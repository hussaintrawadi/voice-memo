import { describe, expect, it } from "vitest";
import { ingestRecording } from "../worker/routes/recordings";

/**
 * Just enough of D1, R2 and Workflows to watch what an upload does.
 * `storedBytes` is what the database already holds; the insert only "writes a row" while the
 * new recording still fits under the cap, which is how SQLite evaluates the real statement.
 */
function fakeEnv({ storedBytes = 0, cap = 1000, putFails = false } = {}) {
  const calls = { inserts: 0, puts: 0, deletes: 0, started: 0 };
  let total = storedBytes;
  const env = {
    AUDIO_CAP_BYTES: String(cap),
    AUDIO: {
      put: async () => {
        calls.puts++;
        if (putFails) throw new Error("R2 unavailable");
      },
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO recordings")) {
              const size = args[args.length - 2] as number;
              const limit = args[args.length - 1] as number;
              const fits = total + size <= limit;
              if (fits) {
                total += size;
                calls.inserts++;
              }
              return { meta: { changes: fits ? 1 : 0 } };
            }
            if (sql.startsWith("DELETE FROM recordings")) {
              calls.deletes++;
              total -= 0; // the reservation is released by the row going away
            }
            return { meta: { changes: 1 } };
          },
        }),
      }),
    },
    PROCESS: {
      create: async () => {
        calls.started++;
        return { id: "wf" };
      },
    },
  } as unknown as Env;
  return { env, calls, used: () => total };
}

const upload = (bytes: number) => ({
  id: crypto.randomUUID(),
  userId: "u1",
  mime: "audio/mp4",
  audio: new ArrayBuffer(bytes),
  recordedAt: Date.UTC(2026, 8, 24),
  durationSec: 12,
  source: "pwa",
  partOf: null,
  partIndex: null,
  audioPeak: 0.4,
});

describe("ingestRecording", () => {
  it("stores a recording that fits", async () => {
    const { env, calls } = fakeEnv({ storedBytes: 0, cap: 1000 });
    await ingestRecording(env, upload(400));
    expect(calls).toMatchObject({ inserts: 1, puts: 1, started: 1 });
  });

  it("refuses an upload past the cap, and stores nothing", async () => {
    const { env, calls } = fakeEnv({ storedBytes: 900, cap: 1000 });
    await expect(ingestRecording(env, upload(200))).rejects.toThrow(/storage is full/i);
    expect(calls).toMatchObject({ inserts: 0, puts: 0, started: 0 });
  });

  it("lets only one of two uploads racing for the last slot through", async () => {
    const { env, calls, used } = fakeEnv({ storedBytes: 800, cap: 1000 });
    const results = await Promise.allSettled([ingestRecording(env, upload(150)), ingestRecording(env, upload(150))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.inserts).toBe(1);
    expect(used()).toBeLessThanOrEqual(1000);
  });

  it("releases the reserved space when the upload to storage fails", async () => {
    const { env, calls } = fakeEnv({ storedBytes: 0, cap: 1000, putFails: true });
    await expect(ingestRecording(env, upload(100))).rejects.toThrow(/R2 unavailable/);
    expect(calls).toMatchObject({ inserts: 1, puts: 1, deletes: 1, started: 0 });
  });
});

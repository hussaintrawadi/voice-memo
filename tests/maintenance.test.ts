import { describe, expect, it } from "vitest";
import { sweepOrphanAudio } from "../worker/maintenance";

/** Just enough of R2 and D1 for the orphan sweep. */
function fakeEnv(objects: { key: string; ageMs: number }[], referenced: string[]) {
  const deleted: string[] = [];
  const config = new Map<string, string>();
  const env = {
    AUDIO: {
      list: async () => ({
        objects: objects.map((o) => ({ key: o.key, uploaded: new Date(Date.now() - o.ageMs) })),
        truncated: false,
      }),
      delete: async (keys: string[]) => void deleted.push(...keys),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: string[]) => ({
          first: async () => (config.has("orphan_sweep_cursor") ? { value: config.get("orphan_sweep_cursor") } : null),
          all: async () => ({ results: args.filter((k) => referenced.includes(k)).map((r2_key) => ({ r2_key })) }),
          run: async () => {
            if (sql.includes("INSERT INTO app_config")) config.set("orphan_sweep_cursor", args[0]);
          },
        }),
        first: async () => null,
      }),
    },
  } as unknown as Env;
  return { env, deleted };
}

describe("sweepOrphanAudio", () => {
  const DAY = 24 * 3600_000;

  it("deletes old files no recording points to", async () => {
    const { env, deleted } = fakeEnv(
      [
        { key: "u/2026/09/kept.m4a", ageMs: 2 * DAY },
        { key: "u/2026/09/orphan.m4a", ageMs: 2 * DAY },
      ],
      ["u/2026/09/kept.m4a"],
    );
    expect(await sweepOrphanAudio(env)).toBe(1);
    expect(deleted).toEqual(["u/2026/09/orphan.m4a"]);
  });

  it("never touches recent files that may still be uploading", async () => {
    const { env, deleted } = fakeEnv([{ key: "u/2026/09/new.m4a", ageMs: 60_000 }], []);
    expect(await sweepOrphanAudio(env)).toBe(0);
    expect(deleted).toEqual([]);
  });
});

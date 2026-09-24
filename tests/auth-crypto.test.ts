import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../worker/lib/password";
import { passwordPepper, signedAudioPath, verifyAudioSignature } from "../worker/lib/secrets";

const env = { APP_SECRET: "test-secret-with-enough-entropy-0123456789" } as unknown as Env;

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const pepper = await passwordPepper(env);
    const stored = await hashPassword("correct horse battery", pepper);
    expect(stored).toMatch(/^pbkdf2-sha256\$\d+\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse battery", stored, pepper)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored, pepper)).toBe(false);
  });

  it("salts every hash", async () => {
    const pepper = await passwordPepper(env);
    expect(await hashPassword("same password", pepper)).not.toBe(await hashPassword("same password", pepper));
  });

  it("depends on the pepper", async () => {
    const stored = await hashPassword("correct horse battery", await passwordPepper(env));
    const otherPepper = await passwordPepper({ APP_SECRET: "a-different-secret" } as unknown as Env);
    expect(await verifyPassword("correct horse battery", stored, otherPepper)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash", "pepper")).toBe(false);
  });

  it("enforces a minimum length", () => {
    expect(passwordProblem("short")).not.toBeNull();
    expect(passwordProblem("long enough pw")).toBeNull();
  });
});

describe("signed audio links", () => {
  const params = (path: string) => new URL(path, "https://x").searchParams;

  it("accepts a fresh signature for the same recording only", async () => {
    const path = await signedAudioPath(env, "rec-1");
    const q = params(path);
    expect(await verifyAudioSignature(env, "rec-1", q.get("exp")!, q.get("sig")!)).toBe(true);
    expect(await verifyAudioSignature(env, "rec-2", q.get("exp")!, q.get("sig")!)).toBe(false);
  });

  it("rejects a tampered expiry", async () => {
    const q = params(await signedAudioPath(env, "rec-1"));
    const later = String(Number(q.get("exp")) + 3600_000);
    expect(await verifyAudioSignature(env, "rec-1", later, q.get("sig")!)).toBe(false);
  });

  it("rejects expired links", async () => {
    const q = params(await signedAudioPath(env, "rec-1", Date.now() - 48 * 3600_000));
    expect(await verifyAudioSignature(env, "rec-1", q.get("exp")!, q.get("sig")!)).toBe(false);
  });

  it("stays identical within the hour so audio isn't reloaded", async () => {
    const hour = Math.floor(Date.now() / 3600_000) * 3600_000;
    expect(await signedAudioPath(env, "rec-1", hour + 60_000)).toBe(await signedAudioPath(env, "rec-1", hour + 120_000));
  });
});

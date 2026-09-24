import { safeEqual } from "./util";

/**
 * PBKDF2-SHA256 over an HMAC of the password keyed with a server-side pepper.
 * The iteration count is modest because the Workers Free plan allows ~10 ms of CPU per request;
 * the pepper (a Worker secret, never stored in D1) is what makes a leaked hash useless offline.
 */
const ITERATIONS = 30_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export const MIN_PASSWORD_LENGTH = 10;

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, pepper: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const peppered = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(password.normalize("NFKC")));
  const baseKey = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, baseKey, HASH_BITS);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(SALT_BYTES)));
  const hash = await derive(password, pepper, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const [scheme, iterations, salt, expected] = stored.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
  const saltBytes = fromB64(salt);
  const actual = await derive(password, pepper, new Uint8Array(saltBytes), Number(iterations));
  return safeEqual(toB64(actual), expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 200) return "That password is too long";
  return null;
}

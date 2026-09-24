import { HttpError, safeEqual } from "./util";

/**
 * All server-side keys derive from one Worker secret (APP_SECRET) with a purpose label,
 * so a key used for one job can never be replayed for another.
 */
async function derivedKey(env: Env, purpose: string): Promise<CryptoKey> {
  if (!env.APP_SECRET) throw new HttpError(503, "APP_SECRET is not configured on the server");
  const enc = new TextEncoder();
  const root = await crypto.subtle.importKey("raw", enc.encode(env.APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const material = await crypto.subtle.sign("HMAC", root, enc.encode(purpose));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pepper mixed into password hashes; lives only in the Worker secret. */
export async function passwordPepper(env: Env): Promise<string> {
  const key = await derivedKey(env, "password-pepper");
  return hmacHex(key, "v1");
}

const AUDIO_URL_TTL_MS = 6 * 3600_000;

/**
 * Short-lived signed audio links, so <audio> elements work without cookies
 * (the Android app talks to the API cross-origin with a bearer token).
 */
export async function signedAudioPath(env: Env, recordingId: string, now = Date.now()): Promise<string> {
  // Rounded to the hour so the link stays identical across refetches and playback isn't interrupted.
  const exp = Math.ceil(now / 3600_000) * 3600_000 + AUDIO_URL_TTL_MS;
  const sig = await hmacHex(await derivedKey(env, "audio-url"), `${recordingId}.${exp}`);
  return `/api/recordings/${recordingId}/audio?exp=${exp}&sig=${sig}`;
}

export async function verifyAudioSignature(env: Env, recordingId: string, exp: string, sig: string): Promise<boolean> {
  const expiry = Number(exp);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const expected = await hmacHex(await derivedKey(env, "audio-url"), `${recordingId}.${expiry}`);
  return safeEqual(expected, sig);
}

/** Tamper-proof, expiring blob (e.g. the pending OAuth request carried through the sign-in form). */
export async function signPayload(env: Env, purpose: string, payload: unknown, ttlMs: number): Promise<string> {
  const body = btoa(unescape(encodeURIComponent(JSON.stringify({ p: payload, exp: Date.now() + ttlMs }))));
  const sig = await hmacHex(await derivedKey(env, purpose), body);
  return `${body}.${sig}`;
}

export async function verifyPayload<T>(env: Env, purpose: string, signed: string): Promise<T | null> {
  const [body, sig] = signed.split(".");
  if (!body || !sig) return null;
  const expected = await hmacHex(await derivedKey(env, purpose), body);
  if (!safeEqual(expected, sig)) return null;
  try {
    const { p, exp } = JSON.parse(decodeURIComponent(escape(atob(body)))) as { p: T; exp: number };
    return exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "./app";
import { hashPassword, passwordProblem, verifyPassword } from "./lib/password";
import { passwordPepper } from "./lib/secrets";
import { HttpError, newId, now, randomToken, safeEqual, sha256Hex } from "./lib/util";

const COOKIE = "vm_session";
const SESSION_TTL = 90 * 24 * 3600_000;

/** Lockout after repeated wrong passwords: per client IP, plus a global ceiling. */
const IP_LIMIT = 5;
const IP_LOCK_MS = 15 * 60_000;
const GLOBAL_LIMIT = 30;
const GLOBAL_LOCK_MS = 60 * 60_000;

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  password_hash: string | null;
}

const isSecure = (c: Context<AppEnv>) => new URL(c.req.url).protocol === "https:";

function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL / 1000,
  });
}

/** Creates a session. Browsers get an HttpOnly cookie; the apps keep the returned bearer token. */
async function createSession(c: Context<AppEnv>, userId: string): Promise<string> {
  const token = randomToken();
  const ts = now();
  await c.env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), userId, ts, ts + SESSION_TTL, ts, describeClient(c))
    .run();
  setSessionCookie(c, token);
  return token;
}

function describeClient(c: Context<AppEnv>): string {
  const app = c.req.header("x-client");
  if (app) return app.slice(0, 60);
  return c.req.header("user-agent")?.slice(0, 200) ?? "Unknown device";
}

function sessionToken(c: Context<AppEnv>): { token: string; fromCookie: boolean } | null {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return { token: bearer, fromCookie: false };
  const cookie = getCookie(c, COOKIE);
  return cookie ? { token: cookie, fromCookie: true } : null;
}

/** Resolves the signed-in user, or null. Sliding expiry: active sessions keep renewing. */
async function sessionUser(c: Context<AppEnv>): Promise<{ userId: string; sessionId: string } | null> {
  const found = sessionToken(c);
  if (!found) return null;
  const id = await sha256Hex(found.token);
  const row = await c.env.DB.prepare("SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?")
    .bind(id)
    .first<{ user_id: string; expires_at: number; last_seen_at: number | null }>();
  if (!row || row.expires_at < now()) return null;
  // Renew at most once an hour to keep writes low.
  if (!row.last_seen_at || now() - row.last_seen_at > 3600_000) {
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?")
      .bind(now() + SESSION_TTL, now(), id)
      .run();
    if (found.fromCookie) setSessionCookie(c, found.token);
  }
  return { userId: row.user_id, sessionId: id };
}

/**
 * Server-side calls made on the owner's behalf (the Claude connector reuses the API routes).
 * Only code can put this symbol on env; no request can.
 */
export const INTERNAL_USER = Symbol("internal-user");

export function asUser(env: Env, userId: string): Env {
  return { ...env, [INTERNAL_USER]: userId } as Env;
}

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const internal = (c.env as unknown as Record<symbol, string | undefined>)[INTERNAL_USER];
  if (internal) {
    c.set("userId", internal);
    c.set("sessionId", "internal");
    return next();
  }
  const session = await sessionUser(c);
  if (!session) throw new HttpError(401, "Please sign in");
  c.set("userId", session.userId);
  c.set("sessionId", session.sessionId);
  await next();
});

function clientIp(c: Context<AppEnv>): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

async function assertNotLocked(env: Env, ip: string) {
  const { results } = await env.DB.prepare("SELECT key, locked_until FROM login_attempts WHERE key IN (?, 'global')")
    .bind(`ip:${ip}`)
    .all<{ key: string; locked_until: number }>();
  const lock = Math.max(0, ...results.map((r) => r.locked_until));
  if (lock > now()) {
    const minutes = Math.ceil((lock - now()) / 60_000);
    throw new HttpError(429, `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
  }
}

async function recordFailure(env: Env, ip: string) {
  const bump = (key: string, limit: number, lockMs: number) =>
    env.DB.prepare(
      `INSERT INTO login_attempts (key, failures, locked_until, updated_at) VALUES (?1, 1, 0, ?2)
       ON CONFLICT(key) DO UPDATE SET
         failures = CASE WHEN locked_until > 0 AND locked_until < ?2 THEN 1 ELSE failures + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN locked_until > 0 AND locked_until < ?2 THEN 1 ELSE failures + 1 END) >= ?3 THEN ?2 + ?4
           WHEN locked_until < ?2 THEN 0 ELSE locked_until END,
         updated_at = ?2`,
    ).bind(key, now(), limit, lockMs);
  await env.DB.batch([bump(`ip:${ip}`, IP_LIMIT, IP_LOCK_MS), bump("global", GLOBAL_LIMIT, GLOBAL_LOCK_MS)]);
}

async function clearFailures(env: Env, ip: string) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key IN (?, 'global')").bind(`ip:${ip}`).run();
}

async function getOwner(env: Env): Promise<UserRow | null> {
  return env.DB.prepare("SELECT id, name, email, password_hash FROM users ORDER BY created_at LIMIT 1").first<UserRow>();
}

const Email = z.email().trim().toLowerCase().max(200);
const Password = z.string().min(1).max(200);

const SetupBody = z.object({
  name: z.string().trim().min(1).max(60),
  email: Email,
  password: Password,
  setupCode: z.string().trim().min(1),
});
const LoginBody = z.object({ email: Email, password: Password });
const ResetBody = z.object({ email: Email, setupCode: z.string().trim().min(1), newPassword: Password });
const ChangeBody = z.object({ currentPassword: Password, newPassword: Password });

function checkSetupCode(env: Env, code: string) {
  if (!env.SETUP_CODE) throw new HttpError(503, "SETUP_CODE is not configured on the server");
  if (!safeEqual(code, env.SETUP_CODE)) throw new HttpError(403, "That setup code is not right");
}

function assertStrong(password: string) {
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
}

const publicUser = (u: UserRow) => ({ id: u.id, name: u.name, email: u.email });

export const authRoutes = new Hono<AppEnv>()
  .get("/state", async (c) => {
    const [session, owner] = await Promise.all([sessionUser(c), getOwner(c.env)]);
    return c.json({
      initialized: Boolean(owner?.password_hash),
      user: session && owner && session.userId === owner.id ? publicUser(owner) : null,
    });
  })

  // First run only: creates the single account. Guarded by the setup code.
  .post("/setup", async (c) => {
    const body = SetupBody.parse(await c.req.json());
    const ip = clientIp(c);
    await assertNotLocked(c.env, ip);
    const owner = await getOwner(c.env);
    if (owner?.password_hash) throw new HttpError(409, "This app already has an account. Sign in instead.");
    try {
      checkSetupCode(c.env, body.setupCode);
    } catch (err) {
      await recordFailure(c.env, ip);
      throw err;
    }
    assertStrong(body.password);

    const hash = await hashPassword(body.password, await passwordPepper(c.env));
    const userId = owner?.id ?? newId();
    if (owner) {
      await c.env.DB.prepare(
        "UPDATE users SET name = ?, email = ?, password_hash = ?, password_updated_at = ? WHERE id = ?",
      )
        .bind(body.name, body.email, hash, now(), userId)
        .run();
    } else {
      await c.env.DB.prepare(
        "INSERT INTO users (id, name, email, password_hash, password_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(userId, body.name, body.email, hash, now(), now())
        .run();
    }
    await clearFailures(c.env, ip);
    const token = await createSession(c, userId);
    return c.json({ ok: true, token }, 201);
  })

  .post("/login", async (c) => {
    const body = LoginBody.parse(await c.req.json());
    const ip = clientIp(c);
    await assertNotLocked(c.env, ip);
    const owner = await getOwner(c.env);
    const pepper = await passwordPepper(c.env);
    const valid =
      owner?.password_hash && owner.email?.toLowerCase() === body.email
        ? await verifyPassword(body.password, owner.password_hash, pepper)
        : false;
    if (!owner || !valid) {
      await recordFailure(c.env, ip);
      throw new HttpError(401, "Email or password is wrong");
    }
    await clearFailures(c.env, ip);
    const token = await createSession(c, owner.id);
    return c.json({ ok: true, token });
  })

  // Forgot password: the setup code doubles as the recovery key. Signs out every device.
  .post("/reset", async (c) => {
    const body = ResetBody.parse(await c.req.json());
    const ip = clientIp(c);
    await assertNotLocked(c.env, ip);
    const owner = await getOwner(c.env);
    const ok = owner?.email?.toLowerCase() === body.email && c.env.SETUP_CODE && safeEqual(body.setupCode, c.env.SETUP_CODE);
    if (!owner || !ok) {
      await recordFailure(c.env, ip);
      throw new HttpError(403, "Email or setup code is wrong");
    }
    assertStrong(body.newPassword);
    const hash = await hashPassword(body.newPassword, await passwordPepper(c.env));
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?").bind(
        hash,
        now(),
        owner.id,
      ),
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
    ]);
    await clearFailures(c.env, ip);
    const token = await createSession(c, owner.id);
    return c.json({ ok: true, token });
  })

  .post("/logout", async (c) => {
    const found = sessionToken(c);
    if (found) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(found.token)).run();
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  })

  .post("/password", requireSession, async (c) => {
    const body = ChangeBody.parse(await c.req.json());
    const owner = await getOwner(c.env);
    const pepper = await passwordPepper(c.env);
    if (!owner?.password_hash || !(await verifyPassword(body.currentPassword, owner.password_hash, pepper))) {
      throw new HttpError(403, "Current password is wrong");
    }
    assertStrong(body.newPassword);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET password_hash = ?, password_updated_at = ? WHERE id = ?").bind(
        await hashPassword(body.newPassword, pepper),
        now(),
        owner.id,
      ),
      // Keep this device signed in; sign out the rest.
      c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(owner.id, c.get("sessionId")),
    ]);
    return c.json({ ok: true });
  })

  .get("/sessions", requireSession, async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
    )
      .bind(c.get("userId"), now())
      .all<{ id: string; user_agent: string | null; created_at: number; last_seen_at: number | null }>();
    return c.json({
      sessions: results.map((s) => ({
        id: s.id.slice(0, 16),
        device: s.user_agent,
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        current: s.id === c.get("sessionId"),
      })),
    });
  })

  .delete("/sessions/:id", requireSession, async (c) => {
    const prefix = c.req.param("id");
    if (!/^[0-9a-f]{16}$/.test(prefix)) throw new HttpError(400, "Invalid session id");
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id, 1, 16) = ? AND id != ?")
      .bind(c.get("userId"), prefix, c.get("sessionId"))
      .run();
    return c.json({ ok: true });
  });

/** Bearer-token auth for capture endpoints (iOS Shortcut, Android and Mac background uploads). */
export async function userForCaptureToken(env: Env, header: string | undefined): Promise<string> {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Missing capture token");
  const row = await env.DB.prepare(
    "SELECT id, user_id, last_used_at FROM capture_tokens WHERE token_hash = ? AND revoked_at IS NULL",
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; user_id: string; last_used_at: number | null }>();
  if (!row) throw new HttpError(401, "Invalid capture token");
  if (!row.last_used_at || now() - row.last_used_at > 3600_000) {
    await env.DB.prepare("UPDATE capture_tokens SET last_used_at = ? WHERE id = ?").bind(now(), row.id).run();
  }
  return row.user_id;
}

/** Checks the owner's email and password with the same lockout rules as sign-in. */
export async function verifyOwnerLogin(env: Env, email: string, password: string, ip: string): Promise<{ id: string; email: string }> {
  await assertNotLocked(env, ip);
  const owner = await getOwner(env);
  const valid =
    owner?.password_hash && owner.email?.toLowerCase() === email.trim().toLowerCase()
      ? await verifyPassword(password, owner.password_hash, await passwordPepper(env))
      : false;
  if (!owner || !valid) {
    await recordFailure(env, ip);
    throw new HttpError(401, "Email or password is wrong");
  }
  await clearFailures(env, ip);
  return { id: owner.id, email: owner.email ?? email };
}

/** The owner behind a browser session cookie, if it is still valid. */
export async function ownerForSessionCookie(env: Env, cookieHeader: string | null): Promise<{ id: string; email: string } | null> {
  const token = cookieHeader?.match(/(?:^|;\s*)vm_session=([^;]+)/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?",
  )
    .bind(await sha256Hex(decodeURIComponent(token)), now())
    .first<{ id: string; email: string | null }>();
  return row ? { id: row.id, email: row.email ?? "" } : null;
}

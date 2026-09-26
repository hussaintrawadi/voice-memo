import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { userForCaptureToken } from "../auth";
import { getUser } from "../lib/data";
import { parseWhen } from "../lib/time";
import { HttpError, newId, now } from "../lib/util";

export interface ReminderRow {
  id: string;
  text: string;
  remind_at: number;
  status: "pending" | "sent" | "done" | "cancelled";
  origin: string;
  recording_id: string | null;
  task_id: string | null;
  created_at: number;
}

const COLUMNS = "id, text, remind_at, status, origin, recording_id, task_id, created_at";

const CreateBody = z.object({
  text: z.string().trim().min(1).max(300),
  /** Unix ms, an ISO timestamp, or local "YYYY-MM-DDTHH:MM" in the user's timezone. */
  remindAt: z.union([z.number().int().positive(), z.string().min(10).max(40)]),
  taskId: z.string().optional(),
  origin: z.enum(["app", "claude"]).default("app"),
});

const PatchBody = z.object({
  status: z.enum(["suggested", "pending", "done", "cancelled"]).optional(),
  text: z.string().trim().min(1).max(300).optional(),
  remindAt: z.union([z.number().int().positive(), z.string().min(10).max(40)]).optional(),
});

async function toTimestamp(env: Env, userId: string, value: number | string): Promise<number> {
  if (typeof value === "number") return value;
  const user = await getUser(env, userId);
  try {
    return parseWhen(value, user.timezone);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

export const reminderRoutes = new Hono<AppEnv>()
  // ?scope=upcoming (default: pending, suggested, and recently sent) | all
  .get("/", async (c) => {
    const userId = c.get("userId");
    const scope = c.req.query("scope") ?? "upcoming";
    const stmt =
      scope === "all"
        ? c.env.DB.prepare(`SELECT ${COLUMNS} FROM reminders WHERE user_id = ? ORDER BY remind_at DESC LIMIT 100`).bind(userId)
        : c.env.DB.prepare(
            `SELECT ${COLUMNS} FROM reminders
             WHERE user_id = ? AND (status IN ('pending', 'suggested') OR (status = 'sent' AND remind_at > ?))
             ORDER BY remind_at LIMIT 50`,
          ).bind(userId, now() - 24 * 3600_000);
    const { results } = await stmt.all<ReminderRow>();
    return c.json({ reminders: results });
  })

  .post("/", async (c) => {
    const userId = c.get("userId");
    const body = CreateBody.parse(await c.req.json());
    const remindAt = await toTimestamp(c.env, userId, body.remindAt);
    if (remindAt < now() - 60_000) throw new HttpError(400, "That time has already passed");
    if (body.taskId) {
      const task = await c.env.DB.prepare("SELECT 1 FROM tasks WHERE id = ? AND user_id = ?").bind(body.taskId, userId).first();
      if (!task) throw new HttpError(404, "Task not found");
    }
    const id = newId();
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO reminders (id, user_id, text, remind_at, status, origin, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
      .bind(id, userId, body.text, remindAt, body.origin, body.taskId ?? null, ts, ts)
      .run();
    return c.json({ id, remindAt }, 201);
  })

  // Done, cancel, edit, or snooze (a new remindAt puts it back to pending).
  .patch("/:id", async (c) => {
    const userId = c.get("userId");
    const body = PatchBody.parse(await c.req.json());
    const row = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM reminders WHERE id = ? AND user_id = ?`)
      .bind(c.req.param("id"), userId)
      .first<ReminderRow>();
    if (!row) throw new HttpError(404, "Reminder not found");
    const remindAt = body.remindAt === undefined ? row.remind_at : await toTimestamp(c.env, userId, body.remindAt);
    const status = body.status ?? (body.remindAt !== undefined ? "pending" : row.status);
    await c.env.DB.prepare(
      "UPDATE reminders SET text = ?, remind_at = ?, status = ?, origin = 'app', sent_at = CASE WHEN ? = 'pending' THEN NULL ELSE sent_at END, updated_at = ? WHERE id = ?",
    )
      .bind(body.text ?? row.text, remindAt, status, status, now(), row.id)
      .run();
    return c.json({ ok: true, remindAt, status });
  })

  .delete("/:id", async (c) => {
    await c.env.DB.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("userId")).run();
    return c.json({ ok: true });
  });

/** Devices that receive reminder notifications (the Android app registers its FCM token). */
export const pushDeviceRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const body = z
      .object({ platform: z.enum(["android"]), token: z.string().min(20).max(4096), label: z.string().max(60).optional() })
      .parse(await c.req.json());
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO push_devices (id, user_id, platform, token, label, failures, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, label = excluded.label, failures = 0, last_seen_at = excluded.last_seen_at`,
    )
      .bind(newId(), c.get("userId"), body.platform, body.token, body.label ?? null, ts, ts)
      .run();
    return c.json({ ok: true });
  })

  .delete("/", async (c) => {
    const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(await c.req.json());
    await c.env.DB.prepare("DELETE FROM push_devices WHERE token = ? AND user_id = ?").bind(token, c.get("userId")).run();
    return c.json({ ok: true });
  });

/**
 * For the Android and Mac apps' background sync (device upload token, no session): reminders from
 * two hours ago to two weeks ahead, which the device schedules as local notifications.
 */
const DeviceAction = z.object({
  action: z.enum(["done", "snooze", "confirm", "dismiss"]),
  /** For snooze: minutes from now. */
  minutes: z.number().int().min(1).max(24 * 60).default(10),
});

export const deviceReminderRoutes = new Hono<AppEnv>()
  // ?include=suggested also returns reminders waiting for a tap, so the phone can ask "Set this reminder?".
  // Older app builds don't send it and keep getting only reminders that will ring.
  .get("/", async (c) => {
    const userId = await userForCaptureToken(c.env, c.req.header("authorization"));
    const withSuggested = c.req.query("include") === "suggested";
    const { results } = await c.env.DB.prepare(
      `SELECT id, text, remind_at, status, recording_id FROM reminders
       WHERE user_id = ? AND remind_at BETWEEN ? AND ?
         AND (status IN ('pending', 'sent') OR (? = 1 AND status = 'suggested' AND remind_at > ?))
       ORDER BY remind_at LIMIT 200`,
    )
      .bind(userId, now() - 2 * 3600_000, now() + 14 * 86_400_000, withSuggested ? 1 : 0, now())
      .all<{ id: string; text: string; remind_at: number; status: string; recording_id: string | null }>();
    return c.json({
      now: now(),
      reminders: results.map((r) => ({
        id: r.id,
        text: r.text,
        remindAt: r.remind_at,
        recordingId: r.recording_id,
        suggested: r.status === "suggested",
      })),
    });
  })

  // The buttons on a ringing reminder or a "Set this reminder?" prompt, from the phone or Mac.
  .post("/:id", async (c) => {
    const userId = await userForCaptureToken(c.env, c.req.header("authorization"));
    const body = DeviceAction.parse(await c.req.json());
    const row = await c.env.DB.prepare("SELECT id, status, remind_at FROM reminders WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), userId)
      .first<{ id: string; status: string; remind_at: number }>();
    if (!row) throw new HttpError(404, "Reminder not found");
    const ts = now();
    const update = {
      done: { status: "done", remind_at: row.remind_at },
      snooze: { status: "pending", remind_at: ts + body.minutes * 60_000 },
      confirm: { status: row.status === "suggested" ? "pending" : row.status, remind_at: row.remind_at },
      dismiss: { status: row.status === "suggested" ? "cancelled" : row.status, remind_at: row.remind_at },
    }[body.action];
    await c.env.DB.prepare(
      `UPDATE reminders SET status = ?, remind_at = ?, origin = CASE WHEN ? IN ('confirm', 'snooze') THEN 'app' ELSE origin END,
         sent_at = CASE WHEN ? = 'pending' THEN NULL ELSE sent_at END, updated_at = ? WHERE id = ?`,
    )
      .bind(update.status, update.remind_at, body.action, update.status, ts, row.id)
      .run();
    return c.json({ ok: true, status: update.status, remindAt: update.remind_at });
  });

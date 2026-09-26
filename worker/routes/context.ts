import { Hono } from "hono";
import type { AppEnv } from "../app";
import { HttpError } from "../lib/util";
import { undoChange } from "../pipeline/reconcile";

/** What your memos changed in your open items, most recent first, and undo. */
export const contextRoutes = new Hono<AppEnv>()
  // ?days=7 (default) &limit=20
  .get("/", async (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 7), 1), 90);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
    const { results } = await c.env.DB.prepare(
      `SELECT x.id, x.item_type, x.item_id, x.action, x.summary, x.evidence, x.created_at, x.recording_id, r.title AS recording_title
       FROM context_changes x LEFT JOIN recordings r ON r.id = x.recording_id
       WHERE x.user_id = ? AND x.undone_at IS NULL AND x.created_at > ?
       ORDER BY x.created_at DESC LIMIT ?`,
    )
      .bind(c.get("userId"), Date.now() - days * 86_400_000, limit)
      .all();
    return c.json({ changes: results });
  })

  .post("/:id/undo", async (c) => {
    const ok = await undoChange(c.env, c.get("userId"), c.req.param("id"));
    if (!ok) throw new HttpError(404, "That change was already undone or doesn't exist");
    return c.json({ ok: true });
  });

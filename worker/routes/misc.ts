import { Hono } from "hono";
import { z } from "zod";
import { embed, EMBED_DIMS } from "../ai/embed";
import { providerStatus } from "../ai/router";
import type { AppEnv } from "../app";
import { userForCaptureToken } from "../auth";
import { audioBytesInUse, getUser } from "../lib/data";
import { ftsQuery, fuseRankings } from "../lib/search";
import { errorMessage, HttpError, localTime, newId, now, randomToken, sha256Hex } from "../lib/util";
import { ingestNote } from "../pipeline/steps";
import { startProcessing } from "../pipeline/workflow";
import { audioPeakHeader, ingestRecording, UUID } from "./recordings";

const TaskPatch = z.object({
  status: z.enum(["suggested", "accepted", "dismissed", "done"]).optional(),
  title: z.string().trim().min(1).max(300).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  projectId: z.string().nullable().optional(),
});

const TaskCreate = z.object({
  title: z.string().trim().min(1).max(300),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  notes: z.string().trim().max(2000).optional(),
  projectId: z.string().nullable().optional(),
  origin: z.enum(["user", "claude"]).default("user"),
});

export const miscRoutes = new Hono<AppEnv>()
  // iOS Shortcut / external capture: raw audio body + bearer device token.
  // Device-token uploads: iOS Shortcut, and the Android/Mac apps' background upload queues.
  // A client-generated x-recording-id makes retries idempotent.
  .post("/capture", async (c) => {
    const userId = await userForCaptureToken(c.env, c.req.header("authorization"));
    const clientId = c.req.header("x-recording-id");
    if (clientId && !UUID.test(clientId)) throw new HttpError(400, "Invalid recording id");
    const id = clientId ?? newId();
    if (clientId) {
      const existing = await c.env.DB.prepare("SELECT user_id, status FROM recordings WHERE id = ?")
        .bind(id)
        .first<{ user_id: string; status: string }>();
      if (existing) {
        if (existing.user_id !== userId) throw new HttpError(409, "Id already in use");
        return c.json({ id, status: existing.status, duplicate: true });
      }
    }
    const mime = (c.req.header("content-type") ?? "audio/mp4").split(";")[0].trim();
    const recordedAt = Number(c.req.header("x-recorded-at"));
    const duration = Number(c.req.header("x-duration-sec"));
    const partIndex = c.req.header("x-part-index");
    await ingestRecording(c.env, {
      id,
      userId,
      mime: mime === "application/octet-stream" ? "audio/mp4" : mime,
      audio: await c.req.arrayBuffer(),
      recordedAt: Number.isFinite(recordedAt) && recordedAt > 0 ? recordedAt : now(),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      source: (c.req.header("x-source") ?? "shortcut").slice(0, 20),
      partOf: c.req.header("x-part-of") || null,
      partIndex: partIndex ? Number(partIndex) : null,
      audioPeak: audioPeakHeader(c.req.header("x-audio-peak")),
    });
    return c.json({ id, status: "queued" }, 201);
  })

  .get("/status", async (c) => {
    const [providers, audioBytes, vectorInfo, budget] = await Promise.all([
      providerStatus(c.env),
      audioBytesInUse(c.env),
      c.env.VECTORS.describe().catch(() => null),
      c.env.DB.prepare("SELECT value FROM app_config WHERE key = 'vector_budget_reached'").first<{ value: string }>(),
    ]);
    const info = vectorInfo as { vectorCount?: number; vectorsCount?: number } | null;
    return c.json({
      providers,
      storage: { audioBytes, audioCapBytes: Number(c.env.AUDIO_CAP_BYTES) },
      vectors: {
        stored: info?.vectorCount ?? info?.vectorsCount ?? null,
        capacity: Math.floor(5_000_000 / EMBED_DIMS),
        budgetReached: Boolean(budget),
      },
      retentionDays: Number(c.env.AUDIO_RETENTION_DAYS),
      setupCodeConfigured: Boolean(c.env.SETUP_CODE),
    });
  })

  .get("/settings", async (c) => {
    const user = await getUser(c.env, c.get("userId"));
    return c.json({ name: user.name, email: user.email, timezone: user.timezone, settings: user.settings });
  })

  .patch("/settings", async (c) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        email: z.email().nullable().optional(),
        transcriptionLanguage: z.string().regex(/^(auto|[a-z]{2})$/).optional(),
      })
      .parse(await c.req.json());
    const user = await getUser(c.env, c.get("userId"));
    const settings = { ...user.settings, ...(body.transcriptionLanguage ? { transcriptionLanguage: body.transcriptionLanguage } : {}) };
    await c.env.DB.prepare("UPDATE users SET name = ?, email = ?, settings = ? WHERE id = ?")
      .bind(body.name ?? user.name, body.email === undefined ? user.email : body.email, JSON.stringify(settings), user.id)
      .run();
    return c.json({ ok: true });
  })

  .get("/home", async (c) => {
    const userId = c.get("userId");
    const user = await getUser(c.env, userId);
    const today = localTime(now(), user.timezone).date;
    const [counts, tasks, questions, decisions] = await Promise.all([
      c.env.DB.prepare(
        `SELECT COUNT(*) AS recordings, COALESCE(SUM(duration_sec), 0) AS seconds,
           SUM(CASE WHEN status NOT IN ('completed', 'failed') THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM recordings WHERE user_id = ? AND recorded_at >= ?`,
      )
        .bind(userId, now() - 24 * 3600_000)
        .first(),
      c.env.DB.prepare(
        `SELECT k.id, k.title, k.due_date, k.status, k.recording_id, k.project_id, p.name AS project
         FROM tasks k LEFT JOIN projects p ON p.id = k.project_id
         WHERE k.user_id = ? AND k.status IN ('suggested', 'accepted')
         ORDER BY k.due_date IS NULL, k.due_date, k.created_at DESC LIMIT 20`,
      )
        .bind(userId)
        .all(),
      c.env.DB.prepare(
        `SELECT id, question, recording_id, created_at FROM questions
         WHERE user_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 10`,
      )
        .bind(userId)
        .all(),
      c.env.DB.prepare(
        `SELECT id, statement, recording_id, decided_at FROM decisions
         WHERE user_id = ? AND status = 'active' ORDER BY decided_at DESC LIMIT 5`,
      )
        .bind(userId)
        .all(),
    ]);
    return c.json({ today, last24h: counts, tasks: tasks.results, questions: questions.results, decisions: decisions.results });
  })

  // ?status=open (default) | done | all, optional &projectId=
  .get("/tasks", async (c) => {
    const userId = c.get("userId");
    const status = c.req.query("status") ?? "open";
    const projectId = c.req.query("projectId");
    const where = ["k.user_id = ?"];
    const params: unknown[] = [userId];
    if (status === "open") where.push("k.status IN ('suggested', 'accepted')");
    else if (status === "done") where.push("k.status = 'done'");
    else where.push("k.status != 'dismissed'");
    if (projectId) {
      where.push("k.project_id = ?");
      params.push(projectId);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT k.id, k.title, k.notes, k.due_date, k.status, k.recording_id, k.project_id, k.created_at, k.completed_at, p.name AS project
       FROM tasks k LEFT JOIN projects p ON k.project_id = p.id
       WHERE ${where.join(" AND ")}
       ORDER BY k.status = 'done', k.due_date IS NULL, k.due_date, k.created_at DESC LIMIT 100`,
    )
      .bind(...params)
      .all();
    return c.json({ tasks: results });
  })

  .post("/tasks", async (c) => {
    const userId = c.get("userId");
    const body = TaskCreate.parse(await c.req.json());
    if (body.projectId) {
      const project = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = ? AND user_id = ?").bind(body.projectId, userId).first();
      if (!project) throw new HttpError(404, "Project not found");
    }
    const id = newId();
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO tasks (id, user_id, title, notes, due_date, status, project_id, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?)`,
    )
      .bind(id, userId, body.title, body.notes ?? null, body.dueDate ?? null, body.projectId ?? null, body.origin, ts, ts)
      .run();
    return c.json({ id }, 201);
  })

  // A typed thought: filed, understood and searchable like a memo.
  .post("/notes", async (c) => {
    const userId = c.get("userId");
    const body = z
      .object({ text: z.string().trim().min(3).max(20_000), source: z.enum(["note", "claude"]).default("note") })
      .parse(await c.req.json());
    const id = newId();
    await ingestNote(c.env, { id, userId, text: body.text, source: body.source });
    await startProcessing(c.env, id, "understand");
    return c.json({ id, status: "queued" }, 201);
  })

  .patch("/tasks/:id", async (c) => {
    const body = TaskPatch.parse(await c.req.json());
    const task = await c.env.DB.prepare("SELECT id, title, due_date, status, project_id FROM tasks WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), c.get("userId"))
      .first<{ id: string; title: string; due_date: string | null; status: string; project_id: string | null }>();
    if (!task) throw new HttpError(404, "Task not found");
    const status = body.status ?? task.status;
    const projectId = body.projectId === undefined ? task.project_id : body.projectId;
    await c.env.DB.prepare(
      `UPDATE tasks SET title = ?, due_date = ?, status = ?, project_id = ?, origin = 'user',
         completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        body.title ?? task.title,
        body.dueDate === undefined ? task.due_date : body.dueDate,
        status,
        projectId,
        status,
        now(),
        now(),
        task.id,
      )
      .run();
    return c.json({ ok: true });
  })

  .patch("/decisions/:id", async (c) => {
    const { status } = z.object({ status: z.enum(["active", "reversed", "dismissed"]) }).parse(await c.req.json());
    await c.env.DB.prepare("UPDATE decisions SET status = ?, origin = 'user', updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(status, now(), c.req.param("id"), c.get("userId"))
      .run();
    return c.json({ ok: true });
  })

  .patch("/questions/:id", async (c) => {
    const body = z
      .object({ status: z.enum(["open", "resolved", "dismissed"]), resolution: z.string().max(2000).optional() })
      .parse(await c.req.json());
    await c.env.DB.prepare(
      `UPDATE questions SET status = ?, resolution = COALESCE(?, resolution), origin = 'user',
         resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    )
      .bind(body.status, body.resolution ?? null, body.status, now(), now(), c.req.param("id"), c.get("userId"))
      .run();
    return c.json({ ok: true });
  })

  .get("/search", async (c) => {
    const userId = c.get("userId");
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ results: [], semantic: false });
    const match = ftsQuery(q);

    const keywordThoughts = match
      ? c.env.DB.prepare(
          `SELECT t.id FROM thoughts_fts f JOIN thoughts t ON t.rowid = f.rowid
           WHERE thoughts_fts MATCH ? AND t.user_id = ? ORDER BY bm25(thoughts_fts) LIMIT 30`,
        )
          .bind(match, userId)
          .all<{ id: string }>()
      : Promise.resolve({ results: [] as { id: string }[] });
    const keywordRecordings = match
      ? c.env.DB.prepare(
          `SELECT recording_id FROM recordings_fts
           WHERE recordings_fts MATCH ? AND user_id = ? ORDER BY bm25(recordings_fts) LIMIT 30`,
        )
          .bind(match, userId)
          .all<{ recording_id: string }>()
      : Promise.resolve({ results: [] as { recording_id: string }[] });

    let semantic: string[] = [];
    let semanticError: string | null = null;
    try {
      const [vector] = await embed(c.env, [q], "query");
      const found = await c.env.VECTORS.query(vector, { topK: 30, filter: { user_id: userId } });
      semantic = found.matches.filter((m) => m.score > 0.35).map((m) => m.id);
    } catch (err) {
      semanticError = errorMessage(err);
    }

    const [kt, kr] = await Promise.all([keywordThoughts, keywordRecordings]);
    // Recording-level keyword hits count toward every thought in that recording.
    const recordingIds = kr.results.map((r) => r.recording_id);
    const expanded = recordingIds.length
      ? (
          await c.env.DB.prepare(
            `SELECT id, recording_id FROM thoughts WHERE recording_id IN (${recordingIds.map(() => "?").join(",")}) ORDER BY idx`,
          )
            .bind(...recordingIds)
            .all<{ id: string; recording_id: string }>()
        ).results
      : [];
    const byRecording = recordingIds.flatMap((rid) => expanded.filter((t) => t.recording_id === rid).map((t) => t.id));

    const fused = fuseRankings([kt.results.map((r) => r.id), semantic, byRecording]).slice(0, 25);
    if (!fused.length) return c.json({ results: [], semantic: !semanticError });

    const { results: rows } = await c.env.DB.prepare(
      `SELECT t.id, t.title, t.summary, t.type, t.recorded_at, t.recording_id, r.title AS recording_title, p.name AS project
       FROM thoughts t JOIN recordings r ON r.id = t.recording_id LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = ? AND t.id IN (${fused.map(() => "?").join(",")})`,
    )
      .bind(userId, ...fused.map((f) => f.id))
      .all<Record<string, unknown> & { id: string }>();
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return c.json({
      results: fused.flatMap((f) => (rowById.has(f.id) ? [{ ...rowById.get(f.id), score: f.score }] : [])),
      semantic: !semanticError,
    });
  })

  // Move a thought to another project (or none) when the AI filed it wrongly.
  .patch("/thoughts/:id", async (c) => {
    const { projectId } = z.object({ projectId: z.string().nullable() }).parse(await c.req.json());
    const userId = c.get("userId");
    if (projectId) {
      const owned = await c.env.DB.prepare("SELECT 1 FROM projects WHERE id = ? AND user_id = ?").bind(projectId, userId).first();
      if (!owned) throw new HttpError(404, "Project not found");
    }
    const thought = await c.env.DB.prepare("SELECT id, project_id FROM thoughts WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), userId)
      .first<{ id: string; project_id: string | null }>();
    if (!thought) throw new HttpError(404, "Thought not found");
    const statements = [
      c.env.DB.prepare("UPDATE thoughts SET project_id = ? WHERE id = ?").bind(projectId, thought.id),
      ...["tasks", "decisions", "questions"].map((t) =>
        c.env.DB.prepare(`UPDATE ${t} SET project_id = ? WHERE thought_id = ?`).bind(projectId, thought.id),
      ),
      // Both projects' briefs are now out of date.
      c.env.DB.prepare("UPDATE projects SET summary_updated_at = NULL WHERE id IN (?, ?)").bind(projectId, thought.project_id),
    ];
    if (projectId) statements.push(c.env.DB.prepare("UPDATE projects SET confirmed = 1 WHERE id = ?").bind(projectId));
    await c.env.DB.batch(statements);
    return c.json({ ok: true });
  })

  .get("/vocabulary", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT id, term, source, count FROM vocabulary WHERE user_id = ? AND source != 'blocked'
       ORDER BY source = 'user' DESC, count DESC, term LIMIT 200`,
    )
      .bind(c.get("userId"))
      .all();
    return c.json({ terms: results });
  })

  .post("/vocabulary", async (c) => {
    const { term } = z.object({ term: z.string().trim().min(2).max(60) }).parse(await c.req.json());
    await c.env.DB.prepare(
      `INSERT INTO vocabulary (id, user_id, term, count, source, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 'user', ?4, ?4)
       ON CONFLICT DO UPDATE SET source = 'user', term = excluded.term, updated_at = excluded.updated_at`,
    )
      .bind(newId(), c.get("userId"), term, now())
      .run();
    return c.json({ ok: true }, 201);
  })

  // Removed terms are kept as "blocked" so the AI can't learn the same wrong spelling again.
  .delete("/vocabulary/:id", async (c) => {
    await c.env.DB.prepare("UPDATE vocabulary SET source = 'blocked', updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(now(), c.req.param("id"), c.get("userId"))
      .run();
    return c.json({ ok: true });
  })

  .get("/capture-tokens", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT id, label, created_at, last_used_at FROM capture_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at",
    )
      .bind(c.get("userId"))
      .all();
    return c.json({ tokens: results });
  })

  .post("/capture-tokens", async (c) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(60) }).parse(await c.req.json());
    const token = `vm_${randomToken(24)}`;
    const id = newId();
    await c.env.DB.prepare(
      "INSERT INTO capture_tokens (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(id, c.get("userId"), await sha256Hex(token), label, now())
      .run();
    // Shown once; only the hash is stored.
    return c.json({ id, token }, 201);
  })

  .delete("/capture-tokens/:id", async (c) => {
    await c.env.DB.prepare("UPDATE capture_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?")
      .bind(now(), c.req.param("id"), c.get("userId"))
      .run();
    return c.json({ ok: true });
  });

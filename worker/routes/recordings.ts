import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import {
  currentTranscripts,
  getOwnedRecording,
  getRecording,
  type RecordingRow,
  type TranscriptRow,
} from "../lib/data";
import { signedAudioPath, verifyAudioSignature } from "../lib/secrets";
import { undoChangesFromRecording } from "../pipeline/reconcile";
import { extensionForMime, HttpError, newId, now } from "../lib/util";
import { STAGES } from "../pipeline/steps";
import { startProcessing } from "../pipeline/workflow";

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NewRecording {
  id: string;
  userId: string;
  mime: string;
  audio: ArrayBuffer;
  recordedAt: number;
  durationSec: number | null;
  source: string;
  partOf: string | null;
  partIndex: number | null;
  /** Loudest moment measured on the device, 0–1, if the client sent it. */
  audioPeak: number | null;
}

/** Reads the optional X-Audio-Peak header (0–1). */
export function audioPeakHeader(value: string | undefined): number | null {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/** Stores audio in R2, creates the row and starts the pipeline. Shared by the app and the Shortcut endpoint. */
export async function ingestRecording(env: Env, r: NewRecording) {
  if (r.audio.byteLength === 0) throw new HttpError(400, "The recording is empty");
  if (r.audio.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, "Recording is too large (60 MB max)");

  const date = new Date(r.recordedAt);
  const key = `${r.userId}/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${r.id}.${extensionForMime(r.mime)}`;
  const ts = now();

  // The row is written first, and it both claims the id and reserves the space: SQLite adds up
  // the stored bytes inside this one statement, so two uploads arriving together cannot each see
  // room for themselves and both go through. No row written means the cap was reached.
  const reserved = await env.DB.prepare(
    `INSERT INTO recordings (id, user_id, r2_key, mime, bytes, duration_sec, recorded_at, source, part_of, part_index, audio_peak, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?
     WHERE (SELECT COALESCE(SUM(bytes), 0) FROM recordings WHERE r2_key IS NOT NULL) + ? <= ?`,
  )
    .bind(
      r.id,
      r.userId,
      key,
      r.mime,
      r.audio.byteLength,
      r.durationSec,
      r.recordedAt,
      r.source,
      r.partOf,
      r.partIndex,
      r.audioPeak,
      ts,
      ts,
      r.audio.byteLength,
      Number(env.AUDIO_CAP_BYTES),
    )
    .run();
  if (!reserved.meta.changes) {
    throw new HttpError(507, "Audio storage is full. Old audio must be removed before new uploads.");
  }

  try {
    await env.AUDIO.put(key, r.audio, { httpMetadata: { contentType: r.mime } });
  } catch (err) {
    // Give the reserved space back rather than counting audio that was never stored.
    await env.DB.prepare("DELETE FROM recordings WHERE id = ?").bind(r.id).run();
    throw err;
  }
  await startProcessing(env, r.id, "transcribe");
}

function listItem(r: RecordingRow & { projects: string | null; thought_count: number; open_tasks: number }) {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    category: r.category,
    status: r.status,
    statusDetail: r.status_detail,
    lastError: r.last_error,
    recordedAt: r.recorded_at,
    durationSec: r.duration_sec,
    source: r.source,
    hasAudio: Boolean(r.r2_key),
    keepAudio: Boolean(r.keep_audio),
    projects: r.projects ? r.projects.split("\x1f") : [],
    thoughtCount: r.thought_count,
    openTasks: r.open_tasks,
  };
}

function transcriptView(t: TranscriptRow | undefined) {
  if (!t) return null;
  return {
    version: t.version,
    text: t.text,
    segments: t.segments ? JSON.parse(t.segments) : null,
    language: t.language,
    provider: t.provider,
    model: t.model,
    createdAt: t.created_at,
  };
}

const PatchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  keepAudio: z.boolean().optional(),
});

export const recordingRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const before = Number(c.req.query("before") ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.min(Number(c.req.query("limit") ?? 30), 100);
    const { results } = await c.env.DB.prepare(
      `SELECT r.*,
         (SELECT GROUP_CONCAT(name, char(31)) FROM (
            SELECT DISTINCT p.name FROM thoughts t JOIN projects p ON p.id = t.project_id WHERE t.recording_id = r.id)) AS projects,
         (SELECT COUNT(*) FROM thoughts t WHERE t.recording_id = r.id) AS thought_count,
         (SELECT COUNT(*) FROM tasks k WHERE k.recording_id = r.id AND k.status IN ('suggested', 'accepted')) AS open_tasks
       FROM recordings r
       WHERE r.user_id = ? AND r.recorded_at < ?
       ORDER BY r.recorded_at DESC LIMIT ?`,
    )
      .bind(c.get("userId"), before, limit)
      .all<RecordingRow & { projects: string | null; thought_count: number; open_tasks: number }>();
    return c.json({
      recordings: results.map(listItem),
      nextBefore: results.length === limit ? results[results.length - 1].recorded_at : null,
    });
  })

  .put("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) throw new HttpError(400, "Invalid recording id");
    const userId = c.get("userId");
    const existing = await c.env.DB.prepare("SELECT user_id, status FROM recordings WHERE id = ?")
      .bind(id)
      .first<{ user_id: string; status: string }>();
    if (existing) {
      // Retried upload from the offline queue: already stored.
      if (existing.user_id !== userId) throw new HttpError(409, "Id already in use");
      return c.json({ id, status: existing.status, duplicate: true });
    }

    const mime = (c.req.header("content-type") ?? "audio/webm").split(";")[0].trim();
    if (!mime.startsWith("audio/") && !mime.startsWith("video/")) throw new HttpError(415, "Expected an audio upload");
    const recordedAt = Number(c.req.header("x-recorded-at") ?? now());
    const duration = Number(c.req.header("x-duration-sec"));
    const partIndex = c.req.header("x-part-index");

    await ingestRecording(c.env, {
      id,
      userId,
      mime,
      audio: await c.req.arrayBuffer(),
      recordedAt: Number.isFinite(recordedAt) ? recordedAt : now(),
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      source: c.req.header("x-source") ?? "pwa",
      partOf: c.req.header("x-part-of") || null,
      partIndex: partIndex ? Number(partIndex) : null,
      audioPeak: audioPeakHeader(c.req.header("x-audio-peak")),
    });
    return c.json({ id, status: "queued" }, 201);
  })

  .get("/:id", async (c) => {
    const rec = await getOwnedRecording(c.env, c.req.param("id"), c.get("userId"));
    const [transcripts, thoughts, tasks, decisions, questions, analysis, changes] = await Promise.all([
      currentTranscripts(c.env, rec.id),
      c.env.DB.prepare(
        `SELECT t.id, t.idx, t.type, t.title, t.summary, t.content, t.start_sec, t.end_sec, p.id AS project_id, p.name AS project,
           (SELECT GROUP_CONCAT(tp.name, char(31)) FROM thought_topics tt JOIN topics tp ON tp.id = tt.topic_id WHERE tt.thought_id = t.id) AS topics,
           (SELECT GROUP_CONCAT(e.kind || ':' || e.name, char(31)) FROM thought_entities te JOIN entities e ON e.id = te.entity_id WHERE te.thought_id = t.id) AS entities
         FROM thoughts t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.recording_id = ? ORDER BY t.idx`,
      )
        .bind(rec.id)
        .all<Record<string, unknown> & { topics: string | null; entities: string | null }>(),
      c.env.DB.prepare(
        "SELECT id, thought_id, title, due_date, due_text, status FROM tasks WHERE recording_id = ? ORDER BY created_at",
      )
        .bind(rec.id)
        .all(),
      c.env.DB.prepare(
        "SELECT id, thought_id, statement, rationale, status, decided_at FROM decisions WHERE recording_id = ? ORDER BY created_at",
      )
        .bind(rec.id)
        .all(),
      c.env.DB.prepare(
        "SELECT id, thought_id, question, status, resolution FROM questions WHERE recording_id = ? ORDER BY created_at",
      )
        .bind(rec.id)
        .all(),
      c.env.DB.prepare(
        "SELECT version, provider, model, prompt_version, created_at FROM analyses WHERE recording_id = ? AND is_current = 1",
      )
        .bind(rec.id)
        .first(),
      c.env.DB.prepare(
        `SELECT id, item_type, item_id, action, summary, evidence, created_at FROM context_changes
         WHERE recording_id = ? AND undone_at IS NULL ORDER BY created_at`,
      )
        .bind(rec.id)
        .all(),
    ]);

    return c.json({
      recording: {
        ...listItem({ ...rec, projects: null, thought_count: thoughts.results.length, open_tasks: 0 }),
        summaryDetailed: rec.summary_detailed,
        language: rec.language,
        titleEdited: Boolean(rec.title_edited),
        audioDeletedAt: rec.audio_deleted_at,
        audioUrl: rec.r2_key ? await signedAudioPath(c.env, rec.id) : null,
        attempts: rec.attempts,
      },
      transcripts: {
        raw: transcriptView(transcripts.raw),
        cleaned: transcriptView(transcripts.cleaned),
        edited: transcriptView(transcripts.edited),
      },
      thoughts: thoughts.results.map((t) => ({
        ...t,
        topics: t.topics ? t.topics.split("\x1f") : [],
        entities: t.entities
          ? t.entities.split("\x1f").map((e) => {
              const [kind, ...name] = e.split(":");
              return { kind, name: name.join(":") };
            })
          : [],
      })),
      tasks: tasks.results,
      decisions: decisions.results,
      questions: questions.results,
      changes: changes.results,
      analysis,
    });
  })

  .get("/:id/audio", async (c) => {
    const id = c.req.param("id");
    const { exp, sig } = c.req.query();
    let rec: RecordingRow;
    if (sig) {
      if (!(await verifyAudioSignature(c.env, id, exp ?? "", sig))) throw new HttpError(403, "This audio link has expired");
      const row = await getRecording(c.env, id);
      if (!row) throw new HttpError(404, "Recording not found");
      rec = row;
    } else {
      rec = await getOwnedRecording(c.env, id, c.get("userId"));
    }
    if (!rec.r2_key) throw new HttpError(410, "Audio was removed after the retention period");
    const object = await c.env.AUDIO.get(rec.r2_key, { range: c.req.raw.headers, onlyIf: c.req.raw.headers });
    if (!object) throw new HttpError(404, "Audio not found");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", "private, max-age=3600");
    if (!("body" in object)) return new Response(null, { status: 304, headers });

    const range = object.range as { offset?: number; length?: number } | undefined;
    if (range && c.req.header("range")) {
      const offset = range.offset ?? 0;
      const length = range.length ?? object.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("content-length", String(length));
      return new Response(object.body, { status: 206, headers });
    }
    headers.set("content-length", String(object.size));
    return new Response(object.body, { headers });
  })

  .patch("/:id", async (c) => {
    const rec = await getOwnedRecording(c.env, c.req.param("id"), c.get("userId"));
    const body = PatchBody.parse(await c.req.json());
    const ts = now();
    const statements: D1PreparedStatement[] = [];
    if (body.title !== undefined) {
      statements.push(
        c.env.DB.prepare("UPDATE recordings SET title = ?, title_edited = 1, updated_at = ? WHERE id = ?").bind(
          body.title,
          ts,
          rec.id,
        ),
        c.env.DB.prepare("UPDATE recordings_fts SET title = ? WHERE recording_id = ?").bind(body.title, rec.id),
      );
    }
    if (body.keepAudio !== undefined) {
      statements.push(
        c.env.DB.prepare("UPDATE recordings SET keep_audio = ?, updated_at = ? WHERE id = ?").bind(
          body.keepAudio ? 1 : 0,
          ts,
          rec.id,
        ),
      );
    }
    if (statements.length) await c.env.DB.batch(statements);
    return c.json({ ok: true });
  })

  .put("/:id/transcript", async (c) => {
    const rec = await getOwnedRecording(c.env, c.req.param("id"), c.get("userId"));
    const { text, reanalyze } = z
      .object({ text: z.string().max(500_000), reanalyze: z.boolean().default(true) })
      .parse(await c.req.json());
    const row = await c.env.DB.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM transcripts WHERE recording_id = ? AND kind = 'edited'",
    )
      .bind(rec.id)
      .first<{ v: number }>();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE transcripts SET is_current = 0 WHERE recording_id = ? AND kind = 'edited'").bind(rec.id),
      c.env.DB.prepare(
        `INSERT INTO transcripts (id, recording_id, user_id, kind, version, is_current, text, provider, created_at)
         VALUES (?, ?, ?, 'edited', ?, 1, ?, 'user', ?)`,
      ).bind(newId(), rec.id, rec.user_id, row?.v ?? 1, text, now()),
    ]);
    if (reanalyze) await startProcessing(c.env, rec.id, "understand");
    return c.json({ ok: true, reanalyzing: reanalyze });
  })

  .post("/:id/reprocess", async (c) => {
    const rec = await getOwnedRecording(c.env, c.req.param("id"), c.get("userId"));
    const { from } = z.object({ from: z.enum(STAGES).default("understand") }).parse(await c.req.json().catch(() => ({})));
    if (from === "transcribe" && !rec.r2_key) throw new HttpError(410, "Audio is gone, so it can't be transcribed again");
    const workflowId = await startProcessing(c.env, rec.id, from);
    return c.json({ ok: true, workflowId });
  })

  .delete("/:id", async (c) => {
    const rec = await getOwnedRecording(c.env, c.req.param("id"), c.get("userId"));
    // A deleted memo shouldn't keep having changed your other items.
    await undoChangesFromRecording(c.env, rec.id);
    const { results: thoughts } = await c.env.DB.prepare("SELECT id FROM thoughts WHERE recording_id = ?")
      .bind(rec.id)
      .all<{ id: string }>();
    if (thoughts.length) await c.env.VECTORS.deleteByIds(thoughts.map((t) => t.id));
    if (rec.r2_key) await c.env.AUDIO.delete(rec.r2_key);
    if (rec.workflow_id) {
      try {
        await (await c.env.PROCESS.get(rec.workflow_id)).terminate();
      } catch {
        // already finished
      }
    }
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM recordings_fts WHERE recording_id = ?").bind(rec.id),
      c.env.DB.prepare("DELETE FROM recordings WHERE id = ?").bind(rec.id),
    ]);
    return c.json({ ok: true });
  });

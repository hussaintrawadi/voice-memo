import { NonRetryableError } from "cloudflare:workflows";
import { EMBED_DIMS, embed } from "../ai/embed";
import { complete, transcribe } from "../ai/router";
import type { Segment } from "../ai/types";
import {
  currentTranscripts,
  getRecording,
  getUser,
  loadSpellings,
  loadVocabulary,
  type RecordingRow,
  setStatus,
} from "../lib/data";
import { applySpellings, chunkText, isNameLike, isNearName, isOnlyStockPhrases, type Spelling } from "../lib/text";
import { isLocalDateTime, zonedDateTime } from "../lib/time";
import { reconcileRecording } from "./reconcile";
import { errorMessage, estimateTokens, localTime, newId, now, truncate } from "../lib/util";
import {
  cleanSystemPrompt,
  PROMPT_VERSION,
  SynthesisSchema,
  synthesisSystemPrompt,
  UnderstandSchema,
  type Understanding,
  understandSystemPrompt,
  understandUserPrompt,
} from "./prompts";

export const STAGES = ["transcribe", "clean", "understand", "reconcile", "embed"] as const;
export type Stage = (typeof STAGES)[number];

/** Vectorize free tier: 5M stored dimensions. Stop embedding at 90% and surface it in settings. */
const VECTOR_BUDGET = Math.floor((5_000_000 / EMBED_DIMS) * 0.9);

/** Peak level (0–1) below which a recording is treated as silence. A quiet room measures about 0.013 on a Mac. */
const SILENCE_PEAK = 0.02;
/** Below this peak, a stock phrase or a few stray words ("and more.") are treated as noise too. */
const QUIET_PEAK = 0.05;

/** Chunk sizes keep every request under Groq's 8K tokens-per-minute cap. */
const CLEAN_CHUNK_CHARS = 6_000;
const UNDERSTAND_CHUNK_CHARS = 12_000;

async function loadRecording(env: Env, id: string): Promise<RecordingRow> {
  const rec = await getRecording(env, id);
  if (!rec) throw new NonRetryableError(`Recording ${id} no longer exists`);
  return rec;
}

/** Marks the recording as retrying before the Workflow schedules another attempt. */
async function guarded<T>(env: Env, id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof NonRetryableError)) {
      await setStatus(env, id, "retrying", truncate(errorMessage(err), 300));
    }
    throw err;
  }
}

async function nextVersion(env: Env, table: "transcripts" | "analyses", recordingId: string, kind?: string) {
  const sql =
    table === "transcripts"
      ? "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM transcripts WHERE recording_id = ? AND kind = ?"
      : "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM analyses WHERE recording_id = ?";
  const stmt = env.DB.prepare(sql);
  const row = await (kind ? stmt.bind(recordingId, kind) : stmt.bind(recordingId)).first<{ v: number }>();
  return row?.v ?? 1;
}

function saveTranscript(
  env: Env,
  rec: RecordingRow,
  kind: "raw" | "cleaned" | "edited",
  version: number,
  fields: { text: string; segments?: Segment[] | null; language?: string | null; provider?: string; model?: string },
) {
  return [
    env.DB.prepare("UPDATE transcripts SET is_current = 0 WHERE recording_id = ? AND kind = ?").bind(rec.id, kind),
    env.DB.prepare(
      `INSERT INTO transcripts (id, recording_id, user_id, kind, version, is_current, text, segments, language, provider, model, prompt_version, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      newId(),
      rec.id,
      rec.user_id,
      kind,
      version,
      fields.text,
      fields.segments ? JSON.stringify(fields.segments) : null,
      fields.language ?? null,
      fields.provider ?? null,
      fields.model ?? null,
      kind === "cleaned" ? PROMPT_VERSION : null,
      now(),
    ),
  ];
}

// ── transcribe ──────────────────────────────────────────────────────────────

export function transcribeStage(env: Env, id: string) {
  return guarded(env, id, async () => {
    const rec = await loadRecording(env, id);
    if (!rec.r2_key) throw new NonRetryableError("The audio for this recording has been deleted");
    await setStatus(env, id, "transcribing");

    // The device measured essentially no sound: don't let Whisper invent a transcript.
    if (rec.audio_peak !== null && rec.audio_peak < SILENCE_PEAK) {
      const version = await nextVersion(env, "transcripts", id, "raw");
      await env.DB.batch(saveTranscript(env, rec, "raw", version, { text: "", segments: [], provider: "silence-check" }));
      return { provider: "silence-check", model: "", chars: 0 };
    }

    const object = await env.AUDIO.get(rec.r2_key);
    if (!object) throw new NonRetryableError("Audio file is missing from storage");
    const audio = await object.arrayBuffer();
    const user = await getUser(env, rec.user_id);
    const vocabulary = await loadVocabulary(env, rec.user_id);
    const language = user.settings.transcriptionLanguage;

    const { data, provider, model } = await transcribe(env, {
      audio,
      mime: rec.mime,
      filename: rec.id,
      durationSec: rec.duration_sec ?? undefined,
      vocabulary,
      language: language === "auto" ? undefined : language,
    });

    // A quiet room often comes back as just "Thank you." Keep it out of your notes.
    const words = data.text.split(/\s+/).filter(Boolean).length;
    const invented = rec.audio_peak !== null && rec.audio_peak < QUIET_PEAK && (words <= 3 || isOnlyStockPhrases(data.text));

    const version = await nextVersion(env, "transcripts", id, "raw");
    await env.DB.batch([
      ...saveTranscript(env, rec, "raw", version, {
        text: invented ? "" : data.text,
        segments: invented ? [] : data.segments,
        language: data.language,
        provider,
        model,
      }),
      env.DB.prepare(
        "UPDATE recordings SET duration_sec = COALESCE(?, duration_sec), language = COALESCE(?, language), updated_at = ? WHERE id = ?",
      ).bind(data.durationSec ?? null, data.language ?? null, now(), id),
    ]);
    return { provider, model, chars: invented ? 0 : data.text.length };
  });
}

// ── clean ───────────────────────────────────────────────────────────────────

export function cleanStage(env: Env, id: string) {
  return guarded(env, id, async () => {
    const rec = await loadRecording(env, id);
    await setStatus(env, id, "analyzing", "Cleaning transcript");
    const { raw } = await currentTranscripts(env, id);
    if (!raw) throw new Error("No raw transcript yet");

    const version = await nextVersion(env, "transcripts", id, "cleaned");
    if (!raw.text.trim()) {
      await env.DB.batch(saveTranscript(env, rec, "cleaned", version, { text: "" }));
      return { chunks: 0 };
    }

    const vocabulary = await loadVocabulary(env, rec.user_id, 60);
    const segments = raw.segments ? (JSON.parse(raw.segments) as Segment[]) : null;
    const chunks = chunkText(raw.text, segments, CLEAN_CHUNK_CHARS);
    const cleaned: string[] = [];
    let used = { provider: "", model: "" };
    for (const chunk of chunks) {
      const result = await complete(env, {
        system: cleanSystemPrompt(vocabulary),
        user: chunk,
        maxTokens: Math.ceil(estimateTokens(chunk) * 1.3) + 200,
        temperature: 0,
        check: (text) => {
          const ratio = text.length / chunk.length;
          return ratio < 0.35 || ratio > 1.3 ? `length changed too much (${ratio.toFixed(2)}x)` : null;
        },
      });
      cleaned.push(result.data);
      used = { provider: result.provider, model: result.model };
    }

    // The model sometimes keeps a misheard name; fix known names deterministically.
    const spellings = await loadSpellings(env, rec.user_id);
    await env.DB.batch(
      saveTranscript(env, rec, "cleaned", version, {
        text: applySpellings(cleaned.join("\n\n"), spellings),
        language: raw.language,
        ...used,
      }),
    );
    return { chunks: chunks.length, ...used };
  });
}

// ── understand ──────────────────────────────────────────────────────────────

const normalizeName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const cleanList = (items: string[], max: number) =>
  [...new Map(items.map((i) => i.trim()).filter(Boolean).map((i) => [i.toLowerCase(), i])).values()].slice(0, max);
const isDate = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

function sanitize(u: Understanding, maxThoughts = 12): Understanding {
  const thoughts = u.thoughts.slice(0, maxThoughts).map((t) => ({
    ...t,
    title: truncate(t.title.trim(), 120),
    summary: t.summary.trim(),
    key_quote: truncate(t.key_quote.trim(), 400),
    project: t.project?.trim() || null,
    topics: cleanList(t.topics.map((x) => x.toLowerCase()), 4),
    people: cleanList(t.people, 10),
    organizations: cleanList(t.organizations, 10),
    products: cleanList(t.products, 10),
    places: cleanList(t.places, 10),
  }));
  const index = (i: number | null) => (i !== null && i >= 0 && i < thoughts.length ? i : null);
  return {
    ...u,
    title: truncate(u.title.trim().replace(/^["']|["'.]$/g, ""), 120) || "Untitled memo",
    thoughts,
    tasks: u.tasks
      .filter((t) => t.title.trim())
      .slice(0, 20)
      .map((t) => ({ ...t, due_date: isDate(t.due_date), thought_index: index(t.thought_index) })),
    decisions: u.decisions
      .filter((d) => d.statement.trim())
      .slice(0, 20)
      .map((d) => ({ ...d, thought_index: index(d.thought_index) })),
    questions: u.questions
      .filter((q) => q.question.trim())
      .slice(0, 20)
      .map((q) => ({ ...q, thought_index: index(q.thought_index) })),
    reminders: u.reminders
      .filter((r) => r.text.trim() && isLocalDateTime(r.remind_at))
      .slice(0, 10)
      .map((r) => ({ ...r, text: truncate(r.text.trim(), 300), thought_index: index(r.thought_index) })),
    vocabulary: cleanList(u.vocabulary.filter(isNameLike), 10),
  };
}

async function analyse(env: Env, rec: RecordingRow, transcript: string, timezone: string) {
  const { results: projectRows } = await env.DB.prepare(
    "SELECT name, aliases FROM projects WHERE user_id = ? AND status = 'active' ORDER BY confirmed DESC, updated_at DESC LIMIT 40",
  )
    .bind(rec.user_id)
    .all<{ name: string; aliases: string }>();
  const projects = projectRows.map((p) => {
    const aliases = JSON.parse(p.aliases) as string[];
    return aliases.length ? `${p.name} (also heard as: ${aliases.join(", ")})` : p.name;
  });
  const vocabulary = await loadVocabulary(env, rec.user_id, 40);
  const recordedAt = localTime(rec.recorded_at, timezone);
  const chunks = transcript.length > UNDERSTAND_CHUNK_CHARS * 3 ? chunkText(transcript, null, UNDERSTAND_CHUNK_CHARS) : [transcript];

  const parts: Understanding[] = [];
  let used = { provider: "", model: "" };
  for (const [index, chunk] of chunks.entries()) {
    const result = await complete(env, {
      system: understandSystemPrompt(),
      user: understandUserPrompt({
        transcript: chunk,
        recordedAt,
        timezone,
        projects,
        vocabulary,
        part: chunks.length > 1 ? { index, total: chunks.length } : undefined,
      }),
      schema: UnderstandSchema,
      schemaName: "memo_understanding",
      maxTokens: 3000,
      temperature: 0.1,
    });
    parts.push(result.data);
    used = { provider: result.provider, model: result.model };
  }
  if (parts.length === 1) return { understanding: sanitize(parts[0]), ...used };

  // Long recording: merge the parts, then write one overview.
  const offset = (i: number) => parts.slice(0, i).reduce((n, p) => n + p.thoughts.length, 0);
  const shift = (n: number | null, i: number) => (n === null ? null : n + offset(i));
  const overview = await complete(env, {
    system: synthesisSystemPrompt(),
    user: parts
      .map((p, i) => `Part ${i + 1}: ${p.title}\n${p.detailed_summary}`)
      .join("\n\n"),
    schema: SynthesisSchema,
    schemaName: "memo_overview",
    maxTokens: 1200,
  });
  const merged: Understanding = {
    ...overview.data,
    language: parts[0].language,
    thoughts: parts.flatMap((p) => p.thoughts),
    tasks: parts.flatMap((p, i) => p.tasks.map((t) => ({ ...t, thought_index: shift(t.thought_index, i) }))),
    decisions: parts.flatMap((p, i) => p.decisions.map((d) => ({ ...d, thought_index: shift(d.thought_index, i) }))),
    questions: parts.flatMap((p, i) => p.questions.map((q) => ({ ...q, thought_index: shift(q.thought_index, i) }))),
    reminders: parts.flatMap((p, i) => p.reminders.map((r) => ({ ...r, thought_index: shift(r.thought_index, i) }))),
    vocabulary: parts.flatMap((p) => p.vocabulary),
  };
  // Long recordings legitimately hold more than 12 thoughts.
  return { understanding: sanitize(merged, 12 * parts.length), ...used };
}

/**
 * Maps AI project names onto existing projects: exact name or alias first, then a near-miss
 * spelling ("Lumena" for "Lumina"). Only genuinely new names create a project.
 */
async function resolveProjects(env: Env, userId: string, names: string[]): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, aliases FROM projects WHERE user_id = ? ORDER BY confirmed DESC, created_at",
  )
    .bind(userId)
    .all<{ id: string; name: string; aliases: string }>();
  const { results: vocab } = await env.DB.prepare("SELECT term FROM vocabulary WHERE user_id = ? AND source = 'user'")
    .bind(userId)
    .all<{ term: string }>();
  const known = results.map((p) => ({ id: p.id, names: [p.name, ...(JSON.parse(p.aliases) as string[])], aliases: JSON.parse(p.aliases) as string[] }));
  const lookup = new Map<string, string>();
  for (const p of known) for (const n of p.names) lookup.set(normalizeName(n), p.id);

  const resolved = new Map<string, string>();
  const statements: D1PreparedStatement[] = [];
  for (const name of names) {
    const key = normalizeName(name);
    if (!key || resolved.has(name)) continue;
    let id = lookup.get(key);
    if (!id) {
      const near = known.find((p) => p.names.some((n) => isNearName(n, name)));
      if (near) {
        id = near.id;
        // Remember the misheard form so it matches exactly next time.
        near.aliases.push(name);
        near.names.push(name);
        statements.push(
          env.DB.prepare("UPDATE projects SET aliases = ? WHERE id = ?").bind(JSON.stringify(near.aliases.slice(0, 20)), near.id),
        );
      }
    }
    if (!id) {
      id = newId();
      // Prefer the user's own spelling of the name if they taught it.
      const spelled = vocab.find((v) => isNearName(v.term, name))?.term ?? name;
      known.push({ id, names: [spelled], aliases: [] });
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO projects (id, user_id, name, origin, confirmed, created_at, updated_at) VALUES (?, ?, ?, 'ai', 0, ?, ?)",
        ).bind(id, userId, spelled, now(), now()),
      );
    }
    lookup.set(key, id);
    resolved.set(name, id);
  }
  if (statements.length) {
    await env.DB.batch(statements);
    // A concurrent memo may have created the same project first; re-read ids by name.
    const { results: fresh } = await env.DB.prepare("SELECT id, name FROM projects WHERE user_id = ?")
      .bind(userId)
      .all<{ id: string; name: string }>();
    const byName = new Map(fresh.map((p) => [normalizeName(p.name), p.id]));
    const valid = new Set(fresh.map((p) => p.id));
    for (const [name, id] of resolved) {
      if (valid.has(id)) continue;
      const again = byName.get(normalizeName(name)) ?? fresh.find((p) => isNearName(p.name, name))?.id;
      if (again) resolved.set(name, again);
      else resolved.delete(name);
    }
  }
  return resolved;
}

async function resolveNamed(
  env: Env,
  table: "topics" | "entities",
  userId: string,
  items: { name: string; kind?: string }[],
): Promise<Map<string, string>> {
  const key = (i: { name: string; kind?: string }) => `${i.kind ?? ""}:${i.name.toLowerCase()}`;
  const unique = [...new Map(items.map((i) => [key(i), i])).values()];
  if (!unique.length) return new Map();
  await env.DB.batch(
    unique.map((i) =>
      table === "topics"
        ? env.DB.prepare("INSERT OR IGNORE INTO topics (id, user_id, name, created_at) VALUES (?, ?, ?, ?)").bind(
            newId(),
            userId,
            i.name,
            now(),
          )
        : env.DB.prepare(
            "INSERT OR IGNORE INTO entities (id, user_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(newId(), userId, i.kind, i.name, now()),
    ),
  );
  const { results } = await env.DB.prepare(
    table === "topics"
      ? "SELECT id, name, NULL AS kind FROM topics WHERE user_id = ?"
      : "SELECT id, name, kind FROM entities WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string; name: string; kind: string | null }>();
  const ids = new Map(results.map((r) => [key({ name: r.name, kind: r.kind ?? undefined }), r.id] as const));
  const resolved = new Map<string, string>();
  for (const item of unique) {
    const found = ids.get(key(item));
    if (found) resolved.set(key(item), found);
  }
  return resolved;
}

function respell(u: Understanding, spellings: Spelling[]): Understanding {
  const fix = (t: string) => applySpellings(t, spellings);
  const fixNullable = (t: string | null) => (t === null ? null : fix(t));
  return {
    ...u,
    title: fix(u.title),
    summary: fix(u.summary),
    detailed_summary: fix(u.detailed_summary),
    thoughts: u.thoughts.map((t) => ({
      ...t,
      title: fix(t.title),
      summary: fix(t.summary),
      key_quote: fix(t.key_quote),
      project: fixNullable(t.project),
      people: t.people.map(fix),
      organizations: t.organizations.map(fix),
      products: t.products.map(fix),
    })),
    tasks: u.tasks.map((t) => ({ ...t, title: fix(t.title) })),
    decisions: u.decisions.map((d) => ({ ...d, statement: fix(d.statement), rationale: fixNullable(d.rationale) })),
    questions: u.questions.map((q) => ({ ...q, question: fix(q.question) })),
    reminders: u.reminders.map((r) => ({ ...r, text: fix(r.text) })),
    vocabulary: u.vocabulary.map(fix),
  };
}

export function understandStage(env: Env, id: string) {
  return guarded(env, id, async () => {
    const rec = await loadRecording(env, id);
    await setStatus(env, id, "analyzing", "Understanding");
    const user = await getUser(env, rec.user_id);
    const t = await currentTranscripts(env, id);
    const source = t.edited ?? t.cleaned ?? t.raw;
    if (!source) throw new Error("No transcript yet");

    // Previous AI output for this recording is replaced; anything the user acted on is kept.
    const { results: oldThoughts } = await env.DB.prepare("SELECT id FROM thoughts WHERE recording_id = ?")
      .bind(id)
      .all<{ id: string }>();
    const clearOld = [
      env.DB.prepare("DELETE FROM thoughts WHERE recording_id = ?").bind(id),
      env.DB.prepare("DELETE FROM tasks WHERE recording_id = ? AND origin = 'ai' AND status = 'suggested'").bind(id),
      env.DB.prepare("DELETE FROM decisions WHERE recording_id = ? AND origin = 'ai' AND status = 'active'").bind(id),
      env.DB.prepare("DELETE FROM questions WHERE recording_id = ? AND origin = 'ai' AND status = 'open'").bind(id),
      // Reminders from a memo start as 'suggested'; once confirmed they belong to the user (origin 'app').
      env.DB.prepare("DELETE FROM reminders WHERE recording_id = ? AND origin = 'voice' AND status IN ('suggested', 'pending')").bind(id),
      env.DB.prepare("DELETE FROM recordings_fts WHERE recording_id = ?").bind(id),
    ];
    if (oldThoughts.length) await env.VECTORS.deleteByIds(oldThoughts.map((r) => r.id));

    if (!source.text.trim()) {
      await env.DB.batch([
        ...clearOld,
        env.DB.prepare(
          `UPDATE recordings SET title = CASE WHEN title_edited = 1 THEN title ELSE 'Silent recording' END,
             summary = 'No speech was detected in this recording.', summary_detailed = NULL, category = 'other', updated_at = ?
           WHERE id = ?`,
        ).bind(now(), id),
      ]);
      return { thoughts: 0 };
    }

    const analysed = await analyse(env, rec, source.text, user.timezone);
    const { provider, model } = analysed;
    // Same deterministic name fix as the cleaned transcript, applied to everything the model wrote.
    const u = respell(analysed.understanding, await loadSpellings(env, rec.user_id));
    const projectIds = await resolveProjects(
      env,
      rec.user_id,
      u.thoughts.map((th) => th.project).filter((p): p is string => Boolean(p)),
    );
    const topicIds = await resolveNamed(
      env,
      "topics",
      rec.user_id,
      u.thoughts.flatMap((th) => th.topics.map((name) => ({ name }))),
    );
    const entityItems = u.thoughts.flatMap((th) => [
      ...th.people.map((name) => ({ name, kind: "person" })),
      ...th.organizations.map((name) => ({ name, kind: "company" })),
      ...th.products.map((name) => ({ name, kind: "product" })),
      ...th.places.map((name) => ({ name, kind: "place" })),
    ]);
    const entityIds = await resolveNamed(env, "entities", rec.user_id, entityItems);

    const analysisId = newId();
    const version = await nextVersion(env, "analyses", id);
    const ts = now();
    const thoughtIds = u.thoughts.map(() => newId());
    const thoughtId = (i: number | null) => (i === null ? null : thoughtIds[i]);
    const thoughtProject = (i: number | null) => {
      const name = i === null ? null : u.thoughts[i].project;
      return name ? projectIds.get(name) ?? null : null;
    };

    const statements: D1PreparedStatement[] = [
      ...clearOld,
      env.DB.prepare("UPDATE analyses SET is_current = 0 WHERE recording_id = ?").bind(id),
      env.DB.prepare(
        `INSERT INTO analyses (id, recording_id, user_id, version, is_current, provider, model, prompt_version, output, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(analysisId, id, rec.user_id, version, provider, model, PROMPT_VERSION, JSON.stringify(u), ts),
      env.DB.prepare(
        `UPDATE recordings SET title = CASE WHEN title_edited = 1 THEN title ELSE ? END,
           summary = ?, summary_detailed = ?, category = ?, language = COALESCE(language, ?), updated_at = ?
         WHERE id = ?`,
      ).bind(u.title, u.summary, u.detailed_summary, u.category, u.language, ts, id),
    ];

    u.thoughts.forEach((th, i) => {
      statements.push(
        env.DB.prepare(
          `INSERT INTO thoughts (id, recording_id, user_id, analysis_id, idx, type, title, summary, content, project_id, recorded_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          thoughtIds[i],
          id,
          rec.user_id,
          analysisId,
          i,
          th.type,
          th.title,
          th.summary,
          th.key_quote,
          thoughtProject(i),
          rec.recorded_at,
          ts,
        ),
      );
      for (const name of th.topics) {
        const topicId = topicIds.get(`:${name.toLowerCase()}`);
        if (topicId)
          statements.push(
            env.DB.prepare("INSERT OR IGNORE INTO thought_topics (thought_id, topic_id) VALUES (?, ?)").bind(
              thoughtIds[i],
              topicId,
            ),
          );
      }
      const named = [
        ...th.people.map((n) => `person:${n.toLowerCase()}`),
        ...th.organizations.map((n) => `company:${n.toLowerCase()}`),
        ...th.products.map((n) => `product:${n.toLowerCase()}`),
        ...th.places.map((n) => `place:${n.toLowerCase()}`),
      ];
      for (const k of named) {
        const entityId = entityIds.get(k);
        if (entityId)
          statements.push(
            env.DB.prepare("INSERT OR IGNORE INTO thought_entities (thought_id, entity_id) VALUES (?, ?)").bind(
              thoughtIds[i],
              entityId,
            ),
          );
      }
    });

    for (const task of u.tasks) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO tasks (id, user_id, recording_id, thought_id, title, due_date, due_text, status, project_id, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', ?, 'ai', ?, ?)`,
        ).bind(
          newId(),
          rec.user_id,
          id,
          thoughtId(task.thought_index),
          task.title,
          task.due_date,
          task.due_text,
          thoughtProject(task.thought_index),
          ts,
          ts,
        ),
      );
    }
    for (const d of u.decisions) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO decisions (id, user_id, recording_id, thought_id, statement, rationale, project_id, decided_at, status, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 'ai', ?, ?)`,
        ).bind(
          newId(),
          rec.user_id,
          id,
          thoughtId(d.thought_index),
          d.statement,
          d.rationale,
          thoughtProject(d.thought_index),
          rec.recorded_at,
          ts,
          ts,
        ),
      );
    }
    for (const q of u.questions) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO questions (id, user_id, recording_id, thought_id, question, project_id, status, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', 'ai', ?, ?)`,
        ).bind(newId(), rec.user_id, id, thoughtId(q.thought_index), q.question, thoughtProject(q.thought_index), ts, ts),
      );
    }
    for (const r of u.reminders) {
      const remindAt = zonedDateTime(r.remind_at, user.timezone);
      // A time before the memo was recorded is a misread, not a reminder.
      if (remindAt < rec.recorded_at - 60_000) continue;
      statements.push(
        env.DB.prepare(
          `INSERT INTO reminders (id, user_id, text, remind_at, status, origin, recording_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'suggested', 'voice', ?, ?, ?)`,
        ).bind(newId(), rec.user_id, r.text, remindAt, id, ts, ts),
      );
    }
    for (const term of u.vocabulary) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO vocabulary (id, user_id, term, count, source, created_at, updated_at) VALUES (?, ?, ?, 1, 'learned', ?, ?)
           ON CONFLICT DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
        ).bind(newId(), rec.user_id, term, ts, ts),
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO recordings_fts (recording_id, user_id, title, summary, transcript) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, rec.user_id, rec.title_edited ? rec.title : u.title, u.detailed_summary, source.text),
    );

    await env.DB.batch(statements);
    return { provider, model, thoughts: u.thoughts.length, tasks: u.tasks.length, reminders: u.reminders.length };
  });
}

// ── reconcile ───────────────────────────────────────────────────────────────

/**
 * Updates what was already open (tasks, decisions, reminders, questions) from this memo.
 * If every provider is busy the memo still completes; it just changes nothing this time.
 */
export function reconcileStage(env: Env, id: string) {
  return guarded(env, id, async () => {
    await setStatus(env, id, "organizing", "Updating your open items");
    try {
      return await reconcileRecording(env, id);
    } catch (err) {
      console.error("reconcile skipped", id, errorMessage(err));
      await env.DB.prepare("UPDATE recordings SET reconciled_at = ? WHERE id = ?").bind(now(), id).run();
      return { changes: 0, skipped: truncate(errorMessage(err), 200) };
    }
  });
}

// ── embed ───────────────────────────────────────────────────────────────────

export function embedStage(env: Env, id: string) {
  return guarded(env, id, async () => {
    const rec = await loadRecording(env, id);
    await setStatus(env, id, "organizing", "Indexing for search");
    const { results: thoughts } = await env.DB.prepare(
      "SELECT id, type, title, summary, content FROM thoughts WHERE recording_id = ? ORDER BY idx",
    )
      .bind(id)
      .all<{ id: string; type: string; title: string; summary: string; content: string }>();
    if (!thoughts.length) return { vectors: 0 };

    const info = (await env.VECTORS.describe()) as { vectorCount?: number; vectorsCount?: number };
    const stored = info.vectorCount ?? info.vectorsCount ?? 0;
    if (stored + thoughts.length > VECTOR_BUDGET) {
      await env.DB.prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES ('vector_budget_reached', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2`,
      )
        .bind(JSON.stringify({ stored, budget: VECTOR_BUDGET }), now())
        .run();
      return { vectors: 0, skipped: "vector budget reached" };
    }

    const vectors = await embed(
      env,
      thoughts.map((t) => `${t.title}\n${t.summary}\n${t.content}`),
      "document",
    );
    await env.VECTORS.upsert(
      thoughts.map((t, i) => ({
        id: t.id,
        values: vectors[i],
        metadata: { user_id: rec.user_id, recording_id: id, type: t.type, recorded_at: rec.recorded_at },
      })),
    );
    await env.DB.prepare("UPDATE thoughts SET embedded_at = ? WHERE recording_id = ?").bind(now(), id).run();
    return { vectors: thoughts.length };
  });
}

// ── finish / failure ────────────────────────────────────────────────────────

export async function finishStage(env: Env, id: string) {
  await env.DB.prepare(
    "UPDATE recordings SET status = 'completed', status_detail = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(now(), id)
    .run();
  return { done: true };
}

export async function markFailed(env: Env, id: string, message: string) {
  await env.DB.prepare(
    "UPDATE recordings SET status = 'failed', status_detail = NULL, last_error = ?, updated_at = ? WHERE id = ?",
  )
    .bind(truncate(message, 1000), now(), id)
    .run();
  return { failed: true };
}

/** Works out which stage a recording should resume from, based on what's already stored. */
/**
 * A typed note (from Claude or the app) goes through the same pipeline as a memo, minus
 * transcription and clean-up: the text is kept exactly as written.
 */
export async function ingestNote(env: Env, input: { id: string; userId: string; text: string; source: string }) {
  const ts = now();
  const rec = { id: input.id, user_id: input.userId } as RecordingRow;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recordings (id, user_id, r2_key, mime, bytes, duration_sec, recorded_at, source, status, created_at, updated_at)
       VALUES (?, ?, NULL, 'text/plain', ?, NULL, ?, ?, 'queued', ?, ?)`,
    ).bind(input.id, input.userId, input.text.length, ts, input.source, ts, ts),
    ...saveTranscript(env, rec, "raw", 1, { text: input.text, provider: input.source }),
    ...saveTranscript(env, rec, "cleaned", 1, { text: input.text, provider: input.source }),
  ]);
}

export async function resumeStage(env: Env, id: string): Promise<Stage> {
  const t = await currentTranscripts(env, id);
  if (!t.raw) return "transcribe";
  if (!t.cleaned) return "clean";
  const analysis = await env.DB.prepare("SELECT 1 FROM analyses WHERE recording_id = ? AND is_current = 1")
    .bind(id)
    .first();
  if (!analysis) return "understand";
  const reconciled = await env.DB.prepare("SELECT reconciled_at FROM recordings WHERE id = ?")
    .bind(id)
    .first<{ reconciled_at: number | null }>();
  if (!reconciled?.reconciled_at) return "reconcile";
  return "embed";
}

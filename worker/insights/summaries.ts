import { complete } from "../ai/router";
import { getUser } from "../lib/data";
import { addDays, zonedDayStart } from "../lib/time";
import { estimateTokens, localTime, newId, now } from "../lib/util";
import {
  type PartialSummary,
  PartialSummarySchema,
  partialSummarySystem,
  type RangeSummary,
  RangeSummarySchema,
  rangeSummarySystem,
} from "./prompts";

/** Keeps each LLM request inside Groq's per-minute token cap (see router). */
const CHUNK_TOKENS = 4_500;

export interface RangeStats {
  memos: number;
  minutes: number;
  thoughts: number;
  tasksCreated: number;
  tasksDone: number;
  decisions: number;
  openQuestions: number;
  activeDays: number;
  projects: { name: string; thoughts: number }[];
  topics: { name: string; count: number }[];
}

export interface RangeSummaryResult {
  id: string | null;
  start: string;
  end: string;
  summary: RangeSummary | null;
  stats: RangeStats;
  createdAt: number | null;
  cached: boolean;
  provider: string | null;
  model: string | null;
}

interface ThoughtLine {
  recorded_at: number;
  type: string;
  title: string;
  summary: string;
  project: string | null;
}

async function loadStats(env: Env, userId: string, from: number, to: number, tz: string): Promise<RangeStats> {
  const [base, thoughts, tasks, decisions, questions, projects, topics, days] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS memos, COALESCE(SUM(duration_sec), 0) AS seconds FROM recordings
       WHERE user_id = ?1 AND recorded_at >= ?2 AND recorded_at < ?3`,
    )
      .bind(userId, from, to)
      .first<{ memos: number; seconds: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM thoughts WHERE user_id = ?1 AND recorded_at >= ?2 AND recorded_at < ?3")
      .bind(userId, from, to)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS created, SUM(CASE WHEN k.status = 'done' THEN 1 ELSE 0 END) AS done
       FROM tasks k JOIN recordings r ON r.id = k.recording_id
       WHERE k.user_id = ?1 AND k.status != 'dismissed' AND r.recorded_at >= ?2 AND r.recorded_at < ?3`,
    )
      .bind(userId, from, to)
      .first<{ created: number; done: number | null }>(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM decisions WHERE user_id = ?1 AND status != 'dismissed' AND decided_at >= ?2 AND decided_at < ?3",
    )
      .bind(userId, from, to)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM questions q JOIN recordings r ON r.id = q.recording_id
       WHERE q.user_id = ?1 AND q.status = 'open' AND r.recorded_at >= ?2 AND r.recorded_at < ?3`,
    )
      .bind(userId, from, to)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT p.name, COUNT(*) AS thoughts FROM thoughts t JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = ?1 AND t.recorded_at >= ?2 AND t.recorded_at < ?3
       GROUP BY p.id ORDER BY thoughts DESC LIMIT 8`,
    )
      .bind(userId, from, to)
      .all<{ name: string; thoughts: number }>(),
    env.DB.prepare(
      `SELECT tp.name, COUNT(*) AS count FROM thought_topics tt
       JOIN thoughts t ON t.id = tt.thought_id JOIN topics tp ON tp.id = tt.topic_id
       WHERE t.user_id = ?1 AND t.recorded_at >= ?2 AND t.recorded_at < ?3
       GROUP BY tp.id ORDER BY count DESC LIMIT 10`,
    )
      .bind(userId, from, to)
      .all<{ name: string; count: number }>(),
    env.DB.prepare("SELECT recorded_at FROM recordings WHERE user_id = ?1 AND recorded_at >= ?2 AND recorded_at < ?3")
      .bind(userId, from, to)
      .all<{ recorded_at: number }>(),
  ]);
  return {
    memos: base?.memos ?? 0,
    minutes: Math.round((base?.seconds ?? 0) / 60),
    thoughts: thoughts?.n ?? 0,
    tasksCreated: tasks?.created ?? 0,
    tasksDone: tasks?.done ?? 0,
    decisions: decisions?.n ?? 0,
    openQuestions: questions?.n ?? 0,
    activeDays: new Set(days.results.map((r) => localTime(r.recorded_at, tz).date)).size,
    projects: projects.results,
    topics: topics.results,
  };
}

/** The raw material: every thought, task, decision and question in the range, one line each. */
async function loadMaterial(env: Env, userId: string, from: number, to: number, tz: string): Promise<string[]> {
  const [thoughts, tasks, decisions, questions] = await Promise.all([
    env.DB.prepare(
      `SELECT t.recorded_at, t.type, t.title, t.summary, p.name AS project
       FROM thoughts t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = ?1 AND t.recorded_at >= ?2 AND t.recorded_at < ?3
       ORDER BY t.recorded_at, t.idx`,
    )
      .bind(userId, from, to)
      .all<ThoughtLine>(),
    env.DB.prepare(
      `SELECT k.title, k.due_date, k.status, p.name AS project FROM tasks k
       JOIN recordings r ON r.id = k.recording_id LEFT JOIN projects p ON p.id = k.project_id
       WHERE k.user_id = ?1 AND k.status != 'dismissed' AND r.recorded_at >= ?2 AND r.recorded_at < ?3`,
    )
      .bind(userId, from, to)
      .all<{ title: string; due_date: string | null; status: string; project: string | null }>(),
    env.DB.prepare(
      `SELECT d.statement, d.status, p.name AS project FROM decisions d LEFT JOIN projects p ON p.id = d.project_id
       WHERE d.user_id = ?1 AND d.status IN ('active', 'superseded', 'reversed') AND d.decided_at >= ?2 AND d.decided_at < ?3
       ORDER BY d.decided_at`,
    )
      .bind(userId, from, to)
      .all<{ statement: string; status: string; project: string | null }>(),
    env.DB.prepare(
      `SELECT q.question, q.status, p.name AS project FROM questions q
       JOIN recordings r ON r.id = q.recording_id LEFT JOIN projects p ON p.id = q.project_id
       WHERE q.user_id = ?1 AND q.status != 'dismissed' AND r.recorded_at >= ?2 AND r.recorded_at < ?3`,
    )
      .bind(userId, from, to)
      .all<{ question: string; status: string; project: string | null }>(),
  ]);
  const tag = (p: string | null) => `[${p ?? "Other"}]`;
  return [
    ...thoughts.results.map(
      (t) => `${localTime(t.recorded_at, tz).date} ${tag(t.project)} ${t.type}: ${t.title}. ${t.summary}`,
    ),
    ...tasks.results.map(
      (t) => `TASK ${tag(t.project)} ${t.title}${t.due_date ? ` (due ${t.due_date})` : ""}${t.status === "done" ? " [done]" : ""}`,
    ),
    // Replaced decisions stay in, marked, so a summary can say where the thinking ended up.
    ...decisions.results.map((d) => `DECISION ${tag(d.project)} ${d.statement}${d.status === "active" ? "" : " [changed later]"}`),
    ...questions.results.map((q) => `QUESTION ${tag(q.project)} ${q.question}${q.status === "resolved" ? " [answered]" : ""}`),
  ];
}

function chunkLines(lines: string[], maxTokens: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const t = estimateTokens(line) + 1;
    if (current.length && tokens + t > maxTokens) {
      chunks.push(current.join("\n"));
      current = [];
      tokens = 0;
    }
    current.push(line);
    tokens += t;
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function statsBlock(stats: RangeStats, start: string, end: string): string {
  return [
    `Period: ${start} to ${end}`,
    `Memos: ${stats.memos} (${stats.minutes} min) on ${stats.activeDays} day(s); thoughts: ${stats.thoughts}`,
    `Tasks: ${stats.tasksCreated} (${stats.tasksDone} done); decisions: ${stats.decisions}; open questions: ${stats.openQuestions}`,
    stats.projects.length ? `Most discussed projects: ${stats.projects.map((p) => `${p.name} (${p.thoughts})`).join(", ")}` : "",
    stats.topics.length ? `Frequent topics: ${stats.topics.map((t) => `${t.name} (${t.count})`).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function partialToText(p: PartialSummary, index: number): string {
  return [
    `Slice ${index + 1}:`,
    ...p.notes_by_project.flatMap((g) => g.notes.map((n) => `[${g.name}] ${n}`)),
    ...p.ideas.map((i) => `IDEA ${i}`),
    ...p.decisions.map((d) => `DECISION ${d}`),
    ...p.actions.map((a) => `TASK ${a}`),
    ...p.questions.map((q) => `QUESTION ${q}`),
  ].join("\n");
}

/**
 * Summary of everything captured between two dates (inclusive, user's timezone).
 * Cached per range; regenerated when memos in the range change or on request.
 */
export async function summarizeRange(
  env: Env,
  userId: string,
  start: string,
  end: string,
  options: { refresh?: boolean } = {},
): Promise<RangeSummaryResult> {
  const user = await getUser(env, userId);
  const tz = user.timezone;
  const from = zonedDayStart(start, tz);
  const to = zonedDayStart(addDays(end, 1), tz);

  // Fresh while no memo in the range changed and no later memo changed an item from the range
  // (e.g. a decision from last week replaced today).
  const source = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(COALESCE(MAX(r.updated_at), 0), COALESCE((
       SELECT MAX(COALESCE(x.undone_at, x.created_at)) FROM context_changes x
       WHERE x.user_id = ?1 AND x.item_id IN (
         SELECT id FROM decisions WHERE user_id = ?1 AND decided_at >= ?2 AND decided_at < ?3
         UNION SELECT k.id FROM tasks k JOIN recordings kr ON kr.id = k.recording_id WHERE k.user_id = ?1 AND kr.recorded_at >= ?2 AND kr.recorded_at < ?3
         UNION SELECT q.id FROM questions q JOIN recordings qr ON qr.id = q.recording_id WHERE q.user_id = ?1 AND qr.recorded_at >= ?2 AND qr.recorded_at < ?3)
     ), 0)) AS latest
     FROM recordings r WHERE r.user_id = ?1 AND r.recorded_at >= ?2 AND r.recorded_at < ?3`,
  )
    .bind(userId, from, to)
    .first<{ n: number; latest: number }>();
  const sourceCount = source?.n ?? 0;
  const sourceLatest = source?.latest ?? 0;

  const cached = await env.DB.prepare(
    "SELECT * FROM range_summaries WHERE user_id = ? AND start_date = ? AND end_date = ?",
  )
    .bind(userId, start, end)
    .first<{
      id: string;
      content: string;
      stats: string;
      source_count: number;
      source_updated_at: number;
      provider: string | null;
      model: string | null;
      created_at: number;
    }>();
  if (cached && !options.refresh && cached.source_count === sourceCount && cached.source_updated_at >= sourceLatest) {
    return {
      id: cached.id,
      start,
      end,
      summary: JSON.parse(cached.content) as RangeSummary,
      stats: JSON.parse(cached.stats) as RangeStats,
      createdAt: cached.created_at,
      cached: true,
      provider: cached.provider,
      model: cached.model,
    };
  }

  const stats = await loadStats(env, userId, from, to, tz);
  if (stats.thoughts === 0) {
    return { id: null, start, end, summary: null, stats, createdAt: null, cached: false, provider: null, model: null };
  }

  const lines = await loadMaterial(env, userId, from, to, tz);
  let material = lines.join("\n");
  let used = { provider: "", model: "" };

  // Long periods: condense slices first, then write one summary from the condensed notes.
  if (estimateTokens(material) > CHUNK_TOKENS) {
    const partials: string[] = [];
    for (const [index, chunk] of chunkLines(lines, CHUNK_TOKENS).entries()) {
      const part = await complete(env, {
        system: partialSummarySystem(),
        user: chunk,
        schema: PartialSummarySchema,
        schemaName: "partial_summary",
        maxTokens: 1500,
        temperature: 0.2,
      });
      partials.push(partialToText(part.data, index));
    }
    material = partials.join("\n\n");
  }

  const result = await complete(env, {
    system: rangeSummarySystem(),
    user: `${statsBlock(stats, start, end)}\n\nNotes:\n${material}`,
    schema: RangeSummarySchema,
    schemaName: "range_summary",
    maxTokens: 2500,
    temperature: 0.3,
    effort: "medium",
  });
  used = { provider: result.provider, model: result.model };

  const id = cached?.id ?? newId();
  const createdAt = now();
  await env.DB.prepare(
    `INSERT INTO range_summaries (id, user_id, start_date, end_date, content, stats, source_count, source_updated_at, provider, model, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(user_id, start_date, end_date) DO UPDATE SET
       content = ?5, stats = ?6, source_count = ?7, source_updated_at = ?8, provider = ?9, model = ?10, created_at = ?11`,
  )
    .bind(id, userId, start, end, JSON.stringify(result.data), JSON.stringify(stats), sourceCount, sourceLatest, used.provider, used.model, createdAt)
    .run();

  return { id, start, end, summary: result.data, stats, createdAt, cached: false, ...used };
}

import { HttpError } from "./util";

export interface RecordingRow {
  id: string;
  user_id: string;
  r2_key: string | null;
  mime: string;
  bytes: number;
  duration_sec: number | null;
  recorded_at: number;
  source: string;
  part_of: string | null;
  part_index: number | null;
  status: string;
  status_detail: string | null;
  attempts: number;
  last_error: string | null;
  workflow_id: string | null;
  title: string | null;
  title_edited: number;
  summary: string | null;
  summary_detailed: string | null;
  category: string | null;
  language: string | null;
  keep_audio: number;
  audio_deleted_at: number | null;
  audio_peak: number | null;
  created_at: number;
  updated_at: number;
}

export interface TranscriptRow {
  id: string;
  recording_id: string;
  kind: "raw" | "cleaned" | "edited";
  version: number;
  text: string;
  segments: string | null;
  language: string | null;
  provider: string | null;
  model: string | null;
  created_at: number;
}

export interface UserSettings {
  /** "auto" or an ISO-639-1 code forced on speech-to-text. */
  transcriptionLanguage: string;
}

const DEFAULT_SETTINGS: UserSettings = { transcriptionLanguage: "auto" };

export async function getRecording(env: Env, id: string): Promise<RecordingRow | null> {
  return env.DB.prepare("SELECT * FROM recordings WHERE id = ?").bind(id).first<RecordingRow>();
}

export async function getOwnedRecording(env: Env, id: string, userId: string): Promise<RecordingRow> {
  const row = await env.DB.prepare("SELECT * FROM recordings WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<RecordingRow>();
  if (!row) throw new HttpError(404, "Recording not found");
  return row;
}

export async function getUser(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT id, name, email, timezone, settings FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; email: string | null; timezone: string; settings: string }>();
  if (!row) throw new Error(`User ${id} not found`);
  let settings = DEFAULT_SETTINGS;
  try {
    settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(row.settings) as Partial<UserSettings>) };
  } catch {
    // keep defaults
  }
  return { ...row, settings };
}

/** Current transcript of each kind for a recording. */
export async function currentTranscripts(env: Env, recordingId: string) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM transcripts WHERE recording_id = ? AND is_current = 1",
  )
    .bind(recordingId)
    .all<TranscriptRow>();
  const byKind: Partial<Record<TranscriptRow["kind"], TranscriptRow>> = {};
  for (const row of results) byKind[row.kind] = row;
  return byKind;
}

/**
 * Names and terms that help speech-to-text and cleanup spell things right:
 * words the user added, then projects, then the most frequent learned terms.
 * Terms the user removed ("blocked") are never used, even if the AI keeps learning them.
 */
export async function loadVocabulary(env: Env, userId: string, limit = 40): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT term FROM (
       SELECT term, 2000000 + count AS weight FROM vocabulary WHERE user_id = ?1 AND source = 'user'
       UNION ALL
       SELECT name AS term, 1000000 AS weight FROM projects WHERE user_id = ?1 AND status = 'active'
       UNION ALL
       SELECT term, count AS weight FROM vocabulary WHERE user_id = ?1 AND source = 'learned'
     ) ORDER BY weight DESC LIMIT ?2`,
  )
    .bind(userId, limit * 2)
    .all<{ term: string }>();
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const { term } of results) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}

export async function setStatus(env: Env, id: string, status: string, detail: string | null = null) {
  await env.DB.prepare("UPDATE recordings SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?")
    .bind(status, detail, Date.now(), id)
    .run();
}

export async function audioBytesInUse(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM recordings WHERE r2_key IS NOT NULL")
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Canonical spellings for the deterministic post-cleanup fix: projects (with aliases) and words the user added. */
export async function loadSpellings(env: Env, userId: string): Promise<{ canonical: string; aliases: string[] }[]> {
  const [projects, vocab] = await Promise.all([
    env.DB.prepare("SELECT name, aliases FROM projects WHERE user_id = ? AND status = 'active' ORDER BY confirmed DESC")
      .bind(userId)
      .all<{ name: string; aliases: string }>(),
    env.DB.prepare("SELECT term FROM vocabulary WHERE user_id = ? AND source = 'user'").bind(userId).all<{ term: string }>(),
  ]);
  return [
    ...vocab.results.map((v) => ({ canonical: v.term, aliases: [] as string[] })),
    ...projects.results.map((p) => ({ canonical: p.name, aliases: JSON.parse(p.aliases) as string[] })),
  ];
}

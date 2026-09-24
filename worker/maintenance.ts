import { now } from "./lib/util";

/**
 * Deletes audio past the retention window once everything derived from it is safely stored.
 * Transcripts, thoughts, tasks and vectors are kept forever; pinned recordings keep their audio.
 */
export async function applyAudioRetention(env: Env) {
  const days = Number(env.AUDIO_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) return;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.r2_key FROM recordings r
     WHERE r.r2_key IS NOT NULL AND r.keep_audio = 0 AND r.status = 'completed' AND r.recorded_at < ?
       AND EXISTS (SELECT 1 FROM transcripts t WHERE t.recording_id = r.id AND t.kind = 'raw' AND t.is_current = 1)
       AND EXISTS (SELECT 1 FROM analyses a WHERE a.recording_id = r.id AND a.is_current = 1)
       AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.recording_id = r.id AND t.embedded_at IS NULL)
     LIMIT 50`,
  )
    .bind(now() - days * 24 * 3600_000)
    .all<{ id: string; r2_key: string }>();
  if (!results.length) return;

  await env.AUDIO.delete(results.map((r) => r.r2_key));
  await env.DB.batch(
    results.map((r) =>
      env.DB.prepare("UPDATE recordings SET r2_key = NULL, audio_deleted_at = ?, updated_at = ? WHERE id = ?").bind(
        now(),
        now(),
        r.id,
      ),
    ),
  );
}

/** Housekeeping: expired auth rows, and AI-guessed projects nothing refers to any more (e.g. after a re-analysis). */
export async function housekeeping(env: Env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()),
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now()),
    env.DB.prepare(
      `DELETE FROM projects WHERE origin = 'ai' AND confirmed = 0
         AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.project_id = projects.id)
         AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.project_id = projects.id)
         AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.project_id = projects.id)
         AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.project_id = projects.id)
         AND NOT EXISTS (SELECT 1 FROM ideas i WHERE i.project_id = projects.id)`,
    ),
  ]);
}

/**
 * Deletes audio files no recording points to (e.g. an upload that stored the file but failed
 * before its database row was written). Walks the bucket a page per run; only files older
 * than a day are considered, so in-flight uploads are never touched.
 */
export async function sweepOrphanAudio(env: Env, minAgeMs = 24 * 3600_000) {
  const cursorRow = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'orphan_sweep_cursor'").first<{
    value: string;
  }>();
  const listed = await env.AUDIO.list({ limit: 500, cursor: cursorRow?.value || undefined });
  const cutoff = now() - minAgeMs;
  const candidates = listed.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);

  const orphans: string[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const keys = candidates.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT r2_key FROM recordings WHERE r2_key IN (${keys.map(() => "?").join(",")})`,
    )
      .bind(...keys)
      .all<{ r2_key: string }>();
    const referenced = new Set(results.map((r) => r.r2_key));
    orphans.push(...keys.filter((k) => !referenced.has(k)));
  }
  if (orphans.length) await env.AUDIO.delete(orphans);

  const next = listed.truncated ? listed.cursor : "";
  await env.DB.prepare(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('orphan_sweep_cursor', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2`,
  )
    .bind(next, now())
    .run();
  return orphans.length;
}

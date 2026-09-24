import { errorMessage, now } from "./lib/util";
import { refreshStaleProjectSummaries } from "./insights/projects";
import { applyAudioRetention, housekeeping, sweepOrphanAudio } from "./maintenance";
import { sendDueReminders } from "./notify/reminders";
import { markFailed, resumeStage } from "./pipeline/steps";
import { startProcessing } from "./pipeline/workflow";

const STUCK_AFTER_MS = 15 * 60_000;
const MAX_AUTO_RESTARTS = 4;
const ACTIVE_WORKFLOW = new Set(["queued", "running", "waiting", "paused", "waitingForPause"]);

/** Restarts recordings whose pipeline died without finishing (e.g. a failed Workflow create). */
export async function sweepStuckRecordings(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT id, workflow_id, attempts FROM recordings
     WHERE status NOT IN ('completed', 'failed') AND updated_at < ?
     ORDER BY updated_at LIMIT 20`,
  )
    .bind(now() - STUCK_AFTER_MS)
    .all<{ id: string; workflow_id: string | null; attempts: number }>();

  for (const rec of results) {
    if (rec.workflow_id) {
      try {
        const { status } = await (await env.PROCESS.get(rec.workflow_id)).status();
        if (ACTIVE_WORKFLOW.has(status)) continue;
      } catch {
        // Unknown instance: treat as dead.
      }
    }
    try {
      if (rec.attempts >= MAX_AUTO_RESTARTS) {
        await markFailed(env, rec.id, "Processing kept failing, so automatic retries stopped. Tap retry to try again.");
        continue;
      }
      await startProcessing(env, rec.id, await resumeStage(env, rec.id));
    } catch (err) {
      console.error("sweep failed", rec.id, errorMessage(err));
    }
  }
}

/** The cron fires every minute (for reminders); heavier upkeep keys off the minute. */
export async function runScheduled(env: Env, scheduledTime: number) {
  const minute = new Date(scheduledTime).getUTCMinutes();
  const tasks: Promise<unknown>[] = [sendDueReminders(env)];
  if (minute % 5 === 0) tasks.push(sweepStuckRecordings(env));
  if (minute === 0) {
    tasks.push(applyAudioRetention(env), housekeeping(env), sweepOrphanAudio(env), refreshStaleProjectSummaries(env));
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) if (r.status === "rejected") console.error("scheduled task failed", errorMessage(r.reason));
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { errorMessage, now } from "../lib/util";
import {
  cleanStage,
  embedStage,
  finishStage,
  markFailed,
  type Stage,
  STAGES,
  transcribeStage,
  understandStage,
} from "./steps";

export interface ProcessParams {
  recordingId: string;
  from: Stage;
}

const STEP = {
  retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;

export class ProcessRecording extends WorkflowEntrypoint<Env, ProcessParams> {
  async run(event: WorkflowEvent<ProcessParams>, step: WorkflowStep) {
    const { recordingId } = event.payload;
    const start = STAGES.indexOf(event.payload.from);
    const runs = (stage: Stage) => start <= STAGES.indexOf(stage);

    try {
      if (runs("transcribe")) await step.do("transcribe", STEP, () => transcribeStage(this.env, recordingId));
      if (runs("clean")) await step.do("clean", STEP, () => cleanStage(this.env, recordingId));
      if (runs("understand")) await step.do("understand", STEP, () => understandStage(this.env, recordingId));
      if (runs("embed")) await step.do("embed", STEP, () => embedStage(this.env, recordingId));
      await step.do("finish", () => finishStage(this.env, recordingId));
    } catch (err) {
      const message = errorMessage(err);
      await step.do("mark failed", () => markFailed(this.env, recordingId, message));
      throw err;
    }
  }
}

/** Starts a fresh pipeline run for a recording, from the given stage. */
export async function startProcessing(env: Env, recordingId: string, from: Stage) {
  const instance = await env.PROCESS.create({
    id: `${recordingId}-${now()}`,
    params: { recordingId, from } satisfies ProcessParams,
  });
  await env.DB.prepare(
    `UPDATE recordings SET workflow_id = ?, status = 'queued', status_detail = NULL, last_error = NULL,
       attempts = attempts + 1, updated_at = ? WHERE id = ?`,
  )
    .bind(instance.id, now(), recordingId)
    .run();
  return instance.id;
}

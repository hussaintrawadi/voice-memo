import { z } from "zod";
import { toJsonSchema } from "../ai/router";

export const INSIGHTS_PROMPT_VERSION = "2026-09-19.1";

// No length/count limits in the schemas: constrained decoders reject those keywords.

export const RangeSummarySchema = z.strictObject({
  headline: z.string(),
  overview: z.string(),
  projects: z.array(
    z.strictObject({
      name: z.string(),
      summary: z.string(),
      highlights: z.array(z.string()),
    }),
  ),
  key_ideas: z.array(z.string()),
  decisions: z.array(z.string()),
  action_items: z.array(z.string()),
  open_questions: z.array(z.string()),
  themes: z.array(z.string()),
  emerging: z.string().nullable(),
  reflection: z.string(),
});
export type RangeSummary = z.infer<typeof RangeSummarySchema>;

/** Map step for long ranges: condensed notes for one slice of the period. */
export const PartialSummarySchema = z.strictObject({
  notes_by_project: z.array(z.strictObject({ name: z.string(), notes: z.array(z.string()) })),
  ideas: z.array(z.string()),
  decisions: z.array(z.string()),
  actions: z.array(z.string()),
  questions: z.array(z.string()),
});
export type PartialSummary = z.infer<typeof PartialSummarySchema>;

export const ProjectSummarySchema = z.strictObject({
  current_focus: z.string(),
  overview: z.string(),
  recent_ideas: z.array(z.string()),
  decisions: z.array(z.string()),
  open_questions: z.array(z.string()),
  next_steps: z.array(z.string()),
  evolution: z.string(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

const VOICE = `You write for the person who recorded these voice memos, addressing them as "you".
Be specific and concrete: name the actual ideas, products, people and numbers they mentioned. No filler, no generic advice, no praise.
Only use what the notes say. Never invent facts, decisions or tasks.`;

export function rangeSummarySystem(): string {
  return `${VOICE}
You are summarising everything they captured in a period. Synthesise; don't list memos one by one.
- headline: one line (under 14 words) naming what this period was mostly about.
- overview: 3 to 5 sentences on what they thought about, what moved forward and what kept coming back.
- projects: one entry per project that had real activity, most active first. summary: 2 to 3 sentences. highlights: up to 4 short bullets.
  Thoughts without a project go under "Other" only if they matter.
- key_ideas: the most important new ideas (up to 6).
- decisions: decisions made in this period (up to 6).
- action_items: concrete things to do, with dates when known (up to 8).
- open_questions: questions still unresolved (up to 6).
- themes: 2 to 6 short recurring themes, lowercase.
- emerging: one idea that is clearly gaining momentum (mentioned repeatedly or growing), else null.
- reflection: 1 to 2 sentences on what deserves attention next, based only on the notes.
Reply with only a JSON object matching this JSON Schema:
${JSON.stringify(toJsonSchema(RangeSummarySchema))}`;
}

export function partialSummarySystem(): string {
  return `${VOICE}
Condense this slice of a longer period into notes that will later be merged with other slices.
Keep every distinct idea, decision, action and open question; drop repetition. Group notes by project ("Other" for none).
Reply with only a JSON object matching this JSON Schema:
${JSON.stringify(toJsonSchema(PartialSummarySchema))}`;
}

export function projectSummarySystem(): string {
  return `${VOICE}
You maintain a living one-page brief for one project, built from everything they said about it over time (oldest first).
- current_focus: one sentence on what they're concentrating on right now (weight the most recent notes).
- overview: 3 to 5 sentences: what the project is and where it stands.
- recent_ideas: the newest ideas worth remembering (up to 6).
- decisions: decisions that still stand; skip ones later reversed (up to 6).
- open_questions: unresolved questions (up to 6).
- next_steps: concrete next actions they've mentioned or clearly implied by their own notes (up to 6).
- evolution: 2 to 4 sentences on how their thinking about this project has changed over time, naming shifts (e.g. "moved from X to Y").
Reply with only a JSON object matching this JSON Schema:
${JSON.stringify(toJsonSchema(ProjectSummarySchema))}`;
}

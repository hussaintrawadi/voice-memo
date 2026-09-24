import { z } from "zod";
import { toJsonSchema } from "../ai/router";

export const PROMPT_VERSION = "2026-09-19.3";

export const CATEGORIES = [
  "idea",
  "task",
  "reflection",
  "research",
  "learning",
  "decision",
  "question",
  "discovery",
  "meeting",
  "personal",
  "work",
  "other",
] as const;

export const THOUGHT_TYPES = [
  "idea",
  "task",
  "reflection",
  "research",
  "learning",
  "decision",
  "question",
  "discovery",
  "observation",
  "update",
  "problem",
  "personal",
] as const;

// No length/count constraints here: constrained decoders reject many JSON Schema keywords.
// Limits are applied in code after validation instead.
const ThoughtSchema = z.strictObject({
  type: z.enum(THOUGHT_TYPES),
  title: z.string(),
  summary: z.string(),
  key_quote: z.string(),
  project: z.string().nullable(),
  topics: z.array(z.string()),
  people: z.array(z.string()),
  organizations: z.array(z.string()),
  products: z.array(z.string()),
  places: z.array(z.string()),
});

export const UnderstandSchema = z.strictObject({
  title: z.string(),
  summary: z.string(),
  detailed_summary: z.string(),
  category: z.enum(CATEGORIES),
  language: z.string(),
  thoughts: z.array(ThoughtSchema),
  tasks: z.array(
    z.strictObject({
      title: z.string(),
      due_date: z.string().nullable(),
      due_text: z.string().nullable(),
      thought_index: z.number().int().nullable(),
    }),
  ),
  decisions: z.array(
    z.strictObject({
      statement: z.string(),
      rationale: z.string().nullable(),
      thought_index: z.number().int().nullable(),
    }),
  ),
  questions: z.array(
    z.strictObject({
      question: z.string(),
      thought_index: z.number().int().nullable(),
    }),
  ),
  reminders: z.array(
    z.strictObject({
      text: z.string(),
      remind_at: z.string(),
      thought_index: z.number().int().nullable(),
    }),
  ),
  vocabulary: z.array(z.string()),
});
export type Understanding = z.infer<typeof UnderstandSchema>;

export const SynthesisSchema = z.strictObject({
  title: z.string(),
  summary: z.string(),
  detailed_summary: z.string(),
  category: z.enum(CATEGORIES),
});

export function cleanSystemPrompt(vocabulary: string[]): string {
  return [
    "You clean up raw speech-to-text transcripts of someone's personal voice memos.",
    "- Remove filler words (um, uh, hmm, you know, and Hinglish fillers like matlab or basically when they carry no meaning), stutters, repeated words and false starts.",
    "- Fix punctuation, capitalisation and obvious mis-hearings.",
    vocabulary.length
      ? `- Known names and terms: ${vocabulary.join(", ")}. Speech recognition often mishears these, so when a word sounds like one of them (for example "Lumena" for "Lumina"), write the known spelling.`
      : "",
    "- Keep the speaker's meaning, wording and language. Do not translate Hindi or Hinglish. Do not summarise, reorder or add anything.",
    "- Break the text into short paragraphs where the topic shifts.",
    "Reply with only the cleaned transcript.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCalendarReference(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const center = new Date(Date.UTC(y, m - 1, d));
  const lines: string[] = ['Calendar (for resolving day names to dates):'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let offset = -7; offset <= 7; offset++) {
    const dt = new Date(center.getTime() + offset * 86_400_000);
    const iso = dt.toISOString().slice(0, 10);
    const wd = weekdays[dt.getUTCDay()];
    const marker = offset === 0 ? ' ← today (recording day)' : '';
    lines.push(`  ${wd} ${iso}${marker}`);
  }
  return lines.join('\n');
}

export function understandSystemPrompt(): string {
  return `You turn one raw voice memo into structured memory for the speaker's personal "second brain".
The speaker usually talks in Indian English or Hinglish. Write every field in English; romanise any Hindi words you keep. Keep names exactly as the speaker uses them.

Rules:
- Use only what the transcript says. Never invent facts, tasks, people or dates.
- title: 3 to 8 specific words naming the main idea, no quotes or trailing punctuation.
- summary: 1 to 2 sentences. detailed_summary: 3 to 6 sentences covering everything important.
- Write summaries as the speaker's own notes, addressing them as "you" ("You're weighing usage-based pricing…") or with no subject ("Weighing usage-based pricing…"). Never write "the speaker" or "the user".
- When the memo mentions a known project, always write its main name, even if the transcript spells it differently.
- category: the best fit for the memo as a whole.
- language: "en", "hi", or "hi-en" for Hinglish (or another ISO code).
- thoughts: split the memo wherever the topic changes; a short memo is usually one thought; at most 12.
  - type: what kind of thought it is.
  - key_quote: the most informative sentence or two for that thought, lightly cleaned, under 300 characters.
  - project: the project, product or venture the speaker is working on that this thought belongs to. Strongly prefer a name from "Known projects" (use its main name, never the "also heard as" spelling) whenever it is the same thing, even if spelled differently. Only name a new project for a clearly named product, company or initiative the speaker is building or running; never for general topics like "health" or "productivity". null when there is none.
  - topics: 1 to 4 broad lowercase subjects such as "pricing", "voice ai", "hiring".
  - people, organizations, products, places: proper names mentioned in that thought.
- tasks: only concrete things the speaker intends or needs to do. Start the title with a verb. due_date: resolve any date or deadline into YYYY-MM-DD by looking it up in the Calendar. "This <weekday>" means the nearest <weekday> on or after the recording day. "Next <weekday>" means the <weekday> of the following week. "Tomorrow" is the day after the recording day. Never calculate dates yourself — always copy the exact YYYY-MM-DD from the Calendar. due_text: only the words that expressed the date, such as "tomorrow" or "by next Friday". Use null for both when no date was given.
- decisions: choices the speaker commits to ("I've decided", "we'll go with", "let's use").
- questions: open questions the speaker has not answered yet.
- reminders: only when the speaker explicitly asks to be reminded ("remind me", "set a reminder", "don't let me forget", "yaad dila dena"). text: what to remind them about, starting with a verb. remind_at: the local time "YYYY-MM-DDTHH:MM", resolved against the recording time: "in 2 hours" adds to it; a day with no time is 09:00; morning 09:00, afternoon 14:00, evening 18:00, tonight 20:00. Look up the exact YYYY-MM-DD in the Calendar to build the date portion. Never guess or calculate dates yourself. Also list the same thing under tasks when it is something to do. An empty list when nobody asked for a reminder.
- thought_index: the 0-based index of the thought an item came from, or null.
- vocabulary: up to 10 proper names (people, companies, products, projects, places) or rare technical terms from this memo that speech recognition could misspell. Never include ordinary words or phrases like "pricing" or "automation". Use the spelling from "Known names and terms" when a word is clearly the same name.
Reply with only a JSON object that matches this JSON Schema:
${JSON.stringify(toJsonSchema(UnderstandSchema))}`;
}

export function understandUserPrompt(input: {
  transcript: string;
  recordedAt: { date: string; weekday: string; time: string };
  timezone: string;
  projects: string[];
  vocabulary: string[];
  part?: { index: number; total: number };
}): string {
  return [
    `Recording time: ${input.recordedAt.weekday} ${input.recordedAt.date} ${input.recordedAt.time} (${input.timezone})`,
    buildCalendarReference(input.recordedAt.date),
    `Known projects: ${input.projects.length ? input.projects.join(", ") : "none yet"}`,
    input.vocabulary.length ? `Known names and terms: ${input.vocabulary.join(", ")}` : "",
    input.part ? `This is part ${input.part.index + 1} of ${input.part.total} of a long recording.` : "",
    "Transcript:",
    '"""',
    input.transcript,
    '"""',
  ]
    .filter(Boolean)
    .join("\n");
}

export function synthesisSystemPrompt(): string {
  return `You combine the per-part analyses of one long voice memo into a single overview.
Write in English. title: 3 to 8 specific words. summary: 1 to 2 sentences. detailed_summary: 4 to 8 sentences.
Reply with only a JSON object that matches this JSON Schema:
${JSON.stringify(toJsonSchema(SynthesisSchema))}`;
}

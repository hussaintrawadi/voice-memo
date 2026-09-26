import { z } from "zod";
import { complete, toJsonSchema } from "../ai/router";
import { refreshProjectSummary } from "../insights/projects";
import { currentTranscripts, getUser } from "../lib/data";
import { isIsoDate, isLocalDateTime, zonedDateTime } from "../lib/time";
import { errorMessage, localTime, newId, now, truncate } from "../lib/util";
import { buildCalendarReference } from "./prompts";

/**
 * Context awareness. After a memo is understood, compare it with everything still open
 * (action points, decisions, reminders, questions) and apply what it changes: a decision
 * replaced by a new one, a task that is no longer needed or is done, a reminder moved or
 * cancelled, a question answered, a task mentioned twice. Every change is logged with the
 * values it replaced, so the app can show it and undo it.
 */

export type ItemType = "task" | "decision" | "reminder" | "question";

interface Item {
  /** Short label the model refers to: T3 (open task), NT1 (task from this memo), ... */
  handle: string;
  type: ItemType;
  id: string;
  isNew: boolean;
  text: string;
  projectId: string | null;
  project: string | null;
  status: string;
  due: string | null;
  remindAt: number | null;
  at: number;
}

export const ReconcileSchema = z.strictObject({
  changes: z.array(
    z.strictObject({
      target: z.string(),
      action: z.enum(["replace", "cancel", "complete", "reschedule", "rename", "answer", "duplicate"]),
      replaced_by: z.string().nullable(),
      new_due_date: z.string().nullable(),
      new_remind_at: z.string().nullable(),
      new_title: z.string().nullable(),
      answer: z.string().nullable(),
      evidence: z.string(),
    }),
  ),
});
export type Reconciliation = z.infer<typeof ReconcileSchema>;

/** Columns each kind of change may touch; undo restores exactly these. */
const COLUMNS: Record<ItemType, string[]> = {
  task: ["status", "due_date", "title", "completed_at", "completed_by_thought_id"],
  decision: ["status", "superseded_by"],
  reminder: ["status", "remind_at", "sent_at"],
  question: ["status", "resolution", "resolved_by_thought_id", "resolved_at"],
};
const TABLE: Record<ItemType, string> = { task: "tasks", decision: "decisions", reminder: "reminders", question: "questions" };

const LIMITS = { task: 40, decision: 25, reminder: 20, question: 25 };
const MAX_CHANGES = 15;
const MEMO_CHARS = 3500;

export function reconcileSystemPrompt(): string {
  return `You keep someone's second brain consistent. They just recorded a new memo. You also get the items that memo produced (NT tasks, ND decisions, NR reminders) and everything they already had open before it: action points (T), decisions (D), reminders (R) and open questions (Q).

Find the existing items this memo changes, and only those. A change must be said or clearly meant in the new memo:
- They changed their mind about a decision: "replace" it, with replaced_by set to the ND id of the new decision. If nothing replaces it, "cancel" it.
- A task or reminder is no longer needed or no longer happening: "cancel" it.
- A new task takes the place of an old one ("do ABC instead of XYZ"): "replace" the old task, with replaced_by set to the new NT id.
- They say they already did a task, or the thing a reminder was for: "complete" it.
- They move a date or time: "reschedule". For a task give new_due_date as YYYY-MM-DD; for a reminder give new_remind_at as YYYY-MM-DDTHH:MM. Copy dates from the Calendar.
- They reword what a task is: "rename" it with new_title.
- They answer an open question: "answer" it, with a one-sentence answer.
- The memo repeats something already open: mark the NEW item (NT or NR) as "duplicate", with replaced_by set to the existing T or R it repeats.

Never change an item only because it is on a related topic, and never invent items. When unsure, leave it alone; most memos change nothing, and an empty list is a normal answer. evidence is the few words from the new memo that justify the change.
Reply with only a JSON object matching this JSON Schema:
${JSON.stringify(toJsonSchema(ReconcileSchema))}`;
}

function itemLine(item: Item, timeZone: string): string {
  const parts = [`${item.handle}: ${item.text}`];
  if (item.due) parts.push(`(due ${item.due})`);
  if (item.remindAt) {
    const t = localTime(item.remindAt, timeZone);
    parts.push(`(at ${t.date}T${t.time})`);
  }
  if (item.project) parts.push(`[${item.project}]`);
  if (!item.isNew) parts.push(`· from ${localTime(item.at, timeZone).date}`);
  return parts.join(" ");
}

export function reconcileUserPrompt(input: {
  memo: string;
  recordedAt: { date: string; weekday: string; time: string };
  timezone: string;
  created: Item[];
  open: Item[];
}): string {
  return [
    `Recording time: ${input.recordedAt.weekday} ${input.recordedAt.date} ${input.recordedAt.time} (${input.timezone})`,
    buildCalendarReference(input.recordedAt.date),
    `New memo:\n"""\n${input.memo}\n"""`,
    `Items this memo created:\n${input.created.length ? input.created.map((i) => itemLine(i, input.timezone)).join("\n") : "(none)"}`,
    `Already open before this memo:\n${input.open.map((i) => itemLine(i, input.timezone)).join("\n")}`,
  ].join("\n\n");
}

interface Row {
  id: string;
  text: string;
  project_id: string | null;
  project: string | null;
  status: string;
  due: string | null;
  remind_at: number | null;
  at: number;
}

async function loadItems(env: Env, userId: string, recordingId: string, projectIds: string[]) {
  const sameProject = projectIds.length ? `(x.project_id IN (${projectIds.map(() => "?").join(",")}))` : "0";
  const q = (type: ItemType, select: string, where: string, mine: boolean) => {
    const limit = mine ? 20 : LIMITS[type];
    const sql = `SELECT ${select} FROM ${TABLE[type]} x LEFT JOIN projects p ON p.id = x.project_id
      WHERE x.user_id = ? AND ${where} AND x.recording_id ${mine ? "= ?" : "IS NOT ?"}
      ORDER BY ${sameProject} DESC, x.created_at DESC LIMIT ${limit}`;
    return env.DB.prepare(sql)
      .bind(userId, recordingId, ...projectIds)
      .all<Row>();
  };
  const cols = (text: string, due = "NULL", remind = "NULL", at = "x.created_at") =>
    `x.id, ${text} AS text, x.project_id, p.name AS project, x.status, ${due} AS due, ${remind} AS remind_at, ${at} AS at`;
  const task = cols("x.title", "x.due_date");
  const decision = cols("x.statement", "NULL", "NULL", "x.decided_at");
  // Reminders have no project column, so they are listed by time instead.
  const reminderSql = (mine: boolean) =>
    env.DB.prepare(
      `SELECT x.id, x.text AS text, NULL AS project_id, NULL AS project, x.status, NULL AS due, x.remind_at, x.created_at AS at
       FROM reminders x WHERE x.user_id = ? AND x.status IN ('suggested', 'pending') AND x.recording_id ${mine ? "= ?" : "IS NOT ?"}
       AND x.remind_at > ? ORDER BY x.remind_at LIMIT ${mine ? 20 : LIMITS.reminder}`,
    )
      .bind(userId, recordingId, now() - 86_400_000)
      .all<Row>();
  const question = cols("x.question");

  const [newTasks, newDecisions, newReminders, tasks, decisions, reminders, questions] = await Promise.all([
    q("task", task, "x.status IN ('suggested', 'accepted')", true),
    q("decision", decision, "x.status = 'active'", true),
    reminderSql(true),
    q("task", task, "x.status IN ('suggested', 'accepted')", false),
    q("decision", decision, "x.status = 'active'", false),
    reminderSql(false),
    q("question", question, "x.status = 'open'", false),
  ]);

  const toItems = (rows: Row[], type: ItemType, prefix: string, isNew: boolean): Item[] =>
    rows.map((r, i) => ({
      handle: `${prefix}${i + 1}`,
      type,
      id: r.id,
      isNew,
      text: truncate(r.text, 200),
      projectId: r.project_id,
      project: r.project,
      status: r.status,
      due: r.due,
      remindAt: r.remind_at,
      at: r.at,
    }));

  return {
    created: [
      ...toItems(newDecisions.results, "decision", "ND", true),
      ...toItems(newTasks.results, "task", "NT", true),
      ...toItems(newReminders.results, "reminder", "NR", true),
    ],
    open: [
      ...toItems(tasks.results, "task", "T", false),
      ...toItems(decisions.results, "decision", "D", false),
      ...toItems(reminders.results, "reminder", "R", false),
      ...toItems(questions.results, "question", "Q", false),
    ],
  };
}

export interface PlannedChange {
  item: Item;
  action: string;
  set: Record<string, string | number | null>;
  summary: string;
  evidence: string;
}

const ALLOWED: Record<ItemType, string[]> = {
  task: ["replace", "cancel", "complete", "reschedule", "rename"],
  decision: ["replace", "cancel"],
  reminder: ["cancel", "reschedule", "complete"],
  question: ["answer"],
};

const quote = (s: string) => `“${s}”`;
const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Turns the model's answer into concrete, validated changes. Anything that names an unknown
 * item, an action that doesn't fit the item, or a malformed date is dropped, not guessed at.
 */
export function planChanges(
  result: Reconciliation,
  items: { created: Item[]; open: Item[] },
  ctx: { timezone: string; thoughtId: string | null; now: number },
): PlannedChange[] {
  const byHandle = new Map([...items.created, ...items.open].map((i) => [i.handle.toUpperCase(), i]));
  const seen = new Set<string>();
  const planned: PlannedChange[] = [];

  for (const c of result.changes) {
    if (planned.length >= MAX_CHANGES) break;
    const item = byHandle.get(c.target.trim().toUpperCase());
    if (!item || seen.has(item.id)) continue;
    const evidence = truncate(c.evidence.trim(), 300);
    const by = c.replaced_by ? byHandle.get(c.replaced_by.trim().toUpperCase()) : undefined;

    let change: PlannedChange | null = null;
    if (item.isNew) {
      // A memo may only mark its own items as repeats of something already open.
      if (c.action !== "duplicate" || !by || by.isNew || by.type !== item.type) continue;
      if (item.type === "task") {
        change = { item, action: "duplicate", set: { status: "dismissed" }, summary: `Didn't add ${quote(item.text)} again; it's already on your list`, evidence };
      } else if (item.type === "reminder") {
        change = { item, action: "duplicate", set: { status: "cancelled" }, summary: `Didn't set ${quote(item.text)} twice`, evidence };
      }
    } else if (ALLOWED[item.type].includes(c.action)) {
      change = planExisting(item, c, by, evidence, ctx);
    }
    if (change) {
      planned.push(change);
      seen.add(item.id);
    }
  }
  return planned;
}

function planExisting(
  item: Item,
  c: Reconciliation["changes"][number],
  by: Item | undefined,
  evidence: string,
  ctx: { timezone: string; thoughtId: string | null; now: number },
): PlannedChange | null {
  const replacement = by && by.isNew && by.type === item.type ? by : undefined;
  switch (item.type) {
    case "decision":
      if (c.action === "replace" && replacement) {
        return { item, action: "replace", set: { status: "superseded", superseded_by: replacement.id }, summary: `Replaced ${quote(item.text)} with ${quote(replacement.text)}`, evidence };
      }
      return { item, action: "cancel", set: { status: "reversed" }, summary: `Dropped the decision ${quote(item.text)}`, evidence };

    case "task":
      if (c.action === "replace") {
        return replacement
          ? { item, action: "replace", set: { status: "dismissed" }, summary: `Swapped ${quote(item.text)} for ${quote(replacement.text)}`, evidence }
          : { item, action: "cancel", set: { status: "dismissed" }, summary: `Removed ${quote(item.text)} from your action points`, evidence };
      }
      if (c.action === "cancel") {
        return { item, action: "cancel", set: { status: "dismissed" }, summary: `Removed ${quote(item.text)} from your action points`, evidence };
      }
      if (c.action === "complete") {
        return { item, action: "complete", set: { status: "done", completed_at: ctx.now, completed_by_thought_id: ctx.thoughtId }, summary: `Marked ${quote(item.text)} done`, evidence };
      }
      if (c.action === "reschedule" && c.new_due_date && isIsoDate(c.new_due_date) && c.new_due_date !== item.due) {
        return { item, action: "reschedule", set: { due_date: c.new_due_date }, summary: `Moved ${quote(item.text)} to ${dayLabel(c.new_due_date)}`, evidence };
      }
      if (c.action === "rename" && c.new_title?.trim() && c.new_title.trim() !== item.text) {
        const title = truncate(c.new_title.trim(), 300);
        return { item, action: "rename", set: { title }, summary: `Renamed ${quote(item.text)} to ${quote(title)}`, evidence };
      }
      return null;

    case "reminder":
      if (c.action === "cancel") {
        return { item, action: "cancel", set: { status: "cancelled" }, summary: `Cancelled the reminder ${quote(item.text)}`, evidence };
      }
      if (c.action === "complete") {
        return { item, action: "complete", set: { status: "done" }, summary: `Marked the reminder ${quote(item.text)} done`, evidence };
      }
      if (c.action === "reschedule" && c.new_remind_at && isLocalDateTime(c.new_remind_at)) {
        const at = zonedDateTime(c.new_remind_at, ctx.timezone);
        if (at < ctx.now - 60_000 || at === item.remindAt) return null;
        const t = localTime(at, ctx.timezone);
        return {
          item,
          action: "reschedule",
          set: { remind_at: at, status: item.status === "suggested" ? "suggested" : "pending", sent_at: null },
          summary: `Moved the reminder ${quote(item.text)} to ${dayLabel(t.date)}, ${t.time}`,
          evidence,
        };
      }
      return null;

    case "question":
      if (c.action === "answer" && c.answer?.trim()) {
        const answer = truncate(c.answer.trim(), 500);
        return { item, action: "answer", set: { status: "resolved", resolution: answer, resolved_by_thought_id: ctx.thoughtId, resolved_at: ctx.now }, summary: `Answered ${quote(item.text)}: ${answer}`, evidence };
      }
      return null;
  }
}

/** Puts back the values a change replaced. Only the columns it touched, only if still owned. */
function undoStatements(env: Env, change: { item_type: ItemType; item_id: string; user_id: string; before: string }) {
  const before = JSON.parse(change.before) as Record<string, unknown>;
  const cols = COLUMNS[change.item_type].filter((c) => c in before);
  if (!cols.length) return [];
  return [
    env.DB.prepare(
      `UPDATE ${TABLE[change.item_type]} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(...cols.map((c) => before[c] ?? null), now(), change.item_id, change.user_id),
  ];
}

interface ChangeRow {
  id: string;
  user_id: string;
  item_type: ItemType;
  item_id: string;
  before: string;
}

/** Undoes one change the app made from a memo. */
export async function undoChange(env: Env, userId: string, changeId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id, user_id, item_type, item_id, before FROM context_changes WHERE id = ? AND user_id = ? AND undone_at IS NULL",
  )
    .bind(changeId, userId)
    .first<ChangeRow>();
  if (!row) return false;
  await env.DB.batch([
    ...undoStatements(env, row),
    env.DB.prepare("UPDATE context_changes SET undone_at = ? WHERE id = ?").bind(now(), row.id),
  ]);
  return true;
}

/** Undoes everything a memo changed (before it is reprocessed or deleted). */
export async function undoChangesFromRecording(env: Env, recordingId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, item_type, item_id, before FROM context_changes WHERE recording_id = ? AND undone_at IS NULL ORDER BY created_at DESC",
  )
    .bind(recordingId)
    .all<ChangeRow>();
  if (!results.length) return;
  await env.DB.batch(
    results.flatMap((row) => [
      ...undoStatements(env, row),
      env.DB.prepare("UPDATE context_changes SET undone_at = ? WHERE id = ?").bind(now(), row.id),
    ]),
  );
}

/** Reads the current values of the columns a change will overwrite. */
async function snapshot(env: Env, change: PlannedChange): Promise<Record<string, unknown>> {
  const cols = Object.keys(change.set).filter((c) => COLUMNS[change.item.type].includes(c));
  const row = await env.DB.prepare(`SELECT ${cols.join(", ")} FROM ${TABLE[change.item.type]} WHERE id = ?`)
    .bind(change.item.id)
    .first<Record<string, unknown>>();
  return row ?? {};
}

export async function reconcileRecording(env: Env, recordingId: string): Promise<{ changes: number; skipped?: string }> {
  const rec = await env.DB.prepare("SELECT id, user_id, recorded_at, summary_detailed FROM recordings WHERE id = ?")
    .bind(recordingId)
    .first<{ id: string; user_id: string; recorded_at: number; summary_detailed: string | null }>();
  if (!rec) return { changes: 0, skipped: "recording not found" };

  const markDone = () =>
    env.DB.prepare("UPDATE recordings SET reconciled_at = ? WHERE id = ?").bind(now(), recordingId).run();

  // Reprocessing a memo: its earlier changes are taken back, then worked out afresh.
  await undoChangesFromRecording(env, recordingId);

  const transcripts = await currentTranscripts(env, recordingId);
  const text = (transcripts.edited ?? transcripts.cleaned ?? transcripts.raw)?.text?.trim() ?? "";
  if (!text) {
    await markDone();
    return { changes: 0, skipped: "no speech" };
  }

  const { results: projectRows } = await env.DB.prepare(
    "SELECT DISTINCT project_id FROM thoughts WHERE recording_id = ? AND project_id IS NOT NULL",
  )
    .bind(recordingId)
    .all<{ project_id: string }>();
  const projectIds = projectRows.map((r) => r.project_id);
  const items = await loadItems(env, rec.user_id, recordingId, projectIds);
  if (!items.open.length) {
    await markDone();
    return { changes: 0, skipped: "nothing open" };
  }

  const user = await getUser(env, rec.user_id);
  const memo =
    text.length > MEMO_CHARS
      ? `${rec.summary_detailed ?? ""}\n\n${truncate(text, MEMO_CHARS)}`
      : text;
  const result = await complete(env, {
    system: reconcileSystemPrompt(),
    user: reconcileUserPrompt({
      memo,
      recordedAt: localTime(rec.recorded_at, user.timezone),
      timezone: user.timezone,
      created: items.created,
      open: items.open,
    }),
    schema: ReconcileSchema,
    schemaName: "memo_reconciliation",
    maxTokens: 1500,
    temperature: 0,
  });

  const firstThought = await env.DB.prepare("SELECT id FROM thoughts WHERE recording_id = ? ORDER BY idx LIMIT 1")
    .bind(recordingId)
    .first<{ id: string }>();
  const planned = planChanges(result.data, items, { timezone: user.timezone, thoughtId: firstThought?.id ?? null, now: now() });

  const ts = now();
  const statements: D1PreparedStatement[] = [];
  for (const change of planned) {
    const before = await snapshot(env, change);
    const cols = Object.keys(change.set);
    statements.push(
      env.DB.prepare(
        `UPDATE ${TABLE[change.item.type]} SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(...cols.map((c) => change.set[c]), ts, change.item.id, rec.user_id),
      env.DB.prepare(
        `INSERT INTO context_changes (id, user_id, recording_id, item_type, item_id, action, summary, before, after, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(),
        rec.user_id,
        recordingId,
        change.item.type,
        change.item.id,
        change.action,
        change.summary,
        JSON.stringify(before),
        JSON.stringify(change.set),
        change.evidence,
        ts,
      ),
    );
  }
  statements.push(env.DB.prepare("UPDATE recordings SET reconciled_at = ? WHERE id = ?").bind(ts, recordingId));
  await env.DB.batch(statements);

  // Real time: rewrite the brief of every project this memo touched, now rather than within the hour.
  const touched = new Set([...projectIds, ...planned.map((p) => p.item.projectId).filter((p): p is string => Boolean(p))]);
  for (const projectId of [...touched].slice(0, 2)) {
    try {
      await refreshProjectSummary(env, projectId);
    } catch (err) {
      console.error("brief refresh skipped", projectId, errorMessage(err));
    }
  }

  return { changes: planned.length };
}

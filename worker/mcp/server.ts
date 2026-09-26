import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { app } from "../app";
import { asUser } from "../auth";
import { getUser } from "../lib/data";
import { localTime } from "../lib/util";

/**
 * The Claude connector: Voice Memo as an MCP server. Every tool calls the app's own API routes
 * as the signed-in owner, so Claude sees exactly what the app shows.
 */

interface Props {
  userId: string;
}

type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

function apiFor(env: Env, ctx: ExecutionContext, userId: string): Api {
  const internalEnv = asUser(env, userId);
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.fetch(
      new Request(`https://internal/api${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      internalEnv,
      ctx,
    );
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data as T;
  };
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const fail = (err: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true });

function when(ts: number, tz: string): string {
  const t = localTime(ts, tz);
  return `${t.weekday} ${t.date} ${t.time}`;
}

const bullets = (items: string[], empty = "none") => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  status: string;
  project: string | null;
  notes?: string | null;
  recording_id?: string | null;
}
interface ReminderRow {
  id: string;
  text: string;
  remind_at: number;
  status: string;
}
interface ProjectItem {
  id: string;
  name: string;
  aliases: string[];
  summary: { current_focus: string; overview: string; next_steps: string[]; open_questions: string[] } | null;
  memoCount: number;
  openTasks: number;
  lastActivity: number | null;
}

const taskLine = (t: TaskRow) =>
  `${t.title}${t.due_date ? ` (due ${t.due_date})` : ""}${t.project ? ` [${t.project}]` : ""}${t.status === "done" ? " ✓ done" : t.status === "suggested" ? " (suggested)" : ""} {id: ${t.id}}`;

async function findProject(api: Api, nameOrId: string): Promise<ProjectItem> {
  const { projects } = await api<{ projects: ProjectItem[] }>("GET", "/projects");
  const needle = nameOrId.trim().toLowerCase();
  const found =
    projects.find((p) => p.id === nameOrId) ??
    projects.find((p) => p.name.toLowerCase() === needle || p.aliases.some((a) => a.toLowerCase() === needle)) ??
    projects.find((p) => p.name.toLowerCase().includes(needle));
  if (!found) throw new Error(`No project called "${nameOrId}". Projects: ${projects.map((p) => p.name).join(", ") || "none yet"}`);
  return found;
}

async function buildServer(env: Env, ctx: ExecutionContext, userId: string): Promise<McpServer> {
  const api = apiFor(env, ctx, userId);
  const user = await getUser(env, userId);
  const tz = user.timezone;
  const nowLocal = when(Date.now(), tz);

  const server = new McpServer(
    { name: "voice-memo", version: "1.0.0" },
    {
      instructions: `Voice Memo is ${user.name}'s voice-first second brain: they record thoughts, and each memo is transcribed and organised into thoughts, projects, action points, decisions, questions and reminders.
Start with get_overview when they want to talk about their work or plans. Use search_memory to find what they said about anything.
When they want something remembered, use save_note. For things to do, add_action_point. For "remind me", set_reminder.
Their thinking changes over time: newer memos replace older decisions, and the app already updates tasks, decisions and reminders when they change their mind. Treat anything marked [replaced] as history, never as the current plan.
Their timezone is ${tz}; it is now ${nowLocal}. Refer to them as "you".`,
    },
  );

  server.registerTool(
    "get_overview",
    {
      title: "Overview",
      description:
        "What's on the user's mind right now: the last 24 hours, open action points, upcoming reminders, open questions, recent decisions and active projects. Good first call.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        type Home = {
          last24h: { recordings: number; seconds: number };
          tasks: TaskRow[];
          questions: { id: string; question: string }[];
          decisions: { statement: string; decided_at: number; status: string }[];
        };
        const [home, reminders, projects, changes] = await Promise.all([
          api<Home>("GET", "/home"),
          api<{ reminders: ReminderRow[] }>("GET", "/reminders"),
          api<{ projects: ProjectItem[] }>("GET", "/projects"),
          api<{ changes: { summary: string; created_at: number }[] }>("GET", "/context-changes?days=7&limit=8"),
        ]);
        const active = projects.projects.filter((p) => p.memoCount > 0).slice(0, 8);
        return text(
          [
            `Now: ${nowLocal} (${tz})`,
            `Last 24 hours: ${home.last24h.recordings} memos, ${Math.round(home.last24h.seconds / 60)} minutes`,
            `\nOpen action points:\n${bullets(home.tasks.map(taskLine))}`,
            `\nUpcoming reminders:\n${bullets(reminders.reminders.filter((r) => r.status === "pending").map((r) => `${when(r.remind_at, tz)}: ${r.text} {id: ${r.id}}`))}`,
            `\nOpen questions:\n${bullets(home.questions.map((q) => q.question))}`,
            `\nRecent decisions (only ones that still stand):\n${bullets(home.decisions.map((d) => `${d.statement} (${when(d.decided_at, tz).slice(0, -6)})`))}`,
            `\nRecently updated because they changed their mind or finished something:\n${bullets(changes.changes.map((x) => `${x.summary} (${when(x.created_at, tz).slice(0, -6)})`))}`,
            `\nActive projects:\n${bullets(active.map((p) => `${p.name}: ${p.summary?.current_focus ?? `${p.memoCount} memos`}${p.openTasks ? ` (${p.openTasks} open)` : ""}`))}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_memory",
    {
      title: "Search memory",
      description:
        "Search everything the user has said, by meaning and by keyword (English, Hindi or Hinglish). Returns matching thoughts with dates, projects and memo ids; use get_memo for the full memo.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, in natural language"),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      try {
        type Hit = { title: string; summary: string; type: string; recorded_at: number; recording_id: string; project: string | null };
        const { results } = await api<{ results: Hit[] }>("GET", `/search?q=${encodeURIComponent(query)}`);
        if (!results.length) return text(`Nothing found for "${query}".`);
        return text(
          results
            .slice(0, limit)
            .map((r) => `- ${when(r.recorded_at, tz)} · ${r.type}${r.project ? ` · ${r.project}` : ""}\n  ${r.title}: ${r.summary} {memo: ${r.recording_id}}`)
            .join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_memos",
    {
      title: "Recent memos",
      description: "The user's recent memos, newest first, with their summaries and ids.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).default(7).describe("How many days back"),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ days, limit }) => {
      try {
        type Rec = { id: string; title: string | null; summary: string | null; recordedAt: number; durationSec: number | null; status: string; projects: string[] };
        const { recordings } = await api<{ recordings: Rec[] }>("GET", `/recordings?limit=${limit}`);
        const since = Date.now() - days * 86_400_000;
        const recent = recordings.filter((r) => r.recordedAt >= since);
        if (!recent.length) return text(`No memos in the last ${days} days.`);
        return text(
          recent
            .map(
              (r) =>
                `- ${when(r.recordedAt, tz)}${r.durationSec ? ` · ${Math.round(r.durationSec)}s` : ""}${r.projects.length ? ` · ${r.projects.join(", ")}` : ""}\n  ${r.title ?? "(processing)"}: ${r.summary ?? r.status} {memo: ${r.id}}`,
            )
            .join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_memo",
    {
      title: "Read a memo",
      description: "One memo in full: summary, transcript, and the thoughts, action points, decisions and questions taken from it.",
      inputSchema: z.object({ memo_id: z.string().describe("The memo id from another tool's results") }),
      annotations: { readOnlyHint: true },
    },
    async ({ memo_id }) => {
      try {
        type Detail = {
          recording: { title: string | null; summaryDetailed: string | null; summary: string | null; recordedAt: number; projects: string[] };
          transcripts: { raw: { text: string } | null; cleaned: { text: string } | null; edited: { text: string } | null };
          thoughts: { type: string; title: string; summary: string; project: string | null }[];
          tasks: TaskRow[];
          decisions: { statement: string }[];
          questions: { question: string; status: string }[];
        };
        const d = await api<Detail>("GET", `/recordings/${encodeURIComponent(memo_id)}`);
        const transcript = d.transcripts.edited?.text ?? d.transcripts.cleaned?.text ?? d.transcripts.raw?.text ?? "";
        return text(
          [
            `${d.recording.title ?? "Untitled"} (${when(d.recording.recordedAt, tz)})`,
            d.recording.summaryDetailed ?? d.recording.summary ?? "",
            `\nThoughts:\n${bullets(d.thoughts.map((t) => `${t.type}${t.project ? ` [${t.project}]` : ""}: ${t.title}: ${t.summary}`))}`,
            `\nAction points:\n${bullets(d.tasks.map(taskLine))}`,
            `\nDecisions:\n${bullets(d.decisions.map((x) => x.statement))}`,
            `\nQuestions:\n${bullets(d.questions.map((q) => `${q.question}${q.status !== "open" ? ` (${q.status})` : ""}`))}`,
            `\nTranscript:\n${transcript.slice(0, 12_000)}${transcript.length > 12_000 ? "\n[…cut]" : ""}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_action_points",
    {
      title: "Action points",
      description: "The user's action points (tasks), optionally for one project.",
      inputSchema: z.object({
        status: z.enum(["open", "done", "all"]).default("open"),
        project: z.string().optional().describe("Project name or id"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, project }) => {
      try {
        const projectId = project ? (await findProject(api, project)).id : undefined;
        const { tasks } = await api<{ tasks: TaskRow[] }>("GET", `/tasks?status=${status}${projectId ? `&projectId=${projectId}` : ""}`);
        return text(tasks.length ? tasks.map((t) => `- ${taskLine(t)}${t.notes ? `\n  ${t.notes}` : ""}`).join("\n") : "No action points.");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "add_action_point",
    {
      title: "Add action point",
      description: "Add something the user needs to do to their action points. Start the title with a verb.",
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD in the user's timezone"),
        project: z.string().optional().describe("Project name or id to file it under"),
        notes: z.string().max(2000).optional(),
      }),
    },
    async ({ title, due_date, project, notes }) => {
      try {
        const projectId = project ? (await findProject(api, project)).id : null;
        const { id } = await api<{ id: string }>("POST", "/tasks", { title, dueDate: due_date ?? null, projectId, notes, origin: "claude" });
        return text(`Added "${title}"${due_date ? ` due ${due_date}` : ""}. {id: ${id}}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "update_action_point",
    {
      title: "Update action point",
      description: "Mark an action point done, reopen or dismiss it, or change its title or due date.",
      inputSchema: z.object({
        id: z.string(),
        status: z.enum(["open", "done", "dismissed"]).optional(),
        title: z.string().min(1).max(300).optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe("YYYY-MM-DD, or null to clear"),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ id, status, title, due_date }) => {
      try {
        await api("PATCH", `/tasks/${encodeURIComponent(id)}`, {
          status: status === "open" ? "accepted" : status,
          title,
          dueDate: due_date,
        });
        return text("Updated.");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "Projects",
      description: "The user's projects with their current focus and activity.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { projects } = await api<{ projects: ProjectItem[] }>("GET", "/projects");
        if (!projects.length) return text("No projects yet.");
        return text(
          projects
            .map(
              (p) =>
                `- ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(", ")})` : ""}: ${p.summary?.current_focus ?? "no brief yet"} · ${p.memoCount} memos, ${p.openTasks} open${p.lastActivity ? `, last active ${when(p.lastActivity, tz).slice(0, -6)}` : ""} {id: ${p.id}}`,
            )
            .join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Project book",
      description: "Everything about one project: its brief, open action points, decisions, open questions and recent thoughts.",
      inputSchema: z.object({ project: z.string().describe("Project name or id") }),
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const found = await findProject(api, project);
        type Detail = {
          project: { name: string; summary: (ProjectItem["summary"] & { recent_ideas: string[]; decisions: string[]; evolution: string }) | null };
          thoughts: { type: string; title: string; summary: string; recorded_at: number; recording_id: string }[];
          tasks: TaskRow[];
          decisions: { statement: string; decided_at: number; status: string }[];
          questions: { question: string; status: string }[];
        };
        const d = await api<Detail>("GET", `/projects/${found.id}`);
        const b = d.project.summary;
        return text(
          [
            `# ${d.project.name}`,
            b ? `Current focus: ${b.current_focus}\n\n${b.overview}\n\nNext steps:\n${bullets(b.next_steps)}\n\nHow the thinking evolved: ${b.evolution}` : "No brief yet.",
            `\nOpen action points:\n${bullets(d.tasks.filter((t) => t.status !== "done").map(taskLine))}`,
            `\nDecisions (newest first; replaced ones no longer apply):\n${bullets(d.decisions.map((x) => `${x.status === "active" ? "" : "[replaced] "}${x.statement} (${when(x.decided_at, tz).slice(0, -6)})`))}`,
            `\nOpen questions:\n${bullets(d.questions.filter((q) => q.status === "open").map((q) => q.question))}`,
            `\nRecent thoughts:\n${bullets(d.thoughts.slice(0, 25).map((t) => `${when(t.recorded_at, tz).slice(0, -6)} · ${t.type}: ${t.title}: ${t.summary} {memo: ${t.recording_id}}`))}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "summarize_period",
    {
      title: "Summarise a period",
      description: "A written summary of what the user talked about between two dates (inclusive): themes, projects, ideas, decisions, to-dos.",
      inputSchema: z.object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ start, end }) => {
      try {
        type Result = {
          summary: {
            headline: string;
            overview: string;
            projects: { name: string; summary: string }[];
            key_ideas: string[];
            decisions: string[];
            action_items: string[];
            open_questions: string[];
          } | null;
          stats: { memos: number; minutes: number };
        };
        const r = await api<Result>("POST", "/summaries", { start, end });
        if (!r.summary) return text(`No memos between ${start} and ${end}.`);
        const s = r.summary;
        return text(
          [
            `${s.headline} (${r.stats.memos} memos, ${r.stats.minutes} min)`,
            s.overview,
            `\nBy project:\n${bullets(s.projects.map((p) => `${p.name}: ${p.summary}`))}`,
            `\nKey ideas:\n${bullets(s.key_ideas)}`,
            `\nDecided:\n${bullets(s.decisions)}`,
            `\nTo do:\n${bullets(s.action_items)}`,
            `\nStill open:\n${bullets(s.open_questions)}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "save_note",
    {
      title: "Save to memory",
      description:
        "Save a thought, idea or piece of information to the user's second brain, in their words. It is filed into projects and its action points, decisions and questions are pulled out, just like a voice memo.",
      inputSchema: z.object({ text: z.string().min(3).max(20_000) }),
    },
    async ({ text: note }) => {
      try {
        const { id } = await api<{ id: string }>("POST", "/notes", { text: note, source: "claude" });
        return text(`Saved. It will be organised in a few seconds. {memo: ${id}}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_reminder",
    {
      title: "Set a reminder",
      description: `Remind the user about something at a time: a notification on their phone and Mac. The user's timezone is ${tz}; it is now ${nowLocal}.`,
      inputSchema: z.object({
        text: z.string().min(1).max(300).describe("What to remind them about, starting with a verb"),
        when: z.string().describe(`Local time "YYYY-MM-DDTHH:MM" in ${tz}, or an ISO timestamp with an offset`),
      }),
    },
    async ({ text: body, when: at }) => {
      try {
        const r = await api<{ id: string; remindAt: number }>("POST", "/reminders", { text: body, remindAt: at, origin: "claude" });
        return text(`Reminder set for ${when(r.remindAt, tz)}: ${body} {id: ${r.id}}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_reminders",
    {
      title: "Reminders",
      description: "The user's upcoming reminders (or all recent ones).",
      inputSchema: z.object({ include_past: z.boolean().default(false) }),
      annotations: { readOnlyHint: true },
    },
    async ({ include_past }) => {
      try {
        const { reminders } = await api<{ reminders: ReminderRow[] }>("GET", `/reminders${include_past ? "?scope=all" : ""}`);
        return text(
          reminders.length
            ? reminders.map((r) => `- ${when(r.remind_at, tz)}: ${r.text} (${r.status}) {id: ${r.id}}`).join("\n")
            : "No reminders.",
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "update_reminder",
    {
      title: "Change a reminder",
      description: "Mark a reminder done, cancel it, or move it to a new time.",
      inputSchema: z.object({
        id: z.string(),
        action: z.enum(["done", "cancel", "reschedule"]),
        when: z.string().optional().describe(`For reschedule: local "YYYY-MM-DDTHH:MM" in ${tz}`),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ id, action, when: at }) => {
      try {
        if (action === "reschedule" && !at) throw new Error("Give a new time to reschedule");
        const body = action === "reschedule" ? { remindAt: at } : { status: action === "done" ? "done" : "cancelled" };
        const r = await api<{ remindAt: number; status: string }>("PATCH", `/reminders/${encodeURIComponent(id)}`, body);
        return text(action === "reschedule" ? `Moved to ${when(r.remindAt, tz)}.` : `Reminder ${r.status}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

/** The protected /mcp endpoint; the OAuth provider has already checked the token and set ctx.props. */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { userId } = (ctx as ExecutionContext & { props: Props }).props;
    const handler = createMcpHandler(() => buildServer(env, ctx, userId), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};

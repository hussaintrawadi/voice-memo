import { complete } from "../ai/router";
import { getUser } from "../lib/data";
import { errorMessage, estimateTokens, localTime, now } from "../lib/util";
import { type ProjectSummary, ProjectSummarySchema, projectSummarySystem } from "./prompts";

/** Budget for the notes sent to the model (keeps one request under Groq's per-minute cap). */
const NOTES_TOKENS = 4_500;

/** Rebuilds a project's living brief from everything said about it. */
export async function refreshProjectSummary(env: Env, projectId: string): Promise<ProjectSummary | null> {
  const project = await env.DB.prepare("SELECT id, user_id, name, aliases, description FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ id: string; user_id: string; name: string; aliases: string; description: string | null }>();
  if (!project) return null;
  const tz = (await getUser(env, project.user_id)).timezone;

  const [thoughts, tasks, decisions, questions] = await Promise.all([
    env.DB.prepare(
      "SELECT recorded_at, type, title, summary FROM thoughts WHERE project_id = ? ORDER BY recorded_at DESC LIMIT 300",
    )
      .bind(projectId)
      .all<{ recorded_at: number; type: string; title: string; summary: string }>(),
    env.DB.prepare(
      "SELECT title, due_date, status FROM tasks WHERE project_id = ? AND status IN ('suggested', 'accepted', 'done') ORDER BY created_at DESC LIMIT 30",
    )
      .bind(projectId)
      .all<{ title: string; due_date: string | null; status: string }>(),
    env.DB.prepare(
      "SELECT statement, status, decided_at FROM decisions WHERE project_id = ? AND status != 'dismissed' ORDER BY decided_at DESC LIMIT 20",
    )
      .bind(projectId)
      .all<{ statement: string; status: string; decided_at: number }>(),
    env.DB.prepare(
      "SELECT question, status FROM questions WHERE project_id = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 20",
    )
      .bind(projectId)
      .all<{ question: string; status: string }>(),
  ]);
  if (!thoughts.results.length) return null;

  // Newest notes first until the budget is used, then back into chronological order.
  const lines: string[] = [];
  let budget = NOTES_TOKENS;
  for (const t of thoughts.results) {
    const line = `${localTime(t.recorded_at, tz).date} ${t.type}: ${t.title}. ${t.summary}`;
    budget -= estimateTokens(line);
    if (budget < 0) break;
    lines.push(line);
  }
  const skipped = thoughts.results.length - lines.length;
  lines.reverse();

  const aliases = JSON.parse(project.aliases) as string[];
  const user = [
    `Project: ${project.name}${aliases.length ? ` (also called ${aliases.join(", ")})` : ""}`,
    project.description ? `Description: ${project.description}` : "",
    skipped > 0 ? `(${skipped} older notes not shown)` : "",
    "Notes, oldest first:",
    ...lines,
    tasks.results.length ? "Tasks:" : "",
    ...tasks.results.map((t) => `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ""}${t.status === "done" ? " [done]" : ""}`),
    decisions.results.length ? "Decisions:" : "",
    ...decisions.results.map(
      (d) => `- ${localTime(d.decided_at, tz).date}: ${d.statement}${d.status !== "active" ? ` [${d.status}]` : ""}`,
    ),
    questions.results.length ? "Questions:" : "",
    ...questions.results.map((q) => `- ${q.question}${q.status === "resolved" ? " [answered]" : ""}`),
  ]
    .filter(Boolean)
    .join("\n");

  const result = await complete(env, {
    system: projectSummarySystem(),
    user,
    schema: ProjectSummarySchema,
    schemaName: "project_summary",
    maxTokens: 1800,
    temperature: 0.3,
    effort: "medium",
  });
  await env.DB.prepare("UPDATE projects SET living_summary = ?, summary_updated_at = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(result.data), now(), now(), projectId)
    .run();
  return result.data;
}

/** Hourly: refresh briefs of projects that got new thoughts since their last brief. */
export async function refreshStaleProjectSummaries(env: Env, limit = 3) {
  const { results } = await env.DB.prepare(
    `SELECT p.id FROM projects p
     WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.project_id = p.id AND t.created_at > COALESCE(p.summary_updated_at, 0))
     ORDER BY COALESCE(p.summary_updated_at, 0) LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  for (const { id } of results) {
    try {
      await refreshProjectSummary(env, id);
    } catch (err) {
      console.error("project summary failed", id, errorMessage(err));
    }
  }
}

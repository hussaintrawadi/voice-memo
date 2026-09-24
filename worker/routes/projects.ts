import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { refreshProjectSummary } from "../insights/projects";
import { applySpellings, isNearName } from "../lib/text";
import { HttpError, newId, now } from "../lib/util";

interface ProjectRow {
  id: string;
  name: string;
  aliases: string;
  description: string | null;
  living_summary: string | null;
  summary_updated_at: number | null;
  status: string;
  origin: string;
  confirmed: number;
  created_at: number;
}

/** Text columns that can mention a project by name. */
const TEXT_COLUMNS: Record<string, string[]> = {
  thoughts: ["title", "summary", "content"],
  tasks: ["title"],
  decisions: ["statement", "rationale"],
  questions: ["question"],
};

/**
 * After merging a misheard project into the real one, rewrite the misheard name in the
 * notes that were filed under it (and their memos) so everything reads consistently.
 */
async function respellMerged(env: AppEnv["Bindings"], projectId: string, canonical: string, misheard: string[]) {
  const aliases = misheard.filter((name) => name !== canonical && isNearName(name, canonical));
  if (!aliases.length) return;
  const spellings = [{ canonical, aliases }];
  const updates: D1PreparedStatement[] = [];
  const recordingIds = new Set<string>();
  for (const [table, columns] of Object.entries(TEXT_COLUMNS)) {
    const { results } = await env.DB.prepare(`SELECT id, recording_id, ${columns.join(", ")} FROM ${table} WHERE project_id = ?`)
      .bind(projectId)
      .all<Record<string, string | null>>();
    for (const row of results) {
      if (row.recording_id) recordingIds.add(row.recording_id);
      const changed = columns.filter((col) => row[col] && applySpellings(row[col], spellings) !== row[col]);
      if (!changed.length) continue;
      updates.push(
        env.DB.prepare(`UPDATE ${table} SET ${changed.map((col) => `${col} = ?`).join(", ")} WHERE id = ?`).bind(
          ...changed.map((col) => applySpellings(row[col] as string, spellings)),
          row.id,
        ),
      );
    }
  }
  for (const id of recordingIds) {
    const rec = await env.DB.prepare("SELECT title, summary, summary_detailed FROM recordings WHERE id = ?")
      .bind(id)
      .first<{ title: string | null; summary: string | null; summary_detailed: string | null }>();
    if (!rec) continue;
    const fix = (t: string | null) => (t === null ? null : applySpellings(t, spellings));
    if (fix(rec.title) === rec.title && fix(rec.summary) === rec.summary && fix(rec.summary_detailed) === rec.summary_detailed) continue;
    updates.push(
      env.DB.prepare("UPDATE recordings SET title = ?, summary = ?, summary_detailed = ? WHERE id = ?").bind(
        fix(rec.title),
        fix(rec.summary),
        fix(rec.summary_detailed),
        id,
      ),
    );
  }
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
}

function projectView(p: ProjectRow) {
  return {
    id: p.id,
    name: p.name,
    aliases: JSON.parse(p.aliases) as string[],
    description: p.description,
    summary: p.living_summary ? JSON.parse(p.living_summary) : null,
    summaryUpdatedAt: p.summary_updated_at,
    status: p.status,
    suggested: p.origin === "ai" && !p.confirmed,
    createdAt: p.created_at,
  };
}

async function ownedProject(env: Env, id: string, userId: string): Promise<ProjectRow> {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").bind(id, userId).first<ProjectRow>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

const cleanAliases = (aliases: string[], name: string) =>
  [...new Map(aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== name.toLowerCase()).map((a) => [a.toLowerCase(), a])).values()].slice(0, 20);

const ProjectBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).nullable().optional(),
  aliases: z.array(z.string().max(80)).max(20).optional(),
});

export const projectRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM thoughts t WHERE t.project_id = p.id) AS thought_count,
         (SELECT COUNT(DISTINCT t.recording_id) FROM thoughts t WHERE t.project_id = p.id) AS memo_count,
         (SELECT MAX(t.recorded_at) FROM thoughts t WHERE t.project_id = p.id) AS last_activity,
         (SELECT COUNT(*) FROM tasks k WHERE k.project_id = p.id AND k.status IN ('suggested', 'accepted')) AS open_tasks,
         (SELECT COUNT(*) FROM questions q WHERE q.project_id = p.id AND q.status = 'open') AS open_questions
       FROM projects p WHERE p.user_id = ? AND p.status != 'archived'
       ORDER BY COALESCE(last_activity, p.created_at) DESC`,
    )
      .bind(c.get("userId"))
      .all<ProjectRow & { thought_count: number; memo_count: number; last_activity: number | null; open_tasks: number; open_questions: number }>();
    return c.json({
      projects: results.map((p) => ({
        ...projectView(p),
        thoughtCount: p.thought_count,
        memoCount: p.memo_count,
        lastActivity: p.last_activity,
        openTasks: p.open_tasks,
        openQuestions: p.open_questions,
      })),
    });
  })

  .post("/", async (c) => {
    const body = ProjectBody.parse(await c.req.json());
    const userId = c.get("userId");
    const clash = await c.env.DB.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ? COLLATE NOCASE")
      .bind(userId, body.name)
      .first<{ id: string }>();
    if (clash) throw new HttpError(409, "A project with that name already exists");
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, aliases, description, origin, confirmed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'user', 1, ?, ?)`,
    )
      .bind(id, userId, body.name, JSON.stringify(cleanAliases(body.aliases ?? [], body.name)), body.description ?? null, now(), now())
      .run();
    return c.json({ id }, 201);
  })

  .get("/:id", async (c) => {
    const userId = c.get("userId");
    const project = await ownedProject(c.env, c.req.param("id"), userId);
    const id = project.id;
    const [thoughts, tasks, decisions, questions, topics, people, counts] = await Promise.all([
      c.env.DB.prepare(
        `SELECT t.id, t.type, t.title, t.summary, t.recorded_at, t.recording_id, r.title AS recording_title
         FROM thoughts t JOIN recordings r ON r.id = t.recording_id
         WHERE t.project_id = ? ORDER BY t.recorded_at DESC, t.idx LIMIT 60`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT id, title, due_date, status, recording_id FROM tasks
         WHERE project_id = ? AND status != 'dismissed' ORDER BY status = 'done', due_date IS NULL, due_date, created_at DESC LIMIT 40`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT id, statement, status, decided_at, recording_id FROM decisions
         WHERE project_id = ? AND status != 'dismissed' ORDER BY decided_at DESC LIMIT 20`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT id, question, status, recording_id, created_at FROM questions
         WHERE project_id = ? AND status != 'dismissed' ORDER BY status = 'resolved', created_at DESC LIMIT 20`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT tp.name, COUNT(*) AS count FROM thought_topics tt JOIN topics tp ON tp.id = tt.topic_id
         JOIN thoughts t ON t.id = tt.thought_id WHERE t.project_id = ? GROUP BY tp.id ORDER BY count DESC LIMIT 12`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT e.name, e.kind, COUNT(*) AS count FROM thought_entities te JOIN entities e ON e.id = te.entity_id
         JOIN thoughts t ON t.id = te.thought_id WHERE t.project_id = ? AND e.kind IN ('person', 'company')
         GROUP BY e.id ORDER BY count DESC LIMIT 12`,
      )
        .bind(id)
        .all(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS thoughts, COUNT(DISTINCT recording_id) AS memos, MIN(recorded_at) AS first, MAX(recorded_at) AS last
         FROM thoughts WHERE project_id = ?`,
      )
        .bind(id)
        .first<{ thoughts: number; memos: number; first: number | null; last: number | null }>(),
    ]);
    return c.json({
      project: projectView(project),
      counts,
      thoughts: thoughts.results,
      tasks: tasks.results,
      decisions: decisions.results,
      questions: questions.results,
      topics: topics.results,
      people: people.results,
    });
  })

  .patch("/:id", async (c) => {
    const userId = c.get("userId");
    const project = await ownedProject(c.env, c.req.param("id"), userId);
    const body = ProjectBody.partial()
      .extend({ confirmed: z.boolean().optional(), status: z.enum(["active", "archived"]).optional() })
      .parse(await c.req.json());
    const name = body.name ?? project.name;
    if (body.name && body.name.toLowerCase() !== project.name.toLowerCase()) {
      const clash = await c.env.DB.prepare("SELECT id FROM projects WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?")
        .bind(userId, body.name, project.id)
        .first();
      if (clash) throw new HttpError(409, "A project with that name already exists. Merge them instead.");
    }
    // Renaming keeps the old name as an alias so future memos still match it.
    let aliases = body.aliases ?? (JSON.parse(project.aliases) as string[]);
    if (body.name && body.name !== project.name) aliases = [...aliases, project.name];
    await c.env.DB.prepare(
      `UPDATE projects SET name = ?, aliases = ?, description = ?, status = ?, confirmed = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        name,
        JSON.stringify(cleanAliases(aliases, name)),
        body.description === undefined ? project.description : body.description,
        body.status ?? project.status,
        body.confirmed === undefined ? project.confirmed : body.confirmed ? 1 : 0,
        now(),
        project.id,
      )
      .run();
    return c.json({ ok: true });
  })

  // Folds this project into another: everything moves, and this name becomes an alias there.
  .post("/:id/merge", async (c) => {
    const userId = c.get("userId");
    const source = await ownedProject(c.env, c.req.param("id"), userId);
    const { intoId } = z.object({ intoId: z.string() }).parse(await c.req.json());
    if (intoId === source.id) throw new HttpError(400, "Pick a different project");
    const target = await ownedProject(c.env, intoId, userId);
    const aliases = cleanAliases(
      [...(JSON.parse(target.aliases) as string[]), source.name, ...(JSON.parse(source.aliases) as string[])],
      target.name,
    );
    await c.env.DB.batch([
      ...["thoughts", "tasks", "decisions", "questions", "ideas"].map((table) =>
        c.env.DB.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ?`).bind(target.id, source.id),
      ),
      c.env.DB.prepare("UPDATE projects SET aliases = ?, confirmed = 1, summary_updated_at = NULL, updated_at = ? WHERE id = ?").bind(
        JSON.stringify(aliases),
        now(),
        target.id,
      ),
      c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(source.id),
    ]);
    await respellMerged(c.env, target.id, target.name, aliases);
    return c.json({ ok: true, id: target.id });
  })

  .post("/:id/summary", async (c) => {
    const project = await ownedProject(c.env, c.req.param("id"), c.get("userId"));
    const summary = await refreshProjectSummary(c.env, project.id);
    if (!summary) throw new HttpError(400, "There's nothing recorded about this project yet");
    return c.json({ summary, summaryUpdatedAt: now() });
  })

  .delete("/:id", async (c) => {
    const project = await ownedProject(c.env, c.req.param("id"), c.get("userId"));
    // Foreign keys set project_id to NULL on thoughts, tasks, decisions and questions.
    await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id).run();
    return c.json({ ok: true });
  });

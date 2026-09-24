import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, CircleCheck, Plus, X } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { Link } from "wouter";
import { api, json, type ProjectSummaryItem, type Task, type TaskStatus } from "../lib/api";
import { formatDueDate, isOverdue } from "../lib/format";
import { useEditGestures } from "../lib/gestures";
import { Button, Card, Chip, EditButton, ErrorNote, SectionTitle } from "./ui";

export function useTaskUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: TaskStatus; title?: string; dueDate?: string | null; projectId?: string | null }) =>
      api(`/tasks/${id}`, { method: "PATCH", body: json(body) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["recording"] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["project"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/* ── Add Task form ───────────────────────────────────────────────── */

function AddTask({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [projectId, setProjectId] = useState("");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects"),
  });
  const create = useMutation({
    mutationFn: () =>
      api("/tasks", {
        method: "POST",
        body: json({ title: title.trim(), dueDate: dueDate || null, projectId: projectId || null }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["home"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) create.mutate();
  };
  const field = "h-11 w-full rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand";
  return (
    <form onSubmit={submit} className="space-y-2 border-b border-line p-4">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What do you need to do?"
        aria-label="Task title"
        maxLength={300}
        className={field}
      />
      <div className="flex gap-2">
        <input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          aria-label="Due date"
          className={`${field} min-w-0 flex-1`}
        />
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
          className={`${field} min-w-0 flex-1`}
        >
          <option value="">No project</option>
          {(projects.data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
          Cancel
        </button>
        <Button type="submit" variant="primary" busy={create.isPending} disabled={!title.trim()}>
          Add
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}

/* ── Inline edit form (appears on long-press) ────────────────────── */

function TaskEditForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const update = useTaskUpdate();
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [projectId, setProjectId] = useState(task.project_id ?? "");
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects"),
  });
  const save = () => {
    if (!title.trim()) return;
    update.mutate(
      { id: task.id, title: title.trim(), dueDate: dueDate || null, projectId: projectId || null },
      { onSuccess: onClose },
    );
  };
  const field = "h-10 w-full rounded-xl border border-line bg-bg px-3 text-sm outline-none focus:border-brand";
  return (
    <div className="space-y-2.5 border-t border-line bg-surface-2/50 px-4 py-3">
      <label className="block text-xs font-medium text-muted">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} className={`mt-1 ${field}`} />
      </label>
      <div className="flex gap-2">
        <label className="block flex-1 text-xs font-medium text-muted">
          Due date
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`mt-1 ${field}`} />
        </label>
        <label className="block flex-1 text-xs font-medium text-muted">
          Project
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={`mt-1 ${field}`}>
            <option value="">None</option>
            {(projects.data?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={update.isPending || !title.trim()}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ── Task list (with long-press edit and Add button) ─────────────── */

export function TaskList({ tasks, showSource = false }: { tasks: Task[]; showSource?: boolean }) {
  const update = useTaskUpdate();
  const [editingId, setEditingId] = useState<string | null>(null);
  const visible = tasks.filter((t) => t.status !== "dismissed");
  if (!visible.length) return null;

  return (
    <ul className="divide-y divide-line">
      {visible.map((task) => {
        const done = task.status === "done";
        const suggested = task.status === "suggested";
        const isEditing = editingId === task.id;
        return <TaskRow key={task.id} task={task} done={done} suggested={suggested} isEditing={isEditing} showSource={showSource} update={update} setEditingId={setEditingId} />;
      })}
    </ul>
  );
}

function TaskRow({ task, done, suggested, isEditing, showSource, update, setEditingId }: {
  task: Task; done: boolean; suggested: boolean; isEditing: boolean; showSource: boolean;
  update: ReturnType<typeof useTaskUpdate>; setEditingId: (id: string | null) => void;
}) {
  const edit = useCallback(() => setEditingId(task.id), [task.id, setEditingId]);
  const gestures = useEditGestures(edit);
  return (
    <li>
      <div className="group flex items-start gap-3 px-4 py-3" {...gestures}>
        <button
          type="button"
          aria-label={done ? "Mark as not done" : "Mark as done"}
          onClick={() => update.mutate({ id: task.id, status: done ? "accepted" : "done" })}
          className="mt-0.5 text-muted hover:text-ok"
        >
          {done ? <CircleCheck className="size-5 text-ok" /> : <Circle className="size-5" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className={`text-[15px] leading-snug ${done ? "text-muted line-through" : ""}`}>{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {task.due_date && (
              <span className={isOverdue(task.due_date) && !done ? "font-medium text-danger" : ""}>
                {formatDueDate(task.due_date)}
              </span>
            )}
            {task.project && <Chip tone="brand">{task.project}</Chip>}
            {suggested && <Chip tone="accent">Suggested</Chip>}
            {showSource && task.recording_id && (
              <Link href={`/r/${task.recording_id}`} className="underline-offset-2 hover:underline">
                From memo
              </Link>
            )}
          </div>
        </div>
        <EditButton onClick={edit} label="Edit task" />
        {suggested && (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              aria-label="Keep task"
              onClick={() => update.mutate({ id: task.id, status: "accepted" })}
              className="grid size-8 place-items-center rounded-full bg-brand-soft text-brand"
            >
              <Check className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Dismiss task"
              onClick={() => update.mutate({ id: task.id, status: "dismissed" })}
              className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
      </div>
      {isEditing && <TaskEditForm task={task} onClose={() => setEditingId(null)} />}
    </li>
  );
}

/* ── Tasks section with Add button (used in Home) ────────────────── */

export function TasksSection({ tasks, title = "Action points" }: { tasks: Task[]; title?: string }) {
  const [adding, setAdding] = useState(false);
  const visible = tasks.filter((t) => t.status !== "dismissed");
  return (
    <>
      <SectionTitle
        action={
          <button type="button" onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1 text-sm text-brand">
            <Plus className="size-4" /> Add
          </button>
        }
      >
        {title}
      </SectionTitle>
      <Card className="overflow-hidden">
        {adding && <AddTask onDone={() => setAdding(false)} />}
        {visible.length === 0 && !adding && (
          <p className="px-4 py-3 text-sm text-muted">
            Say what you need to do in a memo, or tap Add.
          </p>
        )}
        <TaskList tasks={tasks} showSource />
      </Card>
    </>
  );
}

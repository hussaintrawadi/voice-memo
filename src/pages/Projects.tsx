import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle, ListChecks, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button, Card, Chip, EmptyState, ErrorNote, PageHeader, Spinner } from "../components/ui";
import { api, json, type ProjectSummaryItem } from "../lib/api";
import { formatDayInline } from "../lib/format";

function NewProject({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/projects", { method: "POST", body: json({ name: name.trim() }) }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onDone();
      navigate(`/projects/${id}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) create.mutate();
  };
  return (
    <Card className="mt-4 p-4">
      <form onSubmit={submit} className="flex gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name, e.g. Lumina"
          aria-label="Project name"
          className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand"
        />
        <Button type="submit" variant="primary" busy={create.isPending}>
          Create
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted">
        Memos that mention this name are filed here automatically. You can also add other spellings later.
      </p>
      <ErrorNote error={create.error} />
    </Card>
  );
}

export function Projects() {
  const [adding, setAdding] = useState(false);
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects"),
  });
  const projects = query.data?.projects ?? [];

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Everything you've said, filed by project"
        actions={
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            <Plus className="size-4" /> New
          </Button>
        }
      />
      {adding && <NewProject onDone={() => setAdding(false)} />}
      {query.isPending && <Spinner />}
      <ErrorNote error={query.error} />
      {query.isSuccess && projects.length === 0 && (
        <EmptyState
          title="No projects yet"
          body="Talk about something you're working on by name and Voice Memo will start a project for it, or create one yourself."
        />
      )}

      <div className="mt-5 space-y-2.5">
        {projects.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="block">
            <Card className="p-4 transition hover:border-muted/40 active:scale-[0.99]">
              <div className="flex items-center justify-between gap-3">
                <h2 className="truncate font-serif text-xl">{p.name}</h2>
                {p.suggested && <Chip tone="accent">Suggested</Chip>}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted">
                {p.summary?.current_focus ?? p.description ?? (p.thoughtCount ? "Brief will be written shortly." : "Nothing recorded yet.")}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  {p.memoCount} {p.memoCount === 1 ? "memo" : "memos"}
                </span>
                {p.openTasks > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <ListChecks className="size-3.5" /> {p.openTasks} open
                  </span>
                )}
                {p.openQuestions > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <HelpCircle className="size-3.5" /> {p.openQuestions} questions
                  </span>
                )}
                {p.lastActivity && <span>Active {formatDayInline(p.lastActivity)}</span>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, HelpCircle, Milestone, Pencil, RefreshCw, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { TaskList } from "../components/TaskList";
import { Bullets, Button, Card, Chip, ErrorNote, SectionTitle, Spinner } from "../components/ui";
import { api, json, type ProjectDetail, type ProjectSummaryItem } from "../lib/api";
import { capitalize, dayKey, formatDay, formatDayInline, formatTime } from "../lib/format";

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDayInline(ts);
}

function EditDetails({ detail, onClose }: { detail: ProjectDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const p = detail.project;
  const [name, setName] = useState(p.name);
  const [aliases, setAliases] = useState(p.aliases.join(", "));
  const [description, setDescription] = useState(p.description ?? "");
  const save = useMutation({
    mutationFn: () =>
      api(`/projects/${p.id}`, {
        method: "PATCH",
        body: json({
          name: name.trim(),
          aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
          description: description.trim() || null,
          confirmed: true,
        }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", p.id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });
  const field = "mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2.5 outline-none focus:border-brand";
  return (
    <Card className="mt-4 space-y-3 p-4">
      <label className="block text-sm font-medium">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <label className="block text-sm font-medium">
        Other spellings
        <input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="e.g. Lumena, Luminar"
          className={field}
        />
        <span className="mt-1 block text-xs font-normal text-muted">
          Comma separated. Memos using these names are filed here and spelled correctly.
        </span>
      </label>
      <label className="block text-sm font-medium">
        What is it?
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="One line that helps the AI understand this project"
          className={field}
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}

function MergeInto({ detail, onClose }: { detail: ProjectDetail; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [target, setTarget] = useState("");
  const all = useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects") });
  const merge = useMutation({
    mutationFn: () => api<{ id: string }>(`/projects/${detail.project.id}/merge`, { method: "POST", body: json({ intoId: target }) }),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/${id}`);
    },
  });
  const others = (all.data?.projects ?? []).filter((p) => p.id !== detail.project.id);
  return (
    <Card className="mt-4 p-4">
      <p className="text-sm">
        Move everything from <strong>{detail.project.name}</strong> into another project. "{detail.project.name}" becomes
        one of its other spellings.
      </p>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        aria-label="Merge into"
        className="mt-3 h-11 w-full rounded-xl border border-line bg-bg px-3"
      >
        <option value="">Choose a project…</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!target} busy={merge.isPending} onClick={() => merge.mutate()}>
          Merge
        </Button>
      </div>
      <ErrorNote error={merge.error} />
    </Card>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [panel, setPanel] = useState<"edit" | "merge" | null>(null);
  const query = useQuery({ queryKey: ["project", id], queryFn: () => api<ProjectDetail>(`/projects/${id}`) });

  const refreshBrief = useMutation({
    mutationFn: () => api(`/projects/${id}/summary`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const keep = useMutation({
    mutationFn: () => api(`/projects/${id}`, { method: "PATCH", body: json({ confirmed: true }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    },
  });
  const updateItem = useMutation({
    mutationFn: ({ kind, itemId, status }: { kind: "decisions" | "questions"; itemId: string; status: string }) =>
      api(`/${kind}/${itemId}`, { method: "PATCH", body: json({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", id] }),
  });

  if (query.isPending) return <Spinner />;
  if (query.error) return <ErrorNote error={query.error} />;
  const d = query.data;
  const p = d.project;
  const brief = p.summary;

  const byDay = new Map<string, typeof d.thoughts>();
  for (const t of d.thoughts) {
    const key = dayKey(t.recorded_at);
    byDay.set(key, [...(byDay.get(key) ?? []), t]);
  }
  const openQuestions = d.questions.filter((q) => q.status === "open");

  return (
    <article className="pb-6">
      <Link href="/projects" className="inline-flex items-center gap-1 pt-1 text-sm text-muted">
        <ArrowLeft className="size-4" /> Projects
      </Link>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-serif text-4xl leading-tight">{p.name}</h1>
          {p.aliases.length > 0 && <p className="mt-1 text-sm text-muted">Also heard as {p.aliases.join(", ")}</p>}
          {p.description && <p className="mt-1 text-sm">{p.description}</p>}
        </div>
        <Button size="sm" variant="ghost" onClick={() => setPanel(panel === "edit" ? null : "edit")} aria-label="Edit project">
          <Pencil className="size-4" />
        </Button>
      </div>
      {d.counts && d.counts.thoughts > 0 && (
        <p className="mt-2 text-xs text-muted">
          {d.counts.memos} {d.counts.memos === 1 ? "memo" : "memos"} · {d.counts.thoughts} thoughts
          {d.counts.first ? ` · since ${formatDayInline(d.counts.first)}` : ""}
        </p>
      )}

      {p.suggested && panel === null && (
        <Card className="mt-4 border-accent/30 bg-accent-soft/40 p-4">
          <p className="text-sm">Voice Memo started this project from your memos. Is it right?</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" busy={keep.isPending} onClick={() => keep.mutate()}>
              <Check className="size-3.5" /> Keep it
            </Button>
            <Button size="sm" onClick={() => setPanel("merge")}>
              It's the same as another project
            </Button>
            <Button
              size="sm"
              variant="ghost"
              busy={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete "${p.name}"? Its thoughts stay in your memos, just without a project.`)) remove.mutate();
              }}
            >
              <X className="size-3.5" /> Not a project
            </Button>
          </div>
        </Card>
      )}
      {panel === "edit" && <EditDetails detail={d} onClose={() => setPanel(null)} />}
      {panel === "merge" && <MergeInto detail={d} onClose={() => setPanel(null)} />}

      <SectionTitle
        action={
          brief && (
            <button
              type="button"
              onClick={() => refreshBrief.mutate()}
              disabled={refreshBrief.isPending}
              className="inline-flex items-center gap-1 text-xs text-brand disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${refreshBrief.isPending ? "animate-spin" : ""}`} /> Refresh
            </button>
          )
        }
      >
        Brief
      </SectionTitle>
      {brief ? (
        <Card className="space-y-5 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-accent">Current focus</p>
            <p className="mt-1 font-serif text-xl leading-snug">{brief.current_focus}</p>
          </div>
          <p className="text-[15px] leading-relaxed">{brief.overview}</p>
          {brief.next_steps.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Next steps</p>
              <Bullets items={brief.next_steps} tone="accent" />
            </div>
          )}
          {brief.recent_ideas.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Recent ideas</p>
              <Bullets items={brief.recent_ideas} tone="brand" />
            </div>
          )}
          {brief.decisions.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Decided</p>
              <Bullets items={brief.decisions} />
            </div>
          )}
          {brief.open_questions.length > 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold">Still open</p>
              <Bullets items={brief.open_questions} />
            </div>
          )}
          {brief.evolution && (
            <div className="rounded-xl bg-surface-2 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted">How your thinking evolved</p>
              <p className="mt-1 text-sm leading-relaxed">{brief.evolution}</p>
            </div>
          )}
          {p.summaryUpdatedAt && <p className="text-xs text-muted">Updated {timeAgo(p.summaryUpdatedAt)}</p>}
        </Card>
      ) : (
        <Card className="p-5 text-center">
          <p className="text-sm text-muted">
            {d.thoughts.length
              ? "A one-page brief of everything you've said about this project."
              : "Nothing recorded about this project yet."}
          </p>
          {d.thoughts.length > 0 && (
            <Button className="mt-3" variant="primary" busy={refreshBrief.isPending} onClick={() => refreshBrief.mutate()}>
              <Sparkles className="size-4" /> Write the brief
            </Button>
          )}
        </Card>
      )}
      <ErrorNote error={refreshBrief.error} />

      {d.tasks.length > 0 && (
        <>
          <SectionTitle>Tasks</SectionTitle>
          <Card className="overflow-hidden">
            <TaskList tasks={d.tasks} showSource />
          </Card>
        </>
      )}

      {openQuestions.length > 0 && (
        <>
          <SectionTitle>Open questions</SectionTitle>
          <Card className="divide-y divide-line">
            {openQuestions.map((q) => (
              <div key={q.id} className="flex items-start gap-3 px-4 py-3">
                <HelpCircle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <Link href={`/r/${q.recording_id}`} className="min-w-0 flex-1 text-[15px]">
                  {q.question}
                </Link>
                <button
                  type="button"
                  aria-label="Mark answered"
                  onClick={() => updateItem.mutate({ kind: "questions", itemId: q.id, status: "resolved" })}
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"
                >
                  <Check className="size-4" />
                </button>
              </div>
            ))}
          </Card>
        </>
      )}

      {d.decisions.length > 0 && (
        <>
          <SectionTitle>Decisions</SectionTitle>
          <Card className="divide-y divide-line">
            {d.decisions.map((x) => (
              <Link key={x.id} href={`/r/${x.recording_id}`} className="flex gap-3 px-4 py-3">
                <Milestone className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={`text-[15px] ${x.status !== "active" ? "text-muted line-through" : ""}`}>{x.statement}</p>
                  <p className="text-xs text-muted">{formatDay(x.decided_at)}</p>
                </div>
              </Link>
            ))}
          </Card>
        </>
      )}

      {(d.people.length > 0 || d.topics.length > 0) && (
        <>
          <SectionTitle>People &amp; topics</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {d.people.map((e) => (
              <Chip key={`${e.kind}:${e.name}`} tone="brand">
                {e.name}
              </Chip>
            ))}
            {d.topics.map((t) => (
              <Chip key={t.name}>{t.name}</Chip>
            ))}
          </div>
        </>
      )}

      {d.thoughts.length > 0 && (
        <>
          <SectionTitle>Everything you've said</SectionTitle>
          <div className="space-y-4">
            {[...byDay.entries()].map(([key, items]) => (
              <section key={key}>
                <h3 className="mb-1.5 px-1 text-sm font-medium text-muted">{formatDay(items[0].recorded_at)}</h3>
                <Card className="divide-y divide-line">
                  {items.map((t) => (
                    <Link key={t.id} href={`/r/${t.recording_id}`} className="block px-4 py-3">
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span className="tabular-nums">{formatTime(t.recorded_at)}</span>
                        <Chip tone="accent">{capitalize(t.type)}</Chip>
                      </div>
                      <p className="mt-1 font-medium">{t.title}</p>
                      <p className="mt-0.5 text-sm text-muted">{t.summary}</p>
                    </Link>
                  ))}
                </Card>
              </section>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Manage</SectionTitle>
      <Card className="flex flex-wrap gap-2 p-4">
        <Button size="sm" onClick={() => setPanel("edit")}>
          <Pencil className="size-3.5" /> Rename or add spellings
        </Button>
        <Button size="sm" onClick={() => setPanel("merge")}>
          Merge into another project
        </Button>
        <Button
          size="sm"
          variant="danger"
          busy={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${p.name}"? Its thoughts stay in your memos, just without a project.`)) remove.mutate();
          }}
        >
          Delete project
        </Button>
        <ErrorNote error={remove.error ?? keep.error} />
      </Card>
    </article>
  );
}

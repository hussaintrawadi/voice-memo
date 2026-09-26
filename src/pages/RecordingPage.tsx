import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, HelpCircle, Milestone, Pin, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { AudioPlayer } from "../components/AudioPlayer";
import { ChangeRow } from "../components/ContextUpdates";
import { TaskList } from "../components/TaskList";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { Button, Card, Chip, ErrorNote, SectionTitle, Spinner, StatusBadge } from "../components/ui";
import { api, IN_PROGRESS, json, type ProjectSummaryItem, type RecordingDetail } from "../lib/api";
import { capitalize, formatDay, formatDuration, formatTime } from "../lib/format";
import { apiUrl } from "../lib/platform";

/** The project chip on a thought; tap to move the thought to another project. */
function ThoughtProject({ thoughtId, projectId, project }: { thoughtId: string; projectId: string | null; project: string | null }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects"),
    enabled: open,
  });
  const move = useMutation({
    mutationFn: (next: string | null) => api(`/thoughts/${thoughtId}`, { method: "PATCH", body: json({ projectId: next }) }),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["recording"] });
      void queryClient.invalidateQueries({ queryKey: ["project"] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} aria-label="Change project">
        <Chip tone={project ? "brand" : "neutral"}>{project ?? "+ Project"}</Chip>
      </button>
    );
  }
  return (
    <select
      autoFocus
      value={projectId ?? ""}
      disabled={move.isPending}
      onBlur={() => setOpen(false)}
      onChange={(e) => move.mutate(e.target.value || null)}
      aria-label="Move to project"
      className="h-7 rounded-full border border-line bg-bg px-2 text-xs"
    >
      <option value="">No project</option>
      {(projects.data?.projects ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

function EditableTitle({ id, title }: { id: string; title: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? "");
  const save = useMutation({
    mutationFn: (next: string) => api(`/recordings/${id}`, { method: "PATCH", body: json({ title: next }) }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ["recording", id] });
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });

  if (!editing) {
    return (
      <h1
        className={`mt-1 cursor-text font-serif text-[28px] leading-tight ${title ? "" : "italic text-muted"}`}
        onClick={() => {
          setValue(title ?? "");
          setEditing(true);
        }}
        title="Tap to rename"
      >
        {title ?? "Processing your memo…"}
      </h1>
    );
  }
  return (
    <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) save.mutate(value.trim());
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 font-serif text-xl outline-none focus:border-brand"
      />
      <Button type="submit" size="sm" variant="primary" busy={save.isPending} aria-label="Save title">
        <Check className="size-4" />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)} aria-label="Cancel">
        <X className="size-4" />
      </Button>
    </form>
  );
}

export function RecordingPage({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);
  const onTime = useCallback((t: number) => setTime(t), []);

  const query = useQuery({
    queryKey: ["recording", id],
    queryFn: () => api<RecordingDetail>(`/recordings/${id}`),
    refetchInterval: (q) => (q.state.data && IN_PROGRESS.includes(q.state.data.recording.status) ? 3000 : false),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["recording", id] });
    void queryClient.invalidateQueries({ queryKey: ["recordings"] });
    void queryClient.invalidateQueries({ queryKey: ["home"] });
  };

  const reprocess = useMutation({
    mutationFn: (from: "transcribe" | "understand") =>
      api(`/recordings/${id}/reprocess`, { method: "POST", body: json({ from }) }),
    onSuccess: refresh,
  });
  const setKeep = useMutation({
    mutationFn: (keepAudio: boolean) => api(`/recordings/${id}`, { method: "PATCH", body: json({ keepAudio }) }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/recordings/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      navigate("/timeline");
    },
  });
  const updateItem = useMutation({
    mutationFn: ({ kind, itemId, status }: { kind: "decisions" | "questions"; itemId: string; status: string }) =>
      api(`/${kind}/${itemId}`, { method: "PATCH", body: json({ status }) }),
    onSuccess: refresh,
  });

  if (query.isPending) return <Spinner />;
  if (query.error) return <ErrorNote error={query.error} />;
  const d = query.data;
  const r = d.recording;
  const seek = r.hasAudio
    ? (seconds: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = seconds;
        void audio.play();
      }
    : null;
  const decisions = d.decisions.filter((x) => x.status !== "dismissed");
  const questions = d.questions.filter((x) => x.status !== "dismissed");

  return (
    <article className="pb-6">
      <Link href="/timeline" className="inline-flex items-center gap-1 pt-1 text-sm text-muted">
        <ArrowLeft className="size-4" /> Timeline
      </Link>

      <p className="mt-4 text-sm text-muted">
        {formatDay(r.recordedAt)} · {formatTime(r.recordedAt)} · {formatDuration(r.durationSec)}
      </p>
      <EditableTitle id={r.id} title={r.title} />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {r.category && <Chip>{capitalize(r.category)}</Chip>}
        {[...new Map(d.thoughts.filter((t) => t.project_id).map((t) => [t.project_id, t.project])).entries()].map(([pid, name]) => (
          <Link key={pid} href={`/projects/${pid}`}>
            <Chip tone="brand">{name}</Chip>
          </Link>
        ))}
        {r.status !== "completed" && <StatusBadge status={r.status} detail={r.statusDetail} />}
      </div>

      {r.status === "failed" && (
        <Card className="mt-4 p-4">
          <p className="text-sm font-medium text-danger">Processing stopped</p>
          {r.lastError && <p className="mt-1 break-words text-xs text-muted">{r.lastError}</p>}
          <Button
            className="mt-3"
            size="sm"
            busy={reprocess.isPending}
            onClick={() => reprocess.mutate(d.transcripts.raw ? "understand" : "transcribe")}
          >
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        </Card>
      )}

      <div className="mt-5">
        {r.hasAudio && r.audioUrl ? (
          <AudioPlayer
            src={apiUrl(r.audioUrl)}
            audioRef={audioRef}
            fallbackDuration={r.durationSec}
            onTime={onTime}
          />
        ) : (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
            Audio was removed after the retention period. The transcript and everything extracted from it are kept.
          </p>
        )}
      </div>

      {r.summary && (
        <>
          <SectionTitle>Summary</SectionTitle>
          <Card className="p-4">
            <p className="text-[15px] leading-relaxed">{r.summary}</p>
            {r.summaryDetailed && r.summaryDetailed !== r.summary && (
              <details className="mt-3 text-sm text-muted">
                <summary className="cursor-pointer text-brand">More detail</summary>
                <p className="mt-2 leading-relaxed">{r.summaryDetailed}</p>
              </details>
            )}
          </Card>
        </>
      )}

      {d.changes && d.changes.length > 0 && (
        <>
          <SectionTitle>What this memo changed</SectionTitle>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {d.changes.map((c) => (
                <ChangeRow key={c.id} change={c} showSource={false} />
              ))}
            </ul>
          </Card>
        </>
      )}

      {d.thoughts.length > 0 && (
        <>
          <SectionTitle>{d.thoughts.length === 1 ? "Thought" : `${d.thoughts.length} thoughts`}</SectionTitle>
          <div className="space-y-2.5">
            {d.thoughts.map((t) => (
              <Card key={t.id} className="p-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone="accent">{capitalize(t.type)}</Chip>
                  <ThoughtProject thoughtId={t.id} projectId={t.project_id} project={t.project} />
                  {t.topics.map((topic) => (
                    <Chip key={topic}>{topic}</Chip>
                  ))}
                </div>
                <h3 className="mt-2 font-medium">{t.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t.summary}</p>
                {t.content && (
                  <blockquote className="mt-2 border-l-2 border-line pl-3 text-sm italic text-muted">
                    {t.content}
                  </blockquote>
                )}
                {t.entities.length > 0 && (
                  <p className="mt-2 text-xs text-muted">{t.entities.map((e) => e.name).join(" · ")}</p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {d.tasks.some((t) => t.status !== "dismissed") && (
        <>
          <SectionTitle>Tasks</SectionTitle>
          <Card className="overflow-hidden">
            <TaskList tasks={d.tasks} />
          </Card>
        </>
      )}

      {decisions.length > 0 && (
        <>
          <SectionTitle>Decisions</SectionTitle>
          <Card className="divide-y divide-line">
            {decisions.map((x) => (
              <div key={x.id} className="flex items-start gap-3 px-4 py-3">
                <Milestone className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={`text-[15px] ${x.status === "reversed" || x.status === "superseded" ? "text-muted line-through" : ""}`}>
                    {x.statement}
                  </p>
                  {(x.status === "reversed" || x.status === "superseded") && (
                    <p className="mt-0.5 text-xs text-muted">You changed this later</p>
                  )}
                  {x.rationale && <p className="mt-0.5 text-xs text-muted">{x.rationale}</p>}
                </div>
                <button
                  type="button"
                  aria-label="Not a decision"
                  onClick={() => updateItem.mutate({ kind: "decisions", itemId: x.id, status: "dismissed" })}
                  className="text-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
            ))}
          </Card>
        </>
      )}

      {questions.length > 0 && (
        <>
          <SectionTitle>Open questions</SectionTitle>
          <Card className="divide-y divide-line">
            {questions.map((x) => (
              <div key={x.id} className="flex items-start gap-3 px-4 py-3">
                <HelpCircle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <p className={`min-w-0 flex-1 text-[15px] ${x.status === "resolved" ? "text-muted line-through" : ""}`}>
                  {x.question}
                </p>
                {x.status === "open" && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      aria-label="Mark answered"
                      onClick={() => updateItem.mutate({ kind: "questions", itemId: x.id, status: "resolved" })}
                      className="grid size-8 place-items-center rounded-full bg-brand-soft text-brand"
                    >
                      <Check className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="Not a question"
                      onClick={() => updateItem.mutate({ kind: "questions", itemId: x.id, status: "dismissed" })}
                      className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </>
      )}

      {d.transcripts.raw && (
        <>
          <SectionTitle>Transcript</SectionTitle>
          <TranscriptPanel detail={d} currentTime={time} onSeek={seek} />
        </>
      )}

      <SectionTitle>Manage</SectionTitle>
      <Card className="divide-y divide-line">
        {r.hasAudio && (
          <label className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="flex items-center gap-2 text-[15px]">
              <Pin className="size-4 text-muted" /> Keep audio forever
            </span>
            <input
              type="checkbox"
              checked={r.keepAudio}
              onChange={(e) => setKeep.mutate(e.target.checked)}
              className="size-5 accent-[var(--brand)]"
            />
          </label>
        )}
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Button
            size="sm"
            disabled={!d.transcripts.raw || IN_PROGRESS.includes(r.status)}
            busy={reprocess.isPending && reprocess.variables === "understand"}
            onClick={() => reprocess.mutate("understand")}
          >
            <RefreshCw className="size-3.5" /> Re-run analysis
          </Button>
          {r.hasAudio && (
            <Button
              size="sm"
              disabled={IN_PROGRESS.includes(r.status)}
              busy={reprocess.isPending && reprocess.variables === "transcribe"}
              onClick={() => reprocess.mutate("transcribe")}
            >
              <RefreshCw className="size-3.5" /> Transcribe again
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            busy={remove.isPending}
            onClick={() => {
              if (window.confirm("Delete this memo, its audio and everything extracted from it?")) remove.mutate();
            }}
          >
            <Trash2 className="size-3.5" /> Delete
          </Button>
        </div>
        <ErrorNote error={reprocess.error ?? remove.error ?? setKeep.error} />
      </Card>

      {d.analysis && (
        <p className="mt-4 text-center text-xs text-muted">
          Analysed by {d.analysis.provider} · {d.analysis.model} · v{d.analysis.version}
        </p>
      )}
    </article>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarRange, Lightbulb, RefreshCw, TrendingUp } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { Bullets, Button, Card, Chip, ErrorNote, PageHeader, SectionTitle } from "../components/ui";
import { api, json, type ProjectSummaryItem, type RangeSummaryResult } from "../lib/api";
import { useOnline } from "../lib/online";

/** Local calendar date as YYYY-MM-DD. */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

interface Range {
  key: string;
  label: string;
  start: string;
  end: string;
}

function presets(): Range[] {
  const today = isoDate(new Date());
  const monthStart = isoDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  return [
    { key: "today", label: "Today", start: today, end: today },
    { key: "yesterday", label: "Yesterday", start: daysAgo(1), end: daysAgo(1) },
    { key: "7d", label: "Last 7 days", start: daysAgo(6), end: today },
    { key: "15d", label: "Last 15 days", start: daysAgo(14), end: today },
    { key: "30d", label: "Last 30 days", start: daysAgo(29), end: today },
    { key: "month", label: "This month", start: monthStart, end: today },
  ];
}

function formatRange(start: string, end: string): string {
  const fmt = (s: string, withYear = false) =>
    new Date(`${s}T12:00:00`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: withYear ? "numeric" : undefined,
    });
  if (start === end) return new Date(`${start}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  return `${fmt(start)} – ${fmt(end, true)}`;
}

function Block({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2">
      <p className="font-serif text-xl leading-none">{value}</p>
      <p className="mt-1 text-[11px] text-muted">{label}</p>
    </div>
  );
}

function SummaryView({ result, projects }: { result: RangeSummaryResult; projects: ProjectSummaryItem[] }) {
  const s = result.summary;
  const st = result.stats;
  const projectId = (name: string) => projects.find((p) => p.name.toLowerCase() === name.toLowerCase())?.id;

  if (!s) {
    return (
      <Card className="mt-5 p-6 text-center">
        <p className="font-medium">No memos in this period</p>
        <p className="mt-1 text-sm text-muted">Pick a different range, or record something new.</p>
      </Card>
    );
  }

  return (
    <div className="mt-5 space-y-3">
      <Card className="p-5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{formatRange(result.start, result.end)}</p>
        <h2 className="mt-1.5 font-serif text-2xl leading-snug">{s.headline}</h2>
        <div className="mt-4 grid grid-cols-4 gap-2">
          <Stat value={st.memos} label="memos" />
          <Stat value={st.minutes} label="minutes" />
          <Stat value={st.tasksCreated} label="tasks" />
          <Stat value={st.decisions} label="decisions" />
        </div>
        <p className="mt-4 text-[15px] leading-relaxed">{s.overview}</p>
        {s.themes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {s.themes.map((t) => (
              <Chip key={t}>{t}</Chip>
            ))}
          </div>
        )}
      </Card>

      {s.emerging && (
        <Card className="border-accent/30 bg-accent-soft/40 p-4">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-accent">
            <TrendingUp className="size-3.5" /> Gaining momentum
          </p>
          <p className="mt-1 text-[15px]">{s.emerging}</p>
        </Card>
      )}

      {s.projects.length > 0 && (
        <>
          <SectionTitle>By project</SectionTitle>
          {s.projects.map((p) => {
            const id = projectId(p.name);
            const body = (
              <Card className="p-4 transition hover:border-muted/40">
                <h3 className="font-serif text-lg">{p.name}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{p.summary}</p>
                {p.highlights.length > 0 && (
                  <div className="mt-3">
                    <Bullets items={p.highlights} tone="brand" />
                  </div>
                )}
              </Card>
            );
            return id ? (
              <Link key={p.name} href={`/projects/${id}`} className="block">
                {body}
              </Link>
            ) : (
              <div key={p.name}>{body}</div>
            );
          })}
        </>
      )}

      <Card className="space-y-5 p-5">
        {s.key_ideas.length > 0 && (
          <Block title="Key ideas" icon={<Lightbulb className="size-4 text-accent" />}>
            <Bullets items={s.key_ideas} tone="accent" />
          </Block>
        )}
        {s.action_items.length > 0 && (
          <Block title="To do">
            <Bullets items={s.action_items} tone="brand" />
          </Block>
        )}
        {s.decisions.length > 0 && (
          <Block title="Decided">
            <Bullets items={s.decisions} />
          </Block>
        )}
        {s.open_questions.length > 0 && (
          <Block title="Still open">
            <Bullets items={s.open_questions} />
          </Block>
        )}
      </Card>

      {s.reflection && (
        <p className="px-2 pt-1 text-center font-serif text-lg italic leading-snug text-muted">{s.reflection}</p>
      )}
    </div>
  );
}

export function Summary() {
  const queryClient = useQueryClient();
  const search = useSearch();
  const online = useOnline();
  const all = presets();
  const initial = all.find((r) => r.key === new URLSearchParams(search).get("range")) ?? all[2];
  const [range, setRange] = useState<Range>(initial);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState(daysAgo(6));
  const [customEnd, setCustomEnd] = useState(daysAgo(0));

  // Links like /summary?range=today pick the preset (presets only depend on today's date).
  const rangeParam = new URLSearchParams(search).get("range");
  useEffect(() => {
    const fromUrl = presets().find((r) => r.key === rangeParam);
    if (fromUrl) setRange(fromUrl);
  }, [rangeParam]);

  const queryKey = ["summary", range.start, range.end];
  const summary = useQuery({
    queryKey,
    queryFn: () =>
      api<RangeSummaryResult>("/summaries", { method: "POST", body: json({ start: range.start, end: range.end }) }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const regenerate = useMutation({
    mutationFn: () =>
      api<RangeSummaryResult>("/summaries", {
        method: "POST",
        body: json({ start: range.start, end: range.end, refresh: true }),
      }),
    onSuccess: (data) => queryClient.setQueryData(queryKey, data),
  });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects") });

  const long = (Date.parse(range.end) - Date.parse(range.start)) / 86_400_000 >= 6;
  const working = summary.isFetching || regenerate.isPending;

  return (
    <div>
      <PageHeader title="Summary" subtitle="What you've been thinking about" />

      <div className="no-scrollbar -mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {all.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => {
              setCustomOpen(false);
              setRange(r);
            }}
            className={`shrink-0 rounded-full px-3.5 py-2 text-sm font-medium transition ${
              range.key === r.key ? "bg-ink text-bg" : "bg-surface-2 text-muted"
            }`}
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium ${
            range.key === "custom" || customOpen ? "bg-ink text-bg" : "bg-surface-2 text-muted"
          }`}
        >
          <CalendarRange className="size-4" /> Custom
        </button>
      </div>

      {customOpen && (
        <Card className="mt-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">
              From
              <input
                type="date"
                value={customStart}
                max={customEnd}
                onChange={(e) => setCustomStart(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3"
              />
            </label>
            <label className="text-sm font-medium">
              To
              <input
                type="date"
                value={customEnd}
                min={customStart}
                max={daysAgo(0)}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3"
              />
            </label>
          </div>
          <Button
            className="mt-3 w-full"
            variant="primary"
            disabled={!customStart || !customEnd || customEnd < customStart}
            onClick={() => {
              setRange({ key: "custom", label: "Custom", start: customStart, end: customEnd });
              setCustomOpen(false);
            }}
          >
            Summarise this range
          </Button>
        </Card>
      )}

      {working && !summary.data && (
        <Card className="mt-5 p-6 text-center">
          <RefreshCw className="mx-auto size-6 animate-spin text-muted" />
          <p className="mt-3 font-medium">Reading your memos…</p>
          <p className="mt-0.5 text-sm text-muted">{formatRange(range.start, range.end)}</p>
          <p className="mt-2 text-xs text-muted">{long ? "Longer periods can take up to a minute." : "This takes a few seconds."}</p>
        </Card>
      )}
      {!online && !summary.data && <p className="mt-5 text-center text-sm text-muted">Connect to the internet to write a new summary.</p>}
      <ErrorNote error={summary.error ?? regenerate.error} />

      {summary.data && <SummaryView result={summary.data} projects={projects.data?.projects ?? []} />}

      {summary.data?.summary && (
        <div className="mt-5 flex items-center justify-center gap-3 text-xs text-muted">
          <span>
            {summary.data.cached ? "Saved summary" : "Just written"}
            {summary.data.createdAt ? ` · ${new Date(summary.data.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}
          </span>
          <button
            type="button"
            onClick={() => regenerate.mutate()}
            disabled={working || !online}
            className="inline-flex items-center gap-1 text-brand disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${regenerate.isPending ? "animate-spin" : ""}`} /> Rewrite
          </button>
        </div>
      )}
    </div>
  );
}

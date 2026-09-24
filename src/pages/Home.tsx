import { useQuery } from "@tanstack/react-query";
import { ArrowRight, BellRing, HelpCircle, Mic, Milestone, Search as SearchIcon, Settings as SettingsIcon, Sparkles } from "lucide-react";
import { useMemo } from "react";
import { Link } from "wouter";
import { PendingUploads } from "../components/PendingUploads";
import { RecordingCard } from "../components/RecordingCard";
import { RemindersSection, useReminders, formatReminderTime } from "../components/Reminders";
import { TaskList, TasksSection } from "../components/TaskList";
import { Card, Chip, IconLink, PageHeader, SectionTitle } from "../components/ui";
import { api, type HomeData, IN_PROGRESS, type ProjectSummaryItem, type RecordingSummary } from "../lib/api";
import { formatDayInline, formatDuration } from "../lib/format";
import { useRecording } from "../lib/recording";

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function todayDateKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TodaySection({ tasks }: { tasks: import("../lib/api").Task[] }) {
  const remindersQuery = useReminders();
  const todayKey = useMemo(todayDateKey, []);

  const todayTasks = useMemo(
    () => tasks.filter((t) => t.due_date === todayKey && t.status !== "dismissed"),
    [tasks, todayKey],
  );

  const todayReminders = useMemo(() => {
    const all = remindersQuery.data?.reminders ?? [];
    const start = new Date(new Date().toDateString()).getTime();
    const end = start + 86_400_000;
    return all.filter(
      (r) => r.remind_at >= start && r.remind_at < end && (r.status === "pending" || r.status === "sent"),
    );
  }, [remindersQuery.data]);

  if (todayTasks.length === 0 && todayReminders.length === 0) return null;

  return (
    <>
      <SectionTitle>Today</SectionTitle>
      <Card className="overflow-hidden">
        {todayTasks.length > 0 && (
          <>
            <p className="border-b border-line bg-brand-soft/30 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-brand">
              Tasks due today
            </p>
            <TaskList tasks={todayTasks} showSource />
          </>
        )}
        {todayReminders.length > 0 && (
          <>
            <p className="border-b border-line bg-accent-soft/30 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-accent">
              Reminders today
            </p>
            <ul className="divide-y divide-line">
              {todayReminders.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <BellRing className="size-4 shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-snug">{r.text}</p>
                    <p className="text-xs text-muted">{formatReminderTime(r.remind_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </>
  );
}

export function Home({ userName }: { userName: string }) {
  const rec = useRecording();
  const recent = useQuery({
    queryKey: ["recordings", "recent"],
    queryFn: () => api<{ recordings: RecordingSummary[] }>("/recordings?limit=5"),
    refetchInterval: (q) => (q.state.data?.recordings.some((r) => IN_PROGRESS.includes(r.status)) ? 4000 : false),
  });
  const home = useQuery({
    queryKey: ["home"],
    queryFn: () => api<HomeData>("/home"),
    refetchInterval: recent.data?.recordings.some((r) => IN_PROGRESS.includes(r.status)) ? 8000 : false,
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummaryItem[] }>("/projects"),
  });

  const stats = home.data?.last24h;
  const firstName = userName.split(" ")[0];
  const noMemosYet = recent.isSuccess && recent.data.recordings.length === 0;
  const activeProjects = (projects.data?.projects ?? []).filter((p) => p.thoughtCount > 0).slice(0, 6);

  return (
    <div>
      <PageHeader
        subtitle={new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        title={firstName ? `${greeting()}, ${firstName}` : greeting()}
        actions={
          <>
            <IconLink href="/search" label="Search">
              <SearchIcon className="size-5" />
            </IconLink>
            <IconLink href="/settings" label="Settings">
              <SettingsIcon className="size-5" />
            </IconLink>
          </>
        }
      />

      <PendingUploads />

      {noMemosYet ? (
        <Card className="mt-6 p-6 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
            <Mic className="size-6" />
          </div>
          <h2 className="mt-4 font-serif text-2xl">Say what's on your mind</h2>
          <p className="mt-2 text-sm text-muted">
            Tap the red button at the bottom and just talk. Voice Memo transcribes it, pulls out tasks, decisions and ideas,
            and files everything into your projects.
          </p>
        </Card>
      ) : (
        <Card className="mt-5 flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Last 24 hours</p>
            <p className="mt-1 text-[15px]">
              <span className="font-serif text-2xl">{stats?.recordings ?? 0}</span>{" "}
              {stats?.recordings === 1 ? "memo" : "memos"} · {formatDuration(stats?.seconds ?? 0)}
            </p>
            {Boolean(stats?.processing) && <p className="text-xs text-warn">{stats?.processing} still processing</p>}
          </div>
          <Link
            href="/summary?range=today"
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-3.5 py-2 text-sm font-medium text-brand"
          >
            <Sparkles className="size-4" /> Summarise
          </Link>
        </Card>
      )}

      <TodaySection tasks={home.data?.tasks ?? []} />

      {!noMemosYet && <TasksSection tasks={home.data?.tasks ?? []} title="All tasks" />}

      {!noMemosYet && <RemindersSection />}

      {activeProjects.length > 0 && (
        <>
          <SectionTitle
            action={
              <Link href="/projects" className="text-sm text-brand">
                All projects
              </Link>
            }
          >
            Projects
          </SectionTitle>
          <div className="no-scrollbar -mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1">
            {activeProjects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="w-56 shrink-0 snap-start rounded-2xl border border-line bg-surface p-4 transition active:scale-[0.99]"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="truncate font-serif text-lg">{p.name}</h3>
                  <ArrowRight className="size-4 shrink-0 text-muted" />
                </div>
                <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm text-muted">
                  {p.summary?.current_focus ?? `${p.thoughtCount} thoughts so far`}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {p.lastActivity ? `Active ${formatDayInline(p.lastActivity)}` : ""}
                  {p.openTasks > 0 ? ` · ${p.openTasks} open` : ""}
                </p>
              </Link>
            ))}
          </div>
        </>
      )}

      {home.data && home.data.questions.length > 0 && (
        <>
          <SectionTitle>Open questions</SectionTitle>
          <Card className="divide-y divide-line">
            {home.data.questions.map((q) => (
              <Link key={q.id} href={`/r/${q.recording_id}`} className="flex gap-3 px-4 py-3 text-[15px]">
                <HelpCircle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                {q.question}
              </Link>
            ))}
          </Card>
        </>
      )}

      {home.data && home.data.decisions.length > 0 && (
        <>
          <SectionTitle>Recent decisions</SectionTitle>
          <Card className="divide-y divide-line">
            {home.data.decisions.map((d) => (
              <Link key={d.id} href={`/r/${d.recording_id}`} className="flex gap-3 px-4 py-3 text-[15px]">
                <Milestone className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                {d.statement}
              </Link>
            ))}
          </Card>
        </>
      )}

      {recent.data && recent.data.recordings.length > 0 && (
        <>
          <SectionTitle
            action={
              <Link href="/timeline" className="text-sm text-brand">
                See all
              </Link>
            }
          >
            Recent memos
          </SectionTitle>
          <div className="space-y-2.5">
            {recent.data.recordings.map((r) => (
              <RecordingCard key={r.id} recording={r} />
            ))}
          </div>
        </>
      )}

      {!rec.supported && (
        <p className="mt-6 text-center text-sm text-danger">This browser can't record audio. Try Chrome on Android or Safari on Mac.</p>
      )}
      {activeProjects.length === 0 && !noMemosYet && projects.isSuccess && (
        <p className="mt-6 text-center text-xs text-muted">
          Mention a project by name in a memo (e.g. "for Lumina…") and it gets its own page. <Chip>Projects</Chip>
        </p>
      )}
    </div>
  );
}

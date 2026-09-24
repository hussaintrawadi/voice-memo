import { ListChecks } from "lucide-react";
import { Link } from "wouter";
import type { RecordingSummary } from "../lib/api";
import { capitalize, formatDuration, formatTime } from "../lib/format";
import { Chip, StatusBadge } from "./ui";

export function RecordingCard({ recording: r }: { recording: RecordingSummary }) {
  const pending = r.status !== "completed";
  return (
    <Link
      href={`/r/${r.id}`}
      className="block rounded-2xl border border-line bg-surface px-4 py-3.5 transition hover:border-muted/40 active:scale-[0.99]"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular-nums">
          {formatTime(r.recordedAt)} · {formatDuration(r.durationSec)}
        </span>
        {pending ? <StatusBadge status={r.status} detail={r.statusDetail} /> : r.category && <Chip>{capitalize(r.category)}</Chip>}
      </div>
      <h3 className={`mt-1.5 font-serif text-[17px] leading-snug ${r.title ? "" : "italic text-muted"}`}>
        {r.title ?? (r.status === "failed" ? "Couldn't process this memo" : "Processing your memo…")}
      </h3>
      {r.summary && <p className="mt-1 line-clamp-2 text-sm text-muted">{r.summary}</p>}
      {(r.projects.length > 0 || r.openTasks > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {r.projects.map((p) => (
            <Chip key={p} tone="brand">
              {p}
            </Chip>
          ))}
          {r.openTasks > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              <ListChecks className="size-3.5" aria-hidden /> {r.openTasks} open
            </span>
          )}
        </div>
      )}
    </Link>
  );
}

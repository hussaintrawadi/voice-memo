import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, HelpCircle, ListChecks, Milestone, RefreshCw, Undo2 } from "lucide-react";
import { Link } from "wouter";
import { api, type ContextChange } from "../lib/api";
import { formatDayInline } from "../lib/format";
import { syncDeviceReminders } from "../lib/native";
import { Card, ErrorNote, SectionTitle } from "./ui";

const ICONS = { task: ListChecks, decision: Milestone, reminder: AlarmClock, question: HelpCircle } as const;

/** Undo for a change a memo made, refreshing everything it could have touched. */
export function useUndoChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: ContextChange) => api(`/context-changes/${change.id}/undo`, { method: "POST" }),
    onSuccess: (_data, change) => {
      if (change.item_type === "reminder") syncDeviceReminders();
      for (const key of ["context-changes", "home", "reminders", "projects", "project", "recording", "recordings", "summary"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export function ChangeRow({ change, showSource = true }: { change: ContextChange; showSource?: boolean }) {
  const undo = useUndoChange();
  const Icon = ICONS[change.item_type] ?? RefreshCw;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug">{change.summary}</p>
        <p className="mt-0.5 text-xs text-muted">
          {formatDayInline(change.created_at)}
          {showSource && change.recording_id && (
            <>
              {" · "}
              <Link href={`/r/${change.recording_id}`} className="underline-offset-2 hover:underline">
                {change.recording_title ? `From “${change.recording_title}”` : "From memo"}
              </Link>
            </>
          )}
        </p>
        <ErrorNote error={undo.error} />
      </div>
      <button
        type="button"
        onClick={() => undo.mutate(change)}
        disabled={undo.isPending}
        aria-label="Undo this change"
        title="Undo"
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
      >
        <Undo2 className="size-3.5" /> Undo
      </button>
    </li>
  );
}

/**
 * What your recent memos changed: a decision you replaced, a task you dropped or finished,
 * a reminder you moved. Hidden when nothing changed.
 */
export function ContextUpdates({ live = false }: { live?: boolean }) {
  const changes = useQuery({
    queryKey: ["context-changes"],
    queryFn: () => api<{ changes: ContextChange[] }>("/context-changes?days=3&limit=6"),
    // While a memo is still processing, look again so its updates show up when it finishes.
    refetchInterval: live ? 8000 : false,
  });
  const items = changes.data?.changes ?? [];
  if (!items.length) return null;
  return (
    <>
      <SectionTitle>Updated from your memos</SectionTitle>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {items.map((c) => (
            <ChangeRow key={c.id} change={c} />
          ))}
        </ul>
      </Card>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, BellRing, Check, Plus, Trash2, X } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { Link } from "wouter";
import { api, json, type Reminder } from "../lib/api";
import { useEditGestures } from "../lib/gestures";
import { syncDeviceReminders } from "../lib/native";
import { Button, Card, EditButton, ErrorNote, SectionTitle } from "./ui";

const pad = (n: number) => String(n).padStart(2, "0");
/** Value for <input type="datetime-local">, in this device's time. */
const toLocalInput = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function formatReminderTime(ts: number): string {
  const d = new Date(ts);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(new Date().toDateString()).getTime();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (day === today) return `Today ${time}`;
  if (day === today + 86_400_000) return `Tomorrow ${time}`;
  if (day === today - 86_400_000) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

export function useReminders() {
  return useQuery({
    queryKey: ["reminders"],
    queryFn: () => api<{ reminders: Reminder[] }>("/reminders"),
    // Keeps "due" states fresh without polling hard.
    refetchInterval: 60_000,
  });
}

/* ── Add Reminder form ───────────────────────────────────────────── */

function AddReminder({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  // Default: the next full hour.
  const [at, setAt] = useState(() => toLocalInput(Math.ceil((Date.now() + 5 * 60_000) / 3600_000) * 3600_000));
  const create = useMutation({
    mutationFn: () => api("/reminders", { method: "POST", body: json({ text: text.trim(), remindAt: new Date(at).getTime() }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reminders"] });
      syncDeviceReminders();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && at) create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 border-b border-line p-4">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Remind me to…"
        aria-label="Reminder"
        maxLength={300}
        className="h-11 w-full rounded-xl border border-line bg-bg px-3 outline-none focus:border-brand"
      />
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={at}
          min={toLocalInput(Date.now())}
          onChange={(e) => setAt(e.target.value)}
          aria-label="When"
          className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-bg px-3"
        />
        <Button type="submit" variant="primary" busy={create.isPending} disabled={!text.trim() || !at}>
          Add
        </Button>
      </div>
      <ErrorNote error={create.error} />
    </form>
  );
}

/* ── Inline edit form (appears on long-press) ────────────────────── */

function ReminderEditForm({ reminder, onClose, onSave, onDelete, onMarkDone }: {
  reminder: Reminder;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => void;
  onDelete: () => void;
  onMarkDone: () => void;
}) {
  const [text, setText] = useState(reminder.text);
  const [at, setAt] = useState(() => toLocalInput(reminder.remind_at));
  const save = () => {
    if (!text.trim() || !at) return;
    onSave({ text: text.trim(), remindAt: new Date(at).getTime() });
  };
  const field = "h-10 w-full rounded-xl border border-line bg-bg px-3 text-sm outline-none focus:border-brand";
  return (
    <div className="space-y-2 border-t border-line bg-surface-2/50 px-4 py-3">
      <label className="block text-xs font-medium text-muted">
        Reminder
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} className={`mt-1 ${field}`} />
      </label>
      <label className="block text-xs font-medium text-muted">
        When
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={`mt-1 ${field}`} />
      </label>
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button type="button" onClick={onMarkDone} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-ok hover:bg-ok/10">
            <Check className="size-3.5" /> Done
          </button>
          <button type="button" onClick={onDelete} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-danger hover:bg-danger/10">
            <Trash2 className="size-3.5" /> Delete
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-surface-2">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!text.trim() || !at}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Reminders section ───────────────────────────────────────────── */

/** Upcoming reminders with save / dismiss / long-press-to-edit. */
export function RemindersSection() {
  const queryClient = useQueryClient();
  const reminders = useReminders();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api(`/reminders/${id}`, { method: "PATCH", body: json(body) }),
    onSettled: () => {
      syncDeviceReminders();
      return queryClient.invalidateQueries({ queryKey: ["reminders"] });
    },
  });
  const items = (reminders.data?.reminders ?? []).filter((r) => r.status === "pending" || r.status === "sent");

  return (
    <>
      <SectionTitle
        action={
          <button type="button" onClick={() => setAdding((v) => !v)} className="inline-flex items-center gap-1 text-sm text-brand">
            <Plus className="size-4" /> Add
          </button>
        }
      >
        Reminders
      </SectionTitle>
      <Card className="overflow-hidden">
        {adding && <AddReminder onDone={() => setAdding(false)} />}
        {items.length === 0 && !adding && (
          <p className="px-4 py-3 text-sm text-muted">
            Say "remind me…" in a memo, ask Claude, or tap Add.
          </p>
        )}
        <ul className="divide-y divide-line">
          {items.map((r) => (
            <ReminderRow
              key={r.id}
              reminder={r}
              isEditing={editingId === r.id}
              setEditingId={setEditingId}
              update={update}
            />
          ))}
        </ul>
      </Card>
    </>
  );
}

function ReminderRow({ reminder: r, isEditing, setEditingId, update }: {
  reminder: Reminder;
  isEditing: boolean;
  setEditingId: (id: string | null) => void;
  update: ReturnType<typeof useMutation<unknown, Error, { id: string; body: Record<string, unknown> }>>;
}) {
  const due = r.status === "sent" || r.remind_at <= Date.now();
  const isSuggested = r.status === "suggested" || (r.status === "pending" && r.origin === "voice");
  const edit = useCallback(() => setEditingId(r.id), [r.id, setEditingId]);
  const gestures = useEditGestures(edit);

  return (
    <li>
      <div className="group flex items-start gap-3 px-4 py-3" {...gestures}>
        {due ? (
          <BellRing className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        ) : (
          <AlarmClock className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-snug">{r.text}</p>
          <p className={`mt-0.5 text-xs ${due ? "font-medium text-accent" : "text-muted"}`}>
            {formatReminderTime(r.remind_at)}
            {r.recording_id && (
              <>
                {" · "}
                <Link href={`/r/${r.recording_id}`} className="underline-offset-2 hover:underline">
                  From memo
                </Link>
              </>
            )}
            {isSuggested && " · Needs confirmation"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <EditButton onClick={edit} label="Edit reminder" />
          {due && !isSuggested && (
            <button
              type="button"
              aria-label="Snooze one hour"
              title="Snooze 1 hour"
              onClick={() => update.mutate({ id: r.id, body: { remindAt: Date.now() + 3600_000 } })}
              className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted"
            >
              <AlarmClock className="size-4" />
            </button>
          )}
          {isSuggested ? (
            <>
              {/* ✅ = Save / accept the reminder */}
              <button
                type="button"
                aria-label="Save reminder"
                title="Save reminder"
                onClick={() => update.mutate({ id: r.id, body: { status: "pending" } })}
                className="grid size-8 place-items-center rounded-full bg-brand-soft text-brand"
              >
                <Check className="size-4" />
              </button>
              {/* ❌ = Discard / don't save the reminder */}
              <button
                type="button"
                aria-label="Discard reminder"
                title="Discard reminder"
                onClick={() => update.mutate({ id: r.id, body: { status: "cancelled" } })}
                className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted"
              >
                <X className="size-4" />
              </button>
            </>
          ) : due ? (
            <button
              type="button"
              aria-label="Mark done"
              title="Mark done"
              onClick={() => update.mutate({ id: r.id, body: { status: "done" } })}
              className="grid size-8 place-items-center rounded-full bg-brand-soft text-brand"
            >
              <Check className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      {isEditing && (
        <ReminderEditForm
          reminder={r}
          onClose={() => setEditingId(null)}
          onSave={(body) => {
            update.mutate({ id: r.id, body }, { onSuccess: () => setEditingId(null) });
          }}
          onDelete={() => {
            update.mutate({ id: r.id, body: { status: "cancelled" } }, { onSuccess: () => setEditingId(null) });
          }}
          onMarkDone={() => {
            update.mutate({ id: r.id, body: { status: "done" } }, { onSuccess: () => setEditingId(null) });
          }}
        />
      )}
    </li>
  );
}

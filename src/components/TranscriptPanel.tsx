import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { api, json, type RecordingDetail, type Segment } from "../lib/api";
import { formatDuration } from "../lib/format";
import { Button, Card, ErrorNote } from "./ui";

type Tab = "clean" | "original" | "edited";

export function TranscriptPanel({
  detail,
  currentTime,
  onSeek,
}: {
  detail: RecordingDetail;
  currentTime: number;
  onSeek: ((seconds: number) => void) | null;
}) {
  const { raw, cleaned, edited } = detail.transcripts;
  const initial: Tab = edited ? "edited" : cleaned ? "clean" : "original";
  const [tab, setTab] = useState<Tab>(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const queryClient = useQueryClient();

  useEffect(() => setTab(initial), [initial]);

  const save = useMutation({
    mutationFn: (text: string) =>
      api(`/recordings/${detail.recording.id}/transcript`, { method: "PUT", body: json({ text, reanalyze: true }) }),
    onSuccess: () => {
      setEditing(false);
      setTab("edited");
      void queryClient.invalidateQueries({ queryKey: ["recording", detail.recording.id] });
    },
  });

  if (!raw) return null;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "edited", label: "Your edit", show: Boolean(edited) },
    { id: "clean", label: "Clean", show: Boolean(cleaned) },
    { id: "original", label: "Original", show: true },
  ];
  const current = tab === "edited" ? edited : tab === "clean" ? cleaned : raw;
  const segments: Segment[] | null = tab === "original" ? raw.segments : null;

  const startEdit = () => {
    setDraft((edited ?? cleaned ?? raw).text);
    setEditing(true);
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-2 py-2">
        <div className="flex gap-1" role="tablist">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setEditing(false);
                }}
                className={`rounded-full px-3 py-1.5 text-sm ${tab === t.id ? "bg-surface-2 font-medium" : "text-muted"}`}
              >
                {t.label}
              </button>
            ))}
        </div>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={startEdit}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className="p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            className="w-full rounded-xl border border-line bg-bg p-3 text-[15px] leading-relaxed outline-none focus:border-brand"
          />
          <p className="mt-2 text-xs text-muted">
            Saving keeps the original and re-runs the analysis on your version.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(draft)}>
              Save
            </Button>
          </div>
          <ErrorNote error={save.error} />
        </div>
      ) : segments && segments.length > 0 ? (
        <div className="max-h-[60vh] space-y-1 overflow-y-auto p-2">
          {segments.map((s, i) => {
            const active = currentTime >= s.start && currentTime < s.end;
            return (
              <button
                key={i}
                type="button"
                disabled={!onSeek}
                onClick={() => onSeek?.(s.start)}
                className={`flex w-full gap-3 rounded-xl px-2 py-1.5 text-left text-[15px] leading-relaxed transition ${
                  active ? "bg-brand-soft" : "hover:bg-surface-2"
                }`}
              >
                <span className="w-10 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted">
                  {formatDuration(s.start)}
                </span>
                <span>{s.text}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="whitespace-pre-wrap p-4 text-[15px] leading-relaxed">
          {current?.text || <span className="italic text-muted">No speech detected.</span>}
        </div>
      )}

      {current && !editing && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          {tab === "edited"
            ? `Edited by you · version ${current.version}`
            : `${current.provider ?? ""} ${current.model ?? ""}`.trim() || " "}
        </p>
      )}
    </Card>
  );
}

import { CloudOff, CloudUpload, RotateCw, Trash2 } from "lucide-react";
import { pendingActions, usePendingUploads } from "../lib/capture";
import { formatDuration, formatTime } from "../lib/format";
import { useOnline } from "../lib/online";
import { Card } from "./ui";

export function PendingUploads() {
  const items = usePendingUploads();
  const online = useOnline();
  if (!items.length) return null;

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {online ? <CloudUpload className="size-4 text-warn" /> : <CloudOff className="size-4 text-muted" />}
          {items.length} {items.length === 1 ? "memo" : "memos"} {online ? "waiting to upload" : "saved on this device"}
        </div>
        {online && (
          <button type="button" onClick={() => void pendingActions.uploadNow()} className="text-sm text-brand">
            Upload now
          </button>
        )}
      </div>
      {!online && (
        <p className="border-t border-line px-4 py-2 text-xs text-muted">
          They'll upload by themselves when you're back online.
        </p>
      )}
      <ul className="divide-y divide-line border-t border-line">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className="tabular-nums text-muted">
              {formatTime(item.recordedAt)} · {formatDuration(item.durationSec)}
            </span>
            <span className={`min-w-0 flex-1 truncate text-xs ${item.blocked ? "text-danger" : "text-muted"}`}>
              {online ? (item.lastError ?? "") : ""}
            </span>
            {item.blocked && (
              <button type="button" aria-label="Retry upload" onClick={() => void pendingActions.retry(item.id)}>
                <RotateCw className="size-4 text-muted" />
              </button>
            )}
            <button
              type="button"
              aria-label="Delete this recording"
              onClick={() => {
                if (window.confirm("Delete this recording? It hasn't been uploaded yet.")) void pendingActions.remove(item.id);
              }}
            >
              <Trash2 className="size-4 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

import Dexie, { liveQuery, type Table } from "dexie";
import { useEffect, useState } from "react";
import type { RecordedPart } from "./recorder";

export interface PendingUpload extends RecordedPart {
  createdAt: number;
  attempts: number;
  lastError: string | null;
  /** Set when the server refused the file for a reason retrying won't fix. */
  blocked: boolean;
}

class QueueDb extends Dexie {
  uploads!: Table<PendingUpload, string>;
  kv!: Table<{ key: string; value: string }, string>;
  constructor() {
    super("voice-memo");
    this.version(1).stores({ uploads: "id, createdAt" });
    this.version(2).stores({ uploads: "id, createdAt", kv: "key" });
  }
}

const db = new QueueDb();

/** Async key/value storage on IndexedDB, used to keep the query cache for offline reading. */
export const kvStorage = {
  getItem: async (key: string) => (await db.kv.get(key))?.value ?? null,
  setItem: async (key: string, value: string) => {
    await db.kv.put({ key, value });
  },
  removeItem: async (key: string) => {
    await db.kv.delete(key);
  },
};

type Listener = () => void;
const uploadedListeners = new Set<Listener>();

/** Called after any upload succeeds, so views can refresh. */
export function onUploaded(listener: Listener) {
  uploadedListeners.add(listener);
  return () => uploadedListeners.delete(listener);
}

export async function enqueue(part: RecordedPart) {
  await db.uploads.put({ ...part, createdAt: Date.now(), attempts: 0, lastError: null, blocked: false });
  // Ask the browser not to evict the queue under storage pressure.
  void navigator.storage?.persist?.();
  void flushQueue();
}

export async function removePending(id: string) {
  await db.uploads.delete(id);
}

export async function retryPending(id: string) {
  await db.uploads.update(id, { blocked: false, lastError: null });
  void flushQueue();
}

let flushing: Promise<void> | null = null;

/** Uploads queued recordings oldest-first. Safe to call often; runs one pass at a time. */
export function flushQueue(): Promise<void> {
  if (!flushing) {
    flushing = runFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function runFlush() {
  if (!navigator.onLine) return;
  const pending = await db.uploads.orderBy("createdAt").toArray();
  for (const item of pending) {
    if (item.blocked) continue;
    let res: Response;
    try {
      res = await fetch(`/api/recordings/${item.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "content-type": item.mime,
          "x-recorded-at": String(item.recordedAt),
          "x-duration-sec": String(item.durationSec),
          "x-part-of": item.partOf,
          "x-part-index": String(item.partIndex),
          "x-source": "pwa",
          ...(typeof item.peak === "number" ? { "x-audio-peak": String(item.peak) } : {}),
        },
        body: item.audio,
      });
    } catch (err) {
      await db.uploads.update(item.id, { attempts: item.attempts + 1, lastError: String(err) });
      return; // offline or network trouble: try again later
    }

    if (res.ok) {
      await db.uploads.delete(item.id);
      uploadedListeners.forEach((l) => l());
      continue;
    }
    const message = await res
      .json()
      .then((d: { error?: string }) => d.error ?? `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    if (res.status === 401) {
      window.dispatchEvent(new Event("vm:unauthorized"));
      return;
    }
    const permanent = [400, 409, 413, 415].includes(res.status);
    await db.uploads.update(item.id, { attempts: item.attempts + 1, lastError: message, blocked: permanent });
    if (!permanent) return;
  }
}

export function usePendingUploads(): PendingUpload[] {
  const [items, setItems] = useState<PendingUpload[]>([]);
  useEffect(() => {
    const sub = liveQuery(() => db.uploads.orderBy("createdAt").toArray()).subscribe({
      next: setItems,
      error: () => setItems([]),
    });
    return () => sub.unsubscribe();
  }, []);
  return items;
}

/** Keeps the queue moving: on start, on reconnect, when the app comes back to the foreground, and every 30 s. */
export function startQueueWorker() {
  void flushQueue();
  const kick = () => void flushQueue();
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
  window.setInterval(kick, 30_000);
}

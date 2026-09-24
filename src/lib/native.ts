import { type PluginListenerHandle, registerPlugin } from "@capacitor/core";
import { isNativeApp, macBridge } from "./platform";

export type NativeState = "idle" | "recording" | "paused";

export interface NativeStatus {
  state: NativeState;
  /** Seconds across all parts of the current session. */
  elapsedSec: number;
  /** Current input level, 0–1. */
  level: number;
}

export interface NativePending {
  id: string;
  recordedAt: number;
  durationSec: number;
  bytes: number;
  attempts: number;
  lastError: string | null;
  blocked: boolean;
}

/**
 * Android recorder (see android/app/src/main/java/.../recorder).
 * Records in a foreground service so it keeps going with the screen off, stores files
 * on the device, and uploads them with WorkManager whenever there is a connection.
 */
export interface NativeRecorderPlugin {
  configure(options: { baseUrl: string; captureToken: string | null }): Promise<void>;
  getConfig(): Promise<{ baseUrl: string | null; hasToken: boolean }>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<{ saved: boolean }>;
  cancel(): Promise<void>;
  status(): Promise<NativeStatus>;
  listPending(): Promise<{ items: NativePending[] }>;
  retryUploads(): Promise<void>;
  deletePending(options: { id: string }): Promise<void>;
  /** Re-sync reminder alarms now (asks for notification permission first on Android 13+). */
  syncReminders(): Promise<void>;
  addListener(event: "queueChanged", listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: "stateChanged", listener: (status: NativeStatus) => void): Promise<PluginListenerHandle>;
}

export const NativeRecorder = registerPlugin<NativeRecorderPlugin>("NativeRecorder");

/** What the UI needs from a native recorder: the Android plugin or the Mac app's bridge. */
export interface HostRecorder {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<unknown>;
  cancel(): Promise<void>;
  status(): Promise<NativeStatus>;
  listPending(): Promise<{ items: NativePending[] }>;
  retryUploads(): Promise<void>;
  deletePending(options: { id: string }): Promise<void>;
  /** Returns a function that removes the listener. */
  onQueueChanged(listener: () => void): () => void;
}

const androidRecorder: HostRecorder = {
  start: () => NativeRecorder.start(),
  pause: () => NativeRecorder.pause(),
  resume: () => NativeRecorder.resume(),
  stop: () => NativeRecorder.stop(),
  cancel: () => NativeRecorder.cancel(),
  status: () => NativeRecorder.status(),
  listPending: () => NativeRecorder.listPending(),
  retryUploads: () => NativeRecorder.retryUploads(),
  deletePending: (options) => NativeRecorder.deletePending(options),
  onQueueChanged(listener) {
    const handle = NativeRecorder.addListener("queueChanged", listener);
    return () => void handle.then((h) => h.remove());
  },
};

/** Calls the Mac app (apps/macos WebBridge.swift); errors come back as rejected promises. */
export function callMac<T = void>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!macBridge) return Promise.reject(new Error("Not running in the Mac app"));
  return macBridge.postMessage({ method, args }) as Promise<T>;
}

const macRecorder: HostRecorder = {
  start: () => callMac("start"),
  pause: () => callMac("pause"),
  resume: () => callMac("resume"),
  stop: () => callMac("stop"),
  cancel: () => callMac("cancel"),
  status: () => callMac<NativeStatus>("status"),
  listPending: () => callMac<{ items: NativePending[] }>("listPending"),
  retryUploads: () => callMac("retryUploads"),
  deletePending: ({ id }) => callMac("deletePending", { id }),
  onQueueChanged(listener) {
    window.addEventListener("voicememo:queue", listener);
    return () => window.removeEventListener("voicememo:queue", listener);
  },
};

/** The native recorder of the app we're running in; null in a plain browser. */
export const hostRecorder: HostRecorder | null = isNativeApp ? androidRecorder : macBridge ? macRecorder : null;

/** After a reminder changes in the app, have the phone or Mac reschedule its notifications now. */
export function syncDeviceReminders(): void {
  if (isNativeApp) void NativeRecorder.syncReminders().catch(() => undefined);
  else if (macBridge) void callMac("syncReminders").catch(() => undefined);
}

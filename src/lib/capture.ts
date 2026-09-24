import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type HostRecorder, hostRecorder, type NativeState } from "./native";
import { enqueue, flushQueue, removePending, retryPending, usePendingUploads as useWebPending } from "./queue";
import { recordingSupported, VoiceRecorder } from "./recorder";

/** One interface over the browser recorder and the Android and Mac apps' native recorders. */
export interface CaptureController {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Saves the recording to the upload queue. */
  stop(): Promise<void>;
  cancel(): Promise<void>;
  /** Latest state; cheap to call every animation frame. */
  snapshot(): { state: NativeState; elapsedSec: number; level: number };
  dispose(): void;
}

export const captureSupported = () => hostRecorder !== null || recordingSupported();

class WebCapture implements CaptureController {
  private recorder = new VoiceRecorder(async (part) => {
    await enqueue(part);
    this.onSaved();
  });
  constructor(private readonly onSaved: () => void) {}
  start = () => this.recorder.start();
  pause = async () => this.recorder.pause();
  resume = async () => this.recorder.resume();
  stop = () => this.recorder.stop();
  cancel = async () => this.recorder.cancel();
  snapshot() {
    return { state: this.recorder.state, elapsedSec: this.recorder.totalSeconds(), level: this.recorder.level() };
  }
  dispose() {
    if (this.recorder.state !== "idle") void this.recorder.stop();
  }
}

/**
 * Polls the native recorder, which keeps recording even if this screen goes away.
 * Fast while recording (for the waveform), slow when idle, slower still in the background.
 */
class NativeCapture implements CaptureController {
  private latest = { state: "idle" as NativeState, elapsedSec: 0, level: 0 };
  private timer = 0;
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly host: HostRecorder,
    private readonly onSaved: () => void,
  ) {
    this.kick();
  }
  private async refresh() {
    try {
      this.latest = await this.host.status();
    } catch {
      // recorder not ready yet
    }
  }
  private async poll(generation: number) {
    await this.refresh();
    if (this.disposed || generation !== this.generation) return;
    const delay = this.latest.state !== "idle" ? 100 : document.hidden ? 5000 : 1000;
    this.timer = window.setTimeout(() => void this.poll(generation), delay);
  }
  /** Polls now and restarts the schedule, e.g. right after starting a recording. */
  private kick() {
    this.generation += 1;
    window.clearTimeout(this.timer);
    void this.poll(this.generation);
  }
  private async act(action: () => Promise<unknown>) {
    await action();
    await this.refresh();
    this.kick();
  }
  start = () => this.act(() => this.host.start());
  pause = () => this.act(() => this.host.pause());
  resume = () => this.act(() => this.host.resume());
  stop = async () => {
    await this.act(() => this.host.stop());
    this.onSaved();
  };
  cancel = () => this.act(() => this.host.cancel());
  snapshot() {
    return this.latest;
  }
  dispose() {
    this.disposed = true;
    window.clearTimeout(this.timer);
  }
}

export function createCapture(onSaved: () => void): CaptureController {
  return hostRecorder ? new NativeCapture(hostRecorder, onSaved) : new WebCapture(onSaved);
}

export interface PendingItem {
  id: string;
  recordedAt: number;
  durationSec: number;
  lastError: string | null;
  blocked: boolean;
}

/** Recordings saved on this device that haven't reached the server yet. */
export function usePendingUploads(): PendingItem[] {
  const web = useWebPending();
  const [native, setNative] = useState<PendingItem[]>([]);
  const queryClient = useQueryClient();
  const lastCount = useRef(0);

  useEffect(() => {
    const host = hostRecorder;
    if (!host) return;
    let cancelled = false;
    const load = () =>
      host
        .listPending()
        .then((r) => {
          if (cancelled) return;
          // Something finished uploading (maybe recorded from the menu bar or notification): show it.
          if (r.items.length < lastCount.current) {
            void queryClient.invalidateQueries({ queryKey: ["recordings"] });
            void queryClient.invalidateQueries({ queryKey: ["home"] });
          }
          lastCount.current = r.items.length;
          setNative(r.items);
        })
        .catch(() => undefined);
    void load();
    const unsubscribe = host.onQueueChanged(() => void load());
    const timer = window.setInterval(() => !document.hidden && void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [queryClient]);

  return hostRecorder ? native : web;
}

export const pendingActions = {
  uploadNow: () => (hostRecorder ? hostRecorder.retryUploads() : flushQueue()),
  retry: (id: string) => (hostRecorder ? hostRecorder.retryUploads() : retryPending(id)),
  remove: (id: string) => (hostRecorder ? hostRecorder.deletePending({ id }) : removePending(id)),
};

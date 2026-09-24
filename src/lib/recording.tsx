import { useQueryClient } from "@tanstack/react-query";
import { createContext, type MutableRefObject, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type CaptureController, captureSupported, createCapture } from "./capture";
import type { NativeState } from "./native";
import { isNativeApp } from "./platform";

export const WAVE_BARS = 48;

interface RecordingContextValue {
  state: NativeState;
  elapsed: number;
  busy: boolean;
  error: string | null;
  /** Briefly true after a recording is saved, for the confirmation toast. */
  justSaved: boolean;
  /** Recent input levels (0–1), newest last; read by the waveform on every frame. */
  levels: MutableRefObject<number[]>;
  supported: boolean;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  dismissError(): void;
}

const RecordingContext = createContext<RecordingContextValue | null>(null);

function micMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "NotAllowedError" || /permission/i.test(e?.message ?? "")) {
    return isNativeApp
      ? "Microphone access is off. Allow it for Voice Memo in Android settings."
      : "Microphone access was blocked. Allow it in your browser settings to record.";
  }
  return e?.message ?? "Recording failed";
}

/**
 * Owns the recorder for the whole app, so a recording keeps going while you move between tabs.
 * In the Android and Mac apps the native recorder does the recording; this mirrors its state.
 */
export function RecordingProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<CaptureController | null>(null);
  const animateRef = useRef<() => void>(() => undefined);
  const levels = useRef<number[]>(Array(WAVE_BARS).fill(0));
  const [state, setState] = useState<NativeState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    const controller = createCapture(() => {
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
      void queryClient.invalidateQueries({ queryKey: ["home"] });
    });
    controllerRef.current = controller;
    let frame = 0;
    let last = 0;
    const sample = () => {
      const snap = controller.snapshot();
      setState((prev) => (prev === snap.state ? prev : snap.state));
      if (snap.state !== "idle") {
        levels.current = [...levels.current.slice(1), snap.state === "recording" ? snap.level : 0];
        setElapsed(snap.elapsedSec);
      }
      return snap.state;
    };
    // Animates only while recording: the waveform is the only thing that needs every frame.
    const loop = (t: number) => {
      if (t - last > 70) {
        last = t;
        if (sample() === "idle") {
          frame = 0;
          return;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    const animate = () => {
      if (!frame) frame = requestAnimationFrame(loop);
    };
    animateRef.current = animate;
    // While idle, check twice a second for a recording started elsewhere (Mac menu bar, Android notification).
    const watch = window.setInterval(() => {
      if (!frame && controller.snapshot().state !== "idle") animate();
    }, 500);
    return () => {
      window.clearInterval(watch);
      cancelAnimationFrame(frame);
      animateRef.current = () => undefined;
      controller.dispose();
      controllerRef.current = null;
    };
  }, [queryClient]);

  const run = async (action: (c: CaptureController) => Promise<void>) => {
    const controller = controllerRef.current;
    if (!controller || busy) return;
    setError(null);
    setBusy(true);
    try {
      await action(controller);
    } catch (err) {
      setError(micMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const value: RecordingContextValue = {
    state,
    elapsed,
    busy,
    error,
    justSaved,
    levels,
    supported: captureSupported(),
    start: () =>
      void run(async (c) => {
        levels.current = Array(WAVE_BARS).fill(0);
        setElapsed(0);
        await c.start();
        setState("recording");
        animateRef.current();
      }),
    stop: () =>
      void run(async (c) => {
        await c.stop();
        setState("idle");
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 3000);
      }),
    pause: () => void run((c) => c.pause().then(() => setState("paused"))),
    resume: () =>
      void run(async (c) => {
        await c.resume();
        setState("recording");
        animateRef.current();
      }),
    cancel: () =>
      void run(async (c) => {
        await c.cancel();
        setState("idle");
      }),
    dismissError: () => setError(null),
  };

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error("useRecording must be used inside RecordingProvider");
  return ctx;
}

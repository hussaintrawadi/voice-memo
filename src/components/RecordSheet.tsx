import { AlertTriangle, CheckCircle2, Pause, Play, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatDuration } from "../lib/format";
import { isMacApp, isNativeApp } from "../lib/platform";
import { useRecording, WAVE_BARS } from "../lib/recording";

function Waveform({ paused }: { paused: boolean }) {
  const { levels } = useRecording();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    let color = "";
    // Levels change about 14 times a second, so drawing faster than that only burns battery.
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      if (t - last < 66) return;
      last = t;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        color = "";
      }
      if (!color) color = getComputedStyle(canvas).color;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      const gap = 3;
      const barWidth = (width - gap * (WAVE_BARS - 1)) / WAVE_BARS;
      levels.current.forEach((level, i) => {
        const h = Math.max(3, level * height);
        ctx.globalAlpha = paused ? 0.3 : 0.3 + (i / WAVE_BARS) * 0.7;
        ctx.beginPath();
        ctx.roundRect(i * (barWidth + gap), (height - h) / 2, barWidth, h, barWidth / 2);
        ctx.fill();
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levels, paused]);

  return <canvas ref={canvasRef} className="h-14 w-full text-accent" aria-hidden />;
}

/** Bottom sheet shown while recording: every control sits in thumb reach. */
export function RecordSheet() {
  const rec = useRecording();
  const active = rec.state !== "idle";

  if (!active) {
    if (rec.error) {
      return (
        <div className="fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4" role="alert">
          <div className="flex max-w-md items-start gap-2 rounded-2xl bg-danger px-4 py-3 text-sm text-white shadow-lg">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span className="flex-1">{rec.error}</span>
            <button type="button" onClick={rec.dismissError} aria-label="Dismiss">
              <X className="size-4" />
            </button>
          </div>
        </div>
      );
    }
    if (rec.justSaved) {
      return (
        <div className="fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4" role="status">
          <div className="flex items-center gap-2 rounded-full bg-ink px-4 py-2.5 text-sm text-bg shadow-lg">
            <CheckCircle2 className="size-4 text-ok" aria-hidden /> Saved. Transcribing in the background.
          </div>
        </div>
      );
    }
    return null;
  }

  const paused = rec.state === "paused";
  const discard = () => {
    if (rec.elapsed > 10 && !window.confirm("Discard this recording?")) return;
    rec.cancel();
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px]" aria-hidden />
      <section
        aria-label="Recording"
        className="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t border-line bg-surface px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 shadow-2xl"
      >
        <div className="mx-auto max-w-md">
          <div className="flex items-center justify-center gap-2 text-sm font-medium text-accent" aria-live="polite">
            <span className={`size-2 rounded-full bg-accent ${paused ? "opacity-40" : "animate-pulse"}`} />
            {paused ? "Paused" : "Recording"}
          </div>
          <div className="mt-1 text-center font-serif text-5xl tabular-nums tracking-tight">{formatDuration(rec.elapsed)}</div>
          <div className="mt-4">
            <Waveform paused={paused} />
          </div>
          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={discard}
              disabled={rec.busy}
              aria-label="Discard recording"
              className="grid size-14 place-items-center rounded-full bg-surface-2 text-muted"
            >
              <Trash2 className="size-5" />
            </button>
            <button
              type="button"
              onClick={rec.stop}
              disabled={rec.busy}
              aria-label="Stop and save"
              className="grid size-20 place-items-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 active:scale-95"
            >
              <Square className="size-7 fill-current" />
            </button>
            <button
              type="button"
              onClick={paused ? rec.resume : rec.pause}
              disabled={rec.busy}
              aria-label={paused ? "Resume" : "Pause"}
              className="grid size-14 place-items-center rounded-full bg-surface-2 text-ink"
            >
              {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
            </button>
          </div>
          <p className="mt-4 text-center text-xs text-muted">
            {isNativeApp
              ? "Keeps recording with the screen off. Stop from here or the notification."
              : isMacApp
                ? "Keeps recording if you close this window. Stop from here, the menu bar or ⌃⌥⌘R."
                : "Keep this page open while recording."}
          </p>
        </div>
      </section>
    </>
  );
}

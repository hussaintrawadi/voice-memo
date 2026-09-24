import { Pause, Play } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { formatDuration } from "../lib/format";

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

export function AudioPlayer({
  src,
  audioRef,
  fallbackDuration,
  onTime,
}: {
  src: string;
  audioRef: RefObject<HTMLAudioElement | null>;
  fallbackDuration: number | null;
  onTime: (seconds: number) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      setTime(audio.currentTime);
      onTime(audio.currentTime);
    };
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : null);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
    };
  }, [audioRef, onTime]);

  const total = duration ?? fallbackDuration ?? 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        onClick={toggle}
        disabled={error}
        aria-label={playing ? "Pause" : "Play"}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-brand text-bg disabled:opacity-40"
      >
        {playing ? <Pause className="size-5 fill-current" /> : <Play className="ml-0.5 size-5 fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={total || 1}
          step={0.1}
          value={Math.min(time, total || 1)}
          onChange={(e) => {
            if (audioRef.current) audioRef.current.currentTime = Number(e.target.value);
          }}
          aria-label="Seek"
          className="w-full accent-[var(--brand)]"
        />
        <div className="flex justify-between text-xs tabular-nums text-muted">
          <span>{formatDuration(time)}</span>
          <span>{error ? "Audio unavailable" : formatDuration(total)}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={cycleSpeed}
        aria-label="Playback speed"
        className="h-8 w-12 shrink-0 rounded-full bg-surface-2 text-xs font-semibold tabular-nums"
      >
        {speed}×
      </button>
    </div>
  );
}

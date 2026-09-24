/** Long recordings are cut into parts so each upload and transcription stays small. */
export const MAX_PART_SECONDS = 30 * 60;
const BITRATE = 24_000;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm",
];

export interface RecordedPart {
  id: string;
  audio: ArrayBuffer;
  mime: string;
  durationSec: number;
  recordedAt: number;
  partOf: string;
  partIndex: number;
  /** Loudest moment of this part, 0–1 (lets the server skip silent recordings). */
  peak: number;
}

export type RecorderState = "idle" | "recording" | "paused";

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function pickMime(): string | undefined {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Wraps MediaRecorder with pause-aware timing, a level meter for the waveform,
 * a screen wake lock, and automatic rollover into a new part every 30 minutes.
 */
export class VoiceRecorder {
  state: RecorderState = "idle";
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private groupId = "";
  private partIndex = 0;
  private partStartedAt = 0;
  private accumulatedMs = 0;
  private spanStart = 0;
  private rolling = false;
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;
  private peak = 0;
  private peakTimer: number | null = null;

  constructor(private readonly onPart: (part: RecordedPart) => void | Promise<void>) {}

  async start() {
    if (this.state !== "idle") return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.context = new AudioContext();
    await this.context.resume();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);
    this.levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));

    this.groupId = crypto.randomUUID();
    this.partIndex = 0;
    this.beginPart();
    this.state = "recording";
    // Sampled independently of the UI so the peak is right even if nothing is drawing.
    this.peakTimer = window.setInterval(() => this.samplePeak(), 100);
    await this.acquireWakeLock();
  }

  pause() {
    if (this.state !== "recording" || !this.recorder) return;
    this.recorder.pause();
    this.accumulatedMs += performance.now() - this.spanStart;
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused" || !this.recorder) return;
    this.recorder.resume();
    this.spanStart = performance.now();
    this.state = "recording";
    void this.acquireWakeLock();
  }

  /** Seconds recorded in the current part. */
  partSeconds(): number {
    const running = this.state === "recording" ? performance.now() - this.spanStart : 0;
    return (this.accumulatedMs + running) / 1000;
  }

  /** Seconds across all parts of this session. */
  totalSeconds(): number {
    return this.partIndex * MAX_PART_SECONDS + this.partSeconds();
  }

  /** Current input level between 0 and 1. Also drives the 30-minute rollover. */
  level(): number {
    if (this.state === "recording" && !this.rolling && this.partSeconds() >= MAX_PART_SECONDS) {
      void this.rollover();
    }
    if (!this.analyser || !this.levelBuffer || this.state !== "recording") return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) {
      const centered = (v - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 3.2);
  }

  async stop(): Promise<void> {
    if (this.state === "idle") return;
    if (this.state === "recording") this.accumulatedMs += performance.now() - this.spanStart;
    const part = await this.finishPart();
    this.teardown();
    if (part) await this.onPart(part);
  }

  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.chunks = [];
    this.teardown();
  }

  private samplePeak() {
    if (!this.analyser || !this.levelBuffer || this.state !== "recording") return;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    for (const v of this.levelBuffer) {
      const amplitude = Math.abs(v - 128) / 128;
      if (amplitude > this.peak) this.peak = amplitude;
    }
  }

  private beginPart() {
    if (!this.stream) throw new Error("Microphone is not open");
    const mimeType = pickMime();
    this.recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: BITRATE,
    });
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // Collect data every few seconds so a crash loses little.
    this.recorder.start(5000);
    this.partStartedAt = Date.now();
    this.accumulatedMs = 0;
    this.peak = 0;
    this.spanStart = performance.now();
  }

  private finishPart(): Promise<RecordedPart | null> {
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = async () => {
        const mime = (recorder.mimeType || this.chunks[0]?.type || "audio/webm").split(";")[0];
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        if (blob.size === 0) return resolve(null);
        resolve({
          id: crypto.randomUUID(),
          audio: await blob.arrayBuffer(),
          mime,
          durationSec: Math.round(this.accumulatedMs / 100) / 10,
          recordedAt: this.partStartedAt,
          partOf: this.groupId,
          partIndex: this.partIndex,
          peak: Math.round(this.peak * 10_000) / 10_000,
        });
      };
      if (recorder.state !== "inactive") recorder.stop();
      else recorder.onstop?.(new Event("stop"));
    });
  }

  private async rollover() {
    this.rolling = true;
    try {
      this.accumulatedMs += performance.now() - this.spanStart;
      const part = await this.finishPart();
      this.partIndex += 1;
      this.beginPart();
      if (part) await this.onPart(part);
    } finally {
      this.rolling = false;
    }
  }

  private async acquireWakeLock() {
    try {
      if ("wakeLock" in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
      }
    } catch {
      // Not available (e.g. low battery); recording still works while the screen is on.
    }
  }

  private teardown() {
    if (this.peakTimer !== null) window.clearInterval(this.peakTimer);
    this.peakTimer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
    void this.wakeLock?.release();
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.recorder = null;
    this.wakeLock = null;
    this.state = "idle";
  }
}

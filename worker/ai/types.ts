export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeInput {
  audio: ArrayBuffer;
  mime: string;
  filename: string;
  durationSec?: number;
  /** Names and jargon that help the model spell things right. */
  vocabulary: string[];
  /** ISO-639-1 code, or undefined for auto-detect. */
  language?: string;
}

export interface Transcript {
  text: string;
  segments: Segment[];
  language?: string;
  durationSec?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** When set, the provider is asked for JSON that matches this schema. */
  json?: { name: string; schema: Record<string, unknown> };
  maxTokens: number;
  temperature: number;
  effort: "low" | "medium" | "high";
}

export interface CompletionResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Daily ceilings the router enforces (at 90%) before calling a provider. */
export interface Quota {
  requestsPerDay?: number;
  tokensPerDay?: number;
  audioSecondsPerDay?: number;
  /** Provider-specific cost units per UTC day (Workers AI neurons). */
  costUnitsPerDay?: number;
  /** Lifetime cost-unit budget for one-time credits (micro-USD). */
  costUnitsLifetime?: number;
  /** Quota is shared by every model of this provider rather than per model. */
  sharedAcrossModels?: boolean;
}

export interface SttProvider {
  id: string;
  model: string;
  maxBytes: number;
  quota: Quota;
  /** Estimated cost units for a transcription of this length. */
  costUnits(durationSec: number): number;
  isConfigured(env: Env): boolean;
  transcribe(env: Env, input: TranscribeInput): Promise<Transcript>;
}

export interface LlmProvider {
  id: string;
  model: string;
  /** Largest prompt+completion we send in one request (per-minute token caps). */
  maxRequestTokens: number;
  quota: Quota;
  costUnits(inputTokens: number, outputTokens: number): number;
  isConfigured(env: Env): boolean;
  complete(env: Env, req: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** How long to leave this provider alone. */
    readonly cooldownMs = 30_000,
    /** False when retrying this provider with the same input can't help (bad request). */
    readonly retryable = true,
  ) {
    super(message);
  }
}

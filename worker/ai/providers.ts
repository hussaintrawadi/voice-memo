import { dropHallucinations, type ScoredSegment } from "../lib/text";
import { extensionForMime, msUntilNextUtcDay, stripThinking } from "../lib/util";
import {
  type CompletionRequest,
  type CompletionResponse,
  type LlmProvider,
  ProviderError,
  type Segment,
  type SttProvider,
  type Transcript,
} from "./types";

const TIMEOUT_MS = 110_000;

async function request(provider: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderError(`${provider}: network error (${String(err)})`, undefined, 30_000);
  }
  if (res.ok) return res;

  const body = (await res.text()).slice(0, 400);
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.status === 429) {
    const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
    throw new ProviderError(`${provider}: rate limited (${body})`, 429, ms);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError(`${provider}: key rejected (${res.status})`, res.status, 6 * 3600_000, false);
  }
  if (res.status === 402) {
    throw new ProviderError(`${provider}: credit exhausted`, 402, 24 * 3600_000, false);
  }
  if (res.status >= 500) {
    throw new ProviderError(`${provider}: server error ${res.status} (${body})`, res.status, 60_000);
  }
  throw new ProviderError(`${provider}: request rejected ${res.status} (${body})`, res.status, 0, false);
}

/** Whisper's prompt is capped at ~224 tokens; keep it to a comma list of known terms. */
function whisperPrompt(vocabulary: string[]): string | undefined {
  if (vocabulary.length === 0) return undefined;
  let prompt = "";
  for (const term of vocabulary) {
    const next = prompt ? `${prompt}, ${term}` : term;
    if (next.length > 600) break;
    prompt = next;
  }
  return prompt;
}

function cleanSegments(segments: ScoredSegment[] | undefined): Segment[] {
  return dropHallucinations(segments ?? [])
    .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
}

/** Whisper responses: rebuild the text from the segments that survived filtering. */
function whisperResult(
  text: string,
  segments: ScoredSegment[] | undefined,
  language: string | undefined,
  durationSec: number | undefined,
): Transcript {
  const kept = cleanSegments(segments);
  return {
    text: segments?.length ? kept.map((s) => s.text).join(" ") : text.trim(),
    segments: kept,
    language,
    durationSec,
  };
}

// ── Speech-to-text ──────────────────────────────────────────────────────────

function groqWhisper(model: string): SttProvider {
  return {
    id: "groq",
    model,
    maxBytes: 24 * 1024 * 1024,
    quota: { requestsPerDay: 2000, audioSecondsPerDay: 28_800 },
    costUnits: () => 0,
    isConfigured: (env) => Boolean(env.GROQ_API_KEY),
    async transcribe(env, input): Promise<Transcript> {
      const form = new FormData();
      const name = `${input.filename}.${extensionForMime(input.mime)}`;
      form.append("file", new File([input.audio], name, { type: input.mime }));
      form.append("model", model);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("temperature", "0");
      const prompt = whisperPrompt(input.vocabulary);
      if (prompt) form.append("prompt", prompt);
      if (input.language) form.append("language", input.language);

      const res = await request("groq", "https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: form,
      });
      const data = (await res.json()) as {
        text: string;
        language?: string;
        duration?: number;
        segments?: ScoredSegment[];
      };
      return whisperResult(data.text, data.segments, data.language, data.duration);
    },
  };
}

const workersAiWhisper: SttProvider = {
  id: "workers-ai",
  model: "@cf/openai/whisper-large-v3-turbo",
  maxBytes: 20 * 1024 * 1024,
  quota: { costUnitsPerDay: 6000, sharedAcrossModels: true },
  // 46.63 neurons per audio minute
  costUnits: (durationSec) => Math.ceil((durationSec / 60) * 46.63),
  isConfigured: () => true,
  async transcribe(env, input): Promise<Transcript> {
    const stream = new Blob([input.audio], { type: input.mime }).stream();
    const out = await runWorkersAi(env, "@cf/openai/whisper-large-v3-turbo", {
      audio: { body: stream, contentType: input.mime },
      task: "transcribe",
      vad_filter: true,
      ...(input.language ? { language: input.language } : {}),
      ...(whisperPrompt(input.vocabulary) ? { initial_prompt: whisperPrompt(input.vocabulary) } : {}),
    });
    const data = out as {
      text: string;
      segments?: ScoredSegment[];
      transcription_info?: { language?: string; duration?: number };
    };
    return whisperResult(data.text, data.segments, data.transcription_info?.language, data.transcription_info?.duration);
  },
};

const deepgramNova3: SttProvider = {
  id: "deepgram",
  model: "nova-3-multi",
  maxBytes: 100 * 1024 * 1024,
  // $200 one-time credit; stop at $180. Opting out of training doubles the rate to ~$0.0104/min.
  quota: { costUnitsLifetime: 180_000_000, sharedAcrossModels: true },
  costUnits: (durationSec) => Math.ceil((durationSec / 60) * 10_400),
  isConfigured: (env) => Boolean(env.DEEPGRAM_API_KEY),
  async transcribe(env, input): Promise<Transcript> {
    const params = new URLSearchParams({
      model: "nova-3",
      language: input.language ?? "multi",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      mip_opt_out: "true",
    });
    for (const term of input.vocabulary.slice(0, 50)) params.append("keyterm", term);

    const res = await request("deepgram", `https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, "Content-Type": input.mime },
      body: input.audio,
    });
    const data = (await res.json()) as {
      metadata?: { duration?: number };
      results: {
        channels: { detected_language?: string; alternatives: { transcript: string }[] }[];
        utterances?: { start: number; end: number; transcript: string }[];
      };
    };
    const channel = data.results.channels[0];
    return {
      text: channel?.alternatives[0]?.transcript.trim() ?? "",
      segments: cleanSegments(
        data.results.utterances?.map((u) => ({ start: u.start, end: u.end, text: u.transcript })),
      ),
      language: channel?.detected_language,
      durationSec: data.metadata?.duration,
    };
  },
};

export const STT_PROVIDERS: SttProvider[] = [groqWhisper("whisper-large-v3"), workersAiWhisper, deepgramNova3];

// ── LLMs ────────────────────────────────────────────────────────────────────

interface OpenAiChatResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function readChat(provider: string, data: OpenAiChatResponse): CompletionResponse {
  const text = stripThinking(data.choices?.[0]?.message?.content ?? "");
  if (!text) throw new ProviderError(`${provider}: empty completion`, undefined, 10_000);
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

function groqChat(model: string): LlmProvider {
  const isGptOss = model.startsWith("openai/gpt-oss");
  return {
    id: "groq",
    model,
    // Free tier: 8K tokens per minute per model.
    maxRequestTokens: 7_500,
    quota: { requestsPerDay: 1000, tokensPerDay: 200_000 },
    costUnits: () => 0,
    isConfigured: (env) => Boolean(env.GROQ_API_KEY),
    async complete(env, req: CompletionRequest) {
      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
        max_completion_tokens: req.maxTokens,
        temperature: req.temperature,
      };
      if (isGptOss) {
        body.reasoning_effort = req.effort;
        body.include_reasoning = false;
      } else {
        body.reasoning_format = "hidden";
      }
      if (req.json) {
        body.response_format = isGptOss
          ? { type: "json_schema", json_schema: { name: req.json.name, schema: req.json.schema, strict: true } }
          : { type: "json_object" };
      }
      const res = await request("groq", "https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return readChat("groq", (await res.json()) as OpenAiChatResponse);
    },
  };
}

const workersAiQwen: LlmProvider = {
  id: "workers-ai",
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
  maxRequestTokens: 24_000,
  quota: { costUnitsPerDay: 6000, sharedAcrossModels: true },
  costUnits: (input, output) => Math.ceil((input * 4625 + output * 30475) / 1_000_000),
  isConfigured: () => true,
  async complete(env, req) {
    // Qwen3's soft switch to skip the thinking phase.
    const messages = req.messages.map((m, i) =>
      i === req.messages.length - 1 && m.role === "user" ? { ...m, content: `${m.content}\n\n/no_think` } : m,
    );
    const out = await runWorkersAi(env, "@cf/qwen/qwen3-30b-a3b-fp8", {
      messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...(req.json ? { response_format: { type: "json_schema", json_schema: req.json.schema } } : {}),
    });
    const data = out as OpenAiChatResponse & { response?: unknown };
    if (data.response !== undefined && data.response !== null) {
      const text = typeof data.response === "string" ? data.response : JSON.stringify(data.response);
      return {
        text: stripThinking(text),
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    }
    return readChat("workers-ai", data);
  },
};

/** Mistral's free plan: ministral-14b is included (mistral-small/medium/large are not). */
const mistralFree: LlmProvider = {
  id: "mistral",
  model: "ministral-14b-latest",
  maxRequestTokens: 30_000,
  // Free plan: 0.5 requests/second; the $10 monthly allowance is far above backup use.
  quota: { requestsPerDay: 2000 },
  costUnits: () => 0,
  isConfigured: (env) => Boolean(env.MISTRAL_API_KEY),
  async complete(env, req) {
    const res = await request("mistral", "https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.MISTRAL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ministral-14b-latest",
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...(req.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    return readChat("mistral", (await res.json()) as OpenAiChatResponse);
  },
};

export const LLM_PROVIDERS: LlmProvider[] = [
  groqChat("openai/gpt-oss-120b"),
  groqChat("qwen/qwen3.8-27b"),
  groqChat("openai/gpt-oss-20b"),
  workersAiQwen,
  mistralFree,
];

// ── Workers AI helpers ──────────────────────────────────────────────────────

/** Calls a Workers AI model and maps platform errors onto ProviderError. */
export async function runWorkersAi(env: Env, model: string, inputs: Record<string, unknown>): Promise<unknown> {
  try {
    // Model ids are validated against the catalog at runtime; the typed overloads lag new models.
    return await (env.AI as unknown as { run(m: string, i: unknown): Promise<unknown> }).run(model, inputs);
  } catch (err) {
    const message = String(err);
    if (/4006|daily free allocation|neurons/i.test(message)) {
      throw new ProviderError(`workers-ai: daily allocation used up`, 429, msUntilNextUtcDay());
    }
    if (/3036|capacity|3040|timeout/i.test(message)) {
      throw new ProviderError(`workers-ai: busy (${message})`, 503, 60_000);
    }
    throw new ProviderError(`workers-ai: ${message}`, undefined, 30_000);
  }
}

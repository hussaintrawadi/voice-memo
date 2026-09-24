import { z } from "zod";
import { errorMessage, estimateTokens, now, parseModelJson, utcDay } from "../lib/util";
import { LLM_PROVIDERS, STT_PROVIDERS } from "./providers";
import {
  type ChatMessage,
  type LlmProvider,
  ProviderError,
  type Quota,
  type SttProvider,
  type Transcript,
  type TranscribeInput,
} from "./types";

/** Leave 10% of every free allowance untouched. */
const SAFETY = 0.9;

export interface Routed<T> {
  data: T;
  provider: string;
  model: string;
}

export class AllProvidersFailed extends Error {
  constructor(
    kind: string,
    readonly attempts: string[],
  ) {
    super(`No ${kind} provider could handle this right now: ${attempts.join(" | ")}`);
  }
}

// ── Config (D1 app_config) ──────────────────────────────────────────────────

interface RouterConfig {
  disabled: string[]; // "provider" or "provider:model"
}

async function loadConfig(env: Env): Promise<RouterConfig> {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'router'").first<{ value: string }>();
  if (!row) return { disabled: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<RouterConfig>;
    return { disabled: parsed.disabled ?? [] };
  } catch {
    return { disabled: [] };
  }
}

const isDisabled = (cfg: RouterConfig, p: { id: string; model: string }) =>
  cfg.disabled.includes(p.id) || cfg.disabled.includes(`${p.id}:${p.model}`);

// ── Usage + cooldown bookkeeping ────────────────────────────────────────────

const stateKey = (p: { id: string; model: string }) => `${p.id}:${p.model}`;

async function coolingDown(env: Env, p: { id: string; model: string }): Promise<boolean> {
  const row = await env.DB.prepare("SELECT cooldown_until FROM provider_state WHERE provider = ?")
    .bind(stateKey(p))
    .first<{ cooldown_until: number }>();
  return Boolean(row && row.cooldown_until > now());
}

async function setCooldown(env: Env, p: { id: string; model: string }, err: unknown) {
  const cooldownMs = err instanceof ProviderError ? err.cooldownMs : 30_000;
  await env.DB.prepare(
    `INSERT INTO provider_state (provider, cooldown_until, last_error, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(provider) DO UPDATE SET cooldown_until = ?2, last_error = ?3, updated_at = ?4`,
  )
    .bind(stateKey(p), now() + cooldownMs, errorMessage(err).slice(0, 500), now())
    .run();
}

interface UsageDelta {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  errors?: number;
  costUnits?: number;
}

export async function recordUsage(env: Env, p: { id: string; model: string }, d: UsageDelta) {
  await env.DB.prepare(
    `INSERT INTO provider_usage (day, provider, model, requests, input_tokens, output_tokens, audio_seconds, errors, cost_units)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(day, provider, model) DO UPDATE SET
       requests = requests + ?4, input_tokens = input_tokens + ?5, output_tokens = output_tokens + ?6,
       audio_seconds = audio_seconds + ?7, errors = errors + ?8, cost_units = cost_units + ?9`,
  )
    .bind(
      utcDay(),
      p.id,
      p.model,
      d.requests ?? 0,
      d.inputTokens ?? 0,
      d.outputTokens ?? 0,
      d.audioSeconds ?? 0,
      d.errors ?? 0,
      d.costUnits ?? 0,
    )
    .run();
}

interface UsageTotals {
  requests: number;
  tokens: number;
  audio_seconds: number;
  cost_units: number;
}

async function usageFor(env: Env, p: { id: string; model: string }, quota: Quota): Promise<UsageTotals> {
  const where = ["provider = ?"];
  const params: string[] = [p.id];
  // One-time credits are tracked over all time; everything else resets daily.
  if (!quota.costUnitsLifetime) {
    where.push("day = ?");
    params.push(utcDay());
  }
  if (!quota.sharedAcrossModels) {
    where.push("model = ?");
    params.push(p.model);
  }
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(requests),0) AS requests,
            COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
            COALESCE(SUM(audio_seconds),0) AS audio_seconds,
            COALESCE(SUM(cost_units),0) AS cost_units
     FROM provider_usage WHERE ${where.join(" AND ")}`,
  )
    .bind(...params)
    .first<UsageTotals>();
  return row ?? { requests: 0, tokens: 0, audio_seconds: 0, cost_units: 0 };
}

function withinQuota(quota: Quota, used: UsageTotals, next: { tokens?: number; audioSeconds?: number; costUnits?: number }) {
  const ok = (limit: number | undefined, current: number, add = 0) =>
    limit === undefined || current + add <= limit * SAFETY;
  return (
    ok(quota.requestsPerDay, used.requests, 1) &&
    ok(quota.tokensPerDay, used.tokens, next.tokens) &&
    ok(quota.audioSecondsPerDay, used.audio_seconds, next.audioSeconds) &&
    ok(quota.costUnitsPerDay, used.cost_units, next.costUnits) &&
    ok(quota.costUnitsLifetime, used.cost_units, next.costUnits)
  );
}

// ── Speech-to-text ──────────────────────────────────────────────────────────

export async function transcribe(env: Env, input: TranscribeInput): Promise<Routed<Transcript>> {
  const cfg = await loadConfig(env);
  const attempts: string[] = [];
  const duration = input.durationSec ?? 0;

  for (const p of STT_PROVIDERS) {
    const label = stateKey(p);
    if (!p.isConfigured(env) || isDisabled(cfg, p)) continue;
    if (input.audio.byteLength > p.maxBytes) {
      attempts.push(`${label}: file too large`);
      continue;
    }
    if (await coolingDown(env, p)) {
      attempts.push(`${label}: cooling down`);
      continue;
    }
    const used = await usageFor(env, p, p.quota);
    if (!withinQuota(p.quota, used, { audioSeconds: duration, costUnits: p.costUnits(duration) })) {
      attempts.push(`${label}: daily allowance reached`);
      continue;
    }

    try {
      const result = await p.transcribe(env, input);
      const seconds = result.durationSec ?? duration;
      await recordUsage(env, p, { requests: 1, audioSeconds: seconds, costUnits: p.costUnits(seconds) });
      // An empty transcript is a valid answer (silence), not a provider failure.
      return { data: result, provider: p.id, model: p.model };
    } catch (err) {
      attempts.push(errorMessage(err));
      await recordUsage(env, p, { errors: 1 });
      if (!(err instanceof ProviderError) || err.cooldownMs > 0) await setCooldown(env, p, err);
    }
  }
  throw new AllProvidersFailed("speech-to-text", attempts);
}

// ── LLM completions ─────────────────────────────────────────────────────────

export interface CompleteOptions<S extends z.ZodType | undefined> {
  system: string;
  user: string;
  /** Validate the reply as JSON against this schema. */
  schema?: S;
  /** Name for the JSON Schema sent to providers that support constrained decoding. */
  schemaName?: string;
  maxTokens: number;
  temperature?: number;
  effort?: "low" | "medium" | "high";
  /** Extra check for plain-text replies; return an error message to reject. */
  check?: (text: string) => string | null;
}

type Output<S> = S extends z.ZodType ? z.infer<S> : string;

export async function complete<S extends z.ZodType | undefined = undefined>(
  env: Env,
  opts: CompleteOptions<S>,
): Promise<Routed<Output<S>>> {
  const cfg = await loadConfig(env);
  const attempts: string[] = [];
  const promptTokens = estimateTokens(opts.system) + estimateTokens(opts.user);
  const requestTokens = promptTokens + opts.maxTokens;

  for (const p of LLM_PROVIDERS) {
    const label = stateKey(p);
    if (!p.isConfigured(env) || isDisabled(cfg, p)) continue;
    if (requestTokens > p.maxRequestTokens) {
      attempts.push(`${label}: prompt too large`);
      continue;
    }
    if (await coolingDown(env, p)) {
      attempts.push(`${label}: cooling down`);
      continue;
    }
    const used = await usageFor(env, p, p.quota);
    if (!withinQuota(p.quota, used, { tokens: requestTokens, costUnits: p.costUnits(promptTokens, opts.maxTokens) })) {
      attempts.push(`${label}: daily allowance reached`);
      continue;
    }

    try {
      const data = await completeWith(env, p, opts);
      return { data: data as Output<S>, provider: p.id, model: p.model };
    } catch (err) {
      attempts.push(`${label}: ${errorMessage(err)}`);
      if (err instanceof ProviderError) {
        await recordUsage(env, p, { errors: 1 });
        if (err.cooldownMs > 0) await setCooldown(env, p, err);
      }
    }
  }
  throw new AllProvidersFailed("language model", attempts);
}

async function completeWith<S extends z.ZodType | undefined>(
  env: Env,
  p: LlmProvider,
  opts: CompleteOptions<S>,
): Promise<unknown> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const json = opts.schema ? { name: opts.schemaName ?? "result", schema: toJsonSchema(opts.schema) } : undefined;
  const call = async (msgs: ChatMessage[]) => {
    const res = await p.complete(env, {
      messages: msgs,
      json,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.2,
      effort: opts.effort ?? "low",
    });
    await recordUsage(env, p, {
      requests: 1,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUnits: p.costUnits(res.inputTokens, res.outputTokens),
    });
    return res.text;
  };

  const first = await call(messages);
  const problem = validate(first, opts);
  if (problem.ok) return problem.value;

  // One repair round on the same provider before moving on.
  const repaired = await call([
    ...messages,
    { role: "assistant", content: first },
    {
      role: "user",
      content: `Your reply was not acceptable: ${problem.error}. Reply again with only the corrected ${
        opts.schema ? "JSON object" : "text"
      }.`,
    },
  ]);
  const second = validate(repaired, opts);
  if (second.ok) return second.value;
  throw new Error(`invalid output after repair (${second.error})`);
}

/** JSON Schema for constrained decoding; schemas use strictObject so every key is required. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

type Validation = { ok: true; value: unknown } | { ok: false; error: string };

function validate(text: string, opts: CompleteOptions<z.ZodType | undefined>): Validation {
  if (opts.schema) {
    let parsed: unknown;
    try {
      parsed = parseModelJson(text);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    const result = opts.schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `JSON did not match the schema: ${issues}` };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty reply" };
  const error = opts.check?.(trimmed);
  return error ? { ok: false, error } : { ok: true, value: trimmed };
}

// ── Status for the settings page ────────────────────────────────────────────

export async function providerStatus(env: Env) {
  const cfg = await loadConfig(env);
  const describe = async (p: SttProvider | LlmProvider, kind: "speech" | "llm") => {
    const used = await usageFor(env, p, p.quota);
    const state = await env.DB.prepare("SELECT cooldown_until, last_error FROM provider_state WHERE provider = ?")
      .bind(stateKey(p))
      .first<{ cooldown_until: number; last_error: string | null }>();
    return {
      kind,
      provider: p.id,
      model: p.model,
      configured: p.isConfigured(env),
      enabled: !isDisabled(cfg, p),
      coolingDownUntil: state && state.cooldown_until > now() ? state.cooldown_until : null,
      lastError: state?.last_error ?? null,
      usedToday: used,
      quota: p.quota,
    };
  };
  return Promise.all([
    ...STT_PROVIDERS.map((p) => describe(p, "speech")),
    ...LLM_PROVIDERS.map((p) => describe(p, "llm")),
  ]);
}

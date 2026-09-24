import { estimateTokens, truncateAndNormalize } from "../lib/util";
import { runWorkersAi } from "./providers";
import { recordUsage } from "./router";

export const EMBED_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
/** Must match the Vectorize index. Qwen3-embedding is Matryoshka-trained, so prefixes stay meaningful. */
export const EMBED_DIMS = 384;
const BATCH = 32;
const QUERY_INSTRUCTION = "Given a question or search phrase, retrieve the user's own voice-note thoughts that answer it";

/**
 * Embeds texts with the single embedding model the index was built with.
 * There is deliberately no fallback model: mixing models would corrupt search.
 */
export async function embed(env: Env, texts: string[], kind: "document" | "query"): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH).map((t) => t.slice(0, 8000));
    const inputs =
      kind === "query" ? { queries: batch, instruction: QUERY_INSTRUCTION } : { documents: batch };
    const out = (await runWorkersAi(env, EMBED_MODEL, inputs)) as { data: number[][] };
    const tokens = batch.reduce((sum, t) => sum + estimateTokens(t), 0);
    await recordUsage(env, { id: "workers-ai", model: EMBED_MODEL }, {
      requests: 1,
      inputTokens: tokens,
      costUnits: Math.ceil((tokens * 1075) / 1_000_000),
    });
    for (const v of out.data) vectors.push(truncateAndNormalize(v, EMBED_DIMS));
  }
  return vectors;
}

/**
 * Live smoke test of the analysis prompt against each configured Groq model.
 * Run: set -a; . ./.dev.vars; set +a; npx -y tsx eval/scripts/llm-smoke.ts
 */
import { LLM_PROVIDERS } from "../../worker/ai/providers";
import { toJsonSchema } from "../../worker/ai/router";
import { parseModelJson } from "../../worker/lib/util";
import {
  cleanSystemPrompt,
  UnderstandSchema,
  understandSystemPrompt,
  understandUserPrompt,
} from "../../worker/pipeline/prompts";

const transcript =
  "Umm so I was thinking about Lumina again, the onboarding is still like too manual yaar. " +
  "What if restaurants could just upload a photo of their menu and we extract everything automatically? " +
  "Also I need to call Priya tomorrow about the pricing. And I've decided we're going with Cloudflare for the voice app backend. " +
  "I still don't know if we should do usage based pricing or fixed plans for Lumina.";

const env = { GROQ_API_KEY: process.env.GROQ_API_KEY, MISTRAL_API_KEY: process.env.MISTRAL_API_KEY } as unknown as Env;

for (const provider of LLM_PROVIDERS.filter((p) => p.id === "groq")) {
  const started = Date.now();
  try {
    const res = await provider.complete(env, {
      messages: [
        { role: "system", content: understandSystemPrompt() },
        {
          role: "user",
          content: understandUserPrompt({
            transcript,
            recordedAt: { date: "2026-09-17", weekday: "Thursday", time: "10:30" },
            timezone: "Asia/Kolkata",
            projects: ["Lumina"],
            vocabulary: ["Lumina", "Priya"],
          }),
        },
      ],
      json: { name: "memo_understanding", schema: toJsonSchema(UnderstandSchema) },
      maxTokens: 3000,
      temperature: 0.1,
      effort: "low",
    });
    const parsed = UnderstandSchema.safeParse(parseModelJson(res.text));
    console.log(`\n== ${provider.model} (${Date.now() - started} ms, ${res.inputTokens}+${res.outputTokens} tokens)`);
    if (!parsed.success) {
      console.log("SCHEMA MISMATCH", parsed.error.issues.slice(0, 3));
      continue;
    }
    const u = parsed.data;
    console.log("title:", u.title, "| category:", u.category, "| language:", u.language);
    console.log("thoughts:", u.thoughts.map((t) => `${t.type}:${t.title}${t.project ? ` [${t.project}]` : ""}`));
    console.log("tasks:", u.tasks);
    console.log("decisions:", u.decisions.map((d) => d.statement));
    console.log("questions:", u.questions.map((q) => q.question));
  } catch (err) {
    console.log(`\n== ${provider.model} FAILED:`, String(err));
  }
}

const clean = await LLM_PROVIDERS[0].complete(env, {
  messages: [
    { role: "system", content: cleanSystemPrompt(["Lumina", "Priya"]) },
    { role: "user", content: transcript },
  ],
  maxTokens: 600,
  temperature: 0,
  effort: "low",
});
console.log("\n== cleaned:\n" + clean.text);

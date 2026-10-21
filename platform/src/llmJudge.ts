// ============================================================================
// llmJudge.ts — the REAL judge (temperature 0), for when a provider key is set.
//
// It asks a model to propose verdicts + verbatim quotes. It does NOT decide
// credit — runJudge() in judge.ts still verifies every quote against the source
// and discards any that don't anchor. So swapping the mock for this changes who
// PROPOSES verdicts, never how credit is AWARDED. That is what keeps a real,
// non-deterministic model trustworthy as a grader.
// ============================================================================
import type { JudgeSpec, JudgeVerdict } from "./types.ts";
import type { JudgeClient } from "./judge.ts";
import { requireKey } from "./env.ts";
import { resolveJudgeModel } from "./judgeConfig.ts";

type Provider = "openai" | "anthropic";

// One JSON-only call to the model. Returns parsed JSON or throws.
async function ask(provider: Provider, model: string, system: string, user: string): Promise<any> {
  if (provider === "openai") {
    const key = requireKey("OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI judge ${res.status}: ${await res.text()}`);
    return JSON.parse((await res.json()).choices[0].message.content);
  }
  const key = requireKey("ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 1024, temperature: 0,
      system: system + " Reply with ONLY a JSON object, no prose.",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic judge ${res.status}: ${await res.text()}`);
  const text = (await res.json()).content.map((b: any) => b.text ?? "").join("");
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
}

// The judge client makes its calls lazily & synchronously-cached per case is not
// needed here; run.ts calls per case. We pre-fetch verdicts once and memoize.
export function makeLlmJudge(provider: Provider, modelOverride?: string): JudgeClient {
  // NOTE: the JudgeClient interface is synchronous, so we do the (async) model
  // calls here via a tiny cache keyed by the produced text. runJudge is called
  // right after warm(), which fills the cache.
  const cache = new Map<string, { coverage: JudgeVerdict[]; support: JudgeVerdict[]; grammar: JudgeVerdict[] }>();

  async function warm(spec: JudgeSpec, produced: string, transcript: string): Promise<void> {
    const sys = "You are a strict evaluator. For every positive judgement you MUST include a `quote` copied VERBATIM from the stated source. If you cannot quote it, mark it negative.";
    const facts = spec.facts.map((f) => `- ${f.id}: ${f.text}`).join("\n");
    const user =
      `TRANSCRIPT:\n${transcript}\n\nAGENT OUTPUT:\n${produced}\n\n` +
      `Return JSON: {\n` +
      ` "coverage": [{"id","positive","quote"}]  // for each required fact, is it present in AGENT OUTPUT? quote from AGENT OUTPUT.\n` +
      ` "support": [{"id","positive","quote"}]    // for each claim the AGENT OUTPUT makes, is it grounded in the TRANSCRIPT? quote from TRANSCRIPT.\n` +
      (spec.checkGrammar ? ` "grammar": [{"id","positive","quote"}]   // list ONLY ungrammatical sentences; quote each from AGENT OUTPUT.\n` : "") +
      `}\nRequired facts:\n${facts}`;
    const j = await ask(provider, resolveJudgeModel(provider, modelOverride), sys, user);
    cache.set(produced, {
      coverage: (j.coverage ?? []).map((v: any) => ({ kind: "coverage", ...v })),
      support: (j.support ?? []).map((v: any, i: number) => ({ kind: "support", id: v.id ?? `claim-${i}`, positive: v.positive, quote: v.quote })),
      grammar: (j.grammar ?? []).map((v: any, i: number) => ({ kind: "grammar", id: v.id ?? `g-${i}`, positive: v.positive ?? true, quote: v.quote })),
    });
  }

  const client: JudgeClient & { warm: typeof warm } = {
    warm,
    proposeCoverage: (_s, produced) => cache.get(produced)?.coverage ?? [],
    proposeSupport: (_s, produced) => cache.get(produced)?.support ?? [],
    proposeGrammar: (produced) => cache.get(produced)?.grammar ?? [],
  };
  return client;
}

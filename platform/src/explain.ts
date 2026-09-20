// ============================================================================
// explain.ts — turn the structured findings into a plain-English sentence a
// human can act on ("it booked the wrong time; the reply invented something").
//
// Offline it uses a deterministic template (no key). With a real provider it
// asks the LLM to write the same thing in one friendly paragraph — same inputs,
// nicer prose. Either way it's built ONLY from verified findings, so it never
// makes things up.
// ============================================================================
import type { CaseResult } from "./score.ts";
import { requireKey } from "./env.ts";

function friendlyField(at: string): string {
  const f = at.split(":")[1] ?? at;
  return ({ time: "time", date: "date", name: "patient name", type: "appointment type", action: "action" } as Record<string, string>)[f] ?? f;
}

// deterministic, no key — always available
export function explainCase(r: CaseResult): string {
  if (r.score.composite >= 0.999 && !r.hardFail) {
    return "All good — the agent did exactly what the answer key expected.";
  }
  const lines: string[] = [];

  // heard
  if (r.layer1 && r.layer1.wer.value < 0.85) {
    lines.push(`Speech-to-text misheard part of the audio (heard about ${(r.layer1.wer.value * 100).toFixed(0)}% of the words correctly).`);
  }
  // findings
  for (const m of r.score.mismatches) {
    if (m.at.startsWith("field:")) {
      lines.push(`It booked the wrong ${friendlyField(m.at)} — expected ${JSON.stringify(m.expected)}, but got ${JSON.stringify(m.produced)}.`);
    } else if (m.at.startsWith("tooth:")) {
      const t = m.at.split(":")[1];
      lines.push(`Tooth ${t}: expected ${JSON.stringify(m.expected)} but charted ${JSON.stringify(m.produced)} (${m.class.toLowerCase()}).`);
    } else if (m.class === "UNSUPPORTED") {
      lines.push(`The spoken reply said something the caller never said: “${m.produced}”.`);
    } else if (m.class === "GRAMMAR") {
      lines.push(`Awkward wording in the reply: “${m.produced}”.`);
    } else if (m.class === "MISSING") {
      lines.push(`It skipped something it should have done at ${m.at}.`);
    } else {
      lines.push(`Problem at ${m.at}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.produced)}.`);
    }
  }
  if (r.hardFail) lines.unshift(`The run did not finish cleanly (${r.hardFail}).`);
  if (!lines.length) lines.push("Scored below target, but no specific finding was recorded.");
  return lines.join(" ");
}

// LLM-written version (used only when a real provider is set)
export async function explainCaseLLM(r: CaseResult, provider: "openai" | "anthropic"): Promise<string> {
  const facts = explainCase(r);   // the verified findings, as grounding
  const prompt =
    `You are helping a developer fix a voice agent. In 2-3 short, plain sentences, ` +
    `explain what went wrong and what to check first. Use ONLY these verified findings; ` +
    `do not invent anything.\n\nFindings: ${facts}`;
  if (provider === "openai") {
    const key = requireKey("OPENAI_API_KEY");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return facts;
    return (await res.json()).choices?.[0]?.message?.content ?? facts;
  }
  const key = requireKey("ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 300, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) return facts;
  return (await res.json()).content?.map((b: any) => b.text ?? "").join("") ?? facts;
}

// ============================================================================
// judge.ts — the LLM judge harness (spec §9), for outputs with no exact answer.
//
// The platform enforces the rules; the adapter only supplies the JudgeSpec.
// The rule that makes the judge trustworthy (spec §9.5):
//
//   Every positive verdict must carry a verbatim quote from the source it
//   points at. The platform verifies the quote by normalized substring match.
//   A verdict whose quote does not anchor is DISCARDED, not counted.
//
// Two metrics come out: coverage (fraction of required facts present) and
// support (fraction of produced claims grounded in the transcript).
//
// The judge client is injected, so this whole file is unit-testable with a
// scripted mock and no token spend (see judge.test.ts).
// ============================================================================
import type { JudgeSpec, JudgeVerdict, MetricValue } from "./types.ts";
import { normalize } from "./util.ts";
import { normText } from "./match.ts";

/** A required fact counts as present if its text is literally in the output —
 *  checked in code, so a sloppy model that forgets to quote can't zero a reply
 *  that plainly contains the fact. (The LLM's own verified quote is a fallback
 *  for paraphrases, below.) */
function present(factText: string, output: string): boolean {
  const f = normText(factText);
  return f.length > 0 && normText(output).includes(f);
}

// A judge client proposes verdicts. A real one calls a model at temperature 0,
// seeing ONLY the transcript and the produced output — never the agent's
// reasoning, never its own prior verdicts.
export interface JudgeClient {
  proposeCoverage(spec: JudgeSpec, produced: string, transcript: string): JudgeVerdict[];
  proposeSupport(spec: JudgeSpec, produced: string, transcript: string): JudgeVerdict[];
  // grammar: flag ungrammatical sentences. Each flag must QUOTE the bad sentence
  // (verifiable against the output), so even grammar credit can't be faked.
  proposeGrammar?(produced: string): JudgeVerdict[];
}

export interface JudgeResult {
  coverage: MetricValue;
  support: MetricValue;
  grammar?: MetricValue;
  verdicts: (JudgeVerdict & { anchored: boolean })[];
}

/** Verify a verdict's quote actually appears in its source (spec §9.4). */
function anchored(v: JudgeVerdict, source: string): boolean {
  if (!v.positive) return false;
  if (!v.quote) return false;
  return normalize(source).includes(normalize(v.quote));
}

export function runJudge(
  spec: JudgeSpec, produced: string, transcript: string, client: JudgeClient,
): JudgeResult {
  const verdicts: (JudgeVerdict & { anchored: boolean })[] = [];

  // coverage: a required fact is covered if it's literally in the output
  // (deterministic — robust to a model that returns a bad/empty quote) OR the
  // model supplied a verbatim quote that anchors in the output.
  const cov = client.proposeCoverage(spec, produced, transcript);
  let covCorrect = 0;
  for (const fact of spec.facts) {
    const v = cov.find((x) => x.id === fact.id);
    const ok = present(fact.text, produced) || (!!v && anchored(v, produced));
    if (ok) covCorrect++;
    verdicts.push({ kind: "coverage", id: fact.id, positive: ok, quote: v?.quote ?? null, anchored: ok });
  }

  // support: each claim the output makes must be grounded in the transcript.
  // A verdict WITHOUT a quote carries no evidence either way, so it's ignored
  // (a sloppy model that omits quotes must not silently tank a clean reply).
  // Of the verdicts that DO quote, the fraction whose quote grounds in the
  // transcript is the support score; a quoted claim that doesn't ground is a
  // hallucination (e.g. an invented insurance line) and drags support down.
  const sup = client.proposeSupport(spec, produced, transcript);
  let supValid = 0, supGrounded = 0;
  for (const v of sup) {
    if (!v.quote) { verdicts.push({ ...v, anchored: false }); continue; }   // no evidence → ignore
    supValid++;
    const ok = anchored(v, transcript);            // quote must be in the TRANSCRIPT
    if (ok) supGrounded++;
    verdicts.push({ ...v, anchored: ok });
  }

  // grammar (optional): each flagged error must quote a real sentence from the
  // output. Clean output => grammar 1.0; each verified error drags it down.
  let grammar: MetricValue | undefined;
  if (spec.checkGrammar && client.proposeGrammar) {
    const flags = client.proposeGrammar(produced);
    let verified = 0;
    for (const v of flags) {
      const ok = anchored(v, produced);            // the bad sentence must be in the OUTPUT
      if (ok) verified++;
      verdicts.push({ ...v, anchored: ok });
    }
    const sentences = Math.max(1, produced.split(/[.!?]+/).filter((s) => s.trim()).length);
    grammar = { value: Math.max(0, 1 - verified / sentences), total: sentences, correct: sentences - verified };
  }

  return {
    coverage: { value: spec.facts.length ? covCorrect / spec.facts.length : 1,
                total: spec.facts.length, correct: covCorrect },
    support: { value: supValid ? supGrounded / supValid : 1,
               total: supValid, correct: supGrounded },
    grammar,
    verdicts,
  };
}
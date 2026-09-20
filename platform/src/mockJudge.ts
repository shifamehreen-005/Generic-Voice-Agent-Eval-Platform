// ============================================================================
// mockJudge.ts — a deterministic stand-in for a real LLM judge.
//
// It lets the whole platform run offline with no token spend. It proposes a
// verdict + quote per the §9 protocol; the platform's runJudge() still does the
// anchoring/verification, so swapping this for a real temperature-0 model
// changes nothing about how credit is awarded.
// ============================================================================
import type { JudgeSpec, JudgeVerdict } from "./types.ts";
import type { JudgeClient } from "./judge.ts";

const STOP = new Set(["the", "a", "an", "is", "are", "no", "to", "of", "on", "in",
  "and", "per", "about", "half", "when", "this", "visit", "reports", "taking"]);

function keywords(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function sentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

/** Best sentence in `text` for the given keywords, or null. */
function bestSentence(text: string, kws: string[]): string | null {
  let best: string | null = null, bestHits = 0;
  for (const sent of sentences(text)) {
    const low = sent.toLowerCase();
    const hits = kws.filter((k) => low.includes(k)).length;
    if (hits > bestHits) { bestHits = hits; best = sent; }
  }
  // offline stand-in: any keyword overlap counts as grounding. The REAL LLM
  // judge (llmJudge.ts) does proper semantic grounding; this is just so the
  // no-key demo behaves sensibly.
  return bestHits >= 1 ? best : null;
}

export const mockJudge: JudgeClient = {
  // coverage: is each required fact present in the produced note? quote from produced.
  proposeCoverage(spec: JudgeSpec, produced: string): JudgeVerdict[] {
    return spec.facts.map((f) => {
      const q = bestSentence(produced, keywords(f.text));
      return { kind: "coverage", id: f.id, positive: q != null, quote: q };
    });
  },
  // support: is each claim the note makes grounded in the transcript? quote from transcript.
  proposeSupport(spec: JudgeSpec, produced: string, transcript: string): JudgeVerdict[] {
    return sentences(produced).map((claim, i) => {
      const q = bestSentence(transcript, keywords(claim));
      // if no grounding is found the judge still points at the claim itself,
      // which then fails to anchor in the transcript and is discarded.
      return { kind: "support", id: `claim-${i}`, positive: true, quote: q ?? claim };
    });
  },
  // grammar: a light offline heuristic (real judge uses an LLM). Flags a
  // sentence that doesn't start capitalized or contains an obvious typo.
  proposeGrammar(produced: string): JudgeVerdict[] {
    const out: JudgeVerdict[] = [];
    sentences(produced).forEach((s, i) => {
      const bad = /\b(teh|recieve|adn|thier|alot)\b/i.test(s) || /^[a-z]/.test(s.trim()) || /\s{2,}/.test(s);
      if (bad) out.push({ kind: "grammar", id: `g-${i}`, positive: true, quote: s });
    });
    return out;
  },
};

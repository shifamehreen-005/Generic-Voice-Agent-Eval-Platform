// ============================================================================
// stt.ts — Layer 1: STT fidelity (spec §7, layer 1).
//
// Compares what STT produced against the reference transcript. Reports overall
// WER *and* accuracy on the tokens that actually matter (digits / critical
// tokens), because in a domain where numbers are the payload, overall WER hides
// the errors that count.
// ============================================================================
import type { MetricValue } from "./types.ts";

// Number words → digits, so spoken "three" and transcribed "3" count as equal
// (a numbers-heavy domain shouldn't be penalised for word-vs-digit formatting).
const NUM: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30",
};

function tokens(s: string): string[] {
  return s.toLowerCase()
    .replace(/[.,;:!?]/g, " ")
    .replace(/-/g, " ")            // "214-324" → "214 324"
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => NUM[t] ?? t);      // normalise number words to digits
}

/** Word error rate via word-level Levenshtein distance. */
export function wer(reference: string, hypothesis: string): number {
  const r = tokens(reference);
  const h = tokens(hypothesis);
  if (r.length === 0) return 0;
  const dp = Array.from({ length: h.length + 1 }, (_, i) => i);
  for (let i = 1; i <= r.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const cur = dp[j];
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return dp[h.length] / r.length;
}

/**
 * Accuracy over the tokens that actually matter. When a criticalTranscript is
 * given, its distinct tokens define the "critical vocabulary"; we pull just
 * those tokens out of the hypothesis (in order) and score that stream against
 * the criticalTranscript. This is the number-only fidelity a digit-heavy domain
 * needs — overall WER hides it. Falls back to digit tokens when no critical
 * transcript is supplied.
 */
export function criticalAccuracy(criticalTranscript: string | undefined,
                                 referenceTranscript: string,
                                 hypothesis: string): MetricValue {
  let refCrit: string[];
  let vocab: Set<string>;
  if (criticalTranscript) {
    refCrit = tokens(criticalTranscript);
    vocab = new Set(refCrit);
  } else {
    const isDigit = (t: string) => /\d/.test(t);
    refCrit = tokens(referenceTranscript).filter(isDigit);
    vocab = new Set(refCrit);
  }
  const hypCrit = tokens(hypothesis).filter((t) => vocab.has(t));
  const w = refCrit.length ? wer(refCrit.join(" "), hypCrit.join(" ")) : 0;
  const value = Math.max(0, 1 - w);
  return { value, total: refCrit.length, correct: Math.round(value * refCrit.length) };
}

export interface Layer1 {
  wer: MetricValue;               // overall, vs the full reference transcript
  criticalDigits: MetricValue;    // the number/entity stream only
}

/**
 * @param hypothesis run.transcriptText (what STT heard)
 */
export function scoreLayer1(referenceTranscript: string | undefined,
                            criticalTranscript: string | undefined,
                            hypothesis: string): Layer1 | null {
  if (!referenceTranscript) return null;           // strongly wanted, but optional
  const w = wer(referenceTranscript, hypothesis);  // overall WER on the full text
  const total = tokens(referenceTranscript).length;
  const value = Math.max(0, 1 - w);
  return {
    wer: { value, total, correct: Math.round(value * total) },
    criticalDigits: criticalAccuracy(criticalTranscript, referenceTranscript, hypothesis),
  };
}

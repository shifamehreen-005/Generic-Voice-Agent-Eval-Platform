// ============================================================================
// score.ts — assemble the three layers into one per-case result (spec §7).
//
//   layer 1 : STT fidelity   (generic, from reference transcript)
//   layer 2 : trajectory     (generic, from optional gt.expectedCalls)
//   layer 3 : outcome        (adapter.score) AND/OR judge (adapter.judgeSpec)
//
// A domain may have BOTH a deterministic score() and a judged reply (judgeSpec).
// The receptionist does: structured booking is graded by code, the spoken reply
// by the judge. We merge them into one composite via adapter.judgeWeight.
// ============================================================================
import type { Case, RunResult, Score, MetricValue } from "./types.ts";
import type { Adapter } from "./adapter.ts";
import { scoreLayer1, type Layer1 } from "./stt.ts";
import { scoreTrajectory, type ExpectedCall, type TrajectoryScore } from "./trajectory.ts";
import { runJudge, type JudgeResult, type JudgeClient } from "./judge.ts";
import { round } from "./util.ts";
import { attachFeedback } from "./feedback.ts";
import { ConfigError } from "./errors.ts";

export interface CaseResult {
  caseId: string;
  adapter: string;
  provenanceKind: "gold" | "silver";
  layer1: Layer1 | null;
  trajectory: TrajectoryScore | null;
  score: Score;
  judge: JudgeResult | null;
  produced: unknown;
  transcriptText: string;
  hardFail?: string;
  cached?: boolean;               // agent events replayed; this case cost 0
  explanation?: string;           // plain-English "what went wrong", filled by run.ts
}

const EMPTY_STATS = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] };

// Bump when the scoring rules change, so a re-score is traceable (spec §18).
export const SCORER_VERSION = "1.0.0";

function judgeMetrics(j: JudgeResult): { metrics: Record<string, MetricValue>; composite: number } {
  const metrics: Record<string, MetricValue> = { coverage: j.coverage, support: j.support };
  if (j.grammar) metrics.grammar = j.grammar;
  const vals = Object.values(metrics).map((m) => m.value);
  return { metrics, composite: round(vals.reduce((a, b) => a + b, 0) / vals.length) };
}

export async function scoreCase(
  adapter: Adapter, c: Case, rr: RunResult, judgeClient: JudgeClient,
): Promise<CaseResult> {
  const gt = c.groundTruth as any;

  // layer 1 + layer 2
  const layer1 = scoreLayer1(c.referenceTranscript, c.criticalTranscript, rr.transcriptText);
  const expected: ExpectedCall[] | undefined = gt?.expectedCalls;
  const trajectory = expected ? scoreTrajectory(rr.events, expected) : null;

  // layer 3
  const produced = adapter.fold(rr.events);

  const det = adapter.score ? adapter.score(produced, gt, {}) : null;

  let judge: JudgeResult | null = null;
  let judgePart: { metrics: Record<string, MetricValue>; composite: number } | null = null;
  if (adapter.judgeSpec) {
    const target = adapter.judgeTarget ? adapter.judgeTarget(produced) : String(produced);
    // warm a real (async) judge client if it needs a model call first
    const warm = (judgeClient as any).warm as undefined | ((s: unknown, p: string, t: string) => Promise<void>);
    if (warm) await warm(adapter.judgeSpec(gt), target, rr.transcriptText);
    judge = runJudge(adapter.judgeSpec(gt), target, rr.transcriptText, judgeClient);
    judgePart = judgeMetrics(judge);
  }

  // Turn judge verdicts into mismatches:
  //  - grammar: a real error the judge found and DID quote => GRAMMAR.
  //  - support: a claim that WAS quoted but did NOT ground in the transcript
  //    (a hallucination, e.g. an invented insurance line) => UNSUPPORTED.
  //  - coverage: a required fact the reply did not state => MISSING.
  const judgeMismatches = () => (judge?.verdicts ?? []).flatMap((v: any) => {
    if (v.kind === "grammar") {
      return v.positive && v.anchored
        ? [{ class: "GRAMMAR", at: `grammar:${v.id}`, expected: "clean sentence", produced: v.quote }]
        : [];
    }
    if (v.kind === "support") {
      return v.quote && !v.anchored
        ? [{ class: "UNSUPPORTED", at: `support:${v.id}`, expected: "grounded in transcript", produced: v.quote }]
        : [];
    }
    if (v.kind === "forbidden") {
      return [{ class: "FORBIDDEN", at: `forbidden:${v.id}`, expected: "absent", produced: v.quote }];
    }
    if (v.kind === "template") {
      return [{ class: "TEMPLATE", at: `section:${v.id}`, expected: "heading in order, once", produced: v.quote }];
    }
    // coverage
    return v.positive === false
      ? [{ class: "MISSING", at: `reply-fact:${v.id}`, expected: "stated in the spoken reply", produced: null }]
      : [];
  });

  // combine
  let score: Score;
  if (det && judgePart) {
    const jw = adapter.judgeWeight ?? 0.3;
    const metrics = { ...det.metrics, ...judgePart.metrics };
    const composite = round((1 - jw) * det.composite + jw * judgePart.composite);
    const jkeys = Object.keys(judgePart.metrics);
    const weights = { ...scale(det.weights, 1 - jw), ...Object.fromEntries(jkeys.map((k) => [k, round(jw / jkeys.length)])) };
    score = { metrics, composite, weights, mismatches: [...det.mismatches, ...judgeMismatches()], extras: det.extras, stats: rr.stats };
  } else if (det) {
    score = { ...det, stats: rr.stats };
  } else if (judgePart) {
    score = { metrics: judgePart.metrics, composite: judgePart.composite,
      weights: even(Object.keys(judgePart.metrics)), mismatches: judgeMismatches(), extras: 0, stats: rr.stats };
  } else {
    throw new ConfigError(`adapter "${adapter.name}" has neither score() nor judgeSpec(). Add one of them.`);
  }

  score = {
    ...score,
    mismatches: attachFeedback(score.mismatches, rr.segments ?? [], c.referenceTranscript, rr.events, rr.transcriptText),
  };

  if (rr.hardFail) score = { ...score, composite: 0, hardFail: rr.hardFail };

  return {
    caseId: c.id, adapter: c.adapter, provenanceKind: c.provenance.kind,
    layer1, trajectory, score, judge, produced,
    transcriptText: rr.transcriptText, hardFail: rr.hardFail,
  };
}

function scale(w: Record<string, number>, f: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(w)) out[k] = round(v * f);
  return out;
}
function even(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = round(1 / keys.length);
  return out;
}

function _avg(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
}

export async function evaluateSuite(): Promise<void> { /* unused; run.ts drives it */ }
export { _avg };
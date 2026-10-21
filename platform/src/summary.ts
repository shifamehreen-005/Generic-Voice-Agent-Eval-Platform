// The one small object a coding agent reads. Written to summary.json and,
// with --json, printed as the only thing on stdout.
import type { CaseRun } from "./run.ts";
import { topLine } from "./feedback.ts";
import { round } from "./util.ts";

export interface SummaryCase {
  id: string;
  composite: number;
  delta: number | null;
  hardFail: string | null;
  mismatches: number;
  top: string[];
  cached: boolean;
  cost: number;
}

export interface Summary {
  run: string;
  runId: string;
  baseline: string | null;
  gate: "pass" | "fail";
  exit: number;
  meanComposite: number;
  cost: number;
  baselineCost: number | null;
  wallMs: number;
  skipped: number;
  stopped?: "max-cost" | "fail-fast" | "provider";
  error?: string;
  cases: SummaryCase[];
}

export function buildSummary(opts: {
  run: string;
  runId: string;
  baseline: string | null;
  gate: "pass" | "fail";
  exit: number;
  wallMs: number;
  skipped: number;
  baselineCost: number | null;
  baselineByCase: Map<string, number>;
  runs: CaseRun[];
  stopped?: Summary["stopped"];
  error?: string;
}): Summary {
  const cases: SummaryCase[] = opts.runs.map((r) => {
    const base = opts.baselineByCase.get(r.result.caseId);
    const composite = round(r.spread.mean);
    return {
      id: r.result.caseId,
      composite,
      delta: base == null ? null : round(composite - base),
      hardFail: r.result.hardFail ?? null,
      mismatches: r.result.score.mismatches.length,
      top: r.result.score.mismatches.slice(0, 3).map(topLine),
      cached: r.result.cached === true,
      cost: round(r.result.score.stats.estCostUsd, 4),
    };
  });
  const cost = round(cases.reduce((a, c) => a + c.cost, 0), 4);
  const meanComposite = cases.length
    ? round(cases.reduce((a, c) => a + c.composite, 0) / cases.length)
    : 0;
  const summary: Summary = {
    run: opts.run,
    runId: opts.runId,
    baseline: opts.baseline,
    gate: opts.gate,
    exit: opts.exit,
    meanComposite,
    cost,
    baselineCost: opts.baselineCost,
    wallMs: opts.wallMs,
    skipped: opts.skipped,
    cases,
  };
  if (opts.stopped) summary.stopped = opts.stopped;
  if (opts.error) summary.error = opts.error;
  return summary;
}

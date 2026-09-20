// ============================================================================
// report.ts — report.md + report.json (spec §11).
//
// One row per case, a totals row, then: the mismatch-class histogram, the
// slowest tool calls, any lint warnings, and the gold/silver split behind the
// numbers. report.json carries the same data for the gate to read.
// ============================================================================
import type { CaseRun } from "./run.ts";
import type { LintFinding } from "./types.ts";
import { round } from "./util.ts";

export interface ReportJson {
  cases: {
    id: string; adapter: string; provenance: string;
    layer1Wer: number | null; layer1Digits: number | null;
    trajectory: number | null; outcome: number;
    correct: number | null;     // deterministic part, combined (all outcome metrics)
    metrics: { key: string; value: number; weight: number }[];  // EVERY outcome metric the adapter defined
    reply: number | null;       // judged part (avg of coverage/support/grammar)
    composite: number; min: number; max: number; unstable: boolean;
    extras: number; hardFail: string | null; costUsd: number;
    mismatchClasses: Record<string, number>;
    explanation: string;
    slowestToolMs: number;
  }[];
  totals: {
    meanComposite: number; goldCount: number; silverCount: number;
    silverShare: number; estCostUsd: number; mismatchHistogram: Record<string, number>;
  };
}

function pct(v: number | null): string {
  return v == null ? "  -  " : (v * 100).toFixed(1) + "%";
}

export function buildReport(runs: CaseRun[], lint: Map<string, LintFinding[]>) {
  const rows: ReportJson["cases"] = [];
  const histogram: Record<string, number> = {};
  let gold = 0, silver = 0, silverComposite = 0, totalComposite = 0, cost = 0;
  const slowest: { case: string; name: string; ms: number }[] = [];

  for (const run of runs) {
    const r = run.result;
    const classes: Record<string, number> = {};
    for (const m of r.score.mismatches) {
      classes[m.class] = (classes[m.class] ?? 0) + 1;
      histogram[m.class] = (histogram[m.class] ?? 0) + 1;
    }
    const l1 = r.layer1;
    const traj = r.trajectory;
    if (traj) slowest.push({ case: r.caseId, name: "tool", ms: traj.slowestMs });

    // split the score into the deterministic part and the judged part ("reply")
    // so the table reads in plain words. An adapter may define ANY NUMBER of
    // deterministic metrics — we keep them all (metrics[]) and also combine them
    // into one "correct" number (their weighted average) for the summary column.
    const judgeKeys = ["coverage", "support", "grammar"];
    const detMetrics = Object.entries(r.score.metrics)
      .filter(([k]) => !judgeKeys.includes(k))
      .map(([key, m]) => ({ key, value: round(m.value), weight: round(r.score.weights[key] ?? 0) }));
    const wSum = detMetrics.reduce((a, m) => a + m.weight, 0);
    const correct = detMetrics.length
      ? round(wSum > 0
          ? detMetrics.reduce((a, m) => a + m.value * m.weight, 0) / wSum
          : detMetrics.reduce((a, m) => a + m.value, 0) / detMetrics.length)
      : null;
    const replyVals = judgeKeys.map((k) => r.score.metrics[k]?.value).filter((v) => v != null) as number[];

    rows.push({
      id: r.caseId, adapter: r.adapter, provenance: r.provenanceKind,
      layer1Wer: l1 ? round(l1.wer.value) : null,
      layer1Digits: l1 ? round(l1.criticalDigits.value) : null,
      trajectory: traj ? round(traj.metric.value) : null,
      outcome: round(r.score.composite),
      correct,
      metrics: detMetrics,
      reply: replyVals.length ? round(replyVals.reduce((a, b) => a + b, 0) / replyVals.length) : null,
      composite: run.spread.mean, min: run.spread.min, max: run.spread.max,
      unstable: run.spread.unstable,
      extras: r.score.extras, hardFail: r.hardFail ?? null,
      costUsd: round(r.score.stats.estCostUsd, 4),
      mismatchClasses: classes, explanation: r.explanation ?? "",
      slowestToolMs: traj?.slowestMs ?? 0,
    });

    totalComposite += run.spread.mean;
    cost += r.score.stats.estCostUsd;
    if (r.provenanceKind === "gold") gold++; else { silver++; silverComposite += run.spread.mean; }
  }

  const meanComposite = round(totalComposite / (runs.length || 1));
  const json: ReportJson = {
    cases: rows,
    totals: {
      meanComposite, goldCount: gold, silverCount: silver,
      silverShare: round(totalComposite ? silverComposite / totalComposite : 0),
      estCostUsd: round(cost, 4), mismatchHistogram: histogram,
    },
  };

  // ---- markdown ----
  const L: string[] = [];
  L.push(`# Eval report\n`);
  L.push(`| case | prov | L1 WER | L1 digits | trajectory | outcome | composite (min–max) | extras | hardFail | cost |`);
  L.push(`|------|------|-------:|----------:|-----------:|--------:|--------------------:|-------:|:--------:|-----:|`);
  for (const c of rows) {
    const spread = c.unstable ? `${(c.composite*100).toFixed(1)}% ⚠(${(c.min*100).toFixed(0)}–${(c.max*100).toFixed(0)})`
                              : `${(c.composite*100).toFixed(1)}%`;
    L.push(`| ${c.id} | ${c.provenance} | ${pct(c.layer1Wer)} | ${pct(c.layer1Digits)} | ${pct(c.trajectory)} | ${pct(c.outcome)} | ${spread} | ${c.extras} | ${c.hardFail ?? "—"} | $${c.costUsd} |`);
  }
  L.push(`| **mean** |  |  |  |  |  | **${(meanComposite*100).toFixed(1)}%** |  |  | $${json.totals.estCostUsd} |`);

  L.push(`\n## Mismatch classes\n`);
  const hist = Object.entries(histogram).sort((a, b) => b[1] - a[1]);
  L.push(hist.length ? hist.map(([k, n]) => `- ${k}: ${n}`).join("\n") : "- none");

  L.push(`\n## Slowest tool calls\n`);
  const top = slowest.sort((a, b) => b.ms - a.ms).slice(0, 5);
  L.push(top.length ? top.map((s) => `- ${s.case}: ${s.ms}ms`).join("\n") : "- n/a");

  L.push(`\n## Lint warnings\n`);
  const warns: string[] = [];
  for (const [id, fs] of lint) for (const f of fs) if (f.severity === "warn") warns.push(`- ${id}: ${f.message}`);
  L.push(warns.length ? warns.join("\n") : "- none");

  L.push(`\n## Ground-truth provenance\n`);
  L.push(`- gold: ${gold}  ·  silver: ${silver}  ·  **${(json.totals.silverShare*100).toFixed(0)}% of the composite rests on silver (unreviewed) ground truth**`);

  return { md: L.join("\n") + "\n", json };
}

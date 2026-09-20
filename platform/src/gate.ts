// ============================================================================
// gate.ts — the regression gate (spec §11). What makes this a testing platform
// rather than a measuring tool. Exits non-zero for CI.
//
// Fails when, versus the baseline:
//   - any case gains a hardFail it did not have
//   - composite drops more than `tolerance` on any single case
//   - mean composite drops at all
//   - p95 tool-call latency regresses more than `p95Latency`
//   - cost per case rises more than `costPerCase`
//
// Thresholds live in config/gate.json, never in code.
// ============================================================================
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ReportJson } from "./report.ts";
import { percentile, round } from "./util.ts";

export interface GateConfig {
  tolerance: number;        // per-case composite drop allowed (default 0.02)
  p95Latency: number;       // p95 tool latency regression allowed (default 0.20)
  costPerCase: number;      // cost per case increase allowed (default 0.25)
}

const DEFAULTS: GateConfig = { tolerance: 0.02, p95Latency: 0.20, costPerCase: 0.25 };

export function loadGateConfig(): GateConfig {
  const p = join(process.cwd(), "config", "gate.json");
  if (existsSync(p)) { try { return { ...DEFAULTS, ...JSON.parse(readFileSync(p, "utf8")) }; } catch { /* fall through */ } }
  return DEFAULTS;
}

export interface GateResult { passed: boolean; reasons: string[]; }

export function gate(baseline: ReportJson, candidate: ReportJson, cfg = loadGateConfig()): GateResult {
  const reasons: string[] = [];
  const baseById = new Map(baseline.cases.map((c) => [c.id, c]));

  // per-case checks
  for (const cand of candidate.cases) {
    const base = baseById.get(cand.id);
    if (!base) continue;
    if (cand.hardFail && !base.hardFail) {
      reasons.push(`${cand.id}: new hardFail "${cand.hardFail}"`);
    }
    const drop = round(base.composite - cand.composite);
    if (drop > cfg.tolerance) {
      reasons.push(`${cand.id}: composite dropped ${(base.composite*100).toFixed(1)}% → ${(cand.composite*100).toFixed(1)}% (−${(drop*100).toFixed(1)}, tol ${(cfg.tolerance*100).toFixed(0)})`);
    }
  }

  // mean composite must not drop at all
  const meanDrop = round(baseline.totals.meanComposite - candidate.totals.meanComposite);
  if (meanDrop > 0) {
    reasons.push(`mean composite dropped ${(baseline.totals.meanComposite*100).toFixed(1)}% → ${(candidate.totals.meanComposite*100).toFixed(1)}%`);
  }

  // p95 tool latency
  const baseP95 = percentile(baseline.cases.map((c) => c.slowestToolMs), 95);
  const candP95 = percentile(candidate.cases.map((c) => c.slowestToolMs), 95);
  if (baseP95 > 0 && (candP95 - baseP95) / baseP95 > cfg.p95Latency) {
    reasons.push(`p95 tool latency up ${(((candP95 - baseP95) / baseP95) * 100).toFixed(0)}% (${baseP95}ms → ${candP95}ms)`);
  }

  // cost per case
  const baseCost = baseline.totals.estCostUsd / (baseline.cases.length || 1);
  const candCost = candidate.totals.estCostUsd / (candidate.cases.length || 1);
  if (baseCost > 0 && (candCost - baseCost) / baseCost > cfg.costPerCase) {
    reasons.push(`cost/case up ${(((candCost - baseCost) / baseCost) * 100).toFixed(0)}% ($${round(baseCost,4)} → $${round(candCost,4)})`);
  }

  if (reasons.length === 0) reasons.push(`no regression (mean composite ${(candidate.totals.meanComposite*100).toFixed(1)}%)`);
  return { passed: reasons.length === 1 && reasons[0].startsWith("no regression"), reasons };
}

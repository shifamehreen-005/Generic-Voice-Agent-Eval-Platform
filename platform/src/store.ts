// ============================================================================
// store.ts — the results directory (spec §6) + run naming/versioning.
//
// Layout: results are grouped by adapter so each domain's history sits together.
//   results/index.json          global run history (all adapters)
//   results/<adapter>/<run-id>/
//     run.json              config, git sha, models, timestamps, totals
//     report.md / report.json / report.html
//     cases/<case-id>/{events,produced,segments,score,trace,judge}.json
//
// Naming (an idea from our design chat, layered on top of the spec): a run is
// labeled with --name, or, if omitted, it reuses the previous run's base name
// and bumps the version — "smoke v1", "smoke v2", ... Every run is written once
// and never mutated, so history is just the pile of run.json files.
// ============================================================================
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CaseResult } from "./score.ts";
import { stableStringify } from "./util.ts";

const RESULTS = join(process.cwd(), "results");
const INDEX = join(RESULTS, "index.json");

export interface RunIndexEntry {
  runId: string;
  label: string;
  baseName: string;
  version: number;
  adapters: string[];
  timestamp: string;
  meanComposite: number;
  gatePassed: boolean | null;
}

function readIndex(): RunIndexEntry[] {
  if (!existsSync(INDEX)) return [];
  try { return JSON.parse(readFileSync(INDEX, "utf8")); } catch { return []; }
}

function writeIndex(rows: RunIndexEntry[]): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(INDEX, stableStringify(rows));
}

/** Resolve (baseName, version, label) per the naming rule above. */
export function resolveName(explicit: string | undefined, fallback: string): { baseName: string; version: number; label: string } {
  const idx = readIndex();
  const baseName = explicit?.trim() || fallback || "run";
  const version = 1 + idx.filter((r) => r.baseName === baseName).length;
  return { baseName, version, label: `${baseName} v${version}` };
}

/** A readable, filesystem-safe id from the run label, e.g. "smoke v2" -> "smoke-v2". */
export function runIdForLabel(label: string, adapter: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // labels already include a version, so they're unique; guard anyway
  let id = base || "run";
  let n = 2;
  while (existsSync(join(RESULTS, adapter, id))) id = `${base}-${n++}`;
  return id;
}

// Runs live under results/<adapter>/<run-id>/. We look the adapter up from the
// index by run-id, so every reader lands in the right subfolder.
function adapterOf(runId: string): string | null {
  const row = readIndex().find((r) => r.runId === runId);
  return row?.adapters?.[0] ?? null;
}
/** Absolute path to a run's folder (adapter-nested; falls back to flat). */
export function runDir(runId: string): string {
  const a = adapterOf(runId);
  return a ? join(RESULTS, a, runId) : join(RESULTS, runId);
}
/** Same path, relative — for printing to the user, e.g. "results/dental/dental-real-v1". */
export function runDirRel(runId: string): string {
  const a = adapterOf(runId);
  return a ? `results/${a}/${runId}` : `results/${runId}`;
}

/** The most recent prior run for the same base name — the gate's baseline. */
// The gate compares each run to the PREVIOUS run of the same ADAPTER (not the
// same label) — so a run is always lined up against the right thing whether or
// not you named it. Removes the "named one run, not the other" footgun.
export function pickBaselineByAdapter(adapter: string): string | null {
  const idx = readIndex();
  const same = idx.filter((r) => (r.adapters ?? []).includes(adapter));
  return same.length ? same[same.length - 1].runId : null;
}

export interface RunManifest {
  runId: string;
  label: string;
  baseName: string;
  adapter: string;          // primary adapter → the results/<adapter>/ subfolder
  version: number;
  timestamp: string;
  gitSha: string;
  mode: string;
  model?: string;
  promptHash?: string;
  sttConfig: { provider: string; configHash: string };
  repeat: number;
  totals: {
    meanComposite: number;
    minComposite: number;
    maxComposite: number;
    goldCount: number;
    silverCount: number;
    silverShare: number;   // fraction of composite resting on silver ground truth
    estCostUsd: number;
  };
  cases: string[];
}

export function saveRun(manifest: RunManifest, results: CaseResult[],
                        artifacts: Record<string, { events: unknown; segments: unknown; trace: string; judge: unknown }>,
                        reportMd: string, reportJson: unknown): string {
  const dir = join(RESULTS, manifest.adapter, manifest.runId);
  mkdirSync(join(dir, "cases"), { recursive: true });
  writeFileSync(join(dir, "run.json"), stableStringify(manifest));
  writeFileSync(join(dir, "report.md"), reportMd);
  writeFileSync(join(dir, "report.json"), stableStringify(reportJson));

  for (const r of results) {
    const cdir = join(dir, "cases", r.caseId);
    mkdirSync(cdir, { recursive: true });
    const a = artifacts[r.caseId];
    writeFileSync(join(cdir, "events.json"), stableStringify(a.events));
    writeFileSync(join(cdir, "produced.json"), stableStringify(r.produced));
    writeFileSync(join(cdir, "segments.json"), stableStringify(a.segments));
    writeFileSync(join(cdir, "score.json"), stableStringify(r.score));
    writeFileSync(join(cdir, "trace.txt"), a.trace);
    if (a.judge) writeFileSync(join(cdir, "judge.json"), stableStringify(a.judge));
  }
  return dir;
}

export function appendIndex(entry: RunIndexEntry): void {
  const idx = readIndex();
  idx.push(entry);
  writeIndex(idx);
}

export function updateGateResult(runId: string, passed: boolean): void {
  const idx = readIndex();
  const row = idx.find((r) => r.runId === runId);
  if (row) { row.gatePassed = passed; writeIndex(idx); }
}

export function listRuns(): RunIndexEntry[] { return readIndex(); }

export function loadReportJson(runId: string): any {
  const p = join(runDir(runId), "report.json");
  if (!existsSync(p)) throw new Error(`no report.json for run ${runId}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function loadManifest(runId: string): RunManifest {
  return JSON.parse(readFileSync(join(runDir(runId), "run.json"), "utf8"));
}

export function resultsDir(): string { return RESULTS; }
export function runExists(runId: string): boolean {
  return existsSync(join(runDir(runId), "run.json"));
}
export function resolveRunId(idOrLatest: string | undefined): string {
  const idx = readIndex();
  if (!idOrLatest || idOrLatest === "latest") {
    if (!idx.length) throw new Error("no runs yet");
    return idx[idx.length - 1].runId;
  }
  // allow matching by label too
  const byLabel = idx.find((r) => r.label === idOrLatest);
  return byLabel ? byLabel.runId : idOrLatest;
}

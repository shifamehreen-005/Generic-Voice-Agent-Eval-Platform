#!/usr/bin/env -S npx tsx
// ============================================================================
// cli.ts — the command surface.
//
//   eval run   --cases <glob> [--mode live|replay] [--json] [--failed-only]
//   eval score --run <id>                 re-score existing artifacts, NO inference
//   eval gate  --baseline <id> --candidate <id>
//   eval lint  --cases <glob>
//   eval draft --case <file>
//   eval cases [--cases <glob>]
//   eval runs
//   eval show  --run <id> --case <id>     feedback blocks only
//   eval diff  --a <id> --b <id>          cells that changed
//   eval doctor
//   eval html  --run <id>
//
// Exit codes: 0 pass, 1 gate failed, 2 hard fail, 3 bad config, 4 provider / cost.
// ============================================================================
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import "../../demo/adapters/index.ts";
import "../../adapters/index.ts";
import { getAdapter, allAdapters, isStreaming } from "./adapter.ts";
import { loadCases, loadCaseFile } from "./loader.ts";
import { lintSet, lintCase, hasBlockingError } from "./lint.ts";
import { runSet } from "./run.ts";
import { scoreCase, SCORER_VERSION } from "./score.ts";
import { mockJudge } from "./mockJudge.ts";
import { explainCase } from "./explain.ts";
import { buildReport } from "./report.ts";
import { gate, loadGateConfig } from "./gate.ts";
import * as store from "./store.ts";
import { sttConfigFor } from "./cache.ts";
import { ttsElevenLabs, ttsOpenAI } from "./providers.ts";
import { writeHtml } from "./reportHtml.ts";
import { gitSha, sha1, stableStringify, c, round } from "./util.ts";
import { EXIT, ConfigError, oneLine, exitFor } from "./errors.ts";
import { feedbackBlock } from "./feedback.ts";
import { buildSummary } from "./summary.ts";
import { cacheRoot, resultsRoot } from "./paths.ts";
import { loadEnv } from "./env.ts";
import type { Case, Mismatch } from "./types.ts";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }
function jsonMode(): boolean { return flag("json") || !process.stdout.isTTY; }

function selectCases(): Case[] {
  let cases = loadCases(arg("cases", "demo/cases")!);
  const adapterFilter = arg("adapter");
  if (adapterFilter) {
    cases = cases.filter((cs) => cs.adapter === adapterFilter);
    if (cases.length === 0) {
      throw new ConfigError(
        `no cases for adapter "${adapterFilter}". Registered: [${allAdapters().join(", ")}]. Point --cases at a file whose adapter field matches.`,
      );
    }
  }
  const only = arg("case");
  if (only) {
    cases = cases.filter((cs) => cs.id === only);
    if (!cases.length) throw new ConfigError(`no case with id "${only}". Check the --case id against \`eval cases\`.`);
  }
  const tags = arg("tag");
  if (tags) {
    const want = tags.split(",").map((s) => s.trim()).filter(Boolean);
    cases = cases.filter((cs) => want.some((t) => (cs.tags ?? []).includes(t)));
    if (!cases.length) throw new ConfigError(`no cases tagged ${want.join(", ")}. Check --tag against the case "tags" array.`);
  }
  return cases;
}

function openLog(path: string): (line: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (line: string) => appendFileSync(path, line.replace(/\s*\n\s*/g, " ") + "\n");
}

function numArg(name: string, dflt: number, extra: string): number {
  const raw = arg(name, String(dflt))!;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`--${name} must be a number. ${extra} Got "${raw}".`);
  return n;
}

async function cmdRun() {
  const json = jsonMode();
  const modeArg = arg("mode", "replay")!;
  if (modeArg !== "live" && modeArg !== "replay") {
    throw new ConfigError(`--mode must be live or replay. Got "${modeArg}".`);
  }
  const mode = modeArg;
  const repeat = numArg("repeat", 1, "Use an integer >= 1.");
  if (repeat < 1) throw new ConfigError(`--repeat must be an integer >= 1. Got ${repeat}.`);
  let jobs = numArg("jobs", 4, "Use an integer >= 1.");
  if (jobs < 1) throw new ConfigError(`--jobs must be an integer >= 1. Got ${jobs}.`);
  const maxCost = numArg("max-cost", 5, "USD, 0 or more.");
  if (maxCost < 0) throw new ConfigError(`--max-cost must be >= 0. Got ${maxCost}.`);
  const speed = numArg("speed", 0, "0 = as fast as possible, 1 = real time.");
  if (speed !== 0 && speed !== 1) throw new ConfigError(`--speed must be 0 or 1. Got ${speed}.`);
  const corruptFraction = numArg("corrupt-speakers", 0, "A fraction from 0 to 1.");
  if (corruptFraction < 0 || corruptFraction > 1) throw new ConfigError(`--corrupt-speakers must be between 0 and 1. Got ${corruptFraction}.`);
  const corruptSeed = numArg("corrupt-seed", 1, "An integer.");

  const provider = arg("provider");
  const model = provider ?? arg("model");
  const promptArg = arg("prompt");
  const prompt = promptArg && existsSync(promptArg) ? readFileSync(promptArg, "utf8") : promptArg;
  const sttArg = arg("stt", "mock")!;
  if (sttArg !== "mock" && sttArg !== "openai") throw new ConfigError(`--stt must be mock or openai. Got "${sttArg}".`);
  const stt = sttArg as "mock" | "openai";

  let cases = selectCases();
  const lint = lintSet(cases);
  const blocked = cases.filter((cs) => hasBlockingError(lint.get(cs.id) ?? []));
  if (blocked.length) {
    const lines = blocked.flatMap((b) => (lint.get(b.id) ?? [])
      .filter((f) => f.severity === "error")
      .map((f) => `${b.id}: ${f.message}`));
    throw new ConfigError(lines[0] ?? `lint errors block ${blocked.map((b) => b.id).join(", ")}. Fix the case file.`);
  }

  let skipped = 0;
  if (flag("failed-only")) {
    const adapterName = cases[0]?.adapter;
    const last = adapterName ? store.lastCompletedRun(adapterName) : null;
    if (last) {
      const report = store.loadReportJson(last);
      const failed = new Set(
        (report.cases as { id: string; hardFail: string | null; composite: number }[])
          .filter((row) => row.hardFail || row.composite < 0.999)
          .map((row) => row.id),
      );
      const before = cases.length;
      cases = cases.filter((cs) => failed.has(cs.id));
      skipped = before - cases.length;
    }
  }

  const primaryAdapter = cases[0]?.adapter ?? arg("adapter") ?? "run";
  const { baseName, version, label } = store.resolveName(arg("name"), primaryAdapter);
  const runId = store.runIdForLabel(label, primaryAdapter);
  const dir = join(resultsRoot(), primaryAdapter, runId);
  const log = openLog(join(dir, "log.txt"));
  const streaming = cases.some((cs) => { try { return isStreaming(getAdapter(cs.adapter)); } catch { return false; } });
  if (streaming && jobs > 1) { jobs = 1; log("streaming adapter: jobs set to 1"); }
  log(`run ${label} cases=${cases.length} skipped=${skipped} agent=${model ?? "mock"} stt=${stt} speed=${speed}`);
  if (!json) {
    console.log(c.b(`\n  ${label}`) + c.dim(`   ${cases.length} cases · agent=${model ?? "mock"} · speech-to-text=${stt}\n`));
  }

  const onStep = (id: string, step: string) => process.stdout.write(`\r  ${c.dim("▸")} ${id.padEnd(22)} ${c.dim(step + "…".padEnd(16))}`);
  const onDone = (r: { result: { caseId: string; hardFail?: string; score: { composite: number } } }) => {
    const v = r.result.score.composite;
    const mark = r.result.hardFail ? c.r("✗") : v >= 0.999 ? c.g("✓") : v >= 0.5 ? c.y("~") : c.r("✗");
    process.stdout.write(`\r  ${mark} ${r.result.caseId.padEnd(22)} ${(v * 100).toFixed(0).padStart(3)}%${" ".repeat(18)}\n`);
  };

  const started = Date.now();
  const { runs, stop, error } = await runSet(cases, mode, repeat, model, prompt, stt, {
    noCache: flag("no-cache"),
    maxCostUsd: maxCost,
    jobs,
    failFast: flag("fail-fast"),
    explain: flag("explain"),
    judgeModel: arg("judge-model"),
    speed,
    corruptFraction,
    corruptSeed,
    onStep: json ? undefined : onStep,
    onDone: json ? undefined : onDone,
    log,
  });
  const wallMs = Date.now() - started;

  const { md, json: report } = buildReport(runs, lint);
  const totalCost = round(runs.reduce((a, r) => a + r.result.score.stats.estCostUsd, 0), 4);
  const composites = runs.map((r) => r.spread.mean);
  const gold = runs.filter((r) => r.result.provenanceKind === "gold").length;

  const manifest: store.RunManifest = {
    runId, label, baseName, adapter: primaryAdapter, version,
    timestamp: new Date().toISOString(),
    gitSha: gitSha(), mode, model, promptHash: prompt ? sha1(prompt) : undefined,
    sttConfig: sttConfigFor(stt), repeat,
    partial: !!stop,
    totals: {
      meanComposite: report.totals.meanComposite,
      minComposite: composites.length ? round(Math.min(...composites)) : 0,
      maxComposite: composites.length ? round(Math.max(...composites)) : 0,
      goldCount: gold, silverCount: runs.length - gold,
      silverShare: report.totals.silverShare, estCostUsd: totalCost,
    },
    cases: runs.map((r) => r.result.caseId),
  };

  const baselineId = store.pickBaselineByAdapter(primaryAdapter);
  const art: Record<string, { events: unknown; segments: unknown; trace: string; judge: unknown; repeats: store.RepeatArtifact[] }> = {};
  for (const r of runs) art[r.result.caseId] = r.artifacts;
  const saved = store.saveRun(manifest, runs.map((r) => r.result), art, md, report);
  store.appendIndex({
    runId, label, baseName, version, adapters: [...new Set(runs.map((r) => r.result.adapter).concat(primaryAdapter))],
    timestamp: manifest.timestamp, meanComposite: report.totals.meanComposite, gatePassed: null,
    partial: !!stop,
  });

  let passed = true;
  let reasons = ["first run for this test — recorded as the baseline"];
  let baseLabel: string | null = null;
  let baselineCost: number | null = null;
  const baselineByCase = new Map<string, number>();
  if (baselineId && store.runExists(baselineId) && runs.length) {
    const baseManifest = store.loadManifest(baselineId);
    const baseJson = store.loadReportJson(baselineId);
    baseLabel = baseManifest.label;
    baselineCost = baseJson.totals?.estCostUsd ?? null;
    for (const row of baseJson.cases ?? []) baselineByCase.set(row.id, row.composite);
    const res = gate(baseJson, report);
    passed = res.passed;
    reasons = res.reasons;
    writeFileSync(join(saved, "gate.json"), stableStringify({ ...res, baseline: baseLabel }));
  } else {
    writeFileSync(join(saved, "gate.json"), stableStringify({ passed: true, reasons, baseline: null }));
  }
  store.updateGateResult(runId, passed);
  writeHtml(saved);

  const hard = runs.some((r) => r.result.hardFail);
  let exit: number = EXIT.pass;
  if (stop === "max-cost" || stop === "provider") exit = EXIT.provider;
  else if (hard) exit = EXIT.hardFail;
  else if (!passed) exit = EXIT.gate;

  const summary = buildSummary({
    run: label, runId, baseline: baseLabel, gate: passed ? "pass" : "fail", exit,
    wallMs, skipped, baselineCost, baselineByCase, runs, stopped: stop, error,
  });
  writeFileSync(join(saved, "summary.json"), stableStringify(summary));

  if (stop === "max-cost") console.error(`cost ceiling $${maxCost} hit. Raise --max-cost or pass --case to run less.`);
  if (stop === "provider" && error) console.error(error);

  if (json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    if (runs.length) printReportConsole(report);
    printGate({ passed, reasons }, baseLabel ?? "(baseline)", report, store.runDirRel(runId), label);
    if (skipped) console.log(c.dim(`  skipped ${skipped} case(s) that passed the last run`));
    if (model === "openai" || model === "anthropic") await speakReplies(runs, saved, runId);
  }
  process.exit(exit);
}

async function speakReplies(runs: { artifacts?: { events?: { kind: string; data?: unknown }[] }; result: { caseId: string } }[], dir: string, runId: string) {
  const useEleven = !!process.env.ELEVENLABS_API_KEY;
  if (!useEleven && !process.env.OPENAI_API_KEY) return;
  let n = 0;
  for (const r of runs) {
    const ev = (r.artifacts?.events ?? []).find((e) => e.kind === "assistant_text");
    const text = String(ev?.data ?? "").trim();
    if (!text) continue;
    const out = join(dir, "cases", r.result.caseId, "reply.mp3");
    try { if (useEleven) await ttsElevenLabs(text, out); else await ttsOpenAI(text, out); n++; }
    catch (e) { console.log(c.dim(`  (reply audio: couldn't voice ${r.result.caseId}: ${e instanceof Error ? e.message.split("\n")[0] : e})`)); }
  }
  if (n) console.log(c.dim(`\n  🔊 voiced ${n} repl${n === 1 ? "y" : "ies"} → ${store.runDirRel(runId)}/cases/<case>/reply.mp3`));
}

function printReportConsole(json: { cases: any[]; totals: { meanComposite: number } }) {
  const W = 8;
  const p = (v: number | null | undefined) => (v == null ? "–" : (v * 100).toFixed(0) + "%");
  const cell = (s: string) => s.padStart(W);
  const head = (s: string) => cell(s.length > W ? s.slice(0, W) : s);
  const PRE = 24;
  const metricKeys: string[] = [];
  for (const r of json.cases) for (const m of r.metrics ?? []) if (!metricKeys.includes(m.key)) metricKeys.push(m.key);
  let header = "  " + "Case".padEnd(PRE) + cell("Heard") + cell("Tools");
  for (const k of metricKeys) header += head(k);
  header += cell("Reply") + cell("Overall");
  const rule = "  " + "─".repeat(Math.max(10, header.length - 2));
  console.log();
  console.log(c.dim(header));
  console.log(c.dim(rule));
  for (const r of json.cases) {
    const mark = r.hardFail ? c.r("✗") : r.composite >= 0.999 ? c.g("✓") : r.composite >= 0.5 ? c.y("~") : c.r("✗");
    let line = `  ${mark} ${r.id.padEnd(PRE - 2)}` + cell(p(r.layer1Wer)) + cell(p(r.trajectory));
    for (const k of metricKeys) {
      const m = (r.metrics ?? []).find((x: { key: string }) => x.key === k);
      line += cell(m ? p(m.value) : "–");
    }
    const ovStr = cell(p(r.composite));
    const ov = r.composite >= 0.999 ? c.g(ovStr) : r.composite >= 0.5 ? c.y(ovStr) : c.r(ovStr);
    line += cell(p(r.reply)) + ov;
    console.log(line);
  }
  console.log(c.dim(rule));
  const avg = cell((json.totals.meanComposite * 100).toFixed(0) + "%");
  console.log(c.b("  Average") + " ".repeat(Math.max(1, header.length - "  Average".length - W)) + avg);
  const cols = metricKeys.length ? `then one column per outcome metric your adapter defines (${metricKeys.join(", ")})` : "Correct = outcome vs answer key";
  console.log(c.dim(`  Heard = speech-to-text · Tools = right tools/order · Reply = judged spoken reply · ${cols}`));
}

function printGate(res: { passed: boolean; reasons: string[] }, baselineLabel: string, json: { cases: any[] }, dir: string, label: string) {
  console.log();
  if (res.passed) console.log(c.g("  ✓ PASSED") + c.dim(`  no worse than “${baselineLabel}”.`));
  else {
    console.log(c.r("  ✗ FAILED") + c.dim(`  this run is worse than “${baselineLabel}”:`));
    for (const reason of res.reasons) console.log(c.r("    • ") + reason);
    const failing = json.cases.filter((r) => r.composite < 0.999);
    if (failing.length) console.log(c.dim("\n  What went wrong:"));
    for (const r of failing) console.log(`    ${c.b(r.id)}: ${r.explanation}`);
  }
  console.log(c.dim(`\n  Full report → open ${dir}/report.html   (run: eval html --run "${label}")`));
  console.log(c.dim(`  Raw detail  → ${dir}/cases/<case>/score.json`));
  console.log(c.dim(`  Summary     → ${dir}/summary.json`));
}

function replayJudge(verdicts: any[]) {
  const of = (k: string) => (verdicts ?? []).filter((v) => v.kind === k)
    .map((v) => ({ kind: v.kind, id: v.id, positive: v.positive, quote: v.quote }));
  return { proposeCoverage: () => of("coverage"), proposeSupport: () => of("support"), proposeGrammar: () => of("grammar") };
}

async function cmdScore() {
  const runId = store.resolveRunId(arg("run"));
  const dir = store.runDir(runId);
  const manifest = store.loadManifest(runId);
  const oldJson = store.loadReportJson(runId);
  const byId = new Map(loadCases("demo/cases,adapters").map((cs) => [cs.id, cs]));
  console.log(c.dim(`re-scoring ${runId} from saved events (no inference, scorer ${SCORER_VERSION})…\n`));
  const runs: any[] = [];
  for (const caseId of manifest.cases) {
    const cs = byId.get(caseId);
    if (!cs) { console.log(c.y(`  skip ${caseId} — case file not found in cases/`)); continue; }
    const cdir = join(dir, "cases", caseId);
    const events = JSON.parse(readFileSync(join(cdir, "events.json"), "utf8"));
    const segments = existsSync(join(cdir, "segments.json")) ? JSON.parse(readFileSync(join(cdir, "segments.json"), "utf8")) : [];
    const savedScore = existsSync(join(cdir, "score.json")) ? JSON.parse(readFileSync(join(cdir, "score.json"), "utf8")) : { stats: {} };
    const savedJudge = existsSync(join(cdir, "judge.json")) ? JSON.parse(readFileSync(join(cdir, "judge.json"), "utf8")) : null;
    const rr = {
      events, segments, transcriptText: segments.map((s: { text: string }) => s.text).join(" "),
      stats: savedScore.stats ?? {}, hardFail: savedScore.hardFail,
    };
    const judgeClient = savedJudge ? replayJudge(savedJudge.verdicts) : mockJudge;
    const result = await scoreCase(getAdapter(cs.adapter), cs, rr as any, judgeClient as any);
    result.explanation = explainCase(result);
    runs.push({
      result, spread: { mean: result.score.composite, min: result.score.composite, max: result.score.composite, unstable: false },
      artifacts: { events, segments, trace: "", judge: result.judge, repeats: [] },
    });
  }
  const { json } = buildReport(runs, new Map());
  (json as any).scorerVersion = SCORER_VERSION;
  writeFileSync(join(dir, "report.rescored.json"), stableStringify(json));
  printReportConsole(json);
  const delta = round((json.totals.meanComposite - oldJson.totals.meanComposite) * 100, 1);
  console.log(c.dim(`\n  re-scored average ${(json.totals.meanComposite * 100).toFixed(0)}% vs stored ${(oldJson.totals.meanComposite * 100).toFixed(0)}% (${delta >= 0 ? "+" : ""}${delta} pts) → ${store.runDirRel(runId)}/report.rescored.json`));
}

function cmdGate() {
  const base = store.resolveRunId(arg("baseline"));
  const cand = store.resolveRunId(arg("candidate"));
  const candJson = store.loadReportJson(cand);
  const res = gate(store.loadReportJson(base), candJson, loadGateConfig());
  if (jsonMode()) {
    process.stdout.write(JSON.stringify({ gate: res.passed ? "pass" : "fail", exit: res.passed ? 0 : 1, reasons: res.reasons }) + "\n");
  } else {
    printGate(res, store.loadManifest(base).label, candJson, store.runDirRel(cand), store.loadManifest(cand).label);
  }
  process.exit(res.passed ? EXIT.pass : EXIT.gate);
}

function cmdLint() {
  const cases = selectCases();
  let errors = 0;
  for (const cs of cases) {
    const findings = lintCase(cs);
    if (!findings.length) { console.log(`${c.g("✓")} ${cs.id}`); continue; }
    for (const f of findings) {
      if (f.severity === "error") errors++;
      const tag = f.severity === "error" ? c.r("ERROR") : c.y("warn ");
      console.log(`${tag} ${cs.id}: ${f.message}${f.at ? " @ " + f.at : ""} (${f.rule})`);
    }
  }
  process.exit(errors ? EXIT.config : EXIT.pass);
}

function cmdDraft() {
  const file = arg("case");
  if (!file) throw new ConfigError(`eval draft needs --case <file>. Example: eval draft --case demo/cases/receptionist-01.json`);
  const cs = loadCaseFile(file);
  const adapter = getAdapter(cs.adapter);
  if (!adapter.draftGroundTruth) throw new ConfigError(`adapter "${adapter.name}" has no drafter. Add draftGroundTruth() or draft the answer key by hand.`);
  const gt = adapter.draftGroundTruth(cs.referenceTranscript ?? cs.transcriptText ?? "");
  const drafted = { ...cs, groundTruth: gt, provenance: { kind: "silver", model: "mock-drafter", approvedAt: null } };
  const out = join(dirname(file), basename(file).replace(/\.json$/, "") + ".silver.json");
  writeFileSync(out, stableStringify(drafted));
  console.log(`${c.y("silver")} ground truth drafted → ${out}`);
  console.log(c.dim("run `eval lint` on it, then a human flips provenance.kind to \"gold\" after review."));
}

function cmdCases() {
  const cases = selectCases();
  for (const cs of cases) {
    const prov = cs.provenance.kind === "gold" ? c.g("gold  ") : c.y("silver");
    console.log(`${prov} ${cs.id.padEnd(24)} ${c.dim(cs.adapter)}  ${(cs.tags ?? []).join(", ")}`);
  }
}

function cmdRuns() {
  const rows = store.listRuns();
  if (!rows.length) { console.log("no runs yet."); return; }
  console.log(c.dim("runId              label              mean     gate    when"));
  for (const r of rows) {
    const g = r.gatePassed == null ? "  -" : r.gatePassed ? c.g("pass") : c.r("fail");
    console.log(`${r.runId}  ${r.label.padEnd(18)} ${(r.meanComposite * 100).toFixed(1).padStart(5)}%   ${g}   ${r.timestamp}`);
  }
}

function mismatchesOf(runId: string, caseId: string): Mismatch[] {
  const p = join(store.runDir(runId), "cases", caseId, "score.json");
  if (!existsSync(p)) return [];
  const score = JSON.parse(readFileSync(p, "utf8"));
  return (score.mismatches ?? []) as Mismatch[];
}

function cmdShow() {
  const caseId = arg("case");
  if (!caseId) throw new ConfigError("eval show needs --case <id>.");
  const runId = store.resolveRunId(arg("run"));
  const p = join(store.runDir(runId), "cases", caseId, "score.json");
  if (!existsSync(p)) throw new ConfigError(`no score for case "${caseId}" in run "${runId}". Check --run and --case.`);
  const blocks = mismatchesOf(runId, caseId).slice(0, 20).map((m) => feedbackBlock(m));
  process.stdout.write(JSON.stringify(blocks) + "\n");
}

function cmdDiff() {
  if (!arg("a") || !arg("b")) throw new ConfigError("eval diff needs --a <run> and --b <run>.");
  const a = store.resolveRunId(arg("a"));
  const b = store.resolveRunId(arg("b"));
  const ids = [...new Set([...(store.loadManifest(a).cases ?? []), ...(store.loadManifest(b).cases ?? [])])];
  const changed: Record<string, unknown>[] = [];
  for (const id of ids) {
    const am = new Map(mismatchesOf(a, id).map((m) => [m.at, m]));
    const seen = new Set<string>();
    for (const m of mismatchesOf(b, id)) {
      seen.add(m.at);
      const prev = am.get(m.at);
      const changedCell = !prev
        || JSON.stringify(prev.produced) !== JSON.stringify(m.produced)
        || JSON.stringify(prev.expected) !== JSON.stringify(m.expected);
      if (changedCell) changed.push(feedbackBlock(m, id));
    }
    for (const [at, m] of am) {
      if (!seen.has(at)) changed.push(feedbackBlock({ ...m, produced: null }, id));
    }
  }
  process.stdout.write(JSON.stringify(changed) + "\n");
}

function cmdHtml() {
  const runId = store.resolveRunId(arg("run"));
  const dir = store.runDir(runId);
  const out = writeHtml(dir);
  console.log(`${c.g("wrote")} ${out}\n${c.dim("open it in a browser (double-click).")}`);
}

function cmdDoctor() {
  loadEnv();
  const problems: string[] = [];
  const major = parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 18) {
    problems.push(`node ${process.versions.node} is too old. Install Node 18 or newer.`);
  }
  let adapters: string[] = [];
  try { adapters = allAdapters(); }
  catch (e) { problems.push(`adapters failed to load: ${oneLine(e)}. Check adapters/index.ts.`); }
  if (!adapters.length) problems.push("no adapters loaded. Add an import in adapters/index.ts.");
  try {
    const probe = join(cacheRoot(), ".doctor-probe");
    mkdirSync(cacheRoot(), { recursive: true });
    writeFileSync(probe, "ok");
  } catch {
    problems.push(`cache not writable at ${cacheRoot()}. Fix the directory permissions.`);
  }
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(EXIT.config);
  }
  const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"]
    .map((k) => `${k} ${process.env[k] ? "present" : "missing"}`)
    .join("  ");
  console.log(`node ${process.versions.node}`);
  console.log(keys);
  console.log(`cache writable ${cacheRoot()}`);
  console.log(`adapters ${adapters.join(", ")}`);
}

const usage =
  `usage: eval <run|score|gate|lint|draft|cases|runs|show|diff|doctor|html>\n` +
  `  run    --adapter <name> [--provider mock|mock-bug|openai|anthropic] [--json]\n` +
  `         [--case <id>] [--tag a,b] [--failed-only] [--fail-fast] [--no-cache]\n` +
  `         [--max-cost <usd>] [--jobs N] [--repeat N] [--speed 0|1] [--explain] [--name x]\n` +
  `         [--corrupt-speakers <fraction>] [--corrupt-seed <n>] [--judge-model <name>]\n` +
  `  show   --run <name> --case <id>     feedback blocks only (max 20)\n` +
  `  diff   --a <run> --b <run>          cells whose value changed\n` +
  `  doctor                              node, keys, cache, adapters\n` +
  `exit 0 pass\n` +
  `exit 1 gate failed\n` +
  `exit 2 a case hard-failed\n` +
  `exit 3 bad config or case file\n` +
  `exit 4 provider error (key, quota, network) or cost ceiling\n` +
  `adapters: ${allAdapters().join(", ")}`;

const cmd = process.argv[2];
const table: Record<string, () => void | Promise<void>> = {
  run: cmdRun, score: cmdScore, gate: cmdGate, lint: cmdLint,
  draft: cmdDraft, cases: cmdCases, runs: cmdRuns, show: cmdShow,
  diff: cmdDiff, html: cmdHtml, doctor: cmdDoctor,
};
if (!cmd || cmd === "help" || cmd === "--help") {
  console.log(usage);
  process.exit(EXIT.pass);
}
if (!table[cmd]) {
  console.error(usage);
  console.error(`unknown command "${cmd}". Use one of: ${Object.keys(table).join(", ")}.`);
  process.exit(EXIT.config);
}
try {
  await table[cmd]();
} catch (err) {
  console.error(oneLine(err));
  if (flag("debug") && err instanceof Error && err.stack) console.error(err.stack);
  process.exit(exitFor(err));
}

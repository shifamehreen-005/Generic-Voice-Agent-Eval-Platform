#!/usr/bin/env -S npx tsx
// ============================================================================
// cli.ts — the command surface (spec §12).
//
//   eval run   --cases <glob> [--mode live|replay] [--repeat N] [--model .. --prompt ..] [--name ..]
//   eval score --run <id>                 re-score existing artifacts, NO inference
//   eval gate  --baseline <id> --candidate <id>
//   eval lint  --cases <glob>
//   eval draft --case <file>              model-drafted ground truth → writes silver
//   eval cases [--cases <glob>]           list cases: tags, provenance
//   eval runs                             list past runs (our history idea)
//   eval show  --run <id> --case <id>     deep-dive one case
//
// `eval score` is deliberately separate from `eval run`: scorer work must never
// re-run inference (spec §12).
// ============================================================================
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import "../../demo/adapters/index.ts";                 // example adapters (dental, receptionist)
import "../../adapters/index.ts";                      // your own adapters
import { getAdapter, allAdapters } from "./adapter.ts";
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

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

// Load the case set (--cases), then optionally narrow to one domain (--adapter).
// Shared by run / lint / cases so the flag behaves the same everywhere (spec §12).
function loadFilteredCases(): ReturnType<typeof loadCases> {
  let cases = loadCases(arg("cases", "demo/cases")!);   // default = the example cases
  const adapterFilter = arg("adapter");
  if (adapterFilter) {
    cases = cases.filter((cs) => cs.adapter === adapterFilter);
    if (cases.length === 0) {
      console.error(c.r(`no cases for adapter "${adapterFilter}". Registered: [${allAdapters().join(", ")}]`));
      process.exit(1);
    }
  }
  return cases;
}

async function cmdRun() {
  const mode = (arg("mode", "replay") as "live" | "replay");
  const repeat = parseInt(arg("repeat", "1")!, 10);
  // --provider picks the agent: mock (offline) | openai | anthropic. It is passed
  // to the adapter as the "model" so each adapter decides how to use it.
  const provider = arg("provider");
  const model = provider ?? arg("model");
  // --prompt takes a file path (the agent's system prompt) or a literal string
  const promptArg = arg("prompt");
  const prompt = promptArg && existsSync(promptArg) ? readFileSync(promptArg, "utf8") : promptArg;
  const stt = (arg("stt", "mock") as "mock" | "openai");   // real speech-to-text opt-in
  const cases = loadFilteredCases();

  // lint gate: an error blocks the case from entering the set (spec §8)
  const lint = lintSet(cases);
  const blocked = cases.filter((cs) => hasBlockingError(lint.get(cs.id) ?? []));
  if (blocked.length) {
    console.error(c.r(`lint errors block ${blocked.length} case(s): ` + blocked.map((b) => b.id).join(", ")));
    for (const b of blocked) for (const f of lint.get(b.id)!) if (f.severity === "error")
      console.error(`  ${b.id}: ${f.message}`);
    process.exit(1);
  }

  const primaryAdapter = cases[0]?.adapter ?? "run";   // for naming + baseline
  const { baseName, version, label } = store.resolveName(arg("name"), primaryAdapter);
  const runId = store.runIdForLabel(label, primaryAdapter);   // results/<adapter>/<runId>/
  console.log(c.b(`\n  ${label}`) + c.dim(`   ${cases.length} cases · agent=${model ?? "mock"} · speech-to-text=${stt}\n`));

  // live progress: show what's happening for each case as it runs
  const onStep = (id: string, step: string) => process.stdout.write(`\r  ${c.dim("▸")} ${id.padEnd(22)} ${c.dim(step + "…".padEnd(16))}`);
  const onDone = (r: any) => {
    const v = r.result.score.composite;
    const mark = r.result.hardFail ? c.r("✗") : v >= 0.999 ? c.g("✓") : v >= 0.5 ? c.y("~") : c.r("✗");
    process.stdout.write(`\r  ${mark} ${r.result.caseId.padEnd(22)} ${(v * 100).toFixed(0).padStart(3)}%${" ".repeat(18)}\n`);
  };

  const runs = await runSet(cases, mode, repeat, model, prompt, stt, onStep, onDone);
  const { md, json } = buildReport(runs, lint);

  const totalCost = round(runs.reduce((a, r) => a + r.result.score.stats.estCostUsd, 0), 4);
  const composites = runs.map((r) => r.spread.mean);
  const gold = runs.filter((r) => r.result.provenanceKind === "gold").length;

  const manifest: store.RunManifest = {
    runId, label, baseName, adapter: primaryAdapter, version,
    timestamp: new Date().toISOString(),
    gitSha: gitSha(), mode, model, promptHash: prompt ? sha1(prompt) : undefined,
    sttConfig: sttConfigFor(stt), repeat,
    totals: {
      meanComposite: json.totals.meanComposite,
      minComposite: round(Math.min(...composites)),
      maxComposite: round(Math.max(...composites)),
      goldCount: gold, silverCount: runs.length - gold,
      silverShare: json.totals.silverShare, estCostUsd: totalCost,
    },
    cases: cases.map((cs) => cs.id),
  };

  // pick the baseline (previous version of the same test) BEFORE recording this
  // run in the index, so we never compare a run against itself
  const baselineId = store.pickBaselineByAdapter(primaryAdapter);

  const artifacts: Record<string, any> = {};
  for (const r of runs) artifacts[r.result.caseId] = r.artifacts;
  const dir = store.saveRun(manifest, runs.map((r) => r.result), artifacts, md, json);
  store.appendIndex({
    runId, label, baseName, version, adapters: [...new Set(cases.map((cs) => cs.adapter))],
    timestamp: manifest.timestamp, meanComposite: json.totals.meanComposite, gatePassed: null,
  });
  printReportConsole(json);
  let passed = true, res: { passed: boolean; reasons: string[] }, baseLabel = "";
  if (baselineId && store.runExists(baselineId)) {
    baseLabel = store.loadManifest(baselineId).label;
    res = gate(store.loadReportJson(baselineId), json);
    passed = res.passed;
    writeFileSync(join(dir, "gate.json"), stableStringify({ ...res, baseline: baseLabel }));
  } else {
    res = { passed: true, reasons: ["first run for this test — recorded as the baseline"] };
    baseLabel = "(baseline)";
    writeFileSync(join(dir, "gate.json"), stableStringify({ passed: true, reasons: res.reasons, baseline: null }));
  }
  store.updateGateResult(runId, passed);
  writeHtml(dir);                                   // always leave a fresh report.html
  // On a real run, voice each agent's spoken reply to reply.mp3 (demo playback,
  // never affects a score). Skips silently with no TTS key or no reply.
  if (model === "openai" || model === "anthropic") await speakReplies(runs, dir, runId);
  printGate(res, baseLabel, json, store.runDirRel(runId), label);
  process.exit(passed ? 0 : 1);
}

// Turn each agent's spoken reply into an .mp3 next to that case's results, so you
// can play the agent talking. Does NOT affect any score — the reply is still judged
// as text. Prefers ElevenLabs, falls back to OpenAI.
async function speakReplies(runs: any[], dir: string, runId: string) {
  const useEleven = !!process.env.ELEVENLABS_API_KEY;
  if (!useEleven && !process.env.OPENAI_API_KEY) return;   // no TTS key → nothing to do
  let n = 0;
  for (const r of runs) {
    const ev = (r.artifacts?.events ?? []).find((e: any) => e.kind === "assistant_text");
    const text = String(ev?.data ?? "").trim();
    if (!text) continue;                              // nothing spoken (e.g. dental) → skip
    const out = join(dir, "cases", r.result.caseId, "reply.mp3");
    try { if (useEleven) await ttsElevenLabs(text, out); else await ttsOpenAI(text, out); n++; }
    catch (e) { console.log(c.dim(`  (reply audio: couldn't voice ${r.result.caseId}: ${e instanceof Error ? e.message.split("\n")[0] : e})`)); }
  }
  if (n) console.log(c.dim(`\n  🔊 voiced ${n} repl${n === 1 ? "y" : "ies"} → ${store.runDirRel(runId)}/cases/<case>/reply.mp3`));
}

// Prints one column per OUTCOME metric the adapter defined (between Tools and
// Reply), so you're never limited to a single "Correct" number — an adapter that
// scores teeth + bleeding + recession shows all three.
function printReportConsole(json: any) {
  const W = 8;                                  // column width
  const p = (v: number | null | undefined) => (v == null ? "–" : (v * 100).toFixed(0) + "%");
  const cell = (s: string) => s.padStart(W);
  const head = (s: string) => cell(s.length > W ? s.slice(0, W) : s);
  const PRE = 24;                               // width of the "Case" column

  // union of metric names across cases, in first-seen order
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
      const m = (r.metrics ?? []).find((x: any) => x.key === k);
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

function printGate(res: { passed: boolean; reasons: string[] }, baselineLabel: string, json: any, dir: string, label: string) {
  console.log();
  if (res.passed) {
    console.log(c.g("  ✓ PASSED") + c.dim(`  no worse than “${baselineLabel}”.`));
  } else {
    console.log(c.r("  ✗ FAILED") + c.dim(`  this run is worse than “${baselineLabel}”:`));
    for (const reason of res.reasons) console.log(c.r("    • ") + reason);
    // show the plain-English "why" for each failing case
    const failing = json.cases.filter((r: any) => r.composite < 0.999);
    if (failing.length) { console.log(c.dim("\n  What went wrong:")); }
    for (const r of failing) console.log(`    ${c.b(r.id)}: ${r.explanation}`);
  }
  console.log(c.dim(`\n  Full report → open ${dir}/report.html   (run: eval html --run "${label}")`));
  console.log(c.dim(`  Raw detail  → ${dir}/cases/<case>/score.json`));
}

// A judge client that REPLAYS the saved verdicts (no model call). runJudge still
// re-verifies each quote against the source, so a scorer change is re-applied.
function replayJudge(verdicts: any[]) {
  const of = (k: string) => (verdicts ?? []).filter((v) => v.kind === k)
    .map((v) => ({ kind: v.kind, id: v.id, positive: v.positive, quote: v.quote }));
  return { proposeCoverage: () => of("coverage"), proposeSupport: () => of("support"), proposeGrammar: () => of("grammar") };
}

async function cmdScore() {
  // Re-score WITHOUT inference: replay each case's saved events through the
  // CURRENT adapter fold()/score()/judge rules, so a scorer change shows up
  // without re-running the agent or any model.
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
      events, segments, transcriptText: segments.map((s: any) => s.text).join(" "),
      stats: savedScore.stats ?? {}, hardFail: savedScore.hardFail,
    };
    const judgeClient = savedJudge ? replayJudge(savedJudge.verdicts) : mockJudge;
    const result = await scoreCase(getAdapter(cs.adapter), cs, rr as any, judgeClient as any);
    result.explanation = explainCase(result);
    runs.push({ result, spread: { mean: result.score.composite, min: result.score.composite, max: result.score.composite, unstable: false },
      artifacts: { events, segments, trace: "", judge: result.judge } });
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
  printGate(res, store.loadManifest(base).label, candJson, store.runDirRel(cand), store.loadManifest(cand).label);
  process.exit(res.passed ? 0 : 1);
}

function cmdLint() {
  const cases = loadFilteredCases();
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
  process.exit(errors ? 1 : 0);
}

function cmdDraft() {
  const file = arg("case");
  if (!file) { console.error("need --case <file>"); process.exit(1); }
  const cs = loadCaseFile(file);
  const adapter = getAdapter(cs.adapter);
  if (!adapter.draftGroundTruth) { console.error(`adapter ${adapter.name} has no drafter`); process.exit(1); }
  const gt = adapter.draftGroundTruth(cs.referenceTranscript ?? cs.transcriptText ?? "");
  const drafted = { ...cs, groundTruth: gt, provenance: { kind: "silver", model: "mock-drafter", approvedAt: null } };
  const out = join(dirname(file), basename(file).replace(/\.json$/, "") + ".silver.json");
  writeFileSync(out, stableStringify(drafted));
  console.log(`${c.y("silver")} ground truth drafted → ${out}`);
  console.log(c.dim("run `eval lint` on it, then a human flips provenance.kind to \"gold\" after review."));
}

function cmdCases() {
  const cases = loadFilteredCases();
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
    console.log(`${r.runId}  ${r.label.padEnd(18)} ${(r.meanComposite*100).toFixed(1).padStart(5)}%   ${g}   ${r.timestamp}`);
  }
}

function cmdShow() {
  const runId = store.resolveRunId(arg("run"));
  const caseId = arg("case");
  const json = store.loadReportJson(runId);
  const row = json.cases.find((x: any) => x.id === caseId) ?? json.cases[0];
  console.log(c.b(`\n${row.id}`) + c.dim(`  (run ${runId})`));
  console.log(`layer1 WER ${row.layer1Wer == null ? "-" : (row.layer1Wer*100).toFixed(1)+"%"}  ·  digits ${row.layer1Digits == null ? "-" : (row.layer1Digits*100).toFixed(1)+"%"}  ·  trajectory ${row.trajectory == null ? "-" : (row.trajectory*100).toFixed(1)+"%"}  ·  outcome ${(row.outcome*100).toFixed(1)}%`);
  console.log(c.dim(`artifacts: ${store.runDirRel(runId)}/cases/${row.id}/  (events, produced, segments, score, trace, judge)`));
  const cls = Object.entries(row.mismatchClasses);
  if (cls.length) { console.log(c.b("\nmismatch classes:")); for (const [k, n] of cls) console.log(`  ${k}: ${n}`); }
}

function cmdHtml() {
  const runId = store.resolveRunId(arg("run"));
  const dir = store.runDir(runId);
  const out = writeHtml(dir);
  console.log(`${c.g("wrote")} ${out}\n${c.dim("open it in a browser (double-click).")}`);
}

const cmd = process.argv[2];
const table: Record<string, () => void | Promise<void>> = {
  run: cmdRun, score: cmdScore, gate: cmdGate, lint: cmdLint,
  draft: cmdDraft, cases: cmdCases, runs: cmdRuns, show: cmdShow, html: cmdHtml,
};
if (!table[cmd]) {
  console.log(`usage: eval <run|score|gate|lint|draft|cases|runs|show|html> [...]\n` +
    `  run  --adapter <name> [--provider mock|mock-bug|openai|anthropic] [--stt mock|openai] [--repeat N] [--name x]\n` +
    `  html --run <name>     write a readable results/<run>/report.html\n` +
    `adapters: ${allAdapters().join(", ")}`);
  process.exit(cmd ? 1 : 0);
}
try {
  await table[cmd]();
} catch (err) {
  // clean one-line error (e.g. missing API key) instead of a stack trace
  console.error(c.r("\nerror: ") + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
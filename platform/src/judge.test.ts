// ============================================================================
// judge.test.ts — unit tests for the anchoring rule (spec §9), no tokens spent.
//
// Run:  npx tsx platform/src/judge.test.ts
// ============================================================================
import assert from "node:assert";
import type { JudgeSpec, JudgeVerdict } from "./types.ts";
import { runJudge, type JudgeClient } from "./judge.ts";
import { resolveJudgeModel } from "./judgeConfig.ts";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function test(name: string, fn: () => void) {
  fn(); passed++; console.log("  \x1b[32m✓\x1b[0m " + name);
}

const spec: JudgeSpec = {
  facts: [{ id: "f1", text: "gums bleeding when brushing" }],
  fields: [{ key: "medical", description: "history" }],
};

// A judge that credits everything but supplies a quote NOT in the source.
const lyingJudge: JudgeClient = {
  proposeCoverage: () => [{ kind: "coverage", id: "f1", positive: true, quote: "totally made up" }],
  proposeSupport: () => [{ kind: "support", id: "c0", positive: true, quote: "also invented" }],
};

// A judge whose quotes are real substrings of the source.
const honestJudge: JudgeClient = {
  proposeCoverage: () => [{ kind: "coverage", id: "f1", positive: true, quote: "gums bleeding" }],
  proposeSupport: () => [{ kind: "support", id: "c0", positive: true, quote: "brushing twice a day" }],
};

console.log("judge anchoring");

test("unanchored positive verdicts are discarded, not counted", () => {
  const produced = "Patient note: gums bleeding recorded.";
  const transcript = "Patient says gums bleeding when brushing twice a day.";
  const r = runJudge(spec, produced, transcript, lyingJudge);
  assert.strictEqual(r.coverage.correct, 0, "fabricated coverage quote must not count");
  assert.strictEqual(r.support.correct, 0, "fabricated support quote must not count");
});

test("verdicts whose quotes really anchor are counted", () => {
  const produced = "Patient note: gums bleeding recorded.";
  const transcript = "Patient says gums bleeding when brushing twice a day.";
  const r = runJudge(spec, produced, transcript, honestJudge);
  assert.strictEqual(r.coverage.correct, 1, "'gums bleeding' is in the produced note");
  assert.strictEqual(r.support.correct, 1, "'brushing twice a day' is in the transcript");
});

test("a missing fact scores zero coverage even if positive is claimed", () => {
  const produced = "Nothing relevant here.";
  const r = runJudge(spec, produced, "irrelevant transcript", honestJudge);
  assert.strictEqual(r.coverage.correct, 0);
});

test("forbidden words and heading order are code checks", () => {
  const produced = "# Later\nWe guarantee a cure.\n# First\nPain started on Monday.";
  const r = runJudge({
    facts: [{ id: "pain", text: "Pain started on Monday", section: "First" }],
    forbidden: [{ id: "g", text: "guarantee" }],
    sections: ["First", "Later"],
  }, produced, "Pain started on Monday.", honestJudge);
  const kinds = r.verdicts.filter((v) => v.kind === "forbidden" || v.kind === "template").map((v) => v.kind);
  assert.ok(kinds.includes("forbidden"));
  assert.ok(kinds.includes("template"));
});

test("the judge model comes from config/judge.json unless overridden", () => {
  assert.strictEqual(resolveJudgeModel("openai"), "gpt-4o");
  const dir = mkdtempSync(join(tmpdir(), "judge-cfg-"));
  try {
    const path = join(dir, "judge.json");
    writeFileSync(path, JSON.stringify({ model: "gpt-4o-mini" }));
    assert.strictEqual(resolveJudgeModel("openai", undefined, path), "gpt-4o-mini");
    assert.strictEqual(resolveJudgeModel("openai", "override-model", path), "override-model");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the brief demo scores below 100 for a missing fact, an invented line, and a forbidden word", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-"));
  const env = { ...process.env, EVAL_RESULTS: join(dir, "results"), EVAL_CACHE: join(dir, "cache") };
  delete env.OPENAI_API_KEY;
  try {
    const res = spawnSync(join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["platform/src/cli.ts", "run", "--cases", "demo/cases/brief", "--json", "--jobs", "1", "--name", "brief"],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const summary = JSON.parse(res.stdout.trim());
    assert.ok(summary.meanComposite < 1, String(summary.meanComposite));
    const classes = summary.cases[0].top.map((line: string) => line.split(" ")[0]).sort();
    assert.deepStrictEqual(classes, ["FORBIDDEN", "MISSING", "UNSUPPORTED"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);

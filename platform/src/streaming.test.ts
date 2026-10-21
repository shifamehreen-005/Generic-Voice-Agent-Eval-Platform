// streaming.test.ts — segmentsFile, speaker corruption, and the form agent.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreTrajectory } from "./trajectory.ts";
import { corruptSpeakers } from "./segments.ts";

const root = process.cwd();
const tsx = join(root, "node_modules", ".bin", "tsx");
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("  \x1b[32m✓\x1b[0m " + name); };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "eval-stream-"));
  const env: NodeJS.ProcessEnv = { ...process.env, EVAL_RESULTS: join(dir, "results"), EVAL_CACHE: join(dir, "cache") };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  return { dir, env };
}

function evalCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsx, ["platform/src/cli.ts", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
}

function summaryOf(res: { stdout: string }) {
  return JSON.parse(res.stdout.trim().split("\n").filter(Boolean).at(-1)!);
}

function elapsed(log: string): number[] {
  return [...log.matchAll(/elapsedMs=(\d+)/g)].map((m) => Number(m[1]));
}

console.log("streaming");

test("callId pairs a tool result with its call, not with whichever result is next", () => {
  const events = [
    { atMs: 0, kind: "tool_call" as const, name: "a", callId: "1" },
    { atMs: 10, kind: "tool_call" as const, name: "b", callId: "2" },
    { atMs: 100, kind: "tool_result" as const, callId: "2", ok: true },
    { atMs: 40, kind: "tool_result" as const, callId: "1", ok: true },
  ];
  const scored = scoreTrajectory(events, [{ name: "a" }, { name: "b" }]);
  assert.strictEqual(scored.slowestMs, 90);
});

test("corruptSpeakers flips a fixed share of operator segments", () => {
  const segs = [0, 1, 2, 3].map((id) => ({
    id, text: "x", speaker: id === 3 ? "S2" : "S1", startMs: id, durationMs: 1, isFinal: true,
  }));
  const once = corruptSpeakers(segs, 0.3, 7, ["S1"]);
  const twice = corruptSpeakers(segs, 0.3, 7, ["S1"]);
  assert.deepStrictEqual(once, twice);
  const flipped = once.filter((s) => s.speaker === "UU");
  assert.strictEqual(flipped.length, 1);
  assert.ok(once.find((s) => s.id === 3)!.speaker === "S2");
});

test("a segmentsFile run never calls a speech provider, revises a field, and records settleMs", () => {
  const { dir, env } = fresh();
  try {
    const res = evalCli([
      "run", "--cases", "demo/cases/form", "--case", "form-01",
      "--provider", "mock", "--stt", "openai", "--speed", "0", "--json", "--jobs", "1", "--name", "form",
    ], env);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const summary = summaryOf(res);
    assert.ok(summary.cases[0].settleMs >= 1500, `settleMs ${summary.cases[0].settleMs}`);
    assert.ok(summary.cases[0].audioMs > 0);
    const caseDir = join(env.EVAL_RESULTS as string, "form", summary.runId, "cases", "form-01");
    const events = JSON.parse(readFileSync(join(caseDir, "events.json"), "utf8")) as { sourceSegmentIds?: number[] }[];
    assert.ok(events.length >= 1);
    assert.ok(events.every((e) => Array.isArray(e.sourceSegmentIds) && e.sourceSegmentIds.length > 0));
    const produced = JSON.parse(readFileSync(join(caseDir, "produced.json"), "utf8"));
    assert.deepStrictEqual(produced.fields, { name: "Bea", city: "Paris" });
    const log = readFileSync(join(env.EVAL_RESULTS as string, "form", summary.runId, "log.txt"), "utf8");
    assert.match(log, /no speech provider/);
    const gaps = elapsed(log);
    assert.ok(gaps.length >= 2);
    assert.ok(gaps[gaps.length - 1] - gaps[0] < 150, `speed 0 gap ${gaps}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("speed 1 delivers segments with the saved gaps", () => {
  const { dir, env } = fresh();
  try {
    const res = evalCli([
      "run", "--cases", "demo/cases/form", "--case", "form-01",
      "--speed", "1", "--json", "--jobs", "1", "--name", "realtime",
    ], env);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const summary = summaryOf(res);
    const log = readFileSync(join(env.EVAL_RESULTS as string, "form", summary.runId, "log.txt"), "utf8");
    const gaps = elapsed(log);
    assert.ok(gaps.length >= 2);
    assert.ok(gaps[1] - gaps[0] >= 700, `speed 1 gap ${gaps}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("settleTimeoutMs 1 hard-fails and still keeps what was written", () => {
  const { dir, env } = fresh();
  try {
    const res = evalCli([
      "run", "--cases", "demo/cases/form/form-timeout.json",
      "--json", "--jobs", "1", "--name", "timeout",
    ], env);
    assert.strictEqual(res.status, 2, res.stderr + res.stdout);
    const summary = summaryOf(res);
    assert.strictEqual(summary.cases[0].hardFail, "settle_timeout");
    assert.ok(summary.cases[0].settleMs < 1000, `settleMs ${summary.cases[0].settleMs}`);
    const produced = JSON.parse(readFileSync(
      join(env.EVAL_RESULTS as string, "form", summary.runId, "cases", "form-timeout", "produced.json"), "utf8"));
    assert.strictEqual(produced.fields.name, "Bea");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clean and corrupted speaker runs both leave a summary the gate can compare", () => {
  const { dir, env } = fresh();
  try {
    const clean = evalCli([
      "run", "--cases", "demo/cases/form", "--case", "form-01", "--json", "--jobs", "1", "--name", "spk",
    ], env);
    assert.strictEqual(clean.status, 0, clean.stderr + clean.stdout);
    const dirty = evalCli([
      "run", "--cases", "demo/cases/form", "--case", "form-01",
      "--corrupt-speakers", "0.3", "--corrupt-seed", "1", "--json", "--jobs", "1", "--name", "spk",
    ], env);
    assert.ok(dirty.status === 0 || dirty.status === 1, dirty.stderr + dirty.stdout);
    const summary = summaryOf(dirty);
    assert.ok(summary.baseline);
    const segments = JSON.parse(readFileSync(
      join(env.EVAL_RESULTS as string, "form", summary.runId, "cases", "form-01", "segments.json"), "utf8",
    )) as { speaker: string }[];
    assert.strictEqual(segments.filter((s) => s.speaker === "UU").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed`);

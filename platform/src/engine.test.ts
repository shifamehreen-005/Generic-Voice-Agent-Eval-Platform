// engine.test.ts — exit codes, the JSON summary, the agent cache, and feedback layers.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFeedback } from "./feedback.ts";
import { exitFor, ProviderError, ConfigError, EXIT } from "./errors.ts";

const root = process.cwd();
const tsx = join(root, "node_modules", ".bin", "tsx");
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("  \x1b[32m✓\x1b[0m " + name); };

function fresh(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "eval-engine-"));
  const env: NodeJS.ProcessEnv = { ...process.env, EVAL_RESULTS: join(dir, "results"), EVAL_CACHE: join(dir, "cache") };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ELEVENLABS_API_KEY;
  return { env, dir };
}

function evalCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(tsx, ["platform/src/cli.ts", ...args], {
    cwd: root, env, encoding: "utf8", timeout: 60_000,
  });
}

function stdoutJson(res: { stdout: string }): any {
  const line = res.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return JSON.parse(line);
}

console.log("engine");

test("feedback: agent when the transcript agrees, stt when the heard token changed, uncertain without a reference", () => {
  const segments = [{ id: 0, text: "pockets five", speaker: "S1", startMs: 0, durationMs: 300, isFinal: true }];
  const events = [{ atMs: 1, kind: "tool_call" as const, name: "chart_tooth", args: { tooth: "14" }, sourceSegmentIds: [0] }];
  const [stt] = attachFeedback(
    [{ class: "WRONG", at: "tooth:14", expected: 4, produced: 5 }],
    segments, "pockets four", events, "pockets five",
  );
  assert.strictEqual(stt.layer, "stt");
  assert.strictEqual(stt.heard, "pockets five");
  assert.strictEqual(stt.said, "pockets four");
  const [agent] = attachFeedback(
    [{ class: "WRONG", at: "tooth:14", expected: 4, produced: 6 }],
    segments, "pockets five", events, "pockets five",
  );
  assert.strictEqual(agent.layer, "agent");
  const [unsure] = attachFeedback(
    [{ class: "WRONG", at: "tooth:14", expected: 4, produced: 6 }],
    segments, undefined, events, "pockets five",
  );
  assert.strictEqual(unsure.layer, "scorer-uncertain");
});

test("exit codes map provider and config errors", () => {
  assert.strictEqual(exitFor(new ProviderError("no key")), EXIT.provider);
  assert.strictEqual(exitFor(new ConfigError("bad field")), EXIT.config);
});

test("eval with no command lists the exit codes and exits 0", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli([], env);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /exit 0 pass/);
    assert.match(res.stdout, /exit 1 gate failed/);
    assert.match(res.stdout, /exit 2 a case hard-failed/);
    assert.match(res.stdout, /exit 3 bad config or case file/);
    assert.match(res.stdout, /exit 4 provider error/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval doctor exits 0", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["doctor"], env);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /node /);
    assert.match(res.stdout, /dental/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bad case file is one line naming the field, exit 3", () => {
  const { env, dir } = fresh();
  try {
    const file = join(dir, "bad.json");
    writeFileSync(file, JSON.stringify({ id: "bad", transcriptText: "hi", groundTruth: {}, provenance: { kind: "gold" } }));
    const res = evalCli(["run", "--cases", file, "--json"], env);
    assert.strictEqual(res.status, 3, res.stderr);
    const lines = res.stderr.split("\n").filter((l) => l.trim());
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /field "adapter"/);
    assert.doesNotMatch(lines[0], /\bat /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit 0 on a good run, summary under 1KB per case, and nothing else on stdout", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--name", "good", "--json", "--jobs", "1"], env);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    assert.ok(res.stdout.trim().startsWith("{"), res.stdout.slice(0, 80));
    const summary = stdoutJson(res);
    assert.strictEqual(summary.exit, 0);
    assert.strictEqual(summary.gate, "pass");
    assert.ok(summary.cases.length >= 1);
    assert.ok(res.stdout.length / summary.cases.length < 1024, `summary ${res.stdout.length} bytes`);
    assert.ok(summary.cases.every((c: { top: string[] }) => c.top.length <= 3));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit 1 when the gate fails", () => {
  const { env, dir } = fresh();
  try {
    const first = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--name", "gate", "--json", "--jobs", "1"], env);
    assert.strictEqual(first.status, 0, first.stderr);
    const second = evalCli(["run", "--adapter", "dental", "--provider", "mock-bug", "--name", "gate", "--json", "--jobs", "1"], env);
    assert.strictEqual(second.status, 1, second.stderr + second.stdout);
    const summary = stdoutJson(second);
    assert.strictEqual(summary.exit, 1);
    assert.strictEqual(summary.gate, "fail");
    assert.ok(summary.baseline);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit 2 when a case hard-fails", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["run", "--cases", "platform/fixtures/hardfail.json", "--adapter", "hardfail", "--json", "--jobs", "1"], env);
    assert.strictEqual(res.status, 2, res.stderr + res.stdout);
    assert.strictEqual(stdoutJson(res).exit, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit 4 when the provider key is missing", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["run", "--adapter", "dental", "--provider", "openai", "--case", "dental-quadrant-02", "--json", "--jobs", "1"], env);
    assert.strictEqual(res.status, 4, res.stderr + res.stdout);
    const lines = res.stderr.split("\n").filter((l) => l.trim());
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /OPENAI_API_KEY/);
    assert.match(lines[0], /\.env/);
    assert.strictEqual(stdoutJson(res).exit, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exit 4 when the cost ceiling is hit, with a partial summary", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--max-cost", "0", "--json", "--jobs", "1"], env);
    assert.strictEqual(res.status, 4, res.stderr + res.stdout);
    const summary = stdoutJson(res);
    assert.strictEqual(summary.exit, 4);
    assert.strictEqual(summary.stopped, "max-cost");
    assert.match(res.stderr, /--max-cost/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the same run twice is cached and costs 0 the second time", () => {
  const { env, dir } = fresh();
  try {
    const args = ["run", "--adapter", "dental", "--provider", "mock", "--name", "cache", "--json", "--jobs", "1"];
    const first = evalCli(args, env);
    assert.strictEqual(first.status, 0, first.stderr);
    const a = stdoutJson(first);
    assert.ok(a.cases.every((c: { cached: boolean; cost: number }) => c.cached === false && c.cost > 0));
    const second = evalCli(args, env);
    assert.strictEqual(second.status, 0, second.stderr + second.stdout);
    const b = stdoutJson(second);
    assert.ok(b.cases.every((c: { cached: boolean; cost: number }) => c.cached === true && c.cost === 0));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--failed-only reruns the failed case and reports how many were skipped", () => {
  const { env, dir } = fresh();
  try {
    const base = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--name", "fo", "--json", "--jobs", "1"], env);
    assert.strictEqual(base.status, 0, base.stderr);
    const bug = evalCli(["run", "--adapter", "dental", "--provider", "mock-bug", "--case", "dental-quadrant-02", "--name", "fo", "--json", "--jobs", "1"], env);
    assert.strictEqual(bug.status, 1, bug.stderr + bug.stdout);
    const again = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--failed-only", "--name", "fo", "--json", "--jobs", "1"], env);
    assert.strictEqual(again.status, 0, again.stderr + again.stdout);
    const summary = stdoutJson(again);
    assert.strictEqual(summary.skipped, 1);
    assert.deepStrictEqual(summary.cases.map((c: { id: string }) => c.id), ["dental-quadrant-02"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mock-bug show is one agent block; mishearing adds an stt block", () => {
  const { env, dir } = fresh();
  try {
    const bug = evalCli(["run", "--adapter", "dental", "--provider", "mock-bug", "--case", "dental-fullmouth-01", "--name", "bug", "--json", "--jobs", "1"], env);
    assert.strictEqual(bug.status, 0, bug.stderr + bug.stdout);
    const show = evalCli(["show", "--run", stdoutJson(bug).runId, "--case", "dental-fullmouth-01"], env);
    assert.strictEqual(show.status, 0, show.stderr);
    const blocks = JSON.parse(show.stdout) as { layer: string }[];
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].layer, "agent");

    const both = evalCli(["run", "--cases", "platform/fixtures/layers.json", "--adapter", "fixture", "--provider", "mock-bug", "--name", "layers", "--json", "--jobs", "1"], env);
    assert.strictEqual(both.status, 0, both.stderr + both.stdout);
    const shown = evalCli(["show", "--run", stdoutJson(both).runId, "--case", "fixture-layers"], env);
    const layers = JSON.parse(shown.stdout) as { layer: string; at: string }[];
    assert.deepStrictEqual(layers.map((b) => b.layer).sort(), ["agent", "stt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("eval diff prints only the cell that changed", () => {
  const { env, dir } = fresh();
  try {
    const a = evalCli(["run", "--adapter", "dental", "--provider", "mock", "--case", "dental-fullmouth-01", "--name", "da", "--json", "--jobs", "1"], env);
    const b = evalCli(["run", "--adapter", "dental", "--provider", "mock-bug", "--case", "dental-fullmouth-01", "--name", "db", "--json", "--jobs", "1"], env);
    assert.strictEqual(a.status, 0, a.stderr);
    assert.strictEqual(b.status, 1, b.stderr + b.stdout);
    const diff = evalCli(["diff", "--a", "da", "--b", "db"], env);
    assert.strictEqual(diff.status, 0, diff.stderr);
    const cells = JSON.parse(diff.stdout) as { at: string; layer: string; case: string }[];
    assert.ok(cells.length >= 1);
    assert.ok(cells.every((c) => c.at === "tooth:14"));
    assert.ok(cells.every((c) => c.layer === "agent"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every repeat is kept", () => {
  const { env, dir } = fresh();
  try {
    const res = evalCli(["run", "--cases", "adapters/sample-case.json", "--adapter", "sample", "--repeat", "2", "--name", "rep", "--json", "--jobs", "1"], env);
    assert.strictEqual(res.status, 0, res.stderr + res.stdout);
    const summary = stdoutJson(res);
    const caseDir = join(env.EVAL_RESULTS as string, "sample", summary.runId, "cases", "sample-reminder-01");
    assert.ok(existsSync(join(caseDir, "repeat-1", "events.json")));
    assert.ok(existsSync(join(caseDir, "repeat-2", "score.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n${passed} passed`);

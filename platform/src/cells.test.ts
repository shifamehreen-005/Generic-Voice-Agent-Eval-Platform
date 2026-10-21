import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreCells } from "./cells.ts";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log("  \x1b[32m✓\x1b[0m " + name); };

console.log("cell scorer");

const gold = { cells: { "field:a": [1, 2, 3], "field:b": 4, "row:14": "x" } };

test("MISSING when the gold cell was never written", () => {
  const s = scoreCells({ "field:a": [1, 2, 3], "field:b": 4 }, gold);
  assert.strictEqual(s.mismatches.find((m) => m.at === "row:14")?.class, "MISSING");
});

test("WRONG when the value differs and tolerance is zero", () => {
  const s = scoreCells({ "field:a": [1, 2, 3], "field:b": 5, "row:14": "x" }, gold);
  assert.strictEqual(s.mismatches.find((m) => m.at === "field:b")?.class, "WRONG");
  const loose = scoreCells({ "field:a": [1, 2, 3], "field:b": 5, "row:14": "x" }, gold, { tolerance: 1 });
  assert.ok(!loose.mismatches.some((m) => m.at === "field:b"));
});

test("SHIFTED when the gold value landed on a neighbour", () => {
  const s = scoreCells(
    { "field:a": [1, 2, 3], "field:c": 4, "row:14": "x" },
    { cells: gold.cells, neighbors: { "field:b": ["field:c"] } },
  );
  assert.strictEqual(s.mismatches.find((m) => m.at === "field:b")?.class, "SHIFTED");
});

test("TRANSPOSED when the same numbers are in the wrong order", () => {
  const s = scoreCells({ "field:a": [3, 2, 1], "field:b": 4, "row:14": "x" }, gold);
  assert.strictEqual(s.mismatches.find((m) => m.at === "field:a")?.class, "TRANSPOSED");
});

test("EXTRA is its own mismatch and its own count", () => {
  const s = scoreCells({ "field:a": [1, 2, 3], "field:b": 4, "row:14": "x", "field:z": 9 }, gold);
  assert.strictEqual(s.mismatches.find((m) => m.at === "field:z")?.class, "EXTRA");
  assert.strictEqual(s.extras, 1);
  assert.strictEqual(s.metrics.clean.value, 0);
});

test("corrections are applied before scoring", () => {
  const s = scoreCells(
    { "field:a": [1, 2, 3], "field:b": 9, "row:14": "x" },
    { cells: gold.cells, corrections: [{ at: "field:b", value: 9 }] },
  );
  assert.strictEqual(s.composite, 1);
});

test("three metric weights sum to 1", () => {
  const s = scoreCells({ "field:a": [1, 2, 3], "field:b": 4, "row:14": "x" }, gold);
  const sum = Object.values(s.weights).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 1);
  assert.deepStrictEqual(Object.keys(s.metrics).sort(), ["clean", "exact", "presence"]);
});

test("the sample template passes on mock, fails the gate on mock-bug, and has three metric columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-cells-"));
  const env = { ...process.env, EVAL_RESULTS: join(dir, "results"), EVAL_CACHE: join(dir, "cache") };
  delete env.OPENAI_API_KEY;
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  const run = (args: string[]) => spawnSync(tsx, ["platform/src/cli.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8", timeout: 30_000 });
  try {
    const good = run(["run", "--cases", "adapters/sample-case.json", "--adapter", "sample", "--provider", "mock", "--json", "--jobs", "1", "--name", "sample"]);
    assert.strictEqual(good.status, 0, good.stderr + good.stdout);
    const summary = JSON.parse(good.stdout.trim());
    const report = JSON.parse(readFileSync(join(env.EVAL_RESULTS, "sample", summary.runId, "report.json"), "utf8"));
    const keys = (report.cases[0].metrics as { key: string }[]).map((m) => m.key);
    assert.ok(keys.length >= 3, keys.join(","));
    const bad = run(["run", "--cases", "adapters/sample-case.json", "--adapter", "sample", "--provider", "mock-bug", "--json", "--jobs", "1", "--name", "sample"]);
    assert.strictEqual(bad.status, 1, bad.stderr + bad.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed`);

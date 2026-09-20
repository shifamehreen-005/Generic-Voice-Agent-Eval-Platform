// ============================================================================
// score.test.ts — the dental scorer is a pure function, unit-tested with no
// model and no key (spec §18). Run: npx tsx demo/adapters/dental/score.test.ts
// ============================================================================
import assert from "node:assert";
import adapter from "./adapter.ts";

const gt = { teeth: { "14": [3, 2, 4], "15": [2, 2, 3], "18": [4, 5, 4] } };

let passed = 0;
const test = (n: string, f: () => void) => { f(); passed++; console.log("  \x1b[32m✓\x1b[0m " + n); };

console.log("dental scorer");

test("exact charting scores 100%", () => {
  const s = adapter.score!({ "14": [3, 2, 4], "15": [2, 2, 3], "18": [4, 5, 4] }, gt as any, {});
  assert.strictEqual(s.metrics.teeth.value, 1);
  assert.strictEqual(s.mismatches.length, 0);
});

test("a depth within 1mm still counts (tolerance)", () => {
  const s = adapter.score!({ "14": [3, 2, 5], "15": [2, 2, 3], "18": [4, 5, 4] }, gt as any, {});
  assert.strictEqual(s.metrics.teeth.value, 1, "5 vs 4 is within 1mm");
});

test("a depth off by 2mm is WRONG", () => {
  const s = adapter.score!({ "14": [3, 2, 6], "15": [2, 2, 3], "18": [4, 5, 4] }, gt as any, {});
  assert.ok(s.metrics.teeth.value < 1);
  assert.strictEqual(s.mismatches[0].class, "WRONG");
});

test("right numbers in wrong order (beyond tolerance) is TRANSPOSED", () => {
  // reorder must exceed ±1mm to count as an error rather than a tolerated match
  const g = { teeth: { "14": [2, 4, 7] } };
  const s = adapter.score!({ "14": [7, 4, 2] }, g as any, {});
  assert.strictEqual(s.mismatches[0].class, "TRANSPOSED");
});

test("charting an unrequested tooth counts as an extra (hallucination)", () => {
  const s = adapter.score!({ "14": [3, 2, 4], "15": [2, 2, 3], "18": [4, 5, 4], "99": [1, 1, 1] }, gt as any, {});
  assert.strictEqual(s.extras, 1);
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m\n`);

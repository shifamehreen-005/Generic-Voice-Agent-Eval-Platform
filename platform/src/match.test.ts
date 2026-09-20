// ============================================================================
// match.test.ts — locks in the comparison rules so a grader can't silently
// become unfair. Every fairness bug we hit lives here as a test, so it can
// never come back. Run: npx tsx platform/src/match.test.ts
// ============================================================================
import assert from "node:assert";
import { eqText, eqEnum, nearNum, sameSet, eqDate, eqTime } from "./match.ts";

let passed = 0;
const test = (n: string, f: () => void) => { f(); passed++; console.log("  \x1b[32m✓\x1b[0m " + n); };
console.log("match primitives");

test("text ignores case and punctuation (check-up == checkup)", () => {
  assert.ok(eqText("Check-Up", "checkup"));
  assert.ok(eqText("Marcus Bell", "marcus  bell"));
  assert.ok(!eqText("Sara", "Sarah"));
});

test("enum synonyms match", () => {
  assert.ok(eqEnum("exam", "checkup", [["checkup", "check up", "exam"]]));
  assert.ok(!eqEnum("cleaning", "checkup", [["checkup", "exam"]]));
});

test("numbers match within tolerance", () => {
  assert.ok(nearNum(3, 4, 1));
  assert.ok(!nearNum(3, 5, 1));
});

test("set equality ignores order", () => {
  assert.ok(sameSet([2, 3, 4], [4, 2, 3]));
  assert.ok(!sameSet([2, 3, 4], [2, 3, 5]));
});

test("dates match on month+day, ignoring an unspoken year (2023 vs 2026)", () => {
  assert.ok(eqDate("2023-10-03", "2026-10-03"));       // agent guessed the year — still correct
  assert.ok(eqDate("October 3rd", "2026-10-03"));
  assert.ok(eqDate("10/3", "2026-10-03"));
  assert.ok(!eqDate("2026-10-04", "2026-10-03"));      // wrong day is still wrong
});

test("dates can require the year when it was actually spoken", () => {
  assert.ok(!eqDate("2023-10-03", "2026-10-03", { requireYear: true }));
  assert.ok(eqDate("2026-10-03", "2026-10-03", { requireYear: true }));
});

test("times normalize 12h/24h (2pm == 14:00)", () => {
  assert.ok(eqTime("2pm", "14:00"));
  assert.ok(eqTime("9 AM", "09:00"));
  assert.ok(!eqTime("2pm", "14:30"));
});

console.log(`\n\x1b[32m${passed} passed\x1b[0m`);

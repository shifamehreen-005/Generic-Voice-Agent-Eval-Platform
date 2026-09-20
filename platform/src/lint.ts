// ============================================================================
// lint.ts — the ground-truth gate (spec §8).
//
// Runs schema validation FIRST, then the adapter's domain rules. An `error`
// blocks the case from entering the set; a `warn` shows in the report. This is
// what stops a silver (model-drafted) case with an off-by-one from quietly
// setting your score ceiling.
// ============================================================================
import type { Case, LintFinding } from "./types.ts";
import { getAdapter } from "./adapter.ts";
import { validateSchema } from "./loader.ts";

export function lintCase(c: Case): LintFinding[] {
  const adapter = getAdapter(c.adapter);
  const findings: LintFinding[] = [];

  // 1. schema validation
  if (adapter.groundTruthSchema) {
    for (const msg of validateSchema(c.groundTruth, adapter.groundTruthSchema)) {
      findings.push({ rule: "schema", severity: "error", message: msg });
    }
  }

  // 2. adapter domain rules (only if schema passed — garbage in, garbage rules)
  if (!findings.some((f) => f.severity === "error") && adapter.lint) {
    findings.push(...adapter.lint(c.groundTruth as never, c));
  }
  return findings;
}

export function lintSet(cases: Case[]): Map<string, LintFinding[]> {
  const out = new Map<string, LintFinding[]>();
  for (const c of cases) {
    const f = lintCase(c);
    if (f.length) out.set(c.id, f);
  }
  return out;
}

export function hasBlockingError(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

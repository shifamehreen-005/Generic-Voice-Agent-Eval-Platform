// ============================================================================
// util.ts — small shared helpers. Kept dependency-free.
//
// Every artifact this platform writes must be JSON-diffable (spec §18): stable
// key order and stable float formatting, so a run-to-run diff shows only what
// actually changed.
// ============================================================================
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

/** Deterministic JSON: object keys sorted recursively, floats fixed to 4dp. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === "number" && !Number.isInteger(v)) {
    return Number(v.toFixed(4));
  }
  return v;
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** Normalized substring match used by the judge anchor check (spec §9.4). */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return "no-git";
  }
}

export function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** p-th percentile of a numeric array (0..100). */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

// tiny ANSI helpers for the console
export const c = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

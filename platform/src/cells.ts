// A scorer for structured state: cells keyed by a location string.
// Tolerance defaults to zero. A tolerance is a per-domain choice.
import type { Mismatch, Score } from "./types.ts";

export interface CellCorrection { at: string; value: unknown }
export interface CellGold {
  cells: Record<string, unknown>;
  corrections?: CellCorrection[];
  neighbors?: Record<string, string[]>;
}

const EMPTY = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] as [] };

function same(a: unknown, b: unknown, tol: number): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i], tol));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function bag(xs: unknown[]): string[] {
  return xs.map((x) => JSON.stringify(x)).sort();
}

function transposed(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 2) return false;
  return JSON.stringify(a) !== JSON.stringify(b) && JSON.stringify(bag(a)) === JSON.stringify(bag(b));
}

function autoNeighbors(key: string, keys: string[]): string[] {
  const m = /^(.*?)(\d+)$/.exec(key);
  if (!m) return [];
  const n = Number(m[2]);
  return keys.filter((k) => k === `${m[1]}${n - 1}` || k === `${m[1]}${n + 1}`);
}

function applyCorrections(gt: CellGold): Record<string, unknown> {
  const cells = { ...(gt.cells ?? {}) };
  for (const c of gt.corrections ?? []) cells[c.at] = c.value;
  return cells;
}

/**
 * Grade produced cells against gold.
 * Metrics (weights sum to 1): exact 0.5, presence 0.3, clean 0.2.
 * `extras` is the count of produced cells with no gold, reported on its own.
 */
export function scoreCells(
  produced: Record<string, unknown>, gold: CellGold, opts: { tolerance?: number } = {},
): Score {
  const tol = opts.tolerance ?? 0;
  const cells = applyCorrections(gold);
  const producedKeys = Object.keys(produced ?? {});
  const goldKeys = Object.keys(cells);
  const mismatches: Mismatch[] = [];
  let exact = 0;
  let present = 0;

  for (const key of goldKeys) {
    const exp = cells[key];
    const has = Object.prototype.hasOwnProperty.call(produced, key);
    const got = produced[key];
    if (has && same(got, exp, tol)) { exact++; present++; continue; }
    if (has) present++;
    const neighbors = [...(gold.neighbors?.[key] ?? []), ...autoNeighbors(key, producedKeys)];
    const shifted = neighbors.some((n) => Object.prototype.hasOwnProperty.call(produced, n) && same(produced[n], exp, 0));
    let cls = "WRONG";
    if (!has && shifted) cls = "SHIFTED";
    else if (!has) cls = "MISSING";
    else if (transposed(got, exp)) cls = "TRANSPOSED";
    else if (shifted) cls = "SHIFTED";
    mismatches.push({ class: cls, at: key, expected: exp, produced: has ? got : null });
  }

  const extras = producedKeys.filter((k) => !Object.prototype.hasOwnProperty.call(cells, k));
  for (const key of extras) {
    mismatches.push({ class: "EXTRA", at: key, expected: null, produced: produced[key] });
  }

  const exactValue = goldKeys.length ? exact / goldKeys.length : 1;
  const presenceValue = goldKeys.length ? present / goldKeys.length : 1;
  const cleanValue = extras.length ? 0 : 1;
  return {
    metrics: {
      exact: { value: exactValue, total: goldKeys.length, correct: exact },
      presence: { value: presenceValue, total: goldKeys.length, correct: present },
      clean: { value: cleanValue, total: 1, correct: cleanValue },
    },
    weights: { exact: 0.5, presence: 0.3, clean: 0.2 },
    composite: 0.5 * exactValue + 0.3 * presenceValue + 0.2 * cleanValue,
    mismatches,
    extras: extras.length,
    stats: { ...EMPTY },
  };
}

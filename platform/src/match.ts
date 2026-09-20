// ============================================================================
// match.ts — reusable, UNIT-TESTED comparison primitives for adapter scorers.
//
// Why this exists: an eval is only trustworthy if the *grader* is correct. The
// fragile part of any grader is "are these two answers equal?" — dates in three
// formats, "check-up" vs "checkup", "2pm" vs "14:00", a depth within tolerance.
// If every adapter hand-rolls === for these, every adapter re-invents (and
// re-breaks) the same edge cases.
//
// So domain scorers compare answers with THESE helpers instead. Fairness is
// solved once and tested once (see match.test.ts) — not per agent, not per
// domain. A new agent in an existing domain reuses its scorer unchanged; a new
// domain composes these primitives rather than writing brittle equality checks.
// ============================================================================

/** Lowercase and strip everything but letters/digits, so punctuation, spacing
 *  and case never cause a false mismatch. "Check-Up" == "checkup". */
export function normText(s?: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
export function eqText(a?: string, b?: string): boolean {
  return normText(a) === normText(b);
}

/** Enum match with optional synonym groups, e.g. eqEnum("exam","checkup",
 *  [["checkup","check up","exam"]]) === true. */
export function eqEnum(a?: string, b?: string, synonyms: string[][] = []): boolean {
  if (eqText(a, b)) return true;
  const na = normText(a), nb = normText(b);
  return synonyms.some((group) => {
    const g = group.map(normText);
    return g.includes(na) && g.includes(nb);
  });
}

/** Numeric equality within a tolerance (e.g. a pocket depth within ±1 mm). */
export function nearNum(a: number, b: number, tol = 0): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
}

/** Order-insensitive equality of two multisets (same values, any order). */
export function sameSet(a: (string | number)[], b: (string | number)[]): boolean {
  if (a.length !== b.length) return false;
  const key = (xs: (string | number)[]) => xs.map((x) => String(x)).sort().join("|");
  return key(a) === key(b);
}

// ---- dates -----------------------------------------------------------------
const MONTHS: Record<string, number> = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
export interface ParsedDate { y?: number; m: number; d: number }

/** Parse ISO (2026-10-03), M/D[/Y], "October 3rd", "3 Oct" → {y?,m,d}. */
export function parseDate(s?: string): ParsedDate | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  let mo: RegExpExecArray | null;
  if ((mo = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) return { y: +mo[1], m: +mo[2], d: +mo[3] };
  if ((mo = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t))) return { m: +mo[1], d: +mo[2], y: mo[3] ? +mo[3] : undefined };
  if ((mo = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/.exec(t))) {
    const m = MONTHS[mo[1].slice(0, mo[1].startsWith("sept") ? 4 : 3)]; if (m) return { m, d: +mo[2], y: mo[3] ? +mo[3] : undefined };
  }
  if ((mo = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})/.exec(t))) {
    const m = MONTHS[mo[2].slice(0, mo[2].startsWith("sept") ? 4 : 3)]; if (m) return { m, d: +mo[1] };
  }
  return null;
}

/** Compare dates on month + day. A spoken request rarely states a year, so the
 *  agent can only guess one — requiring an exact year would fail a correct
 *  booking. Pass {requireYear:true} only when the year was actually spoken. */
export function eqDate(a?: string, b?: string, opts: { requireYear?: boolean } = {}): boolean {
  const pa = parseDate(a), pb = parseDate(b);
  if (!pa || !pb) return eqText(a, b);              // fall back to text if unparseable
  if (pa.m !== pb.m || pa.d !== pb.d) return false;
  if (opts.requireYear) return pa.y != null && pa.y === pb.y;
  return true;
}

// ---- times -----------------------------------------------------------------
/** Normalize "2pm", "2 PM", "14:00", "14" → "HH:MM" (24h). */
export function normTime(s?: string): string | null {
  if (!s) return null;
  const m = /^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1]; const mm = m[2] ? +m[2] : 0; const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
export function eqTime(a?: string, b?: string): boolean {
  const na = normTime(a);
  return na != null && na === normTime(b);
}

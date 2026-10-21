// Load a saved segment file, and optionally flip operator speakers to "UU".
import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Case, TranscriptSegment } from "./types.ts";
import { ConfigError } from "./errors.ts";
import { sha1 } from "./util.ts";

function resolveSegmentsPath(file: string): string {
  if (isAbsolute(file)) return file;
  const candidates = [join(process.cwd(), file)];
  for (const p of candidates) if (existsSync(p)) return p;
  return join(process.cwd(), file);
}

export function loadSegmentsFile(c: Case): TranscriptSegment[] {
  if (!c.segmentsFile) {
    throw new ConfigError(`${c.id}: field "segmentsFile" is missing.`);
  }
  const path = resolveSegmentsPath(c.segmentsFile);
  if (!existsSync(path)) {
    throw new ConfigError(`${c.id}: field "segmentsFile" points at ${c.segmentsFile}, which does not exist. Write a JSON list of segments there.`);
  }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new ConfigError(`${c.id}: field "segmentsFile" is not valid JSON. Fix ${path}.`); }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${c.id}: field "segmentsFile" must be a non-empty JSON list. Each item needs id, text, speaker, startMs, durationMs, isFinal.`);
  }
  const segments: TranscriptSegment[] = raw.map((item, i) => {
    const s = item as Partial<TranscriptSegment>;
    if (typeof s.text !== "string" || typeof s.speaker !== "string" || typeof s.startMs !== "number") {
      throw new ConfigError(`${c.id}: field "segmentsFile" item ${i} needs text, speaker, and startMs.`);
    }
    return {
      id: typeof s.id === "number" ? s.id : i,
      text: s.text,
      speaker: s.speaker,
      startMs: s.startMs,
      durationMs: typeof s.durationMs === "number" ? s.durationMs : 0,
      isFinal: s.isFinal !== false,
      confidence: s.confidence,
    };
  });
  segments.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
  return segments;
}

/**
 * Flip `fraction` of the operator segments to speaker "UU".
 * Operator ids are `roster` (the people the agent is allowed to act on).
 * The choice is a pure function of seed + segment id.
 */
export function corruptSpeakers(
  segments: TranscriptSegment[], fraction: number, seed: number, roster: string[],
): TranscriptSegment[] {
  if (!(fraction > 0) || roster.length === 0) return segments;
  const ops = segments.filter((s) => roster.includes(s.speaker));
  const n = Math.round(ops.length * fraction);
  if (n <= 0) return segments;
  const ranked = [...ops].sort((a, b) => sha1(`${seed}:${a.id}`).localeCompare(sha1(`${seed}:${b.id}`)));
  const flip = new Set(ranked.slice(0, n).map((s) => s.id));
  return segments.map((s) => flip.has(s.id) ? { ...s, speaker: "UU" } : s);
}

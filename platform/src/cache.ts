// ============================================================================
// cache.ts — capture once, replay many (spec §10). Mandatory, not optional.
//
// The single biggest lever on cost and determinism. In "live" mode we run audio
// through (simulated) STT and write the segments to a cache keyed by
// (caseId, sttProvider, sttConfigHash, audioFileHash). In "replay" mode we feed
// those cached segments straight to the agent, so STT variance is removed from
// the measurement while you tune a prompt. Any change to a key component
// invalidates the entry — we never silently reuse segments from a different STT
// config.
//
// There is no real audio in this reference build, so `audioFileHash` is derived
// from the reference transcript. Swap `capture()` for a real STT call to go live.
// ============================================================================
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Case, TranscriptSegment } from "./types.ts";
import { sha1, stableStringify } from "./util.ts";
import { transcribeOpenAI } from "./providers.ts";

export type SttMode = "mock" | "openai";

const CACHE_DIR = join(process.cwd(), ".cache", "segments");

export interface SttConfig {
  provider: string;
  configHash: string;             // hash of provider settings (model, lang, ...)
}

export const DEFAULT_STT: SttConfig = { provider: "mock-stt", configHash: sha1("v1") };

export function sttConfigFor(mode: SttMode): SttConfig {
  return mode === "openai"
    ? { provider: "openai-stt", configHash: sha1("openai") }
    : { provider: "mock-stt", configHash: sha1("mock") };
}

function audioFileHash(c: Case): string {
  // stand-in for hashing real audio bytes
  return sha1(c.referenceTranscript ?? c.transcriptText ?? c.id);
}

function keyFor(c: Case, stt: SttConfig): string {
  return sha1([c.id, stt.provider, stt.configHash, audioFileHash(c)].join("|"));
}

export function cacheHit(c: Case, stt: SttConfig = DEFAULT_STT): boolean {
  return existsSync(join(CACHE_DIR, keyFor(c, stt) + ".json"));
}

export function readCache(c: Case, stt: SttConfig = DEFAULT_STT): TranscriptSegment[] | null {
  const p = join(CACHE_DIR, keyFor(c, stt) + ".json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")).segments;
}

export function writeCache(c: Case, segments: TranscriptSegment[], stt: SttConfig = DEFAULT_STT): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const p = join(CACHE_DIR, keyFor(c, stt) + ".json");
  writeFileSync(p, stableStringify({ caseId: c.id, stt, segments }));
}

/**
 * STT capture. In "mock" mode it splits the reference transcript into timed
 * segments and injects one deterministic mishearing so layer-1 WER is nonzero
 * and honest (no key, runs anywhere). In "openai" mode it transcribes the real
 * audio file with OpenAI — that is the real speech-to-text path.
 */
export async function capture(c: Case, mode: SttMode = "mock", stt: SttConfig = DEFAULT_STT): Promise<TranscriptSegment[]> {
  let text: string;
  if (mode === "openai") {
    if (!c.audioFile) throw new Error(`case ${c.id}: --stt openai needs an audioFile`);
    // audio clips live next to the demo cases (gen-audio writes them here)
    const path = join(process.cwd(), "demo", "cases", "audio", c.audioFile);
    text = await transcribeOpenAI(path);              // REAL speech-to-text
  } else {
    const words = (c.referenceTranscript ?? c.transcriptText ?? "").split(/\s+/).filter(Boolean);
    // deterministic fake error: swap the first "four" for "five" if present
    text = words.map((w) => (w.toLowerCase().replace(/[.,]/g, "") === "four" ? "five" : w)).join(" ");
  }
  const seg: TranscriptSegment = {
    id: 0, text, speaker: c.speakers?.primary ?? "S1",
    startMs: 0, durationMs: Math.max(1000, text.split(/\s+/).length * 300), isFinal: true,
  };
  const segments = [seg];
  writeCache(c, segments, sttConfigFor(mode));
  return segments;
}

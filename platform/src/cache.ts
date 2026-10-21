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
import { cacheRoot } from "./paths.ts";
import { splitUtterances } from "./utter.ts";
import { ConfigError } from "./errors.ts";

export type SttMode = "mock" | "openai";

function cacheDir(): string {
  return join(cacheRoot(), "segments");
}

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
  return existsSync(join(cacheDir(), keyFor(c, stt) + ".json"));
}

export function readCache(c: Case, stt: SttConfig = DEFAULT_STT): TranscriptSegment[] | null {
  const p = join(cacheDir(), keyFor(c, stt) + ".json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")).segments;
}

export function writeCache(c: Case, segments: TranscriptSegment[], stt: SttConfig = DEFAULT_STT): void {
  mkdirSync(cacheDir(), { recursive: true });
  const p = join(cacheDir(), keyFor(c, stt) + ".json");
  writeFileSync(p, stableStringify({ caseId: c.id, stt, segments }));
}

/** Flip the first spoken "four" to "five", once per capture. Other words stay. */
function mishear(text: string, state: { done: boolean }): string {
  if (state.done) return text;
  const words = text.split(/\s+/);
  let changed = false;
  const out = words.map((w) => {
    if (!state.done && w.toLowerCase().replace(/[^a-z]/g, "") === "four") {
      state.done = true;
      changed = true;
      return w.replace(/four/i, "five");
    }
    return w;
  });
  return changed ? out.join(" ") : text;
}

/**
 * STT capture. In "mock" mode it splits the reference transcript into timed
 * segments and injects one deterministic mishearing so layer-1 WER is nonzero
 * and honest (no key, runs anywhere). In "openai" mode it transcribes the real
 * audio file with OpenAI — that is the real speech-to-text path.
 */
export async function capture(c: Case, mode: SttMode = "mock", stt: SttConfig = DEFAULT_STT): Promise<TranscriptSegment[]> {
  let full: string;
  if (mode === "openai") {
    if (!c.audioFile) throw new ConfigError(`${c.id}: field "audioFile" is missing. --stt openai needs audioFile set to a clip.`);
    // audio clips live next to the demo cases (gen-audio writes them here)
    const path = join(process.cwd(), "demo", "cases", "audio", c.audioFile);
    full = await transcribeOpenAI(path);              // REAL speech-to-text
  } else {
    full = c.referenceTranscript ?? c.transcriptText ?? "";
  }
  const state = { done: false };
  const parts = splitUtterances(full);
  const texts = (parts.length ? parts : [""]).map((p) => (mode === "openai" ? p : mishear(p, state)));
  const segments: TranscriptSegment[] = texts.map((text, i) => ({
    id: i,
    text,
    speaker: c.speakers?.primary ?? "S1",
    startMs: i * 1000,
    durationMs: Math.max(300, text.split(/\s+/).filter(Boolean).length * 300),
    isFinal: true,
  }));
  writeCache(c, segments, sttConfigFor(mode));
  return segments;
}

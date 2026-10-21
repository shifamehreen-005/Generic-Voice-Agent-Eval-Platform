// Cache of the agent's events. A rerun with the same case, segments, adapter
// version, model, prompt and seed replays this and costs nothing.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RunStats } from "./types.ts";
import type { TranscriptSegment } from "./types.ts";
import { sha1, stableStringify } from "./util.ts";
import { cacheRoot } from "./paths.ts";

export interface AgentCacheHit {
  events: AgentEvent[];
  transcriptText: string;
  stats: RunStats;
  hardFail?: string;
}

function dir(): string {
  return join(cacheRoot(), "events");
}

export function agentCacheKey(parts: {
  caseId: string;
  segments: TranscriptSegment[];
  adapterVersion: string;
  model: string;
  promptHash: string;
  seed: number;
}): string {
  return sha1([
    parts.caseId,
    sha1(stableStringify(parts.segments)),
    parts.adapterVersion,
    parts.model,
    parts.promptHash,
    String(parts.seed),
  ].join("|"));
}

export function readAgentCache(key: string): AgentCacheHit | null {
  const p = join(dir(), key + ".json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as AgentCacheHit; }
  catch { return null; }
}

export function writeAgentCache(key: string, hit: AgentCacheHit): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), key + ".json"), stableStringify(hit));
}

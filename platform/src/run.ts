// ============================================================================
// run.ts — the run loop (spec §2, §7, §10, §11 variance).
//
// For each case: resolve segments (capture in live / read cache in replay),
// drive the adapter --repeat N times, score every repeat, keep the first
// repeat's artifacts, and report mean/min/max composite with an unstable flag.
// ============================================================================
import type { Case, RunOpts, TranscriptSegment, AgentEvent } from "./types.ts";
import { getAdapter } from "./adapter.ts";
import { scoreCase, type CaseResult } from "./score.ts";
import { capture, readCache, sttConfigFor, type SttMode } from "./cache.ts";
import { mockJudge } from "./mockJudge.ts";
import { makeLlmJudge } from "./llmJudge.ts";
import { explainCase, explainCaseLLM } from "./explain.ts";
import { round, c } from "./util.ts";

export type OnStep = (caseId: string, step: string) => void;

export interface RepeatAgg { mean: number; min: number; max: number; unstable: boolean }
export interface CaseRun {
  result: CaseResult;
  spread: RepeatAgg;
  artifacts: { events: AgentEvent[]; segments: TranscriptSegment[]; trace: string; judge: unknown };
}

const UNSTABLE_SPREAD = 0.05;

async function resolveSegments(cs: Case, mode: "live" | "replay", stt: SttMode): Promise<TranscriptSegment[]> {
  const cfg = sttConfigFor(stt);
  // pre-captured segments on the case take precedence
  // (segmentsFile handling would load here; omitted in this reference build)
  if (mode === "live") {
    return await capture(cs, stt, cfg);              // hits STT (real or mock), writes cache
  }
  const cached = readCache(cs, cfg);
  if (cached) return cached;                        // quiet: live progress shows status
  return await capture(cs, stt, cfg);               // no cache yet → capture once
}

function buildTrace(events: AgentEvent[]): string {
  return events.map((e) => {
    const t = String(e.atMs).padStart(6) + "ms";
    if (e.kind === "tool_call") return `${t}  CALL  ${e.name}(${JSON.stringify(e.args ?? {})})`;
    if (e.kind === "tool_result") return `${t}  RES   ok=${e.ok}${e.error ? " err=" + e.error : ""}`;
    if (e.kind === "assistant_text") return `${t}  TEXT  ${String(e.data ?? "")}`;
    if (e.kind === "state_change") return `${t}  STATE ${JSON.stringify(e.data ?? {})}`;
    return `${t}  END`;
  }).join("\n");
}

export async function runCase(cs: Case, mode: "live" | "replay", repeat: number,
                              model?: string, prompt?: string, stt: SttMode = "mock",
                              onStep?: OnStep): Promise<CaseRun> {
  const adapter = getAdapter(cs.adapter);
  onStep?.(cs.id, "transcribing");
  const segments = await resolveSegments(cs, mode, stt);

  const composites: number[] = [];
  let first: CaseResult | null = null;
  let firstEvents: AgentEvent[] = [];
  let firstJudge: unknown = null;

  // real provider => real LLM judge; otherwise the offline mock judge
  const judgeClient = (model === "openai" || model === "anthropic") ? makeLlmJudge(model) : mockJudge;

  for (let i = 0; i < repeat; i++) {
    const opts: RunOpts = { mode, segments, model, systemPromptOverride: prompt, seed: i };
    onStep?.(cs.id, i === 0 ? "running agent" : `repeat ${i + 1}`);
    const rr = await adapter.run(cs, opts);
    const result = await scoreCase(adapter, cs, rr, judgeClient);
    composites.push(result.score.composite);
    if (i === 0) { first = result; firstEvents = rr.events; firstJudge = result.judge; }
  }

  // plain-English explanation (LLM when a real provider is set, else deterministic)
  first!.explanation = (model === "openai" || model === "anthropic")
    ? await explainCaseLLM(first!, model)
    : explainCase(first!);

  const mean = round(composites.reduce((a, b) => a + b, 0) / composites.length);
  const min = Math.min(...composites), max = Math.max(...composites);
  return {
    result: first!,
    spread: { mean, min, max, unstable: max - min > UNSTABLE_SPREAD },
    artifacts: { events: firstEvents, segments, trace: buildTrace(firstEvents), judge: firstJudge },
  };
}

export async function runSet(cases: Case[], mode: "live" | "replay", repeat: number,
                             model?: string, prompt?: string, stt: SttMode = "mock",
                             onStep?: OnStep, onDone?: (r: CaseRun) => void): Promise<CaseRun[]> {
  const out: CaseRun[] = [];
  for (const cs of cases) {
    const r = await runCase(cs, mode, repeat, model, prompt, stt, onStep);
    onDone?.(r);
    out.push(r);
  }
  return out;
}

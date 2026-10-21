// ============================================================================
// run.ts — the run loop.
//
// For each case: resolve segments (capture in live / read cache in replay),
// drive the adapter --repeat N times, score every repeat, keep every repeat's
// artifacts, and report mean/min/max composite with an unstable flag.
//
// Agent events are cached. An unchanged rerun replays them and costs nothing.
// ============================================================================
import type { Case, RunOpts, RunResult, TranscriptSegment, AgentEvent } from "./types.ts";
import { getAdapter } from "./adapter.ts";
import { scoreCase, type CaseResult } from "./score.ts";
import { capture, readCache, sttConfigFor, type SttMode } from "./cache.ts";
import { mockJudge } from "./mockJudge.ts";
import { makeLlmJudge } from "./llmJudge.ts";
import { explainCase, explainCaseLLM } from "./explain.ts";
import { round } from "./util.ts";
import { sha1 } from "./util.ts";
import { agentCacheKey, readAgentCache, writeAgentCache } from "./agentCache.ts";
import { ProviderError, isProviderMessage, oneLine } from "./errors.ts";

export type OnStep = (caseId: string, step: string) => void;

export interface RepeatArtifact {
  n: number;
  events: AgentEvent[];
  score: CaseResult["score"];
  trace: string;
  cached: boolean;
}

export interface RepeatAgg { mean: number; min: number; max: number; unstable: boolean }
export interface CaseRun {
  result: CaseResult;
  spread: RepeatAgg;
  artifacts: {
    events: AgentEvent[];
    segments: TranscriptSegment[];
    trace: string;
    judge: unknown;
    repeats: RepeatArtifact[];
  };
}

export interface RunControl {
  noCache: boolean;
  maxCostUsd: number;
  jobs: number;
  failFast: boolean;
  explain: boolean;
  onStep?: OnStep;
  onDone?: (r: CaseRun) => void;
  log?: (line: string) => void;
}

export interface RunSetResult {
  runs: CaseRun[];
  stop?: "max-cost" | "fail-fast" | "provider";
  error?: string;
}

const UNSTABLE_SPREAD = 0.05;
const ZERO_COST = { estCostUsd: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 };

async function resolveSegments(cs: Case, mode: "live" | "replay", stt: SttMode): Promise<TranscriptSegment[]> {
  const cfg = sttConfigFor(stt);
  if (mode === "live") return await capture(cs, stt, cfg);
  const cached = readCache(cs, cfg);
  if (cached) return cached;
  return await capture(cs, stt, cfg);
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

function asProvider(e: unknown): unknown {
  if (e instanceof ProviderError) return e;
  if (e instanceof Error && isProviderMessage(e.message)) return new ProviderError(oneLine(e));
  return e;
}

export async function runCase(cs: Case, mode: "live" | "replay", repeat: number,
                              model: string | undefined, prompt: string | undefined, stt: SttMode,
                              control: RunControl): Promise<CaseRun> {
  const adapter = getAdapter(cs.adapter);
  control.onStep?.(cs.id, "transcribing");
  control.log?.(`${cs.id} transcribing`);
  const segments = await resolveSegments(cs, mode, stt);

  const judgeClient = (model === "openai" || model === "anthropic") ? makeLlmJudge(model) : mockJudge;
  const composites: number[] = [];
  const repeats: RepeatArtifact[] = [];
  let first: CaseResult | null = null;
  let firstEvents: AgentEvent[] = [];
  let firstJudge: unknown = null;

  for (let i = 0; i < repeat; i++) {
    const key = agentCacheKey({
      caseId: cs.id,
      segments,
      adapterVersion: adapter.version ?? "1",
      model: model ?? "mock",
      promptHash: sha1(prompt ?? ""),
      seed: i,
    });
    let rr: RunResult;
    const hit = control.noCache ? null : readAgentCache(key);
    if (hit) {
      rr = {
        events: hit.events,
        segments,
        transcriptText: hit.transcriptText,
        stats: { ...hit.stats, ...ZERO_COST },
        hardFail: hit.hardFail,
        cached: true,
      };
      control.onStep?.(cs.id, "cached");
      control.log?.(`${cs.id} repeat ${i + 1} cached`);
    } else {
      const opts: RunOpts = { mode, segments, model, systemPromptOverride: prompt, seed: i };
      control.onStep?.(cs.id, i === 0 ? "running agent" : `repeat ${i + 1}`);
      control.log?.(`${cs.id} repeat ${i + 1} running`);
      try {
        rr = await adapter.run(cs, opts);
      } catch (e) {
        throw asProvider(e);
      }
      rr = { ...rr, segments: rr.segments?.length ? rr.segments : segments, cached: false };
      if (!rr.hardFail) {
        writeAgentCache(key, {
          events: rr.events, transcriptText: rr.transcriptText, stats: rr.stats, hardFail: rr.hardFail,
        });
      }
    }

    const result = await scoreCase(adapter, cs, rr, judgeClient);
    result.cached = rr.cached === true;
    composites.push(result.score.composite);
    repeats.push({
      n: i + 1, events: rr.events, score: result.score, trace: buildTrace(rr.events), cached: rr.cached === true,
    });
    if (i === 0) { first = result; firstEvents = rr.events; firstJudge = result.judge; }
  }

  const useLlm = control.explain && (model === "openai" || model === "anthropic");
  first!.explanation = useLlm ? await explainCaseLLM(first!, model as "openai" | "anthropic") : explainCase(first!);

  const mean = round(composites.reduce((a, b) => a + b, 0) / composites.length);
  const min = Math.min(...composites), max = Math.max(...composites);
  return {
    result: first!,
    spread: { mean, min, max, unstable: max - min > UNSTABLE_SPREAD },
    artifacts: { events: firstEvents, segments, trace: buildTrace(firstEvents), judge: firstJudge, repeats },
  };
}

export async function runSet(cases: Case[], mode: "live" | "replay", repeat: number,
                             model: string | undefined, prompt: string | undefined, stt: SttMode,
                             control: RunControl): Promise<RunSetResult> {
  const runs: CaseRun[] = [];
  let next = 0;
  let spent = 0;
  let stop: RunSetResult["stop"];
  let error: string | undefined;
  const jobs = Math.max(1, Math.min(control.jobs || 1, Math.max(1, cases.length)));

  async function worker(): Promise<void> {
    while (!stop) {
      if (spent >= control.maxCostUsd) { stop = "max-cost"; return; }
      const i = next++;
      if (i >= cases.length) return;
      try {
        const r = await runCase(cases[i], mode, repeat, model, prompt, stt, control);
        runs[i] = r;
        spent += r.result.score.stats.estCostUsd;
        control.onDone?.(r);
        control.log?.(`${r.result.caseId} composite ${r.result.score.composite} cost ${r.result.score.stats.estCostUsd} cached ${r.result.cached === true}`);
        if (spent > control.maxCostUsd) { stop = stop ?? "max-cost"; return; }
        const failed = !!r.result.hardFail || r.result.score.composite < 0.999;
        if (control.failFast && failed) { stop = stop ?? "fail-fast"; return; }
      } catch (e) {
        const wrapped = asProvider(e);
        if (wrapped instanceof ProviderError) {
          error = oneLine(wrapped);
          stop = "provider";
          control.log?.(`provider ${error}`);
          return;
        }
        throw wrapped;
      }
    }
  }

  if (cases.length) await Promise.all(Array.from({ length: jobs }, () => worker()));
  else if (0 >= control.maxCostUsd) stop = "max-cost";

  return { runs: runs.filter((r): r is CaseRun => !!r), stop, error };
}

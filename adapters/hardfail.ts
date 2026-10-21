// Fixture that hard-fails. Used to lock exit code 2.
import { register } from "../platform/src/adapter.ts";
import type { Adapter } from "../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, Score } from "../platform/src/types.ts";

const STATS = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] as [] };

const adapter: Adapter<Record<string, never>, Record<string, never>> = {
  name: "hardfail",
  version: "1",
  async run(_c: Case, opts: RunOpts): Promise<RunResult> {
    const events: AgentEvent[] = [{ atMs: 1, kind: "end" }];
    return {
      events, segments: opts.segments ?? [], transcriptText: "",
      stats: { ...STATS }, hardFail: "crashed",
    };
  },
  fold(): Record<string, never> { return {}; },
  score(): Score {
    return {
      metrics: { ok: { value: 1, total: 1, correct: 1 } },
      weights: { ok: 1 }, composite: 1, mismatches: [], extras: 0, stats: { ...STATS },
    };
  },
};

register(adapter);

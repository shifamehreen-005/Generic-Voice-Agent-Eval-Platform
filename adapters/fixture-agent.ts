// Fixture for the feedback loop. mock-bug writes a slot the transcript never
// said (agent). The mock speech path turns the word "four" into "five" (stt).
import { register } from "../platform/src/adapter.ts";
import type { Adapter } from "../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, Score, Mismatch } from "../platform/src/types.ts";

interface GT { code: string; slot: string }
interface Produced { code: string | null; slot: string | null }

const EMPTY = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0.01, perCall: [] as [] };

const adapter: Adapter<GT, Produced> = {
  name: "fixture",
  version: "1",

  async run(_c: Case, opts: RunOpts): Promise<RunResult> {
    const text = opts.segments?.map((s) => s.text).join(" ") ?? "";
    const code = /code\s+(\w+)/i.exec(text)?.[1] ?? null;
    let slot = /slot\s+(\w+)/i.exec(text)?.[1] ?? null;
    if (opts.model === "mock-bug") slot = "nine";
    const events: AgentEvent[] = [
      { atMs: 100, kind: "tool_call", name: "set_field", args: { code, slot }, sourceSegmentIds: opts.segments?.map((s) => s.id) ?? [0] },
      { atMs: 140, kind: "tool_result", ok: true },
      { atMs: 200, kind: "end" },
    ];
    return { events, segments: opts.segments ?? [], transcriptText: text, stats: { ...EMPTY } };
  },

  fold(events: AgentEvent[]): Produced {
    const call = events.find((e) => e.kind === "tool_call" && e.name === "set_field");
    const a = (call?.args ?? {}) as { code?: string | null; slot?: string | null };
    return { code: a.code ?? null, slot: a.slot ?? null };
  },

  score(produced: Produced, gt: GT): Score {
    const mismatches: Mismatch[] = [];
    if (produced.code !== gt.code) mismatches.push({ class: "WRONG", at: "field:code", expected: gt.code, produced: produced.code });
    if (produced.slot !== gt.slot) mismatches.push({ class: "WRONG", at: "field:slot", expected: gt.slot, produced: produced.slot });
    const ok = mismatches.length === 0 ? 1 : 0;
    return {
      metrics: { fields: { value: ok, total: 1, correct: ok } },
      weights: { fields: 1 },
      composite: ok,
      mismatches,
      extras: 0,
      stats: { ...EMPTY, estCostUsd: 0 },
    };
  },
};

register(adapter);

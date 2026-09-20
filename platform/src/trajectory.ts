// ============================================================================
// trajectory.ts — Layer 2: score the event trace itself (spec §7, layer 2).
//
// This is generic and ships with the platform. It's driven by an optional
// `expectedCalls` block on the ground truth; an adapter only writes its own
// trajectory scorer when the domain needs something smarter.
//
//   expectedCalls: [{ name, args?, ordered? }]
//
// It checks: were the expected calls made, were arguments right (per argument,
// so partial credit shows), ordering where required, and calls that shouldn't
// have happened. Per-call latency comes straight off the event timestamps.
// ============================================================================
import type { AgentEvent, MetricValue, Mismatch } from "./types.ts";

export interface ExpectedCall {
  name: string;
  args?: Record<string, unknown>;
  ordered?: boolean;              // must appear after the previous ordered call
}

export interface TrajectoryScore {
  metric: MetricValue;            // fraction of expected args satisfied
  mismatches: Mismatch[];
  extras: number;                 // tool calls made that were not expected
  slowestMs: number;
}

export function scoreTrajectory(events: AgentEvent[], expected: ExpectedCall[]): TrajectoryScore {
  const calls = events.filter((e) => e.kind === "tool_call");
  const mismatches: Mismatch[] = [];
  let argsTotal = 0, argsCorrect = 0;
  const consumed = new Set<number>();

  let lastOrderedIdx = -1;
  for (const exp of expected) {
    // find the first unconsumed matching call by name
    const idx = calls.findIndex((c, i) => !consumed.has(i) && c.name === exp.name);
    if (idx === -1) {
      argsTotal += Math.max(1, Object.keys(exp.args ?? {}).length);
      mismatches.push({ class: "MISSING", at: `call:${exp.name}`, expected: exp, produced: null });
      continue;
    }
    consumed.add(idx);
    const call = calls[idx];

    // per-argument check (partial credit visible)
    for (const [k, v] of Object.entries(exp.args ?? {})) {
      argsTotal++;
      if (JSON.stringify(call.args?.[k]) === JSON.stringify(v)) argsCorrect++;
      else mismatches.push({
        class: "WRONG", at: `call:${exp.name}/arg:${k}`,
        expected: v, produced: call.args?.[k], eventIndex: events.indexOf(call),
        segmentIds: call.sourceSegmentIds,
      });
    }
    if (!exp.args || Object.keys(exp.args).length === 0) { argsTotal++; argsCorrect++; }

    // ordering
    if (exp.ordered) {
      if (idx < lastOrderedIdx) {
        mismatches.push({ class: "ORDER", at: `call:${exp.name}`, expected: "after prior ordered call", produced: "before" });
      }
      lastOrderedIdx = idx;
    }
  }

  const extras = calls.length - consumed.size;
  const perCallMs = calls.map((c, i) => {
    const res = events.find((e) => e.kind === "tool_result" && events.indexOf(e) > events.indexOf(c));
    return res ? res.atMs - c.atMs : 0;
  });

  return {
    metric: { value: argsTotal ? argsCorrect / argsTotal : 1, total: argsTotal, correct: argsCorrect },
    mismatches,
    extras: Math.max(0, extras),
    slowestMs: perCallMs.length ? Math.max(...perCallMs) : 0,
  };
}

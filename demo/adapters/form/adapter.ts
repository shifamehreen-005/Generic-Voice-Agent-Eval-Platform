// ============================================================================
// form — a streaming demo agent. No model and no key.
//
// Segments arrive one at a time ("name is Ada", then later "name is Bea").
// The agent keeps a small form, revises a field when a later phrase corrects
// it, and finishes 2 seconds after end(). Speaker "UU" is ignored: that is an
// unknown voice, not the operator.
//
// The platform drives start → onSegment* → end → drain. run() exists only
// because every adapter has one; the engine does not call it.
// ============================================================================
import { register, type Adapter } from "../../../platform/src/adapter.ts";
import type { Case, RunResult, AgentEvent, Score, Mismatch, TranscriptSegment } from "../../../platform/src/types.ts";
import { ConfigError } from "../../../platform/src/errors.ts";

interface GT { fields: Record<string, string> }
interface Produced { fields: Record<string, string> }

const STATS = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] as [] };

interface Session {
  fields: Record<string, string>;
  events: AgentEvent[];
  n: number;
  lastSegment: number;
  roster: string[];
}

let session: Session = { fields: {}, events: [], n: 0, lastSegment: 0, roster: [] };

const adapter: Adapter<GT, Produced> = {
  name: "form",
  version: "1",

  async start(c: Case): Promise<void> {
    session = { fields: {}, events: [], n: 0, lastSegment: 0, roster: c.speakers?.roster ?? [] };
  },

  async onSegment(seg: TranscriptSegment): Promise<void> {
    session.lastSegment = seg.id;
    const operator = session.roster.length ? session.roster.includes(seg.speaker) : seg.speaker !== "UU";
    if (!operator) return;
    const m = /^(?:the )?(\w+) is (\w+)/i.exec(seg.text.trim());
    if (!m) return;
    const field = m[1].toLowerCase();
    const value = m[2];
    session.fields[field] = value;
    const callId = `f${session.n++}`;
    session.events.push({
      atMs: seg.startMs, kind: "tool_call", name: "set_field", callId,
      args: { field, value }, sourceSegmentIds: [seg.id],
    });
    session.events.push({
      atMs: seg.startMs + 20, kind: "tool_result", callId, ok: true,
      sourceSegmentIds: [seg.id],
    });
  },

  async end(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    session.events.push({
      atMs: (session.events.at(-1)?.atMs ?? 0) + 2000,
      kind: "end",
      sourceSegmentIds: [session.lastSegment],
    });
  },

  async drain(): Promise<AgentEvent[]> {
    return session.events;
  },

  async run(): Promise<RunResult> {
    throw new ConfigError(`adapter "form" is streaming. The engine calls start, onSegment, end, and drain.`);
  },

  fold(events: AgentEvent[]): Produced {
    const fields: Record<string, string> = {};
    for (const e of events) {
      if (e.kind === "tool_call" && e.name === "set_field") {
        const a = e.args as { field?: string; value?: string } | undefined;
        if (a?.field) fields[a.field] = String(a.value ?? "");
      }
    }
    return { fields };
  },

  score(produced: Produced, gt: GT): Score {
    const mismatches: Mismatch[] = [];
    const keys = new Set([...Object.keys(gt.fields ?? {}), ...Object.keys(produced.fields ?? {})]);
    let correct = 0;
    let extras = 0;
    for (const key of keys) {
      const exp = gt.fields?.[key];
      const got = produced.fields?.[key];
      if (exp === undefined) { extras++; mismatches.push({ class: "EXTRA", at: `field:${key}`, expected: null, produced: got }); continue; }
      if (got === undefined) { mismatches.push({ class: "MISSING", at: `field:${key}`, expected: exp, produced: null }); continue; }
      if (got !== exp) { mismatches.push({ class: "WRONG", at: `field:${key}`, expected: exp, produced: got }); continue; }
      correct++;
    }
    const total = Object.keys(gt.fields ?? {}).length;
    const value = total ? correct / total : 1;
    return {
      metrics: { fields: { value, total, correct } },
      weights: { fields: 1 },
      composite: value,
      mismatches,
      extras,
      stats: { ...STATS },
    };
  },
};

register(adapter);

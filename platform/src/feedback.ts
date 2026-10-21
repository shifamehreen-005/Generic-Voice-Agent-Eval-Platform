// feedback.ts — for each mismatch, the words the agent heard, the words that
// were said, and which layer broke. Decided in code, never by a model.
//
//   stt              heard and said disagree on a token that matters
//   agent            heard and said agree, and the value is still wrong
//   scorer-uncertain there is no reference transcript to compare against
import type { AgentEvent, Mismatch, TranscriptSegment } from "./types.ts";
import { tokens } from "./stt.ts";
import { splitUtterances } from "./utter.ts";

function flatten(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(flatten).join(" ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(flatten).join(" ");
  return String(v);
}

function counts(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}

function diffTokens(a: string[], b: string[]): string[] {
  const ca = counts(a);
  const cb = counts(b);
  const out: string[] = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    if ((ca.get(k) ?? 0) !== (cb.get(k) ?? 0)) out.push(k);
  }
  return out;
}

function findEventIndex(m: Mismatch, events: AgentEvent[]): number | undefined {
  const loc = m.at.split(":").slice(1).join(":");
  if (!loc) return undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind !== "tool_call" && e.kind !== "state_change") continue;
    const blob = JSON.stringify(e.args ?? e.data ?? {});
    if (blob.includes(JSON.stringify(loc)) || blob.includes(loc)) return i;
  }
  return undefined;
}

function heardFor(ids: number[] | undefined, segments: TranscriptSegment[], hypothesis: string): string {
  if (ids?.length && segments.length) {
    const texts = ids
      .map((id) => segments.find((s) => s.id === id)?.text)
      .filter((t): t is string => !!t);
    if (texts.length) return texts.join(" ");
  }
  if (hypothesis) return hypothesis;
  return segments.map((s) => s.text).join(" ");
}

function saidFor(ids: number[] | undefined, segments: TranscriptSegment[], reference: string | undefined): string {
  if (!reference) return "";
  if (!ids?.length || segments.length <= 1) return reference;
  const refParts = splitUtterances(reference);
  if (refParts.length !== segments.length) return reference;
  const byId = new Map(segments.map((s, i) => [s.id, i]));
  return ids
    .map((id) => refParts[byId.get(id) ?? -1] ?? "")
    .filter(Boolean)
    .join(" ");
}

export function decideLayer(
  reference: string | undefined, heard: string, said: string, expected: unknown, produced: unknown,
): Mismatch["layer"] {
  if (!reference) return "scorer-uncertain";
  const matter = diffTokens(tokens(flatten(expected)), tokens(flatten(produced)));
  const ht = counts(tokens(heard));
  const st = counts(tokens(said));
  for (const tok of matter) {
    if ((ht.get(tok) ?? 0) !== (st.get(tok) ?? 0)) return "stt";
  }
  return "agent";
}

/** Add heard / said / layer onto every mismatch. Pure. */
export function attachFeedback(
  mismatches: Mismatch[],
  segments: TranscriptSegment[],
  reference: string | undefined,
  events: AgentEvent[],
  hypothesis: string,
): Mismatch[] {
  return mismatches.map((m) => {
    const eventIndex = m.eventIndex ?? findEventIndex(m, events);
    const event = eventIndex != null ? events[eventIndex] : undefined;
    const segmentIds = m.segmentIds ?? event?.sourceSegmentIds;
    const heard = heardFor(segmentIds, segments, hypothesis);
    const said = saidFor(segmentIds, segments, reference);
    const layer = decideLayer(reference, heard, said, m.expected, m.produced);
    return { ...m, heard, said, layer, eventIndex, segmentIds };
  });
}

/** The one line a summary's `top` array carries. */
export function topLine(m: { class: string; at: string; expected: unknown; produced: unknown }): string {
  return `${m.class} ${m.at} expected ${JSON.stringify(m.expected)} got ${JSON.stringify(m.produced)}`;
}

/** The block `eval show` and `eval diff` print. Nothing else. */
export function feedbackBlock(m: Mismatch, caseId?: string): Record<string, unknown> {
  const block: Record<string, unknown> = {
    class: m.class,
    at: m.at,
    expected: m.expected,
    produced: m.produced,
    heard: m.heard ?? "",
    said: m.said ?? "",
    layer: m.layer ?? "scorer-uncertain",
    eventIndex: m.eventIndex ?? null,
  };
  if (caseId) block.case = caseId;
  return block;
}

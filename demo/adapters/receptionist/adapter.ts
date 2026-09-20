// ============================================================================
// receptionist — a dental front-desk voice agent. The richest domain: it shows
// BOTH kinds of scoring at once.
//
//   deterministic  : did it book the RIGHT thing? (action/name/date/time/type)
//   trajectory     : did it look up + check availability BEFORE booking?
//   judge (LLM)    : is the SPOKEN REPLY faithful — did it confirm the key facts
//                    (coverage), avoid making things up (support), and read
//                    cleanly (grammar)?
//
// Agent by opts.model: "mock" | "mock-bug" (offline) | "openai" | "anthropic".
// ============================================================================
import { register } from "../../../platform/src/adapter.ts";
import type { Adapter } from "../../../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, Score, Mismatch, MetricValue, JudgeSpec } from "../../../platform/src/types.ts";
import { receptionistAgent } from "./mock.ts";
import { llmAgentOpenAI, llmAgentAnthropic, type ToolDef } from "../../../platform/src/providers.ts";
// Shared, unit-tested comparison helpers (platform/src/match.ts) — so this
// scorer never re-invents (or re-breaks) date/time/text equality.
import { eqText, eqDate, eqTime } from "../../../platform/src/match.ts";

interface ReceptionGT {
  action: string; name: string; date: string; time?: string; type?: string;
  reply_facts?: { id: string; text: string }[];    // what the spoken reply must confirm
  expectedCalls?: unknown;
}
interface Produced { booking: Record<string, unknown>; reply: string }

const TOOLS: ToolDef[] = [
  { name: "lookup_patient", description: "Find the patient by name.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_availability", description: "List open slots for a date.",
    parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } },
  { name: "book_appointment", description: "Book a new appointment.",
    parameters: { type: "object", properties: { patient_name: { type: "string" }, date: { type: "string" }, time: { type: "string" }, type: { type: "string" } }, required: ["patient_name", "date"] } },
  { name: "reschedule_appointment", description: "Move an existing appointment.",
    parameters: { type: "object", properties: { patient_name: { type: "string" }, date: { type: "string" }, time: { type: "string" }, type: { type: "string" } }, required: ["patient_name", "date"] } },
  { name: "cancel_appointment", description: "Cancel an appointment.",
    parameters: { type: "object", properties: { patient_name: { type: "string" }, date: { type: "string" } }, required: ["patient_name", "date"] } },
];

const SYSTEM =
  "You are a dental clinic receptionist on a live call. Complete the request end to end with the tools and " +
  "do NOT ask the caller to confirm: (1) lookup_patient, (2) get_availability for the date, (3) ALWAYS call " +
  "book_appointment / reschedule_appointment / cancel_appointment with the patient name and the exact date, " +
  "time and type the caller said, then (4) write one short spoken reply confirming name, type, date and time. " +
  "Never state anything the caller did not say (e.g. insurance).";

// name/type/date/time equality all come from the shared match library above.

// Plausible tool results fed back to a real agent mid-run, so it can complete
// the flow. NOTE: no answer-key leakage — a lookup just says "found", and
// availability lists generic open slots (not the graded date/time).
function receptionistToolResult(name: string, args: Record<string, unknown>): unknown {
  if (name === "lookup_patient") return { found: true, patient_id: "P-1042", name: args.name };
  if (name === "get_availability") return { date: args.date, open_slots: ["09:00","09:30","10:00","11:00","13:30","14:00","14:30","15:00","16:00"] };
  return { ok: true, confirmed: true };            // book / reschedule / cancel
}

const adapter: Adapter<ReceptionGT, Produced> = {
  name: "receptionist",
  judgeWeight: 0.4,               // spoken reply carries 40% of the grade

  groundTruthSchema: {
    type: "object", required: ["action", "name", "date"],
    properties: {
      action: { type: "string", enum: ["book", "reschedule", "cancel"] },
      name: { type: "string" }, date: { type: "string" }, time: { type: "string" }, type: { type: "string" },
      reply_facts: { type: "array", items: {
        type: "object", required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } } } },
      expectedCalls: { type: "array", items: {
        type: "object", required: ["name"],
        properties: { name: { type: "string" }, ordered: { type: "boolean" } } } },
    },
  },

  async run(c: Case, opts: RunOpts): Promise<RunResult> {
    const provider = opts.model ?? "mock";
    const gt = c.groundTruth as ReceptionGT;
    const transcript = (opts.segments?.map((s) => s.text).join(" ")) ?? c.referenceTranscript ?? c.transcriptText ?? "";
    let events: AgentEvent[]; let inTok = 0, outTok = 0, cost = 0.02;

    if (provider === "openai" || provider === "anthropic") {
      const system = opts.systemPromptOverride ?? SYSTEM;   // --prompt swaps this
      const reply = provider === "openai"
        ? await llmAgentOpenAI(system, transcript, TOOLS, receptionistToolResult)
        : await llmAgentAnthropic(system, transcript, TOOLS, receptionistToolResult);
      events = reply.events; inTok = reply.inputTokens; outTok = reply.outputTokens;
      cost = (inTok * 3 + outTok * 12) / 1_000_000;
    } else {
      events = receptionistAgent(transcript, gt, provider === "mock-bug");
    }
    return { events, segments: opts.segments ?? [], transcriptText: transcript,
      stats: { wallMs: 0, llmCalls: 1, inputTokens: inTok, outputTokens: outTok, cachedInputTokens: 0, estCostUsd: cost, perCall: [] } };
  },

  fold(events: AgentEvent[]): Produced {
    const final = [...events].reverse().find((e) => e.kind === "tool_call" && /_(appointment)$/.test(e.name ?? ""));
    const reply = String(events.find((e) => e.kind === "assistant_text")?.data ?? "");
    if (!final) return { booking: {}, reply };
    const a = final.args as any;
    const action = final.name!.replace("_appointment", "");
    return { booking: { action, name: a.patient_name, date: a.date, time: a.time, type: a.type }, reply };
  },

  // deterministic: did it book the right thing?
  score(p: Produced, gt: ReceptionGT): Score {
    const b = p.booking;
    const checks: [string, boolean][] = [
      ["action", eqText(b.action as string, gt.action)],
      ["name", eqText(b.name as string, gt.name)],
      ["date", eqDate(b.date as string, gt.date)],
    ];
    if (gt.time !== undefined) checks.push(["time", eqTime(b.time as string, gt.time)]);
    if (gt.type !== undefined) checks.push(["type", eqText(b.type as string, gt.type)]);
    const mismatches: Mismatch[] = [];
    let correct = 0;
    for (const [f, ok] of checks) { if (ok) correct++; else mismatches.push({ class: "WRONG", at: `field:${f}`, expected: (gt as any)[f], produced: (b as any)[f] }); }
    const metric: MetricValue = { value: correct / checks.length, total: checks.length, correct };
    return { metrics: { booking: metric }, composite: metric.value, weights: { booking: 1 }, mismatches, extras: 0,
      stats: { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] } };
  },

  // judge: grade the spoken reply (facts confirmed, nothing invented, reads well)
  judgeSpec(gt: ReceptionGT): JudgeSpec {
    return { facts: gt.reply_facts ?? [], fields: [{ key: "reply", description: "spoken confirmation" }], checkGrammar: true };
  },
  judgeTarget(produced: unknown): string { return (produced as Produced).reply; },

  // feed realistic tool results back to the real agent so it can finish the flow
  toolResult: receptionistToolResult,
};

register(adapter);
export default adapter;

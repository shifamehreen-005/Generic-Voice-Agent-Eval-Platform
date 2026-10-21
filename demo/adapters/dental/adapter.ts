// ============================================================================
// dental — periodontal charting, with a REAL agent option (spec §13 shape).
//
// This is the user's actual domain. The agent hears a clinician dictate pocket
// depths and must call chart_tooth(tooth, depths) for each tooth. Correctness is
// per-tooth within a 1 mm tolerance.
//
// run() picks the agent by opts.model:
//   "mock"       -> offline parser (reads the transcript itself; no key)
//   "openai"     -> real GPT function-calling agent   (needs OPENAI_API_KEY)
//   "anthropic"  -> real Claude tool-use agent        (needs ANTHROPIC_API_KEY)
//
// Everything downstream (fold/score/judge/gate) is identical whether the tool
// calls came from the parser or a live model — that is the whole point.
// ============================================================================
import { register } from "../../../platform/src/adapter.ts";
import type { Adapter } from "../../../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, Score, Mismatch, MetricValue } from "../../../platform/src/types.ts";
import { parseDentalTranscript, tagDentalSegments } from "./mock.ts";
import { llmAgentOpenAI, llmAgentAnthropic, type ToolDef } from "../../../platform/src/providers.ts";

interface DentalGT { teeth: Record<string, number[]> }   // { "14": [3,2,4], ... }
type Produced = Record<string, number[]>;

const CHART_TOOTH: ToolDef = {
  name: "chart_tooth",
  description: "Record the three periodontal pocket depths (in mm) for one tooth.",
  parameters: {
    type: "object",
    properties: {
      tooth: { type: "string", description: "tooth number, e.g. '14'" },
      depths: { type: "array", items: { type: "number" }, description: "exactly three probing depths in mm" },
    },
    required: ["tooth", "depths"],
  },
};

const SYSTEM =
  "You are a periodontal charting assistant. The user dictates pocket depths tooth by tooth. " +
  "For every tooth mentioned, call chart_tooth with the tooth number and its three depths in mm, " +
  "in the order spoken. Do not invent teeth that were not mentioned.";

const eqTriple = (a?: number[], b?: number[], tol = 1) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

const adapter: Adapter<DentalGT, Produced> = {
  name: "dental",

  groundTruthSchema: {
    type: "object", required: ["teeth"],
    properties: { teeth: { type: "object" } },
  },

  // count reconciliation: every tooth must have exactly three depths
  lint(gt: DentalGT) {
    const findings = [];
    for (const [tooth, d] of Object.entries(gt.teeth ?? {})) {
      if (!Array.isArray(d) || d.length !== 3) {
        findings.push({ rule: "count-reconciliation", severity: "error" as const,
          message: `tooth ${tooth} must have 3 depths, has ${Array.isArray(d) ? d.length : "?"}`, at: `tooth:${tooth}` });
      }
    }
    return findings;
  },

  async run(c: Case, opts: RunOpts): Promise<RunResult> {
    const provider = opts.model ?? "mock";
    const transcript = (opts.segments?.map((s) => s.text).join(" ")) ?? c.referenceTranscript ?? c.transcriptText ?? "";

    let events: AgentEvent[];
    let inTok = 0, outTok = 0, cost = 0;

    if (provider === "openai" || provider === "anthropic") {
      const system = opts.systemPromptOverride ?? SYSTEM;   // --prompt swaps this
      const reply = provider === "openai"
        ? await llmAgentOpenAI(system, transcript, [CHART_TOOTH])
        : await llmAgentAnthropic(system, transcript, [CHART_TOOTH]);
      events = reply.events; inTok = reply.inputTokens; outTok = reply.outputTokens;
      cost = estCost(provider, inTok, outTok);
    } else {
      // offline parser (no key). "mock-bug" injects one wrong depth so you can
      // see a regression and the gate catch it without spending anything.
      events = parseDentalTranscript(transcript, provider === "mock-bug");
      cost = 0.02;
    }
    tagDentalSegments(events, opts.segments ?? []);

    return {
      events, segments: opts.segments ?? [], transcriptText: transcript,
      stats: { wallMs: 0, llmCalls: 1, inputTokens: inTok, outputTokens: outTok,
               cachedInputTokens: 0, estCostUsd: cost, perCall: [] },
    };
  },

  fold(events: AgentEvent[]): Produced {
    const out: Produced = {};
    for (const e of events) {
      if (e.kind === "tool_call" && e.name === "chart_tooth") {
        const a = e.args as { tooth: string; depths: number[] };
        if (a?.tooth != null && Array.isArray(a.depths)) out[String(a.tooth)] = a.depths;
      }
    }
    return out;
  },

  score(p: Produced, gt: DentalGT): Score {
    const mismatches: Mismatch[] = [];
    const teeth = Object.entries(gt.teeth);
    let correct = 0;
    // SHIFTED means the gold triple appears EXACTLY on a neighbor tooth — use
    // tol 0 here so ordinary similar-looking neighbors aren't mislabeled.
    const neighborHas = (id: number, V: number[]) =>
      eqTriple(p[String(id - 1)], V, 0) || eqTriple(p[String(id + 1)], V, 0);

    const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
    for (const [tooth, gold] of teeth) {
      const got = p[tooth];
      if (eqTriple(got, gold)) { correct++; continue; }
      let cls: string;
      if (got === undefined) cls = neighborHas(+tooth, gold) ? "SHIFTED" : "MISSING";
      else if (sameSet(got, gold)) cls = "TRANSPOSED";              // right numbers, wrong order
      else if (neighborHas(+tooth, gold)) cls = "SHIFTED";          // values landed on a neighbor tooth
      else cls = "WRONG";
      mismatches.push({ class: cls, at: `tooth:${tooth}`, expected: gold, produced: got ?? null });
    }
    // extras: teeth charted that the gold never asked for (hallucinated)
    const extras = Object.keys(p).filter((t) => !(t in gt.teeth)).length;

    const metric: MetricValue = { value: teeth.length ? correct / teeth.length : 1, total: teeth.length, correct };
    return { metrics: { teeth: metric }, composite: metric.value, weights: { teeth: 1 },
      mismatches, extras,
      stats: { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] } };
  },
};

function estCost(provider: string, inTok: number, outTok: number): number {
  // rough public rates ($/1M tokens); adjust as needed
  const rate = provider === "openai" ? { in: 2.5, out: 10 } : { in: 3, out: 15 };
  return (inTok * rate.in + outTok * rate.out) / 1_000_000;
}

register(adapter);
export default adapter;

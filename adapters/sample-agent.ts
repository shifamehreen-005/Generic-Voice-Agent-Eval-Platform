// ============================================================================
// sample-agent.ts — COPY ME. This is the template for plugging in YOUR agent.
//
// The platform is domain-agnostic: it doesn't know anything about your agent.
// You teach it, by writing one file like this — an "adapter". An adapter answers
// four questions about your agent:
//
//     1. run()   — how do I run your agent on one test?      (REQUIRED)
//     2. fold()  — how do I collapse what it did into a
//                  simple "here is the final answer" object? (REQUIRED)
//     3. score() — how do I compare that answer to the
//                  correct answer and give it 0..1?          (optional*)
//     4. judgeSpec() — for a spoken/written reply, what
//                  facts must it contain?  (an LLM grades it) (optional*)
//
//     * provide at least one of score() / judgeSpec().
//
// To make your own: copy this file to adapters/<your-name>.ts, change `name`,
// fill in the four parts, then import it in adapters/index.ts. Write test cases
// (see demo/cases/*.json for the shape) and run:
//
//     npm run eval -- run --cases adapters/sample-case.json --adapter sample
//
// This sample models a tiny "reminder" voice agent that should hear
//   "remind me to <thing> at <time>"
// and call one tool: set_reminder(text, time).
// ============================================================================
import { register } from "../platform/src/adapter.ts";
import type { Adapter } from "../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, Score } from "../platform/src/types.ts";
import { scoreCells, type CellGold } from "../platform/src/cells.ts";

// Produced state is cells keyed by a location ("field:text"). Gold is the same
// shape, plus optional corrections applied before scoring. Tolerance is 0
// unless a domain passes one. See platform/src/cells.ts.

const adapter: Adapter<CellGold, Record<string, unknown>> = {
  // A stable id. Your case files point at this with  "adapter": "sample".
  name: "sample",

  // -- STEP 1: run your agent on one case -----------------------------------
  // Input: the case + the transcript of what was said (the platform already did
  // speech-to-text for you). Output: the list of tool calls your agent made.
  //
  // Here we use a trivial offline "agent" that reads the words itself. THIS is
  // the line you replace with a call to YOUR real agent, e.g.
  //     const calls = await myAgent(transcript);
  // and then turn each of its tool calls into an AgentEvent below.
  async run(c: Case, opts: RunOpts): Promise<RunResult> {
    const transcript =
      opts.segments?.map((s) => s.text).join(" ") ?? c.referenceTranscript ?? c.transcriptText ?? "";

    // toy parser: "remind me to X at Y for Z"
    const m = /remind me to (.+?) at (.+?)(?: for (\w+))?[.?!]?$/i.exec(transcript.trim());
    const events: AgentEvent[] = [];
    if (m) {
      const who = opts.model === "mock-bug" ? "Eve" : (m[3] ?? "").trim();
      events.push({
        atMs: 100,
        kind: "tool_call",
        name: "set_reminder",
        args: { "field:text": m[1].trim(), "field:time": m[2].trim(), "field:who": who },
        sourceSegmentIds: [0],
      });
      events.push({ atMs: 140, kind: "tool_result", ok: true, callId: "r1", sourceSegmentIds: [0] });
    }
    events.push({ atMs: 200, kind: "end" });

    return {
      events,
      segments: opts.segments ?? [],
      transcriptText: transcript,
      // cost/latency accounting — zero for an offline agent.
      stats: { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] },
    };
  },

  // -- STEP 2: fold the tool calls into a final answer ----------------------
  // The platform hands you the event list; you return the one object that
  // represents "what the agent decided". Pure function, no I/O.
  fold(events: AgentEvent[]): Record<string, unknown> {
    const call = events.find((e) => e.kind === "tool_call" && e.name === "set_reminder");
    const args = (call?.args ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== "") out[k] = v;
    return out;
  },

  // -- STEP 3: score it against the correct answer --------------------------
  // Cells, not one field. Tolerance stays 0. Three metrics: exact, presence, clean.
  // mock-bug writes the wrong person so the gate can fail with no API key.
  score(produced: Record<string, unknown>, gt: CellGold): Score {
    return scoreCells(produced, gt);
  },

  // -- STEP 4 (optional): judge a spoken reply ------------------------------
  // This sample has no spoken reply, so we omit judgeSpec(). If your agent talks
  // back, return { facts:[{id,text}], fields:[{key,description}] } here and an
  // LLM will check the reply actually says those facts (see demo receptionist).
};

register(adapter);
export default adapter;

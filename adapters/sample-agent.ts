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
import { eqText, eqTime } from "../platform/src/match.ts";   // shared fair comparisons

// The "correct answer" shape for this domain. You define this — it's whatever
// your test cases put under groundTruth. Here: the reminder we expected.
interface ReminderGT { text: string; time: string }
// The "what the agent actually produced" shape, after fold().
interface Produced { text: string | null; time: string | null }

const adapter: Adapter<ReminderGT, Produced> = {
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

    // toy parser: pull "<thing>" and "<time>" out of "remind me to X at Y"
    const m = /remind me to (.+?) at (.+?)[.?!]?$/i.exec(transcript.trim());
    const events: AgentEvent[] = [];
    if (m) {
      events.push({
        atMs: 100,
        kind: "tool_call",
        name: "set_reminder",
        args: { text: m[1].trim(), time: m[2].trim() },
      });
      events.push({ atMs: 140, kind: "tool_result", ok: true });
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
  fold(events: AgentEvent[]): Produced {
    const call = events.find((e) => e.kind === "tool_call" && e.name === "set_reminder");
    const a = (call?.args ?? {}) as { text?: string; time?: string };
    return { text: a.text ?? null, time: a.time ?? null };
  },

  // -- STEP 3: score it against the correct answer --------------------------
  // Return named 0..1 metrics + a composite + typed mismatches (why it lost
  // points). The mismatches are what show up in the report's "what went wrong".
  //
  // IMPORTANT: compare with the shared, unit-tested helpers in
  // platform/src/match.ts (eqText, eqDate, eqTime, nearNum, eqEnum, sameSet) —
  // NOT hand-rolled === — so date/time/case/punctuation fairness is solved once
  // for every domain. Here eqText handles "Call the Pharmacy" == "call the pharmacy".
  score(produced: Produced, gt: ReminderGT): Score {
    const textOk = eqText(produced.text ?? "", gt.text) ? 1 : 0;
    const timeOk = eqTime(produced.time ?? "", gt.time) ? 1 : 0;
    const mismatches = [];
    if (!textOk) mismatches.push({ class: "WRONG", at: "text", expected: gt.text, produced: produced.text });
    if (!timeOk) mismatches.push({ class: "WRONG", at: "time", expected: gt.time, produced: produced.time });

    return {
      metrics: {
        text: { value: textOk, total: 1, correct: textOk },
        time: { value: timeOk, total: 1, correct: timeOk },
      },
      weights: { text: 0.5, time: 0.5 },      // must sum to 1
      composite: 0.5 * textOk + 0.5 * timeOk,
      mismatches,
      extras: 0,
      stats: { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] },
    };
  },

  // -- STEP 4 (optional): judge a spoken reply ------------------------------
  // This sample has no spoken reply, so we omit judgeSpec(). If your agent talks
  // back, return { facts:[{id,text}], fields:[{key,description}] } here and an
  // LLM will check the reply actually says those facts (see demo receptionist).
};

register(adapter);
export default adapter;

// ============================================================================
// mock.ts — the OFFLINE dental agent (the "mock" provider).
//
// It genuinely READS the transcript and decides what to chart, so it can be
// wrong on its own if the transcript is garbled. It's a stand-in for a real LLM
// agent and runs when you don't pass a real --provider.
//
// It handles natural dictation like "Tooth number 14, pockets 3, 2, 4." by
// grabbing, after each "tooth", the first number (the tooth id) and the next
// three numbers (the depths) — words or digits.
// ============================================================================
import type { AgentEvent } from "../../../platform/src/types.ts";

const WORD: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30,
};

function num(tok: string): number | null {
  const t = tok.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t in WORD) return WORD[t];
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return null;
}

// `buggy` misreads the last depth of the first tooth by +2mm, so you can see a
// regression the gate catches — without any API cost.
export function parseDentalTranscript(transcript: string, buggy = false): AgentEvent[] {
  const events: AgentEvent[] = [];
  let t = 100;
  let first = true;
  for (const chunk of transcript.toLowerCase().split(/tooth\s+/).slice(1)) {
    const nums = chunk.split(/[\s,.:;-]+/).map(num).filter((x): x is number => x != null);
    if (nums.length >= 4) {
      const tooth = String(nums[0]);            // first number = tooth id
      const depths = nums.slice(1, 4);          // next three = pocket depths
      if (buggy && first) { depths[2] += 2; first = false; }
      events.push({ atMs: t, kind: "tool_call", name: "chart_tooth", args: { tooth, depths } });
      events.push({ atMs: t + 40, kind: "tool_result", ok: true });
      t += 200;
    }
  }
  events.push({ atMs: t, kind: "end" });
  return events;
}

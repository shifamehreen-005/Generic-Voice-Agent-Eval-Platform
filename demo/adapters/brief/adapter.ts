// A judged document. The mock writer misses one fact, invents one line, and
// uses one forbidden word. No model and no key. Headings are checked in code.
import { register, type Adapter } from "../../../platform/src/adapter.ts";
import type { Case, RunOpts, RunResult, AgentEvent, JudgeSpec } from "../../../platform/src/types.ts";

interface Fact { id: string; text: string; section?: string }
interface GT {
  facts: Fact[];
  forbidden?: { id: string; text: string }[];
  sections?: string[];
}

const DOC = `# Intake
Patient is Mara Chen.
She takes no daily medication.
The visit lasted twenty minutes.
Vitals were within the usual range.
No swelling was seen.
Water was offered on arrival.
The room was on the second floor.
The nurse was present.

# Findings
Pain started on Monday.
She asked about home care.
The chart was updated.
Radiograph looked unremarkable.
Brush twice a day.
Use a soft brush.
Avoid very cold drinks this week.

# Plan
Call the clinic if pain returns.
Bring the insurance card next time.
The hygienist is Noah.
Arrive ten minutes early.
Parking is behind the building.
The fee was explained.
She agreed to the plan.
Book a follow-up in two weeks and we guarantee it.
A reminder was sent.
The referral form is unsigned.
Next review is in six months.
`;

const STATS = { wallMs: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estCostUsd: 0, perCall: [] as [] };

const adapter: Adapter<GT, { reply: string }> = {
  name: "brief",
  version: "1",

  async run(c: Case, opts: RunOpts): Promise<RunResult> {
    const transcript = opts.segments?.map((s) => s.text).join(" ") || c.transcriptText || "";
    const events: AgentEvent[] = [
      { atMs: 100, kind: "assistant_text", data: DOC.trim(), sourceSegmentIds: [0] },
      { atMs: 120, kind: "end", sourceSegmentIds: [0] },
    ];
    return { events, segments: opts.segments ?? [], transcriptText: transcript, stats: { ...STATS } };
  },

  fold(): { reply: string } {
    return { reply: DOC.trim() };
  },

  judgeSpec(gt: GT): JudgeSpec {
    return {
      facts: gt.facts,
      forbidden: gt.forbidden,
      sections: gt.sections,
      fields: [{ key: "reply", description: "the written brief" }],
    };
  },

  judgeTarget(produced: unknown): string {
    return (produced as { reply: string }).reply;
  },
};

register(adapter);

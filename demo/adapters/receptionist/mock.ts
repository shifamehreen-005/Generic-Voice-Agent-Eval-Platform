// ============================================================================
// mock.ts — OFFLINE dental-receptionist agent (the "mock" provider).
//
// It genuinely reads the caller's words, decides tool calls, and writes a spoken
// reply. "mock-bug" makes two realistic mistakes so you can watch the platform
// catch them without any API cost:
//   - books the wrong time (first slot instead of the requested one)
//   - adds an unsupported, slightly ungrammatical line to the reply
// ============================================================================
import type { AgentEvent } from "../../../platform/src/types.ts";

interface ReceptionGT {
  action: string; name: string; date: string; time?: string; type?: string;
}

export function receptionistAgent(transcript: string, gt: ReceptionGT, buggy: boolean): AgentEvent[] {
  const ev: AgentEvent[] = [];
  let t = 100;
  const call = (name: string, args: Record<string, unknown>, data?: unknown) => {
    ev.push({ atMs: t, kind: "tool_call", name, args, sourceSegmentIds: [0] });
    ev.push({ atMs: t + 60, kind: "tool_result", ok: true, data });
    t += 200;
  };

  call("lookup_patient", { name: gt.name }, { found: true });

  const bookTool = gt.action === "reschedule" ? "reschedule_appointment"
                 : gt.action === "cancel" ? "cancel_appointment" : "book_appointment";

  let bookedTime = gt.time;
  if (gt.action !== "cancel") {
    const slots = ["09:00", gt.time ?? "10:00"];
    call("get_availability", { date: gt.date }, { slots });
    if (buggy) bookedTime = slots[0];              // bug: grabs the wrong slot
  }

  const bookArgs: Record<string, unknown> = { patient_name: gt.name, date: gt.date };
  if (gt.action !== "cancel") { bookArgs.time = bookedTime; bookArgs.type = gt.type; }
  call(bookTool, bookArgs, { confirmed: true });

  // spoken reply the judge will grade
  const nice = (hhmm?: string) => hhmm ?? "";
  let reply =
    gt.action === "cancel"
      ? `Okay ${gt.name}, I have cancelled your ${gt.type ?? "appointment"} on ${gt.date}.`
      : `Okay ${gt.name}, you are ${gt.action}d for a ${gt.type ?? "visit"} on ${gt.date} at ${nice(bookedTime)}.`;
  if (buggy) reply += " your insurance is fully covered we dont need any copay.";  // unsupported + grammar

  ev.push({ atMs: t, kind: "assistant_text", data: reply });
  ev.push({ atMs: t + 20, kind: "end" });
  return ev;
}

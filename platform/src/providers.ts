// ============================================================================
// providers.ts — the REAL external calls (STT, LLM agent, TTS).
//
// Uses the global fetch (Node 18+) — no SDK dependency. Each function is only
// reached when you pass a real --provider / --stt on the CLI; otherwise the
// platform runs fully offline in mock mode. Keys come from .env (see env.ts).
//
//   transcribeOpenAI  — audio file  -> transcript text        (real STT)
//   llmAgentOpenAI     — transcript  -> tool calls             (real agent)
//   llmAgentAnthropic  — transcript  -> tool calls             (real agent)
//   ttsOpenAI          — text        -> mp3 file               (make sample audio)
// ============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import type { AgentEvent } from "./types.ts";
import { requireKey } from "./env.ts";

// A tool the agent may call, in a provider-neutral shape the adapter defines.
export interface ToolDef {
  name: string;
  description: string;
  parameters: object;             // JSON Schema for the arguments
}

export interface AgentReply {
  events: AgentEvent[];
  inputTokens: number;
  outputTokens: number;
}

// ---- STT: OpenAI transcription --------------------------------------------
export async function transcribeOpenAI(audioPath: string, model = "gpt-4o-transcribe"): Promise<string> {
  const key = requireKey("OPENAI_API_KEY");
  const bytes = readFileSync(audioPath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), audioPath.split(/[\\/]/).pop() ?? "audio.mp3");
  form.append("model", model);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI STT ${res.status}: ${await res.text()}`);
  return (await res.json()).text as string;
}

// ---- TTS: OpenAI speech (to make sample audio) -----------------------------
export async function ttsOpenAI(text: string, outPath: string, voice = "onyx"): Promise<void> {
  const key = requireKey("OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice, input: text }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// ---- TTS: ElevenLabs (more natural voice) ----------------------------------
// Default voice "Rachel"; override with any ElevenLabs voice id.
const EL_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
export async function ttsElevenLabs(text: string, outPath: string, voiceId = EL_DEFAULT_VOICE): Promise<void> {
  const key = requireKey("ELEVENLABS_API_KEY");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${await res.text()}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// ---- Agent: OpenAI function calling ---------------------------------------
// A real agentic LOOP, not a single call: the model calls a tool, we feed a
// result back, and it continues — look up → check availability → book → then
// speak a confirmation. Without this loop the agent would stop after its first
// tool call and never finish (or speak).
//
// The result each tool returns comes from the adapter's optional toolResult()
// (there's no real backend in the eval). This matters a lot: a multi-step agent
// can only proceed if a lookup actually says "found" and an availability check
// actually lists slots. If the adapter provides nothing, we fall back to
// {ok:true}, which is fine for single-shot agents (e.g. dental charting) but
// starves a multi-step one. toolResult MUST NOT leak the graded answer.
const MAX_AGENT_STEPS = 6;   // safety cap so a confused agent can't loop forever
type ToolResultFn = (name: string, args: Record<string, unknown>) => unknown;

export async function llmAgentOpenAI(
  system: string, transcript: string, tools: ToolDef[],
  toolResult?: ToolResultFn, model = "gpt-4o",
): Promise<AgentReply> {
  const key = requireKey("OPENAI_API_KEY");
  const toolSpec = tools.map((t) => ({ type: "function", function: t }));
  const messages: any[] = [
    { role: "system", content: system },
    { role: "user", content: transcript },
  ];
  const events: AgentEvent[] = [];
  let t = 100, inTok = 0, outTok = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, messages, tools: toolSpec, tool_choice: "auto" }),
    });
    if (!res.ok) throw new Error(`OpenAI chat ${res.status}: ${await res.text()}`);
    const data = await res.json();
    inTok += data.usage?.prompt_tokens ?? 0;
    outTok += data.usage?.completion_tokens ?? 0;
    const msg = data.choices?.[0]?.message ?? {};
    const calls = msg.tool_calls ?? [];

    if (!calls.length) {                       // no more tools → this is the spoken reply
      const text = String(msg.content ?? "").trim();
      if (text) events.push({ atMs: t, kind: "assistant_text", data: text });
      break;
    }

    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
    for (const call of calls) {
      const args = safeParse(call.function.arguments);
      const result = toolResult ? toolResult(call.function.name, args) : { ok: true };
      events.push({ atMs: t, kind: "tool_call", name: call.function.name, args });
      events.push({ atMs: t + 50, kind: "tool_result", ok: true, data: result });
      t += 150;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // If the agent finished its tool calls but never spoke, force one closing
  // turn WITHOUT tools so we always capture a spoken reply to judge. (Models
  // often stop after the last successful tool call; this guarantees the
  // confirmation the reply metric grades.)
  if (!events.some((e) => e.kind === "assistant_text")) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, temperature: 0,
        messages: [...messages, { role: "user", content: "Now give your one short spoken reply to the caller." }] }),
    });
    if (res.ok) {
      const data = await res.json();
      inTok += data.usage?.prompt_tokens ?? 0;
      outTok += data.usage?.completion_tokens ?? 0;
      const text = String(data.choices?.[0]?.message?.content ?? "").trim();
      if (text) events.push({ atMs: t, kind: "assistant_text", data: text });
    }
  }
  events.push({ atMs: t, kind: "end" });
  return { events, inputTokens: inTok, outputTokens: outTok };
}

// ---- Agent: Anthropic tool use --------------------------------------------
// Same real loop as OpenAI: feed each tool_use a result and continue until the
// model stops calling tools and speaks.
export async function llmAgentAnthropic(
  system: string, transcript: string, tools: ToolDef[],
  toolResult?: ToolResultFn, model = "claude-sonnet-4-5",
): Promise<AgentReply> {
  const key = requireKey("ANTHROPIC_API_KEY");
  const toolSpec = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const messages: any[] = [{ role: "user", content: transcript }];
  const events: AgentEvent[] = [];
  let t = 100, inTok = 0, outTok = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1024, temperature: 0, system, tools: toolSpec, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    inTok += data.usage?.input_tokens ?? 0;
    outTok += data.usage?.output_tokens ?? 0;
    const blocks = data.content ?? [];
    const toolUses = blocks.filter((b: any) => b.type === "tool_use");

    if (!toolUses.length) {                    // no more tools → this is the spoken reply
      const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      if (text) events.push({ atMs: t, kind: "assistant_text", data: text });
      break;
    }

    messages.push({ role: "assistant", content: blocks });
    const results: any[] = [];
    for (const b of toolUses) {
      const result = toolResult ? toolResult(b.name, b.input ?? {}) : { ok: true };
      events.push({ atMs: t, kind: "tool_call", name: b.name, args: b.input });
      events.push({ atMs: t + 50, kind: "tool_result", ok: true, data: result });
      t += 150;
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: results });
  }

  // Force a closing spoken reply if the agent finished tools without speaking.
  if (!events.some((e) => e.kind === "assistant_text")) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 512, temperature: 0, system,
        messages: [...messages, { role: "user", content: "Now give your one short spoken reply to the caller." }] }),
    });
    if (res.ok) {
      const data = await res.json();
      inTok += data.usage?.input_tokens ?? 0;
      outTok += data.usage?.output_tokens ?? 0;
      const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      if (text) events.push({ atMs: t, kind: "assistant_text", data: text });
    }
  }
  events.push({ atMs: t, kind: "end" });
  return { events, inputTokens: inTok, outputTokens: outTok };
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
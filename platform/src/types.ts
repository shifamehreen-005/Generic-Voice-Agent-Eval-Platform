// ============================================================================
// types.ts — the shared vocabulary of the platform.
//
// These interfaces are lifted directly from the build spec (sections 3, 5, 6,
// 8, 9). The platform code below only ever speaks in these generic shapes; no
// domain type is ever imported into the platform. That is the rule that keeps
// the whole thing generic instead of rotting into a perio-specific script.
// ============================================================================

// ---- 4 · the case file -----------------------------------------------------
export interface Case {
  id: string;
  schemaVersion: number;
  adapter: string;

  // exactly one entry point is used; all three must work
  audioFile?: string | null;
  segmentsFile?: string | null;
  transcriptText?: string | null;

  referenceTranscript?: string;   // for the STT fidelity metric (layer 1)
  criticalTranscript?: string;    // the tokens that actually matter (digits, names)

  speakers?: { primary?: string; roster?: string[] };

  groundTruth: unknown;           // adapter-defined, validated by groundTruthSchema

  provenance: Provenance;
  tags?: string[];
  // NOTE: any key starting with "_" is a human annotation and is stripped by
  // the loader before validation (spec §4, convention 1).
}

export interface Provenance {
  kind: "gold" | "silver";        // gold = human approved, silver = model drafted
  author?: string;
  approvedAt?: string | null;
  model?: string | null;          // set when kind = "silver"
}

// ---- 5 · event trace -------------------------------------------------------
export interface AgentEvent {
  atMs: number;                   // ms since run start — trajectory timing
  kind: "tool_call" | "tool_result" | "assistant_text" | "state_change" | "end";
  name?: string;                  // tool name for tool_call
  args?: Record<string, unknown>;
  ok?: boolean;                   // tool_result
  error?: string;
  data?: unknown;                 // adapter payload; platform never reads inside
  sourceSegmentIds?: number[];    // which transcript segment(s) triggered this
}

export interface TranscriptSegment {
  id: number;
  text: string;
  speaker: string;
  startMs: number;
  durationMs: number;
  isFinal: boolean;
}

// ---- 3 · adapter run I/O ---------------------------------------------------
export interface RunOpts {
  mode: "live" | "replay";        // live hits real STT; replay uses cached segments
  segments?: TranscriptSegment[]; // supplied by the platform in replay mode
  model?: string;
  systemPromptOverride?: string;
  seed?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  events: AgentEvent[];
  segments: TranscriptSegment[];  // what STT produced, or the replayed input
  transcriptText: string;
  stats: RunStats;
  hardFail?: string;              // "crashed" | "ended_early" | "timeout" ...
  cached?: boolean;               // replayed from the agent-event cache; cost is 0
}

// ---- 6 · score object ------------------------------------------------------
export interface Score {
  metrics: Record<string, MetricValue>;   // named 0..1 metrics; adapter chooses names
  composite: number;                       // weighted scalar the gate reads
  weights: Record<string, number>;         // declared, must sum to 1
  mismatches: Mismatch[];                   // typed failures — fuel for the fix loop
  extras: number;                           // hallucinations: produced but not asked for
  hardFail?: string;                        // forces composite to 0
  stats: RunStats;
}

export interface MetricValue {
  value: number;                  // usually accuracy or F1
  total: number;
  correct: number;
  detail?: Record<string, number>;
}

export interface Mismatch {
  class: string;                  // MISSING | WRONG | SHIFTED | TRANSPOSED | EXTRA | OUT_OF_SCOPE ...
  at: string;                     // stable location key, e.g. "tooth:14/side:facial"
  expected: unknown;
  produced: unknown;
  eventIndex?: number;            // pointer back into the trace
  segmentIds?: number[];          // pointer back into the transcript
  heard?: string;                 // transcript words the agent acted on
  said?: string;                  // the same span in the reference transcript
  layer?: "stt" | "agent" | "scorer-uncertain";
}

export interface RunStats {
  wallMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estCostUsd: number;
  perCall: PerCallStat[];
}

export interface PerCallStat {
  name?: string;
  elapsedMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
}

export interface ScoreOpts {
  weights?: Record<string, number>;
}

// ---- 8 · lint --------------------------------------------------------------
export interface LintFinding {
  rule: string;
  severity: "error" | "warn";
  message: string;
  at?: string;
}

// ---- 9 · judge -------------------------------------------------------------
export interface JudgeSpec {
  facts: { id: string; text: string; requiredIn?: string[] }[];
  fields: { key: string; description: string }[];
  checkGrammar?: boolean;         // also grade the writing quality of the output
}

// A single verdict the judge emits. `quote` MUST be verbatim from the source;
// the platform verifies it and discards the verdict if it does not anchor.
export interface JudgeVerdict {
  kind: "coverage" | "support" | "grammar";
  id: string;                     // fact id, or a claim id
  positive: boolean;
  quote: string | null;           // verbatim evidence, or null
}

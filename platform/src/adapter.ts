// ============================================================================
// adapter.ts — THE contract (spec §3). The only surface the platform speaks to.
//
// Rule of thumb from the spec: "if a type name would only make sense to someone
// who knows the vertical, it belongs in the adapter." The platform never imports
// an adapter's domain types — only this interface.
// ============================================================================
import type {
  Case, RunOpts, RunResult, AgentEvent, Score, ScoreOpts,
  JudgeSpec, LintFinding,
} from "./types.ts";
import { ConfigError } from "./errors.ts";

export interface Adapter<GT = unknown, Produced = unknown> {
  /** Stable id, e.g. "perio-chart", "clinical-notes". */
  name: string;

  /** Bump when run() behaviour changes so the agent-event cache misses. */
  version?: string;

  /** Optional JSON-Schema-ish object for the case's groundTruth block. */
  groundTruthSchema?: object;

  /** Domain consistency checks beyond schema. Returns findings, never throws. */
  lint?(gt: GT, c: Case): LintFinding[];

  /** Drive the system under test. Side-effect free outside its own sandbox. */
  run(c: Case, opts: RunOpts): Promise<RunResult>;

  /** Optional: what a tool call returns to the agent mid-run, so a multi-step
   *  flow (look up → check availability → book) can proceed. The real agent loop
   *  feeds this back after each call. Defaults to {ok:true}. MUST NOT encode the
   *  answer key — return only plausible world state (e.g. "patient found",
   *  "these slots are open"), never the graded answer. */
  toolResult?(name: string, args: Record<string, unknown>): unknown;

  /** Reduce the event trace to final state. Pure, no I/O, unit-testable. */
  fold(events: AgentEvent[]): Produced;

  /** Deterministic scoring. Omit if the domain is judge-only. */
  score?(produced: Produced, gt: GT, opts: ScoreOpts): Score;

  /** Judge-scored fields. Omit if the domain is deterministic-only. A domain
   *  may provide BOTH score() and judgeSpec() (e.g. receptionist: structured
   *  booking + a judged spoken reply). */
  judgeSpec?(gt: GT): JudgeSpec;

  /** When both score() and judgeSpec() exist, how much of the composite the
   *  judge part carries (0..1). Default 0.3. */
  judgeWeight?: number;

  /** For a domain with a judged reply, which text the judge grades (e.g. the
   *  spoken confirmation). Defaults to String(produced). */
  judgeTarget?(produced: unknown): string;

  /**
   * Offline stand-in for the §8 model-drafter. In production this is a strong
   * model reading the reference transcript + schema + worked examples. Here it
   * is a deterministic function so `eval draft` works with no API key. Output is
   * always marked provenance.kind = "silver" by the platform.
   */
  draftGroundTruth?(referenceTranscript: string): GT;
}

// ---- adapter registry ------------------------------------------------------
// Adapters self-register here. The platform looks them up by `case.adapter`.
const REGISTRY = new Map<string, Adapter>();

export function register(a: Adapter): void {
  REGISTRY.set(a.name, a);
}

export function getAdapter(name: string): Adapter {
  const a = REGISTRY.get(name);
  if (!a) {
    throw new ConfigError(
      `unknown adapter "${name}". Registered: [${[...REGISTRY.keys()].join(", ")}]. Fix the case "adapter" field or register it in adapters/index.ts.`,
    );
  }
  return a;
}

export function allAdapters(): string[] {
  return [...REGISTRY.keys()];
}

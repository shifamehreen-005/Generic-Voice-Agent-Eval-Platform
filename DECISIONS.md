# Design decisions

The key choices behind the platform and *why* each was made. Read top-to-bottom to
understand how the design hangs together.

---

## 1. Shape of the thing

**A CLI engine, not a web app.**
An agent is *code*, not something you upload through a form. So the platform is a
command-line tool you point at an agent. A web UI is future work — a thin review layer over
the same CLI, not a replacement for it.

**Domain-agnostic engine + per-domain adapters.**
The engine (`platform/`) never contains `if (domain === ...)`. Everything domain-specific
lives behind a four-method **adapter** contract: `run` (drive the agent), `fold` (reduce
its actions to a final answer), `score` (grade deterministically), `judgeSpec` (grade a
spoken reply with an LLM). Swap the adapter and the same engine evaluates a different
agent. This is the core idea: *what to measure* is small and per-domain; *how to run and
grade* is shared and written once.

**You bring an agent, not a scorer.**
Ten different agents in the same domain (yours, a competitor's, v1 vs v2) all use the same
adapter and the same scorer — no changes. You only write scoring when the *domain* is new.

---

## 2. How scoring works

**Four score axes, so a failure localizes.**
- **Heard** — did speech-to-text get the words? (word error rate vs a reference transcript)
- **Tools** — right tools, right order? (from an optional `expectedCalls` list)
- **Correct** — did the final result match the answer key? (deterministic `score()`)
- **Reply** — is the spoken reply faithful? (LLM judge)

A column shows `–` when a case doesn't use that axis (dental has no spoken reply, so its
Reply is blank). This tells you *which step* broke, not just that something did.

**Metrics are unlimited, not fixed at four.**
"Correct" isn't one number — an adapter can define any number of outcome metrics (e.g.
teeth + bleeding + recession), each with its own weight, and each shows as its own column
in the table and its own bar in the report. The four axes are pipeline *stages*, not a cap.

**The grader is code; it never trusts the agent.**
The agent (an LLM) is random. The grader is plain code comparing to a fixed answer key.
Where judgment is unavoidable (is a reply faithful?), the LLM judge must supply a
**verbatim quote** as evidence, and code verifies that quote actually appears in the
source — any claim it can't anchor is discarded. The measuring never trusts the thing
being measured.

**Comparisons live in one tested library (`match.ts`).**
This was the answer to "our scores can't be buggy — users bring different agents, how do
we fix for each?" We don't fix per agent. All equality — dates, times, text, numeric
tolerance, enums, sets — lives in one place with unit tests, so fairness is solved once.
Adapters call `eqText` / `eqDate` / `eqTime` / `nearNum`, never hand-rolled `===`. Every
fairness bug we hit is now a locked-in test.

**Fair by construction, learned from real failures:**
- Dates compare on **month + day**, ignoring the year — a caller says "October 3rd" with
  no year, so an agent can only guess one (it often picks 2023); demanding an exact year
  would fail a correct booking.
- Text ignores case and punctuation, so "check-up" == "checkup".
- Coverage of a required fact is checked **deterministically** (is the fact literally in
  the reply?), so a model that returns a badly-formatted quote can't zero a correct reply.

**The regression gate is what makes it a *testing* tool.**
Every run is compared to the previous run of the same adapter; if the composite drops
(beyond a small tolerance), or a case gains a hard failure, the gate exits non-zero — it
fails the build. Thresholds live in `config/gate.json`, never in code. Cost is gated too,
but loosely, so sub-cent token wobble doesn't false-fail a good run.

**Scoring is versioned and replayable.**
Changing the rules bumps `SCORER_VERSION`. `eval score --run <id>` re-grades saved runs
with the current rules **without re-running the agent or any model** — so a scoring change
is traceable and never silently moves numbers.

---

## 3. The real pipeline

**Full voice loop, real providers.**
`ElevenLabs/OpenAI TTS (speaks the caller) → OpenAI STT → a real LLM agent → scoring`.
The agent runs a genuine **tool-calling loop**: it calls a tool, gets a result, and
continues until it's done — look up → check availability → book → then speak. Without the
loop it would stop after the first tool call.

**The adapter supplies tool results.**
There's no real backend in an eval, so the adapter returns plausible results mid-run
("patient found", "here are open slots") — enough for a multi-step agent to finish, and
never leaking the graded answer.

**The agent is forced to speak.**
Models often go quiet after the last successful tool call. If the agent finishes its tools
without a reply, the loop makes one final no-tools turn so there's always a spoken
confirmation to judge.

**Mock mode for free, deterministic testing.**
`--provider mock` runs the whole platform offline with no API key; `mock-bug` makes
deliberate mistakes. This is the everyday loop; the real path is for the demo.

**Reply audio is saved, but judged as text.**
On a real run the agent's reply is saved as `reply.mp3` (playback for demos). Scoring still
grades the reply *text* — running it back through TTS→STT would only add noise to a reply
we already have, so audio never affects a score.

---

## 4. The two demo agents

**Dental — deterministic, no spoken reply.**
Hears pocket depths and charts each tooth; graded per tooth within a 1 mm tolerance. It's
the clean, mechanical example. (This demo mirrors a real product category: an assistant
that hears a clinician dictate and fills a chart.)

**Receptionist — the richest case.**
Books/reschedules and speaks a confirmation, so it exercises all four axes at once:
deterministic booking + tool order + an LLM-judged reply. It's where the judge earns its
keep — catching an invented "your insurance is fully covered" line the caller never said.

**Good vs weak is a *prompt* difference, not different cases.**
The same cases run twice with two system prompts. The good prompt passes; the weak one is
written to fail *reliably* (dental: adds a 2 mm margin → every reading wrong; receptionist:
invents the insurance line → the judge catches it) so the gate visibly blocks a regression.
We learned dental was too easy to fail on a merely-vague prompt, so the weak prompt had to
induce a concrete, gradeable error.

---

## 5. Project layout

**`demo/` holds all examples; `adapters/` is where your agent goes.**
Everything sample — the two example adapters, their cases, their prompts, the audio
generator — lives under `demo/` and is safe to delete. The top-level `adapters/` folder is
for your own agents, seeded with a heavily-commented `sample-agent.ts` template and a
runnable `sample-case.json`.

**Files are named for what they are.**
Inside each adapter, `adapter.ts` is the contract + scoring rules and `mock.ts` is the
offline stand-in agent. `providers.ts` (the real API calls) stays in the engine because the
platform's own speech-to-text step needs it.

**Results are grouped by adapter and append-only.**
`results/<adapter>/<run>/` holds each run's report, scores, gate result, and per-case
artifacts; nothing is ever mutated, so history is just the pile of runs. A run is labelled
`<name> v<N>`; the gate compares by *adapter*, not by label, so an unnamed run can't dodge
the comparison.

**Speech-to-text is capture-once, replay-many.**
The first run transcribes the audio and caches it; later runs replay the cached transcript,
so re-scoring is free and deterministic and you're not paying for STT on every run.

---

## 6. Documentation

Three docs, three jobs: **README** (start here — what it is, how to run), **GUIDE** (deep
architecture, the sample cases explained, roadmap), and **SUBMISSION** (the narrative /
pitch). This file is the decision log behind all three.
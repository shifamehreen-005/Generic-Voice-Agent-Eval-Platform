# agent-eval — the complete guide

Everything about how the platform works and how to use it: architecture, the file
map, the sample test cases explained, and step-by-step usage. Start with the
[README](./README.md) for the 30-second version; this is the full picture.

---

## 1. What it is (one paragraph)

A voice agent listens to speech and *does things* — transcribes it, decides, and
calls tools that change real data (a chart, a booking). When the result is wrong,
you usually can't tell *which* link broke. This platform runs the agent on a set
of test cases, scores the result against a known-correct answer key at three
levels (heard / tools / outcome), grades any free-text reply with an evidence-
anchored judge, and **fails the build if a new version got worse**. The engine is
domain-agnostic; each domain (dental, receptionist) is a small plug-in.

---

## 2. Architecture — the one idea

The **engine** knows nothing about dentistry or bookings. All domain knowledge
lives behind a four-method **adapter**. Swap the adapter and the same engine
tests a different agent. There is deliberately no `if (domain === …)` in the engine.

```
        you provide                    the platform (never changes per domain)
   ┌───────────────────┐        ┌──────────────────────────────────────────────┐
   │  case .json files  │        │  run → fold → score → judge → gate → report   │
   │  (input + answer)  │───────▶│                                              │
   │  adapters/<name>.ts│        │   speaks only to the Adapter interface        │
   │  (your agent)      │        └──────────────────────────────────────────────┘
   └───────────────────┘                         │
                                                  ▼
                                   results/<adapter>/<run>/report.html
```

The adapter provides four things; the engine calls them and never looks inside:

| method | meaning | dental | receptionist |
|---|---|---|---|
| `run(case)` | drive the agent → tools + transcript | charts teeth | books + replies |
| `fold(events)` | pull out the one thing to grade | `{tooth: [d,d,d]}` | `{booking, reply}` |
| `score(produced, gold)` | what "correct" means (code) | ±1 mm per tooth | field match |
| `judgeSpec(gold)` | rubric for fuzzy text (optional) | — (none) | reply facts + grammar |

Dental has a `score()` and no `judgeSpec()` (it just fills a chart — no reply).
Receptionist has **both** (a booked result *and* a spoken reply). That's how the
platform handles agents that speak and agents that don't, with the same engine.

---

## 3. The five steps, per case

```
  1. RUN ────────▶ 2. FOLD ───────▶ 3. SCORE ──────▶ 4. JUDGE ──────▶ 5. GATE
  play the         reduce the        compare to the    grade the free    is this run
  audio/text,      messy trace       answer key with   text reply (only  worse than the
  agent calls      into one clean    fixed rules       if the domain     previous one?
  tools            result            (3 levels)        has a reply)      pass / fail
```

**Three scoring levels (step 3)** so a failure *localizes*:
- **Heard** — speech-to-text word accuracy (did it hear the numbers?).
- **Tools** — did it call the right tools, with the right arguments, in order?
- **Outcome** — did the final result match the answer key?

When Outcome drops but Heard is fine → the model regressed. When Heard drops too →
blame the audio/STT first.

---

## 4. File structure

```
agent-eval/
├── README.md              quick start + how you define tests & scoring
├── GUIDE.md               this file (deep dive + build-vs-buy pitch + roadmap)
├── package.json           npm scripts (eval, test, eval:real …)
├── .env.example           where API keys go (copy to .env; gitignored)
│
├── adapters/              ← YOU write these. Your agents + your test cases.
│   ├── sample-agent.ts    copy-me template (run / fold / score, heavily commented)
│   ├── sample-case.json   a runnable example test for it
│   └── index.ts           lists which of your adapters are turned on
│
├── demo/                  ← WORKING EXAMPLES to read & learn from (safe to delete)
│   ├── adapters/
│   │   ├── dental/        adapter.ts (contract + scoring) + mock.ts (offline agent)
│   │   ├── receptionist/  adapter.ts + mock.ts
│   │   └── index.ts       registers the two example adapters
│   ├── cases/             one .json per test = what's said + the correct answer
│   │   ├── dental-fullmouth-01.json   dental-quadrant-02.json
│   │   └── receptionist-01.json       receptionist-02.json
│   ├── prompts/           good vs weak system prompts (for the real-agent demo)
│   │   ├── dental-good.txt   dental-weak.txt
│   │   └── receptionist-good.txt  receptionist-weak.txt
│   └── gen-audio.ts       turn case transcripts into real audio (TTS)
│
├── platform/src/          ← the ENGINE. Never changes per domain.
│   ├── types.ts           the shared shapes (AgentEvent, Score, …)
│   ├── adapter.ts         THE contract + registry
│   ├── loader.ts lint.ts  load cases, validate answer keys
│   ├── stt.ts             layer 1 — speech-to-text accuracy
│   ├── trajectory.ts      layer 2 — right tools / order
│   ├── judge.ts           layer 3 — quote-anchored judge harness
│   ├── mockJudge.ts       offline judge (no key)
│   ├── llmJudge.ts        real LLM judge (temperature 0)
│   ├── explain.ts         plain-English "what went wrong"
│   ├── score.ts           assembles the 3 layers into one Score
│   ├── cache.ts           capture-once / replay-many (STT cache)
│   ├── providers.ts       real STT + LLM agent + TTS (ElevenLabs/OpenAI)
│   ├── env.ts             loads API keys from .env
│   ├── run.ts             the run loop
│   ├── store.ts           results/<adapter>/<run>/ layout + run naming
│   ├── report.ts          report.md + report.json
│   ├── reportHtml.ts      the pretty report.html
│   ├── gate.ts            the regression gate
│   └── cli.ts             the commands
│
├── config/gate.json       gate thresholds (not in code)
└── results/               ← the tool writes these, grouped by adapter:
    ├── <adapter>/<run>/   report.html · report.json · gate.json · cases/<id>/…
    └── index.json         history of every run
```

Rule of thumb: **you touch `adapters/` (your agent + cases); the tool fills
`results/`.** `providers.ts` stays in the engine because the platform's own
speech-to-text step uses it; the `demo/` folder is pure example and can be deleted.

---

## 5. What's in a sample test case

A case is just **input + the correct answer**, in a fixed envelope. Two examples:

### Dental — `demo/cases/dental-fullmouth-01.json`
```jsonc
{
  "id": "dental-fullmouth-01",
  "adapter": "dental",
  "audioFile": "dental-fullmouth-01.mp3",           // the spoken dictation (for real STT)
  "referenceTranscript": "Tooth 14 three two four. Tooth 15 two two three. …",
  "criticalTranscript": "three two four two two three …",  // the numbers that matter
  "groundTruth": {                                   // THE ANSWER KEY
    "teeth": { "14": [3,2,4], "15": [2,2,3], "18": [4,5,4], "19": [3,3,2] }
  }
}
```
What it tests: can the agent hear the dictation and chart each tooth's three
pocket depths correctly (within ±1 mm)? No spoken reply, so no judge step.

### Receptionist — `demo/cases/receptionist-01.json`
```jsonc
{
  "id": "receptionist-01",
  "adapter": "receptionist",
  "referenceTranscript": "Hi, this is Marcus Bell. Reschedule my cleaning to October 3rd at 2pm.",
  "groundTruth": {
    "action": "reschedule", "name": "Marcus Bell",       // graded by code
    "date": "2026-10-03", "time": "14:00", "type": "cleaning",
    "reply_facts": [                                       // the spoken reply must confirm these (judge)
      { "id": "rf1", "text": "Marcus Bell" },
      { "id": "rf2", "text": "cleaning" }
    ],
    "expectedCalls": [                                     // the tools that should fire, in order
      { "name": "lookup_patient" },
      { "name": "get_availability", "ordered": true },
      { "name": "reschedule_appointment", "ordered": true }
    ]
  }
}
```
What it tests: does it book the right thing (code), call the tools in the right
order (trajectory), and say a reply that confirms the facts without inventing
anything (judge)? Any key starting with `_` is a human note the loader ignores.

**The four sample cases:**
| case | scenario | what it stresses |
|---|---|---|
| `dental-fullmouth-01` | 4 teeth dictated | hearing numbers, per-tooth accuracy |
| `dental-quadrant-02` | 3 teeth dictated | same, smaller |
| `receptionist-01` | reschedule a cleaning | booking + tool order + reply |
| `receptionist-02` | book a checkup | booking + reply grounding |

---

## 6. How to use it — step by step

### A. Offline, no key (everyday testing)
```bash
npm install
npm test                                                    # the grader's own tests pass

npm run eval -- run --adapter receptionist --provider mock       --name smoke   # good agent
npm run eval -- run --adapter receptionist --provider mock-bug   --name smoke   # broken → gate FAILS
open results/receptionist/smoke-v2/report.html                                 # read it
```

Flow of what just happened:
```
case .json ──▶ run (agent) ──▶ fold ──▶ score+judge ──▶ gate vs smoke v1 ──▶ report.html
```

### B. Fully real, with your keys (the demo)
```bash
cp .env.example .env               # OPENAI_API_KEY is enough (ELEVENLABS optional)
```
Each domain ships a **good** prompt (should pass) and a **weak** prompt (should fail),
so you can watch the gate catch a real regression. Run the good one first — it becomes
the baseline — then the weak one, which is compared against it:

```bash
npm run eval:real:dental           # v1 good  → charts correctly → PASSES (~100%)
npm run eval:real:dental:weak      # v2 weak  → adds a 2mm margin → charts wrong → gate FAILS it

npm run eval:real:receptionist       # v1 good → books + speaks → PASSES
npm run eval:real:receptionist:weak  # v2 weak → invents an insurance line → judge catches it → gate FAILS
```

The first run of each domain is recorded as the baseline (always shown as passed);
the weak run is graded against it, so a drop shows up as **✗ FAILED** with the reason.
(Same idea offline with `--provider mock` vs `mock-bug`, no keys needed.)

**Reply audio** — on a real run the agent's spoken reply is saved automatically to
`results/<adapter>/<run>/cases/<id>/reply.mp3` (ElevenLabs if that key is set, else
OpenAI). Offline `mock` runs skip it; add `--speak` to force it there too. It's demo
playback only: the reply is still judged as *text*, so scores are unchanged; cases with
no reply (dental) are skipped and it no-ops without a TTS key.

### C. Add your own agent + cases
1. Copy `adapters/sample-agent.ts` → `adapters/mydomain.ts`, point `run()` at your
   real agent, fill in `fold()`/`score()`, and add its import to `adapters/index.ts`.
2. Write `.json` cases (input + answer key — copy the shape from `demo/cases/`).
3. `npm run eval -- run --adapter mydomain --cases <your-cases>`.

Nothing in `platform/src/` changes.

### Keeping scores fair (important)
Scoring is written **per domain, once** — not per agent. Ten different agents in
the same domain (yours, a competitor's, v1 vs v2) all run against the same
adapter's `score()`; you only write scoring when the *domain* is new.

So a scorer must be fair by construction. Two rules:

- **Compare with the shared helpers in `platform/src/match.ts`, never hand-rolled
  `===`.** `eqText` (ignores case/punctuation — "check-up" == "checkup"), `eqDate`
  (month+day, ignores an unspoken year — "October 3rd" == "2026-10-03"), `eqTime`
  ("2pm" == "14:00"), `nearNum` (tolerance), `eqEnum` (synonyms), `sameSet`
  (order-insensitive). These are unit-tested in `match.test.ts`, so the same edge
  cases can't be re-broken in each new domain.
- **Unit-test your scorer** like `demo/adapters/dental/score.test.ts` — a scorer is
  a pure function, so pin its behaviour with a handful of asserts. `npm test` runs
  the match tests + every scorer test. A change to scoring bumps `SCORER_VERSION`,
  and `eval score --run <id>` re-grades saved runs with the new rules (no re-running
  the agent), so scoring changes are traceable, never silent.

---

## 7. Reading the results

- **`report.html`** — open this first. Score bars in plain words, the tool-call
  trace, a one-line "fix this", and links to the raw files.
- **CLI table** — Heard / Tools / Correct / Reply / Overall per case, then PASS/FAIL.
- **`results/<adapter>/<run>/cases/<id>/score.json`** — the exact numbers and every mismatch
  (`{class, at, expected, produced}`), for when you want the ground truth of a score.

---

## 8. Why the scores are trustworthy

The agent (an LLM) is non-deterministic; **the grader is not**. Scoring is plain
code comparing to a fixed answer key. Two safeguards handle the randomness:
`--repeat N` measures how much the agent wobbles, and the LLM judge must **quote
verbatim evidence** that plain code verifies — so even the AI grader can't award
credit it can't point at. The measuring never trusts the thing being measured.

---

## 9. Why use this (the short pitch)

**The problem:** a voice agent goes `audio → speech-to-text → decide → call tools →
change real data`. When the result is wrong you can't tell *which link broke*. Teams
find out by listening to recordings and squinting — which doesn't scale and can't run
on every change.

**What this gives you:**
- **Localizes the failure** with three scores (heard / tools / outcome) — which link, not just "it failed".
- **Types every mistake** (`WRONG`, `SHIFTED`, `TRANSPOSED`, `MISSING`, `UNSUPPORTED`, `GRAMMAR`) so the report gives a root cause, not just "78%".
- **Blocks regressions** — the gate fails the build (exit 1) when a new version is worse, costlier, or slower.
- **Won't be fooled on free text** — the judge must quote verbatim evidence that plain code verifies.

**Why build, not buy:** generic voice-eval tools grade the *conversation* with checks
baked into their box. They can't take *your* definition of a correct structured
outcome and grade against *your* answer key — perio charts scored tooth-by-tooth
within ±1 mm, a booking scored field-by-field. That domain-specific outcome scoring,
the gold-answer discipline, and the evidence-anchored judge are the defensible core,
and they sit on a generic engine that never changes when you add a domain.

**In one line:** it's the report card that tells a voice-agent team exactly what their
agent got wrong, where, and whether the latest change made it better or worse —
automatically, on every version.

---

## 10. Roadmap (phase 2+)

Everything in sections 1–8 is built and runs today. Next, in order of value:

**1. The improvement loop (spec §15).** Auto-tune the agent: run baseline → show the
mismatch list to a strong model → get **one** prompt change → re-run → keep it only
if the gate passes and a held-out set doesn't regress. A thin wrapper on the gate we
already have, trustworthy only because the scoring underneath is.

**2. Jev (TypeSafe AI) to cut cost and sharpen the judge.** [Jev](https://typesafe.ai/)
is a fast, cheap, calibrated *decision* model (not an LLM): structured input + a typed
question (yes/no, pick-one, 0–N score) → an answer with a calibrated confidence, at
~1% of LLM cost and ~100 ms. Where it slots in:
- **Cheaper quality scores** — swap the LLM judge's *scalar* checks (professionalism 0–5, "off-policy?", "toxic?") for a Jev call via the same `JudgeClient` interface; keep the quote-anchored grounding in plain code (a confidence score can't cite evidence).
- **Confidence-based review triage (silver → gold)** — run Jev over model-drafted answer keys and send only the *low-confidence* ones to a human.
- **In the improvement loop** — a fast pre-filter for which failures deserve an expensive LLM explanation.

**3. A web UI for the data side (optional).** Keep the CLI for plugging in an agent (an
agent is code, not an upload). A small form is only worth it for dropping a
a case `.json` or an audio clip and hitting "run" — a thin front end over the CLI.

**4. MCP plugin — drive evals from Claude Code.** Wrap the CLI as `eval_run` /
`eval_gate` / `eval_show` so a developer can say "clone this repo and run the evals"
and get the readable summary back. A wrapper around the CLI that already exists.

---

## 11. Known limitations (honest list)

Small, non-blocking gaps, on record so they're not surprises:

- **`segmentsFile` isn't loaded yet.** `audioFile` real STT works (`--stt openai`);
  pre-cached `segmentsFile` input is not wired.
- **Per-call latency is approximate.** `trajectory.ts` pairs a tool call to the next
  `tool_result` by order, not a call id — fine for the (currently synthetic) latency
  stat, not yet exact. A `callId` on events is the clean fix.
- **No parallelism.** `runSet()` is sequential; large suites would want a `--jobs` flag.
- **Judge weights** are per-adapter (`judgeWeight`) rather than a full `config/score.json`.
- **CLI parsing is hand-rolled** — works, help text is basic.

None affect the correctness of the scores; they're phase-2 polish.
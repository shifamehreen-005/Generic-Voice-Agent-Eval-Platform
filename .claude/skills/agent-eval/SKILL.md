---
name: agent-eval
description: Run, score and gate voice agent evals. Use when asked to test an agent,
  check accuracy against ground truth, compare prompts or models, add an eval case,
  or investigate why an eval case regressed.
---

# agent-eval

A router into the CLI. Full detail lives in `README.md` and the build spec.

## Run an eval
`npm run eval -- run --adapter <name> --mode replay` (cases default to `demo/cases`;
pass `--cases <path>` for your own). Results land in `results/<adapter>/<run-id>/report.md`.
Read that first, then `results/<adapter>/<run-id>/cases/<case-id>/score.json` for the mismatch list.

## Compare a change (which model / agent version)
Run baseline, apply the change, run candidate, then
`npm run eval -- gate --baseline <a> --candidate <b>`. Non-zero exit means regression.
Here `--model v1|v2` selects the fixture agent version.

## Add a case
1. Drop the case JSON (or audio) in your cases folder (examples in `demo/cases/`).
2. `npm run eval -- draft --case <file>` to get silver ground truth. 3. `npm run eval -- lint --cases <file>`
and fix every error. 4. A human reviews and flips provenance to gold. Never score
against unreviewed silver.

## Write an adapter
Copy `adapters/sample-agent.ts` and implement the `Adapter` interface. Required:
`run`, `fold`. Then `score` and/or `judgeSpec`; register it in `adapters/index.ts`.
See the worked examples `demo/adapters/dental` (deterministic, real STT + LLM agent)
and `demo/adapters/receptionist` (deterministic booking + judged reply).

## Rules
- Default to replay mode. Live mode costs real money and adds STT variance.
- Never edit ground truth to make a run pass.
- Report the mismatch classes, not just the percentage.

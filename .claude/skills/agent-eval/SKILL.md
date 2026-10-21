---
name: agent-eval
description: Run, score and gate voice agent evals. Use when asked to test an agent,
  check accuracy against ground truth, compare prompts or models, add an eval case,
  or investigate why an eval case regressed.
---

# agent-eval

Drive the eval from this file. Do not open the README or the source unless a command here fails in a way this file does not explain.

Commands run as `npm run eval -- <command>`. Results go under `results/<adapter>/<run-id>/`.

## Loop

```
npm run eval -- doctor
npm run eval -- run --adapter <name> --name v1 --json
# edit the agent prompt or code
npm run eval -- run --adapter <name> --name v2 --json
npm run eval -- diff --a v1 --b v2
```

`--json` prints one object and writes `summary.json`. When stdout is not a terminal it is the default. Read `summary.json` first. Then `cases/<id>/score.json` for the mismatch list. Open `log.txt` only if asked. Do not diff two full reports.

`run` is the label (`v1 v1` when you passed `--name v1`). `runId` is the folder name. `baseline` is the previous run. `gate` is `pass` or `fail`. `exit` matches the process exit code. Each case has `composite`, `delta`, `hardFail`, `mismatches`, `top` (at most 3 lines), `cached`, and `cost`.

## Fix one case

```
npm run eval -- show --run <run> --case <id>
npm run eval -- run --adapter <name> --name v3 --failed-only --json
npm run eval -- run --adapter <name> --name v3 --json
```

`show` prints at most 20 feedback blocks and nothing else. `diff --a <run> --b <run>` prints only cells whose value changed, same block:

```json
{ "class": "WRONG", "at": "field:x", "expected": [], "produced": [],
  "heard": "words the agent acted on", "said": "the reference span",
  "layer": "agent", "eventIndex": 0 }
```

`layer` is `stt` (heard and said disagree on a token that matters), `agent` (they agree and the value is still wrong), or `scorer-uncertain` (no reference transcript). Fix the layer it names. Report the mismatch classes, not a percentage.

`--failed-only` reruns cases that failed the last completed run of this adapter. `skipped` in the summary is how many were left out. After it is green, run once without `--failed-only` before you finish.

## Exit codes

| exit | meaning | what to do |
|---|---|---|
| 0 | pass | keep the change |
| 1 | gate failed | read `top` and `diff`; the candidate is worse than the baseline |
| 2 | a case hard-failed | read `hardFail` on that case; a crash or settle timeout is not a score |
| 3 | bad config or case file | the stderr line names the field; fix that file |
| 4 | provider error or cost ceiling | key, quota, or network: fix `.env`. Cost: `stopped` is `max-cost`; raise `--max-cost` or pass `--case` |

`--debug` prints a stack trace. Without it every error is one line.

## Flags

- `--provider mock` offline. `mock-bug` is the broken demo. `openai` or `anthropic` needs a key in `.env`.
- `--case <id>` one case. `--tag a,b` cases carrying either tag. `--fail-fast` stop after the first failure.
- `--no-cache` forces a fresh agent run. Default replays cached events: `cached: true` and `cost: 0`.
- `--max-cost <usd>` default 5. Hitting it writes a partial summary and exits 4. Stop. Do not raise it to push a change through.
- `--jobs N` default 4. `--repeat N` keeps every pass in `cases/<id>/repeat-<n>/`.
- `--explain` asks a model for prose. Leave it off. The feedback block is what you use.
- `--mode replay` is the default. Do not use `live` unless you mean to pay for speech-to-text.

`doctor` checks node, whether keys are set, that the cache is writable, and that adapters load. Exit 0, or one line per problem.

## Rules

- Replay by default. Live mode spends money and adds speech-to-text variance.
- Never edit ground truth to make a run pass. Silver (`eval draft`) is not gold until a person flips `provenance.kind`.
- Do not score against unreviewed silver.
- Stop when `--max-cost` trips. Report mismatch classes, not just the composite.

## Add an adapter

Copy `adapters/sample-agent.ts`. It scores cells (`field:text`) with tolerance 0 and three metrics: `exact`, `presence`, `clean`. Gold may include `corrections` (applied before scoring) and `neighbors` (a value on the neighbour key is `SHIFTED`). Mismatch classes are `MISSING`, `WRONG`, `SHIFTED`, `TRANSPOSED`, `EXTRA`.

1. Copy the file to `adapters/<name>.ts`. Implement `run`, `fold`, and `score` or `judgeSpec`. Import it from `adapters/index.ts`.
2. Add a case. Exactly one of `audioFile`, `segmentsFile`, `transcriptText`. `provenance.kind` stays `silver` until a person approves it.
3. `npm run eval -- run --cases <file> --adapter <name> --provider mock --json` must pass. `--provider mock-bug` must fail the gate. No key yet.
4. One real run after that: `--provider openai` (needs `OPENAI_API_KEY`).

For an agent that hears segments and keeps state, copy `demo/adapters/form/adapter.ts` instead. Implement `start`, `onSegment`, `end`, `drain`. Put a `segmentsFile` on the case (`id`, `text`, `speaker`, `startMs`, `durationMs`, `isFinal`). `speakers.roster` is who the agent acts on. `--speed 0` is as fast as possible, `--speed 1` keeps the gaps. `--corrupt-speakers 0.3 --corrupt-seed 1` flips that share of operator segments to `UU`. `settleTimeoutMs` bounds `end()`; a timeout is `hardFail: settle_timeout` and exit 2. `settleMs` is on the summary.

A long reply uses `judgeSpec`: `facts` (optional `section`), `forbidden`, `sections` (headings, in order, once). Forbidden words and heading order are code. Facts stay quote-anchored. The model is `config/judge.json`. `--judge-model` overrides it. See `demo/cases/brief`.

`eval score --run <id>` re-grades saved events with no model calls. The platform owns `SCORER_VERSION`.

# Evaluation

Benchmark suites for the ZCode-inspired preset. Each round lives in its own
directory with its own tasks, scripts and results.

The suites exist to observe behaviour, not to produce a score. A task counts
only when its check was verified to fail on the untouched fixture and pass on a
reference solution, and when a run was scored from its session log rather than
from memory of the transcript.

- [Round 1](round-1/README.md): small tasks that exercise instruction
  following, selective reading of a large input, and a frozen file.

## Environment

One evaluation home per operator, for example `DSH_HOME=~/.dsh-zcode-eval`,
with a dedicated profile. Personal instructions and skills change results.

One DSH server at a time. The Web UI shares preset, model and access state
across clients, so a second attached client can retarget a run in flight.

## Scoring a run

`eval/round-1/session-facts.mjs` prints the facts a run is scored on: provider,
model, effort, preset, access mode, turns, tool calls, tokens and the
compaction events the preset emitted. A row is written only from that output
plus the check result. Do not fill a row from the transcript alone.

## Running

```sh
eval/round-1/setup.sh eval/round-1/tasks/01-nested-rules /tmp/zc-01-zcode
eval/round-1/run-check.sh eval/round-1/tasks/01-nested-rules /tmp/zc-01-zcode
```

`run-check.sh` prints `PASS` or `FAIL` and exits with the check status.

## Recorded evidence

Results recorded on 2026-11-19. Round 1 has task checks. The separate scored pilot has model results.

| Item | Command | Result |
| --- | --- | --- |
| Task checks | `setup.sh` then `git apply solution.patch` then `run-check.sh`, three tasks | PASS for each, and FAIL before the patch, recorded in [round-1/verification.md](round-1/verification.md) |
| Live smoke | `eval/live-smoke/run-smoke.sh` | PASS: isolated profile composed, patch rows activated, scripted answer recorded, facts read (`provider=scripted`, 1 turn) |
| Mounted proofs | `pnpm test` | 139 tests, 139 pass, typecheck clean. The script includes `test/pack/*.test.ts` |
| Scored pilot | `eval/scored/runner.ts` plus the official harness | 3 SWE-bench Verified instances, 3 resolved, one attempt each except a disclosed pytest recovery. Details and limits in [scored/REPORT.md](scored/REPORT.md) |

The `test` script uses explicit globs. Bare `node --test` reports four extra
"passing tests" because the runner executes the fixture modules under
`test/fixtures/`, which have top-level code and no assertions. Count real tests
with the script, not with auto-discovery.

The mounted proofs live in `test/context/` and `test/integration/context/`:
restore selection and caps, instruction discovery and budget, prompt snapshot
assembly and reload, full compaction with the restore window, interactive
memory extraction, runtime microcompaction, and workspace-context rooting after
a working-directory change.

## Round 1 model runs

The Round 1 results table is empty. To run a cell, select a profile with an authorized model route, or supply approved credentials to the isolated profile. Record the session facts and the task check together.

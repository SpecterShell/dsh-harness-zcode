# Round 1: preset smoke evaluation

Small tasks for the `ZCode` preset with `Standard` as the control. The point is
to see how a preset behaves on work that resembles ordinary coding, not to
produce a score.

The suite is deliberately small. Two verified tasks say more than ten
unverified ones, and the interesting context behaviour (restore after
compaction, snapshot stability, instruction precedence) is covered by
`test/context/` and `test/integration/context/` where it can be asserted
directly.

## Layout

```
eval/round-1/
  setup.sh             copy a fixture, expand .gz inputs, commit the work dir
  run-check.sh         run one task's check and print PASS or FAIL
  session-facts.mjs    read one session log and print the facts a run is scored on
  verification.md      fail-before / careless-fail / pass-after record
  results.md           table to fill in while running
  tasks/<nn-slug>/
    task.md            prompt to paste into a new session, verbatim
    fixture/           starting repository
    check.sh           automatic check, no network
    rubric.md          review criteria for a human
    solution.patch     reference fix in git apply format
```

## Environment

- `DSH_HOME=~/.dsh-zcode-eval` with a profile that holds only the preset under
  test. Personal instructions and skills change results.
- One DSH server, one attached client. The Web UI shares preset, model and
  access state across clients.
- Full access for every task. Tasks write inside their work dir.
- Models: record the exact ids the session header shows, not the composer
  label. Two rows per task are enough for a smoke round: one account model and
  one subscription model, if both are available.
- No network. Fixtures use only `python3` from the base image.

## Running one task

1. Prepare a fresh work dir.

   ```sh
   eval/round-1/setup.sh eval/round-1/tasks/01-nested-rules /tmp/zc-01-zcode
   ```

2. In the Web UI, create a session with that work dir, choose the preset,
   model and effort, then paste `task.md` verbatim. Do not add hints, do not
   mention the rubric, and answer a question only if the agent asks one.

3. When the turn ends, record the session link and run the check.

   ```sh
   eval/round-1/run-check.sh eval/round-1/tasks/01-nested-rules /tmp/zc-01-zcode
   ```

4. Score the run from the session log, not the transcript.

   ```sh
   node eval/round-1/session-facts.mjs ~/.dsh-zcode-eval/sessions
   ```

   `headerMismatch: true` voids the run. Otherwise copy provider, model,
   effort, preset, turns, tool calls and tokens into `results.md`.

5. Read the transcript once and fill the rubric. Note anything the check
   cannot see: a wrong first fix, a failed patch, a claim the commands do not
   support, files touched outside the task.

## Tasks

| Task | What it exercises |
| --- | --- |
| 01-nested-rules | loading the root and a nested instruction file, then following both a ticket-format rule and a frozen-tests rule |
| 02-log-aggregate | reading a 2.2 MB log without printing it, correcting three definitions against a written spec, producing an artifact |
| 03-frozen-config | reading a generated config file without editing it, and keeping a behaviour that a different config file must still drive |

A run counts when the check prints PASS and its facts come from a log with no
header mismatch. A run that stops early is not retried for a scored row.

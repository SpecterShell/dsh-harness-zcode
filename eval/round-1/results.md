# Round 1 results

No model runs have been recorded yet. This file is a table to fill in while
running the suite, one row per task, preset and model.

Read the facts from `eval/round-1/session-facts.mjs` for the run's session log.
A row with `headerMismatch: true` is void and gets no entry.

| Task | Preset | Provider | Model | Effort | Access | Result | Turns | Tool calls | Tokens | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## How to read a row

- Preset is the display name from the session header, `ZCode` or `Standard`.
- Model is the id the header shows, not the composer label.
- Result is PASS or FAIL from `run-check.sh`.
- Notes hold what the check cannot see: a wrong first fix, a failed patch, a
  command that had to be polled, a claim the transcript does not support.

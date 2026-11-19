# Scored pilot: ZCode preset on GLM-5.3-Flash

Three SWE-bench Verified instances, one attempt each, graded by the official
container harness. Written 2026-11-19.

## Benchmark identity

- Dataset: SWE-bench Verified, revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`
  (500 rows), the subset the DeepSWE card names.
- Selection recorded before any run by host-qa: patch at most 25 lines, at most
  three FAIL_TO_PASS tests, non-security subject, distinct repositories.
- Instances: `pallets__flask-5014` (`7ee9ceb71e`, F2P 1, P2P 59),
  `pytest-dev__pytest-7982` (`a7e38c5c61`, F2P 1, P2P 78),
  `pylint-dev__pylint-4970` (`40cc2ffd78`, F2P 1, P2P 17).

## Cell

- Model: `axonhub` / `glm-5.3-flash`, exactly as configured in the operator's
  web profile. No substitution and no fallback model.
- Preset: `zcode` from this checkout (`preset id zcode`, display `ZCode mode`).
  This is the development checkout, not a published release.
- Composition: real loader, preset registry, preset rows, agent loop, tools,
  executor, filesystem, subprocess, sandbox policy, shell and token meter.
  Workspace writes enabled through the sandbox policy. The model is the only
  real provider call.
- Credentials: resolved by the host credential store from the operator's
  `~/.dsh/.credentials.yaml` refs. The key is never placed in the runner's
  environment, never printed, and never written to disk, so a tool-spawned child
  cannot inherit it.

## Results

| Instance | Grade run | Resolved | F2P | P2P | Patch bytes | Turns | Steps | Tool calls | Wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pallets__flask-5014 | model-flask | true | 1/1 | 59/59 | 1053 | 1 | 39 | 42 | 255 s |
| pytest-dev__pytest-7982 | model-pytest | true | 1/1 | 78/78 | 1659 | 1 | 47 | 46 | 573 s |
| pylint-dev__pylint-4970 | model-pylint | true | 1/1 | 17/17 | 2015 | 1 | 22 | 35 | 281 s |

Patch digests, harness reports and verdicts live next to each cell in
`grade.json` and `report.json`.

| Instance | Patch sha256 |
| --- | --- |
| pallets__flask-5014 | `934d25308bd76938c023c950c89f229b63ac553b426a4ad61db95788b434940b` |
| pytest-dev__pytest-7982 | `b9023cafa7dfa4e9a0fbe6459e6cc5359e45ba85a8401feb2e102c3eeacc0c3c` |
| pylint-dev__pylint-4970 | `44ae07884b083c3d432e4b54ea171385d1b2ebf41b37bbbdb511a68b3e0023f6` |

## Attempts

- flask: one attempt, one graded cell.
- pylint: one attempt, one graded cell.
- pytest: two attempts. The first produced a patch and a session log, but the
  record writer crashed on a relative path before `cell.json` existed, so it was
  never graded, and its directory was deleted before the rerun. Report pytest as
  one graded cell plus one infrastructure recovery. This is not a pass@1 over
  attempts, and the harness record carries the same note.

  Attempt 1 was observed before deletion as: session log with no `turn/end`
  event, `turns: 0`, 33 model steps, 34 tool calls, and a patch with three
  diffs (`changelog/7982.bugfix.rst`, `src/_pytest/pathlib.py`,
  `testing/test_collection.py`) that applied cleanly to the base checkout. Its
  log and patch no longer exist; those counts are the only record of it.

## Controls

Gold-control resolves, so the harness is known to score a correct patch as
resolved. Fail-before is proved across two prediction files rather than one:
flask with an empty patch, pytest and pylint with a marker patch. A reader
expecting a single three-row fail-before run should read it as two runs.
pytest's `ambiguous_failure`/`missing_module` behavior in the fail-before run is
disclosed in `GRADING.md`.

## Limits

- Three instances, one attempt each. This is a pilot, not a benchmark score.
- The agent scaffold is this ZCode preset, not the DeepSWE scaffold. Grading
  protocol and container are unchanged, so the number answers "does this preset
  solve these instances", not "does it match DeepSWE".
- No `standard` baseline ran. Without it, nothing here says the preset beats or
  trails DSH's own composition.
- Byte-level comparison found host differences that would matter for an
  output-equality claim, including UTF-8 BOM removal and different line-ending
  handling. Neither affects these cells, because grading compares test
  outcomes. The [tool guide](../../docs/tools.md#evidence-limits) records the
  results and evidence limits.

## Artifacts

Per instance under `eval/<instance_id>/`:

```
cell.json             model, preset, session id, log path, turns, steps, tools, wall
session-facts.json    facts read from the persisted session log
patch.diff            git diff of the workspace, including created source files
grade.json            official harness verdict, patch sha256, attempts note
report.json           harness report
```

Local runs also create `sessions/` and a `patch-check/` checkout. The published records contain paths relative to the pilot or plugin repository.

Reproduce a cell:

```sh
node eval/scored/runner.ts \
  <pilot>/workspaces/<instance_id> \
  <pilot>/eval/<instance_id>/problem_statement.md \
  eval/<instance_id>
```

`<pilot>` is a checkout of the pilot repository, which holds the prepared
workspaces and problem statements.

Grading runs outside the model's view through
`swebench.harness.run_evaluation`; see `GRADING.md` in the pilot repository.

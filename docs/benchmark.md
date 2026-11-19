# Benchmark

This document compares the `ZCode` preset with DSH's Standard preset on the
same model. The tasks, scripts and raw rows are in [eval/](../eval/).

## Status

The check harness is verified. All three round-1 tasks were exercised three ways on
2026-11-19: unchanged fixture fails, a careless solution fails for the stated
reason, the reference patch passes. The record is in
[eval/round-1/verification.md](../eval/round-1/verification.md).

Round 1 has no recorded model runs. The [separate SWE-bench pilot](../eval/scored/REPORT.md) reports three resolved instances. Rows are
added only from a session log read by `eval/round-1/session-facts.mjs`, and the
table lives in [eval/round-1/results.md](../eval/round-1/results.md).

## What round 1 covers

Three tasks, each about work an agent does every day:

| Task | Behaviour under test |
| --- | --- |
| 01-nested-rules | Loading a root and a nested instruction file, then following a ticket-format rule and a frozen-tests rule |
| 02-log-aggregate | Reading a 2.2 MB log without printing it, correcting three definitions against a written spec, producing an artifact |
| 03-frozen-config | Reading a generated config file without editing it, and keeping the behaviour that a different config file must still drive |

All three tasks carry a check that reads the work product and a rubric for the
transcript. A run passes when the check prints PASS and its session log has no
header mismatch.

## What is measured outside the benchmark

The benchmark scores the work product. Separate tests cover context behaviour, which the work product alone cannot show. `test/context/` covers restore selection and caps,
instruction discovery and budget, prompt snapshots, microcompaction defaults
and the memory index. Those proofs run in the test suite with a fake model and
real host services, and they fail when the pinned ZCode rule drifts.

## Running a row

The full procedure is in [eval/round-1/README.md](../eval/round-1/README.md).
In short: one isolated `DSH_HOME`, one server, one attached client, a fresh
work dir per run, and a session log before any number is written down.

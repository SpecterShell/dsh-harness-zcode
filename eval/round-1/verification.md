# Check verification, round 1

Every task was exercised three ways on this machine, each from a fresh work dir
made by `eval/round-1/setup.sh`:

1. untouched fixture: the check must print `FAIL`;
2. a plausible careless solution: the check must print `FAIL` for the stated
   reason;
3. after `git apply <task>/solution.patch`: the check must print `PASS`.

Environment: Linux 6.8 x86_64, Python 3.10.12, Node.js v24.22.2. No network was
used. Date: 2026-11-19.

| Task | Untouched | Careless solution | Careless failure | After patch |
| --- | --- | --- | --- | --- |
| 01-nested-rules | FAIL: `test_rounds_once_after_summing` fails, 1 of 4 tests | changed the test expectation to `2.02` instead of fixing the rounding | `FAIL: existing files under tests/ changed; the repository rules freeze them` | PASS |
| 02-log-aggregate | FAIL: `out/report.json` is missing; 2 of 3 unit tests fail on their own | implemented the definitions but took a job's service from its last attempt | `FAIL: report behaviour checks failed`, `{'checkout': 662, ...} != {'checkout': 661, ...}` | PASS |
| 03-frozen-config | FAIL: `test_burst_ceiling` fails, 1 of 4 tests | hardcoded both ceilings instead of reading the limit file | `FAIL: clamp ignores the configured limit file`, `AssertionError: 100` where the file said 40 | PASS |

## Notes

- 01's careless patch also changes what the visible suite asserts, but the
  check reports the frozen-tests rule first, which is the rule under test.
- 02's careless solution passes all three visible unit tests and fails only on
  the real log. The fixture log changes service on 10 percent of retries, so
  last-attempt service and first-attempt service disagree. The mini log inside
  `check.sh` covers the same trap on input the fixture never showed.
- 02's untouched failure fires on the missing artifact before the unit tests.
  The careless column shows the behaviour check fails on its own once the
  artifact exists.
- 03's careless solution passes all four visible tests, because the fixture
  config and the hardcoded numbers agree. The check points `LIMITS_PATH` at a
  different file, so only a real read passes.

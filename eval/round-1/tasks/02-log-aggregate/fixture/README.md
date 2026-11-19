# Nightly failure report

`ops/report.py <log> <out>` reads a service log and writes a JSON summary.

## Log format

One event per line, space separated, with quoted `msg` values:

```
2026-10-31T12:00:00Z level=error service=checkout job=J-000123 attempt=1 msg="card declined"
```

Every job has one or more attempts. `attempt` starts at 1 and increases by one.
An attempt is either `level=info` (success) or `level=error` (failure).
`level=warn` lines belong to no job and are ignored by the report.

## Definitions

- A **failed job** is a job whose highest attempt is `level=error`.
- A **retried job** is a job with more than one attempt, whatever the outcome.
- `total_failures` counts failed jobs, not error lines.
- `by_service` counts failed jobs per service. A job's service is the one on
  its first attempt.
- `retried_jobs` counts retried jobs, failed or not.

## Output

```json
{
  "by_service": {"api": 2, "checkout": 1},
  "retried_jobs": 4,
  "total_failures": 3
}
```

## Tests

```sh
python3 -m unittest discover -s tests -q
```

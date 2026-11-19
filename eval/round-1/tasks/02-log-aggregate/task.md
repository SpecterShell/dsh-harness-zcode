The nightly failure report is wrong: it counts retries as extra failures and
reports too many retried jobs. Fix `ops/report.py` so it follows `README.md`
exactly, then run it against `logs/service.log` so `out/report.json` exists.

The log is a few megabytes. Search or stream it, do not print it into the
session. `ops/legacy_report.py` is a frozen audit copy and the log itself is
input, so neither may change. Run the test suite when you finish.

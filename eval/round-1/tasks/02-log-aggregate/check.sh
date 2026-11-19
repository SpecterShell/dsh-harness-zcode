#!/usr/bin/env bash
# Check task 02: definitions fixed, report produced, inputs frozen, behaviour
# generalizes to a log the fixture never saw.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=${1:-$PWD}
[[ -d "$repo" ]] || { echo "no such work dir: $repo" >&2; exit 1; }
repo=$(cd -- "$repo" && pwd)

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cmp -s -- "$here/fixture/ops/legacy_report.py" "$repo/ops/legacy_report.py" \
  || fail "ops/legacy_report.py changed; the audit copy is frozen"
gzip -dc -- "$here/fixture/logs/service.log.gz" | cmp -s -- - "$repo/logs/service.log" \
  || fail "logs/service.log changed; the log is input, not a place to fix counts"

[[ -f "$repo/out/report.json" ]] \
  || fail "out/report.json is missing; the report was not run after the fix"

if ! (cd -- "$repo" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q); then
  fail "unit tests failed"
fi

there=$(mktemp -d "$repo/.zc-eval.XXXXXX")
trap 'rm -rf -- "${there:?}"' EXIT

if ! (cd -- "$repo" && PYTHONDONTWRITEBYTECODE=1 python3 - "$there" <<'PY'
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

here = Path(sys.argv[1])


def expected(path):
    attempts = defaultdict(int)
    final = {}
    service = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        fields = dict(
            part.split("=", 1) for part in line.split() if "=" in part and not part.startswith("msg=")
        )
        level = fields.get("level")
        if level == "warn":
            continue
        job = fields.get("job")
        attempt = int(fields.get("attempt", "1"))
        attempts[job] += 1
        service.setdefault(job, fields.get("service", "unknown"))
        final[job] = level
    failed = [job for job, level in final.items() if level == "error"]
    by_service = defaultdict(int)
    for job in failed:
        by_service[service[job]] += 1
    return {
        "by_service": dict(sorted(by_service.items())),
        "retried_jobs": sum(1 for count in attempts.values() if count > 1),
        "total_failures": len(failed),
    }


def run(log, out):
    result = subprocess.run(
        [sys.executable, "ops/report.py", str(log), str(out)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(out.read_text(encoding="utf-8"))


real = run(Path("logs/service.log"), here / "real.json")
want = expected(Path("logs/service.log"))
assert real == want, f"real log mismatch: {real} != {want}"

mini = here / "mini.log"
mini.write_text(
    "\n".join(
        [
            '2026-10-31T00:00:00Z level=error service=search job=M-1 attempt=1 msg="x"',
            '2026-10-31T00:00:01Z level=info service=search job=M-1 attempt=2 msg="ok"',
            '2026-10-31T00:00:02Z level=info service=api job=M-2 attempt=1 msg="ok"',
            '2026-10-31T00:00:03Z level=error service=worker job=M-3 attempt=1 msg="x"',
            '2026-10-31T00:00:04Z level=error service=worker job=M-3 attempt=2 msg="x"',
            '2026-10-31T00:00:05Z level=error service=worker job=M-4 attempt=1 msg="x"',
            '2026-10-31T00:00:06Z level=warn service=worker job=- attempt=0 msg="queue deep"',
        ],
    )
    + "\n",
    encoding="utf-8",
)
hidden = run(mini, here / "mini.json")
hidden_want = expected(mini)
assert hidden == hidden_want, f"mini log mismatch: {hidden} != {hidden_want}"
print("report checks ok")
PY
); then
  fail "report behaviour checks failed"
fi

echo "task 02 check passed"

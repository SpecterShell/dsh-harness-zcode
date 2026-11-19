#!/usr/bin/env bash
# Check task 01: sum-then-round fix, protected tests, changelog entry.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=${1:-$PWD}
[[ -d "$repo" ]] || { echo "no such work dir: $repo" >&2; exit 1; }
repo=$(cd -- "$repo" && pwd)

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if ! diff -rq -- "$here/fixture/tests" "$repo/tests" >/dev/null; then
  fail "existing files under tests/ changed; the repository rules freeze them"
fi

if ! (cd -- "$repo" && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q); then
  fail "the test suite failed"
fi

if ! (cd -- "$repo" && PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
from decimal import Decimal

from billing.rounding import invoice_total

cases = [
    ([("1.005", 1), ("1.005", 1)], Decimal("2.01")),
    ([("0.333", 3)], Decimal("1.00")),
    ([("2.675", 1), ("2.675", 1)], Decimal("5.35")),
    ([], Decimal("0.00")),
]
for pairs, expected in cases:
    actual = invoice_total(pairs)
    assert isinstance(actual, Decimal), f"return type changed: {type(actual)!r}"
    assert actual == expected, f"{pairs}: got {actual}, expected {expected}"
print("invoice behaviour ok")
PY
); then
  fail "invoice_total behaviour checks failed"
fi

python3 - "$repo/billing/CHANGELOG.md" <<'PY' || fail "billing/CHANGELOG.md has no BIL-431 line under Unreleased"
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
assert "## Unreleased" in text, text
section = text.split("## Unreleased", 1)[1].split("\n## ", 1)[0]
lines = [line for line in section.splitlines() if line.strip()]
assert any(re.match(r"^- BIL-431\s+\S", line) for line in lines), lines
print("changelog ok")
PY

echo "task 01 check passed"

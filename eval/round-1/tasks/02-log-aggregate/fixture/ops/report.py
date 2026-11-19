"""Nightly failure report."""

import json
import re
import sys
from collections import defaultdict

FIELD = re.compile(r'(\w+)=("[^"]*"|\S+)')


def parse(line):
    return {key: value.strip('"') for key, value in FIELD.findall(line)}


def summarize(lines):
    by_service = defaultdict(int)
    errors = 0
    retried = 0
    for line in lines:
        fields = parse(line)
        level = fields.get("level")
        if level == "warn":
            continue
        attempt = int(fields.get("attempt", "1"))
        if attempt > 1:
            retried += 1
        if level == "error":
            errors += 1
            by_service[fields.get("service", "unknown")] += 1
    return {
        "by_service": dict(sorted(by_service.items())),
        "retried_jobs": retried,
        "total_failures": errors,
    }


def main(argv):
    if len(argv) != 3:
        print("usage: report.py <log> <out>", file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as handle:
        report = summarize(handle)
    with open(argv[2], "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

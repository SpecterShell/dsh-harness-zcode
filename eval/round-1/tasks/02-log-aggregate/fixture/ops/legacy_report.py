"""Frozen audit copy of the report that produced the November numbers.

This file is kept for audit only. It is not imported and must not change.
"""

import sys


def main(argv):
    total = 0
    with open(argv[1], encoding="utf-8") as handle:
        for line in handle:
            if "level=error" in line:
                total += 1
    print(total)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

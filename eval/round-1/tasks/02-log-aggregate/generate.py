#!/usr/bin/env python3
"""Build the fixture log once. Deterministic for a fixed seed."""

import gzip
import random
from pathlib import Path

SEED = 20261019
SERVICES = ["api", "checkout", "worker", "search"]
WARN_EVERY = 250
SEED_LINES = Path(__file__).parent / "fixture" / "logs"


def main():
    rng = random.Random(SEED)
    lines = []
    jobs = 20000
    for index in range(1, jobs + 1):
        job = f"J-{index:06d}"
        service = rng.choice(SERVICES)
        attempts = rng.choices([1, 2, 3], weights=[70, 20, 10])[0]
        for attempt in range(1, attempts + 1):
            if attempt > 1 and rng.random() < 0.1:
                # A retry can run on a different host, so the emitting service changes.
                service = rng.choice([name for name in SERVICES if name != service])
            failed = rng.random() < 0.14
            level = "error" if failed else "info"
            msg = rng.choice(["declined", "timeout", "throttled"]) if failed else "ok"
            minute = (index + attempt) % 60
            second = (index * 7 + attempt) % 60
            lines.append(
                f"2026-10-31T{(index % 24):02d}:{minute:02d}:{second:02d}Z "
                f"level={level} service={service} job={job} attempt={attempt} msg=\"{msg}\"",
            )
        # Queue warnings belong to no job, so they carry job=- and attempt=0.
        if index % WARN_EVERY == 0:
            lines.append(
                f"2026-10-31T{(index % 24):02d}:30:00Z "
                f'level=warn service={service} job=- attempt=0 msg="queue deep"',
            )
    SEED_LINES.mkdir(parents=True, exist_ok=True)
    target = SEED_LINES / "service.log.gz"
    with gzip.open(target, "wt", encoding="utf-8", compresslevel=9) as handle:
        handle.write("\n".join(lines) + "\n")
    print(f"wrote {target} with {len(lines)} lines")


if __name__ == "__main__":
    main()

"""Request limit helpers."""

import json
import os
from pathlib import Path

DEFAULT_LIMITS = Path(__file__).resolve().parent.parent / "config" / "limits.json"


def limit_file():
    override = os.environ.get("LIMITS_PATH")
    return Path(override) if override else DEFAULT_LIMITS


def limits():
    return json.loads(limit_file().read_text(encoding="utf-8"))


def clamp(value, key="requests"):
    # TODO: read the ceiling for the key from the limit file.
    return min(value, 100)

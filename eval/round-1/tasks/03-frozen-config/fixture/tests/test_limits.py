import json
import os
import tempfile
import unittest
from pathlib import Path

from app.limits import clamp, limits


class ClampTests(unittest.TestCase):
    def test_requests_ceiling(self):
        self.assertEqual(clamp(150), 100)

    def test_value_under_the_ceiling_passes_through(self):
        self.assertEqual(clamp(12, "requests"), 12)

    def test_burst_ceiling(self):
        self.assertEqual(clamp(150, "burst"), 150)
        self.assertEqual(clamp(400, "burst"), 250)

    def test_limits_reads_the_configured_file(self):
        self.assertEqual(limits()["burst"], 250)


if __name__ == "__main__":
    unittest.main()

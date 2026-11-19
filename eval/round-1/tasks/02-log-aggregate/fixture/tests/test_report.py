import unittest

from ops.report import summarize

SMALL = """\
2026-10-31T10:00:00Z level=error service=checkout job=J-1 attempt=1 msg="declined"
2026-10-31T10:00:05Z level=info service=checkout job=J-1 attempt=2 msg="ok"
2026-10-31T10:01:00Z level=info service=api job=J-2 attempt=1 msg="ok"
2026-10-31T10:02:00Z level=error service=worker job=J-3 attempt=1 msg="timeout"
2026-10-31T10:02:30Z level=error service=worker job=J-3 attempt=2 msg="timeout"
2026-10-31T10:03:00Z level=warn service=worker job=- attempt=0 msg="queue deep"
""".splitlines()


class SummarizeTests(unittest.TestCase):
    def test_counts_failed_jobs_not_error_lines(self):
        report = summarize(SMALL)
        self.assertEqual(report["total_failures"], 1)

    def test_counts_retried_jobs(self):
        report = summarize(SMALL)
        self.assertEqual(report["retried_jobs"], 2)

    def test_service_is_taken_from_first_attempt(self):
        report = summarize(SMALL)
        self.assertEqual(report["by_service"], {"worker": 1})


if __name__ == "__main__":
    unittest.main()

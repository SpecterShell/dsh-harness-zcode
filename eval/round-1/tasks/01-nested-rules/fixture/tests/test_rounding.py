import unittest
from decimal import Decimal

from billing.rounding import invoice_total


class InvoiceTotalTests(unittest.TestCase):
    def test_single_line(self):
        self.assertEqual(invoice_total([("12.50", 2)]), Decimal("25.00"))

    def test_empty(self):
        self.assertEqual(invoice_total([]), Decimal("0.00"))

    def test_rounds_once_after_summing(self):
        total = invoice_total([("1.005", 1), ("1.005", 1)])
        self.assertEqual(total, Decimal("2.01"))

    def test_quantity_multiplies_before_rounding(self):
        total = invoice_total([("0.333", 3)])
        self.assertEqual(total, Decimal("1.00"))


if __name__ == "__main__":
    unittest.main()

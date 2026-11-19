"""Invoice totals with half-up rounding."""

from decimal import Decimal, ROUND_HALF_UP

CENT = Decimal("0.01")


def invoice_total(pairs):
    """Add (unit_price, quantity) pairs and round the result to cents."""
    total = Decimal("0")
    for unit_price, quantity in pairs:
        line = Decimal(unit_price) * Decimal(quantity)
        total += line.quantize(CENT, rounding=ROUND_HALF_UP)
    return total

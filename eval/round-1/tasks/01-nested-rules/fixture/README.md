# Billing helpers

`billing.rounding.invoice_total(pairs)` adds a list of `(unit_price, quantity)`
pairs and returns the amount with two decimals.

```python
from billing.rounding import invoice_total

invoice_total([("1.005", 1), ("1.005", 1)])  # Decimal("2.01")
```

The rounding mode is half-up, applied once to the sum.

Run the tests from the repository root:

```sh
python3 -m unittest discover -s tests -q
```

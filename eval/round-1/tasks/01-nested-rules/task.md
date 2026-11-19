The invoice total is off by a cent on some inputs. `invoice_total` in
`billing/rounding.py` rounds each line before adding, and it should round once,
at the end, half-up to two decimals. Fix it, keep the public signature and the
return type, and leave the existing tests alone. Ticket: BIL-431.

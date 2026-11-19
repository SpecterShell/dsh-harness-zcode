# Rubric: 01-nested-rules

1. **Loaded both instruction files.** The root `AGENTS.md` and the nested
   `billing/AGENTS.md` were read, and the agent described the rules it found.
2. **Found the real cause.** The per-line `quantize` is the bug, and the fix
   moves rounding to the end instead of widening the test.
3. **Kept the interface.** The function still takes price/quantity pairs and
   still returns a two-decimal amount.
4. **Ran the suite.** The agent ran `python3 -m unittest discover -s tests -q`
   from the repository root and showed the result.
5. **Recorded the ticket.** `billing/CHANGELOG.md` has a new line under
   `## Unreleased` naming BIL-431.

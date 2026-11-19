# Rubric: 03-frozen-config

1. **Found the constant.** The agent named the hardcoded ceiling in `clamp()`.
2. **Read the config contract.** The README says both keys, and the env
   override, are part of the interface.
3. **Left the generated file alone.** `config/limits.json` is byte identical.
4. **Ran the suite.** `python3 -m unittest discover -s tests -q` passed.

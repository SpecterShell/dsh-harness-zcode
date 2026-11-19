# Live smoke

Boot one real DSH profile with this bundle and a scripted model, run one
headless task, and read the run's session facts. The scripted model is a
plumbing device: it always answers with one fixed sentence. Nothing here
measures preset quality.

```sh
eval/live-smoke/run-smoke.sh
```

The run uses a throwaway `DSH_HOME`, so the operator's profile, credentials and
sessions are untouched. Output lines:

- `home` and `work`: the temporary roots, printed for diagnosis.
- `exit`: the headless exit status.
- `answer`: the text the scripted model produced.
- `facts`: provider, model, preset, turns, tool calls and tokens, read by
  `eval/round-1/session-facts.mjs` from the session log.

A smoke run passes when `exit` is 0, `facts` reports `provider=scripted`, and
the log parses. Preset quality needs a real model and is out of scope here.

## Current status (2026-11-19): passing

The profile is built from the shipped `headless` template, then three rows are
inserted through the profile patch layer, which is how the shipped web app
composes them:

- `agent-preset-registry` with `default: zcode`
- `dsh-scripted-model`, the adapter
- an `agent-default-model` override pointing at `provider: scripted`

Measured result:

```
exit    0
answer  Scripted model reply: plumbing check only.
facts   provider=scripted model=scripted turns=1 toolCalls=0
smoke   PASS: profile composed, rows activated, scripted answer recorded
```

Two findings worth keeping:

1. Patch entries that name a new row must live under `- insert:`. A bare
   `- id: ...` entry only targets an existing row, so the registry and adapter
   silently never mounted until the insert block was added.
2. The headless runner refuses to compose agent presets. Its adopter rejects
   any session whose header or `agent-preset/selected` names a preset:
   `session "..." runs under agent preset "...", which the one-shot runner does
   not compose`. So this smoke proves composition and plumbing, and the facts
   reader reports `preset=unknown` on purpose.

Live preset execution therefore belongs to the web/app composition, which owns
`agentPresets`. The mounted proofs under `test/integration/` remain the way to
exercise preset rows against real host services without a browser.

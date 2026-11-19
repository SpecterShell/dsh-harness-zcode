#!/usr/bin/env bash
# Boot one real DSH profile with this bundle and a scripted model, run one
# headless task, then read the run's session facts.
#
# Usage: eval/live-smoke/run-smoke.sh [work-dir]
#
# Everything happens under a throwaway DSH_HOME. The real profile, credentials
# and sessions are never touched. The scripted model answers with fixed text,
# so the run proves plumbing only: profile composition, preset row mounting,
# session logging and the facts reader.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd -- "$here/../.." && pwd)
work=${1:-$(mktemp -d /tmp/zcode-live-smoke.XXXXXX)}
home=$(mktemp -d /tmp/zcode-live-home.XXXXXX)
profile=zcode-smoke

cleanup() {
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "kept    $home"
    return
  fi
  chmod -R u+w "$home" 2>/dev/null || true
  rm -rf -- "${home:?}"
}
trap cleanup EXIT

mkdir -p "$work"
cd -- "$work"

echo "home    $home"
echo "work    $work"

# Start from the shipped headless template so the app, approval and session
# rows match a real install.
DSH_HOME=$home dsh --profile "$profile" --from-default-profile headless \
  --dump-config >/dev/null

DSH_HOME=$home dsh plugin --profile "$profile" add "$repo" >/dev/null
DSH_HOME=$home dsh plugin --profile "$profile" add "$here/scripted-model" >/dev/null
# The base and headless layers carry no preset registry, so the bundle's preset
# row would stay pending. Mount the registry the shipped web profile uses as a
# plain plugin row, which is how its app bundle does it.
DSH_HOME=$home dsh plugin --profile "$profile" add \
  @deepseek-ai/dsh-agent-preset-registry >/dev/null 2>&1 || true

# The profile's patch layer is a YAML array. Add the adapter row and a default
# model that points at it. An empty `[]` is replaced in place so template
# entries survive.
python3 - "$home/profiles/$profile/cordis.patch.yml" <<'PY'
import sys

path = sys.argv[1]
entries = """\
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: zcode
    - id: scripted-model
      name: 'dsh-scripted-model'
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: scripted
    model: scripted
"""
text = open(path, encoding="utf-8").read()
if text.strip().endswith("[]"):
    text = text[: text.rfind("[]")] + entries
else:
    text = text.rstrip("\n") + "\n" + entries
open(path, "w", encoding="utf-8").write(text)
PY

set +e
DSH_HOME=$home timeout "${SMOKE_TIMEOUT:-120}" dsh --profile "$profile" headless \
  --approval-policy never \
  'Reply with one short sentence.' \
  </dev/null >"$work/answer.txt" 2>"$work/stderr.txt"
status=$?
set -e

echo "exit    $status"
echo "answer  $(head -c 200 "$work/answer.txt" | tr '\n' ' ')"
if [ -s "$work/stderr.txt" ]; then
  echo "stderr  $(head -c 400 "$work/stderr.txt" | tr '\n' ' ')"
fi

node "$repo/eval/round-1/session-facts.mjs" "$home/sessions" --json >"$work/facts.json" 2>&1 || {
  echo "facts   unavailable"
  head -c 300 "$work/facts.json"
  exit 1
}

node -e '
const facts = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
console.log(`facts   session=${facts.sessionId} preset=${facts.preset} provider=${facts.provider} model=${facts.model}`)
console.log(`facts   turns=${facts.turns} toolCalls=${facts.toolCallTotal} tokens=${facts.totalTokens}`)
if (facts.provider !== "scripted") { console.error("provider is not the scripted adapter"); process.exit(1) }
' "$work/facts.json"

# The profile must compose cleanly: the bundle's preset rows activate, and the
# scripted answer must reach the caller. Preset execution is a separate matter;
# the headless runner refuses to compose presets by design, which the README
# records.
if grep -q 'did not activate' "$work/stderr.txt"; then
  echo "smoke   FAIL: a patch row did not activate"
  grep 'did not activate' "$work/stderr.txt" | head -3
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "smoke   FAIL: headless exited $status"
  exit 1
fi
if ! grep -q 'Scripted model reply' "$work/answer.txt"; then
  echo "smoke   FAIL: the scripted answer never arrived"
  exit 1
fi
echo "smoke   PASS: profile composed, rows activated, scripted answer recorded"

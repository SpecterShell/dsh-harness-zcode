#!/usr/bin/env bash
# Create a fresh, identical working copy of one task fixture.
#
# Usage: eval/round-1/setup.sh <task-dir> <work-dir>
#
# <work-dir> must not exist yet, or must be empty. The fixture is copied there,
# stored `.gz` inputs are expanded, an optional `fixture-prepare.sh` inside the
# task is run, and the result is committed as one initial commit so every run
# starts from the same state.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <task-dir> <work-dir>" >&2
  exit 2
fi

task_dir=$1
work_dir=$2

[[ -d "$task_dir" ]] || { echo "no such task dir: $task_dir" >&2; exit 2; }
task_dir=$(cd -- "$task_dir" && pwd)
[[ -d "$task_dir/fixture" ]] || { echo "task has no fixture/: $task_dir" >&2; exit 2; }

if [[ -e "$work_dir" ]]; then
  [[ -d "$work_dir" ]] || { echo "work dir is not a directory: $work_dir" >&2; exit 2; }
  if [[ -n "$(ls -A -- "$work_dir")" ]]; then
    echo "refusing to use non-empty work dir: $work_dir" >&2
    exit 2
  fi
else
  mkdir -p -- "$work_dir"
fi

work_dir=$(cd -- "$work_dir" && pwd)

cp -a -- "$task_dir/fixture/." "$work_dir/"

# Large or generated inputs are stored compressed; the agent must see plain files.
find "$work_dir" -name '*.gz' -not -path '*/.git/*' -print0 |
  while IFS= read -r -d '' file; do
    gunzip -- "$file"
  done

if [[ -f "$task_dir/fixture-prepare.sh" ]]; then
  ( cd -- "$work_dir" && bash "$task_dir/fixture-prepare.sh" )
fi

cd -- "$work_dir"
git init -q -b main
git config user.name "DSH Eval"
git config user.email "eval@dsh.invalid"
git add -A
git -c commit.gpgsign=false commit -q -m "Initial fixture"

echo "prepared $work_dir from $task_dir"

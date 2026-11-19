#!/usr/bin/env bash
# Run one task's automatic check against a working copy.
#
# Usage: eval/round-1/run-check.sh <task-dir> <work-dir>
#
# Prints PASS when check.sh exits 0, FAIL otherwise, and mirrors the status.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <task-dir> <work-dir>" >&2
  exit 2
fi

task_dir=$1
work_dir=$2

[[ -d "$task_dir" ]] || { echo "no such task dir: $task_dir" >&2; exit 2; }
[[ -d "$work_dir" ]] || { echo "no such work dir: $work_dir" >&2; exit 2; }
task_dir=$(cd -- "$task_dir" && pwd)
work_dir=$(cd -- "$work_dir" && pwd)
[[ -f "$task_dir/check.sh" ]] || { echo "task has no check.sh: $task_dir" >&2; exit 2; }

if bash "$task_dir/check.sh" "$work_dir"; then
  echo "PASS"
  exit 0
else
  echo "FAIL"
  exit 1
fi

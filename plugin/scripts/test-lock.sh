#!/usr/bin/env bash
# Runs a heavy command (unit tests, type-check) while holding one of N machine-wide slots,
# so parallel Claude sessions on one Mac take turns instead of exhausting RAM.
# Usage: test-lock.sh <command> [args...]   Slots: H1_LOCK_SLOTS (default 1).
set -u
slots="${H1_LOCK_SLOTS:-1}"
base="${TMPDIR:-/tmp}"
base="${base%/}/h1-heavy-lock"
mkdir -p "$base"
held=""
release() { [ -n "$held" ] && rm -rf "$held"; }
trap release EXIT INT TERM
while :; do
  for i in $(seq 1 "$slots"); do
    d="$base/slot-$i"
    if mkdir "$d" 2>/dev/null; then
      echo $$ > "$d/pid"; held="$d"; break 2
    fi
    pid="$(cat "$d/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$d"; fi
  done
  sleep 2
done
"$@"

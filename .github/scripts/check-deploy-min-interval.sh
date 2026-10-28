#!/usr/bin/env bash
set -euo pipefail

# BLO-49140 / BLO-12563: every rollout can strand mid-setup runs, so refuse a
# roll while paperclip-0 (the worker, recreated by every deploy) is younger
# than MIN_INTERVAL_SECONDS. OVERRIDE=emergency|rollback skips the refusal.
#
# Inputs (env): POD_CREATED (pod .metadata.creationTimestamp; empty = pod
# absent), OVERRIDE, MIN_INTERVAL_SECONDS (default 6h), NOW_EPOCH (tests).
min="${MIN_INTERVAL_SECONDS:-21600}"
override="${OVERRIDE:-none}"

case "$override" in
  none|"") ;;
  emergency|rollback)
    echo "::warning::Minimum-interval guard overridden (${override})."
    exit 0 ;;
  *)
    echo "::error::Unknown min_interval_override '${override}' (expected none|emergency|rollback)." >&2
    exit 1 ;;
esac

if [ -z "${POD_CREATED:-}" ]; then
  echo "paperclip-0 not found; nothing to strand, allowing deploy."
  exit 0
fi

# Fail closed on an unparseable timestamp rather than deploying blind.
created="$(date -u -d "$POD_CREATED" +%s)"
now="${NOW_EPOCH:-$(date -u +%s)}"
age=$(( now - created ))

if [ "$age" -lt "$min" ]; then
  wait_s=$(( min - age ))
  echo "::error::Deploy refused: paperclip-0 is $(( age / 60 ))m old (created ${POD_CREATED}); minimum interval is $(( min / 60 ))m. Retry in $(( wait_s / 60 ))m, or re-dispatch with min_interval_override=emergency|rollback." >&2
  exit 1
fi
echo "paperclip-0 is $(( age / 60 ))m old; minimum interval $(( min / 60 ))m satisfied."

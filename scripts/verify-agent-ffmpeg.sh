#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: verify-agent-ffmpeg.sh IMAGE}
probe_timeout=${FFMPEG_PROBE_TIMEOUT_SECONDS:-15}

set +e
probe_output=$(timeout --foreground --kill-after=5s "${probe_timeout}s" \
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --user 65534:65534 \
    --entrypoint ffmpeg \
    "$image" -hide_banner -muxers 2>&1)
probe_status=$?
set -e

if [ "$probe_status" -ne 0 ]; then
  if [ "$probe_status" -eq 124 ] || [ "$probe_status" -eq 137 ]; then
    echo "FFmpeg capability probe timed out for ${image}" >&2
  else
    echo "FFmpeg capability probe failed for ${image} (status ${probe_status})" >&2
  fi
  exit 2
fi

if grep -E '(^|[[:space:]])moq_mmt([[:space:]]|$)' <<<"$probe_output" >/dev/null; then
  exit 0
fi

echo "FFmpeg image ${image} lacks required moq_mmt muxer" >&2
exit 1

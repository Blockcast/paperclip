#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: verify-agent-ffmpeg.sh IMAGE}

# Do not use grep -q here. Under pipefail it can close the pipe after the
# first match and turn a valid, still-writing producer into SIGPIPE failure.
docker run --rm --entrypoint ffmpeg "$image" -hide_banner -muxers 2>&1 \
  | grep -E '(^|[[:space:]])moq_mmt([[:space:]]|$)' >/dev/null

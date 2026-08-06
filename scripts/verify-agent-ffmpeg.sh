#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: verify-agent-ffmpeg.sh IMAGE}
probe_timeout=${FFMPEG_PROBE_TIMEOUT_SECONDS:-15}
probe_output_bytes=${FFMPEG_PROBE_OUTPUT_BYTES:-65536}

case "$probe_output_bytes" in
  ""|*[!0-9]*)
    echo "FFMPEG_PROBE_OUTPUT_BYTES must be a positive integer" >&2
    exit 2
    ;;
esac

cidfile=$(mktemp "${TMPDIR:-/tmp}/paperclip-ffmpeg-probe-cid.XXXXXX")
probe_found_file=$(mktemp "${TMPDIR:-/tmp}/paperclip-ffmpeg-probe-found.XXXXXX")
probe_output_file=$(mktemp "${TMPDIR:-/tmp}/paperclip-ffmpeg-probe-output.XXXXXX")

cleanup() {
  local status=$?
  if [ -s "$cidfile" ]; then
    local cid
    cid=$(cat "$cidfile")
    if [ -n "$cid" ]; then
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$cidfile" "$probe_found_file" "$probe_output_file"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

set +e
timeout --foreground --kill-after=5s "${probe_timeout}s" \
  docker run --rm \
    --cidfile "$cidfile" \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --cpus 1 \
    --memory 256m \
    --memory-swap 256m \
    --user 65534:65534 \
    --entrypoint ffmpeg \
    "$image" -hide_banner -muxers 2>&1 \
  | awk -v found_file="$probe_found_file" -v output_file="$probe_output_file" -v max_bytes="$probe_output_bytes" '
      {
        if ($0 ~ /(^|[[:space:]])moq_mmt([[:space:]]|$)/) found = 1;
        line = $0 ORS;
        if (written < max_bytes) {
          remaining = max_bytes - written;
          if (length(line) > remaining) line = substr(line, 1, remaining);
          printf "%s", line >> output_file;
          written += length(line);
          if (written >= max_bytes && !truncated) {
            printf "\n[paperclip] ffmpeg probe output truncated at %d bytes\n", max_bytes >> output_file;
            truncated = 1;
          }
        }
      }
      END {
        if (found) print "1" > found_file;
      }
    '
pipeline_status=("${PIPESTATUS[@]}")
probe_status=${pipeline_status[0]}
filter_status=${pipeline_status[1]}
set -e

if [ "$filter_status" -ne 0 ]; then
  echo "FFmpeg capability probe failed for ${image} while filtering output (status ${filter_status})" >&2
  exit 2
fi

if [ "$probe_status" -ne 0 ]; then
  if [ "$probe_status" -eq 124 ] || [ "$probe_status" -eq 137 ]; then
    echo "FFmpeg capability probe timed out for ${image}" >&2
  else
    echo "FFmpeg capability probe failed for ${image} (status ${probe_status})" >&2
  fi
  exit 2
fi

if [ -s "$probe_found_file" ]; then
  exit 0
fi

echo "FFmpeg image ${image} lacks required moq_mmt muxer" >&2
exit 1

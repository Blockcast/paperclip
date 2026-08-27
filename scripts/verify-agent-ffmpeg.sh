#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: verify-agent-ffmpeg.sh IMAGE}
probe_timeout=${FFMPEG_PROBE_TIMEOUT_SECONDS:-15}
probe_output_bytes=${FFMPEG_PROBE_OUTPUT_BYTES:-65536}
pull_timeout=${FFMPEG_PULL_TIMEOUT_SECONDS:-300}
pull_attempts=${FFMPEG_PULL_ATTEMPTS:-3}
pull_timeout_limit=600
pull_attempts_limit=5

case "$probe_output_bytes" in
  ""|0|*[!0-9]*)
    echo "FFMPEG_PROBE_OUTPUT_BYTES must be a positive integer" >&2
    exit 2
    ;;
esac

validate_bounded_positive_integer() {
  local name="$1"
  local value="$2"
  local limit="$3"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} must be a positive integer" >&2
    return 1
  fi
  # Check the string width before arithmetic so an oversized value cannot
  # wrap before it is rejected.
  if (( ${#value} > ${#limit} )) || (( value > limit )); then
    echo "${name} must not exceed ${limit}" >&2
    return 1
  fi
}

validate_bounded_positive_integer FFMPEG_PULL_TIMEOUT_SECONDS "$pull_timeout" "$pull_timeout_limit" || exit 2
validate_bounded_positive_integer FFMPEG_PULL_ATTEMPTS "$pull_attempts" "$pull_attempts_limit" || exit 2

if ! declared_volumes=$(
  docker buildx imagetools inspect "$image" --format '{{json .Image.Config.Volumes}}' 2>/dev/null
); then
  echo "Unable to inspect FFmpeg image volume declarations for ${image}" >&2
  exit 2
fi
case "$declared_volumes" in
  null|"{}") ;;
  *)
    echo "FFmpeg image ${image} declares writable volumes; refusing capability probe" >&2
    exit 2
    ;;
esac

# Keep registry latency out of the capability budget. A `docker run` may pull
# an image before it starts the requested process, so wrapping the whole run in
# the short probe timeout can misclassify a healthy image as an unsafe probe.
# Pull the immutable reference separately, with bounded retries, and make the
# actual probe refuse any further registry access.
pull_status=1
attempt=1
while [ "$attempt" -le "$pull_attempts" ]; do
  echo "Pulling FFmpeg image ${image} (attempt ${attempt}/${pull_attempts})"
  if timeout --foreground --kill-after=5s "${pull_timeout}s" docker pull "$image"; then
    pull_status=0
    break
  else
    pull_status=$?
  fi
  if [ "$attempt" -lt "$pull_attempts" ]; then
    sleep "$attempt"
  fi
  attempt=$((attempt + 1))
done
if [ "$pull_status" -ne 0 ]; then
  if [ "$pull_status" -eq 124 ] || [ "$pull_status" -eq 137 ]; then
    echo "FFmpeg image pull timed out for ${image}" >&2
  else
    echo "Unable to pull FFmpeg image ${image} (status ${pull_status})" >&2
  fi
  exit 2
fi

probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/paperclip-ffmpeg-probe.XXXXXX")
cidfile="$probe_dir/cid"
probe_output_file="$probe_dir/output"

cleanup() {
  local status=$?
  if [ -s "$cidfile" ]; then
    local cid
    cid=$(cat "$cidfile")
    if [ -n "$cid" ]; then
      docker rm -f "$cid" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$probe_dir"
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

set +e
timeout --foreground --kill-after=5s "${probe_timeout}s" \
  docker run --pull=never --rm \
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
  | {
      head -c "$probe_output_bytes" > "$probe_output_file"
      capture_status=$?
      cat >/dev/null
      drain_status=$?
      if [ "$capture_status" -ne 0 ]; then
        exit "$capture_status"
      fi
      exit "$drain_status"
    }
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

if grep -Eq '(^|[[:space:]])moq_mmt([[:space:]]|$)' "$probe_output_file"; then
  exit 0
fi

echo "FFmpeg image ${image} lacks required moq_mmt muxer" >&2
exit 1

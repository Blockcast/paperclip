#!/usr/bin/env bash
set -euo pipefail

# Agent browser canary. Proves a restricted agent pod can still turn HTML into
# a PNG, and — since PEN-4682 — that the browser it reaches BY NAME is the
# image-pinned headless shell.
#
# Resolving through PATH rather than reading $CHROME_BIN directly is the whole
# point of the PEN-4682 arm. `/paperclip/bin` is persistent fleet state that
# both k8s adapters place after the image's own wrapper directory, and it
# carried a symlink to an ad hoc puppeteer Chrome 149 download that hangs in
# its screenshot path under --user-data-dir. A canary that asserts $CHROME_BIN
# is structurally blind to that: the binary it measures is not the one an agent
# typing `google-chrome` actually runs.

browser_name="${PAPERCLIP_BROWSER_SMOKE_NAME:-google-chrome}"
expected="${CHROME_BIN:-/usr/local/bin/google-chrome}"
timeout_seconds="${PAPERCLIP_BROWSER_SMOKE_TIMEOUT:-20}"
width="${PAPERCLIP_BROWSER_SMOKE_WIDTH:-400}"
height="${PAPERCLIP_BROWSER_SMOKE_HEIGHT:-300}"
output="${1:-$(mktemp --suffix=.png)}"
profile="$(mktemp -d)"
cleanup_output=false

if [ "$#" -eq 0 ]; then
  cleanup_output=true
fi

cleanup() {
  rm -rf "$profile"
  if [ "$cleanup_output" = true ]; then
    rm -f "$output"
  fi
}
trap cleanup EXIT

fail() {
  echo "browser smoke test: $1" >&2
  exit 1
}

# Big-endian unsigned integer out of a byte range, as lowercase hex. `od`
# rather than `xxd`, which the runtime image does not carry.
hex_at() {
  od -An -tx1 -j "$1" -N "$2" -- "$3" | tr -d ' \n'
}

if ! resolved="$(command -v "$browser_name" 2>/dev/null)"; then
  fail "$browser_name does not resolve on PATH ($PATH)"
fi
[ -x "$resolved" ] || fail "resolved $browser_name at $resolved, which is not executable"
[ -x "$expected" ] || fail "CHROME_BIN executable not found at $expected"

# Compare the resolved TARGETS, not the paths: both are normally symlinks into
# /opt, and an equal realpath is the property that matters — it is still the
# pinned binary however many links deep it sits.
resolved_real="$(realpath "$resolved")"
expected_real="$(realpath "$expected")"
if [ "$resolved_real" != "$expected_real" ]; then
  fail "$(cat <<MSG
PATH resolves $browser_name to a browser that is NOT the image-pinned one.
  $browser_name -> $resolved -> $resolved_real
  CHROME_BIN    -> $expected -> $expected_real
Something earlier on PATH is shadowing the image. On an agent Job that is
normally a stale symlink on the /paperclip PVC (PEN-4682/PEN-2077); the
image ships /usr/local/libexec/paperclip/bin/google-chrome to win over it,
so check that directory is still present and still leads PATH.
PATH=$PATH
MSG
)"
fi

: > "$output"
timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" \
  "$resolved" \
  --headless \
  --no-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir="$profile" \
  --window-size="${width},${height}" \
  --screenshot="$output" \
  'data:text/html,<h1>hello</h1>' \
  || fail "$resolved exited $? rendering the canary (124 = exceeded the ${timeout_seconds}s bound and wrote nothing, the hang signature)"

[ -s "$output" ] || fail "screenshot is empty at $output"

# A non-empty file is not a PNG. Chrome has written truncated and error output
# here before, and the point of a canary is to be specific about what it saw.
magic="$(hex_at 0 8 "$output")"
[ "$magic" = "89504e470d0a1a0a" ] || fail "$output is not a PNG: leading bytes are $magic, expected 89504e470d0a1a0a"

# The IHDR chunk is fixed by the spec as the first one: a 13-byte payload typed
# "IHDR", then width and height as big-endian uint32.
ihdr="$(hex_at 8 8 "$output")"
[ "$ihdr" = "0000000d49484452" ] || fail "$output has no IHDR chunk where the spec requires it: bytes 8..16 are $ihdr"

got_width=$((16#$(hex_at 16 4 "$output")))
got_height=$((16#$(hex_at 20 4 "$output")))
if [ "$got_width" -ne "$width" ] || [ "$got_height" -ne "$height" ]; then
  fail "rendered ${got_width}x${got_height}, expected ${width}x${height}"
fi

printf 'browser smoke test: %s -> %s rendered a valid %dx%d PNG, %s bytes, to %s\n' \
  "$browser_name" "$resolved_real" "$got_width" "$got_height" "$(wc -c < "$output")" "$output"

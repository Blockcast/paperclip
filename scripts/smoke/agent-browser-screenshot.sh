#!/usr/bin/env bash
set -euo pipefail

browser="${CHROME_BIN:-/usr/local/bin/google-chrome}"
timeout_seconds="${PAPERCLIP_BROWSER_SMOKE_TIMEOUT:-20}"
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

if [ ! -x "$browser" ]; then
  echo "browser smoke test: executable not found at $browser" >&2
  exit 1
fi

: > "$output"
timeout --signal=TERM --kill-after=5s "${timeout_seconds}s" \
  "$browser" \
  --headless \
  --no-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir="$profile" \
  --window-size=400,300 \
  --screenshot="$output" \
  'data:text/html,<h1>hello</h1>'

if [ ! -s "$output" ]; then
  echo "browser smoke test: screenshot is empty at $output" >&2
  exit 1
fi

printf 'browser smoke test: wrote %s bytes to %s\n' "$(wc -c < "$output")" "$output"

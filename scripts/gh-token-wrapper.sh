#!/bin/sh
# Wraps the real `gh` binary (installed as /usr/bin/gh.real by the base
# Dockerfile) so it reads the live GitHub App installation token from the
# kubelet-refreshed secret-volume file on every invocation, instead of
# falling back to an unmaintained ~/.config/gh/hosts.yml (BLO-13241).
#
# Checked in as a standalone file (rather than an inline Dockerfile heredoc)
# so it has one source of truth and can be exercised directly by
# scripts/gh-token-wrapper.test.mjs without reimplementing the logic in JS.
#
# Falls back to the unmodified binary when the token file is absent/empty,
# so non-agent uses of the image (or a build where the secret was never
# mounted) are unaffected — this is not a hard dependency on the file
# existing.
set -eu

TOKEN_FILE="${PAPERCLIP_GITHUB_TOKEN_FILE:-/paperclip/.secrets/github-token/token}"
REAL_GH="${GH_TOKEN_WRAPPER_REAL_GH:-/usr/bin/gh.real}"

if [ -r "${TOKEN_FILE}" ]; then
  TOKEN="$(tr -d '\r\n' < "${TOKEN_FILE}" 2>/dev/null || true)"
  if [ -n "${TOKEN}" ]; then
    export GH_TOKEN="${TOKEN}"
    export GITHUB_TOKEN="${TOKEN}"
  fi
fi

exec "${REAL_GH}" "$@"

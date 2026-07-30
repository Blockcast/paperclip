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
#
# A second, volume-free delivery path exists for credentials bound per-agent
# rather than mounted fleet-wide: see PAPERCLIP_GITHUB_TOKEN_VALUE below.
set -eu

TOKEN_FILE="${PAPERCLIP_GITHUB_TOKEN_FILE:-/paperclip/.secrets/github-token/token}"
REAL_GH="${GH_TOKEN_WRAPPER_REAL_GH:-/usr/bin/gh.real}"

# PAPERCLIP_GITHUB_TOKEN_VALUE carries a token *value* rather than a path, for
# credentials delivered by the scoped secret-binding path (per-agent /
# per-project env bindings) instead of by a mounted secret volume. It exists so
# a credential can be given to specific agents without mounting it into every
# agent pod: the k8s adapters propagate every main-container secret volume into
# every Job pod with no agent or tenant filter (BLO-18927, BLO-18970), so a
# volume-delivered secret is necessarily fleet-wide.
#
# Precedence: value > file. Both are *explicit caller selections* of an identity
# for one invocation — the same trust model the FILE variable already had, since
# a caller could always point that at a file it wrote. This is deliberately NOT
# GH_TOKEN: the override below must keep clobbering GH_TOKEN unconditionally
# (BLO-13241), so GH_TOKEN cannot double as an input without reopening that bug.
if [ -n "${PAPERCLIP_GITHUB_TOKEN_VALUE:-}" ]; then
  TOKEN="$(printf '%s' "${PAPERCLIP_GITHUB_TOKEN_VALUE}" | tr -d '\r\n')"
  if [ -n "${TOKEN}" ]; then
    export GH_TOKEN="${TOKEN}"
    export GITHUB_TOKEN="${TOKEN}"
  fi
  exec "${REAL_GH}" "$@"
fi

if [ -r "${TOKEN_FILE}" ]; then
  TOKEN="$(tr -d '\r\n' < "${TOKEN_FILE}" 2>/dev/null || true)"
  if [ -n "${TOKEN}" ]; then
    # Deliberately overrides any GH_TOKEN/GITHUB_TOKEN the caller already
    # set, not just supplements an unset one. Plain `gh` prefers an
    # explicit env-var token over hosts.yml, so `GH_TOKEN=<other> gh ...`
    # used to let you temporarily authenticate as something else inside a
    # pod; after this wrapper that override is silently replaced by the
    # live bot token on every call. That's intentional here — every pod
    # getting the live token regardless of what's already in its env is
    # the whole point of BLO-13241 — but it's a real precedence change
    # from stock `gh`, worth this comment so it isn't a surprise.
    export GH_TOKEN="${TOKEN}"
    export GITHUB_TOKEN="${TOKEN}"
  fi
elif [ -e "${TOKEN_FILE}" ]; then
  # Distinguish "file exists but isn't readable" (a permissions
  # misconfig on the mount) from "file legitimately absent" (image used
  # without the secret mounted, the normal non-agent case) — the former
  # is exactly the class of silent failure BLO-13241 itself was: it's
  # worth a signal at the point of failure rather than waiting on the
  # external github-cli-probe alert (onprem-k8s#1077) to notice.
  echo "gh-token-wrapper: ${TOKEN_FILE} exists but is not readable; falling back to unwrapped auth" >&2
fi

exec "${REAL_GH}" "$@"

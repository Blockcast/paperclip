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
# rather than mounted fleet-wide: see GH_SEAT_TOKEN_VALUE below.
set -eu

TOKEN_FILE="${PAPERCLIP_GITHUB_TOKEN_FILE:-/paperclip/.secrets/github-token/token}"
REAL_GH="${GH_TOKEN_WRAPPER_REAL_GH:-/usr/bin/gh.real}"

# GH_SEAT_TOKEN_VALUE carries a token *value* rather than a path, for
# credentials delivered by the scoped secret-binding path (agent-scoped env
# bindings only) instead of by a mounted secret volume. Project, environment and
# routine scope are NOT delivery routes for this key: AGENT_SCOPE_ONLY_ENV_KEYS
# (server/src/services/heartbeat.ts) strips it from all three, so that a
# lower-trust writer cannot select the identity every `gh` call runs as.
# It exists so a credential can be given to specific agents without mounting it
# into every agent pod: the k8s adapters propagate every main-container secret
# volume into every Job pod with no agent or tenant filter (BLO-18927,
# BLO-18970), so a volume-delivered secret is necessarily fleet-wide.
#
# The name deliberately does NOT start with `PAPERCLIP_`. Do not "fix" it for
# consistency with the FILE variable below — the prefix is load-bearing in the
# opposite direction. `isPaperclipRuntimeEnvKey` (server/src/services/
# heartbeat.ts) strips every `PAPERCLIP_*` key out of adapter, environment,
# project and routine env, and agent-scope binding resolution reads that
# already-stripped config. A `PAPERCLIP_`-prefixed name is therefore
# unreachable from the very binding path this branch exists to serve: it would
# be silently deleted server-side and fall through to the file branch with no
# error anywhere. That guard is correct and must stay — it stops user config
# overriding paperclip's own runtime env — so the credential moves out of its
# namespace instead. See BLO-18927 step 2.
#
# The FILE variable keeps its `PAPERCLIP_` prefix on purpose, for the same
# reason inverted: it selects a path on disk, and being strippable is what
# stops project/environment config from redirecting the file branch.
#
# Precedence: value > file. Both are *explicit caller selections* of an identity
# for one invocation — the same trust model the FILE variable already had, since
# a caller could always point that at a file it wrote.
#
# Dropping the `PAPERCLIP_` prefix would otherwise have widened who can set this
# key: environment/project/routine env are overlaid *after* agent-scope
# resolution, so the lowest-trust writer would win and could swap the identity
# `gh` runs as, or park whitespace here and fail every invocation with exit 64.
# The prefix used to prevent that for free. It is now prevented explicitly
# instead: AGENT_SCOPE_ONLY_ENV_KEYS in server/src/services/heartbeat.ts strips
# this key from environment, project and routine env, so only an agent-scoped
# secret binding can set it. Keep those two in sync — renaming here without
# renaming there silently reopens the hole.
#
# This is deliberately NOT GH_TOKEN: the override below must keep clobbering
# GH_TOKEN unconditionally (BLO-13241), so GH_TOKEN cannot double as an input
# without reopening that bug.
if [ "${GH_SEAT_TOKEN_VALUE+x}" = x ]; then
  # Trim surrounding whitespace only — a secret that arrives via a templated
  # env binding routinely picks up a trailing newline, and tabs/spaces are just
  # as likely as CR/LF from a YAML block scalar. Deliberately a trim rather than
  # a delete: `tr -d` would silently splice "ghu_aaa\nbbb" into the single
  # plausible-looking token "ghu_aaabbb" and authenticate as nobody-in-
  # particular, which is the failure mode this whole branch exists to avoid.
  TOKEN="${GH_SEAT_TOKEN_VALUE}"
  while :; do
    case "${TOKEN}" in
      [[:space:]]*) TOKEN="${TOKEN#?}" ;;
      *[[:space:]]) TOKEN="${TOKEN%?}" ;;
      *) break ;;
    esac
  done

  # Both rejections below must exit rather than fall through to the token file
  # or to the real binary: a malformed binding is a misconfiguration, and
  # continuing would run `gh` under whatever ambient GH_TOKEN/GITHUB_TOKEN the
  # caller happened to inherit — an unintended identity, silently.
  if [ -z "${TOKEN}" ]; then
    echo "gh-token-wrapper: GH_SEAT_TOKEN_VALUE is set but holds only whitespace; refusing to run with ambient auth" >&2
    exit 64
  fi
  case "${TOKEN}" in
    *[[:space:]]*)
      # No GitHub token format contains whitespace, so this is either a
      # concatenation of two values or a corrupted binding. Refuse rather than
      # guess which half was meant. The value itself is never echoed.
      echo "gh-token-wrapper: GH_SEAT_TOKEN_VALUE contains embedded whitespace; refusing to guess at the intended token" >&2
      exit 64
      ;;
  esac

  export GH_TOKEN="${TOKEN}"
  export GITHUB_TOKEN="${TOKEN}"
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

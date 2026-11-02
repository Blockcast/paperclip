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
# Falls back to the unmodified binary when the token file is absent/empty *and*
# PAPERCLIP_GITHUB_TOKEN_FILE is unset, so non-agent uses of the image (or a
# build where the secret was never mounted) are unaffected — this is not a hard
# dependency on the file existing. When that variable IS set the caller has
# named a credential, so the same conditions are refused with exit 64 instead
# of being silently downgraded to ambient auth (BLO-37977).
#
# A second, volume-free delivery path exists for credentials bound per-agent
# rather than mounted fleet-wide: see GH_SEAT_TOKEN_VALUE below.
set -eu

TOKEN_FILE="${PAPERCLIP_GITHUB_TOKEN_FILE:-/etc/paperclip/secrets/github-token/token}"
REAL_GH="${GH_TOKEN_WRAPPER_REAL_GH:-/usr/bin/gh.real}"
GH_SELF="${GH_TOKEN_WRAPPER_SELF:-/usr/bin/gh}"
# Absolute, not `git` via PATH: some pods reorder PATH ahead of this image's
# own bin dirs (this is precisely the class of drift BLO-25702 is about), and
# a shadowing `git` could behave arbitrarily differently underneath us here.
GIT_BIN="${GH_TOKEN_WRAPPER_GIT:-/usr/bin/git}"

# PEN-5241: which credential this wrapper actually supplied, for `gh auth
# status` to report. `gh` prints "Logged in ... (GH_TOKEN)" because GH_TOKEN is
# what it was handed — but GH_TOKEN does not exist in the caller's environment,
# this wrapper exports it into the child only. An agent reading that line
# reasonably runs `curl -H "Authorization: Bearer $GH_TOKEN"`, gets an empty
# Bearer, gets 401, and concludes the credential is dead. Naming the real source
# costs one stderr line and removes the whole false trail.
WRAPPER_TOKEN_SOURCE="none — this wrapper supplied no credential; gh is on ambient auth"
# Whether this wrapper exported GH_TOKEN/GITHUB_TOKEN into the child. It does
# not in the ambient-auth fall-through at the tail of this file, which `exec`s
# the real binary with no override — so there `gh` authenticates with whatever
# the *caller* already had (its own GH_TOKEN/GITHUB_TOKEN, or
# ~/.config/gh/hosts.yml). The "(GH_TOKEN) is not set in your shell" correction
# below is true only when we exported it, and is exactly backwards otherwise:
# in the ambient case a "(GH_TOKEN)" line names a variable the caller DOES have
# set. A diagnostic that disagrees with the path it diagnoses is the defect this
# whole change exists to remove, so the two cases get two messages.
WRAPPER_EXPORTED_TOKEN=no

# `gh auth setup-git` asks the running `gh` binary to report its own on-disk
# path (via /proc/self/exe, not argv[0]) and writes that path into git's
# credential.*.helper. Because this wrapper delegates by `exec`, the running
# binary *is* REAL_GH by the time that happens — so a plain exec here
# reproduces BLO-25702 verbatim. Two callers can trigger the write:
# `gh auth setup-git` directly, and `gh auth login`, which runs the identical
# setup-git logic internally when it prompts (or is told, e.g. via
# `--git-protocol https`) to authenticate git — by the time that internal
# call happens, `gh auth login` has *already* been exec'd into REAL_GH, so it
# hits the bug the same way a direct `setup-git` call would. Route both
# subcommands through a non-exec call so the helper that was just written can
# be rewritten back to this wrapper afterward, instead of either reproducing
# the regression or silently skipping a command the caller explicitly asked
# for.
exec_real_gh() {
  # PEN-5241: `gh auth status` is the one command whose whole job is to answer
  # "where is my credential coming from", and stock gh answers it with the name
  # of a variable that is not set in the caller's shell. Correct it at the point
  # of the misdirection. stderr, so no parser of gh's stdout changes behaviour.
  case "${1:-} ${2:-}" in
    "auth status")
      if [ "${WRAPPER_EXPORTED_TOKEN}" = yes ]; then
        echo "gh-token-wrapper: credential source is ${WRAPPER_TOKEN_SOURCE}. Any \"(GH_TOKEN)\" below names the variable this wrapper exported into gh, NOT one set in your shell — \$GH_TOKEN is empty there, so curl-ing with it returns 401 regardless of credential health. Run \`gh paperclip-auth-check\` to test the credential itself (PEN-5241)." >&2
      else
        echo "gh-token-wrapper: credential source is ${WRAPPER_TOKEN_SOURCE}. This wrapper exported nothing, so any \"(GH_TOKEN)\" below names a variable from your OWN environment and gh is authenticating with ambient auth (your GH_TOKEN/GITHUB_TOKEN, or ~/.config/gh/hosts.yml). \`gh paperclip-auth-check\` reports this wrapper's own credential paths and does NOT probe ambient auth (PEN-5241)." >&2
      fi
      ;;
  esac
  case "${1:-} ${2:-}" in
    "pr merge") squash_merge_without_ai_trailers "$@" ;;
    "pr ready") refuse_ready_on_held_draft "$@" ;;
    "api "*) refuse_api_merge "$@"; refuse_api_ready "$@" ;;
  esac
  case "${1:-} ${2:-}" in
    "auth setup-git" | "auth login")
      status=0
      "${REAL_GH}" "$@" || status=$?
      fix_setup_git_credential_helper
      exit "${status}"
      ;;
  esac
  exec "${REAL_GH}" "$@"
}

# BLO-47692: GitHub's default squash message appends a `Co-authored-by:` for
# every commit author who is not the merger, and copies the branch commits'
# own `Co-Authored-By: Claude …` / "Generated with" lines — even on repos set to
# squash_merge_commit_message=BLANK. Every agent merge runs through this
# wrapper, so for `pr merge --squash` it always passes an explicit body: the
# caller's, or else the PR body, with those lines removed. Other trailers
# (`Signed-off-by:`, `values-ack:`) are kept. Non-squash merges are untouched.
#
# A `## Model used` section (the PR template requires one) and any
# `Model used:` line are dropped too. A strip list always misses the next
# form, so after stripping the merge is refused if any attribution text is
# left anywhere in the body.
strip_ai_trailers() {
  awk '
    { l = tolower($0) }
    l ~ /^[ \t]*(```|~~~)/ { fence = !fence }
    !fence && l ~ /^[ \t]*#+[ \t]/ {
      match(l, /#+/)
      if (skip && RLENGTH <= level) skip = 0
      if (!skip && l ~ /^[ \t]*#+[ \t]*model used/) { skip = 1; level = RLENGTH }
    }
    skip { next }
    l ~ /^[ \t]*co-authored-by:/ || l ~ /^[^a-z0-9]*(generated with|model used)/ { next }
    { print }
  '
}

# Attribution shapes only: a bare "model used" or "generated with" also appears
# in the PR template's checklist and in codegen prose, and refusing on those
# refused every templated PR. `co-authored-by:` counts only at the start of a
# line (after list/quote markers): prose that documents the trailer, e.g.
# "drops the `Co-authored-by:` line", is not attribution (BLO-48206).
AI_ATTRIBUTION_RE='^[-*_> \t]*co-authored-by:|noreply@anthropic\.com|noreply@paperclip\.ing|generated with \[?claude|^[-*_> \t]*model used'
refuse_if_ai_attribution_left() {
  if grep -qiE "${AI_ATTRIBUTION_RE}" "$1"; then
    grep -niE "${AI_ATTRIBUTION_RE}" "$1" >&2 || true
    rm -f "$1"
    echo "gh-token-wrapper: refusing the squash merge: the message above still carries AI attribution after scrubbing (BLO-47692); pass a --body-file without it" >&2
    exit 1
  fi
}

# BLO-47692: a merge through `gh api` (REST PUT pulls/N/merge, or the GraphQL
# merge mutations) gets GitHub's default squash message, trailers included,
# and never reaches the scrub above. Refuse it; `gh pr merge` does the same job.
# ponytail: a GraphQL query passed as `query=@file` is not opened, only argv is read.
# `enqueuePullRequest` is deliberately allowed: paperclip lands through its
# rebase merge queue (AC3), which keeps the branch commits and is gated by
# check-pr-commit-trailers.mjs instead.
refuse_api_merge() {
  put=no merge=no prev=""
  for a in "$@"; do
    case "$(printf '%s %s' "${prev}" "${a}" | tr '[:upper:]' '[:lower:]')" in
      "-x put" | "--method put" | *" -xput" | *" -x=put" | *" --method=put") put=yes ;;
    esac
    case "${a}" in
      *pulls/*/merge | *pulls/*/merge\?*) merge=yes ;;
      *mergePullRequest* | *enablePullRequestAutoMerge*) put=yes merge=yes ;;
    esac
    prev="${a}"
  done
  if [ "${put}" = yes ] && [ "${merge}" = yes ]; then
    echo "gh-token-wrapper: refusing a pull-request merge through \`gh api\`: it would land GitHub's default squash message with AI co-author trailers (BLO-47692); use \`gh pr merge --squash\`" >&2
    exit 1
  fi
}

# BLO-48359: a draft can be a human HOLD (merging publishes to production), and
# agents un-drafted three of them on 10-22 because green CI + a clean review read
# like a barrier to clear. On a draft, `gh pr ready` refuses when a human (any
# non-Bot actor) made the latest ConvertToDraftEvent, or opened the PR as a draft,
# or left a comment with hold language. Keyed on `__typename`, not on the author,
# so a human's own draft of their own PR is a hold too. `--undo` (back to draft)
# is always allowed. Fails closed if the PR cannot be read.
# ponytail: reads only the last 100 issue comments, not review bodies or threads;
# the drafted-by arm is the backstop.
HOLD_RE='do not merge|don.t merge|hold until|production hold|user hold|code-owner hold|needs [^ ]+.s go|needs the user.s go'
refuse_ready_on_held_draft() {
  shift 2
  selector="" repo=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --undo) return 0 ;;
      -R | --repo) repo="${2:-}"; shift ;;
      --repo=*) repo="${1#*=}" ;;
      -R?*) repo="${1#-R}" ;;
      -*) ;;
      *) [ -n "${selector}" ] || selector="$1" ;;
    esac
    shift
  done
  url="$("${REAL_GH}" pr view ${selector:+"${selector}"} ${repo:+--repo "${repo}"} --json url --jq .url)" || url=""
  pr_path="${url#https://github.com/}"
  owner="${pr_path%%/*}" rest="${pr_path#*/}"
  name="${rest%%/*}" number="${pr_path##*/}"
  case "${url}" in https://github.com/*/*/pull/[0-9]*) ;; *)
    echo "gh-token-wrapper: refusing \`gh pr ready\`: could not resolve the PR to check it for a human draft hold (BLO-48359)" >&2
    exit 1 ;;
  esac
  # shellcheck disable=SC2016
  reason="$("${REAL_GH}" api graphql -F n="${number}" -f o="${owner}" -f r="${name}" -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){isDraft author{__typename login} timelineItems(last:1,itemTypes:[CONVERT_TO_DRAFT_EVENT]){nodes{... on ConvertToDraftEvent{createdAt actor{__typename login}}}} comments(last:100){nodes{author{__typename login} createdAt url body}}}}}' \
    --jq '.data.repository.pullRequest as $p
      | if $p.isDraft == false then "" else
        [$p.timelineItems.nodes[]] as $d
        | (if ($d | length) > 0
            then [$d[] | select(.actor.__typename != "Bot") | "drafted by \(.actor.login // "unknown") at \(.createdAt)"]
            elif $p.author.__typename != "Bot" then ["opened as a draft by \($p.author.login // "unknown")"]
            else [] end)
        + [$p.comments.nodes[] | select(.author.__typename != "Bot")
          | select(.body | test("'"${HOLD_RE}"'"; "i"))
          | "hold comment by \(.author.login // "unknown") at \(.createdAt): \(.url)"]
        | join("; ") end')" || {
    echo "gh-token-wrapper: refusing \`gh pr ready\`: could not read ${owner}/${name}#${number} to check it for a human draft hold (BLO-48359)" >&2
    exit 1
  }
  if [ -n "${reason}" ]; then
    echo "gh-token-wrapper: refusing to mark ${owner}/${name}#${number} ready for review: it is a human hold (${reason}). Leave it a draft and record the hold on your issue; only a human takes it out; this refusal does not expire, so do not retry it (BLO-48359)" >&2
    exit 1
  fi
}

# BLO-48359: the GraphQL mutation skips the hold check above. Route it through
# `gh pr ready`. ponytail: like refuse_api_merge, only argv is read.
refuse_api_ready() {
  for a in "$@"; do
    case "${a}" in *markPullRequestReadyForReview*)
      echo "gh-token-wrapper: refusing markPullRequestReadyForReview through \`gh api\`: use \`gh pr ready\`, which checks the draft is not a human hold (BLO-48359)" >&2
      exit 1 ;;
    esac
  done
}

squash_merge_without_ai_trailers() {
  squash=no
  for a in "$@"; do
    case "${a}" in -s | -ds | -sd | --squash | --squash=true) squash=yes ;; esac
  done
  [ "${squash}" = yes ] || return 0

  body_file="$(mktemp "${TMPDIR:-/tmp}/gh-merge-body.XXXXXX")"
  have_body=no selector="" repo=""
  n=$#
  i=0
  while [ "${i}" -lt "${n}" ]; do
    a="$1"
    shift
    i=$((i + 1))
    v=""
    case "${a}" in
      -b | --body | -F | --body-file | -R | --repo | -t | --subject | -A | --author-email | --match-head-commit)
        v="${1:-}"
        shift
        i=$((i + 1))
        ;;
      --body=* | --body-file=* | --repo=*) v="${a#*=}" a="${a%%=*}" ;;
      -b?* | -F?* | -R?*) v="${a#-?}" a="${a%"${v}"}" ;;
    esac
    case "${a}" in
      -b | --body)
        printf '%s\n' "${v}" | strip_ai_trailers > "${body_file}"
        have_body=yes
        continue
        ;;
      -F | --body-file)
        if [ "${v}" != - ] && [ ! -r "${v}" ]; then
          rm -f "${body_file}"
          echo "gh-token-wrapper: --body-file ${v} is not readable" >&2
          exit 1
        fi
        if [ "${v}" = - ]; then cat; else cat -- "${v}"; fi | strip_ai_trailers > "${body_file}"
        have_body=yes
        continue
        ;;
      -R | --repo) repo="${v}" ;;
      -*) ;;
      *) [ "${i}" -le 2 ] || [ -n "${selector}" ] || selector="${a}" ;;
    esac
    set -- "$@" "${a}"
    case "${a}" in
      -t | --subject | -A | --author-email | --match-head-commit) set -- "$@" "${v}" ;;
      --repo) set -- "$@" "${v}" ;;
      -R) set -- "$@" "${v}" ;;
    esac
  done

  if [ "${have_body}" = no ]; then
    # Fail closed: a trailer that reaches main cannot be taken back.
    if ! "${REAL_GH}" pr view ${selector:+"${selector}"} ${repo:+--repo "${repo}"} --json body --jq .body > "${body_file}.raw"; then
      rm -f "${body_file}" "${body_file}.raw"
      echo "gh-token-wrapper: could not read the PR body to build a squash message without AI co-author trailers (BLO-47692); pass --body-file explicitly" >&2
      exit 1
    fi
    strip_ai_trailers < "${body_file}.raw" > "${body_file}"
    rm -f "${body_file}.raw"
  fi
  refuse_if_ai_attribution_left "${body_file}"

  status=0
  "${REAL_GH}" "$@" --body-file "${body_file}" || status=$?
  rm -f "${body_file}"
  exit "${status}"
}

# Best-effort repair of whatever `gh auth setup-git` (directly, or via `gh
# auth login`'s internal call to the same logic) just wrote with `--global`.
# gh has no notion of this wrapper's split HOME-per-workspace layout, so it
# always ends up in whichever file `git config --global` itself resolves for
# the current environment: normally "${HOME}/.gitconfig", but
# "$XDG_CONFIG_HOME/git/config" instead when that file already exists (see
# the FILES section of git-config(1)). Repairing through `git config` rather
# than sed on a path we guess means git resolves that file for us, so both
# locations are covered without this script needing to know which one
# applies (BLO-25702 review S2 on PR #1311 — the sed version only ever
# checked "${HOME}/.gitconfig").
#
# `--fixed-value` treats both the search pattern and (implicitly, since we
# only ever pass the literal value we just searched for) the value we match
# on as exact strings, not regexes — REAL_GH/GH_SELF come from
# GH_TOKEN_WRAPPER_REAL_GH/GH_TOKEN_WRAPPER_SELF, caller-controlled env vars,
# and the prior sed-based version only escaped "." in them, so a path
# containing "#", "&", "\", or another sed/regex metacharacter could corrupt
# the gitconfig instead of failing loudly (BLO-25702 review, same PR).
# Scoped to the exact value gh's own setup-git logic writes — a shell-out
# credential helper pointing at REAL_GH — so it never touches an unrelated
# helper a caller configured on purpose.
fix_setup_git_credential_helper() {
  [ -n "${HOME:-}" ] || return 0

  broken_value="!${REAL_GH} auth git-credential"
  fixed_value="!${GH_SELF} auth git-credential"

  matches=$("${GIT_BIN}" config --global --fixed-value --get-regexp '^credential\..*\.helper$' "${broken_value}" 2>/dev/null) || return 0

  echo "${matches}" | while IFS=' ' read -r key value; do
    [ -n "${key}" ] || continue
    "${GIT_BIN}" config --global --fixed-value --replace-all "${key}" "${fixed_value}" "${broken_value}" 2>/dev/null || true
  done

  echo "gh-token-wrapper: gh auth setup-git (directly or via gh auth login) wrote a credential helper pointing at ${REAL_GH} (its own on-disk path, per BLO-25702); rewrote the global git config to route through ${GH_SELF} instead" >&2
}

# BLO-40279: never read a credential off the fleet-shared data volume. Every
# agent uid can write there, so a readable file on it proves nothing about who
# put it there — a vacated /paperclip/.secrets/<name>/ is a bare, group-writable
# directory, and a token planted in it would run `gh` as an identity the caller
# never chose. A Secret mounted *under* the volume is its own tmpfs with its own
# device, so it still passes. Compared by device rather than by path prefix,
# because a symlink or any other pinned path reaches the same filesystem. Fails
# closed when either side cannot be stat'ed.
#
# Defined up here with the other functions, rather than beside its first use in
# the branch chain below, so `paperclip_auth_check` can reach it too (PEN-5241).
# The self-test has to report the same shared-volume verdict the real path would
# reach, and deriving that from a second implementation is how a diagnostic ends
# up disagreeing with the thing it diagnoses.
SHARED_VOLUME="${PAPERCLIP_HOME:-/paperclip}"
token_file_on_shared_volume() {
  [ -d "${SHARED_VOLUME}" ] || return 1
  shared_dev="$(stat -L -c %d -- "${SHARED_VOLUME}" 2>/dev/null)" || return 0
  file_dev="$(stat -L -c %d -- "${TOKEN_FILE}" 2>/dev/null)" || return 0
  [ "${file_dev}" = "${shared_dev}" ]
}

# PEN-5241: `gh paperclip-auth-check` — a one-shot GitHub credential self-test.
#
# `401 Bad credentials` is the byte-identical response GitHub returns for every
# credential fault there is: revoked token, expired token, unset variable, empty
# file read, mid-rotation race, and an `Authorization: Bearer ` with nothing
# after it. It is not a diagnosis. It reads like one, and on 2026-11-02 two
# agents reached opposite wrong conclusions from it inside fifteen minutes —
# one hand-rolled a five-probe isolation and still could not tell its own seat
# from the fleet (PEN-5239), the other measured a 200 on a *later* token
# generation and wrote a false all-clear into a bug report (PEN-5241).
#
# The self-test an agent reaches for first cannot work here. `curl -H
# "Authorization: Bearer $GH_TOKEN" ...` reads a variable that does not exist in
# an agent pod — this wrapper exports GH_TOKEN into the child it execs, never
# into the caller's shell — so it sends an empty Bearer and gets 401 regardless
# of credential health. That is a false credential-death signal reachable in one
# command, and it reads as confirmation.
#
# Three properties this has to have, each one bought by a specific past failure:
#
#  1. It is dispatched BEFORE every credential branch below, so it still answers
#     on a pod where those branches exit 64. A diagnostic that needs a working
#     credential to tell you the credential is broken is not a diagnostic.
#  2. It separates "GitHub said no" from "we never reached GitHub", using
#     PEN-5239's control — an *unauthenticated* /rate_limit beside the
#     authenticated probe. A bare authenticated 401 cannot tell those apart, and
#     PEN-5239 had to establish that by hand mid-incident. (This is where
#     PEN-5239's own "detector exists" item is satisfied.)
#  3. It prints the mount generation and a truncated SHA-256. The rotator
#     re-mints every 20 minutes and kubelet propagates into a *running* pod
#     within seconds, so the live token turns over several times inside one
#     agent wake. Without naming which generation a result describes, two pods
#     disagreeing is indistinguishable from one pod changing over time — which
#     is precisely the false clear that PEN-5241 was filed with.
#
# Never prints credential material: a truncated hash identifies a generation
# without revealing it, which is what makes two reports comparable at all.
GITHUB_API_BASE="${GH_TOKEN_WRAPPER_API_BASE:-https://api.github.com}"

# Emits "<http_code> <x-ratelimit-limit>". http_code is 000 when the request
# never completed (DNS, TLS, proxy, timeout) — curl's transport failure is a
# different fact from any status GitHub returns, and collapsing the two is the
# mistake this whole subcommand exists to stop. The token, when present, travels
# in a 0600 config file rather than argv, so it is never visible in `ps`.
#
# `-q` is passed first on both calls, and must stay first: curl reads ~/.curlrc
# unless -q is the *first* argument, and a .curlrc — in a HOME on a writable
# shared path, or just stray operator config — could inject proxy/insecure/extra
# headers into the request that carries the live Bearer. Same "do not trust what
# another uid could have planted" model as BLO-40279.
auth_check_probe() {
  probe_path="$1"
  probe_cfg="${2:-}"
  # A read-only or full TMPDIR must produce a named failure rather than `set -e`
  # killing the diagnostic with a bare shell error — the one tool an agent
  # reaches for when nothing else works cannot die without saying why.
  probe_hdr="$(mktemp "${TMPDIR:-/tmp}/gh-auth-check.XXXXXX" 2>/dev/null)" || {
    echo "gh-token-wrapper: paperclip-auth-check cannot create a temp file in ${TMPDIR:-/tmp}; cannot run the probe (PEN-5241)" >&2
    exit 70
  }
  # Scoped to this probe: an interrupt during the up-to-15s curl must not leave
  # the header file behind. Setting it here also replaces the caller's EXIT trap
  # for the duration of this command-substitution subshell, so the caller's
  # cleanup cannot run early against its own still-in-use temp file.
  trap 'rm -f "${probe_hdr}"' EXIT
  trap 'rm -f "${probe_hdr}"; exit 130' INT
  trap 'rm -f "${probe_hdr}"; exit 143' TERM
  probe_code=000
  if [ -n "${probe_cfg}" ]; then
    probe_code="$(curl -q -sS --max-time 15 --config "${probe_cfg}" -o /dev/null -D "${probe_hdr}" \
      -w '%{http_code}' "${GITHUB_API_BASE}${probe_path}" 2>/dev/null)" || probe_code=000
  else
    probe_code="$(curl -q -sS --max-time 15 -o /dev/null -D "${probe_hdr}" \
      -w '%{http_code}' "${GITHUB_API_BASE}${probe_path}" 2>/dev/null)" || probe_code=000
  fi
  [ -n "${probe_code}" ] || probe_code=000
  probe_limit="$(awk 'tolower($1) == "x-ratelimit-limit:" { v = $2 }
    END { gsub(/\r/, "", v); print (v == "" ? "-" : v) }' "${probe_hdr}" 2>/dev/null)" || probe_limit="-"
  [ -n "${probe_limit}" ] || probe_limit="-"
  rm -f "${probe_hdr}"
  printf '%s %s\n' "${probe_code}" "${probe_limit}"
}

# Reports the kubelet atomic-writer generation backing a mounted Secret. kubelet
# writes each version into a `..<timestamp>.<nonce>` directory and flips a
# `..data` symlink at it, so the symlink target IS the generation identifier and
# it is readable from inside the pod with no API access. Prints "-" for a token
# file that is not a Secret mount (a path a caller wrote itself, or the test
# harness's temp file), which is itself the answer to "is this pod reading a
# managed credential or something someone left here".
auth_check_mount_generation() {
  gen_dir="$(dirname -- "$1")"
  if [ -L "${gen_dir}/..data" ]; then
    readlink "${gen_dir}/..data" 2>/dev/null || printf '%s\n' "-"
  else
    printf '%s\n' "-"
  fi
}

# Removes the probe config file, which is the one temp file here that carries
# the token. 0600 and short-lived, but "short-lived" stops being true the moment
# the probe is interrupted, so the cleanup is a trap rather than a trailing rm.
auth_check_cleanup() {
  [ -n "${check_cfg:-}" ] && rm -f "${check_cfg}"
  return 0
}

paperclip_auth_check() {
  check_source="none" check_state="absent" check_gen="-" check_written="-"
  check_hash="-" check_bytes="-" check_token="" would_refuse=no check_cfg=""
  trap 'auth_check_cleanup' EXIT
  trap 'auth_check_cleanup; exit 130' INT
  trap 'auth_check_cleanup; exit 143' TERM

  # Mirrors the precedence the branches below actually implement (value > file).
  # Reporting a source the wrapper would not have used is the same class of
  # misdirection as `gh auth status` naming GH_TOKEN, so this follows the real
  # order rather than checking whichever is cheaper.
  if [ "${GH_SEAT_TOKEN_VALUE+x}" = x ]; then
    check_source="GH_SEAT_TOKEN_VALUE (agent-scoped secret binding)"
    # Same trim as the real branch: surrounding whitespace only, never a delete.
    check_token="${GH_SEAT_TOKEN_VALUE}"
    while :; do
      case "${check_token}" in
        [[:space:]]*) check_token="${check_token#?}" ;;
        *[[:space:]]) check_token="${check_token%?}" ;;
        *) break ;;
      esac
    done
    if [ -z "${check_token}" ]; then
      check_state="set-but-whitespace-only"
      would_refuse=yes
    else
      case "${check_token}" in
        *[[:space:]]*)
          check_state="set-but-contains-embedded-whitespace"
          would_refuse=yes
          check_token=""
          ;;
        *) check_state="present" ;;
      esac
    fi
  else
    if [ "${PAPERCLIP_GITHUB_TOKEN_FILE+x}" = x ]; then
      check_source="PAPERCLIP_GITHUB_TOKEN_FILE=${TOKEN_FILE}"
      # `+x` not `-n`, matching require_token_file: a set-but-empty variable has
      # still named a credential, and treating it as unset is the fail-open this
      # wrapper exists to kill.
      would_refuse=yes
    else
      check_source="compiled-in default ${TOKEN_FILE} (PAPERCLIP_GITHUB_TOKEN_FILE unset)"
    fi

    if [ -r "${TOKEN_FILE}" ] && token_file_on_shared_volume; then
      check_state="on-shared-${SHARED_VOLUME}-volume-not-trusted"
    elif [ -r "${TOKEN_FILE}" ]; then
      check_token="$(tr -d '\r\n' < "${TOKEN_FILE}" 2>/dev/null || true)"
      case "${check_token}" in
        *[![:space:]]*) check_state="present" ;;
        *) check_state="empty"; check_token="" ;;
      esac
      check_gen="$(auth_check_mount_generation "${TOKEN_FILE}")"
      check_written="$(stat -L -c %y -- "${TOKEN_FILE}" 2>/dev/null | cut -d. -f1)" || check_written="-"
      check_bytes="$(printf '%s' "${check_token}" | wc -c | tr -d ' ')"
    elif [ -e "${TOKEN_FILE}" ]; then
      check_state="exists-but-unreadable"
    else
      check_state="absent"
    fi
  fi

  if [ -n "${check_token}" ]; then
    check_hash="$(printf '%s' "${check_token}" | sha256sum 2>/dev/null | cut -c1-8)" || check_hash="-"
    [ -n "${check_hash}" ] || check_hash="-"
  fi

  # PEN-5239's control, and it runs unconditionally: proving egress to GitHub is
  # healthy is what turns a 401 into evidence instead of a guess, and proving it
  # is *un*healthy is what stops a network fault being reported as a dead
  # credential. An anonymous caller is rate-limited at 60/hr, so this doubles as
  # the reference value for the ambient-auth arm below.
  #
  # `set -f` first: the second field is a response header value, and an
  # unquoted expansion also globs — a `*` would expand to cwd filenames and
  # shift $2 out from under the verdict logic.
  set -f
  set -- $(auth_check_probe "/rate_limit")
  set +f
  # The probe's `exit 70` only ends the command-substitution subshell, so a
  # failed mktemp arrives here as an empty `set --`, not as an exit. Re-raise it
  # at the call site: without this, `anon_code="$1"` trips `set -u` and the
  # wrapper dies with rc 2 — which is the NO_CREDENTIAL verdict code, so a
  # read-only TMPDIR would read as a missing credential. Checking the arity also
  # fails closed on any other malformed probe output.
  [ $# -eq 2 ] || exit 70
  anon_code="$1" anon_limit="$2"

  auth_code="-" auth_limit="-"
  if [ -n "${check_token}" ]; then
    # /installation/repositories, not /rate_limit: a healthy *App installation*
    # token authenticates there and is refused per-endpoint elsewhere (403 on
    # /user, per PEN-3193), so a 200 here is positive proof of the identity this
    # pod is supposed to hold rather than merely "some credential was accepted".
    check_cfg="$(mktemp "${TMPDIR:-/tmp}/gh-auth-check-cfg.XXXXXX" 2>/dev/null)" || {
      echo "gh-token-wrapper: paperclip-auth-check cannot create a temp file in ${TMPDIR:-/tmp}; cannot run the authenticated probe (PEN-5241)" >&2
      exit 70
    }
    chmod 600 "${check_cfg}"
    printf 'header = "Authorization: Bearer %s"\n' "${check_token}" > "${check_cfg}"
    set -f
    set -- $(auth_check_probe "/installation/repositories" "${check_cfg}")
    set +f
    # Same arity guard as the unauthenticated probe above, for the same reason.
    # The EXIT trap removes check_cfg on the way out.
    [ $# -eq 2 ] || exit 70
    auth_code="$1" auth_limit="$2"
    rm -f "${check_cfg}"
    check_cfg=""
  fi

  if [ "${anon_code}" = 000 ]; then
    github_reachable="NO (unauthenticated ${GITHUB_API_BASE}/rate_limit did not complete)"
  else
    github_reachable="yes (unauthenticated /rate_limit -> ${anon_code}, x-ratelimit-limit ${anon_limit})"
  fi

  # Verdicts are deliberately four distinct states with four distinct exit
  # codes, because the whole defect is that GitHub collapses them into one
  # string. Order matters: a transport failure is decided before anything is
  # read as a statement by GitHub.
  if [ -z "${check_token}" ]; then
    if [ "${would_refuse}" = yes ]; then
      verdict="NO_CREDENTIAL — no usable token (${check_state}); \`gh\` will refuse with exit 64, it will NOT fall back to ambient auth"
      verdict_code=2
    else
      # `-` means the unauthenticated probe never returned a limit header, so
      # "(rate limit -/hr)" would dress an unknown up as a measurement.
      anon_rate=""
      [ "${anon_limit}" = "-" ] || anon_rate=" (rate limit ${anon_limit}/hr)"
      verdict="AMBIENT_AUTH — this wrapper supplied no credential and none was named, so \`gh\` runs on whatever auth the caller already had (its own GH_TOKEN/GITHUB_TOKEN, or ~/.config/gh/hosts.yml); this check does NOT probe that. With no ambient credential either, gh is unauthenticated${anon_rate}"
      verdict_code=3
    fi
  elif [ "${auth_code}" = 000 ]; then
    verdict="GITHUB_UNREACHABLE — a token is present and intact, but the authenticated request never completed; this is NOT a credential fault"
    verdict_code=4
  elif [ "${auth_code}" = 200 ]; then
    verdict="OK — valid GitHub App installation token (rate limit ${auth_limit}/hr)"
    verdict_code=0
  elif [ "${auth_code}" = 401 ]; then
    if [ "${anon_code}" = 000 ]; then
      verdict="GITHUB_UNREACHABLE — authenticated 401, but unauthenticated GitHub is unreachable too, so the 401 is not trustworthy evidence about the credential"
      verdict_code=4
    else
      verdict="REJECTED — the token reached GitHub and GitHub refused it, while unauthenticated GitHub answered ${anon_code}; the credential itself is bad"
      verdict_code=1
    fi
  else
    verdict="UNEXPECTED — authenticated /installation/repositories -> ${auth_code}; not a known state, report it with the generation above"
    verdict_code=5
  fi

  printf 'gh paperclip-auth-check (PEN-5241)\n'
  printf '  source:             %s\n' "${check_source}"
  printf '  credential:         %s%s\n' "${check_state}" \
    "$([ "${check_bytes}" = "-" ] && printf '' || printf ' (%s bytes)' "${check_bytes}")"
  printf '  mount-generation:   %s\n' "${check_gen}"
  printf '  mount-written:      %s\n' "${check_written}"
  printf '  token-sha256:       %s\n' "${check_hash}"
  printf '  github-reachable:   %s\n' "${github_reachable}"
  printf '  authenticated:      /installation/repositories -> %s, x-ratelimit-limit %s\n' "${auth_code}" "${auth_limit}"
  printf '  verdict:            %s\n' "${verdict}"
  exit "${verdict_code}"
}

# PEN-5241: dispatched here, above every credential branch, on purpose. Each
# branch below can exit 64 for a credential it refuses to use, and the one
# moment an agent needs this subcommand is the moment those refusals are firing.
# It is also deliberately not routed through exec_real_gh: `gh` has no such
# subcommand and would exit 1 with a usage error.
case "${1:-}" in
  paperclip-auth-check | --paperclip-auth-check)
    paperclip_auth_check
    ;;
esac

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
  #
  # The empty case also names the BLO-40279 move: the documented recipe fills
  # this from `$(cat <token file>)`, and a stale /paperclip/.secrets path makes
  # that cat fail and leave the variable set-but-empty, so the refusal fires
  # here and never reaches reject_token_file()'s path-specific hint below.
  if [ -z "${TOKEN}" ]; then
    echo "gh-token-wrapper: GH_SEAT_TOKEN_VALUE is set but holds only whitespace; refusing to run with ambient auth. If it was filled by cat-ing a token file, that read failed: a path under /paperclip/.secrets is stale since BLO-40279, and the token Secrets now mount at /etc/paperclip/secrets/<name>/token. Run \`gh paperclip-auth-check\` for a full credential diagnosis (PEN-5241)" >&2
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
  WRAPPER_TOKEN_SOURCE="GH_SEAT_TOKEN_VALUE (agent-scoped secret binding)"
  WRAPPER_EXPORTED_TOKEN=yes
  exec_real_gh "$@"
fi

# BLO-37977: every branch below other than the happy path used to fall through
# to `gh` under whatever ambient auth the caller inherited — which inside an
# agent pod is none — and two of them did so printing nothing at all. A
# fleet-wide credential fault therefore presented as `gh` quietly doing nothing
# on a pod that reported healthy, and cost a PR review that was never performed.
#
# When PAPERCLIP_GITHUB_TOKEN_FILE is set, the caller has *named* the credential
# it wants, so a missing/unreadable/empty file is a misconfiguration: refuse,
# exactly as the GH_SEAT_TOKEN_VALUE branch above already does. When it is unset
# we are on the compiled-in default and the historical fallback stands, so
# non-agent uses of the image (the case the header comment describes) keep
# working unchanged.
require_token_file() { [ "${TOKEN_FILE_REQUIRED}" = yes ]; }

TOKEN_FILE_REQUIRED=no
if [ "${PAPERCLIP_GITHUB_TOKEN_FILE+x}" = x ]; then
  TOKEN_FILE_REQUIRED=yes
  case "${1:-} ${2:-}" in
    # The two commands that REPAIR a broken credential state. Refusing them for
    # want of a credential would be circular, and they configure auth rather
    # than querying GitHub, so the wrong-answer harm this refusal exists to
    # prevent does not apply to them.
    "auth setup-git" | "auth login") TOKEN_FILE_REQUIRED=no ;;
    # Local-only commands (bare `gh` prints usage) never contact GitHub, so no
    # credential can make their answer wrong. `gh --version` is also the first
    # thing a human or a probe runs to decide whether the binary works at all,
    # which is exactly when refusing it would mislead. `config` reads and writes
    # only ~/.config/gh, so it belongs to the same rule.
    #
    # The rule is narrower than "every local-only invocation", deliberately: the
    # patterns match on `$1 $2`, so subcommand-level help (`gh api -h`,
    # `gh repo view -h`) is still refused even though it contacts nothing.
    # Widening this is the fail-open direction and the stakes are low — `gh help
    # api` is the exempt equivalent, and the forms a human or the
    # github-cli-probe reaches for first are already here.
    "--version "* | "version "* | "--help "* | "-h "* | "help "* | "completion "* | "config "* | " ") TOKEN_FILE_REQUIRED=no ;;
    # `auth git-credential` is deliberately NOT exempt: git resolving a remote
    # is a real query, so it gets the stderr diagnostic at the point of failure.
    # That is all it gets. git ignores a credential helper's non-zero exit and
    # carries on with no credentials, so an anonymous fetch/clone of a public
    # repo still succeeds silently; this refusal does not prevent that.
  esac
fi

# Never echoes the token, only the path — which is not itself secret.
# A caller's own GH_TOKEN/GITHUB_TOKEN is refused here too (the file branch
# never honours them, see the override below), so the message names the
# override that does work: the value branch above runs before this one.
#
# Says "a token file is required" rather than naming the variable as the source
# of ${TOKEN_FILE}: the guard above tests `${VAR+x}` (set, including set-empty)
# while :22 resolves `${VAR:-default}`, so for PAPERCLIP_GITHUB_TOKEN_FILE=""
# the path printed is the compiled-in default and the variable named nothing.
# Keeping the `+x` guard is the point — `-n` would let a set-but-empty value
# fall through to ambient auth, which is the fail-open this file exists to kill.
#
# A caller naming a path under /paperclip/.secrets gets the move named for it
# (BLO-40279): that was where both token Secrets mounted until they moved out
# from under the shared CephFS volume, and an absolute path pinned in prose —
# a runbook, an agent instruction bundle, muscle memory — cannot be swept the
# way an in-repo one can. Deliberately a HINT and not a fallback: the two
# Secrets are two *different principals* (the App installation vs the
# `allyblockcast` user seat), whose approvals GitHub counts differently, so
# silently resolving a named merge-seat path to the compiled-in App default
# would run as an identity the caller did not ask for — the exact silent
# downgrade BLO-37977 made this branch refuse.
reject_token_file() {
  moved=""
  case "${TOKEN_FILE}" in
    /paperclip/.secrets/*)
      moved=". That path is stale: the token Secrets moved to /etc/paperclip/secrets/<name>/token in BLO-40279, out from under the shared /paperclip volume. Point PAPERCLIP_GITHUB_TOKEN_FILE at the new path — this wrapper will not pick a credential for you, because the App token and the merge seat are different identities"
      ;;
  esac
  echo "gh-token-wrapper: PAPERCLIP_GITHUB_TOKEN_FILE is set, so a token file is required, but ${TOKEN_FILE} ${1}; refusing to run with ambient auth. GH_TOKEN/GITHUB_TOKEN are not used as a fallback; to run under a specific token, set GH_SEAT_TOKEN_VALUE${moved}. Run \`gh paperclip-auth-check\` for a full credential diagnosis (PEN-5241)" >&2
  exit 64
}

if [ -r "${TOKEN_FILE}" ] && token_file_on_shared_volume; then
  if require_token_file; then
    reject_token_file "is on the shared ${SHARED_VOLUME} volume, which every agent can write"
  fi
  echo "gh-token-wrapper: ${TOKEN_FILE} is on the shared ${SHARED_VOLUME} volume, which every agent can write; not reading a credential from it, falling back to unwrapped auth" >&2
elif [ -r "${TOKEN_FILE}" ]; then
  TOKEN="$(tr -d '\r\n' < "${TOKEN_FILE}" 2>/dev/null || true)"
  # `tr -d '\r\n'` strips line terminators but leaves spaces/tabs, so a
  # whitespace-only file would otherwise export a whitespace GH_TOKEN and
  # authenticate as nobody-in-particular. Fold it into the empty case rather
  # than adding a branch — same refusal the GH_SEAT_TOKEN_VALUE arm makes.
  case "${TOKEN}" in
    *[![:space:]]*) ;;
    *) TOKEN="" ;;
  esac
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
    if [ "${PAPERCLIP_GITHUB_TOKEN_FILE+x}" = x ]; then
      WRAPPER_TOKEN_SOURCE="the file named by PAPERCLIP_GITHUB_TOKEN_FILE (${TOKEN_FILE})"
    else
      WRAPPER_TOKEN_SOURCE="the compiled-in default token file (${TOKEN_FILE}); PAPERCLIP_GITHUB_TOKEN_FILE is unset"
    fi
    WRAPPER_EXPORTED_TOKEN=yes
  elif require_token_file; then
    reject_token_file "is empty"
  fi
elif [ -e "${TOKEN_FILE}" ]; then
  # Distinguish "file exists but isn't readable" (a permissions
  # misconfig on the mount) from "file legitimately absent" (image used
  # without the secret mounted, the normal non-agent case) — the former
  # is exactly the class of silent failure BLO-13241 itself was: it's
  # worth a signal at the point of failure rather than waiting on the
  # external github-cli-probe alert (onprem-k8s#1077) to notice.
  if require_token_file; then
    reject_token_file "exists but is not readable"
  fi
  echo "gh-token-wrapper: ${TOKEN_FILE} exists but is not readable; falling back to unwrapped auth" >&2
elif require_token_file; then
  reject_token_file "is absent"
fi

exec_real_gh "$@"

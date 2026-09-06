#!/usr/bin/env bash
# Vendored from Blockcast/onprem-k8s at cedac5c69fe6870e66250ce187c6d108bc0592ba.
# Authorize one immutable Paperclip API image digest at admission time (BLO-19955).
#
# Rotates the bounded approval window in
# ConfigMap/paperclip-api-approved-images (namespace paperclip-release-approvals),
# which ValidatingAdmissionPolicy/paperclip-api-image-approval consumes via
# paramRef. Run this with the paperclip-release-approver credential — NOT the
# Release Engineer's deploy credential, which has only exact-name `get` on this
# object so ValidatingAdmissionPolicy can resolve its parameter; it cannot mutate
# the ring. PAPERCLIP_DEPLOY_KUBECONFIG supplies that separate deploy identity
# for reading and server-dry-running the exact planned Deployment.
#
# Usage:
#   PAPERCLIP_DEPLOY_KUBECONFIG=/path/to/deploy.kubeconfig \
#     PAPERCLIP_APPROVED_SERVER_PLAN_OUT=/path/to/approved-deployment.json \
#     scripts/approve-paperclip-api-digest.sh sha256:<64 hex> planned-deployment.yaml
#
# The exact manifest that will be deployed must carry
# paperclip.blockcast.net/approval-plan-sha256 on its pod template. Its value is
# the SHA-256 of the canonical full Deployment with that annotation removed.
# The approval probe and the release must submit the same stamped manifest.
#
# The window is a ring of at most MAX_APPROVED_DIGESTS entries: the digest being
# released, then the digest the cluster is currently running, then the most
# recently approved ones. That keeps an immediate rollback available without
# accepting every historical digest. Rolling back past the window is deliberately
# an explicit act — re-run this script naming that digest.
#
# The running digest is pinned ahead of the age-ordered fill rather than taking
# its chances in it. A deploy that fails before its rollout lands still consumes
# a slot permanently, so under plain newest-first ordering a run of consecutive
# failures — exactly when a rollback is wanted — is what ages out the digest
# actually serving traffic, and helm can then no longer roll back to it
# (BLO-28483). Pinning reorders eviction only; the bound is unchanged, so
# the maxApprovedApiDigests CEL variable does not move.
#
# "Currently running" means a rollout that has actually landed and is serving,
# not merely one that was written to the pod template — a digest applied by a
# failed deploy stays in spec.template forever, and pinning that would burn the
# reserved slot on an image which never carried traffic. Once that has happened
# the Deployment no longer names the last healthy digest at all, so the previous
# ReplicaSet is consulted instead (BLO-31842); that read needs get+list on
# apps/replicasets for the deploy identity, and says so in the log when it does
# not have them, rather than degrading in silence.
#
# An approval holds an in-flight lock until its rollout actually lands, so two
# releases cannot rotate the ring underneath each other. Retiring that lock —
# whether automatically on abort or explicitly via the escape hatch below —
# deliberately leaves the ring alone, so an abandoned digest keeps its slot until
# it ages out normally. If a release fails and will never complete, retire its
# lock explicitly:
#
#   PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=sha256:<the stuck digest> \
#     PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=<the stuck 64-hex owner> \
#     PAPERCLIP_DEPLOY_KUBECONFIG=... scripts/approve-paperclip-api-digest.sh ...
#
# The script retires its own lock automatically when it aborts after taking it,
# so an inadmissible plan does not wedge the channel on its own. It cannot do
# the same for a caller that fails AFTER this script exits 0 -- success
# deliberately leaves the lock live for the next release to retire. A release
# workflow closes that window by setting
#
#   PAPERCLIP_APPROVAL_LOCK_OWNER_OUT=/path/to/lock-owner.txt
#
# which receives the 64-hex owner of the lock this invocation minted, and only
# that lock: a lock adopted from an earlier attempt is left unnamed, because
# its rollout may still be running. A later step that knows the cluster was
# never touched can then feed that owner back through
# PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER above. No file is written when the
# lock is not this invocation's to abandon.
#
# That later step retires the lock through this same script, in retire-only mode
# (BLO-31666):
#
#   PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY=1 \
#     PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=sha256:<the digest it approved> \
#     PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=<the owner it was handed> \
#     scripts/approve-paperclip-api-digest.sh
#
# which removes that one lock and approves nothing. It takes no positional
# arguments, matches on digest AND owner so it can never retire a lock another
# run took, and exits 0 without writing when no such lock is present -- "not
# ours" and "already gone" are the same fact, and neither is an error.

set -euo pipefail

NAMESPACE="${PAPERCLIP_APPROVAL_NAMESPACE:-paperclip-release-approvals}"
CONFIGMAP="${PAPERCLIP_APPROVAL_CONFIGMAP:-paperclip-api-approved-images}"
DATA_KEY="approvedDigests"
DEPLOY_NAMESPACE="${PAPERCLIP_DEPLOY_NAMESPACE:-paperclip}"
DEPLOYMENT="${PAPERCLIP_API_DEPLOYMENT:-paperclip-api}"
IMAGE_REPOSITORY="harbor.blockcast.net/paperclip/paperclip"
LOCK_DIGEST_ANNOTATION="paperclip.blockcast.net/approval-in-flight-digest"
LOCK_PLAN_ANNOTATION="paperclip.blockcast.net/approval-in-flight-plan-sha256"
# The rollout nonce: the identity and generation of Deployment/paperclip-api as
# observed immediately BEFORE this approval was written. Health alone cannot
# retire a lock -- see ROLLOUT_COMPLETE_JQ.
LOCK_UID_ANNOTATION="paperclip.blockcast.net/approval-in-flight-deployment-uid"
LOCK_GENERATION_ANNOTATION="paperclip.blockcast.net/approval-in-flight-deployment-generation"
LOCK_MARKER_ANNOTATION="paperclip.blockcast.net/approval-in-flight-rollout-marker"
LOCK_SERVER_PLAN_ANNOTATION="paperclip.blockcast.net/approval-in-flight-server-plan-sha256"
LOCK_OWNER_ANNOTATION="paperclip.blockcast.net/approval-in-flight-owner"
ROLLOUT_MARKER_ANNOTATION="paperclip.blockcast.net/approval-plan-sha256"

# Retiring a lock means removing every annotation that constitutes it, and the
# set has grown three times (uid, generation, server-plan). Two copies of this
# list would drift on the fourth: a copy that forgets one key leaves a partial
# lock behind, and a partial lock is worse than none -- the digest field is what
# the next approval refuses on, so a retirement that clears the owner but keeps
# the digest wedges the channel while reporting success. So it is written once
# and used by both retirement paths: release_in_flight_lock (this invocation
# aborting after it took the lock) and the retire-only mode below (a caller that
# knows the cluster was never touched).
#
# The ring in .data is deliberately untouched by both. The digest is legitimately
# approved, the window bound still holds, and dropping entries here could evict a
# rollback target.
read -r -d '' CLEAR_IN_FLIGHT_LOCK_JQ <<'CLEAR_JQ' || true
del(.metadata.annotations[$digest_key])
| del(.metadata.annotations[$plan_key])
| del(.metadata.annotations[$uid_key])
| del(.metadata.annotations[$generation_key])
| del(.metadata.annotations[$marker_key])
| del(.metadata.annotations[$server_plan_key])
| del(.metadata.annotations[$owner_key])
CLEAR_JQ

# kubectl's stderr from the most recent clear_in_flight_lock call. Declared
# here so it is readable under `set -u` even if the function never ran.
CLEAR_IN_FLIGHT_LOCK_ERR=""

# resourceVersion rides along inside the object read here, so `kubectl replace`
# is rejected with a 409 if anyone else changed the transaction in between --
# the same optimistic-concurrency guard the rotation write uses, for the same
# reason. Retried from a fresh read rather than forced.
clear_in_flight_lock() {
  local json="$1"
  local status=0
  # `2>&1 >/dev/null` in that order: stderr is duplicated onto the command
  # substitution's pipe first, then stdout is discarded. Capturing rather than
  # discarding is what lets the retire-only loop tell a 409 (retrying may win)
  # from an RBAC denial or a vanished ConfigMap (retrying cannot), the same
  # distinction the rotation write makes further down this file.
  CLEAR_IN_FLIGHT_LOCK_ERR="$(
    jq \
      --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
      --arg plan_key "$LOCK_PLAN_ANNOTATION" \
      --arg uid_key "$LOCK_UID_ANNOTATION" \
      --arg generation_key "$LOCK_GENERATION_ANNOTATION" \
      --arg marker_key "$LOCK_MARKER_ANNOTATION" \
      --arg server_plan_key "$LOCK_SERVER_PLAN_ANNOTATION" \
      --arg owner_key "$LOCK_OWNER_ANNOTATION" \
      "$CLEAR_IN_FLIGHT_LOCK_JQ" <<<"$json" \
      | kubectl replace -f - 2>&1 >/dev/null
  )" || status=$?
  return "$status"
}

# Must stay in lockstep with the `maxApprovedApiDigests` CEL variable in
# paperclip/paperclip-public-tools.yaml. The policy denies everything if the
# list is longer, so a drift here is a hard outage, not a silent widening.
#
# Deliberately a constant and not an override. This script runs against the
# cluster with the approver credential and cannot read the policy to check
# itself, and the window guard below compares against this same number -- so an
# override would raise the bound and the guard that exists to catch exactly that
# would move with it, reporting success while leaving the ring in a state the
# policy answers by denying every rollout.
# scripts/test-apply-platform-sre-backup-rbac.sh asserts this equals the CEL bound.
readonly MAX_APPROVED_DIGESTS=3

# Retry bound shared by BOTH retirement paths: retire-only mode below, and
# release_in_flight_lock on the abort path. Declared here rather than inside
# retire-only mode because that block exits before the approval path ever runs,
# so a declaration there leaves this unset -- and under `set -u` that aborts
# cleanup_on_exit mid-retirement, turning a parity fix into a fresh wedge.
readonly RETIRE_ATTEMPTS=3

if [[ -n "${PAPERCLIP_MAX_APPROVED_DIGESTS:-}" \
      && "$PAPERCLIP_MAX_APPROVED_DIGESTS" != "$MAX_APPROVED_DIGESTS" ]]; then
  echo "refusing to approve: PAPERCLIP_MAX_APPROVED_DIGESTS=${PAPERCLIP_MAX_APPROVED_DIGESTS} disagrees with the" >&2
  echo "${MAX_APPROVED_DIGESTS}-entry window the admission policy enforces. Raising the writer-side bound does not" >&2
  echo "widen the policy; it makes the policy deny every rollout. Change the maxApprovedApiDigests CEL" >&2
  echo "variable in paperclip/paperclip-public-tools.yaml and this constant together." >&2
  exit 2
fi

usage() {
  echo "usage: PAPERCLIP_DEPLOY_KUBECONFIG=/path/to/deploy.kubeconfig $0 sha256:<64 lowercase hex> planned-deployment.yaml" >&2
  exit 2
}

# BLO-31666. A release that took a lock and then died BEFORE `helm upgrade` ever
# executed knows something no other actor can know: the cluster was never
# touched, so this lock names a rollout that will never happen. Nothing clears it
# on its own -- the ring still lists the digest, so every subsequent production
# deploy is refused at admission until a human retires it by hand. That is
# BLO-31598, and it cost hours. This mode is the entry point for the cleanup step
# that closes the window.
#
# It approves nothing. So it needs no plan manifest, no deploy credential, and no
# admissibility probe: it is the removal half of the transaction and nothing else.
# The lock is named entirely by the ABANDON pair validated below, which is why
# this mode takes NO positional arguments -- a digest supplied in two places
# could disagree with itself, and the resulting ambiguity is precisely what the
# digest+owner pairing rule exists to eliminate.
RETIRE_IN_FLIGHT_ONLY="${PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY:-}"

retire_only_usage() {
  echo "usage: PAPERCLIP_APPROVAL_RETIRE_IN_FLIGHT_ONLY=1 \\" >&2
  echo "  PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=sha256:<64 lowercase hex> \\" >&2
  echo "  PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=<64 lowercase hex> $0" >&2
  echo "retire-only mode takes no positional arguments; it names the lock by env" >&2
  echo >&2
  echo "The owner must be the CURRENT one. An exact retry adopts the lock and" >&2
  echo "rewrites that annotation, so if a deploy re-ran after a cleanup step" >&2
  echo "already failed, the owner in that first run's log is stale and will be" >&2
  echo "refused here as 'nothing to retire'. Take the owner from the most recent" >&2
  echo "deploy's approval-step epilogue, which prints the lock it actually holds." >&2
  exit 2
}

if [[ -n "$RETIRE_IN_FLIGHT_ONLY" ]]; then
  [[ $# -eq 0 ]] || retire_only_usage
  # Defined so the shared validation below can reference them under `set -u`.
  # Neither is meaningful in this mode: nothing is approved.
  DIGEST=""
  PLANNED_DEPLOYMENT=""
else
  [[ $# -eq 2 ]] || usage
  DIGEST="$1"
  PLANNED_DEPLOYMENT="$2"

  if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "refusing to approve '${DIGEST}': not a well-formed lowercase sha256 digest" >&2
    echo "pass the bare digest only — the repository is fixed inside the admission policy" >&2
    exit 2
  fi

  if [[ ! -f "$PLANNED_DEPLOYMENT" ]]; then
    echo "planned Deployment manifest not found: $PLANNED_DEPLOYMENT" >&2
    exit 2
  fi
fi

# Escape hatch for a release that will never complete: a rollout that failed and
# is being rolled back, or an approval whose plan was inadmissible. Naming the
# exact digest AND unique owner being retired keeps this an explicit, auditable
# act. Digest alone is insufficient because configuration-only releases can use
# the same image. The retirement is resourceVersion-guarded by the rotation write.
ABANDON_IN_FLIGHT="${PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT:-}"
ABANDON_IN_FLIGHT_OWNER="${PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER:-}"
if [[ -n "$ABANDON_IN_FLIGHT" \
      && ! "$ABANDON_IN_FLIGHT" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT='${ABANDON_IN_FLIGHT}' is not a well-formed digest" >&2
  echo "name the exact in-flight digest being retired, or unset it" >&2
  exit 2
fi
if [[ -n "$ABANDON_IN_FLIGHT_OWNER" \
      && ! "$ABANDON_IN_FLIGHT_OWNER" =~ ^[0-9a-f]{64}$ ]]; then
  echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER='${ABANDON_IN_FLIGHT_OWNER}' is not a well-formed owner" >&2
  echo "name the exact 64-hex in-flight owner being retired, or unset it" >&2
  exit 2
fi
if [[ -n "$ABANDON_IN_FLIGHT" && -z "$ABANDON_IN_FLIGHT_OWNER" ]] \
    || [[ -z "$ABANDON_IN_FLIGHT" && -n "$ABANDON_IN_FLIGHT_OWNER" ]]; then
  echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT and PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER must be set together" >&2
  exit 2
fi

# BLO-31666: retire-only mode executes here and exits, before anything that
# needs a plan, a deploy credential, or the admission probe. Placed immediately
# after the ABANDON pair is validated because that pair IS the whole input.
if [[ -n "$RETIRE_IN_FLIGHT_ONLY" ]]; then
  if [[ -z "$ABANDON_IN_FLIGHT" ]]; then
    echo "retire-only mode requires the lock to retire to be named explicitly" >&2
    retire_only_usage
  fi
  for dep in kubectl jq; do
    command -v "$dep" >/dev/null 2>&1 || { echo "$dep is required" >&2; exit 2; }
  done

  # kubectl's stderr on the read below is the only thing that separates an
  # approver Role missing `get` from a ConfigMap deleted out from under the run,
  # and the operator reading it is about to clear a lock by hand. It goes to a
  # file rather than a combined `2>&1` capture because kubectl writes warnings
  # on the SUCCESS path too, and those would be spliced into the JSON parsed
  # below. Same idiom as the admissibility probe's `server_plan_err`, created
  # here because this mode exits before that one is set up.
  if ! retire_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-retire-err.XXXXXX")"; then
    echo "cannot create a temporary file for the retire read's error output" >&2
    exit 1
  fi
  trap 'rm -f "$retire_err"' EXIT

  for attempt in $(seq 1 "$RETIRE_ATTEMPTS"); do
    # `get` is the approver's only read verb and it is scoped to this one name.
    # A failure is fail-closed and must be surfaced: a caller that cannot read
    # the lock cannot conclude anything about it, and reporting success here
    # would leave the wedge in place while claiming it was cleared.
    if ! retire_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json 2>"$retire_err")"; then
      echo "cannot read ${NAMESPACE}/${CONFIGMAP} to retire the in-flight lock:" >&2
      if [[ -s "$retire_err" ]]; then
        sed 's/^/    /' "$retire_err" >&2
      else
        # kubectl killed by a signal, or dead before it wrote anything, would
        # otherwise print a dangling colon and -- now that the bootstrap hint is
        # gated on NotFound -- no guidance at all. The gate stays honest without
        # restoring the red herring it was added to remove.
        echo "    (kubectl produced no error output)" >&2
      fi
      # Gated on the cause: the bootstrap is only the answer for a ConfigMap
      # that is not there. Printed blind, it sends an operator whose approver
      # Role is missing `get` to re-run a bootstrap that is already in place --
      # the one hint guaranteed not to help, on the path where they have the
      # least time to spare. Same NotFound test as the server-plan probe.
      if grep -qiE 'not[[:space:]]+found|notfound' "$retire_err"; then
        echo "The approval ConfigMap is installed by the cluster-admin bootstrap;" >&2
        echo "this script never creates it." >&2
      fi
      exit 1
    fi

    # Digest AND owner, together, exactly as the operator hatch matches. The
    # owner is a per-invocation nonce, so this is what makes the retirement
    # incapable of touching a lock some other run took -- and the digest alone
    # could not: a configuration-only release legitimately reuses a digest.
    if ! jq -e \
        --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
        --arg digest "$ABANDON_IN_FLIGHT" \
        --arg owner_key "$LOCK_OWNER_ANNOTATION" \
        --arg owner "$ABANDON_IN_FLIGHT_OWNER" '
          .metadata.annotations[$digest_key] == $digest and
          .metadata.annotations[$owner_key] == $owner
        ' <<<"$retire_json" >/dev/null; then
      # Not ours, or already gone. Both are the same fact -- there is no lock
      # this caller is entitled to retire -- and neither is an error. The caller
      # is a cleanup step on an already-failing job; turning "nothing to do"
      # into a second red step would bury the real failure underneath it.
      echo "no in-flight approval lock matching ${ABANDON_IN_FLIGHT} owner ${ABANDON_IN_FLIGHT_OWNER}; nothing to retire"
      exit 0
    fi

    if clear_in_flight_lock "$retire_json"; then
      echo "Retired the in-flight approval lock on ${ABANDON_IN_FLIGHT} (owner ${ABANDON_IN_FLIGHT_OWNER})."
      echo "The ring still lists that digest, so a corrected plan or a rollback is"
      echo "admitted without an out-of-band edit."
      exit 0
    fi

    # A conflict proves this write lost a race, so a fresh read may win the
    # next one. Anything else -- an approver Role missing `update`, a deleted
    # ConfigMap -- fails identically on all three attempts, and spending 3s to
    # then report the generic "could not retire" below hides the actual cause
    # from the operator who now has to clear the lock by hand. Same test, and
    # same reasoning, as the rotation write's non-retriable bail.
    if ! grep -qiE 'conflict|modified|latest version' <<<"$CLEAR_IN_FLIGHT_LOCK_ERR"; then
      echo "cannot retire the in-flight approval lock on ${ABANDON_IN_FLIGHT} (owner ${ABANDON_IN_FLIGHT_OWNER}):" >&2
      if [[ -n "$CLEAR_IN_FLIGHT_LOCK_ERR" ]]; then
        printf '%s\n' "$CLEAR_IN_FLIGHT_LOCK_ERR" | sed 's/^/    /' >&2
      else
        # Empty is not a special case to skip: it matches none of the conflict
        # vocabulary, so it arrives HERE, and printing the header alone would
        # leave the dangling colon the read guard above exists to prevent.
        echo "    (kubectl produced no error output)" >&2
      fi
      exit 1
    fi
    # No sleep after the final attempt: the loop is about to end, so it buys
    # nothing and delays the exhaustion message below by a whole ceiling while
    # a release is wedged. Spelled as an `if` because a BARE `(( … ))` as the
    # loop body's last command is false on the final attempt, and `set -e`
    # aborts the retirement there. Note the `(( … )) && sleep` spelling would
    # NOT abort -- bash exempts the left side of an `&&` list from `set -e` --
    # so the `if` is what makes the intent survive either rewrite.
    if (( attempt < RETIRE_ATTEMPTS )); then
      sleep "$attempt"
    fi
  done

  echo "could not retire the in-flight approval lock on ${ABANDON_IN_FLIGHT} (owner ${ABANDON_IN_FLIGHT_OWNER})." >&2
  echo "The next approval will refuse until it is retired. Re-run this mode, or pass" >&2
  echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT and PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER" >&2
  echo "on the next approval." >&2
  exit 1
fi

# Admissibility-probe pacing. Validated here, with the other operator-facing
# env, so a typo fails before the ring is touched rather than mid-probe with an
# in-flight lock held. The exhaustion message at the end of this script actively
# directs operators to raise the attempt count, so these are turned by hand
# under pressure and must fail legibly.
#
# An explicitly-empty value falls through to the default on purpose: a CI `env:`
# expression that resolves to "" must not fail a deploy.
#
# Shape AND magnitude are both checked. A bare digits pattern would accept 4000
# — one stray zero on the default 40 — which is ~8.9h of probing while holding
# the in-flight approval lock. That is the same hazard class the exponent clamp
# closes. The exhaustion message points an operator at this exact knob while a
# release is wedged, and only CI has a deadline to catch an overshoot (bash does
# run the EXIT trap on SIGTERM, so the CI kill at least retires the lock); the
# hand-invoked path has none. The ceilings below are fat-finger guards, not
# policy: a deliberate widening well past the default still fits.
PROBE_ATTEMPTS="${PAPERCLIP_APPROVAL_PROBE_ATTEMPTS:-40}"
PROBE_MAX_SLEEP_SECONDS="${PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS:-8}"
PROBE_ATTEMPTS_LIMIT=1000
PROBE_MAX_SLEEP_SECONDS_LIMIT=3600

# Shape, then WIDTH, then magnitude — in that order, because `(( ))` evaluates in
# signed 64-bit and silently wraps. 18446744073709551656 (2^64 + 40) satisfies
# `^[1-9][0-9]*$`, wraps to 40 in arithmetic, and would sail through a bare
# magnitude check — after which `seq 1 "$PROBE_ATTEMPTS"` iterates on the
# unwrapped literal essentially forever with the in-flight lock held, the exact
# hazard the ceiling exists to close. Rejecting on digit count first means no
# value wide enough to wrap ever reaches arithmetic. The width is derived from
# the limit rather than hardcoded, so it cannot drift away from it.
#
# Returns 1 for a malformed value and 2 for an out-of-range one, so the caller
# can attach knob-specific guidance to the range case only.
require_bounded_positive_int() {
  local name="$1" value="$2" limit="$3"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name}='${value}' is not a positive integer" >&2
    return 1
  fi
  if (( ${#value} > ${#limit} )) || (( value > limit )); then
    echo "${name}='${value}' exceeds the ${limit} maximum" >&2
    return 2
  fi
}

knob_status=0
require_bounded_positive_int PAPERCLIP_APPROVAL_PROBE_ATTEMPTS \
  "$PROBE_ATTEMPTS" "$PROBE_ATTEMPTS_LIMIT" || knob_status=$?
if (( knob_status != 0 )); then
  if (( knob_status == 2 )); then
    echo "that many probes would hold the in-flight approval lock for hours; widen deliberately, not by typo" >&2
  fi
  exit 2
fi
require_bounded_positive_int PAPERCLIP_APPROVAL_PROBE_MAX_SLEEP_SECONDS \
  "$PROBE_MAX_SLEEP_SECONDS" "$PROBE_MAX_SLEEP_SECONDS_LIMIT" || exit 2

# The lock-owner handoff path is validated here for a sharper reason than the
# knobs above: it is the one operator-facing value whose failure would otherwise
# land AFTER the ring write. emit_lock_owner runs immediately after the rotation
# succeeds, so under `set -e` an unwritable path aborts there. That abort is
# safe -- cleanup_on_exit retires the lock it just minted -- but it costs a
# deploy, and it fails at a point in the run that reads like success. Proving
# writability now costs nothing; discovering it later costs a release cycle.
#
# The target file is deliberately NOT created. Absent means "this invocation has
# no lock it is entitled to abandon", so pre-creating an empty file here would
# hand a consumer a path that exists with no owner in it. Probe a sibling temp
# file instead: same directory, same mount, same permissions, no target.
LOCK_OWNER_OUT="${PAPERCLIP_APPROVAL_LOCK_OWNER_OUT:-}"
if [[ -n "$LOCK_OWNER_OUT" ]]; then
  if [[ -d "$LOCK_OWNER_OUT" ]]; then
    echo "PAPERCLIP_APPROVAL_LOCK_OWNER_OUT='${LOCK_OWNER_OUT}' is a directory, not a file" >&2
    echo "name the file to write the in-flight lock owner to, or unset it" >&2
    exit 2
  fi
  lock_owner_out_dir="$(dirname -- "$LOCK_OWNER_OUT")"
  if [[ ! -d "$lock_owner_out_dir" ]]; then
    echo "PAPERCLIP_APPROVAL_LOCK_OWNER_OUT='${LOCK_OWNER_OUT}': ${lock_owner_out_dir} is not a directory" >&2
    echo "create it before this step, or unset the variable to skip the handoff" >&2
    exit 2
  fi
  if [[ -e "$LOCK_OWNER_OUT" && ! -w "$LOCK_OWNER_OUT" ]]; then
    echo "PAPERCLIP_APPROVAL_LOCK_OWNER_OUT='${LOCK_OWNER_OUT}' exists and is not writable" >&2
    exit 2
  fi
  if ! lock_owner_probe="$(
        mktemp "${lock_owner_out_dir}/.paperclip-lock-owner-probe.XXXXXX" 2>/dev/null)"; then
    echo "PAPERCLIP_APPROVAL_LOCK_OWNER_OUT='${LOCK_OWNER_OUT}': ${lock_owner_out_dir} is not writable" >&2
    echo "the approval would rotate the ring and then abort, costing a deploy; fix the path first" >&2
    exit 2
  fi
  rm -f "$lock_owner_probe"
fi

if [[ -z "${PAPERCLIP_DEPLOY_KUBECONFIG:-}" \
      || ! -f "$PAPERCLIP_DEPLOY_KUBECONFIG" ]]; then
  echo "PAPERCLIP_DEPLOY_KUBECONFIG must name the deploy credential used for the admission probe" >&2
  exit 2
fi

for dep in kubectl jq ruby sha256sum; do
  command -v "$dep" >/dev/null 2>&1 || { echo "$dep is required" >&2; exit 2; }
done

TARGET_IMAGE="${IMAGE_REPOSITORY}@${DIGEST}"
deploy_kubectl=(kubectl --kubeconfig "$PAPERCLIP_DEPLOY_KUBECONFIG")

planned_json="$(ruby -ryaml -rjson - "$PLANNED_DEPLOYMENT" <<'RUBY'
docs = YAML.load_stream(File.read(ARGV.fetch(0))).compact
unless docs.size == 1 && docs[0].is_a?(Hash)
  abort "planned manifest must contain exactly one Kubernetes object"
end
puts JSON.generate(docs[0])
RUBY
)" || { echo "could not parse planned Deployment: $PLANNED_DEPLOYMENT" >&2; exit 2; }

if ! jq -e \
    --arg namespace "$DEPLOY_NAMESPACE" \
    --arg deployment "$DEPLOYMENT" \
    --arg image "$TARGET_IMAGE" '
      .apiVersion == "apps/v1" and
      .kind == "Deployment" and
      .metadata.namespace == $namespace and
      .metadata.name == $deployment and
      (.spec.replicas // 1) > 0 and
      (.spec.template.spec.containers | type == "array" and length > 0) and
      (.spec.template.spec.containers | all(.image == $image))
    ' <<<"$planned_json" >/dev/null; then
  echo "planned manifest must be ${DEPLOY_NAMESPACE}/Deployment/${DEPLOYMENT} with every container image exactly ${TARGET_IMAGE}" >&2
  exit 2
fi

# The release plan carries its own deterministic identity on the pod template.
# Hash the full canonical Deployment with this annotation removed, so the
# marker is neither self-referential nor blind to non-template plan changes.
# The release workflow must deploy this exact annotated manifest; completion
# later checks the live template for the same value.
PLAN_MARKER="$(jq -r --arg key "$ROLLOUT_MARKER_ANNOTATION" \
  '.spec.template.metadata.annotations[$key] // ""' <<<"$planned_json")"
CANONICAL_UNSTAMPED_PLAN="$(jq -cS --arg key "$ROLLOUT_MARKER_ANNOTATION" '
    del(.spec.template.metadata.annotations[$key])
    | if ((.spec.template.metadata.annotations // {}) | length) == 0
      then del(.spec.template.metadata.annotations)
      else .
      end
    | if ((.spec.template.metadata // {}) | length) == 0
      then del(.spec.template.metadata)
      else .
      end
  ' <<<"$planned_json")"
EXPECTED_PLAN_MARKER="$(printf '%s' "$CANONICAL_UNSTAMPED_PLAN" \
  | sha256sum | awk '{print $1}')"
if [[ ! "$PLAN_MARKER" =~ ^[0-9a-f]{64}$ \
      || "$PLAN_MARKER" != "$EXPECTED_PLAN_MARKER" ]]; then
  echo "planned Deployment pod template must carry ${ROLLOUT_MARKER_ANNOTATION}=${EXPECTED_PLAN_MARKER}" >&2
  echo "computed from the canonical full Deployment with that annotation removed" >&2
  exit 2
fi
PLAN_SHA256="$(printf '%s' "$planned_json" | sha256sum | awk '{print $1}')"

# Server normalization happens after provisional lock acquisition below. The
# exact canonical name must be retained so every shipping policy evaluates the
# same object the release will submit. Completion hashes the live Deployment with
# this normalizer, so copying the local marker onto another plan cannot retire a
# lock.
#
# Helm ownership fields and top-level operator metadata survive later upgrades
# even when absent from the rendered chart, so top-level metadata is projected
# to Deployment identity. Pod-template metadata is behavior-bearing input to
# the rollout, however: sidecar injection, security controls, and restart
# annotations can all change the resulting Pods. Preserve all template labels
# and annotations alongside the complete Deployment spec so a copied marker
# cannot retire a different pod plan.
#
# Extracted verbatim by the admission regression between the marker comments.
read -r -d '' CANONICAL_DEPLOYMENT_JQ <<'CANONICAL_JQ' || true
# BEGIN CANONICAL_DEPLOYMENT_JQ
.metadata = {
  name: .metadata.name,
  namespace: .metadata.namespace
}
| .spec.template.metadata = {
    labels: (.spec.template.metadata.labels // {}),
    annotations: (.spec.template.metadata.annotations // {})
  }
| del(.status)
# END CANONICAL_DEPLOYMENT_JQ
CANONICAL_JQ

LOCK_OWNER_ID="$(ruby -rsecurerandom -e 'print SecureRandom.hex(32)')"
SERVER_PLAN_SHA256=""

# When may an in-flight approval lock be retired automatically?
#
# Health on the locked digest is NOT sufficient. A configuration-only release
# reuses the digest that is already running, so "live Deployment is healthy on
# the locked digest" is true the instant the lock is taken — the next release
# would then retire this lock before this plan ever rolled out, which is exactly
# the concurrent-rollout and ring-eviction race the lock exists to prevent.
# So completion also requires evidence that the Deployment ADVANCED past the
# state observed when the lock was written.
#
# Extracted verbatim by scripts/test-paperclip-image-approval-admission.sh
# between the marker comments below, so the regression tests exercise this exact
# predicate and cannot drift from it. They are jq comments; keep them.
read -r -d '' ROLLOUT_COMPLETE_JQ <<'ROLLOUT_JQ' || true
# BEGIN ROLLOUT_COMPLETE_JQ
def advanced:
  # Lock predates rollout-nonce recording: this plan's rollout cannot be
  # proven, so refuse to auto-advance. PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT is
  # the explicit way out, rather than silently trusting health.
  if $generation == "" then false
  elif ($generation | test("^[0-9]+$") | not) then false
  # No Deployment existed when the lock was taken, so any live one is newer.
  elif $uid == "" then true
  # Recreated object: generation restarts from 1, so identity is the evidence.
  elif (.metadata.uid // "") != $uid then true
  else (.metadata.generation // 0) > ($generation | tonumber)
  end;
(.spec.template.spec.containers | type == "array" and length > 0) and
(.spec.template.spec.containers | all(.image == $image)) and
(.spec.template.metadata.annotations[$marker_key] // "") == $marker and
(.spec.replicas // 1) > 0 and
(.status.observedGeneration // 0) >= (.metadata.generation // 1) and
(.status.updatedReplicas // 0) == (.spec.replicas // 1) and
(.status.readyReplicas // 0) == (.spec.replicas // 1) and
(.status.availableReplicas // 0) == (.spec.replicas // 1) and
(.status.unavailableReplicas // 0) == 0 and
advanced
# END ROLLOUT_COMPLETE_JQ
ROLLOUT_JQ

# The health half of ROLLOUT_COMPLETE_JQ above: the controller has observed the
# current generation, and every replica is updated to the current pod template,
# ready, and available, with none unavailable. It deliberately carries none of
# that predicate's lock-identity clauses — the rollout marker, the generation
# nonce, the expected image — because it answers a different question: not "did
# MY plan's rollout land?" but "is the template that is written also the one
# serving traffic?".
#
# The condition lines are kept byte-identical to their counterparts above, and
# scripts/approve-paperclip-api-digest.test.js compares the two blocks for set
# equality over the health half -- in both directions, so neither predicate can
# gain or lose a health condition without the other -- so "this rollout has
# landed" has one definition in this file rather than two.
read -r -d '' ROLLOUT_SERVING_JQ <<'SERVING_JQ' || true
# BEGIN ROLLOUT_SERVING_JQ
(.spec.replicas // 1) > 0 and
(.status.observedGeneration // 0) >= (.metadata.generation // 1) and
(.status.updatedReplicas // 0) == (.spec.replicas // 1) and
(.status.readyReplicas // 0) == (.spec.replicas // 1) and
(.status.availableReplicas // 0) == (.spec.replicas // 1) and
(.status.unavailableReplicas // 0) == 0
# END ROLLOUT_SERVING_JQ
SERVING_JQ

# The rollout nonce is read fresh inside the rotation loop, immediately before
# the write that stores it — not once up front. A retry can lose a race to a
# rollout that lands between attempts, and recording the pre-retry generation
# would make the *next* approval read "already advanced" for free.
observe_rollout_nonce() {
  local live_json status=0
  observed_uid=""
  observed_generation="0"
  live_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
    get deployment "$DEPLOYMENT" -o json 2>"$nonce_err")" || status=$?
  if (( status == 0 )); then
    observed_uid="$(jq -r '.metadata.uid // ""' <<<"$live_json")"
    observed_generation="$(jq -r '(.metadata.generation // 0) | tostring' <<<"$live_json")"
    return 0
  fi
  # A genuinely absent Deployment is an honest empty nonce -- the first rollout
  # is unambiguously newer than "nothing". Any OTHER read failure is not: it
  # would record an empty uid, which the completion rule reads as "any live
  # rollout counts", and this lock would then retire on evidence it never had.
  if grep -qiE 'not ?found' "$nonce_err"; then
    return 0
  fi
  echo "cannot read Deployment/${DEPLOY_NAMESPACE}/${DEPLOYMENT} to record the rollout nonce:" >&2
  cat "$nonce_err" >&2
  echo "refusing to approve rather than taking a lock that cannot prove its own rollout" >&2
  exit 1
}

# Abort path. Once the lock is written, every failure below it must retire the
# lock again or the release channel wedges: a corrected plan hashes differently,
# so it would be refused against a lock naming a rollout that never happened,
# and so would a rollback. Only OUR lock is retired -- if the annotations no
# longer names this invocation's unique owner, someone else owns the transaction
# and we leave it alone. Digest/plan/marker are intentionally insufficient:
# exact concurrent invocations share all three. The ring is deliberately left
# intact: the digest is approved, the window bound still holds, and dropping
# entries here could evict a rollback target.
release_in_flight_lock() {
  local attempt json
  for attempt in $(seq 1 "$RETIRE_ATTEMPTS"); do
    # Same argument as the retire-only read above, and it applies harder here:
    # this path has LESS operator visibility, not more. Its failure surfaces as
    # cleanup_on_exit's bare "could not retire the in-flight lock" with no cause,
    # and unlike retire-only mode nobody is sitting at a terminal to re-run it
    # with more logging. Written to a file rather than folded in with `2>&1`
    # because kubectl warns on the SUCCESS path too, and those lines would be
    # spliced into the JSON parsed just below.
    if ! json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json 2>"${release_err:-/dev/null}")"; then
      echo "cannot read ${NAMESPACE}/${CONFIGMAP} to retire the in-flight lock:" >&2
      if [[ -n "${release_err:-}" && -s "$release_err" ]]; then
        sed 's/^/    /' "$release_err" >&2
      else
        echo "    (kubectl produced no error output)" >&2
      fi
      return 1
    fi
    if ! jq -e \
        --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
        --arg digest "$DIGEST" \
        --arg plan_key "$LOCK_PLAN_ANNOTATION" \
        --arg plan "$PLAN_SHA256" \
        --arg marker_key "$LOCK_MARKER_ANNOTATION" \
        --arg marker "$PLAN_MARKER" \
        --arg owner_key "$LOCK_OWNER_ANNOTATION" \
        --arg owner "$LOCK_OWNER_ID" '
          .metadata.annotations[$digest_key] == $digest and
          .metadata.annotations[$plan_key] == $plan and
          .metadata.annotations[$marker_key] == $marker and
          .metadata.annotations[$owner_key] == $owner
        ' <<<"$json" >/dev/null; then
      return 0
    fi
    if clear_in_flight_lock "$json"; then
      return 0
    fi
    # Same non-retriable test as retire-only mode's write bail, for the same
    # reason and with the same argument as the read failure above: a conflict
    # means this write lost a race and a fresh read may win the next one, while
    # an approver Role missing `update` or a deleted ConfigMap fails identically
    # on every attempt. Retrying those spends the very TERM grace period the flat
    # pacing below exists to conserve, and still reports nothing -- the caller
    # prints only the bare "could not retire the in-flight lock", with no
    # operator present to re-run with more logging.
    if ! grep -qiE 'conflict|modified|latest version' <<<"$CLEAR_IN_FLIGHT_LOCK_ERR"; then
      echo "cannot retire the in-flight lock on ${DIGEST} (owner ${LOCK_OWNER_ID}):" >&2
      if [[ -n "$CLEAR_IN_FLIGHT_LOCK_ERR" ]]; then
        printf '%s\n' "$CLEAR_IN_FLIGHT_LOCK_ERR" | sed 's/^/    /' >&2
      else
        # Not an exotic case here: this loop runs inside a trap reached from
        # `trap 'exit 143' TERM`, so kubectl signal-killed mid-`replace` is the
        # EXPECTED teardown, and it writes nothing. An empty capture matches
        # none of the conflict vocabulary, so it lands on this bail -- correctly,
        # since nothing suggests a retry would win -- and without this branch the
        # header would promise a cause and deliver a blank line, on the one path
        # where the caller prints no cause of its own.
        echo "    (kubectl produced no error output)" >&2
      fi
      return 1
    fi
    # Guarded rather than unconditional: the last attempt has nothing left to
    # wait for. Spelled as an `if` because a BARE `(( ... ))` as the loop body's
    # last command is false on the final attempt and `set -e` aborts there; the
    # `(( ... )) && sleep` spelling would not abort (bash exempts the left side
    # of an `&&` list), so the `if` is what survives either rewrite intact.
    #
    # Flat, where retire-only mode backs off linearly (`sleep "$attempt"`). With
    # the bail above shared, the sleep is the only remaining asymmetry in the
    # two loops' RETRY-CONTROL structure, and it is deliberate rather than an
    # unfinished parity fix: this loop runs inside a trap reached from
    # `trap 'exit 143' TERM`, so the runner's grace period is the whole budget
    # and 2s of total sleep beats 3s. Retire-only mode has an operator at a
    # terminal and no such deadline.
    #
    # Their MESSAGING differences are deliberate too, and are not a parity gap
    # to close: this loop's caller (`cleanup_on_exit`) prints the operator
    # guidance that retire-only mode prints itself, so a chatty success or
    # exhaustion here would bury the real failure the cleanup is running after.
    # `return` vs `exit` is structurally required for the same reason.
    if (( attempt < RETIRE_ATTEMPTS )); then
      sleep 1
    fi
  done
  return 1
}

# A release workflow that sets this learns the owner id of the lock this
# invocation minted, so a later step can retire it when the deploy dies after
# the approval succeeded but before the cluster was ever touched (BLO-31598).
# Success deliberately leaves the lock live for the next release to retire
# after observing this plan marker roll out, so the owner is otherwise only
# ever prose on stdout and the workflow cannot name it.
#
# Written ONLY for a lock this invocation created. An adopted lock belongs to a
# rollout that may still be running, and retiring it would reopen the ring
# underneath that rollout -- the same distinction lock_preserve_on_failure
# encodes at the transfer below. Absent file therefore means "this invocation
# has no lock it is entitled to abandon", which is the safe default.
emit_lock_owner() {
  [[ -n "${PAPERCLIP_APPROVAL_LOCK_OWNER_OUT:-}" ]] || return 0
  [[ -n "$lock_owner_is_ours" ]] || return 0
  (umask 077; printf '%s\n' "$LOCK_OWNER_ID" >"$PAPERCLIP_APPROVAL_LOCK_OWNER_OUT")
}

# Rotation is a read-modify-write, so the write MUST be guarded by the version
# that was read. With an unconditional merge-patch, two releases approving
# concurrently silently clobber each other: A and B both read [x], A writes
# [a,x], B writes [b,x], and `a` is gone. Worse, A's own read-back can land in
# the window between the two writes and observe `a` present — so A proceeds to a
# `helm upgrade` whose digest is no longer approved and dies on a confusing
# admission denial. Carrying the observed resourceVersion into the write makes
# the apiserver reject a stale write with 409 instead, and we retry from a fresh
# read.
#
# `kubectl replace` maps to the `update` verb, which the approver Role grants on
# exactly this one ConfigMap name. It cannot create the object (no `create`), so
# the fail-closed behaviour below is preserved.
live_deployment_completed_digest() {
  local digest="$1"
  local uid="$2"
  local generation="$3"
  local marker="$4"
  local server_plan_sha256="$5"
  local image="${IMAGE_REPOSITORY}@${digest}"
  local live_json canonical_live_plan live_plan_sha256
  live_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
    get deployment "$DEPLOYMENT" -o json 2>/dev/null)" || return 1
  canonical_live_plan="$(jq -cS "$CANONICAL_DEPLOYMENT_JQ" <<<"$live_json")"
  live_plan_sha256="$(printf '%s' "$canonical_live_plan" | sha256sum | awk '{print $1}')"
  [[ "$live_plan_sha256" == "$server_plan_sha256" ]] || return 1
  jq -e \
        --arg image "$image" \
        --arg uid "$uid" \
        --arg generation "$generation" \
        --arg marker_key "$ROLLOUT_MARKER_ANNOTATION" \
        --arg marker "$marker" \
        "$ROLLOUT_COMPLETE_JQ" <<<"$live_json" >/dev/null
}

# The digest the cluster is actually serving right now, or empty when that cannot
# be established. Only a digest of OUR repository counts: a sidecar's image is not
# a rollback target for this Deployment. A multi-image pod template is likewise
# refused rather than guessed at -- the completion predicate above already requires
# every container to carry the same image, so disagreement means something outside
# this channel's model is going on and pinning would be a guess.
#
# The pod template alone is NOT sufficient evidence, because it records what was
# asked for rather than what is running. Nothing reverts spec.template after a
# failed rollout, so a digest that was applied and never became ready sits there
# indefinitely -- and pinning that would hold a slot for a digest which never
# served traffic while the last healthy one aged out, reaching the very wedge
# BLO-28483 exists to prevent by a different route. So the spec is believed only
# once ROLLOUT_SERVING_JQ confirms the rollout of that spec has fully landed.
#
# Every failure path returns empty and succeeds. This is an availability
# safeguard, not a gate: not being able to name the live digest must degrade to
# the previous age-ordered behaviour, never fail an otherwise valid release.
# Tightening the evidence therefore costs no availability -- a rollout in flight,
# or one that never landed, simply goes unpinned.
#
# Declining to believe the spec is correct but not sufficient on its own, because
# nothing then names the last healthy digest either and the ring is back to pure
# age ordering -- the same wedge, one failure later (BLO-31842). The previous
# ReplicaSet is the object that still names it, so a spec that fails the serving
# gate falls back to serving_replicaset_image below.
live_running_digest() {
  local live_json image
  live_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
    get deployment "$DEPLOYMENT" -o json 2>/dev/null)" || return 0
  if jq -e "$ROLLOUT_SERVING_JQ" <<<"$live_json" >/dev/null 2>&1; then
    image="$(jq -r '
      [ .spec.template.spec.containers[]?.image // empty ] as $images
      | if ($images | length) > 0 and (($images | unique | length) == 1)
        then $images[0]
        else ""
        end
    ' <<<"$live_json" 2>/dev/null)" || return 0
  else
    image="$(serving_replicaset_image "$live_json")" || return 0
  fi
  [[ "$image" == "${IMAGE_REPOSITORY}@sha256:"* ]] || return 0
  printf '%s\n' "${image#*@}"
}

# The image carried by the LOWEST-REVISION ReplicaSet of this Deployment that still
# has ready pods, or empty. Reached only when the Deployment's own template has
# failed the serving gate -- typically because a rollout was applied and never became
# ready, which leaves spec.template naming a digest that never carried traffic
# while the previous ReplicaSet keeps serving the one that did.
#
# LOWEST REVISION rather than newest, and rather than "exactly one" (BLO-32101).
# Taking the NEWEST is wrong, for either of the two ways to reach the two-serving
# case:
#
#   - A roll still moving. The newer digest is usually the one being approved right
#     now, which build_approval_ring already holds in slot 0 and discards as not
#     distinct, so pinning it would be a no-op anyway.
#   - A roll stalled part-way, which is reachable here rather than hypothetical.
#     With maxSurge: 1 / maxUnavailable: 0 (values.yaml api.maxSurge) the old
#     ReplicaSet scales 2->1 as soon as the first new pod goes ready, so a second
#     new pod that never schedules parks the Deployment at old=1 ready / new=1
#     ready indefinitely -- and deployment-api.yaml hard-enforces DoNotSchedule
#     spread across nodes for pods of the SAME ReplicaSet (BLO-20901), so losing a
#     node to capacity holds that surge pod Pending. Here the newer digest is the
#     BROKEN one rather than the one being approved, so pinning it would be
#     actively worse than pinning nothing.
#
# This function originally required EXACTLY ONE serving ReplicaSet and declined
# otherwise, on the reasoning that neither of two serving digests is "the running
# one". That is true and still not a reason to decline: in BOTH cases above the
# PREVIOUS ReplicaSet is the one carrying the last-healthy digest this reader
# exists to recover -- in the stalled case it is the only object that still names
# it -- and declining threw it away. An RS with ready pods is serving traffic by
# definition, so ordering the serving set breaks the tie in exactly the direction
# this reader wants. Ordered-wins therefore dominates: the two rules agree whenever
# one serving RS exists, and where they differ the strict rule pinned nothing while
# this one pins the last-healthy digest.
#
# The order is `deployment.kubernetes.io/revision` ASCENDING, NOT creationTimestamp.
# This distinction is load-bearing rather than stylistic, and creationTimestamp is
# outright wrong (raised on #1676, native-codex lens):
#
#   - The Deployment controller REUSES a ReplicaSet whose pod template is
#     byte-identical to one it has seen before. FindNewReplicaSet matches it and
#     getNewReplicaSet scales that existing object back up instead of minting a new
#     one -- preserving its original creationTimestamp while bumping its revision
#     annotation to the new highest revision.
#   - So a reused RS is simultaneously the OLDEST by stamp and the NEWEST by
#     rollout. "Older" then stops meaning "has been serving longer": a reused RS may
#     have sat at zero replicas for days and only just scaled back up. Ordering by
#     stamp would elect the digest being rolled OUT -- already admissible by
#     construction, so pinning it wastes the slot that should have held the digest
#     still serving, which then ages out and leaves nothing to fall back to. That is
#     the BLO-28483 wedge this reader exists to prevent, reached by a new route.
#   - This is not hypothetical here. `helm rollback paperclip <REVISION>` is the
#     documented rollback path (deploy/helm/paperclip/README.md), it re-applies the
#     stored manifest verbatim rather than re-rendering it, and the paperclip-api pod
#     template carries only two variable annotations (deployed-commit and
#     approval-plan-sha256) which that stored manifest restores unchanged. So a
#     rollback reproduces a previously-seen template exactly and triggers the reuse.
#     The approval ring has no purpose unless that path is exercised.
#
# Revision strictly dominates the stamp: revisions are unique per ReplicaSet and
# monotonic per rollout, so the two agree whenever no reuse has occurred, and
# revision is the correct answer when it has.
#
# Revision is consulted ONLY to break a tie among ReplicaSets that already passed
# ownership and readiness, and the winner is then subjected to the same container
# and repository checks as before, with no fallthrough to the runner-up. So an
# elected ReplicaSet whose containers disagree, or one carrying another
# repository's image, still yields no digest rather than promoting the next one
# -- the elected RS being disqualified is evidence about the rollback target, not an
# invitation to pick a different one.
#
# Two shapes leave no winner to pick and are declined rather than guessed at, both
# of which the plain sort would otherwise answer arbitrarily:
#
#   - Equal revisions. Two ReplicaSets of one Deployment should never share a
#     revision, so this is a shape outside the controller's model rather than a
#     near-miss; jq's sort would resolve it on apiserver list order.
#   - A missing or non-numeric revision annotation. The controller sets it on every
#     ReplicaSet it creates (verified on the live paperclip-api set, 2026-09-06),
#     so its absence likewise means something outside the model. Declining is the
#     conservative direction: it costs a recovery opportunity, where guessing costs
#     the rollback target.
#
# Revisions are compared NUMERICALLY after an explicit integer test, so revision 9
# does not outrank revision 10 the way a string compare would.
#
# ReplicaSets are matched by the Deployment's own selector AND by an ownerReference
# to its uid. The selector alone is server-side narrowing; the uid is what makes it
# exact, so an overlapping selector elsewhere in the namespace cannot contribute a
# rollback target for a different workload.
#
# A failed list is REPORTED rather than swallowed. This reader needs `get`/`list`
# on apps/replicasets for the deploy identity, and as of 2026-09-04 the deploy SA
# (system:serviceaccount:paperclip:paperclip-ci-deploy) holds them only through
# RoleBinding/paperclip-ci-deploy-admin -> ClusterRole/admin, which carries a
# deprecation annotation and whose removal is tracked at BLO-21598. The scoped
# replacement Role/paperclip-ci-deploy grants apps/{deployments,statefulsets} and
# no replicasets rule at all. So the day that cutover lands, this reader starts
# returning empty on every release -- silently, with every stubbed unit test in
# scripts/approve-paperclip-api-digest.test.js still green, because they stub
# kubectl. The warning below is what makes that visible in the deploy log instead.
# It stays a warning: this is still an availability safeguard, not a gate.
#
# A jq ABORT is reported the same way, and for the same reason (BLO-32267). Every
# decline above is expressed by the program succeeding and emitting "", so a
# non-zero jq exit can only mean the program itself is broken -- and swallowing
# its stderr made that indistinguishable from "no rollback target". See the
# branch itself for why that conflation is not hypothetical.
serving_replicaset_image() {
  local live_json="$1"
  local selector uid rs_json rs_err rs_status jq_err jq_status state_dir state_dir_owned="" image=""

  selector="$(jq -r '
    [ (.spec.selector.matchLabels // {}) | to_entries[] | "\(.key)=\(.value)" ]
    | join(",")
  ' <<<"$live_json" 2>/dev/null)" || return 0
  uid="$(jq -r '.metadata.uid // ""' <<<"$live_json" 2>/dev/null)" || return 0

  # Warn-once markers and the stderr capture live in a directory the CALLER owns.
  # Both properties matter and neither is available any other way: this function
  # runs inside $( ), so a shell variable set here cannot survive back to the
  # rotate loop that re-reads the digest on every 409, and a `local` path cannot
  # be seen by the EXIT trap that clears the script's other temp files. A file in
  # a directory the caller minted is visible to both. When no caller directory
  # exists -- the extracted-function unit tests, which source this on its own --
  # an ephemeral one is minted and removed before returning, so the markers are
  # per-invocation there and nothing is left behind either way.
  state_dir="${rs_state_dir:-}"
  if [[ -z "$state_dir" || ! -d "$state_dir" ]]; then
    state_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-approve-rs.XXXXXX")" || return 0
    state_dir_owned=1
  fi

  if [[ -z "$selector" || -z "$uid" ]]; then
    # Not reachable against the Helm-rendered paperclip-api Deployment, which uses
    # matchLabels. It is reachable for a selector written with matchExpressions
    # only, and returning quietly there would be the same silent hollowing-out
    # this reader's list-failure branch exists to prevent -- so it is stated too.
    if [[ ! -e "${state_dir}/warned-selector" ]]; then
      : >"${state_dir}/warned-selector"
      echo "warning: Deployment/${DEPLOYMENT} exposes no matchLabels selector and uid pair, so the" >&2
      echo "         ReplicaSet that last actually served traffic cannot be identified. The" >&2
      echo "         approval ring falls back to pure age ordering and the rollback target can" >&2
      echo "         age out (BLO-28483, BLO-31842)." >&2
    fi
  else
    rs_err="${state_dir}/list-err"
    : >"$rs_err"
    rs_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
      get replicasets --selector "$selector" -o json 2>"$rs_err")" && rs_status=0 || rs_status=$?
    if (( rs_status != 0 )); then
      # Warned once per script run, not once per rotation: this reader is called
      # again on every 409 retry, so an unwarned branch would print the same five
      # lines up to MAX_ROTATE_ATTEMPTS times and bury the signal in its own noise.
      if [[ ! -e "${state_dir}/warned-list" ]]; then
        : >"${state_dir}/warned-list"
        echo "warning: cannot list ReplicaSets in namespace ${DEPLOY_NAMESPACE}, so the digest that" >&2
        echo "         last actually served traffic cannot be named. Deployment/${DEPLOYMENT} names a" >&2
        echo "         digest whose rollout has not landed, so the approval ring falls back to pure" >&2
        echo "         age ordering and the rollback target can age out (BLO-28483, BLO-31842)." >&2
        echo "         The deploy identity needs get+list on apps/replicasets in this namespace." >&2
        sed 's/^/         /' <"$rs_err" >&2
      fi
    else
      jq_err="${state_dir}/jq-err"
      : >"$jq_err"
      image="$(jq -r --arg uid "$uid" '
        def rs_image:
          [ .spec.template.spec.containers[]?.image // empty ] as $images
          | if ($images | length) > 0 and (($images | unique | length) == 1)
            then $images[0]
            else ""
            end;

        # null for a ReplicaSet whose revision annotation is absent or not an
        # integer, which the caller below turns into a decline. The string test
        # runs before tonumber so a malformed value declines rather than aborting
        # the whole program, and the type guard runs before the string test so a
        # non-string annotation cannot error inside test() either.
        def rs_revision:
          ((.metadata.annotations // {})["deployment.kubernetes.io/revision"]) as $r
          | if ($r | type) == "string" and ($r | test("^[0-9]+$"))
            then ($r | tonumber)
            else null
            end;

        [ .items[]?
          | select(
              [ (.metadata.ownerReferences // [])[]
                | select(.kind == "Deployment" and .uid == $uid)
              ] | length == 1
            )
          | select((.status.readyReplicas // 0) > 0)
        ] as $serving
        | [ $serving[] | rs_revision ] as $revisions
        | if   ($serving | length) == 0 then ""
          elif ($serving | length) == 1 then ($serving[0] | rs_image)
          elif ($revisions | map(select(. == null)) | length) > 0 then ""
          elif (($revisions | sort) | .[0] == .[1]) then ""
          else ($serving | sort_by(rs_revision) | .[0] | rs_image)
          end
      ' <<<"$rs_json" 2>"$jq_err")" && jq_status=0 || jq_status=$?
      if (( jq_status != 0 )); then
        # A non-zero jq exit is a BROKEN PROGRAM, not a decline (BLO-32267).
        # Every decline above -- no serving ReplicaSet, a missing or non-integer
        # revision, tied revisions, containers that disagree -- is expressed by
        # the program SUCCEEDING and emitting "". So the only way to arrive here
        # is a jq that could not run: a syntax error, a type error, an unguarded
        # coercion. The empty string is then a symptom rather than an answer, and
        # `2>/dev/null` used to throw away the one line that said which.
        #
        # That conflation is not hypothetical. BLO-32101's first attempt at the
        # malformed-revision case passed WITH and WITHOUT the guard it was written
        # to prove, because an abort and a clean decline are indistinguishable
        # from outside; it had to be rewritten to become discriminating. Left
        # alone, a future edit that breaks this program surfaces as a silently
        # missing recovery digest -- in the very reader whose purpose is to
        # preserve the last-healthy one.
        #
        # Reported the same way the list failure two branches up is: warned once
        # per script run (the reader is re-entered on every 409 retry), degrading
        # to empty rather than failing the release. This is still an availability
        # safeguard, not a gate.
        image=""
        if [[ ! -e "${state_dir}/warned-jq" ]]; then
          : >"${state_dir}/warned-jq"
          echo "warning: the ReplicaSet reader's jq program failed (exit ${jq_status}), so the digest that" >&2
          echo "         last actually served traffic cannot be named. This is a broken program rather" >&2
          echo "         than a decline: the approval ring falls back to pure age ordering and the" >&2
          echo "         rollback target can age out (BLO-28483, BLO-31842)." >&2
          sed 's/^/         /' <"$jq_err" >&2
        fi
      fi
      rm -f "$jq_err"
    fi
    rm -f "$rs_err"
  fi

  if [[ -n "$state_dir_owned" ]]; then
    rm -rf "$state_dir"
  fi
  printf '%s\n' "$image"
}

# Build the approval window, newest-first, from the digest being released, the
# digest currently running, and the existing list on stdin.
#
# A plain prepend-and-truncate evicts by age alone, which is exactly backwards
# under the failure this window exists to cover. Every failed deploy approves a
# digest that never reached the cluster and permanently consumes a slot, so a run
# of consecutive failures -- precisely when a rollback is needed -- is what ages
# the running digest out. Once it is gone, helm cannot roll back to the state
# actually serving traffic, and a transient upgrade failure becomes a wedged
# release that cannot self-heal (BLO-28483).
#
# So the running digest is pinned immediately behind the one being released,
# ahead of the age-ordered fill. This REORDERS eviction; it does not widen the
# window. The total stays bounded by $3, so the maxApprovedApiDigests CEL
# variable in paperclip/paperclip-public-tools.yaml is untouched and cannot
# drift. The cost is one historical slot, which is the correct trade: an older
# digest is a convenience, the running one is the only guaranteed-good rollback
# target.
#
# Extracted verbatim and exercised by scripts/approve-paperclip-api-digest.test.js,
# so a rewrite fails that test rather than silently reverting the guarantee.
build_approval_ring() {
  local new_digest="$1" live_digest="$2" max="$3"
  local -a ring=("$new_digest")
  local entry

  # Pin only a well-formed, distinct digest, and only when there is a slot for it
  # after the released digest. A config-only release reusing the running digest
  # lands in the "not distinct" branch and needs no pin -- it is already slot 1.
  if (( max >= 2 )) \
      && [[ "$live_digest" =~ ^sha256:[0-9a-f]{64}$ && "$live_digest" != "$new_digest" ]]; then
    ring+=("$live_digest")
  else
    live_digest=""
  fi

  # Anything malformed already in the list is discarded rather than carried
  # forward -- the policy would ignore it anyway, and leaving it in place would
  # consume a slot in the window. Entries already placed above are dropped here so
  # they cannot appear twice.
  while IFS= read -r entry; do
    (( ${#ring[@]} < max )) || break
    [[ -n "$entry" ]] || continue
    ring+=("$entry")
  done < <(
    sed $'s/^\r*//; s/\r*$//' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
      | grep -E '^sha256:[0-9a-f]{64}$' \
      | grep -Fxv "$new_digest" \
      | { if [[ -n "$live_digest" ]]; then grep -Fxv "$live_digest"; else cat; fi } \
      || true
  )

  printf '%s\n' "${ring[@]}"
}

# Render an approval window for operator output: one indented entry per line, or
# an explicit marker when empty so a failure report never renders as a silent
# blank line. Used by the read-back guards as well as the success path, because
# on the failure paths the contents are the actionable part -- a bare count says
# the window is wrong without saying what is in it to trim.
format_digest_list() {
  local list="$1"
  if [[ -z "$list" ]]; then
    echo "  (none)"
    return 0
  fi
  printf '%s\n' "$list" | sed 's/^/  - /'
}

MAX_ROTATE_ATTEMPTS="${PAPERCLIP_APPROVAL_ROTATE_ATTEMPTS:-5}"
replace_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-err.XXXXXX")"
nonce_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-nonce.XXXXXX")"
server_plan_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-server-plan.XXXXXX")"
probe_attempts_log="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-probe-log.XXXXXX")"
release_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-release-err.XXXXXX")"
# Owned here rather than inside serving_replicaset_image so the EXIT trap can
# clear it: that reader runs inside $( ), so a path it mints itself is invisible
# to this shell. Holding it here also makes its warn-once markers span the whole
# rotate loop instead of resetting on every 409 retry.
rs_state_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-approve-rs.XXXXXX")"
lock_cleanup_armed=""
lock_preserve_on_failure=""
lock_owner_is_ours=""

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$lock_preserve_on_failure" && $status -ne 0 ]]; then
    echo "Preserved the adopted in-flight lock after this exact retry failed." >&2
    echo "The original rollout may still be active; re-read the current owner before" >&2
    echo "retrying or explicitly abandoning the transaction." >&2
  elif [[ -n "$lock_cleanup_armed" && $status -ne 0 ]]; then
    if release_in_flight_lock; then
      echo "Retired this approval's in-flight lock; the ring still lists ${DIGEST}." >&2
      echo "A corrected plan or a rollback can be approved without an out-of-band edit." >&2
    else
      # Both halves are printed, not just the digest. This branch is gated on
      # lock_cleanup_armed, which is only set after LOCK_OWNER_ID is assigned,
      # so the owner is guaranteed in scope here -- and the likeliest way to
      # arrive is a read failure, which returns without retrying. Sending the
      # operator to the cluster for a value we are holding would ask them to
      # re-run the very read that just failed. The annotation query stays as
      # the fallback for the case where this process's value is genuinely gone.
      echo "WARNING: could not retire the in-flight lock on ${DIGEST}." >&2
      echo "The next approval will refuse until it is retired with both halves:" >&2
      echo "  PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=${DIGEST}" >&2
      echo "  PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=${LOCK_OWNER_ID}" >&2
      echo "If that owner is refused as 'nothing to retire', a later run adopted the" >&2
      echo "lock and rewrote it; read the current one from the cluster instead:" >&2
      echo "  kubectl -n ${NAMESPACE} get configmap ${CONFIGMAP} \\" >&2
      echo "    -o jsonpath='{.metadata.annotations.${LOCK_OWNER_ANNOTATION//./\\.}}'" >&2
    fi
  fi
  rm -f "$replace_err" "$nonce_err" "$server_plan_err" "$probe_attempts_log" "$release_err"
  rm -rf "$rs_state_dir"
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rotated=""
for attempt in $(seq 1 "$MAX_ROTATE_ATTEMPTS"); do
  # `get` is the only read verb the approver holds, and it is scoped to this one
  # name. A failure here means the credential is wrong or the ConfigMap was never
  # installed by the cluster-admin bootstrap — both are fail-closed, so surface
  # them rather than trying to create the object.
  if ! current_json=$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json 2>/dev/null); then
    echo "cannot read ${NAMESPACE}/${CONFIGMAP}." >&2
    echo "The approval ConfigMap is installed by the cluster-admin bootstrap" >&2
    echo "(paperclip/paperclip-release-approvals.yaml); this script never creates it." >&2
    exit 1
  fi

  in_flight_digest="$(jq -r --arg key "$LOCK_DIGEST_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_plan="$(jq -r --arg key "$LOCK_PLAN_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_uid="$(jq -r --arg key "$LOCK_UID_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_generation="$(jq -r --arg key "$LOCK_GENERATION_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_marker="$(jq -r --arg key "$LOCK_MARKER_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_server_plan="$(jq -r --arg key "$LOCK_SERVER_PLAN_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  in_flight_owner="$(jq -r --arg key "$LOCK_OWNER_ANNOTATION" \
    '.metadata.annotations[$key] // ""' <<<"$current_json")"
  matching_lock=""
  if [[ -n "$in_flight_digest" ]]; then
    if [[ ! "$in_flight_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "approval transaction lock contains malformed digest: $in_flight_digest" >&2
      exit 1
    fi
    if [[ "$in_flight_digest" == "$DIGEST" \
          && "$in_flight_plan" == "$PLAN_SHA256" ]]; then
      if [[ "$in_flight_marker" != "$PLAN_MARKER" ]]; then
        echo "matching approval lock carries a different rollout marker; refusing to rewrite its nonce" >&2
        exit 1
      fi
      if [[ -n "$in_flight_server_plan" \
            && ! "$in_flight_server_plan" =~ ^[0-9a-f]{64}$ ]]; then
        echo "matching approval lock carries a malformed server-normalized plan hash" >&2
        exit 1
      fi
      if [[ ! "$in_flight_owner" =~ ^[0-9a-f]{64}$ ]]; then
        echo "matching approval lock has no valid unique owner; retire it explicitly before retrying" >&2
        exit 1
      fi
      matching_lock=yes
    else
      if [[ -n "$ABANDON_IN_FLIGHT" ]]; then
        if [[ "$ABANDON_IN_FLIGHT" != "$in_flight_digest" ]]; then
          echo "refusing to approve ${DIGEST}: asked to abandon ${ABANDON_IN_FLIGHT}, but the" >&2
          echo "in-flight lock is on ${in_flight_digest}. Re-read the lock and name that digest" >&2
          echo "if you really mean to retire it." >&2
          exit 2
        fi
        if [[ "$ABANDON_IN_FLIGHT_OWNER" != "$in_flight_owner" ]]; then
          echo "refusing to approve ${DIGEST}: asked to abandon owner ${ABANDON_IN_FLIGHT_OWNER}, but the" >&2
          echo "in-flight lock owner is ${in_flight_owner}. Re-read the lock and name both its" >&2
          echo "digest and owner if you really mean to retire that exact transaction." >&2
          exit 2
        fi
        echo "Retiring in-flight approval lock on ${in_flight_digest} owner ${in_flight_owner} at explicit operator request"
      elif live_deployment_completed_digest \
          "$in_flight_digest" "$in_flight_uid" "$in_flight_generation" \
          "$in_flight_marker" "$in_flight_server_plan"; then
        echo "Prior approval ${in_flight_digest} completed rollout on Deployment/${DEPLOYMENT}; advancing the transaction lock"
      else
        echo "refusing to approve ${DIGEST}: ${in_flight_digest} is still locked until Deployment/${DEPLOYMENT} completes rollout" >&2
        echo "If that release is still landing, wait for it." >&2
        echo "If it failed, was rolled back, or will never complete, retire the lock explicitly:" >&2
        echo "  PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=${in_flight_digest} \\" >&2
        echo "    PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=${in_flight_owner} \\" >&2
        echo "    $0 ${DIGEST} <planned-deployment.yaml>" >&2
        exit 1
      fi
    fi
  fi

  current_raw="$(jq -r --arg key "$DATA_KEY" '.data[$key] // ""' <<<"$current_json")"

  # Read the running digest fresh on every rotation attempt: a 409 sends us back
  # through here, and a rollout that landed in the meantime changes what the
  # rollback target is.
  live_digest="$(live_running_digest)"

  mapfile -t approved < <(
    printf '%s\n' "$current_raw" \
      | build_approval_ring "$DIGEST" "$live_digest" "$MAX_APPROVED_DIGESTS"
  )

  payload=$(printf '%s\n' "${approved[@]}")

  # An exact retry takes ownership with a resourceVersion-guarded write while
  # preserving the original rollout baseline and plan fields. The prior owner
  # can then no longer retire this retry's operative lock from an EXIT trap.
  if [[ -n "$matching_lock" ]]; then
    observed_uid="$in_flight_uid"
    observed_generation="$in_flight_generation"
    locked_server_plan="$in_flight_server_plan"
    replacement_json="$(jq \
      --arg lock_owner "$LOCK_OWNER_ANNOTATION" \
      --arg owner "$LOCK_OWNER_ID" '
        .metadata.annotations[$lock_owner] = $owner
      ' <<<"$current_json")"
  else
    # New transactions first acquire a provisional lock. The empty server-plan
    # field keeps every other release closed out while the now-approved canonical
    # Deployment is normalized under all shipping admission policies.
    observe_rollout_nonce
    locked_server_plan=""
    replacement_json="$(jq \
        --arg key "$DATA_KEY" \
        --arg value "$payload" \
        --arg lock_digest "$LOCK_DIGEST_ANNOTATION" \
        --arg digest "$DIGEST" \
        --arg lock_plan "$LOCK_PLAN_ANNOTATION" \
        --arg plan "$PLAN_SHA256" \
        --arg lock_uid "$LOCK_UID_ANNOTATION" \
        --arg uid "$observed_uid" \
        --arg lock_generation "$LOCK_GENERATION_ANNOTATION" \
        --arg generation "$observed_generation" \
        --arg lock_marker "$LOCK_MARKER_ANNOTATION" \
        --arg marker "$PLAN_MARKER" \
        --arg lock_server_plan "$LOCK_SERVER_PLAN_ANNOTATION" \
        --arg lock_owner "$LOCK_OWNER_ANNOTATION" \
        --arg owner "$LOCK_OWNER_ID" '
          .data[$key] = $value |
          .metadata.annotations = (.metadata.annotations // {}) |
          .metadata.annotations[$lock_digest] = $digest |
          .metadata.annotations[$lock_plan] = $plan |
          .metadata.annotations[$lock_uid] = $uid |
          .metadata.annotations[$lock_generation] = $generation |
          .metadata.annotations[$lock_marker] = $marker |
          .metadata.annotations[$lock_server_plan] = "" |
          .metadata.annotations[$lock_owner] = $owner
        ' <<<"$current_json")"
  fi

  # resourceVersion rides along inside replacement_json, so this write is
  # rejected if anyone else changed the transaction since the read above.
  # New-transaction cleanup is armed BEFORE the write: `kubectl replace` can
  # succeed server-side and still report failure to the client. Exact retries
  # instead preserve the inherited lock across every post-transfer failure.
  if [[ -n "$matching_lock" ]]; then
    # A retry adopts an already-operative rollout lock. If anything after the
    # owner transfer fails, retiring that inherited lock would reopen the ring
    # while the original rollout may still be running.
    lock_cleanup_armed=""
    lock_preserve_on_failure=yes
    lock_owner_is_ours=""
  else
    lock_cleanup_armed=yes
    lock_preserve_on_failure=""
    lock_owner_is_ours=yes
  fi
  if printf '%s\n' "$replacement_json" \
      | kubectl replace -f - >/dev/null 2>"$replace_err"; then
    rotated=yes
    # Only after the write landed: before it, no lock with this owner exists.
    #
    # Deliberately fatal under `set -e`, matching this file's fail-fast
    # convention. The minted branch just armed lock_cleanup_armed and cleared
    # lock_preserve_on_failure, so aborting here reaches cleanup_on_exit's
    # release_in_flight_lock: the lock is retired, the ring still lists DIGEST,
    # and the run fails visibly. That is self-healing, and it is what the next
    # approval needs.
    #
    # Warning and carrying on would instead exit 0 with the ring rotated and a
    # live lock nothing can name -- an absent owner file means "no lock this run
    # is entitled to abandon", so a cleanup step correctly declines to touch it.
    # That is the BLO-31598 wedge reintroduced, and silently. The path was proven
    # writable during env validation, so reaching here at all means something
    # changed mid-run (revoked mount, full disk).
    emit_lock_owner
    break
  fi

  if ! grep -qiE 'conflict|modified|latest version' "$replace_err"; then
    echo "failed to rotate ${NAMESPACE}/${CONFIGMAP}:" >&2
    cat "$replace_err" >&2
    exit 1
  fi
  # A conflict proves this write did not land. Disarm before retrying so a
  # later exact-match retry cannot retire a lock acquired by another process.
  lock_cleanup_armed=""
  lock_preserve_on_failure=""
  lock_owner_is_ours=""
  echo "approval ring changed underneath us; retrying (${attempt}/${MAX_ROTATE_ATTEMPTS})" >&2
  sleep $(( attempt ))
done

if [[ -z "$rotated" ]]; then
  echo "could not rotate ${NAMESPACE}/${CONFIGMAP} after ${MAX_ROTATE_ATTEMPTS} attempts;" >&2
  echo "another release is approving concurrently — serialize the release path" >&2
  exit 1
fi

echo "Approving ${DIGEST} for harbor.blockcast.net/paperclip/paperclip"

# Read back rather than trusting the replace exit code. The digest and its
# transaction lock must be one observed resource version before any probe.
verify_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json)"
verify_raw="$(jq -r --arg key "$DATA_KEY" '.data[$key] // ""' <<<"$verify_json")"
# Normalise once. The count, the absence test, and every operator-facing report
# below all read this same list, so they cannot disagree about what the cluster
# holds -- previously each derived its own view from verify_raw.
verify_digests="$(printf '%s\n' "$verify_raw" \
  | sed $'s/^\r*//; s/\r*$//' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -E '^sha256:[0-9a-f]{64}$' \
  || true)"
verify_count=$(printf '%s' "$verify_digests" | grep -c . || true)

if ! printf '%s\n' "$verify_digests" | grep -Fxq "$DIGEST"; then
  echo "approval did not persist: ${DIGEST} is absent from ${NAMESPACE}/${CONFIGMAP}" >&2
  echo "the window holds ${verify_count} entries, as persisted:" >&2
  format_digest_list "$verify_digests" >&2
  exit 1
fi

if (( verify_count > MAX_APPROVED_DIGESTS )); then
  echo "approval window is ${verify_count} entries, over the ${MAX_APPROVED_DIGESTS} the policy accepts;" >&2
  echo "the admission policy will now deny every rollout until this is trimmed." >&2
  echo "The window, as persisted:" >&2
  format_digest_list "$verify_digests" >&2
  exit 1
fi

# Report the window that was READ BACK, not the one just built. On the exact-retry
# path the replacement only re-owns the lock and never rewrites .data, so the
# locally-built ring is not what the cluster holds. That gap was cosmetic while
# the window was a plain age-ordered list; now that a slot is reserved for the
# running digest, an operator reading "the rollback target is pinned" off a list
# that was never persisted would be misled at exactly the wrong moment.
echo "Approval window (newest first, max ${MAX_APPROVED_DIGESTS}), as persisted:"
format_digest_list "$verify_digests"

if ! jq -e \
    --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
    --arg digest "$DIGEST" \
    --arg plan_key "$LOCK_PLAN_ANNOTATION" \
    --arg plan "$PLAN_SHA256" \
    --arg marker_key "$LOCK_MARKER_ANNOTATION" \
    --arg marker "$PLAN_MARKER" \
    --arg server_plan_key "$LOCK_SERVER_PLAN_ANNOTATION" \
    --arg server_plan "$locked_server_plan" \
    --arg owner_key "$LOCK_OWNER_ANNOTATION" \
    --arg owner "$LOCK_OWNER_ID" '
      .metadata.annotations[$digest_key] == $digest and
      .metadata.annotations[$plan_key] == $plan and
      .metadata.annotations[$marker_key] == $marker and
      .metadata.annotations[$server_plan_key] == $server_plan and
      .metadata.annotations[$owner_key] == $owner
    ' <<<"$verify_json" >/dev/null; then
  echo "approval transaction lock did not persist with the digest" >&2
  exit 1
fi

# ConfigMap reads are storage-consistent, but admission parameters are backed by
# an informer. Poll the exact canonical Deployment through the deploy identity
# until both shipping policies admit it. Keeping metadata.name=paperclip-api is
# load-bearing: the routing policy rejects protected API selector labels on any
# renamed Deployment. When the Deployment exists, attach its current
# resourceVersion and dry-run an update; unlike SSA, this does not conflict with
# Helm's managed-field ownership. Create semantics are used only on NotFound.
# The returned object is also the server-normalized plan whose hash completion
# later requires on the live rollout.
#
# The wait is for an informer to converge, not for a kubectl round trip, so the
# cadence has to be sized in wall-clock minutes rather than attempts. The
# original flat 1s/2s over 30 attempts capped the sleep budget at ~56s; three
# consecutive production deploys (2026-08-14, -16, -17) burned the entire window
# and failed at this step, and an otherwise-identical rerun on 08-18 passed with
# no code change — the signature of a race, not a rejected manifest. Back off
# geometrically to a ceiling: still ~1s for the common case where the parameter
# is already visible, but a tail measured in minutes when it is not.
# PROBE_ATTEMPTS and PROBE_MAX_SLEEP_SECONDS are resolved and range-checked in
# the operator-env block near the top, before the in-flight lock is taken.
#
# 1,1,2,2,4,4,8,8,... capped. Two different quantities, kept distinct on purpose
# because conflating them is what this fix exists to prevent: probe_backoff_seconds
# over 40 attempts totals 286s, but the loop skips the sleep after the final
# attempt, so an exhausted window spends 278s sleeping. The exponent is
# clamped before shifting: bash arithmetic is signed 64-bit, so `1 << 63` is
# INT64_MIN and a raised PAPERCLIP_APPROVAL_PROBE_ATTEMPTS — which the
# exhaustion message below tells operators to do — would otherwise hand `sleep`
# a negative delay and abort the run with the lock still held.
probe_backoff_seconds() {
  local attempt="$1"
  local exponent=$(( (attempt - 1) / 2 ))
  local delay="$PROBE_MAX_SLEEP_SECONDS"
  if (( exponent < 31 )); then
    delay=$(( 1 << exponent ))
    if (( delay > PROBE_MAX_SLEEP_SECONDS )); then
      delay="$PROBE_MAX_SLEEP_SECONDS"
    fi
  fi
  printf '%s' "$delay"
}

# Only the final attempt's stderr used to be reported. When the ring became
# visible partway through, the tail of the window could be dominated by an
# unrelated policy, so an informer-lag timeout was indistinguishable from a
# genuine manifest rejection — which is exactly how this failure was first
# misdiagnosed as Helm-chart drift. Keep every attempt so the summary can show
# what actually denied, and how often.
record_probe_attempt() {
  printf 'attempt %s: %s\n' \
    "$1" \
    "$(tr '\n' ' ' <"$server_plan_err" | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')" \
    >>"$probe_attempts_log"
}

probe_started_at="$(date +%s)"
server_plan_ready=""
server_plan_json=""
for attempt in $(seq 1 "$PROBE_ATTEMPTS"); do
  server_plan_candidate="$planned_json"
  server_plan_verb=create
  if live_server_plan_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
      get deployment "$DEPLOYMENT" -o json 2>"$server_plan_err")"; then
    if ! live_resource_version="$(jq -er \
        '.metadata.resourceVersion | select(type == "string" and length > 0)' \
        <<<"$live_server_plan_json")"; then
      echo "live Deployment/${DEPLOYMENT} has no resourceVersion" >"$server_plan_err"
      record_probe_attempt "$attempt"
      sleep "$(probe_backoff_seconds "$attempt")"
      continue
    fi
    server_plan_candidate="$(jq -n \
      --argjson planned "$planned_json" \
      --argjson live "$live_server_plan_json" \
      --arg resource_version "$live_resource_version" '
        def release_controlled_metadata_key:
          startswith("app.kubernetes.io/") or
          startswith("helm.sh/") or
          startswith("meta.helm.sh/") or
          startswith("paperclip.blockcast.net/");
        ($live.metadata
          | del(.managedFields, .uid, .creationTimestamp, .generation)) as $live_metadata |
        $planned |
        .metadata = ($live_metadata + $planned.metadata) |
        .metadata.labels = (
          (($live.metadata.labels // {})
            | with_entries(select((.key | release_controlled_metadata_key) | not))) +
          ($planned.metadata.labels // {})
        ) |
        .metadata.annotations = (
          (($live.metadata.annotations // {})
            | with_entries(select((.key | release_controlled_metadata_key) | not))) +
          ($planned.metadata.annotations // {})
        ) |
        if (.metadata.labels | length) == 0 then del(.metadata.labels) else . end |
        if (.metadata.annotations | length) == 0 then del(.metadata.annotations) else . end |
        .metadata.resourceVersion = $resource_version
      ')"
    server_plan_verb=replace
  elif ! grep -qiE 'not[[:space:]]+found|notfound' "$server_plan_err"; then
    record_probe_attempt "$attempt"
    sleep "$(probe_backoff_seconds "$attempt")"
    continue
  fi

  if server_plan_json="$(printf '%s\n' "$server_plan_candidate" \
      | "${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" "$server_plan_verb" \
          --dry-run=server -o json -f - 2>"$server_plan_err")"; then
    server_plan_ready=yes
    # Always report, not just on a slow convergence: this race was invisible for
    # three deploys precisely because a win left no trace. A run that habitually
    # lands near PROBE_ATTEMPTS is one informer hiccup from failing, and only
    # the success-path number shows that before it does.
    echo "Plan became admissible on probe ${attempt}/${PROBE_ATTEMPTS} after $(( $(date +%s) - probe_started_at ))s."
    break
  fi
  record_probe_attempt "$attempt"
  # No sleep after the final attempt: the loop is about to end, so it buys
  # nothing and would inflate the elapsed figure reported below by one whole
  # ceiling — overstating the window in the very message an operator reads to
  # decide whether to widen it. Spelled as an `if` rather than
  # `(( … )) && sleep`: a false `(( … ))` yields a non-zero status, and this is
  # the last command in the loop body, so the safe reading depends on a `set -e`
  # exemption. An abort here would strand the in-flight lock; not worth the
  # subtlety to save two lines.
  if (( attempt < PROBE_ATTEMPTS )); then
    sleep "$(probe_backoff_seconds "$attempt")"
  fi
done
if [[ -z "$server_plan_ready" ]]; then
  probe_elapsed_seconds=$(( $(date +%s) - probe_started_at ))
  {
    echo "planned Deployment never became admissible for ${DIGEST}"
    echo "  gave up after ${PROBE_ATTEMPTS} probes spanning ${probe_elapsed_seconds}s"
    echo "  denials observed across the window (most frequent first):"
    if ! grep -oE "ValidatingAdmissionPolicy '[^']+'" "$probe_attempts_log" \
        | sort | uniq -c | sort -rn | sed 's/^/    /'; then
      echo "    (no admission-policy denial matched; see the last attempt below)"
    fi
    echo "  last attempt:"
    sed 's/^/    /' "$server_plan_err"
    echo "  If the denials above are dominated by paperclip-api-image-approval,"
    echo "  this is admission-parameter informer lag, not a rejected manifest;"
    echo "  raise PAPERCLIP_APPROVAL_PROBE_ATTEMPTS and retry."
  } >&2
  exit 1
fi
CANONICAL_SERVER_PLAN="$(jq -cS "$CANONICAL_DEPLOYMENT_JQ" <<<"$server_plan_json")"
SERVER_PLAN_SHA256="$(printf '%s' "$CANONICAL_SERVER_PLAN" | sha256sum | awk '{print $1}')"

# A finalized exact retry must observe the same normalized plan while retaining
# every original lock field except owner. A provisional transaction (new or
# recovered after response loss) persists the hash with a second RV-guarded
# update. Until that update lands, the empty field remains an operative lock and
# no different release can rotate the ring.
server_plan_persisted=""
if [[ -n "$locked_server_plan" ]]; then
  if [[ "$locked_server_plan" != "$SERVER_PLAN_SHA256" ]]; then
    echo "matching approval lock carries a different server-normalized plan; refusing to reuse it" >&2
    exit 1
  fi
  server_plan_persisted=yes
else
  for attempt in $(seq 1 "$MAX_ROTATE_ATTEMPTS"); do
    finalize_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json)"
    if ! jq -e \
        --arg data_key "$DATA_KEY" \
        --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
        --arg digest "$DIGEST" \
        --arg plan_key "$LOCK_PLAN_ANNOTATION" \
        --arg plan "$PLAN_SHA256" \
        --arg marker_key "$LOCK_MARKER_ANNOTATION" \
        --arg marker "$PLAN_MARKER" \
        --arg owner_key "$LOCK_OWNER_ANNOTATION" \
        --arg owner "$LOCK_OWNER_ID" '
          .metadata.annotations[$digest_key] == $digest and
          .metadata.annotations[$plan_key] == $plan and
          .metadata.annotations[$marker_key] == $marker and
          .metadata.annotations[$owner_key] == $owner and
          ((.data[$data_key] // "") | split("\n") | index($digest) != null)
        ' <<<"$finalize_json" >/dev/null; then
      echo "approval ring or transaction ownership changed during server normalization" >&2
      exit 1
    fi

    current_server_plan="$(jq -r --arg key "$LOCK_SERVER_PLAN_ANNOTATION" \
      '.metadata.annotations[$key] // ""' <<<"$finalize_json")"
    if [[ "$current_server_plan" == "$SERVER_PLAN_SHA256" ]]; then
      server_plan_persisted=yes
      break
    fi
    if [[ -n "$current_server_plan" ]]; then
      echo "approval transaction acquired a different server-normalized plan hash" >&2
      exit 1
    fi

    finalized_replacement="$(jq \
      --arg key "$LOCK_SERVER_PLAN_ANNOTATION" \
      --arg server_plan "$SERVER_PLAN_SHA256" '
        .metadata.annotations[$key] = $server_plan
      ' <<<"$finalize_json")"
    if printf '%s\n' "$finalized_replacement" \
        | kubectl replace -f - >/dev/null 2>"$replace_err"; then
      server_plan_persisted=yes
      break
    fi

    if ! grep -qiE 'conflict|modified|latest version' "$replace_err"; then
      # The update may have committed before its response was lost. Confirm the
      # exact owner and hash before treating the ambiguous result as a failure.
      uncertain_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json 2>/dev/null || true)"
      if jq -e \
          --arg server_plan_key "$LOCK_SERVER_PLAN_ANNOTATION" \
          --arg server_plan "$SERVER_PLAN_SHA256" \
          --arg owner_key "$LOCK_OWNER_ANNOTATION" \
          --arg owner "$LOCK_OWNER_ID" '
            .metadata.annotations[$server_plan_key] == $server_plan and
            .metadata.annotations[$owner_key] == $owner
          ' <<<"$uncertain_json" >/dev/null 2>&1; then
        server_plan_persisted=yes
        break
      fi
      echo "failed to persist the server-normalized approval plan:" >&2
      cat "$replace_err" >&2
      exit 1
    fi
    echo "approval lock changed while finalizing its server plan; retrying (${attempt}/${MAX_ROTATE_ATTEMPTS})" >&2
    sleep "$(( attempt ))"
  done
fi

if [[ -z "$server_plan_persisted" ]]; then
  echo "could not finalize the server-normalized approval plan after ${MAX_ROTATE_ATTEMPTS} attempts" >&2
  exit 1
fi

# A writer outside this script can still mutate the ConfigMap. Recheck after
# normalization and finalization so success binds the admission decision and
# current lock to the same digest, plan, and unique owner.
final_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json)"
if ! jq -e \
    --arg data_key "$DATA_KEY" \
    --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
    --arg digest "$DIGEST" \
    --arg plan_key "$LOCK_PLAN_ANNOTATION" \
    --arg plan "$PLAN_SHA256" \
    --arg marker_key "$LOCK_MARKER_ANNOTATION" \
    --arg marker "$PLAN_MARKER" \
    --arg server_plan_key "$LOCK_SERVER_PLAN_ANNOTATION" \
    --arg server_plan "$SERVER_PLAN_SHA256" \
    --arg owner_key "$LOCK_OWNER_ANNOTATION" \
    --arg owner "$LOCK_OWNER_ID" '
      .metadata.annotations[$digest_key] == $digest and
      .metadata.annotations[$plan_key] == $plan and
      .metadata.annotations[$marker_key] == $marker and
      .metadata.annotations[$server_plan_key] == $server_plan and
      .metadata.annotations[$owner_key] == $owner and
      ((.data[$data_key] // "") | split("\n") | index($digest) != null)
    ' <<<"$final_json" >/dev/null; then
  echo "approval ring or transaction lock changed during the admission probe" >&2
  exit 1
fi

final_raw="$(jq -r --arg key "$DATA_KEY" '.data[$key] // ""' <<<"$final_json")"
final_count=$(printf '%s\n' "$final_raw" \
  | sed $'s/^\r*//; s/\r*$//' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -Ec '^sha256:[0-9a-f]{64}$' || true)
if (( final_count > MAX_APPROVED_DIGESTS )); then
  echo "approval window changed to ${final_count} entries during normalization, over the ${MAX_APPROVED_DIGESTS} policy bound" >&2
  exit 1
fi

# A release workflow that sets this receives the exact server-normalized object
# whose canonical hash was persisted in the lock. Applying this object directly
# prevents a package manager's three-way merge from preserving live-only drift
# and producing a Deployment that can never satisfy lock completion.
if [[ -n "${PAPERCLIP_APPROVED_SERVER_PLAN_OUT:-}" ]]; then
  (umask 077; printf '%s\n' "$server_plan_json" >"$PAPERCLIP_APPROVED_SERVER_PLAN_OUT")
fi

# From here on, success intentionally leaves the rollout lock active for the
# next release to retire after observing this exact plan marker live. Keep
# cleanup armed until the approved object has been handed off successfully.
lock_cleanup_armed=""

echo "Approved and admission-ready. ${final_count} digest(s) in the window."
echo "Approval lock remains on ${DIGEST} until Deployment/${DEPLOYMENT} rolls out a"
echo "generation newer than ${observed_generation} on that digest with plan marker ${PLAN_MARKER}."
echo "If this release fails and will not be retried, retire the lock explicitly with"
echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=${DIGEST} and"
echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=${LOCK_OWNER_ID} on the next approval."

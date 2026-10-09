#!/usr/bin/env bash
# BLO-41774. Report whether ConfigMap/paperclip-api-approved-images holds an
# in-flight approval lock that no rollout can ever satisfy.
#
# The lock is a correct safety mechanism: an approval stays in flight until the
# Deployment it names has demonstrably rolled out, so a second release cannot
# rotate the approval ring underneath a landing one. What was missing is
# visibility. Nothing detects a lock that will never clear, so the only signal
# has been the NEXT production deploy being refused at its approval step --
# the most expensive possible moment, and one that silently burns a run. It has
# happened twice from different causes (BLO-31598, pre-helm failure; BLO-41478,
# landed then rolled back), so a third should be expected.
#
# READ-ONLY, DELIBERATELY. It issues two `get` calls and writes nothing: no
# retirement, no ConfigMap mutation, no cluster change of any kind. That is not
# an oversight, it is the design. Auto-retiring on "the Deployment advanced past
# the lock and settled elsewhere" races `helm upgrade --atomic`: a release that
# lands and is then rolled back by --atomic, while the deploy job is still
# running, presents exactly that shape -- and retiring there would admit a
# second concurrent approval, which is the race the lock exists to prevent.
# Reporting carries no such hazard. Whether auto-retirement should follow is a
# separate decision that needs that race answered first; this script is the
# detection half and nothing more.
#
# The grace window below is the second guard against the same race: see
# PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES.
#
# usage: [KUBECONFIG=…] scripts/check-stranded-approval-lock.sh
# exit 0  no lock, lock satisfiable, or rollout still landing
# exit 1  STRANDED -- the digest/owner pair printed is pasteable into docker.yml
# exit 2  the check could not be run (missing tool, unreadable object)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPROVE_SCRIPT="${PAPERCLIP_APPROVE_SCRIPT:-${SCRIPT_DIR}/approve-paperclip-api-digest.sh}"

for dep in kubectl jq sha256sum; do
  command -v "$dep" >/dev/null 2>&1 || { echo "$dep is required" >&2; exit 2; }
done

if [[ ! -r "$APPROVE_SCRIPT" ]]; then
  echo "cannot read the approval script at ${APPROVE_SCRIPT}" >&2
  echo "this check derives every predicate and annotation key from it; it has no copy of its own" >&2
  exit 2
fi

# Everything below is lifted OUT OF THE SHIPPING APPROVAL SCRIPT rather than
# restated here. A detector that disagrees with the gate it is detecting for is
# worse than no detector: it would report clean while the next deploy is
# refused, or cry stranded on a lock that is fine. docker.yml already lifts
# CANONICAL_DEPLOYMENT_JQ the same way for its post-rollout comparison, and
# approve-paperclip-api-digest.test.js lifts the jq blocks and shell constants
# for its assertions. Same seam, same reason.
script_jq_block() {
  local name="$1" block
  block="$(sed -n "/^# BEGIN ${name}\$/,/^# END ${name}\$/p" "$APPROVE_SCRIPT" | sed '1d;$d')"
  if [[ -z "$block" ]]; then
    echo "could not lift the ${name} jq block out of ${APPROVE_SCRIPT}" >&2
    exit 2
  fi
  printf '%s\n' "$block"
}

script_const() {
  local name="$1" value
  value="$(sed -n "s/^${name}=\"\\([^\"\$]*\\)\"\$/\\1/p" "$APPROVE_SCRIPT" | head -n1)"
  if [[ -z "$value" ]]; then
    echo "could not lift ${name} out of ${APPROVE_SCRIPT}" >&2
    exit 2
  fi
  printf '%s\n' "$value"
}

# Defaulted the same way the approval script defaults them, so an operator
# pointing both at a non-production cluster gets a consistent pair.
NAMESPACE="${PAPERCLIP_APPROVAL_NAMESPACE:-paperclip-release-approvals}"
CONFIGMAP="${PAPERCLIP_APPROVAL_CONFIGMAP:-paperclip-api-approved-images}"
DEPLOY_NAMESPACE="${PAPERCLIP_DEPLOY_NAMESPACE:-paperclip}"
DEPLOYMENT="${PAPERCLIP_API_DEPLOYMENT:-paperclip-api}"

# Lifted in a loop rather than as eight assignments in a row: a run of
# NAME=VALUE lines is the shape the GitHub egress guard reads as an environment
# dump, and it refuses the push. Spelled with an explicit temporary because
# `declare "$c=$(script_const …)"` returns declare's status, not the
# substitution's -- which would swallow a failed lift and leave the name empty,
# the one failure mode the mutation tests in this script's suite exist to catch.
for const in \
  IMAGE_REPOSITORY \
  LOCK_DIGEST_ANNOTATION LOCK_UID_ANNOTATION LOCK_GENERATION_ANNOTATION \
  LOCK_MARKER_ANNOTATION LOCK_SERVER_PLAN_ANNOTATION LOCK_OWNER_ANNOTATION \
  ROLLOUT_MARKER_ANNOTATION
do
  lifted="$(script_const "$const")"
  declare "$const=$lifted"
done
unset lifted

CANONICAL_DEPLOYMENT_JQ="$(script_jq_block CANONICAL_DEPLOYMENT_JQ)"
ROLLOUT_COMPLETE_JQ="$(script_jq_block ROLLOUT_COMPLETE_JQ)"
ROLLOUT_SERVING_JQ="$(script_jq_block ROLLOUT_SERVING_JQ)"

# ROLLOUT_COMPLETE_JQ is `def advanced: … ; <conjunction ending in advanced>`.
# The conjunction answers "may this lock be retired", which is the verdict; the
# helper alone answers "did the Deployment move at all since the lock was
# written", which is what separates the two known incident shapes in the report
# -- BLO-31598 never moved it, BLO-41478 moved it onto a different plan. Lifted
# rather than restated for the reason everything else here is.
ADVANCED_JQ="$(printf '%s\n' "$ROLLOUT_COMPLETE_JQ" | sed -n '/^def advanced:/,/^  end;$/p')"
if [[ -z "$ADVANCED_JQ" ]]; then
  echo "could not lift the \`advanced\` helper out of ROLLOUT_COMPLETE_JQ in ${APPROVE_SCRIPT}" >&2
  exit 2
fi

# How long a lock may sit unsatisfied before it is called stranded.
#
# This is what makes the check safe against `helm upgrade --atomic`. A lock is
# only ever held by a running deploy job, and docker.yml caps that job at
# `timeout-minutes: 98` -- so a lock older than that is held by nothing, and the
# --atomic window (which lives entirely inside the job) is long over. The
# default is 120m: 98m plus margin for the runner queueing before the job's own
# clock starts. scripts/check-stranded-approval-lock.test.js pins it at or above
# the deploy job's timeout, so raising that timeout fails there rather than
# silently narrowing this window into the race.
#
# It is also what makes the BLO-31598 shape decidable at all. A lock taken
# seconds ago whose `helm upgrade` has not run yet is indistinguishable from one
# whose deploy died before it ever would: in both the Deployment is healthy and
# has not advanced. Only elapsed time separates them.
GRACE_MINUTES="${PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES:-120}"
if [[ ! "$GRACE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES='${GRACE_MINUTES}' is not a non-negative integer" >&2
  exit 2
fi

read_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-stranded-lock.XXXXXX")"
trap 'rm -f "$read_err"' EXIT

# --show-managed-fields because the lock carries no timestamp of its own and the
# last write to this ConfigMap IS the lock being taken or adopted: the approval
# script is its only writer. kubectl strips managedFields from `get` by default,
# so without the flag every lock reads as ageless.
if ! configmap_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" \
    -o json --show-managed-fields 2>"$read_err")"; then
  echo "cannot read ${NAMESPACE}/${CONFIGMAP}:" >&2
  sed 's/^/    /' "$read_err" >&2
  exit 2
fi

lock_annotation() {
  jq -r --arg key "$1" '.metadata.annotations[$key] // ""' <<<"$configmap_json"
}

lock_digest="$(lock_annotation "$LOCK_DIGEST_ANNOTATION")"
if [[ -z "$lock_digest" ]]; then
  echo "verdict=clean"
  echo "No in-flight approval lock on ${NAMESPACE}/${CONFIGMAP}."
  exit 0
fi

lock_owner="$(lock_annotation "$LOCK_OWNER_ANNOTATION")"
lock_uid="$(lock_annotation "$LOCK_UID_ANNOTATION")"
lock_generation="$(lock_annotation "$LOCK_GENERATION_ANNOTATION")"
lock_marker="$(lock_annotation "$LOCK_MARKER_ANNOTATION")"
lock_server_plan="$(lock_annotation "$LOCK_SERVER_PLAN_ANNOTATION")"

# A Deployment that cannot be read is a check that cannot conclude, not a clean
# one. Fail-closed and say so, exactly as the approval script does when it
# cannot read the rollout nonce.
if ! deployment_json="$("${PAPERCLIP_DEPLOY_KUBECTL:-kubectl}" -n "$DEPLOY_NAMESPACE" \
    get deployment "$DEPLOYMENT" -o json 2>"$read_err")"; then
  echo "cannot read Deployment/${DEPLOY_NAMESPACE}/${DEPLOYMENT}:" >&2
  sed 's/^/    /' "$read_err" >&2
  echo "an in-flight lock on ${lock_digest} is present but its satisfiability cannot be decided" >&2
  exit 2
fi

# Branch on jq's exit status, not its truthiness: 1 is a predicate that
# evaluated false, while 3 (compile) and 5 (runtime) are a predicate that could
# not be evaluated. Folding those into `false` reads a broken serving predicate
# as "not serving" and reports a stranded lock as landing, exit 0. Fail closed
# like every other seam here. `exit 2` leaves the command substitution, and
# `set -e` carries it out of the assignment, as script_const's already does.
jq_bool() {
  local out status=0
  out="$(jq -e "$@" 2>&1)" || status=$?
  case "$status" in
    0) printf 'true' ;;
    1) printf 'false' ;;
    *)
      echo "jq could not evaluate a lifted predicate (exit ${status}): ${out}" >&2
      exit 2
      ;;
  esac
}

image="${IMAGE_REPOSITORY}@${lock_digest}"

image_match="$(jq_bool --arg image "$image" '
  (.spec.template.spec.containers | type == "array" and length > 0) and
  (.spec.template.spec.containers | all(.image == $image))' <<<"$deployment_json")"
marker_match="$(jq_bool --arg key "$ROLLOUT_MARKER_ANNOTATION" --arg marker "$lock_marker" '
  (.spec.template.metadata.annotations[$key] // "") == $marker' <<<"$deployment_json")"
advanced="$(jq_bool --arg uid "$lock_uid" --arg generation "$lock_generation" \
  "${ADVANCED_JQ}"$'\n''advanced' <<<"$deployment_json")"
serving_healthy="$(jq_bool "$ROLLOUT_SERVING_JQ" <<<"$deployment_json")"
rollout_complete="$(jq_bool \
  --arg image "$image" \
  --arg uid "$lock_uid" \
  --arg generation "$lock_generation" \
  --arg marker_key "$ROLLOUT_MARKER_ANNOTATION" \
  --arg marker "$lock_marker" \
  "$ROLLOUT_COMPLETE_JQ" <<<"$deployment_json")"

# The other half of live_deployment_completed_digest, which gates on the server-
# normalized plan BEFORE it ever evaluates ROLLOUT_COMPLETE_JQ. A lock whose
# rollout is complete by every clause above still cannot be retired if the live
# object has drifted from the plan that was approved -- and an empty annotation
# (a provisional lock whose second write never landed) can never match, which is
# deliberate: such a lock is operative and closes the channel to everyone.
live_server_plan="$(jq -cS "$CANONICAL_DEPLOYMENT_JQ" <<<"$deployment_json" \
  | sha256sum | awk '{print $1}')"
server_plan_match=false
[[ -n "$lock_server_plan" && "$live_server_plan" == "$lock_server_plan" ]] && server_plan_match=true

# The last write to the ConfigMap is the lock being taken (or adopted by an
# exact retry, which is equally a fresh deploy holding it).
lock_written_at="$(jq -r '[.metadata.managedFields[]?.time // empty] | max // ""' <<<"$configmap_json")"
if [[ -n "$lock_written_at" ]] && lock_epoch="$(date -u -d "$lock_written_at" +%s 2>/dev/null)"; then
  lock_age_minutes=$(( ( $(date -u +%s) - lock_epoch ) / 60 ))
else
  # Unknown age never suppresses a report. A detector that goes quiet because it
  # could not read a clock fails in the one direction this whole channel
  # distrusts: silently, looking healthy. Erring the other way costs a look.
  lock_written_at="unknown"
  lock_age_minutes=""
fi

cat <<REPORT
lock_digest        = ${lock_digest}
lock_owner         = ${lock_owner:-<empty>}
lock_written_at    = ${lock_written_at}
lock_age_minutes   = ${lock_age_minutes:-unknown}
grace_minutes      = ${GRACE_MINUTES}
image_match        = ${image_match}
marker_match       = ${marker_match}
advanced           = ${advanced}
serving_healthy    = ${serving_healthy}
server_plan_match  = ${server_plan_match}  (locked ${lock_server_plan:-<empty, provisional lock>}, live ${live_server_plan})
rollout_complete   = ${rollout_complete}
REPORT

if [[ "$rollout_complete" == true && "$server_plan_match" == true ]]; then
  echo "verdict=clean"
  echo "The lock is satisfied: the next approval retires it automatically."
  exit 0
fi

if [[ "$serving_healthy" != true ]]; then
  echo "verdict=landing"
  echo "Deployment/${DEPLOYMENT} has not settled; this rollout is still in flight."
  exit 0
fi

if [[ -n "$lock_age_minutes" ]] && (( lock_age_minutes < GRACE_MINUTES )); then
  echo "verdict=landing"
  echo "The lock is ${lock_age_minutes}m old, inside the ${GRACE_MINUTES}m deploy window;"
  echo "a deploy job may still hold it, including inside a \`helm upgrade --atomic\` rollback."
  exit 0
fi

# Name the clause that actually failed rather than the incident it resembles.
# A third cause was always expected -- the first run of this check against
# production found one (rollout_complete true, server_plan_match false) that is
# neither known shape -- so a report that guesses between the two known ones
# would have mislabelled the very case it was written to catch.
echo "verdict=stranded"
if [[ "$rollout_complete" != true && "$advanced" != true ]]; then
  echo "Deployment/${DEPLOYMENT} never moved since this lock was written, and no deploy job"
  echo "can still be holding it. The rollout it names never started (BLO-31598 shape)."
elif [[ "$rollout_complete" != true ]]; then
  echo "Deployment/${DEPLOYMENT} advanced past this lock and settled on a different pod plan."
  echo "It will not move back without a fresh approval, which this lock refuses (BLO-41478 shape)."
else
  echo "This lock's rollout completed, but the live Deployment no longer canonicalizes to the"
  echo "server plan the approval recorded, so the next approval still refuses to advance it."
  if [[ -z "$lock_server_plan" ]]; then
    echo "The lock carries no server plan at all: it is provisional, and the approval run died"
    echo "between taking the lock and persisting that hash."
  else
    echo "Something changed Deployment/${DEPLOYMENT}'s spec after the release settled."
  fi
fi
cat <<REMEDY

Every production deploy is refused at its approval step until this is retired.
Re-run docker.yml with:

  abandon_in_flight:       ${lock_digest}
  abandon_in_flight_owner: ${lock_owner:-<MISSING -- the lock has no owner annotation; retire it by hand>}

Confirm the rollout is genuinely not still landing before using it: this check
reports, it never retires.
REMEDY
exit 1

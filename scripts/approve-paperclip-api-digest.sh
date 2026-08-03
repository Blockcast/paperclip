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
# The window is a ring of at most MAX_APPROVED_DIGESTS entries, newest first:
# the digest being released plus the most recently approved ones. That keeps an
# immediate rollback available without accepting every historical digest. Rolling
# back past the window is deliberately an explicit act — re-run this script
# naming that digest.
#
# An approval holds an in-flight lock until its rollout actually lands, so two
# releases cannot rotate the ring underneath each other. If a release fails and
# will never complete, retire its lock explicitly:
#
#   PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=sha256:<the stuck digest> \
#     PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=<the stuck 64-hex owner> \
#     PAPERCLIP_DEPLOY_KUBECONFIG=... scripts/approve-paperclip-api-digest.sh ...
#
# The script retires its own lock automatically when it aborts after taking it,
# so an inadmissible plan does not wedge the channel on its own.

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
  for attempt in 1 2 3; do
    json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json 2>/dev/null)" || return 1
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
    if jq \
        --arg digest_key "$LOCK_DIGEST_ANNOTATION" \
        --arg plan_key "$LOCK_PLAN_ANNOTATION" \
        --arg uid_key "$LOCK_UID_ANNOTATION" \
        --arg generation_key "$LOCK_GENERATION_ANNOTATION" \
        --arg marker_key "$LOCK_MARKER_ANNOTATION" \
        --arg server_plan_key "$LOCK_SERVER_PLAN_ANNOTATION" \
        --arg owner_key "$LOCK_OWNER_ANNOTATION" '
          del(.metadata.annotations[$digest_key])
          | del(.metadata.annotations[$plan_key])
          | del(.metadata.annotations[$uid_key])
          | del(.metadata.annotations[$generation_key])
          | del(.metadata.annotations[$marker_key])
          | del(.metadata.annotations[$server_plan_key])
          | del(.metadata.annotations[$owner_key])
        ' <<<"$json" \
        | kubectl replace -f - >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
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

MAX_ROTATE_ATTEMPTS="${PAPERCLIP_APPROVAL_ROTATE_ATTEMPTS:-5}"
replace_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-err.XXXXXX")"
nonce_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-nonce.XXXXXX")"
server_plan_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-server-plan.XXXXXX")"
lock_cleanup_armed=""
lock_preserve_on_failure=""

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
      echo "WARNING: could not retire the in-flight lock on ${DIGEST}." >&2
      echo "The next approval will refuse until it is retired with" >&2
      echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=${DIGEST} and the current" >&2
      echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER value." >&2
    fi
  fi
  rm -f "$replace_err" "$nonce_err" "$server_plan_err"
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

  # Keep only well-formed digests, drop the one being approved wherever it already
  # sits, then prepend it. Anything malformed already in the list is discarded here
  # rather than carried forward — the policy would ignore it anyway, and leaving it
  # in place would consume a slot in the window.
  mapfile -t existing < <(
    printf '%s\n' "$current_raw" \
      | sed $'s/^\r*//; s/\r*$//' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
      | grep -E '^sha256:[0-9a-f]{64}$' \
      | grep -Fxv "$DIGEST" \
      || true
  )

  approved=("$DIGEST")
  for entry in "${existing[@]:-}"; do
    [[ -n "$entry" ]] || continue
    (( ${#approved[@]} < MAX_APPROVED_DIGESTS )) || break
    approved+=("$entry")
  done

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
  else
    lock_cleanup_armed=yes
    lock_preserve_on_failure=""
  fi
  if printf '%s\n' "$replacement_json" \
      | kubectl replace -f - >/dev/null 2>"$replace_err"; then
    rotated=yes
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
  echo "approval ring changed underneath us; retrying (${attempt}/${MAX_ROTATE_ATTEMPTS})" >&2
  sleep $(( attempt ))
done

if [[ -z "$rotated" ]]; then
  echo "could not rotate ${NAMESPACE}/${CONFIGMAP} after ${MAX_ROTATE_ATTEMPTS} attempts;" >&2
  echo "another release is approving concurrently — serialize the release path" >&2
  exit 1
fi

echo "Approving ${DIGEST} for harbor.blockcast.net/paperclip/paperclip"
echo "Approval window (newest first, max ${MAX_APPROVED_DIGESTS}):"
printf '  - %s\n' "${approved[@]}"

# Read back rather than trusting the replace exit code. The digest and its
# transaction lock must be one observed resource version before any probe.
verify_json="$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" -o json)"
verify_raw="$(jq -r --arg key "$DATA_KEY" '.data[$key] // ""' <<<"$verify_json")"
verify_count=$(printf '%s\n' "$verify_raw" \
  | sed $'s/^\r*//; s/\r*$//' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -Ec '^sha256:[0-9a-f]{64}$' || true)

if ! printf '%s\n' "$verify_raw" \
  | sed $'s/^\r*//; s/\r*$//' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -Fxq "$DIGEST"; then
  echo "approval did not persist: ${DIGEST} is absent from ${NAMESPACE}/${CONFIGMAP}" >&2
  exit 1
fi

if (( verify_count > MAX_APPROVED_DIGESTS )); then
  echo "approval window is ${verify_count} entries, over the ${MAX_APPROVED_DIGESTS} the policy accepts;" >&2
  echo "the admission policy will now deny every rollout until this is trimmed" >&2
  exit 1
fi

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
server_plan_ready=""
server_plan_json=""
for attempt in $(seq 1 "${PAPERCLIP_APPROVAL_PROBE_ATTEMPTS:-30}"); do
  server_plan_candidate="$planned_json"
  server_plan_verb=create
  if live_server_plan_json="$("${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" \
      get deployment "$DEPLOYMENT" -o json 2>"$server_plan_err")"; then
    if ! live_resource_version="$(jq -er \
        '.metadata.resourceVersion | select(type == "string" and length > 0)' \
        <<<"$live_server_plan_json")"; then
      echo "live Deployment/${DEPLOYMENT} has no resourceVersion" >"$server_plan_err"
      sleep "$(( attempt < 5 ? 1 : 2 ))"
      continue
    fi
    server_plan_candidate="$(jq \
      --arg resource_version "$live_resource_version" '
        del(.metadata.managedFields, .metadata.uid, .metadata.creationTimestamp,
            .metadata.generation, .status) |
        .metadata.resourceVersion = $resource_version
      ' <<<"$planned_json")"
    server_plan_verb=replace
  elif ! grep -qiE 'not[[:space:]]+found|notfound' "$server_plan_err"; then
    sleep "$(( attempt < 5 ? 1 : 2 ))"
    continue
  fi

  if server_plan_json="$(printf '%s\n' "$server_plan_candidate" \
      | "${deploy_kubectl[@]}" -n "$DEPLOY_NAMESPACE" "$server_plan_verb" \
          --dry-run=server -o json -f - 2>"$server_plan_err")"; then
    server_plan_ready=yes
    break
  fi
  sleep "$(( attempt < 5 ? 1 : 2 ))"
done
if [[ -z "$server_plan_ready" ]]; then
  echo "planned Deployment never became admissible for ${DIGEST}:" >&2
  cat "$server_plan_err" >&2
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

# From here on, success intentionally leaves the rollout lock active for the
# next release to retire after observing this exact plan marker live.
lock_cleanup_armed=""

# A release workflow that sets this receives the exact server-normalized object
# whose canonical hash was persisted in the lock. Applying this object directly
# prevents a package manager's three-way merge from preserving live-only drift
# and producing a Deployment that can never satisfy lock completion.
if [[ -n "${PAPERCLIP_APPROVED_SERVER_PLAN_OUT:-}" ]]; then
  (umask 077; printf '%s\n' "$server_plan_json" >"$PAPERCLIP_APPROVED_SERVER_PLAN_OUT")
fi

echo "Approved and admission-ready. ${final_count} digest(s) in the window."
echo "Approval lock remains on ${DIGEST} until Deployment/${DEPLOYMENT} rolls out a"
echo "generation newer than ${observed_generation} on that digest with plan marker ${PLAN_MARKER}."
echo "If this release fails and will not be retried, retire the lock explicitly with"
echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT=${DIGEST} and"
echo "PAPERCLIP_APPROVAL_ABANDON_IN_FLIGHT_OWNER=${LOCK_OWNER_ID} on the next approval."

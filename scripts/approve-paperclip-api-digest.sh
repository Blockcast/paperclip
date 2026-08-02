#!/usr/bin/env bash
# Authorize one immutable Paperclip API image digest at admission time (BLO-19955).
#
# Rotates the bounded approval window in
# ConfigMap/paperclip-api-approved-images (namespace paperclip-release-approvals),
# which ValidatingAdmissionPolicy/paperclip-api-image-approval consumes via
# paramRef. Run this with the paperclip-release-approver credential — NOT the
# Release Engineer's namespace-scoped deploy credential, which by design cannot
# reach this object.
#
# Usage:
#   scripts/approve-paperclip-api-digest.sh sha256:<64 hex>
#
# This is the single implementation of the rotation. The production release
# workflow (.github/workflows/docker.yml, "Approve deploy digest at admission
# time") invokes this file rather than reimplementing the ring inline, so the
# code path exercised by scripts/approve-paperclip-api-digest.test.mjs is the
# code path that ships. The companion admission suite in Blockcast/onprem-k8s
# takes the same file via its APPROVE_SCRIPT override.
#
# The window is a ring of at most MAX_APPROVED_DIGESTS entries, newest first:
# the digest being released plus the most recently approved ones. That keeps an
# immediate rollback available without accepting every historical digest. Rolling
# back past the window is deliberately an explicit act — re-run this script
# naming that digest.
set -euo pipefail

NAMESPACE="${PAPERCLIP_APPROVAL_NAMESPACE:-paperclip-release-approvals}"
CONFIGMAP="${PAPERCLIP_APPROVAL_CONFIGMAP:-paperclip-api-approved-images}"
DATA_KEY="approvedDigests"
# Must stay in lockstep with the `maxApprovedApiDigests` CEL variable in
# onprem-k8s paperclip/paperclip-public-tools.yaml. The policy denies everything
# if the list is longer, so a drift here is a hard outage, not a silent widening.
#
# Deliberately a constant and not an override. This script runs with the
# approver credential, which cannot read the cluster-scoped policy to check
# itself, and the window guard at the bottom of this file compares against this
# same number — so an override raises the bound *and* moves the guard that
# exists to catch exactly that, reporting "Approved. 4 digest(s) in the window."
# while leaving the ring in a state the policy answers by denying every rollout.
# Raising the writer-side bound never widens the policy; it only breaks it.
readonly MAX_APPROVED_DIGESTS=3

if [[ -n "${PAPERCLIP_MAX_APPROVED_DIGESTS:-}" \
      && "$PAPERCLIP_MAX_APPROVED_DIGESTS" != "$MAX_APPROVED_DIGESTS" ]]; then
  echo "refusing to approve: PAPERCLIP_MAX_APPROVED_DIGESTS=${PAPERCLIP_MAX_APPROVED_DIGESTS} disagrees with the" >&2
  echo "${MAX_APPROVED_DIGESTS}-entry window the admission policy enforces. Raising the writer-side bound does not" >&2
  echo "widen the policy; it makes the policy deny every rollout. Change the maxApprovedApiDigests CEL" >&2
  echo "variable in onprem-k8s paperclip/paperclip-public-tools.yaml and this constant together." >&2
  exit 2
fi

usage() {
  echo "usage: $0 sha256:<64 lowercase hex>" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
DIGEST="$1"

if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "refusing to approve '${DIGEST}': not a well-formed lowercase sha256 digest" >&2
  echo "pass the bare digest only — the repository is fixed inside the admission policy" >&2
  exit 2
fi

for dep in kubectl jq; do
  command -v "$dep" >/dev/null 2>&1 || { echo "$dep is required" >&2; exit 2; }
done

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
MAX_ROTATE_ATTEMPTS="${PAPERCLIP_APPROVAL_ROTATE_ATTEMPTS:-5}"
replace_err="$(mktemp "${TMPDIR:-/tmp}/paperclip-approve-err.XXXXXX")"
trap 'rm -f "$replace_err"' EXIT

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

  current_raw="$(jq -r --arg key "$DATA_KEY" '.data[$key] // ""' <<<"$current_json")"

  # Keep only well-formed digests, drop the one being approved wherever it
  # already sits, then collapse any remaining repeats before prepending it.
  #
  # The `awk '!seen[$0]++'` is load-bearing and not merely tidy: without it only
  # duplicates OF THE NEW DIGEST are removed, so a window that already contained
  # a repeat spends a rollback slot on it. Rotating `A,A,B` with `C` would yield
  # `C,A,A` and silently evict B — three entries, two distinct, one usable
  # rollback target instead of two. Anything malformed is discarded here rather
  # than carried forward: the policy would ignore it anyway, and leaving it in
  # place would consume a slot the same way.
  existing=()
  while IFS= read -r entry; do
    existing+=("$entry")
  done < <(
    printf '%s\n' "$current_raw" \
      | tr -d '\r' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
      | grep -E '^sha256:[0-9a-f]{64}$' \
      | grep -Fxv "$DIGEST" \
      | awk '!seen[$0]++' \
      || true
  )

  approved=("$DIGEST")
  for entry in "${existing[@]:-}"; do
    [[ -n "$entry" ]] || continue
    (( ${#approved[@]} < MAX_APPROVED_DIGESTS )) || break
    approved+=("$entry")
  done

  payload=$(printf '%s\n' "${approved[@]}")

  # resourceVersion rides along inside current_json, so this write is rejected if
  # anyone else rotated the ring since the read above.
  if jq --arg key "$DATA_KEY" --arg value "$payload" '.data[$key] = $value' <<<"$current_json" \
      | kubectl replace -f - >/dev/null 2>"$replace_err"; then
    rotated=yes
    break
  fi

  if ! grep -qiE 'conflict|modified|latest version' "$replace_err"; then
    echo "failed to rotate ${NAMESPACE}/${CONFIGMAP}:" >&2
    cat "$replace_err" >&2
    exit 1
  fi
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

# Read back rather than trusting the write's exit code. A 200 that did not
# persist the digest would let `helm upgrade` run straight into an admission
# denial with a confusing error, so verify the approval actually landed.
verify_raw=$(kubectl -n "$NAMESPACE" get configmap "$CONFIGMAP" \
  -o jsonpath="{.data.${DATA_KEY}}")
verify_count=$(printf '%s\n' "$verify_raw" | tr -d '\r' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | grep -Ec '^sha256:[0-9a-f]{64}$' || true)

if ! printf '%s\n' "$verify_raw" | tr -d '\r' \
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

echo "Approved. ${verify_count} digest(s) in the window."

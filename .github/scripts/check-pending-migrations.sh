#!/usr/bin/env bash
# Read-only deploy gate: refuse to start a rollout whose pending migrations
# need an index precreated online.
#
# Runs the check inside the cluster using the CANDIDATE image, not the running
# one. The pending set is (migrations shipped in the new image) minus (already
# applied), so asking the currently-running pod would compute the wrong answer
# and pass a deploy that is about to stall.
#
# Failure mode this replaces: the guarded migration raises during worker
# startup, the pod crashloops, `helm upgrade --wait` reports nothing for 30
# minutes and then `context deadline exceeded`, and `--atomic` spends a second
# timeout failing to roll back a pod that cannot be evicted while crashlooping.
set -euo pipefail

: "${DIGEST:?DIGEST (sha256:...) is required}"
: "${NS:?NS is required}"
IMAGE_REPO="${IMAGE_REPO:-harbor.blockcast.net/paperclip/paperclip}"
DB_SECRET_NAME="${DB_SECRET_NAME:-paperclip-database-url}"
DB_SECRET_KEY="${DB_SECRET_KEY:-url}"
# Bounded so a hung check fails the deploy quickly instead of reproducing the
# open-ended wait it exists to prevent. Two separate budgets, because the two
# phases fail for unrelated reasons and a single budget silently charges one
# for the other: BLO-31254 measured a cold pull of the ~1.7 GB image at 3m3s
# against a single 180s budget, so the container started ~3s past the deadline
# and was killed before emitting anything. The gate read INCONCLUSIVE on a
# perfectly good build, and only passed on retry because the first attempt had
# warmed the node cache -- meaning the first deploy of any freshly built image,
# the case that always pulls cold, was a coin flip.
#
# TIMEOUT_SECONDS bounds the check itself and is only armed once the container
# is running, which is what it was always sized for.
TIMEOUT_SECONDS="${PREFLIGHT_TIMEOUT_SECONDS:-180}"
# STARTUP_TIMEOUT_SECONDS bounds scheduling plus image transfer. Sized at ~3x
# the measured cold pull so registry throughput cannot fail a good build,
# while still bounding an unschedulable pod or an undownloadable digest.
STARTUP_TIMEOUT_SECONDS="${PREFLIGHT_STARTUP_TIMEOUT_SECONDS:-600}"
# How often phase 1 re-observes the pod. Injectable only so the behavioural
# tests can drive real waits without spending real minutes; nothing in CI or the
# deploy job sets it.
POLL_SECONDS="${PREFLIGHT_POLL_SECONDS:-5}"

[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "DIGEST is not a sha256 digest: ${DIGEST}" >&2; exit 1; }

JOB_NAME="paperclip-migration-preflight-$(date +%s)-${RANDOM}"
cleanup() { kubectl -n "${NS}" delete job "${JOB_NAME}" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "pending-migration pre-flight: running ${IMAGE_REPO}@${DIGEST} as job/${JOB_NAME} in ${NS}"

kubectl -n "${NS}" apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  labels:
    app.kubernetes.io/name: paperclip
    paperclip.dev/purpose: migration-preflight
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: paperclip
        paperclip.dev/purpose: migration-preflight
    spec:
      restartPolicy: Never
      containers:
        - name: preflight
          image: ${IMAGE_REPO}@${DIGEST}
          workingDir: /app
          command: ["node_modules/.bin/tsx", "packages/db/src/pending-migration-preflight-cli.ts"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${DB_SECRET_NAME}
                  key: ${DB_SECRET_KEY}
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
YAML

# Phase 1: wait for the container to actually start. The migration budget must
# not be spent on image transfer, so nothing is charged to TIMEOUT_SECONDS
# until we have seen the pod leave Pending.
pod_name=""
container_started=0
startup_terminal=0
waiting_reason=""
startup_began="$(date +%s)"
startup_deadline=$(( startup_began + STARTUP_TIMEOUT_SECONDS ))
while :; do
  pod_name="$(kubectl -n "${NS}" get pods -l "job-name=${JOB_NAME}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "${pod_name}" ]; then
    # Succeeded and Failed are terminal but still mean the container ran: a
    # fast check can complete between two polls, and treating that as "never
    # started" would discard a conclusive answer.
    case "$(kubectl -n "${NS}" get pod "${pod_name}" -o jsonpath='{.status.phase}' 2>/dev/null || true)" in
      Running|Succeeded|Failed)
        container_started=1
        break
        ;;
    esac
    waiting_reason="$(kubectl -n "${NS}" get pod "${pod_name}" \
      -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)"
    case "${waiting_reason}" in
      # These never self-heal, so riding out the full startup budget only
      # delays a verdict that is already decided. Pull errors are deliberately
      # NOT in this list: ErrImagePull/ImagePullBackOff routinely recover, and
      # failing fast on them would recreate the defect this phase fixes.
      InvalidImageName|CreateContainerConfigError)
        startup_terminal=1
        break
        ;;
    esac
  fi
  if [ "$(date +%s)" -ge "${startup_deadline}" ]; then
    break
  fi
  sleep "${POLL_SECONDS}"
done
startup_seconds=$(( $(date +%s) - startup_began ))

if [ "${container_started}" -ne 1 ]; then
  # The check never ran, so this says nothing about the migrations. Surface the
  # pod events inline: they carry the pull duration and image size that
  # otherwise force the operator to go describe the pod by hand.
  echo "--- pod events ---"
  if [ -n "${pod_name}" ]; then
    kubectl -n "${NS}" get events --field-selector "involvedObject.name=${pod_name}" \
      --sort-by=.lastTimestamp 2>&1 | tail -20 || echo "(no events available)"
  else
    echo "(no pod was created for job/${JOB_NAME})"
  fi
  echo "--- end pod events ---"
  # Bailing early on a terminal error and exhausting the budget are different
  # facts; saying "within Ns of the ${STARTUP_TIMEOUT_SECONDS}s budget" for the
  # former would imply the budget was the constraint when it was not.
  if [ "${startup_terminal}" -eq 1 ]; then
    cause="hit a terminal container error (${waiting_reason}) after ${startup_seconds}s; waiting out the remaining startup budget would not have cleared it"
  else
    cause="never started${waiting_reason:+ (${waiting_reason})} within its ${STARTUP_TIMEOUT_SECONDS}s startup budget"
  fi
  echo "pending-migration pre-flight: INCONCLUSIVE — the pre-flight container ${cause}; the migration check itself never ran. This is broken or slow infrastructure (image pull, scheduling, container config), not a migration verdict. Not starting the rollout blind" >&2
  exit 1
fi

# Phase 2: the container is up, so the migration budget now measures only what
# it was sized for.
set +e
kubectl -n "${NS}" wait --for=condition=complete "job/${JOB_NAME}" --timeout="${TIMEOUT_SECONDS}s" >/dev/null 2>&1
completed=$?
set -e

# Always surface the job's own output: on success it records what was checked,
# and on failure it carries the CREATE INDEX CONCURRENTLY remediation that is
# the whole point of running this.
echo "--- pre-flight output ---"
kubectl -n "${NS}" logs "job/${JOB_NAME}" --tail=200 2>&1 || echo "(no logs available)"
echo "--- end pre-flight output ---"

if [ "${completed}" -eq 0 ]; then
  echo "pending-migration pre-flight: PASSED (container started in ${startup_seconds}s)"
  exit 0
fi

# Distinguish "the check ran and said no" from "the check never ran". Both stop
# the deploy, but they need different operator responses.
if kubectl -n "${NS}" wait --for=condition=failed "job/${JOB_NAME}" --timeout=10s >/dev/null 2>&1; then
  echo "pending-migration pre-flight: FAILED — a pending migration needs its index precreated (see remediation above)" >&2
else
  echo "pending-migration pre-flight: INCONCLUSIVE — the container started after ${startup_seconds}s but the migration check produced no result within its ${TIMEOUT_SECONDS}s run budget. The image pull is NOT implicated; treat this as migrations actually in trouble. Not starting the rollout blind" >&2
fi
exit 1

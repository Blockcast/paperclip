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
# The Job's TTL is counted past this script's last read of it, not from the
# Job finishing, because on a failed Job those are a full run budget apart:
# phase 2's `kubectl wait --for=condition=complete` never sees Complete go true
# on a failed Job, so it returns only when TIMEOUT_SECONDS runs out
# (kubernetes/kubectl#1629; see the stub note in
# scripts/check-pending-migration-preflight-phases.test.js), and only then are
# the logs, status.reason and the `failed` condition read. A fixed TTL races
# those reads as soon as the run budget approaches it, and the loser is a
# genuine FAILED verdict reported as a vanished pod. The 300s beyond the run
# budget covers the POLL_SECONDS gap before phase 2 starts, the 10s `failed`
# wait and kubectl round-trips, however far the run budget is raised.
JOB_TTL_SECONDS=$(( TIMEOUT_SECONDS + 300 ))

[[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "DIGEST is not a sha256 digest: ${DIGEST}" >&2; exit 1; }

JOB_NAME="paperclip-migration-preflight-$(date +%s)-${RANDOM}"
cleanup() { kubectl -n "${NS}" delete job "${JOB_NAME}" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Both non-verdict exits need these: they carry the pull duration, the image
# size and the eviction message that otherwise force the operator to go
# describe a pod the job's TTL is already deleting.
dump_pod_events() {
  echo "--- pod events ---"
  if [ -n "${pod_name:-}" ]; then
    kubectl -n "${NS}" get events --field-selector "involvedObject.name=${pod_name}" \
      --sort-by=.lastTimestamp 2>&1 | tail -20 || echo "(no events available)"
  else
    echo "(no pod was created for job/${JOB_NAME})"
  fi
  echo "--- end pod events ---"
}

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
  ttlSecondsAfterFinished: ${JOB_TTL_SECONDS}
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
# until the kubelet has stamped a start time on the container.
pod_name=""
container_started=0
startup_terminal_cause=""
waiting_reason=""
startup_began="$(date +%s)"
startup_deadline=$(( startup_began + STARTUP_TIMEOUT_SECONDS ))
while :; do
  pod_name="$(kubectl -n "${NS}" get pods -l "job-name=${JOB_NAME}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "${pod_name}" ]; then
    # The container ran iff the kubelet stamped a start time on it. Pod phase is
    # NOT that fact: a pod can reach Failed straight from Pending (eviction under
    # node pressure, preemption) having never started a container, and reading
    # that as "started" hands phase 2 a job it reports as "a pending migration
    # needs its index precreated" -- a migration verdict from a check that never
    # ran, which is the most misleading output available here.
    # terminated.startedAt is what covers the fast-check-between-polls race:
    # backoffLimit is 0, so a job that finished already still has a real answer
    # and treating it as "never started" would discard one.
    if [ -n "$(kubectl -n "${NS}" get pod "${pod_name}" \
      -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}{.status.containerStatuses[0].state.terminated.startedAt}' \
      2>/dev/null || true)" ]; then
      container_started=1
      break
    fi
    waiting_reason="$(kubectl -n "${NS}" get pod "${pod_name}" \
      -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}' 2>/dev/null || true)"
    case "${waiting_reason}" in
      # These never self-heal, so riding out the full startup budget only
      # delays a verdict that is already decided. Pull errors are deliberately
      # NOT in this list: ErrImagePull/ImagePullBackOff routinely recover, and
      # failing fast on them would recreate the defect this phase fixes.
      InvalidImageName|CreateContainerConfigError)
        startup_terminal_cause="hit a terminal container error (${waiting_reason})"
        break
        ;;
    esac
    # A terminal phase with no start stamp means the pod died before the
    # container ran. backoffLimit is 0, so nothing will replace it and the rest
    # of the startup budget cannot change the answer.
    case "$(kubectl -n "${NS}" get pod "${pod_name}" -o jsonpath='{.status.phase}' 2>/dev/null || true)" in
      Succeeded|Failed)
        startup_terminal_cause="reached terminal pod phase without ever starting its container (evicted or preempted before the image ran)"
        break
        ;;
    esac
  fi
  if [ "$(date +%s)" -ge "${startup_deadline}" ]; then
    break
  fi
  sleep "${POLL_SECONDS}"
done
# Quantized to POLL_SECONDS plus up to three kubectl round-trips, so it
# over-reports: read and report it as an upper bound, never as a measurement to
# size the next budget from.
startup_seconds=$(( $(date +%s) - startup_began ))

if [ "${container_started}" -ne 1 ]; then
  # The check never ran, so this says nothing about the migrations. Surface the
  # pod events inline.
  dump_pod_events
  # Bailing early on a decided error and exhausting the budget are different
  # facts; saying "within Ns of the ${STARTUP_TIMEOUT_SECONDS}s budget" for the
  # former would imply the budget was the constraint when it was not.
  if [ -n "${startup_terminal_cause}" ]; then
    cause="${startup_terminal_cause} within ${startup_seconds}s; waiting out the remaining startup budget would not have cleared it"
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
  echo "pending-migration pre-flight: PASSED (container started within ${startup_seconds}s)"
  exit 0
fi

# Distinguish "the check ran and said no" from "the check never ran". Both stop
# the deploy, but they need different operator responses.
#
# An eviction is checked FIRST because it satisfies the `failed` condition
# without ever producing a verdict: the kubelet stamps status.reason=Evicted,
# backoffLimit is 0 so nothing replaces the pod, and the Job trips `failed` via
# BackoffLimitExceeded. Phase 1's start-stamp guard does not catch this one --
# it covers a pod that dies *before* its container runs, and an eviction whose
# kill lands just after the pull can stamp a real startedAt on a container that
# lived about a second. Measured on the 2026-09-27T01:58Z production deploy
# (run 36279683355): the preflight pod was evicted three times for
# ephemeral-storage on k8s-data-6, logs read "(no logs available)", and the
# gate still printed the migration verdict below -- sending the one human
# approval in four days of ProductionDeployApprovalStuck off to look for an
# index that does not exist.
#
# The same holds for every other disruption, and for a pod that no longer
# exists at all. So the test is inverted rather than listed: status.reason is
# pod-level, and a container that exits non-zero leaves it unset, so an EMPTY
# reason on a pod that still exists is the one shape that is a migration
# verdict. Any other reason (Evicted, Preempting, NodeLost stamped by the node
# lifecycle controller before pod GC removes the pod, DeadlineExceeded, and
# whatever upstream adds next) is disruption. An API-initiated eviction (drain,
# autoscaler, descheduler) deletes the pod instead, so the read fails; that is
# kept distinct from an empty reason. A gone pod's logs are gone too, so there is no
# remediation to point at either way. The Job's own TTL cannot be what removed
# a pod that finished normally: this read lands up to a full run budget after
# the Job finished, and JOB_TTL_SECONDS is counted past that.
pod_reason="$(kubectl -n "${NS}" get pod "${pod_name}" -o jsonpath='{.status.reason}' 2>/dev/null)" || pod_reason="__gone__"
case "${pod_reason}" in
  "")
    : ;;
  __gone__)
    dump_pod_events
    echo "pending-migration pre-flight: INCONCLUSIVE: the pre-flight pod no longer exists (deleted by an API eviction, preemption, node shutdown or pod GC), so the migration check never reached a verdict. Re-run the deploy rather than precreating an index. Not starting the rollout blind" >&2
    exit 1 ;;
  *)
    dump_pod_events
    echo "pending-migration pre-flight: INCONCLUSIVE: the pre-flight pod was stopped by the cluster (status.reason=${pod_reason}) after its container started, so the migration check never reached a verdict. This is node disruption, not a migration verdict; re-run the deploy rather than precreating an index. Not starting the rollout blind" >&2
    exit 1 ;;
esac
if kubectl -n "${NS}" wait --for=condition=failed "job/${JOB_NAME}" --timeout=10s >/dev/null 2>&1; then
  echo "pending-migration pre-flight: FAILED — a pending migration needs its index precreated (see remediation above)" >&2
else
  echo "pending-migration pre-flight: INCONCLUSIVE — the container started within ${startup_seconds}s but the migration check produced no result within its ${TIMEOUT_SECONDS}s run budget. The image pull is NOT implicated; treat this as migrations actually in trouble. Not starting the rollout blind" >&2
fi
exit 1

#!/usr/bin/env bash
# ADVISORY deploy step: build the online indexes that pending migrations
# require, before the read-only pre-flight gate decides whether to roll.
#
# Why this exists. `check-pending-migrations.sh` detects that a pending
# migration needs an index precreated and stops the deploy with the exact
# `CREATE INDEX CONCURRENTLY` statement to run. For most of that family the
# repository ALREADY ships the code to run it -- the migration runner calls
# `ensureConcurrentIndexesForMigration` per file, outside the transaction,
# immediately before applying it (packages/db/src/client.ts), and
# `pnpm db:migrate` calls `ensureOnlineIndexPrerequisites` up front
# (packages/db/src/migrate.ts). The deploy pipeline was the only path that
# never wired it up, so the gate handed a production DDL to a human instead.
# PEN-4176 measured that cost: ~25 h of silent deploy freeze, 54 commits.
#
# This step closes that gap by running the CLI whose own doc comment names
# this use ("before `db:migrate` runs in a deploy pipeline that wants the two
# as separately observable steps"). It covers exactly the migrations in
# `PENDING_CONCURRENT_INDEXES`; the six pre-flight-only migrations have no
# runner path and still need the human remediation the gate prints.
#
# Runs the CANDIDATE image, like the gate, so the pending set is the one about
# to be applied rather than the one already running.
#
# ADVISORY, and that is load-bearing: this script ALWAYS exits 0. The
# pre-flight behind it stays the decider. Precreation can move a blocker from
# "absent" to "built" but can never introduce a stop of its own, which is what
# makes it landable on the production deploy path. Every failure here leaves
# the deploy exactly as it was before this step existed.
set -uo pipefail

: "${DIGEST:?DIGEST (sha256:...) is required}"
: "${NS:?NS is required}"
IMAGE_REPO="${IMAGE_REPO:-harbor.blockcast.net/paperclip/paperclip}"
DB_SECRET_NAME="${DB_SECRET_NAME:-paperclip-database-url}"
DB_SECRET_KEY="${DB_SECRET_KEY:-url}"

# Startup budget: scheduling plus image transfer, same shape and same reason as
# the gate's (BLO-31254 measured a ~1.7 GB cold pull at 3m3s, so a single short
# budget failed good builds). Same image, same node pool, same number.
STARTUP_TIMEOUT_SECONDS="${PRECREATE_STARTUP_TIMEOUT_SECONDS:-600}"
# Run budget. ⚠️ DERIVED FROM THE GUARD'S OWN TIMEOUTS -- do not lower it to buy
# margin elsewhere. An interrupted `CREATE INDEX CONCURRENTLY` leaves an
# INVALID index, and the pre-flight's remediation for that is strictly worse
# than for an absent one ("drop it first"). So this budget must EXCEED the
# guard's worst case rather than clip it:
#
#   DEFAULT_LOCK_WAIT_TIMEOUT_MS   paid once (shortened below)        2 min
#   DEFAULT_DDL_LOCK_TIMEOUT_MS    per spec                          2 min
#   DEFAULT_STATEMENT_TIMEOUT_MS   per spec, the build itself       10 min
#
# Sized for three pending specs: 2 + 3*(2+10) = 38 min. Three is a ceiling, not
# an expectation -- this family lands one migration at a time, and the common
# case ("No pending migration requires online index precreation") exits in
# seconds. If this ever needs to shrink, cut the SPEC COUNT it is sized for and
# say so here; never cut the statement timeout.
TIMEOUT_SECONDS="${PRECREATE_TIMEOUT_SECONDS:-2280}"
# Only the serializing advisory lock wait is safe to shorten: it elapses BEFORE
# any DDL begins, so giving up on it cannot leave anything half-built. On
# contention this step gives up, says so, and the gate decides -- which is
# precisely today's behaviour, so the downside is bounded at "no worse".
LOCK_WAIT_TIMEOUT_MS="${PRECREATE_LOCK_WAIT_TIMEOUT_MS:-120000}"
POLL_SECONDS="${PRECREATE_POLL_SECONDS:-5}"
JOB_TTL_SECONDS=$(( TIMEOUT_SECONDS + 300 ))

if ! [[ "${DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "online-index precreation: SKIPPED — DIGEST is not a sha256 digest (${DIGEST}); leaving the pre-flight to decide" >&2
  exit 0
fi

JOB_NAME="paperclip-precreate-indexes-$(date +%s)-${RANDOM}"

# Deliberately NOT a blanket EXIT trap. Deleting this Job while a
# `CREATE INDEX CONCURRENTLY` is still running kills the build mid-flight and
# leaves an INVALID index -- converting the cheap "absent" remediation into the
# expensive "drop it first" one. The Job is therefore only deleted once it has
# reached a terminal state; a build still in progress is left alone to finish,
# and the pre-flight will correctly refuse to roll over an incomplete index.
delete_job_if_terminal() {
  local phase
  phase="$(kubectl -n "${NS}" get pods -l "job-name=${JOB_NAME}" \
    -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)"
  case "${phase}" in
    Succeeded|Failed)
      kubectl -n "${NS}" delete job "${JOB_NAME}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
      ;;
    *)
      echo "online-index precreation: leaving job/${JOB_NAME} in place (pod phase '${phase:-unknown}') — deleting it now could abort an in-flight index build and leave it INVALID. Its ttlSecondsAfterFinished (${JOB_TTL_SECONDS}s) collects it once it finishes."
      ;;
  esac
}

echo "online-index precreation: running ${IMAGE_REPO}@${DIGEST} as job/${JOB_NAME} in ${NS}"

if ! kubectl -n "${NS}" apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  labels:
    app.kubernetes.io/name: paperclip
    paperclip.dev/purpose: online-index-precreation
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: ${JOB_TTL_SECONDS}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: paperclip
        paperclip.dev/purpose: online-index-precreation
    spec:
      restartPolicy: Never
      # Every schedulable node is tainted; tolerate the pool the API itself runs
      # on, exactly as the pre-flight Job does. A pod tolerating neither pool
      # never schedules and this step would burn its whole startup budget.
      tolerations:
        - key: dedicated
          operator: Equal
          value: paperclip
          effect: NoSchedule
      containers:
        - name: precreate
          image: ${IMAGE_REPO}@${DIGEST}
          workingDir: /app
          command: ["node_modules/.bin/tsx", "packages/db/src/precreate-online-indexes-cli.ts"]
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: ${DB_SECRET_NAME}
                  key: ${DB_SECRET_KEY}
            - name: PAPERCLIP_PRECREATE_LOCK_WAIT_TIMEOUT_MS
              value: "${LOCK_WAIT_TIMEOUT_MS}"
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
YAML
then
  echo "online-index precreation: SKIPPED — could not create job/${JOB_NAME}; leaving the pre-flight to decide" >&2
  exit 0
fi

# Phase 1: wait for the container to actually start, so the run budget measures
# the index build and not the image transfer. Mirrors the gate's phase 1, minus
# its verdict taxonomy: every outcome here is advisory, so the only thing that
# changes between causes is what gets printed.
pod_name=""
container_started=0
startup_deadline=$(( $(date +%s) + STARTUP_TIMEOUT_SECONDS ))
while :; do
  pod_name="$(kubectl -n "${NS}" get pods -l "job-name=${JOB_NAME}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "${pod_name}" ]; then
    # terminated.startedAt matters as much as running.startedAt: with
    # backoffLimit 0 a job that already finished between polls still holds a
    # real answer, and reading it as "never started" would discard one.
    if [ -n "$(kubectl -n "${NS}" get pod "${pod_name}" \
      -o jsonpath='{.status.containerStatuses[0].state.running.startedAt}{.status.containerStatuses[0].state.terminated.startedAt}' \
      2>/dev/null || true)" ]; then
      container_started=1
      break
    fi
  fi
  if [ "$(date +%s)" -ge "${startup_deadline}" ]; then
    break
  fi
  sleep "${POLL_SECONDS}"
done

if [ "${container_started}" -ne 1 ]; then
  echo "online-index precreation: SKIPPED — the container never started within its ${STARTUP_TIMEOUT_SECONDS}s startup budget. No index was built and nothing was changed; the pre-flight decides." >&2
  delete_job_if_terminal
  exit 0
fi

# Phase 2: the build itself.
kubectl -n "${NS}" wait --for=condition=complete "job/${JOB_NAME}" --timeout="${TIMEOUT_SECONDS}s" >/dev/null 2>&1
completed=$?

echo "--- precreation output ---"
kubectl -n "${NS}" logs "job/${JOB_NAME}" --tail=200 2>&1 || echo "(no logs available)"
echo "--- end precreation output ---"

if [ "${completed}" -eq 0 ]; then
  echo "online-index precreation: done — every pending migration's online index is built. The pre-flight below verifies it."
else
  # `kubectl wait --for=condition=complete` also returns non-zero on a FAILED
  # job (kubernetes/kubectl#1629 — Complete never goes true), so this covers
  # both "still building" and "failed". Neither is this step's to adjudicate.
  echo "online-index precreation: INCOMPLETE — job/${JOB_NAME} did not report complete within ${TIMEOUT_SECONDS}s (still building, or failed; see output above). Nothing is broken by this: the pre-flight below reports the real index state and stops the deploy if an index is absent or half-built." >&2
fi

delete_job_if_terminal
exit 0

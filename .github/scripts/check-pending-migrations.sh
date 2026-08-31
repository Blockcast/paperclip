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
# open-ended wait it exists to prevent.
TIMEOUT_SECONDS="${PREFLIGHT_TIMEOUT_SECONDS:-180}"

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
  echo "pending-migration pre-flight: PASSED"
  exit 0
fi

# Distinguish "the check ran and said no" from "the check never ran". Both stop
# the deploy, but they need different operator responses.
if kubectl -n "${NS}" wait --for=condition=failed "job/${JOB_NAME}" --timeout=10s >/dev/null 2>&1; then
  echo "pending-migration pre-flight: FAILED — a pending migration needs its index precreated (see remediation above)" >&2
else
  echo "pending-migration pre-flight: INCONCLUSIVE — job did not finish within ${TIMEOUT_SECONDS}s; not starting the rollout blind" >&2
fi
exit 1

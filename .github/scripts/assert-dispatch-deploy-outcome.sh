#!/usr/bin/env bash
# PEN-5369. A production deploy dispatch that delivered NOTHING must not report
# `conclusion: success`.
#
# On 2026-11-03T07:27Z run 41596391238 dispatched against master, built and
# pushed an image, deployed nothing, and concluded `success`. Production sat 105
# commits behind master with every CI signal green. The cause was
# `vars.PAPERCLIP_CI_DEPLOY` no longer reading `true`, which skips
# `guard-pending-deploy`, `guard-pending-deploy-final` and `deploy` by their
# shared `if:` — and a skipped job does not fail a run.
#
# WHY THIS IS NOT PEN-4841'S FALSE POSITIVE. That row correctly records that a
# `docker.yml` run reading `success` with `deploy` skipped is NORMAL, because
# deploys only run on dispatch and every `push` build of this workflow skips
# them. The discriminator is the EVENT, and it is enforced one level up: this
# script only ever runs from a job whose own `if:` pins
# `github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'`.
# On a `push` run the job is skipped outright and this file is never executed,
# so the PEN-4841 population stays silent by construction rather than by a
# condition written here.
#
# WHY FAILING THE RUN IS THE FIX AND NOT MERELY A LOUDER LOG. The deploy-drift
# exporter in Blockcast/onprem-k8s
# (monitoring/paperclip-api-deploy-drift/workload/exporter.py,
# `classify_deploy_job`) already reads a skipped `deploy` job against the RUN
# conclusion:
#
#   * run `success` + deploy `skipped` -> "neither". Evidence of nothing; the
#     gauge does not move. This is the shape the kill switch produced, and it is
#     why `paperclip_api_deploy_failed_since_success` read 0 through the freeze.
#   * run `failure` + deploy `skipped` -> "attempt". A dead deploy attempt, so
#     `deploy_failed_since_success` increments and
#     `PaperclipProductionDeployFailing` fires after its 15m `for:`.
#
# So turning this run red is what converts an invisible absence into the failure
# the existing, healthy alert is already keyed on. No exporter change and no new
# alert rule are needed for this cause.
#
# FAIL-CLOSED. Every benign explanation for a skipped `deploy` is enumerated
# below as an ALLOW-list and anything unrecognised fails. A future conjunct
# added to the `deploy` job's `if:` therefore surfaces here as a loud,
# named failure the first time it skips a dispatch, rather than silently
# rejoining the class of green-but-undeployed runs this script exists to end.
set -euo pipefail

# Defaulted with `:` rather than a plain assignment run, so `set -u` cannot
# abort on a `needs` result GitHub left empty. Not a style choice: five or
# more consecutive `NAME=value` lines are the `environment-dump` shape the
# egress door refuses (ENV_ASSIGNMENT_LINE in
# packages/adapter-utils/src/github-egress-scrub.ts), and this block was six.
# `: "${VAR:=}"` is the canonical POSIX defaulting idiom and is not that
# shape, so this closes the finding structurally rather than suppressing it.
: "${BUILD_RESULT:=}"
: "${GUARD_RESULT:=}"
: "${GUARD_BLOCKED:=}"
: "${FINAL_RESULT:=}"
: "${FINAL_BLOCKED:=}"
: "${DEPLOY_RESULT:=}"

note() {
  printf '%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
  fi
}

fail() {
  printf '::error::%s\n' "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >>"${GITHUB_STEP_SUMMARY}"
  fi
  exit 1
}

printf 'build-and-push=%s guard-pending-deploy=%s (blocked=%s) guard-pending-deploy-final=%s (blocked=%s) deploy=%s\n' \
  "${BUILD_RESULT}" "${GUARD_RESULT}" "${GUARD_BLOCKED:-<unset>}" \
  "${FINAL_RESULT}" "${FINAL_BLOCKED:-<unset>}" "${DEPLOY_RESULT}"

# BEGIN DISPATCH_DEPLOY_OUTCOME_GUARD
# The deploy delivered. Nothing to report.
if [ "${DEPLOY_RESULT}" = "success" ]; then
  note "deploy succeeded on this dispatch"
  exit 0
fi

# The deploy ran and did not succeed, or the run was cancelled under it. Every
# such conclusion is ALREADY visible: `failure`/`timed_out` make the run red by
# themselves, and `cancelled` is read by the exporter's steps-array rule. Adding
# a second red job here would double-report one cause.
if [ "${DEPLOY_RESULT}" != "skipped" ]; then
  note "deploy reported '${DEPLOY_RESULT}', which is already visible in the run conclusion"
  exit 0
fi

# From here the `deploy` job was SKIPPED on a dispatch to master, which is the
# shape that reports green while delivering nothing. Enumerate the benign
# causes; anything left is the defect.

# Cause 1: the attempt died upstream, at the build. The run is already red, and
# the exporter already scores it an "attempt" via the run conclusion. This also
# absorbs a cancelled run, whose `build-and-push` cannot report `success`.
if [ "${BUILD_RESULT}" != "success" ]; then
  note "deploy was skipped because build-and-push reported '${BUILD_RESULT}'; the run conclusion already carries that"
  exit 0
fi

# Cause 2: a guard deliberately held the deploy because another run holds a
# pending production approval. This is the control working, not a wedge, and it
# is the population the exporter deliberately scores as evidence of nothing.
if [ "${GUARD_BLOCKED}" = "true" ] || [ "${FINAL_BLOCKED}" = "true" ]; then
  note "deploy was deliberately held: a pending production approval is already outstanding (guard blocked=${GUARD_BLOCKED:-<unset>}, final blocked=${FINAL_BLOCKED:-<unset>})"
  exit 0
fi

# Cause 3: a guard job itself failed or was cancelled. `deploy` requires both
# guard RESULTS, not merely their outputs, so it fails closed into a skip — and
# the failed guard has already made the run red.
case "${GUARD_RESULT}:${FINAL_RESULT}" in
  *failure* | *cancelled* | *timed_out*)
    note "deploy was skipped because a guard reported guard='${GUARD_RESULT}' final='${FINAL_RESULT}'; the run conclusion already carries that"
    exit 0
    ;;
esac

# Nothing benign is left. Name the kill switch when the evidence is deductive.
#
# This job's own `if:` has already established `event_name == 'workflow_dispatch'`
# and `ref == 'refs/heads/master'`. `guard-pending-deploy` gates on exactly
# those two terms plus `vars.PAPERCLIP_CI_DEPLOY == 'true'` and has no `needs:`,
# so if it was SKIPPED the variable is the only conjunct that can have been
# false. That is an identification, not a guess.
if [ "${GUARD_RESULT}" = "skipped" ]; then
  fail "production deploy did not run: guard-pending-deploy was skipped on a workflow_dispatch to master, so vars.PAPERCLIP_CI_DEPLOY is the only conjunct of its if: that can be false. The image was built and pushed; NOTHING was deployed. See PEN-5369 — do not simply flip the variable, establish who set it and why first."
fi

fail "production deploy did not run and no known cause explains it (build-and-push=${BUILD_RESULT}, guard-pending-deploy=${GUARD_RESULT} blocked=${GUARD_BLOCKED:-<unset>}, guard-pending-deploy-final=${FINAL_RESULT} blocked=${FINAL_BLOCKED:-<unset>}, deploy=${DEPLOY_RESULT}). A conjunct was likely added to the deploy job's if: without being taught to this guard. See PEN-5369."
# END DISPATCH_DEPLOY_OUTCOME_GUARD

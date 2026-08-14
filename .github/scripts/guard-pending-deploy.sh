#!/usr/bin/env bash
set -euo pipefail

# BLO-26972: shared by guard-pending-deploy (fast pre-check) and
# guard-pending-deploy-final (authoritative re-check right before `deploy`
# enters the paperclip-production concurrency group). Keeping one script
# means both checks can never drift apart.
#
# status=waiting is GitHub's status for a run parked on an environment
# reviewer gate (as opposed to queued for a runner). Lists across ALL
# docker.yml runs, not just this concurrency group, because the thing we
# must never evict is any run already waiting on paperclip-production — the
# group key is what caused the bug, not what should scope the guard.
#
# Requires GH_TOKEN, REPO, CURRENT_RUN_ID in the environment.
runs_json="$(gh api "repos/${REPO}/actions/workflows/docker.yml/runs?status=waiting&per_page=20")"
pending="$(printf '%s' "$runs_json" | jq -c --arg cur "$CURRENT_RUN_ID" \
  '[.workflow_runs[] | select((.id | tostring) != $cur)] | sort_by(.created_at) | .[0] // empty')"

if [ -n "${pending}" ] && [ "${pending}" != "null" ]; then
  pending_url="$(printf '%s' "$pending" | jq -r '.html_url')"
  pending_created="$(printf '%s' "$pending" | jq -r '.created_at')"
  echo "blocked=true" >> "$GITHUB_OUTPUT"
  # ::warning:: puts this in the run's annotations panel and marks the run
  # with a warning triangle in the Actions list, so a suppressed dispatch
  # doesn't read as an identical green success to a real deploy.
  echo "::warning::Deploy dispatch skipped — production approval already pending since ${pending_created}: ${pending_url}"
  {
    echo "### Deploy dispatch skipped"
    echo "A production deployment is already waiting on approval, pending since ${pending_created}:"
    echo "- ${pending_url}"
    echo ""
    echo "This dispatch will not enter the paperclip-production queue, so that pending approval is not evicted."
    echo "Approve or reject it first, then re-dispatch this workflow if a deploy of this commit is still wanted."
  } >> "$GITHUB_STEP_SUMMARY"
else
  echo "blocked=false" >> "$GITHUB_OUTPUT"
fi

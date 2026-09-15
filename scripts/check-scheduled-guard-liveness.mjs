#!/usr/bin/env node

/**
 * PEN-3281: a scheduled guard that STOPS RUNNING emits no signal anywhere.
 *
 * A GitHub Actions run sitting in `queued` has no `conclusion`. It is not
 * `failure`, not `cancelled`, not `timed_out` — it is nothing. So on every
 * dashboard and in every rollup, a control that has silently ceased to enforce
 * is indistinguishable from a control that ran and found nothing to report.
 *
 * Measured 2026-09-15: six scheduled guards on this repo — review-gate-sweep,
 * Ally Review Consistency Guard, CODEOWNERS Guard, Relay SSL Multicert Guard,
 * Lockfile Drift Monitor, Adapter Pin Drift Monitor — had not executed since
 * 03:41Z because the `arc-default` ARC listener was gone (PEN-3272). Two of
 * them are security controls. Nothing went red for ten hours.
 *
 * This watches LIVENESS, NOT VERDICT. See the header of
 * .github/workflows/scheduled-guard-liveness.yml for the full rationale:
 * why age-since-last-COMPLETION rather than age-since-last-SUCCESS, why the
 * threshold is 4h, and why the job must not run on the `default` label.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_STALE_HOURS = 4;

export const WATCHED_WORKFLOWS = [
  "review-gate-sweep.yml",
  "ally-review-consistency.yml",
  "codeowners-guard.yml",
  "relay-ssl-multicert-guard.yml",
  "lockfile-drift-monitor.yml",
  "adapter-pin-drift-monitor.yml",
];

/**
 * Classifies one watched guard from already-fetched observations.
 *
 * Pure: every failure mode an observation can carry is decided here, so the
 * mutation checks in the colocated test exercise the real decision rather
 * than a re-implementation of it.
 *
 * `observation` is one of:
 *   {error: "unreadable"}                      workflow metadata unreadable
 *   {error: "runs-unreadable", state}          run history unreadable
 *   {state, name, newest: null}                active, never completed
 *   {state, name, newest: {updatedAt, conclusion, htmlUrl}}
 *
 * @returns {{workflow: string, status: "ok"|"stale"|"unknown", reason: string,
 *            name: string, ageMinutes: number|null, detail: string}}
 */
export function classifyGuard(workflow, observation, { now, staleHours = DEFAULT_STALE_HOURS } = {}) {
  const name = observation?.name || workflow;
  const base = { workflow, name, ageMinutes: null };

  if (observation?.error === "unreadable") {
    return {
      ...base,
      status: "stale",
      reason: "unreadable",
      detail:
        `${workflow} could not be read from the workflows API. It was renamed, deleted, or the ` +
        `token lost access. Either way this guard is no longer being watched: fix the path in ` +
        `WATCHED_WORKFLOWS in scripts/check-scheduled-guard-liveness.mjs, or remove it deliberately.`,
    };
  }

  if (observation?.error === "runs-unreadable") {
    return {
      ...base,
      status: "stale",
      reason: "runs-unreadable",
      detail:
        `could not enumerate completed runs for ${name} (${workflow}). Treating as stale: an API ` +
        `error must not read as health.`,
    };
  }

  // A renamed, deleted or manually/inactivity-disabled workflow stops enforcing
  // just as completely as a starved one, and is invisible to any run-state scan.
  if (observation?.state && observation.state !== "active") {
    return {
      ...base,
      status: "stale",
      reason: "disabled",
      detail:
        `${name} (${workflow}) has state '${observation.state}', so its schedule no longer fires. ` +
        `GitHub sets disabled_inactivity automatically on scheduled workflows in dormant ` +
        `repositories; disabled_manually means a human turned it off. Re-enable it, or drop it ` +
        `from WATCHED_WORKFLOWS if it was retired on purpose.`,
    };
  }

  if (!observation?.newest) {
    return {
      ...base,
      status: "stale",
      reason: "never-completed",
      detail: `${name} (${workflow}) is active but has no completed run at all. It has never enforced anything.`,
    };
  }

  const completedEpoch = Date.parse(observation.newest.updatedAt);
  if (Number.isNaN(completedEpoch)) {
    // An unparsable timestamp is not evidence of staleness, but it must not be
    // silently dropped either.
    return {
      ...base,
      status: "unknown",
      reason: "unparsable-timestamp",
      detail: `${name} (${workflow}) has updated_at '${observation.newest.updatedAt}'; cannot age it`,
    };
  }

  const ageMinutes = Math.floor((now - completedEpoch) / 60000);
  const conclusion = observation.newest.conclusion ?? "unknown";

  if (ageMinutes < staleHours * 60) {
    return {
      ...base,
      status: "ok",
      reason: "fresh",
      ageMinutes,
      detail: `${name} last completed ${ageMinutes}m ago (conclusion=${conclusion})`,
    };
  }

  return {
    ...base,
    status: "stale",
    reason: "stopped",
    ageMinutes,
    detail:
      `${name} (${workflow}) last completed ${Math.floor(ageMinutes / 60)}h ago (at ` +
      `${observation.newest.updatedAt}, conclusion=${conclusion}), past the ${staleHours}h liveness ` +
      `threshold.`,
    lastRunUrl: observation.newest.htmlUrl ?? null,
  };
}

/**
 * Distinguishes the two stop-modes, which have different owners: starved
 * behind a dead lane is an ARC/infra fault, whereas nothing queued at all
 * points at the schedule itself.
 *
 * @param {number|null} queuedCount null when the count could not be read
 */
export function describeStopMode(queuedCount) {
  if (queuedCount === null || queuedCount === undefined) {
    return (
      `Could not read the queued-run count, so the stop-mode is undetermined — check both the ARC ` +
      `listener for the 'default' label and the workflow's own schedule.`
    );
  }

  if (queuedCount > 0) {
    return (
      `${queuedCount} run(s) are sitting in 'queued' and have never started — the schedule is ` +
      `firing but nothing is dispatching them. That is a runner-lane fault: check the ARC listener ` +
      `for the 'default' label (cf. PEN-3272).`
    );
  }

  return (
    `Nothing is queued either, so the schedule itself is not producing runs. Check the workflow's ` +
    `cron and whether the default branch still carries it.`
  );
}

/**
 * @param {ReturnType<typeof classifyGuard>[]} results
 */
export function summarize(results, { staleHours = DEFAULT_STALE_HOURS } = {}) {
  const stale = results.filter((r) => r.status === "stale");
  const checked = results.length;

  return {
    checked,
    staleCount: stale.length,
    stale,
    exitCode: stale.length > 0 ? 1 : 0,
    headline:
      stale.length === 0
        ? `All ${checked} watched scheduled guards have completed within ${staleHours}h.`
        : `${stale.length} of ${checked} watched scheduled guard(s) have stopped executing.`,
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function observeWorkflow(repo, workflow) {
  let meta;
  try {
    meta = JSON.parse(gh(["api", `repos/${repo}/actions/workflows/${workflow}`]));
  } catch {
    return { error: "unreadable" };
  }

  if (meta.state !== "active") {
    return { state: meta.state, name: meta.name };
  }

  try {
    // Newest COMPLETED run, any conclusion. per_page=1 on a server-side
    // filtered query: no pagination, so the 1000-item cap that bites
    // --paginate scans cannot truncate this.
    const raw = gh([
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=1`,
    ]);
    const run = JSON.parse(raw).workflow_runs?.[0];
    if (!run) return { state: meta.state, name: meta.name, newest: null };

    return {
      state: meta.state,
      name: meta.name,
      newest: { updatedAt: run.updated_at, conclusion: run.conclusion, htmlUrl: run.html_url },
    };
  } catch {
    return { error: "runs-unreadable", state: meta.state, name: meta.name };
  }
}

function countQueued(repo, workflow) {
  try {
    const raw = gh([
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?status=queued&per_page=100`,
    ]);
    return JSON.parse(raw).workflow_runs?.length ?? 0;
  } catch {
    return null;
  }
}

function main() {
  const repo = process.env.GUARD_LIVENESS_REPO || process.env.GITHUB_REPOSITORY || "Blockcast/paperclip";
  const staleHours = Number(process.env.GUARD_LIVENESS_STALE_HOURS || DEFAULT_STALE_HOURS);
  const watched = (process.env.GUARD_LIVENESS_WORKFLOWS || "").trim()
    ? process.env.GUARD_LIVENESS_WORKFLOWS.trim().split(/\s+/)
    : WATCHED_WORKFLOWS;

  const now = Date.now();
  const results = watched.map((workflow) =>
    classifyGuard(workflow, observeWorkflow(repo, workflow), { now, staleHours }),
  );

  for (const result of results) {
    if (result.status === "ok") {
      console.log(`ok: ${result.detail}`);
      continue;
    }

    if (result.status === "unknown") {
      console.log(`::warning title=Unparsable run timestamp::${result.detail}`);
      continue;
    }

    if (result.reason === "stopped") {
      // Only now, and only for a guard already known stale, spend a call to
      // distinguish the stop-modes.
      const detail = describeStopMode(countQueued(repo, result.workflow));
      console.log(
        `::error title=Scheduled guard has stopped executing::${result.detail} ${detail} This ` +
          `guard is not enforcing anything right now, and a stopped guard reds nothing on its own ` +
          `— that silence is why this job exists (PEN-3281). Last run: ${result.lastRunUrl ?? "n/a"}`,
      );
      continue;
    }

    const titles = {
      unreadable: "Guard workflow unreadable",
      "runs-unreadable": "Guard run history unreadable",
      disabled: "Guard workflow disabled",
      "never-completed": "Guard has never completed",
    };
    console.log(`::error title=${titles[result.reason]}::${result.detail}`);
  }

  const summary = summarize(results, { staleHours });
  if (summary.exitCode === 0) {
    console.log(summary.headline);
    return;
  }

  console.error(summary.headline);
  process.exit(1);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}

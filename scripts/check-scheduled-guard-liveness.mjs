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

/**
 * Every watched guard, with the threshold that guard's OWN cadence justifies.
 *
 * A single global threshold was the first shape of this file and it was wrong:
 * it silently assumed every watched guard is hourly. That assumption held only
 * because the watched set had been transcribed from the six workflows named in
 * PEN-3281, which happened to be the hourly ones. See the enumeration test —
 * the set is now checked against the repo rather than against that memory.
 *
 * Thresholds are measured per guard, never assumed, by the same method for
 * each: enumerate real completion gaps, separate ordinary jitter from outage
 * clusters, and place the bar above the jitter ceiling and below the outages
 * it must catch.
 */
export const WATCHED_GUARDS = [
  // Hourly guards. Gap distribution to 2026-09-11: ordinary jitter <= 118 min,
  // outage clusters 213-305 min. 4h = 2.03x the jitter ceiling.
  { workflow: "review-gate-sweep.yml", staleHours: 4 },
  { workflow: "ally-review-consistency.yml", staleHours: 4 },
  { workflow: "codeowners-guard.yml", staleHours: 4 },
  { workflow: "relay-ssl-multicert-guard.yml", staleHours: 4 },
  { workflow: "lockfile-drift-monitor.yml", staleHours: 4 },
  { workflow: "adapter-pin-drift-monitor.yml", staleHours: 4 },

  // Twice daily (cron "43 6,18"), so the 4h bar above would red it permanently.
  // 39 measured gaps: ordinary band tops out at 14.60h (n=37); the two outliers
  // are 17.71h (the 2026-09-15 PEN-3272 event this row was filed on) and 22.21h
  // (2026-09-06, a wholly missed 06:43 cycle nobody noticed at the time).
  //
  // 16h is the honest number and it is the least comfortable one in this file:
  // the admissible window is only (14.60h, 17.71h), so the margin is 1.10x the
  // jitter ceiling where the hourly guards get 2.03x. Setting it any looser —
  // 18h, say — would clear the jitter ceiling more safely but sail straight
  // over the 17.71h event, which is the baseline-on-the-incident error this
  // file already made once and corrected.
  //
  // What makes 16h acceptable rather than merely tight: this guard's age check
  // is a BACKSTOP, not its primary coverage. A lane outage wide enough to stall
  // it also stalls the six hourly guards, which detect the same event with
  // hours of margin, and detection is per-EVENT. The failure modes unique to
  // this guard — disabled, renamed, never completed — are decided on their own
  // branches and are threshold-independent.
  { workflow: "production-environment-protection-guard.yml", staleHours: 16 },
];

/** Back-compat / convenience view: just the workflow filenames. */
export const WATCHED_WORKFLOWS = WATCHED_GUARDS.map((guard) => guard.workflow);

/**
 * Scheduled `default`-label workflows this job deliberately does NOT watch.
 *
 * Enumerated rather than left implicit so the colocated drift test can assert
 * that every scheduled `default` workflow in the repo is either watched or
 * exempted here. An unlisted new one fails that test at PR time, which is where
 * the drift is introduced — not silently at 03:00, which is the whole failure
 * mode PEN-3281 exists to close.
 */
export const EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS = [
  {
    workflow: "refresh-shard-manifest.yml",
    reason:
      "Not a guard. It opens a PR refreshing a shard-duration manifest (BLO-24241); nothing is " +
      "enforced, so its stopping costs test-sharding accuracy rather than coverage. Its weekly " +
      "cron also makes any liveness bar coarse to the point of noise — a threshold would have to " +
      "exceed 7 days to clear ordinary jitter, by which point it reports nothing worth waking for.",
  },
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
 * Reasons that mean "this guard demonstrably is not enforcing".
 *
 * Kept distinct from the read-failure reasons below because they are DIFFERENT
 * CLAIMS WITH DIFFERENT OWNERS. "The CODEOWNERS guard has stopped executing"
 * pages whoever owns the runner lane; "I could not reach the GitHub API" is a
 * statement about this job's own visibility and owns nothing. Both still exit
 * non-zero — an API error must never read as health — but collapsing them into
 * one headline makes the job assert, on a transient 5xx, that a perfectly
 * healthy control has stopped. A liveness alarm that cries wolf gets muted, and
 * a muted liveness alarm is exactly the failure mode this job exists to prevent.
 */
const STOPPED_REASONS = new Set(["stopped", "disabled", "never-completed"]);
const UNREADABLE_REASONS = new Set(["unreadable", "runs-unreadable"]);

/**
 * @param {ReturnType<typeof classifyGuard>[]} results
 */
export function summarize(results) {
  const stale = results.filter((r) => r.status === "stale");
  const stopped = stale.filter((r) => STOPPED_REASONS.has(r.reason));
  const unreadable = stale.filter((r) => UNREADABLE_REASONS.has(r.reason));
  const checked = results.length;

  const clauses = [];
  if (stopped.length > 0) {
    clauses.push(`${stopped.length} of ${checked} watched scheduled guard(s) have stopped executing`);
  }
  if (unreadable.length > 0) {
    clauses.push(
      `${unreadable.length} of ${checked} could not be read from the GitHub API, so their liveness ` +
        `is unknown (failing closed, not asserting they stopped)`,
    );
  }

  return {
    checked,
    staleCount: stale.length,
    stale,
    stoppedCount: stopped.length,
    unreadableCount: unreadable.length,
    exitCode: stale.length > 0 ? 1 : 0,
    headline:
      stale.length === 0
        ? `All ${checked} watched scheduled guards have completed within their liveness thresholds.`
        : `${clauses.join("; ")}.`,
  };
}

/**
 * The `stale_hours` workflow_dispatch input is free text, so it arrives as an
 * arbitrary string. Left unguarded, `Number("abc")` is NaN, `age < NaN` is
 * false, and EVERY guard is classified stale with detail text reading "past the
 * NaNh liveness threshold" — a full-fleet false alarm from one typo. `"0"` is a
 * truthy string, so it survives `||` and then classifies everything stale too.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 */
export function resolveStaleHours(raw, fallback = DEFAULT_STALE_HOURS) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A 404 is a real, terminal answer — the workflow was renamed or deleted, which
 * IS one of the stop-modes this job reports — so it must not be retried into a
 * delay. Everything else (5xx, rate limiting, DNS, a dropped connection) is
 * treated as transient.
 *
 * @param {unknown} error
 */
function isTerminalApiError(error) {
  const text = `${error?.stderr ?? ""}${error?.stdout ?? ""}${error?.message ?? ""}`;
  return /HTTP 404|Not Found/i.test(text);
}

/** Synchronous sleep. This script is sync end to end; Atomics.wait avoids reshaping it. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * At ~14 read calls an hour (~2,400 a week) a single unretried attempt makes an
 * occasional transient failure a near-certainty, and every one of those would
 * have surfaced as a stale verdict about a healthy guard. Three attempts with a
 * short backoff costs at most ~3s on the terminal path and removes that class.
 */
function gh(args, { attempts = 3, backoffMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch (error) {
      lastError = error;
      if (isTerminalApiError(error) || attempt === attempts) break;
      sleepSync(backoffMs * attempt);
    }
  }
  throw lastError;
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
    //
    // ON THE SORT KEY, which is deliberate and not an oversight: this endpoint
    // orders by created_at, while the age below is computed from updated_at.
    // Re-running an OLD run bumps its updated_at without moving it up that
    // ordering, so a completion can land outside this single-item window and be
    // missed. That is a KNOWN, ACCEPTED skew, kept because it errs in the safe
    // direction — reporting a guard stale slightly early. The alternative,
    // taking max(updated_at) over the newest N, trades it for an unsafe error:
    // re-running one ancient run would then read as a fresh completion and mask
    // a dead schedule indefinitely. For a control whose only value is being
    // believed, false-early beats false-quiet.
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

  // An explicit override is a manual debugging dial (workflow_dispatch, or the
  // live checks in the PR). It deliberately applies to EVERY guard, flattening
  // the per-guard thresholds, so a dispatch at 1h reds the whole set on purpose.
  const override = process.env.GUARD_LIVENESS_STALE_HOURS;
  const overrideHours = override && String(override).trim() !== "" ? resolveStaleHours(override) : null;

  const watched = (process.env.GUARD_LIVENESS_WORKFLOWS || "").trim()
    ? process.env.GUARD_LIVENESS_WORKFLOWS.trim()
        .split(/\s+/)
        .map((workflow) => ({ workflow, staleHours: overrideHours ?? DEFAULT_STALE_HOURS }))
    : WATCHED_GUARDS;

  const now = Date.now();
  const results = watched.map(({ workflow, staleHours }) =>
    classifyGuard(workflow, observeWorkflow(repo, workflow), {
      now,
      staleHours: overrideHours ?? staleHours,
    }),
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

  const summary = summarize(results);
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

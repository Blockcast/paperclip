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
 * why age-since-last-COMPLETION rather than age-since-last-SUCCESS, how each
 * threshold is derived from that guard's own measured cadence, why a stale
 * verdict must survive a second independent read (PEN-3379), and why the job
 * must not run on the `default` label.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_STALE_HOURS = 2.75;

/**
 * How many runs the cross-check read scans (see `crossCheckCompletions`).
 *
 * Unfiltered, so it sees queued and in-progress runs too. An hourly guard
 * produces ~1 run an hour, so 30 covers well over a day — comfortably past any
 * threshold in this file for which the cross-check is spent.
 */
const CROSS_CHECK_PAGE_SIZE = 30;

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
  // outage clusters 213-305 min. The bar is 165 min (2.75h), 1.40x the jitter
  // ceiling, mid-band in the only admissible window: (118, 213).
  //
  // This shipped at 240 min and 240 IS OUTSIDE THAT WINDOW — above the 213-min
  // floor of the outage cluster it exists to catch, not merely close to it. The
  // number it was justified against was the jitter ceiling alone (240 = 2.03x
  // 118), which is only half the constraint; nothing checked it against the
  // events on the other side. PEN-3379.
  //
  // The instrument is not the retrospective gap but the window in which an
  // HOURLY detector can sample it: a leg of length G is over bar B for G-B
  // minutes, so the catch is guaranteed only when G-B > 60. Against the six
  // measured legs of the 2026-09-14 event (305, 291, 268, 254, 241, 213):
  //
  //   bar 240 -> guaranteed on 1 of 6   (and the 241 leg clears it by one minute)
  //   bar 165 -> guaranteed on 5 of 6
  //
  // Derived jointly with @Devops on PEN-3281 (2026-09-16) from two independent
  // datasets — per-workflow completion gaps and a pool-wide dispatch census —
  // which disagree about the low legs and agree that 240 is wrong.
  //
  // RE-DERIVED 2026-09-22 on 11 days of fresh data (2026-09-11 -> 09-22), because
  // the numbers above were measured to 09-11 and a tightened bar has less
  // headroom to spend than the one it replaces. 1634 pooled completion gaps
  // across the six guards (successive updated_at deltas, ~272 legs each):
  //
  //   ordinary jitter ceiling   118 min   unchanged; p95 is 83-99 per guard
  //   legs above the ceiling    213, 246, 254, 290, 301, 305, then 562-712
  //
  // The band survives unchanged, and on better evidence than it had: NO LEG
  // LANDS IN (118, 213) AT ALL over 1634 observations. The set of legs above
  // 118 and the set above 165 are identical, so moving the bar from the jitter
  // ceiling to 165 adds exactly zero false positives across the whole window.
  // 165 is not merely mid-band — it sits in an observed-empty region, which is
  // the property that matters for an alarm whose value is being believed.
  //
  // Two caveats kept rather than smoothed over. The 213-min floor is still a
  // single leg, so the band's lower edge rests on one observation even now.
  // And the 562-712 legs are much longer than the 213-305 cluster cited above;
  // they are not attributed here, because this measurement enumerates gaps and
  // does not establish what caused any of them.
  //
  // Not 150-180 by luck: a quantized one-tick drop (~120 min) sits below this
  // band and a two-tick drop (~180) would sit inside it, but two consecutive
  // drops are NOT OBSERVED in either dataset. And a quorum rule ("red only when
  // >=2 guards are stale at once") is not available as an alternative: five of
  // the six share a cron minute and dropped the SAME tick, so simultaneity is
  // not independent here. Magnitude is the only axis that separates jitter from
  // outage.
  { workflow: "review-gate-sweep.yml", staleHours: 2.75 },
  { workflow: "ally-review-consistency.yml", staleHours: 2.75 },
  { workflow: "codeowners-guard.yml", staleHours: 2.75 },
  { workflow: "relay-ssl-multicert-guard.yml", staleHours: 2.75 },
  { workflow: "lockfile-drift-monitor.yml", staleHours: 2.75 },
  { workflow: "adapter-pin-drift-monitor.yml", staleHours: 2.75 },

  // Twice daily (cron "43 6,18"), so the hourly bar above would red it
  // permanently.
  // 39 measured gaps: ordinary band tops out at 14.60h (n=37); the two outliers
  // are 17.71h (the 2026-09-15 PEN-3272 event this row was filed on) and 22.21h
  // (2026-09-06, a wholly missed 06:43 cycle nobody noticed at the time).
  //
  // 16h is the honest number and it is the least comfortable one in this file:
  // the admissible window is only (14.60h, 17.71h), so the margin is 1.10x the
  // jitter ceiling where the hourly guards get 1.40x. That contrast is narrower
  // than it used to read: this note said 2.03x until PEN-3379, quoting the old
  // 240-min hourly bar, and the tightening to 165 min cut the hourly margin to
  // 1.40x. So 16h is tight, but it is no longer the outlier the 1.10x-vs-2.03x
  // framing implied — both bars now sit close to their jitter ceilings, which is
  // what placing a bar mid-band actually costs. Setting it any looser —
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
 * `observation.crossCheck` is optional and only consulted on the path that
 * would otherwise red. It is `{newestCompletedAt}` from the independent
 * unfiltered read, or `{error: true}`. A cross-check that is NEWER than
 * `newest` suppresses the alarm to "unknown" (PEN-3379); an absent or
 * unreadable one leaves the verdict alone.
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
    // This reds on the SAME filtered index the rest of this function now
    // distrusts, and on its strongest possible claim — "never enforced
    // anything". An index that served a 140-run-old entry as [0] is not
    // obviously trustworthy when it serves an empty page instead, so the
    // empty result gets the same corroboration a stale one does: any completed
    // run in the unfiltered re-read refutes "never", outright and without
    // needing to be recent (PEN-3379).
    const crossCheckNewest = observation?.crossCheck?.newestCompletedAt;
    if (crossCheckNewest) {
      return {
        ...base,
        status: "unknown",
        reason: "cross-check-disagreement",
        detail:
          `${name} (${workflow}) returned no completed run at all from the filtered run index, ` +
          `but an unfiltered re-read of the same history found a completion at ${crossCheckNewest}. ` +
          `The two reads disagree, so the filtered index is stale and "has never completed" is a ` +
          `fiction. Suppressing the alarm rather than firing it (PEN-3379); this guard is NOT being ` +
          `asserted to have stopped.`,
      };
    }

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

  // Past the bar on the filtered read alone. Before that becomes a red, it has
  // to survive the independent unfiltered read (PEN-3379): on 2026-09-18 the
  // filtered index served a ~140-run-old entry as [0] four times, and every red
  // this detector had ever produced was that fault rather than a stopped guard.
  //
  // DISAGREEMENT SUPPRESSES. A cross-check that found a completion NEWER than
  // the one we just aged proves the filtered read was stale, so the age is
  // measured off a fiction and the only honest verdict is "unknown". It still
  // prints as a warning, so a genuinely wedged index stays visible instead of
  // going quiet — but it does not assert that a guard stopped, and it does not
  // exit non-zero.
  //
  // Absence of corroboration is NOT agreement: an unreadable cross-check leaves
  // the stale verdict standing, annotated. Suppressing there would mean a
  // persistently failing second read mutes the alarm entirely, which is the
  // exact failure mode this detector exists to prevent — the same reasoning
  // that makes `runs-unreadable` red rather than pass.
  const crossCheck = observation.crossCheck;
  if (crossCheck && !crossCheck.error && crossCheck.newestCompletedAt) {
    const crossEpoch = Date.parse(crossCheck.newestCompletedAt);
    if (!Number.isNaN(crossEpoch) && crossEpoch > completedEpoch) {
      const crossAgeMinutes = Math.floor((now - crossEpoch) / 60000);
      return {
        ...base,
        status: "unknown",
        reason: "cross-check-disagreement",
        ageMinutes: crossAgeMinutes,
        detail:
          `${name} (${workflow}) read as ${Math.floor(ageMinutes / 60)}h stale from the filtered ` +
          `run index (newest completed ${observation.newest.updatedAt}), but an unfiltered re-read ` +
          `of the same history found a completion at ${crossCheck.newestCompletedAt} — ` +
          `${crossAgeMinutes}m ago. The two reads disagree, so the filtered index is stale and the ` +
          `age above is measured off a fiction. Suppressing the alarm rather than firing it ` +
          `(PEN-3379); this guard is NOT being asserted to have stopped.`,
        lastRunUrl: observation.newest.htmlUrl ?? null,
      };
    }
  }

  const crossCheckNote = crossCheck?.error
    ? ` The unfiltered cross-check read could not be made, so this verdict rests on the filtered ` +
      `read alone (PEN-3379); treat the age with corresponding caution.`
    : "";

  return {
    ...base,
    status: "stale",
    reason: "stopped",
    ageMinutes,
    detail:
      `${name} (${workflow}) last completed ${Math.floor(ageMinutes / 60)}h ago (at ` +
      `${observation.newest.updatedAt}, conclusion=${conclusion}), past the ${staleHours}h liveness ` +
      `threshold.${crossCheckNote}`,
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
    // ON THE SORT KEY: this endpoint orders by created_at, while the age below
    // is computed from updated_at. Re-running an OLD run bumps its updated_at
    // without moving it up that ordering, so a completion can land outside this
    // single-item window and be missed. The alternative, taking max(updated_at)
    // over the newest N, trades it for an unsafe error: re-running one ancient
    // run would then read as a fresh completion and mask a dead schedule
    // indefinitely.
    //
    // THIS NOTE USED TO CALL THAT SKEW BOUNDED — "errs in the safe direction,
    // reporting a guard stale slightly early". PEN-3379 FALSIFIED THAT BOUND.
    // On 2026-09-18 this read returned a ~140-run-old entry as [0] four times
    // in ~8h, citing 2026-09-12T04:32:39Z for a guard that had completed 17 min
    // earlier. The error was 146-154h, not "slightly". Two distinct guards were
    // hit with bogus citations 3 minutes apart, which points at one stale
    // server-side index rather than two independent per-workflow faults — it was
    // not reproducible on demand afterwards, and the root cause is NOT
    // established. All four reds this detector had produced in production were
    // false positives.
    //
    // So the skew is no longer accepted on trust. `crossCheckCompletions` below
    // re-reads the same history UNFILTERED before any stale verdict is allowed
    // to stand, and disagreement between the two reads SUPPRESSES the alarm
    // instead of firing it. The false-early/false-quiet trade above still
    // decides the sort key; what changed is that "false-early" is no longer
    // assumed to be small.
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

/**
 * Picks the newest COMPLETED run out of an unfiltered run page.
 *
 * Split out from the read below so the selection can be tested without the
 * network — the selection, not the request, is where this was got wrong once.
 *
 * The page is ordered by `created_at` DESC, so the FIRST completed entry is the
 * newest-created completion. That ordering is the whole reason this is a
 * `find`. Taking `max(updated_at)` across the page is NOT a harmless
 * equivalent: it is the unsafe error the sort-key note in `observeWorkflow`
 * rejects, arriving by the back door. Re-running any older run still inside the
 * page bumps its `updated_at` without moving its `created_at`, so `max` reads
 * that as a fresh completion, disagrees with the filtered read, and SUPPRESSES
 * the alarm. On a genuinely stopped guard that is a mute — and re-running a
 * stalled guard is the first thing a human does, which puts the trigger exactly
 * where the outage is. `find` cannot be fooled this way: a re-run entry stays
 * where its `created_at` put it.
 *
 * Returns the ISO `updated_at` of that run — the same quantity `observeWorkflow`
 * returns, so the two reads are compared like for like — or null when the page
 * holds no completed run. A newest completion whose timestamp will not parse
 * also returns null rather than falling through to an older run: null merely
 * withholds corroboration (the red stands), whereas selecting some other run
 * would answer a different question than the one asked.
 */
export function selectNewestCompleted(runs) {
  const newest = (runs ?? []).find((run) => run?.status === "completed" && run.updated_at);
  if (!newest) return null;

  const epoch = Date.parse(newest.updated_at);
  return Number.isNaN(epoch) ? null : new Date(epoch).toISOString();
}

/**
 * Second, INDEPENDENT read of the same run history — the corroboration a stale
 * verdict must survive before it is allowed to red (PEN-3379).
 *
 * Deliberately differs from `observeWorkflow`'s read on the one axis suspected
 * of failing: it drops `status=completed`, so it does not go through the
 * server-side filtered index that returned a 6-day-old entry as [0]. It pages
 * CROSS_CHECK_PAGE_SIZE runs and takes the newest one that has actually
 * completed, which is the same quantity the filtered read claims to return.
 *
 * Returns `{newestCompletedAt}` (ISO string, or null when the page genuinely
 * holds no completed run), or `{error: true}` when the read could not be made.
 * An unreadable cross-check is NOT treated as agreement — see `classifyGuard`.
 *
 * `read` is injectable so the failure branch is reachable from a test. It is
 * the branch that matters most: it decides whether a broken second read
 * degrades to "no corroboration, red stands" or to a silent mute, and a
 * veto whose failure mode is untested is a veto nobody can trust.
 */
export function crossCheckCompletions(repo, workflow, read = gh) {
  try {
    const raw = read([
      "api",
      `repos/${repo}/actions/workflows/${workflow}/runs?per_page=${CROSS_CHECK_PAGE_SIZE}`,
    ]);
    return { newestCompletedAt: selectNewestCompleted(JSON.parse(raw).workflow_runs ?? []) };
  } catch {
    return { error: true };
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
  const results = watched.map(({ workflow, staleHours }) => {
    const effectiveStaleHours = overrideHours ?? staleHours;
    const observation = observeWorkflow(repo, workflow);
    const first = classifyGuard(workflow, observation, { now, staleHours: effectiveStaleHours });

    // The cross-check is only worth a call once the cheap read has already
    // decided this guard looks stopped — the same "spend it only when it
    // matters" shape as countQueued below. Re-classifying is a pure call on the
    // observation we already hold, so corroborating costs exactly one request
    // and only on the path that was about to red (PEN-3379).
    //
    // Both reasons that red off the filtered index are gated, not just
    // `stopped`: `never-completed` rests on the same suspect read and makes a
    // stronger claim from it. `disabled` and `runs-unreadable` are deliberately
    // NOT here — neither is derived from that index, so a second read of it
    // could not corroborate them.
    if (first.status !== "stale" || (first.reason !== "stopped" && first.reason !== "never-completed")) {
      return first;
    }

    return classifyGuard(
      workflow,
      { ...observation, crossCheck: crossCheckCompletions(repo, workflow) },
      { now, staleHours: effectiveStaleHours },
    );
  });

  for (const result of results) {
    if (result.status === "ok") {
      console.log(`ok: ${result.detail}`);
      continue;
    }

    if (result.status === "unknown") {
      const title =
        result.reason === "cross-check-disagreement"
          ? "Run index disagreed with itself — liveness alarm suppressed"
          : "Unparsable run timestamp";
      console.log(`::warning title=${title}::${result.detail}`);
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

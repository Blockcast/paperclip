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

  // BLO-38228. Daily at 00:37, and the ONLY thing in this repo that observes
  // time passing — a test fixture can expire on the clock with no commit, which
  // is how master stayed red 63h with every push-triggered signal green.
  //
  // `event: "schedule"` is load-bearing, not tidiness. master-health also runs
  // on every push to master, so an unfiltered newest-run query is satisfied by
  // push runs while the cron is dead. Watching it without the filter would
  // report ok forever and manufacture exactly the confidence this guard exists
  // to withhold.
  //
  // 48h is DELIBERATELY LOOSE and is the one threshold in this file not derived
  // from a measured gap distribution — there is none, because BLO-38228 is what
  // introduces the schedule. Rather than invent a number, it is set where it
  // cannot false-red on GitHub's scheduled-run delay under load: a daily cron
  // must miss two full cycles to trip it. That is honest about what it buys.
  // The value here is mostly the threshold-INDEPENDENT branches — renamed or
  // deleted (unreadable), disabled (state), never completed — with a coarse
  // descheduled backstop on top. Tighten to ~26h once 30+ real gaps exist,
  // by this file's normal method.
  //
  // `graceUntil` exists because a schedule only fires from the DEFAULT branch,
  // so at merge this workflow has zero completed `schedule` runs by
  // construction and classifies `never-completed` — a threshold-INDEPENDENT
  // branch the 48h above cannot cover. Without the grace it reds the hourly
  // liveness job for up to ~24h, and an alarm that is red by design is one
  // everybody learns to ignore, which is the exact failure this guard exists
  // to prevent.
  //
  // This is a fixed literal in the PR that exists BECAUSE a fixed literal
  // rotted, so state the difference: rotting here is FAIL-CLOSED. When it
  // lapses the guard gets STRICTER, and the only thing that can go wrong is a
  // loud red — never a silent green. The date is the first cron after merge
  // (2026-10-01T00:37Z) plus two full cycles of slack for GitHub's scheduled-
  // run delay under load. If the merge slips past it, the grace is already
  // expired and the guard simply reds on day one: honest, not silent.
  {
    workflow: "master-health.yml",
    staleHours: 48,
    event: "schedule",
    graceUntil: "2026-10-03T00:00:00.000Z",
  },

  // BLO-26736. Twice daily (cron "29 7,19"), so it takes the same 16h bar as
  // the other twice-daily guard above rather than the hourly 2.75h one. The bar
  // is INHERITED, not re-derived: this workflow has no gap history of its own
  // yet, and 16h is the number the only comparable cadence on this repo was
  // measured against. Re-derive it by this file's normal method once ~30 real
  // gaps exist; if its distribution turns out wider than
  // production-environment-protection-guard's, this will false-red first and
  // loudly, which is the right direction to be wrong in.
  //
  // `graceUntil` for the same reason as master-health: a schedule only fires
  // from the default branch, so at merge this guard has zero completed runs by
  // construction and classifies `never-completed` — a threshold-INDEPENDENT
  // branch 16h cannot cover. Set to the first cron after the expected merge
  // plus two full cycles of slack. Rotting here is FAIL-CLOSED: when it lapses
  // the guard gets stricter, so the only thing that can go wrong is a loud red.
  {
    workflow: "review-gate-consumer-protection-guard.yml",
    staleHours: 16,
    graceUntil: "2026-10-09T00:00:00.000Z",
  },
];

/**
 * Resolves the guard entries `main()` will classify.
 *
 * Extracted and exported ONLY so the scoping branch is testable. It was
 * previously inline and rebuilt entries from the workflow name alone, which
 * silently dropped `event` and `graceUntil` — i.e. scoping to a guard reverted
 * its own fix and reported ok off a push run. The source-text test could not
 * see that, because the destructure it asserts on stayed correct.
 *
 * `GUARD_LIVENESS_WORKFLOWS` is a debugging dial that may name a workflow not
 * in WATCHED_GUARDS at all, so an undeclared name still resolves — to the
 * default threshold and no filter.
 */
export function resolveWatched(workflowsEnv, overrideHours = null) {
  const scoped = (workflowsEnv || "").trim();
  if (!scoped) return WATCHED_GUARDS;

  return scoped.split(/\s+/).map((workflow) => {
    const declared = WATCHED_GUARDS.find((guard) => guard.workflow === workflow);
    return {
      ...declared,
      workflow,
      staleHours: overrideHours ?? declared?.staleHours ?? DEFAULT_STALE_HOURS,
    };
  });
}

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
export function classifyGuard(
  workflow,
  observation,
  { now, staleHours = DEFAULT_STALE_HOURS, graceUntil = null } = {},
) {
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
    // Grace is checked BEFORE the cross-check, deliberately. A guard inside its
    // grace window has no completed run for a known, benign reason, so there is
    // nothing for a second read to corroborate — and returning `ok` here means
    // main()'s `first.status !== "stale"` early-out fires and the cross-check
    // call is never spent. Correct and one request cheaper.
    //
    // A guard whose schedule is newer than its own history has no completed run
    // yet and cannot have one: schedules fire only from the default branch, so
    // the count is zero at merge by construction. Red-by-design until the first
    // cron is noise sitting on top of a shared alarm — see graceUntil's comment
    // in WATCHED_GUARDS. Only this branch is graced; every other stale reason is
    // decided on real evidence and is not suppressed.
    if (graceUntil && now < Date.parse(graceUntil)) {
      return {
        ...base,
        status: "ok",
        reason: "awaiting-first-run",
        detail:
          `${name} (${workflow}) has no completed run yet and is inside its grace window until ` +
          `${graceUntil}. A newly-scheduled workflow cannot have fired before it reached the ` +
          `default branch. After that instant this reverts to a hard red.`,
      };
    }

    // This reds on the SAME filtered index the rest of this function now
    // distrusts, and on its strongest possible claim — "never enforced
    // anything". An index that served a 140-run-old entry as [0] is not
    // obviously trustworthy when it serves an empty page instead, so the
    // empty result gets the same corroboration a stale one does: any completed
    // run in the unfiltered re-read refutes "never", outright and without
    // needing to be recent (PEN-3379).
    //
    // Refuting "never" does not establish "alive", though. The cross-check
    // hands back a real timestamp, and that timestamp is aged against the same
    // staleHours bar the `stopped` branch uses: inside the bar the two reads
    // merely disagree and the alarm is suppressed; past the bar the guard has
    // stopped, and the unfiltered completion is strictly better evidence than
    // the empty page it replaces. Otherwise a dead guard whose filtered index
    // happens to serve an empty page would go quiet with exit 0, and an empty
    // page is exactly the index fault this gate was widened for.
    const crossCheckNewest = observation?.crossCheck?.newestCompletedAt;
    const crossEpoch = crossCheckNewest ? Date.parse(crossCheckNewest) : NaN;
    if (!Number.isNaN(crossEpoch)) {
      const crossAgeMinutes = Math.floor((now - crossEpoch) / 60000);
      if (crossAgeMinutes < staleHours * 60) {
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
        reason: "stopped",
        ageMinutes: crossAgeMinutes,
        detail:
          `${name} (${workflow}) returned no completed run from the filtered run index, but an ` +
          `unfiltered re-read found its newest completion at ${crossCheckNewest}, ` +
          `${Math.floor(crossAgeMinutes / 60)}h ago, past the ${staleHours}h liveness threshold. ` +
          `"Never completed" is refuted, but the guard has stopped (PEN-3379).`,
        lastRunUrl: null,
      };
    }

    // A present-but-unparsable cross-check timestamp falls through to the red:
    // selectNewestCompleted withholds corroboration (null) rather than serving
    // an older run, and an unreadable value is no corroboration either.
    const neverCompletedNote = observation?.crossCheck?.error
      ? ` The unfiltered cross-check read could not be made, so this verdict rests on the filtered ` +
        `read alone (PEN-3379); treat the age with corresponding caution.`
      : "";

    return {
      ...base,
      status: "stale",
      reason: "never-completed",
      detail:
        `${name} (${workflow}) is active but has no completed run at all. It has never enforced ` +
        `anything.${neverCompletedNote}`,
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
  //
  // A newer cross-check refutes the AGE, not staleness: it is aged against the
  // same staleHours bar the never-completed branch uses. Past the bar the guard
  // is dead by either read (a one-second index lag is enough to reach this
  // branch), so the red stands, citing the better timestamp.
  const crossCheck = observation.crossCheck;
  if (crossCheck && !crossCheck.error && crossCheck.newestCompletedAt) {
    const crossEpoch = Date.parse(crossCheck.newestCompletedAt);
    const crossAgeMinutes = Math.floor((now - crossEpoch) / 60000);
    if (!Number.isNaN(crossEpoch) && crossEpoch > completedEpoch && crossAgeMinutes >= staleHours * 60) {
      return {
        ...base,
        status: "stale",
        reason: "stopped",
        ageMinutes: crossAgeMinutes,
        detail:
          `${name} (${workflow}) read as ${Math.floor(ageMinutes / 60)}h stale from the filtered ` +
          `run index, and an unfiltered re-read found its newest completion at ` +
          `${crossCheck.newestCompletedAt}, ${Math.floor(crossAgeMinutes / 60)}h ago, also past the ` +
          `${staleHours}h liveness threshold. The guard has stopped by either read (PEN-3379).`,
        lastRunUrl: observation.newest.htmlUrl ?? null,
      };
    }
    if (!Number.isNaN(crossEpoch) && crossEpoch > completedEpoch) {
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
  // Suppressed, not healthy. `classifyGuard` declines to assert these stopped,
  // so the headline must not assert the stronger thing, that they completed.
  // They do not redden the run: exitCode stays keyed on `stale` alone.
  const unknown = results.filter((r) => r.status === "unknown");
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
  if (unknown.length > 0) {
    clauses.push(
      `${unknown.length} of ${checked} could not be assessed (the run index disagreed with itself, ` +
        `or a run timestamp would not parse), so their liveness is unknown, not asserted healthy`,
    );
  }

  return {
    checked,
    staleCount: stale.length,
    stale,
    stoppedCount: stopped.length,
    unreadableCount: unreadable.length,
    unknownCount: unknown.length,
    exitCode: stale.length > 0 ? 1 : 0,
    headline:
      stale.length > 0
        ? `${clauses.join("; ")}.`
        : unknown.length > 0
          ? `${checked - unknown.length} of ${checked} watched scheduled guards have completed within ` +
            `their liveness thresholds; ${clauses.join("; ")}.`
          : `All ${checked} watched scheduled guards have completed within their liveness thresholds.`,
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

/**
 * API path for a guard's newest completed run.
 *
 * `event` narrows to one trigger, for a guard that is ALSO reachable by a
 * non-scheduled trigger. Without it the newest run is whatever fired last, so a
 * workflow with a push trigger reads fresh while its cron is dead.
 *
 * Exported only so the colocated test can mutation-check that filter — the same
 * reason `classifyGuard` is exported: a guard with no failing mutation is a
 * comment.
 */
export function completedRunsPath(repo, workflow, event) {
  const base = `repos/${repo}/actions/workflows/${workflow}/runs?status=completed&per_page=1`;
  return event ? `${base}&event=${encodeURIComponent(event)}` : base;
}

/**
 * `read` is injectable for exactly one reason: without it this function reaches
 * `gh` directly, so the `event` argument had no observable effect and dropping
 * it from the adapter in `makeGuardReaders` was a mutation no test could see.
 * `crossCheckCompletions` already took `read` and its `event` leg was guarded;
 * this leg was not, which is the asymmetry rather than a style difference.
 */
export function observeWorkflow(repo, workflow, read = gh, event = undefined) {
  let meta;
  try {
    meta = JSON.parse(read(["api", `repos/${repo}/actions/workflows/${workflow}`]));
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
    //
    // ON THE `event` NARROWING (BLO-38228): orthogonal to the axis above, and it
    // is threaded into `crossCheckCompletions` as well. The cross-check's whole
    // point is to differ on ONE axis — `status=completed` — so if it differed on
    // the trigger axis too it would read a push run the filtered side cannot
    // see, disagree with itself on every poll, and suppress the alarm forever.
    // An always-muted guard is the failure mode both of these mechanisms exist
    // to prevent.
    const raw = read(["api", completedRunsPath(repo, workflow, event)]);
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
 *
 * STATED, because this file's own thesis is that unstated assumptions are what
 * cost four false positives: relying on `created_at` DESC is itself trust in
 * server-side ordering — the same CLASS of assumption PEN-3379 falsified for
 * the filtered index. These two reads differ only on the filter axis, and the
 * root cause is recorded there as unestablished, so nothing here proves the
 * unfiltered page is ordered any more reliably than the filtered one was.
 *
 * What makes it tolerable is the direction it fails in, not confidence that it
 * holds. A mis-ordered page hands back an OLDER completion than the true
 * newest, which reads as "no corroboration" — and this function's corroboration
 * is only ever used to weaken a red. So the failure mode is a red that stands
 * when it might have been suppressed, never a mute. The assumption is load-
 * bearing for precision and NOT for safety; if it breaks, the detector gets
 * noisier, not quieter. That asymmetry is why this is a `find` over an ordering
 * assumption rather than a `max` over none.
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
 *
 * `event` MIRRORS `observeWorkflow`'s narrowing and is deliberately NOT dropped
 * along with `status=completed` (BLO-38228). "Differs on ONE axis" is the whole
 * design: for a guard that is also reachable by a non-scheduled trigger, an
 * unfiltered cross-check would see push runs the filtered side cannot, report a
 * newer completion on every poll, and land permanently in
 * `cross-check-disagreement` — i.e. suppress the alarm forever. It comes after
 * `read` so the existing positional call sites keep working; nothing about the
 * PEN-3379 corroboration property depends on the trigger axis.
 */
export function crossCheckCompletions(repo, workflow, read = gh, event = undefined) {
  try {
    const base = `repos/${repo}/actions/workflows/${workflow}/runs?per_page=${CROSS_CHECK_PAGE_SIZE}`;
    const raw = read(["api", event ? `${base}&event=${encodeURIComponent(event)}` : base]);
    return { newestCompletedAt: selectNewestCompleted(JSON.parse(raw).workflow_runs ?? []) };
  } catch {
    return { error: true };
  }
}

/**
 * Classifies every resolved guard entry, including the PEN-3379 cross-check
 * escalation.
 *
 * Extracted and exported ONLY so this line has a failing mutation. It is the
 * JOIN between producer and consumers — `resolveWatched()`'s `event` and
 * `graceUntil` handed to `observeWorkflow()`, `classifyGuard()` and the
 * cross-check — and while it lived inline in `main()` it was the last unguarded
 * link in the chain: dropping any of those fields left the whole suite green,
 * because `main()` is never invoked by a test and `observeWorkflow` was not
 * exported (BLO-38228). `observeWorkflow` now takes an injectable `read` and is
 * exported, so its own `event` leg is held directly too.
 *
 * `observe` and `crossCheck` are injected for exactly that reason: the join is
 * then testable without a network call, so every field is held by a behavioural
 * guard rather than a source-text regex. A regex would also have caught the
 * `observe` leg, but a regex on a destructure is what previously passed across
 * its own reversion — hold the behaviour instead.
 *
 * `crossCheck` MUST receive `event`. That leg came back from the PEN-3379 rebase
 * as the only one a test could not see, and its failure mode is the worst of the
 * three: an unfiltered cross-check against a filtered read disagrees on every
 * poll, so the guard lands permanently in `cross-check-disagreement` and the
 * alarm is muted forever rather than going red. Pulling it in here is what makes
 * that arm mutation-visible.
 */
export function classifyWatched(watched, observe, crossCheck, { now, overrideHours = null } = {}) {
  return watched.map(({ workflow, staleHours, event, graceUntil }) => {
    const effectiveStaleHours = overrideHours ?? staleHours;
    const options = { now, staleHours: effectiveStaleHours, graceUntil };
    const observation = observe(workflow, event);
    const first = classifyGuard(workflow, observation, options);

    // The cross-check is only worth a call once the cheap read has already
    // decided this guard looks stopped — the same "spend it only when it
    // matters" shape as countQueued. Re-classifying is a pure call on the
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

    return classifyGuard(workflow, { ...observation, crossCheck: crossCheck(workflow, event) }, options);
  });
}

/**
 * Binds `repo` to the two reads `classifyWatched` consumes.
 *
 * Exported for the same single reason `classifyWatched` is: to leave no
 * unguarded link. With the closures written inline in `main()`, dropping
 * `event` from the cross-check closure was the last mutation the suite could
 * not see — `main()` is never invoked by a test, so the whole chain was held
 * behaviourally right up to the line that assembles it. Here it is one exported
 * call away from a test.
 *
 * `read` is threaded to BOTH legs so each one's real URL is observable without
 * a network call. It used to reach only `crossCheckCompletions`; `observeWorkflow`
 * called `gh` directly, so dropping `event` from the observe closure below was a
 * mutation the suite could not see. The docstring here previously claimed that
 * leg was "held by `classifyWatched`'s injected-observer test instead" — that was
 * wrong and measured wrong: that test injects a FAKE observer, so it pins
 * `classifyWatched`'s call, never the adapter that forwards into the real
 * `observeWorkflow`. Both legs now have a failing mutation.
 */
export function makeGuardReaders(repo, read = gh) {
  return {
    observe: (workflow, event) => observeWorkflow(repo, workflow, read, event),
    crossCheck: (workflow, event) => crossCheckCompletions(repo, workflow, read, event),
  };
}

function main() {
  const repo = process.env.GUARD_LIVENESS_REPO || process.env.GITHUB_REPOSITORY || "Blockcast/paperclip";

  // An explicit override is a manual debugging dial (workflow_dispatch, or the
  // live checks in the PR). It deliberately applies to EVERY guard, flattening
  // the per-guard thresholds, so a dispatch at 1h reds the whole set on purpose.
  const override = process.env.GUARD_LIVENESS_STALE_HOURS;
  const overrideHours = override && String(override).trim() !== "" ? resolveStaleHours(override) : null;

  const watched = resolveWatched(process.env.GUARD_LIVENESS_WORKFLOWS, overrideHours);

  const now = Date.now();
  const { observe, crossCheck } = makeGuardReaders(repo);
  const results = classifyWatched(watched, observe, crossCheck, { now, overrideHours });

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

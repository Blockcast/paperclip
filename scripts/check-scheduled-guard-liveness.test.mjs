import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STALE_HOURS,
  EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS,
  WATCHED_GUARDS,
  WATCHED_WORKFLOWS,
  classifyGuard,
  classifyWatched,
  completedRunsPath,
  crossCheckCompletions,
  describeStopMode,
  makeGuardReaders,
  observeWorkflow,
  resolveStaleHours,
  resolveWatched,
  selectNewestCompleted,
  summarize,
} from "./check-scheduled-guard-liveness.mjs";

const HOUR = 3600_000;
const MINUTE = 60_000;

/** Shorthand for an active workflow whose newest completed run finished `agoMs` before `now`. */
function completedAgo(name, agoMs, { now, conclusion = "success" } = {}) {
  return {
    state: "active",
    name,
    newest: {
      updatedAt: new Date(now - agoMs).toISOString(),
      conclusion,
      htmlUrl: "https://github.com/Blockcast/paperclip/actions/runs/1",
    },
  };
}

/** Threshold a guard actually ships with, so tests never silently apply the hourly bar to all. */
function thresholdFor(workflow) {
  return WATCHED_GUARDS.find((guard) => guard.workflow === workflow)?.staleHours ?? DEFAULT_STALE_HOURS;
}

function classifyAll(observations, now) {
  return Object.entries(observations).map(([workflow, observation]) =>
    classifyGuard(workflow, observation, { now, staleHours: thresholdFor(workflow) }),
  );
}

describe("classifyGuard — liveness, not verdict", () => {
  const now = Date.parse("2026-09-15T09:45:00Z");

  it("passes a guard that completed within the threshold", () => {
    const result = classifyGuard("codeowners-guard.yml", completedAgo("CODEOWNERS Guard", 30 * MINUTE, { now }), {
      now,
    });

    assert.equal(result.status, "ok");
    assert.equal(result.ageMinutes, 30);
  });

  // The load-bearing design property. `ally-review-consistency` has 0 successes
  // in its last 100 runs (PEN-2847). An age-since-last-SUCCESS detector would
  // be born permanently red on this repo, reproducing inside the detector the
  // very defect it exists to fix. Liveness and verdict stay orthogonal: a guard
  // that runs and reports a real failure IS enforcing correctly.
  it("passes a recently-completed guard whose conclusion was failure", () => {
    const result = classifyGuard(
      "ally-review-consistency.yml",
      completedAgo("Ally Review Consistency Guard", 20 * MINUTE, { now, conclusion: "failure" }),
      { now },
    );

    assert.equal(result.status, "ok", "a failing-but-running guard must not trip the liveness alarm");
  });

  it("treats a cancelled or timed_out conclusion as evidence of execution", () => {
    for (const conclusion of ["cancelled", "timed_out", "neutral", null]) {
      const result = classifyGuard("review-gate-sweep.yml", completedAgo("x", 10 * MINUTE, { now, conclusion }), {
        now,
      });
      assert.equal(result.status, "ok", `conclusion=${conclusion} still means it ran`);
    }
  });
});

describe("classifyGuard — reconstruction of the 2026-09-15 outage (PEN-3281)", () => {
  // The condition that produced this row: the `arc-default` ARC listener was
  // gone (PEN-3272) and at detection time (09:45Z) nothing anywhere had gone red.
  //
  // Timings are the MEASURED ones, per guard, not a uniform stand-in. The six
  // hourly guards last completed ~03:41Z. The twice-daily
  // production-environment-protection-guard last completed 2026-09-14T20:59:31Z
  // and did not complete again until 14:41:55Z — a 17.71h gap, the widest in its
  // history bar one.
  const now = Date.parse("2026-09-15T09:45:00Z");
  const hourlyLastCompletion = "2026-09-15T03:41:00Z";
  const twiceDaily = "production-environment-protection-guard.yml";
  const twiceDailyLastCompletion = "2026-09-14T20:59:31Z";

  function observed(workflow) {
    return {
      state: "active",
      name: workflow.replace(/\.yml$/, ""),
      newest: {
        updatedAt: workflow === twiceDaily ? twiceDailyLastCompletion : hourlyLastCompletion,
        conclusion: "success",
        htmlUrl: "https://example.invalid/run",
      },
    };
  }

  // The cohort is PINNED to the seven guards watched on 2026-09-15, not read
  // from WATCHED_WORKFLOWS. This is a reconstruction of one past event: a guard
  // added later was not in that outage and cannot be reasoned about from it.
  // Driving it off the live set made the 7/6 counts below drift the moment
  // BLO-38228 added an eighth, on a lane that was not even starved that day.
  const PEN_3281_COHORT = [
    "review-gate-sweep.yml",
    "ally-review-consistency.yml",
    "codeowners-guard.yml",
    "relay-ssl-multicert-guard.yml",
    "lockfile-drift-monitor.yml",
    "adapter-pin-drift-monitor.yml",
    twiceDaily,
  ];

  const outage = Object.fromEntries(PEN_3281_COHORT.map((workflow) => [workflow, observed(workflow)]));

  it("reds the six hourly guards at detection time", () => {
    const results = classifyAll(outage, now);
    const summary = summarize(results);

    assert.equal(summary.checked, 7);
    assert.equal(summary.staleCount, 6);
    assert.equal(summary.exitCode, 1, "the detector must fail the job against the real condition");
    assert.match(summary.headline, /6 of 7 watched scheduled guard\(s\) have stopped executing/);
  });

  it("correctly leaves the twice-daily guard green at 09:45Z — 12.7h is inside its own bar", () => {
    // Honest about coverage rather than flattering: at detection time this guard
    // was genuinely within ordinary twice-daily jitter. Reporting it stale here
    // would be a false positive, and per-EVENT detection does not need it — the
    // six hourly legs already red.
    const result = classifyAll(outage, now).find((r) => r.workflow === twiceDaily);

    assert.equal(result.status, "ok");
    assert.ok(result.ageMinutes < 16 * 60);
  });

  it("reds the twice-daily guard later in the SAME outage, once it passes 16h", () => {
    // 20:59:31Z + 16h = 12:59:31Z, still inside the outage (which ran to 14:41Z).
    // So the 16h bar does catch this event on this leg — just later.
    const later = Date.parse("2026-09-15T13:30:00Z");
    const result = classifyAll(outage, later).find((r) => r.workflow === twiceDaily);

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    assert.match(result.detail, /past the 16h liveness threshold/);
  });

  it("reports the stop as `stopped` with the observed age, not a generic failure", () => {
    const [first] = classifyAll(outage, now);

    assert.equal(first.reason, "stopped");
    assert.equal(first.ageMinutes, 364);
    assert.match(first.detail, /last completed 6h ago/);
    assert.match(first.detail, new RegExp(`past the ${DEFAULT_STALE_HOURS}h liveness threshold`));
  });

  // Mutation check: the same guards, same code path, healthy timings. If this
  // went red too, the test above would prove nothing.
  it("stays green when the same guards are executing normally", () => {
    const healthy = Object.fromEntries(
      WATCHED_WORKFLOWS.map((workflow, i) => [
        workflow,
        completedAgo(workflow, (10 + i * 5) * MINUTE, { now }),
      ]),
    );

    const summary = summarize(classifyAll(healthy, now));
    assert.equal(summary.staleCount, 0);
    assert.equal(summary.exitCode, 0);
  });
});

describe("classifyGuard — the 165-minute threshold against measured gap distribution", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");

  // Ordinary cron jitter on this repo topped out at 118 min across all six
  // guards back to 2026-09-11. The threshold must clear that ceiling, or the
  // alarm gets muted — and a muted liveness alarm reproduces exactly the
  // failure mode it exists to prevent.
  it("does not fire at the observed jitter ceiling of 118 minutes", () => {
    const result = classifyGuard("review-gate-sweep.yml", completedAgo("x", 118 * MINUTE, { now }), { now });
    assert.equal(result.status, "ok");
  });

  it("fires just past the threshold and not just under it", () => {
    const under = classifyGuard("x.yml", completedAgo("x", DEFAULT_STALE_HOURS * HOUR - MINUTE, { now }), { now });
    const over = classifyGuard("x.yml", completedAgo("x", DEFAULT_STALE_HOURS * HOUR + MINUTE, { now }), { now });

    assert.equal(under.status, "ok");
    assert.equal(over.status, "stale");
  });

  // The band is (118, 213): above the jitter ceiling, below the shortest leg of
  // the outage cluster. 165 sits mid-band at 1.40x the ceiling. Asserted so a
  // later "let's relax it a bit" edit has to argue with the data.
  it("sits strictly inside the admissible band", () => {
    const bar = DEFAULT_STALE_HOURS * 60;
    assert.ok(bar > 118, `bar ${bar} must clear the 118-min jitter ceiling`);
    assert.ok(bar < 213, `bar ${bar} must sit under the 213-min shortest outage leg`);
  });

  const EVENT_2026_09_14_LEGS = [305, 291, 268, 254, 241, 213];

  it("is retrospectively over the bar on all six legs of the 2026-09-14 event", () => {
    const results = EVENT_2026_09_14_LEGS.map((minutes, index) =>
      classifyGuard(`leg-${index}.yml`, completedAgo(`leg-${index}`, minutes * MINUTE, { now }), { now }),
    );
    const summary = summarize(results);

    assert.equal(summary.staleCount, 6);
    assert.equal(summary.exitCode, 1);
  });

  // The number that actually decides coverage, and the reason 240 was wrong.
  // An HOURLY detector only samples once every 60 min, so a leg of length G is
  // catchable for G-bar minutes and only GUARANTEED to be sampled when
  // G - bar > 60. Retrospective "is it over the bar" flatters both bars; this
  // is the honest instrument.
  it("guarantees a catch on 5 of 6 legs at 165 min where 240 min guarantees 1", () => {
    const guaranteed = (bar) => EVENT_2026_09_14_LEGS.filter((leg) => leg - bar > 60).length;

    assert.equal(guaranteed(DEFAULT_STALE_HOURS * 60), 5);
    assert.equal(guaranteed(240), 1, "the shipped 240-min bar guaranteed a catch on one leg only");
  });
});

describe("classifyGuard — the four PEN-3379 production false positives", () => {
  // NOT a synthetic reconstruction. These are the four reds this detector
  // actually produced in production between 2026-09-18T06:59Z and 14:50Z, the
  // only four it had ever produced on the detection step — and all four were
  // wrong. `claimed` is the completion the filtered `status=completed&per_page=1`
  // read returned as [0]; `actual` is the completion that guard genuinely had,
  // 14-23 minutes before the red. Both guards ran every hour throughout and
  // read state=active.
  const FALSE_POSITIVES = [
    {
      redAt: "2026-09-18T06:59:00Z",
      workflow: "relay-ssl-multicert-guard.yml",
      name: "Relay SSL Multicert",
      claimed: "2026-09-12T04:32:39Z",
      actual: "2026-09-18T06:42:30Z",
    },
    {
      redAt: "2026-09-18T08:52:00Z",
      workflow: "ally-review-consistency.yml",
      name: "Ally Review Consistency",
      claimed: "2026-09-12T04:35:43Z",
      actual: "2026-09-18T08:38:43Z",
    },
    {
      redAt: "2026-09-18T10:51:00Z",
      workflow: "relay-ssl-multicert-guard.yml",
      name: "Relay SSL Multicert",
      claimed: "2026-09-12T04:32:39Z",
      actual: "2026-09-18T10:27:48Z",
    },
    {
      redAt: "2026-09-18T14:50:00Z",
      workflow: "relay-ssl-multicert-guard.yml",
      name: "Relay SSL Multicert",
      claimed: "2026-09-12T04:32:39Z",
      actual: "2026-09-18T14:32:34Z",
    },
  ];

  /** The stale-index observation as the detector saw it, with the cross-check attached. */
  function staleIndexObservation({ name, claimed, actual }) {
    return {
      state: "active",
      name,
      newest: {
        updatedAt: claimed,
        conclusion: "success",
        htmlUrl: "https://github.com/Blockcast/paperclip/actions/runs/1",
      },
      crossCheck: { newestCompletedAt: actual },
    };
  }

  // The positive control. Without the cross-check this fixture MUST still red,
  // or the test proves nothing about the fix — it would pass just as happily
  // against a classifier that never reds at all.
  it("reproduces all four reds when the cross-check is absent (shipped behaviour)", () => {
    for (const fixture of FALSE_POSITIVES) {
      const { crossCheck, ...withoutCrossCheck } = staleIndexObservation(fixture);
      const result = classifyGuard(fixture.workflow, withoutCrossCheck, {
        now: Date.parse(fixture.redAt),
        staleHours: thresholdFor(fixture.workflow),
      });

      assert.equal(result.status, "stale", `${fixture.workflow} @ ${fixture.redAt}`);
      assert.equal(result.reason, "stopped");
      assert.ok(result.ageMinutes > 140 * 60, "the fixture really does carry the ~6-day bogus age");
    }
  });

  it("suppresses all four once the unfiltered cross-check contradicts the index", () => {
    for (const fixture of FALSE_POSITIVES) {
      const result = classifyGuard(fixture.workflow, staleIndexObservation(fixture), {
        now: Date.parse(fixture.redAt),
        staleHours: thresholdFor(fixture.workflow),
      });

      assert.equal(result.status, "unknown", `${fixture.workflow} @ ${fixture.redAt} must not red`);
      assert.equal(result.reason, "cross-check-disagreement");
      // Re-aged against the completion that really happened: 14-23 min, not ~150h.
      assert.ok(result.ageMinutes < 30, `re-aged to ${result.ageMinutes}m against the real completion`);
    }
  });

  it("reports the whole set as zero stale and exits 0", () => {
    // Each fixture is classified at its own redAt. Its `actual` is the guard's
    // newest completion AT THAT MOMENT; at a later `now` the unfiltered read
    // would return a later completion (both guards ran hourly), so replaying an
    // early `actual` hours later feeds the classifier a read that cannot occur
    // and, now that the cross-check is aged too, would red correctly.
    const summary = summarize(
      FALSE_POSITIVES.map((fixture) =>
        classifyGuard(fixture.workflow, staleIndexObservation(fixture), {
          now: Date.parse(fixture.redAt),
          staleHours: thresholdFor(fixture.workflow),
        }),
      ),
    );

    assert.equal(summary.staleCount, 0);
    assert.equal(summary.exitCode, 0, "not one of these four may exit non-zero");
    // Suppressed is not healthy: the headline must not claim they completed.
    assert.equal(summary.unknownCount, FALSE_POSITIVES.length);
    assert.doesNotMatch(summary.headline, /^All \d+ watched/);
    assert.match(summary.headline, /could not be assessed/);
  });

  // The other half of the contract. Suppression must be driven by DISAGREEMENT,
  // not by the cross-check existing — otherwise the fix mutes the detector and
  // reproduces PEN-3281 by a different route.
  it("still reds a genuinely stopped guard when both reads agree", () => {
    const now = Date.parse("2026-09-18T14:50:00Z");
    const result = classifyGuard(
      "relay-ssl-multicert-guard.yml",
      {
        state: "active",
        name: "Relay SSL Multicert",
        newest: { updatedAt: "2026-09-12T04:32:39Z", conclusion: "success", htmlUrl: "https://x" },
        // The unfiltered read corroborates: nothing newer has completed.
        crossCheck: { newestCompletedAt: "2026-09-12T04:32:39Z" },
      },
      { now, staleHours: thresholdFor("relay-ssl-multicert-guard.yml") },
    );

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
  });

  it("still reds a stopped guard when the cross-check is newer but also past the bar", () => {
    // A one-second index lag puts a dead guard in the disagreement branch. The
    // newer read refutes the age, not staleness, so it must be aged too.
    const now = Date.parse("2026-09-24T12:00:00Z");
    const result = classifyGuard(
      "relay-ssl-multicert-guard.yml",
      {
        state: "active",
        name: "Relay SSL Multicert",
        newest: { updatedAt: "2026-09-14T04:00:00Z", conclusion: "success", htmlUrl: "https://x" },
        crossCheck: { newestCompletedAt: "2026-09-14T04:00:01Z" },
      },
      { now, staleHours: thresholdFor("relay-ssl-multicert-guard.yml") },
    );

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    assert.match(result.detail, /2026-09-14T04:00:01Z/);
  });

  // Exactly ON the bar is past it (`>=`): 12:05Z -> 14:50Z is 165m against the
  // 2.75h threshold. `>` in place of `>=` turns this stop into a suppression.
  it("still reds a stopped guard whose newer cross-check sits exactly on the bar", () => {
    const now = Date.parse("2026-09-18T14:50:00Z");
    const result = classifyGuard(
      "relay-ssl-multicert-guard.yml",
      {
        state: "active",
        name: "Relay SSL Multicert",
        newest: { updatedAt: "2026-09-18T11:00:00Z", conclusion: "success", htmlUrl: "https://x" },
        crossCheck: { newestCompletedAt: "2026-09-18T12:05:00Z" },
      },
      { now, staleHours: thresholdFor("relay-ssl-multicert-guard.yml") },
    );

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    assert.match(result.detail, /2026-09-18T12:05:00Z/);
  });

  // Absence of corroboration is not agreement. A permanently failing second
  // read must not become a mute switch.
  it("leaves the red standing, annotated, when the cross-check cannot be read", () => {
    const now = Date.parse("2026-09-18T14:50:00Z");
    const result = classifyGuard(
      "relay-ssl-multicert-guard.yml",
      {
        state: "active",
        name: "Relay SSL Multicert",
        newest: { updatedAt: "2026-09-12T04:32:39Z", conclusion: "success", htmlUrl: "https://x" },
        crossCheck: { error: true },
      },
      { now, staleHours: thresholdFor("relay-ssl-multicert-guard.yml") },
    );

    assert.equal(result.status, "stale");
    assert.match(result.detail, /cross-check read could not be made/);
  });
});

describe("selectNewestCompleted — the cross-check must not become a mute switch", () => {
  /**
   * An unfiltered run page as the API returns it: ordered by `created_at` DESC,
   * mixing queued/in-progress entries in with completed ones.
   */
  function page(...runs) {
    return runs.map(([createdAt, updatedAt, status]) => ({
      created_at: createdAt,
      updated_at: updatedAt,
      status,
    }));
  }

  // THE failure this selection exists to avoid, and the one a `max(updated_at)`
  // implementation gets wrong. The guard genuinely stopped on 09-12. Someone
  // then re-ran an ancient run — the ordinary triage reflex on a stalled guard —
  // which bumped that entry's `updated_at` to 09-18 WITHOUT moving its
  // `created_at`, so it stays near the bottom of the page.
  //
  // `max(updated_at)` reads 09-18, contradicts the filtered read, and suppresses
  // the alarm: a mute, co-located with the outage it would hide. Taking the
  // first completed entry in `created_at` order cannot be fooled this way.
  it("takes the newest-CREATED completion, not the largest updated_at", () => {
    const observed = selectNewestCompleted(
      page(
        ["2026-09-12T04:32:39Z", "2026-09-12T04:32:39Z", "completed"],
        ["2026-09-12T03:31:12Z", "2026-09-12T03:33:40Z", "completed"],
        // The re-run: ancient created_at, fresh updated_at.
        ["2026-09-06T11:20:00Z", "2026-09-18T14:00:00Z", "completed"],
      ),
    );

    assert.equal(observed, "2026-09-12T04:32:39.000Z");
    assert.notEqual(observed, "2026-09-18T14:00:00.000Z", "a re-run of an old run is not a fresh completion");
  });

  it("drives that page through the classifier without suppressing a real outage", () => {
    const result = classifyGuard(
      "relay-ssl-multicert-guard.yml",
      {
        state: "active",
        name: "Relay SSL Multicert",
        newest: { updatedAt: "2026-09-12T04:32:39Z", conclusion: "success", htmlUrl: "https://x" },
        crossCheck: {
          newestCompletedAt: selectNewestCompleted(
            page(
              ["2026-09-12T04:32:39Z", "2026-09-12T04:32:39Z", "completed"],
              ["2026-09-06T11:20:00Z", "2026-09-18T14:00:00Z", "completed"],
            ),
          ),
        },
      },
      {
        now: Date.parse("2026-09-18T14:50:00Z"),
        staleHours: thresholdFor("relay-ssl-multicert-guard.yml"),
      },
    );

    assert.equal(result.status, "stale", "a re-run must not demote a genuine outage to unknown");
    assert.equal(result.reason, "stopped");
  });

  // The other direction: the four real false positives must still be suppressed
  // when the cross-check is derived from a PAGE rather than handed in ready-made.
  it("still recovers the real completion behind each PEN-3379 false positive", () => {
    const observed = selectNewestCompleted(
      page(
        ["2026-09-18T06:31:02Z", "2026-09-18T06:42:30Z", "completed"],
        ["2026-09-18T05:30:55Z", "2026-09-18T05:33:10Z", "completed"],
      ),
    );

    assert.equal(observed, "2026-09-18T06:42:30.000Z", "the completion the filtered index failed to return");
  });

  it("skips queued and in-progress entries sitting above the newest completion", () => {
    const observed = selectNewestCompleted(
      page(
        ["2026-09-22T07:31:00Z", "2026-09-22T07:31:00Z", "queued"],
        ["2026-09-22T06:43:09Z", "2026-09-22T06:44:10Z", "in_progress"],
        ["2026-09-22T05:28:10Z", "2026-09-22T05:30:01Z", "completed"],
      ),
    );

    assert.equal(observed, "2026-09-22T05:30:01.000Z");
  });

  it("returns null when the page holds no completed run at all", () => {
    assert.equal(selectNewestCompleted(page(["2026-09-22T07:31:00Z", "2026-09-22T07:31:00Z", "queued"])), null);
    assert.equal(selectNewestCompleted([]), null);
    assert.equal(selectNewestCompleted(undefined), null);
  });

  // Null withholds corroboration, which leaves the red STANDING. Falling through
  // to an older run instead would answer a different question than the one asked.
  it("returns null rather than an older run when the newest completion will not parse", () => {
    const observed = selectNewestCompleted(
      page(
        ["2026-09-12T04:32:39Z", "not-a-timestamp", "completed"],
        ["2026-09-12T03:31:12Z", "2026-09-12T03:33:40Z", "completed"],
      ),
    );

    assert.equal(observed, null);
  });
});

describe("crossCheckCompletions — the corroborating read's own failure modes", () => {
  const reader = (payload) => () => JSON.stringify(payload);

  it("asks for the unfiltered, workflow-scoped page, not the index it corroborates", () => {
    const calls = [];
    crossCheckCompletions("Blockcast/paperclip", "relay-ssl-multicert-guard.yml", (args) => {
      calls.push(args);
      return JSON.stringify({ workflow_runs: [] });
    });

    assert.equal(calls.length, 1);
    // Workflow-scoped: a repo-wide page is always fresh ordinary CI, which
    // would mute every guard forever at exit 0.
    assert.match(
      calls[0][1],
      /^repos\/Blockcast\/paperclip\/actions\/workflows\/relay-ssl-multicert-guard\.yml\/runs\?per_page=30$/,
    );
    // Not redundant with the anchored match above: this is the one that names
    // the property. Without `status=completed` this read is a second opinion;
    // with it, it is a re-read of the index PEN-3379 found wedged, and it
    // agrees with the primary by construction.
    assert.doesNotMatch(calls[0][1], /status=/);
  });

  it("reports the newest completion from an unfiltered page", () => {
    const observed = crossCheckCompletions(
      "Blockcast/paperclip",
      "relay-ssl-multicert-guard.yml",
      reader({
        workflow_runs: [
          { created_at: "2026-09-18T06:31:02Z", updated_at: "2026-09-18T06:42:30Z", status: "completed" },
          { created_at: "2026-09-18T05:30:55Z", updated_at: "2026-09-18T05:33:10Z", status: "completed" },
        ],
      }),
    );

    assert.deepEqual(observed, { newestCompletedAt: "2026-09-18T06:42:30.000Z", allCount: null });
  });

  it("reports null — not an error — when the page genuinely holds no completed run", () => {
    const observed = crossCheckCompletions(
      "Blockcast/paperclip",
      "relay-ssl-multicert-guard.yml",
      reader({ workflow_runs: [{ created_at: "2026-09-22T07:31:00Z", updated_at: "2026-09-22T07:31:00Z", status: "queued" }] }),
    );

    // Distinct from {error: true}: this is a successful read that found
    // nothing, which is evidence. An error is the absence of evidence.
    // `allCount: null` is the same distinction one field over — the body
    // carried no `total_count`, so the cardinality check has nothing to weigh
    // and must not invent a number for it (BLO-38286).
    assert.deepEqual(observed, { newestCompletedAt: null, allCount: null });
  });

  it("reports {error: true} when the read throws, so the red is left standing", () => {
    const observed = crossCheckCompletions("Blockcast/paperclip", "relay-ssl-multicert-guard.yml", () => {
      throw new Error("gh: API rate limit exceeded");
    });

    // THE branch that decides whether a broken second read degrades to "no
    // corroboration, red stands" or becomes a mute switch. classifyGuard only
    // suppresses on `!error && newestCompletedAt`, so `{error: true}` must not
    // be confused with either a null or a timestamp.
    assert.deepEqual(observed, { error: true });
    assert.equal(observed.newestCompletedAt, undefined);
  });

  it("reports {error: true} on a malformed body rather than throwing out of the run", () => {
    const observed = crossCheckCompletions(
      "Blockcast/paperclip",
      "relay-ssl-multicert-guard.yml",
      () => "<html>502 Bad Gateway</html>",
    );

    assert.deepEqual(observed, { error: true });
  });

  it("tolerates a well-formed body with no workflow_runs key", () => {
    const observed = crossCheckCompletions("Blockcast/paperclip", "relay-ssl-multicert-guard.yml", reader({}));

    assert.deepEqual(observed, { newestCompletedAt: null, allCount: null });
  });
});

describe("classifyGuard — 'never completed' rests on the same distrusted index", () => {
  const now = Date.parse("2026-09-18T14:50:00Z");
  const staleHours = 2.75;

  function neverCompleted(crossCheck) {
    return classifyGuard(
      "relay-ssl-multicert-guard.yml",
      { state: "active", name: "Relay SSL Multicert", newest: null, crossCheck },
      { now, staleHours },
    );
  }

  it("still reds when the cross-check agrees there is no completed run", () => {
    const result = neverCompleted({ newestCompletedAt: null });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "never-completed");
  });

  it("still reds when no cross-check was supplied at all", () => {
    const result = neverCompleted(undefined);

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "never-completed");
  });

  it("still reds when the cross-check could not be read — absence is not agreement", () => {
    const result = neverCompleted({ error: true });

    assert.equal(result.status, "stale", "an unreadable second read must not mute the alarm");
    assert.equal(result.reason, "never-completed");
  });

  it("suppresses when the unfiltered read finds any completion — 'never' is then a fiction", () => {
    const result = neverCompleted({ newestCompletedAt: "2026-09-18T14:32:34Z" });

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "cross-check-disagreement");
    assert.match(result.detail, /NOT being\s+asserted to have stopped/);
  });

  // "Never completed" is refuted by ANY completion, however old. But refuting
  // "never" does not establish "alive": the cross-check timestamp is aged
  // against staleHours, and a six-day-old completion is a stopped guard, not a
  // disagreement to suppress. The empty filtered page must not mute a dead guard.
  it("reds as stopped, citing the cross-check timestamp, when the only completion is past the bar; refuting 'never' does not establish 'alive'", () => {
    const result = neverCompleted({ newestCompletedAt: "2026-09-12T04:32:39Z" });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    // 2026-09-12T04:32:39Z -> 2026-09-18T14:50:00Z is 6d 10h 17m 21s = 9257m (floored).
    assert.equal(result.ageMinutes, 9257);
    assert.match(result.detail, /2026-09-12T04:32:39Z/);
    assert.match(result.detail, /past the 2\.75h liveness threshold/);
    assert.equal(result.lastRunUrl, null);
  });

  // Inside the bar by one minute: 2h44m against a 2h45m threshold still reads
  // as a disagreement, not a stop.
  it("still suppresses when the cross-check completion sits just inside the bar", () => {
    const result = neverCompleted({ newestCompletedAt: "2026-09-18T12:06:00Z" });

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "cross-check-disagreement");
  });

  // The other side of that minute: EXACTLY on the bar (12:05Z, 165m) is past it,
  // a stop and not a suppression. `<=` in place of `<` mutes it.
  it("reds as stopped when the cross-check completion sits exactly on the bar", () => {
    const result = neverCompleted({ newestCompletedAt: "2026-09-18T12:05:00Z" });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    assert.equal(result.ageMinutes, 165);
  });

  // A present-but-unparsable timestamp is not corroboration. It falls through to
  // the red rather than being read as either fresh or stale.
  it("falls through to never-completed when the cross-check timestamp is present but unparsable", () => {
    const result = neverCompleted({ newestCompletedAt: "not-a-timestamp" });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "never-completed");
  });

  it("annotates the never-completed red when the cross-check could not be read", () => {
    const result = neverCompleted({ error: true });

    assert.match(result.detail, /cross-check read could not be made/);
  });
});

describe("classifyGuard — stop-modes a run-state scan cannot see", () => {
  const now = Date.parse("2026-09-15T09:45:00Z");

  // The reason this is age-based and not a `queued` scan. A disabled workflow
  // has no stuck run to find; it simply stopped, with a recent clean history.
  it("reds a disabled workflow even though its last run was minutes ago", () => {
    const result = classifyGuard(
      "codeowners-guard.yml",
      { state: "disabled_inactivity", name: "CODEOWNERS Guard" },
      { now },
    );

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "disabled");
    assert.match(result.detail, /disabled_inactivity/);
  });

  it("reds an active workflow that has never completed", () => {
    const result = classifyGuard("new-guard.yml", { state: "active", name: "New Guard", newest: null }, { now });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "never-completed");
  });

  // A newly-scheduled workflow has zero completed runs at merge by construction
  // — schedules fire only from the default branch — so without a grace it reds
  // the shared hourly job until its first cron. The alarm this guard reports
  // into is all-or-nothing, so a red-by-design window trains everyone to ignore
  // a real stall in the other seven guards.
  it("graces a never-completed guard inside its window, and only that reason", () => {
    const never = { state: "active", name: "Master Health", newest: null };
    const graceUntil = new Date(now + HOUR).toISOString();

    const inside = classifyGuard("master-health.yml", never, { now, graceUntil });
    assert.equal(inside.status, "ok");
    assert.equal(inside.reason, "awaiting-first-run");

    // Fail-closed: the grace expires into a hard red, never into a silent green.
    const expired = classifyGuard("master-health.yml", never, {
      now,
      graceUntil: new Date(now - HOUR).toISOString(),
    });
    assert.equal(expired.status, "stale");
    assert.equal(expired.reason, "never-completed");

    // The grace covers the bootstrap only. Every reason decided on real
    // evidence must survive it, or it becomes a blanket mute.
    const disabled = classifyGuard(
      "master-health.yml",
      { state: "disabled_manually", name: "Master Health" },
      { now, graceUntil },
    );
    assert.equal(disabled.status, "stale");
    assert.equal(disabled.reason, "disabled");

    const stale = classifyGuard(
      "master-health.yml",
      { state: "active", name: "Master Health", newest: { updatedAt: new Date(now - 100 * HOUR).toISOString(), conclusion: "success" } },
      { now, graceUntil, staleHours: 48 },
    );
    assert.equal(stale.status, "stale");

    const unreadable = classifyGuard("master-health.yml", { error: "unreadable" }, { now, graceUntil });
    assert.equal(unreadable.status, "stale");
    assert.equal(unreadable.reason, "unreadable");
  });

  // The window must outlive the merge that introduces the schedule, or it buys
  // nothing; and it must not be open-ended, or the guard never starts enforcing.
  it("sets the grace window past the first cron after merge, and not far past it", () => {
    const grace = Date.parse(
      WATCHED_GUARDS.find((guard) => guard.workflow === "master-health.yml").graceUntil,
    );

    assert.ok(grace > Date.parse("2026-10-01T00:37:00Z"), "expires before master-health's first cron can fire");
    assert.ok(grace < Date.parse("2026-10-05T00:00:00Z"), "an open-ended grace is a permanently muted guard");
  });

  // Silently dropping a guard from the watched set is this row's whole defect,
  // so an unreadable workflow must fail loudly rather than skip.
  it("reds an unreadable workflow rather than skipping it", () => {
    const result = classifyGuard("renamed.yml", { error: "unreadable" }, { now });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "unreadable");
  });

  it("reds unreadable run history — an API error must not read as health", () => {
    const result = classifyGuard("x.yml", { error: "runs-unreadable", state: "active", name: "X" }, { now });

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "runs-unreadable");
  });

  it("surfaces an unparsable timestamp as unknown without counting it stale", () => {
    const result = classifyGuard(
      "x.yml",
      { state: "active", name: "X", newest: { updatedAt: "not-a-date", conclusion: "success" } },
      { now },
    );

    assert.equal(result.status, "unknown");
    assert.equal(summarize([result]).exitCode, 0, "an unreadable clock is not proof of a stopped guard");
  });
});

describe("describeStopMode", () => {
  it("points at the runner lane when runs are piled up in queued", () => {
    assert.match(describeStopMode(38), /38 run\(s\) are sitting in 'queued'/);
    assert.match(describeStopMode(38), /PEN-3272/);
  });

  it("points at the schedule when nothing is queued either", () => {
    assert.match(describeStopMode(0), /the schedule itself is not producing runs/);
  });

  it("states the stop-mode is undetermined when the count could not be read", () => {
    assert.match(describeStopMode(null), /undetermined/);
  });
});

describe("WATCHED_GUARDS is checked against the repo, not against memory", () => {
  // Residual #2. The watched set used to be an explicit list justified by "the
  // list is short and the failure is loud". That reasoning was wrong in a way
  // this test caught the moment it was written: the set had been transcribed
  // from the six workflows PEN-3281 happened to name, and
  // production-environment-protection-guard — a security control on the same
  // starvable lane — had never been in it.
  //
  // Enumerating the repo rather than trusting the list means drift fails here,
  // in the PR that introduces it, instead of silently at 03:00.
  const workflowDir = resolve(dirname(fileURLToPath(import.meta.url)), "../.github/workflows");

  /** Every scheduled workflow in the repo, whatever lane it runs on. */
  function scheduledWorkflows() {
    return readdirSync(workflowDir)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .filter((file) => /^\s*schedule:\s*$/m.test(readFileSync(join(workflowDir, file), "utf8")))
      .sort();
  }

  /** Every workflow that is BOTH scheduled and on the starvable `default` lane. */
  function scheduledDefaultWorkflows() {
    return scheduledWorkflows().filter((file) =>
      /^\s*runs-on:\s*default\s*$/m.test(readFileSync(join(workflowDir, file), "utf8")),
    );
  }

  it("finds the scheduled default-lane workflows it is supposed to be reasoning about", () => {
    // Positive control: a silently-empty scan would make every assertion below
    // vacuously pass, which is this row's own failure mode in miniature.
    const found = scheduledDefaultWorkflows();
    assert.ok(
      found.length >= 7,
      `expected to find the scheduled default-lane workflows, got ${found.length}: ${found.join(", ")}`,
    );
    assert.ok(found.includes("codeowners-guard.yml"), "known member missing — the scan is broken");
  });

  // Regression, review finding on 7bc9e6737. The per-guard thresholds are real
  // in the script but were unreachable in production: this workflow set
  // `GUARD_LIVENESS_STALE_HOURS: ${{ inputs.stale_hours || '4' }}` with a
  // declared `default: "4"`, and main() treats ANY non-blank value as the
  // flatten-every-guard override. So `production-environment-protection-guard`
  // ran against 4h instead of its declared 16h on every invocation path, going
  // red 16 of 24 hours a day while behaving perfectly.
  //
  // The defect is in the YAML wiring, so a script-level test cannot see it —
  // this asserts against the workflow file itself.
  it("does not hand the script a non-blank stale-hours default, which would flatten every per-guard threshold", () => {
    const body = readFileSync(join(workflowDir, "scheduled-guard-liveness.yml"), "utf8");

    // Positive control: a renamed file or changed key would otherwise make both
    // assertions below vacuously pass.
    assert.match(body, /GUARD_LIVENESS_STALE_HOURS:/, "env key missing — this test is no longer reading what it thinks");
    assert.match(body, /stale_hours:/, "input key missing — this test is no longer reading what it thinks");

    const envLine = body.split("\n").find((line) => line.includes("GUARD_LIVENESS_STALE_HOURS:"));
    assert.equal(
      /\|\||&&|'\d|"\d/.test(envLine),
      false,
      `stale-hours env must pass the input through unchanged, got: ${envLine.trim()}`,
    );

    const inputDefault = /stale_hours:[\s\S]*?^\s*default:\s*(.+)$/m.exec(body);
    assert.ok(inputDefault, "stale_hours input has no default: line to check");
    assert.match(
      inputDefault[1].trim(),
      /^(""|'')$/,
      `stale_hours default must be blank so the script's per-guard thresholds stand, got: ${inputDefault[1].trim()}`,
    );
  });

  it("watches or explicitly exempts every scheduled workflow on the default lane", () => {
    const accounted = new Set([
      ...WATCHED_WORKFLOWS,
      ...EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS.map((entry) => entry.workflow),
    ]);
    const unaccounted = scheduledDefaultWorkflows().filter((file) => !accounted.has(file));

    assert.deepEqual(
      unaccounted,
      [],
      "a scheduled guard on the starvable `default` lane is neither watched nor exempted. Add it " +
        "to WATCHED_GUARDS with a threshold derived from its own cadence, or to " +
        "EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS with a reason.",
    );
  });

  it("does not watch a workflow that has stopped being a scheduled guard", () => {
    // Scoped to `scheduledWorkflows()`, not the `default`-lane subset. The
    // COVERAGE invariant above is deliberately lane-scoped — it asks which
    // guards MUST be watched, and starvation is a `default`-lane property. This
    // one asks whether a watched entry is still a live scheduled workflow, and
    // that is lane-independent: BLO-38228 added master-health.yml, which runs on
    // arc-light/arc-paperclip-general. Keeping the lane filter here would have
    // red-flagged a perfectly live entry as dangling.
    const live = new Set(scheduledWorkflows());
    const dangling = WATCHED_WORKFLOWS.filter((file) => !live.has(file));

    assert.deepEqual(
      dangling,
      [],
      "a watched entry no longer resolves to a scheduled workflow. At runtime this reds " +
        "as 'unreadable', which is correct but late — fix the entry here.",
    );
  });

  // BLO-38228. A guard reachable by an AUTO-FIRING non-schedule trigger needs
  // `event: "schedule"`, or its newest-run query is satisfied by those runs
  // while the cron is dead — reporting ok forever. master-health.yml is the
  // first such guard: it also runs on every push to master.
  //
  // `workflow_dispatch` is deliberately NOT in this list, and that is a stated
  // exposure rather than an oversight. All seven pre-existing guards carry it,
  // and a dispatch does bump the newest-run timestamp — so a manual dispatch
  // can mask a dead cron for one threshold window. It is accepted because a
  // dispatch is human-initiated and rare, where a push to master is neither;
  // and because narrowing those seven to `event: "schedule"` would invalidate
  // the gap distributions their thresholds were measured from, which is a
  // change to a live security control and not this row's to make.
  it("declares an event filter for every watched guard with an auto-firing non-schedule trigger", () => {
    const missing = WATCHED_GUARDS.filter((guard) => {
      const body = readFileSync(join(workflowDir, guard.workflow), "utf8");
      const autoTrigger = /^\s*(push|pull_request|pull_request_target|workflow_call|workflow_run|merge_group|issue_comment|repository_dispatch|release):/m.test(
        body,
      );
      return autoTrigger && guard.event !== "schedule";
    }).map((guard) => guard.workflow);

    assert.deepEqual(
      missing,
      [],
      "a watched guard has a non-schedule trigger but no `event: \"schedule\"`. Its liveness " +
        "check would be satisfied by those runs while the cron is dead, which is a muted alarm " +
        "dressed as a green one. Add the filter in WATCHED_GUARDS.",
    );

    // Positive control: a silently-empty scan makes the assertion vacuous, which
    // is this file's own recurring failure mode.
    assert.ok(
      WATCHED_GUARDS.some((guard) => guard.event === "schedule"),
      "no watched guard declares an event filter — the scan above proves nothing",
    );
  });

  // A YAML block scalar (`if: >-`) carries one logical expression across several
  // physical lines, so a line-anchored scan sees the `if:` token and the
  // `pretested` reference as unrelated lines and matches neither — the gate goes
  // unguarded on a reformat alone. Join the continuations back before scanning.
  //
  // Not a YAML parser by choice: `scripts/check-workflows-parse.mjs` records the
  // standing decision that this validator stays Node-builtins-only, because
  // adding `js-yaml` would change `pnpm-lock.yaml` and the `Block manual
  // lockfile edits` gate rejects that.
  //
  // ponytail: this joins BLOCK scalars (`>`/`|`) only, and treats a blank line as
  // closing one where real YAML would not. Two known gaps, both MEASURED at this
  // SHA rather than reasoned about — and note which arm each actually lands in,
  // because the obvious guess is wrong for both:
  //
  //   blank line inside a folded block   -> `unbypassed`, NOT `unscannable`. The
  //     blank closes the scalar, so line 1 still joins to `if: >- ${{ … pretested
  //     != '1'` — it matches `/^\s*if:/` and carries the token, it is just
  //     truncated before the bypass clause. A located gate, read short.
  //   plain (unquoted) multi-line scalar -> `unbypassed` too, because nothing
  //     joins it. If the bypass sits on the continuation line this is a FALSE
  //     RED, and the message will assert the clause is missing when it is
  //     present. Recognise that message; do not trust it.
  //
  // Both fail loudly and neither can pass clean, which is why this is a named
  // ceiling and not a fix: closing them needs the real YAML parser the paragraph
  // above rules out. Upgrade to real scalar tracking only if one of these ever
  // fires on a real reformat — and when you do, the two ceiling cases in "the
  // bypass scan itself" will fail, which is how you learn the prose here is now
  // stale rather than discovering it from a wrong hint during an outage.
  const joinFoldedIfs = (body) => {
    const joined = [];
    let openAt = null;
    for (const line of body.split("\n")) {
      const indent = line.search(/\S/);
      if (openAt !== null && indent > openAt) {
        joined[joined.length - 1] += ` ${line.trim()}`;
        continue;
      }
      openAt = /^\s*if:\s*[>|][-+]?\s*$/.test(line) ? indent : null;
      joined.push(line);
    }
    return joined;
  };

  // `unbypassed` — a gate the scheduled run would skip. `unscannable` — a body
  // that mentions the output but whose gate this scan could not locate, which
  // would otherwise report as zero violations.
  const auditPretestedBypass = (guards) => {
    const scanned = guards.map(({ workflow, body }) => ({
      workflow,
      ifs: joinFoldedIfs(body).filter(
        (line) => /^\s*if:/.test(line) && line.includes("needs.gate.outputs.pretested"),
      ),
    }));
    const missingBypass = ({ ifs }) =>
      ifs.some((line) => !line.includes("github.event_name == 'schedule'"));
    return {
      unscannable: scanned.filter(({ ifs }) => ifs.length === 0).map(({ workflow }) => workflow),
      unbypassed: scanned.filter(missingBypass).map(({ workflow }) => workflow),
    };
  };

  // The bypass this PR calls "the load-bearing half of that fix" had NO guard at
  // any level, and — unlike every other regression in this file — the runtime
  // guard cannot catch it either. That asymmetry is the whole reason it needs a
  // source-text assertion:
  //
  //   Delete the `schedule:` cron  -> no scheduled run completes -> this guard
  //                                   reds after 48h. Defence in depth, working.
  //   Delete the BYPASS            -> the scheduled run still fires, `gate` still
  //                                   sets pretested=1, the matrix is SKIPPED, and
  //                                   a skipped matrix still concludes `success`.
  //                                   The liveness guard sees a fresh completed
  //                                   `schedule` run and reports ok forever.
  //
  // That second row is run 36648202266 reproduced exactly — the specific false
  // green cited in master-health.yml's own header. So the half that fails loudly
  // was guarded and the half that fails SILENTLY was not, which inverts the
  // priority this file is supposed to apply.
  //
  // ON THE INSTRUMENT: this file's general doctrine is "hold the behaviour, not
  // the source text" (a regex on a destructure is what previously passed across
  // its own reversion). The doctrine does not apply here, because a YAML `if:`
  // expression has no behavioural surface a node test can drive — there is no
  // behaviour to hold. A source-text scan is the only available guard, and the
  // vacuity control below is what makes it trustworthy rather than decorative.
  it("keeps the schedule bypass on every pretested gate in a watched guard", () => {
    const gated = WATCHED_GUARDS.map((guard) => ({
      workflow: guard.workflow,
      body: readFileSync(join(workflowDir, guard.workflow), "utf8"),
    })).filter(({ body }) => /needs\.gate\.outputs\.pretested/.test(body));

    const { unscannable, unbypassed } = auditPretestedBypass(gated);

    // Checked BEFORE the bypass assertion, because a scan that located no gate
    // reports zero violations — the silent green this whole test exists to
    // prevent, one level down. The body-level `gated` filter cannot see it: the
    // body still contains the string, so the file still looks audited.
    assert.deepEqual(
      unscannable,
      [],
      "a watched guard mentions `needs.gate.outputs.pretested` but this scan found no `if:` " +
        "carrying it, so the bypass assertion below would pass vacuously. Either the gate moved " +
        "into a form the scan cannot read, or the output was renamed and only the prose kept the " +
        "old name. Fix the scan — do not delete this control.",
    );

    assert.deepEqual(
      unbypassed,
      [],
      "a watched guard gates a job on `needs.gate.outputs.pretested` without " +
        "`github.event_name == 'schedule'` in the same `if:`. The scheduled run then skips that " +
        "job, a skipped job still concludes `success`, and THIS liveness check reads that as a " +
        "healthy guard forever. The cron half of the fix reds in 48h; this half never does.",
    );

    // Positive control: if no watched guard has a pretested gate at all, the
    // filter above is empty and the assertion proves nothing. That silent-vacuity
    // shape is this file's own recurring failure mode.
    assert.ok(
      gated.length > 0,
      "no watched guard carries a pretested gate — the scan above proves nothing",
    );
  });

  // The scan above is driven by fixtures here as well as by the real file,
  // because the real file is in exactly one state at a time — so a guard held
  // only against it has no failing mutation, and is a comment rather than a test.
  describe("the bypass scan itself", () => {
    const folded = [
      "  general_tests:",
      "    if: >-",
      "      ${{ !cancelled() && (needs.gate.outputs.pretested != '1'",
      "      || github.event_name == 'workflow_dispatch') }}",
      "    runs-on: arc-paperclip-general",
    ].join("\n");

    // The same gate, correctly bypassed. Shared, because the two ceiling cases
    // below are reformats OF A GATE THAT PASSES CLEAN — that is what makes them
    // false reds rather than correct detections.
    const bypassed = folded.replace(
      "'workflow_dispatch')",
      "'workflow_dispatch' || github.event_name == 'schedule')",
    );

    it("sees through a folded `if:` block scalar, so a reformat cannot disarm it", () => {
      // Without the fold normaliser the `if:` token and the `pretested`
      // reference sit on different physical lines, the scan finds zero
      // candidates, and a DELETED bypass reports clean. `if: >-` is established
      // convention in this repo (pr.yml, commitperclip-review.yml,
      // storybook-visual.yml) and the guarded line is the longest in
      // master-health.yml — so this is one reformat away, not a hypothetical.
      assert.deepEqual(auditPretestedBypass([{ workflow: "f.yml", body: folded }]), {
        unscannable: [],
        unbypassed: ["f.yml"],
      });
    });

    it("accepts a folded `if:` that keeps the bypass", () => {
      assert.deepEqual(auditPretestedBypass([{ workflow: "f.yml", body: bypassed }]), {
        unscannable: [],
        unbypassed: [],
      });
    });

    it("reports a gate it cannot locate rather than reporting it clean", () => {
      // The output renamed but the prose left behind: the body still matches, so
      // the file still looks audited, while no `if:` carries the token.
      const body = ["  # needs.gate.outputs.pretested is set by `gate`", "    if: ${{ true }}"].join(
        "\n",
      );
      assert.deepEqual(auditPretestedBypass([{ workflow: "f.yml", body }]), {
        unscannable: ["f.yml"],
        unbypassed: [],
      });
    });

    // The two cases below PIN THE CEILING documented above `joinFoldedIfs`, and
    // they exist because that comment was wrong once already: it named
    // `unscannable` for both, when both actually land in `unbypassed`. Prose that
    // names the wrong arm sends a reader hunting a missing gate that is present.
    //
    // Both are `bypassed` — a gate this scan passes CLEAN — reformatted one way
    // each. So they assert a FALSE RED, not a detection, and they fail the moment
    // someone teaches `joinFoldedIfs` real scalar tracking. That is the point:
    // closing a gap should break the test that documents it, not silently leave
    // a comment describing behaviour the code no longer has.
    it("reads a blank line inside a folded `if:` as a short gate, not an unreadable one", () => {
      // The blank closes the scalar early, so line 1 still joins to
      // `if: >- ${{ … pretested != '1'`: located, carries the token, truncated
      // before the bypass clause. A located gate read short — hence `unbypassed`.
      const blankInside = bypassed.replace("\n      || github", "\n\n      || github");
      assert.deepEqual(auditPretestedBypass([{ workflow: "f.yml", body: blankInside }]), {
        unscannable: [],
        unbypassed: ["f.yml"],
      });
    });

    it("reports a plain multi-line `if:` as unbypassed, which is a false red", () => {
      // No `>`/`|`, so nothing joins the continuation the bypass sits on. The
      // failure message will assert the clause is missing when it is present
      // three lines below. Recognise that message; do not trust it.
      const plain = bypassed.replace("    if: >-\n      ${{", "    if: ${{");
      assert.match(plain, /github\.event_name == 'schedule'/);
      assert.deepEqual(auditPretestedBypass([{ workflow: "f.yml", body: plain }]), {
        unscannable: [],
        unbypassed: ["f.yml"],
      });
    });
  });

  it("puts the event filter into the API path, and omits it when unset", () => {
    assert.equal(
      completedRunsPath("o/r", "master-health.yml", "schedule"),
      "repos/o/r/actions/workflows/master-health.yml/runs?status=completed&per_page=1&event=schedule",
    );
    assert.equal(
      completedRunsPath("o/r", "codeowners-guard.yml", undefined),
      "repos/o/r/actions/workflows/codeowners-guard.yml/runs?status=completed&per_page=1",
    );
  });

  // The two assertions above prove the filter is BUILT correctly. Neither proves
  // main() actually hands it over. This used to assert against the SOURCE TEXT
  // of main()'s destructure, and that test was worthless in the precise way this
  // file keeps warning about: the destructure stayed correct while the scoping
  // branch beside it rebuilt entries from the workflow name alone and dropped
  // `event` for every guard it scoped to. The regex matched; the fix was
  // reverted. resolveWatched() exists so this is a behavioural test on the
  // object main() classifies, not on how it is spelled.
  it("threads each guard's event filter and grace through the unscoped set", () => {
    const masterHealth = resolveWatched("").find((guard) => guard.workflow === "master-health.yml");

    assert.equal(masterHealth.event, "schedule");
    assert.equal(
      completedRunsPath("o/r", masterHealth.workflow, masterHealth.event),
      "repos/o/r/actions/workflows/master-health.yml/runs?status=completed&per_page=1&event=schedule",
    );
  });

  // The cross-check must narrow on the SAME trigger axis as the filtered read
  // (BLO-38228). PEN-3379's design is that the two reads differ on exactly one
  // axis, `status=completed`. Let them differ on the trigger axis too and the
  // unfiltered side sees push runs the filtered side cannot: it reports a newer
  // completion on every single poll, `classifyGuard` lands in
  // `cross-check-disagreement`, and the alarm is suppressed FOREVER. That is a
  // permanent mute on the guard whose only job is to notice silence — strictly
  // worse than the false positives the cross-check was added to remove.
  it("narrows the cross-check on the same trigger axis, so it cannot disagree by construction", () => {
    const paths = [];
    const reader = (args) => {
      paths.push(args[1]);
      return JSON.stringify({ workflow_runs: [] });
    };

    crossCheckCompletions("o/r", "master-health.yml", reader, "schedule");
    crossCheckCompletions("o/r", "codeowners-guard.yml", reader);

    assert.match(
      paths[0],
      /^repos\/o\/r\/actions\/workflows\/master-health\.yml\/runs\?per_page=\d+&event=schedule$/,
      "a filtered guard's cross-check must carry the same event filter",
    );
    assert.match(
      paths[1],
      /^repos\/o\/r\/actions\/workflows\/codeowners-guard\.yml\/runs\?per_page=\d+$/,
      "an unfiltered guard's cross-check must stay unfiltered",
    );
    // The axis it must still DROP: corroboration depends on not going through
    // the suspect server-side index.
    for (const path of paths) assert.ok(!path.includes("status=completed"));
  });

  // GUARD_LIVENESS_WORKFLOWS is the path a human uses to check this guard works,
  // so unfiltering there reports "fresh" off a push run to whoever is verifying
  // — the one reading most likely to be believed.
  it("keeps a scoped guard's own event filter, threshold and grace", () => {
    const [scoped] = resolveWatched("master-health.yml");

    assert.equal(scoped.event, "schedule", "scoping dropped the event filter — push runs read as fresh");
    assert.equal(scoped.staleHours, 48, "scoping silently reset the threshold to the hourly default");
    assert.ok(scoped.graceUntil, "scoping dropped the grace window");
  });

  // Both assertions above prove the fields SURVIVE resolveWatched(). Neither
  // reaches the line that hands them to the two consumers. That line lived
  // inline in main(), which no test invokes, so dropping `event` or `graceUntil`
  // from it left the whole suite green (Ally, BLO-38228) — and the first of
  // those mutations reintroduces the exact false green this guard exists to
  // withhold: an unfiltered newest-run query is satisfied by a push run while
  // the cron is dead. classifyWatched() is exported so the join is behavioural.
  it("hands each guard's event filter and grace window to the observer and the classifier", () => {
    const now = Date.now();
    const seen = [];
    const [result] = classifyWatched(
      [
        {
          workflow: "master-health.yml",
          staleHours: 48,
          event: "schedule",
          // Derived from the clock, not pinned — a fixed literal here would rot
          // the same way the fixture this PR's issue is about did.
          graceUntil: new Date(now + 60_000).toISOString(),
        },
      ],
      (workflow, event) => {
        seen.push({ workflow, event });
        return { state: "active", name: "Master general tests", newest: null };
      },
      () => {
        assert.fail("a graced guard must not spend a cross-check call");
      },
      { now },
    );

    assert.deepEqual(
      seen,
      [{ workflow: "master-health.yml", event: "schedule" }],
      "the event filter never reached the observer — an unfiltered query reads push runs as fresh",
    );
    assert.equal(result.status, "ok", "the grace window never reached the classifier");
    assert.equal(result.reason, "awaiting-first-run");
  });

  // The THIRD consumer of `event`, and the one the PEN-3379 rebase very nearly
  // lost. PEN-3379 added an unfiltered second read that must corroborate a stale
  // verdict before it may red; it differs from the filtered read on exactly one
  // axis, `status=completed`. Let it differ on the TRIGGER axis too and it sees
  // push runs the filtered side cannot: it reports a newer completion on every
  // poll, the guard lands permanently in `cross-check-disagreement`, and the
  // alarm is MUTED forever instead of going red.
  //
  // Both changes are correct alone; the naive merge is a permanent mute on the
  // one guard whose entire job is to notice silence. This leg had no failing
  // mutation until `classifyWatched` took the cross-check as an argument — a
  // source-text regex was the only instrument available, and this file's own
  // history is that such a regex passed straight across its own reversion.
  it("hands the event filter to the cross-check too, so it cannot disagree by construction", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    const seen = [];
    const [result] = classifyWatched(
      [{ workflow: "master-health.yml", staleHours: 48, event: "schedule" }],
      () => ({ state: "active", name: "Master general tests", newest: null }),
      (workflow, event) => {
        seen.push({ workflow, event });
        return { newestCompletedAt: null };
      },
      { now },
    );

    assert.deepEqual(
      seen,
      [{ workflow: "master-health.yml", event: "schedule" }],
      "the cross-check ran unfiltered against a filtered read — it will disagree on every poll and mute the alarm",
    );
    assert.equal(result.status, "stale", "an ungraced never-completed guard must still red");
    assert.equal(result.reason, "never-completed");
  });

  // The LAST link: the line that binds `repo` into those two reads. Everything
  // above is held behaviourally, and with the closures written inline in main()
  // this one line still was not — main() is never invoked by a test, so dropping
  // `event` from the cross-check closure specifically left the suite green while
  // reintroducing the permanent mute. makeGuardReaders() is exported to close it.
  it("binds repo into both reads without losing the event filter", () => {
    const paths = [];
    const { crossCheck } = makeGuardReaders("o/r", (args) => {
      paths.push(args[1]);
      return JSON.stringify({ workflow_runs: [] });
    });
    crossCheck("master-health.yml", "schedule");
    crossCheck("codeowners-guard.yml", undefined);

    assert.match(
      paths[0],
      /^repos\/o\/r\/actions\/workflows\/master-health\.yml\/runs\?per_page=\d+&event=schedule$/,
      "the binding layer dropped the event filter — the cross-check will disagree on every poll and mute the alarm",
    );
    assert.match(
      paths[1],
      /^repos\/o\/r\/actions\/workflows\/codeowners-guard\.yml\/runs\?per_page=\d+$/,
      "an unfiltered guard's cross-check must stay unfiltered",
    );
    // The axis it must still DROP: corroboration depends on not going through
    // the suspect server-side index.
    for (const path of paths) assert.ok(!path.includes("status=completed"));
  });

  // The OTHER leg of that same binding line, and it stayed unguarded one round
  // longer than the cross-check did. `observeWorkflow` used to call `gh`
  // directly, so `event` had no observable effect and dropping it from the
  // `observe` closure left the suite at 78/0. The docstring claimed the leg was
  // "held by classifyWatched's injected-observer test instead" — it is not:
  // that test injects a FAKE observer, so it pins classifyWatched's own call and
  // never the adapter that forwards into the real read. Threading `read` through
  // `observeWorkflow` is what makes this assertion possible at all.
  it("keeps the event filter on the observe leg too, not just the cross-check", () => {
    const paths = [];
    const reader = (args) => {
      paths.push(args[1]);
      // First call is the workflow-meta read; it must look active or the
      // function short-circuits before ever building the runs path.
      return args[1].includes("/runs?")
        ? JSON.stringify({ workflow_runs: [] })
        : JSON.stringify({ state: "active", name: "Master health" });
    };

    const { observe } = makeGuardReaders("o/r", reader);
    observe("master-health.yml", "schedule");
    observe("codeowners-guard.yml", undefined);

    const runPaths = paths.filter((path) => path.includes("/runs?"));
    assert.equal(runPaths.length, 2, "the observe leg did not reach its runs read — this test is vacuous");

    assert.match(
      runPaths[0],
      /^repos\/o\/r\/actions\/workflows\/master-health\.yml\/runs\?status=completed&per_page=1&event=schedule$/,
      "the binding layer dropped the event filter on the OBSERVE leg. A push run then satisfies " +
        "the liveness read while the cron is dead — the exact false green this guard exists to withhold.",
    );
    assert.match(
      runPaths[1],
      /^repos\/o\/r\/actions\/workflows\/codeowners-guard\.yml\/runs\?status=completed&per_page=1$/,
      "an unfiltered guard's observe read must stay unfiltered",
    );
  });

  it("still honours the stale-hours override and resolves an undeclared workflow", () => {
    const [overridden] = resolveWatched("master-health.yml", 1);
    assert.equal(overridden.staleHours, 1, "an explicit override must beat the declared threshold");

    // The dial may name anything; an unwatched workflow is not an error.
    const [undeclared] = resolveWatched("not-a-watched-guard.yml");
    assert.equal(undeclared.staleHours, DEFAULT_STALE_HOURS);
    assert.equal(undeclared.event, undefined);
  });

  it("gives every exemption a stated reason", () => {
    for (const entry of EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS) {
      assert.ok(
        entry.reason && entry.reason.length > 40,
        `${entry.workflow} is exempt without a reason anyone can audit`,
      );
    }
  });

  it("carries the six PEN-3281 guards, the security control the original list missed, and the clock-rot guard", () => {
    assert.deepEqual(
      [...WATCHED_WORKFLOWS].sort(),
      [
        "adapter-pin-drift-monitor.yml",
        "ally-review-consistency.yml",
        "codeowners-guard.yml",
        "lockfile-drift-monitor.yml",
        "master-health.yml",
        "production-environment-protection-guard.yml",
        "relay-ssl-multicert-guard.yml",
        "review-gate-sweep.yml",
      ],
    );
  });

  it("gives the twice-daily guard a threshold its own cadence justifies", () => {
    const byWorkflow = new Map(WATCHED_GUARDS.map((g) => [g.workflow, g.staleHours]));

    // Measured 39 gaps: ordinary band tops out at 14.60h, the two outage
    // outliers are 17.71h and 22.21h. The bar must sit strictly between.
    const twiceDaily = byWorkflow.get("production-environment-protection-guard.yml");
    assert.ok(twiceDaily > 14.6, "would red on ordinary twice-daily jitter");
    assert.ok(twiceDaily < 17.71, "would sail over the 2026-09-15 outage it must catch");

    // BLO-38228: the daily clock-rot guard is on 48h, deliberately loose because
    // its schedule is new and has no measured gap distribution yet. Asserted
    // rather than skipped, so a drift into the hourly bar (which would red it
    // every single day) fails here.
    const dailyClockRot = byWorkflow.get("master-health.yml");
    assert.ok(dailyClockRot > 24, "a daily cron must clear one full cycle plus GitHub's delay");
    assert.ok(dailyClockRot <= 48, "looser than two missed cycles stops being a backstop at all");

    // The hourly six share one bar; a shared GLOBAL threshold across cadences is
    // the bug this replaced. Asserted against DEFAULT_STALE_HOURS rather than a
    // literal so moving the bar stays a one-line change with a reason attached
    // (PEN-3379 moved it 4h -> 2.75h).
    const notHourly = new Set(["production-environment-protection-guard.yml", "master-health.yml"]);
    for (const workflow of WATCHED_WORKFLOWS) {
      if (notHourly.has(workflow)) continue;
      assert.equal(
        byWorkflow.get(workflow),
        DEFAULT_STALE_HOURS,
        `${workflow} should be on the hourly ${DEFAULT_STALE_HOURS}h bar`,
      );
    }
  });
});

describe("resolveStaleHours — a free-text dispatch input must not red the fleet", () => {
  // `stale_hours` is a free-text workflow_dispatch input. Unguarded,
  // Number("abc") is NaN, `age < NaN * 60` is false, and EVERY guard classifies
  // stale with detail text reading "past the NaNh liveness threshold".
  it("falls back when the input is not a number", () => {
    assert.equal(resolveStaleHours("abc"), DEFAULT_STALE_HOURS);
  });

  it("falls back on zero, which is a truthy string and would red everything", () => {
    assert.equal(resolveStaleHours("0"), DEFAULT_STALE_HOURS);
  });

  it("falls back on a negative threshold", () => {
    assert.equal(resolveStaleHours("-5"), DEFAULT_STALE_HOURS);
  });

  it("falls back when unset or blank", () => {
    assert.equal(resolveStaleHours(undefined), DEFAULT_STALE_HOURS);
    assert.equal(resolveStaleHours("   "), DEFAULT_STALE_HOURS);
  });

  it("honours a legitimate override, including a fractional one", () => {
    assert.equal(resolveStaleHours("1"), 1);
    assert.equal(resolveStaleHours("0.5"), 0.5);
    assert.equal(resolveStaleHours("16", 4), 16);
  });

  it("classifies nothing stale under a NaN input once guarded", () => {
    const now = Date.parse("2026-09-15T09:45:00Z");
    const result = classifyGuard(
      "codeowners-guard.yml",
      completedAgo("CODEOWNERS Guard", 30 * MINUTE, { now }),
      { now, staleHours: resolveStaleHours("abc") },
    );

    assert.equal(result.status, "ok");
    assert.doesNotMatch(result.detail, /NaN/);
  });
});

describe("summarize — 'could not read' is a different claim from 'stopped executing'", () => {
  const now = Date.parse("2026-09-15T09:45:00Z");

  it("says stopped only about guards actually shown to have stopped", () => {
    const results = [
      classifyGuard("codeowners-guard.yml", completedAgo("CODEOWNERS Guard", 9 * HOUR, { now }), { now }),
      classifyGuard("review-gate-sweep.yml", completedAgo("Review Gate Sweep", 5 * MINUTE, { now }), { now }),
    ];
    const summary = summarize(results);

    assert.equal(summary.exitCode, 1);
    assert.equal(summary.stoppedCount, 1);
    assert.equal(summary.unreadableCount, 0);
    assert.match(summary.headline, /1 of 2 watched scheduled guard\(s\) have stopped executing/);
  });

  it("does NOT claim a guard stopped when the API read was the thing that failed", () => {
    // A transient 5xx must not put words in the alarm's mouth: the owner of
    // "this guard stopped" is the runner lane; the owner of "I could not read"
    // is this job.
    const results = [
      classifyGuard("codeowners-guard.yml", { error: "unreadable" }, { now }),
      classifyGuard("review-gate-sweep.yml", completedAgo("Review Gate Sweep", 5 * MINUTE, { now }), { now }),
    ];
    const summary = summarize(results);

    assert.equal(summary.exitCode, 1, "an API error must still fail closed");
    assert.equal(summary.stoppedCount, 0);
    assert.equal(summary.unreadableCount, 1);
    assert.doesNotMatch(summary.headline, /stopped executing/);
    assert.match(summary.headline, /could not be read from the GitHub API/);
    assert.match(summary.headline, /not asserting they stopped/);
  });

  it("reports both populations separately when both are present", () => {
    const results = [
      classifyGuard("codeowners-guard.yml", { error: "runs-unreadable", state: "active" }, { now }),
      classifyGuard("review-gate-sweep.yml", completedAgo("Review Gate Sweep", 9 * HOUR, { now }), { now }),
    ];
    const summary = summarize(results);

    assert.equal(summary.stoppedCount, 1);
    assert.equal(summary.unreadableCount, 1);
    assert.match(summary.headline, /stopped executing/);
    assert.match(summary.headline, /could not be read/);
  });

  it("counts a disabled or never-completed guard as stopped, not as unreadable", () => {
    const results = [
      classifyGuard("codeowners-guard.yml", { state: "disabled_inactivity", name: "CODEOWNERS Guard" }, { now }),
      classifyGuard("review-gate-sweep.yml", { state: "active", name: "Review Gate Sweep", newest: null }, { now }),
    ];
    const summary = summarize(results);

    assert.equal(summary.stoppedCount, 2);
    assert.equal(summary.unreadableCount, 0);
  });

  it("stays silent and green when every guard is fresh", () => {
    const results = WATCHED_WORKFLOWS.map((workflow) =>
      classifyGuard(workflow, completedAgo(workflow, 20 * MINUTE, { now }), { now }),
    );
    const summary = summarize(results);

    assert.equal(summary.exitCode, 0);
    // Derived, not a literal: the count is incidental to what this asserts
    // (green + silent), and hardcoding it made adding a guard fail here for no
    // reason anyone could act on.
    assert.match(
      summary.headline,
      new RegExp(`All ${WATCHED_WORKFLOWS.length} watched scheduled guards have completed`),
    );
  });
});

describe("the run index is not self-consistent across filters (BLO-38286)", () => {
  // Reconstructed from the production false red: run 36692972253,
  // 2026-09-30T08:59Z. `relay-ssl-multicert-guard` was cited at 436h stale and
  // was completing on schedule the whole time. The PEN-3379 timestamp
  // cross-check had been live since 09-27 and did NOT suppress it — the log
  // carries no "could not be made" note, so the corroborating read was made
  // cleanly and AGREED. Both reads were served the same pinned index.
  //
  // That is the gap this block holds: a second read taken at the same instant
  // cannot see a fault that is windowed rather than per-call.
  const CLAIMED = "2026-09-12T04:32:39Z";
  const NOW = Date.parse("2026-09-30T08:59:35Z");
  const WORKFLOW = "relay-ssl-multicert-guard.yml";

  // Measured counts, codeowners-guard.yml + event=schedule, inside ~4 minutes.
  // Adding a filter INCREASED the count, which is impossible over a fixed set.
  const COMPLETED_COUNT = 1058;
  const ALL_COUNT = 632;

  function observation({ completedCount, allCount, newest = true }) {
    return {
      state: "active",
      name: "Relay SSL Multicert Guard",
      completedCount,
      newest: newest
        ? { updatedAt: CLAIMED, conclusion: "success", htmlUrl: "https://example.invalid/1" }
        : null,
      // Timestamp-agreeing, exactly as production saw it: the cross-check is
      // readable and is NOT newer, so the PEN-3379 arm has nothing to fire on.
      crossCheck: { newestCompletedAt: CLAIMED, allCount },
    };
  }

  const classify = (obs) => classifyGuard(WORKFLOW, obs, { now: NOW, staleHours: 2.75 });

  // POSITIVE CONTROL. Without the impossible counts this fixture must still
  // red, or the two assertions below prove nothing about the fix — they would
  // pass just as happily against a classifier that never reds at all.
  it("still reds when the counts are consistent (shipped behaviour, timestamp arm blind)", () => {
    const result = classify(observation({ completedCount: 600, allCount: ALL_COUNT }));

    assert.equal(result.status, "stale");
    assert.equal(result.reason, "stopped");
    assert.ok(result.ageMinutes > 400 * 60, "the fixture really does carry the ~436h bogus age");
  });

  it("suppresses the red once completed > total proves the reads disagree", () => {
    const result = classify(observation({ completedCount: COMPLETED_COUNT, allCount: ALL_COUNT }));

    assert.equal(result.status, "unknown", "must not assert a healthy guard stopped");
    assert.equal(result.reason, "index-inconsistent");
    assert.match(result.detail, /1058 completed run\(s\) but only 632 run\(s\) in total/);
  });

  // The same distrusted index makes a STRONGER claim on this path, so it is
  // gated too — `classifyWatched` spends the cross-check on both reasons.
  it("suppresses 'never completed' on the same proof", () => {
    const result = classify(
      observation({ completedCount: COMPLETED_COUNT, allCount: ALL_COUNT, newest: false }),
    );

    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "index-inconsistent");
  });

  // Without this, an arm that returned `unknown` unconditionally would pass
  // every assertion above. A suppression that cannot tell the two apart is a
  // mute switch, which is the failure this whole file exists to prevent.
  it("does NOT suppress when the counts are possible — equality is not a violation", () => {
    for (const [completedCount, allCount] of [
      [632, 632],
      [0, 0],
      [1, 632],
    ]) {
      const result = classify(observation({ completedCount, allCount }));
      assert.equal(result.status, "stale", `completed=${completedCount} total=${allCount}`);
      assert.equal(result.reason, "stopped");
    }
  });

  it("does not fire on a missing or unreadable count rather than guessing", () => {
    for (const obs of [
      observation({ completedCount: undefined, allCount: ALL_COUNT }),
      observation({ completedCount: COMPLETED_COUNT, allCount: null }),
      { ...observation({ completedCount: COMPLETED_COUNT, allCount: ALL_COUNT }), crossCheck: { error: true } },
    ]) {
      assert.equal(classify(obs).status, "stale", "absence of evidence must not weaken the red");
    }
  });

  // THE LEGS THAT CARRY THE COUNTS. The arm above is pure and would stay green
  // forever while being unreachable in production if either read stopped
  // returning its `total_count` — the exact unguarded-leg mutation this file
  // has already shipped twice (`event` on the observe closure, then on the
  // cross-check closure). Hold both behaviourally.
  it("observeWorkflow carries the filtered read's total_count", () => {
    const read = (args) =>
      args[1].includes("/runs")
        ? JSON.stringify({
            total_count: COMPLETED_COUNT,
            workflow_runs: [{ updated_at: CLAIMED, conclusion: "success", html_url: "u" }],
          })
        : JSON.stringify({ state: "active", name: "Relay SSL Multicert Guard" });

    assert.equal(observeWorkflow("o/r", WORKFLOW, read).completedCount, COMPLETED_COUNT);
  });

  it("observeWorkflow carries total_count on the no-completed-run path too", () => {
    const read = (args) =>
      args[1].includes("/runs")
        ? JSON.stringify({ total_count: COMPLETED_COUNT, workflow_runs: [] })
        : JSON.stringify({ state: "active", name: "Relay SSL Multicert Guard" });

    const observed = observeWorkflow("o/r", WORKFLOW, read);
    assert.equal(observed.newest, null);
    assert.equal(observed.completedCount, COMPLETED_COUNT);
  });

  it("crossCheckCompletions carries the unfiltered read's total_count", () => {
    const read = () => JSON.stringify({ total_count: ALL_COUNT, workflow_runs: [] });

    assert.equal(crossCheckCompletions("o/r", WORKFLOW, read).allCount, ALL_COUNT);
  });

  it("a suppressed guard exits 0 and is not reported as healthy", () => {
    const summary = summarize([classify(observation({ completedCount: COMPLETED_COUNT, allCount: ALL_COUNT }))]);

    assert.equal(summary.exitCode, 0, "a lying index must not red the job");
    assert.equal(summary.unknownCount, 1);
    assert.doesNotMatch(summary.headline, /have stopped executing/);
  });
});

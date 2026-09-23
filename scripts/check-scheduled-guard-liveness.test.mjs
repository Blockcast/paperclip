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
  crossCheckCompletions,
  describeStopMode,
  resolveStaleHours,
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

  const outage = Object.fromEntries(WATCHED_WORKFLOWS.map((workflow) => [workflow, observed(workflow)]));

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
    // All four reds fell inside one ~8h window; classify them together at the
    // last one, which is how a single run would have seen a repeat occurrence.
    const now = Date.parse("2026-09-18T14:50:00Z");
    const summary = summarize(
      FALSE_POSITIVES.map((fixture) =>
        classifyGuard(fixture.workflow, staleIndexObservation(fixture), {
          now,
          staleHours: thresholdFor(fixture.workflow),
        }),
      ),
    );

    assert.equal(summary.staleCount, 0);
    assert.equal(summary.exitCode, 0, "not one of these four may exit non-zero");
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

    assert.deepEqual(observed, { newestCompletedAt: "2026-09-18T06:42:30.000Z" });
  });

  it("reports null — not an error — when the page genuinely holds no completed run", () => {
    const observed = crossCheckCompletions(
      "Blockcast/paperclip",
      "relay-ssl-multicert-guard.yml",
      reader({ workflow_runs: [{ created_at: "2026-09-22T07:31:00Z", updated_at: "2026-09-22T07:31:00Z", status: "queued" }] }),
    );

    // Distinct from {error: true}: this is a successful read that found
    // nothing, which is evidence. An error is the absence of evidence.
    assert.deepEqual(observed, { newestCompletedAt: null });
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

    assert.deepEqual(observed, { newestCompletedAt: null });
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

  /** Every workflow that is BOTH scheduled and on the starvable `default` lane. */
  function scheduledDefaultWorkflows() {
    return readdirSync(workflowDir)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .filter((file) => {
        const body = readFileSync(join(workflowDir, file), "utf8");
        const scheduled = /^\s*schedule:\s*$/m.test(body);
        const onDefault = /^\s*runs-on:\s*default\s*$/m.test(body);
        return scheduled && onDefault;
      })
      .sort();
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

  it("does not watch a workflow that has stopped being a scheduled default guard", () => {
    const live = new Set(scheduledDefaultWorkflows());
    const dangling = WATCHED_WORKFLOWS.filter((file) => !live.has(file));

    assert.deepEqual(
      dangling,
      [],
      "a watched entry no longer resolves to a scheduled `default` workflow. At runtime this reds " +
        "as 'unreadable', which is correct but late — fix the entry here.",
    );
  });

  it("gives every exemption a stated reason", () => {
    for (const entry of EXEMPT_SCHEDULED_DEFAULT_WORKFLOWS) {
      assert.ok(
        entry.reason && entry.reason.length > 40,
        `${entry.workflow} is exempt without a reason anyone can audit`,
      );
    }
  });

  it("carries the six PEN-3281 guards plus the security control the original list missed", () => {
    assert.deepEqual(
      [...WATCHED_WORKFLOWS].sort(),
      [
        "adapter-pin-drift-monitor.yml",
        "ally-review-consistency.yml",
        "codeowners-guard.yml",
        "lockfile-drift-monitor.yml",
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

    // The hourly six share one bar; a shared GLOBAL threshold across cadences is
    // the bug this replaced. Asserted against DEFAULT_STALE_HOURS rather than a
    // literal so moving the bar stays a one-line change with a reason attached
    // (PEN-3379 moved it 4h -> 2.75h).
    for (const workflow of WATCHED_WORKFLOWS) {
      if (workflow === "production-environment-protection-guard.yml") continue;
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
    assert.match(summary.headline, /All 7 watched scheduled guards have completed/);
  });
});

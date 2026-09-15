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
  describeStopMode,
  resolveStaleHours,
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
    assert.match(first.detail, /past the 4h liveness threshold/);
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

describe("classifyGuard — the 4h threshold against measured gap distribution", () => {
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

  // Honest limitation, asserted rather than left in prose: in the 2026-09-14
  // event the lockfile guard's gap reached only 213 min, under the 4h bar. The
  // event is still caught — detection is per-event, and the other five breach.
  it("catches the 2026-09-14 event on five of six legs", () => {
    const gaps = { a: 305, b: 291, c: 268, d: 254, e: 241, "lockfile-drift-monitor.yml": 213 };
    const results = Object.entries(gaps).map(([workflow, minutes]) =>
      classifyGuard(workflow, completedAgo(workflow, minutes * MINUTE, { now }), { now }),
    );
    const summary = summarize(results);

    assert.equal(summary.staleCount, 5);
    assert.equal(summary.exitCode, 1, "the event is reported even though one leg is under the bar");
    assert.equal(
      results.find((r) => r.workflow === "lockfile-drift-monitor.yml").status,
      "ok",
      "documents the known miss rather than pretending full coverage",
    );
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

    // The hourly six keep 4h; a shared global threshold is the bug this replaced.
    for (const workflow of WATCHED_WORKFLOWS) {
      if (workflow === "production-environment-protection-guard.yml") continue;
      assert.equal(byWorkflow.get(workflow), 4, `${workflow} should be on the hourly 4h bar`);
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_STALE_HOURS,
  WATCHED_WORKFLOWS,
  classifyGuard,
  describeStopMode,
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

function classifyAll(observations, now) {
  return Object.entries(observations).map(([workflow, observation]) =>
    classifyGuard(workflow, observation, { now }),
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
  // gone (PEN-3272), all six guards last completed ~03:41Z, and at detection
  // time (09:45Z) nothing anywhere had gone red.
  const now = Date.parse("2026-09-15T09:45:00Z");
  const lastCompletion = "2026-09-15T03:41:00Z";

  const outage = Object.fromEntries(
    WATCHED_WORKFLOWS.map((workflow) => [
      workflow,
      {
        state: "active",
        name: workflow.replace(/\.yml$/, ""),
        newest: { updatedAt: lastCompletion, conclusion: "success", htmlUrl: "https://example.invalid/run" },
      },
    ]),
  );

  it("reds every one of the six guards", () => {
    const results = classifyAll(outage, now);
    const summary = summarize(results);

    assert.equal(summary.checked, 6);
    assert.equal(summary.staleCount, 6);
    assert.equal(summary.exitCode, 1, "the detector must fail the job against the real condition");
    assert.match(summary.headline, /6 of 6 watched scheduled guard\(s\) have stopped executing/);
  });

  it("reports the stop as `stopped` with the observed age, not a generic failure", () => {
    const [first] = classifyAll(outage, now);

    assert.equal(first.reason, "stopped");
    assert.equal(first.ageMinutes, 364);
    assert.match(first.detail, /last completed 6h ago/);
    assert.match(first.detail, /past the 4h liveness threshold/);
  });

  // Mutation check: the same six guards, same code path, healthy timings. If
  // this went red too, the test above would prove nothing.
  it("stays green when the same six guards are executing normally", () => {
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

describe("WATCHED_WORKFLOWS", () => {
  it("covers the six guards named in PEN-3281", () => {
    assert.deepEqual(
      [...WATCHED_WORKFLOWS].sort(),
      [
        "adapter-pin-drift-monitor.yml",
        "ally-review-consistency.yml",
        "codeowners-guard.yml",
        "lockfile-drift-monitor.yml",
        "relay-ssl-multicert-guard.yml",
        "review-gate-sweep.yml",
      ],
      "the watched set is explicit; a new scheduled guard is unwatched until added here",
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyRow,
  destroyedDueTimes,
  findHandoffFailures,
  hasRecoveryEmitted,
  isCancelledClear,
  isLiveMonitorOnCancelledRow,
  isMainModule,
  isOwnerlessSource,
  nextCursor,
  summarize,
} from "./measure-cancelled-monitor-recovery.mjs";

function issue(overrides = {}) {
  const { monitor, ...rest } = overrides;
  return {
    id: "00000000-0000-0000-0000-000000000001",
    identifier: "PEN-4835",
    status: "cancelled",
    assigneeAgentId: "29033747-e513-46d5-8a13-dcb5dac10017",
    originKind: "plugin:paperclip-plugin-alertmanager",
    monitorNextCheckAt: null,
    executionState: { monitor: { clearReason: "cancelled", ...monitor } },
    ...rest,
  };
}

describe("isCancelledClear", () => {
  it("selects on the monitor's clear reason, not on the row's status", () => {
    // A flapping alert row sits in `todo` mid-cycle and is still owed a carrier.
    assert.equal(isCancelledClear(issue({ status: "todo" })), true);
    assert.equal(isCancelledClear(issue({ monitor: { clearReason: "manual" } })), false);
    assert.equal(isCancelledClear(issue({ executionState: {} })), false);
    assert.equal(isCancelledClear(issue({ executionState: null })), false);
    assert.equal(isCancelledClear(undefined), false);
  });
});

describe("isLiveMonitorOnCancelledRow", () => {
  it("selects the PEN-3554 shape and nothing adjacent to it", () => {
    assert.equal(
      isLiveMonitorOnCancelledRow(issue({ monitorNextCheckAt: "2026-11-03T12:00:00.000Z" })),
      true,
    );
    // Same live column, row not cancelled: an ordinary armed monitor.
    assert.equal(
      isLiveMonitorOnCancelledRow(
        issue({ status: "in_progress", monitorNextCheckAt: "2026-11-03T12:00:00.000Z" }),
      ),
      false,
    );
    assert.equal(isLiveMonitorOnCancelledRow(issue()), false);
  });
});

describe("hasRecoveryEmitted", () => {
  it("treats ABSENT and null alike as still owed", () => {
    // Absent is what every row reads before the field ships; scoring it as
    // handled would report the entire pre-deploy population as already done.
    assert.equal(hasRecoveryEmitted(issue()), false);
    assert.equal(hasRecoveryEmitted(issue({ monitor: { recoveryEmittedAt: null } })), false);
    assert.equal(
      hasRecoveryEmitted(issue({ monitor: { recoveryEmittedAt: "2026-11-03T18:00:00.000Z" } })),
      true,
    );
  });
});

describe("isOwnerlessSource", () => {
  it("flags a source that would produce an ownerless carrier", () => {
    assert.equal(isOwnerlessSource(issue({ assigneeAgentId: null })), true);
    assert.equal(isOwnerlessSource(issue()), false);
  });
});

describe("summarize", () => {
  it("counts both disjuncts, splits owed from emitted, and sizes the ownerless slice", () => {
    const rows = [
      issue({ identifier: "PEN-4835" }),
      issue({ identifier: "PEN-5104", status: "todo" }),
      issue({ identifier: "PEN-4424", assigneeAgentId: null }),
      issue({
        identifier: "PEN-4768",
        monitor: { recoveryEmittedAt: "2026-11-03T18:00:00.000Z" },
      }),
      issue({
        identifier: "PEN-3554",
        monitor: { clearReason: "manual" },
        monitorNextCheckAt: "2026-11-03T12:00:00.000Z",
      }),
      issue({ identifier: "PEN-5203", status: "done", monitor: { clearReason: "manual" } }),
    ];

    const summary = summarize(rows);
    assert.equal(summary.scanned, 6);
    assert.equal(summary.population, 5);
    assert.equal(summary.disjunctA, 4);
    assert.equal(summary.disjunctB, 1);
    assert.equal(summary.emitted, 1);
    assert.equal(summary.owed, 4);
    assert.equal(summary.ownerlessOwed, 1);
  });

  it("counts a row satisfying BOTH disjuncts once in the population", () => {
    const both = issue({ monitorNextCheckAt: "2026-11-03T12:00:00.000Z" });
    const summary = summarize([both]);
    assert.equal(summary.population, 1);
    assert.equal(summary.disjunctA, 1);
    assert.equal(summary.disjunctB, 1);
  });

  it("reports an empty population rather than throwing", () => {
    assert.equal(summarize([]).population, 0);
    assert.equal(summarize(undefined).scanned, 0);
  });
});

describe("findHandoffFailures", () => {
  const stamped = issue({ monitor: { recoveryEmittedAt: "2026-11-03T18:00:00.000Z" } });

  it("reports a stamped row with no carrier — the one reading that falsifies the design", () => {
    const { lost, duplicated } = findHandoffFailures([stamped], []);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].identifier, "PEN-4835");
    assert.equal(duplicated.length, 0);
  });

  it("reports two carriers for one obligation separately from a lost one", () => {
    // The single-flight gap: a duplicate carrier still carries the obligation,
    // so this is a defect but not a falsification of the handoff.
    const carriers = [{ originId: stamped.id }, { originId: stamped.id }];
    const { lost, duplicated } = findHandoffFailures([stamped], carriers);
    assert.equal(lost.length, 0);
    assert.equal(duplicated.length, 1);
    assert.match(duplicated[0].detail, /2 carriers/);
  });

  it("is silent on a correctly handed-back row and on an unstamped one", () => {
    const ok = findHandoffFailures([stamped], [{ originId: stamped.id }]);
    assert.deepEqual(ok, { lost: [], duplicated: [] });
    // Unstamped rows are still owed, not failures — they are the `owed` count.
    const unstamped = findHandoffFailures([issue()], []);
    assert.deepEqual(unstamped, { lost: [], duplicated: [] });
  });
});

describe("destroyedDueTimes", () => {
  const events = [
    {
      action: "issue.monitor_cleared_undeliverable",
      createdAt: "2026-11-03T01:11:40.383Z",
      details: {
        clearReason: "cancelled",
        nextCheckAt: "2026-11-03T12:00:00.000Z",
        attemptCount: 1,
        notes: "Outstanding: ONE human approval",
      },
    },
    // Same event shape, different reason: not this population.
    {
      action: "issue.monitor_cleared_undeliverable",
      createdAt: "2026-10-27T15:55:25.906Z",
      details: { clearReason: "manual", nextCheckAt: "2026-10-27T18:40:00.000Z" },
    },
    { action: "issue.monitor_scheduled", createdAt: "2026-11-02T12:56:17.309Z", details: {} },
  ];

  it("recovers the destroyed due time from the event that destroyed it", () => {
    // This is the #3311 sequencing answer: the due time is persisted today, so
    // `clearedNextCheckAt` is a convenience and not a blocker.
    const found = destroyedDueTimes(events);
    assert.equal(found.length, 1);
    assert.equal(found[0].dueAt, "2026-11-03T12:00:00.000Z");
    assert.equal(found[0].clearedAt, "2026-11-03T01:11:40.383Z");
    assert.equal(found[0].attemptCount, 1);
  });

  it("reports a missing due time as null rather than dropping the clear", () => {
    const withoutDue = [
      {
        action: "issue.monitor_cleared_undeliverable",
        createdAt: "2026-11-03T01:11:40.383Z",
        details: { clearReason: "cancelled" },
      },
    ];
    assert.deepEqual(destroyedDueTimes(withoutDue).map((row) => row.dueAt), [null]);
    assert.deepEqual(destroyedDueTimes([]), []);
  });
});

describe("nextCursor", () => {
  const page = (ids) => ids.map((id) => ({ id }));

  it("stops on a short page only when the list did not report more rows", () => {
    assert.deepEqual(nextCursor(page(["a", "b"]), 3, undefined), { done: true, afterId: null });
    assert.deepEqual(nextCursor([], 3, "z"), { done: true, afterId: null });
    assert.deepEqual(nextCursor(page(["a", "b"]), 3, undefined, false), { done: true, afterId: null });
  });

  it("keeps walking past a SHORT page that is flagged truncated", () => {
    // The ACL filter runs after the raw window, so a restricted actor gets a
    // short page with readable rows still beyond it. Stopping there undercounts
    // and leaves no trace — the exact failure this file is written against.
    assert.deepEqual(nextCursor(page(["a", "b"]), 3, undefined, true), { done: false, afterId: "b" });
  });

  it("throws when the list reports more rows beyond a page it cannot advance past", () => {
    // Empty AND truncated: more rows exist and there is no cursor to take.
    assert.throws(() => nextCursor([], 3, "z", true), /cannot advance/);
  });

  it("advances to the last id of a full page", () => {
    assert.deepEqual(nextCursor(page(["a", "b", "c"]), 3, undefined), { done: false, afterId: "c" });
    assert.deepEqual(nextCursor(page(["a", "b", "c"]), 3, undefined, true), { done: false, afterId: "c" });
    assert.deepEqual(nextCursor(page(["d", "e", "f"]), 3, "c"), { done: false, afterId: "f" });
  });

  it("throws when a full page did not advance past the cursor", () => {
    // afterId never reached the query, so the walk would re-serve this page
    // forever. Silently returning a partial scan is the failure to avoid.
    assert.throws(
      () => nextCursor(page(["a", "b", "c"]), 3, "c"),
      /keyset cursor did not advance/,
    );
  });
});

describe("isMainModule", () => {
  it("is false when another entrypoint is running, true for its own path", () => {
    // Passing `undefined` would trigger the default parameter and compare the
    // test file against itself, which asserts nothing about the guard.
    assert.equal(isMainModule("/some/other/entrypoint.mjs", import.meta.url), false);
    assert.equal(isMainModule("", import.meta.url), false);
    assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
  });
});

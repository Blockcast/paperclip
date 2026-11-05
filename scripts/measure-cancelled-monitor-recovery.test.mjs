import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  carriersBySource,
  classifyMultiCarrier,
  classifyRow,
  destroyedDueTimes,
  findHandoffFailures,
  hasRecoveryEmitted,
  isAutoDischarged,
  isCancelledClear,
  isLiveMonitorOnCancelledRow,
  isMainModule,
  isOwnerlessSource,
  nextCursor,
  recoveryObligationKeys,
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

/**
 * One `issue.monitor_recovery_issue_created` row. `details.nextCheckAt` on THIS
 * action is `performIssueMonitorRecovery`'s `scheduledAtIso`, which the
 * cancelled-monitor pass supplies as `monitorState.clearedAt` — so it names the
 * clear this recovery discharged, one value per obligation. The identically
 * named field on `issue.monitor_cleared_undeliverable` holds the destroyed DUE
 * time instead; the two are not equal and are never joined on.
 */
function recoveryEvent(clearedAt) {
  return {
    action: "issue.monitor_recovery_issue_created",
    createdAt: "2026-11-05T19:25:47.888Z",
    details: { clearReason: "cancelled", nextCheckAt: clearedAt, recoveryIdentifier: "PEN-5694" },
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

describe("recoveryObligationKeys", () => {
  it("keys each recovery on the clear it discharged and collapses re-drives", () => {
    // Two clears on a recycled row, plus a re-drive of the FIRST one: the pass
    // crashed between emit and stamp, re-entered, reused the carrier, and logged
    // the same clearedAt again. Three events, two obligations, two carriers.
    const found = recoveryObligationKeys([
      recoveryEvent("2026-11-05T01:30:34.554Z"),
      recoveryEvent("2026-11-05T01:30:34.554Z"),
      recoveryEvent("2026-11-05T19:24:08.284Z"),
      { action: "issue.monitor_cleared_undeliverable", details: { nextCheckAt: "2026-11-05T06:30:00.000Z" } },
    ]);
    assert.deepEqual(found, { events: 3, distinct: 2, unkeyed: 0 });
  });

  it("counts an unkeyed recovery event rather than silently dropping it", () => {
    assert.deepEqual(recoveryObligationKeys([recoveryEvent(null), recoveryEvent("2026-11-05T01:30:34.554Z")]), {
      events: 2,
      distinct: 1,
      unkeyed: 1,
    });
    assert.deepEqual(recoveryObligationKeys([]), { events: 0, distinct: 0, unkeyed: 0 });
    assert.deepEqual(recoveryObligationKeys(undefined), { events: 0, distinct: 0, unkeyed: 0 });
  });
});

describe("classifyMultiCarrier", () => {
  it("clears a recycled row whose carriers each discharge their own clear", () => {
    const { verdict } = classifyMultiCarrier(2, [
      recoveryEvent("2026-11-05T01:30:34.554Z"),
      recoveryEvent("2026-11-05T19:24:08.284Z"),
    ]);
    assert.equal(verdict, "ok");
  });

  it("reports two carriers for ONE clear as duplicated", () => {
    const { verdict, detail } = classifyMultiCarrier(2, [
      recoveryEvent("2026-11-05T01:30:34.554Z"),
      recoveryEvent("2026-11-05T01:30:34.554Z"),
    ]);
    assert.equal(verdict, "duplicated");
    assert.match(detail, /2 carriers across 1 distinct obligation\b/);
  });

  it("refuses to decide when the obligation count is not established", () => {
    // No feed at all.
    assert.equal(classifyMultiCarrier(2, undefined).verdict, "unresolved");
    // An event that cannot be attributed to a clear.
    assert.equal(
      classifyMultiCarrier(2, [recoveryEvent(null), recoveryEvent("2026-11-05T01:30:34.554Z")]).verdict,
      "unresolved",
    );
    // FEWER events than carriers. The server's creation log is best-effort (its
    // rejection is swallowed to keep the committed carrier discoverable by
    // originId), so a lost line is a designed-for state, and under it "two
    // carriers, one event" cannot be told from one obligation emitted twice.
    const short = classifyMultiCarrier(2, [recoveryEvent("2026-11-05T01:30:34.554Z")]);
    assert.equal(short.verdict, "unresolved");
    assert.match(short.detail, /best-effort/);
  });

  it("never asserts a count it has not established", () => {
    for (const feed of [undefined, [recoveryEvent(null)], [recoveryEvent("2026-11-05T01:30:34.554Z")]]) {
      assert.doesNotMatch(classifyMultiCarrier(2, feed).detail, /for one obligation/);
    }
  });
});

describe("carriersBySource", () => {
  it("groups carriers by the source row they were emitted for", () => {
    const grouped = carriersBySource([{ originId: "a" }, { originId: "b" }, { originId: "a" }]);
    assert.equal(grouped.get("a").length, 2);
    assert.equal(grouped.get("b").length, 1);
    assert.equal(grouped.get("c"), undefined);
    assert.equal(carriersBySource(undefined).size, 0);
  });
});

describe("findHandoffFailures", () => {
  const stamped = issue({ monitor: { recoveryEmittedAt: "2026-11-03T18:00:00.000Z" } });
  const carrier = () => ({ originId: stamped.id });

  it("reports a stamped row with no carrier — the one reading that falsifies the design", () => {
    const { lost, duplicated, unresolved } = findHandoffFailures([stamped], []);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].identifier, "PEN-4835");
    // The source id travels with the finding so the re-check never has to look
    // the row back up by identifier, which can miss and throw.
    assert.equal(lost[0].id, stamped.id);
    assert.equal(duplicated.length, 0);
    assert.equal(unresolved.length, 0);
  });

  it("does NOT report a re-flapped row whose two carriers discharge two clears", () => {
    // PEN-5838, measured on PEN-4917: 9 cancelled clears, 2 recoveries, 2
    // carriers. An alert row is recycled, so it incurs a new obligation on every
    // flap — this is the common case in the only corpus this instrument is ever
    // pointed at, and keying on originId alone reported it as a fault.
    const feeds = new Map([
      [
        stamped.id,
        [recoveryEvent("2026-11-05T01:30:34.554Z"), recoveryEvent("2026-11-05T19:24:08.284Z")],
      ],
    ]);
    const { lost, duplicated, unresolved } = findHandoffFailures(
      [stamped],
      [carrier(), carrier()],
      feeds,
    );
    assert.deepEqual({ lost, duplicated, unresolved }, { lost: [], duplicated: [], unresolved: [] });
  });

  it("still reports two carriers that discharge the SAME clear", () => {
    // The single-flight gap: a duplicate carrier still carries the obligation,
    // so this is a defect but not a falsification of the handoff.
    const feeds = new Map([
      [stamped.id, [recoveryEvent("2026-11-05T01:30:34.554Z"), recoveryEvent("2026-11-05T01:30:34.554Z")]],
    ]);
    const { lost, duplicated, unresolved } = findHandoffFailures(
      [stamped],
      [carrier(), carrier()],
      feeds,
    );
    assert.equal(lost.length, 0);
    assert.equal(unresolved.length, 0);
    assert.equal(duplicated.length, 1);
    assert.match(duplicated[0].detail, /2 carriers across 1 distinct obligation\b/);
  });

  it("parks a multi-carrier row with no readable feed under unresolved, not duplicated", () => {
    const { duplicated, unresolved } = findHandoffFailures([stamped], [carrier(), carrier()]);
    assert.equal(duplicated.length, 0);
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].id, stamped.id);
    assert.match(unresolved[0].detail, /not established/);
  });

  it("is silent on a correctly handed-back row and on an unstamped one", () => {
    const ok = findHandoffFailures([stamped], [carrier()]);
    assert.deepEqual(ok, { lost: [], duplicated: [], unresolved: [], autoDischarged: [] });
    // Unstamped rows are still owed, not failures — they are the `owed` count.
    const unstamped = findHandoffFailures([issue()], []);
    assert.deepEqual(unstamped, { lost: [], duplicated: [], unresolved: [], autoDischarged: [] });
  });

  it("does NOT report a horizon-discharged row as lost — it is stamped with no carrier on purpose", () => {
    // The whole backfill reaches this shape once the horizon works, so scoring
    // it as `lost` would exit 1 on success and read as a falsification of
    // #3352. Same stamp as `stamped`, one extra field.
    const discharged = issue({
      monitor: {
        recoveryEmittedAt: "2026-11-03T18:00:00.000Z",
        recoveryDisposition: "auto_discharged_past_horizon",
      },
    });
    const { lost, duplicated, autoDischarged } = findHandoffFailures([discharged], []);
    assert.equal(lost.length, 0);
    assert.equal(duplicated.length, 0);
    assert.equal(autoDischarged.length, 1);
    assert.equal(autoDischarged[0].identifier, "PEN-4835");
    assert.equal(autoDischarged[0].carriers, 0);

    // A carrier on a discharged row is an anomaly, reported rather than
    // silently dropped — and still never `lost`.
    const withCarrier = findHandoffFailures([discharged], [{ originId: discharged.id }]);
    assert.equal(withCarrier.lost.length, 0);
    assert.equal(withCarrier.autoDischarged[0].carriers, 1);
    assert.match(withCarrier.autoDischarged[0].detail, /1 carrier/);
  });
});

describe("isAutoDischarged", () => {
  it("reads the disposition, and nothing adjacent to it", () => {
    assert.equal(
      isAutoDischarged(issue({ monitor: { recoveryDisposition: "auto_discharged_past_horizon" } })),
      true,
    );
    // `recovery_issue` is the sibling disposition — a carrier WAS built, so the
    // stamp looks the same and only this field separates them.
    assert.equal(
      isAutoDischarged(issue({ monitor: { recoveryDisposition: "recovery_issue" } })),
      false,
    );
    assert.equal(isAutoDischarged(issue()), false);
    assert.equal(isAutoDischarged(issue({ executionState: null })), false);
    assert.equal(isAutoDischarged(undefined), false);
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

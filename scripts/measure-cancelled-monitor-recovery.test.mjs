import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLEAR_ROUTE_PATCH,
  CLEAR_ROUTE_UNDELIVERABLE,
  cancelledClears,
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
  patchRouteClears,
  recoveryObligationKeys,
  summarize,
  tallyOwedClears,
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

  // PEN-5487. The two clear actions use DISJOINT key vocabularies for the same
  // two facts: the bare `issue.monitor_cleared` keys its reason as `reason`
  // (never `clearReason`) and its due time as `previousNextCheckAt` (never
  // `nextCheckAt`). Verified at master 8b240102 across both bare emitters in
  // `server/src/routes/issues.ts` -- the monitor route (`via:
  // "issue_monitor_route"`) and the issue PATCH route -- and all three
  // `..._cleared_undeliverable` emitters in `server/src/services/heartbeat.ts`.
  //
  // So widening this predicate to "also catch the sibling action" admits this
  // event, and `?? null` then reports its very real destroyed due time as
  // unrecoverable rather than as mis-keyed. The details below are shaped as the
  // emitter emits them, which is what also catches the widening that matches on
  // `reason`. `patchRouteClears` is the reader that does handle this event, with
  // the right keys.
  it("excludes the sibling manual-clear action, whose due time lives under a different key", () => {
    assert.deepEqual(
      destroyedDueTimes([
        {
          action: "issue.monitor_cleared",
          createdAt: "2026-11-03T22:52:34.948Z",
          details: { reason: "cancelled", previousNextCheckAt: "2026-11-04T08:15:00.000Z" },
        },
      ]),
      [],
    );
  });
});

// PEN-5518 -- the other half of the same key-vocabulary defect: the reader that
// DOES see the sibling action, and the pairing that reports it.
describe("patchRouteClears", () => {
  const sibling = {
    action: "issue.monitor_cleared",
    createdAt: "2026-11-03T22:52:34.948Z",
    details: {
      identifier: "PEN-1",
      reason: "cancelled",
      previousNextCheckAt: "2026-11-04T08:15:00.000Z",
      notes: "Outstanding: ONE human approval",
    },
  };

  it("recovers the due time from previousNextCheckAt, not nextCheckAt", () => {
    const found = patchRouteClears([sibling]);
    assert.equal(found.length, 1);
    assert.equal(found[0].dueAt, "2026-11-04T08:15:00.000Z");
    assert.equal(found[0].clearedAt, "2026-11-03T22:52:34.948Z");
    assert.equal(found[0].notes, "Outstanding: ONE human approval");
  });

  it("ignores the undeliverable action, which destroyedDueTimes already owns", () => {
    assert.deepEqual(
      patchRouteClears([
        {
          action: "issue.monitor_cleared_undeliverable",
          createdAt: "2026-11-03T01:11:40.383Z",
          details: { clearReason: "cancelled", nextCheckAt: "2026-11-03T12:00:00.000Z" },
        },
      ]),
      [],
    );
  });

  it("ignores a sibling clear for any other reason, and an empty feed", () => {
    // `manual` is 87/100 of the live sibling population: selecting on the action
    // alone would swamp the owed set with clears this measurement is not about.
    const manual = { ...sibling, details: { ...sibling.details, reason: "manual" } };
    assert.deepEqual(patchRouteClears([manual]), []);
    assert.deepEqual(patchRouteClears([]), []);
    assert.deepEqual(patchRouteClears(null), []);
  });

  it("reports a missing due time as null rather than dropping the clear", () => {
    const withoutDue = { ...sibling, details: { reason: "cancelled" } };
    assert.deepEqual(patchRouteClears([withoutDue]).map((row) => row.dueAt), [null]);
  });
});

describe("cancelledClears", () => {
  const undeliverable = {
    action: "issue.monitor_cleared_undeliverable",
    createdAt: "2026-11-03T01:11:40.383Z",
    details: { clearReason: "cancelled", nextCheckAt: "2026-11-03T12:00:00.000Z" },
  };
  const sibling = {
    action: "issue.monitor_cleared",
    createdAt: "2026-11-03T22:52:34.948Z",
    details: { reason: "cancelled", previousNextCheckAt: "2026-11-04T08:15:00.000Z" },
  };

  it("tags each clear with the route that emitted it", () => {
    const found = cancelledClears([undeliverable, sibling]);
    assert.deepEqual(
      found.map((row) => [row.route, row.dueAt]),
      [
        [CLEAR_ROUTE_UNDELIVERABLE, "2026-11-03T12:00:00.000Z"],
        [CLEAR_ROUTE_PATCH, "2026-11-04T08:15:00.000Z"],
      ],
    );
  });

  // The regression this row exists for: before `patchRouteClears` an owed row
  // whose only clear went out on the PATCH route produced NO entry at all -- not
  // even one with `dueAt: null` -- so it lowered `cancelled-clear-events-on-owed`
  // silently instead of surfacing. It carried a genuinely destroyed due time and
  // was reported strictly less than a clear we could not recover.
  it("sees an owed row whose only clear went out on the sibling action", () => {
    const found = cancelledClears([sibling]);
    assert.equal(found.length, 1);
    assert.equal(found[0].route, CLEAR_ROUTE_PATCH);
    assert.equal(found[0].dueAt, "2026-11-04T08:15:00.000Z");
  });
});

describe("tallyOwedClears", () => {
  const feed = (identifier, clears) => ({ ok: true, value: { identifier, clears } });
  const undeliverable = {
    clearedAt: "2026-11-03T01:11:40.383Z",
    dueAt: "2026-11-03T12:00:00.000Z",
    route: CLEAR_ROUTE_UNDELIVERABLE,
  };
  const sibling = {
    clearedAt: "2026-11-03T22:52:34.948Z",
    dueAt: "2026-11-04T08:15:00.000Z",
    route: CLEAR_ROUTE_PATCH,
  };

  it("counts both routes, and reports the sibling route on its own counter", () => {
    const tally = tallyOwedClears([feed("PEN-1", [undeliverable]), feed("PEN-2", [sibling])]);
    assert.equal(tally.clears, 2);
    assert.equal(tally.withDueTime, 2);
    // The discrepancy is reachable from the summary line rather than only from a
    // reader diffing `owed=` against `cancelled-clear-events-on-owed=`.
    assert.equal(tally.viaPatchRoute, 1);
    assert.deepEqual(tally.lines, [
      "DUE PEN-1 cleared=2026-11-03T01:11:40.383Z due=2026-11-03T12:00:00.000Z route=undeliverable",
      "DUE PEN-2 cleared=2026-11-03T22:52:34.948Z due=2026-11-04T08:15:00.000Z route=patch",
    ]);
  });

  it("reports an unrecovered due time as MISSING rather than dropping the line", () => {
    const tally = tallyOwedClears([feed("PEN-3", [{ ...sibling, dueAt: null }])]);
    assert.equal(tally.clears, 1);
    assert.equal(tally.withDueTime, 0);
    assert.equal(tally.viaPatchRoute, 1);
    assert.deepEqual(tally.lines, [
      "DUE PEN-3 cleared=2026-11-03T22:52:34.948Z due=MISSING route=patch",
    ]);
  });

  it("skips an unreadable feed, which the caller counts and exits on", () => {
    const tally = tallyOwedClears([
      { ok: false, item: { identifier: "PEN-4" }, error: "boom" },
      feed("PEN-5", [undeliverable]),
    ]);
    assert.equal(tally.clears, 1);
    assert.equal(tally.lines.length, 1);
  });

  it("is empty for no feeds at all", () => {
    assert.deepEqual(tallyOwedClears([]), {
      clears: 0,
      withDueTime: 0,
      viaPatchRoute: 0,
      lines: [],
    });
    assert.equal(tallyOwedClears(null).clears, 0);
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

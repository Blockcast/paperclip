import { describe, expect, it, vi } from "vitest";

import {
  createActivePauseHoldPrefilter,
  DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS,
  isAutomaticRecoverySuppressedByPauseHold,
} from "../services/recovery/pause-hold-guard.js";

/**
 * PEN-3636. `reconcileStrandedAssignedIssues` calls the pause-hold guard once per
 * candidate, and the guard's first read is scoped to the *company* — identical for every
 * candidate of that company. At a measured lower bound of 2,234 candidates in one pass and
 * ~110 ms per round-trip (queueing, not execution) that one repeated question costs minutes
 * of a single pass.
 *
 * These tests pin the three properties the optimisation rests on, because each of them
 * fails silently if broken: a prefilter that never caches is merely slow (invisible), one
 * that short-circuits on the positive answer skips the per-issue ancestor walk (wrongly
 * suppresses recovery for unaffected issues), and one with an unbounded window reintroduces
 * exactly the pass-duration-scaled staleness the TTL exists to cap.
 *
 * The directional invariant these rest on — that the prefilter's predicate stays a SUPERSET
 * of `getActivePauseHoldGate`'s — is not pinned here and is not pinned by any test. Since
 * increment 2 it is stronger than a superset: the gate reads its rows through the very
 * function the prefilter caches (`listActivePauseHolds`), so the relation is identity and
 * holds by construction.
 *
 * Increment 2 added a fourth property, and it is the one this file exists to defend now:
 * the cached rows must actually REACH the gate. A prefilter that caches the list and then
 * lets the gate re-read it is indistinguishable from the old boolean one by every assertion
 * above — same answers, same call counts on the collaborator — while buying nothing.
 */

type FakeHold = { id: string; rootIssueId: string; reason: string | null; releasePolicy: null };

type FakeSvc = {
  listActivePauseHolds: ReturnType<typeof vi.fn<(companyId: string) => Promise<FakeHold[]>>>;
  getActivePauseHoldGate: ReturnType<
    typeof vi.fn<
      (
        companyId: string,
        issueId: string,
        dbOrTx?: unknown,
        preloaded?: readonly FakeHold[],
      ) => Promise<unknown>
    >
  >;
};

function holdRow(id: string, rootIssueId = "root-1"): FakeHold {
  return { id, rootIssueId, reason: null, releasePolicy: null };
}

function fakeTreeControlSvc(opts: { anyHold: boolean; gate?: unknown }): FakeSvc {
  return {
    listActivePauseHolds: vi.fn(async (_companyId: string) => (opts.anyHold ? [holdRow("h1")] : [])),
    getActivePauseHoldGate: vi.fn(
      async (
        _companyId: string,
        _issueId: string,
        _dbOrTx?: unknown,
        _preloaded?: readonly FakeHold[],
      ) => opts.gate ?? null,
    ),
  };
}

const db = {} as never;

describe("active pause-hold prefilter", () => {
  it("answers repeated candidates of one company from a single company-scoped read", async () => {
    const svc = fakeTreeControlSvc({ anyHold: false });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    for (let i = 0; i < 50; i += 1) {
      const suppressed = await isAutomaticRecoverySuppressedByPauseHold(
        db,
        "company-1",
        `issue-${i}`,
        svc as never,
        db,
        prefilter,
      );
      expect(suppressed).toBe(false);
    }

    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(1);
    // The whole point: the per-issue gate — the expensive half — is never reached when
    // the company provably has no active pause hold.
    expect(svc.getActivePauseHoldGate).not.toHaveBeenCalled();
  });

  it("caches per company, so one company's answer never serves another", async () => {
    const svc = fakeTreeControlSvc({ anyHold: false });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    await isAutomaticRecoverySuppressedByPauseHold(db, "company-1", "i1", svc as never, db, prefilter);
    await isAutomaticRecoverySuppressedByPauseHold(db, "company-2", "i2", svc as never, db, prefilter);
    await isAutomaticRecoverySuppressedByPauseHold(db, "company-1", "i3", svc as never, db, prefilter);

    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(2);
    expect(svc.listActivePauseHolds.mock.calls.map((call) => call[0])).toEqual([
      "company-1",
      "company-2",
    ]);
  });

  it("never short-circuits on the positive answer — the per-issue ancestor walk stays live", async () => {
    // A company WITH a hold proves nothing about any particular issue: only the ancestor
    // walk inside `getActivePauseHoldGate` can decide that. Short-circuiting the positive
    // would suppress recovery for every issue in the company, including unaffected trees.
    // Note the memo does store `true` — what must never happen is the caller *acting* on it
    // without the walk, which is what this asserts.
    const svc = fakeTreeControlSvc({ anyHold: true, gate: null });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    for (let i = 0; i < 5; i += 1) {
      const suppressed = await isAutomaticRecoverySuppressedByPauseHold(
        db,
        "company-1",
        `issue-${i}`,
        svc as never,
        db,
        prefilter,
      );
      expect(suppressed).toBe(false);
    }

    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(5);
  });

  it("bounds staleness by the TTL rather than by pass duration", async () => {
    const svc = fakeTreeControlSvc({ anyHold: false });
    let clock = 0;
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { ttlMs: 5_000, now: () => clock });

    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter);
    clock = 4_999;
    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i2", svc as never, db, prefilter);
    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(1);

    clock = 5_000;
    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i3", svc as never, db, prefilter);
    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(2);
  });

  it("observes a hold created after the window expires", async () => {
    // The staleness this trades away, asserted as a bounded window rather than described:
    // the guard does start suppressing once the TTL lapses, with no new sweep needed.
    let anyHold = false;
    const svc: FakeSvc = {
      listActivePauseHolds: vi.fn(async (_companyId: string) => (anyHold ? [holdRow("h1")] : [])),
      getActivePauseHoldGate: vi.fn(async () => ({ holdId: "h1" })),
    };
    let clock = 0;
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { ttlMs: 5_000, now: () => clock });

    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter),
    ).toBe(false);

    anyHold = true;
    clock = 4_999;
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i2", svc as never, db, prefilter),
    ).toBe(false);

    clock = 5_000;
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i3", svc as never, db, prefilter),
    ).toBe(true);
  });

  it("is behaviour-preserving for callers that pass no prefilter", async () => {
    // Every call site outside the sweep keeps today's fully live per-issue read.
    const svc = fakeTreeControlSvc({ anyHold: false, gate: { holdId: "h1" } });

    const suppressed = await isAutomaticRecoverySuppressedByPauseHold(
      db,
      "company-1",
      "issue-1",
      svc as never,
    );

    expect(suppressed).toBe(true);
    expect(svc.listActivePauseHolds).not.toHaveBeenCalled();
    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(1);
  });

  it("hands the cached rows to the gate instead of letting it re-read them", async () => {
    // THE increment-2 property. Everything else in this file passes just as well against a
    // prefilter that caches the list and then lets the gate issue its own company-scoped
    // SELECT — same answers, same `listActivePauseHolds` call count — while saving nothing,
    // because the whole cost being removed is that second read. Only the argument the gate
    // receives can tell the two apart.
    const svc = fakeTreeControlSvc({ anyHold: true, gate: null });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    for (let i = 0; i < 5; i += 1) {
      await isAutomaticRecoverySuppressedByPauseHold(
        db,
        "company-1",
        `issue-${i}`,
        svc as never,
        db,
        prefilter,
      );
    }

    // One live read for five candidates...
    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(1);
    const cachedRows = await svc.listActivePauseHolds.mock.results[0]!.value;
    // ...and every gate call carries those rows, so none of the five re-reads them.
    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(5);
    for (const call of svc.getActivePauseHoldGate.mock.calls) {
      expect(call[3]).toEqual(cachedRows);
    }
  });

  it("leaves the gate reading live when no prefilter is supplied", async () => {
    // The excluded branch. `preloadedActivePauseHolds` must arrive as `undefined` rather
    // than as an empty array — an empty array is a positive claim that the company has no
    // holds, and passing one here would make the gate return null for every caller outside
    // the sweep, disabling the pause-hold guard everywhere.
    const svc = fakeTreeControlSvc({ anyHold: true, gate: { holdId: "h1" } });

    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "company-1", "issue-1", svc as never),
    ).toBe(true);

    expect(svc.listActivePauseHolds).not.toHaveBeenCalled();
    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(1);
    expect(svc.getActivePauseHoldGate.mock.calls[0]![3]).toBeUndefined();
  });

  it("holds the widened staleness window to the TTL, including for a company that already had a hold", async () => {
    // The cost of increment 2, asserted rather than only described. While the memo held a
    // boolean, a hold added ALONGSIDE an existing one was seen at once, because the gate
    // re-read the list every candidate. Now it is invisible until the TTL lapses.
    //
    // This test deliberately pins a WEAKENING. It is here so that the window is a bounded,
    // reviewed property with a number on it rather than an accident: if someone later
    // lengthens the TTL, this is the test that should make them think.
    let holds = [holdRow("h-existing", "root-A")];
    const svc: FakeSvc = {
      listActivePauseHolds: vi.fn(async (_companyId: string) => holds),
      getActivePauseHoldGate: vi.fn(
        async (
          _companyId: string,
          issueId: string,
          _dbOrTx?: unknown,
          preloaded?: readonly FakeHold[],
        ) => (preloaded ?? holds).some((hold) => hold.rootIssueId === issueId)
          ? { holdId: "x" }
          : null,
      ),
    };
    let clock = 0;
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { ttlMs: 5_000, now: () => clock });

    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "root-A", svc as never, db, prefilter),
    ).toBe(true);

    // A second hold appears, rooted on a different tree, inside the window.
    holds = [holdRow("h-existing", "root-A"), holdRow("h-new", "root-B")];
    clock = 4_999;
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "root-B", svc as never, db, prefilter),
    ).toBe(false);

    // ...and is honoured as soon as the window lapses, with no new sweep needed.
    clock = 5_000;
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "root-B", svc as never, db, prefilter),
    ).toBe(true);
  });

  it("keeps the default TTL short enough to stay well inside one recovery tick", () => {
    // The recovery chain ticks every 30 s. A default at or above that would let the
    // window the TTL exists to bound span a whole tick.
    expect(DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS).toBeGreaterThan(0);
    expect(DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS).toBeLessThanOrEqual(10_000);
  });

  it("counts the round-trips it took and the ones it removed", async () => {
    // PEN-3636: without this the saving is a projection. `memoHits` must equal exactly the
    // number of company-scoped reads that did not happen, or the figure reported on the
    // issue is not a measurement of anything.
    const svc = fakeTreeControlSvc({ anyHold: false });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    expect(prefilter.stats()).toEqual({ liveReads: 0, memoHits: 0, gateReadsAvoided: 0 });

    for (let i = 0; i < 10; i += 1) {
      await isAutomaticRecoverySuppressedByPauseHold(
        db,
        "company-1",
        `issue-${i}`,
        svc as never,
        db,
        prefilter,
      );
    }
    await isAutomaticRecoverySuppressedByPauseHold(db, "company-2", "x", svc as never, db, prefilter);

    // Two companies ⇒ two live reads; the other nine calls were answered from the memo.
    expect(prefilter.stats()).toEqual({ liveReads: 2, memoHits: 9, gateReadsAvoided: 0 });
    // The counters must agree with the collaborator rather than merely be self-consistent.
    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(2);
  });

  it("counts the gate reads the pass-through removed, separately from its own", async () => {
    // The increment-2 saving needs its own reading for the same reason the memo's did: the
    // two counters beside it are untouched by this change, so reporting them post-merge
    // would show nothing moved. A company WITH a hold is the only population that scores
    // here — the empty case short-circuits before the gate, which is why the assertion
    // above it reads 0 on the same fixture shape.
    const svc = fakeTreeControlSvc({ anyHold: true, gate: null });
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    for (let i = 0; i < 4; i += 1) {
      await isAutomaticRecoverySuppressedByPauseHold(
        db,
        "company-1",
        `issue-${i}`,
        svc as never,
        db,
        prefilter,
      );
    }

    // One live read, three memo hits — and all four candidates reached the gate with rows
    // in hand, so all four are gate reads that did not happen. The first scores on BOTH
    // `liveReads` and `gateReadsAvoided`: that read is the gate's own, hoisted.
    expect(prefilter.stats()).toEqual({ liveReads: 1, memoHits: 3, gateReadsAvoided: 4 });
    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(4);
  });

  it("books a failed read as a round-trip taken, not as a saving", async () => {
    // Counting on return would flatter the saving on exactly the passes where the database
    // is in trouble — the reading would improve as the system degraded.
    const svc: FakeSvc = {
      listActivePauseHolds: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
      getActivePauseHoldGate: vi.fn(async () => null),
    };
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    await expect(
      isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter),
    ).rejects.toThrow("connection terminated");

    expect(prefilter.stats()).toEqual({ liveReads: 1, memoHits: 0, gateReadsAvoided: 0 });
  });

  it("does not memoise a read that threw", async () => {
    // A failed read must not populate the cache: serving an empty list from a read that
    // never returned would suppress the guard on evidence that does not exist.
    let fail = true;
    const svc: FakeSvc = {
      listActivePauseHolds: vi.fn(async () => {
        if (fail) throw new Error("connection terminated");
        return [holdRow("h1")];
      }),
      getActivePauseHoldGate: vi.fn(async () => ({ holdId: "h1" })),
    };
    const prefilter = createActivePauseHoldPrefilter(svc as never, db, { now: () => 1_000 });

    await expect(
      isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter),
    ).rejects.toThrow("connection terminated");

    fail = false;
    // Same company, same instant — a cached entry would short-circuit here and return
    // `false`. It must re-read instead and observe the hold.
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i2", svc as never, db, prefilter),
    ).toBe(true);
    expect(svc.listActivePauseHolds).toHaveBeenCalledTimes(2);
  });
});

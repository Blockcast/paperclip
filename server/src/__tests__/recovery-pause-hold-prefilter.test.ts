import { describe, expect, it, vi } from "vitest";

import {
  createActivePauseHoldPrefilter,
  DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS,
  isAutomaticRecoverySuppressedByPauseHold,
} from "../services/recovery/pause-hold-guard.js";

/**
 * PEN-3636. `reconcileStrandedAssignedIssues` calls the pause-hold guard once per
 * candidate, and the guard's first read is scoped to the *company* — identical for every
 * candidate of that company. At ~3.2k candidates and a measured ~110 ms per round-trip
 * (queueing, not execution) that one repeated question costs minutes of a single pass.
 *
 * These tests pin the three properties the optimisation rests on, because each of them
 * fails silently if broken: a prefilter that never caches is merely slow (invisible), one
 * that short-circuits on the positive answer skips the per-issue ancestor walk (wrongly
 * suppresses recovery for unaffected issues), and one with an unbounded window reintroduces
 * exactly the pass-duration-scaled staleness the TTL exists to cap.
 *
 * The directional invariant these rest on — that `hasAnyActivePauseHold`'s predicate stays a
 * SUPERSET of `getActivePauseHoldGate`'s — cannot be pinned here, because this file mocks the
 * service away. It is pinned against real SQL in `issue-tree-control-service.test.ts`
 * ("keeps hasAnyActivePauseHold a superset of getActivePauseHoldGate").
 */

type FakeSvc = {
  hasAnyActivePauseHold: ReturnType<typeof vi.fn<(companyId: string) => Promise<boolean>>>;
  getActivePauseHoldGate: ReturnType<
    typeof vi.fn<(companyId: string, issueId: string) => Promise<unknown>>
  >;
};

function fakeTreeControlSvc(opts: { anyHold: boolean; gate?: unknown }): FakeSvc {
  return {
    hasAnyActivePauseHold: vi.fn(async (_companyId: string) => opts.anyHold),
    getActivePauseHoldGate: vi.fn(async (_companyId: string, _issueId: string) => opts.gate ?? null),
  };
}

const db = {} as never;

describe("active pause-hold prefilter", () => {
  it("answers repeated candidates of one company from a single company-scoped read", async () => {
    const svc = fakeTreeControlSvc({ anyHold: false });
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

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

    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(1);
    // The whole point: the per-issue gate — the expensive half — is never reached when
    // the company provably has no active pause hold.
    expect(svc.getActivePauseHoldGate).not.toHaveBeenCalled();
  });

  it("caches per company, so one company's answer never serves another", async () => {
    const svc = fakeTreeControlSvc({ anyHold: false });
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

    await isAutomaticRecoverySuppressedByPauseHold(db, "company-1", "i1", svc as never, db, prefilter);
    await isAutomaticRecoverySuppressedByPauseHold(db, "company-2", "i2", svc as never, db, prefilter);
    await isAutomaticRecoverySuppressedByPauseHold(db, "company-1", "i3", svc as never, db, prefilter);

    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(2);
    expect(svc.hasAnyActivePauseHold.mock.calls.map((call) => call[0])).toEqual([
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
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

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
    const prefilter = createActivePauseHoldPrefilter({ ttlMs: 5_000, now: () => clock });

    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter);
    clock = 4_999;
    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i2", svc as never, db, prefilter);
    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(1);

    clock = 5_000;
    await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i3", svc as never, db, prefilter);
    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(2);
  });

  it("observes a hold created after the window expires", async () => {
    // The staleness this trades away, asserted as a bounded window rather than described:
    // the guard does start suppressing once the TTL lapses, with no new sweep needed.
    let anyHold = false;
    const svc: FakeSvc = {
      hasAnyActivePauseHold: vi.fn(async (_companyId: string) => anyHold),
      getActivePauseHoldGate: vi.fn(async (_companyId: string, _issueId: string) => ({
        holdId: "h1",
      })),
    };
    let clock = 0;
    const prefilter = createActivePauseHoldPrefilter({ ttlMs: 5_000, now: () => clock });

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
    expect(svc.hasAnyActivePauseHold).not.toHaveBeenCalled();
    expect(svc.getActivePauseHoldGate).toHaveBeenCalledTimes(1);
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
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

    expect(prefilter.stats()).toEqual({ liveReads: 0, memoHits: 0 });

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
    expect(prefilter.stats()).toEqual({ liveReads: 2, memoHits: 9 });
    // The counters must agree with the collaborator rather than merely be self-consistent.
    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(2);
  });

  it("books a failed read as a round-trip taken, not as a saving", async () => {
    // Counting on return would flatter the saving on exactly the passes where the database
    // is in trouble — the reading would improve as the system degraded.
    const svc: FakeSvc = {
      hasAnyActivePauseHold: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
      getActivePauseHoldGate: vi.fn(async () => null),
    };
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

    await expect(
      isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter),
    ).rejects.toThrow("connection terminated");

    expect(prefilter.stats()).toEqual({ liveReads: 1, memoHits: 0 });
  });

  it("does not memoise a read that threw", async () => {
    // A failed read must not populate the cache: serving `present: false` from a read that
    // never returned would suppress the guard on evidence that does not exist.
    let fail = true;
    const svc: FakeSvc = {
      hasAnyActivePauseHold: vi.fn(async () => {
        if (fail) throw new Error("connection terminated");
        return true;
      }),
      getActivePauseHoldGate: vi.fn(async () => ({ holdId: "h1" })),
    };
    const prefilter = createActivePauseHoldPrefilter({ now: () => 1_000 });

    await expect(
      isAutomaticRecoverySuppressedByPauseHold(db, "c", "i1", svc as never, db, prefilter),
    ).rejects.toThrow("connection terminated");

    fail = false;
    // Same company, same instant — a cached entry would short-circuit here and return
    // `false`. It must re-read instead and observe the hold.
    expect(
      await isAutomaticRecoverySuppressedByPauseHold(db, "c", "i2", svc as never, db, prefilter),
    ).toBe(true);
    expect(svc.hasAnyActivePauseHold).toHaveBeenCalledTimes(2);
  });
});

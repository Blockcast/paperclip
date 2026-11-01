import { describe, expect, it } from "vitest";

import type { Db } from "@paperclipai/db";
import type { ReclaimClaimOutcome } from "../services/isolation-reclaim-driver.js";
import {
  DEFAULT_MAX_CLAIMS_PER_TICK,
  nextInvocationId,
  orderClaimsForTick,
  startIsolationReclaimSweep,
  sweepIsolationReclaim,
} from "../services/isolation-reclaim-sweep.js";
import type {
  IsolationReclaimSweepOptions,
  IsolationReclaimSweepScheduler,
} from "../services/isolation-reclaim-sweep.js";
import type { ReclaimJobPort } from "../services/isolation-reclaim-runner.js";
import type {
  IsolationReclaimExecutionResult,
  ReclaimableClaim,
} from "../services/isolation-workspace-reaper.js";

/** Never touched: every test supplies both seams. */
const db = {} as Db;

const port = {} as ReclaimJobPort;

const TEMPLATE = {
  namespace: "paperclip",
  image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
};

function claim(name: string): ReclaimableClaim {
  return { claimName: name, source: "agent_per_agent_volume", agentId: null };
}

function result(deleted: number, wouldDelete = 0): IsolationReclaimExecutionResult {
  return {
    requested: deleted + wouldDelete,
    deleted,
    wouldDelete,
    skippedUnsafeName: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    vanished: 0,
    failed: 0,
    notAttempted: 0,
    capped: false,
    stopReason: "complete",
  };
}

function outcome(
  c: ReclaimableClaim,
  overrides: Partial<ReclaimClaimOutcome> = {},
): ReclaimClaimOutcome {
  return {
    claimName: c.claimName,
    agentId: c.agentId,
    source: c.source,
    phase: "execute",
    ok: true,
    failureKind: null,
    detail: null,
    plan: null,
    result: result(0),
    nothingEligible: false,
    dryRun: false,
    adoptedInventory: false,
    adoptedExecute: false,
    deletionOutcomeUnknown: false,
    inventoryJobName: null,
    executeJobName: null,
    ...overrides,
  };
}

function sweepWith(
  overrides: Partial<IsolationReclaimSweepOptions> & {
    listClaims: IsolationReclaimSweepOptions["listClaims"];
    drive: IsolationReclaimSweepOptions["drive"];
  },
): ReturnType<typeof sweepIsolationReclaim> {
  return sweepIsolationReclaim(db, {
    template: TEMPLATE,
    port,
    selfClaimName: "paperclip-data",
    maxAgeDays: 7,
    invocationId: "abc1234",
    lookupWorkspaceUsage: async () => new Map(),
    ...overrides,
  });
}

describe("orderClaimsForTick", () => {
  const all = ["a", "b", "c", "d"].map(claim);

  it("sorts by name with no cursor", () => {
    const shuffled = ["c", "a", "d", "b"].map(claim);
    expect(orderClaimsForTick(shuffled, null).map((c) => c.claimName)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("resumes after the cursor", () => {
    expect(orderClaimsForTick(all, "b").map((c) => c.claimName)).toEqual(["c", "d", "a", "b"]);
  });

  it("WRAPS to the head when the cursor was the last name", () => {
    // The whole list, not an empty one. `findIndex` returns -1 here, and
    // returning [] for it would stop the rotation dead: the cursor only ever
    // advances, so nothing would ever be driven again.
    expect(orderClaimsForTick(all, "d").map((c) => c.claimName)).toEqual(["a", "b", "c", "d"]);
  });

  it("wraps when the cursor sorts past every name, having left the fleet", () => {
    expect(orderClaimsForTick(all, "zzz").map((c) => c.claimName)).toEqual(["a", "b", "c", "d"]);
  });

  it("resumes at the successor when the cursor itself has left the fleet", () => {
    // "bb" is gone; the next tick must continue at "c", not restart at "a".
    expect(orderClaimsForTick(all, "bb").map((c) => c.claimName)).toEqual(["c", "d", "a", "b"]);
  });

  it("returns the whole list when every name sorts after the cursor", () => {
    expect(orderClaimsForTick(all, "A").map((c) => c.claimName)).toEqual(["a", "b", "c", "d"]);
  });

  it("is empty for an empty fleet", () => {
    expect(orderClaimsForTick([], "b")).toEqual([]);
  });
});

describe("sweepIsolationReclaim", () => {
  it("drives every claim and sums what came back", async () => {
    const driven: string[] = [];
    const sweep = await sweepWith({
      listClaims: async () => ["b", "a"].map(claim),
      drive: async (o) => {
        driven.push(o.claim.claimName);
        return outcome(o.claim, { result: result(3) });
      },
    });

    expect(driven).toEqual(["a", "b"]);
    expect(sweep.claimsFound).toBe(2);
    expect(sweep.claimsDriven).toBe(2);
    expect(sweep.claimsOk).toBe(2);
    expect(sweep.reclaimed).toBe(6);
    expect(sweep.reclaimedIsLowerBound).toBe(false);
    expect(sweep.cursor).toBe("b");
  });

  it("drives claims one at a time, never concurrently", async () => {
    // The MDS bound is per-tick and every executor is another unlink source
    // against the same MDS; N concurrent drives multiply it by N.
    let inFlight = 0;
    let maxInFlight = 0;
    await sweepWith({
      listClaims: async () => ["a", "b", "c"].map(claim),
      drive: async (o) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return outcome(o.claim);
      },
    });

    expect(maxInFlight).toBe(1);
  });

  it("bounds the tick and defers the rest", async () => {
    const driven: string[] = [];
    const sweep = await sweepWith({
      // A literal 2, not derived from DEFAULT_MAX_CLAIMS_PER_TICK.
      maxClaimsPerTick: 2,
      listClaims: async () => ["a", "b", "c", "d"].map(claim),
      drive: async (o) => {
        driven.push(o.claim.claimName);
        return outcome(o.claim);
      },
    });

    expect(driven).toEqual(["a", "b"]);
    expect(sweep.claimsFound).toBe(4);
    expect(sweep.claimsDriven).toBe(2);
    expect(sweep.claimsDeferred).toBe(2);
    expect(sweep.cursor).toBe("b");
  });

  it("reaches the deferred tail on the next tick", async () => {
    const list = async (): Promise<ReclaimableClaim[]> => ["a", "b", "c", "d"].map(claim);
    const first: string[] = [];
    const firstSweep = await sweepWith({
      maxClaimsPerTick: 2,
      listClaims: list,
      drive: async (o) => {
        first.push(o.claim.claimName);
        return outcome(o.claim);
      },
    });

    const second: string[] = [];
    await sweepWith({
      maxClaimsPerTick: 2,
      startAfterClaimName: firstSweep.cursor,
      listClaims: list,
      drive: async (o) => {
        second.push(o.claim.claimName);
        return outcome(o.claim);
      },
    });

    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c", "d"]);
  });

  it("marks reclaimed as a lower bound when any claim reports an unknown", async () => {
    const sweep = await sweepWith({
      listClaims: async () => ["a", "b"].map(claim),
      drive: async (o) =>
        o.claim.claimName === "a"
          ? outcome(o.claim, { result: result(5) })
          : outcome(o.claim, {
              ok: false,
              failureKind: "execute_run_failed",
              result: null,
              deletionOutcomeUnknown: true,
            }),
    });

    expect(sweep.reclaimed).toBe(5);
    expect(sweep.unknownOutcomeClaims).toBe(1);
    // 5 is what was MEASURED, not what was reclaimed. An operator reading this
    // as a total reads a number that was never taken for claim b.
    expect(sweep.reclaimedIsLowerBound).toBe(true);
    expect(sweep.claimsOk).toBe(1);
    expect(sweep.claimsFailed).toBe(1);
  });

  it("sums wouldReclaim separately under dryRun", async () => {
    const sweep = await sweepWith({
      dryRun: true,
      listClaims: async () => ["a", "b"].map(claim),
      drive: async (o) => outcome(o.claim, { dryRun: true, result: result(0, 4) }),
    });

    expect(sweep.reclaimed).toBe(0);
    expect(sweep.wouldReclaim).toBe(8);
  });

  it("keeps sweeping past a failing claim", async () => {
    const driven: string[] = [];
    const sweep = await sweepWith({
      listClaims: async () => ["a", "b", "c"].map(claim),
      drive: async (o) => {
        driven.push(o.claim.claimName);
        return o.claim.claimName === "a"
          ? outcome(o.claim, { ok: false, failureKind: "inventory_run_failed", result: null })
          : outcome(o.claim, { result: result(1) });
      },
    });

    // Stopping at "a" would let one unreachable claim mask every other claim's
    // growth.
    expect(driven).toEqual(["a", "b", "c"]);
    expect(sweep.claimsFailed).toBe(1);
    expect(sweep.reclaimed).toBe(2);
  });

  it("keeps sweeping past a drive that THREW, and records it as an unknown", async () => {
    const driven: string[] = [];
    const sweep = await sweepWith({
      listClaims: async () => ["a", "b"].map(claim),
      drive: async (o) => {
        driven.push(o.claim.claimName);
        if (o.claim.claimName === "a") throw new Error("defect past the drive's own handling");
        return outcome(o.claim);
      },
    });

    expect(driven).toEqual(["a", "b"]);
    expect(sweep.claimsDriven).toBe(2);
    expect(sweep.claimsFailed).toBe(1);
    // A drive that threw past its own handling may have got as far as launching
    // an execute Job.
    expect(sweep.unknownOutcomeClaims).toBe(1);
    expect(sweep.reclaimedIsLowerBound).toBe(true);
    expect(sweep.outcomes[0]?.claimName).toBe("a");
    expect(sweep.outcomes[0]?.detail).toContain("defect past");
  });

  it("ABORTS when the claim list cannot be read", async () => {
    // A partial list is indistinguishable from a shorter fleet, so the sweep
    // would report success over a population it never saw.
    await expect(
      sweepWith({
        listClaims: async () => {
          throw new Error("connection terminated unexpectedly");
        },
        drive: async (o) => outcome(o.claim),
      }),
    ).rejects.toThrow("connection terminated");
  });

  it("passes selfClaimName through to the claim list", async () => {
    const seen: Array<string | null> = [];
    await sweepWith({
      selfClaimName: "paperclip-data",
      listClaims: async (self) => {
        seen.push(self);
        return [];
      },
      drive: async (o) => outcome(o.claim),
    });

    expect(seen).toEqual(["paperclip-data"]);
  });

  it("leaves the cursor null on a tick that drove nothing", async () => {
    const sweep = await sweepWith({
      listClaims: async () => [],
      drive: async (o) => outcome(o.claim),
    });

    expect(sweep.claimsFound).toBe(0);
    expect(sweep.claimsDriven).toBe(0);
    expect(sweep.cursor).toBeNull();
  });

  it("hands each drive the sweep's own bound and invocation id", async () => {
    const seen: Array<{ invocationId: string; maxDeletes?: number; maxAgeDays: number }> = [];
    await sweepWith({
      invocationId: "k7q2z",
      maxDeletes: 17,
      maxAgeDays: 21,
      listClaims: async () => ["a"].map(claim),
      drive: async (o) => {
        seen.push({
          invocationId: o.invocationId,
          maxDeletes: o.maxDeletes,
          maxAgeDays: o.maxAgeDays,
        });
        return outcome(o.claim);
      },
    });

    expect(seen).toEqual([{ invocationId: "k7q2z", maxDeletes: 17, maxAgeDays: 21 }]);
  });
});

describe("startIsolationReclaimSweep", () => {
  function fakeScheduler(): {
    scheduler: IsolationReclaimSweepScheduler;
    tick: () => void;
    cleared: () => boolean;
  } {
    let callback: (() => void) | null = null;
    let isCleared = false;
    return {
      scheduler: {
        setInterval: (cb) => {
          callback = cb;
          return 1 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: () => {
          isCleared = true;
        },
      },
      tick: () => callback?.(),
      cleared: () => isCleared,
    };
  }

  const baseOptions = {
    template: TEMPLATE,
    port,
    selfClaimName: null,
    maxAgeDays: 7,
    lookupWorkspaceUsage: async () => new Map(),
  };

  it("carries the rotation cursor across ticks", async () => {
    const fake = fakeScheduler();
    const driven: string[][] = [];
    let current: string[] = [];

    const stop = startIsolationReclaimSweep(
      db,
      60_000,
      {
        ...baseOptions,
        maxClaimsPerTick: 2,
        listClaims: async () => ["a", "b", "c", "d"].map(claim),
        drive: async (o) => {
          current.push(o.claim.claimName);
          return outcome(o.claim);
        },
      },
      fake.scheduler,
    );

    // The constructor runs the first tick itself.
    await new Promise((resolve) => setTimeout(resolve, 5));
    driven.push(current);
    current = [];
    fake.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    driven.push(current);

    expect(driven).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    stop();
    expect(fake.cleared()).toBe(true);
  });

  it("serializes ticks: a slow sweep is not stacked on by the next interval", async () => {
    const fake = fakeScheduler();
    // A holder rather than a bare `let`: TypeScript's control-flow analysis
    // never sees the assignment inside the Promise executor, so a plain
    // variable narrows to `null` and `release?.()` is a call on `never`.
    const gate: { release: (() => void) | null } = { release: null };
    let starts = 0;

    startIsolationReclaimSweep(
      db,
      60_000,
      {
        ...baseOptions,
        listClaims: async () => ["a"].map(claim),
        drive: async (o) => {
          starts += 1;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return outcome(o.claim);
        },
      },
      fake.scheduler,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(1);
    // Interval fires while the first sweep is still in flight.
    fake.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(1);

    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(2);
  });

  it("gives every tick a FRESH invocation id", async () => {
    const fake = fakeScheduler();
    const ids: string[] = [];

    startIsolationReclaimSweep(
      db,
      60_000,
      {
        ...baseOptions,
        listClaims: async () => ["a"].map(claim),
        drive: async (o) => {
          ids.push(o.invocationId);
          return outcome(o.claim);
        },
      },
      fake.scheduler,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A repeated id is an ADOPTION: the tick would re-attach to the previous
    // tick's Jobs instead of starting new ones.
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("survives a sweep that rejects", async () => {
    const fake = fakeScheduler();
    let attempts = 0;

    startIsolationReclaimSweep(
      db,
      60_000,
      {
        ...baseOptions,
        listClaims: async () => {
          attempts += 1;
          throw new Error("db down");
        },
        drive: async (o) => outcome(o.claim),
      },
      fake.scheduler,
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The in-flight guard must be released on the failure path too, or the
    // first bad tick wedges the sweep forever.
    expect(attempts).toBe(2);
  });
});

describe("nextInvocationId", () => {
  it("stays short enough to leave the claim its uuid", () => {
    // `reclaimJobName` budgets 63 - len("pc-reclaim-inv") - 2 - len(invocation)
    // for the CLAIM, and two claims truncated to a shared prefix collide on one
    // Job name. At 9 characters the budget is 38, which keeps 22 characters of
    // an `agent-workspace-<uuid>` name past the 16-character prefix.
    for (let i = 0; i < 200; i += 1) {
      const id = nextInvocationId(1_762_000_000_000 + i * 60_000);
      expect(id.length).toBeLessThanOrEqual(9);
      expect(id).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("differs between two ticks in the same minute", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => nextInvocationId(1_762_000_000_000)),
    );
    // Not a uniqueness guarantee — a random suffix can repeat. The property is
    // that the id is not a pure function of the minute, which is what would
    // make two deployments ticking together adopt each other's Jobs.
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("DEFAULT_MAX_CLAIMS_PER_TICK", () => {
  it("is a positive bound", () => {
    expect(DEFAULT_MAX_CLAIMS_PER_TICK).toBeGreaterThan(0);
  });
});

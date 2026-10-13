import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schedulerLeases } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acquireSchedulerLease,
  releaseSchedulerLease,
  schedulerLeaseHolder,
} from "../services/scheduler-lease.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const LEASE = "heartbeat-timer-test";

/**
 * BLO-43292. Run against a REAL postgres rather than a fake, deliberately: the
 * whole exclusion property lives in one `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE` statement and in the row lock the primary key takes. A fake would be
 * asserting that the test double is mutually exclusive.
 */
describeEmbeddedPostgres("scheduler lease (BLO-43292)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-scheduler-lease-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await db.delete(schedulerLeases);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("gives the lease to exactly one of two concurrent acquirers", async () => {
    const [a, b] = await Promise.all([
      acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 45_000 }),
      acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = a ? "a" : "b";
    expect((a ?? b)?.holderId).toBe(winner);
  });

  it("refuses a second holder while the lease is live, and lets one in once it expires", async () => {
    expect(await acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 45_000 })).not.toBeNull();
    expect(await acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 })).toBeNull();

    // Expire it by taking a 1 ms lease as the incumbent — the renewal path,
    // which is the only way to shorten a live lease. Nothing here sleeps on a
    // real TTL; the expiry test is `expires_at <= now()` on the DB clock.
    await acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const taken = await acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 });
    expect(taken?.holderId).toBe("b");
  });

  it("keeps acquired_at across a renewal and resets it on takeover", async () => {
    const first = await acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 45_000 });
    const renewed = await acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 1 });
    expect(renewed?.acquiredAt.getTime()).toBe(first?.acquiredAt.getTime());
    expect(renewed?.renewedAt.getTime()).toBeGreaterThanOrEqual(first?.renewedAt.getTime() ?? 0);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const takenOver = await acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 });
    expect(takenOver?.acquiredAt.getTime()).toBeGreaterThan(first?.acquiredAt.getTime() ?? 0);
  });

  it("releases only for the holder, so a loser cannot evict the leader", async () => {
    await acquireSchedulerLease(db, { name: LEASE, holderId: "a", ttlMs: 45_000 });
    expect(await releaseSchedulerLease(db, { name: LEASE, holderId: "b" })).toBe(false);
    expect(await acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 })).toBeNull();

    expect(await releaseSchedulerLease(db, { name: LEASE, holderId: "a" })).toBe(true);
    expect(await acquireSchedulerLease(db, { name: LEASE, holderId: "b", ttlMs: 45_000 })).not.toBeNull();
  });

  /**
   * The acceptance criterion itself: two timer-loop instances, one lease,
   * exactly one enqueues. Asserted over many ticks rather than one, because a
   * single tick would pass against a merely-lucky implementation.
   */
  it("lets exactly one of two timer loops enqueue, tick after tick", async () => {
    const enqueuedBy: string[] = [];
    const makeInstance = (pod: string) => {
      const holder = schedulerLeaseHolder(db, {
        name: LEASE,
        ttlMs: 45_000,
        renewIntervalMs: 60_000,
        identity: { pod, holderId: `${pod}#fixed` },
      });
      return {
        holder,
        // The shape of the real tick: renew/acquire, then do the gated work
        // only while this process holds the lease.
        tick: async () => {
          await holder.tick();
          if (!holder.isLeader()) return;
          enqueuedBy.push(pod);
        },
      };
    };

    const one = makeInstance("pod-1");
    const two = makeInstance("pod-2");

    for (let i = 0; i < 10; i += 1) {
      await Promise.all([one.tick(), two.tick()]);
    }

    expect(enqueuedBy).toHaveLength(10);
    expect(new Set(enqueuedBy).size).toBe(1);

    // And the loop moves when the leader stops renewing: release stands in for
    // a holder that has died or stalled past its TTL.
    const leaderPod = enqueuedBy[0];
    const leader = leaderPod === "pod-1" ? one : two;
    const survivor = leaderPod === "pod-1" ? two : one;
    await leader.holder.stop();

    enqueuedBy.length = 0;
    await survivor.tick();
    expect(enqueuedBy).toEqual([survivor.holder.identity.pod]);
  }, 60_000);

  it("demotes a holder whose renewals have lapsed past the TTL", async () => {
    let clock = 1_000_000;
    const holder = schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
      now: () => clock,
    });

    expect(await holder.tick()).toBe(true);
    expect(holder.isLeader()).toBe(true);

    // No further renewals. This is the stall the lease exists for: the process
    // is alive enough to answer `isLeader()` and not alive enough to renew, so
    // the cached verdict must be a deadline and not a boolean.
    clock += 44_000;
    expect(holder.isLeader()).toBe(true);
    clock += 2_000;
    expect(holder.isLeader()).toBe(false);
  });

  it("keeps the lease across a failed renewal until the cached deadline passes", async () => {
    let clock = 1_000_000;
    let failQueries = false;
    const flaky = {
      execute: (query: unknown) => {
        if (failQueries) return Promise.reject(new Error("connection terminated"));
        return (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(query);
      },
    };
    const holder = schedulerLeaseHolder(flaky as never, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
      now: () => clock,
    });

    expect(await holder.tick()).toBe(true);

    // A transient database error must not hand the loop over on its own: the
    // cached deadline is already the same bound the database would enforce.
    failQueries = true;
    clock += 10_000;
    expect(await holder.tick()).toBe(true);

    clock += 40_000;
    // ...and once the deadline passes it MUST hand over, errors or not. This
    // is the stalled-holder case; failing open here would put two processes on
    // the loop at precisely the moment the database lets a survivor in.
    expect(await holder.tick()).toBe(false);
    expect(holder.state().runsLoop).toBe(false);
  });

  it("stays a follower when it has NEVER reached the lease table, then takes over once it can (BLO-45763)", async () => {
    // Unknown is not leadership. At `replicas: 2` a cold replica that ran the
    // loop unleased (table not migrated, lease query erroring) would enqueue
    // alongside a healthy leader. It must retry and run only once it wins.
    let reachable = false;
    const coldDb = {
      execute: (query: unknown) => {
        if (!reachable) return Promise.reject(new Error("relation does not exist"));
        return (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(query);
      },
    };
    const holder = schedulerLeaseHolder(coldDb as never, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
    });

    expect(await holder.tick()).toBe(false);
    expect(await holder.tick()).toBe(false);
    expect(holder.isLeader()).toBe(false);
    expect(holder.state()).toMatchObject({ everAcquired: false, runsLoop: false, lastRenewedAtMs: 0 });

    reachable = true;
    expect(await holder.tick()).toBe(true);
    expect(holder.state()).toMatchObject({ everAcquired: true, runsLoop: true });
  });

  it("does NOT run the loop when it cleanly loses to a live holder", async () => {
    // A clean loss and an error both leave this process a follower.
    await acquireSchedulerLease(db, { name: LEASE, holderId: "incumbent", ttlMs: 45_000 });
    const holder = schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-2", holderId: "pod-2#fixed" },
    });

    expect(await holder.tick()).toBe(false);
    expect(holder.state()).toMatchObject({ everAcquired: false, runsLoop: false });
  });

  it("single-flights renewals and lets an in-flight one land BEFORE stop() releases", async () => {
    // A renewal held open (pool starvation) must neither stack a second query
    // nor land after the release and re-insert the row for a full TTL.
    let gate!: () => void;
    let calls = 0;
    const slow = {
      execute: async (query: unknown) => {
        calls += 1;
        if (calls === 2) await new Promise<void>((resolve) => { gate = resolve; });
        return (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(query);
      },
    };
    const holder = schedulerLeaseHolder(slow as never, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
    });
    expect(await holder.tick()).toBe(true);

    const pending = holder.tick(); // call 2, parked on the gate
    void holder.tick();
    void holder.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);

    const stopping = holder.stop();
    gate();
    expect(await pending).toBe(true);
    expect(await stopping).toBe(true);
    expect(await db.select().from(schedulerLeases)).toHaveLength(0);
    expect(await holder.tick()).toBe(false);
    expect(calls).toBe(3); // the release; no tick ran after stop
  });

  it("leaves the row to expire when stop() is told not to release", async () => {
    const holder = schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
    });
    expect(await holder.tick()).toBe(true);
    expect(await holder.stop({ release: false })).toBe(false);
    expect(holder.isLeader()).toBe(false);
    expect(await db.select().from(schedulerLeases)).toHaveLength(1);
  });

  it("fires onAcquire once on the boot leader only, and again on the survivor at takeover (BLO-45212)", async () => {
    // Stands in for the startup recovery chain: index.ts runs it from
    // onAcquire, so "fired" == "this process ran recovery".
    const recoveredBy: string[] = [];
    const make = (pod: string) => schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod, holderId: `${pod}#fixed` },
      onAcquire: () => recoveredBy.push(pod),
    });
    const one = make("pod-1");
    const two = make("pod-2");

    // Both boot together, then keep renewing: recovery ran in exactly one.
    await Promise.all([one.tick(), two.tick()]);
    for (let i = 0; i < 5; i += 1) await Promise.all([one.tick(), two.tick()]);
    expect(recoveredBy).toHaveLength(1);

    const leader = recoveredBy[0] === "pod-1" ? one : two;
    const survivor = leader === one ? two : one;
    await leader.stop();
    await survivor.tick();
    expect(recoveredBy).toEqual([leader.identity.pod, survivor.identity.pod]);
  });

  it("fires onAcquire again when the same holder re-wins after its own renewals lapsed", async () => {
    let t = Date.now();
    let fired = 0;
    const holder = schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
      now: () => t,
      onAcquire: () => { fired += 1; },
    });
    expect(await holder.tick()).toBe(true);
    expect(await holder.tick()).toBe(true);
    expect(fired).toBe(1);
    t += 46_000; // a DB stall longer than the TTL
    expect(await holder.tick()).toBe(true);
    expect(fired).toBe(2);
  });

  it("keeps the lease when onAcquire throws", async () => {
    const holder = schedulerLeaseHolder(db, {
      name: LEASE,
      ttlMs: 45_000,
      renewIntervalMs: 60_000,
      identity: { pod: "pod-1", holderId: "pod-1#fixed" },
      onAcquire: () => {
        throw new Error("boom");
      },
    });
    expect(await holder.tick()).toBe(true);
    expect(holder.isLeader()).toBe(true);
  });
});

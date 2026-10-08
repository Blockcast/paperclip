import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * BLO-36922: the dispatch critical path must run ONE fleet-wide orphan sweep
 * per wake wave, not one per waking agent.
 *
 * `startNextQueuedRunForAgent` calls `reapOrphanedRuns` from inside
 * `withAgentStartLock`, and that reap is fleet-wide — every `running` row, a
 * namespace-wide Job list, then per-run reservation reads and per-Job deletes.
 * With no coalescing, N agents waking together ran N identical whole-fleet
 * sweeps concurrently, each holding a different agent's lock and each slowing
 * the others through the single in-pod Kubernetes client. Measured signature,
 * four times in the 7d to 2026-09-27: agents entering the stall staggered over
 * ~13 minutes (3 -> 6 -> 8 -> 11 -> 14) and releasing in one step, peak hold
 * 2293s, with the DB pool idle and apiserver latency at its LOWEST throughout.
 *
 * `listManagedAgentJobs` is the sweep counter here: `reapOrphanedRuns` calls it
 * exactly once per sweep, unconditionally, before any per-run work.
 */

const listManagedAgentJobsMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/k8s-job-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.js")>();
  return { ...actual, listManagedAgentJobs: listManagedAgentJobsMock };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping start-lock reap coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("start-lock orphan reap coalescing (BLO-36922)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalTtl = process.env.AGENT_START_LOCK_REAP_TTL_MS;
  const originalWaitBound = process.env.AGENT_START_LOCK_REAP_WAIT_BOUND_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-start-lock-reap-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    listManagedAgentJobsMock.mockReset();
    listManagedAgentJobsMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (originalTtl === undefined) delete process.env.AGENT_START_LOCK_REAP_TTL_MS;
    else process.env.AGENT_START_LOCK_REAP_TTL_MS = originalTtl;
    if (originalWaitBound === undefined) delete process.env.AGENT_START_LOCK_REAP_WAIT_BOUND_MS;
    else process.env.AGENT_START_LOCK_REAP_WAIT_BOUND_MS = originalWaitBound;
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** One company with `count` idle external-lifecycle agents and no runs. */
  async function seedFleet(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent ${i}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    return { companyId, agentIds };
  }

  it("folds concurrent start-lock reaps into a single fleet sweep", async () => {
    await seedFleet(3);
    const heartbeat = heartbeatService(db);
    const gate = deferred<null>();
    let calls = 0;
    listManagedAgentJobsMock.mockImplementation(async () => {
      calls += 1;
      return gate.promise;
    });

    const waves = [
      heartbeat.reapOrphanedRunsForStartLock(),
      heartbeat.reapOrphanedRunsForStartLock(),
      heartbeat.reapOrphanedRunsForStartLock(),
    ];
    // Let all three reach the wrapper before the sweep is allowed to finish,
    // so this measures coalescing rather than sequencing.
    await vi.waitFor(() => expect(calls).toBe(1));
    gate.resolve(null);
    const dispositions = await Promise.all(waves);

    // The guard: one sweep, and the two joiners still awaited its completion
    // rather than dispatching against an unreaped fleet.
    expect(calls).toBe(1);
    expect(dispositions).toEqual(["ran", "joined", "joined"]);
  });

  it("does not serve a caller that arrives mid-sweep the in-flight sweep's stale result", async () => {
    await seedFleet(3);
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "0";
    const heartbeat = heartbeatService(db);
    const first = deferred<null>();
    const second = deferred<null>();
    let calls = 0;
    listManagedAgentJobsMock.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });

    const early = heartbeat.reapOrphanedRunsForStartLock();
    // The first sweep has read fleet state, so anything arriving now would get
    // a snapshot from before it woke if it joined this sweep.
    await vi.waitFor(() => expect(calls).toBe(1));
    let lateSettled = false;
    const late = [
      heartbeat.reapOrphanedRunsForStartLock(),
      heartbeat.reapOrphanedRunsForStartLock(),
    ];
    void Promise.all(late).then(() => {
      lateSettled = true;
    });

    first.resolve(null);
    expect(await early).toBe("ran");
    // The guard: late callers are not released by the sweep that predates
    // them. They wait for a second sweep, which they share.
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(lateSettled).toBe(false);
    second.resolve(null);
    expect(await Promise.all(late)).toEqual(["ran", "joined"]);
    expect(calls).toBe(2);
  });

  it("serves mid-sweep arrivals from the chained sweep when the in-flight one fails", async () => {
    await seedFleet(1);
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "0";
    const heartbeat = heartbeatService(db);
    const first = deferred<null>();
    let calls = 0;
    listManagedAgentJobsMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        await first.promise;
        throw new Error("apiserver unreachable");
      }
      return null;
    });

    const early = heartbeat.reapOrphanedRunsForStartLock();
    await vi.waitFor(() => expect(calls).toBe(1));
    const late = heartbeat.reapOrphanedRunsForStartLock();
    first.resolve(null);

    // The failure belongs to the sweep's own caller. The late caller never
    // depended on that sweep, so it gets its own result instead.
    await expect(early).rejects.toThrow("apiserver unreachable");
    expect(await late).toBe("ran");
    expect(calls).toBe(2);
  });

  it("skips a second sweep inside the freshness TTL, and runs again once it lapses", async () => {
    await seedFleet(2);
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "60000";
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.reapOrphanedRunsForStartLock()).toBe("ran");
    expect(listManagedAgentJobsMock).toHaveBeenCalledTimes(1);

    // Sequential, so single-flight cannot be what suppresses this one.
    expect(await heartbeat.reapOrphanedRunsForStartLock()).toBe("skipped_fresh");
    expect(listManagedAgentJobsMock).toHaveBeenCalledTimes(1);

    // Negative control for the TTL arm: with the window disabled, the same
    // sequential second call must sweep. Without this, a wrapper that never
    // reaps again would pass the assertion above.
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "0";
    const freshHeartbeat = heartbeatService(db);
    expect(await freshHeartbeat.reapOrphanedRunsForStartLock()).toBe("ran");
    expect(await freshHeartbeat.reapOrphanedRunsForStartLock()).toBe("ran");
    expect(listManagedAgentJobsMock).toHaveBeenCalledTimes(3);
  });

  it("does not latch the in-flight slot when a sweep fails", async () => {
    await seedFleet(1);
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "0";
    const heartbeat = heartbeatService(db);
    listManagedAgentJobsMock.mockRejectedValueOnce(new Error("apiserver unreachable"));

    // A failing sweep must reject for its callers (same as before this change)
    // and must clear the slot, or every later wake would join a dead promise
    // and dispatch would stop for the life of the process.
    await expect(heartbeat.reapOrphanedRunsForStartLock()).rejects.toThrow("apiserver unreachable");
    expect(await heartbeat.reapOrphanedRunsForStartLock()).toBe("ran");
  });

  it("leaves direct reapOrphanedRuns callers uncoalesced", async () => {
    await seedFleet(1);
    const heartbeat = heartbeatService(db);

    // The periodic reaper and the recovery tests call `reapOrphanedRuns`
    // directly and rely on row-level dedup, a separate invariant. Coalescing
    // must not have been pushed down into the sweep itself.
    await Promise.all([
      heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true }),
      heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true }),
    ]);
    expect(listManagedAgentJobsMock).toHaveBeenCalledTimes(2);
  });

  /**
   * BLO-41036. Coalescing (every test above) is what makes this necessary: the
   * sweep is single-flight across the fleet, so one that does not return holds
   * EVERY agent's start lock, not just its own. Measured on `d5268bc0`
   * 2026-10-07T00:26-00:48Z — nine agents in phase `reap`, the hold climbing
   * +120s per 120s scrape to 1049s and still rising, 0 run starts in 22
   * minutes, 544 runs queued, released only by `helm rollback`.
   *
   * The guard is that the caller STOPS WAITING, not that the sweep is
   * cancelled: dispatch proceeds on stale orphan state (the already-supported
   * `skipped_fresh` cost) instead of a slow section being aborted, which is the
   * livelock documented on `LOCK_ABORT_MS`.
   */
  it("gives up waiting on a sweep that never returns instead of holding dispatch", async () => {
    await seedFleet(2);
    process.env.AGENT_START_LOCK_REAP_WAIT_BOUND_MS = "50";
    const heartbeat = heartbeatService(db);
    const wedged = deferred<null>();
    let calls = 0;
    listManagedAgentJobsMock.mockImplementation(async () => {
      calls += 1;
      return wedged.promise;
    });

    // The originator of the wedged sweep must not wait on it forever...
    const first = heartbeat.reapOrphanedRunsForStartLock();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(await first).toBe("timed_out");

    // ...and neither must an agent arriving mid-sweep, which is the fleet-wide
    // half of the outage. Its chained sweep is queued behind the wedged one, so
    // it inherits the wedge without ever running: one stuck sweep parks every
    // later waker. That is what took 100% of dispatch, not the first caller.
    expect(await heartbeat.reapOrphanedRunsForStartLock()).toBe("timed_out");

    // Still exactly one sweep: the chained sweep never got to read fleet state,
    // and giving up on the wait must not start a replacement.
    expect(calls).toBe(1);

    wedged.resolve(null);
  });
});

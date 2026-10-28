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
 * PEN-4736: the PERIODIC orphan sweep must run ONE fleet-wide sweep per pass,
 * not one per row it acts on.
 *
 * `reapOrphanedRuns` dispatches per reaped row via `startNextQueuedRunForAgent`,
 * which takes `withAgentStartLock` and — for external-lifecycle agents — calls
 * `reapOrphanedRunsForStartLock` from inside it. The periodic sweep never runs
 * inside `agentStartLockSweepContext`, so that nested call misses the cheap
 * `nested` branch and schedules a WHOLE NEW FLEET SWEEP; the `skipped_fresh`
 * short-circuit is unreachable too, because `START_LOCK_REAP_TTL_DEFAULT_MS` is
 * 0. Cost was (rows acted on) x (fleet sweep), both terms growing with run
 * population — measured at N^2.29 on PEN-4734 (6.74 runs -> 1.15 s/sweep;
 * 24.18 runs -> 21.20 s/sweep), with
 * `paperclip_agent_start_lock_reap_disposition_total{disposition="timed_out"}`
 * 26 -> 405 and `PaperclipRecoveryChainHeadroomLow` firing 181 min/24 h.
 *
 * ⚠️ The `nested` disposition counter CANNOT observe this path, and a previous
 * investigation was misled by exactly that: `nested` is returned only from
 * inside the sweep context the periodic reaper never enters, so periodic-origin
 * re-entry counts as `ran`/`joined`/`timed_out`. A `nested` of 0 is fully
 * consistent with this path being taken on every sweep. Do not re-derive that
 * refutation from the counter.
 *
 * `listManagedAgentJobs` is the sweep counter here, for the same reason the
 * BLO-36922 coalescing suite uses it: `reapOrphanedRuns` calls it exactly once
 * per sweep, unconditionally, before any per-run work.
 */

const listManagedAgentJobsMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/k8s-job-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.js")>();
  return { ...actual, listManagedAgentJobs: listManagedAgentJobsMock };
});

const { heartbeatService } = await import("../services/heartbeat.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping periodic reap nested-sweep tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The periodic tick's staleness threshold, from `index.ts`. */
const PERIODIC_STALE_THRESHOLD_MS = 5 * 60 * 1000;

describeEmbeddedPostgres("periodic orphan reap nested fleet sweeps (PEN-4736)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalTtl = process.env.AGENT_START_LOCK_REAP_TTL_MS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-periodic-reap-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    listManagedAgentJobsMock.mockReset();
    listManagedAgentJobsMock.mockResolvedValue(null);
    // Pin the TTL off, so a `skipped_fresh` short-circuit cannot mask a nested
    // sweep and make an unfixed tree look fixed. This is the production default
    // (`START_LOCK_REAP_TTL_DEFAULT_MS`), asserted rather than assumed.
    process.env.AGENT_START_LOCK_REAP_TTL_MS = "0";
  });

  afterEach(async () => {
    if (originalTtl === undefined) delete process.env.AGENT_START_LOCK_REAP_TTL_MS;
    else process.env.AGENT_START_LOCK_REAP_TTL_MS = originalTtl;
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

  /**
   * One company with `count` external-lifecycle agents, each holding a stale
   * `running` run with no live Job — i.e. `count` rows the sweep will act on.
   *
   * `claude_k8s` is load-bearing: `hasExternalLifecycle` gates the nested
   * start-lock reap, so a `process` agent would not reach it and the test would
   * pass on an unfixed tree.
   */
  async function seedOrphanedFleet(count: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const stale = new Date(Date.now() - 10 * PERIODIC_STALE_THRESHOLD_MS);
    const agentIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent ${i}`,
        role: "engineer",
        status: "running",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {},
        startedAt: stale,
        createdAt: stale,
        updatedAt: stale,
        lastOutputAt: stale,
      });
    }
    return { companyId, agentIds };
  }

  /**
   * The guard. Asserted as a CONJUNCTION with the reap count rather than alone:
   * "one sweep" on its own would also pass on a tree where the reap silently
   * stopped acting on rows at all, which is the failure mode that matters most
   * here — a sweep that reaps nothing is cheap and useless.
   *
   * Both halves discriminate. Removing `suppressDispatchAfterReap: true` from
   * `reapOrphanedRunsPeriodic` fails the sweep count (1 -> 2..4 observed, since
   * how many rows promote rather than dispatch varies) and also drops the reap
   * count, because the nested sweeps consume orphan rows the outer pass would
   * otherwise have finalized.
   */
  it("runs exactly one fleet sweep per periodic pass regardless of how many rows it reaps", async () => {
    const { agentIds } = await seedOrphanedFleet(4);
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.reapOrphanedRunsPeriodic({
      staleThresholdMs: PERIODIC_STALE_THRESHOLD_MS,
    });

    expect(listManagedAgentJobsMock).toHaveBeenCalledTimes(1);
    // ...and the rows really were acted on, so that single sweep is a fixed
    // re-entrancy and not an empty pass.
    expect(result.reaped).toBe(agentIds.length);
  });

  /**
   * Characterization of the defect itself, and the mutation control: this is
   * the call the periodic tick used to make. It pins that the suppression flag
   * is what does the work, so deleting
   * `suppressDispatchAfterReap: true` from `reapOrphanedRunsPeriodic` turns the
   * case above red rather than merely making it slower — a cost regression is
   * otherwise invisible to a functional suite.
   *
   * Asserted as a lower bound (`>`) rather than exactly 1 + N: the per-row
   * dispatch is reached only for rows that did not promote a queued
   * continuation, and one extra coalesced sweep is admissible. The property
   * under test is "per-row sweeps happen at all", not their exact count.
   */
  it("characterizes the unsuppressed call it replaced: per-row dispatch nests extra fleet sweeps", async () => {
    await seedOrphanedFleet(4);
    const heartbeat = heartbeatService(db);

    await heartbeat.reapOrphanedRuns({ staleThresholdMs: PERIODIC_STALE_THRESHOLD_MS });

    expect(listManagedAgentJobsMock.mock.calls.length).toBeGreaterThan(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, externalRuntimeReservations, heartbeatRuns } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { claimRunWithExternalRuntimeSlotPool } from "../services/external-runtime-reservations.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

/**
 * BLO-44457. `withAgentStartLock` is in-process only, so with `replicas > 1` two
 * dispatch passes for one agent can run at once — one from the timer leader,
 * one from an HTTP wake on the other replica. This pins that the exclusion the
 * fleet's adapters (claude_k8s / opencode_k8s, i.e. every external-lifecycle
 * agent) rely on lives in the DATABASE, not in that lock:
 *
 *  - per run:   `SELECT ... FOR UPDATE` on the run row + `status = 'queued'` CAS;
 *  - per agent: the partial unique index `external_runtime_reservations_active_slot_idx`
 *               on (agent_id, slot_id) WHERE released_at IS NULL caps concurrent
 *               runs at `maxConcurrentRuns` across processes.
 *
 * Two separate `createDb` pools stand in for two replicas: from Postgres's point
 * of view they are two unrelated clients. A fake would only prove the test
 * double is exclusive.
 */
describeEmbeddedPostgres("cross-process queued-run claim (BLO-44457)", () => {
  let replicaA!: Db;
  let replicaB!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-claim-");
    replicaA = createDb(tempDb.connectionString);
    replicaB = createDb(tempDb.connectionString);
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await replicaA.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await replicaA.insert(agents).values({
      id: agentId,
      companyId,
      name: "K8sAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await replicaA.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "queued",
      contextSnapshot: {},
    });
    return runId;
  }

  async function activeReservations(agentId: string) {
    return replicaA
      .select()
      .from(externalRuntimeReservations)
      .where(and(eq(externalRuntimeReservations.agentId, agentId), isNull(externalRuntimeReservations.releasedAt)));
  }

  it("lets exactly one of two replicas claim the same queued run", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);

    const claims = await Promise.all([
      claimRunWithExternalRuntimeSlotPool(replicaA, runId, new Date(), 2),
      claimRunWithExternalRuntimeSlotPool(replicaB, runId, new Date(), 2),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await activeReservations(agentId)).toHaveLength(1);
    const [run] = await replicaA.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("running");
  });

  it("holds maxConcurrentRuns=1 when two replicas claim DIFFERENT queued runs of one agent", async () => {
    // The case the per-run CAS alone cannot catch: no run is claimed twice, yet
    // two pods would start for an agent capped at one.
    const { companyId, agentId } = await seedAgent();
    const runA = await seedQueuedRun(companyId, agentId);
    const runB = await seedQueuedRun(companyId, agentId);

    const claims = await Promise.all([
      claimRunWithExternalRuntimeSlotPool(replicaA, runA, new Date(), 1),
      claimRunWithExternalRuntimeSlotPool(replicaB, runB, new Date(), 1),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await activeReservations(agentId)).toHaveLength(1);
    const statuses = await replicaA
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(statuses.map((row) => row.status).sort()).toEqual(["queued", "running"]);
  });

  it("still fills every slot when the cap allows it (no new way to fail closed)", async () => {
    const { companyId, agentId } = await seedAgent();
    const runA = await seedQueuedRun(companyId, agentId);
    const runB = await seedQueuedRun(companyId, agentId);

    const claims = await Promise.all([
      claimRunWithExternalRuntimeSlotPool(replicaA, runA, new Date(), 2),
      claimRunWithExternalRuntimeSlotPool(replicaB, runB, new Date(), 2),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(2);
    expect((await activeReservations(agentId)).map((row) => row.slotId).sort()).toEqual([0, 1]);
  });
});

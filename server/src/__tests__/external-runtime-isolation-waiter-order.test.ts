import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, externalRuntimeReservations, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  bindExternalRuntimeReservationIsolation,
  ExternalRuntimeIsolationConflictError,
  releaseExternalRuntimeReservation,
} from "../services/external-runtime-reservations.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * BLO-48769: waiters on one non-run isolation key were admitted by whichever
 * reached bind first after a release, so the oldest waiter (at the 5-min
 * backoff cap) lost to younger runs for hours. Bind now yields to the oldest
 * live waiter, and a release pulls that waiter's backoff forward.
 */
describeEmbeddedPostgres("isolation writer admits waiters oldest-first (BLO-48769)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("isolation-waiter-order-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Waiter Co", issuePrefix: "WTR" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "K8s agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let slot = 0;
  async function insertRun(input: { createdAt: Date; status: string; context?: Record<string, unknown> }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      contextSnapshot: input.context ?? {},
      createdAt: input.createdAt,
    });
    return id;
  }
  async function reserve(runId: string) {
    const [row] = await db.insert(externalRuntimeReservations).values({
      companyId,
      agentId,
      runId,
      slotId: slot++,
      state: "reserved",
      isolationMode: "pending",
      isolationKey: `pending:${runId}`,
      isolationBoundAt: new Date(),
    }).returning();
    return row!;
  }
  function waiting(key: string, retryAt: Date) {
    return {
      paperclipK8sIsolationWaitKey: key,
      paperclipK8sIsolationRetryAt: retryAt.toISOString(),
    };
  }
  const bind = (runId: string, reservationId: string, key: string) =>
    bindExternalRuntimeReservationIsolation(db, { runId, reservationId, isolationMode: "workspace", isolationKey: key });

  it("makes a younger contender yield to an older live waiter, then lets the elder in", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    const now = Date.now();
    const elder = await insertRun({
      createdAt: new Date(now - 6 * 3600_000),
      status: "queued",
      context: waiting(key, new Date(now + 4 * 60_000)),
    });
    const young = await insertRun({ createdAt: new Date(now - 60_000), status: "running" });

    const youngRes = await reserve(young);
    const err = await bind(young, youngRes.id, key).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalRuntimeIsolationConflictError);
    expect((err as ExternalRuntimeIsolationConflictError).conflictingRunId).toBe(elder);

    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, elder));
    const elderRes = await reserve(elder);
    const bound = await bind(elder, elderRes.id, key);
    expect(bound.isolationKey).toBe(key);
  });

  it("does not yield to a waiter that stopped retrying", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    const now = Date.now();
    await insertRun({
      createdAt: new Date(now - 6 * 3600_000),
      status: "queued",
      context: waiting(key, new Date(now - 20 * 60_000)),
    });
    const young = await insertRun({ createdAt: new Date(now - 60_000), status: "running" });
    const youngRes = await reserve(young);
    expect((await bind(young, youngRes.id, key)).isolationKey).toBe(key);
  });

  it("does not make an older contender yield to a younger waiter", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    const now = Date.now();
    await insertRun({
      createdAt: new Date(now - 60_000),
      status: "queued",
      context: waiting(key, new Date(now + 4 * 60_000)),
    });
    const old = await insertRun({ createdAt: new Date(now - 3600_000), status: "running" });
    const oldRes = await reserve(old);
    expect((await bind(old, oldRes.id, key)).isolationKey).toBe(key);
  });

  it("on writer release, pulls only the oldest live waiter's backoff forward", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    const now = Date.now();
    const later = new Date(now + 4 * 60_000);
    const oldest = await insertRun({ createdAt: new Date(now - 3 * 3600_000), status: "queued", context: waiting(key, later) });
    const next = await insertRun({ createdAt: new Date(now - 3600_000), status: "queued", context: waiting(key, later) });
    const writer = await insertRun({ createdAt: new Date(now - 7200_000), status: "running" });
    const writerRes = await reserve(writer);
    await db.update(externalRuntimeReservations)
      .set({ isolationMode: "workspace", isolationKey: key })
      .where(eq(externalRuntimeReservations.id, writerRes.id));

    await releaseExternalRuntimeReservation(db, { runId: writer, reason: "test" });

    const retryAt = async (id: string) => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      return new Date(String(row!.contextSnapshot!.paperclipK8sIsolationRetryAt)).getTime();
    };
    expect(await retryAt(oldest)).toBeLessThanOrEqual(Date.now());
    expect(await retryAt(next)).toBe(later.getTime());
  });

  it("treats a waiter with a malformed retry stamp as not live instead of failing the bind", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    await insertRun({
      createdAt: new Date(Date.now() - 3600_000),
      status: "queued",
      context: { paperclipK8sIsolationWaitKey: key, paperclipK8sIsolationRetryAt: "not-a-date" },
    });
    const run = await insertRun({ createdAt: new Date(), status: "running" });
    const res = await reserve(run);
    expect((await bind(run, res.id, key)).isolationKey).toBe(key);
  });

  it("releasing a yielded run's still-pending reservation does not refresh the elder's stamp", async () => {
    const key = `workspace-tree:project-primary:${randomUUID()}`;
    const now = Date.now();
    const stamp = new Date(now + 4 * 60_000);
    const elder = await insertRun({ createdAt: new Date(now - 6 * 3600_000), status: "queued", context: waiting(key, stamp) });
    const young = await insertRun({ createdAt: new Date(now - 60_000), status: "running" });
    const youngRes = await reserve(young);
    await expect(bind(young, youngRes.id, key)).rejects.toBeInstanceOf(ExternalRuntimeIsolationConflictError);

    await releaseExternalRuntimeReservation(db, { runId: young, reason: "test" });

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, elder));
    expect(row!.contextSnapshot!.paperclipK8sIsolationRetryAt).toBe(stamp.toISOString());
  });
});

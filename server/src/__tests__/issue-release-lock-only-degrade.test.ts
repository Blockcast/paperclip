import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
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
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping release lock-only degrade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * BLO-27356: `svc.release` refused outright when the actor was no longer the
 * assignee, so a run that held the issue's execution lock could not let go of
 * it. The stale pair "A holds the lock, B is the assignee" is produced by
 * ordinary operation — a manager hand-back whose releasing run stays alive, the
 * heartbeat's reassignment lock-release deliberately sparing a `running`
 * holder, `escalateStaleRunRefire`, `agents.remove` — so B parked waiting for a
 * lock A was structurally unable to release.
 *
 * The fix degrades that refusal to a lock-only relinquish. The assertion that
 * actually catches the bug is NOT that `assigneeAgentId` survives — it is that
 * B's own heartbeat run survives, because the naive patch (delete the assignee
 * check) reaches `cancelStaleIssueContextRuns`, which is called with no
 * `keepRunId` and cancels every never-started run whose contextSnapshot names
 * this issue. That includes B's.
 */
describeEmbeddedPostgres("issue release: lock-only degrade for a non-assignee lock holder", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-release-degrade-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    // Order matters: heartbeat_runs.wakeup_request_id FKs into
    // agent_wakeup_requests, and issues FK into heartbeat_runs, so the wake
    // rows have to go last of the three.
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /**
   * A never-started run whose contextSnapshot names the issue — precisely the
   * shape `cancelStaleIssueContextRuns` reaps. `queued` is load-bearing: the
   * cascade only touches STALE_ISSUE_CONTEXT_RUN_STATUSES
   * (`queued` / `scheduled_retry`), so seeding this as `running` would make
   * every "B survived" assertion below pass without exercising anything. The
   * positive control at the end of this file pins that.
   */
  async function seedQueuedRunForIssue(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    return { runId, wakeupRequestId };
  }

  /** A running holder run — the lock A is trying to relinquish. */
  async function seedHolderRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    return runId;
  }

  /**
   * The stale pair: A's run holds both lock columns, B is the assignee.
   */
  async function seedStalePair(options: { lockedColumns?: "both" | "checkoutOnly" } = {}) {
    const companyId = await seedCompany();
    const agentA = await seedAgent(companyId, "Agent A");
    const agentB = await seedAgent(companyId, "Agent B");

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentB,
    });

    const runA = await seedHolderRun(companyId, agentA, issueId);
    await db
      .update(issues)
      .set({
        checkoutRunId: runA,
        executionRunId: options.lockedColumns === "checkoutOnly" ? null : runA,
        executionAgentNameKey: "agent a",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    return { companyId, agentA, agentB, issueId, runA };
  }

  const readIssue = async (issueId: string) =>
    db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
  const readRun = async (runId: string) =>
    db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
  const readWake = async (wakeId: string) =>
    db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]);

  it("AC-1: lets the lock holder relinquish the lock after the assignee changed", async () => {
    const { agentA, issueId, runA } = await seedStalePair();

    const released = await issueService(db).release(issueId, agentA, runA);

    expect(released).not.toBeNull();
    const after = await readIssue(issueId);
    expect(after?.checkoutRunId).toBeNull();
    expect(after?.executionRunId).toBeNull();
    expect(after?.executionAgentNameKey).toBeNull();
    expect(after?.executionLockedAt).toBeNull();
  });

  it("AC-2: leaves assigneeAgentId and status untouched, so the takeover still wins", async () => {
    const { agentA, agentB, issueId, runA } = await seedStalePair();

    await issueService(db).release(issueId, agentA, runA);

    const after = await readIssue(issueId);
    expect(after?.assigneeAgentId).toBe(agentB);
    expect(after?.status).toBe("in_progress");
  });

  it("AC-3: does not cancel the new assignee's run (the cancelStaleIssueContextRuns cascade)", async () => {
    const { companyId, agentA, agentB, issueId, runA } = await seedStalePair();
    const bRun = await seedQueuedRunForIssue(companyId, agentB, issueId);

    await issueService(db).release(issueId, agentA, runA);

    // The whole point of the issue. A patch that merely deletes the assignee
    // check leaves assigneeAgentId intact (so AC-2 passes) while the cascade
    // cancels this run out from under B.
    const bRunAfter = await readRun(bRun.runId);
    expect(bRunAfter?.status).toBe("queued");
    expect(bRunAfter?.finishedAt).toBeNull();
    expect(bRunAfter?.errorCode).toBeNull();

    const bWakeAfter = await readWake(bRun.wakeupRequestId);
    expect(bWakeAfter?.status).toBe("queued");
  });

  it("AC-4: still refuses an actor that holds no lock and is not the assignee", async () => {
    const { companyId, issueId } = await seedStalePair();
    const strangerAgent = await seedAgent(companyId, "Agent C");
    const strangerRun = await seedHolderRun(companyId, strangerAgent, issueId);

    await expect(issueService(db).release(issueId, strangerAgent, strangerRun)).rejects.toThrow(
      /Only assignee can release issue/,
    );

    const after = await readIssue(issueId);
    expect(after?.checkoutRunId).not.toBeNull();
  });

  it("refuses a run that owns only one half of a divergent lock pair", async () => {
    // A owns checkoutRunId; a different run owns executionRunId. Owning one
    // column is not ownership — relinquishing here would drop a lock the other
    // run still holds.
    const { companyId, agentA, issueId, runA } = await seedStalePair({
      lockedColumns: "checkoutOnly",
    });
    const foreignRun = await seedHolderRun(companyId, await seedAgent(companyId, "Agent D"), issueId);
    await db.update(issues).set({ executionRunId: foreignRun }).where(eq(issues.id, issueId));

    await expect(issueService(db).release(issueId, agentA, runA)).rejects.toThrow(
      /Only assignee can release issue/,
    );

    const after = await readIssue(issueId);
    expect(after?.checkoutRunId).toBe(runA);
    expect(after?.executionRunId).toBe(foreignRun);
  });

  it("POSITIVE CONTROL: an ordinary assignee release still clobbers the row and still reaps that run shape", async () => {
    // Two jobs. (1) Non-regression: the normal path is untouched. (2) It proves
    // the AC-3 fixture is not vacuous — an identically-shaped `queued` run IS
    // cancelled by the cascade when release takes its ordinary path, so AC-3
    // passing means the degrade genuinely skipped the cascade rather than the
    // cascade being harmless against this fixture.
    const companyId = await seedCompany();
    const ownerAgent = await seedAgent(companyId, "Owner");

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgent,
    });
    const ownerRun = await seedHolderRun(companyId, ownerAgent, issueId);
    await db
      .update(issues)
      .set({
        checkoutRunId: ownerRun,
        executionRunId: ownerRun,
        executionAgentNameKey: "owner",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));

    const collateral = await seedQueuedRunForIssue(companyId, ownerAgent, issueId);

    await issueService(db).release(issueId, ownerAgent, ownerRun);

    const after = await readIssue(issueId);
    expect(after?.status).toBe("todo");
    expect(after?.assigneeAgentId).toBeNull();
    expect(after?.checkoutRunId).toBeNull();
    expect(after?.executionRunId).toBeNull();

    const collateralAfter = await readRun(collateral.runId);
    expect(collateralAfter?.status).toBe("cancelled");
    expect(collateralAfter?.errorCode).toBe("issue_released");
  });
});

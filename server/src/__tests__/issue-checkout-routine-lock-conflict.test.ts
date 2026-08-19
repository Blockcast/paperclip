import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

/**
 * PEN-2395. `assertCheckoutOwner` answers an authorization question by writing:
 * it adopts an unowned/stale checkout so the calling run may proceed. Every one
 * of those adoption writes sets `execution_run_id`, which is in the predicate of
 * the `issues_open_routine_execution_uq` partial index. So when a sibling open
 * execution of the same routine already holds the dispatch lock, the adoption
 * write raises 23505 and the *caller's* mutation returns 500.
 *
 * On the live board this made PEN-2368 read as permanently unmanageable: every
 * `PATCH` failed, including a no-op `priority` write, because the failure
 * happens in the permission check before the payload is looked at. `GET` and
 * `POST .../comments` kept working (neither adopts), and a sibling row took the
 * identical payload — which is what made it look like row corruption rather than
 * a lock conflict.
 *
 * These tests use embedded Postgres deliberately: the whole defect lives in a
 * partial unique index, so a mocked db would pin nothing.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routine-lock conflict DB tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("checkout adoption vs open routine-execution lock (PEN-2395)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Devops",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status,
      contextSnapshot: {},
    });
    return runId;
  }

  async function readIssueLockState(issueId: string) {
    return db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Reproduces the live shape: two open executions of ONE routine, where the
   * owner holds the dispatch lock (`execution_run_id` set, so it occupies the
   * partial index) and the victim does not (so it is adoptable, and adopting it
   * collides). This is reachable in production because the index only covers
   * rows with `execution_run_id is not null` — a bypassed fire can create a
   * second open execution with a null lock and no 23505 at creation time.
   */
  async function seedDuplicateRoutineExecutions() {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const routineId = randomUUID();
    const fingerprint = "shared-dispatch-fingerprint";

    const ownerRunId = await seedRun(companyId, agentId, "running");
    const ownerIssueId = randomUUID();
    await db.insert(issues).values({
      id: ownerIssueId,
      companyId,
      identifier: "PEN-OWNER",
      title: "CI pipeline health check",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: fingerprint,
      executionRunId: ownerRunId,
      executionLockedAt: new Date(),
    });

    const victimIssueId = randomUUID();
    await db.insert(issues).values({
      id: victimIssueId,
      companyId,
      identifier: "PEN-VICTIM",
      title: "CI pipeline health check",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: fingerprint,
      checkoutRunId: null,
      executionRunId: null,
    });

    const actorRunId = await seedRun(companyId, agentId, "running");
    return { companyId, agentId, ownerIssueId, ownerRunId, victimIssueId, actorRunId };
  }

  it("rejects with 409 naming the lock owner instead of a 500", async () => {
    const { victimIssueId, ownerIssueId, ownerRunId, agentId, actorRunId } =
      await seedDuplicateRoutineExecutions();

    const error = await svc
      .assertCheckoutOwner(victimIssueId, agentId, actorRunId)
      .then(() => null)
      .catch((caught: unknown) => caught as {
        status?: number;
        message?: string;
        details?: {
          ownerIssueId?: string | null;
          ownerIdentifier?: string | null;
          ownerExecutionRunId?: string | null;
        };
      });

    // The regression criterion. Before the fix this surfaced the raw
    // DrizzleQueryError, which the route layer renders as 500 — so an agent
    // could not park, block, or cancel the duplicate execution at all, and
    // retrying (the natural reaction to a 500) could never succeed.
    expect(error, "adoption must not succeed while a sibling holds the lock").not.toBeNull();
    expect(error?.status).toBe(409);
    expect(error?.details?.ownerIssueId).toBe(ownerIssueId);
    expect(error?.details?.ownerIdentifier).toBe("PEN-OWNER");
    expect(error?.details?.ownerExecutionRunId).toBe(ownerRunId);
  });

  it("leaves the victim row untouched, so the failure is not half-applied", async () => {
    const { victimIssueId, agentId, actorRunId } = await seedDuplicateRoutineExecutions();

    await svc.assertCheckoutOwner(victimIssueId, agentId, actorRunId).catch(() => null);

    const victim = await readIssueLockState(victimIssueId);

    expect(victim?.status).toBe("in_progress");
    expect(victim?.checkoutRunId).toBeNull();
    expect(victim?.executionRunId).toBeNull();
  });

  it("reaps a sibling lock held by a dead run and adopts, rather than wedging forever", async () => {
    // The index does not check run liveness, so a lock left behind by a
    // terminal run occupies it exactly as a live one does. Without reaping,
    // every other execution of that routine stays unwritable indefinitely with
    // nothing actually owning the work — which is what makes the fault read as
    // permanent rather than as a transient lock conflict.
    const { victimIssueId, ownerIssueId, ownerRunId, agentId, actorRunId } =
      await seedDuplicateRoutineExecutions();

    await db
      .update(heartbeatRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, ownerRunId));

    const ownership = await svc.assertCheckoutOwner(victimIssueId, agentId, actorRunId);
    expect(ownership).toBeTruthy();

    const victim = await readIssueLockState(victimIssueId);
    expect(victim?.executionRunId).toBe(actorRunId);

    const owner = await readIssueLockState(ownerIssueId);
    expect(owner?.executionRunId, "the dead run's lock must be released").toBeNull();
  });

  it("adopts normally once the sibling releases the dispatch lock", async () => {
    const { victimIssueId, ownerIssueId, agentId, actorRunId } =
      await seedDuplicateRoutineExecutions();

    // Releasing the owner's `execution_run_id` drops it out of the partial
    // index, which is exactly what happened on the live board when the owning
    // run finished and the previously "unmanageable" PATCH started succeeding.
    await db
      .update(issues)
      .set({ executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, ownerIssueId));

    const ownership = await svc.assertCheckoutOwner(victimIssueId, agentId, actorRunId);

    expect(ownership).toBeTruthy();
    const victim = await readIssueLockState(victimIssueId);
    expect(victim?.checkoutRunId).toBe(actorRunId);
    expect(victim?.executionRunId).toBe(actorRunId);
  });
});

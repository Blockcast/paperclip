import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES,
  ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES,
  TERMINAL_HEARTBEAT_RUN_STATUS_VALUES,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  runStatusHoldsIssueExecutionLock,
} from "../services/issue-execution-lock.js";

/**
 * BLO-19749. The defect these tests pin was not a wrong value in one place — it
 * was the same notion open-coded as three literal arrays that drifted, so that
 * `GET /issues/{id}` reported `activeRun: null` on an issue whose `POST
 * /checkout` simultaneously 409'd naming the run that held it.
 *
 * "Holds the lock" and "terminal" MUST partition the run-status domain: the
 * checkout path releases a lock exactly when the named run is terminal, so any
 * status that is neither releases nothing and blocks nothing — an issue stuck in
 * that gap is invisible to every availability check while still un-checkoutable.
 */
describe("issue execution-lock run statuses", () => {
  it("partitions the canonical run-status domain: every status either holds or releases", () => {
    for (const status of HEARTBEAT_RUN_STATUSES) {
      const holds = (ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES as readonly string[]).includes(status);
      const terminal = TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
      expect(
        holds !== terminal,
        `"${status}" must be exactly one of holding/terminal, got holds=${holds} terminal=${terminal}`,
      ).toBe(true);
    }
  });

  it("keeps the SQL-safe terminal tuple and lock lookup set in sync", () => {
    expect([...TERMINAL_HEARTBEAT_RUN_STATUSES]).toEqual(TERMINAL_HEARTBEAT_RUN_STATUS_VALUES);
  });

  it("treats scheduled_retry as holding the lock", () => {
    // The status the retry ladder parks runs in, and the exact one the old
    // ["queued","running"] activeRun filter dropped.
    expect(runStatusHoldsIssueExecutionLock("scheduled_retry")).toBe(true);
    expect(ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES).toContain("scheduled_retry");
  });

  it("allows only queued and scheduled_retry locks to be reaped before they start", () => {
    expect(ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES).toEqual(["queued", "scheduled_retry"]);
  });

  it("holds for queued and running, releases for every terminal status", () => {
    expect(runStatusHoldsIssueExecutionLock("queued")).toBe(true);
    expect(runStatusHoldsIssueExecutionLock("running")).toBe(true);
    for (const status of ["succeeded", "interrupted", "failed", "cancelled", "timed_out"]) {
      expect(runStatusHoldsIssueExecutionLock(status), status).toBe(false);
    }
  });

  it("releases for dead statuses outside the canonical union, and for no run at all", () => {
    // Fail toward releasing: treating an unknown-but-dead status as holding
    // would strand the issue with no run able to clear it.
    expect(runStatusHoldsIssueExecutionLock("error")).toBe(false);
    expect(runStatusHoldsIssueExecutionLock("adapter_failed")).toBe(false);
    expect(runStatusHoldsIssueExecutionLock(null)).toBe(false);
    expect(runStatusHoldsIssueExecutionLock(undefined)).toBe(false);
  });

  it("holds the lock for any non-terminal status, so a new status cannot silently free a live issue", () => {
    // SQL availability checks must use this same terminal complement rather
    // than treating the known holding-status array as a closed enum.
    expect(runStatusHoldsIssueExecutionLock("some_future_live_status")).toBe(true);
    expect(ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES as readonly string[]).not.toContain(
      "some_future_live_status",
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping activeRun hydration DB tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * BLO-25410. The unit tests above pin the in-memory predicate. These pin the SQL
 * one, because the two had drifted into different *forms* of the same notion:
 *
 *   checkout()          `!TERMINAL.has(status)`                 — terminal complement
 *   activeRun hydration `inArray(status, HOLDING_STATUSES)`     — enumeration
 *
 * Those agree on every status in `HEARTBEAT_RUN_STATUSES` and disagree outside
 * it. `heartbeat_runs.status` is a plain `text` column with no enum or check
 * constraint, and `error`/`adapter_failed` are already observed in it without
 * being in the union — so "outside the union" is a demonstrated state, not a
 * hypothetical. For a non-terminal status outside the union the enumeration
 * matched nothing, so `GET /issues/{id}` reported `activeRun: null` while
 * `POST /checkout` 409'd naming that exact run: the BLO-19749 defect, reopened.
 */
describeEmbeddedPostgres("activeRun hydration agrees with checkout (BLO-25410)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-exec-lock-");
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

  async function seedAgent(companyId: string, name = "CTO") {
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
   * Seeds an issue whose `executionRunId` names a run in `runStatus`, i.e. the
   * exact state `checkout()` evaluates its conflict against.
   */
  async function seedIssueHeldByRunWithStatus(runStatus: string) {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: runStatus,
      contextSnapshot: { issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "cto", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    return { companyId, agentId, issueId, runId };
  }

  it("hydrates a run whose non-terminal status is absent from the canonical union", async () => {
    // The regression criterion. "provisioning" is non-terminal and NOT in
    // HEARTBEAT_RUN_STATUSES, so the enumeration form matched nothing and this
    // returned null while checkout() 409'd on the very same row.
    expect(HEARTBEAT_RUN_STATUSES as readonly string[]).not.toContain("provisioning");
    expect(runStatusHoldsIssueExecutionLock("provisioning")).toBe(true);

    const { companyId, runId } = await seedIssueHeldByRunWithStatus("provisioning");

    const activeRun = await svc.getActiveRun({ companyId, executionRunId: runId });

    expect(activeRun).not.toBeNull();
    expect(activeRun?.id).toBe(runId);
    expect(activeRun?.status).toBe("provisioning");
  });

  it("names the same run id that checkout conflicts on", async () => {
    // The two read paths must agree. Before the fix this issue was
    // simultaneously un-checkoutable (409, naming runId) and reported as having
    // no active run at all — the state that makes a stuck issue invisible.
    const { companyId, issueId, runId } = await seedIssueHeldByRunWithStatus("provisioning");
    const otherAgentId = await seedAgent(companyId, "MulticastEngineer");

    const activeRun = await svc.getActiveRun({ companyId, executionRunId: runId });
    expect(activeRun?.id).toBe(runId);

    const conflict = await svc
      .checkout(issueId, otherAgentId, ["in_progress"], randomUUID())
      .then(() => null)
      .catch((error: unknown) => error as { status?: number; details?: { executionRunId?: string } });

    expect(conflict, "checkout must reject while a non-terminal run holds the lock").not.toBeNull();
    expect(conflict?.status).toBe(409);
    expect(conflict?.details?.executionRunId).toBe(runId);
    expect(conflict?.details?.executionRunId).toBe(activeRun?.id);
  });

  it("still hydrates every holding status in the canonical union", async () => {
    for (const status of ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES) {
      const { companyId, runId } = await seedIssueHeldByRunWithStatus(status);
      const activeRun = await svc.getActiveRun({ companyId, executionRunId: runId });
      expect(activeRun?.id, `"${status}" must hydrate as activeRun`).toBe(runId);
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    }
  });

  it("still reports no active run for every terminal status", async () => {
    for (const status of TERMINAL_HEARTBEAT_RUN_STATUS_VALUES) {
      const { companyId, runId } = await seedIssueHeldByRunWithStatus(status);
      const activeRun = await svc.getActiveRun({ companyId, executionRunId: runId });
      expect(activeRun, `"${status}" must not hydrate as activeRun`).toBeNull();
      await db.delete(issues);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(companies);
    }
  });
});

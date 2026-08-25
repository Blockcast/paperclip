/**
 * BLO-28992: `provider_quota_exhausted_recovered` must resume the parked run's
 * own task instead of arriving unscoped.
 *
 * The defect these tests pin down is not a race. An unscoped recovery wake sends
 * the agent down its documented `inboxLite` path, and that pick is deterministic
 * for a given agent — it collapses to a single top row. So when a provider
 * throttle parks N runs of one agent and capacity returns, all N are aimed at
 * the *same* issue by construction, regardless of inbox size (observed with both
 * 84- and 169-row inboxes). Two runs then share one checkout: in BLO-28442 that
 * produced interleaved writes into `erasure/tracker.go` and a transiently
 * uncompilable file.
 *
 * The fix carries each parked run's own `contextSnapshot.issueId` through to its
 * recovery wake, so N recovering runs resume N different tasks and only
 * genuinely task-less runs consult the inbox at all.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { __resetQuotaExhaustedHookStateForTesting } from "../services/quota-exhausted-hook.js";
import type {
  PenstockAvailabilityGate,
  PenstockAvailabilityGateResult,
} from "../services/penstock-availability-gate.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quota-recovery wake-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Capacity is available again — the recovery wake must not be capacity-gated. */
function allowingGate(): PenstockAvailabilityGate {
  return {
    async checkAdapter(): Promise<PenstockAvailabilityGateResult> {
      return { allow: true };
    },
    _resetForTesting() {},
  };
}

describeEmbeddedPostgres("quota-recovery wake task scoping (BLO-28992)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quota-recovery-wake-scope-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    // The hook's debounce/inFlight state is a module-level singleton; leaking it
    // across tests would silently change which branch fires onSuccess.
    __resetQuotaExhaustedHookStateForTesting();
    // `true` exits 0, so the hook reports recovery and runs onSuccess — the
    // branch that issues the wake under test.
    process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV = "1";
    process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD = "true";
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_QUOTA_HOOK_ALLOW_ENV;
    delete process.env.PAPERCLIP_QUOTA_EXHAUSTED_CMD;
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      // Run dispatch refuses to seed a run it cannot attribute to a user. The
      // scoped and unscoped branches resolve that differently, so pin a company
      // default and both reach the assertion rather than one failing on setup.
      defaultResponsibleUserId: "test-responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      // The whole hazard requires an agent that can hold concurrent runs.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(input: {
    companyId: string;
    assigneeAgentId: string | null;
    status?: string;
    title?: string;
  }): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title ?? "Parked work",
      status: input.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
    });
    return issueId;
  }

  /**
   * A run that was live on `issueId` (or task-less when null) and is now being
   * finalized because the provider threw a quota error.
   */
  async function seedParkedRun(input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      errorCode: "provider_quota_exhausted",
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: input.issueId
        ? { issueId: input.issueId, taskId: input.issueId }
        : {},
    });
    return runId;
  }

  /**
   * `runQuotaExhaustedHook` is invoked fire-and-forget from `finalizeAgentStatus`,
   * so the wake it produces lands after that await resolves. Poll rather than
   * sleep a fixed amount, so a slow host does not turn into a flaky assertion.
   */
  async function waitForRecoveryRuns(agentId: string, expected: number) {
    const deadline = Date.now() + 15_000;
    let rows: Array<{ id: string; contextIssueId: string | null }> = [];
    while (Date.now() < deadline) {
      rows = await db
        .select({ id: heartbeatRuns.id, contextIssueId: heartbeatRuns.contextIssueId })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.contextWakeReason, "provider_quota_exhausted_recovered"),
          ),
        );
      if (rows.length >= expected) return rows;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return rows;
  }

  it("re-delivers each parked run its OWN task id, so two recovering runs do not converge", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueA = await seedIssue({ companyId, assigneeAgentId: agentId, title: "Task A" });
    const issueB = await seedIssue({ companyId, assigneeAgentId: agentId, title: "Task B" });
    const runA = await seedParkedRun({ companyId, agentId, issueId: issueA });
    const runB = await seedParkedRun({ companyId, agentId, issueId: issueB });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    // Both runs of the same agent die to the same throttle window. The second
    // takes the hook's debounce branch, which fires *its own* onSuccess — that
    // per-caller closure is what makes per-run scope possible at all.
    await heartbeat.finalizeAgentStatus(agentId, "failed", "quota", {
      errorCode: "provider_quota_exhausted",
      runId: runA,
    });
    await heartbeat.finalizeAgentStatus(agentId, "failed", "quota", {
      errorCode: "provider_quota_exhausted",
      runId: runB,
    });

    const recovered = await waitForRecoveryRuns(agentId, 2);
    expect(recovered).toHaveLength(2);

    const scopes = recovered.map((row) => row.contextIssueId).sort();
    // The load-bearing assertion: two distinct scopes, not one row twice.
    expect(scopes).toEqual([issueA, issueB].sort());
    expect(new Set(scopes).size).toBe(2);
    // And neither is unscoped, which is what would send the agent to the inbox.
    expect(scopes).not.toContain(null);
  });

  it("still wakes unscoped when the parked run had no task", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedParkedRun({ companyId, agentId, issueId: null });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.finalizeAgentStatus(agentId, "failed", "quota", {
      errorCode: "provider_quota_exhausted",
      runId,
    });

    const recovered = await waitForRecoveryRuns(agentId, 1);
    expect(recovered).toHaveLength(1);
    // Unchanged from today: a task-less park has nothing to resume, so the
    // inbox path remains correct for it.
    expect(recovered[0]?.contextIssueId).toBeNull();
  });

  it("drops the scope when the issue reached a terminal status while parked", async () => {
    const { companyId, agentId } = await seedAgent();
    const doneIssue = await seedIssue({
      companyId,
      assigneeAgentId: agentId,
      status: "done",
      title: "Completed while parked",
    });
    const runId = await seedParkedRun({ companyId, agentId, issueId: doneIssue });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.finalizeAgentStatus(agentId, "failed", "quota", {
      errorCode: "provider_quota_exhausted",
      runId,
    });

    const recovered = await waitForRecoveryRuns(agentId, 1);
    expect(recovered).toHaveLength(1);
    // Resuming onto a closed row would be a new defect, not a fix. Degrading to
    // the previous unscoped behaviour is the safe outcome.
    expect(recovered[0]?.contextIssueId).toBeNull();
  });

  it("drops the scope when the issue was reassigned to another agent while parked", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const reassigned = await seedIssue({
      companyId,
      assigneeAgentId: otherAgentId,
      title: "Taken over while parked",
    });
    const runId = await seedParkedRun({ companyId, agentId, issueId: reassigned });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.finalizeAgentStatus(agentId, "failed", "quota", {
      errorCode: "provider_quota_exhausted",
      runId,
    });

    const recovered = await waitForRecoveryRuns(agentId, 1);
    expect(recovered).toHaveLength(1);
    // Waking an agent onto work it no longer owns is exactly the second-writer
    // shape this issue exists to remove.
    expect(recovered[0]?.contextIssueId).toBeNull();
  });
});

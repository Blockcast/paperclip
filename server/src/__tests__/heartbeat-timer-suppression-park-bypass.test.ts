import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, isGenericTimerWakeSnapshot } from "../services/heartbeat.js";
import type {
  PenstockAvailabilityGate,
  PenstockAvailabilityGateCheckInput,
  PenstockAvailabilityGateResult,
} from "../services/penstock-availability-gate.js";

/**
 * BLO-31344 — `skipTimerWhenNoActionableWork` was bypassed by the
 * park/promote path, in two independent places:
 *
 *  1. the wake-time suppression gate was ordered AFTER the penstock capacity
 *     gate, which does not decline a wake but parks it as a `scheduled_retry`
 *     and returns — so under a capacity crunch the suppression gate was never
 *     reached at all; and
 *  2. promotion of a parked run never re-enters `wakeup()`, so no gate that
 *     lives there evaluates for a promoted retry, whatever parked it.
 *
 * The knob therefore worked on an idle fleet and stopped working under exactly
 * the load that makes a wasted paid invocation most expensive.
 */

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Timer suppression park-bypass test run.",
    provider: "test",
    model: "test-model",
    resultJson: {},
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

/** Capacity unavailable — the shape that parks a wake instead of declining it. */
function denyingGate(): PenstockAvailabilityGate {
  return {
    async checkAdapter(_input: PenstockAvailabilityGateCheckInput): Promise<PenstockAvailabilityGateResult> {
      return {
        allow: false,
        provider: "anthropic",
        reason: "penstock.model_capacity_unavailable",
        model: "claude-test",
        resumeAt: new Date(Date.now() + 15 * 60 * 1000),
        retryAfterSeconds: 900,
      };
    },
    _resetForTesting() {},
  };
}

/** Capacity recovered, so capacity cannot be what stops a promotion. */
function allowingGate(): PenstockAvailabilityGate {
  return {
    async checkAdapter(_input: PenstockAvailabilityGateCheckInput): Promise<PenstockAvailabilityGateResult> {
      return { allow: true };
    },
    _resetForTesting() {},
  };
}

describe("isGenericTimerWakeSnapshot", () => {
  it("treats the __heartbeat__ sentinel as generic, not as a scope", () => {
    // The load-bearing case, and the one a "simplification" breaks. A generic
    // tick is persisted with `taskKey: "__heartbeat__"` by the heartbeat
    // fallback in `enrichWakeContextSnapshot`, while the live predicate reads
    // the plain (null) task key. Testing the stored key for non-null would be
    // false for every row this predicate exists to match, so the promotion-path
    // suppression would silently never fire.
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", taskKey: "__heartbeat__" })).toBe(true);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer" })).toBe(true);
  });

  it("refuses to classify a scoped wake as generic", () => {
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", issueId: randomUUID() })).toBe(false);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", taskId: randomUUID() })).toBe(false);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", wakeCommentId: randomUUID() })).toBe(false);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", commentId: randomUUID() })).toBe(false);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "timer", taskKey: "issue:real-scope" })).toBe(false);
  });

  it("only ever matches a timer wake", () => {
    expect(isGenericTimerWakeSnapshot({ wakeSource: "automation" })).toBe(false);
    expect(isGenericTimerWakeSnapshot({ wakeSource: "assignment" })).toBe(false);
    expect(isGenericTimerWakeSnapshot({})).toBe(false);
    expect(isGenericTimerWakeSnapshot(null)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer-suppression park-bypass tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timer suppression is not bypassed by park/promote", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-timer-suppression-bypass-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    mockAdapterExecute.mockClear();
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
      // Needed so a wake that is NOT suppressed can reach dispatch — otherwise
      // the "still actionable" assertions fail on responsible-user resolution
      // and cannot distinguish that from suppression.
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PlatformSREEngineer",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          skipTimerWhenNoActionableWork: true,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** An assigned issue that is `blocked` behind a live blocker edge. */
  async function seedBlockedAssignedIssue(companyId: string, agentId: string) {
    const blockedId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
        assigneeAgentId: null,
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked assigned row",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    // "blocked is blocked by blocker" — the blocker `blocks` the dependent.
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
    return { blockedId, blockerId };
  }

  /**
   * A park as one of the three `scheduled_retry` writers actually shapes it.
   *
   * Default (`retryOf` omitted) is a **deferred fresh wake** — the ccrotate
   * capacity park and the `dependency_blocked` park both insert one: no
   * `agent_wakeup_requests` row on the capacity path (hence the null
   * `wakeupRequestId`), `retryOfRunId` left null because no run ever executed,
   * and a snapshot carrying the `__heartbeat__` sentinel.
   *
   * Pass `retryOf` for a **bounded-retry** park as `scheduleBoundedRetryForRun`
   * writes one: `invocationSource: "automation"`, a non-null `wakeupRequestId`
   * bound to a queued wakeup request, and `retryOfRunId` set to the run being
   * continued. The column split is load-bearing — it is the discriminator the
   * promotion gate uses to tell "never ran" from "work already in flight" — so
   * a test that means to exercise the bounded-retry path must use this arm or
   * it is silently asserting against a capacity row with a different reason
   * string.
   */
  async function seedPark(input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown>;
    scheduledRetryReason?: string;
    retryOf?: { runId: string };
  }): Promise<string> {
    const runId = randomUUID();
    let wakeupRequestId: string | null = null;
    if (input.retryOf) {
      wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId: input.companyId,
        agentId: input.agentId,
        source: "automation",
        reason: "heartbeat.retry",
        status: "queued",
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.retryOf ? "automation" : "timer",
      triggerDetail: input.retryOf ? "system" : "schedule",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() - 60_000),
      scheduledRetryAttempt: 2,
      scheduledRetryReason: input.scheduledRetryReason ?? "ccrotate_capacity",
      wakeupRequestId,
      retryOfRunId: input.retryOf?.runId ?? null,
      contextSnapshot: input.contextSnapshot,
    });
    return runId;
  }

  /** A terminal run for a bounded-retry park to be a continuation *of*. */
  async function seedSourceRun(companyId: string, agentId: string): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "schedule",
      status: "failed",
      contextSnapshot: { wakeSource: "timer", taskKey: "__heartbeat__" },
    });
    return runId;
  }

  it("declines a generic timer tick with no actionable work instead of capacity-parking it", async () => {
    // The reported defect. Capacity is unavailable, so before the reorder this
    // wake was parked (a run row, a later promotion, a paid invocation) even
    // though there was provably nothing for the agent to do.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: denyingGate(),
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "schedule" });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // No park was created: nothing to promote later, nothing to pay for.
    const runRows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runRows).toHaveLength(0);

    // And the decline is durably recorded as a suppression, not lost.
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
  });

  it("still capacity-parks a generic timer tick when the agent does have actionable work", async () => {
    // Guards the reorder: suppression must not shadow the capacity gate for a
    // wake that had real work to do.
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Actionable",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: denyingGate(),
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "schedule" });

    expect(run).toBeNull();
    const [parked] = await db
      .select({ status: heartbeatRuns.status, reason: heartbeatRuns.scheduledRetryReason })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(parked).toMatchObject({ status: "scheduled_retry", reason: "ccrotate_capacity" });
  });

  it("suppresses an already-parked generic tick at promotion instead of dispatching it", async () => {
    // The second half. This row is already parked, so the reordered wake gate
    // cannot help it; only a promotion-time re-probe can. Capacity has
    // recovered, so capacity is not what stops it.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const runId = await seedPark({
      companyId,
      agentId,
      contextSnapshot: { wakeSource: "timer", wakeTriggerDetail: "schedule", taskKey: "__heartbeat__" },
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.promoted).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const parked = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(parked).toMatchObject({ status: "cancelled", errorCode: "timer_no_actionable_work" });
  });

  it("promotes a parked generic tick once the agent has actionable work again", async () => {
    // Suppression must be a function of the lane's live state, not a property
    // stamped on the park.
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Actionable",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const runId = await seedPark({
      companyId,
      agentId,
      contextSnapshot: { wakeSource: "timer", taskKey: "__heartbeat__" },
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.promoted).toBe(1);
    expect(result.runIds).toContain(runId);
  });

  it("never suppresses a scoped park, even when the lane has no actionable work", async () => {
    // The guard that keeps this fix from eating real work: a park whose
    // original wake carried a scope must promote regardless of what else the
    // lane has queued, or the wake its scope was for is silently dropped.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const runId = await seedPark({
      companyId,
      agentId,
      contextSnapshot: { wakeSource: "timer", taskKey: "agent:scoped-real-work" },
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.promoted).toBe(1);
    expect(result.runIds).toContain(runId);
  });

  it("suppresses a promoted dependency_blocked park, not just a capacity one", async () => {
    // The bypass is not confined to capacity parks. Both writers that defer a
    // *fresh* wake leave `retryOfRunId` null, and both promote through the same
    // function, so both are in scope.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const runId = await seedPark({
      companyId,
      agentId,
      contextSnapshot: { wakeSource: "timer", taskKey: "__heartbeat__" },
      scheduledRetryReason: "dependency_blocked",
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.promoted).toBe(0);
    const parked = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(parked).toMatchObject({ status: "cancelled", errorCode: "timer_no_actionable_work" });
  });

  it("never suppresses a max_turns_continuation park, even with an empty queue", async () => {
    // The guard that keeps this fix from destroying in-flight work, and the one
    // case where getting it wrong is unrecoverable: cancellation is terminal.
    //
    // An issueless continuation park exists *because* the agent ran out of
    // turns mid-task. Agents doing issueless work — sweeps, reports, PR review
    // — normally have an empty assigned queue, so without the `retryOfRunId`
    // guard this is not an edge case but the common shape, and the work is
    // dropped with no path back to it.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const sourceRunId = await seedSourceRun(companyId, agentId);
    const runId = await seedPark({
      companyId,
      agentId,
      // Byte-identical to the suppressed capacity park above: generic-timer
      // snapshot, no scope, empty queue. `retryOfRunId` is the only difference,
      // which is exactly what this test is pinning.
      contextSnapshot: { wakeSource: "timer", taskKey: "__heartbeat__" },
      scheduledRetryReason: "max_turns_continuation",
      retryOf: { runId: sourceRunId },
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.runIds).toContain(runId);
    const parked = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(parked?.status).not.toBe("cancelled");
    expect(parked?.errorCode).not.toBe("timer_no_actionable_work");
  });

  it("never suppresses a transient_failure park, which is also a retry of a real run", async () => {
    // Same protection, different reason: every `scheduleBoundedRetryForRun`
    // reason is a retry *of* a run that already executed.
    const { companyId, agentId } = await seedAgent();
    await seedBlockedAssignedIssue(companyId, agentId);
    const sourceRunId = await seedSourceRun(companyId, agentId);
    const runId = await seedPark({
      companyId,
      agentId,
      contextSnapshot: { wakeSource: "timer", taskKey: "__heartbeat__" },
      scheduledRetryReason: "transient_failure",
      retryOf: { runId: sourceRunId },
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const result = await heartbeat.promoteDueScheduledRetries(new Date());

    expect(result.runIds).toContain(runId);
    const parked = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(parked?.status).not.toBe("cancelled");
  });

  it("pins the snapshot coupling the promotion gate rests on", async () => {
    // The whole promotion-side fix assumes a REAL capacity park stores a
    // snapshot that `isGenericTimerWakeSnapshot` matches. Nothing else asserts
    // that, and it is precisely the coupling the helper's doc comment warns
    // fails silently: if the persisted shape drifts, the gate compiles, deploys
    // and never fires. So produce a genuine park through the wake path and read
    // the row back, rather than trusting a hand-built snapshot.
    const { companyId, agentId } = await seedAgent();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Actionable",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: denyingGate(),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "schedule" });

    const [parked] = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        reason: heartbeatRuns.scheduledRetryReason,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(parked.reason).toBe("ccrotate_capacity");
    expect(
      isGenericTimerWakeSnapshot(parked.contextSnapshot as Record<string, unknown>),
    ).toBe(true);
    // The other half of the promotion gate's condition, on a real row: a
    // capacity park is a deferred fresh wake, so it must carry no source run.
    expect(parked.retryOfRunId).toBeNull();
  });

  it("keeps counting a todo row with unresolved blockers as actionable", async () => {
    // AC4: the deliberate behavior. `hasActionableTimerWork` filters on status,
    // so a row that is still `todo`/`in_progress` counts even when its blockers
    // are unresolved — only `status: blocked` is excluded. This fix must not
    // narrow that.
    const { companyId, agentId } = await seedAgent();
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "high", assigneeAgentId: null },
      {
        id: dependentId,
        companyId,
        title: "Todo with unresolved blockers",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });
    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowingGate(),
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "schedule" });

    // Not suppressed: no skipped no-actionable-work row was written.
    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(
      wakeups.filter((row) => row.reason === "heartbeat.timer.no_actionable_work"),
    ).toHaveLength(0);
    expect(run).not.toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { logger } from "../middleware/logger.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
  STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS,
} from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * BLO-19124 — recovery actions must be bounded and must re-arm.
 *
 * Before this suite, escalation created an action, fired exactly one
 * `wake_owner`, and parked the source issue in `blocked`. The only sweep that
 * could retry (`reconcileStrandedAssignedIssues`) selects
 * todo/in_progress/in_review, so escalation evicted its own issue from the one
 * retry path. 131 actions sat active, 67 of them at attemptCount 1, oldest
 * seven weeks.
 */
describeEmbeddedPostgres("recovery action bounds and reaping", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-reaper-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts?: { issueCount?: number }) {
    const issueCount = opts?.issueCount ?? 1;
    const companyId = randomUUID();
    const ownerId = randomUUID();
    const coderId = randomUUID();
    const prefix = `RR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Reaper Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerId,
        companyId,
        name: "Owner",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        // The burst owner in the incident ran maxConcurrentRuns: 3 and could
        // not absorb 59 simultaneous one-shot wakes.
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: ownerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const issueIds: string[] = [];
    for (let index = 0; index < issueCount; index += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Stranded work ${index}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: index + 1,
        identifier: `${prefix}-${index + 1}`,
      });
    }
    return { companyId, ownerId, coderId, issueIds };
  }

  function failedRun(agentId: string) {
    return {
      id: randomUUID(),
      agentId,
      status: "failed",
      error: "job failed: BackoffLimitExceeded",
      errorCode: "job_failed",
      contextSnapshot: {},
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: new Date(),
    } as const;
  }

  /** Drives the real escalation path so the action is created exactly as production creates it. */
  async function escalate(
    recovery: ReturnType<typeof recoveryService>,
    issueId: string,
    coderId: string,
  ) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
    return recovery.escalateStrandedAssignedIssue({
      issue: issue!,
      previousStatus: "in_progress",
      latestRun: failedRun(coderId),
    });
  }

  // A bare `vi.fn()` resolves to `undefined`, and the escalation path reads any
  // nullish return from `enqueueWakeup` as "this wake reached nobody" and refunds
  // the attempt (`refundUnspentWakeAttempt`, cause `enqueue_not_delivered`). That
  // is the right production reading — nine non-delivery paths return null — but it
  // means a bare mock leaves `attemptCount` at 0 forever. Tests below that assert
  // delivered-wake accounting (attempt budget spent, re-arm, expiry-by-attempts)
  // must therefore mock a wake that actually reached the queue.
  const deliveredWake = () => vi.fn(async () => ({ id: randomUUID() }) as never);

  it("stamps a bound on every wake_owner action it creates", async () => {
    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    await escalate(recovery, issueIds[0]!, coderId);

    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toBeTruthy();
    expect((action!.wakePolicy as { type?: string } | null)?.type).toBe("wake_owner");
    // AC: non-null timeoutAt OR non-null maxAttempts. We set both.
    expect(action!.maxAttempts).not.toBeNull();
    expect(action!.timeoutAt).not.toBeNull();
  });

  it("stamps the CONFIGURED bound, so the reaper's own env knobs are not inert on new actions", async () => {
    // Ally review on #875: creation used to stamp the STRANDED_RECOVERY_* constants
    // while the reaper read RECOVERY_ACTION_*, so an operator raising the reaper's
    // bound moved only legacy NULL-bound rows and every freshly created action kept
    // the old fixed values. Both now resolve through one config, which this pins.
    //
    // Note the coupling that makes this more than a tidiness fix: the stamped
    // columns are also what escalation's runaway backstop
    // (`strandedRecoveryWakeAttemptsExhausted`) reads, so a divergence here is a
    // divergence in when escalation stops waking the owner.
    const previousAttempts = process.env.RECOVERY_ACTION_MAX_ATTEMPTS;
    const previousTimeout = process.env.RECOVERY_ACTION_TIMEOUT_MS;
    process.env.RECOVERY_ACTION_MAX_ATTEMPTS = "9";
    process.env.RECOVERY_ACTION_TIMEOUT_MS = String(11 * 60 * 60 * 1000);
    try {
      const { coderId, issueIds } = await seedCompany();
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

      const before = Date.now();
      await escalate(recovery, issueIds[0]!, coderId);
      const after = Date.now();

      const [action] = await db.select().from(issueRecoveryActions);
      expect(action!.maxAttempts).toBe(9);
      // Bounded on both sides rather than asserted exactly, since the stamp is
      // taken from the escalation's own clock rather than the test's.
      const timeoutAt = new Date(action!.timeoutAt as Date).getTime();
      expect(timeoutAt).toBeGreaterThanOrEqual(before + 11 * 60 * 60 * 1000);
      expect(timeoutAt).toBeLessThanOrEqual(after + 11 * 60 * 60 * 1000);
    } finally {
      if (previousAttempts === undefined) delete process.env.RECOVERY_ACTION_MAX_ATTEMPTS;
      else process.env.RECOVERY_ACTION_MAX_ATTEMPTS = previousAttempts;
      if (previousTimeout === undefined) delete process.env.RECOVERY_ACTION_TIMEOUT_MS;
      else process.env.RECOVERY_ACTION_TIMEOUT_MS = previousTimeout;
    }
  });

  it("defaults the reaper bound to the escalation wake horizon rather than widening it", async () => {
    // The guard on the fix above. `RECOVERY_ACTION_*` unset must not silently
    // hand a new action a longer leash than BLO-18996's 6h/5-attempt horizon:
    // the same columns gate escalation's owner wakes, so a wider default would
    // lengthen the owner-churn ping-pong loop that ticket measured at 30 wakes
    // over 30 sweeps, not merely slow the drain.
    //
    // The horizon is asserted as a CONCRETE 6h, not merely as equal to
    // `STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS`. Both the stamp and that constant
    // now resolve through `DEFAULT_RECOVERY_ACTION_TIMEOUT_MS`, so a
    // constant-to-constant comparison moves with any widening and can never fail
    // — it would have passed unchanged against a 72h default. Pinning the number
    // is what makes this a guard rather than a tautology; if you are deliberately
    // retuning the horizon, change it here and say why in the same commit.
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    expect(STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS).toBe(SIX_HOURS_MS);

    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const before = Date.now();
    await escalate(recovery, issueIds[0]!, coderId);

    const [action] = await db.select().from(issueRecoveryActions);
    expect(action!.maxAttempts).toBe(STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS);
    const timeoutAt = new Date(action!.timeoutAt as Date).getTime();
    expect(timeoutAt - before).toBeLessThanOrEqual(SIX_HOURS_MS + 5_000);
  });

  it("preserves the original bound across re-escalation so a flapping issue still expires", async () => {
    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: deliveredWake() });

    await escalate(recovery, issueIds[0]!, coderId);
    const [first] = await db.select().from(issueRecoveryActions);
    const originalTimeout = first!.timeoutAt;

    // Return it to a live status and strand it again, as a flapping issue does.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueIds[0]!));
    await escalate(recovery, issueIds[0]!, coderId);

    const [second] = await db.select().from(issueRecoveryActions);
    expect(second!.attemptCount).toBeGreaterThan(first!.attemptCount);
    // If re-escalation refreshed the deadline, an issue that flaps every few
    // hours would push its own bound forward forever.
    expect(second!.timeoutAt).toEqual(originalTimeout);
  });

  it("re-arms an unresolved action instead of letting it die after one attempt", async () => {
    const { ownerId, coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: deliveredWake() });

    await escalate(recovery, issueIds[0]!, coderId);
    const [created] = await db.select().from(issueRecoveryActions);
    expect(created!.attemptCount).toBe(1);

    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    expect(blocked!.status).toBe("blocked");
    expect(blocked!.assigneeAgentId).toBe(ownerId);

    // Advance past the first backoff window.
    const later = new Date(Date.now() + 45 * 60_000);
    const result = await recovery.reapRecoveryActions({ now: later });

    expect(result.rearmed).toBe(1);
    const [rearmed] = await db.select().from(issueRecoveryActions);
    expect(rearmed!.attemptCount).toBe(2);
    expect(rearmed!.status).toBe("active");

    // The issue is back on a live status, so the normal reconcile sweep — which
    // only selects todo/in_progress/in_review — can see it again.
    const [restored] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    expect(restored!.status).toBe("todo");
    expect(restored!.assigneeAgentId).toBe(coderId);
  });

  it("terminates into outcome=expired and leaves the issue with a live wake path", async () => {
    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    await escalate(recovery, issueIds[0]!, coderId);
    // Force the wall-clock bound to be in the past.
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: new Date(Date.now() - 1_000) });

    const result = await recovery.reapRecoveryActions();
    expect(result.expired).toBe(1);

    const [expired] = await db.select().from(issueRecoveryActions);
    expect(expired!.outcome).toBe("expired");
    expect(expired!.resolvedAt).not.toBeNull();
    expect(expired!.status).toBe("cancelled");

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    expect(issue!.status).toBe("todo");
  });

  it("does not terminate a recovery episode that was refreshed inside the reap window", async () => {
    const { companyId, ownerId, coderId, issueIds } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const seeder = recoveryService(db, { enqueueWakeup: deliveredWake() });
    await escalate(seeder, issueIds[0]!, coderId);
    const [created] = await db.select().from(issueRecoveryActions);
    expect(created!.attemptCount).toBe(1);

    // Send the reaper down its widest window: the wall-clock bound is spent, so
    // it restores the source issue (an issue UPDATE plus a comment insert) and
    // only then terminates the action.
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: new Date(Date.now() - 1_000) });

    let refreshedAt: number | null = null;
    const recovery = recoveryService(db, {
      enqueueWakeup: deliveredWake(),
      // The production sequence this reproduces: the reaper's restore put the
      // issue back on a live status, the normal dispatch sweep picked it up,
      // that run failed too, and escalation opened a new episode — which
      // reuses THIS row, because `issue_recovery_actions_active_source_uq`
      // permits only one active action per source issue. So targeting the id
      // is not enough; the reaper is about to cancel an episode it never saw.
      beforeRecoveryActionTerminateForTest: async (action) => {
        if (refreshedAt !== null) return;
        refreshedAt = action.attemptCount;
        await svc.upsertSourceScoped({
          companyId,
          sourceIssueId: action.sourceIssueId,
          kind: "stranded_assigned_issue",
          ownerType: "agent",
          ownerAgentId: ownerId,
          previousOwnerAgentId: coderId,
          returnOwnerAgentId: coderId,
          cause: "stranded_assigned_issue",
          fingerprint: `wake-owner:${action.sourceIssueId}:refresh`,
          evidence: {},
          nextAction: "Re-arm the owner.",
          wakePolicy: { type: "wake_owner" },
          maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
          lastAttemptAt: new Date(),
        });
      },
    });

    const result = await recovery.reapRecoveryActions();

    // Guard the fixture itself: if the seam never fired there is no race to
    // test, and every assertion below would pass for the wrong reason.
    expect(refreshedAt).toBe(1);
    expect(result.scanned).toBe(1);
    // The reaper observed attempt 1 and the row is now at attempt 2, so the
    // compare-and-set misses. Reporting nothing is the correct outcome — the
    // fresh episode owns the row, and the next tick reaps it on its own terms.
    expect(result.expired).toBe(0);
    expect(result.settled).toBe(0);

    const [survivor] = await db.select().from(issueRecoveryActions);
    expect(survivor!.attemptCount).toBe(2);
    expect(survivor!.status).toBe("active");
    expect(survivor!.outcome).toBeNull();
    expect(survivor!.resolvedAt).toBeNull();
  });

  it("still terminates when nothing refreshed the row underneath it", async () => {
    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: deliveredWake() });

    await escalate(recovery, issueIds[0]!, coderId);
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: new Date(Date.now() - 1_000) });

    // The compare-and-set above must not turn every expiry into a no-op: the
    // uncontended path is the common one and has to keep working.
    const result = await recovery.reapRecoveryActions();

    expect(result.expired).toBe(1);
    const [expired] = await db.select().from(issueRecoveryActions);
    expect(expired!.status).toBe("cancelled");
    expect(expired!.outcome).toBe("expired");
  });

  it("leaves an issue blocked when it has a real unresolved blocker", async () => {
    const { companyId, coderId, issueIds } = await seedCompany({ issueCount: 2 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    await escalate(recovery, issueIds[0]!, coderId);
    // "issueIds[1] blocks issueIds[0]" — so issue 0 has a real unresolved
    // blocker. issueIds[1] is in_progress, i.e. not terminal.
    await db.insert(issueRelations).values({
      companyId,
      issueId: issueIds[1]!,
      relatedIssueId: issueIds[0]!,
      type: "blocks",
    });
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: new Date(Date.now() - 1_000) });

    await recovery.reapRecoveryActions();

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    // blocked-with-a-real-blocker already has a live wake path
    // (issue_blockers_resolved); only the zero-blocker case is the parked one.
    expect(issue!.status).toBe("blocked");
  });

  it("resolves rather than parks a recovery whose source issue has a real blocker", async () => {
    const { companyId, coderId, issueIds } = await seedCompany({ issueCount: 2 });
    const recovery = recoveryService(db, { enqueueWakeup: deliveredWake() });

    await escalate(recovery, issueIds[0]!, coderId);
    await db.insert(issueRelations).values({
      companyId,
      issueId: issueIds[1]!,
      relatedIssueId: issueIds[0]!,
      type: "blocks",
    });

    const later = new Date(Date.now() + 45 * 60_000);
    const result = await recovery.reapRecoveryActions({ now: later });

    // No attempt is burned: the issue is not stranded, it is legitimately
    // blocked, and issue_blockers_resolved is its live wake path.
    expect(result.rearmed).toBe(0);
    expect(result.settled).toBe(1);
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action!.attemptCount).toBe(1);
    expect(action!.status).toBe("resolved");
    expect(action!.outcome).toBe("blocked");

    // Having left the active set, it cannot re-plan and re-consume a per-owner
    // slot on later ticks — the failure this replaced, where a blocked issue
    // held a slot every tick until its 72h wall-clock bound.
    const second = await recovery.reapRecoveryActions({
      now: new Date(later.getTime() + 1_000),
    });
    expect(second.scanned).toBe(0);
    expect(second.rearmed + second.expired + second.settled).toBe(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    expect(issue!.status).toBe("blocked");
  });

  it("does not reap manual_repair_required actions, which genuinely need a human", async () => {
    const { coderId, issueIds } = await seedCompany();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueIds[0]!));
    await recovery.escalateStrandedAssignedIssue({
      issue: issue!,
      previousStatus: "in_progress",
      latestRun: {
        ...failedRun(coderId),
        errorCode: "configuration_incomplete",
        error: "missing secret binding",
      } as never,
      recoveryCause: "configuration_incomplete",
    });

    const [action] = await db.select().from(issueRecoveryActions);
    expect((action!.wakePolicy as { type?: string } | null)?.type).toBe("manual_repair_required");
    // Expiring these would bounce the issue to todo, fail the same validation,
    // and re-escalate in a loop.
    expect(action!.maxAttempts).toBeNull();

    const result = await recovery.reapRecoveryActions({
      now: new Date(Date.now() + 200 * 60 * 60_000),
    });
    expect(result.rearmed).toBe(0);
    expect(result.expired).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("keeps unreapable policies from starving the SQL candidate window", async () => {
    const { companyId, ownerId, coderId, issueIds } = await seedCompany({ issueCount: 2 });
    const svc = issueRecoveryActionService(db);
    const manualActionId = randomUUID();
    const wakeOwnerActionId = randomUUID();
    await db.insert(issueRecoveryActions).values([
      {
        id: manualActionId,
        companyId,
        sourceIssueId: issueIds[0]!,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: ownerId,
        returnOwnerAgentId: coderId,
        cause: "manual_repair_required",
        fingerprint: `manual:${manualActionId}`,
        evidence: {},
        nextAction: "Manual repair is required.",
        wakePolicy: { type: "manual_repair_required" },
        attemptCount: 1,
        lastAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: wakeOwnerActionId,
        companyId,
        sourceIssueId: issueIds[1]!,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: ownerId,
        returnOwnerAgentId: coderId,
        cause: "stranded_assigned_issue",
        fingerprint: `wake-owner:${wakeOwnerActionId}`,
        evidence: {},
        nextAction: "Re-arm the owner.",
        wakePolicy: { type: "wake_owner" },
        attemptCount: 1,
        lastAttemptAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);

    const candidates = await svc.listActiveCandidatesForReap(1);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(wakeOwnerActionId);
  });

  it("resolves rather than parks a recovery whose source issue is already live", async () => {
    const { coderId, issueIds } = await seedCompany({ issueCount: 1 });
    const recovery = recoveryService(db, { enqueueWakeup: deliveredWake() });

    await escalate(recovery, issueIds[0]!, coderId);
    // Move the issue to a live status, which is exactly where a successful
    // re-arm leaves it for the normal dispatch sweep. The recovery action must
    // leave the active set instead of parking until its wall-clock bound.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueIds[0]!));

    const later = new Date(Date.now() + 45 * 60_000);
    const result = await recovery.reapRecoveryActions({ now: later });

    expect(result.scanned).toBe(1);
    expect(result.settled).toBe(1);
    expect(result.parked).toBe(0);

    const [action] = await db.select().from(issueRecoveryActions);
    expect(action!.attemptCount).toBe(1);
    expect(action!.status).toBe("resolved");
    expect(action!.outcome).toBe("restored");

    const second = await recovery.reapRecoveryActions({
      now: new Date(later.getTime() + 1_000),
    });
    expect(second.scanned).toBe(0);
    expect(second.parked).toBe(0);
  });

  it("does not expire a recovery action after its re-arm already restored a live source issue", async () => {
    const { coderId, issueIds } = await seedCompany({ issueCount: 1 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    await escalate(recovery, issueIds[0]!, coderId);
    const [created] = await db.select().from(issueRecoveryActions);
    const firstRearm = await recovery.reapRecoveryActions({
      now: new Date(Date.now() + 45 * 60_000),
    });
    expect(firstRearm.rearmed).toBe(1);

    const afterTimeout = new Date(new Date(created!.timeoutAt as Date).getTime() + 1_000);
    const second = await recovery.reapRecoveryActions({ now: afterTimeout });

    expect(second.expired).toBe(0);
    expect(second.settled).toBe(1);

    const [action] = await db.select().from(issueRecoveryActions);
    expect(action!.status).toBe("resolved");
    expect(action!.outcome).toBe("restored");
  });

  it("reports cap-deferred candidates as skipped", async () => {
    const { coderId, issueIds } = await seedCompany({ issueCount: 3 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });

    for (const issueId of issueIds) {
      await escalate(recovery, issueId, coderId);
    }

    const result = await recovery.reapRecoveryActions({
      now: new Date(Date.now() + 45 * 60_000),
    });

    expect(result.scanned).toBe(3);
    expect(result.rearmed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.parked).toBe(0);

    const rows = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, issueIds));
    expect(rows.filter((issue) => issue.status === "blocked")).toHaveLength(1);
  });

  it("bounds a burst of 25 recoveries for one owner without depending on 25 absorbed wakes", async () => {
    const { coderId, issueIds } = await seedCompany({ issueCount: 25 });
    const enqueueWakeup = deliveredWake();
    const recovery = recoveryService(db, { enqueueWakeup });

    for (const issueId of issueIds) {
      await escalate(recovery, issueId, coderId);
    }

    const created = await db.select().from(issueRecoveryActions);
    expect(created).toHaveLength(25);
    // (a) every action is bounded
    for (const action of created) {
      expect(action.maxAttempts ?? action.timeoutAt).not.toBeNull();
    }

    // Drive the reaper repeatedly past the bound, as the 30s scheduler would.
    // Each tick re-arms at most perOwnerPerTick, so the burst drains as a drip
    // rather than as 25 simultaneous wakes.
    //
    // The stride must stay UNDER the creation-anchored wall-clock horizon
    // (STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS, 6h). decideRecoveryAction checks
    // timeout before backoff, so a stride past the horizon expires all 25 rows on
    // the very first tick: nothing re-arms, no issue is ever restored, and the
    // per-owner cap assertion below passes vacuously at 0. One hour clears the
    // 30-minute base backoff while leaving several real re-arm ticks inside the
    // horizon, which is the drip this AC exists to demonstrate.
    const wakesAfterEscalation = enqueueWakeup.mock.calls.length;
    let tick = 0;
    let maxRearmedInOneTick = 0;
    while (tick < 200) {
      const now = new Date(Date.now() + (tick + 1) * 60 * 60_000);
      const result = await recovery.reapRecoveryActions({ now });
      maxRearmedInOneTick = Math.max(maxRearmedInOneTick, result.rearmed);
      if (result.scanned === 0) break;
      tick += 1;
    }

    // Burst safety: no tick ever re-armed more than the per-owner cap.
    expect(maxRearmedInOneTick).toBeLessThanOrEqual(2);
    // The reaper itself wakes nobody — it restores issues to `todo` and lets
    // the normal dispatcher pick them up under its own concurrency limit.
    expect(enqueueWakeup.mock.calls.length).toBe(wakesAfterEscalation);

    // (c) after the drain every action has terminated with an outcome
    const settled = await db.select().from(issueRecoveryActions);
    expect(settled).toHaveLength(25);
    for (const action of settled) {
      expect(action.status).not.toBe("active");
      expect(action.outcome).not.toBeNull();
    }
    expect(settled.some((action) => action.outcome === "restored")).toBe(true);

    // (d) no source issue is left blocked with zero unresolved blockers
    const finalIssues = await db
      .select()
      .from(issues)
      .where(inArray(issues.id, issueIds));
    expect(finalIssues.filter((issue) => issue.status === "blocked")).toHaveLength(0);
  }, 180_000);

  it("exposes resolved and expired actions through the row-level list, filterable by kind", async () => {
    const { companyId, coderId, issueIds } = await seedCompany({ issueCount: 2 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    const svc = issueRecoveryActionService(db);

    await escalate(recovery, issueIds[0]!, coderId);
    await escalate(recovery, issueIds[1]!, coderId);
    await db
      .update(issueRecoveryActions)
      .set({ timeoutAt: new Date(Date.now() - 1_000) })
      .where(eq(issueRecoveryActions.sourceIssueId, issueIds[0]!));
    await recovery.reapRecoveryActions();

    // The pre-existing surfaces are active-only by construction, so a terminal
    // row was previously unreachable at row level.
    const terminal = await svc.listForCompany({
      companyId,
      statuses: ["resolved", "cancelled"],
      limit: 50,
    });
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal.some((action) => action.outcome === "expired")).toBe(true);

    const byKind = await svc.listForCompany({
      companyId,
      kind: "stranded_assigned_issue",
      limit: 50,
    });
    expect(byKind.length).toBeGreaterThan(0);
    expect(byKind.every((action) => action.kind === "stranded_assigned_issue")).toBe(true);

    const otherKind = await svc.listForCompany({
      companyId,
      kind: "workspace_validation",
      limit: 50,
    });
    expect(otherKind).toHaveLength(0);

    expect(
      await svc.countForCompany({ companyId, outcome: "expired" }),
    ).toBe(1);
  });
});

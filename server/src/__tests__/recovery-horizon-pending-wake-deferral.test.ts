import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateCompanyScopedTestState } from "./helpers/truncate-company-scoped-test-state.js";
import {
  PENDING_RECOVERY_WAKE_CEILING_TIMEOUT_MULTIPLIER,
  issueRecoveryActionService,
} from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PEN-4006: the wake horizon used to retire a recovery action while that action's own wake
 * run was still queued.
 *
 * The horizon is wall-clock from `createdAt`; owner dispatch is not. Measured over ~3 days to
 * 2026-10-12, dispatch lag ran to 13.36 h on @Devops and 17.46 h on @Cto against a 6 h
 * horizon — 41.7% and 65.5% of runs past 6 h respectively. The four PEN-3983 instances are
 * the worked example: flipped `escalated` at 07:41:39Z, their wakes then STARTED at
 * 10:00-10:26Z and succeeded. `escalated` says "Paperclip has stopped waking anyone for it"
 * and pins the source issue `blocked` with no re-entry from any wake, retry or monitor
 * (`BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES`), so the system declared the
 * repair dead while the repair was in flight.
 *
 * PEN-3983's accounting half (paperclip#2588) made the LABEL honest — `delivered` rather than
 * `never_delivered`. It did not move the horizon, which is what this suite covers.
 */
describeEmbeddedPostgres("recovery wake horizon defers to a pending wake (PEN-4006)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-horizon-pending-wake-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await truncateCompanyScopedTestState(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const now = new Date("2026-10-12T12:00:00.000Z");
  const pastHorizon = new Date("2026-10-12T05:26:30.000Z");
  /** The production default, so the fixtures are sized against the real bound. */
  const timeoutMs = 6 * 60 * 60_000;
  const ceilingMs = timeoutMs * PENDING_RECOVERY_WAKE_CEILING_TIMEOUT_MULTIPLIER;

  async function seed() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `PW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Pending Wake Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Devops",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "stranded assigned issue awaiting its recovery wake",
      status: "blocked",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      issueNumber: 3540,
      identifier: `${prefix}-3540`,
    });

    return { companyId, ownerAgentId, sourceIssueId, prefix };
  }

  /**
   * `createdAt` is set explicitly on every action: it is the ceiling's anchor, and the column
   * otherwise defaults to wall-clock `now()`, which would sit in the fixture's future and make
   * every ceiling assertion vacuously false.
   */
  async function insertAction(
    seeded: Awaited<ReturnType<typeof seed>>,
    overrides: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id,
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: seeded.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded:${seeded.sourceIssueId}`,
      evidence: {},
      nextAction: "Restore a live execution path.",
      attemptCount: 1,
      maxAttempts: 5,
      // Minted one horizon before it burned, the ordinary shape.
      createdAt: new Date(pastHorizon.getTime() - timeoutMs),
      timeoutAt: pastHorizon,
      lastAttemptAt: pastHorizon,
      ...overrides,
    });
    return id;
  }

  async function insertWakeRun(
    seeded: Awaited<ReturnType<typeof seed>>,
    overrides: { status: string; recoveryActionId?: string | null },
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      status: overrides.status,
      createdAt: new Date(pastHorizon.getTime() - 60_000),
      contextSnapshot: {
        issueId: seeded.sourceIssueId,
        ...(overrides.recoveryActionId === undefined
          ? {}
          : { recoveryActionId: overrides.recoveryActionId }),
      },
    });
  }

  function readAction(id: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, id))
      .then((rows) => rows[0]!);
  }

  function escalate(overrides: Record<string, unknown> = {}) {
    return issueRecoveryActionService(db).escalateExpiredWakeHorizons({
      now,
      unboundedHorizonMs: timeoutMs,
      ...overrides,
    });
  }

  // `scheduled_retry` first because it is the status the PEN-3983 instances were actually
  // parked in: the provider-capacity path commits a durable run and `enqueueWakeup` still
  // returns null, which is what made the wake invisible to every layer above.
  for (const status of ["scheduled_retry", "queued", "running"] as const) {
    it(`does not retire a burned horizon while its wake run is ${status}`, async () => {
      const seeded = await seed();
      const actionId = await insertAction(seeded);
      await insertWakeRun(seeded, { status, recoveryActionId: actionId });

      const retired = await escalate();

      expect(retired).toEqual([]);
      const action = await readAction(actionId);
      expect(action.status).toBe("active");
      expect(action.retiringBound).toBeNull();
    });
  }

  /**
   * The deferral's own control. This is the pre-PEN-4006 behaviour on a byte-identical
   * fixture: same burned horizon, same pending wake, deferral switched off. If the deferral
   * were removed from `escalateExpiredWakeHorizons`, the tests above would produce exactly
   * this result — so the pair is what makes them a kill rather than a tautology.
   */
  it("retires that same fixture when the deferral is disabled", async () => {
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    await insertWakeRun(seeded, { status: "scheduled_retry", recoveryActionId: actionId });

    const retired = await escalate({ pendingWakeCeilingMs: 0 });

    expect(retired).toHaveLength(1);
    const action = await readAction(actionId);
    expect(action.status).toBe("escalated");
    expect(action.retiringBound).toBe("timeout_horizon");
  });

  it("retires at the absolute ceiling under a distinct bound, wake still pending", async () => {
    // Without a ceiling a permanently-parked wake would hold
    // `issue_recovery_actions_active_source_uq` forever — the unbounded-row harm this module
    // warns about, strictly worse than retiring early.
    const seeded = await seed();
    const actionId = await insertAction(seeded, {
      createdAt: new Date(now.getTime() - ceilingMs - 1_000),
    });
    await insertWakeRun(seeded, { status: "scheduled_retry", recoveryActionId: actionId });

    const retired = await escalate();

    expect(retired).toHaveLength(1);
    const action = await readAction(actionId);
    expect(action.status).toBe("escalated");
    // The whole point of the distinct value: `retiringBound` is the only field that tells
    // "retired with a wake still pending" from "retired having been woken", and
    // `retireWakeAction` writes the column with `coalesce`, so it cannot be repaired later.
    expect(action.retiringBound).toBe("pending_wake_ceiling");
    expect(action.retiringBound).not.toBe("timeout_horizon");
  });

  it("holds a pending-wake row right up to the ceiling and not one tick past it", async () => {
    // Pins the comparison itself. A sign error or an off-by-one horizon here reads as "the
    // deferral works" on both of the tests above while bounding nothing.
    const seeded = await seed();
    const justInside = await insertAction(seeded, {
      createdAt: new Date(now.getTime() - ceilingMs + 60_000),
    });
    await insertWakeRun(seeded, { status: "queued", recoveryActionId: justInside });

    expect(await escalate()).toEqual([]);
    expect((await readAction(justInside)).status).toBe("active");

    // Same row, same wake, read one minute past its ceiling.
    const retired = await escalate({ now: new Date(now.getTime() + 2 * 60_000) });
    expect(retired).toHaveLength(1);
    expect((await readAction(justInside)).retiringBound).toBe("pending_wake_ceiling");
  });

  it("retires as timeout_horizon when the action's wake run has already finished", async () => {
    // "Retired having been woken" — the case the distinct bound must stay distinguishable
    // from, and the one that proves the deferral keys on PENDING statuses rather than on the
    // mere existence of a run carrying the action id.
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    await insertWakeRun(seeded, { status: "succeeded", recoveryActionId: actionId });

    const retired = await escalate();

    expect(retired).toHaveLength(1);
    expect((await readAction(actionId)).retiringBound).toBe("timeout_horizon");
  });

  it("does not let an unrelated live run on the same issue defer the retirement", async () => {
    // `ensureProviderQuotaRecoveryMonitor` carries a null-`recoveryActionId` fallback scoped
    // by `issueId`, for monitors written before the stable key existed. Admitting that shape
    // here would let ANY live run on the source issue hold the action open indefinitely, so
    // this sweep matches the action id and nothing else.
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    await insertWakeRun(seeded, { status: "running" });
    await insertWakeRun(seeded, { status: "running", recoveryActionId: randomUUID() });

    const retired = await escalate();

    expect(retired).toHaveLength(1);
    expect((await readAction(actionId)).retiringBound).toBe("timeout_horizon");
  });

  it("retires one row and defers its batch-mate in the same sweep", async () => {
    // Two UPDATEs now run where one did. Pin that the split is per-row and that neither arm
    // leaks into the other's result set — a sweep that retired the deferred row, or dropped
    // the retirable one, would still satisfy every single-row test above.
    const seeded = await seed();
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId: seeded.companyId,
      title: "second stranded issue in the same sweep batch",
      status: "blocked",
      priority: "high",
      assigneeAgentId: seeded.ownerAgentId,
      issueNumber: 3541,
      identifier: `${seeded.prefix}-3541`,
    });
    const deferredId = await insertAction(seeded);
    await insertWakeRun(seeded, { status: "queued", recoveryActionId: deferredId });
    const retirableId = await insertAction(seeded, {
      sourceIssueId: secondIssueId,
      fingerprint: `stranded:${secondIssueId}`,
    });

    const retired = await escalate();

    expect(retired.map((action) => action.id)).toEqual([retirableId]);
    expect((await readAction(deferredId)).status).toBe("active");
    expect((await readAction(retirableId)).status).toBe("escalated");
  });

  it("defers through the production sweep, posting no horizon notice", async () => {
    // The unit tests above call `escalateExpiredWakeHorizons` directly. This one goes through
    // the only caller, with the config-derived ceiling rather than an explicit one, so the
    // deferral is shown reachable as deployed — and shows the consequence that matters: the
    // source row gets no "Paperclip has stopped waking anyone for it" notice while its repair
    // is still in flight.
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    await insertWakeRun(seeded, { status: "scheduled_retry", recoveryActionId: actionId });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ checked: 0, escalated: 0, announced: 0 });
    expect((await readAction(actionId)).status).toBe("active");
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comments).toEqual([]);
  });

  it("lifts a pending_wake_ceiling retirement when the row takes its first real horizon", async () => {
    // BLO-40297 lifts a DERIVED `timeout_horizon` on exactly this event, because otherwise the
    // row's recorded state and its behaviour disagree: it goes back to being woken while still
    // carrying a retirement that says nothing wakes for it. `pending_wake_ceiling` is written
    // by the same sweep on the same creation anchor, so it has to be lifted on the same terms.
    const seeded = await seed();
    const actionId = await insertAction(seeded, {
      maxAttempts: null,
      timeoutAt: null,
      status: "escalated",
      retiringBound: "pending_wake_ceiling",
    });

    const upserted = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerAgentId: seeded.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded:${seeded.sourceIssueId}`,
      nextAction: "Restore a live execution path.",
      maxAttempts: 5,
      timeoutAt: new Date(now.getTime() + timeoutMs),
    });

    expect(upserted.id).toBe(actionId);
    expect(upserted.status).toBe("active");
    expect(upserted.retiringBound).toBeNull();
  });
});

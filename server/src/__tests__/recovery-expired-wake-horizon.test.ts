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
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { attentionService } from "../services/attention.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  RECOVERY_HORIZON_EXPIRED_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * BLO-24662 AC2: a recovery action past its `timeoutAt` must stop reporting
 * `status: "active"` and must surface.
 *
 * The worked example is BLO-20995: a `stranded_assigned_issue` action with
 * `timeoutAt: 2026-08-08T17:11:02Z`, `attemptCount: 0 / 5`, still reading `active` 13h
 * later. Nothing wakes for it and nothing raises it — the mechanism that exists to catch
 * strandings, itself stranded, and invisible because `active` is the healthy value.
 */
describeEmbeddedPostgres("recovery wake horizon expiry (BLO-24662)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-horizon-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issues);
    // Before `agents`/`companies`: heartbeat_runs has FKs onto both.
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const now = new Date("2026-08-09T06:00:00.000Z");
  const pastHorizon = new Date("2026-08-08T17:11:02.000Z");
  const futureHorizon = new Date("2026-08-09T18:00:00.000Z");

  async function seed() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Horizon Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Designer",
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
      title: "white ink on --success and --error fills",
      // The exact shape from the incident: blocked, assigned, and going nowhere.
      status: "blocked",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      issueNumber: 20995,
      identifier: `${prefix}-20995`,
    });

    return { companyId, ownerAgentId, sourceIssueId };
  }

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
      attemptCount: 0,
      maxAttempts: 5,
      timeoutAt: pastHorizon,
      lastAttemptAt: pastHorizon,
      ...overrides,
    });
    return id;
  }

  function readAction(id: string) {
    return db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, id))
      .then((rows) => rows[0]!);
  }

  it("moves a past-horizon action at 0 attempts out of active and announces it", async () => {
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 1, announced: 1, neverDelivered: 1 });
    const action = await readAction(actionId);
    expect(action.status).not.toBe("active");
    expect(action.status).toBe("escalated");

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Recovery wake horizon reached");
    expect(comments[0]!.body).toContain(pastHorizon.toISOString());
    // PEN-3000: the 0-attempt case is the one the ticket calls out, but the reason matters
    // and the old wording got it backwards. `attemptCount` counts DELIVERED wakes, not
    // sweeps — every sweep reserves +1 and refunds it when `enqueueWakeup` returns null — so
    // 0 does not mean "nothing was ever scheduled", it means every sweep since the current
    // owner took over was refused by the wake channel. Assert the note says so, because an
    // operator who reads "never scheduled" goes looking at the wrong layer — and assert it
    // does NOT claim the whole window, because owner churn restarts the counter (see the
    // churned-owner test below).
    expect(comments[0]!.body).toContain("no wake reached the queue for this action's current owner");
    expect(comments[0]!.body).toContain("DELIVERED, not sweeps attempted");
    expect(comments[0]!.body).not.toContain("never made a single wake attempt");
    expect(comments[0]!.body).not.toContain("across the whole window");
  });

  it("distinguishes a delivered-at-least-once expiry from a never-delivered one", async () => {
    // PEN-3000: these two are different incidents with different responders and they used to
    // render identically. `attemptCount > 0` means the owner WAS woken and recovery still did
    // not converge — a genuine unresolvable stranding — so it must not claim the wake channel
    // refused, and must not be counted in `neverDelivered`.
    const seeded = await seed();
    await insertAction(seeded, { attemptCount: 2 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 1, announced: 1, neverDelivered: 0 });
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Attempts: 2 (budget 5)");
    expect(comments[0]!.body).toContain("reassigning will NOT restore the wake budget");
    expect(comments[0]!.body).not.toContain("no wake reached the queue for this action's current owner");
  });

  it("labels an owner-churned row at 0 attempts never_delivered, scoped to the current owner", async () => {
    // Ally review on #1712: `attemptCount` RESTARTS on owner change
    // (`attemptCount: isNewOwnerSequence ? 1 : existing.attemptCount + 1` in
    // `upsertSourceScopedUnlocked`), so owner A woken three times → handoff to B → B's one
    // reservation refunded → horizon expires also reads `attemptCount: 0`. The label
    // therefore claims only that no wake reached the CURRENT owner's queue, and the
    // operator note must say so rather than assert the whole window was refused.
    //
    // It is deliberately NOT gated on `previousOwnerAgentId === null`: the stranded sweep
    // writes `previousOwnerAgentId: input.issue.assigneeAgentId` on the very FIRST insert
    // (`recovery/service.ts`, `upsertSourceScoped` call in the stranded path), so the field
    // is non-null on exactly the un-churned population PEN-3000 measured, and that gate
    // would silence the paging series for the incident it exists to catch. This row carries
    // a non-null previous owner distinct from the current one to pin that decision.
    __resetMetricsForTest();
    const seeded = await seed();
    const previousOwnerAgentId = randomUUID();
    await db.insert(agents).values({
      id: previousOwnerAgentId,
      companyId: seeded.companyId,
      name: "Previous owner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await insertAction(seeded, { attemptCount: 0, previousOwnerAgentId });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 1, announced: 1, neverDelivered: 1 });
    const { body } = await renderMetrics();
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 1`);
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 0`);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("no wake reached the queue for this action's current owner");
    expect(comments[0]!.body).toContain("An earlier owner may have been woken");
    expect(comments[0]!.body).not.toContain("across the whole window");
  });

  it("emits the horizon-expiry metric split by delivery, through the real sweep", async () => {
    // PEN-3000 asked for exactly this discriminator: "an action reaching its horizon with
    // attemptCount: 0 should be distinguishable in alerting from one that exhausted its
    // budget — the first is a scheduler failure, the second is a genuine unresolvable
    // stranding, and today they render identically."
    //
    // Asserted through `reconcileExpiredRecoveryWakeHorizons` rather than by calling the
    // recorder directly, because the defect this guards against is the CALL SITE picking the
    // wrong label — a direct recorder test would pass with the labels swapped.
    //
    // The counts are deliberately ASYMMETRIC (2 never-delivered vs 1 delivered). With one of
    // each, both series read 1 and swapping the ternary at the call site is invisible —
    // verified by mutation: the symmetric version of this test passed against an inverted
    // ternary. Keep them unequal or this test stops holding the invariant it names.
    __resetMetricsForTest();
    const neverDeliveredA = await seed();
    await insertAction(neverDeliveredA, { attemptCount: 0 });
    const neverDeliveredB = await seed();
    await insertAction(neverDeliveredB, { attemptCount: 0 });
    const delivered = await seed();
    await insertAction(delivered, { attemptCount: 3 });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });
    expect(result).toMatchObject({ escalated: 3, neverDelivered: 2 });

    const { body } = await renderMetrics();
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 2`);
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 1`);
  });

  it("seeds both delivery series at zero so an alert can fire before the first expiry", async () => {
    // Without the zero-init an `absent()`/rate alert on never_delivered cannot distinguish
    // "no expiry yet" from "not instrumented", which is the failure mode that let this go
    // unmeasured. Same reason the backstop gauges are seeded.
    __resetMetricsForTest();

    const { body } = await renderMetrics();
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 0`);
    expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 0`);
  });

  it("leaves an action whose horizon has not passed alone", async () => {
    const seeded = await seed();
    const actionId = await insertAction(seeded, { timeoutAt: futureHorizon });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 0, announced: 0 });
    expect((await readAction(actionId)).status).toBe("active");
  });

  it("leaves an unbounded action alone even with a past timeoutAt", async () => {
    // `maxAttempts: null` is the monitor-only / manual-repair shape. A `timeoutAt` there
    // belongs to the provider-quota scheduler's `retryAt`, not to a wake horizon, and is
    // routinely already in the past — retiring on it would manufacture a false exhaustion.
    const seeded = await seed();
    const actionId = await insertAction(seeded, { maxAttempts: null });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 0 });
    expect((await readAction(actionId)).status).toBe("active");
  });

  it("is idempotent — a second sweep neither re-escalates nor re-announces", async () => {
    const seeded = await seed();
    await insertAction(seeded);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    await recovery.reconcileExpiredRecoveryWakeHorizons({ now });
    const second = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(second).toMatchObject({ escalated: 0, announced: 0 });
    const comments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comments).toHaveLength(1);
  });

  it("keeps the escalated status sticky across a later upsert", async () => {
    // The horizon is creation-anchored and no owner change restores it, so an escalated
    // row must not be flipped back to `active` by the next sweep's upsert — that would
    // silently un-retire it and put it straight back into the invisible state.
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });
    await recovery.reconcileExpiredRecoveryWakeHorizons({ now });
    expect((await readAction(actionId)).status).toBe("escalated");

    const svc = issueRecoveryActionService(db);
    const upserted = await svc.upsertSourceScoped({
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerAgentId: seeded.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded:${seeded.sourceIssueId}:v2`,
      nextAction: "Restore a live execution path.",
      maxAttempts: 5,
      timeoutAt: futureHorizon,
    });

    expect(upserted.id).toBe(actionId);
    expect(upserted.status).toBe("escalated");
    expect((await readAction(actionId)).status).toBe("escalated");
  });

  it("holds the active-source slot so no fresh-budget action can be opened", async () => {
    // `escalated` rather than a terminal status is load-bearing: it stays inside the
    // partial unique index, so the next sweep updates this row instead of opening a new
    // one with a fresh 5-attempt budget and a fresh horizon (the unbounded re-fire loop
    // BLO-18996 closed).
    const seeded = await seed();
    await insertAction(seeded);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });
    await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerAgentId: seeded.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded:${seeded.sourceIssueId}:v2`,
      nextAction: "Restore a live execution path.",
      maxAttempts: 5,
      timeoutAt: futureHorizon,
    });

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, seeded.sourceIssueId));
    expect(rows).toHaveLength(1);
  });

  it("surfaces the escalated action in the attention feed even though an agent owns it", async () => {
    // The surfacing half of the AC. Before this change the attention query required a
    // user/board owner, so an agent-owned action that could no longer wake anyone — the
    // exact BLO-20995 shape — reached no human at all.
    const seeded = await seed();
    const actionId = await insertAction(seeded);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const before = await attentionService(db).list(seeded.companyId, { userId: "board-user" });
    expect(
      before.items.filter((item) => item.sourceKind === "recovery_action"),
    ).toHaveLength(0);

    await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    const after = await attentionService(db).list(seeded.companyId, { userId: "board-user" });
    const surfaced = after.items.filter((item) => item.sourceKind === "recovery_action");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.subject.id).toBe(actionId);
    expect(surfaced[0]!.severity).toBe("high");
    expect(surfaced[0]!.whyNow).toContain("no longer wakes anyone");
  });

  /**
   * BLO-19124: the `attemptCount === 0` notice asserted that the stranding "was never worked"
   * and that the fault was scheduler-side. `attemptCount` counts wakes THIS ACTION delivered,
   * so 0 proves only that this action never woke anyone — it says nothing about whether the
   * issue was serviced by some other path.
   *
   * The worked example is BLO-19124 itself: action opened 16:35Z at `attemptCount: 0`, owner
   * runs commented at 19:44Z and 22:01Z, horizon 22:35Z, escalated 22:55Z with that sentence
   * attached to an issue that had demonstrably been worked twice inside the window.
   *
   * The retirement itself is NOT conditional — see the note on
   * `reconcileExpiredRecoveryWakeHorizons` for why discharging instead would free
   * `issue_recovery_actions_active_source_uq` and reinstate the BLO-18996 re-fire loop. Only
   * the claim changes. Every case below therefore asserts `escalated`; what varies is the text.
   */
  const actionCreatedAt = new Date("2026-08-08T11:00:00.000Z");
  /** The sentence that was false on a worked issue. */
  const SCHEDULER_FAULT_CLAIM = "was never worked, and that is a scheduler-side fault";
  /** The sentence that replaces it when the issue was in fact serviced. */
  const WORKED_ANYWAY_CLAIM = "The issue itself WAS worked inside this window even so";

  async function insertIssueRun(
    seeded: Awaited<ReturnType<typeof seed>>,
    overrides: { status: string; createdAt: Date; finishedAt?: Date; issueId?: string },
  ) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: seeded.companyId,
      agentId: seeded.ownerAgentId,
      status: overrides.status,
      // Long finished by the time the sweep reads the row — the shape
      // `hasActiveExecutionPath` cannot see, which is why it is the wrong instrument here.
      startedAt: overrides.createdAt,
      finishedAt: overrides.finishedAt ?? new Date(overrides.createdAt.getTime() + 60_000),
      createdAt: overrides.createdAt,
      contextSnapshot: { issueId: overrides.issueId ?? seeded.sourceIssueId },
    });
  }

  async function escalateAndReadNotice(seeded: Awaited<ReturnType<typeof seed>>) {
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });
    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });
    const [comment] = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    return { result, body: comment?.body ?? "" };
  }

  it("does not claim a scheduler-side fault when a successful run landed inside the horizon", async () => {
    const seeded = await seed();
    const actionId = await insertAction(seeded, { createdAt: actionCreatedAt });
    // Finished 18h before the sweep, 1h after the action opened.
    await insertIssueRun(seeded, { status: "succeeded", createdAt: new Date("2026-08-08T12:00:00.000Z") });

    const { result, body } = await escalateAndReadNotice(seeded);

    expect(result).toMatchObject({
      escalated: 1,
      neverDelivered: 1,
      neverDeliveredButWorked: 1,
      announced: 1,
    });
    expect(body).toContain(WORKED_ANYWAY_CLAIM);
    expect(body).not.toContain(SCHEDULER_FAULT_CLAIM);
    // The row is still retired, and still HOLDS the uniqueness slot. See the reuse test below.
    expect((await readAction(actionId)).status).toBe("escalated");
  });

  it("counts a run that straddles the action's opening as worked", async () => {
    // The predicate is `createdAt >= since OR finishedAt >= since` — an OVERLAP test, not a
    // containment one. This is the arm that distinguishes the two, and the `predates` control
    // below is only a true negative because its run finished before the anchor as well.
    const seeded = await seed();
    await insertAction(seeded, { createdAt: actionCreatedAt });
    await insertIssueRun(seeded, {
      status: "succeeded",
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
      finishedAt: new Date("2026-08-08T13:00:00.000Z"),
    });

    const { result, body } = await escalateAndReadNotice(seeded);

    expect(result).toMatchObject({ escalated: 1, neverDeliveredButWorked: 1 });
    expect(body).toContain(WORKED_ANYWAY_CLAIM);
  });

  it("still claims a scheduler-side fault when the only run on the issue failed", async () => {
    // Negative control. A crashed run did not service the issue, so the original claim is true
    // and must survive. Without this, a guard that softened on ANY run would pass the tests
    // above and silence the mechanism entirely.
    const seeded = await seed();
    await insertAction(seeded, { createdAt: actionCreatedAt });
    await insertIssueRun(seeded, { status: "failed", createdAt: new Date("2026-08-08T12:00:00.000Z") });

    const { result, body } = await escalateAndReadNotice(seeded);

    expect(result).toMatchObject({ escalated: 1, neverDelivered: 1, neverDeliveredButWorked: 0 });
    expect(body).toContain(SCHEDULER_FAULT_CLAIM);
    expect(body).not.toContain(WORKED_ANYWAY_CLAIM);
  });

  it("still claims a scheduler-side fault when the successful run ended before the action opened", async () => {
    // The anchor is load-bearing in the other direction: a run that both started AND finished
    // before this action existed is what the stranding happened after, not evidence against it.
    const seeded = await seed();
    await insertAction(seeded, { createdAt: actionCreatedAt });
    await insertIssueRun(seeded, {
      status: "succeeded",
      createdAt: new Date("2026-08-08T09:00:00.000Z"),
      finishedAt: new Date("2026-08-08T09:30:00.000Z"),
    });

    const { result, body } = await escalateAndReadNotice(seeded);

    expect(result).toMatchObject({ escalated: 1, neverDeliveredButWorked: 0 });
    expect(body).toContain(SCHEDULER_FAULT_CLAIM);
  });

  it("still claims a scheduler-side fault when the successful run belongs to a different issue", async () => {
    // `contextSnapshot ->> 'issueId'` is the only thing tying a run to an issue; a guard that
    // dropped that predicate would soften every notice in a busy company.
    const seeded = await seed();
    await insertAction(seeded, { createdAt: actionCreatedAt });
    await insertIssueRun(seeded, {
      status: "succeeded",
      createdAt: new Date("2026-08-08T12:00:00.000Z"),
      issueId: randomUUID(),
    });

    const { result, body } = await escalateAndReadNotice(seeded);

    expect(result).toMatchObject({ escalated: 1, neverDeliveredButWorked: 0 });
    expect(body).toContain(SCHEDULER_FAULT_CLAIM);
  });

  it("leaves the escalated row holding the uniqueness slot, so a re-strand cannot mint a fresh budget", async () => {
    // Ally's review of #1950 caught the real hazard in the withdrawn discharge approach: a
    // TERMINAL status (`resolved`) is outside `ACTIVE_RECOVERY_ACTION_STATUSES`, which frees
    // `issue_recovery_actions_active_source_uq`, and `upsertSourceScoped` then INSERTs a fresh
    // row at `attemptCount: 0` with a fresh horizon instead of reusing this one — the unbounded
    // re-fire loop BLO-18996 closed. `escalated` is inside that set, so it cannot happen. This
    // test is what pins that, and it fails if anyone retires this row terminally again.
    const seeded = await seed();
    const actionId = await insertAction(seeded, { createdAt: actionCreatedAt });
    await insertIssueRun(seeded, { status: "succeeded", createdAt: new Date("2026-08-08T12:00:00.000Z") });
    await escalateAndReadNotice(seeded);

    const reused = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: seeded.companyId,
      sourceIssueId: seeded.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: seeded.ownerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded:${seeded.sourceIssueId}`,
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 5,
      timeoutAt: new Date("2026-08-10T00:00:00.000Z"),
    });

    // Same row, not a new one — and the creation-anchored horizon is untouched, so the
    // re-strand inherits the spent window rather than a fresh one.
    expect(reused!.id).toBe(actionId);
    expect(reused!.status).toBe("escalated");
    expect(new Date(reused!.timeoutAt!).toISOString()).toBe(pastHorizon.toISOString());
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES,
  issueRecoveryActionService,
} from "../services/issue-recovery-actions.js";
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
  it("retires a 25-action burst on one 3-concurrency owner bounded by the sweep limit, not by the owner", async () => {
    // BLO-19124 AC4 (burst safety): "creating N recovery actions for one owner in a short
    // window does not depend on that owner absorbing N wakes. Demonstrate with N >= 20
    // against an owner whose `maxConcurrentRuns` is 3."
    //
    // The 07-30 snapshot is the failure this pins: 59 one-shot `wake_owner` beacons landed
    // on a single owner in one day, that owner runs 3 concurrent slots, and there was no
    // second chance — so a burst deterministically stranded most of its own recoveries.
    //
    // WHICH ASSERTION CARRIES THE AC, and which does not — stated because the obvious
    // reading is wrong. `expect(enqueueWakeup).not.toHaveBeenCalled()` below looks like the
    // demonstration and is NOT: `reconcileExpiredRecoveryWakeHorizons` contains no call to
    // `enqueueWakeup` on any path (the only mention in it is a comment), so that assertion
    // holds for N=1 as readily as N=25 and cannot fail against today's code. It is kept
    // deliberately, as a REGRESSION GUARD — it fails the moment someone puts a wake back
    // into the retirement path — but a guard that cannot fail today demonstrates nothing,
    // and citing it as the AC4 evidence would be exactly that.
    //
    // The AC rests on the two-pass drain instead, which is the only part here that depends
    // on N. The retiring path is a batch sweep over the table whose batch is bounded by its
    // OWN `limit` and by nothing else: pass one with `limit: 3` retires exactly 3, and pass
    // two retires the remaining 22 in one go. Were the batch owner-bounded — the pre-fix
    // shape, where progress was gated on how many beacons a 3-slot owner could absorb —
    // pass two would stop at 3 and leave 19 rows `active`. Both counts fail if that
    // changes, so the burst size is load-bearing rather than decorative.
    const N = 25;
    const FIRST_PASS = 3;
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const prefix = `BU${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Burst Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Burst Owner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      // The AC names this number, so assert the fixture carries it rather than letting a
      // later edit quietly turn this into a burst against an unbounded owner.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
      permissions: {},
    });
    const [owner] = await db.select().from(agents).where(eq(agents.id, ownerAgentId));
    expect(
      (owner!.runtimeConfig as { heartbeat?: { maxConcurrentRuns?: number } }).heartbeat
        ?.maxConcurrentRuns,
    ).toBe(3);

    const issueIds: string[] = [];
    const actionIds: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `burst row ${i}`,
        // The shape the stranded sweep leaves behind: blocked, assigned, zero blocker edges.
        status: "blocked",
        priority: "high",
        assigneeAgentId: ownerAgentId,
        issueNumber: 30000 + i,
        identifier: `${prefix}-${30000 + i}`,
      });
      const actionId = randomUUID();
      actionIds.push(actionId);
      await db.insert(issueRecoveryActions).values({
        id: actionId,
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId,
        cause: "stranded_assigned_issue",
        fingerprint: `stranded:${issueId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        // 0 DELIVERED wakes is the burst's own signature: every sweep reserved an attempt
        // and the wake channel refused it, because the owner's 3 slots were saturated by
        // the other 24. This is the population the 07-30 snapshot measured at 67/131.
        attemptCount: 0,
        maxAttempts: 5,
        timeoutAt: pastHorizon,
        lastAttemptAt: pastHorizon,
      });
    }

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    // Pass one, capped well below the burst: the batch is bounded by the sweep's own limit.
    const first = await recovery.reconcileExpiredRecoveryWakeHorizons({ now, limit: FIRST_PASS });
    expect(first).toMatchObject({ checked: FIRST_PASS, escalated: FIRST_PASS });

    // Pass two, uncapped: the whole remainder drains at once. An owner-bounded sweep would
    // stop at the owner's 3 slots here and strand 19 rows — this is the AC4 assertion.
    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });
    expect(result).toMatchObject({
      checked: N - FIRST_PASS,
      escalated: N - FIRST_PASS,
      neverDelivered: N - FIRST_PASS,
      announced: N - FIRST_PASS,
    });

    // Regression guard, not the demonstration — see the header comment. Retirement must
    // stay a table sweep; the day it wakes the owner, a burst is owner-bounded again.
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(inArray(issueRecoveryActions.id, actionIds));
    expect(rows).toHaveLength(N);
    for (const row of rows) {
      expect(row.status).toBe("escalated");
      // AC2's dedicated field: which bound retired it, not prose and not `outcome`.
      expect(row.retiringBound).toBe("timeout_horizon");
      // `outcome` must stay null — it is load-bearing for
      // `issue_recovery_actions_active_source_uq` and writing it reopens BLO-18996's loop.
      expect(row.outcome).toBeNull();
    }

    // Every source issue gets its own notice. One announcement per issue, not one for the
    // batch: an operator triaging BLO-30001 must find it on BLO-30001.
    const comments = await db
      .select({ issueId: issueComments.issueId, body: issueComments.body })
      .from(issueComments)
      .where(inArray(issueComments.issueId, issueIds));
    expect(comments).toHaveLength(N);
    expect(new Set(comments.map((c) => c.issueId)).size).toBe(N);

    // AC3's surviving half, one step removed and said plainly: this asserts the
    // SUPPRESSION is released on all N, not that a resumer ran. `blocked` with zero
    // blockers is auto-resumable only while no recovery action holds a status in
    // `BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES` (issues.ts), and
    // `escalated` is deliberately not in that set. Leave 1 of 25 `active` and the
    // resumer skips that row forever — which is the pre-bounds strand.
    const stillSuppressing = rows.filter((row) =>
      (BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES as readonly string[]).includes(
        row.status,
      ),
    );
    expect(stillSuppressing).toHaveLength(0);
  });
});

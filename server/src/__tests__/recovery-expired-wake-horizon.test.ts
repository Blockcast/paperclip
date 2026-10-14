import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
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
  BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES,
  issueRecoveryActionService,
} from "../services/issue-recovery-actions.js";
import { attentionService } from "../services/attention.js";
import { recoveryService } from "../services/recovery/service.js";
import { reconcileStrandedBlockedIssues } from "../services/stranded-blocked-issue-reconciler.js";
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
    // One TRUNCATE ... CASCADE rooted at `companies` reaches every table this
    // suite writes, so cleanup cannot go stale against a new FK. The burst case
    // drives `reconcileStrandedBlockedIssues`, which writes an
    // `issue.stranded_blocked_reconciled` activity_log row per issue it resumes.
    // That row populates `company_id` only today, but `activity_log` carries FKs
    // to `companies`, `agents` AND `heartbeat_runs`, the last two without an
    // `onDelete` action (BLO-22231) — so a hand-ordered delete list has to track
    // every FK this table grows; this gets them for free.
    await truncateCompanyScopedTestState(db);
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

    return { companyId, ownerAgentId, sourceIssueId, prefix };
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

  it("leaves a RECENT unbounded action alone even with a past timeoutAt", async () => {
    // `maxAttempts: null` is the monitor-only / manual-repair shape. A `timeoutAt` there
    // belongs to the provider-quota scheduler's `retryAt`, not to a wake horizon, and is
    // routinely already in the past — retiring on it would manufacture a false exhaustion.
    //
    // BLO-40297 added a second arm that DOES retire unbounded rows, anchored on `createdAt`.
    // This case is what keeps the two apart, so the fixture's `createdAt` is now load-bearing
    // and stated rather than defaulted: fresh, so only the `timeoutAt` arm could fire. If the
    // derived arm ever starts reading `timeoutAt`, this goes red — which is the whole job.
    const seeded = await seed();
    const actionId = await insertAction(seeded, { maxAttempts: null, createdAt: now });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 0 });
    expect((await readAction(actionId)).status).toBe("active");
  });

  it("retires an unbounded action once it is older than the derived horizon (BLO-40297)", async () => {
    // The shape this ticket is about: BOTH `maxAttempts` and `timeoutAt` null, so the row
    // matched neither sweep predicate and was structurally un-retireable — permanently
    // `active` while holding `issue_recovery_actions_active_source_uq`, which blocks the
    // source issue from ever opening a fresh recovery action. 21 such rows company-wide on
    // 2026-10-05, oldest 122 days.
    const seeded = await seed();
    const actionId = await insertAction(seeded, {
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: null,
      createdAt: new Date(now.getTime() - 90 * 24 * 60 * 60_000),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 1, announced: 1 });
    const action = await readAction(actionId);
    expect(action.status).toBe("escalated");
    // AC2: retired through the existing terminal path, carrying a bound. `outcome` MUST stay
    // null — writing one frees the active-source unique index and re-opens the unbounded
    // re-fire loop BLO-18996 closed.
    expect(action.retiringBound).toBe("timeout_horizon");
    expect(action.outcome).toBeNull();

    // The announcement must not render `horizon \`null\``: an operator reading the notice has
    // to be able to see which horizon was burned. (Dedup is unaffected either way — the
    // marker embeds the unique `action.id`.)
    const [comment] = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, seeded.sourceIssueId));
    expect(comment!.body).not.toContain("horizon `null`");
    expect(comment!.body).toContain("derived from `createdAt`");
  });

  it("leaves an OWNERLESS unbounded action alone however old it is (BLO-40297)", async () => {
    // The documented carve-out, and the negative control for the arm above. `wakesOwner` is
    // `Boolean(ownerAgentId) && …`, so an ownerless action wakes nobody by construction and
    // has no wake horizon to burn — the provider-quota monitor wait is expected to sit open
    // across many sweeps. Without this, the derived arm would retire it on age alone.
    const seeded = await seed();
    const actionId = await insertAction(seeded, {
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: null,
      ownerType: "system",
      ownerAgentId: null,
      createdAt: new Date(now.getTime() - 90 * 24 * 60 * 60_000),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 0 });
    expect((await readAction(actionId)).status).toBe("active");
  });

  it("retires an unbounded action of ANY kind, not just stranded_assigned_issue (BLO-40297)", async () => {
    // AC4: the hole is kind-agnostic. `workspace_validation` and `pr_review_non_convergence`
    // are both in the measured cohort because `wakesOwner` excludes their causes outright, so
    // they are created unbounded TODAY — a `stranded_assigned_issue`-only fix would leave the
    // hole open for the next cause added to that list.
    const seeded = await seed();
    const actionId = await insertAction(seeded, {
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: null,
      createdAt: new Date(now.getTime() - 26 * 24 * 60 * 60_000),
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    expect(result).toMatchObject({ escalated: 1 });
    expect((await readAction(actionId)).status).toBe("escalated");
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
    // OWN `limit` and by nothing else: pass one with `limit: 4` retires exactly 4, and pass
    // two retires the remaining 21 in one go. Were the batch owner-bounded — the pre-fix
    // shape, where progress was gated on how many beacons a 3-slot owner could absorb —
    // pass one would stop at 3 and pass two would stop at 3, stranding 19 rows `active`.
    // Both counts fail if that changes, so the burst size is load-bearing rather than
    // decorative.
    //
    // FIRST_PASS is deliberately NOT 3. At 3 it collides with the fixture's
    // `maxConcurrentRuns: 3`, and pass one then predicts `checked: 3` under BOTH
    // hypotheses — limit-bounded and owner-bounded — so it discriminates neither and all
    // the weight falls on pass two. At 4 the two hypotheses disagree on pass one as well
    // (4 vs 3), at no cost.
    const N = 25;
    const FIRST_PASS = 4;
    // Pass two's batch cap, stated rather than defaulted. `escalateExpiredWakeHorizons`
    // falls back to `input.limit ?? 200` (issue-recovery-actions.ts:832); relying on that
    // would make `checked: 21` depend on an unrelated batch-size constant staying above 21,
    // and a future tune of it would fail this test with a count the comment here attributes
    // to owner-bounding. Any value > N - FIRST_PASS keeps the discrimination identical.
    const SECOND_PASS = N;
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
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } },
      permissions: {},
    });
    const [owner] = await db.select().from(agents).where(eq(agents.id, ownerAgentId));
    // FIXTURE GUARD, and a weaker one than the `enqueueWakeup` guard below — same family,
    // named here by the same standard. No path in the retirement sweep reads the owner's
    // `runtimeConfig` at all (neither `reconcileExpiredRecoveryWakeHorizons` nor
    // `escalateExpiredWakeHorizons` touches it), so unlike the `enqueueWakeup` guard — which
    // fails if a wake ever returns to the path — this one cannot fail against ANY production
    // change. It fails only if someone edits the four literal lines above it. That is still
    // worth keeping: the AC names this number, and the test's claim to be "a burst against a
    // 3-slot owner" is false if the fixture quietly stops being one. It is not evidence.
    expect(
      (owner!.runtimeConfig as { heartbeat?: { maxConcurrentRuns?: number } }).heartbeat
        ?.maxConcurrentRuns,
    ).toBe(3);

    const issueIds = Array.from({ length: N }, () => randomUUID());
    const actionIds = Array.from({ length: N }, () => randomUUID());
    await db.insert(issues).values(
      issueIds.map((issueId, i) => ({
        id: issueId,
        companyId,
        title: `burst row ${i}`,
        // The shape the stranded sweep leaves behind: blocked, assigned, zero blocker edges.
        status: "blocked" as const,
        priority: "high" as const,
        assigneeAgentId: ownerAgentId,
        issueNumber: 30000 + i,
        identifier: `${prefix}-${30000 + i}`,
      })),
    );
    await db.insert(issueRecoveryActions).values(
      actionIds.map((actionId, i) => ({
        id: actionId,
        companyId,
        sourceIssueId: issueIds[i]!,
        kind: "stranded_assigned_issue" as const,
        status: "active" as const,
        ownerType: "agent" as const,
        ownerAgentId,
        cause: "stranded_assigned_issue",
        fingerprint: `stranded:${issueIds[i]!}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        // 0 DELIVERED wakes is the burst's own signature: every sweep reserved an attempt
        // and the wake channel refused it, because the owner's 3 slots were saturated by
        // the other 24. This is the population the 07-30 snapshot measured at 67/131.
        attemptCount: 0,
        maxAttempts: 5,
        timeoutAt: pastHorizon,
        lastAttemptAt: pastHorizon,
      })),
    );

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    // Pass one, capped below both the burst AND the owner's 3 slots: the batch is bounded by
    // the sweep's own limit. An owner-bounded sweep would stop at 3 here, not 4.
    const first = await recovery.reconcileExpiredRecoveryWakeHorizons({ now, limit: FIRST_PASS });
    expect(first).toMatchObject({ checked: FIRST_PASS, escalated: FIRST_PASS });

    // Pass two, capped above the remainder: the whole remainder drains at once. An
    // owner-bounded sweep would stop at the owner's 3 slots here and strand 18 rows — this
    // is the AC4 assertion.
    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({
      now,
      limit: SECOND_PASS,
    });
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
    //
    // Kept as the narrow unit check, with signal (d) driven end to end below it. The two
    // are not the same claim: this one proves the resumer is ALLOWED to run, not that any
    // row ever leaves `blocked`.
    const stillSuppressing = rows.filter((row) =>
      (BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES as readonly string[]).includes(
        row.status,
      ),
    );
    expect(stillSuppressing).toHaveLength(0);

    // Signal (d), driven rather than inferred: "no source issue is left `blocked` with
    // `unresolvedBlockerCount == 0`".
    //
    // WHY THIS IS NOT CEREMONY ON TOP OF `stillSuppressing`. The CEO's 2026-10-01
    // amendment replaced signal (b) with "the burst was retired on strictly fewer than N
    // delivered wakes, and every action reached a terminal bound" — and attached a
    // condition to it: scored together with (d), NEVER alone, because "scored alone, (b)
    // would reward a mechanism that simply never wakes anybody". This burst is the
    // extreme of exactly that: `enqueueWakeup` is asserted above to have been called
    // ZERO times. So (b') here is satisfied by a mechanism that woke nobody at all, and
    // (d) is the entire thing standing between that and a passing test over 25 issues
    // sitting `blocked` with no blockers and no wake path. Inferring (d) from a released
    // suppression does not discharge it: the resumer has its own candidate gate
    // (stranded-blocked-issue-reconciler.ts) and an issue can clear the recovery
    // suppression and still be held there. Both halves must be scored on ONE fixture,
    // which is what the amendment asks for and what no single test did before.
    const resumed = await reconcileStrandedBlockedIssues(db);
    expect(resumed.reconciled).toBe(N);
    const resumedIssues = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    expect(resumedIssues).toHaveLength(N);
    // Named per-row rather than as a count, so a failure says WHICH rows stranded.
    expect(resumedIssues.filter((row) => row.status === "blocked").map((row) => row.id)).toEqual([]);
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
    // Ally suggestion 3 on 36bd9d6b: assert the budget directly rather than inferring it from
    // the preserved horizon. The reuse path sets `attemptCount: existing.attemptCount + 1`
    // (`issue-recovery-actions.ts:575`), so 1 here is positive proof of reuse — a fresh INSERT
    // would read 0. This complements the slot test at `:351` (which checks the status set) and
    // is not a duplicate of it: that one pins WHICH statuses hold the slot, this one pins the
    // consequence for the budget.
    expect(reused!.attemptCount).toBe(1);
  });

  /**
   * Ally's review of #1950 at `36bd9d6b`: both database reads in the per-row body sat OUTSIDE
   * the try, on a path where the announcement is a once-only opportunity.
   * `escalateExpiredWakeHorizons` flips the whole batch to `escalated` in a single UPDATE and
   * only ever selects `status = "active"` rows, so a row whose notice is skipped is never
   * re-selected by a later sweep. One connection blip or statement timeout therefore aborted
   * the sweep and permanently dropped the notice for every remaining row in the batch (default
   * limit 200) — each already silently moved out of `active`. That is the BLO-24662 silent
   * strand this pass exists to end, arriving through the pass itself.
   */
  function dbWithFailingIssueRunLookup(real: typeof db, failures: { remaining: number }) {
    const bind = (target: object, prop: string | symbol) => {
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    };
    return new Proxy(real, {
      get(target, prop) {
        if (prop !== "select") return bind(target, prop);
        return (...args: unknown[]) => {
          const builder = (target.select as (...a: unknown[]) => object)(...args);
          return new Proxy(builder, {
            get(b, p) {
              if (p !== "from") return bind(b, p);
              return (table: unknown) => {
                // Only the run lookup — the batch UPDATE and the dedup select read other tables.
                if (table === heartbeatRuns && failures.remaining > 0) {
                  failures.remaining -= 1;
                  throw new Error("simulated connection blip on the issue-run lookup");
                }
                return (bind(b, "from") as (t: unknown) => unknown)(table);
              };
            },
          });
        };
      },
    }) as typeof db;
  }

  it("announces the rest of the batch when one row's issue-run lookup throws", async () => {
    const seeded = await seed();
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId: seeded.companyId,
      title: "second stranded issue in the same sweep batch",
      status: "blocked",
      priority: "high",
      assigneeAgentId: seeded.ownerAgentId,
      issueNumber: 20996,
      identifier: `${seeded.prefix}-20996`,
    });
    await insertAction(seeded);
    await insertAction(seeded, {
      sourceIssueId: secondIssueId,
      fingerprint: `stranded:${secondIssueId}`,
    });

    const failures = { remaining: 1 };
    const recovery = recoveryService(dbWithFailingIssueRunLookup(db, failures), {
      enqueueWakeup: vi.fn().mockResolvedValue(null),
    });

    // Before the guard this call REJECTED — the throw escaped the sweep entirely.
    const result = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

    // The blip really fired; without this the test would pass on a no-op injection.
    expect(failures.remaining).toBe(0);
    // Both rows were retired by the batch UPDATE — that half is committed either way — and
    // the surviving row still got its notice.
    expect(result).toMatchObject({ escalated: 2, announced: 1 });
    const statuses = await db
      .select({ status: issueRecoveryActions.status })
      .from(issueRecoveryActions)
      .then((rows) => rows.map((row) => row.status));
    expect(statuses).toEqual(["escalated", "escalated"]);
    const comments = await db.select({ id: issueComments.id }).from(issueComments);
    expect(comments).toHaveLength(1);
  });
  /**
   * PEN-3989: the horizon retirement has THREE writers, and until this change only one of
   * them emitted the PEN-3000 counter or the source-row notice.
   *
   * Every test above drives `reconcileExpiredRecoveryWakeHorizons` — writer 1, the path that
   * already worked. That is exactly the blind spot that let this ship: the suite was thorough
   * about the arm that was never broken. `retiring_bound = 'timeout_horizon'` is also written
   * by `retireWakeAction` from the stranded-wake backstop and by `retireAndReleaseWakeAttempt`
   * from the wake dispatch, both from a ternary (`attemptBudgetReached ? ... : ...`) that a
   * grep for the contiguous literal cannot see, and both behind the DISJUNCTIVE
   * `strandedRecoveryWakeAttemptsExhausted` — so they fire on the same condition writer 1
   * exists to handle, and they race it.
   *
   * Writer 1 cannot recover afterwards: it selects `status = 'active'` only, so a row the
   * backstop already flipped to `escalated` is permanently unselectable there. The
   * announcement was not deferred, it was lost.
   *
   * Measured on 2026-10-12: four actions passed a 6 h horizon, were flipped to `escalated`
   * with `retiring_bound = 'timeout_horizon'` at 07:41:39Z by the backstop, and produced
   * neither a metric increment nor a notice on any of the four source rows.
   *
   * These tests assert BOTH observables, from the BACKSTOP. Asserting only the status
   * transition is what made the failure invisible — that half never stopped working.
   */
  describe("horizon retirement performed by the stranded-wake backstop (PEN-3989)", () => {
    it("counts and announces a horizon retirement the backstop performs", async () => {
      // Counts are deliberately ASYMMETRIC (2 never-delivered vs 1 delivered) for the same
      // reason as the writer-1 test above: with one of each, both series read 1 and an
      // inverted ternary at the call site is invisible.
      __resetMetricsForTest();
      const neverDeliveredA = await seed();
      await insertAction(neverDeliveredA, { attemptCount: 0 });
      const neverDeliveredB = await seed();
      await insertAction(neverDeliveredB, { attemptCount: 0 });
      // Horizon passed but the budget is NOT spent, so this retires on `timeout_horizon`
      // with a wake already delivered — the `delivered` arm, through the same gate.
      const delivered = await seed();
      await insertAction(delivered, { attemptCount: 2 });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

      const result = await recovery.reconcileStrandedRecoveryWakeBackstop({ now });
      expect(result).toMatchObject({ exhaustedSkipped: 3 });

      // Half one: the transition. This never stopped working and is NOT what this guards.
      const actions = await db.select().from(issueRecoveryActions);
      expect(actions).toHaveLength(3);
      for (const action of actions) {
        expect(action.status).toBe("escalated");
        expect(action.retiringBound).toBe("timeout_horizon");
      }

      // Half two: the metric. Zero on both series before this change.
      const { body } = await renderMetrics();
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 2`);
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 1`);

      // Half three: the notice on the SOURCE row. Absent entirely before this change, which
      // is why the four production rows retired with no trace an operator could read.
      for (const seeded of [neverDeliveredA, neverDeliveredB, delivered]) {
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, seeded.sourceIssueId));
        expect(comments).toHaveLength(1);
        expect(comments[0]!.body).toContain("Recovery wake horizon reached");
      }
    });

    it("does not count or announce a backstop retirement on the attempt budget", async () => {
      // Negative control for the ternary. `strandedRecoveryWakeAttemptsExhausted` is
      // disjunctive, so a spent budget reaches the SAME gate — but it is a different
      // retirement with a different meaning, and PEN-3322's alerts key on the horizon arm.
      // Without this, widening the announce to every retirement would still pass the test
      // above.
      __resetMetricsForTest();
      const seeded = await seed();
      await insertAction(seeded, {
        attemptCount: 5,
        maxAttempts: 5,
        timeoutAt: futureHorizon,
      });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

      await recovery.reconcileStrandedRecoveryWakeBackstop({ now });

      const [action] = await db.select().from(issueRecoveryActions);
      expect(action!.retiringBound).toBe("attempt_budget");
      const { body } = await renderMetrics();
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 0`);
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 0`);
      const comments = await db.select({ id: issueComments.id }).from(issueComments);
      expect(comments).toHaveLength(0);
    });

    it("announces exactly once when the horizon sweep runs after the backstop retired the row", async () => {
      // The two paths race the same condition in production. The backstop wins, which leaves
      // the row `escalated` and therefore invisible to writer 1 — so the horizon sweep must
      // find nothing to do and must not post a second notice. This pins the dedup that makes
      // announcing from three call sites safe.
      __resetMetricsForTest();
      const seeded = await seed();
      await insertAction(seeded, { attemptCount: 0 });
      const recovery = recoveryService(db, { enqueueWakeup: vi.fn().mockResolvedValue(null) });

      await recovery.reconcileStrandedRecoveryWakeBackstop({ now });
      const sweep = await recovery.reconcileExpiredRecoveryWakeHorizons({ now });

      expect(sweep).toMatchObject({ escalated: 0, announced: 0 });
      const comments = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, seeded.sourceIssueId));
      expect(comments).toHaveLength(1);
      const { body } = await renderMetrics();
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 1`);
    });
  });

  /**
   * PEN-3989 (Ally review of #2607): writer 2 — the wake dispatch — had NO test at all.
   *
   * The block above covers writer 3 (the backstop) and the blocks above that cover writer 1
   * (the sweep). Writer 2 is `retireAndReleaseWakeAttempt`, reached from
   * `enqueueSourceScopedStrandedRecoveryWake`'s exhaustion gate, and it is the one site whose
   * announce input is DERIVED rather than read: the refund has already landed when the
   * announce runs, so the call adjusts `attemptCount` down by the reserve it is giving back.
   * Announcing the unadjusted value would print `Attempts: 1` on a row that reads 0 AND flip
   * `neverDelivered` to false — labelling a never-woken action `delivered`, the exact mislabel
   * PEN-3000 exists to prevent. Reverting that `Math.max(..., 0)` left the whole suite green.
   *
   * The gate on that announce is the second untested thing. It takes two conjuncts and both
   * are load-bearing; see `retireAndReleaseWakeAttempt`.
   */
  describe("horizon retirement performed by the wake dispatch (PEN-3989)", () => {
    const latestRun = {
      id: randomUUID(),
      status: "failed",
      error: "agent is not invokable",
      errorCode: "agent_not_invokable",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      resultJson: null,
      usageJson: null,
      createdAt: pastHorizon,
    } as const;

    /**
     * Drive one dispatch that lands on the exhaustion gate with `timeoutAt` already past.
     *
     * The first escalation mints the action with a service-computed fingerprint; the row is
     * then backdated and its fingerprint staled so the second escalation's
     * `isUnchangedAction` check is false and the upsert actually RESERVES an attempt instead
     * of short-circuiting through `shouldReuseStrandedRecoveryAction`. That reserve is what
     * puts `attemptCount` at 1 on a row whose true delivered count is 0, which is precisely
     * the state the adjusted announce has to describe.
     */
    /**
     * `seed()` creates one engineer and no manager. `resolveStrandedRecoveryRouting` walks the
     * manager ladder for an `agent_not_invokable` strand, so without a `reportsTo` target the
     * routed owner can come back null — and `enqueueSourceScopedStrandedRecoveryWake` returns
     * on `if (!input.action.ownerAgentId)` before the exhaustion gate this block exists to
     * exercise. Give the ladder somewhere to go.
     */
    async function withManager(seeded: Awaited<ReturnType<typeof seed>>) {
      const managerId = randomUUID();
      await db.insert(agents).values({
        id: managerId,
        companyId: seeded.companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.update(agents)
        .set({ reportsTo: managerId })
        .where(eq(agents.id, seeded.ownerAgentId));
      return managerId;
    }

    async function dispatchOntoPastHorizon(
      database: typeof db,
      seeded: Awaited<ReturnType<typeof seed>>,
    ) {
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, seeded.sourceIssueId))
        .then((rows) => rows[0]!);
      // Non-delivery: every wake out of this gate is refunded, so no attempt is ever spent.
      const recovery = recoveryService(database, {
        enqueueWakeup: vi.fn().mockResolvedValue(null),
      });
      await recovery.escalateStrandedAssignedIssue({
        issue,
        previousStatus: "in_progress",
        latestRun: { ...latestRun, agentId: seeded.ownerAgentId },
        comment: "Automatic continuation recovery failed.",
      });
      const [minted] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, seeded.sourceIssueId));
      expect(minted).toBeDefined();
      await db
        .update(issueRecoveryActions)
        .set({
          status: "active",
          retiringBound: null,
          // 0 delivered wakes. The reserve on the next pass takes it to 1 and the refund
          // takes it back to 0, which is the discrepancy the announce has to correct for.
          attemptCount: 0,
          timeoutAt: pastHorizon,
          // BOTH homes of the horizon, not just the column. `upsertSourceScoped` preserves
          // the creation-anchored horizon across sweeps by reading
          // `evidence.sourceScopedWakeHorizonAt` FIRST and writing it back into `timeoutAt`
          // (`carriedWakeHorizonAt` / `wakeHorizonAt`). Backdating the column alone is
          // silently undone by the next upsert, which restores the future horizon the first
          // escalation minted — the row then is not exhausted, the dispatch never reaches the
          // gate, and the test fails having exercised nothing.
          //
          // Merged in SQL rather than replaced, so the keys the first escalation wrote
          // (`latestRunAgentId`, the routing anchors) survive and the fixture differs from a
          // real row in exactly one field.
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
            sourceScopedWakeHorizonAt: pastHorizon.toISOString(),
          })}::jsonb`,
          // Stale it so `isUnchangedAction` is false and the upsert reserves.
          fingerprint: `stale:${seeded.sourceIssueId}`,
        })
        .where(eq(issueRecoveryActions.id, minted!.id));
      // Clear the mint-time escalation comment and the mint-time metric reads, so what the
      // assertions see comes only from the dispatch under test.
      await db.delete(issueComments).where(eq(issueComments.issueId, seeded.sourceIssueId));
      __resetMetricsForTest();

      // Re-read: the first escalation transfers ownership and writes the issue, so the
      // object captured above is stale by now.
      const escalatedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, seeded.sourceIssueId))
        .then((rows) => rows[0]!);
      await recovery.escalateStrandedAssignedIssue({
        issue: escalatedIssue,
        previousStatus: "in_progress",
        latestRun: { ...latestRun, agentId: seeded.ownerAgentId },
        comment: "Automatic continuation recovery failed.",
      });
      return minted!.id;
    }

    it("counts and announces the dispatch retirement with the REFUNDED attempt count", async () => {
      const seeded = await seed();
      await withManager(seeded);
      const actionId = await dispatchOntoPastHorizon(db, seeded);

      const action = await readAction(actionId);
      expect(action).toMatchObject({
        status: "escalated",
        retiringBound: "timeout_horizon",
        // The refund landed: reserved to 1, given back to 0.
        attemptCount: 0,
      });

      // THE discriminator for the `Math.max(attemptCount - 1, 0)` adjustment. The announce is
      // handed the REFUNDED count, so `neverDelivered` is true and the increment lands on
      // `never_delivered`. Hand it the reserved count instead — which is what reverting that
      // one expression does — and `attemptCount === 0` is false, the increment lands on
      // `delivered`, and a never-woken action is labelled as woken. That is precisely the
      // mislabel PEN-3000 exists to prevent, and this pair of assertions is what catches it:
      // the second one matters as much as the first, because a single-series check passes
      // against a revert that merely moves the count to the other label.
      const { body } = await renderMetrics();
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 1`);
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 0`);

      // Exactly one notice, from two writers that share a marker. `escalateStrandedAssignedIssue`
      // posts the identical `Recovery wake horizon reached for action ...` text inside the
      // escalation transaction, which runs BEFORE this dispatch — so on this path the
      // dispatch's own notice is always deduped away and its contribution is the METRIC
      // above, not the comment. That is why the metric increment must stay ahead of the dedup
      // check in `announceRecoveryHorizonRetirement`: behind it, writer 2 would contribute
      // nothing at all on the only path it ever runs, which is the silence this row exists to
      // end.
      //
      // The surviving notice's `- Attempts:` figure is therefore NOT assertable as the
      // refunded count here — it is the escalation path's text, and that one renders the
      // RESERVED count (`action.attemptCount`, pre-refund) against a row that reads 0. That
      // discrepancy is real but pre-existing and belongs to the other writer; it is recorded
      // on PEN-3989 rather than widened into this change.
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, seeded.sourceIssueId));
      const horizonNotices = comments.filter((row) => row.body.includes("Recovery wake horizon reached"));
      expect(horizonNotices).toHaveLength(1);
    });

    /**
     * The CAS miss. `retireAndReleaseWakeAttempt` only updates a row while the owner and the
     * attempt count still match what the reserve read; a sweep that re-homes the action in
     * between (`isNewOwnerSequence` resets `attemptCount`) matches ZERO rows and resolves with
     * no error.
     *
     * Before the fix the gate read "did not throw" as proof of retirement and announced
     * anyway: a counter increment feeding PEN-3322's alert, a notice telling an operator a
     * still-`active` row had moved to `escalated`, and a dedup marker that makes the REAL
     * retirement's notice look like a duplicate when it arrives.
     */
    function dbWithRehomeDuringRetire(
      real: typeof db,
      sabotage: { run: () => Promise<unknown>; armed: boolean; fired: boolean },
    ) {
      const bind = (target: object, prop: string | symbol) => {
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      };
      // Run the re-home immediately before the statement executes, so the CAS reads a row
      // the reserve no longer describes. Wrapping `then` rather than the builder call is what
      // makes the ordering exact: drizzle builds lazily and executes on await.
      const deferUntilAfterSabotage = (node: object): object => new Proxy(node, {
        get(target, prop) {
          if (prop === "then") {
            return (onFulfilled?: unknown, onRejected?: unknown) =>
              sabotage.run().then(() => {
                sabotage.fired = true;
                return (target as PromiseLike<unknown>).then(
                  onFulfilled as never,
                  onRejected as never,
                );
              });
          }
          const value = bind(target, prop);
          if (prop === "where" || prop === "returning") {
            return (...args: unknown[]) =>
              deferUntilAfterSabotage((value as (...a: unknown[]) => object)(...args));
          }
          return value;
        },
      });
      return new Proxy(real, {
        get(target, prop) {
          if (prop !== "update") return bind(target, prop);
          return (table: unknown) => {
            const builder = (target.update as (t: unknown) => object)(table);
            if (table !== issueRecoveryActions) return builder;
            return new Proxy(builder, {
              get(b, p) {
                if (p !== "set") return bind(b, p);
                return (values: Record<string, unknown>) => {
                  const node = (bind(b, "set") as (v: unknown) => object)(values);
                  // Discriminate the retire+refund statement by its payload: it is the only
                  // UPDATE that writes `retiringBound` AND bumps `nonDeliverySweepCount`.
                  // `releaseWakeAttempt` bumps the sweep count without the bound;
                  // `retireWakeAction` writes the bound without the sweep count.
                  const isRetireAndRefund = values.retiringBound !== undefined
                    && values.nonDeliverySweepCount !== undefined;
                  if (!isRetireAndRefund || sabotage.armed === false) return node;
                  sabotage.armed = false;
                  return deferUntilAfterSabotage(node);
                };
              },
            });
          };
        },
      }) as typeof db;
    }

    it("does not count or announce when the retirement UPDATE matched no row", async () => {
      const seeded = await seed();
      await withManager(seeded);
      // A THIRD agent, distinct from both the owner and the manager, so the re-home below
      // cannot coincide with whatever the routing ladder picked.
      const rehomedOwnerId = randomUUID();
      await db.insert(agents).values({
        id: rehomedOwnerId,
        companyId: seeded.companyId,
        name: "Another owner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const sabotage = {
        // `armed` gates the one-shot injection; `fired` records that it actually EXECUTED,
        // which is a different claim — the statement could be built and never awaited.
        armed: true,
        fired: false,
        run: () =>
          db
            .update(issueRecoveryActions)
            .set({ ownerAgentId: rehomedOwnerId })
            .where(eq(issueRecoveryActions.sourceIssueId, seeded.sourceIssueId)),
      };

      const actionId = await dispatchOntoPastHorizon(
        dbWithRehomeDuringRetire(db, sabotage),
        seeded,
      );

      // The injection really fired, and it really re-homed the row. Without BOTH, this test
      // would pass on a no-op proxy — the strongest failure mode for a race fixture.
      expect(sabotage.fired).toBe(true);
      expect((await readAction(actionId)).ownerAgentId).toBe(rehomedOwnerId);

      // The row was NOT retired — which is the whole point. Pre-fix the gate announced a
      // retirement of a row that still reads `active` with no bound.
      const action = await readAction(actionId);
      expect(action).toMatchObject({ status: "active", retiringBound: null });

      // THE assertion. Both series flat: the dispatch announced nothing, because the UPDATE
      // it is reporting on matched no row. Before the fix, `retirementCommitted` meant only
      // "did not throw", so this same state incremented `never_delivered` — one count, into
      // the series PEN-3322's alert sums, for a retirement that never happened.
      const { body } = await renderMetrics();
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="never_delivered"} 0`);
      expect(body).toContain(`${RECOVERY_HORIZON_EXPIRED_METRIC}{delivery="delivered"} 0`);

      // Deliberately NOT asserting the absence of a horizon notice. The second consequence
      // Ally named — a notice claiming a still-`active` row moved to `escalated` — is
      // unreachable from this path in either direction, because `escalateStrandedAssignedIssue`
      // posts the identical marker earlier in the same pass and wins the dedup. So the comment
      // count is 1 whether the gate is fixed or broken, and asserting on it would be a check
      // that cannot fail for the reason it names. The metric above is the one that
      // discriminates.
    });
  });
});

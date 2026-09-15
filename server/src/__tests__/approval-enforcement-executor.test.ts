/**
 * Post-decision execution — end-to-end round trip (BLO-32796).
 *
 * The verifying signal named in the issue: seed an approved
 * `budget_override_required` card whose enforcing policy still holds the
 * pre-approval amount, confirm the BLO-24631 reconciler reports drift, apply
 * the card, then confirm the policy row holds the decided amount, the display
 * mirror agrees, a config revision exists, and a second reconciler pass is
 * silent.
 *
 * Running both halves in one test is the point rather than a convenience: the
 * executor and the detector have to agree about what "applied" means, and the
 * only way that is actually asserted is to run the detector against state the
 * executor produced. They share `extractEnforcementAssertions` and
 * `classifyEnforcementAssertion` so they cannot diverge on shape; this pins
 * that they do not diverge in behaviour either.
 *
 * Plus one negative per refusal branch, because every one of them is a
 * guardrail from the CEO ruling and an untested guardrail is a guardrail that
 * silently stops holding.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  approvals,
  budgetPolicies,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyApprovalEnforcement } from "../services/approval-enforcement-executor.ts";
import { reconcileApprovalEnforcement } from "../services/approval-enforcement-reconciler.ts";
import { budgetService } from "../services/budgets.ts";
import { HttpError } from "../errors.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval-enforcement executor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DECIDED_CENTS = 3_200_000; // $32,000 — what the board approved
const PRE_APPROVAL_CENTS = 1_900_000; // $19,000 — the un-raised cap
/** $56,000 — the CTO's live cap on 2026-09-14, raised after the card decided. */
const SUPERSEDING_CENTS = 5_600_000;

/** No cost events are seeded, so nothing is ever cancelled; collect and assert. */
function collectingHooks() {
  const cancelled: unknown[] = [];
  return {
    cancelled,
    hooks: {
      cancelWorkForScope: async (scope: unknown) => {
        cancelled.push(scope);
      },
    },
  };
}

describeEmbeddedPostgres("applyApprovalEnforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-executor-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: {
    enforcedCents: number;
    decidedCents?: number;
    /** Omit to produce a card with no recorded starting figure. */
    priorCents?: number | null;
    status?: "approved" | "pending" | "rejected" | "revision_requested";
    /** Strip the structured assertion, leaving prose only. */
    proseOnly?: boolean;
    isActive?: boolean;
    /**
     * Override `budget_policies.amount_updated_at`. Left unset the column
     * defaults to now, which is after the fixture's `decidedAt` and therefore
     * reads as a cap moved after the decision.
     */
    policyAmountUpdatedAt?: Date;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `co-${companyId.slice(0, 8)}` });

    // The requester and the target are deliberately different agents: the
    // guardrail is that an agent cannot apply a card to its OWN budget, and a
    // fixture where they coincide could not tell the guard from a no-op.
    const requesterId = randomUUID();
    await db.insert(agents).values({
      id: requesterId,
      companyId,
      name: "RequesterAgent",
      role: "engineer",
    });

    const targetId = randomUUID();
    await db.insert(agents).values({
      id: targetId,
      companyId,
      name: "TargetAgent",
      role: "engineer",
      // Disagrees with the enforcing row on purpose — if the executor ever
      // writes only this mirror, the policy assertion below fails.
      budgetMonthlyCents: 3_680_000,
    });

    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "agent",
      scopeId: targetId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: options.enforcedCents,
      isActive: options.isActive ?? true,
      ...(options.policyAmountUpdatedAt ? { amountUpdatedAt: options.policyAmountUpdatedAt } : {}),
    });

    const decidedCents = options.decidedCents ?? DECIDED_CENTS;
    const priorCents = options.priorCents === undefined ? PRE_APPROVAL_CENTS : options.priorCents;
    const payload = options.proseOnly
      ? { title: "Raise the cap", rationale: "free-form prose carrying no policy id" }
      : {
        title: "Raise the cap",
        exact_changes: [
          {
            policyId,
            agent: "TargetAgent",
            to_usd: decidedCents / 100,
            ...(priorCents === null ? {} : { from_usd: priorCents / 100 }),
          },
        ],
      };

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_override_required",
      status: options.status ?? "approved",
      requestedByAgentId: requesterId,
      payload,
      decidedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    return { companyId, requesterId, targetId, policyId, approvalId };
  }

  function requester(agentId: string) {
    return { actorType: "agent" as const, actorId: agentId, agentId, isBoard: false };
  }

  async function enforcedAmount(policyId: string) {
    const [row] = await db
      .select({ amount: budgetPolicies.amount })
      .from(budgetPolicies)
      .where(eq(budgetPolicies.id, policyId));
    return row?.amount ?? null;
  }

  async function policyRow(policyId: string) {
    const [row] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policyId));
    return row!;
  }

  async function expectRefusal(promise: Promise<unknown>, code: string, status: number) {
    await expect(promise).rejects.toThrow(HttpError);
    const error = await promise.then(
      () => null,
      (err: unknown) => err as HttpError,
    );
    expect((error?.details as { code?: string } | undefined)?.code).toBe(code);
    expect(error?.status).toBe(status);
  }

  it("closes the loop: reconciler reports drift, apply writes both objects, reconciler goes silent", async () => {
    const { companyId, requesterId, targetId, policyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
    });

    // 1. The detector sees the gap.
    const before = await reconcileApprovalEnforcement(db);
    expect(before.drifted).toBe(1);
    expect(before.raised).toBe(1);

    // 2. The requester applies the decision.
    const { cancelled, hooks } = collectingHooks();
    const result = await applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      policyId,
      scopeId: targetId,
      fromAmountCents: PRE_APPROVAL_CENTS,
      toAmountCents: DECIDED_CENTS,
    });
    expect(cancelled).toEqual([]);

    // 3a. The ENFORCING row holds the decided figure. This is the assertion
    // that matters: `pauseScopeForBudget` reads this column and nothing else.
    expect(await enforcedAmount(policyId)).toBe(DECIDED_CENTS);

    // 3b. The display mirror agrees. Writing one without the other is the
    // BLO-27626 defect in either direction.
    const [mirror] = await db
      .select({ budgetMonthlyCents: agents.budgetMonthlyCents })
      .from(agents)
      .where(eq(agents.id, targetId));
    expect(mirror?.budgetMonthlyCents).toBe(DECIDED_CENTS);

    // 3c. A config revision exists — the attribution gap BLO-20121 named. An
    // applied cap with no record of who applied it is the audit hole.
    const revisions = await db
      .select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, targetId));
    expect(revisions.length).toBeGreaterThan(0);

    // 3d. The apply is attributable on the activity log too.
    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "approval.enforcement_applied"),
        ),
      );
    expect(activity).toHaveLength(1);

    // 4. The detector and the executor agree on what "applied" means.
    await db.delete(issues);
    const after = await reconcileApprovalEnforcement(db);
    expect(after.drifted).toBe(0);
    expect(after.raised).toBe(0);
  });

  it("is idempotent: a second apply is a no-op success, not a double write", async () => {
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
    });
    const { hooks } = collectingHooks();

    const first = await applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks);
    expect(first.applied).toHaveLength(1);

    const second = await applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([policyId]);
    expect(await enforcedAmount(policyId)).toBe(DECIDED_CENTS);
  });

  it("refuses a card that is not approved", async () => {
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      status: "pending",
    });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "approval_not_approved",
      409,
    );
    expect(await enforcedAmount(policyId)).toBe(PRE_APPROVAL_CENTS);
  });

  it("refuses a caller who is not the requester", async () => {
    const { policyId, approvalId, targetId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(targetId), hooks),
      "not_requester",
      403,
    );
    expect(await enforcedAmount(policyId)).toBe(PRE_APPROVAL_CENTS);
  });

  it("refuses a payload with no exactly resolvable target", async () => {
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      proseOnly: true,
    });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "no_resolvable_assertions",
      422,
    );
    expect(await enforcedAmount(policyId)).toBe(PRE_APPROVAL_CENTS);
  });

  it("refuses to apply a card to the caller's own budget", async () => {
    // The card names the requester's own policy. Guardrail 3 of the CEO
    // ruling: self-application is out, whatever the card says.
    const { companyId, requesterId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
    });
    const [policy] = await db
      .select({ id: budgetPolicies.id })
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId));
    await db
      .update(budgetPolicies)
      .set({ scopeId: requesterId })
      .where(eq(budgetPolicies.id, policy!.id));

    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "self_budget_application",
      403,
    );
    expect(await enforcedAmount(policy!.id)).toBe(PRE_APPROVAL_CENTS);
  });

  it("refuses to revert a figure a later decision superseded", async () => {
    // The measured hazard: applying card 6f45844e verbatim on 2026-09-14 would
    // have written the CTO $56,000 -> $32,000, reverting a cap a human raised
    // after the card was decided. The enforced value is neither the card's
    // starting figure nor its decided one, AND the row was written after the
    // decision — so something newer set it.
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: SUPERSEDING_CENTS,
    });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "assertion_superseded",
      409,
    );
    expect(await enforcedAmount(policyId)).toBe(SUPERSEDING_CENTS);
  });

  it("applies a policy whose cap has not moved since the decision even when the card's recorded prior is wrong", async () => {
    // Same two-way disagreement as the test above, opposite disposition. Ally's
    // finding on #1846: `from_usd` is unvalidated payload text, so a wrong prior
    // must not be able to disguise a real enforcement gap as a supersession.
    // The cap has not moved since the decision, so there is no later decision
    // to protect — the gap is real and applying it reverts nothing.
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: SUPERSEDING_CENTS,
      policyAmountUpdatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    const { hooks } = collectingHooks();
    const result = await applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks);
    expect(result.applied).toHaveLength(1);
    expect(await enforcedAmount(policyId)).toBe(DECIDED_CENTS);
  });

  it("is not blinded by a post-decision edit that changed everything except the cap", async () => {
    // Ally's second finding on #1846, through the real write path rather than a
    // seeded timestamp. The split first shipped against
    // `budget_policies.updated_at`, and `upsertPolicy` is the single edit path
    // for warn percent, hard stop, notify and active state as well as the
    // amount — so a warn-percent toggle bumped `updated_at` past `decidedAt`
    // and a never-applied raise read as a supersession: unreported by the
    // sweep, refused here. `amount_updated_at` is stamped only when the cap
    // actually moves, so the toggle is invisible to the classifier.
    const { requesterId, policyId, approvalId, companyId, targetId } = await seed({
      enforcedCents: SUPERSEDING_CENTS,
      policyAmountUpdatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    const before = await policyRow(policyId);
    await budgetService(db).upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: targetId,
        amount: SUPERSEDING_CENTS, // unchanged — this edit is metadata only
        windowKind: "calendar_month_utc",
        warnPercent: 55,
      },
      null,
    );
    const after = await policyRow(policyId);
    expect(after.warnPercent).toBe(55);
    // The row was written — this is what used to mislead the classifier...
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // ...and the cap was not, which is the only fact the classifier reads.
    expect(after.amountUpdatedAt.getTime()).toBe(before.amountUpdatedAt.getTime());

    const { hooks } = collectingHooks();
    const result = await applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks);
    expect(result.applied).toHaveLength(1);
    expect(await enforcedAmount(policyId)).toBe(DECIDED_CENTS);

    // And a genuine cap move through the same path does stamp it, so the
    // supersession guard still has something to fire on.
    const applied = await policyRow(policyId);
    expect(applied.amountUpdatedAt.getTime()).toBeGreaterThan(before.amountUpdatedAt.getTime());
  });

  it("refuses a mismatch it cannot classify, rather than guessing", async () => {
    // No recorded starting figure, so "never applied" cannot be told from
    // "superseded". Guardrail 1: refuse, do not guess.
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: SUPERSEDING_CENTS,
      priorCents: null,
    });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "assertion_unverifiable",
      422,
    );
    expect(await enforcedAmount(policyId)).toBe(SUPERSEDING_CENTS);
  });

  it("refuses an inactive enforcing policy", async () => {
    const { requesterId, policyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      isActive: false,
    });
    const { hooks } = collectingHooks();
    await expectRefusal(
      applyApprovalEnforcement(db, approvalId, requester(requesterId), hooks),
      "policy_inactive",
      422,
    );
    expect(await enforcedAmount(policyId)).toBe(PRE_APPROVAL_CENTS);
  });

  it("lets a board actor apply a card it did not request", async () => {
    const { policyId, approvalId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });
    const { hooks } = collectingHooks();
    const result = await applyApprovalEnforcement(
      db,
      approvalId,
      { actorType: "user", actorId: "board-user", agentId: null, isBoard: true },
      hooks,
    );
    expect(result.applied).toHaveLength(1);
    expect(await enforcedAmount(policyId)).toBe(DECIDED_CENTS);
  });
});

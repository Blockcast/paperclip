/**
 * Approval-enforcement reconciler — end-to-end sweep tests (BLO-24631).
 *
 * The pure comparison layer is covered in
 * `approval-enforcement-reconciler.test.ts`, including the historical
 * `304ea443` / `6f45844e` regression fixture. This file covers the wiring the
 * pure layer cannot: that the sweep actually reads `budget_policies` (the
 * enforcing row, not the `agents.budget_monthly_cents` mirror), raises exactly
 * one deduped issue per drifted approval, respects the post-decision grace
 * window, and stays silent when decided and enforced agree.
 *
 * That silent/firing pair against a deliberately reverted policy amount in a
 * throwaway company is the verifying signal named in the issue.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
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
import {
  APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND,
  approvalCursorFrom,
  listCandidateApprovals,
  reconcileApprovalEnforcement,
  startApprovalEnforcementReconciler,
  type ApprovalEnforcementReconcilerScheduler,
} from "../services/approval-enforcement-reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval-enforcement reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DECIDED_CENTS = 3_200_000; // $32,000 — what the board approved
const PRE_APPROVAL_CENTS = 1_900_000; // $19,000 — the un-raised cap

describeEmbeddedPostgres("reconcileApprovalEnforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-enforcement-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * A throwaway company with one agent, one budget policy, and one approved
   * card asserting the policy should sit at `decidedCents`.
   */
  async function seed(options: {
    enforcedCents: number;
    decidedCents?: number;
    decidedAt?: Date;
    /** Emit the canonical shape instead of the legacy `exact_changes`. */
    declared?: boolean;
    /**
     * `companies.issue_prefix` is uniquely indexed and defaults to "PAP", so a
     * test seeding two companies must give the second one its own prefix.
     */
    issuePrefix?: string;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `co-${companyId.slice(0, 8)}`,
      ...(options.issuePrefix ? { issuePrefix: options.issuePrefix } : {}),
    });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RequesterAgent",
      role: "engineer",
      // Deliberately disagrees with the enforcing policy row. If the sweep ever
      // reads this mirror instead of budget_policies, these tests break — which
      // is the point: it read $36,800 for an agent whose enforced cap was
      // $19,000 in the original incident.
      budgetMonthlyCents: 3_680_000,
    });

    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: options.enforcedCents,
      isActive: true,
    });

    const decidedCents = options.decidedCents ?? DECIDED_CENTS;
    const assertionEntry = { policyId, to_usd: decidedCents / 100, agent: "RequesterAgent" };
    const payload = options.declared
      ? {
          title: "Raise the cap",
          enforcement_assertions: [
            {
              kind: "budget_policy_amount",
              policyId,
              expected_amount_cents: decidedCents,
              label: "RequesterAgent",
            },
          ],
        }
      : { title: "Raise the cap", exact_changes: [assertionEntry] };

    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "budget_override_required",
      status: "approved",
      requestedByAgentId: agentId,
      payload,
      decidedAt: options.decidedAt ?? new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    return { companyId, agentId, policyId, approvalId };
  }

  function driftIssuesFor(companyId: string, approvalId: string) {
    return db
      .select({ id: issues.id, title: issues.title, description: issues.description, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND),
          eq(issues.originId, approvalId),
        ),
      );
  }

  it("raises a drift issue when the enforcing policy still holds the pre-approval amount", async () => {
    const { companyId, approvalId, agentId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });

    const result = await reconcileApprovalEnforcement(db);

    expect(result.drifted).toBe(1);
    expect(result.raised).toBe(1);

    const raised = await driftIssuesFor(companyId, approvalId);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.status).toBe("todo");
    // Routed to whoever asked for the decision — they are the one who believes
    // it is resolved.
    expect(raised[0]?.assigneeAgentId).toBe(agentId);
    expect(raised[0]?.description).toContain("$32,000.00");
    expect(raised[0]?.description).toContain("$19,000.00");
    expect(raised[0]?.description).toContain("budget_policies.amount");
  });

  it("stays silent when the decided figure has actually been applied", async () => {
    const { companyId, approvalId } = await seed({ enforcedCents: DECIDED_CENTS });

    const result = await reconcileApprovalEnforcement(db);

    expect(result.withAssertions).toBe(1);
    expect(result.drifted).toBe(0);
    expect(result.raised).toBe(0);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(0);
  });

  it("fires again once an applied amount is deliberately reverted", async () => {
    // The verifying signal from BLO-24631, run as a state transition rather
    // than two independent fixtures: silent while correct, firing after revert.
    const { companyId, approvalId, policyId } = await seed({ enforcedCents: DECIDED_CENTS });

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(0);

    await db
      .update(budgetPolicies)
      .set({ amount: PRE_APPROVAL_CENTS })
      .where(eq(budgetPolicies.id, policyId));

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(1);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(1);
  });

  it("is idempotent: a second sweep reuses the open issue instead of duplicating", async () => {
    const { companyId, approvalId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });

    const first = await reconcileApprovalEnforcement(db);
    const second = await reconcileApprovalEnforcement(db);

    expect(first.raised).toBe(1);
    expect(second.drifted).toBe(1);
    expect(second.raised).toBe(0);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(1);
  });

  it("files a fresh issue if the drift recurs after the first was closed", async () => {
    const { companyId, approvalId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });
    await reconcileApprovalEnforcement(db);

    const [raised] = await driftIssuesFor(companyId, approvalId);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, raised!.id));

    // The partial unique index is scoped to the open population precisely so a
    // recurrence is not permanently suppressed by a closed issue.
    expect((await reconcileApprovalEnforcement(db)).raised).toBe(1);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(2);
  });

  it("honours the grace window for a decision that was only just approved", async () => {
    const { companyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      decidedAt: new Date(Date.now() - 30 * 60 * 1000),
    });

    // Inside the 6h default grace: "not applied yet", not drift.
    expect((await reconcileApprovalEnforcement(db)).raised).toBe(0);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(0);

    // With the grace collapsed, the same state is drift.
    expect((await reconcileApprovalEnforcement(db, { graceHours: 0 })).raised).toBe(1);
  });

  it("ignores approvals that are not approved", async () => {
    const { companyId, approvalId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });
    await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, approvalId));

    const result = await reconcileApprovalEnforcement(db);

    expect(result.scanned).toBe(0);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(0);
  });

  it("reads the enforcing policy row, not the agents budget mirror", async () => {
    // Seeded agent mirror is $36,800; enforcing policy is correct at $32,000.
    // A reconciler reading the mirror would report drift here. It must not.
    const { companyId, approvalId } = await seed({ enforcedCents: DECIDED_CENTS });

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(0);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(0);
  });

  it("treats a policy owned by another company as missing rather than reading it", async () => {
    // `approvals.payload` is free-form and agent-authored, so the policy ids in
    // it are untrusted. Here company A's card names company B's policy, and B's
    // amount happens to equal the decided figure. A lookup keyed on policy id
    // alone would read B's row, see a match, and stay silent — leaking a
    // cross-tenant amount and hiding the fact that A enforces nothing.
    const foreign = await seed({ enforcedCents: DECIDED_CENTS, issuePrefix: "FGN" });
    const { companyId, approvalId } = await seed({ enforcedCents: PRE_APPROVAL_CENTS });

    await db
      .update(approvals)
      .set({
        payload: {
          title: "Raise the cap",
          exact_changes: [
            { policyId: foreign.policyId, to_usd: DECIDED_CENTS / 100, agent: "RequesterAgent" },
          ],
        },
      })
      .where(eq(approvals.id, approvalId));

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(1);

    const [raised] = await driftIssuesFor(companyId, approvalId);
    // Pre-fix this sweep was silent (B's row matched); the fix makes the
    // foreign row unreadable, so the assertion resolves to missing_policy.
    expect(raised?.description).toContain("no budget policy with that id exists");
    // And the foreign company gains no issue of its own from company A's card.
    expect(await driftIssuesFor(foreign.companyId, approvalId)).toHaveLength(0);
  });

  it("treats an inactive enforcing policy as drift even when the amount matches", async () => {
    const { companyId, approvalId, policyId } = await seed({ enforcedCents: DECIDED_CENTS });
    await db.update(budgetPolicies).set({ isActive: false }).where(eq(budgetPolicies.id, policyId));

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(1);
    const [raised] = await driftIssuesFor(companyId, approvalId);
    expect(raised?.description).toContain("inactive");
  });

  it("scans every approval exactly once when a batch boundary falls inside a decidedAt tie", async () => {
    // The shape that motivated the reconciler is also the shape that stresses
    // pagination: a board decides a list of changes in one sitting, so every
    // resulting card shares `decided_at` to the millisecond. Six tied cards over
    // batchSize 2 puts two batch boundaries inside the tie.
    //
    // NB this asserts the end-to-end invariant, not the race. Ordering by a
    // non-unique column leaves tied rows *unspecified*, not reliably wrong, and
    // Postgres in fact returns them consistently at this size — verified by
    // re-running this test against the pre-fix OFFSET paginator, where it
    // passed. The deterministic proof is the next test down; this one guards
    // the user-visible outcome.
    const decidedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const seeded = [];
    for (let i = 0; i < 6; i += 1) {
      seeded.push(
        await seed({
          enforcedCents: PRE_APPROVAL_CENTS,
          decidedAt,
          // `companies.issue_prefix` is uniquely indexed; one per company.
          issuePrefix: `TIE${i}`,
        }),
      );
    }

    const result = await reconcileApprovalEnforcement(db, { batchSize: 2 });

    // Exactly once each: no skips (would under-count) and no revisits (would
    // over-count, since every card here drifts).
    expect(result.scanned).toBe(6);
    expect(result.drifted).toBe(6);
    expect(result.raised).toBe(6);

    // Set assertion, so a skip masked by a coincidental revisit still fails.
    for (const { companyId, approvalId } of seeded) {
      expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(1);
    }
  });

  it("does not revisit a row when the candidate set grows mid-sweep", async () => {
    // The deterministic half. OFFSET pagination is not merely unspecified under
    // ties — it is *guaranteed* wrong when a row enters the set between two
    // batches, which happens on every real sweep as cards cross the grace
    // cutoff. A row sorting above the boundary shifts every subsequent OFFSET
    // by one, so `OFFSET 2` re-returns the row already seen at index 1 and the
    // last row is never scanned at all.
    //
    // Seeking on the (decidedAt, id) the previous batch actually ended at is
    // immune: the boundary is a value, not a position, so nothing shifts it.
    const base = Date.now() - 24 * 60 * 60 * 1000;
    for (let i = 0; i < 4; i += 1) {
      // Distinct, descending timestamps — this failure needs no tie at all,
      // which is what makes it deterministic.
      await seed({
        enforcedCents: PRE_APPROVAL_CENTS,
        decidedAt: new Date(base - i * 60_000),
        issuePrefix: `SHF${i}`,
      });
    }

    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const first = await listCandidateApprovals(db, cutoff, 2, null);
    expect(first).toHaveLength(2);

    // A card decided more recently than any of the above crosses the grace
    // cutoff and joins the set, sorting to position 0 under `decidedAt DESC`.
    await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      decidedAt: new Date(base + 60_000),
      issuePrefix: "SHFN",
    });

    const second = await listCandidateApprovals(db, cutoff, 2, approvalCursorFrom(first[1]!));

    const firstIds = new Set(first.map((row) => row.id));
    const overlap = second.filter((row) => firstIds.has(row.id));
    expect(overlap).toEqual([]);

    // And it genuinely advanced rather than running dry.
    expect(second.length).toBeGreaterThan(0);
  });

  it("handles the canonical declared assertion shape end to end", async () => {
    const { companyId, approvalId } = await seed({
      enforcedCents: PRE_APPROVAL_CENTS,
      declared: true,
    });

    expect((await reconcileApprovalEnforcement(db)).raised).toBe(1);
    expect(await driftIssuesFor(companyId, approvalId)).toHaveLength(1);
  });

  it("skips prose-only approvals without touching the issue table", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "prose-only" });
    await db.insert(approvals).values({
      id: randomUUID(),
      companyId,
      type: "request_board_approval",
      status: "approved",
      payload: { title: "Please grant a permission", summary: "prose", risks: ["none"] },
      decidedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const result = await reconcileApprovalEnforcement(db);

    expect(result.scanned).toBe(1);
    expect(result.withAssertions).toBe(0);
    expect(result.raised).toBe(0);
  });
});

describe("startApprovalEnforcementReconciler", () => {
  it("runs once immediately, then on interval, dropping overlapping ticks", async () => {
    let releaseFirst: (() => void) | null = null;
    let calls = 0;
    const fakeDb = {
      select: () => {
        calls += 1;
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  offset: () =>
                    new Promise((resolve) => {
                      releaseFirst = () => resolve([]);
                    }),
                }),
              }),
            }),
          }),
        };
      },
    } as never;

    let intervalCallback: (() => void) | null = null;
    let cleared = false;
    const scheduler: ApprovalEnforcementReconcilerScheduler = {
      setInterval: (callback) => {
        intervalCallback = callback;
        return 0 as never;
      },
      clearInterval: () => {
        cleared = true;
      },
    };

    const stop = startApprovalEnforcementReconciler(fakeDb, 1000, {}, scheduler);
    expect(calls).toBe(1); // immediate kick-off

    intervalCallback?.();
    expect(calls).toBe(1); // first tick still in flight — overlap dropped

    releaseFirst?.();
    await new Promise((resolve) => setImmediate(resolve));

    intervalCallback?.();
    expect(calls).toBe(2); // in-flight cleared, next tick runs

    stop();
    expect(cleared).toBe(true);
  });
});

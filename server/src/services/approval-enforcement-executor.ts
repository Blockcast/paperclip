/**
 * Post-decision execution for approved cards (BLO-32796).
 *
 * The companion to `approval-enforcement-reconciler.ts`. That file *detects*
 * approved decisions that never reached the object enforcing them; this one
 * lets the requester close the gap without a second human touch.
 *
 * The CEO ruling that authorised it (BLO-24631, 2026-09-07) is narrow and its
 * guardrail is quoted here verbatim because every clause of it is implemented
 * below and none is negotiable:
 *
 * > such a route may write **only the exact values the approved card
 * > recorded**, only once `status = approved`, and never an agent's own budget.
 *
 * So this is not a budget-setting route that happens to check an approval. It
 * is a *replay* of a decision a board actor already made, and it can express
 * nothing else: there is no amount in the request body at all. The only inputs
 * are an approval id and the caller's identity. Every figure written comes out
 * of `payload`, parsed by the reconciler's own `extractEnforcementAssertions`
 * so the executor and the detector cannot disagree about what a card says.
 *
 * ## Why `never_applied` and nothing else
 *
 * Applying every assertion whose enforced value merely *differs* from the
 * decided one is destructive, and measurably so. On approval `6f45844e` — the
 * only card in production carrying machine-readable assertions — a verbatim
 * apply on 2026-09-14 would have written CTO $56,000 -> $32,000, Ally
 * $110,000 -> $38,000 and PlatformSREEngineer $20,000 -> $13,000: a $103,000
 * reduction of caps that humans raised *after* the card was decided, reverting
 * three board decisions in the name of executing a fourth.
 *
 * "Already applied" and "legitimately superseded" are indistinguishable to a
 * decided-vs-enforced comparison, which is why the idempotency guard the issue
 * originally specified could not have caught this: both are "enforced !=
 * decided". `classifyEnforcementAssertion` separates them using the `from_usd`
 * the card already records plus `budget_policies.amount_updated_at` — the card's field
 * alone is untrusted free-form text, so a wrong prior must not be able to make a
 * real gap read as a supersession — and this route writes only the
 * `never_applied` ones.
 *
 * With one subtraction. A cap a later decision moved *back* to the card's
 * starting figure classifies as `never_applied` too, and the detector is right
 * to say so — that decision is once again unapplied, and reporting it costs
 * nothing. Writing it reverts the later decision, so the executor takes the
 * same hazard from the other side and refuses any `never_applied` assertion
 * whose amount moved after the decision, whatever figure it landed on.
 *
 * ## Why a superseded assertion refuses the whole card
 *
 * Card `6f45844e` states the rule itself: *"ALL EIGHT OR NONE ... Applying only
 * the 4 raises grows the envelope by +$29,100 — that IS new money and is not
 * what you approved."* A reallocation approved as net-zero is not net-zero in
 * any subset. So a card with any assertion this route will not write is
 * refused whole, and the caller is told which. Completing the *unapplied
 * remainder* of a card whose other assertions already hold is not a subset —
 * it reaches the exact end state the card recorded — so that is allowed, and is
 * what makes a retry after a partial failure converge.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, budgetPolicies } from "@paperclipai/db";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { agentService } from "./agents.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import {
  classifyEnforcementAssertion,
  extractEnforcementAssertions,
  policyAmountChangedAfterDecision,
  type AssertionEnforcementState,
  type EnforcedBudgetPolicy,
} from "./approval-enforcement-reconciler.js";

/** Machine-readable refusal codes, surfaced in `HttpError.details.code`. */
export type ApplyApprovalRefusalCode =
  | "approval_not_approved"
  | "no_resolvable_assertions"
  | "not_requester"
  | "self_budget_application"
  | "assertion_superseded"
  | "assertion_unverifiable"
  | "policy_missing"
  | "policy_inactive";

export interface AppliedAssertion {
  policyId: string;
  scopeId: string;
  label: string | null;
  fromAmountCents: number;
  toAmountCents: number;
}

export interface ApplyApprovalEnforcementResult {
  approvalId: string;
  /** Assertions this call wrote. Empty on an idempotent replay. */
  applied: AppliedAssertion[];
  /** Assertions already holding the decided figure before this call. */
  alreadyApplied: string[];
}

function refuse(
  code: ApplyApprovalRefusalCode,
  message: string,
  build: (m: string, d: unknown) => Error,
  details: Record<string, unknown> = {},
): Error {
  return build(message, { code, ...details });
}

/**
 * Apply the values an approved card recorded to the rows that enforce them.
 *
 * Runs the whole classify-then-write sequence inside one transaction, and
 * re-reads `budget_policies` *inside* it. Classifying against a read taken
 * outside the transaction would be a stale-read bug of exactly the kind this
 * route exists to avoid: a concurrent cap change between the check and the
 * write would be invisible, and the executor would overwrite it having
 * classified it as `never_applied` a moment earlier.
 */
export async function applyApprovalEnforcement(
  db: Db,
  approvalId: string,
  actor: {
    actorType: "user" | "agent" | "system";
    actorId: string;
    agentId: string | null;
    isBoard: boolean;
  },
  hooks: { cancelWorkForScope: (scope: BudgetEnforcementScope) => Promise<void> },
): Promise<ApplyApprovalEnforcementResult> {
  const approval = await db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      status: approvals.status,
      payload: approvals.payload,
      decidedAt: approvals.decidedAt,
      requestedByAgentId: approvals.requestedByAgentId,
    })
    .from(approvals)
    .where(eq(approvals.id, approvalId))
    .then((rows) => rows[0] ?? null);

  if (!approval) throw unprocessable("Approval not found");

  // Guardrail 2: only once `status = approved`. Never on pending,
  // revision_requested or rejected — this route executes a decision, it is
  // never a way to make one.
  if (approval.status !== "approved") {
    throw refuse(
      "approval_not_approved",
      `Approval is \`${approval.status}\`; only an approved card can be applied`,
      conflict,
      { status: approval.status },
    );
  }

  // Guardrail: requester-scoped. Board actors retain reach, matching
  // `/approvals/:id/withdraw` and `/approvals/:id/resubmit`.
  if (!actor.isBoard && actor.agentId !== approval.requestedByAgentId) {
    throw refuse(
      "not_requester",
      "Only the requesting agent can apply this approval",
      forbidden,
    );
  }

  const assertions = extractEnforcementAssertions(approval.payload);
  if (assertions.length === 0) {
    // Guardrail 1: no recomputation, no "closest sensible figure". A card whose
    // figures are prose is not a card this route can execute, and saying so is
    // the correct outcome rather than a reason to start parsing prose.
    throw refuse(
      "no_resolvable_assertions",
      "Approval payload carries no machine-readable enforcement assertion to apply",
      unprocessable,
    );
  }

  // Guardrail 3: never an agent's own budget. Enforced per assertion inside the
  // transaction below, before classification, and against the *decided* target
  // set — so a self-application is refused even when it would have been a
  // no-op. The point is that this route can never be a path to one's own cap,
  // not merely that it cannot raise it today.
  const policyIds = assertions.map((assertion) => assertion.policyId);

  const deferredCancellations: BudgetEnforcementScope[] = [];
  const result = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const rows = await txDb
      .select({
        id: budgetPolicies.id,
        scopeType: budgetPolicies.scopeType,
        scopeId: budgetPolicies.scopeId,
        amount: budgetPolicies.amount,
        isActive: budgetPolicies.isActive,
        windowKind: budgetPolicies.windowKind,
        amountUpdatedAt: budgetPolicies.amountUpdatedAt,
      })
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, approval.companyId),
          inArray(budgetPolicies.id, [...new Set(policyIds)]),
        ),
      )
      // Under READ COMMITTED — Postgres' default, and this transaction's — an
      // unlocked read is only a snapshot: a concurrent cap write can commit
      // between classification and `upsertPolicy`, and the executor would then
      // write the decided figure over a raise it classified as absent. That is
      // the precise revert this route was built to refuse, arriving through the
      // one gap the classifier cannot see. Locking the rows makes the
      // classify-then-write pair atomic against any other writer of the same
      // policies.
      .for("update");
    const byId = new Map(rows.map((row) => [row.id, row]));

    const applied: AppliedAssertion[] = [];
    const alreadyApplied: string[] = [];
    const toWrite: Array<{ row: (typeof rows)[number]; toAmountCents: number; label: string | null }> =
      [];

    for (const assertion of assertions) {
      const row = byId.get(assertion.policyId) ?? null;
      const enforced: EnforcedBudgetPolicy | null = row
        ? {
          policyId: row.id,
          amount: row.amount,
          isActive: row.isActive,
          amountUpdatedAt: row.amountUpdatedAt,
        }
        : null;

      if (row && row.scopeType === "agent" && row.scopeId === actor.agentId) {
        throw refuse(
          "self_budget_application",
          "This approval targets the calling agent's own budget policy; self-application is not permitted",
          forbidden,
          { policyId: assertion.policyId },
        );
      }

      const state: AssertionEnforcementState = classifyEnforcementAssertion(
        assertion,
        enforced,
        approval.decidedAt,
      );
      switch (state) {
        case "applied":
          alreadyApplied.push(assertion.policyId);
          continue;
        case "never_applied": {
          // `classifyEnforcementAssertion` answers `never_applied` for
          // `enforced == prior` before it consults any timestamp, and for the
          // *detector* that is right: a cap sitting at the card's starting
          // figure is once again unapplied however it got there, and saying so
          // is non-destructive. Writing it is not. A board actor who decided
          // the raise was wrong and put the cap back lands on exactly that
          // classification, so replaying the card here would revert their
          // decision — the same "silently applying a five-day-old figure over
          // whatever a human since set" hazard the header refuses, with the
          // sign flipped. What separates a revert from a decision that never
          // landed is whether the amount moved *after* the decision, and that
          // fact is already on the locked row. So the detector keeps reporting
          // this and the executor declines to write it.
          const movedAfter = policyAmountChangedAfterDecision(
            row!.amountUpdatedAt,
            approval.decidedAt,
          );
          if (movedAfter === true) {
            throw refuse(
              "assertion_superseded",
              `Policy \`${assertion.policyId}\` enforces the card's recorded starting figure (${assertion.priorAmountCents}) but its amount was changed after this card was decided; a later decision put it there and this card must not revert that`,
              conflict,
              { policyId: assertion.policyId, enforcedAmountCents: row!.amount },
            );
          }
          if (movedAfter === null) {
            throw refuse(
              "assertion_unverifiable",
              `Policy \`${assertion.policyId}\` enforces the card's recorded starting figure, but without both the decision time and the policy's last amount-change time this cannot tell "never applied" from "reverted by a later decision"`,
              unprocessable,
              { policyId: assertion.policyId, enforcedAmountCents: row!.amount },
            );
          }
          if (row!.scopeType !== "agent" || row!.windowKind !== "calendar_month_utc") {
            // The only enforcing write implemented is the monthly agent cap.
            // Refuse rather than route a company- or project-scoped figure
            // through an agent-shaped write.
            throw refuse(
              "assertion_unverifiable",
              `Policy \`${assertion.policyId}\` is ${row!.scopeType}/${row!.windowKind}; only agent monthly caps can be applied`,
              unprocessable,
              { policyId: assertion.policyId },
            );
          }
          toWrite.push({ row: row!, toAmountCents: assertion.expectedAmountCents, label: assertion.label });
          continue;
        }
        case "superseded":
          throw refuse(
            "assertion_superseded",
            `Policy \`${assertion.policyId}\` enforces ${row!.amount} cents, which is neither the card's recorded starting figure (${assertion.priorAmountCents}) nor its decided figure (${assertion.expectedAmountCents}); a later decision moved it and this card must not revert that`,
            conflict,
            { policyId: assertion.policyId, enforcedAmountCents: row!.amount },
          );
        case "unverifiable_mismatch":
          throw refuse(
            "assertion_unverifiable",
            `Policy \`${assertion.policyId}\` disagrees with the card, and neither the card's recorded starting figure nor the policy's last amount-change time can tell "never applied" from "superseded"`,
            unprocessable,
            { policyId: assertion.policyId, enforcedAmountCents: row!.amount },
          );
        case "missing_policy":
          throw refuse(
            "policy_missing",
            `Policy \`${assertion.policyId}\` does not exist in this company`,
            unprocessable,
            { policyId: assertion.policyId },
          );
        case "inactive_policy":
          throw refuse(
            "policy_inactive",
            `Policy \`${assertion.policyId}\` is inactive and enforces nothing`,
            unprocessable,
            { policyId: assertion.policyId },
          );
      }
    }

    // Process termination is irreversible and uses the outer connection. Defer
    // it until the transaction commits, so a failed write cannot leave work
    // cancelled for a cap change that rolled back. Same reasoning, same shape,
    // as `PATCH /agents/:agentId/budgets`.
    const txAgents = agentService(txDb);
    const txBudgets = budgetService(txDb, {
      cancelWorkForScope: async (scope) => {
        deferredCancellations.push(scope);
      },
    });

    for (const { row, toAmountCents, label } of toWrite) {
      // Both objects, in this order, per BLO-27626: the mirror alone binds
      // nothing and the policy alone leaves the UI lying. `recordRevision`
      // is what closes the attribution gap BLO-20121 named — without it the
      // audit trail cannot say who applied the card.
      await txAgents.update(
        row.scopeId,
        { budgetMonthlyCents: toAmountCents },
        {
          recordRevision: {
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            source: "approval-apply",
          },
        },
      );
      const written = await txBudgets.upsertPolicy(
        approval.companyId,
        {
          scopeType: "agent",
          scopeId: row.scopeId,
          amount: toAmountCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
      // `upsertPolicy` finds its row by (company, scopeType, scopeId, metric,
      // windowKind) rather than by id, and defaults `metric` to "billed_cents".
      // A policy carrying any other metric would therefore be *inserted* as a
      // new row while the asserted one kept its old figure — and `applied`
      // would report a success that enforced nothing. `BUDGET_METRICS` has one
      // member today so this is unreachable, but the column is plain text with
      // a default and the failure mode is a silent false success on a money
      // path. Checking the id the write actually landed on costs one clause and
      // does not care which lookup column diverged.
      if (written.policyId !== row.id) {
        throw refuse(
          "assertion_unverifiable",
          `Applying policy \`${row.id}\` landed on a different row (\`${written.policyId}\`); refusing rather than reporting a success that enforced nothing`,
          unprocessable,
          { policyId: row.id, writtenPolicyId: written.policyId },
        );
      }
      applied.push({
        policyId: row.id,
        scopeId: row.scopeId,
        label,
        fromAmountCents: row.amount,
        toAmountCents,
      });
    }

    // Only when this call actually wrote something. An idempotent replay
    // changes nothing, and logging it anyway accumulates one
    // `approval.enforcement_applied` row carrying `applied: []` per retry —
    // an audit trail that records non-events is a worse audit trail.
    if (applied.length > 0) {
      await logActivity(txDb, {
        companyId: approval.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.enforcement_applied",
        entityType: "approval",
        entityId: approval.id,
        details: {
          applied: applied.map((entry) => ({
            policyId: entry.policyId,
            fromAmountCents: entry.fromAmountCents,
            toAmountCents: entry.toAmountCents,
          })),
          alreadyAppliedCount: alreadyApplied.length,
        },
      });
    }

    return { approvalId: approval.id, applied, alreadyApplied };
  });

  for (const scope of deferredCancellations) {
    await hooks.cancelWorkForScope(scope);
  }

  return result;
}

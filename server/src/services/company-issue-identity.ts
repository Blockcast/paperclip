/**
 * The one guarded write path for company issue identity
 * (`companies.issuePrefix` / `companies.issueCounter`).
 *
 * BLO-31228: these two columns define the identity of every issue in a company,
 * and the Linear OAuth callback used to overwrite both unconditionally — no
 * check for an existing prefix, no floor on the counter, no audit row. On the
 * Blockcast company that would have rewritten `BLO` -> `EGY` and moved the
 * counter BACKWARDS 31222 -> 363, re-issuing identifiers that already exist.
 *
 * BLO-31227 made team *selection* deterministic. This is the companion guard:
 * a wrong selection, from any cause, must not be destructive. The two defences
 * are independent on purpose — this one holds when the first has a bug nobody
 * has found yet.
 *
 * Two rules, enforced here and nowhere else:
 *   1. Changing a prefix that is already set requires explicit confirmation.
 *      Adopting a prefix on a company that has none is still automatic — that
 *      is the useful first-time-connection behaviour this came from.
 *   2. The counter never decreases. A lower proposed value is refused loudly
 *      and the stored value kept — unless the caller only asked to raise the
 *      floor (`raiseCounterOnly`), in which case "nothing higher" is a silent
 *      no-op. A refusal means someone tried to re-identify the company, never
 *      that an import or a reconnect had nothing new.
 *   3. A counter proposed together with a refused prefix is not applied. It was
 *      computed for the identity that was refused (another team's numbering),
 *      so raising this company's counter with it would be a partial apply of a
 *      re-identification nobody confirmed.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const ISSUE_IDENTITY_ACTIVITY_ACTION = "company.issue_identity_changed";

export interface IssueIdentityState {
  issuePrefix: string | null;
  issueCounter: number | null;
  /**
   * Has this company ever minted an identifier under the stored prefix? That,
   * not the prefix being blank, is what makes a prefix change destructive —
   * `companies.issue_prefix` is `NOT NULL DEFAULT 'PAP'`, so a company that has
   * never been touched still reads as having a prefix. Defaults to
   * `issueCounter > 0`; callers that can see the `issues` table should pass the
   * real answer, because the Linear import can leave rows behind a 0 counter.
   */
  hasMintedIdentifiers?: boolean;
}

export interface IssueIdentityRequest {
  prefix?: string | null;
  counter?: number | null;
}

export type IssueIdentityRefusal = "prefix-change-unconfirmed" | "counter-regression";

export interface IssueIdentityPlan {
  /** Prefix to write, or null to leave the stored value alone. */
  prefix: string | null;
  /** Counter floor to write, or null to leave the stored value alone. */
  counter: number | null;
  refusals: IssueIdentityRefusal[];
  changed: boolean;
}

/** Same normalisation the board's `/configure` endpoint has always applied. */
export function normalizeIssuePrefix(prefix: string | null | undefined): string | null {
  const clean = (prefix ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length > 0 ? clean : null;
}

/**
 * Decide what may be written. Pure: no db, no clock, no I/O — the whole point
 * is that the rules are checkable without standing up a company.
 */
export function planIssueIdentityChange(
  current: IssueIdentityState,
  requested: IssueIdentityRequest,
  options: { confirmPrefixChange?: boolean; raiseCounterOnly?: boolean } = {},
): IssueIdentityPlan {
  const refusals: IssueIdentityRefusal[] = [];
  const storedPrefix = normalizeIssuePrefix(current.issuePrefix);
  const storedCounter = current.issueCounter ?? 0;

  let prefix: string | null = null;
  const wantPrefix = normalizeIssuePrefix(requested.prefix);
  if (wantPrefix && wantPrefix !== storedPrefix) {
    // Nothing has been minted under the stored prefix yet, so adopting one is
    // not a re-identification — it is the first-time setup this came from.
    const inUse = storedPrefix !== null && (current.hasMintedIdentifiers ?? storedCounter > 0);
    if (!inUse || options.confirmPrefixChange) {
      prefix = wantPrefix;
    } else {
      refusals.push("prefix-change-unconfirmed");
    }
  }

  let counter: number | null = null;
  // Rule 3: the counter travels with its prefix. Refused prefix, unread counter
  // — neither a raise nor a counter-regression refusal; the audit row still
  // carries the proposed value.
  const prefixRefused = refusals.includes("prefix-change-unconfirmed");
  if (!prefixRefused && typeof requested.counter === "number" && Number.isFinite(requested.counter)) {
    // Floor before comparing, so a fractional request one notch above the
    // stored value is not reported as a change that writes nothing.
    const wantCounter = Math.floor(requested.counter);
    if (wantCounter > storedCounter) {
      counter = wantCounter;
    } else if (wantCounter < storedCounter && !options.raiseCounterOnly) {
      // Never below the stored value, whoever asks and however they got the
      // number: identifiers below it have already been handed out.
      refusals.push("counter-regression");
    }
  }

  return { prefix, counter, refusals, changed: prefix !== null || counter !== null };
}

export interface SetCompanyIssueIdentityInput extends IssueIdentityRequest {
  companyId: string;
  /**
   * Explicit operator intent to re-identify the company. Integration callbacks
   * MUST leave this false — a prefix change is never a side effect of
   * connecting or reconnecting.
   */
  confirmPrefixChange?: boolean;
  /**
   * The caller is asking "make the counter at least this", not "the counter is
   * this" (e.g. the Linear import's highest-imported-number bump). A value at
   * or below the stored counter is then a silent no-op, not a refusal.
   */
  raiseCounterOnly?: boolean;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string;
  /** Recorded in the audit row, e.g. "linear-oauth-callback". */
  reason: string;
}

export interface SetCompanyIssueIdentityResult extends IssueIdentityState {
  before: IssueIdentityState;
  refusals: IssueIdentityRefusal[];
  changed: boolean;
}

/** Apply a planned change, audit it (refusals included), return the new state. */
export async function setCompanyIssueIdentity(
  db: Db,
  input: SetCompanyIssueIdentityInput,
): Promise<SetCompanyIssueIdentityResult> {
  const [before] = await db
    .select({ issuePrefix: companies.issuePrefix, issueCounter: companies.issueCounter })
    .from(companies)
    .where(eq(companies.id, input.companyId))
    .limit(1);
  if (!before) throw new Error(`company ${input.companyId} not found`);

  // A 0 counter is not proof that nothing was minted: the Linear import's
  // "start fresh" path deliberately leaves the counter at 0 with rows in the
  // table. Ask the table.
  const [anyIssue] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.companyId, input.companyId))
    .limit(1);
  const state: IssueIdentityState = {
    ...before,
    hasMintedIdentifiers: (before.issueCounter ?? 0) > 0 || anyIssue !== undefined,
  };

  const plan = planIssueIdentityChange(state, input, {
    confirmPrefixChange: input.confirmPrefixChange,
    raiseCounterOnly: input.raiseCounterOnly,
  });

  const refusals = [...plan.refusals];
  let changed = plan.changed;
  let after: IssueIdentityState = before;
  if (plan.changed) {
    // When the plan adopts a prefix only because nothing has been minted under
    // the stored one, re-check that in the write itself, as greatest() does
    // for the counter: an identifier allocated between the probe above and
    // this UPDATE would otherwise be re-identified without confirmation. The
    // counter half is re-evaluated on the locked row, so it also holds against
    // an allocator bump that commits while this UPDATE waits on the row lock.
    const adoptsUnminted =
      plan.prefix !== null && !input.confirmPrefixChange && normalizeIssuePrefix(before.issuePrefix) !== null;
    const [updated] = await db
      .update(companies)
      .set({
        ...(plan.prefix !== null ? { issuePrefix: plan.prefix } : {}),
        // greatest() rather than the planned literal: the identifier allocator
        // can bump the counter between the read above and this write, and the
        // floor must hold against that race too.
        ...(plan.counter !== null
          ? { issueCounter: sql`greatest(${companies.issueCounter}, ${plan.counter})` }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(companies.id, input.companyId),
          adoptsUnminted
            ? sql`${companies.issueCounter} <= 0 and not exists (select 1 from ${issues} where ${issues.companyId} = ${input.companyId})`
            : undefined,
        ),
      )
      .returning({ issuePrefix: companies.issuePrefix, issueCounter: companies.issueCounter });
    if (updated) {
      after = updated;
    } else if (adoptsUnminted) {
      // Lost that race: the company now has identifiers, so this is the
      // unconfirmed re-identification rule 1 refuses — and, per rule 3, the
      // counter that came with it is not applied either.
      refusals.push("prefix-change-unconfirmed");
      changed = false;
      const [current] = await db
        .select({ issuePrefix: companies.issuePrefix, issueCounter: companies.issueCounter })
        .from(companies)
        .where(eq(companies.id, input.companyId))
        .limit(1);
      after = current ?? before;
    }
  }

  for (const refusal of refusals) {
    console.error(
      `[issue-identity] REFUSED ${refusal} for company ${input.companyId} (${input.reason}): ` +
        `stored prefix=${before.issuePrefix} counter=${before.issueCounter}, ` +
        `proposed prefix=${input.prefix ?? "-"} counter=${input.counter ?? "-"}`,
    );
  }

  if (changed || refusals.length > 0) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? "system",
      action: ISSUE_IDENTITY_ACTIVITY_ACTION,
      entityType: "company",
      entityId: input.companyId,
      details: {
        reason: input.reason,
        from: { issuePrefix: before.issuePrefix, issueCounter: before.issueCounter },
        to: { issuePrefix: after.issuePrefix, issueCounter: after.issueCounter },
        proposed: { issuePrefix: input.prefix ?? null, issueCounter: input.counter ?? null },
        confirmPrefixChange: input.confirmPrefixChange === true,
        refusals,
      },
    });
  }

  return { ...after, before, refusals, changed };
}

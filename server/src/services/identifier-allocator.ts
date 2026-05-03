// Identifier allocator — central choice point for who mints a new issue's
// identifier. Task 2.1 of the Linear ↔ Paperclip ID Unification plan
// (onprem-k8s commit 9979d0d / .planning/linear-id-unification.md).
//
// Today: every company gets the paperclip-internal `${issuePrefix}-${counter}`
// path, which is the existing behaviour pulled verbatim out of
// services/issues.ts so it's testable and so the linear branch has a place
// to land in Task 2.2 without re-touching the issue creation tx.
//
// The function deliberately accepts a transaction-or-db handle (Drizzle's
// `tx` shares the `Db` shape during `db.transaction(...)`) because the
// paperclip path's counter increment must run inside the same tx as the
// `issues` insert — otherwise two concurrent creators race on
// `issue_counter` and produce a duplicate identifier despite the
// self-correcting `greatest(issueCounter, currentMax) + 1`.
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, issues } from "@paperclipai/db";

// Structural subset of `Db` that the allocator actually uses. Same pattern
// as `GoalReader` in services/goals.ts — accepts either the root client or
// an active tx (Drizzle's tx handle structurally satisfies this Pick).
type IdentifierAllocatorDb = Pick<Db, "select" | "update">;

export interface AllocateIdentifierInput {
  /** Drizzle handle. Pass the active transaction when called from inside one. */
  db: IdentifierAllocatorDb;
  companyId: string;
  /** Title is plumbed through for the Linear path (Task 2.2) which posts it
   *  to Linear's IssueCreate mutation. The paperclip path ignores it. */
  title: string;
  description?: string | null;
}

export interface AllocateIdentifierResult {
  /** The minted identifier (e.g. "BLO-2667" or "PCL-12"). */
  identifier: string;
  /** Bookkeeping: the integer suffix, used to populate issues.issueNumber. */
  issueNumber: number;
  /** Which provider issued the identifier. Determines downstream link rows. */
  source: "paperclip" | "linear";
  /** Linear-side issue id, when source === "linear". */
  externalIssueId?: string;
}

export async function allocateIdentifier(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  const company = await db
    .select({ provider: companies.identifierProvider })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0]);

  if (company?.provider === "linear") {
    return allocateFromLinear(input);
  }
  return allocateFromPaperclip(input);
}

// Pulled verbatim from services/issues.ts (the previous inline block).
// Kept transactional: the caller MUST pass the active tx as `input.db` when
// inside an issue-creation transaction, otherwise concurrent creators race
// on `companies.issue_counter`.
async function allocateFromPaperclip(
  input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  const { db, companyId } = input;

  // Self-correcting counter: use MAX(issue_number) + 1 if the counter has
  // drifted below the actual max. Defends against historical data imports
  // that leave issueCounter stale relative to the issues table.
  const [maxRow] = await db
    .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
    .from(issues)
    .where(eq(issues.companyId, companyId));
  const currentMax = maxRow?.maxNum ?? 0;

  const [company] = await db
    .update(companies)
    .set({
      issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
    })
    .where(eq(companies.id, companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

  const issueNumber = company.issueCounter;
  const identifier = `${company.issuePrefix}-${issueNumber}`;

  return { identifier, issueNumber, source: "paperclip" };
}

// Stub. Task 2.2 fills this in: GraphQL IssueCreate against Linear, then
// returns Linear's identifier + id. The plan-vs-reality gap (the original
// plan referenced a `linear_issue_links` table that doesn't exist; actual
// schema is `plugin_entities` rows owned by paperclip-plugin-linear) means
// the link-table side of Task 2.2 still needs design clarification before
// it can be wired through.
async function allocateFromLinear(
  _input: AllocateIdentifierInput,
): Promise<AllocateIdentifierResult> {
  throw new Error(
    "Linear identifier allocator not implemented (Task 2.2 of linear-id-unification plan)",
  );
}

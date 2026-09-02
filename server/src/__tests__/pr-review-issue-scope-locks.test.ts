/**
 * `lockPrReviewIssueScopes` acquires its PR-scope advisory locks
 * all-or-nothing, and gives up on a bounded budget rather than blocking issue
 * creation. This suite pins what happens to the locks it already holds when it
 * gives up, and what happens to the caller's transaction when the lock
 * statement itself fails.
 *
 * Both are invisible from the create's own result — a create that strands half
 * a lock pair still returns 201 — so neither is covered by the route tests.
 * The stranded-lock failure surfaces only as reviewer wakes that never fire
 * for that PR, on the webhook side, minutes later.
 *
 * PostgreSQL's side of the contract (a savepoint rollback releases advisory
 * xact locks taken inside it) is pinned separately, against a real server, in
 * packages/db/src/advisory-xact-lock-savepoint.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  lockPrReviewIssueScopes,
  type DuplicatePrReviewIssueCandidate,
} from "../services/pr-review-duplicate-issue-guard.js";

const REVIEWER_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OPTIONS = { reviewerAgentIds: [REVIEWER_AGENT_ID] } as const;

const ONE_PR: DuplicatePrReviewIssueCandidate = {
  companyId: "22222222-2222-4222-8222-222222222222",
  assigneeAgentId: REVIEWER_AGENT_ID,
  prReviewTarget: { repoFullName: "blockcast/pim-multicast-gateway", prNumber: 2447 },
};

// Two PRs so a partial acquisition is reachable: the guard sorts its keys and
// takes them in order, so a fake that grants only the first leaves exactly one
// key held at give-up time.
const TWO_PRS: DuplicatePrReviewIssueCandidate = {
  ...ONE_PR,
  description: [
    "https://github.com/blockcast/pim-multicast-gateway/pull/2447",
    "https://github.com/blockcast/pim-multicast-gateway/pull/2448",
  ].join("\n"),
};

type Statement = "savepoint" | "rollback" | "release" | "lock" | "other";

/**
 * The guard only ever calls `execute`, but drizzle's real return type
 * (`PgRaw<RowList<...>>`) is a class instance that cannot be constructed in a
 * test. Cast the fake at the boundary, as the repo's other transaction fakes
 * do — narrowly, so a signature change to the guard still surfaces here.
 */
type GuardTx = Parameters<typeof lockPrReviewIssueScopes>[0];

/** Order matters: "rollback to savepoint" also contains "savepoint". */
function classify(sqlText: string): Statement {
  if (sqlText.includes("rollback to savepoint")) return "rollback";
  if (sqlText.includes("release savepoint")) return "release";
  if (sqlText.includes("savepoint")) return "savepoint";
  if (sqlText.includes("pg_try_advisory_xact_lock")) return "lock";
  return "other";
}

/**
 * @param grant decides each lock attempt: `true` acquires, `false` reports
 *   contention, an `Error` is thrown from `execute` the way a reset connection
 *   or a `statement_timeout` would throw.
 */
function fakeDb(grant: (taskKey: string, attempt: number) => boolean | Error) {
  const kinds: Statement[] = [];
  const lockedKeys: string[] = [];
  let attempts = 0;
  return {
    kinds,
    lockedKeys,
    execute: async (query: unknown) => {
      // Same serialization the repo's other advisory-lock fakes use: drizzle
      // exposes the template's literal chunks and bound params on queryChunks.
      const text = JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? query);
      const kind = classify(text);
      kinds.push(kind);
      if (kind !== "lock") return [];
      const taskKey = text.match(/pr_review:[^"\\]*/)?.[0];
      expect(taskKey, `advisory lock issued without a pr_review-scoped key: ${text}`).toBeTruthy();
      const outcome = grant(taskKey as string, attempts++);
      if (outcome instanceof Error) throw outcome;
      if (outcome) lockedKeys.push(taskKey as string);
      return [{ acquired: outcome }];
    },
  };
}

describe("lockPrReviewIssueScopes", () => {
  it("hands its locks to the caller's transaction when it acquires them all", async () => {
    const db = fakeDb(() => true);

    await lockPrReviewIssueScopes(db as unknown as GuardTx, ONE_PR, OPTIONS);

    expect(db.kinds).toEqual(["savepoint", "lock", "release"]);
    // Releasing (not rolling back) is what keeps the locks held until the issue
    // row is durable. A rollback here would silently disable serialization on
    // the success path.
    expect(db.kinds).not.toContain("rollback");
  });

  it("releases every key it holds when it gives up", async () => {
    // The failure this prevents: the guard parks one half of the pair the
    // webhook acquires all-or-nothing, so the webhook can never complete its
    // set for the rest of the create transaction and every reviewer wake for
    // that PR starves — while this side has already stopped serializing.
    const granted = new Set<string>();
    const db = fakeDb((taskKey) => {
      if (granted.size === 0) {
        granted.add(taskKey);
        return true;
      }
      return granted.has(taskKey);
    });

    await lockPrReviewIssueScopes(db as unknown as GuardTx, TWO_PRS, OPTIONS);

    expect(db.lockedKeys.length).toBeGreaterThan(0);
    expect(db.kinds[0]).toBe("savepoint");
    expect(db.kinds.at(-1)).toBe("rollback");
    // A release would COMMIT the partial set into the caller's transaction —
    // the exact stranding above.
    expect(db.kinds).not.toContain("release");
  }, 15_000);

  it("does not abort the caller's transaction when the lock statement throws", async () => {
    // pg_try_advisory_xact_lock never errors; the STATEMENT does — a reset
    // connection, a statement_timeout, or the role losing EXECUTE on
    // hashtextextended. An uncaught throw here aborts the issue-create
    // transaction and 500s a create that should have proceeded unserialized.
    const db = fakeDb(() => new Error("connection reset by peer"));

    await expect(lockPrReviewIssueScopes(db as unknown as GuardTx, ONE_PR, OPTIONS)).resolves.toBeUndefined();

    expect(db.kinds).toContain("lock");
    expect(db.kinds.at(-1)).toBe("rollback");
  }, 15_000);

  it("takes no lock at all when the assignee is not a configured PR reviewer", async () => {
    // Discriminator for the three tests above: they only prove something about
    // the lock protocol if the guard is reachable for some candidates and not
    // others. A fake that logged statements no matter what would pass them all.
    const db = fakeDb(() => true);

    await lockPrReviewIssueScopes(db as unknown as GuardTx, ONE_PR, { reviewerAgentIds: ["someone-else"] });

    expect(db.kinds).toEqual([]);
  });
});

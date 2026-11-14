/**
 * Stacked-PR base-merge fan-out (BLO-29856).
 *
 * A base-branch merge is an event on a DIFFERENT PR, so an open PR stacked on
 * top of it receives no webhook, fails no check, and gets no comment — it just
 * quietly stops being buildable while continuing to look healthy. #1439 sat
 * orphaned three days after #1415 merged.
 *
 * These pin the two decisions that make the resulting wake correct rather than
 * merely present:
 *
 *  1. The directive must tell a child to REBASE after a rewriting merge and must
 *     not tell it to retarget. "Just click retarget" is the trap — after a
 *     rebase- or squash-merge the base's commits land under new SHAs, so a bare
 *     retarget replays the base PR's whole diff into the child.
 *  2. An unreadable GitHub enumeration must not read as "no stacked children".
 *     Coercing a failed read to an empty list reproduces the exact silence the
 *     fan-out exists to break, one layer up and harder to see.
 */
import { describe, expect, it } from "vitest";
import {
  MERGED_PR_FOR_HEAD_REF_PAGE_SIZE,
  parseMergedPullRequestForHeadRef,
  parseMergeHistoryShape,
  parseOpenPullRequestsOnBasePayload,
  type GraphQlPullRequestPage,
  type GraphQlPullRequestSummary,
} from "../services/github-app-auth.js";
import { __test_stackedChildDirective } from "../routes/github-webhook.js";

describe("parseMergeHistoryShape", () => {
  it("reads two parents as a true merge commit (original SHAs preserved)", () => {
    expect(parseMergeHistoryShape({ parents: [{ sha: "a" }, { sha: "b" }] })).toBe("merge_commit");
  });

  it("reads one parent as rewritten — squash and rebase are deliberately not told apart", () => {
    // Both land the base's work under NEW SHAs, which is the only distinction
    // that changes what a stacked child has to do.
    expect(parseMergeHistoryShape({ parents: [{ sha: "a" }] })).toBe("rewritten");
  });

  it("returns unknown rather than guessing when parents are absent or malformed", () => {
    // Guessing here would guess toward "merge_commit" and recommend the bare
    // retarget that is the whole trap. Unknown is the safe answer.
    expect(parseMergeHistoryShape(null)).toBe("unknown");
    expect(parseMergeHistoryShape({})).toBe("unknown");
    expect(parseMergeHistoryShape({ parents: "two" })).toBe("unknown");
    expect(parseMergeHistoryShape({ parents: {} })).toBe("unknown");
  });
});

/**
 * PEN-6341 item 2: these parsers now read ONE `repository.pullRequests` page
 * off the shared GraphQL reader instead of a REST array body. The fixtures are
 * built GraphQL-shaped rather than translated — a double left in the old
 * transport's shape would make every assertion a tautology about its own
 * fixture rather than a test of the reader.
 */
const prSummary = (
  over: Partial<GraphQlPullRequestSummary> & { number: number },
): GraphQlPullRequestSummary => ({
  title: null,
  url: null,
  isDraft: false,
  createdAt: null,
  state: null,
  mergedAt: null,
  headRefName: null,
  headRefOid: null,
  // Defaults to OUR owner so each test states only what it is about; the
  // fork-qualification tests below override it deliberately.
  headRepositoryOwnerLogin: "Blockcast",
  mergeCommitSha: null,
  authorLogin: null,
  ...over,
});

const prPage = (
  pullRequests: GraphQlPullRequestSummary[],
  over: Partial<Extract<GraphQlPullRequestPage, { ok: true }>> = {},
): GraphQlPullRequestPage => ({
  ok: true,
  pullRequests,
  malformed: 0,
  hasNextPage: false,
  endCursor: null,
  ...over,
});

describe("parseOpenPullRequestsOnBasePayload", () => {
  it("parses open PRs and carries each head ref", () => {
    const result = parseOpenPullRequestsOnBasePayload(prPage([
      prSummary({
        number: 1439,
        title: "child",
        url: "https://example.test/1439",
        headRefName: "se/child",
      }),
    ]));
    expect(result).toEqual({
      pullRequests: [
        { number: 1439, title: "child", url: "https://example.test/1439", headRef: "se/child" },
      ],
      truncated: false,
    });
  });

  it("fails closed on an unreadable page instead of reporting zero children", () => {
    // The dangerous direction: an empty list is indistinguishable from "this
    // branch had no stacked children", and silently means nobody is woken.
    expect(parseOpenPullRequestsOnBasePayload({ ok: false, reason: "payload_malformed" }))
      .toEqual({ error: "open_pull_requests_malformed" });
    expect(parseOpenPullRequestsOnBasePayload({ ok: false, reason: "repository_absent" }))
      .toEqual({ error: "open_pull_requests_repository_absent" });
  });

  it("keeps the REST reader's spelling for the two reasons it had its own words for", () => {
    // `transport` was the REST catch-all for a thrown fetch, and a non-array
    // body was `_malformed`. Both strings are already recorded in the
    // stacked-PR warn diagnostics, so the transport change must not re-spell
    // them. A mutation that drops the mapping reds exactly this.
    expect(parseOpenPullRequestsOnBasePayload({ ok: false, reason: "transport" }))
      .toEqual({ error: "open_pull_requests_fetch_failed" });
    expect(parseOpenPullRequestsOnBasePayload({ ok: false, reason: "http_403" }))
      .toEqual({ error: "open_pull_requests_http_403" });
  });

  it("reports a further page as truncated so a prefix is never read as the whole set", () => {
    expect(parseOpenPullRequestsOnBasePayload(prPage([prSummary({ number: 7 })], {
      hasNextPage: true,
      endCursor: "cursor",
    }))).toMatchObject({ truncated: true });
  });

  it("does NOT call a provably-whole page truncated, however full it is", () => {
    // PEN-6341: the REST reader inferred truncation from "the page came back
    // full", so a chain of exactly OPEN_PRS_ON_BASE_PAGE_SIZE children was
    // reported as possibly-incomplete when it was provably whole.
    // `pageInfo.hasNextPage` is exact. This is the assertion that would fail if
    // the page-size heuristic were ever reinstated.
    const full = Array.from({ length: 100 }, (_, i) => prSummary({ number: i + 1 }));
    expect(parseOpenPullRequestsOnBasePayload(prPage(full))).toMatchObject({ truncated: false });
  });
});

describe("stackedChildDirective", () => {
  it("tells a child to rebase, and NOT to retarget, after a rewriting merge", () => {
    const directive = __test_stackedChildDirective("rewritten");
    expect(directive).toMatch(/rebase/i);
    expect(directive).toMatch(/do not simply retarget/i);
    // The failure this guards: a directive that reads as "retarget is enough".
    expect(directive).not.toMatch(/retargeting this pr .* is sufficient/i);
  });

  it("tells a child a bare retarget is sufficient after a true merge commit", () => {
    const directive = __test_stackedChildDirective("merge_commit");
    expect(directive).toMatch(/retarget/i);
    expect(directive).toMatch(/no rebase is required/i);
  });

  it("refuses to recommend a bare retarget when the merge method is unknown", () => {
    const directive = __test_stackedChildDirective("unknown");
    expect(directive).toMatch(/verify before retargeting/i);
    expect(directive).not.toMatch(/no rebase is required/i);
  });

  it("gives rewriting and merge-commit merges materially different advice", () => {
    // Collapsing the switch to one string is the mutation this catches.
    expect(__test_stackedChildDirective("rewritten")).not.toBe(
      __test_stackedChildDirective("merge_commit"),
    );
  });
});

/**
 * Old-base resolution for the auto-retarget wake (BLO-36775).
 *
 * `pull_request.edited` names the CHILD, so the merge whose shape decides
 * retarget-vs-rebase is not in the delivery. This is how it is recovered, and
 * its three outcomes are not interchangeable: `none` is the precision gate that
 * keeps a hand-retarget from paging anyone, and `error` must stay distinct from
 * it for the same reason the enumeration keeps them apart.
 */
describe("parseMergedPullRequestForHeadRef", () => {
  const OWNER = "Blockcast";

  it("returns the merged PR and its merge commit", () => {
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 2027, mergedAt: "2026-09-26T09:00:00Z", mergeCommitSha: "cafebabe" }),
    ]), OWNER)).toEqual({ outcome: "found", prNumber: 2027, mergeCommitSha: "cafebabe" });
  });

  it("ignores an entry with no merge instant — an abandoned base orphaned nothing", () => {
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 2027, mergedAt: null }),
    ]), OWNER)).toEqual({ outcome: "none" });
  });

  it("takes the most recently merged PR, not the response order", () => {
    // The page is ordered CREATED_AT descending, and a PR opened earlier can
    // merge later. Ordering on `mergedAt` is the fix.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 10, mergedAt: "2026-01-01T00:00:00Z", mergeCommitSha: "old" }),
      prSummary({ number: 20, mergedAt: "2026-09-01T00:00:00Z", mergeCommitSha: "new" }),
      prSummary({ number: 15, mergedAt: "2026-05-01T00:00:00Z", mergeCommitSha: "mid" }),
    ]), OWNER)).toEqual({ outcome: "found", prNumber: 20, mergeCommitSha: "new" });
  });

  it("reports an empty page as none, not as an error", () => {
    // A branch can be deleted, or retargeted by hand, without ever merging.
    // Both fire the same event and neither is a stacked orphaning.
    expect(parseMergedPullRequestForHeadRef(prPage([]), OWNER)).toEqual({ outcome: "none" });
  });

  it("ignores a FORK's pull request that merely shares the head branch name", () => {
    // PEN-6341 item 2, and the reason this parser takes an owner at all. REST
    // qualified its filter as `?head=owner:ref`; GraphQL's `headRefName` takes
    // the BARE branch name, so a fork carrying `se/child` matches too. Taking
    // its merge commit would wake our child with a SHA from someone else's
    // repository — and every other field on the node looks perfectly valid.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({
        number: 99,
        mergedAt: "2026-09-26T09:00:00Z",
        mergeCommitSha: "fork-sha",
        headRepositoryOwnerLogin: "someone-else",
      }),
    ]), OWNER)).toEqual({ outcome: "none" });
  });

  it("prefers OUR newer merge over a fork's, rather than merely preferring the newest", () => {
    // The mutation this catches is dropping the owner filter: without it the
    // fork's later merge wins on `mergedAt` alone.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({
        number: 42,
        mergedAt: "2026-09-01T00:00:00Z",
        mergeCommitSha: "ours",
        headRepositoryOwnerLogin: "Blockcast",
      }),
      prSummary({
        number: 99,
        mergedAt: "2026-09-26T09:00:00Z",
        mergeCommitSha: "theirs",
        headRepositoryOwnerLogin: "someone-else",
      }),
    ]), OWNER)).toEqual({ outcome: "found", prNumber: 42, mergeCommitSha: "ours" });
  });

  it("matches the owner case-insensitively, as GitHub treats it", () => {
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({
        number: 7,
        mergedAt: "2026-09-26T09:00:00Z",
        mergeCommitSha: "keep",
        headRepositoryOwnerLogin: "blockcast",
      }),
    ]), "BLOCKCAST")).toEqual({ outcome: "found", prNumber: 7, mergeCommitSha: "keep" });
  });

  it("ignores an entry whose head owner is unreadable rather than assuming it is ours", () => {
    // A head repository we cannot name cannot be confirmed to be ours, and
    // REST's `owner:ref` filter would not have returned it either.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({
        number: 8,
        mergedAt: "2026-09-26T09:00:00Z",
        mergeCommitSha: "x",
        headRepositoryOwnerLogin: null,
      }),
    ]), OWNER)).toEqual({ outcome: "none" });
  });

  it("treats a further page as unreadable, never as none or as a prefix's merge", () => {
    // Only one page is fetched, so the merge that triggered the retarget may be
    // on the next one. Neither `none` (suppresses the wake) nor the prefix's
    // newest merge (possibly the wrong base, so the wrong directive) is safe.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 99, mergedAt: "2026-09-26T09:00:00Z", mergeCommitSha: "prefix" }),
    ], { hasNextPage: true, endCursor: "cursor" }), OWNER))
      .toEqual({ outcome: "error", reason: "merged_pull_request_truncated" });
  });

  it("does NOT call a provably-whole page truncated, however full it is", () => {
    // PEN-6341: the REST reader inferred truncation from a full page, and
    // closed-but-UNMERGED PRs consumed those slots — a recycled branch name
    // reached the cap on abandoned PRs alone and suppressed the wake.
    // `states: [MERGED]` filters them out server-side and `hasNextPage` is
    // exact, so this page of the old cap size is readable.
    const full = Array.from({ length: MERGED_PR_FOR_HEAD_REF_PAGE_SIZE }, (_, i) =>
      prSummary({ number: i + 1, mergedAt: "2026-01-01T00:00:00Z", mergeCommitSha: "s" }));
    expect(parseMergedPullRequestForHeadRef(prPage(full), OWNER))
      .toMatchObject({ outcome: "found" });
  });

  it("fails closed on an unreadable page instead of reporting none", () => {
    // The dangerous collapse: `none` means "nothing merged this branch", which
    // suppresses the wake. An unreadable answer must never say that.
    expect(parseMergedPullRequestForHeadRef({ ok: false, reason: "payload_malformed" }, OWNER))
      .toEqual({ outcome: "error", reason: "merged_pull_request_malformed" });
    expect(parseMergedPullRequestForHeadRef({ ok: false, reason: "transport" }, OWNER))
      .toEqual({ outcome: "error", reason: "merged_pull_request_fetch_failed" });
    expect(parseMergedPullRequestForHeadRef({ ok: false, reason: "http_502" }, OWNER))
      .toEqual({ outcome: "error", reason: "merged_pull_request_http_502" });
  });

  it("skips an entry with an unusable timestamp without dropping the rest", () => {
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 31, mergedAt: "not-a-date" }),
      prSummary({ number: 42, mergedAt: "2026-09-26T09:00:00Z", mergeCommitSha: "keep" }),
    ]), OWNER)).toEqual({ outcome: "found", prNumber: 42, mergeCommitSha: "keep" });
  });

  it("returns found with a null merge commit rather than dropping the PR", () => {
    // The caller turns this into `unknown`, which refuses to recommend a bare
    // retarget. Dropping the PR instead would suppress the wake entirely.
    expect(parseMergedPullRequestForHeadRef(prPage([
      prSummary({ number: 2027, mergedAt: "2026-09-26T09:00:00Z", mergeCommitSha: null }),
    ]), OWNER)).toEqual({ outcome: "found", prNumber: 2027, mergeCommitSha: null });
  });
});

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

describe("parseOpenPullRequestsOnBasePayload", () => {
  it("parses open PRs and carries each head ref", () => {
    const result = parseOpenPullRequestsOnBasePayload([
      { number: 1439, title: "child", html_url: "https://example.test/1439", head: { ref: "se/child" } },
    ]);
    expect(result).toEqual({
      pullRequests: [
        { number: 1439, title: "child", url: "https://example.test/1439", headRef: "se/child" },
      ],
      truncated: false,
    });
  });

  it("fails closed on a non-array body instead of reporting zero children", () => {
    // The dangerous direction: an empty list is indistinguishable from "this
    // branch had no stacked children", and silently means nobody is woken.
    for (const body of [null, undefined, {}, "[]", 0]) {
      expect(parseOpenPullRequestsOnBasePayload(body)).toEqual({
        error: "open_pull_requests_malformed",
      });
    }
  });

  it("skips entries with no usable number without dropping the rest", () => {
    const result = parseOpenPullRequestsOnBasePayload([
      { number: "nope" },
      { number: 7, head: { ref: "keep" } },
    ]);
    expect(result).toEqual({
      pullRequests: [{ number: 7, title: null, url: null, headRef: "keep" }],
      truncated: false,
    });
  });

  it("flags a full page as truncated so a prefix is never read as the whole set", () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
    const result = parseOpenPullRequestsOnBasePayload(full);
    expect(result).toMatchObject({ truncated: true });
    expect(parseOpenPullRequestsOnBasePayload(full.slice(0, 99))).toMatchObject({
      truncated: false,
    });
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
  it("returns the merged PR and its merge commit", () => {
    expect(parseMergedPullRequestForHeadRef([
      { number: 2027, merged_at: "2026-09-26T09:00:00Z", merge_commit_sha: "cafebabe" },
    ])).toEqual({ outcome: "found", prNumber: 2027, mergeCommitSha: "cafebabe" });
  });

  it("ignores closed-but-unmerged PRs — an abandoned base orphaned nothing", () => {
    expect(parseMergedPullRequestForHeadRef([
      { number: 2027, merged_at: null, merge_commit_sha: null },
    ])).toEqual({ outcome: "none" });
  });

  it("takes the most recently merged PR, not the response order", () => {
    // GitHub sorts this list by `created` descending, and a PR opened earlier
    // can merge later. Ordering on `merged_at` is the fix.
    expect(parseMergedPullRequestForHeadRef([
      { number: 10, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "old" },
      { number: 20, merged_at: "2026-09-01T00:00:00Z", merge_commit_sha: "new" },
      { number: 15, merged_at: "2026-05-01T00:00:00Z", merge_commit_sha: "mid" },
    ])).toEqual({ outcome: "found", prNumber: 20, mergeCommitSha: "new" });
  });

  it("reports an empty list as none, not as an error", () => {
    // A branch can be deleted, or retargeted by hand, without ever merging.
    // Both fire the same event and neither is a stacked orphaning.
    expect(parseMergedPullRequestForHeadRef([])).toEqual({ outcome: "none" });
  });

  it("treats a full page as unreadable, never as none or as a prefix's merge", () => {
    // Only one page is fetched, so the merge that triggered the retarget may be
    // on page 2. Neither `none` (suppresses the wake) nor the prefix's newest
    // merge (possibly the wrong base, so the wrong directive) is a safe answer.
    // Sized off the exported constant so the guard and the fetcher's `per_page`
    // cannot drift apart from this assertion.
    const closedUnmerged = Array.from(
      { length: MERGED_PR_FOR_HEAD_REF_PAGE_SIZE - 1 },
      (_, i) => ({ number: i + 1, merged_at: null }),
    );
    expect(parseMergedPullRequestForHeadRef([...closedUnmerged, { number: 99, merged_at: null }]))
      .toEqual({ outcome: "error", reason: "merged_pull_request_truncated" });
    expect(parseMergedPullRequestForHeadRef([
      ...closedUnmerged,
      { number: 99, merged_at: "2026-09-26T09:00:00Z", merge_commit_sha: "prefix" },
    ])).toEqual({ outcome: "error", reason: "merged_pull_request_truncated" });
    // One short of the page is still the whole answer.
    expect(parseMergedPullRequestForHeadRef(closedUnmerged)).toEqual({ outcome: "none" });
  });

  it("fails closed on an unreadable body instead of reporting none", () => {
    // The dangerous collapse: `none` means "nothing merged this branch", which
    // suppresses the wake. An unreadable answer must never say that.
    for (const body of [null, undefined, {}, "[]", 0]) {
      expect(parseMergedPullRequestForHeadRef(body)).toEqual({
        outcome: "error",
        reason: "merged_pull_request_malformed",
      });
    }
  });

  it("skips entries with an unusable number or timestamp without dropping the rest", () => {
    expect(parseMergedPullRequestForHeadRef([
      { number: "nope", merged_at: "2026-09-26T09:00:00Z" },
      { number: 31, merged_at: "not-a-date" },
      { number: 42, merged_at: "2026-09-26T09:00:00Z", merge_commit_sha: "keep" },
    ])).toEqual({ outcome: "found", prNumber: 42, mergeCommitSha: "keep" });
  });

  it("returns found with a null merge commit rather than dropping the PR", () => {
    // The caller turns this into `unknown`, which refuses to recommend a bare
    // retarget. Dropping the PR instead would suppress the wake entirely.
    expect(parseMergedPullRequestForHeadRef([
      { number: 2027, merged_at: "2026-09-26T09:00:00Z", merge_commit_sha: 42 },
    ])).toEqual({ outcome: "found", prNumber: 2027, mergeCommitSha: null });
  });
});

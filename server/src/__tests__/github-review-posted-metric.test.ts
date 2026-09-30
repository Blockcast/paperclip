/**
 * BLO-27608: the review-OUTPUT counter.
 *
 * Ally was silently down fleet-wide for ~8.6h on 2026-08-12 and nothing paged,
 * because all three existing review metrics are request-side and read
 * `received 131 / queued 131 / suppressed 0` straight through the blackout. The
 * runs were enqueued and dispatched; they died at the model call and produced
 * no artifact. These tests pin the two properties that close that gap:
 * `paperclip_github_review_posted_total` counts only reviews that were actually
 * published (by the reviewer identity, on either surface), and
 * `paperclip_github_review_completion_total` separates a deliberate skip from a
 * failure so intentional-skip volume cannot mask a drought.
 */
import { describe, expect, it } from "vitest";
import {
  GITHUB_REVIEW_COMPLETION_METRIC,
  GITHUB_REVIEW_POSTED_METRIC,
  recordGithubReviewCompletion,
  recordGithubReviewPosted,
  renderMetrics,
} from "../services/metrics.js";
import { __test_resolvePostedReviewObservation } from "../routes/github-webhook.js";

const REVIEWER_LOGIN = "allyblockcast[bot]";
const ALLY_REVIEW_BODY = [
  "## Ally — Consolidated PR Review",
  "",
  "Reviewed head: " + "a".repeat(40),
  "",
  "No blocking findings.",
].join("\n");

/**
 * Read one counter series' value out of the rendered exposition. Returns 0 for
 * an absent series so callers can assert deltas uniformly, but note the
 * zero-init test below deliberately distinguishes absent from zero — that is the
 * whole point of the drought alert being able to fire.
 */
function counterValue(body: string, metric: string, labels: Record<string, string>): number {
  for (const line of body.split("\n")) {
    if (!line.startsWith(metric + "{")) continue;
    const matchesAll = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (!matchesAll) continue;
    const value = Number(line.slice(line.lastIndexOf("}") + 1).trim());
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function hasSeries(body: string, metric: string): boolean {
  return body.split("\n").some((line) => line.startsWith(metric + "{"));
}

function formalReviewPayload(overrides: {
  reviewerLogin?: string;
  action?: string;
  repo?: string;
} = {}): Record<string, unknown> {
  return {
    action: overrides.action ?? "submitted",
    repository: { full_name: overrides.repo ?? "Blockcast/paperclip" },
    pull_request: { number: 937 },
    review: {
      id: 4885879976,
      state: "commented",
      body: ALLY_REVIEW_BODY,
      user: { login: overrides.reviewerLogin ?? REVIEWER_LOGIN, type: "Bot" },
    },
  };
}

function commentReviewPayload(overrides: {
  authorLogin?: string;
  action?: string;
  body?: string;
  isPullRequest?: boolean;
  repo?: string;
} = {}): Record<string, unknown> {
  const issue: Record<string, unknown> = { number: 952 };
  if (overrides.isPullRequest !== false) {
    issue.pull_request = { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/952" };
  }
  return {
    action: overrides.action ?? "created",
    repository: { full_name: overrides.repo ?? "Blockcast/paperclip" },
    issue,
    comment: {
      id: 123456,
      body: overrides.body ?? ALLY_REVIEW_BODY,
      user: { login: overrides.authorLogin ?? REVIEWER_LOGIN, type: "Bot" },
    },
  };
}

describe("resolvePostedReviewObservation — which deliveries count as published review output", () => {
  it("counts a formal pull_request_review.submitted from the reviewer identity", () => {
    const observed = __test_resolvePostedReviewObservation(
      "pull_request_review",
      formalReviewPayload(),
      REVIEWER_LOGIN,
    );
    expect(observed).toEqual({
      repoFullName: "Blockcast/paperclip",
      prNumber: 937,
      surface: "formal",
    });
  });

  it("counts a comment-shaped review carrying the consolidated heading", () => {
    // The surface that most needs its own observation point: a CLEAN
    // comment-shaped review is neither a review request nor actionable feedback,
    // so resolveEventContext returns null for it and every pre-existing counter
    // is blind to it. Measured on Blockcast/paperclip#952: 4 comment-shaped
    // reviews, 0 formal.
    const observed = __test_resolvePostedReviewObservation(
      "issue_comment",
      commentReviewPayload(),
      REVIEWER_LOGIN,
    );
    expect(observed).toEqual({
      repoFullName: "Blockcast/paperclip",
      prNumber: 952,
      surface: "comment",
    });
  });

  it("does NOT count a human's review — a human must not hold the drought alert down", () => {
    // The alert is a bare sum with no label selector, so any series a non-Ally
    // reviewer can feed would let one human review during an Ally blackout mask
    // the outage entirely.
    expect(
      __test_resolvePostedReviewObservation(
        "pull_request_review",
        formalReviewPayload({ reviewerLogin: "kkroo" }),
        REVIEWER_LOGIN,
      ),
    ).toBeNull();
    expect(
      __test_resolvePostedReviewObservation(
        "issue_comment",
        commentReviewPayload({ authorLogin: "kkroo" }),
        REVIEWER_LOGIN,
      ),
    ).toBeNull();
  });

  it("does NOT count the control plane's own back-link comment", () => {
    // githubPostIssueComment posts this under the SAME App login as Ally, so
    // author identity alone cannot separate it from review output. The
    // consolidated heading is what does.
    expect(
      __test_resolvePostedReviewObservation(
        "issue_comment",
        commentReviewPayload({ body: "🔗 Paperclip issue: [BLO-27608](https://example.test)" }),
        REVIEWER_LOGIN,
      ),
    ).toBeNull();
  });

  it("does NOT count an agent's review REQUEST that quotes a heading (BLO-21618)", () => {
    // A marker-prefixed request may legitimately quote a heading-shaped line
    // while asking for a fresh pass. Counting it would invent review output that
    // was never published.
    const body = [
      "<!-- paperclip:review-request -->",
      "@ally please re-review; the previous pass was:",
      "",
      "## Ally — Consolidated PR Review",
    ].join("\n");
    expect(
      __test_resolvePostedReviewObservation(
        "issue_comment",
        commentReviewPayload({ body }),
        REVIEWER_LOGIN,
      ),
    ).toBeNull();
  });

  it("does NOT count a comment on a plain issue (issue_comment fires for both)", () => {
    expect(
      __test_resolvePostedReviewObservation(
        "issue_comment",
        commentReviewPayload({ isPullRequest: false }),
        REVIEWER_LOGIN,
      ),
    ).toBeNull();
  });

  it("does NOT re-count an edited/dismissed review or a deleted comment", () => {
    // Only the action that PUBLISHES a review counts; mutating one that already
    // landed must not increment it a second time.
    for (const action of ["edited", "dismissed"]) {
      expect(
        __test_resolvePostedReviewObservation(
          "pull_request_review",
          formalReviewPayload({ action }),
          REVIEWER_LOGIN,
        ),
      ).toBeNull();
    }
    for (const action of ["edited", "deleted"]) {
      expect(
        __test_resolvePostedReviewObservation(
          "issue_comment",
          commentReviewPayload({ action }),
          REVIEWER_LOGIN,
        ),
      ).toBeNull();
    }
  });

  it("ignores events that carry no review at all", () => {
    expect(
      __test_resolvePostedReviewObservation("workflow_run", formalReviewPayload(), REVIEWER_LOGIN),
    ).toBeNull();
    expect(
      __test_resolvePostedReviewObservation("pull_request", formalReviewPayload(), REVIEWER_LOGIN),
    ).toBeNull();
  });
});

describe("paperclip_github_review_posted_total", () => {
  it("is present at zero before any review is posted, so the drought alert can fire", async () => {
    // Load-bearing, not cosmetic. PaperclipGithubReviewOutputDrought keys on
    // `sum(increase(paperclip_github_review_posted_total[2h])) == 0`. An ABSENT
    // series makes that inner expression an empty vector, the `and` yields
    // nothing, and the alert stays silent — during exactly the outage it exists
    // to catch. Absent and zero render the same and mean the opposite.
    const { body } = await renderMetrics();
    expect(hasSeries(body, GITHUB_REVIEW_POSTED_METRIC)).toBe(true);
  });

  it("increments per surface, labelled by repo", async () => {
    const before = (await renderMetrics()).body;
    const formalBefore = counterValue(before, GITHUB_REVIEW_POSTED_METRIC, {
      repo: "Blockcast/paperclip",
      surface: "formal",
    });
    const commentBefore = counterValue(before, GITHUB_REVIEW_POSTED_METRIC, {
      repo: "Blockcast/paperclip",
      surface: "comment",
    });

    expect(recordGithubReviewPosted({ repo: "Blockcast/paperclip", surface: "formal" })).toEqual({
      repo: "Blockcast/paperclip",
      surface: "formal",
    });
    recordGithubReviewPosted({ repo: "Blockcast/paperclip", surface: "comment" });

    const after = (await renderMetrics()).body;
    expect(
      counterValue(after, GITHUB_REVIEW_POSTED_METRIC, {
        repo: "Blockcast/paperclip",
        surface: "formal",
      }),
    ).toBe(formalBefore + 1);
    expect(
      counterValue(after, GITHUB_REVIEW_POSTED_METRIC, {
        repo: "Blockcast/paperclip",
        surface: "comment",
      }),
    ).toBe(commentBefore + 1);
  });

  it("keeps repos on separate series so a drought can be scoped to one repo", async () => {
    recordGithubReviewPosted({ repo: "Blockcast/trafficcontrol", surface: "formal" });
    const { body } = await renderMetrics();
    expect(
      counterValue(body, GITHUB_REVIEW_POSTED_METRIC, {
        repo: "Blockcast/trafficcontrol",
        surface: "formal",
      }),
    ).toBeGreaterThan(0);
  });

  it("normalizes a missing repo rather than emitting an empty label", () => {
    expect(recordGithubReviewPosted({ repo: null, surface: "formal" }).repo).toBe("unknown");
    expect(recordGithubReviewPosted({ repo: "   ", surface: "formal" }).repo).toBe("unknown");
  });
});

describe("paperclip_github_review_completion_total", () => {
  it("separates a deliberate skip from a failure to produce output", async () => {
    // Without this split a quiet period of legitimate self-review declines is
    // indistinguishable from Ally being dead, and the skip volume masks the
    // drought.
    const before = (await renderMetrics()).body;
    const skipBefore = counterValue(before, GITHUB_REVIEW_COMPLETION_METRIC, {
      status: "self_review_skipped",
    });
    const missingBefore = counterValue(before, GITHUB_REVIEW_COMPLETION_METRIC, {
      status: "missing",
    });

    expect(recordGithubReviewCompletion("self_review_skipped")).toBe("self_review_skipped");
    expect(recordGithubReviewCompletion("missing")).toBe("missing");

    const after = (await renderMetrics()).body;
    expect(
      counterValue(after, GITHUB_REVIEW_COMPLETION_METRIC, { status: "self_review_skipped" }),
    ).toBe(skipBefore + 1);
    expect(counterValue(after, GITHUB_REVIEW_COMPLETION_METRIC, { status: "missing" })).toBe(
      missingBefore + 1,
    );
  });

  it("drops not_applicable — a non-reviewer run is not a review outcome", async () => {
    const before = (await renderMetrics()).body;
    const otherBefore = counterValue(before, GITHUB_REVIEW_COMPLETION_METRIC, { status: "other" });

    expect(recordGithubReviewCompletion("not_applicable")).toBeNull();

    const after = (await renderMetrics()).body;
    expect(counterValue(after, GITHUB_REVIEW_COMPLETION_METRIC, { status: "other" })).toBe(
      otherBefore,
    );
  });

  it("collapses an unrecognized verdict to 'other' instead of inflating cardinality", () => {
    expect(recordGithubReviewCompletion("a_verdict_added_later")).toBe("other");
    expect(recordGithubReviewCompletion(null)).toBe("other");
  });

  it("exposes every known verdict at zero from process start", async () => {
    const { body } = await renderMetrics();
    for (const status of [
      "posted_review",
      "already_reviewed",
      "self_review_skipped",
      "archived_repo_skipped",
      "auth_expired",
      "missing",
    ]) {
      expect(
        body.includes(`${GITHUB_REVIEW_COMPLETION_METRIC}{status="${status}"}`),
      ).toBe(true);
    }
  });
});

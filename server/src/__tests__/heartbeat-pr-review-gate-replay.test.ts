import { describe, expect, it } from "vitest";
import {
  PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS,
  evaluatePrReviewCompletionEvidence,
  selectAgedPrReviewRunForFairDispatch,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";
import {
  __test_buildPrReviewerTaskKey,
  __test_buildPrReviewerWakeIdempotencyKey,
  __test_resolveEventContext,
  __test_shouldFirePrReviewerWake,
} from "../routes/github-webhook.js";

// BLO-17518: integration/replay test for the full BLO-17456 incident chain —
// GitHub webhook events -> Paperclip heartbeat wake dispatch -> Ally posting a
// review -> pim-multicast-gateway's `review-gate` GitHub Action reading that
// review and setting the `review/ally-complete` commit status. Existing
// coverage (heartbeat-retry-scheduling.test.ts, heartbeat-pr-review-queue-
// fairness.test.ts, and pim-multicast-gateway's own
// test/require-ally-review-script.test.ts) is unit-level per component; this
// file replays the exact failure sequence observed on PR
// Blockcast/pim-multicast-gateway#1656 end to end: a review posted on an old
// head, a fix pushed to a new head, a fresh review-request event, a backlog of
// unrelated review wakes ahead of it, a run that leaves no durable evidence,
// and the exact new-head review that finally flips the gate green.
//
// The dispatch/evidence half calls the real exported heartbeat.ts functions
// (shouldScheduleAutomaticRunRetry, evaluatePrReviewCompletionEvidence,
// selectAgedPrReviewRunForFairDispatch) directly, so a revert of either the
// durable-evidence-retry fix (PR #767, `pr_review_output_missing` added to the
// retry allowlist) or the dispatch-fairness fix (`selectAgedPrReviewRunForFair
// Dispatch`) breaks this file's assertions, not just the narrower unit tests.

// Fixture port of Blockcast/pim-multicast-gateway's exact-head review gate
// (scripts/require-ally-review.mjs @ 12a0f903ec6f396150e0991f09eb96c767ca9f20,
// the `review-gate` GitHub Action that sets the `review/ally-complete` commit
// status). Ported rather than imported because pim-multicast-gateway is a
// separate repo/package (BLO-17518 AC: "fixturing ... rather than requiring a
// live GitHub API") — only the pure head-attestation matching is reproduced,
// with no network fetch or event parsing. That repo's own
// test/require-ally-review-script.test.ts remains the authoritative unit
// coverage for the real script; if the source diverges, update this fixture
// to match.
const ALLY_LOGIN = "allyblockcast";
const REPO = "Blockcast/pim-multicast-gateway";
const PR_NUMBER = 1656;
// Real head SHAs from the BLO-17456 incident this test replays.
const OLD_HEAD = "a24708eac27007d4de3280e37b2a887467025146";
const NEW_HEAD = "0cbd6523c2d308e581295b4bf217d8c0b77d5679";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REVIEWED_HEAD_PATTERN =
  /^\s*(?:[_*]+)?\s*Reviewed head:\s*`?([0-9a-f]{40})`?\s*(?:[_*]+)?\s*$/gm;
const REVIEWED_HEAD_MENTION_PATTERN = /reviewed head\s*:/gi;

function extractReviewedHeadSha(body: string | null | undefined) {
  const text = String(body ?? "");
  const matches = [...text.matchAll(REVIEWED_HEAD_PATTERN)];
  const mentions = [...text.matchAll(REVIEWED_HEAD_MENTION_PATTERN)];
  if (matches.length !== 1 || mentions.length !== 1) return null;
  return matches[0][1].toLowerCase();
}

function bodyAttestsToHead(body: string | null | undefined, headSha: string) {
  return FULL_SHA_PATTERN.test(headSha) && extractReviewedHeadSha(body) === headSha.toLowerCase();
}

type FixtureReview = {
  id: number;
  commit_id: string;
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED";
  submitted_at: string;
  user: { login: string; type: "User" | "Bot" };
};

function reviewAttestsToHead(review: FixtureReview | null, headSha: string) {
  return bodyAttestsToHead(review?.body, headSha);
}

function latestAllyReview(reviews: FixtureReview[]) {
  return (
    reviews
      .filter((review) => review?.user?.login === ALLY_LOGIN)
      .sort((left, right) => {
        const byTime = String(right?.submitted_at ?? "").localeCompare(String(left?.submitted_at ?? ""));
        return byTime || Number(right?.id ?? 0) - Number(left?.id ?? 0);
      })[0] ?? null
  );
}

function reviewSignalForHead(reviews: FixtureReview[], headSha: string) {
  const review = latestAllyReview(reviews);
  if (!review) return { state: "pending" as const, description: `Waiting for Ally approval of head ${headSha.slice(0, 7)}.` };
  if (review.user?.type !== "User") return { state: "pending" as const, description: "Ally review identity is not a REST User." };
  if (!reviewAttestsToHead(review, headSha)) {
    return { state: "pending" as const, description: `Latest Ally review does not attest head ${headSha.slice(0, 7)}.` };
  }
  if (review.state === "CHANGES_REQUESTED") return { state: "failure" as const, description: "Ally requested changes." };
  if (review.state === "DISMISSED") return { state: "failure" as const, description: "Ally approval was dismissed." };
  if (review.state !== "APPROVED") return { state: "pending" as const, description: "Waiting for formal Ally approval." };
  return { state: "success" as const, description: `Ally formally approved exact head ${headSha.slice(0, 7)}.` };
}

function allyReview(opts: {
  id: number;
  headSha: string;
  submittedAt: string;
  commitId?: string;
  state?: FixtureReview["state"];
}): FixtureReview {
  return {
    id: opts.id,
    commit_id: opts.commitId ?? opts.headSha,
    body: `Reviewed head: \`${opts.headSha}\`\n\nLGTM, no findings.`,
    state: opts.state ?? "APPROVED",
    submitted_at: opts.submittedAt,
    user: { login: ALLY_LOGIN, type: "User" },
  };
}

function freshHeadWebhookContext() {
  const context = __test_resolveEventContext("pull_request", {
    action: "synchronize",
    pull_request: {
      number: PR_NUMBER,
      title: "fix(review-gate): retry exact-head Ally review (BLO-17456)",
      body: "Closes BLO-17456",
      html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      head: { ref: "fix/BLO-17456-exact-head-review", sha: NEW_HEAD },
      user: { login: "contributor" },
    },
    repository: { full_name: REPO },
  });
  if (!__test_shouldFirePrReviewerWake(context)) {
    throw new Error("expected fresh-head pull_request.synchronize to drive reviewer wake");
  }
  const taskKey = __test_buildPrReviewerTaskKey(context);
  return {
    routeContext: context,
    taskKey,
    contextSnapshot: {
      taskKey,
      wakeReason: context.wakeReason,
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      githubEvent: "pull_request",
      githubDeliveryId: "delivery-fresh-head",
      githubPrNumber: context.prNumber,
      githubRepoFullName: context.repoFullName,
      githubPrTitle: context.prTitle,
      githubPrUrl: context.prUrl,
      githubEventUrl: context.eventUrl,
      githubHeadSha: context.headSha,
      githubPrAuthorLogin: context.prAuthorLogin,
      githubPaperclipIdentifiers: context.identifiers,
      reviewKind: "pr_review" as const,
      prRole: "reviewer" as const,
    },
  };
}

describe("BLO-17518: Ally exact-head re-review replay (old head -> fix push -> re-request -> new head -> gate success)", () => {
  const baseContext = {
    reviewKind: "pr_review" as const,
    prRole: "reviewer" as const,
    githubRepoFullName: REPO,
    githubPrNumber: PR_NUMBER,
    wakeReason: "github_pr_review_requested",
  };

  it("step 1-2: the initial review attests the old head, and a same-head recheck (no push yet) stays satisfied", () => {
    const oldHeadContext = { ...baseContext, githubHeadSha: OLD_HEAD };
    const evidence = evaluatePrReviewCompletionEvidence(oldHeadContext, {
      summary: `Posted the consolidated Ally review on \`${REPO}#${PR_NUMBER}\` for head ${OLD_HEAD}.`,
    });
    expect(evidence).toEqual({ status: "posted_review" });

    const oldReview = allyReview({ id: 1, headSha: OLD_HEAD, submittedAt: "2026-07-21T08:14:00.000Z" });
    expect(reviewSignalForHead([oldReview], OLD_HEAD)).toMatchObject({ state: "success" });
  });

  it("step 3: fixes pushed to a new head — the stale old-head review does NOT satisfy the gate", () => {
    const oldReview = allyReview({ id: 1, headSha: OLD_HEAD, submittedAt: "2026-07-21T08:14:00.000Z" });
    expect(reviewSignalForHead([oldReview], NEW_HEAD)).toMatchObject({ state: "pending" });
  });

  it("step 3b: GitHub webhook normalization preserves the fresh head and PR-scoped reviewer queue keys", () => {
    const { routeContext, taskKey, contextSnapshot } = freshHeadWebhookContext();
    expect(routeContext).toMatchObject({
      identifiers: ["BLO-17456"],
      wakeReason: "github_pr_synchronized",
      prNumber: PR_NUMBER,
      repoFullName: REPO,
      headSha: NEW_HEAD,
    });
    expect(taskKey).toBe(`pr_review:${REPO}:${PR_NUMBER}`);
    expect(__test_buildPrReviewerWakeIdempotencyKey(routeContext, "delivery-fresh-head")).toBe(
      `pr_review:${REPO}:${PR_NUMBER}:github_pr_synchronized`,
    );
    expect(contextSnapshot).toMatchObject({
      taskKey: `pr_review:${REPO}:${PR_NUMBER}`,
      wakeReason: "github_pr_synchronized",
      githubHeadSha: NEW_HEAD,
      reviewKind: "pr_review",
      prRole: "reviewer",
    });
  });

  it("step 4: a run against the fresh new-head review-request that leaves no durable evidence is retry-eligible, not stranded (BLO-17456 AC2 / PR #767)", () => {
    const { contextSnapshot: freshHeadContext } = freshHeadWebhookContext();
    const missingEvidence = evaluatePrReviewCompletionEvidence(freshHeadContext, {
      summary: `Fetching PR metadata and diff for head ${NEW_HEAD.slice(0, 7)}; investigating findings.`,
    });
    expect(missingEvidence).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });

    // This is the exact assertion PR #767 fixed: before it, pr_review_output_missing
    // was terminal (not on the retry allowlist), stranding the exact-head gate.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: missingEvidence.errorCode,
        resultJson: {},
        contextSnapshot: freshHeadContext,
      }),
    ).toBe(true);

    // Also true for the trimmed, taskKey-only webhook snapshot form.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: { taskKey: freshHeadContext.taskKey },
      }),
    ).toBe(true);
  });

  it("step 4b: the retry does not get starved behind a backlog of unrelated review wakes (dispatch-fairness)", () => {
    const now = new Date("2026-07-21T08:40:00.000Z");
    const agedBeyondCutoff = PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS + 60_000;

    const freshRetryRun = {
      id: "retry-of-fresh-head-review",
      // Queued at the fresh review-request event (08:27:55Z in the incident);
      // by 08:40:00Z it has aged past the fairness cutoff.
      createdAt: new Date(now.getTime() - agedBeyondCutoff),
      contextSnapshot: { taskKey: `pr_review:${REPO}:${PR_NUMBER}`, githubHeadSha: NEW_HEAD },
    };
    // A burst of unrelated pr_review wakes across other repos, queued ahead of
    // (i.e. older than, ordered by createdAt) the fresh, merge-blocking one is
    // not required for FIFO to explain the incident — the incident was that
    // Ally's concurrency cap is 1, so *any* queued unrelated review, regardless
    // of relative age, blocks the fresh one until fairness promotes it.
    const unrelatedBacklog = [
      { id: "unrelated-review-1", createdAt: new Date(now.getTime() - 5 * 60_000), contextSnapshot: { taskKey: "pr_review:Blockcast/onprem-k8s:42" } },
      { id: "unrelated-review-2", createdAt: new Date(now.getTime() - 2 * 60_000), contextSnapshot: { taskKey: "pr_review:Blockcast/hindsight:7" } },
    ];
    const queue = [freshRetryRun, ...unrelatedBacklog];

    // While the last-started run was itself a pr_review, fairness must not
    // promote a second one consecutively (the exact-head fix landing does not
    // get to monopolize the reviewer ahead of ordinary priority).
    expect(
      selectAgedPrReviewRunForFairDispatch(queue, { contextSnapshot: { reviewKind: "pr_review" } }, now),
    ).toBeNull();

    // Once the last-started run was issue work (not a review), the fairness
    // fix promotes the OLDEST aged review — the fresh, merge-blocking one —
    // ahead of the fresher unrelated backlog entries, instead of leaving it to
    // rot behind FIFO/priority ordering indefinitely.
    expect(
      selectAgedPrReviewRunForFairDispatch(queue, { contextSnapshot: { issueId: "unrelated-issue-work" } }, now),
    ).toBe(freshRetryRun.id);
  });

  it("step 5-6: the exact new-head review lands and flips review/ally-complete to success", () => {
    const freshHeadContext = { ...baseContext, githubHeadSha: NEW_HEAD };
    const newEvidence = evaluatePrReviewCompletionEvidence(freshHeadContext, {
      summary: `Posted the consolidated Ally review on \`${REPO}#${PR_NUMBER}\` for head ${NEW_HEAD}.`,
    });
    expect(newEvidence).toEqual({ status: "posted_review" });

    const oldReview = allyReview({ id: 1, headSha: OLD_HEAD, submittedAt: "2026-07-21T08:14:00.000Z" });
    const newReview = allyReview({ id: 2, headSha: NEW_HEAD, submittedAt: "2026-07-21T09:06:25.000Z" });
    const rewrittenCommitIdReview = allyReview({
      id: 3,
      headSha: NEW_HEAD,
      commitId: OLD_HEAD,
      submittedAt: "2026-07-21T09:07:00.000Z",
    });

    // Full review history (old + new) evaluated against the current head:
    // the latest, exact-head review resolves the gate success.
    expect(reviewSignalForHead([oldReview, newReview], NEW_HEAD)).toMatchObject({ state: "success" });
    // GitHub may rewrite REST `review.commit_id` after an Update branch action;
    // the immutable explicit body attestation is what the gate should trust.
    expect(reviewSignalForHead([rewrittenCommitIdReview], NEW_HEAD)).toMatchObject({ state: "success" });

    // The gate is exact-head, not "any approval ever": re-checking the OLD
    // head against the same history must not also read as success (there is
    // no live PR at the old head anymore, but the invariant — approval is
    // scoped to one head — must hold for whichever head is asked about).
    expect(reviewSignalForHead([oldReview, newReview], OLD_HEAD)).toMatchObject({ state: "pending" });
  });
});

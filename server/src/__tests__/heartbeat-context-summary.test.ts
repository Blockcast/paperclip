import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  derivePaperclipPrReview,
  triggeredMonitorForPrompt,
  evaluatePrReviewCompletionEvidence,
  mergeCoalescedContextSnapshot,
  prReviewAlreadyReviewedVetoCue,
  prReviewOutputHasAlreadyReviewedSkip,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";
import {
  recoveryRunWriteClassNotice,
  REFUSED_APPROVAL_OPERATIONS,
  STATUS_ONLY_RESUME_PREAMBLE,
  withRecoveryModelProfileHint,
} from "../services/recovery/model-profile-hint.js";

// PEN-3275: the notice is derived from a real producer snapshot rather than named by class, so
// these tests exercise the same path the wake does. The status-only lane has TWO reachable texts,
// differing only in whether the snapshot carries a `sourceIssueId` — the escalation clause is
// conditional on it. Both are fixtures here; the branch-selection logic itself is asserted in
// `model-profile-hint.test.ts`, and what these add is that each text survives the markdown frame.
const STATUS_ONLY_SNAPSHOT = withRecoveryModelProfileHint(
  { issueId: "issue-1", sourceIssueId: "issue-1" },
  "status_only",
);
const STATUS_ONLY_NO_SOURCE_SNAPSHOT = withRecoveryModelProfileHint(
  { issueId: "issue-1", sourceIssueId: null },
  "status_only",
);
const PLANNING_ONLY_SNAPSHOT = withRecoveryModelProfileHint({ issueId: "issue-1" }, "planning_only");
const STATUS_ONLY_NOTICE = recoveryRunWriteClassNotice(STATUS_ONLY_SNAPSHOT);
const STATUS_ONLY_NO_SOURCE_NOTICE = recoveryRunWriteClassNotice(STATUS_ONLY_NO_SOURCE_SNAPSHOT);
const PLANNING_ONLY_NOTICE = recoveryRunWriteClassNotice(PLANNING_ONLY_SNAPSHOT);

describe("buildPaperclipTaskMarkdown", () => {
  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("renders a GitHub PR review directive for github_pr_* wakeups", () => {
    const prReviewMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_opened",
        prNumber: 35,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        deliveryId: "abc-123",
        reviewKind: "pr_review",
      },
    });

    expect(prReviewMarkdown).toContain('- PR: "Blockcast/paperclip#35"');
    expect(prReviewMarkdown).toContain('- Wake reason: "github_pr_opened"');
    expect(prReviewMarkdown).toContain("GitHub PR review directive:");
    expect(prReviewMarkdown).toContain("Follow your AGENTS.md PR-review workflow");
    expect(prReviewMarkdown).toContain("Do not short-circuit to an inbox check");
    // Author-shaped directive must NOT leak into the legacy reviewer path
    // (BLO-6300: same prompt was being injected for both wake recipients).
    expect(prReviewMarkdown).not.toContain("GitHub PR review feedback directive:");
  });

  it("explicit prRole='reviewer' uses the same reviewer directive as the legacy path", () => {
    const reviewerMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_opened",
        prNumber: 35,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        prRole: "reviewer",
        requestCommentBody: "@ally re-review requested after the fix.",
        requestCommentAuthorLogin: "kkroo",
      },
    });
    expect(reviewerMarkdown).toContain("GitHub PR review directive:");
    expect(reviewerMarkdown).toContain("Follow your AGENTS.md PR-review workflow");
    expect(reviewerMarkdown).toContain("kkroo requested this review:");
    expect(reviewerMarkdown).toContain("@ally re-review requested after the fix.");
    expect(reviewerMarkdown).not.toContain("GitHub PR review feedback directive:");
  });

  it("renders an author-facing directive when prRole === 'author' on a review-submitted wake", () => {
    // BLO-6300: the assignee wake fired by pull_request_review.submitted
    // used to inject the reviewer-shaped "review this PR" directive into
    // the PR author's prompt. Now the author gets a directive that maps
    // to what they're supposed to do: read findings + push a follow-up.
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "BLO-5269",
        title: "Aggregator",
        workMode: null,
        description: null,
      },
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 953,
        repoFullName: "Blockcast/magma",
        prTitle: "Aggregator",
        prUrl: "https://github.com/Blockcast/magma/pull/953",
        eventUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-123",
        headSha: "abc123",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        reviewState: "commented",
        reviewAuthorLogin: "ally",
      },
    });

    // Reviewer directive must not leak through.
    expect(authorMarkdown).not.toContain("GitHub PR review directive:");
    expect(authorMarkdown).not.toContain("Follow your AGENTS.md PR-review workflow");
    // Author directive header + reviewer attribution.
    expect(authorMarkdown).toContain("GitHub PR review feedback directive:");
    expect(authorMarkdown).toContain("ally just submitted a review on YOUR pull request (state: COMMENTED).");
    expect(authorMarkdown).toContain('- PR URL: "https://github.com/Blockcast/magma/pull/953"');
    expect(authorMarkdown).toContain('- GitHub event URL: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-123"');
    expect(authorMarkdown).toContain('- Head SHA at wake time: "abc123"');
    expect(authorMarkdown).toContain("may be superseded");
    // Review body fence-block injected inline so the author doesn't need
    // to shell out to `gh pr view` just to read the findings.
    expect(authorMarkdown).toContain("Latest review body:");
    expect(authorMarkdown).toContain("Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.");
    // Closing instructions: push follow-up / reply / don't self-approve.
    expect(authorMarkdown).toContain("push a follow-up commit");
    expect(authorMarkdown).toContain("Do NOT close the PR or self-approve");
  });

  // BLO-19067: the closing instruction was unconditional, so an APPROVED
  // review woke the author telling them to "push a follow-up commit". There is
  // nothing to address on an approved PR, and the resulting no-op push
  // invalidates the approval and restarts CI.
  it("tells an APPROVED-review author not to push a follow-up commit", () => {
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 591,
        repoFullName: "Blockcast/Network-Operator-Portal",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Looks good. No Critical or Important issues found.",
        reviewState: "approved",
        reviewAuthorLogin: "allyblockcast",
      },
    });
    expect(authorMarkdown).toContain(
      "allyblockcast just submitted a review on YOUR pull request (state: APPROVED).",
    );
    expect(authorMarkdown).toContain("It APPROVED your PR, so no implementation pass is required");
    expect(authorMarkdown).not.toContain("push a follow-up commit");
    expect(authorMarkdown).not.toContain("If the findings are correct");
    // The non-state-specific guardrails must survive the branch.
    expect(authorMarkdown).toContain("Do NOT close the PR or self-approve");
  });

  // BLO-19522: `prRole: "author"` is set for EVERY github_pr_* wake, and on a
  // review-REQUEST wake reviewState/reviewBody/reviewAuthorLogin are all null
  // (isActionableReviewFeedbackContext is false for review_requested). The
  // author branch therefore fell through to the null-state feedback directive
  // and told the author a reviewer had posted findings, on a PR with no review
  // at all — then instructed them to push a follow-up commit addressing them.
  // Observed three times across three repos; the action it steers toward is
  // re-requesting the review, which re-posts the marker and re-fires this wake.
  it("does not claim findings exist when the author wake is a review REQUEST", () => {
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_requested",
        prNumber: 604,
        repoFullName: "Blockcast/Network-Operator-Portal",
        event: "issue_comment",
        prRole: "author",
        requestCommentAuthorLogin: "allyblockcast[bot]",
        requestCommentBody: "<!-- paperclip:review-request -->\n@ally please review at head `66a0f30`",
      },
    });
    // The false assertions the old branch produced must be gone.
    expect(authorMarkdown).not.toContain("just posted findings on YOUR pull request");
    expect(authorMarkdown).not.toContain("If the findings are correct");
    expect(authorMarkdown).not.toContain("push a follow-up commit");
    expect(authorMarkdown).not.toContain("GitHub PR review feedback directive:");
    // ...and it must say the true thing, including the anti-loop instruction.
    expect(authorMarkdown).toContain("GitHub PR review request directive:");
    expect(authorMarkdown).toContain(
      "allyblockcast[bot] requested a review on YOUR pull request.",
    );
    expect(authorMarkdown).toContain("no findings to act on");
    expect(authorMarkdown).toContain("you do NOT need to request the review again");
    expect(authorMarkdown).toContain("The request comment:");
  });

  // Guards the branch boundary: a real submitted review with no state/body must
  // still get the feedback directive, so the fix above cannot silence genuine
  // review feedback.
  it("still gives the feedback directive for a submitted review with no state or body", () => {
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 605,
        repoFullName: "Blockcast/Network-Operator-Portal",
        event: "pull_request_review",
        prRole: "author",
      },
    });
    expect(authorMarkdown).toContain("A reviewer just posted findings on YOUR pull request.");
    expect(authorMarkdown).not.toContain("GitHub PR review request directive:");
  });

  // BLO-38816 (BLO-30420 follow-up): the webhook records WHY it declined to
  // treat a review as actionable, but nothing projected that into the run, so a
  // review with no findings still rendered "If the findings are correct, push a
  // follow-up commit addressing them". Acting on it means a no-op push, which
  // restarts CI and ejects a queued PR -- the same damage the APPROVED arm was
  // fixed for in BLO-19067.
  //
  // This test deliberately goes through derivePaperclipPrReview rather than
  // hand-building `prReview`: the projection is the thing under test, and a
  // literal object would bypass it and pin nothing (BLO-34263 guard-mutation
  // rule). Deleting either projection line must turn this red.
  it("names the declined reason and withholds the push-a-follow-up directive for a non-actionable review", () => {
    const prReview = derivePaperclipPrReview({
      wakeReason: "github_pr_review_submitted",
      githubPrNumber: 1681,
      githubRepoFullName: "Blockcast/paperclip",
      githubEvent: "pull_request_review",
      prRole: "author",
      githubPrReviewState: "commented",
      githubPrReviewAuthorLogin: "allyblockcast[bot]",
      githubReviewFeedbackSuppressionReason: "ally_review_findings_all_zero",
      githubReviewFeedbackSuppressionPredicate: "counted_findings_buckets_all_zero",
    });
    expect(prReview?.reviewFeedbackSuppressionReason).toBe("ally_review_findings_all_zero");
    expect(prReview?.reviewFeedbackSuppressionPredicate).toBe(
      "counted_findings_buckets_all_zero",
    );
    // The declined classification is written as `true`-only, so a declined wake
    // leaves it null -- the actionable and declined cases stay distinguishable
    // from inside the run.
    expect(prReview?.reviewFeedbackActionable).toBeNull();

    const authorMarkdown = buildPaperclipTaskMarkdown({ issue: null, prReview });

    // The reason reaches the run instead of being inferable only from a
    // heartbeat_runs query.
    expect(authorMarkdown).toContain("ally_review_findings_all_zero");
    expect(authorMarkdown).toContain("counted_findings_buckets_all_zero");
    expect(authorMarkdown).toContain("classified as carrying NO actionable findings");
    // The load-bearing half: asserting only the added line passes while the
    // contradictory directive still ships.
    expect(authorMarkdown).not.toContain("If the findings are correct");
    expect(authorMarkdown).not.toContain("push a follow-up commit addressing them");
    expect(authorMarkdown).toContain("no implementation pass is required");
  });

  // Boundary guard: without the suppression reason the directive is unchanged,
  // so the fix above cannot silence a genuine review. Absence of
  // `githubReviewFeedbackActionable` must NOT be read as "declined" -- it is
  // also what every wake predating the writer looks like.
  it("still tells the author to push a follow-up when no decline reason was recorded", () => {
    const prReview = derivePaperclipPrReview({
      wakeReason: "github_pr_review_submitted",
      githubPrNumber: 1681,
      githubRepoFullName: "Blockcast/paperclip",
      githubEvent: "pull_request_review",
      prRole: "author",
      githubPrReviewState: "commented",
      githubPrReviewAuthorLogin: "allyblockcast[bot]",
    });
    expect(prReview?.reviewFeedbackSuppressionReason).toBeNull();
    expect(prReview?.reviewFeedbackActionable).toBeNull();

    const authorMarkdown = buildPaperclipTaskMarkdown({ issue: null, prReview });
    expect(authorMarkdown).toContain("If the findings are correct");
    expect(authorMarkdown).toContain("push a follow-up commit addressing them");
    expect(authorMarkdown).not.toContain("classified as carrying NO actionable findings");
  });

  // AC3: actionable and declined must be distinguishable from inside the run.
  // Three states exist and all three must look different -- "classified
  // actionable", "classified declined", and the unclassified wake above.
  it("names the actionable classification when the webhook recorded one", () => {
    const prReview = derivePaperclipPrReview({
      wakeReason: "github_pr_review_submitted",
      githubPrNumber: 1681,
      githubRepoFullName: "Blockcast/paperclip",
      githubEvent: "pull_request_review",
      prRole: "author",
      githubPrReviewState: "commented",
      githubReviewFeedbackActionable: true,
    });
    expect(prReview?.reviewFeedbackActionable).toBe(true);
    expect(prReview?.reviewFeedbackSuppressionReason).toBeNull();

    const authorMarkdown = buildPaperclipTaskMarkdown({ issue: null, prReview });
    expect(authorMarkdown).toContain("classified as carrying actionable findings");
    expect(authorMarkdown).not.toContain("classified as carrying NO actionable findings");
    // An actionable review still gets the unchanged push directive.
    expect(authorMarkdown).toContain("If the findings are correct");
  });

  // The two classifications are mutually exclusive for a single delivery, so
  // this state is unreachable from today's webhook. It is pinned anyway because
  // the decline-first ordering is a safety property the code comments claim,
  // and until this test existed nothing held it: swapping the informational
  // block's arms passed all 541 tests in this file (measured 2026-10-01).
  //
  // Note what the ordering does and does not protect. The closing directive is
  // safe structurally -- its ternary keys on the decline reason and never reads
  // `reviewFeedbackActionable` -- so a swap cannot resurrect the push
  // instruction. What it breaks is coherence: the run would be told there is
  // "something concrete to address" directly above a directive saying no
  // implementation pass is required, which is the self-contradicting wake this
  // PR exists to remove.
  it("prefers the decline line when both classifications are present", () => {
    const prReview = derivePaperclipPrReview({
      wakeReason: "github_pr_review_submitted",
      githubPrNumber: 1681,
      githubRepoFullName: "Blockcast/paperclip",
      githubEvent: "pull_request_review",
      prRole: "author",
      githubPrReviewState: "commented",
      githubReviewFeedbackActionable: true,
      githubReviewFeedbackSuppressionReason: "ally_review_findings_all_zero",
    });
    expect(prReview?.reviewFeedbackActionable).toBe(true);
    expect(prReview?.reviewFeedbackSuppressionReason).toBe("ally_review_findings_all_zero");

    const authorMarkdown = buildPaperclipTaskMarkdown({ issue: null, prReview });
    // Decline wins the informational block ...
    expect(authorMarkdown).toContain("classified as carrying NO actionable findings");
    expect(authorMarkdown).not.toContain("classified as carrying actionable findings");
    // ... and the directive agrees with it rather than asking for a no-op push.
    expect(authorMarkdown).toContain("no implementation pass is required");
    expect(authorMarkdown).not.toContain("If the findings are correct");
  });

  it("falls back to a generic author-facing directive when reviewer login / state / body are missing", () => {
    const authorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 953,
        repoFullName: "Blockcast/magma",
        event: "pull_request_review",
        prRole: "author",
      },
    });
    expect(authorMarkdown).toContain("A reviewer just posted findings on YOUR pull request.");
    expect(authorMarkdown).not.toContain("Latest review body:");
  });

  // BLO-20886: github_pr_review_requested fires on a bare `@ally review` ASK
  // -- no review has been posted -- and the author-role wake loop also
  // covers plain PR lifecycle events with no review data at all. Both used
  // to render the review-feedback directive unconditionally, telling the
  // woken agent "a reviewer just posted findings on YOUR pull request" and
  // to push a follow-up commit against a PR with zero recorded reviews
  // (observed live: Blockcast/paperclip#953).
  //
  // review_requested is claimed by the more specific BLO-19522 branch above,
  // which says the same true thing in more useful words (it names the
  // requester and carries the anti-loop instruction). What BLO-20886 adds is
  // the allowlist that catches every OTHER reasonless wakeReason -- the
  // lifecycle events asserted below, and any reason added later.
  it("does not instruct a push when no review has actually been submitted", () => {
    const requestedMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_requested",
        prNumber: 953,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
      },
    });
    expect(requestedMarkdown).not.toContain("just posted findings on YOUR pull request");
    expect(requestedMarkdown).not.toContain("push a follow-up commit");
    expect(requestedMarkdown).not.toContain("GitHub PR review feedback directive:");
    expect(requestedMarkdown).toContain("GitHub PR review request directive:");

    // A lifecycle event carries no review either, and no branch above claims
    // it -- so it must land on the generic directive rather than fall through
    // to the feedback one.
    for (const wakeReason of [
      "github_pr_opened",
      "github_pr_reopened",
      "github_pr_synchronize",
      "github_pr_ready_for_review",
    ]) {
      const lifecycleMarkdown = buildPaperclipTaskMarkdown({
        issue: null,
        prReview: {
          wakeReason,
          prNumber: 35,
          repoFullName: "Blockcast/paperclip",
          event: "pull_request",
          prRole: "author",
        },
      });
      expect(lifecycleMarkdown).not.toContain("YOUR pull request");
      expect(lifecycleMarkdown).not.toContain("push a follow-up commit");
      expect(lifecycleMarkdown).not.toContain("GitHub PR review feedback directive:");
      expect(lifecycleMarkdown).toContain("GitHub PR event directive:");
      expect(lifecycleMarkdown).toContain(`"${wakeReason}"`);
      expect(lifecycleMarkdown).toContain("No review findings are recorded for this PR yet");
    }

    // The allowlist is what makes this hold for a wakeReason nobody has
    // written yet: unrecognized must fail into "no findings", not into a
    // false claim that findings exist.
    const unknownMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_some_future_reason",
        prNumber: 36,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        prRole: "author",
      },
    });
    expect(unknownMarkdown).toContain("GitHub PR event directive:");
    expect(unknownMarkdown).not.toContain("GitHub PR review feedback directive:");
  });

  // Real review content must still get the author-shaped directive -- this
  // fix narrows WHEN "YOUR pull request" fires, it doesn't remove it.
  it("still asserts 'YOUR pull request' for an actionable review-feedback comment wake", () => {
    const feedbackMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_feedback",
        prNumber: 953,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        reviewBody: "Critical: missing null check.",
        reviewAuthorLogin: "ally",
      },
    });
    expect(feedbackMarkdown).toContain("GitHub PR review feedback directive:");
    expect(feedbackMarkdown).toContain("YOUR pull request");
  });

  // BLO-20886 AC3. Owning-issue routing fixed WHICH issue is woken, but the
  // recipient still isn't necessarily the PR's author: `kkroo/blo-19132-*`
  // resolves to BLO-19132 via the branch tier, so BLO-19132's assignee is woken
  // about a branch a human owns. That is the original paperclip#953 damage path
  // -- #953 existed precisely to have a non-bot author, so a bot commit there
  // destroys the independence it was opened to establish.
  it("drops the possessive and the push instruction when the PR was authored by a third party", () => {
    const thirdPartyMarkdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "BLO-19132",
        title: "Approval dedupe",
        workMode: null,
        description: null,
      },
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 953,
        repoFullName: "Blockcast/paperclip",
        prUrl: "https://github.com/Blockcast/paperclip/pull/953",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Critical: missing null check.",
        reviewState: "changes_requested",
        reviewAuthorLogin: "ally",
        // The signed webhook's pull_request.user.login -- a human, not the fleet bot.
        prAuthorLogin: "kkroo",
      },
    });

    // The two things AC3 forbids asserting about a PR we did not write.
    expect(thirdPartyMarkdown).not.toContain("YOUR pull request");
    expect(thirdPartyMarkdown).not.toContain("push a follow-up commit");
    // It still delivers the findings -- the review is real, only the ownership
    // claim was false -- and names who actually owns the branch.
    expect(thirdPartyMarkdown).toContain("GitHub PR review feedback directive:");
    expect(thirdPartyMarkdown).toContain("pull request #953");
    expect(thirdPartyMarkdown).toContain('authored by "kkroo", NOT by you');
    expect(thirdPartyMarkdown).toContain("Do NOT push commits to it");
    expect(thirdPartyMarkdown).toContain("Critical: missing null check.");
  });

  it("keeps the possessive when the PR was authored by the configured bot identity", () => {
    // Control for the test above: the gate must fire on a positive mismatch
    // only, never blanket-strip the possessive from PRs the fleet did write.
    const botAuthoredMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 1367,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Critical: missing null check.",
        reviewState: "changes_requested",
        reviewAuthorLogin: "ally",
        prAuthorLogin: "allyblockcast[bot]",
      },
    });
    expect(botAuthoredMarkdown).toContain("YOUR pull request");
    expect(botAuthoredMarkdown).toContain("push a follow-up commit");
    expect(botAuthoredMarkdown).not.toContain("NOT by you");
  });

  it("fails open and keeps the possessive when the PR author is unknown", () => {
    // An absent author login is not PROOF of third-party authorship, and the
    // bot-authored case is the common one, so an unknown author must not
    // silently strip the directive the author actually needs.
    const unknownAuthorMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_submitted",
        prNumber: 1367,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request_review",
        prRole: "author",
        reviewBody: "Critical: missing null check.",
        reviewState: "changes_requested",
        reviewAuthorLogin: "ally",
        prAuthorLogin: null,
      },
    });
    expect(unknownAuthorMarkdown).toContain("YOUR pull request");
  });

  it("drops the possessive on a review REQUEST for a third-party-authored PR", () => {
    // The review_requested branch carries no push instruction already, but it
    // still asserted ownership -- paperclip#953's wake was exactly this shape.
    const requestedMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_review_requested",
        prNumber: 953,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        requestCommentAuthorLogin: "kkroo",
        prAuthorLogin: "kkroo",
      },
    });
    expect(requestedMarkdown).toContain("GitHub PR review request directive:");
    expect(requestedMarkdown).not.toContain("YOUR pull request");
    expect(requestedMarkdown).toContain("pull request #953");
    expect(requestedMarkdown).toContain("NOT by you");
  });

  it("adds accepted-plan continuation guidance for standard-work issues when the wake is flagged as a plan continuation", () => {
    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "PAP-415",
        title: "Implement the fix",
        workMode: "standard",
        description: null,
      },
      acceptedPlanContinuation: true,
    });

    expect(acceptedConfirmation).toContain("Accepted plan directive:");
    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("- Work mode: \"planning\"");
  });

  it("adds answer-only guidance for ask-mode issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-ask",
        identifier: "PAP-416",
        title: "Explain the tradeoff",
        workMode: "ask",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"ask\"");
    expect(assignment).toContain("Ask mode directive:");
    expect(assignment).toContain("Answer the question directly in the issue thread.");
    expect(assignment).toContain("Do not write implementation code");
    expect(assignment).toContain("do not produce an implementation plan");
  });

  it("adds dry-run containment guidance for skill-test issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-skill-test",
        identifier: "PAP-417",
        title: "Test skill draft",
        workMode: "skill_test",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"skill_test\"");
    expect(assignment).toContain("Skill test mode directive:");
    expect(assignment).toContain("Make no durable changes outside this issue.");
    expect(assignment).toContain("Write your final output as issue document `output`");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });

  // PEN-3743: a coalesced wake inlines only the newest comment. The earlier
  // orders it absorbed previously reached the agent as silence -- the ids were
  // retained on the run row but never routed into the prompt, which is the one
  // surface the agent reliably reads.
  it("names the earlier comments a coalesced wake absorbed but did not inline", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-3743",
        title: "Coalesced wake",
        workMode: "standard",
        description: null,
      },
      wakeComment: {
        id: "comment-2",
        body: "the correction",
      },
      supersededWakeCommentIds: ["comment-1"],
      supersededWakeCommentCount: 1,
    });

    expect(markdown).toContain("Wake comment -- the comment that TRIGGERED this wake:");
    expect(markdown).toContain("the correction");
    expect(markdown).toContain("Earlier wake comment NOT shown above (1):");
    expect(markdown).toContain("comment-1");
    expect(markdown).toContain("Read it on the issue before acting");
  });

  // PEN-6039: the heading used to read "Latest wake comment", which asserts the
  // one property this block cannot carry. It holds the comment that TRIGGERED
  // the wake; a comment posted after the wake was enqueued -- including one that
  // woke a sibling run -- is newer and is not in this run's id list. Measured
  // twice ~6h apart on unrelated rows, once over a body two later comments had
  // explicitly retracted.
  describe("PEN-6039 wake comment currency", () => {
    const issue = {
      id: "issue-1",
      identifier: "PEN-6039",
      title: "Wake comment currency",
      workMode: "standard",
      description: null,
    };

    it("heads the block by its subject and dates it, never claiming it is latest", () => {
      const markdown = buildPaperclipTaskMarkdown({
        issue,
        wakeComment: {
          id: "comment-wake",
          body: "the retracted downgrade",
          createdAt: "2026-11-07T11:52:56.000Z",
        },
      });

      expect(markdown).toContain(
        "Wake comment -- the comment that TRIGGERED this wake, created 2026-11-07T11:52:56.000Z:",
      );
      // The claim itself, in any casing: the heading must never assert currency.
      expect(markdown).not.toContain("Latest wake comment");
    });

    it("warns that the rendered body is not the newest -- ABOVE the body, not below it", () => {
      const markdown = buildPaperclipTaskMarkdown({
        issue,
        wakeComment: {
          id: "comment-wake",
          body: "the retracted downgrade",
          createdAt: "2026-11-07T11:52:56.000Z",
        },
        latestIssueComment: {
          id: "comment-newest",
          createdAt: "2026-11-07T17:06:28.000Z",
        },
      });

      expect(markdown).toContain("This is NOT the newest comment on this issue.");
      expect(markdown).toContain("comment-newest");
      expect(markdown).toContain("(created 2026-11-07T17:06:28.000Z)");
      expect(markdown).toContain("correct or RETRACT the one below");
      // Placement is the whole point: the reader this protects reads the block
      // and stops, so a notice after the fence reaches only the reader who was
      // going to keep reading anyway.
      expect(markdown.indexOf("This is NOT the newest comment on this issue.")).toBeLessThan(
        markdown.indexOf("the retracted downgrade"),
      );
    });

    it("stays silent when the wake comment IS the newest", () => {
      const markdown = buildPaperclipTaskMarkdown({
        issue,
        wakeComment: {
          id: "comment-wake",
          body: "the only comment",
          createdAt: "2026-11-07T11:52:56.000Z",
        },
        latestIssueComment: {
          id: "comment-wake",
          createdAt: "2026-11-07T11:52:56.000Z",
        },
      });

      expect(markdown).toContain("Wake comment -- the comment that TRIGGERED this wake");
      expect(markdown).not.toContain("This is NOT the newest comment on this issue.");
    });

    it("degrades to the undated heading rather than inventing a time", () => {
      const markdown = buildPaperclipTaskMarkdown({
        issue,
        wakeComment: { id: "comment-wake", body: "undated body" },
        latestIssueComment: { id: "comment-newest", createdAt: null },
      });

      expect(markdown).toContain("Wake comment -- the comment that TRIGGERED this wake:");
      // The warning still fires -- knowing a newer comment exists does not
      // depend on either timestamp being available.
      expect(markdown).toContain("This is NOT the newest comment on this issue.");
      expect(markdown).toContain("comment-newest");
      expect(markdown).not.toContain("(created ");
    });
  });

  it("pluralizes and reports the exact count when the id list is capped", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-3743",
        title: "Coalesced wake",
        workMode: "standard",
        description: null,
      },
      wakeComment: { id: "comment-9", body: "newest" },
      supersededWakeCommentIds: ["comment-1", "comment-2"],
      // Exact count exceeds the enumerated ids: the cap must not understate how
      // much was dropped.
      supersededWakeCommentCount: 5,
    });

    expect(markdown).toContain("Earlier wake comments NOT shown above (5):");
    expect(markdown).toContain("This wake absorbed 5 earlier comments");
    expect(markdown).toContain("(3 further ids not listed.)");
    expect(markdown).toContain("Read them on the issue before acting");
  });

  it("uses the singular when exactly one id is elided by the cap", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-3743",
        title: "Coalesced wake",
        workMode: "standard",
        description: null,
      },
      wakeComment: { id: "comment-9", body: "newest" },
      supersededWakeCommentIds: ["comment-1", "comment-2"],
      supersededWakeCommentCount: 3,
    });

    expect(markdown).toContain("(1 further id not listed.)");
  });

  it("says nothing about supersession when a wake dropped nothing", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PEN-3743",
        title: "Coalesced wake",
        workMode: "standard",
        description: null,
      },
      wakeComment: { id: "comment-1", body: "only comment" },
      supersededWakeCommentIds: [],
      supersededWakeCommentCount: 0,
    });

    expect(markdown).not.toContain("NOT shown above");
  });
});

describe("derivePaperclipPrReview", () => {
  it("returns the PR review descriptor for github_pr_* wake reasons", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
        githubPrTitle: "Add issue refs",
        githubPrUrl: "https://github.com/Blockcast/paperclip/pull/35",
        githubEventUrl: "https://github.com/Blockcast/paperclip/pull/35",
        githubHeadSha: "abc123",
        githubEvent: "pull_request",
        githubDeliveryId: "abc-123",
        reviewKind: "pr_review",
      }),
    ).toEqual({
      wakeReason: "github_pr_opened",
      prNumber: 35,
      repoFullName: "Blockcast/paperclip",
      prTitle: "Add issue refs",
      prUrl: "https://github.com/Blockcast/paperclip/pull/35",
      eventUrl: "https://github.com/Blockcast/paperclip/pull/35",
      headSha: "abc123",
      event: "pull_request",
      deliveryId: "abc-123",
      reviewKind: "pr_review",
      prRole: null,
      reviewBody: null,
      reviewState: null,
      reviewAuthorLogin: null,
      requestCommentBody: null,
      requestCommentAuthorLogin: null,
      // BLO-23395: only populated on a github_pr_merge_queue_evicted wake.
      mergeQueueEvictionBody: null,
      prAuthorLogin: null,
      // BLO-38816: review-feedback classification. Absent from this snapshot,
      // so the run reads "unclassified" -- not "declined".
      reviewFeedbackActionable: null,
      reviewFeedbackSuppressionReason: null,
      reviewFeedbackSuppressionPredicate: null,
    });
  });

  it("surfaces the PR author login when present (BLO-9293)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 235,
        githubRepoFullName: "Blockcast/Network-Operator-Portal",
        reviewKind: "pr_review",
        prRole: "reviewer",
        githubPrAuthorLogin: "allyblockcast[bot]",
      }),
    ).toMatchObject({ prAuthorLogin: "allyblockcast[bot]" });
  });

  it("surfaces prRole='author' + review body/state/login on assignee wakes (BLO-6300)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_review_submitted",
        githubPrNumber: 953,
        githubRepoFullName: "Blockcast/magma",
        githubEvent: "pull_request_review",
        prRole: "author",
        githubPrReviewBody: "Critical: silent 200 on read-only serializer.",
        githubPrReviewState: "commented",
        githubPrReviewAuthorLogin: "ally",
      }),
    ).toMatchObject({
      prRole: "author",
      reviewBody: "Critical: silent 200 on read-only serializer.",
      reviewState: "commented",
      reviewAuthorLogin: "ally",
    });
  });

  it("surfaces prRole='reviewer' on the reviewer wake", () => {
    const review = derivePaperclipPrReview({
      wakeReason: "github_pr_opened",
      githubPrNumber: 35,
      githubRepoFullName: "Blockcast/paperclip",
      prRole: "reviewer",
      githubPrReviewRequestBody: "@ally re-review requested after the fix.",
      githubPrReviewRequestAuthorLogin: "kkroo",
    });
    expect(review?.prRole).toBe("reviewer");
    expect(review?.requestCommentBody).toBe("@ally re-review requested after the fix.");
    expect(review?.requestCommentAuthorLogin).toBe("kkroo");
  });

  it("rejects unknown prRole values (defends against contextSnapshot drift)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
        prRole: "bystander",
      })?.prRole,
    ).toBeNull();
  });

  it("coerces string-form PR numbers (operators sometimes pass strings via curl)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_ready_for_review",
        githubPrNumber: "42",
        githubRepoFullName: "Blockcast/paperclip",
      })?.prNumber,
    ).toBe(42);
  });

  it("returns null when no PR number is present", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubRepoFullName: "Blockcast/paperclip",
      }),
    ).toBeNull();
  });

  it("returns null when wakeReason is unrelated and reviewKind is not pr_review", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "issue_assigned",
        githubPrNumber: 35,
      }),
    ).toBeNull();
  });

  it("matches on reviewKind even when wakeReason is missing", () => {
    expect(
      derivePaperclipPrReview({
        reviewKind: "pr_review",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
      })?.wakeReason,
    ).toBe("github_pull_request");
  });
});

describe("evaluatePrReviewCompletionEvidence", () => {
  const reviewerContext = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 519,
    githubRepoFullName: "Blockcast/trafficcontrol",
  };

  it("fails reviewer PR runs that exit without a posted review or explicit skip", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        resultJson: {
          summary:
            "No prior Ally review exists for head abc123; I am fetching metadata and diff now.",
        },
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("accepts a durable posted-review marker", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary:
          "Posted the consolidated Ally review on `Blockcast/trafficcontrol#519` for head abc123.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  it("accepts the live Ally consolidated comment review marker", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary:
          "Posted Ally's consolidated comment review on `Blockcast/pim-multicast-gateway#548` for head a563570063ed679e325da8da3f5376a019e7b615.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  it("does not accept negated posted-review verifier text", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        resultJson: {
          title: "Could not verify that the review was posted",
          output:
            "No matching Ally review was found for head a563570063ed679e325da8da3f5376a019e7b615.",
        },
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("does not accept generic verifier text as posted-review evidence", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "Could not verify posted Ally review for head abc123.",
      }),
    ).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("accepts idempotent already-reviewed skips", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "already reviewed at 2026-05-26T04:38:27Z for 86fd374dc3b456622b3852c98320f38997ef46b6",
      }),
    ).toEqual({ status: "already_reviewed" });
  });

  // BLO-31374: the same idempotent exit as the reviewer actually writes it —
  // markdown-formatted, and with the sha either after `for` or directly after
  // `at`. Both texts are verbatim openings of real Ally runs on 2026-09-02 that
  // exited cleanly and were still classified `pr_review_output_missing`,
  // flipping Ally to `error`.
  it.each([
    {
      label: "run b7a984bf — sha directly after `at`, bold + backticks",
      summary:
        "**Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`** — no action taken.\n\n" +
        "The wake was a `transient_failure_retry` carrying a stale head (`0936fba6…`). Against the live PR state:\n\n" +
        "- **Live head:** `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` (the wake-time SHA is superseded).\n" +
        "- **Existing review:** `5096237327` — `allyblockcast[bot]` (Bot), state `COMMENTED`, submitted 2026-09-02T23:28:20Z, " +
        "body starting `## Ally — Consolidated PR Review` with exactly one `Reviewed head:` line attesting `8b237675…`.\n\n" +
        "Posting again would be a duplicate verdict on the same head, which the one-review-per-(PR, head) contract prohibits. Exiting cleanly.",
    },
    {
      label: "run 3ace1eef — timestamp + `for` + backticked sha",
      summary:
        "Exiting without posting — the idempotency check proves this head was already reviewed.\n\n" +
        "## Wake disposition: already reviewed\n\n" +
        "**`Blockcast/penstock-vault-node#554`** — the wake carried head `8d47ae36`, which has been superseded. " +
        "Live head is **`90193c30abb9a75ac17e167b9aea8ca83cebc2cb`**, and the PR is **merged**.\n\n" +
        "**Already reviewed at 2026-09-02T20:41:53Z for `90193c30abb9a75ac17e167b9aea8ca83cebc2cb`** (review `5094874877`).\n\n" +
        "No review posted, no PR state touched.",
    },
    {
      label: "sha after a `head` noun",
      summary: "Already reviewed at head 90193c30abb9a75ac17e167b9aea8ca83cebc2cb; skipping.",
    },
  ])("BLO-31374: accepts a markdown-formatted already-reviewed exit ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({
      status: "already_reviewed",
    });
  });

  // Masking guard: an "already reviewed" claim that cites no sha is not an
  // idempotency exit — nothing ties it to a head — and stays `missing`.
  it("BLO-31374: rejects an already-reviewed claim that cites no sha", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "Already reviewed at 2026-09-02T20:41:53Z; nothing further to do.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Masking guard: a negated clause describes the opposite situation — and the
  // negation must survive the same markdown the clause tolerates (Ally review
  // of #1613: a bare `\s+` prefix let `**not**` through).
  it.each([
    { label: "plain not", summary: "This head was not already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; the draft review was never posted." },
    { label: "bold not", summary: "This head was **not** already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; the draft review was never posted." },
    { label: "italic not", summary: "It was *not* already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`." },
    { label: "not yet been", summary: "Has not yet been already reviewed at 8b237675b19fa5ae061821fd3b1d87cd8cd1836f." },
  ])("BLO-31374: rejects a negated already-reviewed clause ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Masking guard: hedged or prior-head narration from a run that did NOT post
  // (Ally review of #1613). The old `for`-anchored regex rejected all three.
  it.each([
    { label: "could not confirm whether", summary: "I could not confirm whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; the API call failed." },
    { label: "unclear if", summary: "Unclear if already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`. Aborting before the post step." },
    { label: "prior head, did not post", summary: "The prior head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`, but the branch moved and I did not post a review for the new head." },
    { label: "unclear that + copula", summary: "It is unclear that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`." },
  ])("BLO-31374: rejects hedged or prior-head already-reviewed narration ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Not vetoed: stating that no second review was posted is the defining
  // property of this exit (second Ally pass on #1613 — a posted-negation veto
  // sent all five of these to `missing`).
  it.each([
    "**Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`** — I did not post a second review.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; I didn't post again.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`. Did not post a duplicate verdict.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — could not post a duplicate; contract forbids it.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; unable to post a second verdict on the same head.",
  ])("BLO-31374: a correct skip that says it did not post again still classifies (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  // Precedence guard: a hedge or bare `if`/`whether` in an earlier clause does
  // not veto a later unhedged clause — whatever joins the two clauses.
  it.each([
    "I checked whether a review exists. Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — no action taken.",
    "Checked whether a prior review exists: already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Checked whether a prior review exists, already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Checked whether a prior review exists — already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Checked whether a prior review exists; already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Skipping the post step if a review exists; already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Determining if this is a duplicate: already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: an earlier clause's hedge or bare if/whether does not veto the clause (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  // Pins the two halves of the hedge veto independently. (1) A bare
  // `whether`/`if` in the SAME clause that does not govern the review clause
  // must not veto — only a governing hedge ("unclear whether", "could not
  // confirm whether") does. (2) A governing hedge about something else in the
  // PREVIOUS clause, joined by ; : , or —, is out of scope for the review
  // clause.
  it.each([
    "Whether the wake was stale is moot because the head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Regardless of if the wake head moved, this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Unclear whether CI is green; already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — no action taken.",
    "I could not confirm whether CI passed: already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Not sure if the lockstep check ran, already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: only a hedge governing the review clause in its own clause vetoes (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  // Stale/prior-head narration AFTER the clause is how a correct skip explains
  // the wake (third Ally pass); only a prior-head subject BEFORE the clause
  // vetoes.
  it.each([
    "**Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`** — the wake carried a stale head, superseded by this one.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`, the wake head has moved since the original wake.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — the branch moved after the wake, so the wake SHA is not the live one.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; the prior head in the payload is superseded.",
    "Already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` (the earlier head `0936fba6` is stale) — no action taken.",
  ])("BLO-31374: stale-head narration after the clause does not veto (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  // Markdown closing before the sha: the clause interior tolerates the same
  // markdown class as its tail.
  it.each([
    "**Already reviewed** at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — no action taken.",
    "*Already reviewed* at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "`Already reviewed` at 8b237675b19fa5ae061821fd3b1d87cd8cd1836f.",
  ])("BLO-31374: markdown that closes before the sha still matches (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  it("BLO-31374: a glued `alreadyreviewed` is not the clause", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "alreadyreviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Multi-word hedges still govern the clause.
  it.each([
    "I could not fully confirm whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; aborting.",
    "I was not able to confirm whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: a multi-word governing hedge still vetoes (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Masking guard (fourth Ally pass): a negation governing the clause from the
  // subject position, not adjacent to `already`. All four were `false` on
  // master and must stay `missing`.
  it.each([
    "There is no evidence this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`, so I posted a fresh verdict.",
    "I do not believe this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I cannot see that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Found no review; nothing indicates this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: rejects a non-adjacent negation governing the clause (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // A correct skip explains WHY it did not post, often with a negation word in
  // the same clause and before the review clause (fifth Ally pass). Only an
  // epistemic negation vetoes; these all classify.
  it.each([
    "Exiting without posting since this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I did not post a duplicate because this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "There is no need to post again because this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "No action taken because this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Nothing to do here because the head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I don't need to post since the head was already reviewed at 2026-09-02T20:41:53Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f.",
    "The contract does not permit a second verdict and this head was already reviewed at 2026-09-02T20:41:53Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f.",
    "I cannot post a second verdict because this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "No second verdict is needed as this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Skipping — no duplicate verdict is permitted and this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: a non-epistemic negation explaining the skip does not veto (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({ status: "already_reviewed" });
  });

  it("BLO-31374: 'failed to confirm whether' is a governing hedge", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "I failed to confirm whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; aborting.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Masking guard (sixth Ally pass): a `that`-complement of an establishing
  // verb that the run could NOT complete. The hedge only sees `if|whether`.
  it.each([
    "I could not verify that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not establish that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not determine that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not find that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I have not verified that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Unable to establish that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not check that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`; the API failed.",
    "I couldn't verify that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I failed to establish that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: rejects a failed establishing verb with a that-complement (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Seventh Ally pass, over-veto direction: the establishing verbs are
  // transitive over arbitrary objects, so a correct skip that negates finding
  // or checking a DIFFERENT thing must still classify as a skip. Master
  // accepted every one of these in the plain shape.
  it.each([
    "I did not find a newer head so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "No newer review was found so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I could not find any reason to re-review so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I did not check the comments API but already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I could not see a newer head so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "Cannot tell you more; nothing else found so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I did not find a newer head so **already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`** — no action taken.",
  ])("BLO-31374: a negated establishing verb with an unrelated object is still a skip (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({
      status: "already_reviewed",
    });
  });

  // …while the same verb bound to the clause by a complementizer still vetoes.
  it("BLO-31374: the complementizer is what binds a negated establishing verb to the clause", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "I did not find that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Seventh Ally pass, masking direction: hedges outside the original four
  // stems, `that` after a hedge stem, and assumptions with no negation and no
  // complementizer at all.
  it.each([
    "Unknown whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "It remains unverified whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I have no idea whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "It is ambiguous whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "It is not clear that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I doubt this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "Possibly already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`, but I could not check.",
    "Assuming this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` (not confirmed).",
  ])("BLO-31374: rejects a hedge or assumption governing the clause (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Eighth Ally pass, over-veto direction: hedging about the WAKE is the most
  // natural thing this exit says, and the assumption stem must not veto it.
  // Master accepted all six.
  it.each([
    "The wake was probably a duplicate dispatch so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "This is presumably a retry wake so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "The retry was apparently spurious so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "The PR may have been updated since but already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "Possibly a duplicate wake and already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "The wake payload was probably stale so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
  ])("BLO-31374: an assumption about the wake is still a skip (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({
      status: "already_reviewed",
    });
  });

  // Eighth Ally pass, masking direction: the complementizer elided, the verb
  // bound to the clause by the copula at the clause edge.
  it.each([
    "I cannot say this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I cannot state this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not confirm this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I could not establish this head had been already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: rejects an elided complementizer bound by a copula (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Ninth Ally pass, over-veto direction: an epistemic NOUN whose negated
  // object is not the review claim. Master accepted all of these.
  it.each([
    "No evidence of a force-push, so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "No indication the branch advanced, so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "There is no record of a newer wake, and already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I do not believe the payload was fresh, but already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "Nothing suggests a retry storm; already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
    "I did not check whether a newer head exists so already reviewed at 2026-09-02T23:31:00Z for 8b237675b19fa5ae061821fd3b1d87cd8cd1836f",
  ])("BLO-31374: a negated NON-review object is still a skip (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toEqual({
      status: "already_reviewed",
    });
  });

  // …and the same nouns bound to the clause still veto.
  it.each([
    "No evidence that this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "No indication this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I do not believe this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: an epistemic noun bound to the clause still vetoes (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // Ninth pass, masking direction: a hedge outside the stem vocabulary that
  // still questions THIS clause through `whether`.
  it.each([
    "It remains an open question whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "The evidence is inconclusive as to whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
    "I would have to guess whether this head was already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
  ])("BLO-31374: any question whose complement is the clause vetoes (%#)", (summary) => {
    expect(evaluatePrReviewCompletionEvidence(reviewerContext, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  // An assumption in the PREVIOUS clause does not reach the review clause.
  it("BLO-31374: an assumption in an earlier clause does not veto the clause", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "Presumably the earlier run posted; already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — no action taken.",
      }),
    ).toEqual({ status: "already_reviewed" });
  });

  // A negation in the PREVIOUS clause does not reach the review clause.
  it("BLO-31374: a negation in an earlier clause does not veto the clause", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "No changes were requested on the prior head; already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f` — no action taken.",
      }),
    ).toEqual({ status: "already_reviewed" });
  });

  // Direct table over the predicate: pins each veto boundary in one line.
  describe("BLO-31374: prReviewOutputHasAlreadyReviewedSkip boundaries", () => {
    const sha = "8b237675b19fa5ae061821fd3b1d87cd8cd1836f";
    it.each([
      [`Already reviewed at \`${sha}\` — no action taken.`, true],
      [`already reviewed at 2026-05-26T04:38:27Z for ${sha}`, true],
      [`**Already reviewed** at \`${sha}\`.`, true],
      [`Already reviewed at head ${sha}; skipping.`, true],
      [`Already reviewed at ${sha} — the wake carried a stale head, superseded by this one.`, true],
      [`Checked whether a prior review exists: already reviewed at \`${sha}\`.`, true],
      [`Unclear whether CI is green; already reviewed at \`${sha}\`.`, true],
      [`Already reviewed at \`${sha}\`; I did not post again.`, true],
      [`Already reviewed at 2026-09-02T20:41:53Z; nothing further to do.`, false],
      [`This head was **not** already reviewed at \`${sha}\`.`, false],
      [`There is no evidence this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot see that this head was already reviewed at \`${sha}\`.`, false],
      [`Exiting without posting since this head was already reviewed at \`${sha}\`.`, true],
      [`No action taken because this head was already reviewed at \`${sha}\`.`, true],
      [`I failed to confirm whether this head was already reviewed at \`${sha}\`.`, false],
      [`I could not verify that this head was already reviewed at \`${sha}\`.`, false],
      [`I did not find a newer head so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I did not find that this head was already reviewed at \`${sha}\`.`, false],
      [`Possibly already reviewed at \`${sha}\`, but I could not check.`, false],
      [`The wake was probably a duplicate dispatch so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I cannot say this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence of a force-push, so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence that this head was already reviewed at \`${sha}\`.`, false],
      [`It remains an open question whether this head was already reviewed at \`${sha}\`.`, false],
      [`Unable to establish that this head was already reviewed at \`${sha}\`.`, false],
      [`Unclear if already reviewed at \`${sha}\`. Aborting.`, false],
      [`It is unclear that this head was already reviewed at \`${sha}\`.`, false],
      [`Unclear that a rerun helps so already reviewed at \`${sha}\`.`, true],
      [`I could not fully confirm whether this head was already reviewed at \`${sha}\`.`, false],
      [`The prior head was already reviewed at \`${sha}\`, but the branch moved.`, false],
      [`Nothing indicates the branch moved so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Checked that no stale head is involved so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`The old head and the current head are the same so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No force-push, so the branch moved nowhere and already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`The branch has moved so the earlier head was already reviewed at \`${sha}\`.`, false],
      [`The stale head was already reviewed at \`${sha}\`.`, false],
      [`The reviews API 500'd; I am guessing this head was already reviewed at \`${sha}\`.`, false],
      [`I guess this head was already reviewed at \`${sha}\`.`, false],
      [`My best guess is that this head was already reviewed at \`${sha}\`.`, false],
      [`The wake was a guess at the head so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`My guess about the retry cause is irrelevant so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`There is no doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I have no doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Without doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Beyond doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It is not in doubt that this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I doubt this head was already reviewed at \`${sha}\`.`, false],
      [`There is some doubt this head was already reviewed at \`${sha}\`.`, false],
      [`It is doubtful this head was already reviewed at \`${sha}\`.`, false],
      [`alreadyreviewed at \`${sha}\`.`, false],
      [`Already reviewed at${sha}.`, false],
      [`There is no real doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`There is no serious doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Beyond reasonable doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Without any doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I have no genuine doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`There is not the slightest doubt this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer commits were found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer head was found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new was seen so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No later commit was found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No other review was found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer head was found but this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer head was found because this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It appears this head was already reviewed at \`${sha}\`.`, false],
      [`It seems likely this head was already reviewed at \`${sha}\`.`, false],
      [`I believe this head was already reviewed at \`${sha}\`.`, false],
      [`I think this head was already reviewed at \`${sha}\`.`, false],
      [`I suspect this head was already reviewed at \`${sha}\`.`, false],
      [`Perhaps this head was already reviewed at \`${sha}\`.`, false],
      [`Maybe this head was already reviewed at \`${sha}\`.`, false],
      [`It looks like this head was already reviewed at \`${sha}\`.`, false],
      [`It is plausible this head was already reviewed at \`${sha}\`.`, false],
      [`There is no confirmation this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot rule out that this head was already reviewed at \`${sha}\`.`, false],
      [`My assumption is that this head was already reviewed at \`${sha}\`.`, false],
      [`My assumption about the wake was wrong so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It appears no new commits landed so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`This looks like a duplicate wake so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer commits were found yet this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found however this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found though this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found although this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found still this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found nonetheless this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found nevertheless this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found whereas this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found while this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found then this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found consequently this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found accordingly this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found, yet this head was already reviewed at \`${sha}\`.`, true],
      [`Already reviewed at 20260902T204153Z`, false],
      [`Already reviewed at 1234567`, false],
      [`Already reviewed at 2026-09-02T20:41:53Z`, false],
      [`Already reviewed at 2026-09-02T23:31:00Z for 1234567`, true],
      [`Already reviewed at head 1234567`, true],
      [`Already reviewed at commit 1234567`, true],
      [`Already reviewed at 8B237675B19FA5AE061821FD3B1D87CD8CD1836F`, false],
      [`Already reviewed at \`${sha}\`.`, true],
      [`This head never was already reviewed at \`${sha}\`.`, false],
      [`This head not yet was already reviewed at \`${sha}\`.`, false],
      [`This head was never already reviewed at \`${sha}\`.`, false],
      [`Already reviewed at head 8B237675B19FA5AE061821FD3B1D87CD8CD1836F`, false],
      [`Already reviewed at 2026-09-02T23:31:00Z for 8B237675B19FA5AE061821FD3B1D87CD8CD1836F`, false],
      [`Already reviewed at 8b237675B19FA5AE061821FD3B1D87CD8CD1836F`, false],
      [`No confirmation yet that this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence yet that this head was already reviewed at \`${sha}\`.`, false],
      [`There is no record yet that this head was already reviewed at \`${sha}\`.`, false],
      [`No indication yet that this head was already reviewed at \`${sha}\`.`, false],
      [`I have no proof yet that this head was already reviewed at \`${sha}\`.`, false],
      [`No sign yet that this head was already reviewed at \`${sha}\`.`, false],
      [`Cannot confirm yet that this head was already reviewed at \`${sha}\`.`, false],
      [`No verification yet that this head was already reviewed at \`${sha}\`.`, false],
      [`No confirmation still that this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence however that this head was already reviewed at \`${sha}\`.`, false],
      [`No record though that this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence while checking that this head was already reviewed at \`${sha}\`.`, false],
      [`No confirmation from the reviews API yet that this head was already reviewed at \`${sha}\`.`, false],
      [`I could not find any record in the last hour that this head was already reviewed at \`${sha}\`.`, false],
      [`No newer commits were found in the last hour so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It appeared this head was already reviewed at \`${sha}\`.`, false],
      [`It looked like this head was already reviewed at \`${sha}\`.`, false],
      [`I am thinking this head was already reviewed at \`${sha}\`.`, false],
      [`It is probable this head was already reviewed at \`${sha}\`.`, false],
      [`It is possible this head was already reviewed at \`${sha}\`.`, false],
      [`It is conceivable this head was already reviewed at \`${sha}\`.`, false],
      [`It is presumable this head was already reviewed at \`${sha}\`.`, false],
      [`It is apparent this head was already reviewed at \`${sha}\`.`, false],
      [`My presumption is that this head was already reviewed at \`${sha}\`.`, false],
      [`My belief is that this head was already reviewed at \`${sha}\`.`, false],
      [`My impression is that this head was already reviewed at \`${sha}\`.`, false],
      [`My understanding is that this head was already reviewed at \`${sha}\`.`, false],
      [`It appeared no new commits landed so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`My understanding of the wake was wrong so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`My impression about the retry cause is irrelevant so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It is possible to re-run the gate so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Already reviewed at 1234567 (sha \`${sha}\`)`, true],
      [`Already reviewed at 20260902T204153Z commit ${sha}`, true],
      [`Already reviewed at 1234567 and the deadbeef branch`, false],
      [`Already reviewed at 1234567 (see deadbeef)`, false],
      [`Already reviewed at 1234567. The commit ${sha} is unrelated.`, false],
      [`No evidence ${"word ".repeat(23)}was already reviewed at \`${sha}\`.`, true],
      [`No evidence ${"word ".repeat(6)}was already reviewed at \`${sha}\`.`, false],
      [`Already reviewed at head: ${sha}`, true],
      [`Already reviewed at the head ${sha}`, true],
      [`Already reviewed at current head ${sha}`, true],
      [`Already reviewed at head sha ${sha}`, true],
      [`Already reviewed at commit sha ${sha}`, true],
      [`Already reviewed at head=${sha}`, true],
      [`Already reviewed at sha 1234567`, false],
      [`Already reviewed at head sha 1234567`, true],
      [`I haven't confirmed that this head was already reviewed at \`${sha}\`.`, false],
      [`I hadn't verified that this head was already reviewed at \`${sha}\`.`, false],
      [`The run didn't establish that this head was already reviewed at \`${sha}\`.`, false],
      [`The API hasn't confirmed that this head was already reviewed at \`${sha}\`.`, false],
      [`The checks weren't showing that this head was already reviewed at \`${sha}\`.`, false],
      [`I am failing to confirm that this head was already reviewed at \`${sha}\`.`, false],
      [`There was a failure to confirm that this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing indicated this head was already reviewed at \`${sha}\`.`, false],
      [`There is no suggestion that this head was already reviewed at \`${sha}\`.`, false],
      [`There are no records that this head was already reviewed at \`${sha}\`.`, false],
      [`There are no traces that this head was already reviewed at \`${sha}\`.`, false],
      [`I never saw that this head was already reviewed at \`${sha}\`.`, false],
      [`I am unaware that this head was already reviewed at \`${sha}\`.`, false],
      [`No statement that this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing was demonstrating that this head was already reviewed at \`${sha}\`.`, false],
      [`The run never told me that this head was already reviewed at \`${sha}\`.`, false],
      [`I could not rule out that this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing indicated a newer commit so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No records of a force-push so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I never saw a newer head so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I am unaware of any newer commits so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer commit was found for the head that was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing found since the commit that was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I could not find any commit newer than the one that was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`The head moved to a commit which was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I cannot confirm \`8b23767\` was already reviewed at \`${sha}\`.`, false],
      [`I could not verify this PR's head was already reviewed at \`${sha}\`.`, false],
      [`I could not verify (after two retries) this head was already reviewed at \`${sha}\`.`, false],
      [`There is no evidence - none - this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot confirm "this" head was already reviewed at \`${sha}\`.`, false],
      [`I cannot confirm the wake. This head was already reviewed at \`${sha}\`.`, true],
      [`No evidence of a force-push; this head was already reviewed at \`${sha}\`.`, true],
      [`I remain unconvinced that this head was already reviewed at \`${sha}\`.`, false],
      [`Unaware whether this head was already reviewed at \`${sha}\`.`, false],
      [`Unconvinced the wake was legitimate so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing showed that this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing showed a newer commit so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      // negatedHeadConnective's adversative-only guard, not position: same slot,
      // opposite verdict for the two families. Consequence-side control:
      // `No evidence so this head was …` (below, and a minimal-pair backtick-sha
      // form beside the consequence-connective rows further down).
      [`No evidence yet this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence still this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence however this head was already reviewed at \`${sha}\`.`, false],
      [`No indication yet this head was already reviewed at \`${sha}\`.`, false],
      [`No indication still this head was already reviewed at \`${sha}\`.`, false],
      [`No indication however this head was already reviewed at \`${sha}\`.`, false],
      [`No confirmation yet this head was already reviewed at \`${sha}\`.`, false],
      [`No confirmation still this head was already reviewed at \`${sha}\`.`, false],
      [`No confirmation however this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot say yet this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot say still this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot say however this head was already reviewed at \`${sha}\`.`, false],
      [`There is no record yet this head was already reviewed at \`${sha}\`.`, false],
      [`There is no record still this head was already reviewed at \`${sha}\`.`, false],
      [`There is no record however this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing suggests yet this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing suggests still this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing suggests however this head was already reviewed at \`${sha}\`.`, false],
      [`No newer commits were found yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new was seen still this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence of a force-push however this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer commits were found yet that head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer commits were found so that commit was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new was seen still that head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence still that this head was already reviewed at \`${sha}\`.`, false],
      [`I assume this head was already reviewed at \`${sha}\`.`, false],
      [`I assumed this head was already reviewed at \`${sha}\`.`, false],
      [`The run assumes this head was already reviewed at \`${sha}\`.`, false],
      [`My assumptions are that this head was already reviewed at \`${sha}\`.`, false],
      [`I presume this head was already reviewed at \`${sha}\`.`, false],
      [`Possibly, this head was already reviewed at \`${sha}\`.`, false],
      [`Probably, this head was already reviewed at \`${sha}\`.`, false],
      [`Perhaps, this head was already reviewed at \`${sha}\`.`, false],
      [`I checked the wake. Possibly, a retry so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`The wake was possibly a duplicate, so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Not possibly, this head was already reviewed at \`${sha}\`.`, true],
      [`No clear evidence yet this head was already reviewed at \`${sha}\`.`, false],
      [`No direct evidence yet this head was already reviewed at \`${sha}\`.`, false],
      [`No strong indication yet this head was already reviewed at \`${sha}\`.`, false],
      [`No independent confirmation yet this head was already reviewed at \`${sha}\`.`, false],
      [`There is no real evidence yet this head was already reviewed at \`${sha}\`.`, false],
      [`No further indication still this head was already reviewed at \`${sha}\`.`, false],
      [`No newer revisions were seen yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new has been found still this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer head is known yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      // minimal pair with the adversative row above: same backtick-sha shape,
      // connective family is the only variable that changes.
      [`No evidence so this head was already reviewed at \`${sha}\`.`, true],
      [`No clear evidence because this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing else found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new seen therefore this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No confirmation hence this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No indication thus this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing else found consequently this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No confirmation accordingly this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing else found therefore this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence then this head was already reviewed at \`${sha}\`.`, false],
      [`No newer commits appear yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer revisions indicate yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No other branches suggest yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No strong indication still this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot fully confirm yet this head was already reviewed at \`${sha}\`.`, false],
      [`I am not fully aware yet this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot definitively say yet this head was already reviewed at \`${sha}\`.`, false],
      [`We do not currently believe yet this head was already reviewed at \`${sha}\`.`, false],
      [`I have not conclusively verified yet this head was already reviewed at \`${sha}\`.`, false],
      [`No longer aware yet this head was already reviewed at \`${sha}\`.`, false],
      [`No anomaly indicates yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No reply suggests yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No supply shows yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I am not certain yet this head was already reviewed at \`${sha}\`.`, false],
      [`I am not convinced that this head was already reviewed at \`${sha}\`.`, false],
      [`It is not clear yet this head was already reviewed at \`${sha}\`.`, false],
      [`It is not apparent yet this head was already reviewed at \`${sha}\`.`, false],
      [`I am not positive yet this head was already reviewed at \`${sha}\`.`, false],
      [`I am not positive that this head was already reviewed at \`${sha}\`.`, false],
      [`It is unclear this head was already reviewed at \`${sha}\`.`, false],
      [`I am unaware this head was already reviewed at \`${sha}\`.`, false],
      [`It is inconclusive this head was already reviewed at \`${sha}\`.`, false],
      [`It is not obvious yet this head was already reviewed at \`${sha}\`.`, false],
      [`I have no idea this head was already reviewed at \`${sha}\`.`, false],
      [`No idea yet this head was already reviewed at \`${sha}\`.`, false],
      [`Everything is clear so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I am satisfied with the checks so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`The evidence is conclusive so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No blocker is apparent so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No positive drift detected, so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No result was positive, but this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No coverage delta was positive, so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Results are unambiguous so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It is unambiguous this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No new idea landed so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I dropped the idea of a rebase, so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`I resolved every unclear row, so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`It is obvious no newer head exists so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No unknown commits were found so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      // pass 23: a negation governing the PREVIOUS clause may not cross a
      // consequence connective into this one (was false-vetoed 7/10).
      [`Nothing changed so I see this head was already reviewed at \`${sha}\`.`, true],
      [`Not stale since I verified this head was already reviewed at \`${sha}\`.`, true],
      [`No drift so we confirm this head was already reviewed at \`${sha}\`.`, true],
      [`Nothing moved therefore I see this head was already reviewed at \`${sha}\`.`, true],
      // …but a connective in FILLER role (complementizer follows) still lets
      // the negation govern this clause — the pass-15 balance, unchanged.
      [`No sign but that this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence so far that this head was already reviewed at \`${sha}\`.`, false],
      // pass 23/24: the negation filler's token class can cross a citation or
      // punctuation; with `\\w+` these four were accepted (masking).
      [`I have no \`direct\` evidence this head was already reviewed at \`${sha}\`.`, false],
      [`No (verified) proof that this head was already reviewed at \`${sha}\`.`, false],
      [`No force-push evidence that this head was already reviewed at \`${sha}\`.`, false],
      [`There is no up-to-date confirmation that this head was already reviewed at \`${sha}\`.`, false],
      [`Already reviewed at head${sha}.`, false],
    ])("%s → %s", (text, want) => {
      expect(prReviewOutputHasAlreadyReviewedSkip(text)).toBe(want);
    });
  });

  // Attribution: which cue vetoes. Eleven review passes have each needed a
  // by-hand bisection to answer this; the table below pins one representative
  // clause per cue so the next regression report can name the cue directly.
  describe("BLO-31374: veto attribution names the governing cue", () => {
    it.each([
      ["It is unclear that this head was ", "hedge"],
      ["Possibly ", "assumption"],
      ["I am guessing this head was ", "assumption"],
      ["I doubt this head was ", "assumption"],
      ["It remains an open question whether this head was ", "questioned"],
      ["Unclear if ", "questioned"],
      ["The prior head was ", "priorHead"],
      ["No evidence that this head was ", "negation"],
      ["I cannot say this head was ", "negation"],
      ["I am unaware that this head was ", "fusedNegation"],
      ["No evidence yet this head was ", "negatedHeadConnective"],
      ["I cannot fully confirm yet this head was ", "negatedHeadConnective"],
      ["I am not certain yet this head was ", "negatedHeadConnective"],
      ["I am not convinced that this head was ", "negation"],
      ["It is unclear this head was ", "fusedNegation"],
      ["It is not obvious yet this head was ", "negatedHeadConnective"],
      ["I have no idea this head was ", "negation"],
      ["No evidence that this head was ", "negation"],
      ["I am not aware that this head was ", "negation"],
      // Correct skips: no cue governs the clause, so nothing vetoes.
      ["No evidence of a force-push, so ", null],
      ["I did not check whether a newer head exists so ", null],
      ["No newer commits were found so this head was ", null],
      ["No force-push evidence that this head was ", "negation"],
      ["Nothing changed so I see this head was ", null],
      ["Beyond reasonable doubt this head was ", null],
      ["The wake was probably a duplicate dispatch so ", null],
    ])("%s -> %s", (before, cue) => {
      expect(prReviewAlreadyReviewedVetoCue(before)).toBe(cue);
    });
  });

  // CHARACTERIZATION, NOT CORRECTNESS. Every row below is a KNOWN FALSE-VETO:
  // the verdict asserted is the one the classifier currently produces, and it
  // is wrong. They are pinned so that a future change which widens or narrows
  // the residual is visible in the diff rather than discovered by the twenty-
  // third review pass.
  //
  // The shape is a preposition-led adjunct with no connective, no comma and no
  // sentence boundary, so nothing in CLAUSE_REACH separates the adjunct from
  // the review clause. It has never been survivable for any epistemic cue —
  // the `negation` row here false-vetoes at every head in this PR's history —
  // and it fails toward `missing`, a re-review rather than a masked
  // non-review. Passes 20-23 each widened it to more words or shapes; none
  // opened it. Pass 23's connective-role exclusion does not touch these frames
  // (they carry no connective for it to act on), but the token class it
  // shares with COPULA_FILLER does, by one shape: punctuated filler tokens.
  //
  // If a later pass fixes CLAUSE_REACH so an adjunct no longer swallows the
  // clause, these expectations flip to `true` and SHOULD be updated to `true`.
  // Do not "fix" a failure here by re-narrowing a cue.
  describe("BLO-31374: known CLAUSE_REACH adjunct residual (characterization)", () => {
    const sha = "8b237675b19fa5ae061821fd3b1d87cd8cd1836f";
    it.each([
      // pre-existing at every head — the control that proves the class is old
      [`Despite no evidence of a force-push this head was already reviewed at \`${sha}\`.`, false],
      // widened by the pass-21 bare fusedNegation stem
      [`Despite the unclear wake payload this head was already reviewed at \`${sha}\`.`, false],
      [`Following the inconclusive CI run this head was already reviewed at \`${sha}\`.`, false],
      // widened by the pass-20 adjective family and the pass-21 `obvious`
      [`Given no certain match this head was already reviewed at \`${sha}\`.`, false],
      [`Aside from no obvious drift this head was already reviewed at \`${sha}\`.`, false],
      // widened by the pass-22 `ideas?` lemma
      [`No new idea landed for this head was already reviewed at \`${sha}\`.`, false],
      // widened by the pass-23 NON_CONNECTIVE_WORD token class
      [`No force-push evidence this head was already reviewed at \`${sha}\`.`, false],
    ])("known residual: %s -> %s", (text, want) => {
      expect(prReviewOutputHasAlreadyReviewedSkip(text)).toBe(want);
    });

    // The same words in the shapes real output actually uses. These are the
    // rows that must never change: a connective, a comma or a sentence
    // boundary separates the adjunct, and the skip survives.
    it.each([
      `Skipping: the merge state is unknown but this head was already reviewed at \`${sha}\`.`,
      `The wake head was unknown, so this head was already reviewed at \`${sha}\`.`,
      `Merge state unknown; nothing to do. This head was already reviewed at \`${sha}\`.`,
      `Nothing ambiguous remained, so this head was already reviewed at \`${sha}\`.`,
    ])("house-style skip containing a residual word still classifies (%#)", (text) => {
      expect(prReviewOutputHasAlreadyReviewedSkip(text)).toBe(true);
    });
  });

  // A hedge about something OTHER than the review does not mask the skip: the
  // `that`-complement closes before the clause, so no copula reaches it. Drop
  // the copula bind from the hedge cue and this row flips to `missing` — the
  // false-`missing` regression this PR exists to eliminate.
  it("BLO-31374: a hedge whose complement closes before the clause still skips", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "Unclear that a rerun helps so already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
      }),
    ).toMatchObject({ status: "already_reviewed" });
  });

  // `notalready` is not a negation and not the clause: no word boundary before
  // `already`, so the shape does not match at all and the run stays `missing`.
  it("BLO-31374: a glued `notalready` is neither a negation nor the clause", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "This head was notalready reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-31374: rejects a plural negation", () => {
    expect(
      evaluatePrReviewCompletionEvidence(reviewerContext, {
        summary: "These heads weren't already reviewed at `8b237675b19fa5ae061821fd3b1d87cd8cd1836f`.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("accepts archived Network-Management-Portal skips", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        {
          ...reviewerContext,
          githubRepoFullName: "Blockcast/Network-Management-Portal",
        },
        {
          summary:
            "Archive notice already present on `Blockcast/Network-Management-Portal#361`; NMP is archived, so Ally skipped review as required.",
        },
      ),
    ).toEqual({ status: "archived_repo_skipped" });
  });

  it("does not apply to author-shaped PR wakes", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        {
          ...reviewerContext,
          prRole: "author",
        },
        { summary: "" },
      ),
    ).toEqual({ status: "not_applicable" });
  });

  // BLO-8195: every entry below is a verbatim-shaped Ally completion summary
  // from a run that DID post a review but was misclassified
  // `pr_review_output_missing` by the old phrase allowlist. They must now be
  // accepted because (a) a posted/landed-review verb is present and (b) the
  // summary references the same PR target (number / head sha / repo) carried on
  // the wake context. Run IDs are recorded so the regression is traceable.
  it.each([
    // run ee48a927 — Blockcast/paperclip#227
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
      summary:
        "The consolidated review landed as a `COMMENTED` review at head `4e60b6b1`. PR-review wake complete. Reviewed **Blockcast/paperclip#227** and posted one consolidated, comment-only review.",
    },
    // run 4c5fc555 — Blockcast/magma#1038
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 1038, githubRepoFullName: "Blockcast/magma", githubHeadSha: "e716f54b" },
      summary:
        "Posted successfully (exit 0). The PR-review wake is complete per the completion contract. **Blockcast/magma#1038** reviewed at head `e716f54b` and posted one comment-only consolidated review.",
    },
    // run 214fad1a — Blockcast/moqtail-private#117 (no explicit "posted" verb; landed-as-COMMENTED + head sha)
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 117, githubRepoFullName: "Blockcast/moqtail-private", githubHeadSha: "d5918c4d" },
      summary:
        "Confirmed landed as **COMMENTED** at head `d5918c4d`. Review complete. Reviewed **Blockcast/moqtail-private#117**.",
    },
    // run 1af81fab — Blockcast/linux-amt#68
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 68, githubRepoFullName: "Blockcast/linux-amt", githubHeadSha: "cbedd9a1" },
      summary: "Review posted successfully on Blockcast/linux-amt#68 at head `cbedd9a1`.",
    },
    // run a7825ae3 — Blockcast/onprem-k8s#461 (verb before review noun; "Consolidated review posted")
    {
      ctx: { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 461, githubRepoFullName: "Blockcast/onprem-k8s", githubHeadSha: "c08d2a6f" },
      summary:
        "Done. Consolidated review posted and confirmed. Posted a comment-only review (`state: COMMENTED`) at the correct head c08d2a6f, confirmed landed.",
    },
  ])("BLO-8195: accepts Ally's natural-language posted-review summary against the same target (%#)", ({ ctx, summary }) => {
    expect(evaluatePrReviewCompletionEvidence(ctx, { summary })).toEqual({ status: "posted_review" });
  });

  // BLO-8195: runs 57ece70a (#365) and 99510598 (#366) posted an archive notice
  // and skipped review on the retired NMP repo, but the old archived detector's
  // exact "archive notice already present" / "skipped review" strings missed
  // their actual phrasing, so they too were misclassified `pr_review_output_missing`.
  it.each([
    {
      label: "#365 skipped + posted notice",
      summary:
        "This wake was for `Blockcast/Network-Management-Portal#365`, which my AGENTS.md flags as **archived/retired** for portal work. Skipped the review (per guardrail) and posted exactly one archive notice — no prior notice existed.",
    },
    {
      label: "#366 archive notice posted, exiting without review",
      summary:
        "Archive notice posted, exiting without review. PR `Blockcast/Network-Management-Portal#366` is on the archived/retired NMP repo. Per the AGENTS.md guardrail, I did not run a review.",
    },
  ])("BLO-8195: classifies NMP archived-skip posts as archived_repo_skipped, not missing ($label)", ({ summary }) => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...reviewerContext, githubRepoFullName: "Blockcast/Network-Management-Portal" },
        { summary },
      ),
    ).toEqual({ status: "archived_repo_skipped" });
  });

  // BLO-8195: the broadened acceptance must never mask a real posting failure.
  it("BLO-8195: still fails a reviewer run that exited mid-fetch without posting", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "No prior Ally review exists for Blockcast/paperclip#227 at head 4e60b6b1; I am fetching metadata and diff now." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-8195: still fails when the posting is negated even though the target matches", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "Could not verify the review posted on Blockcast/paperclip#227 for head 4e60b6b1; no matching Ally review was found." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-8195: still fails when the output only states future intent to post", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 227, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "4e60b6b1" },
        { summary: "Diff fetched for Blockcast/paperclip#227 at head 4e60b6b1; I will post the consolidated review next." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // BLO-8195 hardening (Ally review of #228) — masking direction: each phrasing
  // below posted nothing, so it must stay `missing` even though it names the
  // target and contains a posted/landed token. These pin the gaps the contiguous-
  // only negation guard left open.
  const hardeningCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 227,
    githubRepoFullName: "Blockcast/paperclip",
    githubHeadSha: "4e60b6b1",
  };
  it.each([
    { label: "non-contiguous 'not yet posted'", summary: "Diff fetched for #227 at head 4e60b6b1; the review was not yet posted." },
    { label: "'no review has been posted'", summary: "On #227 at head 4e60b6b1: no review has been posted." },
    { label: "'review never got posted'", summary: "For #227 head 4e60b6b1, the review never got posted." },
    { label: "'have not posted the review'", summary: "On #227 head 4e60b6b1 I have not posted the review." },
    { label: "bare 'submitted … for review'", summary: "Submitted the diff for review on #227 head 4e60b6b1; will await feedback." },
    { label: "credits a prior run", summary: "A review was already posted by a prior run on #227 at head 4e60b6b1." },
  ])("BLO-8195: keeps a non-posted run missing despite a posted token ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toMatchObject({
      status: "missing",
      errorCode: "pr_review_output_missing",
    });
  });

  it("BLO-8195: a same-repo post for a DIFFERENT PR does not satisfy the target anchor", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 228, githubRepoFullName: "Blockcast/paperclip", githubHeadSha: "aabbccdd1122" },
        { summary: "Posted review on Blockcast/paperclip#227 at head deadbeef9988." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // BLO-8195 hardening (Ally review of #228) — recall direction: these DID post and
  // match the target; an unrelated hedge must not veto them back to `missing`.
  it("BLO-8195: accepts a posted review anchored by head sha alone (no #number in text)", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 69, githubRepoFullName: "Blockcast/linux-amt", githubHeadSha: "8be14a3" },
        { summary: "Review posted successfully against head `8be14a3`." },
      ),
    ).toEqual({ status: "posted_review" });
  });

  it.each([
    { label: "incidental CI hedge", summary: "Posted the comment-only review on Blockcast/paperclip#227 at head 4e60b6b1; could not confirm CI is green yet but that is out of review scope." },
    { label: "idempotency 'no prior review' hedge", summary: "Could not find any prior Ally review for head 4e60b6b1, so I proceeded and posted the review on #227." },
  ])("BLO-8195: an unrelated hedge does not veto a genuinely posted, target-matched run ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toEqual({ status: "posted_review" });
  });

  // BLO-8195 recall fixes (Ally review of #229) — lock the two tradeoffs:
  // (1) "await feedback" is normal AFTER a successful post; the standalone veto was
  //     dropped so it no longer flips a posted run to missing.
  // (2) `submitted` reinstated in verb branch (b) (the `for`-guard still rejects
  //     "submitted the diff for review", asserted below).
  it.each([
    { label: "'await feedback' after a real post", summary: "Posted the review on Blockcast/paperclip#227 at head 4e60b6b1; now I await feedback." },
    { label: "'submitted my review' natural phrasing", summary: "Submitted my review on Blockcast/paperclip#227 at head 4e60b6b1." },
  ])("BLO-8195: a genuinely posted run is not vetoed by await-feedback / submitted phrasing ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(hardeningCtx, { summary })).toEqual({ status: "posted_review" });
  });

  it("BLO-8195: reinstating `submitted` does not accept 'submitted the diff for review'", () => {
    expect(
      evaluatePrReviewCompletionEvidence(hardeningCtx, {
        summary: "Submitted the diff for review on #227 head 4e60b6b1; will await feedback.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });
  // BLO-8215: a mid-run GitHub App token expiry on the publish path leaves a
  // drafted-but-unpublished review. It must be flagged with the distinct,
  // recoverable `pr_review_auth_expired` code — NOT conflated with the
  // content-failure `pr_review_output_missing`, which is not auto-retried.
  const authExpiryCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 230,
    githubRepoFullName: "Blockcast/paperclip",
    githubHeadSha: "1672bf45",
  };

  // Real misclassified run 04f96618-af56-4c27-97cc-d8781f4750f6 (Ally, PR #230,
  // 2026-05-30T15:04Z): exited 0, drafted the review, hit `401 Bad credentials`
  // at post time, and was recorded `pr_review_output_missing`. Note the summary
  // also carries posting-negation ("could not post it") and future intent ("will
  // be reposted") — so the auth-expiry branch must take precedence over both the
  // posted-marker veto AND the final missing fallthrough.
  it("BLO-8215: classifies a real mid-run 401 token-expiry as auth_expired, not missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "I completed a full review of Blockcast/paperclip#230 (head `1672bf45`) but could not post it — the GitHub App token returned `401 Bad credentials` on both REST and GraphQL at post time (the known ~1h mid-run token-expiry pattern). The finished review is saved verbatim to memory and will be reposted on a fresh wake once auth works and the head still matches.",
      }),
    ).toMatchObject({ status: "auth_expired", errorCode: "pr_review_auth_expired" });
  });

  it.each([
    {
      label: "explicit installation-token expiry",
      summary:
        "On Blockcast/paperclip#230 at head 1672bf45 the GitHub App installation token expired mid-run, so I could not publish the consolidated review.",
    },
    {
      label: "gh CLI HTTP 401 at publish",
      summary:
        "Could not publish the review for #230 (head 1672bf45): `gh pr review` returned HTTP 401 Bad credentials.",
    },
    {
      label: "GH_TOKEN expiry before push",
      summary: "Drafted the #230 review at head 1672bf45 but GH_TOKEN expired before the push could complete.",
    },
  ])("BLO-8215: flags GitHub auth-expiry phrasings as auth_expired ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(authExpiryCtx, { summary })).toMatchObject({
      status: "auth_expired",
      errorCode: "pr_review_auth_expired",
    });
  });

  // Masking guard: a genuinely-absent review with no GitHub auth-expiry signature
  // must stay `missing`. An unrelated "expired" token (a stale lockfile) without a
  // GitHub/token/401 anchor must not be mistaken for an auth fault.
  it("BLO-8215: a non-posted run with no auth signal stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "Diff fetched for Blockcast/paperclip#230 at head 1672bf45; the review was not yet posted (a stale build lockfile had expired and I am re-running lint).",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-9657: reviewed token-expiry content without a GitHub publish failure stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "Diff fetched for Blockcast/paperclip#230 at head 1672bf45; no review has been posted. The diff changes an application token-expiry scheduler and mid-run token expiry tests for the app's own auth layer.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-9657: reviewed code returning 401 Bad credentials without a GitHub publish anchor stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "Diff fetched for Blockcast/paperclip#230 at head 1672bf45; no review has been posted. The change fixes the OAuth handler that was returning 401 Bad credentials when the session token was missing.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  it("BLO-9657: reviewed code with 'access token expired' without a GitHub publish anchor stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary:
          "Diff fetched for Blockcast/paperclip#230 at head 1672bf45; no review has been posted. The diff adds retry logic for when the OAuth access token expires during a long-running operation.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Precedence guard: a genuinely posted review that merely mentions an earlier,
  // recovered 401 must stay `posted_review` (the posted-marker checks run first).
  it("BLO-8215: a posted review that recovered from an earlier 401 stays posted_review", () => {
    expect(
      evaluatePrReviewCompletionEvidence(authExpiryCtx, {
        summary: "Review posted successfully against head `1672bf45` after an earlier 401 Bad credentials was retried.",
      }),
    ).toEqual({ status: "posted_review" });
  });

  // BLO-9293: an INTENTIONAL self-review skip. Ally is woken to review every PR
  // including ones it authored itself; GitHub forbids self-review, so Ally exits
  // without posting. With the signed-webhook PR author confirming Ally's own bot
  // identity, the gate must accept this as `self_review_skipped` (a non-override
  // status → run stays `succeeded`), NOT `pr_review_output_missing` (which flips
  // Ally `error` and tripped the BLO-3202 sweep on three skips in a row).
  const selfReviewCtx = {
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 235,
    githubRepoFullName: "Blockcast/Network-Operator-Portal",
    githubHeadSha: "9f3ac21",
    // pull_request.user.login from the signed webhook — a GitHub App bot surfaces
    // as "<slug>[bot]"; Ally's summary names the same author as "app/<slug>".
    githubPrAuthorLogin: "allyblockcast[bot]",
  };

  it.each([
    // run 143cdf48 — Network-Operator-Portal#235
    { label: "#235 self-review not allowed", summary: "PR author is `app/allyblockcast`, so self-review is not allowed. Exiting without posting a review on Blockcast/Network-Operator-Portal#235." },
    // run 458b075f — Network-Operator-Portal#234
    { label: "#234 self-review not allowed", summary: "Reviewed Blockcast/Network-Operator-Portal#234: the PR author is `app/allyblockcast`, so self-review is not allowed; skipped." },
    // run 2455a2d9 — Network-Operator-Portal#232
    { label: "#232 skipped as self-review", summary: "PR author is `app/allyblockcast`; review was skipped as self-review for #232." },
    // run fd135efa — penstock-llm-proxy-core#70
    { label: "#70 skipped self-review prefix", summary: "Skipped self-review: PR author is `app/allyblockcast`." },
  ])("BLO-9293: accepts an intentional self-review skip on a bot-authored PR ($label)", ({ summary }) => {
    expect(evaluatePrReviewCompletionEvidence(selfReviewCtx, { summary })).toEqual({
      status: "self_review_skipped",
    });
  });

  it("BLO-9293: accepts a self-review skip when the author handle is given without the app/ prefix", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "allyblockcast" },
        { summary: "Cannot review my own PR — the author is allyblockcast (this bot). Skipping #235." },
      ),
    ).toEqual({ status: "self_review_skipped" });
  });

  // Masking guard 1: the summary claims a self-review skip but the signed-webhook
  // PR author is a DIFFERENT identity (a human, or another bot). The free-text
  // claim is not corroborated, so it must NOT mask a real missing review.
  it("BLO-9293: a self-review claim whose author handle does not match the webhook author stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "some-human-dev" },
        { summary: "PR author is `app/allyblockcast`, so self-review is not allowed; skipping #235." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Masking guard 2: a self-review skip phrase with NO PR author on the wake
  // context cannot be anchored, so it stays missing (text alone is never trusted).
  it("BLO-9293: a self-review claim with no webhook PR author stays missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { reviewKind: "pr_review", prRole: "reviewer", githubPrNumber: 235, githubRepoFullName: "Blockcast/Network-Operator-Portal" },
        { summary: "PR author is `app/allyblockcast`, so self-review is not allowed; skipping #235." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Negative case (issue verifying signal): a genuinely missing review — bot
  // author present, but the run produced no posted-review AND no self-review-skip
  // evidence — must still fail with `pr_review_output_missing`.
  it("BLO-9293: a real missing-output run on a bot-authored PR still fails pr_review_output_missing", () => {
    expect(
      evaluatePrReviewCompletionEvidence(selfReviewCtx, {
        summary: "No prior Ally review exists for Blockcast/Network-Operator-Portal#235 at head 9f3ac21; I am fetching metadata and diff now.",
      }),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });

  // Precedence guard: Ally should still REVIEW another bot's PR (e.g. dependabot)
  // — a missing review there is a real failure, not a self-skip — and an
  // unrelated mention of "self-review" must not flip it green when the author
  // handle (dependabot) is not what any self-skip phrase cites.
  it("BLO-9293: a missing review on another bot's PR is not masked as a self-skip", () => {
    expect(
      evaluatePrReviewCompletionEvidence(
        { ...selfReviewCtx, githubPrAuthorLogin: "dependabot[bot]" },
        { summary: "Fetching diff for #235 at head 9f3ac21; I will post the consolidated review next." },
      ),
    ).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.checkboxSelection).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves resolved interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.checkboxSelection).toEqual({
      prompt: "Delete selected files?",
      selectedOptionIds: ["file-b"],
      selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
    });
  });

  // BLO-19118. Two PRs whose bodies both reference the same BLO- ref resolve to
  // the same issue, so their author wakes share a coalescing task key and get
  // merged. Reproduces the 2026-07-30 incident verbatim: a ready_for_review for
  // #837 (which carries no review fields of its own) merged onto a pending
  // review_submitted for #824 and inherited #824's review body.
  it("drops the inherited GitHub block when the incoming wake names a different PR", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 824,
        githubPrTitle: "fix(recovery): treat checkout adoption as continuity",
        githubPrUrl: "https://github.com/Blockcast/paperclip/pull/824",
        githubHeadSha: "bfc470e81a12a3f52ac030b45a5e68949e119bc1",
        githubCommentId: "review-comment-824",
        githubCommentUrl: "https://github.com/Blockcast/paperclip/pull/824#discussion_r824",
        githubPrReviewBody: "Reviewed head: bfc470e8. getCheckoutAdoptingRun ignores the CAS result.",
        githubPrReviewState: "commented",
        githubPrReviewAuthorLogin: "ally",
        githubReviewFeedbackActionable: true,
        commentId: "review-comment-824",
        wakeCommentId: "review-comment-824",
        wakeCommentIds: ["review-comment-824"],
        paperclipWake: {
          comments: [{ id: "review-comment-824", body: "Findings on #824." }],
        },
        prRole: "author",
      },
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_ready_for_review",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 837,
        githubPrTitle: "fix(recovery): let a recovery owner comment",
        githubPrUrl: "https://github.com/Blockcast/paperclip/pull/837",
        githubHeadSha: "2120c77c8633e98b186c592d0ddd0204cc6a8760",
        prRole: "author",
      },
    );

    // Identity is the incoming PR's, wholesale.
    expect(merged.githubPrNumber).toBe(837);
    expect(merged.githubHeadSha).toBe("2120c77c8633e98b186c592d0ddd0204cc6a8760");
    expect(merged.githubPrTitle).toBe("fix(recovery): let a recovery owner comment");

    // The other PR's review must not ride along — this is the whole bug.
    expect(merged.githubPrReviewBody).toBeUndefined();
    expect(merged.githubPrReviewState).toBeUndefined();
    expect(merged.githubPrReviewAuthorLogin).toBeUndefined();
    expect(merged.githubReviewFeedbackActionable).toBeUndefined();
    expect(merged.githubCommentId).toBeUndefined();
    expect(merged.githubCommentUrl).toBeUndefined();
    expect(merged.commentId).toBeUndefined();
    expect(merged.wakeCommentId).toBeUndefined();
    expect(merged.wakeCommentIds).toBeUndefined();
    expect(merged.paperclipWake).toBeUndefined();

    // Task identity still survives the clear.
    expect(merged.issueId).toBe("issue-18829");
  });

  it("keeps only incoming comment ids when the incoming wake names a different PR", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 824,
        githubHeadSha: "bfc470e81a12a3f52ac030b45a5e68949e119bc1",
        githubCommentId: "review-comment-824",
        commentId: "review-comment-824",
        wakeCommentId: "review-comment-824",
        wakeCommentIds: ["review-comment-824"],
        paperclipWake: {
          comments: [{ id: "review-comment-824", body: "Findings on #824." }],
        },
      },
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_comment",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 837,
        githubHeadSha: "2120c77c8633e98b186c592d0ddd0204cc6a8760",
        githubCommentId: "review-comment-837",
        commentId: "review-comment-837",
      },
    );

    expect(merged.githubPrNumber).toBe(837);
    expect(merged.githubHeadSha).toBe("2120c77c8633e98b186c592d0ddd0204cc6a8760");
    expect(merged.githubCommentId).toBe("review-comment-837");
    expect(merged.commentId).toBe("review-comment-837");
    expect(merged.wakeCommentId).toBe("review-comment-837");
    expect(merged.wakeCommentIds).toEqual(["review-comment-837"]);
    expect(merged.paperclipWake).toBeUndefined();
  });

  it("preserves inherited non-PR comment ids when the incoming wake names a different PR", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_review_feedback",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 824,
        githubHeadSha: "bfc470e81a12a3f52ac030b45a5e68949e119bc1",
        githubPrReviewBody: "Findings on #824.",
        githubReviewFeedbackActionable: true,
        githubReviewFeedbackCommentId: "pr-feedback-comment-824",
        commentId: "pr-feedback-comment-824",
        wakeCommentId: "pr-feedback-comment-824",
        wakeCommentIds: ["human-comment-1", "pr-feedback-comment-824"],
        paperclipWake: {
          comments: [
            { id: "human-comment-1", body: "Can someone check this part?" },
            {
              id: "pr-feedback-comment-824",
              body: "Findings on #824.",
              metadata: {
                kind: "github_pr_review_feedback",
                repoFullName: "Blockcast/paperclip",
                prNumber: 824,
              },
            },
          ],
        },
      },
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_ready_for_review",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 837,
        githubHeadSha: "2120c77c8633e98b186c592d0ddd0204cc6a8760",
        prRole: "author",
      },
    );

    expect(merged.githubPrNumber).toBe(837);
    expect(merged.githubHeadSha).toBe("2120c77c8633e98b186c592d0ddd0204cc6a8760");
    expect(merged.githubPrReviewBody).toBeUndefined();
    expect(merged.githubReviewFeedbackActionable).toBeUndefined();
    expect(merged.githubReviewFeedbackCommentId).toBeUndefined();
    expect(merged.commentId).toBe("human-comment-1");
    expect(merged.wakeCommentId).toBe("human-comment-1");
    expect(merged.wakeCommentIds).toEqual(["human-comment-1"]);
    expect(merged.paperclipWake).toBeUndefined();
  });

  it("keeps review context when both wakes are about the same PR", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 837,
        githubHeadSha: "2120c77c8633e98b186c592d0ddd0204cc6a8760",
        githubPrReviewBody: "Nit: rename the helper.",
        githubPrReviewAuthorLogin: "ally",
        prRole: "author",
      },
      {
        issueId: "issue-18829",
        wakeReason: "github_pr_synchronized",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 837,
        githubHeadSha: "8555702b54179d291f3283a449eaead3c4b08bc9",
        prRole: "author",
      },
    );

    expect(merged.githubPrNumber).toBe(837);
    expect(merged.githubHeadSha).toBe("8555702b54179d291f3283a449eaead3c4b08bc9");
    expect(merged.githubPrReviewBody).toBe("Nit: rename the helper.");
    expect(merged.githubPrReviewAuthorLogin).toBe("ally");
  });

  // BLO-30420. The declined-classification reason is written only when a
  // review is NOT actionable, under a conditional spread, so an actionable
  // review re-supplies neither key. If the two keys are not on the scrub
  // lists, a second review-instance wake coalescing onto the same run keeps
  // the earlier decline's reason next to `githubReviewFeedbackActionable:
  // true` -- the pair github-webhook.test.ts forbids for a single delivery --
  // and via the different-PR scrub the same reason crosses onto another PR.
  it("does not carry a stale suppression reason onto a later actionable review (BLO-30420)", () => {
    const declined = {
      issueId: "issue-1681",
      wakeReason: "github_pr_review_submitted",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 1681,
      githubHeadSha: "6f89faa8",
      githubPrReviewBody: "Findings header with no enumerable items.",
      githubPrReviewAuthorLogin: "allyblockcast[bot]",
      githubReviewFeedbackSuppressionReason: "ally_review_findings_unenumerable",
      githubReviewFeedbackSuppressionPredicate: "findings_header_without_items",
      prRole: "author",
    };

    // Same PR, next review instance, actionable this time.
    const samePr = mergeCoalescedContextSnapshot(declined, {
      issueId: "issue-1681",
      wakeReason: "github_pr_review_feedback",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 1681,
      githubHeadSha: "6f89faa8",
      githubPrReviewBody: "1 Important finding.",
      githubPrReviewAuthorLogin: "allyblockcast[bot]",
      githubReviewFeedbackActionable: true,
      prRole: "author",
    });
    expect(samePr.githubReviewFeedbackActionable).toBe(true);
    expect(samePr).not.toHaveProperty("githubReviewFeedbackSuppressionReason");
    expect(samePr).not.toHaveProperty("githubReviewFeedbackSuppressionPredicate");

    // Different PR routed to the same issue: the reason must not cross PRs.
    const otherPr = mergeCoalescedContextSnapshot(declined, {
      issueId: "issue-1681",
      wakeReason: "github_pr_ready_for_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 1699,
      githubHeadSha: "c9890150",
      prRole: "author",
    });
    expect(otherPr).not.toHaveProperty("githubReviewFeedbackSuppressionReason");
    expect(otherPr).not.toHaveProperty("githubReviewFeedbackSuppressionPredicate");
  });

  // BLO-22229. Reproduces the incident verbatim: a formal `kkroo` APPROVED
  // review is still the active run's context when Ally posts a *comment*-
  // shaped consolidated review carrying Critical findings on the SAME PR.
  // github-webhook.ts's issue_comment branch never sets a `reviewState` (only
  // a formal `pull_request_review` submission can), so the incoming wake
  // supplies a new `githubPrReviewAuthorLogin` (the comment author) but no
  // `githubPrReviewState` of its own. Before the fix, the naive `{...existing,
  // ...incoming}` spread kept the OLD APPROVED state paired with the NEW
  // comment author — composing a directive from two different GitHub events
  // that together describe a review that never happened, and telling the
  // author to merge a PR carrying unresolved Critical findings.
  it("does not weld a stale reviewState onto a same-PR comment-shaped review (BLO-22229)", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "LGTM.",
        githubPrReviewState: "approved",
        githubPrReviewAuthorLogin: "kkroo",
        prRole: "author",
      },
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_feedback",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "1 Critical + 2 Important findings.",
        githubPrReviewAuthorLogin: "allyblockcast[bot]",
        githubReviewFeedbackActionable: true,
        prRole: "author",
      },
    );

    // The incoming comment review's own fields win outright.
    expect(merged.githubPrReviewBody).toBe("1 Critical + 2 Important findings.");
    expect(merged.githubPrReviewAuthorLogin).toBe("allyblockcast[bot]");
    // The prior formal review's state must NOT survive paired with this
    // comment's author — it is cleared, not inherited, so the directive
    // falls back to neutral "posted findings" wording instead of a false
    // "state: APPROVED ... proceed to merge".
    expect(merged.githubPrReviewState).toBeUndefined();
  });

  it("retires superseded review-feedback comments on same-PR review replacement (BLO-22229)", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_feedback",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "1 Critical + 2 Important findings.",
        githubPrReviewAuthorLogin: "allyblockcast[bot]",
        githubReviewFeedbackActionable: true,
        githubReviewFeedbackCommentId: "pr-feedback-comment-1053",
        commentId: "pr-feedback-comment-1053",
        wakeCommentId: "pr-feedback-comment-1053",
        wakeCommentIds: ["human-comment-1", "pr-feedback-comment-1053"],
        paperclipWake: {
          comments: [
            { id: "human-comment-1", body: "Can someone check this part?" },
            {
              id: "pr-feedback-comment-1053",
              body: "1 Critical + 2 Important findings.",
              metadata: {
                kind: "github_pr_review_feedback",
                repoFullName: "Blockcast/paperclip",
                prNumber: 1053,
              },
            },
          ],
        },
        prRole: "author",
      },
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "LGTM.",
        githubPrReviewState: "approved",
        githubPrReviewAuthorLogin: "kkroo",
        prRole: "author",
      },
    );

    expect(merged.githubPrReviewBody).toBe("LGTM.");
    expect(merged.githubPrReviewState).toBe("approved");
    expect(merged.githubPrReviewAuthorLogin).toBe("kkroo");
    expect(merged.githubReviewFeedbackActionable).toBeUndefined();
    expect(merged.githubReviewFeedbackCommentId).toBeUndefined();
    expect(merged.commentId).toBe("human-comment-1");
    expect(merged.wakeCommentId).toBe("human-comment-1");
    expect(merged.wakeCommentIds).toEqual(["human-comment-1"]);
    expect(merged.paperclipWake).toBeUndefined();
  });

  it("clears stale review-feedback comment routing when none survives same-PR review replacement", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_feedback",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "1 Critical + 2 Important findings.",
        githubPrReviewAuthorLogin: "allyblockcast[bot]",
        githubReviewFeedbackActionable: true,
        githubReviewFeedbackCommentId: "pr-feedback-comment-1053",
        commentId: "pr-feedback-comment-1053",
        wakeCommentId: "pr-feedback-comment-1053",
        wakeCommentIds: ["pr-feedback-comment-1053"],
        paperclipWake: {
          comments: [
            {
              id: "pr-feedback-comment-1053",
              body: "1 Critical + 2 Important findings.",
              metadata: {
                kind: "github_pr_review_feedback",
                repoFullName: "Blockcast/paperclip",
                prNumber: 1053,
              },
            },
          ],
        },
        prRole: "author",
      },
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubHeadSha: "82f168065",
        githubPrReviewBody: "LGTM.",
        githubPrReviewState: "approved",
        githubPrReviewAuthorLogin: "kkroo",
        prRole: "author",
      },
    );

    expect(merged.githubPrReviewBody).toBe("LGTM.");
    expect(merged.githubPrReviewState).toBe("approved");
    expect(merged.githubPrReviewAuthorLogin).toBe("kkroo");
    expect(merged.githubReviewFeedbackActionable).toBeUndefined();
    expect(merged.githubReviewFeedbackCommentId).toBeUndefined();
    expect(merged.commentId).toBeUndefined();
    expect(merged.wakeCommentId).toBeUndefined();
    expect(merged.wakeCommentIds).toBeUndefined();
    expect(merged.paperclipWake).toBeUndefined();
  });

  // Companion: a genuine second formal review (APPROVED -> CHANGES_REQUESTED
  // on the same PR) must fully replace the prior review's state, not merge
  // fields across the two submissions either.
  it("a new formal review submission fully replaces the prior one's state (BLO-22229)", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubPrReviewBody: "LGTM.",
        githubPrReviewState: "approved",
        githubPrReviewAuthorLogin: "kkroo",
        prRole: "author",
      },
      {
        issueId: "issue-1053",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1053,
        githubPrReviewState: "changes_requested",
        githubPrReviewAuthorLogin: "allyblockcast[bot]",
        prRole: "author",
      },
    );

    expect(merged.githubPrReviewState).toBe("changes_requested");
    expect(merged.githubPrReviewAuthorLogin).toBe("allyblockcast[bot]");
    // The new review carried no body — the old review's body must not survive
    // paired with the new state/author.
    expect(merged.githubPrReviewBody).toBeUndefined();
  });

  // Same PR number, different repository — the identity key is (repo, number),
  // not the number alone.
  it("treats the same PR number in a different repo as a different PR", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 42,
        githubPrReviewBody: "Findings on paperclip#42.",
      },
      {
        issueId: "issue-1",
        githubRepoFullName: "Blockcast/frr",
        githubPrNumber: 42,
        githubHeadSha: "deadbeef",
      },
    );

    expect(merged.githubRepoFullName).toBe("Blockcast/frr");
    expect(merged.githubPrReviewBody).toBeUndefined();
  });

  it("leaves the GitHub block alone when the incoming wake is not PR-shaped", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 824,
        githubPrReviewBody: "Findings on #824.",
        prRole: "author",
      },
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
        commentId: "comment-1",
      },
    );

    expect(merged.githubPrNumber).toBe(824);
    expect(merged.githubPrReviewBody).toBe("Findings on #824.");
  });

  it("preserves a terminal external resume signal when a later wake is coalesced", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "github_check_suite_completed",
      },
      {
        issueId: "issue-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.wakeReason).toBe("issue_commented");
    expect(merged.externalWaitResumeRequested).toBe(true);
  });

  // parseObject returns its argument by reference when that argument is already
  // an object, so a clear implemented against `existing` would corrupt the
  // caller's persisted snapshot.
  it("does not mutate the caller's existing snapshot", () => {
    const existing = {
      issueId: "issue-1",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 824,
      githubPrReviewBody: "Findings on #824.",
    };

    mergeCoalescedContextSnapshot(existing, {
      issueId: "issue-1",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 837,
    });

    expect(existing.githubPrNumber).toBe(824);
    expect(existing.githubPrReviewBody).toBe("Findings on #824.");
  });

  // BLO-32634. The four cases below are one unit: the first two are the
  // load-bearing pair. Dropping the guard block unconditionally would make the
  // first pass and the second fail, which is the non-fix this issue rules out.
  //
  // `statusOnlyRecoveryRunContext` mirrors the snapshot that
  // recovery/service.ts's `source_scoped_recovery_action` wake persists, and
  // `monitorWakeContext` mirrors what `dispatchClaimedIssueMonitor` builds.
  const statusOnlyRecoveryRunContext = () =>
    withRecoveryModelProfileHint({
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "source_scoped_recovery_action",
      source: "issue_recovery_action",
      recoveryActionId: "recovery-1",
      sourceIssueId: "issue-1",
      recoveryCause: "stranded_assigned_issue",
    }, "status_only");

  const monitorWakeContext = () =>
    withRecoveryModelProfileHint({
      issueId: "issue-1",
      source: "issue.monitor",
      wakeReason: "issue_monitor_due",
      nextCheckAt: "2026-09-08T02:00:00.000Z",
      monitorAttemptCount: 1,
      monitorNotes: null,
      manualTrigger: false,
    }, "normal_model");

  // A monitor fire coalescing into a run row already stamped status-only used to
  // inherit the whole guard tuple through `{...existing, ...incoming}`, because
  // the drop-lists above cover only GitHub keys. The monitor's own scheduled work
  // was then write-refused by `isStatusOnlyCheapRecoveryContext`
  // (routes/issues.ts) — the monitor could not do the thing it was armed to do.
  it("does not let an explicit normal-model wake inherit the status-only recovery guard", () => {
    const merged = mergeCoalescedContextSnapshot(
      statusOnlyRecoveryRunContext(),
      monitorWakeContext(),
    );

    expect(merged.recoveryIntent).toBeUndefined();
    expect(merged.modelProfile).toBeUndefined();
    expect(merged.allowDeliverableWork).toBeUndefined();
    expect(merged.allowDocumentUpdates).toBeUndefined();
    expect(merged.resumeRequiresNormalModel).toBeUndefined();
    // The monitor's own fields survive: this is a class drop, not a wipe.
    expect(merged.wakeReason).toBe("issue_monitor_due");
    expect(merged.monitorAttemptCount).toBe(1);
    // Inherited non-guard recovery context is not this block's business.
    expect(merged.recoveryActionId).toBe("recovery-1");
  });

  // The sign guard. An incoming wake that says nothing about run class must not
  // clear the guard off a genuinely status-only run: silence is not a normal-model
  // declaration.
  it("keeps the status-only recovery guard when the incoming wake is silent about run class", () => {
    const merged = mergeCoalescedContextSnapshot(statusOnlyRecoveryRunContext(), {
      issueId: "issue-1",
      commentId: "comment-1",
      wakeCommentId: "comment-1",
      wakeReason: "issue_commented",
    });

    expect(merged).toMatchObject({
      recoveryIntent: "status_only",
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
  });

  it("applies the status-only guard when the recovery wake is the incoming one", () => {
    const merged = mergeCoalescedContextSnapshot(
      { issueId: "issue-1", wakeReason: "issue_commented" },
      statusOnlyRecoveryRunContext(),
    );

    expect(merged).toMatchObject({
      recoveryIntent: "status_only",
      modelProfile: "cheap",
      resumeRequiresNormalModel: true,
    });
  });

  // Mutual exclusivity across the coalesce. `planning_only` never supplies
  // `modelProfile`, so before the class drop the inherited `cheap` rode along
  // beside `recoveryIntent: planning_only` — a tuple no caller can construct
  // directly, and one that trips neither guard predicate cleanly.
  it("does not leave a partial guard tuple when the run class changes", () => {
    const merged = mergeCoalescedContextSnapshot(
      statusOnlyRecoveryRunContext(),
      withRecoveryModelProfileHint({
        issueId: "issue-1",
        wakeReason: "successful_run_handoff",
      }, "planning_only"),
    );

    expect(merged.modelProfile).toBeUndefined();
    expect(merged).toMatchObject({
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
    });
  });

  // Same hazard as the GitHub-key case above, pinned for the guard block: a
  // clear implemented against `existing` rather than `merged` would strip the
  // guard off the still-queued run row this snapshot came from.
  it("does not mutate the caller's existing snapshot when dropping the guard block", () => {
    const existing = statusOnlyRecoveryRunContext();

    mergeCoalescedContextSnapshot(existing, monitorWakeContext());

    expect(existing.recoveryIntent).toBe("status_only");
    expect(existing.modelProfile).toBe("cheap");
    expect(existing.resumeRequiresNormalModel).toBe(true);
  });
});

// PEN-3275. The run's write-containment class reaches the agent through the task markdown —
// the one surface it reads before planning. Previously it was stated only in a 403, i.e. after
// the agent had committed to work the run cannot perform.
describe("buildPaperclipTaskMarkdown run write-containment notice", () => {
  const issue = {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Do the thing",
    workMode: "standard",
    description: null,
  };

  it("announces a status-only run and names its reachable exits", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE });

    expect(markdown).toContain("Run write-containment notice:");
    expect(markdown).toContain("cheap status-only recovery run");
    expect(markdown).toContain("`request_board_approval`");
    // The "waiting never ends" clause, carried verbatim from the 403's shared guidance.
    expect(markdown).toContain(STATUS_ONLY_RESUME_PREAMBLE);
  });

  // The no-source text reaches this frame on an ordinary run — `resolveStaleRunSourceIssue`
  // returns null for a silent unscoped heartbeat — and it is the text that must NOT offer a
  // filing. Asserted at the markdown level and not only at the notice level: the frame is what
  // the agent actually reads, and a clause dropped between the two would be invisible upstream.
  it("carries the no-source status-only text through the markdown frame without offering a filing", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      recoveryRunWriteClassNotice: STATUS_ONLY_NO_SOURCE_NOTICE,
    });

    expect(markdown).toContain("Run write-containment notice:");
    expect(markdown).toContain("no approval write available at all");
    expect(markdown).toContain(STATUS_ONLY_RESUME_PREAMBLE);
    // The shared constant's own exit clause is unconditional, so the frame must not carry it here.
    expect(markdown).not.toContain("You may also file a `request_board_approval`");
    expect(markdown).not.toMatch(/only approval write this run can perform/);
  });

  // The refusal list must name the OPERATION, not just the object. `approvals.ts` passes
  // `requestedType` at the create call site only, so commenting on / resubmitting / withdrawing /
  // applying an approval compares `undefined` against the permitted type and refuses — on the
  // run's own escalation included. PEN-3248's false record was exactly an approval comment, so a
  // notice that named only "creating or modifying approvals (except a `request_board_approval` …)"
  // pointed the reader into the one 403 this notice exists to pre-empt.
  //
  // PEN-3275 round 6: iterated over `REFUSED_APPROVAL_OPERATIONS` rather than over a literal copy
  // of it. The hand-maintained copy that used to live here listed three of the seven operations,
  // which is how `applying` stayed unannounced while the guard refused it — a list that names a
  // subset cannot fail when the subset is wrong.
  it("names the approval operations it cannot follow its own escalation up with", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE });

    for (const operation of REFUSED_APPROVAL_OPERATIONS) {
      expect(markdown).toContain(operation);
    }
    expect(markdown).toContain("this run may itself file");
    expect(markdown).toContain("not to comment on what you just filed");
    expect(markdown).toContain("not to apply it");
  });

  // `assertCheapRecoveryIssueAssigneeProfileAllowed` (`issues.ts:6813`) is a status-only refusal
  // that the first draft's enumeration omitted. The list presents itself as exhaustive, so an
  // omission is worse than an explicitly partial list — it licenses planning around what is absent.
  it("names the cheap-assignee-profile refusal, and scopes it to status-only", () => {
    expect(buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE }))
      .toContain("assigning downstream issue work to the cheap model profile");
    // The guard does not consult the planning-only predicate, so announcing it there would
    // describe a refusal that does not exist.
    expect(buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: PLANNING_ONLY_NOTICE }))
      .not.toContain("cheap model profile");
  });

  it("announces a planning-only run as document-capable but approval-barred", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: PLANNING_ONLY_NOTICE });

    expect(markdown).toContain("planning-only recovery run");
    expect(markdown).toContain("Issue document updates are permitted.");
    // The `planningOnly` branch refuses ahead of the type check, so unlike status-only this lane
    // has no approval exit at all. Announcing one would be a promise the guard breaks.
    expect(markdown).toContain("no `request_board_approval` exception on this lane");
  });

  // The notice must not assert WHY the run is contained. `successful-run-handoff.ts` selects
  // `planning_only` as `workMode === "planning" || Boolean(run.statusOnlyDocumentWriteRefusedAt)`;
  // the `workMode` arm involves no refusal and stamps nothing, so an "escalated after a refusal"
  // opener is false for a reachable run — an agent reading a prior-run event that never happened,
  // on the one lane whose notice tells it to confirm before claiming. Pinned because the earlier
  // draft carried exactly that clause and nothing failed when it did.
  it("does not claim a refusal caused the planning-only escalation", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: PLANNING_ONLY_NOTICE });

    expect(markdown).not.toContain("escalated after");
    expect(markdown).not.toContain("was refused a document write");
  });

  // The notice is a system-generated containment constraint rendered inside a block whose preamble
  // declares its contents user-authored and overridable by higher-priority instructions. Without
  // this line an agent may discount the one statement that is not negotiable.
  it("marks the notice as system-generated rather than user-authored task data", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE });

    expect(markdown).toContain("System-generated, not user-authored task data.");
    expect(markdown).toContain("not a preference you can decline");
  });

  // Silence must stay the default for an unconstrained run: a notice on every wake would be
  // noise, and worse, would make the constrained case unremarkable.
  it("says nothing on an unconstrained run", () => {
    for (const markdown of [
      buildPaperclipTaskMarkdown({ issue }),
      buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: null }),
    ]) {
      expect(markdown).not.toContain("Run write-containment notice:");
    }
  });

  // The containment binds the RUN, so the class alone must defeat the `return null` early exit —
  // every other test here passes `issue`, which satisfies that guard on its own and leaves the
  // `!input.recoveryRunWriteClassNotice` clause never exercised. Delete that clause and only this fails.
  // `issue` is a required key on the input (`| null`, not `?`), so it is stated explicitly rather
  // than omitted; a wake with no issue context passes `null`, as the prReview cases above do.
  it("announces on a wake carrying no issue, comment or PR context at all", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue: null, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE });

    expect(markdown).not.toBeNull();
    expect(markdown).toContain("Run write-containment notice:");
    expect(markdown).toContain("cheap status-only recovery run");
    // PEN-3275: on this path the block holds the notice and nothing else, so the closing line
    // must not call it an assignment — there is none to point at.
    expect(markdown).toContain("This block carries no assignment");
    expect(markdown).not.toContain("Use this task context as the current assignment.");
    // PEN-3275 round 8: the PREAMBLE is the other half of the same selection, and it is the half
    // that reverts silently — collapsing it back to the fixed user-authored string left the whole
    // suite green. It matters more than the closing line: on this path the block IS the containment
    // notice, so a preamble calling it user-authored and overridable invites the agent to discount
    // the one statement in it that is not negotiable. The inline restatement below the notice does
    // not cover this — it fires on both branches and sits AFTER the frame the agent reads first.
    expect(markdown).toContain("The following block is system-generated");
    expect(markdown).not.toContain("The following task data is user-authored");
  });

  // The converse, so the selection cannot collapse to the no-assignment line for every wake.
  it("keeps the assignment closing line when the block does carry an assignment", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue, recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE });

    expect(markdown).toContain("Use this task context as the current assignment.");
    expect(markdown).not.toContain("This block carries no assignment");
    // The preamble's converse, for the same reason: pinning only the no-issue side would be
    // satisfied by hardcoding the system-generated string, which would then mislabel every
    // ordinary wake's genuinely user-authored task data as system-generated.
    expect(markdown).toContain("The following task data is user-authored");
    expect(markdown).not.toContain("The following block is system-generated");
  });

  // `ancestors` is the one user-authored block not gated on issue/wakeComment/prReview — the
  // ancestor block renders identifiers and titles on `ancestors.length > 0` alone. Unreachable at
  // today's sole production call site, which derives `ancestors` and `issue` from one `issueRef`,
  // but the function is EXPORTED and the invariant lives in the caller. Pinned rather than left to
  // that invariant, because dropping the `ancestors` term is precisely the silent revert this
  // round's Important was about: without this, deleting it leaves the suite green while
  // user-authored ancestor titles render under a preamble calling the block system-generated.
  it("treats a block carrying only ancestors and a notice as user-authored", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      ancestors: [{ id: "issue-parent", identifier: "PEN-1", title: "Parent title" }],
      recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE,
    });

    // The user-authored ancestor title does render on this path — which is why the frame matters.
    expect(markdown).toContain("Parent title");
    expect(markdown).toContain("The following task data is user-authored");
    expect(markdown).not.toContain("The following block is system-generated");
  });

  // End-to-end in the direction that matters: the snapshot a recovery wake actually persists
  // must classify, so the announcement fires on the real payload rather than only on a literal.
  it("fires on the snapshot a source_scoped_recovery_action wake persists", () => {
    const context = withRecoveryModelProfileHint({
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "source_scoped_recovery_action",
      source: "issue_recovery_action",
      recoveryActionId: "recovery-1",
      sourceIssueId: "issue-1",
      recoveryCause: "stranded_assigned_issue",
    }, "status_only");

    const markdown = buildPaperclipTaskMarkdown({
      issue,
      recoveryRunWriteClassNotice: recoveryRunWriteClassNotice(context),
    });

    expect(markdown).toContain("cheap status-only recovery run");
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});

// BLO-23395: PR #1092 sat evicted from the merge queue for 9h13m unnoticed
// because an un-stageable rebase evicts a queue entry with zero merge_group
// runs, no failing check, and no comment. `github_pr_merge_queue_evicted` is
// the wake that closes that gap; these cover the three things that have to
// hold for it to be useful rather than misleading.
describe("merge-queue eviction wake (BLO-23395)", () => {
  const evictionNotice = [
    "<!-- paperclip:merge-queue-eviction -->",
    "**Blockcast/paperclip#1092 was removed from the merge queue without merging.**",
    "Cause: `conflict_unstageable` (0 merge_group runs for this attempt). Refs: BLO-23395",
  ].join("\n");

  it("surfaces the eviction notice body from the contextSnapshot", () => {
    // Ally review #1220: the webhook writes githubMergeQueueEvictionBody so
    // "the woken agent doesn't have to fetch githubEventUrl just to learn
    // why". That goal is only met once something reads the key.
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_merge_queue_evicted",
        githubPrNumber: 1092,
        githubRepoFullName: "Blockcast/paperclip",
        githubEvent: "issue_comment",
        prRole: "author",
        githubMergeQueueEvictionBody: evictionNotice,
      }),
    ).toMatchObject({
      wakeReason: "github_pr_merge_queue_evicted",
      prNumber: 1092,
      mergeQueueEvictionBody: evictionNotice,
    });
  });

  it("renders an eviction directive with the cause inline, and never the false-findings text", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "BLO-23395",
        title: "Merge-queue silent eviction has no alert",
        workMode: null,
        description: null,
      },
      prReview: {
        wakeReason: "github_pr_merge_queue_evicted",
        prNumber: 1092,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        prAuthorLogin: "allyblockcast[bot]",
        mergeQueueEvictionBody: evictionNotice,
      },
    });

    expect(markdown).toContain("GitHub merge-queue eviction directive:");
    expect(markdown).toContain("was REMOVED from the merge queue without being merged");
    expect(markdown).toContain("The eviction notice:");
    expect(markdown).toContain("conflict_unstageable");
    // No review exists on this wake. It must never reach the review-feedback
    // directive, which would tell the author a reviewer posted findings and
    // to push a follow-up commit (the BLO-19522/BLO-20886 damage path).
    expect(markdown).not.toContain("GitHub PR review feedback directive:");
    expect(markdown).not.toContain("just posted findings");
    // Nor the generic author-lifecycle directive, which is true but useless
    // here -- it says only that no review findings are recorded.
    expect(markdown).not.toContain("GitHub PR event directive:");
  });

  it("does not tell the woken agent to rebase a third party's PR (BLO-20886)", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_merge_queue_evicted",
        prNumber: 1092,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        // "author-directed" means the PR is owned by this agent's ISSUE; the
        // PR itself can have a human author, linked only by a BLO- ref.
        prAuthorLogin: "kkroo",
        mergeQueueEvictionBody: evictionNotice,
      },
    });

    expect(markdown).toContain("GitHub merge-queue eviction directive:");
    expect(markdown).toContain("NOT by you");
    expect(markdown).toContain("Do NOT push to its branch or re-enqueue it");
    expect(markdown).not.toContain("and re-enqueue.");
  });

  it("gates the own-PR remedy on a standing-hold re-read, and never presents itself as authorisation (PEN-5119)", () => {
    // Blockcast/paperclip#3205: a "no push to this head" instruction was
    // standing and recorded in the issue's monitor note. This directive woke
    // the assignee with "rebase the branch ... and re-enqueue"; the assignee
    // confirmed the diagnosis (correct) and executed the remedy as though the
    // directive authorised it, force-pushing over the frozen head. The remedy
    // must therefore be reachable only after an explicit hold re-read.
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_merge_queue_evicted",
        prNumber: 3205,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        prAuthorLogin: "allyblockcast[bot]",
        mergeQueueEvictionBody: evictionNotice,
      },
    });

    expect(markdown).toContain("GitHub merge-queue eviction directive:");
    // It must disclaim its own authority...
    expect(markdown).toContain("NOT an authorisation");
    expect(markdown).toContain("cannot grant, widen or retract one");
    // ...name both cheap records of a standing hold...
    expect(markdown).toContain("monitor note");
    expect(markdown).toContain("the last comment you yourself posted about this PR");
    // ...cover every write verb, not just the one the directive suggests...
    expect(markdown).toContain("force-push");
    expect(markdown).toContain("review-request removal");
    // ...and make reporting, not remedying, the action when a hold stands.
    expect(markdown).toContain("REPORT the eviction, not to remedy it");
    // The remedy still exists -- it is gated, not removed.
    expect(markdown).toContain("and re-enqueue.");
  });

  it("points at the event URL when the notice body was not captured", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_merge_queue_evicted",
        prNumber: 1092,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        prAuthorLogin: "allyblockcast[bot]",
        eventUrl: "https://github.com/Blockcast/paperclip/pull/1092#issuecomment-1",
      },
    });

    expect(markdown).toContain("GitHub merge-queue eviction directive:");
    expect(markdown).toContain("eviction notice body was not captured");
    expect(markdown).toContain("#issuecomment-1");
  });

  it("drops a cross-PR eviction body on coalesce (BLO-19118)", () => {
    // The key is registered in GITHUB_PR_CONTEXT_KEYS, so a wake naming a
    // different PR cannot inherit PR #1092's eviction cause and render it as
    // PR #1220's.
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "github_pr_merge_queue_evicted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1092,
        githubMergeQueueEvictionBody: evictionNotice,
        prRole: "author",
      },
      {
        issueId: "issue-1",
        wakeReason: "github_pr_review_submitted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1220,
        githubPrReviewBody: "0 Critical / 2 Important.",
        githubPrReviewAuthorLogin: "allyblockcast[bot]",
        prRole: "author",
      },
    );

    expect(merged.githubPrNumber).toBe(1220);
    expect(merged.githubMergeQueueEvictionBody).toBeUndefined();
  });

  it("does not inherit a previous eviction's cause on a same-PR re-eviction", () => {
    // A PR can be evicted more than once (failing check, fix, then an
    // un-stageable rebase). Each eviction wake owns the notice block, same
    // rule as BLO-22229's review-content block -- otherwise a wake whose
    // notice comment was not captured renders the PRIOR eviction's cause.
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        wakeReason: "github_pr_merge_queue_evicted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1092,
        githubMergeQueueEvictionBody: "Cause: `check_failure` (1 failing merge_group run).",
        prRole: "author",
      },
      {
        issueId: "issue-1",
        wakeReason: "github_pr_merge_queue_evicted",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 1092,
        prRole: "author",
      },
    );

    expect(merged.githubMergeQueueEvictionBody).toBeUndefined();
  });
});

describe("triggered-monitor exits directive (PEN-6271)", () => {
  const issue = {
    id: "issue-6271",
    identifier: "PEN-6271",
    title: "A run that deliberately stops polling has no way to say so",
    workMode: "standard",
    description: null,
  };

  // The measurement this directive exists for. PEN-6271, 2026-11-09, over a census
  // paged to exhaustion: of 286 `trigger_stalled` clears, 87 (30.4%) were rows whose
  // woken run `succeeded` -- it started after the fire, wrote to the row, and finished
  // before the sweep -- against 15 (5.2%) whose run `failed`/`cancelled`. The dominant
  // reader is therefore a run about to make the right decision and express it the wrong
  // way, so the exits have to be stated BEFORE the run ends, not in the recovery comment
  // that is minted once it is too late.
  it("names both exits, and the cost of taking neither, when the monitor is triggered", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      triggeredMonitor: {
        lastTriggeredAt: "2026-11-08T19:30:27.629Z",
        attemptCount: 4,
        maxAttempts: 24,
        serviceName: "github-pr-human-approval",
      },
    });

    expect(markdown).toContain("Triggered monitor -- the two exits that discharge it:");
    // Each exit pinned INDIVIDUALLY. A test that pinned only the heading would pass
    // against a section that had quietly lost one of the two, which is the whole
    // failure this directive addresses.
    expect(markdown).toContain("`paperclipSetIssueMonitor`");
    expect(markdown).toContain("`paperclipClearIssueMonitor(issueId)`");
    // ...and the consequence, which is the half that makes "do nothing" legible as a
    // choice with a price rather than as a neutral default.
    expect(markdown).toContain("`trigger_stalled`");
    expect(markdown).toContain("byte-identical to this run having died");
    // The row's own facts, so the run can tell which monitor is meant.
    expect(markdown).toContain("fired 2026-11-08T19:30:27.629Z");
    expect(markdown).toContain("attempt 4/24");
    expect(markdown).toContain("waiting on `github-pr-human-approval`");
  });

  // Discrimination. The gate has to be able to say NO, or it is not a gate -- and an
  // unconditional version of this block would be standing noise on every wake, which is
  // how a directive stops being read.
  it("is absent when no monitor is triggered", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).not.toContain("Triggered monitor -- the two exits");
    expect(markdown).not.toContain("`paperclipClearIssueMonitor(issueId)`");
    // Control: the block that IS unconditional still renders, so this is a scoped
    // absence and not an empty build.
    expect(markdown).toContain("Pre-write re-read directive:");
  });

  // The GATE itself, not just the rendering. Ally's review of this PR caught the
  // original helper reading `executionState.monitor.status` directly while three
  // comments claimed it derived the state the sweep tests -- and nothing failed,
  // because every test above passes `triggeredMonitor` in by hand and so exercises
  // the caller rather than the derivation that decides it.
  //
  // `derivePersistedMonitorState` gives the `monitor*` COLUMNS precedence over the
  // JSON, so these cases pin the two readings apart. A JSON-only implementation
  // passes the first and fails the second and third.
  describe("triggeredMonitorForPrompt", () => {
    const base = { status: "in_progress", assigneeAgentId: "agent-1", executionPolicy: null };
    // `issueExecutionMonitorStateSchema` requires `nextCheckAt`, `notes`,
    // `scheduledBy`, `clearedAt` and `clearReason` to be PRESENT (nullable, not
    // prefaulted), so a hand-built partial monitor fails `parseIssueExecutionState`
    // and the whole state parses to null. That is the fail-closed direction -- the
    // directive is simply not emitted -- but it would make these cases pass for the
    // wrong reason, so the fixture carries the full persisted shape.
    // `issueExecutionStateSchema` likewise requires the stage fields to be PRESENT
    // (nullable, not prefaulted), so `{ monitor }` alone parses to null and every
    // case below would pass for the wrong reason. This is the shape a real row
    // carries.
    const executionStateWith = (monitor: Record<string, unknown> | null) => ({
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor,
    });
    const monitorState = (overrides: Record<string, unknown>) => ({
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: null,
      scheduledBy: "assignee",
      clearedAt: null,
      clearReason: null,
      ...overrides,
    });

    it("derives a triggered monitor from executionState", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        executionState: executionStateWith(monitorState({
          lastTriggeredAt: "2026-11-08T19:30:27.629Z",
          attemptCount: 4,
          maxAttempts: 24,
          serviceName: "github-pr-human-approval",
        })),
      })).toMatchObject({
        lastTriggeredAt: "2026-11-08T19:30:27.629Z",
        attemptCount: 4,
        maxAttempts: 24,
        serviceName: "github-pr-human-approval",
      });
    });

    // THE case that separates the derived reading from the JSON one. A live
    // `monitorNextCheckAt` means the monitor is scheduled again -- there is no
    // outstanding obligation -- however stale the JSON still reads. A JSON-only
    // helper emits the directive here, claiming an obligation the sweep does not
    // see, which is the exact failure the comments promised could not happen.
    it("returns null when the COLUMN says the monitor is scheduled again", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        monitorNextCheckAt: new Date("2026-11-09T00:00:00.000Z"),
        executionState: executionStateWith(monitorState({ lastTriggeredAt: "2026-11-08T19:30:27.629Z", attemptCount: 4 })),
      })).toBeNull();
    });

    // The other direction: the columns can carry a triggered monitor whose
    // `executionState.monitor` is absent, and the sweep reaps those too. A
    // JSON-only helper stays silent about an obligation that does exist.
    it("derives a triggered monitor from the columns with no executionState", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        monitorLastTriggeredAt: new Date("2026-11-08T19:30:27.629Z"),
        monitorAttemptCount: 2,
        executionState: null,
      })).toMatchObject({ lastTriggeredAt: "2026-11-08T19:30:27.629Z", attemptCount: 2 });
    });

    it("returns null for a cleared monitor and for no row at all", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        executionState: executionStateWith(monitorState({ status: "cleared", clearReason: "manual", clearedAt: "2026-11-08T20:00:00.000Z" })),
      })).toBeNull();
      expect(triggeredMonitorForPrompt(null)).toBeNull();
    });

    // PEN-6553. The three cases below all carry a live `monitorNextCheckAt`, so
    // they are indistinguishable to the derived status -- every one reads
    // `scheduled`. `monitorWakeRequestedAt` is the claim marker that separates
    // them, and it is why this gate is not keyed on the wake reason: it is read
    // off the ROW.
    const scheduledPolicy = (overrides: Record<string, unknown> = {}) => ({
      mode: "normal",
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: "2026-11-09T00:00:00.000Z",
        notes: "waiting on the merge",
        scheduledBy: "assignee",
        serviceName: "github-pr-human-approval",
        maxAttempts: 24,
        ...overrides,
      },
    });

    // Byte-identical across the two assertions below, so it is stated once.
    // They stay TWO tests on purpose: they pin two independent claims about one
    // call -- that the obligation is derived at all, and that the two facts the
    // patch has not written are withheld -- and a merged assertion reports a
    // regression in either under a name describing the other.
    const claimedFireRow = {
      ...base,
      executionPolicy: scheduledPolicy(),
      monitorNextCheckAt: new Date("2026-11-09T00:00:00.000Z"),
      monitorWakeRequestedAt: new Date("2026-11-09T00:00:01.000Z"),
      monitorAttemptCount: 3,
      monitorLastTriggeredAt: new Date("2026-11-08T23:00:00.000Z"),
      executionState: null,
    };

    // THE defect this repairs. The fire has been CLAIMED but its triggered patch
    // has not committed, which is the row a fast dispatch reads -- measured at
    // 7.56-22 s after the claim, and 7 of 15 monitor wakes on one seat landed
    // inside it. Before PEN-6553 this returned null and the run held the
    // obligation for its whole life with the directive never emitted.
    it("derives an obligation while the fire is claimed and the triggered patch has not landed", () => {
      expect(triggeredMonitorForPrompt(claimedFireRow)).toMatchObject({ serviceName: "github-pr-human-approval", maxAttempts: 24 });
    });

    // The two facts the triggered patch WRITES are not written yet, so the
    // columns still hold the PREVIOUS fire's instant and the PRE-increment
    // count. Rendering either would state a fact that is wrong rather than
    // missing, so both are withheld and the renderer omits them.
    it("withholds the two facts the triggered patch has not written yet", () => {
      expect(triggeredMonitorForPrompt(claimedFireRow)).toMatchObject({ lastTriggeredAt: null, attemptCount: null });
    });

    // The arm that must stay SILENT, and the reason a bare
    // `wakeReason === "issue_monitor_due"` gate was refused: after the 15-minute
    // dispatch-lapse watchdog re-arms, `tickExpiredIssueMonitors` selects on
    // `isNull(monitorNextCheckAt)` and can no longer reach the row, so there is
    // no obligation to announce. Every re-arm builder nulls the claim marker,
    // which is exactly what makes this row distinguishable from the one above.
    it("stays silent once a re-arm has released the claim", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        executionPolicy: scheduledPolicy({ nextCheckAt: "2026-11-09T00:15:00.000Z" }),
        monitorNextCheckAt: new Date("2026-11-09T00:15:00.000Z"),
        monitorWakeRequestedAt: null,
        monitorAttemptCount: 4,
        monitorLastTriggeredAt: new Date("2026-11-09T00:00:02.000Z"),
        executionState: null,
      })).toBeNull();
    });

    // The dispatch-lapse watchdog re-arms the row under its OWN service name, and
    // when that monitor comes due it is claimed exactly like any other -- so both
    // columns are set again and the claim branch would otherwise fire. It must
    // not: that arm of `dispatchClaimedIssueMonitor` calls
    // `startNextQueuedRunForAgent` itself, so the watched run's prompt is built
    // inside this very window by construction, and every exit from the arm is a
    // clear or a re-arm, never a trigger. Announcing an obligation there is the
    // FALSE directive this gate exists to avoid.
    //
    // The service name is written as a literal rather than imported because the
    // constant is module-private, and because the literal is what the watchdog
    // arm and this guard must agree on -- the wire value is the contract.
    it("stays silent while a dispatch-watchdog fire is claimed", () => {
      expect(triggeredMonitorForPrompt({
        ...claimedFireRow,
        executionPolicy: scheduledPolicy({ serviceName: "paperclip_monitor_dispatch" }),
      })).toBeNull();
    });

    // A claim marker alone is not an obligation. Nothing writes this shape today
    // -- the cleared patch nulls both columns together -- but the branch is
    // keyed on `scheduled`, not on the marker, and this pins that.
    it("stays silent when a claim marker survives on a row with no armed check", () => {
      expect(triggeredMonitorForPrompt({
        ...base,
        monitorNextCheckAt: null,
        monitorWakeRequestedAt: new Date("2026-11-09T00:00:01.000Z"),
        executionState: executionStateWith(monitorState({ status: "cleared", clearReason: "manual", clearedAt: "2026-11-08T20:00:00.000Z" })),
      })).toBeNull();
    });
  });

  // A monitor can be triggered with none of its descriptive fields populated. The
  // parenthetical must then be omitted entirely rather than rendered empty: a bare
  // "()" reads as the gate having fired on a row with no monitor, which would teach
  // the fleet that the gate means nothing.
  it("omits the parenthetical rather than emitting an empty one", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      triggeredMonitor: {
        lastTriggeredAt: null,
        attemptCount: null,
        maxAttempts: null,
        serviceName: null,
      },
    });

    expect(markdown).toContain("Triggered monitor -- the two exits that discharge it:");
    expect(markdown).toContain("is sitting `triggered`. It stays `triggered`");

    // Scoped to THIS directive's own fact line on purpose. The assertion used to
    // range over the WHOLE markdown, which quietly made it a tripwire on every
    // other directive: #3665 (PEN-6435) landed a `python3 -I -c "... .read()"`
    // recipe in the constraint-recording block at 2026-11-11T17:07Z and reddened
    // `General tests (server 1/6)` repo-wide on a property this test does not own.
    // `toBeDefined` first so a `find` that matches nothing fails here rather than
    // passing the `not.toContain` vacuously on `undefined`.
    const factLine = markdown
      .split("\n")
      .find((line) => line.startsWith("This row's monitor has FIRED"));
    expect(factLine).toBeDefined();
    expect(factLine).not.toContain("()");
  });

  // `attemptCount` without `maxAttempts` is a real shape (the bound defaults), and the
  // "/" separator must not be emitted with nothing after it.
  it("renders an attempt count with no declared ceiling", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      triggeredMonitor: {
        lastTriggeredAt: null,
        attemptCount: 2,
        maxAttempts: null,
        serviceName: null,
      },
    });

    // Same scoping as the sibling case above, for the same reason: the negative
    // belongs to this directive's fact line, not to every directive on the wake.
    const factLine = markdown
      .split("\n")
      .find((line) => line.startsWith("This row's monitor has FIRED"));
    expect(factLine).toBeDefined();
    expect(factLine).toContain("(attempt 2)");
    expect(factLine).not.toContain("attempt 2/");
  });
});

describe("unconditional pre-write re-read directive (PEN-5350 / PEN-5082 deliverable B)", () => {
  const issue = {
    id: "issue-1",
    identifier: "PEN-5181",
    title: "Stage 0 of the D1 broker enablement has no carrier row",
    workMode: "standard",
    description: null,
  };

  // THE measurement this deliverable exists for. PEN-5082 instance 3 is two runs of one
  // agent: the run that pushed was woken `github_pr_merge_queue_evicted` and renders the
  // eviction branch; the run holding the prohibition was woken `issue_comment_mentioned`
  // with no PR context and renders none of it. A directive reachable only from the
  // eviction wake reaches one of the two. This case is the wake shape of the run that
  // could not see it, and it must now see it.
  it("renders on a wake carrying NO prReview context at all", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      wakeComment: {
        id: "comment-1",
        body: "Do not push to this head until the board rules.",
      },
    });

    expect(markdown).toContain("Pre-write re-read directive:");
    expect(markdown).toContain("Recording a constraint:");
    // The two live reads it mandates, named individually: a test that pinned only the
    // heading would pass against a section that had quietly lost one of them.
    expect(markdown).toContain("`activeRun` (`paperclipGetIssue`)");
    expect(markdown).toContain("--json headRefOid,state,mergeStateStatus");
  });

  // PEN-6385. The gate-read polarity rule. `gh api` puts its error document on STDOUT and a
  // pipeline's `$?` is the last stage's, so the idiomatic read returns a clean verdict on a
  // 403. Pinned here as individual conjuncts rather than by heading for the reason stated
  // above, and with one extra reason specific to this section: the remedy has two halves
  // whose RELATIVE importance depends on the shape of the surface being read, so a test
  // that pinned only the heading would pass against a section that had dropped the half
  // that happens to look redundant on the surface it was first measured on.
  it("carries the gate-read polarity rule with both conjuncts and the surface-shape split", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      wakeComment: {
        id: "comment-1",
        body: "Do not push to this head until the board rules.",
      },
    });

    expect(markdown).toContain("Reading a gate:");
    // The rule itself: positive assertion, both conjuncts, and the verbs it binds. DEFERS is
    // named because a read that makes a run stand down is as wrong as one that authorises.
    expect(markdown).toContain("AUTHORISES, REPORTS or DEFERS");
    expect(markdown).toContain("non-empty AND carry a known ROW");
    // The half-fix must stay named. A reader who knows the mechanism reaches for pipefail
    // first, and it restores rc while still leaving `0` on stdout.
    expect(markdown).toContain("`set -o pipefail` is NOT the fix");
    // The surface-shape split, which is the part that does not survive being guessed.
    expect(markdown).toContain("returns ITS KEY COUNT");
    expect(markdown).toContain("the non-empty test alone PASSES a 403");
    // A probe with no control arm is not a probe.
    expect(markdown).toContain("one that refuses everything is not a probe");
    // Scope, so the rule is not widened into a claim about the GitHub API itself.
    expect(markdown).toContain("`mcp__github__*` tools fail loudly");
    // PEN-6385 review pass. rc 1 is jq -e's false branch and is the MODAL live outcome on
    // both shapes -- a three-value rc table that omits it invites a reader to treat the
    // commonest correct refusal as an undocumented failure, which is the exact defect
    // this section exists to name. Pinned on both arms because they drifted apart once.
    expect(markdown).toContain("rc 1 when reviews exist but none are that login");
    expect(markdown).toContain("rc 1 when the set is non-empty and does not contain it");
    expect(markdown).toContain("MODAL live outcome on BOTH shapes");
    // The operands are placeholders. Pasted verbatim they refuse everything, which reads
    // exactly like a working gate, so the warning has to travel with the recipe.
    expect(markdown).toContain("are PLACEHOLDERS");
    // The `// []` claim must carry its mechanism in the EMITTED text: runs never see the
    // TS comment that explains it.
    expect(markdown).toContain("MANUFACTURES the empty list");
    // A permanent rc 4 is a fact about the SURFACE, not the gate. Three repos, three
    // shapes -- so neither protection route may be named as the in-effect one.
    expect(markdown).toContain("Three repos, three shapes");
    expect(markdown).toContain("take the UNION, per repo, live");
    // PEN-6385 second review pass. The list-shaped recipe used to say the probe gives
    // rc 0 when the login reviewed THIS HEAD. The filter tests the login and nothing
    // else, so a review of a superseded tree returns rc 0 too (measured on fixtures).
    // A recipe that promises more than its filter checks is the defect this whole
    // section names, committed inside the section itself.
    expect(markdown).toContain("not this head");
    expect(markdown).toContain("State what a probe checks, never what you wish it checked");
    // ...and the obvious repair is worse: commit_id is re-anchored forward on APPROVED
    // reviews, so that conjunct is satisfied always on the one state carrying authority.
    // Pinned so nobody "strengthens" the recipe back into vacuity.
    expect(markdown).toContain("RE-ANCHORS an APPROVED review's `commit_id` forward");
    // onprem is the mirror of PENSTOCK. paperclip is non-empty on both routes and so is
    // neither; the earlier text named the wrong repo while reaching the right conclusion.
    expect(markdown).toContain("the mirror of PENSTOCK, not of paperclip");
    // The error class is wider than a quota outage: a GraphQL schema error reaches it at
    // FULL quota on a HEALTHY transport, with key count 1 -- on a reviews surface the
    // single most plausible answer there is. Pinned so the rule is not read as an
    // outage-only hazard that waiting fixes.
    expect(markdown).toContain("GraphQL schema error 1");
    expect(markdown).toContain("reachable from a query you typed yourself");
    expect(markdown).toContain("refuses, at rc 5");
    expect(markdown).toContain("tracks the SHAPE of the document that arrived, never the cause");
    expect(markdown).toContain("prints NO headers without `-i`");
    expect(markdown).toContain("CANNOT be run on the probe's own response");
    // Was pinned on "is an artifact of the missing flag". The third review pass widened
    // that sentence from the missing `-i` flag to the RECIPE generally, so the old
    // fragment no longer occurs. The CLAIM is unchanged and is still pinned, on both of
    // its halves -- the `-i` half here and the truncation half below.
    expect(markdown).toContain("on a call made WITHOUT `-i`");
    expect(markdown).toContain("`Retry-After` header is a SECONDARY rate limit");
    expect(markdown).toContain("the causes are open-ended");
    expect(markdown).toContain("refuses at rc 4 at full quota");
    // PEN-6385 third review pass (Ally, Important). The header diagnostic used to end
    // `| head -20`, which CUTS OFF the very header it tells the reader to look for:
    // `gh api -i` prints headers alphabetically and the line they land on moves with the
    // response -- `X-Ratelimit-Remaining` measured at line 22 on a 200 and line 19 on a
    // permission-403. So the positional cut WORKED on one response and silently dropped
    // the header on another, and a reader who saw no zero-remaining line would conclude
    // it was not a rate limit and stand down -- the exact behaviour the next sentence
    // forbids. Select by NAME instead; pinned so nobody reintroduces a positional cut.
    expect(markdown).toContain("grep -iE '^(HTTP|x-ratelimit-|retry-after|x-accepted-github-permissions)'");
    expect(markdown).toContain("never truncate with `head -n`");
    expect(markdown).toContain("MOVES with the response");
    expect(markdown).toContain("line 22 on a 200 and line 19 on a permission-403");
    expect(markdown).toContain("Keep the `2>&1` or a transport error is hidden");
    expect(markdown).toContain("is an artifact of the RECIPE");
    expect(markdown).toContain("no `X-Ratelimit-Remaining` on a TRUNCATED one");
  });

  // PEN-5802. The head check above is push-scoped, and the directive's own verb list
  // includes verbs that never move the head. Two sibling runs of one seat each spent one
  // body-edit grant 38 s apart with both prescribed gates correctly passing, so the
  // directive has to say that an unmoved head is not evidence a grant is unspent, and name
  // the one surface that is. Pinned on the SAME no-PR-context wake as the measurement
  // above: the run that double-spends is not necessarily the one woken about the PR.
  it("states that the head check is push-scoped and names the redemption receipt", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      wakeComment: {
        id: "comment-1",
        body: "Do not push to this head until the board rules.",
      },
    });

    // The non-gate claim itself, and the verbs it is about. A test pinning only the
    // remedy would pass against a bullet that had lost the reason anyone needs it.
    expect(markdown).toContain("That head check is PUSH-scoped");
    expect(markdown).toContain("it is not a weak gate but a NON-gate");
    // The partition, not a second verb list: the bullet names the three verbs that DO move
    // the head and defers to the directive's own list for the rest. Pinned because getting
    // this set wrong inverts the bullet -- it would tell a run the head gates a push.
    expect(markdown).toContain("only push, force-push and rebase move `headRefOid`");
    // A plain force-push overwrites unconditionally, and force-push is the second verb in
    // the list above, so an unqualified "pushes have a CAS" is false for a verb the
    // directive governs.
    expect(markdown).toContain("`--force-with-lease` restores one");
    // The remedy, and the abort condition that makes it fail closed rather than merely
    // leave a trace. `deduplicated: true` is the readable signal; without it the bullet
    // tells a run to write a receipt and not what to do when the write is refused.
    expect(markdown).toContain("redeem its receipt key BEFORE writing");
    expect(markdown).toContain("`deduplicated: true`");
    expect(markdown).toContain("abort, do not write");
    // WHICH issue the receipt goes on, which is the half the first cut of this bullet left
    // out. The unique index leads with `issue_id`, so two sibling runs redeeming the same
    // key on two owning rows of ONE pull request produce two distinct tuples, both inserts
    // succeed, and neither sees `deduplicated: true`. A receipt that refuses nothing is
    // worse than none, because it is trusted -- so this is the single choice that decides
    // whether the CAS catches the case the whole bullet is written for.
    expect(markdown).toContain("ON THE ISSUE THE GRANT WAS POSTED ON");
    expect(markdown).toContain("not whichever row you happen to hold");
    // The unkeyed-grant refusal: the clause that closes the loop when the GRANTOR forgets,
    // so it is the one most likely to be trimmed as belt-and-braces. Now covers a grant
    // that names a key but no issue, which is uncheckable for the reason just above.
    expect(markdown).toContain("A grant that names no receipt issue and key cannot be checked");
  });

  // PEN-5876. Everything above this point is scoped to PULL REQUEST write verbs, and the
  // measured loss was a row FIELD write: two runs of one seat overwrote each other's
  // `description` twice in 16 minutes, and with no revision history neither direction was
  // adjudicable afterwards. Pinned on the SAME no-PR-context wake as the two measurements
  // above, deliberately -- a run that clobbers a field is frequently woken about no pull
  // request at all, so a directive reachable only from a PR wake would miss it.
  it("extends the pre-write re-read to row field writes and names the compare-and-set", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      wakeComment: {
        id: "comment-1",
        body: "Do not push to this head until the board rules.",
      },
    });

    // The scope extension itself, and the reason the bullets above cannot be reused: a
    // field write moves no head, and `activeRun` is per-ROW. A test pinning only the
    // remedy would pass against a section that had lost the reason anyone needs it.
    expect(markdown).toContain("The same applies to a row FIELD write");
    expect(markdown).toContain("`activeRun` is per-ROW while the thing you are about to overwrite is a FIELD");
    // The primitive, by name, on both sides of the round trip. Reading
    // `latestFieldRevisionId` and sending `baseRevisionId` are different identifiers and a
    // run that learns only one of them cannot complete the call.
    expect(markdown).toContain("`latestFieldRevisionId`");
    expect(markdown).toContain("`baseRevisionId`");
    expect(markdown).toContain("409 `stale_base_revision`");
    // Omission vs null. These are NOT the same request: omitting the field is unchecked,
    // `null` is an enforced IS NULL test, and every row predating the feature starts null
    // -- so a run that treats them as interchangeable gets no protection in the COMMON
    // case while believing it opted in.
    expect(markdown).toContain("Omission is NOT `null`");
    // The data-keyed framing. This is the clause most likely to be "simplified" into a
    // lock check, which is the rule this row explicitly rejected: the checkout lock is
    // advisory here, and in the measured incident the HOLDER is the run that lost.
    expect(markdown).toContain("never \"do I hold the checkout?\"");
    // Ally review of #3622: "a live run other than mine" was NARROWER than what the CAS
    // actually checks -- a board user, or a run of yours that has since finished, advances
    // the pointer and is refused identically. Pinned because the narrow form reads as more
    // precise and is the one a later edit would drift back toward.
    expect(markdown).toContain("has ANYONE written this field since I read it?");
    expect(markdown).toContain("do not narrow this back to live sibling runs");
    // Same review: the directive must NOT promise the error body carries the current
    // revision. The pre-check populates `latestRevisionId`; the under-lock race branch
    // carries only `expectedRevisionId` and the code, so a run that relied on the body
    // would find no current id in exactly the case the lock exists for.
    expect(markdown).toContain("Do not count on the error body to carry the current revision");
    // Same review: `title` is covered by the same CAS and named in the opening line, so the
    // instruction to send the precondition must not silently drop it.
    expect(markdown).toContain("Send it on every `title` or `description` edit");
    // CEO ruling on PEN-5876 (comment `15f212c1`, 2026-11-09T21:5xZ): the earlier form
    // exempted an edit "you did not author start to finish in this run". That lands the
    // exemption on the MOST destructive write class rather than the least -- a full
    // replacement carries none of the prior value forward, and the interleaving the CAS
    // exists to catch sits between the READ and the PATCH, which composing your own text
    // does nothing to close. It was also a condition the run SELF-ASSESSES, and the class
    // needing the guard is exactly the class that answers "yes, I wrote all of it".
    // Pinned POSITIVELY on the replacement and NEGATIVELY on the exemption, because the
    // exempting form reads as helpful precision and is what a later edit drifts back toward.
    expect(markdown).toContain("FULL REWRITES INCLUDED");
    expect(markdown).not.toContain("start to finish");
    expect(markdown).toContain("the lock HOLDER is the run whose content was destroyed");
    // The cheap half, phrased so it catches BOTH failures: compare what was STORED against
    // what you MEANT to store. "Did a sibling write?" catches only the concurrency case,
    // and the write path normalises escape sequences, so a single uncontended write can
    // store something other than what it sent.
    expect(markdown).toContain("compare what was STORED against what you MEANT to store");
    expect(markdown).toContain("Re-reading the fields you did NOT write");
    // The two surfaces that look like that check and are not. Both are cheaper to reach
    // than a re-read, which is exactly why they get substituted for it.
    expect(markdown).toContain("A write RESPONSE is not that check");
    expect(markdown).toContain("an ordinary comment bumps it while `description` stays byte-identical");
  });

  // PEN-6145. Five distribution waves amended this rule in the per-seat instruction roots
  // over 46 hours and not one enumerated the generated surface, which outreaches all of them
  // -- it is emitted on every non-null return, including wakes with no issue and no PR. This
  // case is the standing check that makes the NEXT correction to this rule unable to land in
  // the roots alone: it fails here, in this repo, where a reviewer sees it.
  //
  // Anchored on the CALL SIGNATURE -- `paperclipAddComment` plus the `idempotencyKey` field --
  // and on the ordering clause, never on a heading or a digest of the block. The roots carry
  // this rule under five different headings and a licence to re-word it in each seat's own
  // idiom, so a heading or hash anchor is dissolved by exactly the seats that complied, and
  // reports ABSENT on text that is already correct. A call signature cannot be re-worded while
  // the rule still needs it.
  it("names the redemption call signature and the establish-redeem-write ordering (PEN-6145)", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    // The call signature. `idempotencyKey` is pinned as the FIELD because leaving the
    // parameter implicit invites a run to put the key in the comment body, or to pass a
    // comment id -- both dedupe against nothing and post a receipt that reads as a spend.
    expect(markdown).toContain("`paperclipAddComment`");
    expect(markdown).toContain("passed as the `idempotencyKey` field");

    // The ordering, and the scope of "BEFORE" that the sentence above it does not fix on its
    // own. "redeem its receipt key BEFORE writing" lifted out of this block was read by a
    // grantee as "redeem FIRST, then PATCH" (PEN-5296), i.e. before the precondition check.
    expect(markdown).toContain("relative to the WRITE and never to the precondition check");
    expect(markdown).toContain("THEN redeem; THEN write, with nothing in between");

    // The compliant path is the failure this whole rule exists for: not a run that writes
    // when it should not, but one that redeems, re-reads, correctly declines, and has
    // destroyed a grant nothing can give back. Trim this and the ordering reads as style.
    expect(markdown).toContain("STOP and do NOT redeem");
    expect(markdown).toContain("DESTROYS the grant on the COMPLIANT path");

    // Where it concentrates. A wake fired by the authorising event finds the precondition
    // true; a scheduled one usually does not, so redeem-first costs a key at every tick.
    expect(markdown).toContain("wherever the wake is fired by a TIMER");

    // The clause this amendment must NOT have inverted. The emitted ordering was already
    // correct relative to the two live reads the directive mandates, and the repair was
    // additive; a later edit that "fixes" the ordering by moving the redemption after the
    // write would make the one surface every run reads worse, and would pass every
    // assertion above. Pinned here so that edit fails.
    expect(markdown).toContain("redeem its receipt key BEFORE writing");
    expect(markdown.indexOf("redeem its receipt key BEFORE writing")).toBeLessThan(
      markdown.indexOf("relative to the WRITE and never to the precondition check"),
    );
  });

  it("renders on an issue-only wake, with no wake comment and no PR", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("Pre-write re-read directive:");
    expect(markdown).toContain("Recording a constraint:");
  });

  // The other half of instance 3. Both runs must carry it, which is the property that
  // makes this a pre-write gate rather than one wake path's paragraph.
  it("also renders on the merge-queue eviction wake, alongside that branch's own text", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      prReview: {
        wakeReason: "github_pr_merge_queue_evicted",
        prNumber: 3205,
        repoFullName: "Blockcast/paperclip",
        event: "issue_comment",
        prRole: "author",
        prAuthorLogin: "allyblockcast[bot]",
      },
    });

    expect(markdown).toContain("GitHub merge-queue eviction directive:");
    expect(markdown).toContain("Pre-write re-read directive:");
  });

  // The verb list is the whole reach of the rule. #3291 widened the eviction branch's own
  // list from the single verb it suggested; this keeps the unconditional copy from being
  // narrowed back to "push" by a later edit that reads the list as prose.
  it("names every write verb, not only pushing", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    for (const verb of [
      "push",
      "force-push",
      "rebase",
      // PEN-5802 review: the metadata verbs were absent, which left the directive with two
      // overlapping verb lists -- this one, and a second enumeration inside the
      // push-scope bullet. They are now one list, and the bullet partitions it by name.
      "body or title edit",
      "review submission",
      "enqueue",
      "auto-merge",
      "review-request change",
    ]) {
      expect(markdown).toContain(verb);
    }
  });

  // Constraint 1 on PEN-5350, and the reason a re-read that re-reads the prompt buys
  // nothing: PEN-5082 measured the platform's own SHARED CHECKOUT CONTENTION warning
  // computed once at dispatch, so the holding run's copy named two siblings and the run
  // that went on to push was not among them -- it did not yet exist.
  it("says plainly that the values in the prompt are a dispatch-time snapshot", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("computed when this run was DISPATCHED, not now");
    expect(markdown).toContain("Re-reading this prompt is not re-reading state.");
  });

  // The inverse of the case this replaces. Blockcast/paperclip#3310 shipped the endpoint
  // (merged 2026-11-05T03:48:06Z), so the sentence held back behind that trigger is now
  // present and pinned. The positive control is kept for the same reason the absence
  // case carried one: an assertion about this sentence must not be satisfiable by the
  // surrounding section having vanished.
  it("names the owning-row lookup endpoint, now that #3310 has shipped it", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("Recording a constraint:");
    expect(markdown).toContain("work-products/by-external-id");
    // Pinned individually because each clause closes a specific misreading, and a
    // test matching only the path would pass against a sentence that had lost them.
    // `THAT YOU MAY READ` is what stops an authorization-filtered result being read as
    // "this artifact has no owner". The noun is pinned too: this sentence introduces the
    // endpoint, and calling the list "every OWNING row" is the exact misreading the rest
    // of this PR removes -- a reader who stops here never reaches `relation`.
    expect(markdown).toContain("BOUND TO THIS ARTIFACT THAT YOU MAY READ");
    expect(markdown).not.toContain("every owning row YOU MAY READ");
    // PEN-5340 item 5. The signal named here must be the one that covers EVERY
    // incompleteness cause. The sentence previously named
    // `withheldForAuthorizationCount > 0`, which covers only the authorization
    // cause and read `0` on a measured four-of-five answer.
    expect(markdown).toContain("`ownerListComplete: false`");
    expect(markdown).toContain("`unresolvedOwningIdentifiers`");
    // The URL form is the one a run has to hand; teaching `%23` first taught it to
    // re-encode a value the endpoint normalises itself.
    expect(markdown).toContain("externalId=<the PR's URL>");
  });

  // PEN-6056. The lookup matched `owner/repo` byte-exactly, so a casing difference
  // in either segment returned `owners: []` with `withheldForAuthorizationCount: 0`
  // -- byte-identical to a genuinely unowned pull request, including the one field
  // this directive names as the escape hatch for a false empty. The server now
  // folds the casing; this pins that the directive SAYS so. Without the clause a
  // run holding an empty answer has no way to rule out its own typing, and the
  // cheapest thing to try -- re-running under another casing -- is now pure waste.
  it("tells the reader the owner/repo casing is folded", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("work-products/by-external-id");
    expect(markdown).toContain("CASING IN `owner/repo` DOES NOT MATTER");
    expect(markdown).toContain('externalIdMatch: "case_insensitive"');
  });

  // PEN-5340 item 5, asserted as a prohibition rather than only as a presence.
  // The failure being closed is a run reading a complete-looking answer off the
  // one counter this sentence used to advertise, so it is not enough that the
  // better signal is present -- the superseded instruction must be gone, and the
  // reader must be told explicitly that the counter alone does not mean complete.
  it("does not offer the authorization counter as the completeness signal", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("work-products/by-external-id");
    expect(markdown).not.toContain("`withheldForAuthorizationCount > 0` means owners exist");
    expect(markdown).toContain("Do NOT read `withheldForAuthorizationCount: 0` as complete");
  });

  // PEN-5340, review follow-up. `ownerListComplete: false` has two causes and only
  // one of them means owners are missing; the other (`owningIdentifiersUnrecorded`)
  // means completeness could not be CHECKED, and it is the common shape, because
  // agent-registered rows carry no ownership metadata at all. The directive
  // previously asserted the strong reading for every `false`, which would be wrong
  // on most real answers -- and a control that over-claims on the common case is one
  // readers learn to skip, which is the same fail-open it exists to remove.
  it("does not claim a false completeness signal proves owners are missing", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("`ownerListComplete: true` is the only thing");
    expect(markdown).toContain("`ownerListComplete: false`");
    expect(markdown).not.toContain("means the answer is SHORT -- owners exist that it did not show you");
    // The unverifiable cause is named, and named as weaker than the short one.
    expect(markdown).toContain("`owningIdentifiersUnrecorded`");
    expect(markdown).toContain("owners MAY be missing, not that they are");
    // Suggestion from the same review: the two fields can describe one owner.
    expect(markdown).toContain("do not add them up");
  });

  // Security's §4 on PEN-5340: the endpoint refuses a bare `#123` (400), so this
  // cannot be hit through the API -- it is hit by a reader re-deriving owner/repo
  // from an abbreviated reference and guessing wrong, which returns a confident
  // DISJOINT owner set rather than an empty one. Costs one clause to prevent.
  it("requires artifacts to be named with their repo, not a bare number", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("never a bare `#123`");
  });

  // PEN-5836: the directive used to name `provenance: "webhook"` as "the
  // authoritative binding". It is not one -- the webhook writes a work product
  // for every issue a PR references, so a mentioning row carries that same
  // marker. Pinned clause by clause because each closes a specific misreading
  // that was measured in the field, not hypothesised.
  it("sends the run to `relation`, and says `provenance` does not discriminate", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("Read `relation`, NOT `provenance`");
    // Without the reason, "read relation" is a rule a run can talk itself out
    // of the moment the old field looks sufficient.
    expect(markdown).toContain("rows the PR merely MENTIONS");
    expect(markdown).toContain("does not discriminate");
    // The arm that costs most if lost: `undetermined` must not read as "no".
    expect(markdown).toContain("never as a no");
  });

  // The whole point of the correction: a run told only that the list can be too
  // SHORT reads a long list as settled. Both directions, or neither.
  //
  // This assertion was rewritten when the branch was rebased. It used to pin the
  // sentence "`withheldForAuthorizationCount > 0` means owners exist", which
  // PEN-5340 item 5 had meanwhile DELETED from the directive and pinned negatively
  // in the test above -- the branch predates that work. Taking this side of the
  // conflict wholesale would have reinstated the counter as the completeness
  // signal and failed its own repo's test; the two corrections are on different
  // axes and compose, so the under-binding half is now asserted through
  // `ownerListComplete`, which is where PEN-5340 moved it.
  it("documents the over-binding direction alongside the completeness signal", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("errs in BOTH directions");
    expect(markdown).toContain("Too LONG");
    // The completeness signal must survive the rewrite -- this is an addition,
    // not a replacement.
    expect(markdown).toContain("`ownerListComplete: true` is the only thing");
    expect(markdown).toContain("is NOT proof the artifact is unowned");
    // Completeness is not soundness: the flag is defined over owners that are
    // missing, so `true` says nothing about entries that are present and are not
    // owners. Measured at 27 mentioners in 38 rows with the flag `true` on 8 of 8
    // over-binding artifacts, so this is the common answer, not a corner.
    expect(markdown).toContain("Completeness is not soundness");
    // The gap neither number reports.
    expect(markdown).toContain("another company's identifier space");
  });

  // Keyed on the artifact, while the hazard is keyed on the file set. A run that
  // reads the lookup as discharging the obligation misses the row whose planned
  // work edits the same files and which is bound to no PR at all.
  it("says the lookup is necessary but not sufficient", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("necessary for recording a constraint and is not sufficient");
    expect(markdown).toContain("FILE SET");
  });

  // Placement, asserted rather than left to reading order. The sentence is author-side
  // -- it belongs to the rule that says record a constraint on the artifact's owning
  // row, which cannot be followed without enumerating the owners. In the pre-write list
  // it would read as a reader-side check that, on the instance that motivated it, would
  // not have fired: the lookup returns the row the writing run already held.
  it("places the lookup inside the constraint-recording rule, not the pre-write list", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    const constraintHeading = markdown.indexOf("Recording a constraint:");
    const lookup = markdown.indexOf("work-products/by-external-id");

    expect(constraintHeading).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(constraintHeading);
  });

  // PEN-5674. The lookup sentence above tells a run WHICH row owns the artifact; it does
  // not tell a run what to do when the write to that row is refused, and a non-assignee's
  // write is refused (`403 deny_missing_grant`). Without the escalation hop the rule is
  // unsatisfiable in exactly its general case, and the fallback a blocked run reaches for
  // -- recording only on its own row -- is the one the rule opens by calling insufficient.
  // Pinned clause by clause: each closes a distinct way the hop fails silently.
  it("names the escalation hop for a run that cannot write to the owning row", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    // Positive control first: every assertion below is satisfiable by the surrounding
    // section having vanished, which is the one way this case could go green reporting
    // nothing.
    expect(markdown).toContain("Recording a constraint:");
    // The refusal is named by its code so a blocked run recognises what it is holding
    // rather than reading the 403 as a bug in its own call.
    expect(markdown).toContain("`403 deny_missing_grant`");
    // The own-row fallback is what a blocked run does by default; the directive has to
    // say it is not the end of the hop, not merely that it is insufficient.
    expect(markdown).toContain("do not stop at your own row");
    // The hop has a named recipient. Without this it degrades to "write it somewhere".
    expect(markdown).toContain("link the owning row's assignee (or your chain of command)");
    // The mention form is load-bearing: a bare `@Name` binds nobody and raises no wake,
    // so a hop written that way reaches the recipient's thread and not the recipient.
    expect(markdown).toContain("[@Name](agent://<uuid>)");
    expect(markdown).toContain("A bare `@Name` mentions nobody.");
    // The unreached state is the audit trail. A constraint parked on its author's row
    // with nothing saying it never arrived is indistinguishable from one that did.
    expect(markdown).toContain("has NOT yet reached the owning row");
  });

  // Placement, asserted rather than left to reading order. The hop is the failure branch
  // of the lookup sentence, so it has to read after it: a run reaches the hop by having
  // tried the write the lookup pointed it at.
  it("places the escalation hop after the owning-row lookup it fails over from", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    const lookup = markdown.indexOf("work-products/by-external-id");
    const hop = markdown.indexOf("`403 deny_missing_grant`");

    expect(lookup).toBeGreaterThan(-1);
    expect(hop).toBeGreaterThan(lookup);
  });

  // PEN-5904, the SURFACE axis. Everything above this point is the ROW axis, and a run
  // can satisfy all of it and still lose the constraint. Measured on PEN-5524/PEN-5137:
  // eight correct copies across all four owning rows, and seven hours later a reader who
  // knew to check that row read the newest comment plus the park note, found neither
  // carried it, and proceeded -- the nearer copy was at comment depth 10 of 55. Pinned
  // per clause rather than on the heading, because a section that had quietly lost one of
  // the four would pass a heading-only assertion while leaving the hole it was written
  // for wide open.
  it("names the description as the required surface, with the comment as announcement", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("A comment is the announcement; the description is the record");
    // The threshold itself. Without it the clause is a preference; with it a run can tell
    // whether what it just wrote counts.
    expect(markdown).toContain("comment depth >= 2 has not been recorded, it has been mentioned");
    // Retirement, not only recording. A depth-0 constraint that nobody amends is the cost
    // this rule knowingly accepts, so the directive has to say who pays it and why.
    expect(markdown).toContain("amend the DESCRIPTION as well as announcing it");
    // The two rows that already did this per-incident, before any directive asked. Cited
    // so the clause reads as a practice being written down rather than one being invented.
    expect(markdown).toContain("PEN-5734 and PEN-5524 are the worked pattern");
  });

  // The two ways the row-axis rule ends with no row to write on. They are different
  // failures -- no target at all, versus a known target that refuses the write -- and they
  // end in the same place, which is why both are pinned here: the constraint lands
  // wherever the author CAN write, i.e. depth 1 on the author's own row.
  it("names a fallback target with no external id, and a fallback placement on a 403", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    // Target. `by-external-id` is defined for artifacts that HAVE an external id; a
    // control-plane artifact has none, and the conclusion a literal reader reaches from
    // the lookup paragraph alone is "not applicable".
    expect(markdown).toContain("Target, when the artifact has no external id");
    expect(markdown).toContain("'not applicable' is not the conclusion");
    expect(markdown).toContain("which run could act against this constraint");
    // State and consequence, not a prohibition. The actor usually has every right to do
    // the thing; what they lack is the cost.
    expect(markdown).toContain("they need to know what it costs");

    // Placement. A 403 on the owning row is not a licence to write it anywhere.
    expect(markdown).toContain("Placement, when the right target refuses you");
    expect(markdown).toContain("does not license writing the constraint wherever you happen to have access");
    // The honesty clause: a partial placement that reads as a complete one is the exact
    // failure this directive exists to prevent, so an unplaced constraint must say so.
    expect(markdown).toContain("treat it as unplaced until someone holding the grant places it");
  });

  // Depth 0 raises the read rate AND the cost of an error, and the two are not
  // symmetrical: a description has no next-comment-in-thread, so it must be EDITED, by
  // someone holding write access -- who per the Placement clause may not be whoever finds
  // the error. PEN-5524's depth-0 block carried a wrong `monitorStatus: cleared` for six
  // hours and its own author reproduced the error from it the next morning.
  it("tells a depth-0 author to name who to tell when the constraint is wrong", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("A description has no next-comment-in-thread to carry a correction");
    expect(markdown).toContain("name who to tell if it is wrong");
  });

  // Ordering, asserted rather than left to reading order. Target and Placement both
  // answer "the lookup gave me nothing I can write to", so they are unreadable before the
  // lookup paragraph they are the fallback for.
  it("places the surface clauses after the owner lookup they fall back from", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    const lookup = markdown.indexOf("work-products/by-external-id");
    const surface = markdown.indexOf("Surface. Record the constraint");
    const target = markdown.indexOf("Target, when the artifact has no external id");
    const placement = markdown.indexOf("Placement, when the right target refuses you");
    const correction = markdown.indexOf("Correction. A description has no");

    expect(lookup).toBeGreaterThan(-1);
    expect(surface).toBeGreaterThan(lookup);
    expect(target).toBeGreaterThan(surface);
    expect(placement).toBeGreaterThan(target);
    expect(correction).toBeGreaterThan(placement);
  });

  // PEN-6097. The Surface clause above mandates a DESCRIPTION write, and a description
  // write is a full-field replace -- the one placement where two runs destroy each other.
  // The motivating incident is the SAME one Surface cites: two seats writing the same
  // constraint 39 seconds apart. Those were comments, so they were safe; Surface redirects
  // that exact fan-out onto the one field where concurrency is destructive. Pinned per
  // clause like the four above, because a section that quietly loses one of these
  // sentences still passes a heading-only assertion.
  it("says the description write is a full-field replace, and prescribes re-read, prepend, independent verify", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("full-field REPLACE");
    expect(markdown).toContain("Re-read the description immediately before writing, in the same run that writes it");
    expect(markdown).toContain("PREPEND your constraint block and keep every existing byte");
    // The failure mode by name, because "be careful" is not a procedure: a read-modify-
    // write across two runs reports success to BOTH of them.
    expect(markdown).toContain("last-writer-wins");
    // Verification has to be an independent read; a write response is not evidence.
    expect(markdown).toContain("re-reading the row with `paperclipGetIssue`, not off the write response");
  });

  // Concurrency is not the only way to transmit a wrong body, and framing it that way
  // would ship a clause that misses the measured case. 2026-11-08, PEN-5904's own row:
  // one writer, no race, a 13,176-byte description replaced by ~870 bytes of
  // hand-composed text carrying a PLACEHOLDER token. 200 OK, in place 2m36s. The field
  // has no length guard, no `If-Match` and no diff in the response, so a 93%-shorter
  // body is indistinguishable from a deliberate rewrite. The author's pre-write re-read
  // AND their additive-inversion proof both passed -- both ran on the file that was then
  // not sent.
  it("covers the single-writer short-body case, and requires a digest computed before the write", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("no length guard, no `If-Match`");
    expect(markdown).toContain("Send the body from the file you composed it in");
    expect(markdown).toContain("compute its `sha256` BEFORE the write");
    // The generator, stated so it transfers past this one field.
    expect(markdown).toContain("a check you ran on text you did not transmit verifies nothing");
  });

  // Two gaps found independently at the same head: by me, while trying to OBEY this clause
  // on its own row, and by Ally's review of 58f5d4da (suggestions 1 and 2). Both are about
  // what happens AFTER the digest, which the first revision left unsaid.
  //
  // (1) "Send the body from the file you composed it in" is sound for a `curl --data @file`
  //     caller and UNPERFORMABLE for one whose only write path is `paperclipUpdateIssue`,
  //     which takes an inline string. A clause prescribing a step the reader's platform
  //     cannot execute gets skipped whole, so it has to name the inline case and say what
  //     to hash there -- the string actually passed, since transcription is what is on test.
  // (2) A mismatch has two causes with OPPOSITE remedies: your transcription was wrong, or
  //     a sibling legitimately prepended after your read. The natural reaction -- re-PATCH
  //     your body to "fix" it -- is precisely the last-writer-wins loss this clause forbids.
  it("names the inline-string write path, and says what a digest mismatch does and does not license", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("hash the exact string you are about to pass");
    expect(markdown).toContain("the transcription is the step being checked");
    expect(markdown).toContain("A digest mismatch afterwards is NOT by itself a loss");
    expect(markdown).toContain("restore only what is actually gone");
  });

  // Third finding at the third head, and the sharpest: the mismatch guidance above covers
  // a sibling that writes AFTER you, which is the case that is VISIBLE. The case that
  // actually loses data is a sibling writing in the window BETWEEN your re-read and your
  // PATCH -- there your digest MATCHES, because your bytes did land, and their block is
  // gone. The clause never claimed a match proves no loss, but a reader finishing a
  // digest-centred procedure will infer it, and that inference is the whole failure. The
  // re-read's ADJACENCY to the write is the only guard on that window, so the clause has
  // to say so rather than leave the digest looking sufficient.
  it("denies that a matching digest proves nothing was overwritten", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("a MATCHING digest proves only that your bytes landed");
    expect(markdown).toContain("never that nothing was overwritten");
    expect(markdown).toContain("the only guard on that window; the digest cannot see it");
  });

  // Fourth finding at the fourth head, and the only one that corrects a statement of FACT
  // rather than a gap. The clause's own escape hatch read "there is no file transport",
  // which is measured FALSE for a seat in an agent container: PAPERCLIP_API_URL and
  // PAPERCLIP_API_KEY are both set, and `curl -X PATCH --data @body.json` against
  // /api/issues/<id> returns 200. That matters in the fail-CLOSED direction -- the false
  // claim told every reader the safe path did not exist and routed them onto the one where
  // transcription is the step under test. Demonstrated on this directive's own row
  // 2026-11-09T14:2xZ: description read to a file, block concatenated onto it, file hashed,
  // that file transmitted, independent re-read matching the pre-write digest
  // (ad51ac27830514d8, 8,699 B) with the prior 6,403 bytes surviving as a byte-exact
  // suffix. Zero transcription, so there was no transcription to check. An earlier run of
  // mine asserted the API was unreachable from an agent pod on an HTTP 000 against the
  // CLUSTER-INTERNAL host; the external host answers 200, and the inference from one host
  // to all hosts is what produced the false parenthetical.
  it("prefers the file transport where one exists, and keeps the inline-string fallback", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    // Written as a condition the reader ESTABLISHES, not a fact they must find already true.
    expect(markdown).toContain("If your container has `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY` set");
    expect(markdown).toContain("you have a FILE transport and should PREFER it");
    // The reason it is preferred, stated so it transfers past this one field.
    expect(markdown).toContain("REMOVES the step a digest can only check");
    // The two files are distinct and the clause must say which is hashed and which is sent.
    // Collapsing them is what made the first version of this segment unperformable: the
    // digest has to cover the raw description text, and the request body cannot BE that text.
    expect(markdown).toContain("It takes TWO files and they are not interchangeable");
    // The pre-image read was left to the reader, and the obvious improvisation is lossy in the
    // OTHER direction: `jq -r` appends a trailing newline the stored value does not have, so the
    // digest comparison this clause MANDATES mismatches by one byte on a write that lost nothing,
    // and the stored description grows a byte per round-trip. Three independent runs measured it
    // on 2026-11-10 at 45,510 B, 62,912 B and 12,276 B. It matters because this clause DEFINES a
    // mismatch as the signal to go look for a sibling's clobber: a pipeline that cries wolf on
    // every clean write trains the reader to wave through the only detector that catches a real
    // loss. `jq -j` appends nothing and makes the check honest.
    // `// ""` guards a null description: a bare `.description` under `jq -j` writes the four
    // literal bytes `null` into desc.md, and the prepend then publishes the word.
    expect(markdown).toContain("Produce it with `jq -j '.description // \"\"'`");
    expect(markdown).toContain("never `jq -r`, which appends a trailing newline");
    // Split into its own sentence AFTER the `jq -r` one: as a parenthetical it made the
    // following "which appends a trailing newline" attach to the bare `.description` instead
    // of to `jq -r`, which is where the newline actually comes from.
    expect(markdown).toContain("And never a bare `.description`: on a row whose description is null");
    // The encoder is itself a transcription, and the one published here until 2026-11-10 was a
    // LOSSY one: jq-1.7's `-R` raw input replaces a multi-byte UTF-8 character straddling its
    // ~4096-byte in-line read chunk with two U+FFFD, at exit 0 and `200 OK`. Measured destroying
    // two characters in one 145 KB description write -- one of them inside a paragraph that write
    // never touched, which is why it reads as somebody's bad paste rather than a transport fault.
    // Reproduced synthetically: 2- and 3-byte characters corrupt from line-byte 4093 and 4-byte
    // ones from 4092, while 4095 and the later chunk boundaries are clean, so there is no safe
    // offset to code around and the fix has to be the encoder. The claim this transport is sold
    // on -- "nothing is retyped, so nothing can be mistyped" -- is true of the HUMAN step and
    // false of the ENCODER, which is the step it quietly substituted.
    expect(markdown).toContain('python3 -I -c "import io,json;');
    expect(markdown).toContain(
      "json.dumps({'description':io.open('desc.md',encoding='utf-8',newline='').read()})",
    );
    // `newline=''` is not decoration. Without it Python opens in text mode with
    // newline=None, so universal-newline translation rewrites every CRLF and bare CR to LF
    // before json.dumps sees the text -- the replacement encoder reproducing, in a quieter
    // way, the exact defect class it was published to fix, and the same silent byte-rewrite
    // this clause already warns about for `--data`. Measured: a\r\nb\rc round-trips False
    // without it and True with it. Pinned on BOTH opens, because the write side is only a
    // no-op by accident of os.linesep on Linux.
    expect(markdown).toContain("io.open('body.json','w',encoding='utf-8',newline='')");
    expect(markdown).toContain("`newline=''` is load-bearing on BOTH opens");
    // The pre-send check has to be a ROUND-TRIP, not a U+FFFD search. json.dumps defaults to
    // ensure_ascii=True, so a U+FFFD is emitted as the six ASCII characters of its escape and
    // a search for the character finds nothing: that check cannot fire, and it would
    // false-alarm anyway on a row already carrying U+FFFD from the damage this PR fixes. The
    // round-trip catches the boundary corruption, a newline translation and a truncation in
    // one line, and it is the check that caught the CR defect above.
    // Published WITH `assert` and WITH the import, because the bare comparison is the third
    // could-not-fail-loud guard in this one clause: run as `python3 -c "<expr>"` it evaluates
    // to False and exits 0, passing silently on exactly the loss it exists to catch, and
    // without `import json` it raises NameError instead of answering. A check published in a
    // form that cannot fail is worse than no check, because it is reported as having passed.
    expect(markdown).toContain(
      "import json;assert json.load(open('body.json'))['description'].encode('utf-8') == open('desc.md','rb').read()",
    );
    expect(markdown).not.toContain("Assert the encoded body contains zero U+FFFD");
    expect(markdown).toContain("two U+FFFD REPLACEMENT CHARACTERS");
    // Published as a PROHIBITION, not merely dropped. A command this directive taught for days is
    // still reachable from memory and from every seat root that copied it, and three runs of one
    // seat reached for it in a single day against a memory forbidding it -- a published command is
    // re-taught every run where a correction only arrives on recall. So the text has to say the
    // old one is wrong, not just stop saying it is right.
    expect(markdown).toContain("Do NOT build it with `jq -Rs '{description: .}'`");
    expect(markdown).not.toContain("by hand: `jq -Rs '{description: .}' desc.md > body.json`");
    // Both credential and content type, because dropping either one fails and they fail
    // DIFFERENTLY -- measured 2026-11-09T16:1xZ with a discriminating control on each arm.
    expect(markdown).toContain("Authorization: Bearer $PAPERCLIP_API_KEY");
    expect(markdown).toContain("Content-Type: application/json");
    // 404, not 401: the refusal is disguised as a mistyped issue id.
    expect(markdown).toContain("returns `404`, not `401`");
    // The one that matters most: a 200 that writes nothing is the exact failure this whole
    // clause exists to detect, reachable THROUGH the command the clause recommends.
    expect(markdown).toContain("returns `200 OK` and writes NOTHING");
    // --data silently changes the bytes you hashed; --data-binary does not.
    expect(markdown).toContain("Pass `--data-binary`, never `--data`");
    // And the append reading is gone: the clause says PREPEND two sentences earlier, and the
    // Surface clause's pattern ("opens its description with the standing constraint") only
    // holds if the block goes in front.
    expect(markdown).not.toContain("concatenate your block onto that file");
    // The fallback survives: a seat without that transport still gets a performable step.
    expect(markdown).toContain("Where that is unavailable and the only write path takes the body as an inline string argument");
    expect(markdown).toContain("the transcription is the step being checked");
    // And the old absolute is gone, not merely outranked.
    expect(markdown).not.toContain("there is no file transport");
  });

  // The announcement is NOT subject to the same caution, and saying so is the point. The
  // author of the Surface clause skipped a comment on PEN-5793 on concurrency grounds and
  // later corrected it: an append cannot overwrite anything, so the skip was pure loss.
  it("exempts the comment, which is append-only, from the contention rule", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("A comment is append-only and carries none of this exposure");
    expect(markdown).toContain("never the announcement");
  });

  // Both directives are correct, and read as covering appends they are together
  // unsatisfiable with nothing saying which wins. Resolved in the text, not left to the
  // reader -- a reader who resolves it the other way withholds a free, safe comment.
  it("resolves the conflict with the pre-write re-read directive, naming which rule wins", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("governs mutations, not appends");
    expect(markdown).toContain("the two rules meet only on the description, and there the concurrency rule wins");
  });

  // A fan-out that reached three of four rows is byte-identical to one that reached all
  // four, at every surface a later reader can see. Only the author knows, and only while
  // the run lasts.
  it("requires an incomplete fan-out to name the rows it could not reach", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    expect(markdown).toContain("name the rows you could not reach INSIDE the copies you could write");
    expect(markdown).toContain("byte-identical to a complete one");
  });

  // Ordering, asserted rather than left to reading order, in the style the clause above
  // established: Concurrency is HOW to perform the write Surface mandates, so it is
  // unreadable before it and must precede the fallbacks for having no reachable row.
  it("places the concurrency clause between the surface clause and its fallbacks", () => {
    const markdown = buildPaperclipTaskMarkdown({ issue });

    const surface = markdown.indexOf("Surface. Record the constraint");
    const concurrency = markdown.indexOf("Concurrency. The description write");
    const target = markdown.indexOf("Target, when the artifact has no external id");

    expect(surface).toBeGreaterThan(-1);
    expect(concurrency).toBeGreaterThan(surface);
    expect(target).toBeGreaterThan(concurrency);
  });

  // The containment-only path -- a notice with no issue, wake comment, prReview or
  // ancestors -- renders the directive too. An earlier revision gated it out as a run
  // "structurally unable to write", which was false: every refusal the containment
  // enumerates is a Paperclip-API write (approvals, deliverables, annotations, documents,
  // monitors) and NOT ONE is a GitHub write verb, so the run can still push or enqueue.
  // "Carries no assignment" is about authority; this directive is about capability.
  // Pinned so a future reader does not re-gate it on the premise that was already wrong.
  it("renders on the containment-only path, which carries no assignment but can still push", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE,
    });

    // The wake this models genuinely has no assignment -- assert that, so the case
    // cannot pass by accidentally exercising the issue-bearing path instead.
    expect(markdown).toContain("This block carries no assignment");
    expect(markdown).toContain("Run write-containment notice:");
    expect(markdown).toContain("Pre-write re-read directive:");
    expect(markdown).toContain("Recording a constraint:");
  });

  // The PEN-3275 block documents itself as the last block before the closing directive.
  // This section is inserted ahead of it, so that invariant must still hold.
  it("leaves the write-containment notice as the last block before the closing line", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      recoveryRunWriteClassNotice: STATUS_ONLY_NOTICE,
    });

    // `indexOf` returns -1 for an absent marker and -1 is less than everything,
    // so assert presence before comparing or this orders two absences.
    expect(markdown.indexOf("Pre-write re-read directive:")).toBeGreaterThan(-1);
    expect(markdown.indexOf("Pre-write re-read directive:")).toBeLessThan(
      markdown.indexOf("Run write-containment notice:"),
    );
    expect(markdown.indexOf("Run write-containment notice:")).toBeLessThan(
      markdown.indexOf("Use this task context as the current assignment."),
    );
  });
  // PEN-5788: the lookup can SUCCEED, be authoritative, and name nobody -- a pull
  // request with a valid external id whose only issue key belongs to an external
  // tracker. The `Look the owner up` string already refuses the inference ("an empty
  // `owners` list is NOT proof the artifact is unowned"), which tells a run what not to
  // conclude and gives the constraint nowhere to go. The two placement clauses around it
  // do not reach this state either: `403 deny_missing_grant` is a row that exists and
  // refuses you, and the no-external-id clause is an artifact the lookup is undefined
  // for. Pinned because the gap is invisible from any one of the three.
  it("names the pull request itself as the home when the lookup succeeds and names nobody", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-pen-5788",
        identifier: "PAP-5788",
        title: "Owner lookup returns nobody",
        workMode: "standard",
        description: null,
      },
    });

    expect(markdown).toContain("record it as a COMMENT ON THE PULL REQUEST itself");
    // The TRIGGER is "no row I can write to", never "the artifact is unowned". Pinned as
    // a positive AND a negative because the two readings produce the same remedy and
    // diverge only on what the run does NEXT.
    expect(markdown).toContain("Take that step WITHOUT first deciding whether the artifact is unowned");
    // The TRIGGER, pinned on BOTH arms. Keyed on `owners: []` alone, a non-empty result
    // whose every entry is a mention leaves the run with zero homes AND no fallback,
    // silently dropping the constraint -- strictly worse than the empty case this clause
    // was written for, because nothing about it looks unusual.
    expect(markdown).toContain("`owners` empty, or non-empty with every entry `relation: \"mention\"`");
    // Keyed on `relation`, NOT on a caller-side `owningIdentifiers` predicate: PEN-5836
    // moved that discrimination server-side. If this assertion ever has to change back,
    // the directive has regrown the second spelling the supersession removed.
    expect(markdown).toContain("`relation: \"mention\"`");
    // PEN-5340 item 5 guard. An earlier draft keyed the trigger on
    // `withheldForAuthorizationCount` being 0 and concluded there was no owner "for
    // anyone" -- the exact reading item 5 removed, since that count reports only the
    // authorization cause. These two arms red if the count-keyed trigger or the
    // negative-existence claim is reintroduced; reverting the fix alone reds them and
    // nothing else.
    expect(markdown).not.toContain("NO Paperclip owning row, for anyone");
    expect(markdown).toContain("do not key it on `withheldForAuthorizationCount`");
    // `ownerListComplete: false` is a FLOOR, not a discharge -- the case the clause's own
    // cited example (`#3643`) is actually in.
    expect(markdown).toContain("is a FLOOR and not a discharge");
  });
});

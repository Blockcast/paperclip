import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  derivePaperclipPrReview,
  evaluatePrReviewCompletionEvidence,
  mergeCoalescedContextSnapshot,
  prReviewAlreadyReviewedVetoCue,
  prReviewOutputHasAlreadyReviewedSkip,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

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
      prAuthorLogin: null,
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
      [`No newer commits were found yet this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found however this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found though this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found still this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found nonetheless this head was already reviewed at \`${sha}\`.`, true],
      [`No newer commits were found whereas this head was already reviewed at \`${sha}\`.`, true],
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
      [`No evidence that this head was already reviewed at \`${sha}\`.`, false],
      [`No evidence while checking that this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot confirm \`8b23767\` was already reviewed at \`${sha}\`.`, false],
      [`I could not verify this PR's head was already reviewed at \`${sha}\`.`, false],
      [`I could not verify (after two retries) this head was already reviewed at \`${sha}\`.`, false],
      [`There is no evidence - none - this head was already reviewed at \`${sha}\`.`, false],
      [`I cannot confirm "this" head was already reviewed at \`${sha}\`.`, false],
      [`I cannot confirm the wake. This head was already reviewed at \`${sha}\`.`, true],
      [`No evidence of a force-push; this head was already reviewed at \`${sha}\`.`, true],
      [`I remain unconvinced that this head was already reviewed at \`${sha}\`.`, false],
      [`Unaware whether this head was already reviewed at \`${sha}\`.`, false],
      [`I am unaware of any newer commits so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Unconvinced the wake was legitimate so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing showed that this head was already reviewed at \`${sha}\`.`, false],
      [`Nothing showed a newer commit so already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
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
      [`No evidence yet that this head was already reviewed at \`${sha}\`.`, false],
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
      [`No newer commits were found yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer revisions were seen yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`Nothing new has been found still this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No newer head is known yet this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
      [`No evidence so this head was already reviewed at 2026-09-02T23:31:00Z for ${sha}`, true],
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
      [`No clear evidence yet this head was already reviewed at \`${sha}\`.`, false],
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
  // non-review. Passes 20-22 each widened it to more words; none opened it. The
  // pass-23 connective-role exclusion on `negation`'s filler does not touch
  // it either: these frames carry no connective for the exclusion to act on.
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

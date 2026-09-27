/**
 * BLO-17456: resolvePrReviewGateStatusTarget — the gate deciding whether the
 * server writes a commit status when a PR-review run exhausts its bounded
 * retry chain.
 *
 * A required status context that is never posted renders as "Expected —
 * waiting for status to be reported" forever, so an exhausted reviewer chain
 * silently wedges the PR. Failing the context makes that visible.
 *
 * Every test here guards a *refusal to write*, because the failure mode of
 * this feature is posting a status to the wrong commit or to a context the
 * server does not own — both worse than the pending state being fixed.
 */
import { describe, expect, it } from "vitest";

import { resolvePrReviewGateStatusTarget } from "../services/heartbeat.js";

const GATE = "review/ally-complete";
const HEAD_SHA = "45eb633e348a826f43dc68b0c25fe83a96300cea";

function prReviewSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    wakeReason: "github_pr_synchronized",
    // BLO-34699: both reviewer wake constructors stamp these together, and the
    // gate now requires them. Earlier revisions of this fixture omitted both,
    // which made every case here indistinguishable from the PR AUTHOR's own
    // self-wake — the shape that manufactured the false red this guard exists
    // to stop.
    reviewKind: "pr_review",
    prRole: "reviewer",
    githubPrNumber: 7,
    githubRepoFullName: "Blockcast/hang",
    githubHeadSha: HEAD_SHA,
    githubPrUrl: "https://github.com/Blockcast/hang/pull/7",
    ...overrides,
  };
}

describe("resolvePrReviewGateStatusTarget", () => {
  it("resolves repo, exact head SHA, and context for a PR-review run", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot(), GATE)).toEqual({
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: GATE,
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7",
    });
  });

  it("is inert when no context is configured, so the feature ships off", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot(), "")).toBeNull();
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot(), "   ")).toBeNull();
  });

  it("trims a padded configured context rather than posting a whitespace context", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot(), `  ${GATE}  `)?.context).toBe(GATE);
  });

  it("does not post for a non-PR-review run (an ordinary issue wake)", () => {
    const snapshot = { wakeReason: "issue_assigned", issueId: "issue-1" };
    expect(resolvePrReviewGateStatusTarget(snapshot, GATE)).toBeNull();
  });

  it("does not post when the wake carried no head SHA — a guessed commit would fail the wrong one", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot({ githubHeadSha: undefined }), GATE)).toBeNull();
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot({ githubHeadSha: "" }), GATE)).toBeNull();
  });

  it("does not post when the repo is unknown", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot({ githubRepoFullName: undefined }), GATE)).toBeNull();
  });

  it("does not post when the PR number is missing (not an addressable review target)", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot({ githubPrNumber: undefined }), GATE)).toBeNull();
  });

  it("tolerates a null/empty snapshot", () => {
    expect(resolvePrReviewGateStatusTarget(null, GATE)).toBeNull();
    expect(resolvePrReviewGateStatusTarget(undefined, GATE)).toBeNull();
    expect(resolvePrReviewGateStatusTarget({}, GATE)).toBeNull();
  });

  it("resolves for a reviewKind-tagged wake without a github_pr_ reason", () => {
    const target = resolvePrReviewGateStatusTarget(
      prReviewSnapshot({ wakeReason: "manual", reviewKind: "pr_review" }),
      GATE,
    );
    expect(target?.sha).toBe(HEAD_SHA);
  });

  it("carries a null prUrl through rather than fabricating a target link", () => {
    expect(resolvePrReviewGateStatusTarget(prReviewSnapshot({ githubPrUrl: undefined }), GATE)?.prUrl).toBeNull();
  });

  /**
   * BLO-34699 — the PR AUTHOR's own run must never be graded as the review.
   *
   * The author's agent is woken by its own `<!-- paperclip:review-request -->`
   * marker (BLO-19522, deliberate). That wake carries the same repo, head SHA
   * and PR number as the reviewer's, so every other clause in this resolver
   * passes on it. Measured on Blockcast/pim-multicast-gateway#3237: an author
   * run that died `k8s_pod_schedule_failed` at pod start with zero turns was
   * written as `review/ally-complete = failure` while Ally's real review for
   * that exact head was still queued — a red on a `ci-gate` peer that could
   * not self-heal, because the gate re-runs on `pull_request_review:
   * submitted` and Ally's common shape is a comment-shaped review.
   *
   * Mutation check (BLO-34263): delete either guard line in
   * `resolvePrReviewGateStatusTarget` alone and one of these two must fail.
   */
  const AUTHOR_SNAPSHOT = {
    // Verbatim shape of run 974efdbd-0b03-4beb-b3c3-74c8ea6f1341.
    wakeReason: "github_pr_review_requested",
    prRole: "author",
    reviewKind: null,
    githubEvent: "issue_comment",
    githubPrNumber: 3237,
    githubRepoFullName: "Blockcast/pim-multicast-gateway",
    githubHeadSha: "8a38994bffe3ca61e29b4cfa1ed5f04995d6f7c3",
    githubPrReviewRequestAuthorLogin: "github-actions[bot]",
  };

  it("does not post for the PR author's own self-wake run", () => {
    expect(resolvePrReviewGateStatusTarget(AUTHOR_SNAPSHOT, GATE)).toBeNull();
  });

  it("does not post for an author run even if it carries the pr_review tag", () => {
    // Isolates the `prRole` clause from the `reviewKind` clause: with only the
    // reviewKind guard in place this snapshot would still resolve a target.
    expect(
      resolvePrReviewGateStatusTarget({ ...AUTHOR_SNAPSHOT, reviewKind: "pr_review" }, GATE),
    ).toBeNull();
  });

  it("does not post for a PR-shaped wake carrying no pr_review tag at all", () => {
    // Isolates the `reviewKind` clause: drops `prRole` so the second guard
    // cannot be what rejects this.
    const { prRole: _prRole, ...untagged } = AUTHOR_SNAPSHOT;
    expect(resolvePrReviewGateStatusTarget(untagged, GATE)).toBeNull();
  });

  it("still posts for a genuine reviewer run — the BLO-17456 wedge stays visible", () => {
    // The guard must not fail closed on the case the feature exists for.
    expect(
      resolvePrReviewGateStatusTarget(prReviewSnapshot({ prRole: "reviewer" }), GATE)?.sha,
    ).toBe(HEAD_SHA);
  });
});

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
});

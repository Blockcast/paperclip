/**
 * Pure mapping from a GitHub pull_request event to work-product fields
 * (BLO-19566 AC4). No DB — the DB-backed upsert and the webhook wiring are
 * covered in github-webhook.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  buildPullRequestWorkProductFields,
  pullRequestExternalId,
  pullRequestWorkProductStatus,
} from "../services/pull-request-work-products.js";

describe("pullRequestExternalId", () => {
  it("keys on repo and number only, so a push does not fork the identity", () => {
    expect(pullRequestExternalId("Blockcast/paperclip", 905)).toBe("Blockcast/paperclip#905");
  });
});

describe("pullRequestWorkProductStatus", () => {
  it("maps an open non-draft PR to ready_for_review", () => {
    expect(pullRequestWorkProductStatus({ action: "opened", prDraft: false })).toBe("ready_for_review");
    expect(pullRequestWorkProductStatus({ action: "synchronize", prDraft: false })).toBe("ready_for_review");
  });

  it("maps a draft PR to draft", () => {
    expect(pullRequestWorkProductStatus({ action: "opened", prDraft: true })).toBe("draft");
    expect(pullRequestWorkProductStatus({ action: "converted_to_draft", prDraft: true })).toBe("draft");
  });

  it("maps a closed-unmerged PR to closed and a merged PR to merged", () => {
    expect(pullRequestWorkProductStatus({ action: "closed", prMerged: false })).toBe("closed");
    expect(pullRequestWorkProductStatus({ action: "closed", prMerged: true })).toBe("merged");
  });

  it("prefers merged state over the draft flag", () => {
    // A PR cannot merge while draft, but the payload carries both fields and
    // the row must describe the PR's terminal state, not its draft history.
    expect(pullRequestWorkProductStatus({ action: "closed", prDraft: true, prMerged: true })).toBe("merged");
  });
});

describe("buildPullRequestWorkProductFields", () => {
  const base = {
    repoFullName: "Blockcast/paperclip",
    prNumber: 905,
    prUrl: "https://github.com/Blockcast/paperclip/pull/905",
    headSha: "24e7b6bd",
    prBranch: "cto/blo-19566",
    action: "synchronize",
  };

  it("carries the PR identity, link, and head into the row", () => {
    const fields = buildPullRequestWorkProductFields({ ...base, prTitle: "fix(recovery): sweep locks" });
    expect(fields.externalId).toBe("Blockcast/paperclip#905");
    expect(fields.title).toBe("fix(recovery): sweep locks");
    expect(fields.url).toBe("https://github.com/Blockcast/paperclip/pull/905");
    expect(fields.status).toBe("ready_for_review");
    expect(fields.metadata).toMatchObject({
      repoFullName: "Blockcast/paperclip",
      prNumber: 905,
      headSha: "24e7b6bd",
      branch: "cto/blo-19566",
      lastEventAction: "synchronize",
    });
  });

  it("falls back to the PR ref when the event carries no title", () => {
    // `title` is NOT NULL on the row, so an empty title must not produce one.
    expect(buildPullRequestWorkProductFields({ ...base, prTitle: null }).title)
      .toBe("Blockcast/paperclip#905");
    expect(buildPullRequestWorkProductFields({ ...base, prTitle: "   " }).title)
      .toBe("Blockcast/paperclip#905");
  });

  it("produces a stable externalId across the event sequence for one PR", () => {
    const ids = ["opened", "synchronize", "ready_for_review", "closed"].map(
      (action) => buildPullRequestWorkProductFields({ ...base, prTitle: "t", action }).externalId,
    );
    expect(new Set(ids).size).toBe(1);
  });
});

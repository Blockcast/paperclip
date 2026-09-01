/**
 * Pure mapping from a GitHub pull_request event to work-product fields
 * (BLO-19566 AC4). No DB — the DB-backed upsert and the webhook wiring are
 * covered in github-webhook.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  buildPullRequestWorkProductFields,
  OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
  pullRequestExternalId,
  pullRequestWorkProductSourceEventActionOrder,
  pullRequestWorkProductStatus,
  TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES,
} from "../services/pull-request-work-products.js";

// PEN-2791: the stranded-assigned sweep reads the open/terminal split to decide whether
// an issue still has an external event-wake path, so a misclassification here does not
// merely mislabel a card -- it decides whether a live assignee keeps its issue.
describe("open/terminal pull request status partition", () => {
  const EVERY_PR_EVENT_SHAPE = [
    { action: "opened", prDraft: false, prMerged: false },
    { action: "opened", prDraft: true, prMerged: false },
    { action: "reopened", prDraft: false, prMerged: false },
    { action: "ready_for_review", prDraft: false, prMerged: false },
    { action: "converted_to_draft", prDraft: true, prMerged: false },
    { action: "synchronize", prDraft: false, prMerged: false },
    { action: "synchronize", prDraft: true, prMerged: false },
    { action: "closed", prDraft: false, prMerged: false },
    { action: "closed", prDraft: false, prMerged: true },
    { action: "closed", prDraft: true, prMerged: true },
  ];

  it("classifies every status the producer can emit as exactly one of open or terminal", () => {
    const open = new Set<string>(OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES);
    const terminal = new Set<string>(TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES);

    // No overlap: a status that is both would make the sweep's verdict order-dependent.
    for (const status of open) expect(terminal.has(status)).toBe(false);

    // No gap: an unclassified status would be silently dropped by the sweep's `inArray`
    // filter, reading as "no PR" and reopening the seizure this partition prevents.
    const emitted = new Set(EVERY_PR_EVENT_SHAPE.map((shape) => pullRequestWorkProductStatus(shape)));
    expect(emitted.size).toBe(open.size + terminal.size);
    for (const status of emitted) {
      expect(open.has(status) || terminal.has(status)).toBe(true);
    }
  });

  it("treats merged and closed as terminal, because neither emits a further webhook", () => {
    expect(pullRequestWorkProductStatus({ action: "closed", prMerged: true })).toBe("merged");
    expect(pullRequestWorkProductStatus({ action: "closed", prMerged: false })).toBe("closed");
    for (const status of ["merged", "closed"]) {
      expect(TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES).toContain(status);
    }
  });

  it("treats draft as open, because a draft PR still emits ready_for_review and closed", () => {
    // Easy to get backwards: a draft is not "not yet real work", it is a PR GitHub will
    // keep sending events for. Excluding it would seize exactly the rows whose author is
    // still pushing to them.
    expect(OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES).toContain("draft");
    expect(OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES).toContain("ready_for_review");
  });
});

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

describe("pullRequestWorkProductSourceEventActionOrder", () => {
  it("uses deterministic same-second ordering for PR state changes", () => {
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "closed", prMerged: true })).toBe(50);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "reopened" })).toBe(40);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "ready_for_review" })).toBe(40);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "closed", prMerged: false })).toBe(30);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "converted_to_draft" })).toBe(20);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "synchronize" })).toBe(10);
  });
});

describe("buildPullRequestWorkProductFields", () => {
  const base = {
    repoFullName: "Blockcast/paperclip",
    prNumber: 905,
    prUrl: "https://github.com/Blockcast/paperclip/pull/905",
    headSha: "24e7b6bd",
    prBranch: "cto/blo-19566",
    prUpdatedAt: "2026-04-30T10:15:00Z",
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
      previousHeadSha: null,
      branch: "cto/blo-19566",
      lastEventAction: "synchronize",
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-04-30T10:15:00.000Z",
      sourceEventTimestampMs: Date.parse("2026-04-30T10:15:00Z"),
    });
    expect(fields.sourceTrust).toMatchObject({
      preset: "standard",
      disposition: "promoted",
      promotedByActorType: "system",
      promotedByActorId: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
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

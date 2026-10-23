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
  pullRequestHasMerged,
  pullRequestMergeQueueState,
  pullRequestWorkProductSourceEventActionOrder,
  pullRequestWorkProductStatus,
  recordedPullRequestOwners,
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
    { action: "enqueued", prDraft: false, prMerged: false },
    // The merge-queue merge and the merge-queue ejection: same action, told
    // apart only by `merged_at` (PEN-4550). Both must land inside the partition.
    { action: "dequeued", prDraft: false, prMergedAt: "2026-10-23T03:57:49Z" },
    { action: "dequeued", prDraft: false, prMergedAt: null },
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
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "enqueued" })).toBe(45);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "dequeued" })).toBe(46);
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

  // PEN-3219: the row is written for every issue the PR references, so the row
  // alone cannot say which issue the PR is FOR. Carrying the resolved owning
  // set is what lets a consumer tell work on this issue from a name-drop.
  describe("owning identifiers (PEN-3219)", () => {
    it("records the resolved owning set on the row", () => {
      const fields = buildPullRequestWorkProductFields({
        ...base,
        prTitle: "t",
        owningIdentifiers: ["BLO-19566", "BLO-19567"],
      });
      expect(fields.metadata.owningIdentifiers).toEqual(["BLO-19566", "BLO-19567"]);
    });

    it("copies the array rather than aliasing the caller's", () => {
      // The webhook reuses one resolved context across every matched issue, so
      // an aliased array would let a later mutation rewrite rows already built.
      const owning = ["BLO-19566"];
      const fields = buildPullRequestWorkProductFields({ ...base, prTitle: "t", owningIdentifiers: owning });
      owning.push("BLO-99999");
      expect(fields.metadata.owningIdentifiers).toEqual(["BLO-19566"]);
    });

    it("distinguishes an unresolved owning set from an empty one", () => {
      // null means "not recorded" and licenses the consumer's fallback
      // derivation; [] is authoritative — the PR named no owner anywhere.
      expect(buildPullRequestWorkProductFields({ ...base, prTitle: "t" }).metadata.owningIdentifiers)
        .toBeNull();
      expect(
        buildPullRequestWorkProductFields({ ...base, prTitle: "t", owningIdentifiers: null })
          .metadata.owningIdentifiers,
      ).toBeNull();
      expect(
        buildPullRequestWorkProductFields({ ...base, prTitle: "t", owningIdentifiers: [] })
          .metadata.owningIdentifiers,
      ).toEqual([]);
    });
  });

  // BLO-35779: in a rebase merge queue the PR's head deliberately cannot move,
  // so `synchronize` never fires while it advances and the freshness clock the
  // productivity detector reads stops at the enqueue. These two actions are the
  // only per-PR merge-queue signals GitHub emits.
  describe("merge-queue state", () => {
    it("records enqueued and dequeued, and nothing for other actions", () => {
      for (const action of ["enqueued", "dequeued"]) {
        expect(pullRequestMergeQueueState({ action })).toBe(action);
        expect(
          buildPullRequestWorkProductFields({ ...base, prTitle: "t", action }).metadata.mergeQueueState,
        ).toBe(action);
      }
      // null means "this event carried no queue signal", NOT "not queued" — for
      // a repo with no merge queue that is every row, so the consumer must read
      // it as not-queued and never as queued.
      for (const action of ["opened", "reopened", "synchronize", "closed", "ready_for_review"]) {
        expect(pullRequestMergeQueueState({ action })).toBeNull();
        expect(
          buildPullRequestWorkProductFields({ ...base, prTitle: "t", action }).metadata.mergeQueueState,
        ).toBeNull();
      }
    });

    // A queued PR is `ready_for_review`, not a new state: the open/terminal
    // partition above must keep covering it, or the stranded-assigned sweep
    // drops the row.
    it("leaves a queued PR in an open status", () => {
      const open = new Set<string>(OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES);
      for (const action of ["enqueued", "dequeued"]) {
        expect(open.has(pullRequestWorkProductStatus({ action, prDraft: false, prMerged: false }))).toBe(true);
      }
    });
  });
});

// PEN-4550. `github-webhook.ts` populates `prMerged` only for `action === "closed"`,
// but a merge queue merges a PR via `dequeued` — so on a queue-merged repo the event
// that CARRIES the merge has no flag, only `merged_at`. The row then stored
// `ready_for_review`/rank 46 and, because `acceptIncoming` orders on the
// second-granular `updated_at` BEFORE it reaches the terminal-state tie-break, the
// +2s dequeue overwrote a correct `merged` row outright. Measured on
// `Blockcast/paperclip` 2026-10-23: 3 of 6 inspected merged-PR rows demoted.
describe("merge-queue merge delivered as dequeued (PEN-4550)", () => {
  const QUEUE_MERGE = {
    action: "dequeued",
    prDraft: false,
    // Exactly the shape the webhook builds for a queue merge: no flag (the
    // handler gates it on `closed`), but `merged_at` is read unconditionally.
    prMerged: undefined,
    prMergedAt: "2026-10-23T03:57:49Z",
  };
  // A genuine ejection — the queue dropped the PR without merging it. Same
  // action, no `merged_at`. This is the case that must NOT be promoted.
  const QUEUE_EJECTION = { action: "dequeued", prDraft: false, prMerged: undefined, prMergedAt: null };

  it("reads a populated merged_at as the merge witness", () => {
    expect(pullRequestHasMerged(QUEUE_MERGE)).toBe(true);
    expect(pullRequestHasMerged(QUEUE_EJECTION)).toBe(false);
    // `undefined` is "this event said nothing", not "not merged".
    expect(pullRequestHasMerged({ prMerged: undefined, prMergedAt: undefined })).toBe(false);
    // The flag still stands on its own, so the `closed` path is untouched.
    expect(pullRequestHasMerged({ prMerged: true, prMergedAt: null })).toBe(true);
    // A blank string is not a timestamp. Guards against a payload that carries
    // the key with an empty value being read as a merge.
    expect(pullRequestHasMerged({ prMerged: false, prMergedAt: "   " })).toBe(false);
  });

  it("maps the queue merge to merged / rank 50 / metadata.merged", () => {
    expect(pullRequestWorkProductStatus(QUEUE_MERGE)).toBe("merged");
    expect(pullRequestWorkProductSourceEventActionOrder(QUEUE_MERGE)).toBe(50);
    expect(TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES).toContain(
      pullRequestWorkProductStatus(QUEUE_MERGE),
    );

    const fields = buildPullRequestWorkProductFields({
      repoFullName: "Blockcast/paperclip",
      prNumber: 2946,
      prTitle: "docs(runbooks): a `done` row's evidence verdict is not about its closure",
      ...QUEUE_MERGE,
      prUpdatedAt: "2026-10-23T03:57:51Z",
    });
    expect(fields.status).toBe("merged");
    expect(fields.metadata.merged).toBe(true);
    expect(fields.metadata.sourceEventActionOrder).toBe(50);
    // The queue signal itself is still recorded factually: the PR did leave the
    // queue. Only the lifecycle state it was demoting is corrected.
    expect(fields.metadata.mergeQueueState).toBe("dequeued");
    expect(fields.metadata.lastEventAction).toBe("dequeued");
  });

  it("leaves a genuine queue ejection at ready_for_review / rank 46", () => {
    // The whole point of reading `merged_at` rather than the action: an ejected
    // PR is still open and WILL emit further webhooks, so promoting it to a
    // terminal state would strip the event-wake path PEN-2791's sweep reads.
    expect(pullRequestWorkProductStatus(QUEUE_EJECTION)).toBe("ready_for_review");
    expect(pullRequestWorkProductSourceEventActionOrder(QUEUE_EJECTION)).toBe(46);
    expect(OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES).toContain(
      pullRequestWorkProductStatus(QUEUE_EJECTION),
    );

    const fields = buildPullRequestWorkProductFields({
      repoFullName: "Blockcast/paperclip",
      prNumber: 2946,
      prTitle: "ejected",
      ...QUEUE_EJECTION,
      prUpdatedAt: "2026-10-23T03:57:51Z",
    });
    expect(fields.status).toBe("ready_for_review");
    expect(fields.metadata.merged).toBe(false);
    expect(fields.metadata.sourceEventActionOrder).toBe(46);
  });

  it("leaves every non-merge mapping exactly as it was", () => {
    // The done-when's third bullet, pinned: this change may only move the row
    // for an event that carries a real `merged_at`.
    expect(pullRequestWorkProductStatus({ action: "closed", prDraft: false, prMergedAt: null })).toBe("closed");
    expect(pullRequestWorkProductStatus({ action: "opened", prDraft: true, prMergedAt: null })).toBe("draft");
    expect(
      pullRequestWorkProductStatus({ action: "converted_to_draft", prDraft: true, prMergedAt: null }),
    ).toBe("draft");
    expect(
      pullRequestWorkProductStatus({ action: "synchronize", prDraft: false, prMergedAt: null }),
    ).toBe("ready_for_review");
    expect(
      pullRequestWorkProductStatus({ action: "reopened", prDraft: false, prMergedAt: null }),
    ).toBe("ready_for_review");

    expect(pullRequestWorkProductSourceEventActionOrder({ action: "closed", prMergedAt: null })).toBe(30);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "reopened", prMergedAt: null })).toBe(40);
    expect(
      pullRequestWorkProductSourceEventActionOrder({ action: "ready_for_review", prMergedAt: null }),
    ).toBe(40);
    expect(pullRequestWorkProductSourceEventActionOrder({ action: "enqueued", prMergedAt: null })).toBe(45);
    expect(
      pullRequestWorkProductSourceEventActionOrder({ action: "converted_to_draft", prMergedAt: null }),
    ).toBe(20);
    expect(
      pullRequestWorkProductSourceEventActionOrder({ action: "synchronize", prMergedAt: null }),
    ).toBe(10);
  });
});

// BLO-37225: both the PR-review-gate notifier and productivity-review branch on
// null-vs-empty out of this one reader, and they take OPPOSITE directions on an
// empty array. So the reader must not be a second way to produce one.
describe("recordedPullRequestOwners", () => {
  it("returns null for a value that was never recorded", () => {
    expect(recordedPullRequestOwners(undefined)).toBeNull();
    expect(recordedPullRequestOwners(null)).toBeNull();
    expect(recordedPullRequestOwners("BLO-1")).toBeNull();
  });

  it("returns the authoritative empty set only when the recorded array was empty", () => {
    expect(recordedPullRequestOwners([])).toEqual([]);
  });

  it("does not manufacture the authoritative empty set from an unreadable recording", () => {
    // The writer recorded a non-empty set; this reader could not parse any of
    // it. That is "not recorded", not "owns nothing" -- the notifier reads the
    // latter as licence to stay silent, which is the failure direction it
    // exists to remove. Reachable because `metadata` is Record<string, unknown>
    // read back from the DB, not only via buildPullRequestWorkProductFields.
    expect(recordedPullRequestOwners([42])).toBeNull();
    expect(recordedPullRequestOwners([{ id: "BLO-1" }])).toBeNull();
  });

  it("keeps a partially readable recording rather than discarding it", () => {
    // A surviving owner still routes the notice to a real owner, so the safe
    // direction here is to keep what parsed -- unlike the all-unreadable case,
    // where keeping it would flip the meaning from "notify" to "stay silent".
    expect(recordedPullRequestOwners(["BLO-1", 42])).toEqual(["BLO-1"]);
  });
});

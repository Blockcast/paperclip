import type { IssueWorkProduct, SourceTrustMetadata } from "@paperclipai/shared";

/**
 * Pure mapping from a GitHub `pull_request` webhook event to the fields of the
 * issue work product it should produce (BLO-19566).
 *
 * Kept free of DB and network access so the mapping can be unit-tested without
 * Postgres, matching the two-layer convention in github-webhook.test.ts.
 */

export interface PullRequestWorkProductInput {
  repoFullName: string;
  prNumber: number;
  prTitle?: string | null;
  prUrl?: string | null;
  headSha?: string | null;
  previousHeadSha?: string | null;
  prBranch?: string | null;
  prDraft?: boolean;
  prMerged?: boolean;
  prMergedAt?: string | null;
  prUpdatedAt?: string | null;
  /** GitHub `action` from the pull_request event. */
  action: string;
  /**
   * Identifiers this PR *owns*, as resolved by the ranked tiers in
   * `resolveOwningPaperclipIdentifiers` — NOT every identifier it mentions
   * (BLO-20886).
   *
   * A PR work product is written for every issue the PR references anywhere,
   * deliberately: the row is evidence about the PR, not a wake. That makes the
   * row's mere existence useless for deciding whether the PR represents
   * progress on the issue holding it, because a long-lived registry issue
   * accumulates every PR that name-drops it. Recording the owning set here lets
   * a consumer ask "does this PR belong to the row I am reviewing?" without
   * re-deriving ownership from fields the row does not carry (the PR body is
   * never persisted).
   *
   * `undefined`/`null` means "not recorded" — for rows written before this
   * field existed — and must not be read as "owns nothing". An empty array IS
   * authoritative: the PR named no owner in its title, branch, or labeled body.
   */
  owningIdentifiers?: readonly string[] | null;
}

/**
 * Merge-queue occupancy, as last reported by a `pull_request` webhook (BLO-35779).
 *
 * `null` means "this event said nothing about the queue" — NOT "not queued" —
 * exactly like `owningIdentifiers`. Only `enqueued`/`dequeued` carry the signal.
 *
 * Deliberately a STATE, not a timestamp. GitHub emits exactly two per-PR
 * merge-queue signals — `added_to_merge_queue` and `removed_from_merge_queue`
 * — and NOTHING while a PR advances through the queue. Measured on
 * `Blockcast/paperclip`: #1948 sat 27.4h between the two with no intervening
 * event, #1654 sat 38.9h. So there is no "last queue activity" clock to read;
 * the only honest question is "is it in the queue right now".
 */
export type PullRequestMergeQueueState = "enqueued" | "dequeued";

/**
 * Derive queue occupancy from the triggering action.
 *
 * Stateless by design: no read-modify-write of the prior row. That is safe
 * because every other action this webhook handler accepts either cannot occur
 * while a PR is queued (`opened`, `reopened`, `ready_for_review`) or ejects it
 * first — GitHub emits `dequeued` before `closed` on a merge (observed 1s
 * apart on #1948), and a push to a queued PR ejects it. A lost `dequeued`
 * delivery is bounded by the reader's own cap, not carried here.
 */
export function pullRequestMergeQueueState(
  input: Pick<PullRequestWorkProductInput, "action">,
): PullRequestMergeQueueState | null {
  if (input.action === "enqueued") return "enqueued";
  if (input.action === "dequeued") return "dequeued";
  return null;
}

export interface PullRequestWorkProductFields {
  externalId: string;
  title: string;
  url: string | null;
  status: IssueWorkProduct["status"];
  metadata: Record<string, unknown>;
  sourceTrust: SourceTrustMetadata;
}

export const PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE = "github_pull_request_webhook";
export const PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID = "github_pull_request_webhook";
export const PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST: SourceTrustMetadata = {
  preset: "standard",
  disposition: "promoted",
  promotedByActorType: "system",
  promotedByActorId: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
};

/**
 * Stable identity for a PR row: one PR in one repo. Deliberately excludes the
 * head SHA -- a push must update the existing row, not create a new one.
 */
export function pullRequestExternalId(repoFullName: string, prNumber: number): string {
  return `${repoFullName}#${prNumber}`;
}

/**
 * The statuses a PR work product takes while GitHub can still send another
 * `pull_request` event for it.
 *
 * PEN-2791: the stranded-assigned sweep reads this to decide whether an issue still has
 * an external event-wake path, which makes the split load-bearing in a way it was not
 * when it only drove display. `merged` and `closed` are exactly the states after which
 * no further webhook arrives, so a row in either is not evidence of attendance; a row in
 * `draft` or `ready_for_review` will produce a wake the next time the PR moves.
 *
 * Kept beside the producer rather than restated at the consumer, because the consumer is
 * a SQL `inArray` several files away and a second hand-written status list there would
 * drift silently the first time this mapping gains a state.
 */
export const OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES = ["draft", "ready_for_review"] as const;

/** Terminal counterpart. Together with the above this must cover the producer exactly. */
export const TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES = ["merged", "closed"] as const;

/**
 * Exactly the statuses `pullRequestWorkProductStatus` can return.
 *
 * Deliberately NOT `IssueWorkProduct["status"]`, which is far wider (`active`,
 * `approved`, `failed`, `archived`, ... and `| string`) and which PR rows never take
 * from the webhook. Annotating the producer with this narrow union is what makes the
 * open/terminal split above a checked partition instead of a comment: adding a fifth PR
 * state without classifying it here stops the producer compiling.
 */
export type PullRequestWorkProductStatus =
  | (typeof OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES)[number]
  | (typeof TERMINAL_PULL_REQUEST_WORK_PRODUCT_STATUSES)[number];

/**
 * Map a PR's current state onto the work-product status enum.
 *
 * Reads the PR's *state* (merged/draft) in preference to the triggering action,
 * because `synchronize` and `closed` both arrive for PRs in several states and
 * the row should describe the PR, not the event that last touched it.
 */
export function pullRequestWorkProductStatus(
  input: Pick<PullRequestWorkProductInput, "action" | "prDraft" | "prMerged">,
): PullRequestWorkProductStatus {
  if (input.prMerged === true) return "merged";
  if (input.action === "closed") return "closed";
  if (input.prDraft === true) return "draft";
  return "ready_for_review";
}

export function pullRequestWorkProductSourceEventOrder(
  status: IssueWorkProduct["status"] | string,
): number {
  if (status === "merged") return 30;
  if (status === "closed") return 20;
  return 10;
}

export function pullRequestWorkProductSourceEventActionOrder(
  input: Pick<PullRequestWorkProductInput, "action" | "prMerged">,
): number {
  if (input.prMerged === true) return 50;
  switch (input.action) {
    // Merge-queue events rank above ready_for_review because a PR must be
    // ready before it can be queued, and a dequeue above the enqueue it ends.
    // `updated_at` is second-granular, so an auto-merge that queues in the same
    // second as ready_for_review ties on timestamp, and at the default rank the
    // enqueue was rejected and mergeQueueState never recorded (BLO-35779). The
    // one ordering this gets wrong, a dequeue and re-enqueue inside one second,
    // keeps `dequeued`, which fails closed: the PR keeps its normal window.
    case "dequeued":
      return 46;
    case "enqueued":
      return 45;
    case "ready_for_review":
    case "reopened":
      return 40;
    case "closed":
      return 30;
    case "converted_to_draft":
      return 20;
    default:
      return 10;
  }
}

export function buildPullRequestWorkProductFields(
  input: PullRequestWorkProductInput,
): PullRequestWorkProductFields {
  const title = input.prTitle?.trim();
  const status = pullRequestWorkProductStatus(input);
  const sourceEventTimestampMs = input.prUpdatedAt ? Date.parse(input.prUpdatedAt) : NaN;
  const sourceEventTimestamp = Number.isFinite(sourceEventTimestampMs)
    ? new Date(sourceEventTimestampMs).toISOString()
    : null;
  return {
    externalId: pullRequestExternalId(input.repoFullName, input.prNumber),
    // `title` is NOT NULL on the row; fall back to the canonical PR ref so a
    // title-less event still produces a readable work product.
    title: title && title.length > 0
      ? title
      : `${input.repoFullName}#${input.prNumber}`,
    url: input.prUrl ?? null,
    status,
    metadata: {
      source: PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
      sourceEventOrder: pullRequestWorkProductSourceEventOrder(status),
      sourceEventActionOrder: pullRequestWorkProductSourceEventActionOrder(input),
      sourceEventTimestamp,
      sourceEventTimestampMs: sourceEventTimestamp === null ? null : sourceEventTimestampMs,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      headSha: input.headSha ?? null,
      previousHeadSha: input.previousHeadSha ?? null,
      branch: input.prBranch ?? null,
      draft: input.prDraft === true,
      merged: input.prMerged === true,
      mergedAt: input.prMergedAt ?? null,
      lastEventAction: input.action,
      // BLO-35779. Null = "this event carried no queue signal", not "not queued".
      mergeQueueState: pullRequestMergeQueueState(input),
      // Null (not `[]`) when the caller did not resolve ownership, so a
      // consumer can tell "not recorded" from "owns nothing" — see the field
      // docblock on PullRequestWorkProductInput.
      owningIdentifiers: Array.isArray(input.owningIdentifiers)
        ? [...input.owningIdentifiers]
        : null,
    },
    sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
  };
}

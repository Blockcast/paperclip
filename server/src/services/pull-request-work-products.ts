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
  /** Current GitHub pull-request state, when the payload or API supplies it. */
  prState?: "open" | "closed" | null;
  /** GitHub `action` from the pull_request event. */
  action: string;
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
 * Map a PR's current state onto the work-product status enum.
 *
 * Reads the PR's *state* (merged/draft) in preference to the triggering action,
 * because `synchronize` and `closed` both arrive for PRs in several states and
 * the row should describe the PR, not the event that last touched it.
 */
export function pullRequestWorkProductStatus(
  input: Pick<PullRequestWorkProductInput, "action" | "prDraft" | "prMerged" | "prState">,
): IssueWorkProduct["status"] {
  if (input.prMerged === true) return "merged";
  if (input.prState === "closed" || input.action === "closed") return "closed";
  if (input.prDraft === true) return "draft";
  return "ready_for_review";
}

/**
 * Stable representation of the source fields that can differ across two
 * GitHub deliveries with the same second-resolution `updated_at` timestamp.
 * It is deliberately not an ordering key: a different payload proves only
 * that the events are distinct, so the caller must reconcile their current
 * state with GitHub instead of letting receipt order choose a winner.
 */
export function pullRequestWorkProductEventFingerprint(
  input: Pick<
    PullRequestWorkProductInput,
    "action" | "headSha" | "previousHeadSha" | "prDraft" | "prMerged" | "prState"
  >,
  status: IssueWorkProduct["status"],
): string {
  return JSON.stringify({
    action: input.action,
    status,
    headSha: input.headSha ?? null,
    previousHeadSha: input.previousHeadSha ?? null,
    draft: input.prDraft === true,
    merged: input.prMerged === true,
    state: input.prState ?? null,
  });
}

export function pullRequestWorkProductNeedsReconciliation(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.sourceStateVerification === "pending";
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
      sourceEventFingerprint: pullRequestWorkProductEventFingerprint(input, status),
      sourceStateVerification: "verified",
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      headSha: input.headSha ?? null,
      previousHeadSha: input.previousHeadSha ?? null,
      branch: input.prBranch ?? null,
      draft: input.prDraft === true,
      merged: input.prMerged === true,
      mergedAt: input.prMergedAt ?? null,
      lastEventAction: input.action,
    },
    sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
  };
}

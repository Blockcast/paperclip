export type IssueWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document";

export type IssueWorkProductProvider =
  | "paperclip"
  | "github"
  | "vercel"
  | "s3"
  | "custom";

export type IssueWorkProductStatus =
  | "active"
  | "ready_for_review"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "failed"
  | "archived"
  | "draft";

/**
 * Paperclip's own BOARD-REVIEW state for a work product. **NOT a mirror of any
 * external review system, and specifically not of GitHub's `reviewDecision`.**
 *
 * ## What actually writes this
 *
 * Exactly one producer: the low-trust output promotion route
 * (`POST /api/issues/:id/low-trust/promotions`, `server/src/routes/issues.ts`),
 * which sets `approved` when a board member promotes a quarantined artifact.
 * `needs_board_review` is the pending side of that same flow, and the only
 * reader is the board-review UI (`ui/src/components/ArtifactsPanel.tsx`).
 *
 * ## Why it LOOKS like a GitHub mirror (the origin of the trap)
 *
 * Because it was designed to be one and then only half-built. The V1 plan
 * (`doc/plans/workspace-technical-implementation.md`) said of the PR states
 * `draft`/`ready_for_review`/`approved`/`changes_requested`/`merged`/`closed`:
 * *"Represent these in `status` and `review_state` rather than inventing a
 * separate PR table in V1."* `status` was wired to the webhook and carries
 * those values today. `review_state` never was. Its `approved` /
 * `changes_requested` members are the leftover PR-review vocabulary from that
 * abandoned plan, which is precisely why the field reads as a review mirror to
 * anyone who has not traced its writers. `needs_board_review` was added later
 * for the board flow, and the board flow became its only producer. The
 * "separate PR table" the plan rejected was in the end created anyway, as
 * `pull_request_review_state`.
 *
 * ## Why a GitHub PR work product always reads `none`
 *
 * The GitHub webhook never writes this column in ANY branch. It is absent from
 * the insert payload in `github-webhook.ts` (so a new row takes the schema
 * default `none`) and absent from the `onConflictDoUpdate` set clause in
 * `workProductService.upsertByExternalId` (so no later event can move it).
 * `none` on a `provider: "github", type: "pull_request"` row therefore means
 * **"this artifact has never been through Paperclip board review"** — it is the
 * correct and permanent value, not a staleness bug, and it carries NO
 * information about whether anyone has reviewed the pull request on GitHub.
 *
 * ⛔ **Do not read this field to decide whether a PR head has been reviewed.**
 * It answers that question wrongly in the UNSAFE direction: it under-reports,
 * so a reviewed-and-human-APPROVED PR looks untouched. Measured on
 * `Blockcast/onprem-k8s#8006` (PEN-5850): `reviewState: "none"` while GitHub
 * reported `reviewDecision: APPROVED` plus a live `review/ally-complete`
 * success at the identical head, for >13h. That read was the stated premise of
 * a single-use grant to force-push that head, which would have dismissed a
 * human approval; it was caught by an agent re-reading GitHub, not by anything
 * structural.
 *
 * ✅ **The authoritative live reads are GitHub's, and only GitHub's:**
 * - `gh pr view <n> --repo <owner>/<repo> --json reviewDecision`
 * - `gh api repos/<owner>/<repo>/commits/<sha>/status` (head-pinned contexts,
 *   e.g. `review/ally-complete`)
 * - `gh api repos/<owner>/<repo>/pulls/<n>/reviews` (per-review detail)
 *
 * The nearest persisted GitHub review state is the `pull_request_review_state`
 * table, which exists precisely because `issue_work_products` is
 * "webhook-shaped, no review state". ⚠ It is NOT a substitute for the live
 * reads above and cannot answer a head-pinned question: it is a reconciler
 * snapshot on its own interval, and its stored reviews carry only
 * `{authorLogin, submittedAt, state}` — no `commit_id`, and the table has no
 * head column at all (the reconciler reads `headSha` but keeps it in memory
 * for the gate re-drive and never persists it). So it can say *that* a review
 * exists, never *which head* it reviewed. Anything gating a head-moving write
 * must read GitHub.
 */
export type IssueWorkProductReviewState =
  | "none"
  | "needs_board_review"
  | "approved"
  | "changes_requested";

export interface IssueWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  type: IssueWorkProductType;
  provider: IssueWorkProductProvider | string;
  externalId: string | null;
  title: string;
  url: string | null;
  status: IssueWorkProductStatus | string;
  reviewState: IssueWorkProductReviewState;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary: string | null;
  metadata: Record<string, unknown> | null;
  sourceTrust?: import("../trust-policy.js").SourceTrustMetadata | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttachmentArtifactWorkProductMetadata {
  attachmentId: string;
  contentType: string;
  byteSize: number;
  contentPath: string;
  openPath: string;
  downloadPath: string;
  originalFilename?: string | null;
}

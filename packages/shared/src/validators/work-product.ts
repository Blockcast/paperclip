import { z } from "zod";
import { partialNoDefaults } from "../zod-compat.js";
import { workspaceFileRefSchema } from "./workspace-file-resource.js";

function attachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

export const issueWorkProductTypeSchema = z.enum([
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
]);

export const issueWorkProductStatusSchema = z.enum([
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
  "merged",
  "closed",
  "failed",
  "archived",
  "draft",
]);

export const issueWorkProductReviewStateSchema = z.enum([
  "none",
  "needs_board_review",
  "approved",
  "changes_requested",
]);

export const attachmentArtifactWorkProductMetadataSchema = z.object({
  attachmentId: z.string().guid(),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  contentPath: z.string().min(1),
  openPath: z.string().min(1),
  downloadPath: z.string().min(1),
  originalFilename: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  const contentPath = attachmentContentPath(value.attachmentId);
  if (value.contentPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contentPath"],
      message: "contentPath must point to the same-origin attachment content route",
    });
  }
  if (value.openPath !== contentPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["openPath"],
      message: "openPath must point to the same-origin attachment content route",
    });
  }
  if (value.downloadPath !== `${contentPath}?download=1`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["downloadPath"],
      message: "downloadPath must point to the same-origin attachment download route",
    });
  }
});

export type AttachmentArtifactWorkProductMetadata = z.infer<typeof attachmentArtifactWorkProductMetadataSchema>;

export const issueWorkProductMetadataSchema = z
  .object({
    resourceRef: workspaceFileRefSchema.optional().nullable(),
  })
  .passthrough();

export type IssueWorkProductMetadata = z.infer<typeof issueWorkProductMetadataSchema>;

/**
 * PEN-6119. `externalId` is deliberately NOT canonicalised here, and the reason
 * is structural rather than a preference. Two things block it:
 *
 *  - The decision needs `type` and `provider`, and `updateIssueWorkProductSchema`
 *    below is this schema made partial -- so a PATCH that sets only `externalId`
 *    carries neither, and a cross-field rule here would be evaluating fields the
 *    request does not have. The route knows the row and can resolve both.
 *  - `partialNoDefaults` takes a `ZodObject`. A `.superRefine()`/`.transform()`
 *    here makes this a `ZodEffects`, and the update schema stops compiling.
 *
 * The guard lives in `canonicalizeWorkProductExternalIdForWrite` at the bottom
 * of this file, applied by both work-product write routes.
 */
export const createIssueWorkProductSchema = z.object({
  projectId: z.string().guid().optional().nullable(),
  executionWorkspaceId: z.string().guid().optional().nullable(),
  runtimeServiceId: z.string().guid().optional().nullable(),
  type: issueWorkProductTypeSchema,
  provider: z.string().min(1),
  externalId: z.string().optional().nullable(),
  title: z.string().min(1),
  url: z.string().url().optional().nullable(),
  status: issueWorkProductStatusSchema.prefault("active"),
  reviewState: issueWorkProductReviewStateSchema.prefault("none"),
  isPrimary: z.boolean().prefault(false),
  healthStatus: z.enum(["unknown", "healthy", "unhealthy"]).prefault("unknown"),
  summary: z.string().optional().nullable(),
  metadata: issueWorkProductMetadataSchema.optional().nullable(),
  createdByRunId: z.string().guid().optional().nullable(),
});

export type CreateIssueWorkProduct = z.infer<typeof createIssueWorkProductSchema>;

export const updateIssueWorkProductSchema = createIssueWorkProductSchema.apply(partialNoDefaults);

export type UpdateIssueWorkProduct = z.infer<typeof updateIssueWorkProductSchema>;

/**
 * A GitHub pull-request URL, in any of the forms a caller is likely to be
 * holding, reduced to the canonical `owner/repo#123` work-product identity.
 *
 * PEN-5340. The reverse lookup is keyed on the exact stored `external_id`, and
 * the value a run actually has to hand is almost always the PR URL it just
 * printed. Normalising here rather than at the caller keeps the single most
 * likely lookup miss -- a URL that matches no row and is indistinguishable from
 * "no owner" -- from being the caller's problem to notice.
 */
const GITHUB_PULL_REQUEST_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** Canonical stored form: `owner/repo#123`. Must match `pullRequestExternalId`. */
const CANONICAL_EXTERNAL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+$/;

export function normalizeWorkProductExternalId(raw: string): string {
  const trimmed = raw.trim();
  const url = GITHUB_PULL_REQUEST_URL.exec(trimmed);
  if (url) return `${url[1]}#${url[2]}`;
  return trimmed;
}

export const workProductExternalIdLookupQuerySchema = z.object({
  externalId: z
    .string()
    .min(1, "externalId is required")
    .transform(normalizeWorkProductExternalId)
    // Validated AFTER normalisation so a PR URL is accepted and a typo is not.
    // A malformed id would otherwise return an empty set, which reads exactly
    // like "this PR has no owning row" -- the false-absence this lookup exists
    // to stop anyone concluding.
    .refine(
      (value) => CANONICAL_EXTERNAL_ID.test(value),
      "externalId must be `owner/repo#123` or a GitHub pull-request URL",
    ),
  provider: z.string().min(1).prefault("github"),
  type: issueWorkProductTypeSchema.prefault("pull_request"),
});

export type WorkProductExternalIdLookupQuery = z.infer<typeof workProductExternalIdLookupQuerySchema>;

/**
 * PEN-6119. The WRITE-side counterpart to
 * `workProductExternalIdLookupQuerySchema` above.
 *
 * The lookup normalises its query key and then refuses anything that is not
 * `owner/repo#123`, so every key the reader ever asks for is canonical by
 * construction. Nothing did the same for the writer:
 * `POST /api/issues/:id/work-products` stored whatever string arrived, so a run
 * registering its own pull request with the value it actually had to hand -- the
 * URL it had just printed -- wrote a row that no lookup could ever reach. That
 * is the same false empty PEN-6056 fixed for casing, on the other half of the
 * pipeline: `owners: []` with `withheldForAuthorizationCount: 0`, which reads
 * exactly like "this pull request is unowned".
 *
 * Returns the key to store, or the message to refuse with. Normalising what can
 * be normalised and refusing the rest is deliberate. A GitHub pull-request URL
 * has one canonical reading, so rewriting it is free. A value with no canonical
 * reading -- a bare `2124`, which names a different pull request in every
 * repository -- has to be refused, because a 400 naming the canonical form is
 * legible and a row nobody can look up is not.
 *
 * SCOPED TO `github` + `pull_request`, and the narrowness is the design rather
 * than caution. Measured across this company's 11,635 live work products on
 * 2026-11-08, the other types carry external ids of their own kinds -- an
 * attachment uuid on `document`, `owner/repo:path@sha` and a plain slug on
 * `artifact` -- so a transform applied across the board would reject real
 * identities that are not pull-request keys and never were.
 *
 * `provider` is matched EXACTLY, the way `listOwnersByExternalId` matches it,
 * rather than folded. A provider-folding policy here that the reader does not
 * share would reopen the very key-space split this closes, one field over.
 */
export type WorkProductExternalIdWriteDecision =
  | { ok: true; externalId: string | null | undefined }
  | { ok: false; message: string };

export function canonicalizeWorkProductExternalIdForWrite(input: {
  type: string | null | undefined;
  provider: string | null | undefined;
  externalId: string | null | undefined;
}): WorkProductExternalIdWriteDecision {
  const { externalId } = input;
  // `undefined` is a PATCH that does not mention the key, and `null` is a row
  // with deliberately no external identity. Migration 0216's unique index is
  // partial on `external_id IS NOT NULL`, so neither is in the key space this
  // guards, and rewriting either would change what the caller asked for.
  if (externalId === undefined || externalId === null) return { ok: true, externalId };
  if (input.type !== "pull_request" || input.provider !== "github") {
    return { ok: true, externalId };
  }
  const normalized = normalizeWorkProductExternalId(externalId);
  if (!CANONICAL_EXTERNAL_ID.test(normalized)) {
    return {
      ok: false,
      message:
        "externalId for a github pull_request work product must be `owner/repo#123` or a "
        + "GitHub pull-request URL, so that the stored key is the one "
        + "`work-products/by-external-id` asks for; received "
        + `${JSON.stringify(externalId)}`,
    };
  }
  return { ok: true, externalId: normalized };
}

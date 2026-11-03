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

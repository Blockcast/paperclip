import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe(
      "Dedupe token. A second create with the same key, from the same requester, while the first is still undecided replays the original approval instead of filing a duplicate.",
    )
    .optional()
    .nullable(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

/**
 * Query parameters for listing approvals. `view=summary` omits the `payload` body,
 * which is what makes a pre-file existence check cheap enough to be worth doing.
 */
export const listApprovalsQuerySchema = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
  type: z.enum(APPROVAL_TYPES).optional(),
  issueId: z.string().uuid().optional(),
  requestedByAgentId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  view: z.enum(["full", "summary", "count"]).optional().default("full"),
});

export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const approvalTitleMessage =
  "payload.title is required and must be a non-empty, non-whitespace string. " +
  "Include a short, human-readable payload.title so the card is decidable in the board queue.";

const approvalPayloadSchema = z.object({
  title: z.string({
    required_error: approvalTitleMessage,
    invalid_type_error: approvalTitleMessage,
  }).refine((title) => title.trim().length > 0, approvalTitleMessage),
}).catchall(z.unknown()).describe(
  "Free-form beyond `title`. When the decision can be stated as a concrete target value on a " +
    "specific object, ALSO include a machine-checkable `enforcement_assertions` array so the " +
    "approval-enforcement reconciler (BLO-24631) can verify the decision actually reached the " +
    "object that enforces it. Approved decisions have silently never been applied — three " +
    "confirmed instances, one of which left every one of 8 budget changes unapplied for 5 days " +
    "while the affected agent approached an auto-pause. Prose alone cannot be checked. Shape: " +
    '`enforcement_assertions: [{ kind: "budget_policy_amount", policyId: "<uuid>", ' +
    'expected_usd: 32000, label: "CTO" }]` (or `expected_amount_cents`). Today only ' +
    "`budget_policy_amount` is checked; unknown kinds are ignored, so declaring one is never " +
    "harmful and becomes useful when its resolver lands.",
);

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: approvalPayloadSchema,
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
  payload: approvalPayloadSchema.optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

/**
 * Withdrawal is the requester's own exit from the approval queue, so the reason
 * is required rather than optional: a rescinded request must say why it became
 * moot, otherwise the audit trail cannot distinguish it from an abandoned one.
 */
export const withdrawApprovalSchema = z.object({
  reason: multilineTextSchema.pipe(z.string().trim().min(1)),
});

export type WithdrawApproval = z.infer<typeof withdrawApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

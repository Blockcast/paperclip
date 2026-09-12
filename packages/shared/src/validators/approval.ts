import { z } from "zod";
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const approvalTitleMessage =
  "payload.title is required and must be a non-empty, non-whitespace string. " +
  "Include a short, human-readable payload.title so the card is decidable in the board queue.";

/**
 * Machine-readable pointer from a card to the external gate a human must act on.
 *
 * Cards that escalate a CI/deploy gate have only ever carried the run as prose in
 * `payload.title` / `summary` / `recommendedAction`, so nothing could tell whether
 * the gate a card names is still alive. Cards then outlive their runs: BLO-29359
 * recorded three `paperclip-production` gates dying unclicked in 24h, one card
 * pointing approvers at a cancelled run for ~19h, and an approver had no way to
 * see that was what happened.
 *
 * Supplying this lets `approval-gate-reconciler` close the card when the run
 * reaches a terminal state. It stays optional because most approval types have no
 * external gate — absence means "nothing to reconcile", never "gate is healthy".
 */
export const approvalGateSchema = z.object({
  kind: z.literal("github_actions_run"),
  repoFullName: z
    .string()
    .trim()
    // GitHub's real charset, not just "no slashes or spaces". The looser
    // `[^/\s]+/[^/\s]+` accepted `.` and `..` as segments, and this value is
    // interpolated into an authenticated API URL (`github-app-auth.ts`), so a
    // traversal-shaped repo name should not be expressible in the first place.
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
      "gate.repoFullName must be in owner/repo form",
    )
    // The repo half legitimately allows dots, so `.`/`..` still need an explicit reject.
    .refine(
      (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
      "gate.repoFullName must not contain `.` or `..` path segments",
    ),
  runId: z.number().int().positive(),
  url: z.string().trim().url().optional(),
});

export type ApprovalGate = z.infer<typeof approvalGateSchema>;

/**
 * Read a gate out of a persisted `payload` jsonb blob.
 *
 * Deliberately total: rows written before `gate` was validated on create may hold
 * an arbitrary value under that key, and a reconciler sweep must skip those rather
 * than throw and stall the whole batch. A malformed gate is indistinguishable from
 * no gate here — by design, since neither is reconcilable.
 */
export function parseApprovalGate(payload: unknown): ApprovalGate | null {
  if (!payload || typeof payload !== "object") return null;
  const gate = (payload as Record<string, unknown>).gate;
  if (gate === undefined || gate === null) return null;
  const parsed = approvalGateSchema.safeParse(gate);
  return parsed.success ? parsed.data : null;
}

const approvalPayloadSchema = z.object({
  title: z.string({
    required_error: approvalTitleMessage,
    invalid_type_error: approvalTitleMessage,
  }).refine((title) => title.trim().length > 0, approvalTitleMessage),
  gate: approvalGateSchema.optional(),
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

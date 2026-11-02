import { z } from "zod";
import { APPROVAL_LINKED_ISSUE_IDS_MAX, APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const approvalTitleMessage =
  "payload.title is required and must be a non-empty, non-whitespace string. " +
  "Include a short, human-readable payload.title so the card is decidable in the board queue.";

/**
 * Machine-readable pointer from a card to the external event that ends its ask.
 *
 * Cards that escalate a CI/deploy gate had only ever carried the run as prose in
 * `payload.title` / `summary` / `recommendedAction`, so nothing could tell whether
 * the gate a card names is still alive. Cards then outlive their runs: BLO-29359
 * recorded three `paperclip-production` gates dying unclicked in 24h, one card
 * pointing approvers at a cancelled run for ~19h, and an approver had no way to
 * see that was what happened.
 *
 * Supplying this lets `approval-gate-reconciler` close the card when the named
 * event reaches a terminal state. It stays optional because many asks have no
 * machine-checkable event — absence means "nothing to reconcile", never "gate is
 * healthy".
 *
 * ## Two kinds, one rule (PEN-5254)
 *
 * The rule governing BOTH kinds is: **the gate IS the ask**, not a related link.
 * The card is retired the moment the named event terminates, whether or not anyone
 * read the ask — so a gate attached to an event that merely provides context
 * retires the card for a reason that has nothing to do with it (PEN-5103).
 *
 *   - `github_actions_run` — the ask is a human clicking that Actions gate.
 *   - `github_pr_merged`   — the ask is that pull request merging.
 *
 * `github_pr_merged` exists because the Actions-only shape did not cover the event
 * most cards are actually about. Measured on the DevOps seat: 0 of 98 cards carried
 * a gate, while 19 of its 36 self-retiring cards keyed their retirement on a PR
 * merge and said so only in prose. A prose promise is void in exactly the branch
 * where the ask succeeds, because `withdraw` accepts only the undecided set and
 * returns 409 on a decided card — so those cards could never be retired by anyone.
 *
 * ⚠️ Widening this field also widens its blast radius, and deliberately so. An
 * agent has an Actions `runId` only when the ask genuinely is a deployment gate; it
 * has a PR number for nearly every card it files. The scarcity of the ref shape was
 * doing real safety work (7 well-formed gates across 854 cards), and that is why
 * `gateAlreadyTerminalRefusal` in `routes/approvals.ts` is mirrored for this kind
 * in the same change: without a file-time refusal, the first PR-gated card naming
 * yesterday's merge is dead on arrival.
 */
const gateRepoFullNameSchema = () =>
  z
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
    );

/** The ask is a human clicking a specific GitHub Actions deployment gate. */
export const approvalActionsRunGateSchema = z.object({
  kind: z.literal("github_actions_run"),
  repoFullName: gateRepoFullNameSchema(),
  runId: z.number().int().positive(),
  url: z.string().trim().url().optional(),
});

/** The ask is a specific pull request merging. */
export const approvalPullRequestGateSchema = z.object({
  kind: z.literal("github_pr_merged"),
  repoFullName: gateRepoFullNameSchema(),
  prNumber: z.number().int().positive(),
  url: z.string().trim().url().optional(),
});

export const approvalGateSchema = z.discriminatedUnion("kind", [
  approvalActionsRunGateSchema,
  approvalPullRequestGateSchema,
]);

/**
 * Every kind the reconciler is expected to sweep.
 *
 * Exported so the candidate predicate in `approval-gate-reconciler.ts` is derived
 * from this list rather than hand-repeating the literals in SQL. A kind added here
 * but missing from that predicate would be accepted at the door and then never
 * reconciled — a card that advertises self-retirement and silently never retires,
 * which is the exact defect PEN-5254 exists to remove.
 */
export const APPROVAL_GATE_KINDS = ["github_actions_run", "github_pr_merged"] as const;

export type ApprovalGateKind = (typeof APPROVAL_GATE_KINDS)[number];
export type ApprovalActionsRunGate = z.infer<typeof approvalActionsRunGateSchema>;
export type ApprovalPullRequestGate = z.infer<typeof approvalPullRequestGateSchema>;
export type ApprovalGate = z.infer<typeof approvalGateSchema>;

/**
 * Human-readable identity of the event a gate names, in one place.
 *
 * Both the reconciler's announcements and the route's refusal print this, and they
 * must agree: a card refused at the door naming `owner/repo#12` and later closed
 * naming `owner/repo run 12` would read as two different gates.
 */
export function approvalGateRef(gate: ApprovalGate): string {
  return gate.kind === "github_actions_run"
    ? `${gate.repoFullName} run ${gate.runId}`
    : `${gate.repoFullName}#${gate.prNumber}`;
}

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
  title: z.string({ error: approvalTitleMessage }).refine((title) => title.trim().length > 0, approvalTitleMessage),
  gate: approvalGateSchema.optional(),
}).catchall(z.unknown()).describe(
  // This ships in every agent's tool list on every run, so it carries the rule,
  // the shape and the error code only. Mechanics the caller needs *after* a
  // refusal (resubmit semantics, the watcher's own exemption) live in that
  // refusal's `details.remediation`, where they are read at the moment they
  // matter and cost nothing to the agents that never file a budget card.
  "Free-form beyond `title`. When the decision can be stated as a concrete target value on a " +
    "specific object, ALSO include a machine-checkable `enforcement_assertions` array so the " +
    "approval-enforcement reconciler (BLO-24631) can verify the decision actually reached the " +
    "object that enforces it — approved decisions have silently never been applied, one instance " +
    "leaving all 8 of a card's budget changes unapplied for 5 days while the affected agent " +
    "approached an auto-pause. Prose alone cannot be checked. Shape: " +
    '`enforcement_assertions: [{ kind: "budget_policy_amount", policyId: "<uuid>", ' +
    'expected_usd: 32000, label: "<the agent or scope this policy caps>" }]` ' +
    "(`expected_amount_cents` also accepted). `policyId` is a `budget_policies.id`, NOT an agent " +
    "id. `label` is printed into the drift report this assertion raises, so name the scope this " +
    "policy actually caps — never leave an example's. REQUIRED, not advisory, for " +
    "`budget_override_required`: such a card carrying no parseable assertion is refused with " +
    "`budget_approval_missing_enforcement_assertion` (BLO-34008), whose `details.remediation` " +
    "gives the full shape — approving one writes nothing to `budget_policies`, so an undeclared " +
    "figure is unverifiable forever. You do not need to supply the figure the change starts " +
    "from: the server reads it off the policy the assertion names and records it as " +
    "`from_amount_cents`, which is what lets the approval-enforcement reconciler tell a decision " +
    "that was never applied from one that was later superseded. Send `from_usd` / " +
    "`from_amount_cents` yourself only if you know a prior the policy row no longer shows — " +
    "never invent one. For every other type it stays " +
    "optional; today only `budget_policy_amount` is " +
    "checked, and unknown kinds are ignored.",
);

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: approvalPayloadSchema,
  issueIds: z.array(z.string().guid()).max(APPROVAL_LINKED_ISSUE_IDS_MAX).optional(),
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
  issueId: z.string().guid().optional(),
  requestedByAgentId: z.string().guid().optional(),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  view: z.enum(["full", "summary", "count"]).prefault("full"),
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

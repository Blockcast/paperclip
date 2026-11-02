import { z } from "zod";
import { APPROVAL_LINKED_ISSUE_IDS_MAX, APPROVAL_STATUSES, APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

const approvalTitleMessage =
  "payload.title is required and must be a non-empty, non-whitespace string. " +
  "Include a short, human-readable payload.title so the card is decidable in the board queue.";

/**
 * GitHub `owner/repo`, in the one charset GitHub actually uses.
 *
 * Shared by every gate kind because the value is interpolated into an
 * authenticated API URL (`github-app-auth.ts`): a traversal-shaped repo name
 * should not be expressible on any gate, not just the first one written. The
 * looser `[^/\s]+/[^/\s]+` accepted `.` and `..` as segments.
 */
const gateRepoFullNameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
    "gate.repoFullName must be in owner/repo form",
  )
  // The repo half legitimately allows dots, so `.`/`..` still need an explicit reject.
  .refine(
    (value) => !value.split("/").some((segment) => segment === "." || segment === ".."),
    "gate.repoFullName must not contain `.` or `..` path segments",
  );

/**
 * The ask is a human clicking a GitHub Actions deployment gate.
 *
 * Cards that escalate a CI/deploy gate have only ever carried the run as prose in
 * `payload.title` / `summary` / `recommendedAction`, so nothing could tell whether
 * the gate a card names is still alive. Cards then outlive their runs: BLO-29359
 * recorded three `paperclip-production` gates dying unclicked in 24h, one card
 * pointing approvers at a cancelled run for ~19h, and an approver had no way to
 * see that was what happened.
 */
export const approvalActionsRunGateSchema = z.object({
  kind: z.literal("github_actions_run"),
  repoFullName: gateRepoFullNameSchema,
  runId: z.number().int().positive(),
  url: z.string().trim().url().optional(),
});

/**
 * The ask is a human merging (or otherwise closing out) a pull request.
 *
 * PEN-5254. `payload.gate` is the only server-checked retirement field, and until
 * this kind existed it could express exactly one event. Measured across all 854
 * cards in the originating company: 7 carried a well-formed gate, 6 of those 7
 * auto-retired, and all 6 `cancelled` cards in the corpus were gate carriers — so
 * every automatic card retirement on record came from this field, while it was set
 * on 0.8% of cards. The other 124 hand-rolled a prose substitute ("I withdraw this
 * card when #N merges") which is void in exactly the branch where the ask succeeds,
 * because `withdraw` accepts only the undecided set and returns 409 once a card is
 * decided. Six of six requesting agents independently wrote that sentence.
 *
 * ⇒ The fleet did not fail to use the mechanism; the mechanism did not cover the
 * event. A capability gap does not surface as an error, it surfaces as six people
 * writing the same sentence.
 *
 * Named `github_pr_merged` to match the ref shape already carried by
 * `interactions.payload.expectedOutcome`, so the two surfaces spell the same event
 * the same way. The resolver is NOT shared with that surface: `expectedOutcome` is
 * evaluated by inline SQL over the webhook-fed `issue_pull_requests` mirror, while
 * this gate is read live from the GitHub API by `githubGetPullRequestGate` — the
 * same trust model as the Actions kind beside it, which is the property that
 * matters on a field that retires cards without an actor.
 */
export const approvalPullRequestGateSchema = z.object({
  kind: z.literal("github_pr_merged"),
  repoFullName: gateRepoFullNameSchema,
  prNumber: z.number().int().positive(),
  url: z.string().trim().url().optional(),
});

/**
 * Machine-readable pointer from a card to the external gate a human must act on.
 *
 * Supplying this lets `approval-gate-reconciler` close the card when the gate
 * reaches a terminal state. It stays optional because most approval types have no
 * external gate — absence means "nothing to reconcile", never "gate is healthy".
 *
 * ⚠️ It is not a general "related link" field. The card is retired the moment the
 * named gate terminates, whether or not the ask was ever read, so the gate must BE
 * the ask. Naming a CI run on the PR a card asks a human to *review* is the
 * measured failure mode (PEN-5103): two such cards died in under eight minutes
 * each. `routes/approvals.ts` refuses an already-terminal gate of either kind at
 * file time for that reason.
 */
export const approvalGateSchema = z.discriminatedUnion("kind", [
  approvalActionsRunGateSchema,
  approvalPullRequestGateSchema,
]);

export type ApprovalGate = z.infer<typeof approvalGateSchema>;
export type ApprovalGateKind = ApprovalGate["kind"];

/**
 * Every gate kind, for consumers that must enumerate them — notably the
 * reconciler's jsonb candidate predicate, which cannot read the zod union.
 *
 * The two assertions below make this list TOTAL at compile time in both
 * directions: adding a kind to `approvalGateSchema` without adding it here is a
 * type error, and so is listing a kind the schema does not accept. A plain list
 * would still fail safe — an unlisted kind is simply never reconciled — but it
 * would fail *silently*, which is the same shape of invisible coverage gap that
 * `RECONCILABLE_BY_APPROVAL_TYPE` is a total map to avoid.
 */
export const APPROVAL_GATE_KINDS = ["github_actions_run", "github_pr_merged"] as const;

// Every listed kind is a real one.
const _approvalGateKindsAreValid: readonly ApprovalGateKind[] = APPROVAL_GATE_KINDS;
void _approvalGateKindsAreValid;
// Every real kind is listed.
const _approvalGateKindsAreTotal: Exclude<
  ApprovalGateKind,
  (typeof APPROVAL_GATE_KINDS)[number]
> extends never
  ? true
  : never = true;
void _approvalGateKindsAreTotal;

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

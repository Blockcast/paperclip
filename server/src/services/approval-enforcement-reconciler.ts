/**
 * Approval-enforcement reconciler (BLO-24631).
 *
 * An approval records a *decision*. Nothing previously verified that the
 * decision was ever executed against the object that actually enforces it, so
 * a decision could be approved, read as resolved by everyone involved, and
 * never reach the enforcing row — indefinitely, with no alert. Three confirmed
 * instances; the expensive one (`304ea443`, a net-zero budget reallocation
 * across 8 agents) had **zero of eight** changes applied five days after it was
 * decided, while the agent it was meant to un-throttle climbed to 82.83% of the
 * cap the decision would have raised.
 *
 * This sweep closes the loop for the machine-checkable subset: approvals whose
 * payload carries an explicit, structured assertion about enforced state. It
 * re-reads the enforcing object and raises a deduped issue when they disagree.
 *
 * Three design constraints, each of which is a recorded failure:
 *
 * 1. **Read the enforcing object, never a display mirror.** For budgets that is
 *    `budget_policies.amount` — the row `budgetService`'s hard-stop gate reads
 *    (services/budgets.ts, the `agentPolicy.hardStopEnabled && amount > 0`
 *    check). It is emphatically NOT `agents.budget_monthly_cents`, which read
 *    $36,800 for an agent whose enforced cap was $19,000. That column is a
 *    mirror and is never consulted here.
 *
 * 2. **Parse bodies, never trust status codes.** The Paperclip API root is an
 *    SPA catch-all that answers HTTP 200 with ~2.7 KB of HTML for *any* path,
 *    so an unprefixed probe "succeeds" while returning no data and a real
 *    endpoint can look identical to a typo. This reconciler sidesteps the
 *    hazard entirely by reading the table in-process rather than over HTTP —
 *    strictly stronger than parsing. `parseJsonBodyStrict` below exists for the
 *    next resolver class (repo/branch settings), which will be HTTP-backed and
 *    must not regress into status-code probing.
 *
 * 3. **Never throw on a malformed payload.** `approvals.payload` is free-form
 *    jsonb — `approvalPayloadSchema` requires only `title`. Every field read
 *    here is defensive: an unparseable assertion is skipped, not fatal, so one
 *    bad card cannot wedge the sweep for every other card.
 *
 * 4. **Scope every enforcing read to the approval's company.** Following from
 *    (3): because the payload is free-form and agent-authored, the policy ids
 *    in it are untrusted input. An id naming a row owned by another company
 *    must resolve to "missing", not to that company's amount — otherwise the
 *    sweep both leaks a cross-tenant figure and raises false drift from it.
 */
import { and, eq, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, budgetPolicies, issues } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

/** Origin kind for the issues this sweep raises; also the dedup key. */
export const APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.approvalEnforcementDrift;

/** Backstop index for the check-then-insert race between worker replicas. */
const APPROVAL_ENFORCEMENT_DRIFT_UNIQUE_INDEX = "issues_active_approval_enforcement_drift_uq";

export function isApprovalEnforcementDriftConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const maybe = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      maybe.code === "23505" &&
      (maybe.constraint === APPROVAL_ENFORCEMENT_DRIFT_UNIQUE_INDEX ||
        maybe.constraint_name === APPROVAL_ENFORCEMENT_DRIFT_UNIQUE_INDEX ||
        (typeof maybe.message === "string" &&
          maybe.message.includes(APPROVAL_ENFORCEMENT_DRIFT_UNIQUE_INDEX)))
    ) {
      return true;
    }
    current = maybe.cause;
  }
  return false;
}

/** Approvals scanned per batch. */
const RECONCILE_BATCH_SIZE = 200;

/**
 * How long after `decidedAt` a decision is expected to have reached the
 * enforcing object. Below this, disagreement is "not applied *yet*" rather than
 * drift, and raising would be noise on every freshly-approved card.
 */
const DEFAULT_GRACE_HOURS = 6;

/**
 * The only assertion kind implemented today. Budget policies, permission
 * grants and repo/branch settings are the three classes worth checking; all
 * three known incidents fall in them. Budgets are first because that is where
 * the measured damage was.
 */
export const BUDGET_POLICY_AMOUNT_ASSERTION = "budget_policy_amount";

export interface BudgetPolicyAmountAssertion {
  kind: typeof BUDGET_POLICY_AMOUNT_ASSERTION;
  policyId: string;
  expectedAmountCents: number;
  /** Human label for the drift message (agent name); never used for matching. */
  label: string | null;
  /** Which payload shape this came from — surfaced in the raised issue. */
  source: "declared" | "legacy_exact_changes";
}

export type EnforcementAssertion = BudgetPolicyAmountAssertion;

export interface EnforcementDrift {
  assertion: EnforcementAssertion;
  /** `null` when the enforcing row is absent or inactive. */
  actualAmountCents: number | null;
  reason: "missing_policy" | "inactive_policy" | "amount_mismatch";
}

export interface EnforcedBudgetPolicy {
  policyId: string;
  amount: number;
  isActive: boolean;
}

export interface ApprovalEnforcementReconcileResult {
  scanned: number;
  withAssertions: number;
  drifted: number;
  raised: number;
  iterations: number;
}

export type ApprovalEnforcementReconcilerScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: ApprovalEnforcementReconcilerScheduler = {
  setInterval,
  clearInterval,
};

// ---------------------------------------------------------------------------
// Pure layer: payload -> assertions -> drift.
//
// Deliberately free of DB and network access so the historical cards can be
// replayed as fixtures (see the BLO-24631 regression test) without standing up
// Postgres or reconstructing five-day-old enforced state.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Non-empty trimmed string, else null. Payload fields are agent-authored. */
function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Finite number from a raw payload field, accepting the numeric strings agents
 * routinely emit ("32000", "32000.00"). Rejects NaN/Infinity so a garbage
 * figure can never become an assertion that fires forever.
 */
function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/^\+/, "").replace(/,/g, "");
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * USD -> integer cents. `budget_policies.amount` is an integer cent count and
 * decided figures are quoted in dollars, sometimes fractional (one historical
 * donor figure was 30011.4). Round rather than truncate so 30011.4 -> 3001140
 * and not 3001139.
 */
function usdToCents(usd: number): number {
  return Math.round(usd * 100);
}

/** Loose uuid check — keeps obviously-nonsense policy ids out of the sweep. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readAmountCents(entry: Record<string, unknown>): number | null {
  const cents = asFiniteNumber(entry.expected_amount_cents ?? entry.expectedAmountCents);
  if (cents !== null) return Math.round(cents);
  const usd = asFiniteNumber(entry.expected_usd ?? entry.expectedUsd ?? entry.to_usd ?? entry.toUsd);
  return usd === null ? null : usdToCents(usd);
}

/**
 * Extract machine-checkable assertions from an approval payload.
 *
 * Two accepted shapes:
 *
 * - **Canonical** (`payload.enforcement_assertions`) — what requesters should
 *   emit going forward. Explicit `kind`, so new classes can be added without
 *   guessing at prose.
 *
 * - **Legacy** (`payload.exact_changes`) — the ad-hoc shape the CEO agent
 *   actually used on card `6f45844e` (`{agent, policyId, from_usd, to_usd}`).
 *   Supported because it is what the historical cards carry, which is what
 *   makes them usable as a regression fixture rather than a rewrite.
 *
 * Anything without a resolvable `policyId` + target amount is skipped. Returns
 * `[]` for the overwhelming majority of approvals, which carry only prose —
 * that is expected and is not an error. Duplicate policyIds are collapsed
 * last-write-wins so a card that restates a figure cannot double-raise.
 */
export function extractEnforcementAssertions(payload: unknown): EnforcementAssertion[] {
  const root = asRecord(payload);
  if (!root) return [];

  const byPolicyId = new Map<string, EnforcementAssertion>();

  const push = (assertion: EnforcementAssertion) => {
    byPolicyId.set(assertion.policyId, assertion);
  };

  for (const raw of asArray(root.enforcement_assertions ?? root.enforcementAssertions)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const kind = asNonEmptyString(entry.kind);
    if (kind !== BUDGET_POLICY_AMOUNT_ASSERTION) continue;
    const policyId = asNonEmptyString(entry.policyId ?? entry.policy_id);
    if (!policyId || !UUID_PATTERN.test(policyId)) continue;
    const expectedAmountCents = readAmountCents(entry);
    if (expectedAmountCents === null || expectedAmountCents < 0) continue;
    push({
      kind: BUDGET_POLICY_AMOUNT_ASSERTION,
      policyId,
      expectedAmountCents,
      label: asNonEmptyString(entry.label ?? entry.agent ?? entry.scopeName),
      source: "declared",
    });
  }

  for (const raw of asArray(root.exact_changes ?? root.exactChanges)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const policyId = asNonEmptyString(entry.policyId ?? entry.policy_id);
    if (!policyId || !UUID_PATTERN.test(policyId)) continue;
    const expectedAmountCents = readAmountCents(entry);
    if (expectedAmountCents === null || expectedAmountCents < 0) continue;
    // A declared assertion for the same policy wins: it is the explicit form.
    if (byPolicyId.get(policyId)?.source === "declared") continue;
    push({
      kind: BUDGET_POLICY_AMOUNT_ASSERTION,
      policyId,
      expectedAmountCents,
      label: asNonEmptyString(entry.agent ?? entry.label ?? entry.scopeName),
      source: "legacy_exact_changes",
    });
  }

  return [...byPolicyId.values()];
}

/**
 * Compare decided assertions against enforced state.
 *
 * `enforced` maps policyId -> the enforcing row, or `null`/absent when no such
 * row exists. An absent row is drift, not a skip: "the policy this decision
 * names does not exist" is exactly as broken as a wrong figure, and silently
 * ignoring it would reproduce the original failure mode one level down.
 */
export function diffEnforcementAssertions(
  assertions: readonly EnforcementAssertion[],
  enforced: ReadonlyMap<string, EnforcedBudgetPolicy | null>,
): EnforcementDrift[] {
  const drifts: EnforcementDrift[] = [];
  for (const assertion of assertions) {
    const policy = enforced.get(assertion.policyId) ?? null;
    if (!policy) {
      drifts.push({ assertion, actualAmountCents: null, reason: "missing_policy" });
      continue;
    }
    if (!policy.isActive) {
      drifts.push({ assertion, actualAmountCents: policy.amount, reason: "inactive_policy" });
      continue;
    }
    if (policy.amount !== assertion.expectedAmountCents) {
      drifts.push({ assertion, actualAmountCents: policy.amount, reason: "amount_mismatch" });
    }
  }
  return drifts;
}

/**
 * Guard for HTTP-backed resolvers (none today; repo/branch settings next).
 *
 * The API root answers 200-with-HTML for any path, so `res.ok` proves nothing
 * about whether the route exists. Requires a JSON content-type AND a body that
 * parses to an object/array. Never call `res.json()` behind a bare status check.
 */
export function parseJsonBodyStrict(
  status: number,
  contentType: string | null,
  body: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (status < 200 || status >= 300) return { ok: false, reason: `http_${status}` };
  if (!contentType || !/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    return { ok: false, reason: `non_json_content_type:${contentType ?? "none"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "unparseable_json_body" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "json_body_not_object" };
  }
  return { ok: true, value: parsed };
}

// ---------------------------------------------------------------------------
// DB layer.
// ---------------------------------------------------------------------------

type ApprovalCandidate = {
  id: string;
  companyId: string;
  type: string;
  payload: unknown;
  requestedByAgentId: string | null;
  decidedAt: Date | string | null;
};

/**
 * Read the enforcing rows for one company. Selects `budget_policies` by
 * primary key *and* `company_id` — see constraint (1) in the file header on why
 * the agents-table mirror must not be substituted here, and constraint (4) on
 * why the company filter is load-bearing rather than redundant.
 *
 * A policy id naming a row owned by another company resolves to `null` (i.e.
 * `missing_policy`), which is the correct reading: from this approval's
 * company, the policy it names does not exist.
 */
export async function loadEnforcedBudgetPolicies(
  db: Pick<Db, "select">,
  companyId: string,
  policyIds: readonly string[],
): Promise<Map<string, EnforcedBudgetPolicy | null>> {
  const unique = [...new Set(policyIds)];
  const result = new Map<string, EnforcedBudgetPolicy | null>();
  for (const policyId of unique) result.set(policyId, null);
  if (unique.length === 0) return result;

  const rows = await db
    .select({
      policyId: budgetPolicies.id,
      amount: budgetPolicies.amount,
      isActive: budgetPolicies.isActive,
    })
    .from(budgetPolicies)
    .where(and(eq(budgetPolicies.companyId, companyId), inArray(budgetPolicies.id, unique)));

  for (const row of rows) {
    result.set(row.policyId, {
      policyId: row.policyId,
      amount: row.amount,
      isActive: row.isActive,
    });
  }
  return result;
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function describeDrift(drift: EnforcementDrift): string {
  const { assertion } = drift;
  const who = assertion.label ? `${assertion.label} ` : "";
  const decided = formatUsd(assertion.expectedAmountCents);
  switch (drift.reason) {
    case "missing_policy":
      return `- ${who}\`${assertion.policyId}\` — decided **${decided}**, but no budget policy with that id exists.`;
    case "inactive_policy":
      return `- ${who}\`${assertion.policyId}\` — decided **${decided}**, but the policy is **inactive** (enforced amount ${formatUsd(drift.actualAmountCents ?? 0)}); an inactive policy enforces nothing.`;
    case "amount_mismatch":
      return `- ${who}\`${assertion.policyId}\` — decided **${decided}**, enforced **${formatUsd(drift.actualAmountCents ?? 0)}**.`;
  }
}

function buildDriftIssueBody(input: {
  approvalId: string;
  approvalTitle: string | null;
  decidedAt: Date | string | null;
  drifts: EnforcementDrift[];
  assertionCount: number;
}): string {
  const decidedAtIso =
    input.decidedAt instanceof Date
      ? input.decidedAt.toISOString()
      : (input.decidedAt ?? "unknown");
  return [
    `Approval \`${input.approvalId}\` was **approved**, but ${input.drifts.length} of ${input.assertionCount} machine-checkable assertion(s) it carries do not match the object that enforces them.`,
    "",
    input.approvalTitle ? `> ${input.approvalTitle}` : "",
    "",
    `- Decided at: \`${decidedAtIso}\``,
    `- Enforcing object: \`budget_policies.amount\` (the row the budget hard-stop gate reads)`,
    "",
    "## Drift",
    ...input.drifts.map(describeDrift),
    "",
    "## Acceptance criteria",
    "- Every assertion above either matches the enforcing object, or is explicitly superseded by a newer decision recorded on this issue.",
    "- The reconciler's next pass reports zero drift for this approval.",
    "",
    "## Verifying signal",
    `- The approval-enforcement reconciler (\`${APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND}\`) reports zero drift for approval \`${input.approvalId}\` after re-reading \`budget_policies\`; the assigned owner must then close this issue. Editing a mirror column will not satisfy the check.`,
    "",
    "---",
    "Raised automatically by the approval-enforcement reconciler (BLO-24631). An approved decision that never reaches its enforcing object is invisible to everyone: the board reads it as approved and the requester reads it as resolved.",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

async function findOpenDriftIssue(db: Db, companyId: string, approvalId: string) {
  return db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND),
        eq(issues.originId, approvalId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Where the previous batch stopped. Ordering is `(decidedAt, id)` descending,
 * so the next batch wants rows strictly less than this pair.
 *
 * The `string` arm is defensive and unreachable today: `approvals.decidedAt` is
 * declared in drizzle's default `date` mode (no `mode: "string"`), so the driver
 * always hands back a `Date` and `toTimestampParam` always re-serializes at
 * millisecond precision. The keyset is still exact, but for a narrower reason
 * than "the round-trip is avoided" — every write to `decided_at` is a JS `Date`
 * every `decidedAt:` write in `approvals.ts` binds a JS `Date`, and the column
 * carries no `now()` default,
 * so the stored values have no sub-millisecond component for that round-trip to
 * lose.
 *
 * That invariant is load-bearing and sits one line away from breaking:
 * `createdAt`/`updatedAt` on the same table both carry `.defaultNow()` and
 * `decidedAt` is the only column there without one, so adding a SQL-side default
 * — or backfilling with `now()` — is the natural next edit. After it, a row at
 * `.123456` compares greater than a cursor truncated to `.123`, so it is
 * excluded from that batch and from every later one: an approved decision
 * silently never scanned, which is the exact failure this reconciler exists to
 * detect. Give the column `mode: "string"` (making the string arm live) before
 * giving it a SQL-side default.
 */
type ApprovalCursor = { decidedAt: Date | string; id: string };

/**
 * Cursor for the row a batch stopped on. Returns null for a null `decidedAt`,
 * which the `lte` predicate makes unreachable but the nullable column allows.
 */
export function approvalCursorFrom(row: {
  decidedAt: Date | string | null;
  id: string;
}): ApprovalCursor | null {
  return row.decidedAt ? { decidedAt: row.decidedAt, id: row.id } : null;
}

/**
 * A `Date` cannot be bound inside a raw `sql` template — that path goes to the
 * driver directly rather than through the column's serializer, and postgres.js
 * throws on a Date. ISO is lossless for a JS Date (both are millisecond
 * precision); a string is already a timestamp literal and is left alone.
 */
function toTimestampParam(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Paginated by keyset, deliberately not by OFFSET.
 *
 * `decidedAt` is not unique — a card list decided in one board sitting shares a
 * timestamp to the millisecond, and the eight-agent reallocation that motivated
 * this whole reconciler was exactly that shape. Ordering by a non-unique column
 * alone leaves the relative order of tied rows unspecified *per query*, so
 * across two OFFSET-paginated queries Postgres may legally return a tied row in
 * both batches or in neither. Neither is acceptable here: a skipped row is an
 * approved decision that silently never gets checked, which reproduces the exact
 * failure mode this sweep exists to detect, inside the detector.
 *
 * Appending the primary key makes the sort total, and seeking on the resulting
 * `(decidedAt, id)` tuple rather than counting rows also makes the sweep immune
 * to the set shifting underneath it: a card crossing the grace cutoff mid-sweep
 * shifts every subsequent OFFSET by one, but moves no keyset boundary.
 */
export async function listCandidateApprovals(
  db: Pick<Db, "select">,
  cutoff: Date,
  batchSize: number,
  cursor: ApprovalCursor | null,
): Promise<ApprovalCandidate[]> {
  return db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      type: approvals.type,
      payload: approvals.payload,
      requestedByAgentId: approvals.requestedByAgentId,
      decidedAt: approvals.decidedAt,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.status, "approved"),
        lte(approvals.decidedAt, cutoff),
        // Row-wise comparison, so a tie on decided_at falls through to the id.
        // Both sides are cast explicitly: the parameters are otherwise untyped
        // inside a row constructor and Postgres will not infer them. The
        // timestamp is serialized to ISO here because a raw `sql` template
        // binds through the driver directly, bypassing the column serializer
        // that would otherwise handle a Date (postgres.js rejects one outright).
        cursor
          ? sql`(${approvals.decidedAt}, ${approvals.id}) < (${toTimestampParam(cursor.decidedAt)}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(sql`${approvals.decidedAt} DESC, ${approvals.id} DESC`)
    .limit(batchSize);
}

/**
 * One sweep: scan decided approvals, compare their assertions against the
 * enforcing rows, and raise one deduped issue per drifted approval.
 *
 * Idempotent and safe from any number of replicas — the raise path re-checks
 * for an existing open issue keyed on (companyId, originKind, originId), so a
 * concurrent pass reuses rather than duplicates. Read-only with respect to
 * approvals and budget policies: it never "fixes" enforced state, because
 * silently applying a five-day-old figure over whatever a human since set is a
 * worse failure than the one being detected.
 */
export async function reconcileApprovalEnforcement(
  db: Db,
  options: {
    batchSize?: number;
    graceHours?: number;
    now?: Date;
    logger?: typeof defaultLogger;
  } = {},
): Promise<ApprovalEnforcementReconcileResult> {
  const batchSize = Math.max(1, options.batchSize ?? RECONCILE_BATCH_SIZE);
  const graceHours = Math.max(0, options.graceHours ?? DEFAULT_GRACE_HOURS);
  const now = options.now ?? new Date();
  const log = options.logger ?? defaultLogger;
  const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

  let scanned = 0;
  let withAssertions = 0;
  let drifted = 0;
  let raised = 0;
  let iterations = 0;
  let cursor: ApprovalCursor | null = null;

  while (true) {
    const candidates = await listCandidateApprovals(db, cutoff, batchSize, cursor);
    iterations += 1;
    if (candidates.length === 0) break;
    scanned += candidates.length;

    // Advance past the last row of this batch. `decidedAt` cannot be null here
    // — the `lte` predicate excludes nulls — but the column is nullable, so
    // fall back to stopping rather than seeking from a null and rescanning.
    const last = candidates[candidates.length - 1];
    cursor = approvalCursorFrom(last);
    const exhausted = candidates.length < batchSize || cursor === null;

    const parsed = candidates
      .map((approval) => ({
        approval,
        assertions: extractEnforcementAssertions(approval.payload),
      }))
      .filter((entry) => entry.assertions.length > 0);

    if (parsed.length > 0) {
      withAssertions += parsed.length;
      // Group by company before reading. A batch spans approvals from many
      // companies, and each lookup is scoped to the owning company so a payload
      // naming a foreign policy id cannot read another tenant's amount.
      const byCompany = new Map<string, string[]>();
      for (const { approval, assertions } of parsed) {
        const ids = byCompany.get(approval.companyId) ?? [];
        for (const assertion of assertions) ids.push(assertion.policyId);
        byCompany.set(approval.companyId, ids);
      }
      const enforcedByCompany = new Map<string, Map<string, EnforcedBudgetPolicy | null>>();
      for (const [companyId, policyIds] of byCompany) {
        enforcedByCompany.set(companyId, await loadEnforcedBudgetPolicies(db, companyId, policyIds));
      }

      for (const { approval, assertions } of parsed) {
        const enforced =
          enforcedByCompany.get(approval.companyId) ??
          new Map<string, EnforcedBudgetPolicy | null>();
        const drifts = diffEnforcementAssertions(assertions, enforced);
        if (drifts.length === 0) continue;
        drifted += 1;

        const existing = await findOpenDriftIssue(db, approval.companyId, approval.id);
        if (existing) {
          log.info(
            { approvalId: approval.id, issueId: existing.id, driftCount: drifts.length },
            "approval-enforcement reconciler: drift persists, open issue already tracks it (BLO-24631)",
          );
          continue;
        }

        const payloadRecord = asRecord(approval.payload);
        const approvalTitle = payloadRecord ? asNonEmptyString(payloadRecord.title) : null;
        try {
          const created = await issueService(db).create(approval.companyId, {
            title: `Approved decision never reached enforcement: ${approvalTitle ?? approval.id}`,
            description: buildDriftIssueBody({
              approvalId: approval.id,
              approvalTitle,
              decidedAt: approval.decidedAt,
              drifts,
              assertionCount: assertions.length,
            }),
            status: "todo",
            priority: "high",
            assigneeAgentId: approval.requestedByAgentId ?? undefined,
            originKind: APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND,
            originId: approval.id,
            originFingerprint: approval.id,
          });
          raised += 1;
          log.warn(
            {
              approvalId: approval.id,
              issueId: created.id,
              driftCount: drifts.length,
              assertionCount: assertions.length,
            },
            "approval-enforcement reconciler raised drift issue: approved decision never reached its enforcing object (BLO-24631)",
          );
        } catch (err) {
          if (isApprovalEnforcementDriftConflict(err)) {
            // A concurrent replica won the race and filed the same issue.
            // Coalesce onto it rather than retrying: the drift is now tracked.
            log.info(
              { approvalId: approval.id },
              "approval-enforcement reconciler: concurrent replica already raised this drift issue (BLO-24631)",
            );
            continue;
          }
          log.error(
            { err, approvalId: approval.id },
            "approval-enforcement reconciler failed to raise drift issue (BLO-24631)",
          );
        }
      }
    }

    if (exhausted) break;
  }

  return { scanned, withAssertions, drifted, raised, iterations };
}

/**
 * Start the periodic sweep. Mirrors `startStrandedBlockedIssueReconciler`: run
 * once immediately so drift surfaces without waiting a full interval, then on
 * the configured cadence. Returns a stop function.
 */
export function startApprovalEnforcementReconciler(
  db: Db,
  intervalMs: number,
  options: { batchSize?: number; graceHours?: number } = {},
  scheduler: ApprovalEnforcementReconcilerScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = reconcileApprovalEnforcement(db, options)
      .catch((err) => {
        defaultLogger.error({ err }, "approval-enforcement reconciler sweep failed (BLO-24631)");
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}

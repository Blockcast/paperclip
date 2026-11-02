/**
 * Approval-gate reconciler (BLO-29359).
 *
 * A board approval card that escalates an external gate is only a *pointer* to
 * that gate. Nothing used to reconcile the two, so a card outlived its run and
 * kept asking humans to click something that no longer existed: BLO-29359 recorded
 * three `paperclip-production` deploy gates dying unclicked inside 24h, one card
 * sending approvers to a cancelled run for ~19h, and an approver who opened it had
 * no way to tell that was what had happened. Silence was the failure mode.
 *
 * This sweep closes that loop. For each undecided approval carrying a structured
 * `payload.gate` (see `approvalGateSchema`), it asks GitHub whether the run is
 * over; if it is, the card is closed as `cancelled` and every linked issue gets a
 * comment naming the run and its conclusion. That comment is the "death is
 * announced" half — the audit trail that says *why* a card stopped being
 * actionable, which is precisely what no surface recorded before.
 *
 * Deliberate non-goals, each of which would make the sweep less safe:
 *
 *   - It never opens, dispatches, approves or rejects anything. `cancelled` is the
 *     only status it writes, and only from an undecided one.
 *   - It fails toward leaving cards alone. An unreadable or rate-limited GitHub
 *     lookup, or a run state it does not recognise, is treated as "still live" —
 *     a throttled GitHub must not be able to retire live gates in bulk.
 *   - It does not reconcile prose. Cards whose run appears only in
 *     `payload.title` are invisible to it by construction; that is why
 *     `payload.gate` exists.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueComments } from "@paperclipai/db";
import {
  APPROVAL_GATE_KINDS,
  APPROVAL_TYPES,
  APPROVAL_UNDECIDED_STATUSES,
  parseApprovalGate,
  type ApprovalGate,
  type ApprovalType,
  type IssueCommentMetadata,
} from "@paperclipai/shared";
import { logger as defaultLogger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import {
  githubGetPullRequestGate,
  githubGetWorkflowRun,
  type PullRequestGateResult,
  type WorkflowRunLookup,
} from "./github-app-auth.js";

/** Cards examined per DB batch. */
const CANDIDATE_BATCH_SIZE = 100;

/**
 * GitHub lookups per sweep. One card costs one REST call, so this is the sweep's
 * hard budget against the App's rate limit. Hitting it is logged, never silent —
 * a truncated sweep that reported success would read as "all gates verified".
 */
const MAX_LOOKUPS_PER_SWEEP = 200;

/**
 * Run states that mean the gate is over.
 *
 * GitHub overloads a run's `status` with conclusion-shaped values, so both vocabularies
 * appear here. Anything NOT in this set — `queued`, `in_progress`, `waiting`,
 * `requested`, `pending`, `action_required`, or a value GitHub adds after this was
 * written — counts as live. Unknown-means-live is the fail-safe direction: the cost of
 * holding a dead card one more sweep is a stale row, while the cost of retiring a live
 * one is a lost production deploy gate.
 */
const TERMINAL_RUN_STATES = new Set([
  "completed",
  "cancelled",
  "failure",
  "timed_out",
  "skipped",
  "stale",
  "success",
  "neutral",
]);

/**
 * Conclusion that means the gate ran to a green finish rather than dying undecided.
 *
 * ⚠️ This is a property of the RUN, never of the card's ask. Everything downstream that
 * is named `satisfied` carries that narrower meaning: "the run this card named ended
 * green". A card whose `payload.gate` points at a run that was never the ask — an
 * ordinary CI run on the PR a card asks a human to *review*, say — reaches this branch
 * and is closed, correctly, because the named gate is over. What must not follow is an
 * announcement asserting the *ask* was met; see `announcementBody` (PEN-5103).
 */
const SUCCESS_CONCLUSION = "success";

/**
 * Approval types this sweep is allowed to close.
 *
 * An allow-list rather than a deny-list: a newly added approval type is excluded
 * until someone has checked it against the rule below, because the failure mode of
 * guessing wrong is silent and permanent.
 *
 * `hire_agent` is why this exists. It parks a real agent in `pending_approval`, and
 * *both* terminal transitions in the approvals service cascade to that agent —
 * `reject` and `withdraw` each call `agentService.terminate(boundPendingAgent.id)`,
 * the latter under an explicit comment that skipping it strands the agent "frozen
 * with no remaining approval to decide it". This reconciler writes `cancelled`
 * straight through drizzle and deliberately runs no cascade, so closing a gated
 * `hire_agent` card would strand its agent permanently — with the card that could
 * have decided it now gone. `payload.gate` is accepted on every type (one shared
 * `approvalPayloadSchema` serves all of `APPROVAL_TYPES`), so nothing upstream stops
 * such a card from being filed; this predicate is the only guard.
 *
 * The three types below were each checked to have no terminal-transition cascade.
 *
 * Declared as a total map rather than a bare list so that adding an `APPROVAL_TYPE`
 * fails the typecheck here until someone classifies it. A list alone still fails
 * safe — a new type is simply never reconciled — but it fails *silently*, which is
 * the same shape of defect this sweep exists to remove. The map makes the omission
 * a compile error instead of an invisible coverage gap.
 */
const RECONCILABLE_BY_APPROVAL_TYPE: Record<ApprovalType, boolean> = {
  // Cascade-bearing: closing this card must also terminate the bound pending agent.
  hire_agent: false,
  approve_ceo_strategy: true,
  budget_override_required: true,
  request_board_approval: true,
};

const RECONCILABLE_APPROVAL_TYPES = APPROVAL_TYPES.filter(
  (type) => RECONCILABLE_BY_APPROVAL_TYPE[type],
);

export interface ApprovalGateReconcileResult {
  /** Cards examined against GitHub. */
  examined: number;
  /** Cards closed as `cancelled` because their gate had terminated. */
  closed: number;
  /** Announcement comments written across all linked issues. */
  announced: number;
  /** Cards left alone because the gate is still live. */
  live: number;
  /** Cards left alone because GitHub could not be read. */
  deferred: number;
  /**
   * Cards whose close transaction threw. They stay undecided and are retried on the
   * next sweep; a number that stays non-zero across sweeps means one card is stuck
   * rather than the queue being drained.
   */
  failed: number;
  /** True when the lookup budget cut the sweep short. */
  truncated: boolean;
}

export type ApprovalGateReconcilerScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: ApprovalGateReconcilerScheduler = { setInterval, clearInterval };

export type ApprovalGateReconcilerOptions = {
  batchSize?: number;
  maxLookups?: number;
  logger?: typeof defaultLogger;
  /** Seam for tests; defaults to the real GitHub App call. */
  fetchRun?: (input: { repoFullName: string; runId: number }) => Promise<WorkflowRunLookup>;
  /**
   * Seam for tests; defaults to the real GitHub App call (PEN-5254).
   *
   * A separate seam rather than one polymorphic fetch: the two gate kinds have
   * different result types with different fail-closed properties, and collapsing
   * them behind one signature would hide that `githubGetPullRequestGate` has no
   * card-closing failure branch at all while `githubGetWorkflowRun` has exactly one.
   */
  fetchPullRequest?: (input: {
    repoFullName: string;
    prNumber: number;
  }) => Promise<PullRequestGateResult>;
  now?: () => Date;
};

type CandidateCursor = { createdAt: Date | string; id: string };

type CandidateRow = {
  id: string;
  companyId: string;
  status: string;
  payload: unknown;
  createdAt: Date | string;
};

type GateDisposition =
  | { kind: "live" }
  | { kind: "deferred"; reason: string }
  | { kind: "terminal"; summary: string; satisfied: boolean; url: string | null };

function toRows<T>(rows: unknown): T[] {
  return (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] })?.rows ?? [])) as T[];
}

/**
 * Turn a GitHub lookup into a decision about the card.
 *
 * `not_found` is positive evidence the gate is gone and is the one non-2xx result
 * that closes a card. Every other failure defers.
 */
export function classifyGateLookup(lookup: WorkflowRunLookup): GateDisposition {
  if (lookup.outcome === "not_found") {
    return {
      kind: "terminal",
      summary: "the run no longer exists (GitHub returned 404)",
      satisfied: false,
      url: null,
    };
  }
  if (lookup.outcome === "error") {
    return { kind: "deferred", reason: lookup.reason };
  }
  if (!TERMINAL_RUN_STATES.has(lookup.status)) {
    return { kind: "live" };
  }
  // Derived from both halves for the same reason TERMINAL_RUN_STATES carries
  // conclusion-shaped values: GitHub overloads `status`, so a finished run can
  // arrive as `status: "success", conclusion: null`. Reading `conclusion` alone
  // would announce that satisfied gate as "died undecided" — the one case the
  // terminal set was widened to anticipate.
  const satisfied =
    lookup.status === SUCCESS_CONCLUSION || lookup.conclusion === SUCCESS_CONCLUSION;
  const conclusion = lookup.conclusion ?? "none";
  return {
    kind: "terminal",
    summary: `status=\`${lookup.status}\`, conclusion=\`${conclusion}\``,
    satisfied,
    url: lookup.htmlUrl,
  };
}

/**
 * Turn a pull-request lookup into a decision about the card (PEN-5254).
 *
 * ## Fail-closed, and more strongly than the Actions path
 *
 * `githubGetPullRequestGate` maps **every** non-2xx to `{ error }` — it has no
 * `not_found` branch. So unlike {@link classifyGateLookup}, there is no input on
 * which this retires a card it could not read: a deleted PR, a revoked
 * installation, a rate limit and a network fault all defer identically. That is
 * the property `githubGetWorkflowRun` needs 404 disambiguation to reach, and it is
 * why this classifier is deliberately shorter rather than symmetric.
 *
 * ## The deliberate divergence from `terminal-gate-reconciler`, and why
 *
 * That module's header states the opposite rule as a fail-closed invariant: *"Only
 * `merged` counts as satisfied. A PR closed without merging is equally terminal but
 * the work did not land … it must not read as 'done, go close the issue', and must
 * not suppress oversight."* Both halves of that rule are kept here, and only the
 * disposition differs, because the two modules act on different objects:
 *
 *   - **`satisfied` keeps its narrow meaning.** Only `merged` sets it. A PR closed
 *     without merging reports `satisfied: false` and gets its own summary string
 *     and its own announcement, so nothing downstream can read it as success.
 *   - **`terminal` is where we diverge.** That module decides whether to tell a
 *     human an *issue* looks finished, and closed-unmerged means the work is not.
 *     This module decides the fate of a *card* whose ask is "merge #N" — and once
 *     #N is closed unmerged that ask is **unsatisfiable**, not merely unmet. No
 *     human can ever approve it. Leaving it pending forever is the worse failure
 *     and is precisely the PEN-2043 supersession shape (#1058 closed, the work
 *     landed as #1122), where the gate token dies while the work ships.
 *
 * Stated rather than inherited silently: without this note two files would carry
 * opposite rules on the same predicate with nothing saying why.
 */
export function classifyPullRequestGateLookup(lookup: PullRequestGateResult): GateDisposition {
  if ("error" in lookup) {
    return { kind: "deferred", reason: lookup.error };
  }
  if (lookup.state === "open") {
    return { kind: "live" };
  }
  if (lookup.merged) {
    return {
      kind: "terminal",
      summary: "the pull request has merged",
      satisfied: true,
      url: null,
    };
  }
  return {
    kind: "terminal",
    summary: "the pull request was closed without merging",
    satisfied: false,
    url: null,
  };
}

/** Human-readable name of the gate a card points at, independent of markup. */
function gateRef(gate: ApprovalGate): string {
  return gate.kind === "github_actions_run"
    ? `${gate.repoFullName} run ${gate.runId}`
    : `${gate.repoFullName} PR #${gate.prNumber}`;
}

function gateLabel(gate: ApprovalGate, fallbackUrl: string | null): string {
  const url = gate.url ?? fallbackUrl;
  const name = gateRef(gate);
  return url ? `[${name}](${url})` : `\`${name}\``;
}

function announcementBody(input: {
  gate: ApprovalGate;
  disposition: Extract<GateDisposition, { kind: "terminal" }>;
  approvalTitle: string | null;
}): string {
  const label = gateLabel(input.gate, input.disposition.url);
  const title = input.approvalTitle ? ` — *${input.approvalTitle}*` : "";
  const isPullRequest = input.gate.kind === "github_pr_merged";
  const headline = isPullRequest
    ? input.disposition.satisfied
      ? "Approval card closed: the pull request it pointed at has merged"
      : "Approval card closed: the pull request it pointed at was closed without merging"
    : input.disposition.satisfied
      ? "Approval card closed: the gate it pointed at has already completed"
      : "Approval card closed: the gate it pointed at died undecided";

  // Four texts rather than two, because the PR kind's unsatisfied branch is NOT
  // "the gate died before anyone could act" — it is "the gate became unsatisfiable
  // while the work possibly shipped elsewhere" (PEN-2043). Collapsing them would
  // send a reader looking for an abandoned gate instead of a successor PR.
  const consequence = isPullRequest
    ? input.disposition.satisfied
      ? [
          "**This does not say the card's ask was met.** The only thing read here is the named",
          "pull request's own state: it merged, so the merge this card was waiting on has",
          "happened and the card can no longer be approved. If the card asked for anything",
          "beyond that merge, it still has not happened — re-file it.",
        ].join(" ")
      : [
          "**The work did not land, and nobody approved or rejected this card.** The pull",
          "request was closed without merging, which makes this card's gate *unsatisfiable*:",
          "no human can ever merge that PR now, so the card was closed as `cancelled` rather",
          "than left asking for something impossible. **This is not a success.** If the work",
          "was superseded by a different pull request, file a new card naming that one; if it",
          "was abandoned, nothing further is owed.",
        ].join(" ")
    : input.disposition.satisfied
      ? [
          "**This does not say the card's ask was met.** The only thing read here is the named",
          "run's own outcome: it finished green, so there is no longer a gate for anyone to click",
          "and this card can no longer be approved. If the thing the card actually asked for has",
          "not happened, it still has not happened. Re-file it — and attach `payload.gate` only",
          "when the gate IS the ask, because the card dies when that gate ends. For an Actions",
          "deployment gate use `{kind: \"github_actions_run\", runId}`; for a merge click use",
          "`{kind: \"github_pr_merged\", prNumber}`; for a credential grant or an operator",
          "action use neither.",
        ].join(" ")
      : [
          "**Nobody approved or rejected it — the run ended first.** The card was closed as",
          "`cancelled` rather than left pointing at a dead gate. If this work still needs a",
          "deploy, a *new* run must be dispatched and a new card filed; this card can no",
          "longer be approved.",
        ].join(" ");

  return [
    `## ${headline}${title}`,
    "",
    `Gate: ${label} — ${input.disposition.summary}.`,
    "",
    consequence,
    "",
    "<sub>Posted by the approval-gate reconciler (BLO-29359), which closes approval cards",
    "whose external gate has terminated. Before this existed, a dead gate was silent and",
    "the card stayed in the queue indefinitely.</sub>",
  ].join("\n");
}

/**
 * Label of the metadata row that records which card an announcement belongs to.
 *
 * This is load-bearing, not decoration. `issueCommentMetadataSchema` is `.strict()`
 * and permits only `version` / `sourceRunId` / `sections`, so the provenance cannot
 * live in ad-hoc top-level keys: a blob shaped that way is rejected on read by
 * `issueCommentMetadataSchema.nullable().catch(null)`, which means every API consumer
 * silently sees `metadata: null` and the audit trail this sweep exists to produce is
 * lost. Keeping the card identity inside a schema-legal `key_value` row is what lets
 * the idempotency probe stay an indexable jsonb containment match.
 */
const RECONCILED_CARD_LABEL = "Reconciled approval card";

/**
 * Dedupe key for an announcement, unique per (issue, approval).
 *
 * Backed by `issue_comments_issue_system_idempotency_idx`, so this is enforced by
 * the database rather than checked by a preceding read.
 */
function announcementIdempotencyKey(approvalId: string): string {
  return `approval-gate-reconciler:${approvalId}`;
}

/**
 * Provenance for one announcement, in the only shape the comment contract accepts.
 *
 * Typed as `IssueCommentMetadata` on purpose: the column is
 * `jsonb().$type<IssueCommentMetadata | null>()`, so a non-conforming blob is a
 * compile error here rather than a silent `null` at the read path.
 */
function announcementMetadata(input: {
  approvalId: string;
  gate: ApprovalGate;
  satisfied: boolean;
}): IssueCommentMetadata {
  return {
    version: 1,
    sections: [
      {
        title: "Approval gate",
        rows: [
          { type: "key_value", label: RECONCILED_CARD_LABEL, value: input.approvalId },
          {
            type: "key_value",
            label: input.gate.kind === "github_pr_merged" ? "GitHub pull request" : "GitHub run",
            value: gateRef(input.gate),
          },
          // Labelled for what it measures — the gate's own outcome — not for whether
          // the card got what it asked for. The old label read `Gate satisfied`, which
          // a reader of a mis-attached gate reasonably took as "the escalation landed"
          // (PEN-5103). Nothing outside this sweep's own tests reads the label.
          {
            type: "key_value",
            label:
              input.gate.kind === "github_pr_merged"
                ? "Named pull request merged"
                : "Named run finished green",
            value: input.satisfied ? "yes" : "no",
          },
        ],
      },
    ],
  };
}

async function listCandidateApprovals(
  db: Db,
  batchSize: number,
  cursor: CandidateCursor | null,
): Promise<CandidateRow[]> {
  const conditions = [
    inArray(approvals.status, [...APPROVAL_UNDECIDED_STATUSES]),
    // Cascade-bearing types are excluded here, not downstream: see
    // RECONCILABLE_APPROVAL_TYPES. A gated `hire_agent` card must stay pending.
    inArray(approvals.type, [...RECONCILABLE_APPROVAL_TYPES]),
    // Both gate kinds (PEN-5254). Derived from the schema's own union rather than
    // re-spelled here: a kind added to `approvalGateSchema` that is not added to
    // this list is silently never reconciled, which is the exact shape of silent
    // coverage gap `RECONCILABLE_BY_APPROVAL_TYPE` is a total map to avoid.
    inArray(sql`${approvals.payload}->'gate'->>'kind'`, [...APPROVAL_GATE_KINDS]),
  ];
  if (cursor) {
    // postgres.js will not bind a Date into a raw `sql` fragment (it only accepts
    // string/Buffer there), so normalize before the row comparison.
    const createdAt =
      cursor.createdAt instanceof Date ? cursor.createdAt.toISOString() : String(cursor.createdAt);
    conditions.push(
      sql`(${approvals.createdAt}, ${approvals.id}) > (${createdAt}::timestamptz, ${cursor.id}::uuid)`,
    );
  }
  const rows = await db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      status: approvals.status,
      payload: approvals.payload,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(and(...conditions))
    .orderBy(asc(approvals.createdAt), asc(approvals.id))
    .limit(batchSize);
  return toRows<CandidateRow>(rows);
}

/**
 * Close one card and announce it on every linked issue, in a single transaction.
 *
 * The status write requires the row to still be undecided, so a human decision that
 * lands mid-sweep wins and no announcement is posted for a card we did not close.
 * Announcements additionally carry the card id in a `key_value` metadata row, so a
 * retried or overlapping sweep cannot double-post.
 */
async function closeAndAnnounce(
  db: Db,
  input: {
    candidate: CandidateRow;
    gate: ApprovalGate;
    disposition: Extract<GateDisposition, { kind: "terminal" }>;
    now: Date;
  },
): Promise<{ closed: boolean; announced: number }> {
  const { candidate, gate, disposition, now } = input;
  const payload = (candidate.payload ?? {}) as Record<string, unknown>;
  const approvalTitle = typeof payload.title === "string" ? payload.title : null;
  const note = disposition.satisfied
    ? `Gate completed before a decision was recorded (${gateRef(gate)}: ${disposition.summary}). Closed by the approval-gate reconciler.`
    : gate.kind === "github_pr_merged"
      ? `Gate became unsatisfiable (${gateRef(gate)}: ${disposition.summary}). Closed by the approval-gate reconciler.`
      : `Gate died undecided (${gateRef(gate)}: ${disposition.summary}). Closed by the approval-gate reconciler.`;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const updated = await txDb
      .update(approvals)
      .set({
        status: "cancelled",
        decisionNote: note,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, candidate.id), inArray(approvals.status, [...APPROVAL_UNDECIDED_STATUSES])))
      .returning({ id: approvals.id, type: approvals.type });

    const row = toRows<{ id: string; type: string }>(updated)[0];
    // Lost the race to a real decision — leave the thread alone.
    if (!row) return { closed: false, announced: 0 };

    const links = toRows<{ issueId: string; companyId: string }>(
      await txDb
        .select({ issueId: issueApprovals.issueId, companyId: issueApprovals.companyId })
        .from(issueApprovals)
        .where(eq(issueApprovals.approvalId, candidate.id)),
    );

    let announced = 0;
    for (const link of links) {
      // Dedupe in the database rather than by probing first. `idempotencyKey` is
      // covered by `issue_comments_issue_system_idempotency_idx`, a partial UNIQUE
      // index over exactly the rows written here (`author_agent_id IS NULL AND
      // author_user_id IS NULL AND deleted_at IS NULL`), so at-most-once is enforced
      // rather than checked. That is strictly stronger than the select-then-insert
      // this replaced, which two concurrent sweeps could both pass before either
      // wrote, and it needs no jsonb containment match to stay correct.
      //
      // The status write above is still the primary guarantee — only one transaction
      // can win it, and `cancelled` is terminal — but this keeps a future path back
      // to undecided from silently double-posting.
      const insertedComment = toRows<{ id: string }>(
        await txDb
          .insert(issueComments)
          .values({
            companyId: link.companyId,
            issueId: link.issueId,
            authorType: "system",
            idempotencyKey: announcementIdempotencyKey(candidate.id),
            body: announcementBody({ gate, disposition, approvalTitle }),
            metadata: announcementMetadata({
              approvalId: candidate.id,
              gate,
              satisfied: disposition.satisfied,
            }),
          })
          .onConflictDoNothing()
          .returning({ id: issueComments.id }),
      )[0];
      if (insertedComment) announced += 1;
    }

    await logActivity(txDb, {
      companyId: candidate.companyId,
      actorType: "system",
      actorId: "approval-gate-reconciler",
      action: "approval.cancelled",
      entityType: "approval",
      entityId: candidate.id,
      details: {
        type: row.type,
        reason: note,
        repoFullName: gate.repoFullName,
        gateKind: gate.kind,
        // Only ever one of these, and the absent one is omitted rather than null:
        // a `runId: null` on a PR-gated card reads as "we looked for a run and
        // there wasn't one" to anything querying this log.
        ...(gate.kind === "github_actions_run"
          ? { runId: gate.runId }
          : { prNumber: gate.prNumber }),
        gateSatisfied: disposition.satisfied,
        announcedIssues: announced,
      },
      // The announcement comments are part of this transaction. A fire-and-forget
      // plugin event would outlive a rollback and tell every listener the card was
      // decided while it is in fact still pending.
      atomicPluginEvent: true,
    });

    return { closed: true, announced };
  });
}

/**
 * One sweep. Idempotent and safe to run concurrently with itself or with a human
 * using the board: every write re-checks that the card is still undecided.
 */
export async function reconcileApprovalGates(
  db: Db,
  options: ApprovalGateReconcilerOptions = {},
): Promise<ApprovalGateReconcileResult> {
  const batchSize = Math.max(1, options.batchSize ?? CANDIDATE_BATCH_SIZE);
  const maxLookups = Math.max(1, options.maxLookups ?? MAX_LOOKUPS_PER_SWEEP);
  const log = options.logger ?? defaultLogger;
  const fetchRun = options.fetchRun ?? githubGetWorkflowRun;
  const fetchPullRequest = options.fetchPullRequest ?? githubGetPullRequestGate;
  const now = options.now ?? (() => new Date());

  const result: ApprovalGateReconcileResult = {
    examined: 0,
    closed: 0,
    announced: 0,
    live: 0,
    deferred: 0,
    failed: 0,
    truncated: false,
  };
  const closedSamples: string[] = [];
  let cursor: CandidateCursor | null = null;
  let budgetExhausted = false;

  while (!budgetExhausted) {
    const candidates = await listCandidateApprovals(db, batchSize, cursor);
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      const gate = parseApprovalGate(candidate.payload);
      // Matched the jsonb predicate but failed full validation: a malformed gate is
      // not reconcilable, and skipping it must not consume lookup budget.
      if (!gate) {
        cursor = { createdAt: candidate.createdAt, id: candidate.id };
        log.warn(
          { approvalId: candidate.id },
          "approval-gate reconciler skipped a card whose payload.gate failed validation (BLO-29359)",
        );
        continue;
      }

      // Stop before consuming this row, and leave the cursor behind it, so the
      // post-loop probe can tell whether anything was genuinely left unchecked.
      if (result.examined >= maxLookups) {
        budgetExhausted = true;
        break;
      }
      cursor = { createdAt: candidate.createdAt, id: candidate.id };
      result.examined += 1;

      // Dispatch by kind. Each arm pairs its own fetch with its own classifier:
      // the two result shapes have different fail-closed properties (see
      // `classifyPullRequestGateLookup`) and must not be narrowed to a common one.
      let disposition: GateDisposition;
      try {
        disposition =
          gate.kind === "github_actions_run"
            ? classifyGateLookup(
                await fetchRun({ repoFullName: gate.repoFullName, runId: gate.runId }),
              )
            : classifyPullRequestGateLookup(
                await fetchPullRequest({
                  repoFullName: gate.repoFullName,
                  prNumber: gate.prNumber,
                }),
              );
      } catch (err) {
        result.deferred += 1;
        log.warn(
          { err, approvalId: candidate.id, gate: gateRef(gate) },
          "approval-gate reconciler could not read the gate; leaving the card pending",
        );
        continue;
      }

      if (disposition.kind === "live") {
        result.live += 1;
        continue;
      }
      if (disposition.kind === "deferred") {
        result.deferred += 1;
        log.warn(
          {
            approvalId: candidate.id,
            gate: gateRef(gate),
            reason: disposition.reason,
          },
          "approval-gate reconciler deferred a card because GitHub was unreadable (BLO-29359)",
        );
        continue;
      }

      let outcome: { closed: boolean; announced: number };
      try {
        outcome = await closeAndAnnounce(db, { candidate, gate, disposition, now: now() });
      } catch (err) {
        // Symmetric with the guarded `fetchRun` above, and for a sharper reason: an
        // unguarded throw here (deadlock, an FK violation on the comment insert, an
        // outbox failure in logActivity) propagates out of the sweep and is swallowed
        // by the caller's `.catch`. Because every sweep restarts at `cursor = null`
        // ordered by `(createdAt, id)`, the same early card would be re-encountered
        // first on every tick and would starve every card behind it indefinitely —
        // the silent-cap failure the `truncated` counter exists to prevent, arriving
        // through a different door.
        result.failed += 1;
        log.error(
          { err, approvalId: candidate.id, gate: gateRef(gate) },
          "approval-gate reconciler could not close a card; left it pending and continued (BLO-29359)",
        );
        continue;
      }
      if (!outcome.closed) continue;
      result.closed += 1;
      result.announced += outcome.announced;
      if (closedSamples.length < 10) closedSamples.push(candidate.id);
    }

    if (budgetExhausted) break;
    if (candidates.length < batchSize) break;
  }

  // `truncated` must mean "at least one card was definitely not checked", not
  // "the budget happened to run out". Those differ whenever the budget boundary
  // lands exactly on a batch boundary, and reporting the second as the first is
  // the silent cap this counter exists to prevent — so probe for one more row
  // rather than inferring it.
  //
  // The probe shares the candidate predicate, which cannot express "has a *valid*
  // gate" (validation is `parseApprovalGate`, in JS). So a tail consisting only of
  // malformed-gate rows reports `truncated: true` when nothing reconcilable was
  // actually skipped. That over-reports rather than under-reports, which is the
  // fail-safe direction for this counter and consistent with unknown-means-live
  // above: a spurious "check again" costs one probe, a missed cap hides work.
  if (budgetExhausted) {
    result.truncated = (await listCandidateApprovals(db, 1, cursor)).length > 0;
  }

  if (result.closed > 0) {
    log.info(
      { ...result, sample: closedSamples },
      "approval-gate reconciler closed approval cards whose GitHub gate had terminated (BLO-29359)",
    );
  }
  if (result.failed > 0) {
    log.warn(
      { ...result },
      "approval-gate reconciler left cards pending after close failures; they retry next sweep (BLO-29359)",
    );
  }
  if (result.truncated) {
    log.warn(
      { ...result, maxLookups },
      "approval-gate reconciler hit its GitHub lookup budget; remaining cards are checked next sweep",
    );
  }

  return result;
}

/**
 * Start the periodic sweep. Mirrors `startStrandedBlockedIssueReconciler`: one
 * immediate pass so existing debris clears without waiting a full interval, then on
 * the configured cadence. Returns a stop function.
 */
export function startApprovalGateReconciler(
  db: Db,
  intervalMs: number,
  options: ApprovalGateReconcilerOptions = {},
  scheduler: ApprovalGateReconcilerScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = reconcileApprovalGates(db, options)
      .catch((err) => {
        defaultLogger.error({ err }, "approval-gate reconciler sweep failed");
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

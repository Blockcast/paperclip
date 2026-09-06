/**
 * Rejects Paperclip issues that duplicate an already-live GitHub PR review.
 *
 * Agent instructions have long said "do not create a separate Ally review
 * issue solely to wake the reviewer" — the sanctioned path is a
 * `<!-- paperclip:review-request -->` marker comment on the PR, which the
 * GitHub webhook turns into exactly one wake. The prohibition did not hold:
 * measured 2026-08-02, 44% of the reviewer's 24h runs were issue-board work
 * and 91.8% of those were on issues whose title referenced a PR number. One
 * duplicated request costs 4-11 reviewer runs; the webhook path costs 1, and
 * the duplicates contend for the same `maxConcurrentRuns` budget as genuine
 * review wakes (BLO-20526, parent BLO-20491).
 *
 * The guard fires only on a genuine collision — all four must hold:
 *   1. the assignee is a configured PR reviewer (PAPERCLIP_PR_REVIEWER_AGENT_IDS),
 *   2. the issue resolves to a GitHub PR — either from the structured
 *      `prReviewTarget` or from a canonical PR URL in its text,
 *   3. that exact PR already has a queued/running review run in the configured
 *      reviewer pool, and
 *   4. the issue does not carry the `paperclip:not-a-review-request` marker.
 *
 * Condition 4 is the escape hatch for the one false-positive class this guard
 * cannot detect: an issue ABOUT the review rather than a request for one. Those
 * cite the permalink exactly like a duplicate request does. The 409 names the
 * marker so a blocked filer can discover it without reading this file.
 *
 * Keying on the collision rather than on the assignee is deliberate: issues
 * about the reviewer's own tooling stay creatable, and creator identity is
 * useless as a signal here (68% of the measured duplicates were attributed to
 * a user rather than to the filing agent).
 *
 * Failure direction is open. An unparseable reference, a lookup error, or a
 * failed advisory-lock statement all let the issue through — a duplicate review
 * issue is a cost problem, whereas wrongly blocking issue creation is a
 * correctness problem.
 *
 * On the SQL paths that posture costs more than a `catch`, and treating it as
 * free is what produced a real defect here. The caller hands us its in-flight
 * issue-create transaction, and a failed statement aborts *that* transaction:
 * every later statement then raises 25P02 and the create 500s no matter what
 * this module returns. So swallowing the error is only half of failing open.
 * The other half is `rollback to savepoint`, the one statement that restores a
 * usable transaction (measured; pinned against a real server in
 * packages/db/src/advisory-xact-lock-savepoint.test.ts). Both SQL paths in this
 * module therefore run inside a savepoint they can roll back, and both roll it
 * back at the first failure rather than continuing to issue statements that are
 * already guaranteed to fail. The one case this cannot cover is a transaction
 * that was ALREADY aborted before the guard ran: `savepoint` itself fails then,
 * and nothing this module can do from inside clears it.
 *
 * Eligible creates take the normalized PR-scope advisory locks before the
 * issue-create title and idempotency locks. The webhook takes the same
 * normalized namespace as part of its compatibility lock set, so its wake
 * commit is visible before this guard reads. During the compatibility rollout,
 * production keeps this guard disabled until every webhook pod takes that
 * normalized lock: arbitrary canonical GitHub casing cannot be reconstructed
 * from a user-authored URL. Acquiring these locks first keeps the lock order
 * consistent and avoids coupling unrelated issue creates to the webhook path.
 *
 * That acquisition is *bounded* and gives up rather than waiting (see
 * lockPrReviewIssueScopes). Serialization is an optimization on a fail-open
 * cost guard, so it never gets to outrank issue creation itself. The residual
 * — one duplicate that slips through while the webhook's wake is still
 * uncommitted — remains tracked as BLO-21790.
 */
import { type Db, heartbeatRuns } from "@paperclipai/db";
import { type Column, type SQL, and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { readGithubPrReviewerAgentIds } from "../config.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DuplicatePrReviewIssueGuardDb = Pick<DbTransaction, "select" | "transaction">;

/**
 * A review is "already live" while its run is queued or in flight. Mirrors
 * EXECUTION_PATH_HEARTBEAT_RUN_STATUSES in services/heartbeat.ts; a terminal
 * run means the previous review is finished and a fresh request is legitimate.
 */
const LIVE_PR_REVIEW_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * Canonical GitHub PR permalink. Deliberately the *only* accepted form: 99% of
 * the measured duplicate filings carried one (400-issue sample), and a bare
 * "#1911" cannot be resolved to a repo, so matching it would risk rejecting a
 * legitimate issue that happens to share a number with a busy PR in some other
 * repo. The residual 1% is accepted load, not a correctness gap.
 *
 * The trailing lookahead requires a real boundary after the number so that
 * "/pull/1911abc" does not silently resolve to PR 1911 and hard-reject a create
 * over a malformed or unrelated reference.
 */
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?![\w-])/gi;

/** Bounds the work done on a hostile or pathological description. */
const MAX_SCANNED_PULL_REQUEST_REFS = 20;

/**
 * Truncation is fail-open — the unscanned tail is simply unguarded, which is
 * the right direction — but it must not be silent. Returning 20 of 40 refs with
 * no record makes "the guard did not fire" indistinguishable from "the guard
 * decided not to fire".
 */
function warnScanCapReached(): void {
  logger.warn(
    { cap: MAX_SCANNED_PULL_REQUEST_REFS },
    "pr review duplicate guard hit its PR-reference scan cap; references beyond the cap "
      + "are not guarded",
  );
}

/**
 * Explicit opt-out for the false-positive class this guard cannot detect.
 *
 * The guard fires on any canonical PR permalink in the title, description, or
 * structured target, and does NOT check that the issue is a review *request*.
 * That is deliberate — the measured duplicates put the reference in the title
 * 91.8% of the time, and every intent heuristic tried (title prefix, position,
 * keyword) also matched legitimate meta-issues. So rather than guess, let the
 * filer declare intent:
 *
 *   "Ally's review of <PR URL> exited with pr_review_output_missing"
 *
 * is a real issue that must stay creatable. Before this marker the only way
 * past the 409 was the global kill switch, and the rejection's remediation
 * ("post a review-request marker comment on the PR") was actively wrong there —
 * following it queues a second review of a PR whose review is already broken.
 */
export const NOT_A_REVIEW_REQUEST_MARKER = "<!-- paperclip:not-a-review-request -->";

function declaresNotAReviewRequest(candidate: DuplicatePrReviewIssueCandidate): boolean {
  // Case-insensitive on purpose, not redundantly: the marker is an opt-OUT of a
  // hard block, so a filer who typed `<!-- Paperclip:Not-A-Review-Request -->`
  // should not be left staring at a 409 that quotes back what looks like the
  // string they already used.
  return `${candidate.title ?? ""}\n${candidate.description ?? ""}`
    .toLowerCase()
    .includes(NOT_A_REVIEW_REQUEST_MARKER);
}

export const DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE = "duplicate_pr_review_issue";

/**
 * Kill switch. This guard rejects writes on the issue-creation path for every
 * company, so it needs an off switch that does NOT also disable webhook
 * reviewer routing (clearing PAPERCLIP_PR_REVIEWER_AGENT_IDS would).
 *
 * Accepts the usual truthy spellings, not just "1"/"true". This is the one
 * place in the module that fails toward BLOCKING writes, so an operator who
 * sets the variable to "yes" mid-incident and gets a still-enforcing guard has
 * been handed the worst outcome silently. Anything set but unrecognized is
 * logged rather than quietly ignored.
 */
const TRUTHY_KILL_SWITCH_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSEY_KILL_SWITCH_VALUES = new Set(["", "0", "false", "no", "off", "disabled"]);

function guardDisabled(): boolean {
  const raw = process.env.PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD?.trim().toLowerCase();
  if (raw === undefined) return false;
  if (TRUTHY_KILL_SWITCH_VALUES.has(raw)) return true;
  if (!FALSEY_KILL_SWITCH_VALUES.has(raw)) {
    logger.warn(
      { value: raw },
      "PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD is set to an unrecognized value; the "
        + "duplicate-review guard remains ENABLED and will reject issue creates. Use one of: "
        + [...TRUTHY_KILL_SWITCH_VALUES].join(", "),
    );
  }
  return false;
}

export type PullRequestRef = {
  repoFullName: string;
  prNumber: number;
};

export function normalizePrReviewRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

/** Prefix identifying a task key that is scoped to one GitHub pull request. */
const PR_REVIEW_TASK_KEY_PREFIX = "pr_review:";

export function isPrReviewTaskKey(taskKey: string): boolean {
  return taskKey.startsWith(PR_REVIEW_TASK_KEY_PREFIX);
}

/**
 * The single compatibility predicate for matching a live `context_task_key`.
 *
 * GitHub owner/repo identity is case-insensitive. The transition deploys this
 * dual-read predicate before changing producers: old pods only understand the
 * mixed-case GitHub spelling, while compatibility-aware pods understand both.
 * Switching writes in the same deployment would be asymmetric and let an old
 * pod miss a normalized row after the advisory lock is released.
 *
 * Every equality check against a live task key must go through here so the
 * transition is uniform: affinity lookup, coalescing, cancellation, the
 * queued-to-running dispatch lock, and this module's own duplicate lookup.
 * Non-PR keys keep plain `IN (…)` equality, so
 * unrelated task scopes see no behavioural or planner change. Once no
 * old readers remain, producers can switch to normalized keys in a later
 * release; after mixed-case rows drain, the `lower()` leg can be dropped.
 *
 * `column` is widened to any SQL expression because the dispatch lock compares
 * `coalesce(context_task_key, context_snapshot ->> 'taskKey')` rather than a
 * bare column, and open-coding a second predicate there is exactly how the two
 * spellings drift back apart.
 */
export function matchesAnyTaskKey(column: Column | SQL, taskKeys: readonly string[]): SQL {
  const exact = [...new Set(taskKeys)];
  const legacyCasingCandidates = [
    ...new Set(exact.filter(isPrReviewTaskKey).map((taskKey) => taskKey.toLowerCase())),
  ];
  // Render either input as one SQL expression: a bare Column and a composed
  // expression have incompatible `inArray` overloads, and a plain column still
  // renders as its qualified reference, so the index-backed plan is unchanged.
  const target = sql`${column}`;
  const exactLeg = inArray(target, exact);
  if (legacyCasingCandidates.length === 0) return exactLeg;
  const legacyCasingLeg = inArray(sql`lower(${target})`, legacyCasingCandidates);
  return or(exactLeg, legacyCasingLeg) ?? exactLeg;
}

/** Single-key form of {@link matchesAnyTaskKey}. */
export function matchesTaskKey(column: Column | SQL, taskKey: string): SQL {
  return matchesAnyTaskKey(column, [taskKey]);
}

/**
 * Every advisory-lock namespace that must be held to serialize one PR scope.
 *
 * The lock id is `hashtextextended(taskKey, 0)`, so the *spelling* selects the
 * namespace: locking only the caller's spelling gives no mutual exclusion
 * against a peer that spelled the same PR the other way. Sorted so every
 * caller acquires the pair in one order and two peers contending for the same
 * PR cannot livelock by grabbing opposite halves. Mirrors
 * `buildPrReviewerTaskLockKeys` in routes/github-webhook.ts; retire both
 * alongside the `lower()` legs above.
 */
export function prReviewTaskLockSpellings(taskKey: string): string[] {
  if (!isPrReviewTaskKey(taskKey)) return [taskKey];
  return [...new Set([taskKey, taskKey.toLowerCase()])].sort();
}

/**
 * In-memory counterpart of {@link matchesAnyTaskKey}, for the execution-path
 * checks that compare task keys already loaded into JS rather than in SQL.
 * Must stay behaviourally identical to the SQL form or the two paths disagree
 * about whether a legacy run is the same scope.
 */
export function taskKeysMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left ?? null;
  const b = right ?? null;
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (!isPrReviewTaskKey(a) || !isPrReviewTaskKey(b)) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Canonical counterpart of the phase-one legacy producer in
 * `buildPrReviewerTaskKey` (server/src/routes/github-webhook.ts). They resolve
 * to the same scope through `matchesAnyTaskKey`; byte identity is deliberately
 * deferred until old readers have drained.
 */
export function buildPrReviewTaskKey(ref: PullRequestRef): string {
  return `pr_review:${normalizePrReviewRepoFullName(ref.repoFullName)}:${ref.prNumber}`;
}

/** Extracts unique canonical GitHub PR references from free text. */
function parsePullRequestRefsWithCasing(
  preserveRepoCasing: boolean,
  ...texts: Array<string | null | undefined>
): PullRequestRef[] {
  const seen = new Map<string, PullRequestRef>();
  for (const text of texts) {
    if (!text) continue;
    // The pattern is /g, so reset lastIndex rather than sharing state across calls.
    GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GITHUB_PULL_REQUEST_URL_PATTERN.exec(text)) !== null) {
      const [, owner, repo, rawNumber] = match;
      const prNumber = Number.parseInt(rawNumber, 10);
      // GitHub PR numbers are positive; a leading-zero or overflowing value is
      // not a real PR and must not be normalized into one.
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0) continue;
      if (String(prNumber) !== rawNumber) continue;
      const sourceRepoFullName = `${owner}/${repo}`;
      const ref: PullRequestRef = {
        repoFullName: preserveRepoCasing
          ? sourceRepoFullName
          : normalizePrReviewRepoFullName(sourceRepoFullName),
        prNumber,
      };
      const key = `${ref.repoFullName}:${ref.prNumber}`;
      if (!seen.has(key)) seen.set(key, ref);
      if (seen.size >= MAX_SCANNED_PULL_REQUEST_REFS) {
        warnScanCapReached();
        return [...seen.values()];
      }
    }
  }
  return [...seen.values()];
}

export function parsePullRequestRefs(...texts: Array<string | null | undefined>): PullRequestRef[] {
  return parsePullRequestRefsWithCasing(false, ...texts);
}

function configuredPrReviewerAgentIds(override?: readonly string[]): string[] {
  const raw = override ?? readGithubPrReviewerAgentIds();
  return [...new Set(raw.map((agentId) => agentId.trim()).filter(Boolean))];
}

export type DuplicatePrReviewIssueCandidate = {
  companyId: string;
  assigneeAgentId?: string | null;
  title?: string | null;
  description?: string | null;
  /**
   * The structured request target, when the caller supplied one. Authoritative,
   * and deliberately independent of the text: it is what stamps
   * `origin_fingerprint`, so a create carrying a valid target whose title and
   * description never spell a GitHub PR URL would otherwise take no PR-scope
   * lock and skip the live-review lookup entirely — reaching the exact fan-out
   * this module exists to stop, through the newer of the two request paths.
   */
  prReviewTarget?: PullRequestRef | null;
};

export type DuplicatePrReviewIssueOptions = {
  /** Test seam; production reads PAPERCLIP_PR_REVIEWER_AGENT_IDS from the env. */
  reviewerAgentIds?: readonly string[];
};

/**
 * Every PR this candidate refers to, from the structured target and the free
 * text together.
 *
 * The target is listed first so it survives the scan cap: it is the caller's
 * explicit statement of which PR this is, whereas the text refs are inferred.
 */
function candidatePullRequestRefs(
  candidate: DuplicatePrReviewIssueCandidate,
  preserveRepoCasing: boolean,
): PullRequestRef[] {
  const target = candidate.prReviewTarget;
  const seen = new Map<string, PullRequestRef>();
  // Mirrors the validation the text parser applies, so an internal caller that
  // bypasses the create schema cannot key a lock on a non-PR number.
  if (target && Number.isSafeInteger(target.prNumber) && target.prNumber > 0) {
    const repoFullName = preserveRepoCasing
      ? target.repoFullName.trim()
      : normalizePrReviewRepoFullName(target.repoFullName);
    if (repoFullName) seen.set(`${repoFullName}:${target.prNumber}`, { repoFullName, prNumber: target.prNumber });
  }
  for (const ref of parsePullRequestRefsWithCasing(preserveRepoCasing, candidate.title, candidate.description)) {
    const key = `${ref.repoFullName}:${ref.prNumber}`;
    if (!seen.has(key)) seen.set(key, ref);
    if (seen.size >= MAX_SCANNED_PULL_REQUEST_REFS) {
      warnScanCapReached();
      break;
    }
  }
  return [...seen.values()];
}

function guardTaskKeys(
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions,
): string[] {
  const assigneeAgentId = candidate.assigneeAgentId?.trim();
  if (!assigneeAgentId || guardDisabled()) return [];

  const reviewerAgentIds = configuredPrReviewerAgentIds(options.reviewerAgentIds);
  if (!reviewerAgentIds.includes(assigneeAgentId)) return [];

  return candidatePullRequestRefs(candidate, false).map(buildPrReviewTaskKey);
}

/**
 * Upper bound on how long an issue create will wait for the PR-scope locks.
 *
 * The webhook holds these for one wake dispatch — two indexed selects plus
 * heartbeat's enqueue transaction — so single-digit-millisecond holds are the
 * steady state and this is ~1000x headroom. It exists only so a pathological
 * holder cannot wedge issue creation, which is the product's hottest write
 * path; see the fail-open note on lockPrReviewIssueScopes.
 */
const PR_REVIEW_ISSUE_LOCK_TIMEOUT_MS = 1_000;
const PR_REVIEW_ISSUE_LOCK_RETRY_MS = 10;

/**
 * Serializes an eligible issue create with webhook dispatch for every PR it
 * references. Call this before taking any other issue-create advisory lock;
 * PostgreSQL holds these transaction-scoped locks through the later guard read
 * and issue insert.
 *
 * Acquisition is bounded and fails open, in the same direction as the rest of
 * this module. Waiting unboundedly here would put an *unbounded* blocking wait
 * on every agent-assigned issue create, behind a lock whose other holder is the
 * GitHub webhook — coupling the hottest write path to webhook dispatch latency,
 * and with enough concurrent holders exhausting the connection pool. Giving up
 * costs at most one duplicate issue (a cost problem, and exactly the residual
 * tracked as BLO-21790); waiting forever costs issue creation itself (a
 * correctness problem). `pg_try_advisory_xact_lock` never blocks and never
 * errors, so this cannot poison the caller's transaction the way a
 * `lock_timeout` on the blocking variant would.
 *
 * Acquisition is ALL-OR-NOTHING, scoped to a SAVEPOINT. On give-up the
 * savepoint is rolled back, which releases every key acquired inside it —
 * verified behaviour, see packages/db/src/advisory-xact-lock-savepoint.test.ts.
 *
 * That matters because the webhook's dispatch path acquires the same
 * `prReviewTaskLockSpellings` PAIR all-or-nothing. An earlier revision returned
 * from here still holding whichever prefix it had taken, and since a create
 * cannot reconstruct GitHub's canonical casing from user-authored URL text it
 * routinely parked exactly one half of that pair. The webhook could then never
 * complete its set for the rest of the create transaction — starving every
 * reviewer wake for that PR while this side had already abandoned
 * serialization itself. A create that stops trying now stops blocking.
 */
export async function lockPrReviewIssueScopes(
  db: Pick<DbTransaction, "execute">,
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions = {},
): Promise<void> {
  const normalizedTaskKeys = guardTaskKeys(candidate, options);
  if (normalizedTaskKeys.length === 0) return;

  // Preserve source spelling as an additional compatibility lock for callers
  // that copied GitHub's canonical URL, or that named the repo in canonical
  // casing on the structured target. Production rollout still gates this guard
  // until every webhook pod locks the normalized namespace because arbitrary
  // canonical casing cannot be inferred from user-authored text.
  const sourceTaskKeys = candidatePullRequestRefs(candidate, true).map(
    (ref) => `pr_review:${ref.repoFullName}:${ref.prNumber}`,
  );
  const taskKeys = [...new Set([...normalizedTaskKeys, ...sourceTaskKeys])].sort();

  // Fixed identifier, never interpolated from input.
  const SAVEPOINT = sql.raw("pr_review_scope_locks");
  try {
    await db.execute(sql`savepoint ${SAVEPOINT}`);
  } catch (error) {
    // Realistically this only fails when the caller's transaction was ALREADY
    // aborted before the guard ran (measured: `savepoint` raises 25P02 on an
    // aborted transaction). We did not cause that and cannot clear it from in
    // here — there is no savepoint to roll back to. So do NOT claim the create
    // will proceed: it will fail on its next statement either way.
    logger.warn(
      { err: error },
      "pr review duplicate guard could not open its lock savepoint; skipping "
        + "serialization. If this is 25P02 the caller's transaction was already "
        + "aborted upstream and the create will fail regardless",
    );
    return;
  }

  const rollback = async () => {
    try {
      await db.execute(sql`rollback to savepoint ${SAVEPOINT}`);
      return true;
    } catch (error) {
      // This is the ONE statement that can restore a transaction aborted
      // inside the savepoint, so if it fails there is nothing left to try; it
      // will surface on the caller's next statement.
      logger.warn({ err: error }, "pr review duplicate guard could not roll back its lock savepoint");
      return false;
    }
  };

  const deadline = Date.now() + PR_REVIEW_ISSUE_LOCK_TIMEOUT_MS;
  for (const taskKey of taskKeys) {
    for (;;) {
      const outcome = await tryLockPrReviewScope(db, taskKey);
      if (outcome === "acquired") break;
      if (outcome === "unusable" || outcome === "indeterminate") {
        // Neither is retryable. "unusable" means the statement failed, so the
        // transaction is aborted and every further statement raises 25P02
        // until we roll back (measured) — retrying would issue ~100
        // guaranteed-to-fail statements across the budget, logging a warning
        // for each, and reach fail-open only incidentally via the give-up
        // rollback. "indeterminate" means the result shape is unreadable, so
        // the next call returns the same unreadable shape.
        //
        // Roll back either way: for "unusable" it is what restores the
        // caller's transaction, and for "indeterminate" it releases whatever
        // keys we already hold instead of stranding them.
        await rollback();
        logger.warn(
          { taskKey, outcome, keysAttempted: taskKeys.length },
          "pr review duplicate guard cannot evaluate a PR scope lock; rolled back "
            + "to release what it held and restore the caller's transaction, and is "
            + "proceeding unserialized",
        );
        return;
      }
      if (Date.now() >= deadline) {
        await rollback();
        logger.warn(
          { taskKey, keysAttempted: taskKeys.length, timeoutMs: PR_REVIEW_ISSUE_LOCK_TIMEOUT_MS },
          "pr review duplicate guard gave up acquiring the PR scope locks; released "
            + "every key it held and is proceeding unserialized (BLO-21790)",
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PR_REVIEW_ISSUE_LOCK_RETRY_MS));
    }
  }

  // Releasing the savepoint hands the locks to the parent transaction, which
  // holds them until the issue row is durable — the serialization we wanted.
  try {
    await db.execute(sql`release savepoint ${SAVEPOINT}`);
  } catch (error) {
    // A failed RELEASE aborts the parent transaction (measured), so the locks
    // do NOT "remain held" — the create is about to fail. The savepoint is
    // still there, because the release that would have removed it is what
    // failed, so rolling back to it restores a usable transaction. That
    // abandons serialization, which is the correct direction here.
    const restored = await rollback();
    logger.warn(
      { err: error, restored },
      "pr review duplicate guard could not release its lock savepoint; rolled back "
        + "to restore the caller's transaction and is proceeding unserialized",
    );
  }
}

/**
 * Three outcomes, not two.
 *
 * "contended" means someone else holds the key and retrying is meaningful.
 *
 * "unusable" means the STATEMENT failed, so the transaction is aborted and
 * retrying is not just useless but actively harmful — every further statement
 * raises 25P02 until the caller rolls back to its savepoint.
 *
 * "indeterminate" means the statement SUCCEEDED but its result shape is
 * unreadable, so the transaction is fine and retrying is merely pointless: the
 * next call returns the same unreadable shape.
 *
 * Collapsing all three into `false` is what made the retry loop spin ~100
 * doomed statements before reaching fail-open by accident.
 */
type PrReviewScopeLockOutcome = "acquired" | "contended" | "unusable" | "indeterminate";

async function tryLockPrReviewScope(
  db: Pick<DbTransaction, "execute">,
  taskKey: string,
): Promise<PrReviewScopeLockOutcome> {
  let rows: unknown;
  try {
    rows = await db.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${taskKey}, 0)) as acquired`,
    );
  } catch (error) {
    // Fail OPEN, matching this module's stated posture. The docstring above
    // claims pg_try_advisory_xact_lock "never errors", which is true of the
    // function but not of the statement: a reset connection, a
    // statement_timeout, or the role losing EXECUTE on hashtextextended all
    // throw here, and an uncaught throw aborts the caller's issue-create
    // transaction and 500s the create.
    //
    // Report "unusable" rather than "contended": the transaction is now
    // aborted, so the caller must roll back to its savepoint before issuing
    // anything else. Only the caller knows the savepoint, so this is reported
    // up rather than handled here.
    logger.warn(
      { err: error, taskKey },
      "pr review duplicate guard could not evaluate the PR scope lock statement",
    );
    return "unusable";
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && typeof row === "object" && "acquired" in row) {
    return (row as Record<string, unknown>).acquired === true ? "acquired" : "contended";
  }
  // Not "someone else holds it" — the driver's result shape is unrecognized
  // (drizzle's postgres-js execute returns an array; node-postgres returns a
  // QueryResult). Silently reporting contention would spin the entire retry
  // budget on every create and look identical to real contention, so say it
  // once and let the caller give up.
  logger.warn(
    { taskKey, rowType: Array.isArray(rows) ? "array" : typeof rows },
    "pr review duplicate guard got an unrecognized advisory-lock result shape; "
      + "treating the PR scope as unserializable",
  );
  return "indeterminate";
}

/**
 * Throws 409 when `candidate` duplicates a live PR review in the configured
 * reviewer pool. Returns silently in every other case, including on lookup
 * failure — see the fail-open note in the module header.
 */
export async function assertNotDuplicatePrReviewIssue(
  db: DuplicatePrReviewIssueGuardDb,
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions = {},
): Promise<void> {
  const assigneeAgentId = candidate.assigneeAgentId?.trim();
  const taskKeys = guardTaskKeys(candidate, options);
  if (!assigneeAgentId || taskKeys.length === 0) return;

  if (declaresNotAReviewRequest(candidate)) {
    logger.info(
      { companyId: candidate.companyId, assigneeAgentId, taskKeys },
      "duplicate PR review issue guard bypassed by an explicit "
        + "paperclip:not-a-review-request marker",
    );
    return;
  }

  const refs = candidatePullRequestRefs(candidate, false);
  const reviewerAgentIds = configuredPrReviewerAgentIds(options.reviewerAgentIds);
  let liveRun: { id: string; status: string; contextTaskKey: string | null; createdAt: Date } | undefined;
  try {
    // The caller hands us the in-flight issue-creation transaction, so a failed
    // statement here would abort *that* transaction: catching the error would
    // only make every later statement fail with 25P02 and the create would 500
    // anyway. Running the lookup in a nested transaction scopes the damage to a
    // SAVEPOINT that rolls back cleanly, which is what makes the documented
    // fail-open behaviour real rather than nominal.
    liveRun = await db.transaction(async (scoped) => {
      const [row] = await scoped
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextTaskKey: heartbeatRuns.contextTaskKey,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            // The exact leg matches
            // idx_heartbeat_runs_company_agent_context_task_key_created
            // (migration 0104); matchesAnyTaskKey adds the shared lower() leg
            // that bridges already-live mixed-case keys.
            eq(heartbeatRuns.companyId, candidate.companyId),
            inArray(heartbeatRuns.agentId, reviewerAgentIds),
            matchesAnyTaskKey(heartbeatRuns.contextTaskKey, taskKeys),
            inArray(heartbeatRuns.status, [...LIVE_PR_REVIEW_RUN_STATUSES]),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      return row;
    });
  } catch (error) {
    logger.warn(
      { err: error, companyId: candidate.companyId, assigneeAgentId, taskKeys },
      "duplicate PR review issue guard lookup failed; allowing issue creation",
    );
    return;
  }

  if (!liveRun) return;

  const matchedRunTaskKey = liveRun.contextTaskKey?.toLowerCase() ?? null;
  const matchedRef = refs.find((ref) => buildPrReviewTaskKey(ref) === matchedRunTaskKey) ?? refs[0];
  const prUrl = `https://github.com/${matchedRef.repoFullName}/pull/${matchedRef.prNumber}`;
  const waitingMinutes = Math.max(0, Math.round((Date.now() - liveRun.createdAt.getTime()) / 60_000));

  throw conflict(
    `A review of ${matchedRef.repoFullName}#${matchedRef.prNumber} is already ${liveRun.status} on this reviewer ` +
      `(run ${liveRun.id}, ${waitingMinutes}m old). Filing a Paperclip issue does not add a review — it adds ` +
      `4-11 extra reviewer runs that compete with the queued review itself.`,
    {
      code: DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE,
      remediation:
        `Do not file an issue to wake the reviewer. To request or re-request a review, post a comment on ${prUrl} ` +
        `whose literal first byte is the marker \`<!-- paperclip:review-request -->\`, followed by \`@ally\` and ` +
        `the specific review focus. A markerless \`@ally\` from an agent is dropped. If the existing run is ` +
        `starved rather than missing, escalate the queue wait — do not re-file. ` +
        `If this issue is ABOUT the review rather than a request for one (a bug in the reviewer, ` +
        `a postmortem, a tracking issue that merely cites the PR), add ` +
        `\`${NOT_A_REVIEW_REQUEST_MARKER}\` to the description and re-submit.`,
      taskKey: liveRun.contextTaskKey,
      repoFullName: matchedRef.repoFullName,
      prNumber: matchedRef.prNumber,
      existingRunId: liveRun.id,
      existingRunStatus: liveRun.status,
      existingRunAgeMinutes: waitingMinutes,
    },
  );
}

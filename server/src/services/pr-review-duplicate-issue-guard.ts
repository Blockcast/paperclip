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
 *   2. the issue text resolves to a canonical GitHub PR URL,
 *   3. that exact PR already has a queued/running review run in the configured
 *      reviewer pool, and
 *   4. the issue does not carry the `paperclip:not-a-review-request` marker.
 *
 * Condition 4 is the escape hatch for the one false-positive class this guard
 * cannot detect: an issue that is ABOUT the review rather than a request for one
 * ("Ally's review of <PR> exited with pr_review_output_missing"). Those cite the
 * permalink exactly like a duplicate request does, and every intent heuristic
 * tried also matched legitimate meta-issues — so the filer declares intent
 * explicitly instead. The 409's remediation names the marker, so a blocked
 * filer can discover it without reading this file.
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
 * Eligible creates take the normalized PR-scope advisory locks before the
 * issue-create title and idempotency locks. The webhook takes the same
 * normalized namespace as part of its compatibility lock set, so its wake
 * commit is visible before this guard reads. During the compatibility rollout,
 * production keeps this guard disabled until every webhook pod takes that
 * normalized lock: arbitrary canonical GitHub casing cannot be reconstructed
 * from a user-authored URL. Acquiring these locks first keeps the lock order
 * consistent and avoids coupling unrelated issue creates to the webhook path.
 *
 * That acquisition is *bounded*, ALL-OR-NOTHING, and gives up rather than
 * waiting (see lockPrReviewIssueScopes). Serialization is an optimization on a
 * fail-open cost guard, so it never gets to outrank issue creation itself. The
 * residual — one duplicate that slips through while the webhook's wake is still
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

export const DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE = "duplicate_pr_review_issue";

/**
 * Kill switch. This guard rejects writes on the issue-creation path for every
 * company, so it needs an off switch that does NOT also disable webhook
 * reviewer routing (clearing PAPERCLIP_PR_REVIEWER_AGENT_IDS would).
 *
 * Accepts the usual truthy spellings, not just "1"/"true". This is the one
 * place in the module that fails toward BLOCKING writes, so an operator who
 * sets the variable to "yes" during an incident and gets a still-enforcing
 * guard has been handed the worst possible outcome silently. Anything set but
 * unrecognized is logged loudly rather than quietly ignored.
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
      "PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD is set to an unrecognized value; "
        + "the duplicate-review guard remains ENABLED and will reject issue creates. "
        + `Use one of: ${[...TRUTHY_KILL_SWITCH_VALUES].join(", ")}`,
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
 * transition is uniform: affinity lookup, coalescing, cancellation, and this
 * module's own duplicate lookup. Non-PR keys keep plain `IN (…)` equality, so
 * unrelated task scopes see no behavioural or planner change. Once no
 * old readers remain, producers can switch to normalized keys in a later
 * release; after mixed-case rows drain, the `lower()` leg can be dropped.
 */
/**
 * Matches a task-key column against `taskKeys`, bridging the casing rollout.
 *
 * UNINDEXED SECOND LEG — known, deliberate, and bounded. The emitted shape is
 * `col IN (...) OR lower(col) IN (...)`. Only the exact leg can use an index:
 * `heartbeat_runs.context_task_key` has
 * `idx_heartbeat_runs_company_agent_context_task_key_created` (migration 0104)
 * and `agent_wakeup_requests.idempotency_key` has none at all. There is no
 * functional index on `lower(...)` for either column, so that leg is always a
 * recheck filter.
 *
 * Not fixed here on purpose. This module's callers all pin `company_id` and/or
 * `agent_id` first, so the recheck runs over a small per-agent row set rather
 * than the table. A functional index on these two hot tables needs the
 * online-precreation guard apparatus of migrations 0208/0209 plus a manual
 * `CREATE INDEX CONCURRENTLY` on production — an operationally coupled change
 * that does not belong in the same PR as a shell-polling fix. It becomes worth
 * doing if the compatibility rollout stops being temporary; the leg is designed
 * to be deleted once mixed-case rows drain, which is the real fix.
 */
export function matchesAnyTaskKey(column: Column, taskKeys: readonly string[]): SQL {
  const exact = [...new Set(taskKeys)];
  // Named for what they ARE — the normalized (lowercased) probe values — not
  // for the rows they are meant to reach. They are compared against
  // `lower(column)`, so a legacy mixed-case row matches via this leg; calling
  // the values themselves "legacyCasing" says the opposite of their contents.
  const normalizedProbes = [
    ...new Set(exact.filter(isPrReviewTaskKey).map((taskKey) => taskKey.toLowerCase())),
  ];
  const exactLeg = inArray(column, exact);
  if (normalizedProbes.length === 0) return exactLeg;
  const legacyCasingLeg = inArray(sql`lower(${column})`, normalizedProbes);
  return or(exactLeg, legacyCasingLeg) ?? exactLeg;
}

/** Single-key form of {@link matchesAnyTaskKey}. */
export function matchesTaskKey(column: Column, taskKey: string): SQL {
  return matchesAnyTaskKey(column, [taskKey]);
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
        // Truncation is fail-open (the unscanned tail is simply unguarded),
        // which is the right direction — but say so. Silently returning 20 of
        // 40 refs makes "the guard did not fire" indistinguishable from "the
        // guard decided not to fire".
        logger.warn(
          { cap: MAX_SCANNED_PULL_REQUEST_REFS },
          "pr review duplicate guard hit its PR-reference scan cap; references "
            + "beyond the cap are not guarded",
        );
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
};

export type DuplicatePrReviewIssueOptions = {
  /** Test seam; production reads PAPERCLIP_PR_REVIEWER_AGENT_IDS from the env. */
  reviewerAgentIds?: readonly string[];
};

function guardTaskKeys(
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions,
): string[] {
  const assigneeAgentId = candidate.assigneeAgentId?.trim();
  if (!assigneeAgentId || guardDisabled()) return [];

  const reviewerAgentIds = configuredPrReviewerAgentIds(options.reviewerAgentIds);
  if (!reviewerAgentIds.includes(assigneeAgentId)) return [];

  return parsePullRequestRefs(candidate.title, candidate.description).map(buildPrReviewTaskKey);
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
 * This matters because the webhook's dispatch path locks a PAIR of spellings
 * (normalized + GitHub's canonical casing) and acquires them all-or-nothing.
 * An earlier revision returned from here still holding whichever prefix it had
 * managed to take; because the create cannot reconstruct GitHub's canonical
 * casing from user-authored URL text, it would routinely park exactly one half
 * of that pair and make the webhook's acquisition unsatisfiable for the rest of
 * the create transaction — starving every reviewer wake for that PR while
 * having abandoned serialization itself. Releasing on give-up means a create
 * that stops trying stops blocking.
 *
 * Failure direction is OPEN, matching the rest of this module: if the advisory
 * lock statement itself errors, issue creation proceeds unserialized rather
 * than 500ing. Losing serialization costs at most a duplicate issue; failing
 * the create is a correctness problem on the product's hottest write path.
 */
export async function lockPrReviewIssueScopes(
  db: Pick<DbTransaction, "execute">,
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions = {},
): Promise<void> {
  const normalizedTaskKeys = guardTaskKeys(candidate, options);
  if (normalizedTaskKeys.length === 0) return;

  // Preserve source spelling as an additional compatibility lock for callers
  // that copied GitHub's canonical URL. Production rollout still gates this
  // guard until every webhook pod locks the normalized namespace because
  // arbitrary canonical casing cannot be inferred from user-authored text.
  const sourceTaskKeys = parsePullRequestRefsWithCasing(
    true,
    candidate.title,
    candidate.description,
  ).map((ref) => `pr_review:${ref.repoFullName}:${ref.prNumber}`);
  const taskKeys = [...new Set([...normalizedTaskKeys, ...sourceTaskKeys])].sort();

  // Fixed identifier, never interpolated from input.
  const SAVEPOINT = sql.raw("pr_review_scope_locks");
  try {
    await db.execute(sql`savepoint ${SAVEPOINT}`);
  } catch (error) {
    logger.warn(
      { err: error },
      "pr review duplicate guard could not open its lock savepoint; "
        + "proceeding unserialized",
    );
    return;
  }

  const releaseAll = async (why: string, extra: Record<string, unknown> = {}) => {
    try {
      await db.execute(sql`rollback to savepoint ${SAVEPOINT}`);
    } catch (error) {
      // The caller's transaction is already unusable if this fails; it will
      // surface on their next statement. Nothing useful to do here but say so.
      logger.warn({ err: error }, "pr review duplicate guard could not roll back its lock savepoint");
    }
    logger.warn({ ...extra, timeoutMs: PR_REVIEW_ISSUE_LOCK_TIMEOUT_MS }, why);
  };

  const deadline = Date.now() + PR_REVIEW_ISSUE_LOCK_TIMEOUT_MS;
  for (const taskKey of taskKeys) {
    while (!(await tryLockPrReviewScope(db, taskKey))) {
      if (Date.now() >= deadline) {
        await releaseAll(
          "pr review duplicate guard gave up acquiring the PR scope locks; "
            + "released every key it held and is proceeding unserialized (BLO-21790)",
          { taskKey, keysAttempted: taskKeys.length },
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, PR_REVIEW_ISSUE_LOCK_RETRY_MS));
    }
  }

  // Committing the savepoint hands the locks to the parent transaction, which
  // holds them until the issue row is durable — the serialization we wanted.
  try {
    await db.execute(sql`release savepoint ${SAVEPOINT}`);
  } catch (error) {
    logger.warn(
      { err: error },
      "pr review duplicate guard could not release its lock savepoint; "
        + "locks remain held by the caller's transaction",
    );
  }
}

async function tryLockPrReviewScope(
  db: Pick<DbTransaction, "execute">,
  taskKey: string,
): Promise<boolean> {
  let rows: unknown;
  try {
    rows = await db.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${taskKey}, 0)) as acquired`,
    );
  } catch (error) {
    // Fail OPEN. Anything that can make this statement throw — a reset
    // connection, statement_timeout, hashtextextended not permitted for the
    // role — would otherwise abort the caller's issue-create transaction and
    // return 500, which is precisely the outcome this module's stated failure
    // posture rejects. Report "not acquired" so the caller's retry budget
    // expires and it proceeds unserialized.
    logger.warn(
      { err: error, taskKey },
      "pr review duplicate guard could not evaluate the PR scope lock; "
        + "proceeding unserialized",
    );
    return false;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && typeof row === "object" && "acquired" in row) {
    return (row as Record<string, unknown>).acquired === true;
  }
  // Not "someone else holds it" — we do not recognize the driver's result
  // shape at all (drizzle's postgres-js execute returns an array; node-postgres
  // returns a QueryResult). Silently reporting contention here would spin the
  // full retry budget on every create and look identical to real contention,
  // so say so once and let the caller give up.
  logger.warn(
    { taskKey, rowType: typeof rows },
    "pr review duplicate guard got an unrecognized advisory-lock result shape; "
      + "treating the PR scope as unserializable",
  );
  return false;
}

/**
 * Explicit opt-out marker for the false-positive class this guard cannot
 * distinguish on its own.
 *
 * The guard fires on any canonical PR permalink in the title or description and
 * does NOT check that the issue is a review *request*. That is deliberate — the
 * measured duplicates put the reference in the title 91.8% of the time, and
 * every intent heuristic tried (title prefix, position, keyword) also matched
 * legitimate meta-issues. So instead of guessing, give the filer a documented
 * way to say "this is about the review, not a request for one":
 *
 *   "Ally's review of <PR URL> exited with pr_review_output_missing"
 *
 * is a real issue that must stay creatable, and before this marker existed the
 * only way past the 409 was the global kill switch.
 */
const NOT_A_REVIEW_REQUEST_MARKER = "<!-- paperclip:not-a-review-request -->";
export { NOT_A_REVIEW_REQUEST_MARKER };

function declaresNotAReviewRequest(candidate: DuplicatePrReviewIssueCandidate): boolean {
  const haystack = `${candidate.title ?? ""}\n${candidate.description ?? ""}`.toLowerCase();
  return haystack.includes(NOT_A_REVIEW_REQUEST_MARKER);
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

  const refs = parsePullRequestRefs(candidate.title, candidate.description);
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
  // "is already scheduled_retry on this reviewer" reads as a typo. Describe the
  // state instead of interpolating the enum, and say what scheduled_retry
  // actually means for the filer — it is queued but deferred, so re-filing
  // still adds nothing.
  const statePhrase = liveRun.status === "scheduled_retry"
    ? "is already queued on this reviewer, deferred for a capacity retry"
    : `is already ${liveRun.status} on this reviewer`;

  throw conflict(
    `A review of ${matchedRef.repoFullName}#${matchedRef.prNumber} ${statePhrase} ` +
      `(run ${liveRun.id}, ${waitingMinutes}m old). Filing a Paperclip issue does not add a review — it adds ` +
      `4-11 extra reviewer runs that compete with the queued review itself.`,
    {
      code: DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE,
      remediation:
        `Do not file an issue to wake the reviewer. To request or re-request a review, post a comment on ${prUrl} ` +
        `whose literal first byte is the marker \`<!-- paperclip:review-request -->\`, followed by \`@ally\` and ` +
        `the specific review focus. A markerless \`@ally\` from an agent is dropped. If the existing run is ` +
        `starved rather than missing, escalate the queue wait — do not re-file. ` +
        `If this issue is ABOUT the review rather than a request for one (a bug in the reviewer, a postmortem, ` +
        `a tracking issue that merely cites the PR), add \`${NOT_A_REVIEW_REQUEST_MARKER}\` to the description ` +
        `and re-submit.`,
      taskKey: liveRun.contextTaskKey,
      repoFullName: matchedRef.repoFullName,
      prNumber: matchedRef.prNumber,
      existingRunId: liveRun.id,
      existingRunStatus: liveRun.status,
      existingRunAgeMinutes: waitingMinutes,
      bypassMarker: NOT_A_REVIEW_REQUEST_MARKER,
    },
  );
}

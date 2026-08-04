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
 * The guard fires only on a genuine collision — all three must hold:
 *   1. the assignee is a configured PR reviewer (PAPERCLIP_PR_REVIEWER_AGENT_IDS),
 *   2. the issue text resolves to a canonical GitHub PR URL, and
 *   3. that exact PR already has a queued/running review run in the configured
 *      reviewer pool.
 *
 * Keying on the collision rather than on the assignee is deliberate: issues
 * about the reviewer's own tooling stay creatable, and creator identity is
 * useless as a signal here (68% of the measured duplicates were attributed to
 * a user rather than to the filing agent).
 *
 * Failure direction is open. An unparseable reference or lookup error lets the
 * issue through — a duplicate review issue is a cost problem, whereas wrongly
 * blocking issue creation is a correctness problem.
 *
 * Eligible creates take the normalized PR-scope advisory locks before the
 * issue-create title and idempotency locks. The webhook takes the same
 * normalized namespace as part of its compatibility lock set, so its wake
 * commit is visible before this guard reads. During the compatibility rollout,
 * production keeps this guard disabled until every webhook pod takes that
 * normalized lock: arbitrary canonical GitHub casing cannot be reconstructed
 * from a user-authored URL. Acquiring these locks first keeps the lock order
 * consistent and avoids coupling unrelated issue creates to the webhook path.
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
 * reviewer routing (clearing PAPERCLIP_PR_REVIEWER_AGENT_IDS would). Set to
 * "1"/"true" to disable the guard while leaving review dispatch intact.
 */
function guardDisabled(): boolean {
  const raw = process.env.PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD?.trim().toLowerCase();
  return raw === "1" || raw === "true";
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
export function matchesAnyTaskKey(column: Column, taskKeys: readonly string[]): SQL {
  const exact = [...new Set(taskKeys)];
  const legacyCasingCandidates = [
    ...new Set(exact.filter(isPrReviewTaskKey).map((taskKey) => taskKey.toLowerCase())),
  ];
  const exactLeg = inArray(column, exact);
  if (legacyCasingCandidates.length === 0) return exactLeg;
  const legacyCasingLeg = inArray(sql`lower(${column})`, legacyCasingCandidates);
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
      if (seen.size >= MAX_SCANNED_PULL_REQUEST_REFS) return [...seen.values()];
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
 * Serializes an eligible issue create with webhook dispatch for every PR it
 * references. Call this before taking any other issue-create advisory lock;
 * PostgreSQL holds these transaction-scoped locks through the later guard read
 * and issue insert.
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
  for (const taskKey of taskKeys) {
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
  }
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
        `starved rather than missing, escalate the queue wait — do not re-file.`,
      taskKey: liveRun.contextTaskKey,
      repoFullName: matchedRef.repoFullName,
      prNumber: matchedRef.prNumber,
      existingRunId: liveRun.id,
      existingRunStatus: liveRun.status,
      existingRunAgeMinutes: waitingMinutes,
    },
  );
}

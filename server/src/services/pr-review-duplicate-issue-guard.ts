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
 *   3. that exact PR already has a queued/running review run on that reviewer.
 *
 * Keying on the collision rather than on the assignee is deliberate: issues
 * about the reviewer's own tooling stay creatable, and creator identity is
 * useless as a signal here (68% of the measured duplicates were attributed to
 * a user rather than to the filing agent).
 *
 * Failure direction is open. An unparseable reference, a casing mismatch, or a
 * lookup error lets the issue through — a duplicate review issue is a cost
 * problem, whereas wrongly blocking issue creation is a correctness problem.
 */
import { type Db, heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { readGithubPrReviewerAgentIds } from "../config.js";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";

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
 */
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/gi;

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

/**
 * Mirror of `buildPrReviewerTaskKey` (server/src/routes/github-webhook.ts).
 * The two MUST produce byte-identical keys or this guard silently stops
 * matching live review scopes — it is covered by an equivalence test in
 * server/src/__tests__/issue-create-pr-review-duplicate-routes.test.ts.
 */
export function buildPrReviewTaskKey(ref: PullRequestRef): string {
  return `pr_review:${ref.repoFullName}:${ref.prNumber}`;
}

/** Extracts unique canonical GitHub PR references from free text. */
export function parsePullRequestRefs(...texts: Array<string | null | undefined>): PullRequestRef[] {
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
      const ref: PullRequestRef = { repoFullName: `${owner}/${repo}`, prNumber };
      const key = buildPrReviewTaskKey(ref);
      if (!seen.has(key)) seen.set(key, ref);
      if (seen.size >= MAX_SCANNED_PULL_REQUEST_REFS) return [...seen.values()];
    }
  }
  return [...seen.values()];
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

/**
 * Throws 409 when `candidate` duplicates a live PR review on the same
 * reviewer. Returns silently in every other case, including on lookup
 * failure — see the fail-open note in the module header.
 */
export async function assertNotDuplicatePrReviewIssue(
  db: Db,
  candidate: DuplicatePrReviewIssueCandidate,
  options: DuplicatePrReviewIssueOptions = {},
): Promise<void> {
  const assigneeAgentId = candidate.assigneeAgentId?.trim();
  if (!assigneeAgentId) return;
  if (guardDisabled()) return;

  const reviewerAgentIds = configuredPrReviewerAgentIds(options.reviewerAgentIds);
  if (!reviewerAgentIds.includes(assigneeAgentId)) return;

  const refs = parsePullRequestRefs(candidate.title, candidate.description);
  if (refs.length === 0) return;

  const taskKeys = refs.map(buildPrReviewTaskKey);
  let liveRun: { id: string; status: string; contextTaskKey: string | null; createdAt: Date } | undefined;
  try {
    [liveRun] = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextTaskKey: heartbeatRuns.contextTaskKey,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          // company_id + agent_id + context_task_key matches
          // idx_heartbeat_runs_company_agent_context_task_key_created
          // (migration 0104), so this stays a bounded index probe on the
          // issue-creation hot path.
          eq(heartbeatRuns.companyId, candidate.companyId),
          eq(heartbeatRuns.agentId, assigneeAgentId),
          inArray(heartbeatRuns.contextTaskKey, taskKeys),
          inArray(heartbeatRuns.status, [...LIVE_PR_REVIEW_RUN_STATUSES]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1);
  } catch (error) {
    logger.warn(
      { err: error, companyId: candidate.companyId, assigneeAgentId, taskKeys },
      "duplicate PR review issue guard lookup failed; allowing issue creation",
    );
    return;
  }

  if (!liveRun) return;

  const matchedRef =
    refs.find((ref) => buildPrReviewTaskKey(ref) === liveRun.contextTaskKey) ?? refs[0];
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

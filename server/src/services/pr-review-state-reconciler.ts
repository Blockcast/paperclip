/**
 * Open-PR review-state reconciler (BLO-30259).
 *
 * Fills `pull_request_review_state` so the review-request ageing digest producer
 * can be a pure DB read. All GitHub I/O happens here, on this module's own
 * interval — never inside the digest's per-company advisory lock.
 *
 * ## Why the dedicated requested-reviewers endpoint, and not the list payload
 *
 * `pr-review-request-ageing.ts` rules out "REST `requested_reviewers`" in its
 * docblock, on the evidence that 135 of 145 apparent-zeros were live-but-
 * unreadable team requests. That finding is real, but it is a property of the
 * **list** payload, not of REST and not of the token. Re-measured on
 * `Blockcast/onprem-k8s` 2026-08-29 across the full population of 114 App-authored
 * open PRs that the list payload calls zero-reviewer:
 *
 * | source | result |
 * |---|---|
 * | list payload `requested_reviewers + requested_teams` | 0 for all 114 |
 * | dedicated `GET /pulls/{n}/requested_reviewers` | **97 live team requests**, 17 genuinely unrouted, 0 errors |
 *
 * Same installation token. So presence is sourced from the dedicated endpoint,
 * and {@link listOpenPullRequests} deliberately does **not** read the pending
 * arrays off the list page even though they are sitting right there.
 *
 * The timeline is still consulted — but for the *clock*, not for presence. The
 * dedicated endpoint returns no timestamp, so without it every PR would age from
 * its creation date, over-stating any PR whose review was requested later than it
 * was opened. It is fetched only for PRs that already have a pending request, so
 * the common case costs two calls per PR rather than three.
 *
 * ## Readability is recorded, never defaulted
 *
 * Each probe stores whether it answered. A failed probe writes
 * `requestsReadable: false` and a reason — it must never fall back to `[]`,
 * because downstream that is indistinguishable from "nobody is requested" and
 * renders as a clean queue. The pruning pass has the same discipline: rows are
 * only deleted after an enumeration that completed, so a half-read repo cannot
 * delete live rows.
 */

import { and, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, pullRequestReviewState } from "@paperclipai/db";
import { getInstallationTokenResult } from "./github-app-auth.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { logger as defaultLogger } from "../middleware/logger.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_HEADERS = { accept: "application/vnd.github+json" } as const;

/** Pages of 100 open PRs per repo. 10 pages = 1000 PRs, well past any real repo. */
const MAX_OPEN_PR_PAGES = 10;
/** Timeline pages probed per PR when dating a pending request. */
const MAX_TIMELINE_PAGES = 10;

/**
 * PRs probed per repo per sweep.
 *
 * Each costs 2–3 API calls, so this is the rate-limit budget. Truncation is
 * always reported by {@link reconcileRepoReviewState} and always suppresses the
 * prune — a truncated enumeration is not evidence that the unseen PRs closed.
 */
export const DEFAULT_MAX_PULL_REQUESTS_PER_REPO = 400;

export type ReviewStateTarget = { companyId: string; repoFullName: string };

type OpenPullRequest = {
  number: number;
  title: string | null;
  url: string | null;
  authorLogin: string | null;
  createdAt: string;
  isDraft: boolean;
};

export type ReviewStateReconcileResult = {
  enumerated: number;
  written: number;
  pruned: number;
  unreadable: number;
  /** True when the open-PR enumeration hit a cap — prune suppressed. */
  truncated: boolean;
  /** Unparseable list entries. Non-zero also suppresses the prune. */
  malformed: number;
};

type Logger = { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };

function githubHeaders(token: string) {
  return { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
}

/**
 * Repos to poll, per company.
 *
 * **Not** `selectReconcilerTargets` from `pr-reconciler-sweep.ts`. That derives
 * targets from `issue_pull_requests`, which only ever holds **merged** PRs — so a
 * repo whose PRs are all still open is invisible to it, which is structurally
 * circular for an open-PR digest.
 *
 * `issue_work_products` is the right source instead: the GitHub webhook writes a
 * `pull_request` work product on `opened`, so an open PR appears there
 * immediately, and the row already carries `companyId`. That last part is why
 * this is preferred over the alternative `pr-reconciler-sweep.ts:57-58` names in
 * its own docblock — enumerating GitHub App installation repos returns repos with
 * no company attribution at all, and the digest is delivered per company.
 */
export async function selectReviewStateTargets(db: Db): Promise<ReviewStateTarget[]> {
  const rows = await db
    .selectDistinct({
      companyId: issueWorkProducts.companyId,
      repoFullName: sql<string>`${issueWorkProducts.metadata} ->> 'repoFullName'`,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.type, "pull_request"),
        sql`${issueWorkProducts.metadata} ->> 'repoFullName' IS NOT NULL`,
      ),
    );
  return rows
    .filter((row): row is ReviewStateTarget => typeof row.repoFullName === "string" && row.repoFullName.length > 0)
    .map((row) => ({ companyId: row.companyId, repoFullName: row.repoFullName }));
}

/**
 * Open PRs for a repo. Returns `null` on any unreadable page rather than a short
 * list — a partial enumeration that looked complete would prune live rows.
 */
export async function listOpenPullRequests(input: {
  repoFullName: string;
  token: string;
  maxPullRequests: number;
}): Promise<{ pullRequests: OpenPullRequest[]; truncated: boolean; malformed: number } | null> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headers = githubHeaders(input.token);
  const pullRequests: OpenPullRequest[] = [];
  // A skipped entry makes the enumeration INCOMPLETE, not merely lossy. Counted
  // rather than ignored because the prune treats "absent from the open set" as
  // "closed" — silently dropping an unparseable entry would delete a live row.
  let malformed = 0;

  try {
    for (let page = 1; page <= MAX_OPEN_PR_PAGES; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/pulls?state=open&per_page=100&page=${page}`;
      const response = await ghFetch(url, { headers });
      if (!response.ok) return null;
      const payload = await response.json();
      // A non-array body is not an empty page. Treating it as one would report a
      // complete enumeration of zero open PRs and prune the entire repo.
      if (!Array.isArray(payload)) return null;
      const batch = payload as Array<{
        number?: number;
        title?: string | null;
        html_url?: string | null;
        draft?: boolean | null;
        created_at?: string | null;
        user?: { login?: string | null } | null;
      }>;

      for (const pr of batch) {
        if (!Number.isInteger(pr.number) || typeof pr.created_at !== "string") {
          malformed += 1;
          continue;
        }
        pullRequests.push({
          number: pr.number as number,
          title: pr.title ?? null,
          url: pr.html_url ?? null,
          authorLogin: pr.user?.login ?? null,
          createdAt: pr.created_at,
          isDraft: pr.draft === true,
        });
        if (pullRequests.length >= input.maxPullRequests) {
          return { pullRequests, truncated: true, malformed };
        }
      }

      if (batch.length < 100) return { pullRequests, truncated: false, malformed };
      if (page === MAX_OPEN_PR_PAGES) return { pullRequests, truncated: true, malformed };
    }
    return { pullRequests, truncated: false, malformed };
  } catch {
    return null;
  }
}

/**
 * Pending review requests from the dedicated endpoint — the one surface that
 * resolves team requests under an App token. `null` means unreadable.
 *
 * A 200 is not by itself a readable answer. If either `users` or `teams` is
 * absent or not an array, the payload is not the documented shape and we do not
 * know what is pending — so it returns `null` (unreadable) rather than coercing
 * the missing field to `[]`. Coercing would turn a malformed response into a
 * confident "nobody is requested", which is the same false all-clear the list
 * payload produces and the exact thing this module exists to refuse.
 */
export async function fetchPendingReviewRequests(input: {
  repoFullName: string;
  prNumber: number;
  token: string;
}): Promise<Array<{ reviewerLogin?: string | null; reviewerSlug?: string | null }> | null> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  try {
    const response = await ghFetch(
      `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/requested_reviewers`,
      { headers: githubHeaders(input.token) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      users?: Array<{ login?: string | null }> | null;
      teams?: Array<{ slug?: string | null }> | null;
    } | null;
    if (body === null || typeof body !== "object") return null;
    if (!Array.isArray(body.users) || !Array.isArray(body.teams)) return null;
    return [
      ...body.users.map((user) => ({ reviewerLogin: user?.login ?? null })),
      ...body.teams.map((team) => ({ reviewerSlug: team?.slug ?? null })),
    ];
  } catch {
    return null;
  }
}

/**
 * Submitted reviews, with `state` preserved.
 *
 * Deliberately not `githubListPrReviewsWithTimestamps` from `github-app-auth.ts`:
 * that helper drops `state`, and the ageing module needs it to tell an
 * `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED` review (a human engaged) from a
 * `PENDING` draft or a `DISMISSED` one (nobody did).
 */
export async function fetchPullRequestReviews(input: {
  repoFullName: string;
  prNumber: number;
  token: string;
}): Promise<Array<{ authorLogin: string | null; submittedAt: string; state: string }> | null> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headers = githubHeaders(input.token);
  const reviews: Array<{ authorLogin: string | null; submittedAt: string; state: string }> = [];
  try {
    for (let page = 1; page <= MAX_TIMELINE_PAGES; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`;
      const response = await ghFetch(url, { headers });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload)) return null;
      const batch = payload as Array<{
        user?: { login?: string | null } | null;
        state?: string | null;
        submitted_at?: string | null;
      }>;
      for (const review of batch) {
        // No `submitted_at` means an unsubmitted PENDING draft review. Skipping
        // it is correct rather than lossy — it is not a review anyone has given.
        if (typeof review.submitted_at !== "string") continue;
        reviews.push({
          authorLogin: review.user?.login ?? null,
          submittedAt: review.submitted_at,
          state: (review.state ?? "").toUpperCase(),
        });
      }
      if (batch.length < 100) return reviews;
      if (page === MAX_TIMELINE_PAGES) return null;
    }
    return reviews;
  } catch {
    return null;
  }
}

/**
 * Timestamp of the oldest still-standing `review_requested` event.
 *
 * Oldest, not newest, for the same reason `reviewRequestClockAt` prefers it:
 * stacking a second request onto a PR must not reset its age, or the
 * re-request reflex this escalation exists to discourage would double as a way
 * to silence it. `review_request_removed` events cancel a matching request.
 *
 * `null` means "no readable request timestamp" — the caller then falls back to
 * PR creation, which is a safe floor.
 */
export async function fetchOldestReviewRequestedAt(input: {
  repoFullName: string;
  prNumber: number;
  token: string;
}): Promise<string | null> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headers = githubHeaders(input.token);
  const requested: string[] = [];
  let removedCount = 0;
  try {
    for (let page = 1; page <= MAX_TIMELINE_PAGES; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/timeline?per_page=100&page=${page}`;
      const response = await ghFetch(url, {
        headers: { ...headers, accept: "application/vnd.github+json" },
      });
      if (!response.ok) return null;
      const payload = await response.json();
      if (!Array.isArray(payload)) return null;
      const batch = payload as Array<{ event?: string | null; created_at?: string | null }>;
      for (const entry of batch) {
        if (typeof entry.created_at !== "string") continue;
        if (entry.event === "review_requested") requested.push(entry.created_at);
        else if (entry.event === "review_request_removed") removedCount += 1;
      }
      if (batch.length < 100) break;
      if (page === MAX_TIMELINE_PAGES) return null;
    }
  } catch {
    return null;
  }
  requested.sort();
  // Each removal is paired against the oldest outstanding request. This is
  // positional, not identity-matched: the timeline's `requested_team` /
  // `requested_reviewer` fields are subject to the same App-token unreadability
  // as everything else here, so pairing on them would work only for the cases
  // that were never the problem.
  //
  // Failure direction, stated because it is not obvious: on a PR that had a
  // request removed, this can pair the wrong one and return a *newer* timestamp
  // than the truth, which **under-states** the age and delays the escalation. It
  // cannot invent a request that does not exist, and it cannot over-state age
  // past the PR's creation floor. Delay is the milder failure — but it is still
  // a failure, and if re-requests turn out to be common on aged PRs this should
  // become identity-matched with an unreadable-pair fallback to `null`.
  const standing = requested.slice(removedCount);
  return standing[0] ?? null;
}

/** Probe and persist one repo's open-PR review state. */
export async function reconcileRepoReviewState(
  db: Db,
  input: {
    companyId: string;
    repoFullName: string;
    token: string;
    now?: Date;
    maxPullRequests?: number;
    logger?: Logger;
  },
): Promise<ReviewStateReconcileResult> {
  const now = input.now ?? new Date();
  const log = input.logger ?? defaultLogger;
  const maxPullRequests = input.maxPullRequests ?? DEFAULT_MAX_PULL_REQUESTS_PER_REPO;

  const listed = await listOpenPullRequests({
    repoFullName: input.repoFullName,
    token: input.token,
    maxPullRequests,
  });
  if (!listed) {
    throw new Error(`open-PR enumeration failed for ${input.repoFullName}`);
  }

  let written = 0;
  let unreadable = 0;
  const observedNumbers: number[] = [];

  for (const pr of listed.pullRequests) {
    observedNumbers.push(pr.number);

    const pending = await fetchPendingReviewRequests({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      token: input.token,
    });
    const reviews = await fetchPullRequestReviews({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      token: input.token,
    });

    // Dating the request only matters when there is one. Skipping the timeline
    // otherwise is what keeps the common case at two calls per PR.
    let requestedAt: string | null = null;
    if (pending !== null && pending.length > 0) {
      requestedAt = await fetchOldestReviewRequestedAt({
        repoFullName: input.repoFullName,
        prNumber: pr.number,
        token: input.token,
      });
    }

    const reasons: string[] = [];
    if (pending === null) reasons.push("requested_reviewers probe failed");
    if (reviews === null) reasons.push("reviews probe failed");
    if (reasons.length > 0) unreadable += 1;

    const values = {
      companyId: input.companyId,
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      prCreatedAt: new Date(pr.createdAt),
      authorLogin: pr.authorLogin,
      title: pr.title,
      url: pr.url,
      isDraft: pr.isDraft,
      requestsReadable: pending !== null,
      pendingReviewRequests: (pending ?? []).map((request) => ({ ...request, requestedAt })),
      reviewsReadable: reviews !== null,
      reviews: (reviews ?? []).map((review) => ({
        authorLogin: review.authorLogin,
        submittedAt: review.submittedAt,
        state: review.state,
      })),
      unreadableReason: reasons.length > 0 ? reasons.join("; ") : null,
      observedAt: now,
      updatedAt: now,
    };

    await db
      .insert(pullRequestReviewState)
      .values(values)
      .onConflictDoUpdate({
        target: [
          pullRequestReviewState.companyId,
          pullRequestReviewState.repoFullName,
          pullRequestReviewState.prNumber,
        ],
        set: {
          prCreatedAt: values.prCreatedAt,
          authorLogin: values.authorLogin,
          title: values.title,
          url: values.url,
          isDraft: values.isDraft,
          requestsReadable: values.requestsReadable,
          pendingReviewRequests: values.pendingReviewRequests,
          reviewsReadable: values.reviewsReadable,
          reviews: values.reviews,
          unreadableReason: values.unreadableReason,
          observedAt: values.observedAt,
          updatedAt: values.updatedAt,
        },
      });
    written += 1;
  }

  // Prune only behind an enumeration known to be COMPLETE. Two things break
  // that, and both must suppress it:
  //
  //   - `truncated` — the budget or page cap stopped us early. The PRs we did
  //     not reach have not closed; we simply did not look.
  //   - `malformed` — an entry we could not parse. It is still an open PR, it
  //     just is not in `observedNumbers`, so pruning would read it as closed and
  //     delete a live row.
  //
  // Both are the same mistake in different clothing: treating "absent from what
  // I managed to read" as "absent from GitHub".
  let pruned = 0;
  const enumerationComplete = !listed.truncated && listed.malformed === 0;
  if (enumerationComplete) {
    const scope = and(
      eq(pullRequestReviewState.companyId, input.companyId),
      eq(pullRequestReviewState.repoFullName, input.repoFullName),
    );
    const deleted = await db
      .delete(pullRequestReviewState)
      .where(
        observedNumbers.length > 0
          ? and(scope, notInArray(pullRequestReviewState.prNumber, observedNumbers))
          : scope,
      )
      .returning({ id: pullRequestReviewState.id });
    pruned = deleted.length;
  } else {
    log.warn(
      {
        repoFullName: input.repoFullName,
        maxPullRequests,
        truncated: listed.truncated,
        malformedEntries: listed.malformed,
      },
      "pr-review-state: open-PR enumeration incomplete; prune skipped for this repo",
    );
  }

  return {
    enumerated: listed.pullRequests.length,
    written,
    pruned,
    unreadable,
    truncated: listed.truncated,
    malformed: listed.malformed,
  };
}

export type ReviewStateSweepResult = {
  targets: number;
  ok: number;
  failed: number;
  totals: ReviewStateReconcileResult;
};

/** One reconciler pass across every discovered (company, repo) pair. */
export async function prReviewStateReconcilerTick(
  db: Db,
  input: { now?: Date; maxPullRequests?: number; logger?: Logger } = {},
): Promise<ReviewStateSweepResult> {
  const log = input.logger ?? defaultLogger;
  const totals: ReviewStateReconcileResult = {
    enumerated: 0,
    written: 0,
    pruned: 0,
    unreadable: 0,
    truncated: false,
    malformed: 0,
  };

  const tokenResult = await getInstallationTokenResult();
  if (!tokenResult.ok) {
    log.warn(
      { reason: tokenResult.reason },
      "pr-review-state: no installation token; skipping sweep (review state will age, not silently empty)",
    );
    return { targets: 0, ok: 0, failed: 0, totals };
  }

  const targets = await selectReviewStateTargets(db);
  let ok = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      const result = await reconcileRepoReviewState(db, {
        companyId: target.companyId,
        repoFullName: target.repoFullName,
        token: tokenResult.token,
        now: input.now,
        maxPullRequests: input.maxPullRequests,
        logger: log,
      });
      totals.enumerated += result.enumerated;
      totals.written += result.written;
      totals.pruned += result.pruned;
      totals.unreadable += result.unreadable;
      totals.truncated = totals.truncated || result.truncated;
      totals.malformed += result.malformed;
      ok += 1;
    } catch (err) {
      failed += 1;
      log.warn({ err, ...target }, "pr-review-state: repo reconcile failed (isolated)");
    }
  }

  log.info({ targets: targets.length, ok, failed, ...totals }, "pr-review-state: sweep complete");
  return { targets: targets.length, ok, failed, totals };
}

export type ReviewStateScheduler = {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: ReviewStateScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/** Worker-tier singleton, same skeleton as `startHumanGatedDigestSweep`. */
export function startPrReviewStateReconciler(
  db: Db,
  intervalMs: number,
  options: { maxPullRequests?: number } = {},
  scheduler: ReviewStateScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = prReviewStateReconcilerTick(db, options)
      .then(() => undefined)
      .catch((err) => {
        defaultLogger.error({ err }, "pr-review-state reconciler sweep failed");
      })
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}

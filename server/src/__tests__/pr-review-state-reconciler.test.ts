/**
 * Reconciler tests for the open-PR review-state poller (BLO-30259).
 *
 * These cover the two behaviours where a bug is silent and destructive rather
 * than merely wrong:
 *
 *  1. **Readability is never defaulted.** A failed probe must persist
 *     `requestsReadable: false`, not an empty array. `[]` is indistinguishable
 *     downstream from "GitHub says nobody is requested", and the digest would
 *     then render a queue of unanswered requests as a clean section — the false
 *     all-clear this whole issue exists to refuse.
 *  2. **A truncated enumeration must not prune.** Rows are deleted for PRs no
 *     longer in the open set; if a partial read were allowed to drive that, the
 *     unseen PRs would be deleted as though they had closed, silently shrinking
 *     the digest population.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ghFetchMock = vi.fn();
vi.mock("../services/github-fetch.js", () => ({
  ghFetch: (...args: unknown[]) => ghFetchMock(...args),
  gitHubApiBase: () => "https://api.github.com",
}));

const { and, eq } = await import("drizzle-orm");
const { companies, createDb, pullRequestReviewState } = await import("@paperclipai/db");
const { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } = await import(
  "./helpers/embedded-postgres.js"
);
const { reconcileRepoReviewState, selectReviewStateTargets } = await import(
  "../services/pr-review-state-reconciler.js"
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR review-state reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REPO = "Blockcast/onprem-k8s";
const NOW = new Date("2026-08-25T12:00:00.000Z");

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 502, json: async () => body };
}

/** Route a mocked GitHub call by URL shape. */
function routeGithub(handlers: {
  openPrPages?: unknown[][];
  requestedReviewers?: (prNumber: number) => unknown;
  reviews?: (prNumber: number) => unknown;
  timeline?: (prNumber: number) => unknown;
}) {
  ghFetchMock.mockImplementation(async (url: string) => {
    const prMatch = /\/pulls\/(\d+)\//.exec(url) ?? /\/issues\/(\d+)\//.exec(url);
    const prNumber = prMatch ? Number(prMatch[1]) : 0;

    if (url.includes("/requested_reviewers")) {
      const result = handlers.requestedReviewers?.(prNumber);
      return result === null ? jsonResponse(null, false) : jsonResponse(result ?? { users: [], teams: [] });
    }
    if (url.includes("/reviews")) {
      const result = handlers.reviews?.(prNumber);
      return result === null ? jsonResponse(null, false) : jsonResponse(result ?? []);
    }
    if (url.includes("/timeline")) {
      const result = handlers.timeline?.(prNumber);
      return result === null ? jsonResponse(null, false) : jsonResponse(result ?? []);
    }
    // Open-PR list page.
    const pageMatch = /[?&]page=(\d+)/.exec(url);
    const page = pageMatch ? Number(pageMatch[1]) : 1;
    const pages = handlers.openPrPages ?? [[]];
    const body = pages[page - 1];
    if (body === undefined) return jsonResponse([]);
    if (body === null) return jsonResponse(null, false);
    return jsonResponse(body);
  });
}

function openPr(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    draft: false,
    created_at: "2026-08-05T00:00:00.000Z",
    user: { login: "allyblockcast[bot]" },
    ...overrides,
  };
}

describeEmbeddedPostgres("pr-review-state reconciler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-review-state-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reconciler company",
      issuePrefix: `R${Math.floor(Math.random() * 9000) + 1000}`,
      requireBoardApprovalForNewAgents: false,
    });
    ghFetchMock.mockReset();
  });

  afterEach(async () => {
    await db.delete(pullRequestReviewState);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function storedRows() {
    return db
      .select()
      .from(pullRequestReviewState)
      .where(eq(pullRequestReviewState.companyId, companyId));
  }

  it("persists a live team request from the dedicated endpoint", async () => {
    routeGithub({
      openPrPages: [[openPr(2478)]],
      requestedReviewers: () => ({ users: [], teams: [{ slug: "onprem-k8s-ally-reviewer" }] }),
      reviews: () => [],
      timeline: () => [{ event: "review_requested", created_at: "2026-08-11T00:00:00.000Z" }],
    });

    const result = await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });

    expect(result).toMatchObject({ enumerated: 1, written: 1, unreadable: 0, truncated: false });
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestsReadable).toBe(true);
    expect(rows[0]?.reviewsReadable).toBe(true);
    expect(rows[0]?.pendingReviewRequests).toEqual([
      { reviewerSlug: "onprem-k8s-ally-reviewer", requestedAt: "2026-08-11T00:00:00.000Z" },
    ]);
    // The clock is dated from the timeline, not from PR creation.
    expect(rows[0]?.prCreatedAt.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });

  it("records a failed requested-reviewers probe as unreadable, never as an empty request list", async () => {
    routeGithub({
      openPrPages: [[openPr(2500)]],
      requestedReviewers: () => null,
      reviews: () => [],
    });

    const result = await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });

    expect(result.unreadable).toBe(1);
    const rows = await storedRows();
    expect(rows[0]?.requestsReadable).toBe(false);
    expect(rows[0]?.unreadableReason).toContain("requested_reviewers probe failed");
  });

  it("records a failed reviews probe as unreadable", async () => {
    routeGithub({
      openPrPages: [[openPr(2501)]],
      requestedReviewers: () => ({ users: [], teams: [{ slug: "team" }] }),
      reviews: () => null,
      timeline: () => [],
    });

    await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });

    const rows = await storedRows();
    expect(rows[0]?.reviewsReadable).toBe(false);
    expect(rows[0]?.unreadableReason).toContain("reviews probe failed");
  });

  it("prunes rows for PRs that have left the open set", async () => {
    routeGithub({ openPrPages: [[openPr(1), openPr(2)]], requestedReviewers: () => ({ users: [], teams: [] }) });
    await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });
    expect(await storedRows()).toHaveLength(2);

    // #2 merged; only #1 is still open.
    routeGithub({ openPrPages: [[openPr(1)]], requestedReviewers: () => ({ users: [], teams: [] }) });
    const result = await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });

    expect(result.pruned).toBe(1);
    const rows = await storedRows();
    expect(rows.map((row) => row.prNumber)).toEqual([1]);
  });

  it("does NOT prune when the enumeration was truncated", async () => {
    routeGithub({ openPrPages: [[openPr(1), openPr(2)]], requestedReviewers: () => ({ users: [], teams: [] }) });
    await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });
    expect(await storedRows()).toHaveLength(2);

    // A budget of 1 sees only #1. #2 has not closed — it was simply not reached,
    // so deleting it here would silently shrink the digest population.
    routeGithub({ openPrPages: [[openPr(1), openPr(2)]], requestedReviewers: () => ({ users: [], teams: [] }) });
    const result = await reconcileRepoReviewState(db, {
      companyId,
      repoFullName: REPO,
      token: "t",
      now: NOW,
      maxPullRequests: 1,
      logger: { info: () => {}, warn: () => {} },
    });

    expect(result.truncated).toBe(true);
    expect(result.pruned).toBe(0);
    expect((await storedRows()).map((row) => row.prNumber).sort()).toEqual([1, 2]);
  });

  it("throws rather than pruning when the open-PR enumeration itself fails", async () => {
    routeGithub({ openPrPages: [[openPr(1)]], requestedReviewers: () => ({ users: [], teams: [] }) });
    await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });
    expect(await storedRows()).toHaveLength(1);

    routeGithub({ openPrPages: [null] });
    await expect(
      reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW }),
    ).rejects.toThrow(/open-PR enumeration failed/);
    // The prior row survived: an unreadable repo is not an empty repo.
    expect(await storedRows()).toHaveLength(1);
  });

  it("ages a re-request from the OLDEST standing request, so stacking cannot reset the clock", async () => {
    routeGithub({
      openPrPages: [[openPr(2600)]],
      requestedReviewers: () => ({ users: [], teams: [{ slug: "team" }] }),
      reviews: () => [],
      timeline: () => [
        { event: "review_requested", created_at: "2026-08-01T00:00:00.000Z" },
        { event: "review_requested", created_at: "2026-08-20T00:00:00.000Z" },
      ],
    });

    await reconcileRepoReviewState(db, { companyId, repoFullName: REPO, token: "t", now: NOW });

    const rows = await storedRows();
    expect(rows[0]?.pendingReviewRequests[0]?.requestedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("discovers targets from work products, so a repo with only OPEN PRs is visible", async () => {
    const { issueWorkProducts, issues } = await import("@paperclipai/db");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "RWP-1",
      title: "carrier issue",
      status: "in_progress",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: `${REPO}#77`,
      title: "an OPEN pr",
      status: "ready_for_review",
      metadata: { repoFullName: REPO, prNumber: 77 },
    });

    const targets = await selectReviewStateTargets(db);

    expect(targets).toContainEqual({ companyId, repoFullName: REPO });
    await db.delete(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId)));
    await db.delete(issues).where(eq(issues.companyId, companyId));
  });
});

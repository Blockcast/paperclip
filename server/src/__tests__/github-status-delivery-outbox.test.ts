import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  githubCommitStatusDeliveries,
  githubStatusKeyLeases,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { asc, eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const h = vi.hoisted(() => ({
  cfg: {
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    prReviewerBotLogin: "allyblockcast[bot]",
    // Read by pr-comment-review-gate, which the `reevaluate` rows below drive
    // for real rather than through a seam.
    prCommentReviewGateStatusContext: "",
    prCommentReviewGateRetiredStatusContexts: [] as string[],
  } as Record<string, unknown> & {
    githubAppId: string;
    githubAppInstallationId: string;
    githubAppPrivateKey: string;
    prReviewerBotLogin: string;
    prCommentReviewGateStatusContext: string;
    prCommentReviewGateRetiredStatusContexts: string[];
  },
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import { _resetInstallationTokenCache, githubPostCommitStatusDetailed } from "../services/github-app-auth.js";
import { runPrCommentReviewGateCheck } from "../services/pr-comment-review-gate.js";
import {
  _classifyReviewerEvidenceError,
  enqueueGithubCommitStatusDelivery,
  _setGithubStatusKeyLeaseTimingForTest,
  pollGitHubCommitStatusDeliveriesOnce,
  resetStaleGitHubCommitStatusDeliveries,
  withGithubStatusDeliveryLock,
} from "../services/github-status-delivery-outbox.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres GitHub status delivery outbox tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FUTURE_ISO = "2999-01-01T00:00:00Z";
const HEAD_SHA = "45eb633e348a826f43dc68b0c25fe83a96300cea";

function jsonResponse(data: unknown, ok = true, status = 200, headers: Record<string, string> = {}): Response {
  return { ok, status, headers: new Headers(headers), json: async () => data } as unknown as Response;
}

/** A review fixture in the REST shape every test below is still written in. */
type FakeReviewRow = {
  user?: { login?: string };
  commit_id?: string;
  state?: string;
  body?: string;
  submitted_at?: string;
};

/**
 * PEN-6341 item 2: the reviewer-evidence pager reads `/pulls/{n}/reviews` over
 * GraphQL now, so those REST-shaped fixtures are rendered here into the
 * `reviews` connection the reader actually parses.
 *
 * A Bot actor's `login` is the BARE slug over GraphQL where REST returns
 * `<slug>[bot]` (measured on Blockcast/paperclip#3694); the suffix is stripped
 * here and the READER is what puts it back, which is what keeps the
 * Ally-identity assertions below a test of the reader rather than an echo of
 * their own fixture.
 *
 * Every field a fixture supplies is carried. `submittedAt` in particular is
 * load-bearing and was missed once: the comment-review gate orders a review
 * against the green status it is re-evaluating, so hardcoding `null` here
 * silently turns "a newer finding exists" into "nothing newer" and flips the
 * posted gate state from `failure` to `success`.
 */
function graphQlReviewsEnvelope(rows: unknown[]): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: rows.map((row) => {
              const rest = row as FakeReviewRow;
              const login = rest.user?.login ?? "";
              const isBot = login.endsWith("[bot]");
              return {
                state: rest.state ?? "",
                body: rest.body ?? "",
                submittedAt: rest.submitted_at ?? null,
                author: {
                  login: isBot ? login.slice(0, -"[bot]".length) : login,
                  __typename: isBot ? "Bot" : "User",
                },
                commit: { oid: rest.commit_id ?? null },
              };
            }),
          },
        },
      },
    },
  };
}

/** True when this GraphQL POST is the reviews pager rather than a field read. */
function isReviewsQuery(init?: unknown): boolean {
  const body = (init as { body?: unknown } | undefined)?.body;
  return typeof body === "string" && body.includes("reviews(first:");
}

function setCreds() {
  h.cfg.githubAppId = "3966421";
  h.cfg.githubAppInstallationId = "12345678";
  h.cfg.githubAppPrivateKey = PRIVATE_KEY_PEM;
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

function clearCreds() {
  h.cfg.githubAppId = "";
  h.cfg.githubAppInstallationId = "";
  h.cfg.githubAppPrivateKey = "";
  h.cfg.prReviewerBotLogin = "allyblockcast[bot]";
}

// BLO-28968: an evidence-fetch failure is never evidence about the PR, on any
// surface. These pin the *default* — permanent is the enumerated exception —
// so a future third evidence surface cannot silently inherit permanent failure.
// Needs no database: the classifier is pure apart from the mocked config read.
describe("reviewer-evidence error classification", () => {
  afterEach(() => {
    clearCreds();
  });

  // `reviews_graphql_errors` is the PEN-6341 item-2 spelling of an unreadable
  // reviews surface: GitHub answers an unknown pull-request number with HTTP
  // 200 plus an `errors` entry, so it never reaches the `http_*` arms above.
  for (const error of [
    "reviews_http_403",
    "reviews_http_404",
    "reviews_http_401",
    "reviews_graphql_errors",
  ]) {
    it(`retries \`${error}\` rather than permanently dropping the gate-status delivery`, () => {
      setCreds();
      expect(_classifyReviewerEvidenceError(error)).toEqual({
        retryable: true,
        reason: `reviewer_evidence_${error}`,
      });
    });
  }

  it("keeps a missing reviewer bot login permanent", () => {
    setCreds();
    expect(_classifyReviewerEvidenceError("no_bot_login")).toEqual({
      retryable: false,
      reason: "missing_pr_reviewer_bot_login",
    });
  });

  it("keeps an absent GitHub App credential set permanent", () => {
    clearCreds();
    expect(_classifyReviewerEvidenceError("no_token")).toEqual({
      retryable: false,
      reason: "missing_github_app_credentials",
    });
  });

  it("retries a token blip when the credentials are configured", () => {
    setCreds();
    expect(_classifyReviewerEvidenceError("no_token")).toEqual({
      retryable: true,
      reason: "github_app_token_unavailable",
    });
  });
});

describeEmbeddedPostgres("GitHub commit-status delivery outbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-status-outbox-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    _resetInstallationTokenCache();
    clearCreds();
    vi.unstubAllGlobals();
    await db.delete(githubCommitStatusDeliveries);
    await db.delete(githubStatusKeyLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "pr_review_output_missing",
      contextSnapshot: {
        wakeReason: "github_pr_synchronized",
        githubRepoFullName: "Blockcast/hang",
        githubPrNumber: 7,
        githubHeadSha: HEAD_SHA,
      },
    });
    const delivery = await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: runId,
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Paperclip reviewer run exhausted its automatic retries; no review was posted.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7",
    });
    return { companyId, agentId, runId, delivery };
  }

  function stubGithub(options: {
    latestStatuses?: unknown[];
    reviews?: unknown[];
    reviewsStatus?: number;
    reviewsBody?: unknown;
    reviewsHeaders?: Record<string, string>;
    comments?: unknown[];
    postStatus?: number;
    postBody?: unknown;
    postHeaders?: Record<string, string>;
    // Fail the status POST for these contexts only, so a test can drive the
    // live write succeeding while a retired-context supersede does not. 422 is
    // classified non-retryable, which keeps the bounded retry from sleeping.
    failPostContexts?: string[];
    // `GET /commits/{sha}/pulls` — every open pull request at this head. The
    // gate sweeps it before publishing a `success` so a green means no PR at
    // this head is red (PEN-3818). It MUST be routed even when a test has no
    // peers to describe: left unstubbed the fetch throws, the enumeration fails
    // closed, and the publish is withheld as `fetch_failed`, so every clean
    // verdict here would collapse for a reason the test never asked about.
    // The default `[]` is equivalent to the realistic self-only page, because
    // the sweep skips its own row; a test that wants the self-skip or a peer
    // verdict exercised passes the rows explicitly.
    openPullRequestsAtHead?: unknown[];
  }) {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) return jsonResponse(options.latestStatuses ?? []);
      if (/\/commits\/[^/]+\/pulls(?:\?|$)/.test(u)) return jsonResponse(options.openPullRequestsAtHead ?? []);
      // TWO GraphQL documents now arrive on this ONE url, and they are told
      // apart by the document rather than by the url: the reviews pager
      // (PEN-6341 item 2) and the PR-author field read.
      if (u.endsWith("/graphql")) {
        if (isReviewsQuery(init)) {
          if (options.reviewsStatus && options.reviewsStatus >= 400) {
            return jsonResponse(
              options.reviewsBody ?? {},
              false,
              options.reviewsStatus,
              options.reviewsHeaders,
            );
          }
          return jsonResponse(graphQlReviewsEnvelope(options.reviews ?? []));
        }
        // The PR author, read over GraphQL since PEN-6341 (`user.login` ->
        // `author { login }`). The gate reads it only to refuse `clean` for a
        // self-attestation (BLO-34316), so this must answer with an identity
        // distinct from `prReviewerBotLogin`: left unstubbed, the fetch throws,
        // the bounded retry swallows it, and every clean verdict here collapses
        // to `fetch_failed` with nothing posted.
        return jsonResponse({
          data: { repository: { pullRequest: { author: { login: "distinct-pr-author" } } } },
        });
      }
      if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse(options.comments ?? []);
      if (u.includes("/check-runs")) return jsonResponse({ id: 2 }, true, 201);
      if (/\/statuses\/[0-9a-f]{7,40}(?:\?|$)/i.test(u)) {
        const context = String(JSON.parse(String(init?.body ?? "{}")).context ?? "");
        if (options.failPostContexts?.includes(context)) return jsonResponse({ message: "nope" }, false, 422);
        const status = options.postStatus ?? 201;
        return jsonResponse(options.postBody ?? { id: 1 }, status < 400, status, options.postHeaders);
      }
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function readDelivery(id: string) {
    return db
      .select()
      .from(githubCommitStatusDeliveries)
      .where(eq(githubCommitStatusDeliveries.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function readRunEvents(runId: string) {
    return db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(asc(heartbeatRunEvents.seq));
  }

  it("posts the failure status after confirming no newer status or reviewer evidence exists", async () => {
    setCreds();
    const { runId, delivery } = await seedRun();
    const fetchMock = stubGithub({ latestStatuses: [], reviews: [], comments: [] });

    await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

    expect(await readDelivery(delivery.id)).toMatchObject({ status: "delivered", attempts: 0 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(true);
    const events = await readRunEvents(runId);
    expect(events.at(-1)?.message).toContain("Set PR-review gate status review/ally-complete to failure");
  });

  it("scrubs a credential straddling the 140-char cap before persisting it (PEN-3157)", async () => {
    // Ally caught this on #1754: the enqueue truncated to 140 characters and
    // only the SEND scrubbed, so a credential crossing the cut lost the tail
    // its detector needs. The fragment then matched nothing, was persisted, and
    // was republished on every replay — the durable path was the one place the
    // scrub-before-trim guarantee did not hold.
    //
    // Sized so trim-then-scrub cannot pass by accident: the filler ends in a
    // space (VENDOR_KEY_RE is `\b`-anchored) and leaves fewer than the 20 tail
    // characters the detector needs, so truncating first yields no marker at
    // all. Assembled from parts so no credential-shaped literal is committed.
    setCreds();
    const { companyId, runId } = await seedRun();
    const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("");
    const filler = `${"x".repeat(116)} `;

    const delivery = await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: runId,
      repoFullName: "Blockcast/hang",
      sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
      context: "review/straddle",
      state: "failure",
      description: `${filler}${token}`,
      targetUrl: null,
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7",
    });

    const persisted = await readDelivery(delivery.id);
    expect(persisted?.description).not.toContain(token);
    // The marker is the discriminator. Truncating first would also have removed
    // the token — by cutting it, not by detecting it — so absence alone would
    // pass for the wrong reason.
    expect(persisted?.description).toContain("[paperclip-egress-scrub");
    expect((persisted?.description ?? "").length).toBeLessThanOrEqual(140);
  });

  it("scrubs the description on the ON CONFLICT arm too, not only on insert", async () => {
    // The insert arm and the update arm used to derive `description`
    // independently: `values` scrubbed-then-trimmed, while the
    // onConflictDoUpdate `set` did a bare `input.description.slice(0, 140)`.
    // So the guarantee the test above pins held only for a key never seen
    // before — and the conflict target is (repoFullName, sha, context), which
    // means every RE-evaluation of the same gate context on the same head takes
    // the update arm. The bypass was on the common path, not an edge case.
    //
    // Same sizing as above so trim-then-scrub cannot pass by accident, and the
    // marker rather than the token's absence is the discriminator.
    setCreds();
    const { companyId, runId } = await seedRun();
    const token = ["gh", "p_", "Z9y8X7w6V5u4T3s2R1q0P9o8"].join("");
    const filler = `${"x".repeat(116)} `;
    const key = {
      companyId,
      sourceRunId: runId,
      repoFullName: "Blockcast/hang",
      sha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
      context: "review/conflict-arm",
      prNumber: 9,
      prUrl: "https://github.com/Blockcast/hang/pull/9",
      targetUrl: null,
    };

    // First enqueue creates the row (insert arm) with innocuous text.
    const first = await enqueueGithubCommitStatusDelivery(db, {
      ...key,
      state: "pending",
      description: "queued",
    });
    // Second enqueue on the identical key takes the ON CONFLICT arm.
    const second = await enqueueGithubCommitStatusDelivery(db, {
      ...key,
      state: "failure",
      description: `${filler}${token}`,
    });
    expect(second.id, "expected the same row, i.e. the conflict arm").toBe(first.id);

    const persisted = await readDelivery(second.id);
    expect(persisted?.description).not.toContain(token);
    expect(persisted?.description).toContain("[paperclip-egress-scrub");
    expect((persisted?.description ?? "").length).toBeLessThanOrEqual(140);
  });

  it("does not double-process one delivery when pollers race", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const fetchMock = stubGithub({ latestStatuses: [], reviews: [], comments: [] });

    const results = await Promise.all([
      pollGitHubCommitStatusDeliveriesOnce(db),
      pollGitHubCommitStatusDeliveriesOnce(db),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(await readDelivery(delivery.id)).toMatchObject({ status: "delivered" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`)).length).toBe(1);
  });

  it("preserves an active processing claim when enqueue races the worker", async () => {
    const { companyId, runId, delivery } = await seedRun();
    const claimTime = new Date("2026-07-25T12:34:56.000Z");
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        status: "processing",
        attempts: 2,
        nextAttemptAt: claimTime,
        updatedAt: claimTime,
        description: "Claimed worker payload",
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: runId,
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Replacement enqueue payload",
      targetUrl: "https://github.com/Blockcast/hang/pull/7?replacement=1",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7?replacement=1",
    });

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "processing",
      attempts: 2,
      description: "Claimed worker payload",
      targetUrl: "https://github.com/Blockcast/hang/pull/7",
      prUrl: "https://github.com/Blockcast/hang/pull/7",
      updatedAt: claimTime,
    });
  });

  it("fences a stale worker before posting when reclamation revokes its claim", async () => {
    setCreds();
    const { delivery } = await seedRun();
    let reclaimed = false;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) return jsonResponse([]);
      if (u.endsWith("/graphql") && isReviewsQuery(init)) {
        const staleProcessingAt = new Date(Date.now() - 11 * 60 * 1_000);
        await db
          .update(githubCommitStatusDeliveries)
          .set({ updatedAt: staleProcessingAt })
          .where(eq(githubCommitStatusDeliveries.id, delivery.id));
        await expect(resetStaleGitHubCommitStatusDeliveries(db, new Date())).resolves.toBe(1);
        reclaimed = true;
        return jsonResponse(graphQlReviewsEnvelope([]));
      }
      if (/\/statuses\/[0-9a-f]{7,40}(?:\?|$)/i.test(u)) return jsonResponse({ id: 1 }, true, 201);
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

    expect(reclaimed).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
    expect(await readDelivery(delivery.id)).toMatchObject({ status: "queued" });
  });

  it("reclaims expired processing rows during normal polling", async () => {
    const { delivery } = await seedRun();
    const staleProcessingAt = new Date(Date.now() - 11 * 60 * 1_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({ status: "processing", nextAttemptAt: staleProcessingAt, updatedAt: staleProcessingAt })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "failed_permanent",
      lastError: "missing_github_app_credentials",
      lastErrorKind: "permanent",
    });
  });

  it("treats same-second GitHub statuses as fresh enough to avoid overwrite", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const queuedAt = new Date("2026-07-25T12:00:00.900Z");
    await db
      .update(githubCommitStatusDeliveries)
      .set({ createdAt: queuedAt, nextAttemptAt: queuedAt, updatedAt: queuedAt })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));
    const fetchMock = stubGithub({
      latestStatuses: [
        {
          context: "review/ally-complete",
          state: "failure",
          created_at: "2026-07-25T12:00:00Z",
        },
      ],
      reviews: [],
      comments: [],
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "skipped",
      lastResult: { reason: "newer_or_same_second_status_exists" },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("refreshes the freshness baseline when reviving a failed delivery", async () => {
    setCreds();
    const { companyId, runId, delivery } = await seedRun();
    const originalQueuedAt = new Date(Date.now() - 60_000);
    const interveningStatusAt = new Date(Date.now() - 30_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        status: "failed_permanent",
        createdAt: originalQueuedAt,
        updatedAt: originalQueuedAt,
        nextAttemptAt: originalQueuedAt,
        lastError: "commit_status_write_http_403",
        lastErrorKind: "permanent",
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const revived = await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: runId,
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Paperclip reviewer run exhausted again; no review was posted.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7?attempt=2",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7?attempt=2",
    });
    const fetchMock = stubGithub({
      latestStatuses: [
        {
          context: "review/ally-complete",
          state: "pending",
          created_at: interveningStatusAt.toISOString(),
        },
      ],
      reviews: [],
      comments: [],
    });

    expect(revived.createdAt.getTime()).toBeGreaterThan(interveningStatusAt.getTime());
    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({ status: "delivered" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(true);
  });

  it("re-delivers a terminal same-head status for a new source run", async () => {
    setCreds();
    const { companyId, agentId, delivery } = await seedRun();
    const originalDeliveredAt = new Date(Date.now() - 60_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        status: "delivered",
        deliveredAt: originalDeliveredAt,
        createdAt: originalDeliveredAt,
        updatedAt: originalDeliveredAt,
        nextAttemptAt: originalDeliveredAt,
        lastResult: { posted: { ok: true } },
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      errorCode: "pr_review_output_missing",
      contextSnapshot: {
        wakeReason: "github_pr_synchronized",
        githubRepoFullName: "Blockcast/hang",
        githubPrNumber: 7,
        githubHeadSha: HEAD_SHA,
      },
    });

    const revived = await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: secondRunId,
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Paperclip reviewer run exhausted again; no review was posted.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7?attempt=2",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7?attempt=2",
    });
    const fetchMock = stubGithub({
      latestStatuses: [
        {
          context: "review/ally-complete",
          state: "failure",
          created_at: originalDeliveredAt.toISOString(),
        },
      ],
      reviews: [],
      comments: [],
    });

    expect(revived).toMatchObject({
      id: delivery.id,
      sourceRunId: secondRunId,
      status: "queued",
      attempts: 0,
      description: "Paperclip reviewer run exhausted again; no review was posted.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7?attempt=2",
    });
    expect(revived.createdAt.getTime()).toBeGreaterThan(originalDeliveredAt.getTime());

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "delivered",
      sourceRunId: secondRunId,
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`)).length).toBe(1);
    const events = await readRunEvents(secondRunId);
    expect(events.at(-1)?.message).toContain("Set PR-review gate status review/ally-complete to failure");
  });

  it("re-queues a delivered webhook-originated row", async () => {
    setCreds();
    const { companyId, delivery } = await seedRun();
    const deliveredAt = new Date(Date.now() - 60_000);
    // Webhook-originated rows carry no source run (migration 0238 made
    // source_run_id nullable), so preserveExistingDelivery compares NULL to
    // NULL. In SQL that is NULL, not true, which is what lets a terminal row
    // be revived. Pin it: if someone "fixes" the comparison to
    // `is not distinct from`, the row below stays `delivered` and the retirement
    // re-delivery is silently dropped.
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        status: "delivered",
        sourceRunId: null,
        deliveredAt,
        createdAt: deliveredAt,
        updatedAt: deliveredAt,
        nextAttemptAt: deliveredAt,
        lastResult: { posted: { ok: true } },
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const revived = await enqueueGithubCommitStatusDelivery(db, {
      companyId,
      sourceRunId: null,
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Retired. Findings now publish elsewhere.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7",
      forceWrite: true,
    });

    expect(revived).toMatchObject({
      id: delivery.id,
      sourceRunId: null,
      status: "queued",
      attempts: 0,
      forceWrite: true,
      description: "Retired. Findings now publish elsewhere.",
    });
  });

  it("enqueues a retirement when the provenance keys are omitted entirely", async () => {
    setCreds();
    // The webhook retirement call site omits `companyId` and `sourceRunId`
    // rather than passing null, so both arrive as `undefined`. That is a
    // DIFFERENT input from null: drizzle renders an `undefined` chunk as the
    // empty string with no bound parameter, which turns
    // `source_run_id = ${...}` into `source_run_id = ` and a CASE ELSE arm into
    // `else  end` — Postgres 42601 at parse time. Every webhook-originated
    // retirement therefore rejected before writing a row, so the outbox, the
    // force_write column and the forced-retry lock had no reachable caller.
    // The sibling test above passes `sourceRunId: null` explicitly and so
    // cannot catch this; only the omitted shape reproduces production.
    const { delivery } = await seedRun();
    const deliveredAt = new Date(Date.now() - 60_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        status: "delivered",
        companyId: null,
        sourceRunId: null,
        deliveredAt,
        createdAt: deliveredAt,
        updatedAt: deliveredAt,
        nextAttemptAt: deliveredAt,
        lastResult: { posted: { ok: true } },
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const revived = await enqueueGithubCommitStatusDelivery(db, {
      repoFullName: "Blockcast/hang",
      sha: HEAD_SHA,
      context: "review/ally-complete",
      state: "failure",
      description: "Retired. Findings now publish elsewhere.",
      targetUrl: "https://github.com/Blockcast/hang/pull/7",
      prNumber: 7,
      prUrl: "https://github.com/Blockcast/hang/pull/7",
      forceWrite: true,
    });

    // Both the insert values and the two CASE arms must normalize to NULL, and
    // the row must actually be revived — an omitted sourceRunId has to compare
    // the same way an explicit null does, or the retirement is dropped.
    expect(revived).toMatchObject({
      id: delivery.id,
      companyId: null,
      sourceRunId: null,
      status: "queued",
      attempts: 0,
      forceWrite: true,
      description: "Retired. Findings now publish elsewhere.",
    });
  });

  it("skips the failure write when an approved App review exists on GitHub", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const fetchMock = stubGithub({
      latestStatuses: [],
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: HEAD_SHA, state: "APPROVED" }],
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({ status: "skipped" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  // BLO-28920: this outbox decides whether to post a "reviewer never finished"
  // FAILURE status, which is an attestation question, not a merge-authorization
  // one. An exact-head COMMENTED review proves the reviewer DID finish, so the
  // red status would be a false alarm. Suppressing it does not authorize a
  // merge: the required context simply stays unposted/pending (BLO-17456).
  it("skips the failure write when an exact-head COMMENTED App review exists", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const fetchMock = stubGithub({
      latestStatuses: [],
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: HEAD_SHA, state: "COMMENTED" }],
      comments: [],
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({ status: "skipped" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("re-checks commit status after reviewer evidence before posting failure", async () => {
    setCreds();
    const { delivery } = await seedRun();
    let statusReads = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) {
        statusReads += 1;
        return jsonResponse(
          statusReads === 1
            ? []
            : [
                {
                  context: "review/ally-complete",
                  state: "success",
                  created_at: "2026-07-31T10:01:00Z",
                },
              ],
        );
      }
      if (u.endsWith("/graphql") && isReviewsQuery(init)) return jsonResponse(graphQlReviewsEnvelope([]));
      if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse([]);
      if (/\/statuses\/[0-9a-f]{7,40}(?:\?|$)/i.test(u)) return jsonResponse({ id: 1 }, true, 201);
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(statusReads).toBe(2);
    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "skipped",
      lastResult: { reason: "existing_success_status" },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("retries a transient status write failure with bounded backoff", async () => {
    setCreds();
    const { runId, delivery } = await seedRun();
    stubGithub({ latestStatuses: [], reviews: [], comments: [], postStatus: 503 });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    const updated = await readDelivery(delivery.id);
    expect(updated).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "commit_status_write_http_503",
      lastErrorKind: "transient",
    });
    expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    const events = await readRunEvents(runId);
    expect(events.at(-1)?.message).toContain("will retry");
  });

  it("does not let a forced retirement retry overwrite a fresh clean evaluation", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const queuedAt = new Date(Date.now() - 60_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        context: "review/ally-comment",
        forceWrite: true,
        status: "queued",
        createdAt: queuedAt,
        nextAttemptAt: queuedAt,
        updatedAt: queuedAt,
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const fetchMock = stubGithub({
      latestStatuses: [
        {
          context: "review/ally-comment",
          state: "success",
          created_at: new Date().toISOString(),
        },
      ],
      reviews: [],
      comments: [],
    });

    await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "skipped",
      forceWrite: true,
      lastResult: { reason: "fresh_success_status_exists" },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("does not let a stale forced success overwrite a newer blocking evaluation", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const queuedAt = new Date(Date.now() - 60_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        context: "review/ally-comment",
        state: "success",
        forceWrite: true,
        status: "queued",
        createdAt: queuedAt,
        nextAttemptAt: queuedAt,
        updatedAt: queuedAt,
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    const fetchMock = stubGithub({
      latestStatuses: [
        {
          context: "review/ally-comment",
          state: "failure",
          created_at: new Date().toISOString(),
        },
      ],
      reviews: [],
      comments: [],
    });

    await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "skipped",
      forceWrite: true,
      lastResult: { reason: "newer_status_exists" },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("lets a clean evaluation win between the retry freshness check and its post", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const queuedAt = new Date(Date.now() - 60_000);
    await db
      .update(githubCommitStatusDeliveries)
      .set({
        context: "review/ally-comment",
        forceWrite: true,
        status: "queued",
        createdAt: queuedAt,
        nextAttemptAt: queuedAt,
        updatedAt: queuedAt,
        description: "stale failure payload",
      })
      .where(eq(githubCommitStatusDeliveries.id, delivery.id));

    let statusReads = 0;
    let releaseRetryRead!: () => void;
    const retryReadStarted = new Promise<void>((resolve) => {
      releaseRetryRead = resolve;
    });
    let releaseRetry!: () => void;
    const retryReleased = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const postedBodies: Array<{ state?: string; context?: string; description?: string }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) {
        statusReads += 1;
        if (statusReads === 2) {
          releaseRetryRead();
          await retryReleased;
          return jsonResponse([]);
        }
        if (statusReads === 1) return jsonResponse([]);
        return jsonResponse([
          {
            context: "review/ally-comment",
            state: "success",
            created_at: new Date().toISOString(),
          },
        ]);
      }
      if (/\/statuses\/[0-9a-f]{7,40}(?:\?|$)/i.test(u)) {
        if (init?.body) postedBodies.push(JSON.parse(String(init.body)) as { state?: string; context?: string; description?: string });
        return jsonResponse({ id: postedBodies.length }, true, 201);
      }
      if (u.endsWith("/graphql") && isReviewsQuery(init)) return jsonResponse(graphQlReviewsEnvelope([]));
      if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse([]);
      throw new Error(`unexpected url ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const retry = pollGitHubCommitStatusDeliveriesOnce(db);
    await retryReadStarted;

    // The newer evaluation shares the same lock and publishes while the worker
    // is paused inside its pre-lock freshness re-check, i.e. after it has
    // claimed the row but before it holds the advisory lock. Asserted as the
    // exact body so a post to the wrong context cannot pass.
    await withGithubStatusDeliveryLock(
      db,
      "Blockcast/hang#" + HEAD_SHA,
      () => githubPostCommitStatusDetailed({
        repoFullName: "Blockcast/hang",
        sha: HEAD_SHA,
        context: "review/ally-comment",
        state: "success",
        description: "new clean evaluation",
        targetUrl: null,
      }),
    );
    releaseRetry();
    await retry;

    expect(postedBodies).toEqual([
      { state: "success", context: "review/ally-comment", description: "new clean evaluation" },
    ]);
    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "skipped",
      lastResult: { reason: "fresh_success_status_exists" },
    });
  });

  it("retries a GitHub rate-limited 403 status write instead of marking it permanent", async () => {
    setCreds();
    const { delivery } = await seedRun();
    stubGithub({
      latestStatuses: [],
      reviews: [],
      comments: [],
      postStatus: 403,
      postBody: { message: "API rate limit exceeded for installation" },
      postHeaders: { "retry-after": "60" },
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    const updated = await readDelivery(delivery.id);
    expect(updated).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "commit_status_write_rate_limited",
      lastErrorKind: "transient",
    });
    expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("retries a GitHub rate-limited 403 reviewer-evidence fetch instead of marking it permanent", async () => {
    setCreds();
    const { delivery } = await seedRun();
    stubGithub({
      latestStatuses: [],
      reviewsStatus: 403,
      reviewsBody: { message: "You have exceeded a secondary rate limit" },
      reviewsHeaders: { "retry-after": "60" },
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    const updated = await readDelivery(delivery.id);
    expect(updated).toMatchObject({
      status: "queued",
      attempts: 1,
      // PEN-6341 item 2: `ghGraphQlQuery` does not hand back the `Response`,
      // so the reader can no longer tell a rate-limited 403 from any other 403
      // by its headers and records `reviews_http_403`. The PROPERTY this test
      // pins is unchanged and is the one that matters -- retryable, not
      // permanent -- because `classifyReviewerEvidenceError` defaults every
      // unenumerated reason to retryable (BLO-28968).
      lastError: "reviewer_evidence_reviews_http_403",
      lastErrorKind: "transient",
    });
    expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps the delivery retryable when the reviews surface 404s", async () => {
    setCreds();
    const { delivery } = await seedRun();
    stubGithub({
      latestStatuses: [],
      reviewsStatus: 404,
      reviewsBody: { message: "Not Found" },
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    const updated = await readDelivery(delivery.id);
    expect(updated).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "reviewer_evidence_reviews_http_404",
      lastErrorKind: "transient",
    });
    expect(updated?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks permission failures as permanent instead of retrying forever", async () => {
    setCreds();
    const { delivery } = await seedRun();
    stubGithub({ latestStatuses: [], reviews: [], comments: [], postStatus: 403 });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "failed_permanent",
      attempts: 0,
      lastError: "commit_status_write_http_403",
      lastErrorKind: "permanent",
    });
  });

  it("surfaces missing GitHub App credentials as permanent configuration failure", async () => {
    const { delivery } = await seedRun();

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({
      status: "failed_permanent",
      lastError: "missing_github_app_credentials",
      lastErrorKind: "permanent",
    });
  });

  // BLO-36819. The comment-review gate evaluation runs on a void-detached
  // promise fired after the webhook ack, and it is the sole writer of its
  // status context — so one lost evaluation (fetch failure past its bounded
  // retries, refused POST, or a pod restart mid-flight) leaves the previous
  // verdict standing forever. frr#105 sat `failure` for hours after a clean
  // at-head review. A `reevaluate` row re-runs the evaluation here; unlike
  // every other row in this table it carries no verdict of its own.
  describe("comment-review gate re-evaluation", () => {
    const GATE_CONTEXT = "gate/ally-comment-findings";

    function cleanAllyReview(sha: string) {
      return {
        user: { login: "allyblockcast[bot]" },
        state: "COMMENTED",
        submitted_at: "2026-09-26T16:45:29Z",
        body: `## Ally — Consolidated PR Review\nReviewed head: ${sha}\n### Critical Issues (0)\n### Important Issues (0)`,
      };
    }

    // The realistic `GET /commits/{sha}/pulls` page for these rows: the only
    // open pull request at this head is the one being re-evaluated. The sweep
    // skips its own row, so this is the self-skip branch rather than a peer.
    function selfOnlyPullsPage() {
      return [
        {
          number: 105,
          state: "open",
          head: { sha: HEAD_SHA },
          html_url: "https://github.com/Blockcast/frr/pull/105",
        },
      ];
    }

    async function seedReevaluation(options: { queuedAt?: Date } = {}) {
      h.cfg.prCommentReviewGateStatusContext = GATE_CONTEXT;
      const delivery = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: GATE_CONTEXT,
        state: "pending",
        description: "Comment-review gate re-evaluation queued.",
        reevaluate: true,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });
      if (options.queuedAt) {
        await db
          .update(githubCommitStatusDeliveries)
          .set({ createdAt: options.queuedAt })
          .where(eq(githubCommitStatusDeliveries.id, delivery.id));
      }
      return delivery;
    }

    function postedGateStates(fetchMock: ReturnType<typeof vi.fn>): string[] {
      return fetchMock.mock.calls
        .filter(([url]) => /\/statuses\/[0-9a-f]{40}$/i.test(String(url)))
        .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")))
        .filter((body: { context?: string }) => body.context === GATE_CONTEXT)
        .map((body: { state?: string }) => String(body.state));
    }

    afterEach(() => {
      h.cfg.prCommentReviewGateStatusContext = "";
      h.cfg.prCommentReviewGateRetiredStatusContexts = [];
    });

    it("re-runs the evaluation and publishes the verdict the live path lost", async () => {
      setCreds();
      const delivery = await seedReevaluation();
      const fetchMock = stubGithub({
        // The frozen verdict: written before this row was queued, so it is no
        // evidence that the live evaluation for this row ever landed.
        latestStatuses: [{ context: GATE_CONTEXT, state: "failure", created_at: "2026-09-26T16:32:20Z" }],
        reviews: [cleanAllyReview(HEAD_SHA)],
        comments: [],
        openPullRequestsAtHead: selfOnlyPullsPage(),
      });

      await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

      expect(await readDelivery(delivery.id)).toMatchObject({
        status: "delivered",
        lastResult: { reason: "reevaluated" },
      });
      expect(postedGateStates(fetchMock)).toEqual(["success"]);
    });

    // The guard is deliberately "a status was written at or after this row was
    // queued", not handleFreshCommitStatusIfPresent: that helper also
    // short-circuits on any `success` regardless of age, which would make this
    // backstop blind to a review that turns a green head red.
    it("skips when the live evaluation already published for this head", async () => {
      setCreds();
      const delivery = await seedReevaluation({ queuedAt: new Date("2026-09-26T16:45:30Z") });
      const fetchMock = stubGithub({
        latestStatuses: [{ context: GATE_CONTEXT, state: "success", created_at: "2026-09-26T16:45:34Z" }],
        reviews: [cleanAllyReview(HEAD_SHA)],
        comments: [],
      });

      await pollGitHubCommitStatusDeliveriesOnce(db);

      expect(await readDelivery(delivery.id)).toMatchObject({
        status: "skipped",
        lastResult: { reason: "live_evaluation_published" },
      });
      expect(postedGateStates(fetchMock)).toEqual([]);
    });

    it("re-evaluates rather than skipping when the only green status predates the row", async () => {
      setCreds();
      const delivery = await seedReevaluation();
      const fetchMock = stubGithub({
        latestStatuses: [{ context: GATE_CONTEXT, state: "success", created_at: "2026-09-26T16:32:20Z" }],
        reviews: [
          {
            user: { login: "allyblockcast[bot]" },
            state: "COMMENTED",
            submitted_at: "2026-09-26T16:45:29Z",
            body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD_SHA}\n### Important Issues (1)\nFix before merge.`,
          },
        ],
        comments: [],
      });

      await pollGitHubCommitStatusDeliveriesOnce(db);

      expect(await readDelivery(delivery.id)).toMatchObject({ status: "delivered" });
      expect(postedGateStates(fetchMock)).toEqual(["failure"]);
    });

    // The live status published; only the retired-context cleanup did not.
    // Retrying this row instead of handing the retirement its own durable row
    // loses it outright: `retryOrFailDelivery` keeps `createdAt`, so the next
    // attempt reads the status this very run wrote and terminates
    // `skipped: live_evaluation_published` — false, and the retired context
    // keeps a stale verdict standing. Same failure class this backstop exists
    // to remove, in the retirement dimension.
    it("queues a durable retirement retry instead of self-suppressing on retirement_failed", async () => {
      setCreds();
      h.cfg.prCommentReviewGateRetiredStatusContexts = ["review/ally-comment"];
      const delivery = await seedReevaluation();
      const fetchMock = stubGithub({
        latestStatuses: [{ context: GATE_CONTEXT, state: "failure", created_at: "2026-09-26T16:32:20Z" }],
        reviews: [cleanAllyReview(HEAD_SHA)],
        comments: [],
        failPostContexts: ["review/ally-comment"],
        openPullRequestsAtHead: selfOnlyPullsPage(),
      });

      await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(1);

      // The verdict this row existed to publish did publish.
      expect(postedGateStates(fetchMock)).toEqual(["success"]);
      expect(await readDelivery(delivery.id)).toMatchObject({
        status: "delivered",
        lastResult: { reason: "reevaluated_retirement_requeued" },
      });
      const retirement = await db
        .select()
        .from(githubCommitStatusDeliveries)
        .where(eq(githubCommitStatusDeliveries.context, "review/ally-comment"))
        .then((rows) => rows[0] ?? null);
      expect(retirement).toMatchObject({
        status: "queued",
        sha: HEAD_SHA,
        forceWrite: true,
        reevaluate: false,
      });
    });

    // Hold this head's status key, as a live evaluation on another pod would:
    // a live lease row under another token (BLO-52499).
    async function holdStatusKey() {
      await db.execute(sql`
        insert into github_status_key_leases (key, token, expires_at)
        values (${`blockcast/frr#${HEAD_SHA}`}, 'another-pod', clock_timestamp() + interval '1 hour')
      `);
      return async () => {
        await db.execute(sql`delete from github_status_key_leases where token = 'another-pod'`);
      };
    }

    function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms)),
      ]);
    }

    async function gateRow() {
      const [row] = await db
        .select()
        .from(githubCommitStatusDeliveries)
        .where(eq(githubCommitStatusDeliveries.context, GATE_CONTEXT));
      return row ?? null;
    }

    it("coalesces an evaluation of a held head into a forced re-evaluation without waiting (BLO-52499)", async () => {
      setCreds();
      h.cfg.prCommentReviewGateStatusContext = GATE_CONTEXT;
      const fetchMock = stubGithub({ reviews: [cleanAllyReview(HEAD_SHA)], comments: [] });
      const release = await holdStatusKey();
      try {
        const before = Date.now();
        const result = await settlesWithin(runPrCommentReviewGateCheck({
          repoFullName: "Blockcast/frr",
          prNumber: 105,
          headSha: HEAD_SHA,
          prUrl: "https://github.com/Blockcast/frr/pull/105",
          db,
        }), 5_000);

        expect(result).toEqual({ posted: false, reason: "coalesced" });
        // Nothing read or written while another evaluation owns the head.
        expect(fetchMock).not.toHaveBeenCalled();
        const row = await gateRow();
        expect(row).toMatchObject({ status: "queued", reevaluate: true, forceWrite: true, sha: HEAD_SHA, prNumber: 105 });
        expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
      } finally {
        await release();
      }
    });

    // The holder's reads may predate the coalesced trigger, and its status
    // lands after the row was queued, so "a status was written after this row"
    // must not skip a coalesced row the way it skips the webhook backstop.
    it("re-evaluates a coalesced row even when a status was written after it was queued (BLO-52499)", async () => {
      setCreds();
      h.cfg.prCommentReviewGateStatusContext = GATE_CONTEXT;
      const delivery = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: GATE_CONTEXT,
        state: "pending",
        description: "Comment-review gate re-evaluation queued.",
        reevaluate: true,
        forceWrite: true,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });
      const fetchMock = stubGithub({
        // The holder's stale green, published after the row was queued.
        latestStatuses: [{ context: GATE_CONTEXT, state: "success", created_at: new Date(Date.now() + 2_000).toISOString() }],
        reviews: [
          {
            user: { login: "allyblockcast[bot]" },
            state: "COMMENTED",
            submitted_at: "2026-09-26T16:45:29Z",
            body: `## Ally — Consolidated PR Review\nReviewed head: ${HEAD_SHA}\n### Important Issues (1)\nFix before merge.`,
          },
        ],
        comments: [],
      });

      await pollGitHubCommitStatusDeliveriesOnce(db);

      expect(await readDelivery(delivery.id)).toMatchObject({ status: "delivered", lastResult: { reason: "reevaluated" } });
      expect(postedGateStates(fetchMock)).toEqual(["failure"]);
    });

    it("re-arms a re-evaluation of a held head behind the holder without spending an attempt (BLO-52499)", async () => {
      setCreds();
      const delivery = await seedReevaluation();
      const fetchMock = stubGithub({
        latestStatuses: [{ context: GATE_CONTEXT, state: "failure", created_at: "2026-09-26T16:32:20Z" }],
        reviews: [cleanAllyReview(HEAD_SHA)],
        comments: [],
      });
      const release = await holdStatusKey();
      try {
        const before = Date.now();
        await settlesWithin(pollGitHubCommitStatusDeliveriesOnce(db), 5_000);

        const row = await readDelivery(delivery.id);
        expect(row).toMatchObject({
          status: "queued",
          attempts: 0,
          // From here on the holder's status cannot skip it.
          forceWrite: true,
        });
        expect(row!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 10_000);
        expect(postedGateStates(fetchMock)).toEqual([]);
      } finally {
        await release();
      }
    });

    // The live-context row is often the holder itself: the worker's own
    // re-evaluation of this head. A trigger that coalesces behind it must not be
    // swallowed by the upsert preserving that `processing` row, which would let
    // the holder close it `delivered` on reads that predate the trigger.
    it("keeps a trigger that coalesces behind the head's own in-flight re-evaluation (BLO-52499)", async () => {
      setCreds();
      const delivery = await seedReevaluation();
      const inner = stubGithub({
        latestStatuses: [{ context: GATE_CONTEXT, state: "failure", created_at: "2026-09-26T16:32:20Z" }],
        reviews: [cleanAllyReview(HEAD_SHA)],
        comments: [],
        openPullRequestsAtHead: selfOnlyPullsPage(),
      });
      let markReading!: () => void;
      const reading = new Promise<void>((resolve) => { markReading = resolve; });
      let releaseRead!: () => void;
      const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
      let paused = false;
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
        if (!paused && isReviewsQuery(init)) {
          paused = true;
          markReading();
          await readReleased;
        }
        return inner(url, init);
      });

      const holder = pollGitHubCommitStatusDeliveriesOnce(db);
      await reading;
      // The holder has read its reviews; a trigger arrives for another PR at the
      // same head. (The same PR would queue behind the holder in-process instead.)
      let result: Awaited<ReturnType<typeof runPrCommentReviewGateCheck>>;
      try {
        result = await settlesWithin(runPrCommentReviewGateCheck({
          repoFullName: "Blockcast/frr",
          prNumber: 106,
          headSha: HEAD_SHA,
          prUrl: "https://github.com/Blockcast/frr/pull/106",
          db,
        }), 5_000);
      } finally {
        releaseRead();
        await holder;
      }

      expect(result).toEqual({ posted: false, reason: "coalesced" });
      // The holder published from its reads, but the row survives for a rerun.
      expect(postedGateStates(inner)).toEqual(["success"]);
      expect(await readDelivery(delivery.id)).toMatchObject({ status: "queued", reevaluate: true, forceWrite: true });
    });

    it("keeps a coalesced re-evaluation forced and due when a later webhook backstop lands on it (BLO-52499)", async () => {
      h.cfg.prCommentReviewGateStatusContext = GATE_CONTEXT;
      const before = Date.now();
      // The shape the gate queues when it coalesces behind a holder.
      await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: GATE_CONTEXT,
        state: "pending",
        description: "Comment-review gate re-evaluation queued.",
        reevaluate: true,
        forceWrite: true,
        delayMs: 15_000,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });
      // The webhook's pre-ack backstop for the next trigger: unforced, 15 min out.
      const row = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: GATE_CONTEXT,
        state: "pending",
        description: "Comment-review gate re-evaluation queued.",
        reevaluate: true,
        delayMs: 15 * 60_000,
        prNumber: 106,
        prUrl: "https://github.com/Blockcast/frr/pull/106",
      });

      expect(row).toMatchObject({ status: "queued", reevaluate: true, forceWrite: true, prNumber: 106 });
      expect(row.nextAttemptAt.getTime()).toBeLessThan(before + 60_000);
    });

    it("defers a forced retirement replay while the head is held, without writing (BLO-52499)", async () => {
      setCreds();
      const delivery = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: "review/ally-comment",
        state: "failure",
        description: "retired context mirrors the live verdict",
        forceWrite: true,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });
      const fetchMock = stubGithub({ latestStatuses: [] });
      const release = await holdStatusKey();
      try {
        await settlesWithin(pollGitHubCommitStatusDeliveriesOnce(db), 5_000);

        expect(await readDelivery(delivery.id)).toMatchObject({
          status: "queued",
          attempts: 0,
          lastError: "github_status_key_busy",
        });
        expect(fetchMock.mock.calls.some(([url]) => /\/statuses\/[0-9a-f]{40}$/i.test(String(url)))).toBe(false);
      } finally {
        await release();
      }
    });

    it("holds the first attempt back by the requested delay", async () => {
      const before = Date.now();
      h.cfg.prCommentReviewGateStatusContext = GATE_CONTEXT;
      const delivery = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/frr",
        sha: HEAD_SHA,
        context: GATE_CONTEXT,
        state: "pending",
        description: "Comment-review gate re-evaluation queued.",
        reevaluate: true,
        delayMs: 15 * 60_000,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });

      expect(delivery.nextAttemptAt.getTime()).toBeGreaterThan(before + 10 * 60_000);
      // Not due yet, so the poller must not claim it.
      await expect(pollGitHubCommitStatusDeliveriesOnce(db)).resolves.toBe(0);
    });
  });

  describe("status key lease (BLO-52499)", () => {
    const KEY = `Blockcast/FRR#${HEAD_SHA}`;
    const LEASE_KEY = KEY.toLowerCase();

    afterEach(() => {
      _setGithubStatusKeyLeaseTimingForTest();
    });

    async function leaseRows() {
      return db.select().from(githubStatusKeyLeases);
    }

    async function insertLease(token: string, expiresIn: string) {
      await db.execute(sql`
        insert into github_status_key_leases (key, token, expires_at)
        values (${LEASE_KEY}, ${token}, clock_timestamp() + ${sql.raw(`interval '${expiresIn}'`)})
      `);
    }

    it("holds a lease row on the lower-cased key while it runs, and removes it after", async () => {
      const seen = await withGithubStatusDeliveryLock(db, KEY, async () => leaseRows());

      expect(seen).toHaveLength(1);
      expect(seen![0]!.key).toBe(LEASE_KEY);
      expect(await leaseRows()).toEqual([]);
    });

    it("returns null without opening a transaction while another evaluation's lease is live", async () => {
      await insertLease("another-evaluation", "1 hour");
      const transaction = vi.spyOn(db, "transaction");
      const operation = vi.fn(async () => "ran");

      // Differently cased: the lease key is case-insensitive, like GitHub's repo names.
      await expect(withGithubStatusDeliveryLock(db, `blockcast/frr#${HEAD_SHA}`, operation)).resolves.toBeNull();

      expect(operation).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(await leaseRows()).toMatchObject([{ token: "another-evaluation" }]);
    });

    it("takes over an expired lease", async () => {
      await insertLease("crashed-evaluation", "-1 second");

      await expect(withGithubStatusDeliveryLock(db, KEY, async () => "ran")).resolves.toBe("ran");
      expect(await leaseRows()).toEqual([]);
    });

    it("refuses a write once another evaluation has taken the key", async () => {
      const wrote = vi.fn();
      const result = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        await fence();
        await db.update(githubStatusKeyLeases).set({ token: "taker" });
        await fence();
        wrote();
        return "wrote";
      });

      expect(result).toBeNull();
      expect(wrote).not.toHaveBeenCalled();
      // Release deletes only its own token's row.
      expect(await leaseRows()).toMatchObject([{ token: "taker" }]);
    });

    it("renews the lease at every fence", async () => {
      const remaining = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        await db.execute(sql`update github_status_key_leases set expires_at = clock_timestamp() + interval '5 seconds'`);
        await fence();
        const [row] = (await db.execute(
          sql`select extract(epoch from expires_at - clock_timestamp()) as s from github_status_key_leases`,
        )) as unknown as Array<{ s: number }>;
        return Number(row!.s);
      });
      expect(remaining).toBeGreaterThan(80);
    });

    it("refuses a write once its lease has expired", async () => {
      const wrote = vi.fn();
      const result = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        await db.execute(sql`update github_status_key_leases set expires_at = clock_timestamp() - interval '1 second'`);
        await fence();
        wrote();
      });

      expect(result).toBeNull();
      expect(wrote).not.toHaveBeenCalled();
    });

    it("refuses a write when the renewal leaves less than a write attempt's time", async () => {
      // No time left over: any renewal latency at all eats into the write.
      _setGithubStatusKeyLeaseTimingForTest({ ttlMs: 1_000, writeBudgetMs: 1_000 });
      const wrote = vi.fn();
      let reason: string | undefined;
      const result = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        await fence().catch((err: Error) => {
          reason = err.message;
          throw err;
        });
        wrote();
      });

      expect(result).toBeNull();
      expect(reason).toBe("lease_expiring");
      expect(wrote).not.toHaveBeenCalled();
    });

    it("keeps a long evaluation's lease alive with the heartbeat", async () => {
      _setGithubStatusKeyLeaseTimingForTest({ ttlMs: 1_500, heartbeatMs: 200, writeBudgetMs: 500 });
      const result = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        // Twice the TTL, as a slow read phase would take.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await fence();
        return "wrote";
      });

      expect(result).toBe("wrote");
    });

    it("stops holding a head once an evaluation passes its maximum hold", async () => {
      _setGithubStatusKeyLeaseTimingForTest({ ttlMs: 1_000, heartbeatMs: 100, writeBudgetMs: 500, maxHoldMs: 300 });
      const wrote = vi.fn();
      let expired: boolean | undefined;
      const result = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        // Past the hold and a full TTL: the heartbeat must have stopped renewing.
        await new Promise((resolve) => setTimeout(resolve, 1_800));
        const [row] = (await db.execute(sql`
          select expires_at <= clock_timestamp() as expired from github_status_key_leases
        `)) as unknown as Array<{ expired: boolean }>;
        expired = row?.expired;
        await fence();
        wrote();
      });

      expect(result).toBeNull();
      expect(expired).toBe(true);
      expect(wrote).not.toHaveBeenCalled();
    });

    // The point of the lease: a holder keeps no pooled connection, and no
    // transaction, across its GitHub calls.
    it("holds the key without a transaction or an idle-in-transaction backend", async () => {
      const transaction = vi.spyOn(db, "transaction");
      const idleInTransaction = await withGithubStatusDeliveryLock(db, KEY, async (fence) => {
        await fence();
        const [row] = (await db.execute(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and state like 'idle in transaction%'
        `)) as unknown as Array<{ n: number }>;
        return row!.n;
      });

      expect(idleInTransaction).toBe(0);
      expect(transaction).not.toHaveBeenCalled();
    });

    it("sweeps only expired leases", async () => {
      await insertLease("crashed-evaluation", "-1 second");
      await db.execute(sql`
        insert into github_status_key_leases (key, token, expires_at)
        values ('blockcast/other#sha', 'live-evaluation', clock_timestamp() + interval '1 hour')
      `);

      await pollGitHubCommitStatusDeliveriesOnce(db);

      expect(await leaseRows()).toMatchObject([{ key: "blockcast/other#sha", token: "live-evaluation" }]);
    });

    it("defers a forced replay that loses the key before its write", async () => {
      setCreds();
      const delivery = await enqueueGithubCommitStatusDelivery(db, {
        companyId: null,
        sourceRunId: null,
        repoFullName: "Blockcast/FRR",
        sha: HEAD_SHA,
        context: "review/ally-comment",
        state: "failure",
        description: "retired context mirrors the live verdict",
        forceWrite: true,
        prNumber: 105,
        prUrl: "https://github.com/Blockcast/frr/pull/105",
      });
      const inner = stubGithub({ latestStatuses: [] });
      // The in-lock freshness read is the last thing before the fence: lose the
      // key there, as an expiry or a takeover would.
      vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
        if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(String(url))) await db.delete(githubStatusKeyLeases);
        return inner(url, init);
      });

      await pollGitHubCommitStatusDeliveriesOnce(db);

      expect(await readDelivery(delivery.id)).toMatchObject({
        status: "queued",
        attempts: 0,
        lastError: "github_status_key_busy",
      });
      expect(inner.mock.calls.some(([url]) => /\/statuses\/[0-9a-f]{40}$/i.test(String(url)))).toBe(false);
    });
  });
});

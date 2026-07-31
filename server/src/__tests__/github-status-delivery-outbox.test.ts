import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  githubCommitStatusDeliveries,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
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
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import { _resetInstallationTokenCache } from "../services/github-app-auth.js";
import {
  enqueueGithubCommitStatusDelivery,
  pollGitHubCommitStatusDeliveriesOnce,
  resetStaleGitHubCommitStatusDeliveries,
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
  }) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) return jsonResponse(options.latestStatuses ?? []);
      if (u.includes("/pulls/") && u.includes("/reviews")) {
        if (options.reviewsStatus && options.reviewsStatus >= 400) {
          return jsonResponse(
            options.reviewsBody ?? [],
            false,
            options.reviewsStatus,
            options.reviewsHeaders,
          );
        }
        return jsonResponse(options.reviews ?? []);
      }
      if (u.includes("/issues/") && u.includes("/comments")) return jsonResponse(options.comments ?? []);
      if (/\/statuses\/[0-9a-f]{7,40}(?:\?|$)/i.test(u)) {
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
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/access_tokens")) return jsonResponse({ token: "ghs_test", expires_at: FUTURE_ISO });
      if (/\/commits\/[^/]+\/statuses(?:\?|$)/.test(u)) return jsonResponse([]);
      if (u.includes("/pulls/") && u.includes("/reviews")) return jsonResponse([]);
      if (u.includes("/issues/") && u.includes("/comments")) {
        const staleProcessingAt = new Date(Date.now() - 11 * 60 * 1_000);
        await db
          .update(githubCommitStatusDeliveries)
          .set({ updatedAt: staleProcessingAt })
          .where(eq(githubCommitStatusDeliveries.id, delivery.id));
        await expect(resetStaleGitHubCommitStatusDeliveries(db, new Date())).resolves.toBe(1);
        reclaimed = true;
        return jsonResponse([]);
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

  it("skips the failure write when reviewer evidence now exists on GitHub", async () => {
    setCreds();
    const { delivery } = await seedRun();
    const fetchMock = stubGithub({
      latestStatuses: [],
      reviews: [{ user: { login: "allyblockcast[bot]" }, commit_id: HEAD_SHA }],
    });

    await pollGitHubCommitStatusDeliveriesOnce(db);

    expect(await readDelivery(delivery.id)).toMatchObject({ status: "skipped" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(`/statuses/${HEAD_SHA}`))).toBe(false);
  });

  it("re-checks commit status after reviewer evidence before posting failure", async () => {
    setCreds();
    const { delivery } = await seedRun();
    let statusReads = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
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
      if (u.includes("/pulls/") && u.includes("/reviews")) return jsonResponse([]);
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
      lastError: "reviewer_evidence_reviews_rate_limited",
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
});

import { generateKeyPairSync } from "node:crypto";

import {
  applyPendingMigrations,
  createDb,
  githubReviewGateDeliveries,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const h = vi.hoisted(() => ({
  cfg: {
    githubAppId: "3966421",
    githubAppInstallationId: "138085375",
    githubAppPrivateKey: "",
  } as Record<string, string>,
}));

vi.mock("../config.js", () => ({ loadConfig: () => h.cfg }));

import { _resetInstallationTokenCache } from "../services/github-app-auth.js";
import {
  enqueueGithubReviewGateDelivery,
  pollGithubReviewGateDeliveriesOnce,
  resetStaleGithubReviewGateDeliveries,
  startGithubReviewGateDeliveryWorker,
  type GithubReviewGateAuthorityConfig,
} from "../services/github-review-gate-authority.js";

const externalDatabaseUrl = process.env.PAPERCLIP_REVIEW_GATE_TEST_DATABASE_URL?.trim() || null;
const embeddedPostgresSupport = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review-gate delivery tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const FUTURE_ISO = "2999-01-01T00:00:00Z";
const REPO = "Blockcast/penstock-llm-proxy-core";
const PR_NUMBER = 1085;
const LIVE_HEAD = "1111111111111111111111111111111111111111";
const EVENT_HEAD = "2222222222222222222222222222222222222222";
const REVIEW_HEAD = "3333333333333333333333333333333333333333";
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;

const authorityConfig: GithubReviewGateAuthorityConfig = {
  repositories: [REPO],
  statusContext: "review/ally-complete",
  expectedAppId: "3966421",
  expectedInstallationId: "138085375",
  reviewerBotLogin: "allyblockcast[bot]",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function pullRequestPayload(options: {
  action?: string;
  headSha?: string;
  baseRef?: string;
  previousBaseRef?: string;
  before?: string;
} = {}): Record<string, unknown> {
  return {
    action: options.action ?? "synchronize",
    repository: { full_name: REPO },
    number: PR_NUMBER,
    pull_request: {
      number: PR_NUMBER,
      head: { sha: options.headSha ?? LIVE_HEAD },
      base: { ref: options.baseRef ?? "main" },
      html_url: PR_URL,
    },
    ...(options.before ? { before: options.before } : {}),
    ...(options.previousBaseRef
      ? { changes: { base: { ref: { from: options.previousBaseRef } } } }
      : {}),
  };
}

function issueCommentPayload(action: "created" | "edited" | "deleted" = "deleted") {
  return {
    action,
    repository: { full_name: REPO },
    issue: {
      number: PR_NUMBER,
      html_url: PR_URL,
      pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}` },
    },
    comment: {
      body: `## Ally - Consolidated PR Review\n\n_reviewed head: ${REVIEW_HEAD}_`,
      user: { login: "allyblockcast[bot]" },
    },
  };
}

function setValidCredentials() {
  h.cfg.githubAppId = "3966421";
  h.cfg.githubAppInstallationId = "138085375";
  h.cfg.githubAppPrivateKey = PRIVATE_KEY_PEM;
}

function installGithubStub(options: {
  pullStatus?: number;
  liveBaseRef?: string;
  liveHeadSha?: string;
  failStatusSha?: string;
  dispatchStatus?: number;
  tokenStatus?: number;
} = {}) {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/access_tokens")) {
      return response(
        options.tokenStatus && options.tokenStatus >= 400
          ? { message: "token unavailable" }
          : { token: "ghs_review_gate", expires_at: FUTURE_ISO },
        options.tokenStatus ?? 201,
      );
    }
    if (target.endsWith(`/repos/${REPO}/pulls/${PR_NUMBER}`)) {
      return response(
        options.pullStatus && options.pullStatus >= 400
          ? { message: "pull unavailable" }
          : {
              base: { ref: options.liveBaseRef ?? "main" },
              head: { sha: options.liveHeadSha ?? LIVE_HEAD },
              html_url: PR_URL,
            },
        options.pullStatus ?? 200,
      );
    }
    const statusMatch = target.match(/\/statuses\/([0-9a-f]{40})$/i);
    if (statusMatch) {
      return response(
        { id: 1 },
        statusMatch[1] === options.failStatusSha ? 503 : 201,
      );
    }
    if (target.endsWith(`/repos/${REPO}/dispatches`)) {
      return response(null, options.dispatchStatus ?? 204);
    }
    throw new Error(`unexpected GitHub request ${target} ${init?.method ?? "GET"}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describeEmbeddedPostgres("GitHub review-gate durable authority", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
      return;
    }
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-gate-authority-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    _resetInstallationTokenCache();
    setValidCredentials();
    vi.unstubAllGlobals();
    await db.delete(githubReviewGateDeliveries);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function enqueue(options: {
    deliveryId?: string;
    eventName?: string;
    payload?: Record<string, unknown>;
    rawBody?: Buffer;
  } = {}) {
    const payload = options.payload ?? pullRequestPayload({ before: EVENT_HEAD });
    return enqueueGithubReviewGateDelivery({
      db,
      eventName: options.eventName ?? "pull_request",
      deliveryId: options.deliveryId ?? "delivery-1",
      rawBody: options.rawBody ?? Buffer.from(JSON.stringify(payload), "utf8"),
      payload,
      config: authorityConfig,
    });
  }

  async function readDelivery(deliveryId = "delivery-1") {
    return db
      .select()
      .from(githubReviewGateDeliveries)
      .where(eq(githubReviewGateDeliveries.deliveryId, deliveryId))
      .then((rows) => rows[0] ?? null);
  }

  async function makeDue(deliveryId = "delivery-1") {
    await db
      .update(githubReviewGateDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(githubReviewGateDeliveries.deliveryId, deliveryId));
  }

  it("persists a relevant delivery without making any GitHub call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(enqueue()).resolves.toMatchObject({ matched: true, queued: true, duplicate: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readDelivery()).toMatchObject({
      status: "queued",
      expectedAppId: "3966421",
      expectedInstallationId: "138085375",
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("deduplicates an identical delivery and rejects a conflicting duplicate", async () => {
    const first = await enqueue();
    const duplicate = await enqueue();
    const conflict = await enqueue({
      payload: pullRequestPayload({ action: "closed", headSha: EVENT_HEAD }),
    });

    expect(first).toMatchObject({ matched: true, queued: true, duplicate: false });
    expect(duplicate).toMatchObject({ matched: true, queued: true, duplicate: true });
    expect(conflict).toMatchObject({
      matched: true,
      queued: false,
      reason: "delivery_id_payload_conflict",
    });
    expect(await db.select().from(githubReviewGateDeliveries)).toHaveLength(1);
  });

  it("survives token mint failure and completes after a worker restart", async () => {
    await enqueue();
    installGithubStub({ tokenStatus: 503 });

    await expect(pollGithubReviewGateDeliveriesOnce(db)).resolves.toBe(1);
    expect(await readDelivery()).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "github_app_token_http_503",
    });

    _resetInstallationTokenCache();
    await makeDue();
    installGithubStub();
    await expect(pollGithubReviewGateDeliveriesOnce(db)).resolves.toBe(1);
    expect(await readDelivery()).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("survives a live PR fetch failure and completes after a worker restart", async () => {
    await enqueue();
    installGithubStub({ pullStatus: 503 });

    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "review_gate_pull_http_503",
    });

    await makeDue();
    installGithubStub();
    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });
  });

  it("retries every invalidation head after a partial status-write failure", async () => {
    await enqueue();
    const firstFetch = installGithubStub({ failStatusSha: EVENT_HEAD });

    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({
      status: "queued",
      lastError: "review_gate_status_http_503",
    });
    expect(firstFetch.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${LIVE_HEAD}`))).toBe(true);
    expect(firstFetch.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${EVENT_HEAD}`))).toBe(true);
    expect(firstFetch.mock.calls.some(([url]) => String(url).endsWith("/dispatches"))).toBe(true);

    await makeDue();
    const secondFetch = installGithubStub();
    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });
    expect(secondFetch.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${LIVE_HEAD}`))).toBe(true);
    expect(secondFetch.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${EVENT_HEAD}`))).toBe(true);
  });

  it("retries a failed repository dispatch after all pending writes succeeded", async () => {
    await enqueue();
    installGithubStub({ dispatchStatus: 503 });

    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({
      status: "queued",
      lastError: "review_gate_dispatch_http_503",
    });

    await makeDue();
    installGithubStub();
    await pollGithubReviewGateDeliveriesOnce(db);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });
  });

  it("keeps an App or installation identity mismatch queued without external calls", async () => {
    await enqueue();
    h.cfg.githubAppId = "9999999";
    const fetchMock = installGithubStub();

    await pollGithubReviewGateDeliveriesOnce(db);

    expect(await readDelivery()).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "review_gate_identity_mismatch",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes an edited carrier after it moves away from main", async () => {
    await enqueue({
      payload: pullRequestPayload({
        action: "edited",
        headSha: EVENT_HEAD,
        baseRef: "release",
        previousBaseRef: "main",
      }),
    });
    const fetchMock = installGithubStub({ liveBaseRef: "release", liveHeadSha: LIVE_HEAD });

    await pollGithubReviewGateDeliveriesOnce(db);

    expect(await readDelivery()).toMatchObject({ status: "delivered" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${LIVE_HEAD}`))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${EVENT_HEAD}`))).toBe(true);
  });

  it.each([
    {
      name: "issue_comment.deleted",
      eventName: "issue_comment",
      payload: issueCommentPayload("deleted"),
      expectedHead: REVIEW_HEAD,
    },
    {
      name: "pull_request.converted_to_draft",
      eventName: "pull_request",
      payload: pullRequestPayload({ action: "converted_to_draft", headSha: EVENT_HEAD }),
      expectedHead: EVENT_HEAD,
    },
  ])("durably processes $name", async ({ eventName, payload, expectedHead }) => {
    await enqueue({ eventName, payload });
    const fetchMock = installGithubStub();

    await pollGithubReviewGateDeliveriesOnce(db);

    expect(await readDelivery()).toMatchObject({ status: "delivered" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/statuses/${expectedHead}`))).toBe(true);
  });

  it("passes bounded AbortSignals to token, PR, status, and dispatch requests", async () => {
    await enqueue();
    const fetchMock = installGithubStub();

    await pollGithubReviewGateDeliveriesOnce(db);

    const relevantCalls = fetchMock.mock.calls.filter(([url]) => {
      const target = String(url);
      return target.includes("/access_tokens")
        || target.endsWith(`/pulls/${PR_NUMBER}`)
        || target.includes("/statuses/")
        || target.endsWith("/dispatches");
    });
    expect(relevantCalls.length).toBeGreaterThanOrEqual(5);
    for (const [, init] of relevantCalls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const dispatchCall = relevantCalls.find(([url]) => String(url).endsWith("/dispatches"));
    expect(JSON.parse(String(dispatchCall?.[1]?.body))).toMatchObject({
      event_type: "review_gate_reconcile",
      client_payload: {
        producer_app_id: "3966421",
        producer_installation_id: "138085375",
        retry_count: "0",
        target_pull_number: String(PR_NUMBER),
        target_head_sha: LIVE_HEAD,
      },
    });
  });

  it("requeues a stale processing claim", async () => {
    await enqueue();
    const staleAt = new Date(Date.now() - 61_000);
    await db
      .update(githubReviewGateDeliveries)
      .set({ status: "processing", updatedAt: staleAt, nextAttemptAt: staleAt })
      .where(eq(githubReviewGateDeliveries.deliveryId, "delivery-1"));

    await expect(resetStaleGithubReviewGateDeliveries(db)).resolves.toBe(1);
    expect(await readDelivery()).toMatchObject({ status: "queued" });
  });

  it("fences an old claimant after stale reset and a successful reclaim", async () => {
    await enqueue();
    let releaseFirstPull!: () => void;
    const firstPullBlocked = new Promise<void>((resolve) => {
      releaseFirstPull = resolve;
    });
    let markFirstPullStarted!: () => void;
    const firstPullStarted = new Promise<void>((resolve) => {
      markFirstPullStarted = resolve;
    });
    let pullCalls = 0;
    const fetchMock = installGithubStub();
    fetchMock.mockImplementation(async (url: string | URL) => {
      const target = String(url);
      if (target.includes("/access_tokens")) {
        return response({ token: "ghs_review_gate", expires_at: FUTURE_ISO }, 201);
      }
      if (target.endsWith(`/repos/${REPO}/pulls/${PR_NUMBER}`)) {
        pullCalls += 1;
        if (pullCalls === 1) {
          markFirstPullStarted();
          await firstPullBlocked;
        }
        return response({
          base: { ref: "main" },
          head: { sha: LIVE_HEAD },
          html_url: PR_URL,
        });
      }
      if (target.match(/\/statuses\/[0-9a-f]{40}$/i)) return response({ id: 1 }, 201);
      if (target.endsWith(`/repos/${REPO}/dispatches`)) return response(null, 204);
      throw new Error(`unexpected GitHub request ${target}`);
    });

    const oldClaim = pollGithubReviewGateDeliveriesOnce(db);
    await firstPullStarted;
    await resetStaleGithubReviewGateDeliveries(db, new Date(Date.now() + 61_000));
    await db
      .update(githubReviewGateDeliveries)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(githubReviewGateDeliveries.deliveryId, "delivery-1"));
    await expect(pollGithubReviewGateDeliveriesOnce(db)).resolves.toBe(1);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });

    releaseFirstPull();
    await oldClaim;

    expect(await readDelivery()).toMatchObject({ status: "delivered", attempts: 0 });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/repos/${REPO}/dispatches`))).toHaveLength(1);
  });

  it("requeues a delivery when a bounded GitHub request is aborted", async () => {
    await enqueue();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return response({}, 500);
    }));

    await expect(pollGithubReviewGateDeliveriesOnce(db)).resolves.toBe(1);

    expect(await readDelivery()).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "github_app_token_fetch_failed",
    });
  });

  it("allows only one concurrent poller to process a delivery", async () => {
    await enqueue({ payload: pullRequestPayload({ action: "closed" }) });
    const fetchMock = installGithubStub();

    const results = await Promise.all([
      pollGithubReviewGateDeliveriesOnce(db),
      pollGithubReviewGateDeliveriesOnce(db),
    ]);

    expect(results.sort()).toEqual([0, 1]);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/dispatches"))).toHaveLength(1);
  });

  it("finishes an active durable delivery before worker shutdown returns", async () => {
    await enqueue();
    let releasePullRequest!: () => void;
    const pullRequestBlocked = new Promise<void>((resolve) => {
      releasePullRequest = resolve;
    });
    let markPullRequestStarted!: () => void;
    const pullRequestStarted = new Promise<void>((resolve) => {
      markPullRequestStarted = resolve;
    });
    const fetchMock = installGithubStub();
    fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith(`/repos/${REPO}/pulls/${PR_NUMBER}`)) {
        markPullRequestStarted();
        await pullRequestBlocked;
        return response({
          base: { ref: "main" },
          head: { sha: LIVE_HEAD },
          html_url: PR_URL,
        });
      }
      if (target.includes("/access_tokens")) {
        return response({ token: "ghs_review_gate", expires_at: FUTURE_ISO }, 201);
      }
      if (target.match(/\/statuses\/[0-9a-f]{40}$/i)) return response({ id: 1 }, 201);
      if (target.endsWith(`/repos/${REPO}/dispatches`)) return response(null, 204);
      throw new Error(`unexpected GitHub request ${target} ${init?.method ?? "GET"}`);
    });

    const stopWorker = startGithubReviewGateDeliveryWorker(db);
    await pullRequestStarted;
    let stopped = false;
    const stopPromise = stopWorker().then(() => {
      stopped = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    expect(await readDelivery()).toMatchObject({ status: "processing" });

    releasePullRequest();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(await readDelivery()).toMatchObject({ status: "delivered" });
  });
});

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

import { _resetInstallationTokenCache, githubPostCommitStatusDetailed } from "../services/github-app-auth.js";
import {
  _classifyReviewerEvidenceError,
  enqueueGithubCommitStatusDelivery,
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

  for (const error of ["reviews_http_403", "reviews_http_404", "reviews_http_401"]) {
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
      if (u.includes("/pulls/") && u.includes("/reviews")) {
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
      if (u.includes("/pulls/") && u.includes("/reviews")) return jsonResponse([]);
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
      lastError: "reviewer_evidence_reviews_rate_limited",
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
});

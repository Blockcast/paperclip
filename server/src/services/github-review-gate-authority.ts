import { createHash } from "node:crypto";

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { githubReviewGateDeliveries, type Db } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";
import { getInstallationTokenResult } from "./github-app-auth.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

const GITHUB_HOST = "github.com";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const ID_PATTERN = /^\d+$/;
const POLL_INTERVAL_MS = 5_000;
const CLAIM_BATCH = 4;
const STALE_PROCESSING_MS = 60_000;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const PR_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "review_requested",
  "review_request_removed",
  "edited",
  "labeled",
  "unlabeled",
  "closed",
]);
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);
const OVERRIDE_PATTERN = /(?:^|\n)[ \t]*review-gate-override:[ \t]*([0-9a-f]{40})[ \t]*(?=\n|$)/gi;
const REVIEWED_HEAD_PATTERN = /(?:^|\n)[ \t]*_?reviewed head:[ \t]*([0-9a-f]{40})_?[ \t]*(?=\n|$)/gi;

type DeliveryRow = typeof githubReviewGateDeliveries.$inferSelect;

export interface GithubReviewGateAuthorityConfig {
  /** False during the capture-only rollout, before this producer owns authority effects. */
  authorityEnabled: boolean;
  repositories: readonly string[];
  statusContext: string;
  expectedAppId: string;
  expectedInstallationId: string;
  reviewerBotLogin?: string | null;
  baseRef?: string;
  dispatchEventType?: string;
}

export type GithubReviewGateEnqueueResult =
  | { matched: false; reason: string }
  | {
      matched: true;
      queued: true;
      duplicate: boolean;
      requiresRevocation: boolean;
      deliveryDbId: string;
      repoFullName: string;
      prNumber: number;
    }
  | {
      matched: true;
      queued: false;
      reason: string;
      repoFullName: string;
      prNumber: number;
    };

interface Candidate {
  repoFullName: string;
  prNumber: number;
  action: string;
  eventBaseRef: string | null;
  eventHeadShas: string[];
  recoveryHeadSha: string | null;
  previousBaseRef: string | null;
  targetUrl: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function fullSha(value: unknown): string | null {
  const candidate = stringField(value);
  return candidate && SHA_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function normalizeLogin(value: unknown): string {
  return (stringField(value) ?? "")
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

function matchingHeadShas(pattern: RegExp, ...bodies: string[]): string[] {
  return [...new Set(
    bodies.flatMap((body) => [...body.matchAll(pattern)].map((match) => match[1]!.toLowerCase())),
  )];
}

function commentSignals(
  payload: Record<string, unknown>,
  reviewerBotLogin: string | null | undefined,
): { affectsGate: boolean; headShas: string[] } {
  const comment = record(payload.comment);
  const body = stringField(comment?.body) ?? "";
  const previousBody = stringField(record(record(payload.changes)?.body)?.from) ?? "";
  const author = normalizeLogin(record(comment?.user)?.login);
  const reviewer = normalizeLogin(reviewerBotLogin ?? "allyblockcast[bot]");
  const overrideShas = matchingHeadShas(OVERRIDE_PATTERN, body, previousBody);
  const reviewerShas = author === reviewer
    ? matchingHeadShas(REVIEWED_HEAD_PATTERN, body, previousBody)
    : [];
  return {
    affectsGate: author === reviewer || overrideShas.length > 0,
    headShas: [...new Set([...overrideShas, ...reviewerShas])],
  };
}

function resolveCandidate(
  eventName: string,
  payload: Record<string, unknown>,
  reviewerBotLogin: string | null | undefined,
): Candidate | null {
  const repository = record(payload.repository);
  const repoFullName = stringField(repository?.full_name);
  const action = stringField(payload.action) ?? "";
  if (!repoFullName || !action) return null;

  if (eventName === "pull_request") {
    if (!PR_ACTIONS.has(action)) return null;
    const pullRequest = record(payload.pull_request);
    const head = record(pullRequest?.head);
    const base = record(pullRequest?.base);
    const baseRefChange = record(record(record(payload.changes)?.base)?.ref);
    const prNumber = numberField(pullRequest?.number) ?? numberField(payload.number);
    if (!prNumber) return null;
    return {
      repoFullName,
      prNumber,
      action,
      eventBaseRef: stringField(base?.ref),
      eventHeadShas: [fullSha(head?.sha)].filter((sha): sha is string => Boolean(sha)),
      recoveryHeadSha: action === "synchronize" ? fullSha(payload.before) : null,
      previousBaseRef: stringField(baseRefChange?.from),
      targetUrl: stringField(pullRequest?.html_url),
    };
  }

  if (eventName === "pull_request_review") {
    if (!REVIEW_ACTIONS.has(action)) return null;
    const pullRequest = record(payload.pull_request);
    const head = record(pullRequest?.head);
    const base = record(pullRequest?.base);
    const review = record(payload.review);
    const prNumber = numberField(pullRequest?.number) ?? numberField(payload.number);
    if (!prNumber) return null;
    return {
      repoFullName,
      prNumber,
      action,
      eventBaseRef: stringField(base?.ref),
      eventHeadShas: [fullSha(head?.sha), fullSha(review?.commit_id)]
        .filter((sha): sha is string => Boolean(sha)),
      recoveryHeadSha: null,
      previousBaseRef: null,
      targetUrl: stringField(pullRequest?.html_url),
    };
  }

  if (eventName === "issue_comment") {
    if (!COMMENT_ACTIONS.has(action)) return null;
    const signals = commentSignals(payload, reviewerBotLogin);
    if (!signals.affectsGate) return null;
    const issue = record(payload.issue);
    if (!record(issue?.pull_request)) return null;
    const prNumber = numberField(issue?.number);
    if (!prNumber) return null;
    return {
      repoFullName,
      prNumber,
      action,
      eventBaseRef: null,
      eventHeadShas: signals.headShas,
      recoveryHeadSha: null,
      previousBaseRef: null,
      targetUrl: stringField(issue?.html_url),
    };
  }

  return null;
}

function digestPayload(eventName: string, rawBody: Buffer | null | undefined, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(eventName)
    .update("\0")
    .update(rawBody ?? Buffer.from(JSON.stringify(payload), "utf8"))
    .digest("hex");
}

function originRequestId(deliveryId: string): string {
  const prefix = createHash("sha256").update(deliveryId).digest("hex").slice(0, 13);
  return BigInt(`0x${prefix}`).toString(10);
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
}

function nextAttemptAt(attempt: number, now: Date): Date {
  const index = Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1);
  return new Date(now.getTime() + RETRY_DELAYS_MS[index]!);
}

function deliveryClaimWhere(row: DeliveryRow) {
  return and(
    eq(githubReviewGateDeliveries.id, row.id),
    eq(githubReviewGateDeliveries.status, "processing"),
    eq(githubReviewGateDeliveries.updatedAt, row.updatedAt),
  );
}

async function refreshDeliveryClaim(db: Db, row: DeliveryRow): Promise<DeliveryRow | null> {
  const [updated] = await db
    .update(githubReviewGateDeliveries)
    .set({ updatedAt: new Date() })
    .where(deliveryClaimWhere(row))
    .returning();
  return updated ?? null;
}

async function retryDelivery(
  db: Db,
  row: DeliveryRow,
  reason: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const attempts = row.attempts + 1;
  const retryAt = nextAttemptAt(attempts, now);
  const [updated] = await db
    .update(githubReviewGateDeliveries)
    .set({
      status: "queued",
      attempts,
      nextAttemptAt: retryAt,
      lastError: reason,
      lastResult: result,
      updatedAt: now,
    })
    .where(deliveryClaimWhere(row))
    .returning({ id: githubReviewGateDeliveries.id });
  if (!updated) return;
  logger.warn(
    { deliveryId: row.deliveryId, attempts, nextAttemptAt: retryAt, reason },
    "github-review-gate-authority: durable delivery will retry",
  );
}

async function markDelivered(
  db: Db,
  row: DeliveryRow,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubReviewGateDeliveries)
    .set({
      status: "delivered",
      deliveredAt: now,
      lastError: null,
      lastResult: result,
      updatedAt: now,
    })
    .where(deliveryClaimWhere(row));
}

async function fetchPullRequest(token: string, row: DeliveryRow, candidate: Candidate): Promise<
  | { ok: true; baseRef: string; headSha: string; targetUrl: string | null }
  | { ok: false; reason: string }
> {
  try {
    const response = await ghFetch(
      `${gitHubApiBase(GITHUB_HOST)}/repos/${row.repoFullName}/pulls/${candidate.prNumber}`,
      {
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
        signal: requestSignal(),
      },
    );
    if (!response.ok) return { ok: false, reason: `review_gate_pull_http_${response.status}` };
    const body = record(await response.json().catch(() => null));
    const baseRef = stringField(record(body?.base)?.ref);
    const headSha = fullSha(record(body?.head)?.sha);
    if (!baseRef || !headSha) return { ok: false, reason: "review_gate_pull_payload_invalid" };
    return { ok: true, baseRef, headSha, targetUrl: stringField(body?.html_url) };
  } catch {
    return { ok: false, reason: "review_gate_pull_fetch_failed" };
  }
}

async function postPendingStatus(input: {
  token: string;
  row: DeliveryRow;
  sha: string;
  targetUrl: string | null;
  origin: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await ghFetch(
      `${gitHubApiBase(GITHUB_HOST)}/repos/${input.row.repoFullName}/statuses/${input.sha}`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          state: "pending",
          context: input.row.statusContext,
          description: `Evaluating Ally review gate after signed webhook ${input.origin}.`.slice(0, 140),
          ...(input.targetUrl ? { target_url: input.targetUrl } : {}),
        }),
        signal: requestSignal(),
      },
    );
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `review_gate_status_http_${response.status}` };
  } catch {
    return { ok: false, reason: "review_gate_status_fetch_failed" };
  }
}

async function createRepositoryDispatch(input: {
  token: string;
  row: DeliveryRow;
  candidate: Candidate;
  liveHeadSha: string;
  origin: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await ghFetch(
      `${gitHubApiBase(GITHUB_HOST)}/repos/${input.row.repoFullName}/dispatches`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          event_type: input.row.dispatchEventType,
          client_payload: {
            producer_app_id: input.row.expectedAppId,
            producer_installation_id: input.row.expectedInstallationId,
            producer_delivery_id: input.row.deliveryId,
            retry_count: "0",
            target_pull_number: String(input.candidate.prNumber),
            target_head_sha: input.liveHeadSha,
          },
        }),
        signal: requestSignal(),
      },
    );
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `review_gate_dispatch_http_${response.status}` };
  } catch {
    return { ok: false, reason: "review_gate_dispatch_fetch_failed" };
  }
}

function affectsProtectedBase(candidate: Candidate, liveBaseRef: string, protectedBaseRef: string): boolean {
  return liveBaseRef === protectedBaseRef
    || candidate.eventBaseRef === protectedBaseRef
    || candidate.previousBaseRef === protectedBaseRef;
}

type PendingRevocationResult =
  | { ok: false; reason: string; result: Record<string, unknown> }
  | { ok: true; affectsProtectedBase: false; result: Record<string, unknown> }
  | {
      ok: true;
      affectsProtectedBase: true;
      token: string;
      candidate: Candidate;
      liveHeadSha: string;
      headShas: string[];
      origin: string;
      result: Record<string, unknown>;
    };

async function postPendingStatusesForDelivery(row: DeliveryRow): Promise<PendingRevocationResult> {
  const runtime = loadConfig();
  const actualAppId = runtime.githubAppId.trim();
  const actualInstallationId = runtime.githubAppInstallationId.trim();
  if (actualAppId !== row.expectedAppId || actualInstallationId !== row.expectedInstallationId) {
    return {
      ok: false,
      reason: "review_gate_identity_mismatch",
      result: {
        expectedAppId: row.expectedAppId,
        expectedInstallationId: row.expectedInstallationId,
        actualAppId,
        actualInstallationId,
      },
    };
  }

  const candidate = resolveCandidate(row.eventName, row.payload, row.reviewerBotLogin);
  if (!candidate || candidate.repoFullName.toLowerCase() !== row.repoFullName.toLowerCase()) {
    return { ok: false, reason: "review_gate_persisted_payload_invalid", result: {} };
  }

  const token = await getInstallationTokenResult(Date.now(), { signal: requestSignal() });
  if (!token.ok) return { ok: false, reason: token.reason, result: token };

  const pullRequest = await fetchPullRequest(token.token, row, candidate);
  if (!pullRequest.ok) {
    return { ok: false, reason: pullRequest.reason, result: pullRequest };
  }

  if (!affectsProtectedBase(candidate, pullRequest.baseRef, row.baseRef)) {
    return {
      ok: true,
      affectsProtectedBase: false,
      result: { reason: "pull_request_base_not_protected", liveBaseRef: pullRequest.baseRef },
    };
  }

  const headShas = [...new Set([
    pullRequest.headSha,
    ...candidate.eventHeadShas,
    candidate.recoveryHeadSha,
  ].filter((sha): sha is string => Boolean(sha)))];
  const origin = originRequestId(row.deliveryId);
  const targetUrl = candidate.targetUrl ?? pullRequest.targetUrl;
  const statusResults = await Promise.all(
    headShas.map(async (sha) => ({
      sha,
      result: await postPendingStatus({ token: token.token, row, sha, targetUrl, origin }),
    })),
  );
  const statusFailures = statusResults.filter((entry) => !entry.result.ok);
  if (statusFailures.length > 0) {
    const failure = statusFailures[0]!;
    return {
      ok: false,
      reason: failure.result.ok ? "review_gate_status_incomplete" : failure.result.reason,
      result: { headShas, statusFailures },
    };
  }

  return {
    ok: true,
    affectsProtectedBase: true,
    token: token.token,
    candidate,
    liveHeadSha: pullRequest.headSha,
    headShas,
    origin,
    result: { headShas, originRequestId: origin },
  };
}

async function processDelivery(db: Db, row: DeliveryRow): Promise<void> {
  let fencedRow = await refreshDeliveryClaim(db, row);
  if (!fencedRow) return;
  const pending = await postPendingStatusesForDelivery(fencedRow);

  const refreshed = await refreshDeliveryClaim(db, fencedRow);
  if (!refreshed) return;
  fencedRow = refreshed;

  if (!pending.ok) {
    await retryDelivery(db, fencedRow, pending.reason, pending.result);
    return;
  }
  if (!pending.affectsProtectedBase) {
    await markDelivered(db, fencedRow, pending.result);
    return;
  }

  const dispatch = await createRepositoryDispatch({
    token: pending.token,
    row: fencedRow,
    candidate: pending.candidate,
    liveHeadSha: pending.liveHeadSha,
    origin: pending.origin,
  });

  if (!dispatch.ok) {
    await retryDelivery(db, fencedRow, dispatch.reason, {
      headShas: pending.headShas,
      dispatch,
    });
    return;
  }

  await markDelivered(db, fencedRow, { ...pending.result, dispatch });
}

export async function enqueueGithubReviewGateDelivery(input: {
  db: Db;
  eventName: string;
  deliveryId?: string | null;
  rawBody?: Buffer | null;
  payload: Record<string, unknown>;
  config: GithubReviewGateAuthorityConfig;
}): Promise<GithubReviewGateEnqueueResult> {
  const candidate = resolveCandidate(input.eventName, input.payload, input.config.reviewerBotLogin);
  if (!candidate) return { matched: false, reason: "event_not_gate_relevant" };

  const allowedRepositories = new Set(input.config.repositories.map((repo) => repo.toLowerCase()));
  if (!allowedRepositories.has(candidate.repoFullName.toLowerCase())) {
    return { matched: false, reason: "repository_not_configured" };
  }

  const deliveryId = input.deliveryId?.trim() ?? "";
  const statusContext = input.config.statusContext.trim();
  const expectedAppId = input.config.expectedAppId.trim();
  const expectedInstallationId = input.config.expectedInstallationId.trim();
  const invalidReason = !deliveryId
    ? "delivery_id_missing"
    : !statusContext
      ? "status_context_not_configured"
      : !ID_PATTERN.test(expectedAppId)
        ? "expected_app_id_not_configured"
        : !ID_PATTERN.test(expectedInstallationId)
          ? "expected_installation_id_not_configured"
          : null;
  if (invalidReason) {
    return {
      matched: true,
      queued: false,
      reason: invalidReason,
      repoFullName: candidate.repoFullName,
      prNumber: candidate.prNumber,
    };
  }

  const payloadDigest = digestPayload(input.eventName, input.rawBody, input.payload);
  const now = new Date();
  const enqueueResult = await input.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(githubReviewGateDeliveries)
      .values({
        deliveryId,
        repoFullName: candidate.repoFullName,
        eventName: input.eventName,
        payload: input.payload,
        payloadDigest,
        statusContext,
        reviewerBotLogin: input.config.reviewerBotLogin?.trim() || "allyblockcast[bot]",
        baseRef: input.config.baseRef?.trim() || "main",
        dispatchEventType: input.config.dispatchEventType?.trim() || "review_gate_reconcile",
        expectedAppId,
        expectedInstallationId,
        status: "capturing",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: githubReviewGateDeliveries.deliveryId })
      .returning();
    if (inserted) return { row: inserted, duplicate: false, conflict: false };

    const existing = await tx
      .select()
      .from(githubReviewGateDeliveries)
      .where(eq(githubReviewGateDeliveries.deliveryId, deliveryId))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw new Error("review-gate delivery conflict was not readable");
    const conflict = existing.payloadDigest !== payloadDigest
      || existing.eventName !== input.eventName
      || existing.repoFullName.toLowerCase() !== candidate.repoFullName.toLowerCase();
    return { row: existing, duplicate: true, conflict };
  });

  if (enqueueResult.conflict) {
    return {
      matched: true,
      queued: false,
      reason: "delivery_id_payload_conflict",
      repoFullName: candidate.repoFullName,
      prNumber: candidate.prNumber,
    };
  }

  return {
    matched: true,
    queued: true,
    duplicate: enqueueResult.duplicate,
    requiresRevocation: enqueueResult.row.status === "capturing",
    deliveryDbId: enqueueResult.row.id,
    repoFullName: candidate.repoFullName,
    prNumber: candidate.prNumber,
  };
}

export async function activateGithubReviewGateDelivery(
  db: Db,
  deliveryDbId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await db
    .select()
    .from(githubReviewGateDeliveries)
    .where(eq(githubReviewGateDeliveries.id, deliveryDbId))
    .then((rows) => rows[0] ?? null);
  if (!row) return { ok: false, reason: "review_gate_delivery_not_found" };
  if (row.status !== "capturing") return { ok: true };

  const pending = await postPendingStatusesForDelivery(row);
  if (!pending.ok) return { ok: false, reason: pending.reason };

  const now = new Date();
  await db
    .update(githubReviewGateDeliveries)
    .set({
      status: "queued",
      nextAttemptAt: now,
      lastError: null,
      lastResult: { synchronousRevocation: pending.result },
      updatedAt: now,
    })
    .where(
      and(
        eq(githubReviewGateDeliveries.id, row.id),
        eq(githubReviewGateDeliveries.status, "capturing"),
      ),
    );
  return { ok: true };
}

export async function resetStaleGithubReviewGateDeliveries(db: Db, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const rows = await db
    .update(githubReviewGateDeliveries)
    .set({ status: "queued", nextAttemptAt: now, updatedAt: now })
    .where(
      and(
        inArray(githubReviewGateDeliveries.status, ["capturing", "processing"]),
        lt(githubReviewGateDeliveries.updatedAt, staleBefore),
      ),
    )
    .returning({ id: githubReviewGateDeliveries.id });
  if (rows.length > 0) {
    logger.warn(
      { count: rows.length },
      "github-review-gate-authority: requeued stale processing deliveries",
    );
  }
  return rows.length;
}

async function claimDueGithubReviewGateDeliveries(db: Db, now: Date): Promise<DeliveryRow[]> {
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const claimed = await db.transaction(async (tx) => {
    const lockedRows = Array.from(await tx.execute(sql<{ id: string }>`
      select ${githubReviewGateDeliveries.id} as "id"
      from ${githubReviewGateDeliveries}
      where ${githubReviewGateDeliveries.status} = 'queued'
        and ${githubReviewGateDeliveries.nextAttemptAt} <= ${nowSql}
      order by ${githubReviewGateDeliveries.nextAttemptAt} asc, ${githubReviewGateDeliveries.createdAt} asc
      limit ${CLAIM_BATCH}
      for update skip locked
    `)) as Array<{ id: string }>;
    const ids = lockedRows.map((row) => row.id);
    if (ids.length === 0) return [];
    return tx
      .update(githubReviewGateDeliveries)
      .set({ status: "processing", updatedAt: now })
      .where(inArray(githubReviewGateDeliveries.id, ids))
      .returning();
  });
  return claimed.sort(
    (left, right) => left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime()
      || left.createdAt.getTime() - right.createdAt.getTime(),
  );
}

export async function pollGithubReviewGateDeliveriesOnce(db: Db): Promise<number> {
  const now = new Date();
  await resetStaleGithubReviewGateDeliveries(db, now);
  const claimed = await claimDueGithubReviewGateDeliveries(db, now);
  await Promise.all(
    claimed.map(async (row) => {
      try {
        await processDelivery(db, row);
      } catch (err) {
        logger.warn(
          { err, deliveryId: row.deliveryId },
          "github-review-gate-authority: delivery processing failed",
        );
        await retryDelivery(db, row, "review_gate_delivery_processing_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return claimed.length;
}

export function startGithubReviewGateDeliveryWorker(db: Db): () => Promise<void> {
  let stopped = false;
  let activeDrain: Promise<void> | null = null;

  const drain = async () => {
    try {
      while (!stopped && (await pollGithubReviewGateDeliveriesOnce(db)) === CLAIM_BATCH) {
        // Drain one bounded claim batch at a time.
      }
    } catch (err) {
      logger.warn({ err }, "github-review-gate-authority: poll tick failed");
    }
  };

  const triggerDrain = () => {
    if (stopped || activeDrain) return activeDrain;
    activeDrain = drain().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  };

  void triggerDrain();
  const pollTimer = setInterval(() => void triggerDrain(), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  logger.info("github-review-gate-authority worker started");

  return async () => {
    stopped = true;
    clearInterval(pollTimer);
    await activeDrain;
  };
}

import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  githubCommitStatusDeliveries,
  heartbeatRunEvents,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  githubAppCredentialsConfigured,
  githubGetLatestCommitStatusForContext,
  githubHasReviewerEvidenceForPr,
  githubPostCommitStatusDetailed,
  type GitHubCommitStatusState,
} from "./github-app-auth.js";

type DeliveryRow = typeof githubCommitStatusDeliveries.$inferSelect;
type DeliveryTerminalStatus = "delivered" | "skipped" | "failed" | "failed_permanent";

const POLL_INTERVAL_MS = 5_000;
const CLAIM_BATCH = 25;
const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 10 * 60 * 1_000;
const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

export type EnqueueGithubCommitStatusDeliveryInput = {
  companyId: string;
  sourceRunId: string;
  repoFullName: string;
  sha: string;
  context: string;
  state: GitHubCommitStatusState;
  description: string;
  targetUrl?: string | null;
  prNumber: number;
  prUrl?: string | null;
};

function isRetryableGithubHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function normalizeCommitStatusState(value: string): GitHubCommitStatusState {
  return value === "error" || value === "failure" || value === "pending" || value === "success"
    ? value
    : "failure";
}

function nextAttemptAt(attempt: number, now: Date): Date {
  const delayMs = RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]!;
  return new Date(now.getTime() + delayMs);
}

function classifyReviewerEvidenceError(error: string): { retryable: boolean; reason: string } {
  if (error === "no_bot_login") return { retryable: false, reason: "missing_pr_reviewer_bot_login" };
  if (error === "no_token") {
    return githubAppCredentialsConfigured()
      ? { retryable: true, reason: "github_app_token_unavailable" }
      : { retryable: false, reason: "missing_github_app_credentials" };
  }
  const status = Number(error.match(/_(\d{3})$/)?.[1]);
  if (Number.isInteger(status)) {
    return {
      retryable: isRetryableGithubHttpStatus(status),
      reason: `reviewer_evidence_${error}`,
    };
  }
  return { retryable: true, reason: `reviewer_evidence_${error}` };
}

async function appendDeliveryRunEvent(
  db: Db,
  row: DeliveryRow,
  level: "info" | "warn",
  message: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, row.sourceRunId))
    .then((rows) => rows[0] ?? null);
  if (!run) return;

  const [{ maxSeq = null } = {}] = await db
    .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, run.id));

  await db.insert(heartbeatRunEvents).values({
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    seq: (maxSeq ?? 0) + 1,
    eventType: "lifecycle",
    stream: "system",
    level,
    message,
    payload,
  });
}

async function markTerminal(
  db: Db,
  row: DeliveryRow,
  status: DeliveryTerminalStatus,
  level: "info" | "warn",
  message: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  await db
    .update(githubCommitStatusDeliveries)
    .set({
      status,
      updatedAt: now,
      deliveredAt: status === "delivered" || status === "skipped" ? now : null,
      lastError: status === "delivered" || status === "skipped" ? null : String(result.reason ?? status),
      lastErrorKind: status === "failed_permanent" ? "permanent" : status === "failed" ? "retry_exhausted" : null,
      lastResult: result,
    })
    .where(eq(githubCommitStatusDeliveries.id, row.id));

  await appendDeliveryRunEvent(db, row, level, message, {
    deliveryId: row.id,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    headSha: row.sha,
    statusContext: row.context,
    deliveryStatus: status,
    ...result,
  });
}

async function retryOrFailDelivery(
  db: Db,
  row: DeliveryRow,
  reason: string,
  result: Record<string, unknown>,
): Promise<void> {
  const attempts = row.attempts + 1;
  const now = new Date();
  const exhausted = attempts >= MAX_ATTEMPTS;
  await db
    .update(githubCommitStatusDeliveries)
    .set({
      status: exhausted ? "failed" : "queued",
      attempts,
      nextAttemptAt: exhausted ? row.nextAttemptAt : nextAttemptAt(attempts, now),
      lastError: reason,
      lastErrorKind: exhausted ? "retry_exhausted" : "transient",
      lastResult: result,
      updatedAt: now,
    })
    .where(eq(githubCommitStatusDeliveries.id, row.id));

  await appendDeliveryRunEvent(
    db,
    row,
    "warn",
    exhausted
      ? `GitHub PR-review gate status delivery exhausted retries for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)}`
      : `GitHub PR-review gate status delivery will retry for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)}`,
    {
      deliveryId: row.id,
      repoFullName: row.repoFullName,
      prNumber: row.prNumber,
      headSha: row.sha,
      statusContext: row.context,
      deliveryStatus: exhausted ? "failed" : "queued",
      attempts,
      maxAttempts: MAX_ATTEMPTS,
      nextAttemptAt: exhausted ? null : nextAttemptAt(attempts, now).toISOString(),
      reason,
      ...result,
    },
  );
}

async function failPermanentDelivery(
  db: Db,
  row: DeliveryRow,
  reason: string,
  result: Record<string, unknown>,
): Promise<void> {
  await markTerminal(
    db,
    row,
    "failed_permanent",
    "warn",
    `GitHub PR-review gate status delivery cannot proceed for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)}: ${reason}`,
    { reason, ...result },
  );
}

async function processDelivery(db: Db, row: DeliveryRow): Promise<void> {
  const latestStatus = await githubGetLatestCommitStatusForContext({
    repoFullName: row.repoFullName,
    sha: row.sha,
    context: row.context,
  });
  if (!latestStatus.ok) {
    if (latestStatus.retryable) {
      await retryOrFailDelivery(db, row, latestStatus.reason, latestStatus);
    } else {
      await failPermanentDelivery(db, row, latestStatus.reason, latestStatus);
    }
    return;
  }
  const latestCommitStatus = latestStatus.status;
  const statusCreatedAt = latestCommitStatus?.createdAt ? Date.parse(latestCommitStatus.createdAt) : NaN;
  const statusCreatedAfterQueue = Number.isFinite(statusCreatedAt) && statusCreatedAt > row.createdAt.getTime();
  if (latestCommitStatus?.state === "success" || statusCreatedAfterQueue) {
    await markTerminal(
      db,
      row,
      "skipped",
      "info",
      `Skipped PR-review gate status failure for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)} because a newer status already exists`,
      {
        reason: latestCommitStatus?.state === "success" ? "existing_success_status" : "newer_status_exists",
        latestStatus: latestCommitStatus,
      },
    );
    return;
  }

  const evidence = await githubHasReviewerEvidenceForPr({
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    headSha: row.sha,
  });
  if ("found" in evidence && evidence.found) {
    await markTerminal(
      db,
      row,
      "skipped",
      "info",
      `Skipped PR-review gate status failure for ${row.context} on ${row.repoFullName}#${row.prNumber}; reviewer evidence exists`,
      { reason: "reviewer_evidence_found", via: evidence.via },
    );
    return;
  }
  if ("error" in evidence) {
    const classified = classifyReviewerEvidenceError(evidence.error);
    if (classified.retryable) {
      await retryOrFailDelivery(db, row, classified.reason, { evidence });
    } else {
      await failPermanentDelivery(db, row, classified.reason, { evidence });
    }
    return;
  }

  const posted = await githubPostCommitStatusDetailed({
    repoFullName: row.repoFullName,
    sha: row.sha,
    context: row.context,
    state: normalizeCommitStatusState(row.state),
    description: row.description,
    targetUrl: row.targetUrl,
  });
  if (posted.ok) {
    await markTerminal(
      db,
      row,
      "delivered",
      "info",
      `Set PR-review gate status ${row.context} to ${row.state} on ${row.repoFullName}@${row.sha.slice(0, 7)} after retry exhaustion`,
      { posted },
    );
    return;
  }
  if (posted.retryable) {
    await retryOrFailDelivery(db, row, posted.reason, { posted });
    return;
  }
  await failPermanentDelivery(db, row, posted.reason, { posted });
}

export async function enqueueGithubCommitStatusDelivery(
  db: Db,
  input: EnqueueGithubCommitStatusDeliveryInput,
): Promise<DeliveryRow> {
  const now = new Date();
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const values = {
    companyId: input.companyId,
    sourceRunId: input.sourceRunId,
    repoFullName: input.repoFullName,
    sha: input.sha,
    context: input.context,
    state: input.state,
    description: input.description.slice(0, 140),
    targetUrl: input.targetUrl ?? null,
    prNumber: input.prNumber,
    prUrl: input.prUrl ?? null,
    status: "queued",
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    lastErrorKind: null,
    lastResult: null,
    updatedAt: now,
  } satisfies typeof githubCommitStatusDeliveries.$inferInsert;

  const [row] = await db
    .insert(githubCommitStatusDeliveries)
    .values(values)
    .onConflictDoUpdate({
      target: [
        githubCommitStatusDeliveries.repoFullName,
        githubCommitStatusDeliveries.sha,
        githubCommitStatusDeliveries.context,
      ],
      set: {
        companyId: input.companyId,
        sourceRunId: input.sourceRunId,
        prNumber: input.prNumber,
        prUrl: input.prUrl ?? null,
        description: input.description.slice(0, 140),
        targetUrl: input.targetUrl ?? null,
        status: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.status} else 'queued' end`,
        attempts: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.attempts} else 0 end`,
        nextAttemptAt: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.nextAttemptAt} else ${nowSql} end`,
        lastError: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.lastError} else null end`,
        lastErrorKind: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.lastErrorKind} else null end`,
        lastResult: sql`case when ${githubCommitStatusDeliveries.status} in ('delivered', 'skipped') then ${githubCommitStatusDeliveries.lastResult} else null end`,
        updatedAt: now,
      },
    })
    .returning();

  if (!row) throw new Error("failed to enqueue GitHub commit status delivery");
  return row;
}

export async function resetStaleGitHubCommitStatusDeliveries(db: Db): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const rows = await db
    .update(githubCommitStatusDeliveries)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(githubCommitStatusDeliveries.status, "processing"),
        lt(githubCommitStatusDeliveries.updatedAt, staleBefore),
      ),
    )
    .returning({ id: githubCommitStatusDeliveries.id });
  if (rows.length > 0) {
    logger.warn(
      { count: rows.length },
      "github-status-delivery-outbox: requeued stale processing rows on startup",
    );
  }
  return rows.length;
}

export async function pollGitHubCommitStatusDeliveriesOnce(db: Db): Promise<number> {
  const now = new Date();
  const claimed = await db
    .update(githubCommitStatusDeliveries)
    .set({ status: "processing", updatedAt: now })
    .where(
      inArray(
        githubCommitStatusDeliveries.id,
        db
          .select({ id: githubCommitStatusDeliveries.id })
          .from(githubCommitStatusDeliveries)
          .where(
            and(
              eq(githubCommitStatusDeliveries.status, "queued"),
              lte(githubCommitStatusDeliveries.nextAttemptAt, now),
            ),
          )
          .orderBy(asc(githubCommitStatusDeliveries.nextAttemptAt), asc(githubCommitStatusDeliveries.createdAt))
          .limit(CLAIM_BATCH),
      ),
    )
    .returning();

  for (const row of claimed) {
    try {
      await processDelivery(db, row);
    } catch (err) {
      logger.warn(
        { err, deliveryId: row.id },
        "github-status-delivery-outbox: processing failed; retrying",
      );
      await retryOrFailDelivery(db, row, "delivery_processing_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return claimed.length;
}

export function startGitHubCommitStatusDeliveryOutbox(db: Db): () => void {
  let polling = false;
  let stopped = false;

  void resetStaleGitHubCommitStatusDeliveries(db).catch((err) =>
    logger.warn({ err }, "github-status-delivery-outbox: stale-processing reset failed"),
  );

  const pollTimer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    void (async () => {
      try {
        while (!stopped && (await pollGitHubCommitStatusDeliveriesOnce(db)) === CLAIM_BATCH) {
          /* drain backlog */
        }
      } catch (err) {
        logger.warn({ err }, "github-status-delivery-outbox: poll tick failed");
      } finally {
        polling = false;
      }
    })();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  logger.info("github-status-delivery-outbox poller started");

  return () => {
    stopped = true;
    clearInterval(pollTimer);
  };
}

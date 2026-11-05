import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import {
  githubCommitStatusDeliveries,
  heartbeatRunEvents,
  heartbeatRuns,
  type Db,
  type DbTransaction,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  githubAppCredentialsConfigured,
  githubGetLatestCommitStatusForContext,
  githubHasReviewerEvidenceForPr,
  githubPostCommitStatusDetailed,
  scrubOutboundGitHubText,
  type GitHubCommitStatusState,
} from "./github-app-auth.js";
import { GITHUB_FETCH_DEADLINE_MS } from "./github-fetch.js";

type DeliveryRow = typeof githubCommitStatusDeliveries.$inferSelect;
// Either handle works for the delivery bookkeeping below. Code reached from
// inside withGithubStatusDeliveryLock must use the transaction handle so the
// critical section does not take a second pool connection.
type DbHandle = Db | DbTransaction;
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

// How long a holder may sit idle-in-transaction (i.e. inside its external
// GitHub calls) before Postgres terminates it and releases the lock. Far above
// the normal critical-section cost: it exists to make a wedged holder
// recoverable, not to bound healthy work. It is also the last moment, counted
// from taking the key, at which a holder may START a GitHub write.
const DELIVERY_LOCK_HOLD_TIMEOUT_MS = 120_000;

// How long a coalesced re-evaluation, or a forced replay that found the key
// held, waits for the holder to finish. Holds are typically seconds; a key
// still held when the row comes due just pushes it back again.
export const COALESCED_REEVALUATION_DELAY_MS = 15_000;

// The longest one GitHub write attempt can take on the client: an installation
// token mint and the POST, each bounded by ghFetch's deadline.
const WRITE_ATTEMPT_MAX_MS = 2 * GITHUB_FETCH_DEADLINE_MS;
const FENCE_MARGIN_MS = 10_000;
const FENCE_QUERY_TIMEOUT_MS = 10_000;
// Long enough that a write admitted at the last permitted moment still ends on
// the client before anyone else can take the key. ponytail: no heartbeat, so a
// dead holder blocks its head for up to this long; release N+1 renews instead.
const GITHUB_STATUS_KEY_LEASE_TTL_MS = DELIVERY_LOCK_HOLD_TIMEOUT_MS + WRITE_ATTEMPT_MAX_MS + FENCE_MARGIN_MS;

/** The holder no longer owns its status key, so it must not write to GitHub. */
export class GithubStatusKeyLost extends Error {}

/** Throws GithubStatusKeyLost unless the caller may start one GitHub write now. */
export type GithubStatusFence = () => Promise<void>;

function firstRow(rows: unknown): Record<string, unknown> | undefined {
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
}

async function acquireGithubStatusKeyLease(db: Db, leaseKey: string, token: string): Promise<boolean> {
  const ttl = sql.raw(`interval '${GITHUB_STATUS_KEY_LEASE_TTL_MS} milliseconds'`);
  const rows = await db.execute(sql`
    insert into github_status_key_leases (key, token, expires_at)
    values (${leaseKey}, ${token}, clock_timestamp() + ${ttl})
    on conflict (key) do update set token = excluded.token, expires_at = excluded.expires_at
      where github_status_key_leases.expires_at <= clock_timestamp()
    returning token
  `);
  return firstRow(rows) !== undefined;
}

async function releaseGithubStatusKeyLease(db: Db, leaseKey: string, token: string): Promise<void> {
  const release = () => db.execute(sql`delete from github_status_key_leases where key = ${leaseKey} and token = ${token}`);
  try {
    // Once more on failure: after the holder's backend dies, the first query
    // can land on the dead connection, and the retry reopens it. A row left
    // behind would block this head until it expires.
    await release().catch(release);
  } catch (err) {
    // The row frees itself at expiry; the next sweep deletes it.
    logger.warn({ err, leaseKey }, "github-status-delivery-outbox: status key lease release failed");
  }
}

/**
 * Serialize the final read and external write for one GitHub status key.
 *
 * Returns `null`, without waiting, when another evaluation holds the key, or
 * when this one loses it before a write; the caller must leave durable
 * follow-up work instead (BLO-52499). `operation` must call `fence()` before
 * every GitHub write and let a GithubStatusKeyLost propagate.
 *
 * Exclusivity is a lease row (migration 0273), taken before any transaction,
 * so a contended trigger costs one statement. Release N keeps #3411's
 * transaction-scoped advisory lock as well, because pods still running #3411
 * see only that lock during a rolling deploy; the next release drops it, and
 * with it the pooled connection a holder pins across its GitHub calls.
 */
export async function withGithubStatusDeliveryLock<T>(
  db: Db,
  key: string,
  operation: (fence: GithubStatusFence, tx: DbTransaction) => Promise<T>,
): Promise<T | null> {
  const leaseKey = key.toLowerCase();
  const token = `${hostname()}:${randomUUID()}`;
  if (!(await acquireGithubStatusKeyLease(db, leaseKey, token))) return null;

  let running: Promise<T> | undefined;
  let transactionEnded = false;
  try {
    return await db.transaction(async (tx) => {
      // The critical section performs external GitHub I/O (paginated list
      // calls and status POSTs with retries), so the holder sits
      // idle-in-transaction pinning a pool connection. Bound it, or a hung
      // GitHub call holds the key forever.
      //
      // set_config(..., true) is transaction-local; SET LOCAL cannot be
      // parameterized, so it is spelled this way deliberately.
      await tx.execute(
        sql`select set_config('idle_in_transaction_session_timeout', ${`${DELIVERY_LOCK_HOLD_TIMEOUT_MS}ms`}, true)`,
      );
      // BRIDGE (release N): the raw, case-preserving key, byte-identical to
      // #3411's, so a #3411 pod and this one exclude each other.
      const row = firstRow(
        await tx.execute(sql`
          select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired,
                 pg_backend_pid() as pid,
                 transaction_timestamp()::text as started
        `),
      );
      if (row?.acquired !== true) return null;
      const pid = Number(row.pid);
      const started = String(row.started);
      const fence: GithubStatusFence = async () => {
        if (transactionEnded) throw new GithubStatusKeyLost("transaction_ended");
        // On `tx`, not `db`: a second pool connection taken inside the critical
        // section can wedge the holder on a saturated pool. Bound to this
        // backend and this transaction, because after the backend dies the
        // driver can route a later query to a reconnected session that holds
        // no advisory lock. clock_timestamp(), because now() is frozen at the
        // transaction's start.
        const sentAt = performance.now();
        let timer: NodeJS.Timeout | undefined;
        const rows = await Promise.race([
          tx.execute(sql`
            select (extract(epoch from expires_at - clock_timestamp()) * 1000)::float8 as remaining_ms
            from github_status_key_leases
            where key = ${leaseKey} and token = ${token}
              and pg_backend_pid() = ${pid} and transaction_timestamp()::text = ${started}
          `),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new GithubStatusKeyLost("fence_timeout")), FENCE_QUERY_TIMEOUT_MS);
          }),
        ]).catch((err) => {
          throw err instanceof GithubStatusKeyLost ? err : new GithubStatusKeyLost("fence_failed", { cause: err });
        }).finally(() => clearTimeout(timer));
        const remaining = firstRow(rows)?.remaining_ms;
        if (remaining === undefined) throw new GithubStatusKeyLost("lease_not_held");
        // Charge the query's own latency against the holder.
        if (Number(remaining) - (performance.now() - sentAt) < WRITE_ATTEMPT_MAX_MS + FENCE_MARGIN_MS) {
          throw new GithubStatusKeyLost("lease_expiring");
        }
      };
      return (running = operation(fence, tx));
    });
  } catch (err) {
    // Postgres can end the transaction (idle timeout, terminated backend) while
    // the operation is still running, so settle on the operation itself.
    transactionEnded = true;
    const outcome = running
      ? await running.then((value) => ({ value }), (error: unknown) => ({ error }))
      : { error: err };
    if ("value" in outcome) return outcome.value;
    if (outcome.error instanceof GithubStatusKeyLost) {
      logger.warn({ key, reason: outcome.error.message }, "github-status-delivery-outbox: status key lost before a GitHub write; caller re-queues");
      return null;
    }
    throw outcome.error;
  } finally {
    // Never free the key while a write that passed its fence is in flight.
    await running?.catch(() => {});
    await releaseGithubStatusKeyLease(db, leaseKey, token);
  }
}

export type EnqueueGithubCommitStatusDeliveryInput = {
  companyId?: string | null;
  sourceRunId?: string | null;
  repoFullName: string;
  sha: string;
  context: string;
  state: GitHubCommitStatusState;
  forceWrite?: boolean;
  /**
   * Re-run the comment-review gate for this head instead of replaying `state`.
   * Pair with `delayMs`: the row is a backstop for the live evaluation, and
   * firing it before that evaluation has had time to land would duplicate the
   * work on every webhook rather than only on the ones that lose it.
   */
  reevaluate?: boolean;
  /** Hold the first attempt back by this many milliseconds. */
  delayMs?: number;
  description: string;
  targetUrl?: string | null;
  prNumber: number;
  prUrl?: string | null;
};

function normalizeCommitStatusState(value: string): GitHubCommitStatusState {
  return value === "error" || value === "failure" || value === "pending" || value === "success"
    ? value
    : "failure";
}

function nextAttemptAt(attempt: number, now: Date): Date {
  const delayMs = RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS[0]!;
  return new Date(now.getTime() + delayMs);
}

/**
 * An evidence-fetch failure is never evidence about the PR — on ANY surface.
 *
 * Only the two enumerated *configuration* faults below are permanent. Every
 * transport error and every HTTP status, on every present or future evidence
 * surface, is retryable. Stating the rule once as the default (rather than as a
 * per-surface carve-out) is deliberate: a surface added later cannot inherit a
 * permanent-failure default by omission.
 *
 * BLO-28920 established this for `comments_*` but left `reviews_*` classified by
 * HTTP status, so a bare 403/404/401 there reached failPermanentDelivery and
 * permanently dropped the gate-status delivery. That asymmetry was exactly
 * backwards: a `reviews_*` failure means the predicate read NOTHING — strictly
 * less information than a `comments_*` failure, which by construction only
 * happens after the reviews surface has already been read conclusively. So the
 * surface we knew least about was the one that failed permanently.
 *
 * The cost of that is a stall, not a dropped log line. Dropping the delivery
 * means the required context is never posted, and a required context with no
 * status reads "Expected — waiting for status" and blocks the PR indefinitely
 * until a human intervenes (BLO-28968). Retrying is bounded by MAX_ATTEMPTS, so
 * the fail-safe direction costs at most a few extra reads.
 */
function classifyReviewerEvidenceError(error: string): { retryable: boolean; reason: string } {
  if (error === "no_bot_login") return { retryable: false, reason: "missing_pr_reviewer_bot_login" };
  if (error === "no_token") {
    return githubAppCredentialsConfigured()
      ? { retryable: true, reason: "github_app_token_unavailable" }
      : { retryable: false, reason: "missing_github_app_credentials" };
  }
  return { retryable: true, reason: `reviewer_evidence_${error}` };
}

/** Test-only: assert the classification rule directly (BLO-28968). */
export { classifyReviewerEvidenceError as _classifyReviewerEvidenceError };

function deliveryClaimWhere(row: DeliveryRow) {
  return and(
    eq(githubCommitStatusDeliveries.id, row.id),
    eq(githubCommitStatusDeliveries.status, "processing"),
    eq(githubCommitStatusDeliveries.updatedAt, row.updatedAt),
  );
}

async function refreshDeliveryClaimBeforeExternalWrite(db: DbHandle, row: DeliveryRow): Promise<DeliveryRow | null> {
  const [updated] = await db
    .update(githubCommitStatusDeliveries)
    .set({ updatedAt: new Date() })
    .where(deliveryClaimWhere(row))
    .returning();
  return updated ?? null;
}

function statusCreatedAtOrAfterQueueSecond(statusCreatedAt: number, queuedAt: Date): boolean {
  if (!Number.isFinite(statusCreatedAt)) return false;
  const queuedAtSecond = Math.floor(queuedAt.getTime() / 1000) * 1000;
  return statusCreatedAt >= queuedAtSecond;
}

async function handleFreshCommitStatusIfPresent(db: DbHandle, row: DeliveryRow): Promise<boolean> {
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
    return true;
  }

  const latestCommitStatus = latestStatus.status;
  const statusCreatedAt = latestCommitStatus?.createdAt ? Date.parse(latestCommitStatus.createdAt) : NaN;
  const statusAtOrAfterQueue = statusCreatedAtOrAfterQueueSecond(statusCreatedAt, row.createdAt);
  if (latestCommitStatus?.state === "success" || statusAtOrAfterQueue) {
    await markTerminal(
      db,
      row,
      "skipped",
      "info",
      `Skipped PR-review gate status failure for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)} because a newer status already exists`,
      {
        reason: latestCommitStatus?.state === "success" ? "existing_success_status" : "newer_or_same_second_status_exists",
        latestStatus: latestCommitStatus,
      },
    );
    return true;
  }

  return false;
}

// A forced retirement retry may supersede the status that existed when it was
// queued, but it must not overwrite any later evaluation of the same head.
async function handleFreshSuccessForForcedDelivery(db: DbHandle, row: DeliveryRow): Promise<boolean> {
  if (!row.forceWrite) return false;
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
    return true;
  }

  const latest = latestStatus.status;
  const createdAt = latest?.createdAt ? Date.parse(latest.createdAt) : NaN;
  if (statusCreatedAtOrAfterQueueSecond(createdAt, row.createdAt)) {
    await markTerminal(
      db,
      row,
      "skipped",
      "info",
      `Skipped forced retired-context retry for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)} because a newer status already exists`,
      {
        reason: latest?.state === "success" ? "fresh_success_status_exists" : "newer_status_exists",
        latestStatus: latest,
      },
    );
    return true;
  }
  return false;
}

async function appendDeliveryRunEvent(
  db: DbHandle,
  row: DeliveryRow,
  level: "info" | "warn",
  message: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!row.sourceRunId) return;

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
  db: DbHandle,
  row: DeliveryRow,
  status: DeliveryTerminalStatus,
  level: "info" | "warn",
  message: string,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const [updated] = await db
    .update(githubCommitStatusDeliveries)
    .set({
      status,
      updatedAt: now,
      deliveredAt: status === "delivered" || status === "skipped" ? now : null,
      lastError: status === "delivered" || status === "skipped" ? null : String(result.reason ?? status),
      lastErrorKind: status === "failed_permanent" ? "permanent" : status === "failed" ? "retry_exhausted" : null,
      lastResult: result,
    })
    .where(deliveryClaimWhere(row))
    .returning({ id: githubCommitStatusDeliveries.id });
  if (!updated) {
    logger.info(
      { deliveryId: row.id, attemptedStatus: status },
      "github-status-delivery-outbox: stale delivery claim ignored terminal update",
    );
    return;
  }

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

/**
 * A forced replay found this head's status key held by a live evaluation.
 * Requeue without spending an attempt: contention says nothing about whether
 * delivery can succeed, and the holder is bounded by
 * DELIVERY_LOCK_HOLD_TIMEOUT_MS. The in-lock freshness re-check runs again
 * once the key is free.
 */
async function deferBehindLiveEvaluation(db: DbHandle, row: DeliveryRow): Promise<void> {
  const now = new Date();
  await db
    .update(githubCommitStatusDeliveries)
    .set({
      status: "queued",
      nextAttemptAt: new Date(now.getTime() + COALESCED_REEVALUATION_DELAY_MS),
      lastError: "github_status_key_busy",
      lastErrorKind: "transient",
      updatedAt: now,
    })
    .where(deliveryClaimWhere(row));
}

async function retryOrFailDelivery(
  db: DbHandle,
  row: DeliveryRow,
  reason: string,
  result: Record<string, unknown>,
): Promise<void> {
  const attempts = row.attempts + 1;
  const now = new Date();
  const retryAt = nextAttemptAt(attempts, now);
  const exhausted = attempts >= MAX_ATTEMPTS;
  const [updated] = await db
    .update(githubCommitStatusDeliveries)
    .set({
      status: exhausted ? "failed" : "queued",
      attempts,
      nextAttemptAt: exhausted ? row.nextAttemptAt : retryAt,
      lastError: reason,
      lastErrorKind: exhausted ? "retry_exhausted" : "transient",
      lastResult: result,
      updatedAt: now,
    })
    .where(deliveryClaimWhere(row))
    .returning({ id: githubCommitStatusDeliveries.id });
  if (!updated) {
    logger.info(
      { deliveryId: row.id, reason },
      "github-status-delivery-outbox: stale delivery claim ignored retry update",
    );
    return;
  }

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
      nextAttemptAt: exhausted ? null : retryAt.toISOString(),
      reason,
      ...result,
    },
  );
}

async function failPermanentDelivery(
  db: DbHandle,
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

/**
 * Re-drive a lost comment-review gate evaluation (BLO-36819).
 *
 * Unlike every other row in this table, a `reevaluate` row carries no verdict:
 * the whole point is that the evaluation which would have produced one never
 * completed. So it re-runs the gate rather than replaying `state`.
 *
 * The freshness guard here is deliberately NOT `handleFreshCommitStatusIfPresent`.
 * That helper also short-circuits on any `success`, regardless of age, which is
 * right for replaying a stale failure and wrong here: a review can turn a green
 * head red, and skipping on an older green would make this backstop blind to
 * exactly the transition that matters most. Only "a status was written at or
 * after this row was queued" proves the live evaluation landed.
 */
async function processGateReevaluation(db: Db, row: DeliveryRow): Promise<void> {
  // A coalesced row (forceWrite) was queued while another evaluation held this
  // head. That holder's status lands after `createdAt` from reads that may
  // predate the trigger, so here a fresh status proves nothing (BLO-52499).
  if (!row.forceWrite) {
    const latestStatus = await githubGetLatestCommitStatusForContext({
      repoFullName: row.repoFullName,
      sha: row.sha,
      context: row.context,
    });
    if (!latestStatus.ok) {
      if (latestStatus.retryable) {
        await retryOrFailDelivery(db, row, latestStatus.reason, { latestStatus });
      } else {
        await failPermanentDelivery(db, row, latestStatus.reason, { latestStatus });
      }
      return;
    }
    const latestCreatedAt = latestStatus.status?.createdAt ? Date.parse(latestStatus.status.createdAt) : NaN;
    if (statusCreatedAtOrAfterQueueSecond(latestCreatedAt, row.createdAt)) {
      await markTerminal(
        db,
        row,
        "skipped",
        "info",
        `Skipped comment-review gate re-evaluation for ${row.context} on ${row.repoFullName}@${row.sha.slice(0, 7)} because the live evaluation already published`,
        { reason: "live_evaluation_published", latestStatus: latestStatus.status },
      );
      return;
    }
  }

  const fencedRow = await refreshDeliveryClaimBeforeExternalWrite(db, row);
  if (!fencedRow) {
    logger.info(
      { deliveryId: row.id },
      "github-status-delivery-outbox: stale delivery claim ignored before gate re-evaluation",
    );
    return;
  }

  // Imported lazily: pr-comment-review-gate imports withGithubStatusDeliveryLock
  // from this module, and a static edge back would be a module-init cycle.
  const { runPrCommentReviewGateCheck } = await import("./pr-comment-review-gate.js");
  // Not inside withGithubStatusDeliveryLock: the check takes that same advisory
  // lock itself, on a second pool connection, and would always find it held.
  const result = await runPrCommentReviewGateCheck({
    repoFullName: fencedRow.repoFullName,
    prNumber: fencedRow.prNumber,
    // The head this row was queued for, not the PR's current head. A head that
    // has since moved got its own trigger and its own row; this one exists to
    // finish the verdict that was lost for THIS sha.
    headSha: fencedRow.sha,
    prUrl: fencedRow.prUrl,
    db,
  });
  if (result.posted) {
    await markTerminal(
      db,
      fencedRow,
      "delivered",
      "info",
      `Re-evaluated comment-review gate for ${fencedRow.context} on ${fencedRow.repoFullName}@${fencedRow.sha.slice(0, 7)} after the live evaluation was lost`,
      { reason: "reevaluated", verdict: result.verdict },
    );
    return;
  }
  // The gate found the head held and already re-armed this row behind the
  // holder (enqueueCoalescedGateReevaluation), so this claim is gone.
  if (result.reason === "coalesced") return;
  if (result.reason === "not_configured") {
    await failPermanentDelivery(db, fencedRow, "comment_review_gate_not_configured", { result });
    return;
  }
  if (result.reason === "retirement_failed" && result.retirementDeliveries?.length) {
    // The live status DID publish; only the retired-context cleanup did not.
    // Mirror `github-webhook.ts`: give each retirement its own durable row and
    // close this one as `delivered`, because the verdict it existed to publish
    // is published.
    //
    // Retrying this row instead loses the retirement outright. `retryOrFailDelivery`
    // does not reset `createdAt`, so the next attempt reads the status THIS run
    // just wrote, the freshness guard above necessarily sees it as at-or-after
    // `createdAt`, and the row terminates `skipped: live_evaluation_published` —
    // a reason that is also false, since the backstop published, not the live path.
    for (const delivery of result.retirementDeliveries) {
      await enqueueGithubCommitStatusDelivery(db, {
        // Provenance-less for the same reason as the webhook path: a retirement
        // is triggered by a gate evaluation, not an agent run.
        companyId: null,
        sourceRunId: null,
        repoFullName: fencedRow.repoFullName,
        sha: delivery.sha,
        context: delivery.context,
        state: delivery.state,
        description: delivery.description,
        targetUrl: delivery.targetUrl,
        prNumber: fencedRow.prNumber,
        prUrl: fencedRow.prUrl,
        forceWrite: true,
      });
    }
    await markTerminal(
      db,
      fencedRow,
      "delivered",
      "info",
      `Re-evaluated comment-review gate for ${fencedRow.context} on ${fencedRow.repoFullName}@${fencedRow.sha.slice(0, 7)}; queued ${result.retirementDeliveries.length} retired-context retry(s)`,
      { reason: "reevaluated_retirement_requeued", retirementDeliveries: result.retirementDeliveries },
    );
    return;
  }
  await retryOrFailDelivery(db, fencedRow, `comment_review_gate_${result.reason}`, { result });
}

async function processDelivery(db: Db, row: DeliveryRow): Promise<void> {
  if (row.reevaluate) return processGateReevaluation(db, row);
  if (!row.forceWrite) {
    if (await handleFreshCommitStatusIfPresent(db, row)) return;

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
  } else if (await handleFreshSuccessForForcedDelivery(db, row)) {
    return;
  }

  let fencedRow = await refreshDeliveryClaimBeforeExternalWrite(db, row);
  if (!fencedRow) {
    logger.info(
      { deliveryId: row.id },
      "github-status-delivery-outbox: stale delivery claim ignored before external status write",
    );
    return;
  }
  if (await handleFreshSuccessForForcedDelivery(db, fencedRow)) return;
  if (!fencedRow.forceWrite && (await handleFreshCommitStatusIfPresent(db, fencedRow))) return;

  const postingRow = await refreshDeliveryClaimBeforeExternalWrite(db, fencedRow);
  if (!postingRow) {
    logger.info(
      { deliveryId: row.id },
      "github-status-delivery-outbox: stale delivery claim ignored before external status write",
    );
    return;
  }
  fencedRow = postingRow;

  const post = async () => githubPostCommitStatusDetailed({
    repoFullName: fencedRow.repoFullName,
    sha: fencedRow.sha,
    context: fencedRow.context,
    state: normalizeCommitStatusState(fencedRow.state),
    description: fencedRow.description,
    targetUrl: fencedRow.targetUrl,
  });
  const posted = fencedRow.forceWrite
    ? await withGithubStatusDeliveryLock(
        db,
        `${fencedRow.repoFullName}#${fencedRow.sha}`,
        async (fence, tx) => {
          // The lock is shared with the live gate evaluation. Re-check inside
          // it so a clean evaluation that won the lock cannot be overwritten.
          // Use `tx`, not `db`: a second pool connection taken here is what
          // lets a saturated pool wedge the lock holder.
          if (await handleFreshSuccessForForcedDelivery(tx, fencedRow)) {
            return { ok: true as const, skipped: true as const };
          }
          await fence();
          return { ...(await post()), skipped: false as const };
        },
      )
    : { ...(await post()), skipped: false as const };
  if (posted === null) {
    await deferBehindLiveEvaluation(db, fencedRow);
    return;
  }
  if (posted.skipped) return;
  if (posted.ok) {
    await markTerminal(
      db,
      fencedRow,
      "delivered",
      "info",
      `Set PR-review gate status ${fencedRow.context} to ${fencedRow.state} on ${fencedRow.repoFullName}@${fencedRow.sha.slice(0, 7)} after retry exhaustion`,
      { posted },
    );
    return;
  }
  if (posted.retryable) {
    await retryOrFailDelivery(db, fencedRow, posted.reason, { posted });
    return;
  }
  await failPermanentDelivery(db, fencedRow, posted.reason, { posted });
}

/**
 * Queue a re-evaluation of a head whose status key another evaluation holds
 * (BLO-52499). Forced, so the holder's status, which may come from reads that
 * predate this trigger, cannot satisfy its freshness check.
 *
 * It also re-arms a row that is mid-evaluation. The plain enqueue preserves a
 * `processing` row, and that row is often the holder itself, which would then
 * close `delivered` on its pre-trigger reads. Moving it back to `queued` makes
 * the holder's own bookkeeping miss its claim, so the row runs again after it.
 */
export async function enqueueCoalescedGateReevaluation(
  db: Db,
  input: { repoFullName: string; sha: string; context: string; prNumber: number; prUrl?: string | null },
): Promise<void> {
  const row = await enqueueGithubCommitStatusDelivery(db, {
    ...input,
    companyId: null,
    sourceRunId: null,
    // Placeholder, as for the webhook's backstop row: a reevaluate row computes
    // its own verdict and never publishes this state.
    state: "pending",
    description: "Comment-review gate re-evaluation queued.",
    reevaluate: true,
    forceWrite: true,
    delayMs: COALESCED_REEVALUATION_DELAY_MS,
  });
  if (row.status === "queued") return;
  const now = new Date();
  await db
    .update(githubCommitStatusDeliveries)
    .set({
      status: "queued",
      reevaluate: true,
      forceWrite: true,
      nextAttemptAt: new Date(now.getTime() + COALESCED_REEVALUATION_DELAY_MS),
      updatedAt: now,
    })
    // Not only `processing`: the holder may have closed the row since the upsert.
    .where(and(eq(githubCommitStatusDeliveries.id, row.id), ne(githubCommitStatusDeliveries.status, "queued")));
}

export async function enqueueGithubCommitStatusDelivery(
  db: Db | DbTransaction,
  input: EnqueueGithubCommitStatusDeliveryInput,
): Promise<DeliveryRow> {
  const now = new Date();
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const dueAt = new Date(now.getTime() + Math.max(input.delayMs ?? 0, 0));
  const dueAtSql = sql`${dueAt.toISOString()}::timestamptz`;
  // Normalize the two optional provenance fields ONCE, before anything below
  // reads them. `undefined` and `null` are different inputs to drizzle and only
  // the second is safe here: an `undefined` chunk renders as the empty string
  // with no bound parameter, so `source_run_id = ${undefined}` becomes
  // `source_run_id = ` and a CASE ELSE arm becomes `else  end` — both Postgres
  // 42601 at parse time. Webhook-originated retirements omit these keys
  // entirely (`github-webhook.ts`), so that is the shape production actually
  // sends. Deriving the insert values and both CASE arms from these two
  // constants is what keeps them from drifting apart again.
  const companyId = input.companyId ?? null;
  const sourceRunId = input.sourceRunId ?? null;
  // NOTE the NULL semantics, which are load-bearing. Migration 0238 made
  // source_run_id nullable, so for webhook-originated rows both sides of the
  // comparison are NULL and `source_run_id = NULL` evaluates to NULL, not
  // true. preserveExistingDelivery is therefore NULL, every CASE below takes
  // its ELSE branch, and a `delivered`/`skipped` row is reset to `queued`.
  // That is the wanted behavior: a retirement write that already delivered
  // must be redone when a fresh failure re-enqueues the same key. Do NOT
  // "correct" this to `is not distinct from` — that would make the comparison
  // true for two NULLs, preserve the terminal row, and silently drop the
  // re-delivery. Pinned by test: "re-queues a delivered webhook-originated row".
  const preserveExistingDelivery = sql`${
    githubCommitStatusDeliveries.status
  } = 'processing' or (${
    githubCommitStatusDeliveries.status
  } in ('delivered', 'skipped') and ${
    githubCommitStatusDeliveries.sourceRunId
  } = ${sourceRunId})`;
  // A coalesced re-evaluation (reevaluate + forceWrite, BLO-52499) stays forced,
  // and keeps its earlier due time, when the webhook's backstop for a later
  // trigger lands on it: the status that backstop's freshness check would accept
  // may come from a holder whose reads predate the coalesced trigger.
  const keepCoalescedReevaluation = input.reevaluate
    ? sql`${githubCommitStatusDeliveries.status} = 'queued' and ${githubCommitStatusDeliveries.reevaluate} and ${githubCommitStatusDeliveries.forceWrite}`
    : sql`false`;
  // Scrub BEFORE this 140-char cap, not only at the send. The replay path
  // hands `row.description` to githubPostCommitStatusDetailed, which scrubs
  // it — but by then the value has already been truncated here, and a
  // credential straddling the cut loses the prefix or terminator its detector
  // needs. The surviving fragment then matches nothing, is persisted, and is
  // published on every replay. Scrubbing first also means the durable
  // `description` never holds credential-shaped text at rest, which the
  // send-time scrub cannot achieve from here (PEN-3157).
  //
  // Bound ONCE and reused by both arms of the upsert below. It used to be
  // inlined into `values` only, leaving the ON CONFLICT arm on a raw
  // `input.description.slice(0, 140)` — trim-then-scrub, the exact defect this
  // block exists to prevent, on what is in practice the DOMINANT path: the
  // conflict target is (repo, sha, context), so every re-evaluation of the
  // same gate context on the same head takes the update arm, not the insert.
  // Deriving both from one binding is what stops the two paths diverging again.
  const scrubbedDescription = scrubOutboundGitHubText(
    input.description,
    "outbox commit-status description",
  ).slice(0, 140);
  const values = {
    companyId,
    sourceRunId,
    repoFullName: input.repoFullName,
    sha: input.sha,
    context: input.context,
    state: input.state,
    forceWrite: input.forceWrite ?? false,
    reevaluate: input.reevaluate ?? false,
    description: scrubbedDescription,
    targetUrl: input.targetUrl ?? null,
    prNumber: input.prNumber,
    prUrl: input.prUrl ?? null,
    status: "queued",
    attempts: 0,
    nextAttemptAt: dueAt,
    lastError: null,
    lastErrorKind: null,
    lastResult: null,
    createdAt: now,
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
        companyId: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.companyId} else ${companyId} end`,
        sourceRunId: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.sourceRunId} else ${sourceRunId} end`,
        prNumber: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.prNumber} else ${input.prNumber} end`,
        prUrl: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.prUrl} else ${input.prUrl ?? null} end`,
        state: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.state} else ${input.state} end`,
        forceWrite: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.forceWrite} when ${keepCoalescedReevaluation} then true else ${input.forceWrite ?? false} end`,
        reevaluate: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.reevaluate} else ${input.reevaluate ?? false} end`,
        description: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.description} else ${scrubbedDescription} end`,
        targetUrl: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.targetUrl} else ${input.targetUrl ?? null} end`,
        status: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.status} else 'queued' end`,
        attempts: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.attempts} else 0 end`,
        nextAttemptAt: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.nextAttemptAt} when ${keepCoalescedReevaluation} then least(${githubCommitStatusDeliveries.nextAttemptAt}, ${dueAtSql}) else ${dueAtSql} end`,
        lastError: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.lastError} else null end`,
        lastErrorKind: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.lastErrorKind} else null end`,
        lastResult: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.lastResult} else null end`,
        createdAt: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.createdAt} else ${nowSql} end`,
        updatedAt: sql`case when ${preserveExistingDelivery} then ${githubCommitStatusDeliveries.updatedAt} else ${nowSql} end`,
      },
    })
    .returning();

  if (!row) throw new Error("failed to enqueue GitHub commit status delivery");
  return row;
}

export async function resetStaleGitHubCommitStatusDeliveries(db: Db, now = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
  const rows = await db
    .update(githubCommitStatusDeliveries)
    .set({ status: "queued", nextAttemptAt: now, updatedAt: now })
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
      "github-status-delivery-outbox: requeued stale processing rows",
    );
  }
  return rows.length;
}

async function claimDueGitHubCommitStatusDeliveries(db: Db, now: Date): Promise<DeliveryRow[]> {
  const nowSql = sql`${now.toISOString()}::timestamptz`;
  const claimed = await db.transaction(async (tx) => {
    const lockedRows = Array.from(await tx.execute(sql<{ id: string }>`
      select ${githubCommitStatusDeliveries.id} as "id"
      from ${githubCommitStatusDeliveries}
      where ${githubCommitStatusDeliveries.status} = 'queued'
        and ${githubCommitStatusDeliveries.nextAttemptAt} <= ${nowSql}
      order by ${githubCommitStatusDeliveries.nextAttemptAt} asc, ${githubCommitStatusDeliveries.createdAt} asc
      limit ${CLAIM_BATCH}
      for update skip locked
    `)) as Array<{ id: string }>;
    const ids = lockedRows.map((row) => row.id);
    if (ids.length === 0) return [];
    return tx
      .update(githubCommitStatusDeliveries)
      .set({ status: "processing", updatedAt: now })
      .where(inArray(githubCommitStatusDeliveries.id, ids))
      .returning();
  });

  return claimed.sort(
    (left, right) =>
      left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime()
      || left.createdAt.getTime() - right.createdAt.getTime(),
  );
}

export async function pollGitHubCommitStatusDeliveriesOnce(db: Db): Promise<number> {
  const now = new Date();
  await resetStaleGitHubCommitStatusDeliveries(db, now);
  // Only crashed holders leave a row behind; an expired one can never pass a
  // fence and is taken over on acquire anyway, so this just keeps it tidy.
  await db.execute(sql`delete from github_status_key_leases where expires_at <= clock_timestamp()`);
  const claimed = await claimDueGitHubCommitStatusDeliveries(db, now);

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

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { externalRuntimeReservations, heartbeatRuns } from "@paperclipai/db";
import {
  recordExternalRuntimeReservationEvent,
  setExternalRuntimeReservationMetrics,
} from "./metrics.js";
import { logger } from "../middleware/logger.js";
import { canClaimPrReviewTask } from "./pr-review-dispatch-lock.js";

const DEFAULT_EXTERNAL_RUNTIME_SLOT_ID = 0;

export type ExternalRuntimeReservation = typeof externalRuntimeReservations.$inferSelect;
export type ExternalRuntimeIsolationMode = "shared" | "run" | "workspace";

const ACTIVE_RUNTIME_SLOT_CONSTRAINT = "external_runtime_reservations_active_slot_idx";
const ACTIVE_ISOLATION_WRITER_CONSTRAINT = "external_runtime_reservations_active_isolation_writer_idx";

export class ExternalRuntimeIsolationConflictError extends Error {
  readonly code = "external_runtime_isolation_conflict";

  constructor(
    readonly runId: string,
    readonly isolationKey: string,
    readonly conflictingRunId: string | null,
  ) {
    super(
      `External runtime run ${runId} cannot acquire writer ownership for ${isolationKey}`
      + (conflictingRunId ? `; active run ${conflictingRunId} already owns it` : ""),
    );
    this.name = "ExternalRuntimeIsolationConflictError";
  }
}

function isConstraintConflict(error: unknown, expectedConstraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (typeof current !== "object") return false;
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    const constraint = candidate.constraint ?? candidate.constraint_name;
    if (candidate.code === "23505" && constraint === expectedConstraint) return true;
    current = candidate.cause;
  }
  return false;
}

export function externalRuntimeReservationCanRelease(
  reservation: Pick<ExternalRuntimeReservation, "state" | "jobName" | "expectedJobName">,
  observedJobPhase: "active" | "succeeded" | "failed" | "missing" | null,
  unidentifiedLaunchFinished = false,
): boolean {
  if (reservation.jobName || reservation.expectedJobName) {
    return observedJobPhase !== null && observedJobPhase !== "active";
  }
  return reservation.state === "reserved"
    || reservation.state === "launching"
    || (reservation.state === "release_pending" && unidentifiedLaunchFinished);
}

export async function refreshExternalRuntimeReservationMetrics(db: Db, now = new Date()): Promise<void> {
  const [snapshot] = await db
    .select({
      active: sql<number>`count(*)`,
      oldestReservedAt: sql<Date | null>`min(${externalRuntimeReservations.reservedAt})`,
    })
    .from(externalRuntimeReservations)
    .where(isNull(externalRuntimeReservations.releasedAt));
  const oldestMs = snapshot?.oldestReservedAt
    ? new Date(snapshot.oldestReservedAt).getTime()
    : now.getTime();
  setExternalRuntimeReservationMetrics({
    active: Number(snapshot?.active ?? 0),
    oldestAgeSeconds: Math.max(0, (now.getTime() - oldestMs) / 1000),
  });
}

function refreshExternalRuntimeReservationMetricsBestEffort(
  db: Db,
  now: Date,
  operation: string,
) {
  void refreshExternalRuntimeReservationMetrics(db, now).catch((err) => {
    logger.warn({ err, operation }, "failed to refresh external-runtime reservation metrics");
  });
}

type ExternalRuntimeClaim = {
  run: typeof heartbeatRuns.$inferSelect;
  reservation: ExternalRuntimeReservation;
};

async function claimRunWithExternalRuntimeSlotOutcome(
  db: Db,
  runId: string,
  claimedAt: Date,
  slotId = DEFAULT_EXTERNAL_RUNTIME_SLOT_ID,
  options: { exclusivePrReviewTaskKey?: string } = {},
): Promise<{ claimed: ExternalRuntimeClaim | null; taskBlocked: boolean }> {
  let outcome: { claimed: ExternalRuntimeClaim | null; taskBlocked: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      if (
        options.exclusivePrReviewTaskKey &&
        !(await canClaimPrReviewTask(tx, options.exclusivePrReviewTaskKey))
      ) {
        return { claimed: null, taskBlocked: true };
      }
      const run = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!run || run.status !== "queued") return { claimed: null, taskBlocked: false };

      let reservation = await tx
        .select()
        .from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, run.id))
        .then((rows) => rows[0] ?? null);

      if (reservation?.releasedAt) {
        reservation = await tx
          .update(externalRuntimeReservations)
          .set({
            id: randomUUID(),
            slotId,
            state: "reserved",
            expectedJobName: null,
            jobName: null,
            jobUid: null,
            isolationMode: "pending",
            isolationKey: `pending:${run.id}`,
            isolationBoundAt: claimedAt,
            reservedAt: claimedAt,
            launchingAt: null,
            launchedAt: null,
            releasedAt: null,
            releaseReason: null,
            createdAt: claimedAt,
            updatedAt: claimedAt,
          })
          .where(and(
            eq(externalRuntimeReservations.id, reservation.id),
            isNotNull(externalRuntimeReservations.releasedAt),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
      } else if (!reservation) {
        reservation = await tx
          .insert(externalRuntimeReservations)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            runId: run.id,
            slotId,
            state: "reserved",
            isolationMode: "pending",
            isolationKey: `pending:${run.id}`,
            isolationBoundAt: claimedAt,
            reservedAt: claimedAt,
            createdAt: claimedAt,
            updatedAt: claimedAt,
          })
          .onConflictDoNothing()
          .returning()
          .then((rows) => rows[0] ?? null);
      }
      if (!reservation) return { claimed: null, taskBlocked: false };

      const updatedRun = await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          error: null,
          errorCode: null,
          startedAt: run.startedAt ?? claimedAt,
          updatedAt: claimedAt,
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updatedRun) {
        throw new Error(`External runtime reservation ${reservation.id} could not claim queued run ${run.id}`);
      }
      return { claimed: { run: updatedRun, reservation }, taskBlocked: false };
    });
  } catch (error) {
    if (!isConstraintConflict(error, ACTIVE_RUNTIME_SLOT_CONSTRAINT)) throw error;
    outcome = { claimed: null, taskBlocked: false };
  }

  return outcome;
}

/**
 * Emits exactly one claim event per *dispatch attempt*, not per slot probe.
 *
 * `claimRunWithExternalRuntimeSlotPool` walks slots 0..maxSlots-1 looking for a
 * free one, so a probe losing to an already-occupied slot is the expected inner
 * step of a successful claim -- not an independent contention event. Recording
 * inside the probe made `contended` a scan-depth counter: one attempt against a
 * full 15-slot agent booked 15 increments, so the metric over-reported real
 * contention by up to maxSlots x and grew superlinearly with fleet concurrency
 * (observed contended:reserved ~ 1340:1 while dispatch was merely saturated).
 * It also fired the `count(*)+min()` metrics refresh once per probe, turning a
 * single dispatch into maxSlots full-table aggregates under the agent start
 * lock -- the actual source of "agent start lock held longer than expected".
 */
function recordExternalRuntimeClaimAttempt(db: Db, claimedAt: Date, claimed: boolean) {
  recordExternalRuntimeReservationEvent(claimed ? "reserved" : "contended");
  refreshExternalRuntimeReservationMetricsBestEffort(db, claimedAt, "claim");
}

export async function claimRunWithExternalRuntimeSlot(
  db: Db,
  runId: string,
  claimedAt: Date,
  slotId = DEFAULT_EXTERNAL_RUNTIME_SLOT_ID,
  options: { exclusivePrReviewTaskKey?: string } = {},
): Promise<ExternalRuntimeClaim | null> {
  const outcome = await claimRunWithExternalRuntimeSlotOutcome(
    db,
    runId,
    claimedAt,
    slotId,
    options,
  );
  recordExternalRuntimeClaimAttempt(db, claimedAt, Boolean(outcome.claimed));
  return outcome.claimed;
}

export async function claimRunWithExternalRuntimeSlotPool(
  db: Db,
  runId: string,
  claimedAt: Date,
  maxSlots: number,
  options: { exclusivePrReviewTaskKey?: string } = {},
) {
  const slotCount = Math.max(1, Math.floor(maxSlots));
  for (let slotId = 0; slotId < slotCount; slotId += 1) {
    const outcome = await claimRunWithExternalRuntimeSlotOutcome(
      db,
      runId,
      claimedAt,
      slotId,
      options,
    );
    if (outcome.claimed) {
      recordExternalRuntimeClaimAttempt(db, claimedAt, true);
      return outcome.claimed;
    }
    if (outcome.taskBlocked) {
      recordExternalRuntimeClaimAttempt(db, claimedAt, false);
      return null;
    }
  }
  // Every slot was occupied: one genuine contention event for the whole attempt.
  recordExternalRuntimeClaimAttempt(db, claimedAt, false);
  return null;
}

export async function getActiveExternalRuntimeReservation(
  db: Db,
  runId: string,
): Promise<ExternalRuntimeReservation | null> {
  return db
    .select()
    .from(externalRuntimeReservations)
    .where(and(
      eq(externalRuntimeReservations.runId, runId),
      isNull(externalRuntimeReservations.releasedAt),
    ))
    .then((rows) => rows[0] ?? null);
}

export async function bindExternalRuntimeReservationIsolation(
  db: Db,
  input: {
    runId: string;
    reservationId: string;
    isolationMode: ExternalRuntimeIsolationMode;
    isolationKey: string;
    now?: Date;
  },
): Promise<ExternalRuntimeReservation> {
  const now = input.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      if (input.isolationMode !== "run") {
        await tx.execute(sql`select pg_advisory_xact_lock(748293011)`);
      }
      const existing = await tx
        .select()
        .from(externalRuntimeReservations)
        .where(and(
          eq(externalRuntimeReservations.id, input.reservationId),
          eq(externalRuntimeReservations.runId, input.runId),
          isNull(externalRuntimeReservations.releasedAt),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        throw new Error(`External runtime reservation no longer owns isolation binding for run ${input.runId}`);
      }
      if (existing.state === "release_pending" || existing.state === "released") {
        throw new Error(`External runtime reservation for run ${input.runId} is no longer active`);
      }
      const pendingIsolationKey = `pending:${input.runId}`;
      // BLO-21256: `replaceableBinding` is the ONLY gate standing between the
      // legacyWriter check / UPDATE below (which can throw
      // ExternalRuntimeIsolationConflictError) and a reservation that has
      // already been bound to a real isolationMode. That matters because Job
      // identity (expectedJobName/jobName) is never stamped onto a
      // reservation until AFTER a bind call for it has succeeded without
      // throwing (see markExternalRuntimeReservationLaunching /
      // recordExpectedExternalRuntimeJobName / recordExternalRuntimeJobIdentity
      // callers in heartbeat.ts) -- so by the time a run's own k8s Job can
      // exist, `replaceableBinding` is already false for it, and this
      // function can only no-op or throw the plain drift Error below, never
      // the conflict error. deferRunForK8sIsolationConflict() in heartbeat.ts
      // relies on this to avoid stranding a live Job when it reacts to
      // ExternalRuntimeIsolationConflictError. Do not loosen this gate (e.g.
      // to retry the legacyWriter/UPDATE path for an already-bound
      // reservation) without re-proving that invariant --
      // heartbeat-external-runtime-retry.test.ts pins it.
      const replaceableBinding =
        (existing.isolationMode === "pending" && existing.isolationKey === pendingIsolationKey) ||
        (existing.isolationMode === "legacy" && existing.isolationKey === `legacy:${input.runId}`);
      if (!replaceableBinding && (existing.isolationKey || existing.isolationMode)) {
        if (existing.isolationKey === input.isolationKey && existing.isolationMode === input.isolationMode) {
          return existing;
        }
        throw new Error(
          `External runtime isolation binding drift for run ${input.runId}: `
          + `persisted ${existing.isolationMode ?? "<none>"}/${existing.isolationKey ?? "<none>"}, `
          + `received ${input.isolationMode}/${input.isolationKey}`,
        );
      }
      if (input.isolationMode !== "run") {
        const legacyWriter = await tx
          .select({ runId: externalRuntimeReservations.runId })
          .from(externalRuntimeReservations)
          .where(and(
            eq(externalRuntimeReservations.isolationMode, "legacy"),
            isNull(externalRuntimeReservations.releasedAt),
            ne(externalRuntimeReservations.runId, input.runId),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (legacyWriter) {
          throw new ExternalRuntimeIsolationConflictError(
            input.runId,
            input.isolationKey,
            legacyWriter.runId,
          );
        }
      }

      const reservation = await tx
        .update(externalRuntimeReservations)
        .set({
          isolationMode: input.isolationMode,
          isolationKey: input.isolationKey,
          isolationBoundAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(externalRuntimeReservations.id, input.reservationId),
          eq(externalRuntimeReservations.runId, input.runId),
          isNull(externalRuntimeReservations.releasedAt),
          or(
            and(
              eq(externalRuntimeReservations.isolationMode, "pending"),
              eq(externalRuntimeReservations.isolationKey, pendingIsolationKey),
            ),
            and(
              eq(externalRuntimeReservations.isolationMode, "legacy"),
              eq(externalRuntimeReservations.isolationKey, `legacy:${input.runId}`),
            ),
          ),
          or(
            eq(externalRuntimeReservations.state, "reserved"),
            eq(externalRuntimeReservations.state, "launching"),
            eq(externalRuntimeReservations.state, "launched"),
          ),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!reservation) {
        throw new Error(`External runtime reservation no longer owns isolation binding for run ${input.runId}`);
      }
      return reservation;
    });
  } catch (error) {
    if (!isConstraintConflict(error, ACTIVE_ISOLATION_WRITER_CONSTRAINT)) throw error;
    const conflicting = await db
      .select({ runId: externalRuntimeReservations.runId })
      .from(externalRuntimeReservations)
      .where(and(
        eq(externalRuntimeReservations.isolationKey, input.isolationKey),
        isNull(externalRuntimeReservations.releasedAt),
        ne(externalRuntimeReservations.runId, input.runId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    throw new ExternalRuntimeIsolationConflictError(
      input.runId,
      input.isolationKey,
      conflicting?.runId ?? null,
    );
  }
}

export async function markExternalRuntimeReservationLaunching(
  db: Db,
  runId: string,
  now = new Date(),
): Promise<ExternalRuntimeReservation | null> {
  const reservation = await db
    .update(externalRuntimeReservations)
    .set({
      state: "launching",
      launchingAt: sql`coalesce(${externalRuntimeReservations.launchingAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(
      eq(externalRuntimeReservations.runId, runId),
      isNull(externalRuntimeReservations.releasedAt),
      eq(externalRuntimeReservations.state, "reserved"),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (reservation) {
    recordExternalRuntimeReservationEvent("launching");
    return reservation;
  }
  const active = await getActiveExternalRuntimeReservation(db, runId);
  return active?.state === "launching" ? active : null;
}

export async function rearmExternalRuntimeReservationForRetry(
  db: Db,
  input: { runId: string; reservationId: string; now?: Date },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const reservation = await db
    .update(externalRuntimeReservations)
    .set({
      state: "launching",
      expectedJobName: null,
      jobName: null,
      jobUid: null,
      launchingAt: now,
      launchedAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(externalRuntimeReservations.id, input.reservationId),
      eq(externalRuntimeReservations.runId, input.runId),
      isNull(externalRuntimeReservations.releasedAt),
      or(
        eq(externalRuntimeReservations.state, "launching"),
        eq(externalRuntimeReservations.state, "launched"),
      ),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (reservation) recordExternalRuntimeReservationEvent("launching");
  return reservation;
}

export async function requireExternalRuntimeLaunchOwnership(
  db: Db,
  input: { runId: string; reservationId: string },
): Promise<ExternalRuntimeReservation> {
  const reservation = await getActiveExternalRuntimeReservation(db, input.runId);
  if (reservation?.id !== input.reservationId || reservation.state !== "launching") {
    throw new Error(`External runtime reservation no longer owns launch for run ${input.runId}`);
  }
  return reservation;
}

export async function requireExternalRuntimeExecutionOwnership(
  db: Db,
  input: {
    runId: string;
    reservationId: string;
    jobName?: string | null;
    jobUid?: string | null;
  },
): Promise<ExternalRuntimeReservation> {
  const reservation = await getActiveExternalRuntimeReservation(db, input.runId);
  if (reservation?.id !== input.reservationId) {
    throw new Error(`External runtime reservation no longer owns execution for run ${input.runId}`);
  }
  if (reservation.state === "launching") return reservation;
  if (
    reservation.state === "launched"
    && reservation.jobName
    && reservation.jobUid
    && reservation.jobName === input.jobName
    && reservation.jobUid === input.jobUid
  ) {
    return reservation;
  }
  throw new Error(`External runtime reservation has no exact executable Job for run ${input.runId}`);
}

export async function releaseExternalRuntimeReservation(
  db: Db,
  input: { runId: string; reason: string; now?: Date },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const reservation = await db
    .update(externalRuntimeReservations)
    .set({
      state: "released",
      releasedAt: now,
      releaseReason: sql`coalesce(${externalRuntimeReservations.releaseReason}, ${input.reason})`,
      updatedAt: now,
    })
    .where(and(
      eq(externalRuntimeReservations.runId, input.runId),
      isNull(externalRuntimeReservations.releasedAt),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (reservation) {
    recordExternalRuntimeReservationEvent("released");
    refreshExternalRuntimeReservationMetricsBestEffort(db, now, "release");
  }
  return reservation;
}

export async function recordExpectedExternalRuntimeJobName(
  db: Db,
  input: {
    runId: string;
    jobName: string;
    reservationId?: string;
    slotId?: number;
    now?: Date;
  },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const reservation = await db
    .update(externalRuntimeReservations)
    .set({ expectedJobName: input.jobName, updatedAt: now })
    .where(and(
      eq(externalRuntimeReservations.runId, input.runId),
      isNull(externalRuntimeReservations.releasedAt),
      input.reservationId ? eq(externalRuntimeReservations.id, input.reservationId) : sql`true`,
      input.slotId !== undefined ? eq(externalRuntimeReservations.slotId, input.slotId) : sql`true`,
      or(
        and(
          eq(externalRuntimeReservations.state, "launching"),
          or(
            isNull(externalRuntimeReservations.expectedJobName),
            eq(externalRuntimeReservations.expectedJobName, input.jobName),
          ),
        ),
        and(
          eq(externalRuntimeReservations.state, "launched"),
          eq(externalRuntimeReservations.expectedJobName, input.jobName),
          eq(externalRuntimeReservations.jobName, input.jobName),
          isNotNull(externalRuntimeReservations.jobUid),
        ),
      ),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  if (reservation) return reservation;

  const active = await getActiveExternalRuntimeReservation(db, input.runId);
  if (active) {
    throw new Error(
      `External runtime reservation for run ${input.runId} is no longer launchable: `
      + `state ${active.state}, expected ${active.expectedJobName ?? "<none>"}, received ${input.jobName}`,
    );
  }
  return null;
}

/**
 * Stamps the observed Job name/UID onto the run's active reservation. This is
 * the "did we win or lose the create/stamp race" checkpoint: `createNamespacedJob`
 * happens in an external adapter package (outside this repo) and can succeed
 * even after the reservation gating it has been released -- reaped as
 * `process_lost` (pre-adapter, unstamped) or reclaimed by a fresh dispatch of
 * the same run id. A `null` return means EXACTLY that: no active
 * (`releasedAt IS NULL`) reservation existed for this run when the stamp
 * arrived. The caller MUST treat the reported Job as orphaned and delete it by
 * its exact observed name/UID (+ run/agent-id labels) -- never by reservation
 * state, which is by definition gone in this branch. Any other disagreement
 * (missing expectedJobName, identity mismatch, wrong state) throws instead of
 * returning null, since those indicate a real bug rather than a benign race.
 */
export async function recordExternalRuntimeJobIdentity(
  db: Db,
  input: {
    runId: string;
    jobName: string;
    jobUid?: string | null;
    reservationId?: string;
    slotId?: number;
    now?: Date;
  },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const outcome = await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(externalRuntimeReservations)
      .where(and(
        eq(externalRuntimeReservations.runId, input.runId),
        isNull(externalRuntimeReservations.releasedAt),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (!existing.expectedJobName) {
      throw new Error(`External runtime Job identity observed before an expected name was persisted for run ${input.runId}`);
    }
    if (
      (input.reservationId && existing.id !== input.reservationId)
      || (input.slotId !== undefined && existing.slotId !== input.slotId)
      || existing.expectedJobName !== input.jobName
      || (existing.jobName && existing.jobName !== input.jobName)
      || (input.jobUid && existing.jobUid && existing.jobUid !== input.jobUid)
    ) {
      throw new Error(
        `External runtime Job identity mismatch for run ${input.runId}: `
        + `persisted reservation ${existing.id}/slot ${existing.slotId}/`
        + `${existing.jobName ?? existing.expectedJobName}/${existing.jobUid ?? "<none>"}, `
        + `received ${input.jobName}/${input.jobUid ?? "<none>"}`,
      );
    }
    if (existing.state === "launched" && existing.jobName && (!input.jobUid || existing.jobUid === input.jobUid)) {
      // Steady-state re-observation of an already-launched Job. Only touch the
      // run row when externalRunId actually changes (IS DISTINCT FROM, so a
      // NULL still gets stamped) -- an unconditional set wrote updatedAt on
      // every running run every reconcile cycle. No state transition happened,
      // so the caller must not book a `launched` event for it either.
      await tx
        .update(heartbeatRuns)
        .set({ externalRunId: input.jobName, updatedAt: now })
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.status, "running"),
          sql`${heartbeatRuns.externalRunId} IS DISTINCT FROM ${input.jobName}`,
        ));
      return { reservation: existing, transitioned: false };
    }
    if (existing.state !== "launching" && existing.state !== "launched") {
      throw new Error(`External runtime reservation for run ${input.runId} is not launchable from ${existing.state}`);
    }

    const updated = await tx
      .update(externalRuntimeReservations)
      .set({
        state: "launched",
        jobName: input.jobName,
        jobUid: sql`coalesce(${externalRuntimeReservations.jobUid}, ${input.jobUid ?? null})`,
        launchedAt: sql`coalesce(${externalRuntimeReservations.launchedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(eq(externalRuntimeReservations.id, existing.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    await tx
      .update(heartbeatRuns)
      .set({ externalRunId: input.jobName, updatedAt: now })
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.status, "running")));
    return { reservation: updated, transitioned: true };
  });

  if (outcome?.transitioned) {
    recordExternalRuntimeReservationEvent("launched");
    refreshExternalRuntimeReservationMetricsBestEffort(db, now, "launch");
  }
  return outcome?.reservation ?? null;
}

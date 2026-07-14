import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { externalRuntimeReservations, heartbeatRuns } from "@paperclipai/db";
import {
  recordExternalRuntimeReservationEvent,
  setExternalRuntimeReservationMetrics,
} from "./metrics.js";

const DEFAULT_EXTERNAL_RUNTIME_SLOT_ID = 0;

export type ExternalRuntimeReservation = typeof externalRuntimeReservations.$inferSelect;

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

export async function claimRunWithExternalRuntimeSlot(
  db: Db,
  runId: string,
  claimedAt: Date,
  slotId = DEFAULT_EXTERNAL_RUNTIME_SLOT_ID,
): Promise<{
  run: typeof heartbeatRuns.$inferSelect;
  reservation: ExternalRuntimeReservation;
} | null> {
  const claimed = await db.transaction(async (tx) => {
    const run = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!run || run.status !== "queued") return null;

    let reservation = await tx
      .select()
      .from(externalRuntimeReservations)
      .where(and(
        eq(externalRuntimeReservations.runId, run.id),
        isNull(externalRuntimeReservations.releasedAt),
      ))
      .then((rows) => rows[0] ?? null);

    if (!reservation) {
      reservation = await tx
        .insert(externalRuntimeReservations)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          runId: run.id,
          slotId,
          state: "reserved",
          reservedAt: claimedAt,
          createdAt: claimedAt,
          updatedAt: claimedAt,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);
    }
    if (!reservation) return null;

    const updatedRun = await tx
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updatedRun) {
      throw new Error(`External runtime reservation ${reservation.id} could not claim queued run ${run.id}`);
    }
    return { run: updatedRun, reservation };
  });

  recordExternalRuntimeReservationEvent(claimed ? "reserved" : "contended");
  void refreshExternalRuntimeReservationMetrics(db, claimedAt).catch(() => undefined);
  return claimed;
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
    void refreshExternalRuntimeReservationMetrics(db, now).catch(() => undefined);
  }
  return reservation;
}

export async function recordExpectedExternalRuntimeJobName(
  db: Db,
  input: { runId: string; jobName: string; now?: Date },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const reservation = await db
    .update(externalRuntimeReservations)
    .set({ expectedJobName: input.jobName, updatedAt: now })
    .where(and(
      eq(externalRuntimeReservations.runId, input.runId),
      isNull(externalRuntimeReservations.releasedAt),
      eq(externalRuntimeReservations.state, "launching"),
      or(
        isNull(externalRuntimeReservations.expectedJobName),
        eq(externalRuntimeReservations.expectedJobName, input.jobName),
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

export async function recordExternalRuntimeJobIdentity(
  db: Db,
  input: { runId: string; jobName: string; jobUid?: string | null; now?: Date },
): Promise<ExternalRuntimeReservation | null> {
  const now = input.now ?? new Date();
  const existing = await getActiveExternalRuntimeReservation(db, input.runId);
  if (!existing) return null;
  if (!existing.expectedJobName) {
    throw new Error(`External runtime Job identity observed before an expected name was persisted for run ${input.runId}`);
  }
  if (
    (existing.expectedJobName && existing.expectedJobName !== input.jobName)
    || (existing.jobName && existing.jobName !== input.jobName)
    || (input.jobUid && existing.jobUid && existing.jobUid !== input.jobUid)
  ) {
    throw new Error(
      `External runtime Job identity mismatch for run ${input.runId}: `
      + `persisted ${existing.jobName ?? existing.expectedJobName ?? "<none>"}/${existing.jobUid ?? "<none>"}, `
      + `received ${input.jobName}/${input.jobUid ?? "<none>"}`,
    );
  }
  if (existing.state === "launched" && existing.jobName && (!input.jobUid || existing.jobUid === input.jobUid)) {
    return existing;
  }

  const reservation = await db
    .update(externalRuntimeReservations)
    .set({
      state: "launched",
      expectedJobName: sql`coalesce(${externalRuntimeReservations.expectedJobName}, ${input.jobName})`,
      jobName: input.jobName,
      jobUid: sql`coalesce(${externalRuntimeReservations.jobUid}, ${input.jobUid ?? null})`,
      launchedAt: sql`coalesce(${externalRuntimeReservations.launchedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
    })
    .where(and(
      eq(externalRuntimeReservations.runId, input.runId),
      isNull(externalRuntimeReservations.releasedAt),
      or(
        eq(externalRuntimeReservations.state, "launching"),
        eq(externalRuntimeReservations.state, "launched"),
      ),
      or(
        isNull(externalRuntimeReservations.expectedJobName),
        eq(externalRuntimeReservations.expectedJobName, input.jobName),
      ),
      or(isNull(externalRuntimeReservations.jobName), eq(externalRuntimeReservations.jobName, input.jobName)),
      input.jobUid
        ? or(isNull(externalRuntimeReservations.jobUid), eq(externalRuntimeReservations.jobUid, input.jobUid))
        : sql`true`,
    ))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!reservation) {
    const active = await getActiveExternalRuntimeReservation(db, input.runId);
    if (active && (
      active.expectedJobName !== input.jobName
      || active.jobName !== input.jobName
      || (input.jobUid && active.jobUid !== input.jobUid)
    )) {
      throw new Error(
        `External runtime Job identity mismatch for run ${input.runId}: `
        + `persisted ${active.jobName ?? "<none>"}/${active.jobUid ?? "<none>"}, `
        + `received ${input.jobName}/${input.jobUid ?? "<none>"}`,
      );
    }
    return active;
  }

  recordExternalRuntimeReservationEvent("launched");
  void refreshExternalRuntimeReservationMetrics(db, now).catch(() => undefined);
  return reservation;
}

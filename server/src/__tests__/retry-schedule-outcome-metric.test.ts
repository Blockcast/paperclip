import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  RETRY_SCHEDULE_OUTCOME_METRIC,
  __resetMetricsForTest,
  recordRetryScheduleOutcome,
  renderMetrics,
} from "../services/metrics.js";

/**
 * BLO-35472: `scheduleBoundedRetryForRun`'s decisions must be countable.
 *
 * The abandon branch is the reason this file exists. It deliberately creates no
 * retry row -- the owning routine's next scheduled fire takes the work -- so it
 * leaves nothing in `heartbeat_runs` for a row-counting query to find, and the
 * one fleet-visible retry metric (`paperclip_scheduled_retry_park_horizon_
 * seconds`) is a *max over live retries*, which mass abandonment drives DOWN.
 * A regression that silently drops every retry is therefore indistinguishable
 * from the backoff clamp working, on every instrument that existed before this
 * counter.
 *
 * Both arms are asserted together on purpose: `scheduled` is the denominator
 * that makes an abandon count readable as a *share*, and an abandon-only
 * assertion would pass just as well against a build that had stopped scheduling
 * retries entirely.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** Read one counter series out of the Prometheus exposition, 0 when absent. */
async function readOutcomeCount(outcome: string, retryReason: string): Promise<number> {
  const { body } = await renderMetrics();
  const line = body
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith(`${RETRY_SCHEDULE_OUTCOME_METRIC}{`) &&
        candidate.includes(`outcome="${outcome}"`) &&
        candidate.includes(`retry_reason="${retryReason}"`),
    );
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).pop());
}

describe("recordRetryScheduleOutcome", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("coerces an unknown outcome and reason to 'other' so cardinality stays bounded", async () => {
    // The heartbeat service exposes `scheduleBoundedRetry` publicly, so
    // `retryReason` is caller-supplied and is not ours to trust. An unbounded
    // label on a path that runs for every retry of every agent is the failure
    // mode this metric must not itself cause.
    const labels = recordRetryScheduleOutcome({
      outcome: "not_a_real_outcome",
      retryReason: "not_a_real_reason",
    });
    expect(labels).toEqual({ outcome: "other", retry_reason: "other" });

    const nullish = recordRetryScheduleOutcome({ outcome: null, retryReason: undefined });
    expect(nullish).toEqual({ outcome: "other", retry_reason: "other" });

    expect(await readOutcomeCount("other", "other")).toBe(2);
  });
});

describeEmbeddedPostgres("scheduleBoundedRetryForRun retry-schedule outcome metric", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retry-schedule-outcome-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    __resetMetricsForTest();
  });

  /**
   * A run owned by a 6h windowed routine, failing at `failedAt`.
   *
   * The window boundary is read through the origin `routineRuns` row rather
   * than the trigger's current `nextRunAt`, which has already advanced by the
   * time a delayed execution fails -- so the fixture pins it on the payload.
   */
  async function seedRoutineOwnedFailure(failedAt: Date) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const routineId = randomUUID();
    const routineRunId = randomUUID();
    const triggerId = randomUUID();
    const triggeredAt = new Date("2026-08-19T00:00:00.000Z");
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Retry Metric Test",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Six-hour routine",
      assigneeAgentId: agentId,
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      enabled: true,
      cronExpression: "0 */6 * * *",
      timezone: "UTC",
      nextRunAt: windowClosesAt,
    });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      triggerId,
      source: "schedule",
      status: "issue_created",
      triggeredAt,
      triggerPayload: { __paperclipRoutineWindowClosesAt: windowClosesAt.toISOString() },
      linkedIssueId: null,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Routine retry metric fixture",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
    });
    await db.update(routineRuns).set({ linkedIssueId: issueId }).where(eq(routineRuns.id, routineRunId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: failedAt,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
        errorFamily: "transient_upstream",
      },
      resultJson: { errorFamily: "transient_upstream" },
      updatedAt: failedAt,
      createdAt: failedAt,
    });

    return { sourceRunId };
  }

  it("counts a retry that is scheduled, and an abandoned one that persists no row", async () => {
    // Fails 19 minutes into the window: most of it remains, so a retry is
    // scheduled (clamped inside the window) and a row is written.
    const scheduledAt = new Date("2026-08-19T00:19:17.166Z");
    const { sourceRunId: scheduledRunId } = await seedRoutineOwnedFailure(scheduledAt);

    const scheduled = await heartbeat.scheduleBoundedRetry(scheduledRunId, {
      now: scheduledAt,
      random: () => 0,
    });
    expect(scheduled.outcome).toBe("scheduled");
    expect(await readOutcomeCount("scheduled", "transient_failure")).toBe(1);
    expect(await readOutcomeCount("routine_retry_abandoned", "transient_failure")).toBe(0);

    // Fails 1ms before the window closes. `targetMs = deadline - margin` is then
    // at or before the failure instant for any non-zero margin, so this abandons
    // regardless of how MIN_USEFUL_RETRY_MARGIN_MS is later re-tuned -- the
    // issue expects it to fall from ~79m to ~10-15m once dispatch lateness is
    // fixed, and this assertion must survive that.
    const abandonAt = new Date("2026-08-19T05:59:59.999Z");
    const { sourceRunId: abandonRunId } = await seedRoutineOwnedFailure(abandonAt);

    const abandoned = await heartbeat.scheduleBoundedRetry(abandonRunId, {
      now: abandonAt,
      random: () => 0,
    });
    expect(abandoned.outcome).toBe("not_scheduled");
    if (abandoned.outcome !== "not_scheduled") return;
    expect(abandoned.errorCode).toBe("routine_retry_abandoned");

    expect(await readOutcomeCount("routine_retry_abandoned", "transient_failure")).toBe(1);
    // The scheduled arm is untouched by the abandon, so the two series are an
    // honest numerator and denominator for the abandon share.
    expect(await readOutcomeCount("scheduled", "transient_failure")).toBe(1);

    // The decision is only visible in the counter: the abandon wrote no
    // `scheduled_retry` row, which is exactly why row-counting cannot see it.
    const retryRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, abandonRunId));
    expect(retryRows).toHaveLength(0);
  });
});

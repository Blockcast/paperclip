/**
 * PEN-5937: the FORWARD WRITER for `cost_events.attributed_project_id`.
 *
 * `costs/by-project` no longer rebuilds run->project attribution from `activity_log` at
 * read time; it reads `coalesce(project_id, attributed_project_id)`. Two things write
 * that column, and they must agree:
 *
 *   - `resolveLedgerScopeForRun` here, once per run at finalization (the writer), and
 *   - `repairCostEventProjectAttribution` in packages/db (the backfill).
 *
 * The backfill is covered by `cost-events-project-attribution-repair.test.ts`, and every
 * embedded-Postgres case in `costs-service.test.ts` populates the column THROUGH it. So
 * without this file the writer is untested, and a writer that silently stopped stamping
 * would still look green everywhere: rows would simply fall to the backfill, which runs
 * on an interval and would quietly paper over it until the aggregate reported a row in
 * its unattributed bucket (PEN-6084), rather than against the project that incurred it,
 * in the gap between the cost event and the next pass.
 *
 * The run here finalizes with a PROJECT-LESS context snapshot -- no `issueId`, no
 * `projectId` -- which is the case the whole row exists for: an agent that picked work up
 * mid-run has a scope visible only in the `activity_log` rows it wrote.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  repairCostEventProjectAttribution,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    resultJson: { ok: true } as Record<string, unknown>,
    provider: "anthropic",
    model: "claude-opus-5",
    costUsd: 1.25,
    usage: { inputTokens: 1_000, outputTokens: 500 },
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres write-time attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cost event write-time project attribution (PEN-5937)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cost-attribution-writer-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * A run with an EMPTY context snapshot, plus the activity it wrote against an issue
   * that belongs to a project. The activity row is inserted before the run executes,
   * which is what the production ordering gives finalization: the run logs its work and
   * only then is finalized.
   */
  // `issues.identifier` is globally unique, not company-scoped, so each seed needs its
  // own. The embedded database is shared across both cases in this file.
  let seedSeq = 0;

  async function seedProjectLessRun(options: { withActivity: boolean }) {
    const seq = ++seedSeq;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Attribution Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Attributor",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Picked Up Mid-Run",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Worked mid-run",
      status: "in_progress",
      priority: "medium",
      issueNumber: seq,
      identifier: `ATR-${seq}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      triggerDetail: "system",
      // The case under test: no issueId and no projectId. The run's scope exists only in
      // the activity it wrote.
      contextSnapshot: {},
      createdAt: new Date("2026-05-19T00:00:00.000Z"),
      updatedAt: new Date("2026-05-19T00:00:00.000Z"),
    });
    if (options.withActivity) {
      await db.insert(activityLog).values({
        companyId,
        runId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: issueId,
        details: {},
      });
    }
    return { companyId, agentId, projectId, issueId, runId };
  }

  async function ledgerRowForRun(runId: string) {
    return db
      .select({
        projectId: costEvents.projectId,
        issueId: costEvents.issueId,
        attributedProjectId: costEvents.attributedProjectId,
        attributedProjectAt: costEvents.attributedProjectAt,
      })
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("stamps attributed_project_id and the watermark when the run has no write-time project", async () => {
    const { projectId, runId } = await seedProjectLessRun({ withActivity: true });

    await heartbeat.__test_executeRunForTesting(runId);

    const row = await ledgerRowForRun(runId);
    expect(row).not.toBeNull();
    expect(row?.attributedProjectId).toBe(projectId);
    // The watermark is what tells the backfill this row is resolved. Without it the
    // repair would re-derive this row on every pass forever -- the `activity_log` read
    // this row exists to stop, back on a schedule.
    expect(row?.attributedProjectAt).not.toBeNull();

    // ⚠️ The derived value must NOT have leaked into the write-time scope.
    // `services/budgets.ts` enforces every `scopeType: "project"` policy on `project_id`,
    // so a writer that set both would silently widen what counts against a project's cap.
    expect(row?.projectId).toBeNull();
    expect(row?.issueId).toBeNull();

    // Writer and backfill agree: the backfill finds nothing left to do. If the writer
    // stamped a DIFFERENT project the backfill would still find nothing -- it keys on the
    // watermark -- which is exactly why the value is asserted above and not just the
    // count here.
    const repair = await repairCostEventProjectAttribution(db as never, { pauseMs: 0 });
    expect(repair.failedBatches).toBe(0);
    expect(repair.stamped).toBe(0);
  }, 120_000);

  it("stamps the watermark with a NULL project when the run touched no issue", async () => {
    const { runId } = await seedProjectLessRun({ withActivity: false });

    await heartbeat.__test_executeRunForTesting(runId);

    const row = await ledgerRowForRun(runId);
    expect(row).not.toBeNull();
    expect(row?.attributedProjectId).toBeNull();
    // "Resolved, and the answer was nothing" -- distinct from "never resolved", which is
    // the whole reason the watermark is a separate column. A writer that left this NULL
    // would hand the row to the backfill, which would re-derive it on every pass.
    expect(row?.attributedProjectAt).not.toBeNull();

    const repair = await repairCostEventProjectAttribution(db as never, { pauseMs: 0 });
    expect(repair.stamped).toBe(0);
  }, 120_000);
});

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  heartbeatService,
  UNCLAIMABLE_QUEUED_RUN_REAP_MIN_AGE_MS,
} from "../services/heartbeat.js";
import { getDepBlockedMetric, resetDepBlockedMetrics } from "../services/dep-blocked-metrics.js";

/**
 * PEN-4385 — end-to-end proof that an unclaimable `queued` run is reaped by
 * something OTHER than a claim.
 *
 * The sibling unit file pins which rows are eligible. This one pins the part
 * that no pure test can: that such a row actually LEAVES `status='queued'`
 * without any dispatch pass running, within a bounded time, and that the work
 * is not lost when the blocker clears.
 *
 * That last clause is the load-bearing one for the choice of disposition. The
 * reap cancels rather than parking, which is only safe because
 * `reconcileResolvedBlockerDependents` wakes the assignee once the blockers
 * resolve — exactly what the cancellation reason promises the reader. If that
 * promise ever stops being true, the reap becomes a silent work-dropper, so it
 * is asserted here rather than taken on faith from the message text.
 */

vi.mock("../services/gbrain-client-factory.js", async () => {
  const actual = await vi.importActual<typeof import("../services/gbrain-client-factory.js")>(
    "../services/gbrain-client-factory.js",
  );
  return {
    ...actual,
    createServerGbrainClient: vi.fn(() => ({ call: vi.fn(async () => ({ ok: true, result: null })) })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres unclaimable-queued-run reap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("reapUnclaimableQueuedRuns (PEN-4385)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unclaimable-queued-run-reap-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    resetDepBlockedMetrics();
    await cleanupHeartbeatTestState(db, heartbeat, {
      extraTruncateTables: ["issue_relations"],
      errorLabel: "unclaimable queued run reap test cleanup",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One company, one agent, one blocker issue and one issue blocked by it, plus
   * a `queued` run against the blocked issue that is already older than the
   * reap's grace window.
   */
  async function seedBlockedQueuedRun(options: {
    queuedAgeMs?: number;
    contextSnapshotExtra?: Record<string, unknown>;
    blockerStatus?: string;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const queuedAgeMs = options.queuedAgeMs ?? UNCLAIMABLE_QUEUED_RUN_REAP_MIN_AGE_MS + 60_000;
    const queuedAt = new Date(Date.now() - queuedAgeMs);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reap Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, intervalSec: 60 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Blocker",
        status: options.blockerStatus ?? "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const wakeup = await db
      .insert(agentWakeupRequests)
      .values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: blockedIssueId },
        status: "scheduled",
      })
      .returning()
      .then((rows) => rows[0]);

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        queuedAt,
        createdAt: queuedAt,
        wakeupRequestId: wakeup.id,
        contextSnapshot: {
          issueId: blockedIssueId,
          taskId: blockedIssueId,
          ...(options.contextSnapshotExtra ?? {}),
        },
      })
      .returning()
      .then((rows) => rows[0]);

    return { companyId, agentId, blockerIssueId, blockedIssueId, runId: run.id, wakeupId: wakeup.id };
  }

  const runStatus = async (runId: string) =>
    db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);

  it("cancels a dependency-blocked queued run without any claim", async () => {
    const seeded = await seedBlockedQueuedRun();

    // Nothing dispatches here. The whole defect is that the claim never comes,
    // so the reap is invoked directly and the row must still leave `queued`.
    const result = await heartbeat.reapUnclaimableQueuedRuns();

    expect(result.reaped).toBe(1);
    expect(result.failed).toBe(0);
    expect(await runStatus(seeded.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "issue_dependencies_blocked",
    });
    expect(getDepBlockedMetric("dep_blocked_queued_reaped")).toBe(1);
  });

  it("marks the run's wakeup request skipped, exactly as the claim path does", async () => {
    // The reap reuses `cancelQueuedRunForBlockedDependencies` whole rather than
    // writing its own teardown, so the wakeup must not be left `scheduled`
    // pointing at a cancelled run.
    const seeded = await seedBlockedQueuedRun();
    await heartbeat.reapUnclaimableQueuedRuns();

    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeupId))
      .then((rows) => rows[0]);
    expect(wakeup?.status).toBe("skipped");
  });

  it("leaves a run that has not yet served the grace window", async () => {
    const seeded = await seedBlockedQueuedRun({ queuedAgeMs: 30_000 });

    const result = await heartbeat.reapUnclaimableQueuedRuns();

    expect(result.reaped).toBe(0);
    expect((await runStatus(seeded.runId))?.status).toBe("queued");
  });

  it("leaves a dependency-ready queued run alone", async () => {
    // Same shape, but the blocker is already done, so nothing blocks the issue.
    const seeded = await seedBlockedQueuedRun({ blockerStatus: "done" });

    const result = await heartbeat.reapUnclaimableQueuedRuns();

    expect(result.reaped).toBe(0);
    // The REASON matters as much as the count: a row skipped because its issue
    // could not be read would also report `reaped: 0`, so asserting the count
    // alone would pass even if the issue lookup had silently broken.
    expect(result.skipped).toMatchObject({ claimable: 1 });
    expect((await runStatus(seeded.runId))?.status).toBe("queued");
  });

  it("spares an issue-interaction wake carrying a comment id", async () => {
    // The exemption with a person on the other end of it: a human commented on
    // a blocked issue and is waiting for the assignee to answer.
    const seeded = await seedBlockedQueuedRun({
      contextSnapshotExtra: {
        wakeReason: "issue_commented",
        wakeCommentId: randomUUID(),
      },
    });

    const result = await heartbeat.reapUnclaimableQueuedRuns();

    expect(result.reaped).toBe(0);
    expect(result.skipped).toMatchObject({ claimable: 1 });
    expect((await runStatus(seeded.runId))?.status).toBe("queued");
  });

  it("loses cleanly to a run that stopped being queued between read and write", async () => {
    // The out-of-band hazard the `requireQueued` CAS exists for: a dispatcher
    // on another replica claims the row mid-sweep. The reap must report a race
    // and leave the live run untouched, not cancel it.
    const seeded = await seedBlockedQueuedRun();
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.runId));

    const result = await heartbeat.reapUnclaimableQueuedRuns();

    expect(result.reaped).toBe(0);
    expect((await runStatus(seeded.runId))?.status).toBe("running");
  });

  it("wakes the assignee once the blockers resolve, so the reap does not drop the work", async () => {
    // The clause that makes cancelling (rather than parking) safe. Reap first,
    // then resolve the blocker and run the sweep that the cancellation reason
    // names — a fresh run for the same issue must appear.
    const seeded = await seedBlockedQueuedRun();
    await heartbeat.reapUnclaimableQueuedRuns();
    expect((await runStatus(seeded.runId))?.status).toBe("cancelled");

    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(issues.id, seeded.blockerIssueId));

    const swept = await heartbeat.reconcileResolvedBlockerDependents({
      companyId: seeded.companyId,
      // The sweep normally waits 5 min after a blocker completes to let the
      // edge-triggered wake land first; this test has no edge wake to wait for.
      minBlockerResolvedAgeMs: 0,
    });
    expect(swept.woken).toBe(1);

    const runsForIssue = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.contextIssueId, seeded.blockedIssueId));
    const successorRuns = runsForIssue.filter((row) => row.id !== seeded.runId);
    expect(successorRuns.length).toBeGreaterThan(0);
  });
});

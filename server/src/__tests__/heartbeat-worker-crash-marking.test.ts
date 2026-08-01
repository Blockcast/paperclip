import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres worker-crash-marking tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-19722: when the worker process dies mid-flight it takes the supervisor
// for every run it was tracking. Before this change nothing was written at
// crash time, so those runs sat `running` until a reaper noticed minutes later
// and reconciled them as `job_missing` — "External lifecycle Job is missing
// while heartbeat run is still running" (heartbeat.ts:15126-15135). That names
// the symptom (a Job we can no longer see) and hides the cause (this process
// died), sending operators to look at Kubernetes for our fault.
//
// These tests pin the crash-time marking: local runs this worker owned end up
// terminal, attributed to the crash, and retried through the process-loss path.
// External-lifecycle runs stay `running` so restart recovery can reattach to a
// still-healthy Kubernetes Job instead of discarding live work.
describeEmbeddedPostgres("heartbeat crash-time run marking (BLO-19722)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worker-crash-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    // runningProcesses is module-level and shared across service instances.
    runningProcesses.clear();
    // FK order: runs reference agents reference companies.
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(input: { adapterType: string; status?: string; externalRunId?: string | null }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "CrashTest Co",
      issuePrefix: `CR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CrashTestAgent",
      role: "engineer",
      status: "running",
      adapterType: input.adapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.status ?? "running",
        externalRunId: input.externalRunId ?? null,
        contextSnapshot: {},
      })
      .returning();
    return { companyId, agentId, runId: run!.id };
  }

  /** Registers a run as live in this worker, the way a dispatch would. */
  function markLiveInThisWorker(runId: string) {
    runningProcesses.set(runId, {
      child: { pid: 4242 } as never,
      graceSec: 5,
      processGroupId: null,
    });
  }

  it("marks an in-flight local run terminal with a reason naming the crash and queues a retry", async () => {
    const heartbeat = heartbeatService(db);
    const { runId, agentId } = await seedRun({
      adapterType: "codex_local",
    });
    markLiveInThisWorker(runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({
      reason: "uncaughtException: TypeError: Cannot read properties of null (reading 'write')",
    });

    expect(result.markedRunIds).toEqual([runId]);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    // Terminal, so the reaper never reaches the job_missing branch for it.
    expect(run!.status).toBe("interrupted");
    expect(run!.errorCode).toBe("worker_crashed");
    expect(run!.finishedAt).not.toBeNull();
    // The operator-visible reason must name the crash — this is the whole point.
    expect(run!.error).toContain("worker process crash");
    expect(run!.error).toContain("TypeError");
    expect(run!.error).not.toContain("job_missing");
    expect(run!.error).not.toContain("Job is missing");

    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry).toBeTruthy();
    expect(retry!.status).toBe("queued");
    expect(retry!.wakeupRequestId).toBeTruthy();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    // A worker crash is not the agent's fault. Releasing it to `idle` is the
    // same treatment the graceful SIGTERM drain gives an interrupted run
    // (heartbeat.ts drainRunningRunsForShutdown), so restart recovery can
    // reschedule it instead of an operator having to clear a bogus error.
    //
    // NB this deliberately diverges from the verifying signal originally
    // written on BLO-19722, which asked for a non-null `errorReason`. That was
    // drafted assuming we would keep the agent in `error` and only correct the
    // wording; reading finalizeAgentStatus (heartbeat.ts:14869-14878) shows
    // `interrupted` routes to `idle` and clears `errorReason` by design. Not
    // latching the agent at all is the stronger outcome, so the assertion is
    // "not misattributed" rather than "attributed differently".
    expect(agent!.status).toBe("idle");
    expect(agent!.errorReason ?? "").not.toContain("job_missing");
    expect(agent!.errorReason ?? "").not.toContain("Job is missing");
  });

  it("leaves in-flight external-lifecycle runs running for restart reattach", async () => {
    const heartbeat = heartbeatService(db);
    const { runId } = await seedRun({
      adapterType: "claude_k8s",
      externalRunId: "paperclip-run-abc123",
    });
    markLiveInThisWorker(runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({
      reason: "uncaughtException: TypeError: Cannot read properties of null (reading 'write')",
    });

    expect(result.markedRunIds).toEqual([]);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("running");
    expect(run!.errorCode).toBeNull();
    expect(run!.finishedAt).toBeNull();
  });

  it("leaves runs this worker did not own untouched", async () => {
    const heartbeat = heartbeatService(db);
    // Another worker's run, or one already handed off — marking it would strand
    // live work that this process was never supervising.
    const { runId } = await seedRun({ adapterType: "claude_k8s" });

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });

    expect(result.markedRunIds).toEqual([]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("running");
  });

  it("does not overwrite a run that already reached a terminal state", async () => {
    const heartbeat = heartbeatService(db);
    const { runId } = await seedRun({ adapterType: "claude_k8s", status: "succeeded" });
    // Still in the registry — a run can finish between the crash and our sweep.
    markLiveInThisWorker(runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });

    expect(result.markedRunIds).toEqual([]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("succeeded");
    expect(run!.errorCode).toBeNull();
  });

  it("marks every in-flight run the worker owned, not just the first", async () => {
    const heartbeat = heartbeatService(db);
    const first = await seedRun({ adapterType: "claude_k8s" });
    const second = await seedRun({ adapterType: "codex_local" });
    markLiveInThisWorker(first.runId);
    markLiveInThisWorker(second.runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "unhandledRejection: pool drained" });

    expect(result.markedRunIds.sort()).toEqual([first.runId, second.runId].sort());
  });

  it("is a no-op when the worker held no in-flight runs", async () => {
    const heartbeat = heartbeatService(db);

    // The common case for a crash during idle/boot — must not throw, since it
    // runs inside the crash handler where a throw costs us the exit path.
    await expect(
      heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" }),
    ).resolves.toEqual({ markedRunIds: [] });
  });
});

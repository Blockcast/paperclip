import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
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
    // FK order: events reference runs reference agents reference companies.
    // Crash marking appends a lifecycle event and enqueues a retry, so both
    // events and wakeup requests exist by the time a test finishes.
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
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
        // A dispatched run always carries this; the process-loss retry path
        // refuses to re-queue without it (`responsible_user_unresolved`), so
        // omitting it here would make the retry assertion vacuous.
        responsibleUserId: "crash-test-user",
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

  it("leaves an owned external-lifecycle run running before its Job id is stamped", async () => {
    const heartbeat = heartbeatService(db);
    // The pre-stamp window is real, not theoretical: executeRun registers a run
    // in the live-execution registry before it has even loaded the agent, and
    // external_run_id is only stamped later, best-effort, once a reap cycle
    // observes the backing Job. So a healthy claude_k8s run spends real time
    // owned-with-a-null-id. Terminalizing it here would queue a replacement
    // against a Job that is still running — duplicate execution of the same
    // run, which is worse than the orphaned row this guard exists to prevent.
    const { runId } = await seedRun({ adapterType: "claude_k8s", externalRunId: null });
    markLiveInThisWorker(runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });

    expect(result.markedRunIds).toEqual([]);

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("running");
    expect(run!.errorCode).toBeNull();
    expect(run!.finishedAt).toBeNull();
    // And no replacement was queued against the live Job.
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(0);
  });

  it("marks every in-flight run the worker owned, not just the first", async () => {
    const heartbeat = heartbeatService(db);
    const first = await seedRun({ adapterType: "claude_local" });
    const second = await seedRun({ adapterType: "codex_local" });
    markLiveInThisWorker(first.runId);
    markLiveInThisWorker(second.runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "unhandledRejection: pool drained" });

    expect(result.markedRunIds.sort()).toEqual([first.runId, second.runId].sort());
  });

  it("marks only the local runs when the worker owned a mix of adapters", async () => {
    const heartbeat = heartbeatService(db);
    const local = await seedRun({ adapterType: "codex_local" });
    const externalUnstamped = await seedRun({ adapterType: "claude_k8s", externalRunId: null });
    markLiveInThisWorker(local.runId);
    markLiveInThisWorker(externalUnstamped.runId);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });

    // A mixed batch must not let the local sweep drag an external run with it.
    expect(result.markedRunIds).toEqual([local.runId]);
    const [external] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, externalUnstamped.runId));
    expect(external!.status).toBe("running");
  });

  it("is a no-op when the worker held no in-flight runs", async () => {
    const heartbeat = heartbeatService(db);

    // The common case for a crash during idle/boot — must not throw, since it
    // runs inside the crash handler where a throw costs us the exit path.
    await expect(
      heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" }),
    ).resolves.toEqual({ markedRunIds: [] });
  });

  // The crash handler exits on a fixed budget, so the marking pass can be cut
  // off partway. Claim-then-recover is interleaved per run precisely so that a
  // run we never reach stays `running` and the orphan reaper still owns it —
  // the reaper only scans `running`, so a bulk pre-flip would have left every
  // unreached run terminal with no retry, no lock release and nothing able to
  // find it. `reconcileWorkerCrashedRuns` closes the one remaining window:
  // a run claimed just before the budget expired, whose cleanup never ran.
  describe("reconcileWorkerCrashedRuns (crash cut short mid-cleanup)", () => {
    /** A run the crash guard claimed but never got to recover. */
    async function seedClaimedButUnrecovered(overrides: { finishedAt?: Date } = {}) {
      const seeded = await seedRun({ adapterType: "codex_local", status: "interrupted" });
      await db
        .update(heartbeatRuns)
        .set({
          errorCode: "worker_crashed",
          error: "Interrupted by worker process crash (uncaughtException: TypeError)",
          finishedAt: overrides.finishedAt ?? new Date(),
        })
        .where(eq(heartbeatRuns.id, seeded.runId));
      return seeded;
    }

    it("finishes recovery for a crash-marked run whose cleanup never ran", async () => {
      const heartbeat = heartbeatService(db);
      const { runId, agentId } = await seedClaimedButUnrecovered();

      const result = await heartbeat.reconcileWorkerCrashedRuns();

      expect(result.reconciledRunIds).toEqual([runId]);

      // The load-bearing repair: without it this run is terminal, retry-less
      // and invisible to the reaper — dropped work, not just mis-attributed.
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retry).toBeTruthy();
      expect(retry!.status).toBe("queued");
      expect(result.retryRunIds).toEqual([retry!.id]);

      // Attribution is preserved, not rewritten to the reaper's symptom.
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run!.status).toBe("interrupted");
      expect(run!.errorCode).toBe("worker_crashed");
      expect(run!.error).not.toContain("Job is missing");

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agent!.status).toBe("idle");
    });

    it("does not queue a second retry for a run whose cleanup did complete", async () => {
      const heartbeat = heartbeatService(db);
      const { runId } = await seedClaimedButUnrecovered();

      // First pass stands in for the crash-time cleanup having succeeded.
      await heartbeat.reconcileWorkerCrashedRuns();
      const afterFirst = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(afterFirst).toHaveLength(1);

      // Re-running must be inert. This is what makes the pass safe to run at
      // every worker start without persisting a completion marker.
      const second = await heartbeat.reconcileWorkerCrashedRuns();
      expect(second.reconciledRunIds).toEqual([]);
      const afterSecond = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(afterSecond.map((row) => row.id)).toEqual(afterFirst.map((row) => row.id));
    });

    it("recovers a crash-marked run no matter how long it sat unrecovered", async () => {
      const heartbeat = heartbeatService(db);
      // These rows are terminal, so the orphan reaper (which only scans
      // `running`) can never find them — this pass is the only thing that
      // will. A wall-clock cutoff would not defer that work, it would abandon
      // it: an outage longer than the window, or one failed startup pass
      // followed by a day of uptime, would age the row out permanently while
      // its issue lock still points at a dead run.
      const { runId } = await seedClaimedButUnrecovered({
        finishedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      const result = await heartbeat.reconcileWorkerCrashedRuns();

      expect(result.reconciledRunIds).toEqual([runId]);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retries).toHaveLength(1);
      expect(retries[0]!.status).toBe("queued");
    });

    it("drains the oldest unrecovered runs first when a backlog exceeds the batch limit", async () => {
      const heartbeat = heartbeatService(db);
      // Bounding is by batch size, not by age, so the order has to be
      // deterministic for successive startups to make monotonic progress
      // instead of re-reading the same head of the backlog.
      const oldest = await seedClaimedButUnrecovered({
        finishedAt: new Date(Date.now() - 72 * 60 * 60 * 1000),
      });
      const newest = await seedClaimedButUnrecovered({
        finishedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
      });

      const first = await heartbeat.reconcileWorkerCrashedRuns({ maxRuns: 1 });
      expect(first.reconciledRunIds).toEqual([oldest.runId]);

      // The recovered run drops out of the candidate set via the retry
      // pre-filter, so the next pass advances rather than repeating.
      const second = await heartbeat.reconcileWorkerCrashedRuns({ maxRuns: 1 });
      expect(second.reconciledRunIds).toEqual([newest.runId]);
    });

    it("ignores terminal runs that were not attributed to a worker crash", async () => {
      const heartbeat = heartbeatService(db);
      // Another writer's terminal run — e.g. the reaper's process_lost mint,
      // which owns its own retry decision and must not be re-driven here.
      const { runId } = await seedRun({ adapterType: "codex_local", status: "failed" });
      await db
        .update(heartbeatRuns)
        .set({ errorCode: "process_lost", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));

      const result = await heartbeat.reconcileWorkerCrashedRuns();

      expect(result.reconciledRunIds).toEqual([]);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(retries).toHaveLength(0);
    });
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import { runningProcesses } from "../adapters/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres worker-crash-marking tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-19722 / BLO-20822: when the worker process dies mid-flight it takes the
// supervisor for every run it was tracking. Before this change nothing was
// written at crash time, so those runs sat `running` until a reaper noticed
// minutes later and reconciled them as `job_missing` — "External lifecycle Job
// is missing while heartbeat run is still running". That names the symptom (a
// Job we can no longer see) and hides the cause (this process died), sending
// operators to Kubernetes for a fault that was ours.
//
// These tests pin crash-time marking and the convergence properties of the
// startup reconciler: a single owner per run, replay of genuinely failed
// required steps, forward progress past permanently-failing rows, and refusal
// to overwrite a newer run's derived agent state.
describeEmbeddedPostgres("heartbeat worker-crash marking and recovery convergence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-worker-crash-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    // runningProcesses is module-level and shared across service instances.
    runningProcesses.clear();
    // FK order: events reference runs reference agents reference companies, and
    // reservations reference runs.
    await db.delete(heartbeatRunEvents);
    await db.delete(externalRuntimeReservations);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * An environment runtime whose lease release always throws — the "lease left
   * `active`" failure the recovery classification calls a *required* step.
   * Only `releaseRunLeases` is reached by these paths.
   */
  function failingEnvironmentRuntime(): HeartbeatEnvironmentRuntime {
    return {
      releaseRunLeases: async () => {
        throw new Error("environment provider unreachable");
      },
    } as unknown as HeartbeatEnvironmentRuntime;
  }

  function service(options: { environmentRuntime?: HeartbeatEnvironmentRuntime } = {}) {
    // skipQueuedRunDispatch keeps issue promotion from spawning background
    // executeRun work that would race this suite's delete-based cleanup.
    return heartbeatService(db, { skipQueuedRunDispatch: true, ...options });
  }

  async function seedCompanyAndAgent(input: { adapterType?: string; agentStatus?: string } = {}) {
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
      status: input.agentStatus ?? "running",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    errorCode?: string | null;
    error?: string | null;
    finishedAt?: Date | null;
    externalRunId?: string | null;
  }) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: input.status ?? "running",
        errorCode: input.errorCode ?? null,
        error: input.error ?? null,
        finishedAt: input.finishedAt ?? null,
        externalRunId: input.externalRunId ?? null,
        // A dispatched run always carries this; the process-loss retry path
        // refuses to re-queue without it (`responsible_user_unresolved`), so
        // omitting it would make every retry assertion vacuous.
        responsibleUserId: "crash-test-user",
        contextSnapshot: {},
      })
      .returning();
    return run!;
  }

  /** A run already claimed by a crash but whose recovery never completed. */
  async function seedCrashMarkedRun(input: {
    companyId: string;
    agentId: string;
    finishedAt: Date;
  }) {
    return insertRun({
      ...input,
      status: "interrupted",
      errorCode: "worker_crashed",
      error: "Interrupted by worker process crash (uncaughtException: boom)",
    });
  }

  /** Registers a run as live in this worker, the way a dispatch would. */
  function markLiveInThisWorker(runId: string) {
    runningProcesses.set(runId, {
      child: { pid: 4242 } as never,
      graceSec: 5,
      processGroupId: null,
    });
  }

  async function readRun(runId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return run!;
  }

  async function retriesOf(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  // ---- BLO-19722 AC 2 and 3 -------------------------------------------------

  it("marks an in-flight local run terminal with a reason naming worker death, not job_missing", async () => {
    const heartbeat = service();
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await insertRun({ companyId, agentId });
    markLiveInThisWorker(run.id);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({
      reason: "uncaughtException: TypeError: Cannot read properties of null (reading 'write')",
    });

    expect(result.markedRunIds).toEqual([run.id]);

    const marked = await readRun(run.id);
    // AC 2: terminal at crash time, so the reaper never reaches its
    // `job_missing` branch for this run at all.
    expect(marked.status).toBe("interrupted");
    expect(marked.errorCode).toBe("worker_crashed");
    expect(marked.finishedAt).not.toBeNull();
    // The operator-visible reason names the crash — the whole point of AC 2/3.
    expect(marked.error).not.toBeNull();
    expect(marked.error).toContain("worker process crash");
    expect(marked.error).toContain("TypeError");
    expect(marked.error).not.toContain("job_missing");
    expect(marked.error).not.toContain("Job is missing");
    // Recovery ran to completion, so the startup reconciler will not replay it.
    expect(marked.crashRecoveryCompletedAt).not.toBeNull();

    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.status).toBe("queued");

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    // AC 3, read as "the agent is no longer left in `error` misattributed to a
    // missing Job" (BLO-19722's own wording for this acceptance criterion).
    //
    // NB this deliberately diverges from the *verifying signal* phrasing that
    // asked for a non-null `errorReason`. `finalizeAgentStatus` routes the
    // `interrupted` outcome to `idle` and clears `errorReason` by design, and a
    // worker crash is not the agent's fault — latching it to `error` just to
    // have a non-null string there would make an operator clear a bogus error
    // before the agent could be rescheduled. Not latching at all is the
    // stronger outcome, so the assertion is "not misattributed", and the
    // divergence is called out on BLO-20822 rather than made silently.
    expect(agent!.status).toBe("idle");
    expect(agent!.errorReason ?? "").not.toContain("job_missing");
    expect(agent!.errorReason ?? "").not.toContain("Job is missing");
  });

  it("leaves in-flight external-lifecycle runs running for restart reattach", async () => {
    const heartbeat = service();
    const { companyId, agentId } = await seedCompanyAndAgent({ adapterType: "claude_k8s" });
    const run = await insertRun({ companyId, agentId, externalRunId: "paperclip-run-abc123" });
    markLiveInThisWorker(run.id);

    const result = await heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });

    expect(result.markedRunIds).toEqual([]);
    const untouched = await readRun(run.id);
    expect(untouched.status).toBe("running");
    expect(untouched.errorCode).toBeNull();
  });

  // ---- (a) claim ownership --------------------------------------------------

  it("produces exactly one retry and one completion marker when two replicas recover the same run", async () => {
    // Startup reconciliation runs on every replica, so this race is reachable
    // in normal operation: two API pods and the worker can all recover the same
    // crash-marked run concurrently. Two recoveries would mean duplicate
    // lifecycle events, duplicate agent finalization and duplicate issue
    // promotion for one failed execution.
    //
    // The overlap is forced rather than hoped for. Replica A parks inside its
    // environment-lease release — a step that runs *after* the claim — and
    // replica B does a complete pass while A is parked. That is exactly the
    // window a durable claim has to cover, and simply firing both replicas at
    // once does not reliably produce it.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    let releaseA: () => void;
    const parked = new Promise<void>((resolve) => { releaseA = resolve; });
    let enteredA: () => void;
    const hasParked = new Promise<void>((resolve) => { enteredA = resolve; });

    const replicaA = service({
      environmentRuntime: {
        releaseRunLeases: async () => {
          enteredA();
          await parked;
          return [];
        },
      } as unknown as HeartbeatEnvironmentRuntime,
    });
    const replicaB = service();

    const aPromise = replicaA.reconcileWorkerCrashedRuns();
    await hasParked;

    // B runs a full pass while A holds the claim mid-recovery.
    const b = await replicaB.reconcileWorkerCrashedRuns();
    releaseA!();
    const a = await aPromise;

    // B found the run claimed and did nothing at all.
    expect([...b.reconciledRunIds, ...b.unresolvedRunIds]).toEqual([]);
    expect(a.reconciledRunIds).toEqual([run.id]);

    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(1);

    const recovered = await readRun(run.id);
    expect(recovered.crashRecoveryCompletedAt).not.toBeNull();
    // One claim, so one attempt — not one per replica.
    expect(recovered.crashRecoveryAttempts).toBe(1);

    // The clearest duplicate-cleanup signal: the crash lifecycle line is
    // appended once to the parent run, not once per replica.
    const parentEvents = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id));
    expect(parentEvents.filter((event) => event.message?.includes("worker process crash"))).toHaveLength(1);
    // ...and every event still holds a distinct sequence number.
    const seqs = parentEvents.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);

    // And only one "queued automatic retry" line, not one per replica.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, retries[0]!.id));
    expect(events.filter((event) => event.message?.includes("Queued automatic retry"))).toHaveLength(1);
  });

  // ---- (b) failed required step replays ------------------------------------

  it("does not stamp completion when a required step fails, and replays it on the next pass", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    // Lease release throws, so the lease is left `active` — a required step.
    const broken = service({ environmentRuntime: failingEnvironmentRuntime() });
    const first = await broken.reconcileWorkerCrashedRuns();

    expect(first.reconciledRunIds).toEqual([]);
    expect(first.unresolvedRunIds).toEqual([run.id]);

    const afterFailure = await readRun(run.id);
    // Unresolved, and explicitly NOT stamped: stamping to drain the batch would
    // hide a run whose environment is still reserved.
    expect(afterFailure.crashRecoveryCompletedAt).toBeNull();
    expect(afterFailure.crashRecoveryAttempts).toBe(1);
    expect(afterFailure.crashRecoveryNextAttemptAt).not.toBeNull();
    expect(afterFailure.crashRecoveryLastError).toContain("environment_leases");

    // Next pass, once the backoff has elapsed and the provider is healthy again.
    const healthy = service();
    const second = await healthy.reconcileWorkerCrashedRuns({
      now: new Date(afterFailure.crashRecoveryNextAttemptAt!.getTime() + 1000),
    });

    expect(second.reconciledRunIds).toEqual([run.id]);
    const afterReplay = await readRun(run.id);
    expect(afterReplay.crashRecoveryCompletedAt).not.toBeNull();
    expect(afterReplay.crashRecoveryLastError).toBeNull();
  });

  // ---- (c) poison rows do not starve the batch ------------------------------

  it("recovers a newer run even when a permanently-failing row sits at the head of the batch", async () => {
    // Candidates are drained oldest-first in a capped batch. Before the backoff
    // state existed, a row whose required cleanup can never succeed sat at the
    // head of `asc(finished_at)` and consumed a slot on every pass forever, so
    // enough of them froze recovery of every newer run. maxRuns=1 makes that
    // cap bite with a single poison row.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const poison = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const newer = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 60_000),
    });

    // Pass 1: the poison row takes the only slot and fails its required step.
    const broken = service({ environmentRuntime: failingEnvironmentRuntime() });
    const first = await broken.reconcileWorkerCrashedRuns({ maxRuns: 1 });
    expect(first.unresolvedRunIds).toEqual([poison.id]);
    expect(await readRun(newer.id).then((r) => r.crashRecoveryCompletedAt)).toBeNull();

    // Pass 2: same clock, same cap, same still-broken provider. The poison row
    // is now behind its backoff deadline, so the slot goes to the newer run.
    const second = await broken.reconcileWorkerCrashedRuns({ maxRuns: 1 });
    expect(second.reconciledRunIds).not.toContain(poison.id);
    expect([...second.reconciledRunIds, ...second.unresolvedRunIds]).toEqual([newer.id]);

    // The poison row is still unresolved — never falsely marked complete.
    const stuck = await readRun(poison.id);
    expect(stuck.crashRecoveryCompletedAt).toBeNull();
    expect(stuck.crashRecoveryAttempts).toBe(1);
  });

  // ---- (d) stale replay cannot overwrite a newer run's agent status ---------

  it("leaves a newer run's derived agent status intact when a stale replay lands", async () => {
    // The agent is seeded in a state only a *newer* run could have produced: a
    // later run failed and latched it to `error` with its own reason. A stale
    // replay of the day-old crash-marked run must not overwrite that.
    //
    // Seeding `error` (rather than `running`) is what makes this test
    // discriminating. Without the ownership guard, `finalizeAgentStatus`
    // derives its status from a live running-run count and writes
    // unconditionally — so it would flip this agent to `running` and null the
    // reason, silently replacing the newer run's outcome with a day-old one.
    const { companyId, agentId } = await seedCompanyAndAgent({ agentStatus: "error" });
    await db
      .update(agents)
      .set({ errorReason: "newer run failed: provider rejected the request" })
      .where(eq(agents.id, agentId));

    const stale = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    // A newer run for the same agent, still live.
    await insertRun({ companyId, agentId, status: "running" });

    const heartbeat = service();
    await heartbeat.reconcileWorkerCrashedRuns();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.status).toBe("error");
    expect(agent!.errorReason).toContain("newer run failed");

    // And the stale run is still considered recovered, so it does not come back
    // every startup trying to clobber the newer run again.
    expect(await readRun(stale.id).then((r) => r.crashRecoveryCompletedAt)).not.toBeNull();
  });

  it("treats a superseded agent finalization as complete rather than replaying forever", async () => {
    // A paused agent is the deterministic `superseded` case: finalizeAgentStatus
    // refuses to touch paused/terminated agents. That is an intentional
    // no-write, not a failure, so recovery must still stamp — otherwise the row
    // is replayed at every startup for as long as the agent stays paused.
    const { companyId, agentId } = await seedCompanyAndAgent({ agentStatus: "paused" });
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    const heartbeat = service();
    const result = await heartbeat.reconcileWorkerCrashedRuns();

    expect(result.reconciledRunIds).toEqual([run.id]);
    expect(await readRun(run.id).then((r) => r.crashRecoveryCompletedAt)).not.toBeNull();

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.status).toBe("paused");
  });
});

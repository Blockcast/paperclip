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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
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
    // FK order: issues reference runs and companies; events reference runs
    // reference agents reference companies; reservations reference runs.
    await db.delete(issues);
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

  function service(options: {
    environmentRuntime?: HeartbeatEnvironmentRuntime;
    beforeProcessLossRetryEnqueueForTest?: (run: typeof heartbeatRuns.$inferSelect) => Promise<void> | void;
    afterRunEventAppendedInTransactionForTest?: (run: typeof heartbeatRuns.$inferSelect) => Promise<void> | void;
    workerCrashRecoveryProviderTimeoutMsForTest?: number;
  } = {}) {
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

  // ---- (e) a stale recovery's terminal write cannot clobber a fresher claim -

  it("does not let a stale recovery's terminal write clobber a fresher claim's bookkeeping", async () => {
    // The durable claim (test (a) above) prevents two replicas from recovering
    // the same run *concurrently*. It does not, by itself, protect the two
    // terminal writes that follow it: recovery makes an unbounded provider RPC,
    // so a call that outlives its own claim lease can still be mid-flight when
    // a fresher claim has already won the row and moved it forward. Before
    // BLO-20822's CAS fix, both terminal writes were unconditional
    // `where(eq(id, run.id))`, so whichever call's write lands *last* wins —
    // even a stale one whose lease has long since expired.
    //
    // Replica A is parked (healthy otherwise) past its own lease. While it is
    // parked, replica B reclaims the row (the lease has expired) and fails a
    // required step, correctly leaving the row unresolved with a backoff. A is
    // then released and finishes successfully, and attempts its own terminal
    // "complete" write — which must lose to B's fresher bookkeeping rather than
    // falsely marking a genuinely-unresolved run complete.
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
    const replicaB = service({ environmentRuntime: failingEnvironmentRuntime() });

    const t0 = new Date();
    const aPromise = replicaA.reconcileWorkerCrashedRuns({ now: t0, maxRuns: 1 });
    await hasParked;

    // A has claimed by now; read back the lease it claimed so B's `now` is
    // guaranteed past it regardless of the exact TTL constant.
    const claimedByA = await readRun(run.id);
    expect(claimedByA.crashRecoveryNextAttemptAt).not.toBeNull();
    const t1 = new Date(claimedByA.crashRecoveryNextAttemptAt!.getTime() + 1000);

    const b = await replicaB.reconcileWorkerCrashedRuns({ now: t1, maxRuns: 1 });
    expect(b.unresolvedRunIds).toEqual([run.id]);
    const afterB = await readRun(run.id);
    expect(afterB.crashRecoveryCompletedAt).toBeNull();
    expect(afterB.crashRecoveryLastError).toContain("environment_leases");
    const bBackoffLease = afterB.crashRecoveryNextAttemptAt;
    expect(bBackoffLease).not.toBeNull();

    releaseA!();
    const a = await aPromise;
    // A completed every step locally, but its terminal write lost the CAS —
    // it must not report a completion the persisted row does not reflect.
    expect(a.reconciledRunIds).toEqual([]);

    const final = await readRun(run.id);
    // The core regression assertion: B's real "still unresolved" finding must
    // survive A's late, stale write. Pre-fix this is stamped non-null instead,
    // permanently hiding a run whose environment lease was never released.
    expect(final.crashRecoveryCompletedAt).toBeNull();
    expect(final.crashRecoveryLastError).toContain("environment_leases");
    expect(final.crashRecoveryNextAttemptAt?.getTime()).toBe(bBackoffLease!.getTime());
  });

  // ---- (f) a failed retry enqueue must not release the issue lock early ----

  it("does not release the issue execution lock when retry enqueue fails, and releases it once retry succeeds", async () => {
    // `enqueueProcessLossRetry` failing outright (not `suppressed`, a thrown
    // error) is REQUIRED and leaves the whole recovery incomplete. Before
    // BLO-20822, the issue-release branch keyed only on `!retry` — true for
    // both "suppressed" and "threw" — so a failed enqueue still released and
    // promoted the issue's execution lock. A different agent could then claim
    // the issue before the retry that was supposed to own it existed.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: "11111111-1111-1111-1111-111111111111" } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: "11111111-1111-1111-1111-111111111111",
      companyId,
      title: "Crash-recovery lock test issue",
      status: "in_progress",
      executionRunId: run.id,
      executionLockedAt: new Date(Date.now() - 60_000),
    });

    const failing = service({
      beforeProcessLossRetryEnqueueForTest: async () => {
        throw new Error("enqueue RPC unreachable");
      },
    });
    const first = await failing.reconcileWorkerCrashedRuns();

    expect(first.reconciledRunIds).toEqual([]);
    expect(first.unresolvedRunIds).toEqual([run.id]);
    const afterFailure = await readRun(run.id);
    expect(afterFailure.crashRecoveryCompletedAt).toBeNull();
    expect(afterFailure.crashRecoveryLastError).toContain("retry_enqueue");
    expect(await retriesOf(run.id)).toHaveLength(0);

    // The lock must still be held by the original run — not released, and not
    // yet re-pointed at a retry that does not exist.
    const [issueAfterFailure] = await db.select().from(issues).where(eq(issues.id, "11111111-1111-1111-1111-111111111111"));
    expect(issueAfterFailure!.executionRunId).toBe(run.id);

    // Next pass, enqueue succeeds: the whole recovery (including the
    // previously-skipped release) replays and completes.
    const healthy = service();
    const second = await healthy.reconcileWorkerCrashedRuns({
      now: new Date(afterFailure.crashRecoveryNextAttemptAt!.getTime() + 1000),
    });

    expect(second.reconciledRunIds).toEqual([run.id]);
    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(1);
    const [issueAfterRecovery] = await db.select().from(issues).where(eq(issues.id, "11111111-1111-1111-1111-111111111111"));
    // The retry re-points the lock at itself (enqueueProcessLossRetry's own
    // update), not a bare release — the point under test is only that this
    // did not happen prematurely on the failed pass above.
    expect(issueAfterRecovery!.executionRunId).toBe(retries[0]!.id);
  });

  // ---- (g) the one unbounded call cannot outlive the claim lease -----------

  it("bounds the provider lease release so recovery cannot run past its own claim", async () => {
    // The compare-and-set on the terminal writes (test (e)) makes an overrun
    // *safe*; this bound is what makes it rare. Recovery's only call that
    // leaves the database is the environment-lease release, and it has no
    // inherent timeout — a provider that hangs would hold a recovery open past
    // `WORKER_CRASH_RECOVERY_CLAIM_TTL_MS` and let a second replica in. A
    // timeout turns that into an ordinary incomplete required step: backed
    // off, not stamped, replayed later.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    let releaseHungCall: () => void;
    const hungCall = new Promise<never[]>((resolve) => {
      // Resolved in `finally` so the abandoned promise cannot outlive the test
      // and leak into a later one.
      releaseHungCall = () => resolve([]);
    });

    const heartbeat = service({
      environmentRuntime: { releaseRunLeases: () => hungCall } as unknown as HeartbeatEnvironmentRuntime,
      workerCrashRecoveryProviderTimeoutMsForTest: 50,
    });

    try {
      const result = await heartbeat.reconcileWorkerCrashedRuns();

      // Pre-fix this call never returns — the assertion below is only
      // reachable because the release is bounded.
      expect(result.unresolvedRunIds).toEqual([run.id]);
      expect(result.reconciledRunIds).toEqual([]);

      const after = await readRun(run.id);
      expect(after.crashRecoveryCompletedAt).toBeNull();
      expect(after.crashRecoveryLastError).toContain("environment_leases");
      expect(after.crashRecoveryLastError).toContain("50ms");
    } finally {
      releaseHungCall!();
    }
  });

  // ---- (h) a rolled-back event append must not escape to subscribers -------

  it("does not publish a run event whose transaction rolled back", async () => {
    // `appendRunEvent` used to publish the live event and mutate runtime
    // progress inline, while the caller's transaction was still open. If that
    // transaction then rolled back, subscribers had already been handed an
    // event for a row that never became visible. Publication is now a closure
    // the atomic-seq caller invokes only after commit.
    //
    // The hook below throws *after* a successful insert — the only ordering
    // that distinguishes the two designs. An insert that fails on its own
    // never reached the old publish call either, so it would not discriminate.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    // Scoped to this run: recovery also enqueues a *retry* run, whose own
    // "queued automatic retry" event is appended on a pooled, autocommitting
    // executor and is published correctly. The rolled-back append under test
    // is the crash lifecycle line on `run` itself.
    const published: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; message?: string };
      if (event.type === "heartbeat.run.event" && payload.runId === run.id) {
        published.push(payload.message ?? "");
      }
    });

    try {
      const heartbeat = service({
        afterRunEventAppendedInTransactionForTest: () => {
          throw new Error("commit interrupted");
        },
      });
      // Recovery treats the lifecycle append as best-effort, so this resolves
      // rather than throwing; the assertions are about what escaped, not about
      // recovery's own outcome.
      await heartbeat.reconcileWorkerCrashedRuns();

      expect(published).toEqual([]);
      const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(rows).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  // ---- (i) a transient agent-load failure must not release the issue lock ---

  it("does not release the issue execution lock when the agent load fails transiently", async () => {
    // Sibling of (f), one step earlier in the same recovery. A thrown
    // `getAgent` leaves `agent` null, so the retry-enqueue block never runs:
    // `retry` is null but `retryEnqueueIncomplete` is false. Keying the
    // release on `!retry` alone therefore dropped the issue's execution lock
    // even though a retry is still owed and the replay will create one — the
    // same detached-retry-beside-promoted-work hazard (f) covers, reached by a
    // different path and NOT caught by (f)'s assertions.
    const issueId = "22222222-2222-2222-2222-222222222222";
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Crash-recovery agent-load lock test issue",
      status: "in_progress",
      executionRunId: run.id,
      executionLockedAt: new Date(Date.now() - 60_000),
    });

    const failing = service({
      beforeCrashRecoveryAgentLoadForTest: () => {
        throw new Error("agent read timed out");
      },
    });
    const first = await failing.reconcileWorkerCrashedRuns();

    expect(first.reconciledRunIds).toEqual([]);
    expect(first.unresolvedRunIds).toEqual([run.id]);
    const afterFailure = await readRun(run.id);
    expect(afterFailure.crashRecoveryCompletedAt).toBeNull();
    expect(afterFailure.crashRecoveryLastError).toContain("agent_load");
    expect(await retriesOf(run.id)).toHaveLength(0);

    // The assertion that fails pre-fix: the lock is still the original run's,
    // not released to a fresh checkout that would race the owed retry.
    const [issueAfterFailure] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfterFailure!.executionRunId).toBe(run.id);

    // Replay with a healthy agent load: the retry is created and takes the lock.
    const healthy = service();
    const second = await healthy.reconcileWorkerCrashedRuns({
      now: new Date(afterFailure.crashRecoveryNextAttemptAt!.getTime() + 1000),
    });

    expect(second.reconciledRunIds).toEqual([run.id]);
    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(1);
    const [issueAfterRecovery] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfterRecovery!.executionRunId).toBe(retries[0]!.id);
  });

  // ---- (j) a failed terminal write must report the run unresolved ----------

  it("reports the run unresolved when the terminal bookkeeping write itself fails", async () => {
    // Every recovery step can succeed and the recovery still not be durable:
    // if the final completion UPDATE throws, `crash_recovery_completed_at`
    // stays null. The catch used to swallow that and return `completed: true`,
    // so the caller logged the run as reconciled while the row remained a
    // candidate — a reconciliation that never happened, reported as done.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    const heartbeat = service({
      beforeCrashRecoveryTerminalWriteForTest: () => {
        throw new Error("connection terminated during completion write");
      },
    });
    const result = await heartbeat.reconcileWorkerCrashedRuns();

    // Pre-fix this run appears in reconciledRunIds despite nothing persisting.
    expect(result.reconciledRunIds).toEqual([]);
    expect(result.unresolvedRunIds).toEqual([run.id]);
    expect(await readRun(run.id).then((r) => r.crashRecoveryCompletedAt)).toBeNull();
  });

  // ---- (k) ownership is decided by finish order, not creation order --------

  it("leaves the agent status of an older-created but later-finished run intact", async () => {
    // The gap (d) does not cover. (d)'s newer run is created *after* the
    // crash-marked owner, which the original guard's `created_at >
    // owner.created_at` conjunct happened to catch. An overlapping run that
    // started BEFORE the owner and outlived it is equally the current owner of
    // the agent's derived state, but fails that creation-order test — so the
    // whole NOT EXISTS found nothing and the stale replay wrote anyway.
    const { companyId, agentId } = await seedCompanyAndAgent({ agentStatus: "error" });
    await db
      .update(agents)
      .set({ errorReason: "overlapping run failed: provider rejected the request" })
      .where(eq(agents.id, agentId));

    // Created first, finished last.
    const overlapping = await insertRun({ companyId, agentId, status: "failed" });
    const stale = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    // Pin both orderings explicitly rather than relying on insert timing:
    // overlapping.created_at < stale.created_at (so the old conjunct excludes
    // it) and overlapping.finished_at > stale.finished_at (so it genuinely
    // owns the derived state).
    const staleFinishedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000), finishedAt: new Date(Date.now() - 60_000) })
      .where(eq(heartbeatRuns.id, overlapping.id));
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(Date.now() - 36 * 60 * 60 * 1000), finishedAt: staleFinishedAt })
      .where(eq(heartbeatRuns.id, stale.id));

    const heartbeat = service();
    await heartbeat.reconcileWorkerCrashedRuns();

    // Pre-fix: flipped to `idle` with errorReason nulled, silently discarding
    // the overlapping run's outcome.
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent!.status).toBe("error");
    expect(agent!.errorReason).toContain("overlapping run failed");

    // Declining to write is a `superseded` finalization, not a failure, so the
    // run is still stamped and does not replay at every startup.
    expect(await readRun(stale.id).then((r) => r.crashRecoveryCompletedAt)).not.toBeNull();
  });
});

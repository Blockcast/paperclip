import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
    beforeCrashRecoveryTerminalWriteForTest?: (run: typeof heartbeatRuns.$inferSelect) => Promise<void> | void;
    beforeCrashRecoveryAgentLoadForTest?: (run: typeof heartbeatRuns.$inferSelect) => Promise<void> | void;
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

  it("marks every owned run before recovering any of them, so a stalled first recovery cannot strand the rest", async () => {
    // AC 2's actual failure mode, and the reason marking and recovery are two
    // phases rather than one interleaved loop. The crash guard races a fixed
    // exit budget, and a single `recoverCrashInterruptedRun` can spend minutes
    // of it in one provider release. Pre-fix the loop was
    // mark→recover→mark→recover, so the FIRST slow recovery consumed the budget
    // and every later run was still `running` when the process died — later
    // reconciled as `job_missing`, which is exactly the misattribution this
    // issue exists to eliminate. Restoring the interleaved loop fails this:
    // `second` reads `running` / errorCode null.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const first = await insertRun({ companyId, agentId });
    const second = await insertRun({ companyId, agentId });
    markLiveInThisWorker(first.id);
    markLiveInThisWorker(second.id);

    // Stand in for the dying process's budget: the first recovery to run never
    // returns, so nothing sequenced after it can execute.
    let stalledRunId: string | null = null;
    const heartbeat = service({
      beforeCrashRecoveryTerminalWriteForTest: async (run) => {
        if (stalledRunId === null) {
          stalledRunId = run.id;
          await new Promise(() => {});
        }
      },
    });

    const marking = heartbeat.markRunsInterruptedByWorkerCrash({ reason: "uncaughtException: boom" });
    // Deliberately NOT awaited. In production this call does not get to finish:
    // the crash guard races it against a fixed exit budget and the process dies
    // mid-flight. What has to be true at that moment is that the marks are
    // already COMMITTED — so that is what this polls for, while recovery is
    // still wedged. Awaiting `marking` here would hang forever, which is
    // precisely the budget-consuming stall being simulated.
    marking.catch(() => {});
    const deadline = Date.now() + 10_000;
    let bothMarked = false;
    while (Date.now() < deadline) {
      const rows = await Promise.all([readRun(first.id), readRun(second.id)]);
      if (rows.every((row) => row.status === "interrupted")) {
        bothMarked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(bothMarked).toBe(true);

    // Both rows carry crash attribution, not just the one that got to recover.
    for (const runId of [first.id, second.id]) {
      const marked = await readRun(runId);
      expect(marked.status).toBe("interrupted");
      expect(marked.errorCode).toBe("worker_crashed");
      expect(marked.error).toContain("worker process crash");
      expect(marked.error).not.toContain("job_missing");
    }

    // And the stall was real — one row genuinely never finished recovering, so
    // this passed because of the phase split and not because nothing blocked.
    // The hook fires later than the marks by construction (it sits at the
    // terminal write, deep inside phase 2), so it gets its own wait.
    const stallDeadline = Date.now() + 10_000;
    while (stalledRunId === null && Date.now() < stallDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(stalledRunId).not.toBeNull();
    const stalled = await readRun(stalledRunId!);
    expect(stalled.crashRecoveryCompletedAt).toBeNull();
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

  // ---- (l) each claim's lease is measured from its own claim time -----------

  it("gives every claim in a batch a lease and backoff measured from its own claim time", async () => {
    // `reconcileWorkerCrashedRuns` drains its batch serially, and a single row
    // can sit for minutes inside the (bounded) provider release. Pre-fix the
    // whole batch shared one batch-start `now`: every claim's lease was
    // `batchStart + TTL`, so by the time a later row was claimed its lease was
    // mostly — or entirely — spent. A peer replica scanning at that moment sees
    // an expired lease and reclaims a run this pass still owns, which is exactly
    // the double-recovery the durable claim exists to prevent. The same stale
    // timestamp also shortened the failure backoff by the batch's elapsed time.
    //
    // Two runs, and an 11-minute stall charged to the first one — longer than
    // the 10-minute TTL, so pre-fix the second run's lease is already in the
    // past at the instant it is claimed.
    const TTL_MS = 10 * 60 * 1000;
    const BACKOFF_BASE_MS = 5 * 60 * 1000;
    const STALL_MS = 11 * 60 * 1000;

    const { companyId, agentId } = await seedCompanyAndAgent();
    const older = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const newer = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 60_000),
    });

    const batchStart = new Date("2026-08-02T12:00:00.000Z");
    let current = new Date(batchStart);
    const clock = () => new Date(current);

    // What each run's lease looked like at the moment it was about to write its
    // terminal bookkeeping, paired with the clock reading at that same moment.
    // The hook fires after the claim and before the terminal write, and nothing
    // else moves this clock, so the paired reading *is* that run's claim time.
    const observed = new Map<string, { lease: Date | null; at: Date }>();

    // Lease release throws, so every run leaves a required step incomplete and
    // takes the backoff branch — which keeps `crashRecoveryNextAttemptAt`
    // readable afterwards instead of being nulled by a completion stamp.
    const heartbeat = service({
      environmentRuntime: failingEnvironmentRuntime(),
      beforeCrashRecoveryTerminalWriteForTest: async (run) => {
        observed.set(run.id, {
          lease: await readRun(run.id).then((r) => r.crashRecoveryNextAttemptAt),
          at: clock(),
        });
        current = new Date(current.getTime() + STALL_MS);
      },
    });

    // `budgetMs` is raised past this scenario's simulated stalls on purpose:
    // this test is about per-claim clock isolation, and each row here burns
    // STALL_MS (11 min) by design. Under the default wall-clock budget the
    // second row would — correctly — never be reached, which is the property
    // the dedicated budget test below asserts. Leaving the default here would
    // silently convert this into a one-row test that could no longer catch the
    // shared-clock regression it exists for.
    const result = await heartbeat.reconcileWorkerCrashedRuns({
      now: clock,
      budgetMs: 60 * 60 * 1000,
    });
    expect(result.unresolvedRunIds).toEqual([older.id, newer.id]);
    expect(result.budgetExhausted).toBe(false);

    // The property that matters: every claim owns its row for a full TTL from
    // the moment it claimed it. Pre-fix the newer run scored -1 minute here.
    for (const runId of [older.id, newer.id]) {
      const seen = observed.get(runId);
      expect(seen?.lease).not.toBeNull();
      expect(seen!.lease!.getTime() - seen!.at.getTime()).toBe(TTL_MS);
    }

    // And the backoff runs from the write, not from batch start, so a row that
    // just burned eleven minutes failing does not become re-eligible early.
    const afterOlder = await readRun(older.id);
    const afterNewer = await readRun(newer.id);
    expect(afterOlder.crashRecoveryNextAttemptAt!.getTime()).toBe(
      batchStart.getTime() + STALL_MS + BACKOFF_BASE_MS,
    );
    // Pre-fix both rows backed off to the identical batchStart + base instant.
    expect(afterNewer.crashRecoveryNextAttemptAt!.getTime()).toBe(
      batchStart.getTime() + 2 * STALL_MS + BACKOFF_BASE_MS,
    );
  });

  // ---- wall-clock budget bounds the drain ---------------------------------

  it("stops draining candidates once the wall-clock budget is spent, leaving the rest claimable", async () => {
    // The batch cap bounds ROWS; only a time budget bounds LATENCY. Each row can
    // sit in a provider release for minutes, and startup runs this pass ahead of
    // external reattachment, orphan reaping and queued-run resumption — so an
    // unbounded drain during a provider outage starves all of them for hours.
    // Reverting the deadline check in `reconcileWorkerCrashedRuns` makes this
    // fail: both rows get processed and `budgetExhausted` reads false.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const older = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const newer = await seedCrashMarkedRun({
      companyId,
      agentId,
      finishedAt: new Date(Date.now() - 60_000),
    });

    let current = new Date("2026-08-02T12:00:00.000Z");
    const clock = () => new Date(current);
    const BUDGET_MS = 5 * 60 * 1000;
    // One row overshoots the whole budget on its own — the provider-outage shape.
    const SLOW_ROW_MS = BUDGET_MS + 60_000;

    const heartbeat = service({
      environmentRuntime: failingEnvironmentRuntime(),
      beforeCrashRecoveryTerminalWriteForTest: async () => {
        current = new Date(current.getTime() + SLOW_ROW_MS);
      },
    });

    const result = await heartbeat.reconcileWorkerCrashedRuns({
      now: clock,
      budgetMs: BUDGET_MS,
    });

    // Oldest-first: the older row is the one that got in before the budget went.
    expect(result.unresolvedRunIds).toEqual([older.id]);
    expect(result.budgetExhausted).toBe(true);

    // Deferred, not abandoned. The untouched row keeps a null completion marker
    // and an unclaimed backoff field, so the next pass finds it as a candidate.
    const skipped = await readRun(newer.id);
    expect(skipped.crashRecoveryCompletedAt).toBeNull();
    expect(skipped.crashRecoveryAttempts ?? 0).toBe(0);
  });

  // ---- (i) a failed REQUIRED pre-retry step must stop the retry ------------

  it("does not queue a retry while required pre-retry cleanup is still incomplete", async () => {
    // `wakeup_cancel` and `environment_leases` each retire a claim the dead run
    // still holds on a resource the retry is about to take over. Recording them
    // `incomplete` withholds the completion marker, but a withheld marker only
    // schedules a replay — it does not retract a retry that has already been
    // created. So before this fix, a lease left `active` (or a wakeup left
    // `queued`) still produced a replacement run: queued against an environment
    // the dead run had not released, and racing a wake that was still runnable.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    const issueId = "33333333-3333-3333-3333-333333333333";
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-retry cleanup gate issue",
      status: "in_progress",
      executionRunId: run.id,
      executionLockedAt: new Date(Date.now() - 60_000),
    });

    const broken = service({ environmentRuntime: failingEnvironmentRuntime() });
    const first = await broken.reconcileWorkerCrashedRuns();

    expect(first.reconciledRunIds).toEqual([]);
    expect(first.unresolvedRunIds).toEqual([run.id]);
    const afterFailure = await readRun(run.id);
    expect(afterFailure.crashRecoveryLastError).toContain("environment_leases");
    // The load-bearing assertion: no replacement run exists yet.
    expect(await retriesOf(run.id)).toHaveLength(0);
    // And the issue lock is still the original run's — not released, and not
    // handed to a retry that was deliberately not created.
    const [issueAfterFailure] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfterFailure!.executionRunId).toBe(run.id);

    // Once the provider is healthy the replay creates the retry exactly once.
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

  // ---- (j) the stale-lock sweeper racing the issue-lock hand-over ----------

  it("does not create a retry after the sweeper cleared the issue lock", async () => {
    // `sweepStaleIssueLocks` treats a lock held by a terminal run as cleanable,
    // and a crash-marked run is `interrupted` — terminal for the whole duration
    // of its own recovery. Run concurrently with reconciliation it can clear the
    // lock in the window between terminalizing the run and handing the lock to
    // the retry. That hand-over is a guarded UPDATE
    // (`execution_run_id = <original run>`), so it silently matches zero rows.
    // A retry created after that point cannot own the issue and must not become
    // a detached runnable path.
    //
    // Forced overlap rather than hopeful concurrency: clearing the lock from the
    // pre-enqueue hook lands it exactly in the window, every run.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    const issueId = "44444444-4444-4444-4444-444444444444";
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Sweeper overlap issue",
      status: "in_progress",
      checkoutRunId: run.id,
      executionRunId: run.id,
      executionLockedAt: new Date(Date.now() - 60_000),
    });

    let sweptOnce = false;
    const raced = service({
      beforeProcessLossRetryEnqueueForTest: async () => {
        if (sweptOnce) return;
        sweptOnce = true;
        // Stand in for the sweeper clearing this terminal run's execution lock.
        await db
          .update(issues)
          .set({ executionRunId: null, executionLockedAt: null })
          .where(eq(issues.id, issueId));
      },
    });

    const result = await raced.reconcileWorkerCrashedRuns();

    expect(sweptOnce).toBe(true);
    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(0);

    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfter!.executionRunId).toBeNull();

    // Cleanup still clears this run's stale checkout and may promote a deferred
    // wake when one exists.
    expect(issueAfter!.checkoutRunId).toBeNull();

    // Still converges: no orphan replay, no poison row.
    expect(result.reconciledRunIds).toEqual([run.id]);
    expect((await readRun(run.id)).crashRecoveryCompletedAt).not.toBeNull();
  });

  it("releases sibling issue locks even when the retry does take over the context issue", async () => {
    // A run can hold execution locks on MORE than one issue: its context issue
    // from `svc.checkout`, plus any issue stamped by `enqueueWakeup`'s
    // legacy-run fallback. `enqueueProcessLossRetry` hands over only the
    // context issue, so `issueLockOwnedByRetry` is a fact about one issue.
    // Pre-fix, recovery read that single boolean as "the retry owns the lock"
    // and skipped `releaseIssueExecutionAndPromote` entirely, leaving every
    // sibling pointing at a terminal run — the same "checkout 409s forever"
    // strand that function was itself fixed to prevent.
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    const contextIssueId = "55555555-5555-5555-5555-555555555555";
    const siblingIssueId = "66666666-6666-6666-6666-666666666666";
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: contextIssueId } })
      .where(eq(heartbeatRuns.id, run.id));
    for (const [id, title] of [[contextIssueId, "Context issue"], [siblingIssueId, "Sibling issue"]] as const) {
      await db.insert(issues).values({
        id,
        companyId,
        title,
        status: "in_progress",
        checkoutRunId: run.id,
        executionRunId: run.id,
        executionLockedAt: new Date(Date.now() - 60_000),
      });
    }
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      status: "deferred_issue_execution",
      payload: { issueId: contextIssueId },
    });

    const result = await service().reconcileWorkerCrashedRuns();

    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(1);

    // The hand-over still lands and is NOT clobbered by the unconditional
    // release: its clearing UPDATE is keyed on `execution_run_id = <this run>`,
    // which the transferred lock no longer matches.
    const [contextAfter] = await db.select().from(issues).where(eq(issues.id, contextIssueId));
    expect(contextAfter!.executionRunId).toBe(retries[0]!.id);
    const [wakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeAfter!.status).toBe("deferred_issue_execution");

    // The discriminating assertion: pre-fix this stayed pinned to the dead run.
    const [siblingAfter] = await db.select().from(issues).where(eq(issues.id, siblingIssueId));
    expect(siblingAfter!.executionRunId).toBeNull();
    expect(siblingAfter!.checkoutRunId).toBeNull();

    expect(result.reconciledRunIds).toEqual([run.id]);
    expect((await readRun(run.id)).crashRecoveryCompletedAt).not.toBeNull();
  });

  // BLO-21526: migration 0211 declines to build the candidate index inline on a
  // populated table (an inline build would hold ACCESS EXCLUSIVE for its
  // duration) and raises a NOTICE instead — which the production client
  // swallows via `onnotice: () => {}`. So a populated deployment records 0211 as
  // complete with the index absent and no visible signal. Without the index the
  // oldest-first candidate scan is a sequential scan plus a top-N sort, which is
  // fine once per process at startup but not every 30s on every scheduler
  // replica. The periodic caller therefore passes `requireCandidateIndex`.
  it("skips the periodic pass while the candidate index is missing, but never gates startup recovery", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });

    // The embedded test database migrates against an empty `heartbeat_runs`, so
    // 0211 builds the index inline. Drop it to reproduce a populated production
    // database that took 0211's skip path.
    await db.execute(sql`drop index if exists heartbeat_runs_crash_recovery_pending_idx`);

    const svc = service();
    const gated = await svc.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
    expect(gated.skippedReason).toBe("candidate_index_missing");
    expect(gated.reconciledRunIds).toEqual([]);
    // Untouched, so it stays a candidate rather than being consumed or marked.
    expect((await readRun(run.id)).crashRecoveryCompletedAt).toBeNull();

    // Startup recovery is ungated — the primary recovery path must not depend
    // on a deploy step that has not run yet.
    const ungated = await svc.reconcileWorkerCrashedRuns();
    expect(ungated.skippedReason).toBeUndefined();
    expect(ungated.reconciledRunIds).toEqual([run.id]);
    expect((await readRun(run.id)).crashRecoveryCompletedAt).not.toBeNull();

    // Restore it: `afterEach` truncates rows but does not rebuild schema, so
    // leaving it dropped would silently change what later tests exercise.
    await db.execute(sql`
      create index if not exists heartbeat_runs_crash_recovery_pending_idx
        on heartbeat_runs using btree (finished_at, id)
        where error_code = 'worker_crashed' and crash_recovery_completed_at is null
    `);
  });

  it("re-enables the periodic pass once the candidate index is built online, without a restart", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    await db.execute(sql`drop index if exists heartbeat_runs_crash_recovery_pending_idx`);

    // Same service instance throughout: the presence probe must be re-run while
    // the index is absent rather than cached, so the online build flips the pass
    // on within one interval instead of waiting for a redeploy.
    const svc = service();
    expect((await svc.reconcileWorkerCrashedRuns({ requireCandidateIndex: true })).skippedReason).toBe(
      "candidate_index_missing",
    );

    await db.execute(sql`
      create index heartbeat_runs_crash_recovery_pending_idx
        on heartbeat_runs using btree (finished_at, id)
        where error_code = 'worker_crashed' and crash_recovery_completed_at is null
    `);

    const afterBuild = await svc.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
    expect(afterBuild.skippedReason).toBeUndefined();
    expect(afterBuild.reconciledRunIds).toEqual([run.id]);
  });

  // BLO-20822, Ally round 7: the gate must recover in BOTH directions. An
  // earlier version latched `true` after one successful probe, justified as
  // "an index cannot become invalid again without an operator dropping it, and
  // that path takes a restart anyway" — which is wrong about Postgres.
  // `DROP INDEX CONCURRENTLY` needs no restart, and a failed online rebuild can
  // leave the index absent or invalid, so a latched worker would silently
  // resume the sequential scan and top-N sort this gate exists to prevent, with
  // no further catalog check ever. The absent→present test above cannot catch
  // that, because a latch is indistinguishable from a re-probe on that path.
  it("disables the periodic pass again after the candidate index is dropped online", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const first = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 120_000) });

    // Same service instance throughout, so a latched `true` from this first
    // (index-present) pass would carry into the post-drop pass below.
    const svc = service();
    const withIndex = await svc.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
    expect(withIndex.skippedReason).toBeUndefined();
    expect(withIndex.reconciledRunIds).toEqual([first.id]);

    const afterDrop = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    await db.execute(sql`drop index if exists heartbeat_runs_crash_recovery_pending_idx`);
    try {
      // The discriminating assertion: pre-fix this returned undefined and
      // scanned, because readiness had been latched by the pass above.
      const gated = await svc.reconcileWorkerCrashedRuns({ requireCandidateIndex: true });
      expect(gated.skippedReason).toBe("candidate_index_missing");
      expect(gated.reconciledRunIds).toEqual([]);
      expect((await readRun(afterDrop.id)).crashRecoveryCompletedAt).toBeNull();

      // Startup recovery stays ungated, so the run is not stranded.
      expect((await svc.reconcileWorkerCrashedRuns()).reconciledRunIds).toEqual([afterDrop.id]);
    } finally {
      await db.execute(sql`
        create index if not exists heartbeat_runs_crash_recovery_pending_idx
          on heartbeat_runs using btree (finished_at, id)
          where error_code = 'worker_crashed' and crash_recovery_completed_at is null
      `);
    }
  });

  // BLO-20822, Ally round 7/8: a zero-row hand-over must promote the deferred
  // wake without leaving a detached process-loss retry beside it.
  //
  // The stale-lock sweeper can clear the terminal original's context lock before
  // `enqueueProcessLossRetry` attempts its guarded hand-over. Cleanup then finds
  // the context issue unowned, and `releaseIssueExecutionAndPromote`'s check is
  // `issue.executionRunId && issue.executionRunId !== run.id`, so a
  // sweeper-cleared NULL is FALSY and passes straight through it. Pre-fix that
  // promoted a `deferred_issue_execution` wake into a second queued run holding
  // the issue lock, racing the retry. The round-6 zero-row test could not catch
  // this: it has no deferred wake, so it proved stale-checkout cleanup only.
  it("promotes a deferred wake instead of creating a retry when the hand-over would match zero rows", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    const issueId = "77777777-7777-7777-7777-777777777777";
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Contended issue",
      status: "in_progress",
      checkoutRunId: run.id,
      executionRunId: run.id,
      executionLockedAt: new Date(Date.now() - 60_000),
    });
    // A wake parked behind this issue's execution lock — the thing promotion
    // would turn into a second runnable path.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    let sweptOnce = false;
    const raced = service({
      beforeProcessLossRetryEnqueueForTest: async () => {
        if (sweptOnce) return;
        sweptOnce = true;
        // Force the zero-row hand-over: the sweeper clears the lock in the
        // window between terminalizing the run and handing it to the retry.
        await db
          .update(issues)
          .set({ executionRunId: null, executionLockedAt: null })
          .where(eq(issues.id, issueId));
      },
    });

    const result = await raced.reconcileWorkerCrashedRuns();
    expect(sweptOnce).toBe(true);

    const retries = await retriesOf(run.id);
    expect(retries).toHaveLength(0);

    // The discriminating assertion: exactly ONE runnable path survives — the
    // promoted deferred wake. Round 8 suppressed promotion after already
    // creating a detached retry, which stranded ordinary queued dispatch.
    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const runnable = allRuns.filter((r) => r.status === "queued" || r.status === "running");
    expect(runnable).toHaveLength(1);
    expect(runnable[0]!.retryOfRunId).toBeNull();

    const [wakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeAfter!.status).toBe("queued");

    // Stale checkout is still cleared — suppressing promotion must not have
    // suppressed the lock cleanup that round 6 added.
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfter!.checkoutRunId).toBeNull();

    expect(result.reconciledRunIds).toEqual([run.id]);
    expect((await readRun(run.id)).crashRecoveryCompletedAt).not.toBeNull();
  });

  // BLO-21623, Ally round 9: adopting a queued retry is different from failing
  // to create one. Queued runs acquire the issue lock when dispatch claims them,
  // so an adopted retry without the lock is still a runnable continuation and
  // must suppress deferred-wake promotion.
  it.each([
    { retryStatus: "queued", retryIssueScope: "same", expectedWakeStatus: "deferred_issue_execution" },
    { retryStatus: "interrupted", retryIssueScope: "same", expectedWakeStatus: "queued" },
    { retryStatus: "queued", retryIssueScope: "none", expectedWakeStatus: "queued" },
    { retryStatus: "queued", retryIssueScope: "different", expectedWakeStatus: "queued" },
  ])(
    "handles an existing $retryStatus retry with $retryIssueScope issue scope",
    async ({ retryStatus, retryIssueScope, expectedWakeStatus }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
      const issueId = "88888888-8888-8888-8888-888888888888";
      const retryIssueId =
        retryIssueScope === "same"
          ? issueId
          : retryIssueScope === "different"
            ? "99999999-9999-9999-9999-999999999999"
            : null;
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, run.id));
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Issue awaiting adopted retry",
        status: "in_progress",
        checkoutRunId: run.id,
        executionRunId: null,
        executionLockedAt: null,
      });
      const [existingRetry] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: retryStatus,
          responsibleUserId: "crash-test-user",
          contextSnapshot: { ...(retryIssueId ? { issueId: retryIssueId } : {}), retryOfRunId: run.id },
          retryOfRunId: run.id,
        })
        .returning();
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "assignment",
        status: "deferred_issue_execution",
        payload: { issueId },
      });

      const result = await service().reconcileWorkerCrashedRuns();

      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      const runnable = allRuns.filter((candidate) => candidate.status === "queued" || candidate.status === "running");
      const runnableForIssue = runnable.filter(
        (candidate) => (candidate.contextSnapshot as { issueId?: string } | null)?.issueId === issueId,
      );
      expect(runnableForIssue).toHaveLength(1);
      if (retryStatus === "queued" && retryIssueScope === "same") {
        expect(runnableForIssue[0]!.id).toBe(existingRetry!.id);
      } else {
        expect(runnableForIssue[0]!.retryOfRunId).toBeNull();
      }

      const [wakeAfter] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakeAfter!.status).toBe(expectedWakeStatus);
      expect(result.reconciledRunIds).toEqual([run.id]);
      expect((await readRun(run.id)).crashRecoveryCompletedAt).not.toBeNull();
    },
  );

  it("prefers a newer queued retry over terminal retry history for the same issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const run = await seedCrashMarkedRun({ companyId, agentId, finishedAt: new Date(Date.now() - 60_000) });
    const issueId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with mixed retry history",
      status: "in_progress",
      checkoutRunId: run.id,
      executionRunId: null,
      executionLockedAt: null,
    });
    const retries = await db
      .insert(heartbeatRuns)
      .values([
        {
          companyId,
          agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "interrupted",
          responsibleUserId: "crash-test-user",
          contextSnapshot: { issueId, retryOfRunId: run.id },
          retryOfRunId: run.id,
          createdAt: new Date(Date.now() - 30_000),
        },
        {
          companyId,
          agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          responsibleUserId: "crash-test-user",
          contextSnapshot: { issueId, retryOfRunId: run.id },
          retryOfRunId: run.id,
          createdAt: new Date(),
        },
      ])
      .returning();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      status: "deferred_issue_execution",
      payload: { issueId },
    });

    await service().reconcileWorkerCrashedRuns();

    const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const runnable = allRuns.filter((candidate) => candidate.status === "queued" || candidate.status === "running");
    expect(runnable.map((candidate) => candidate.id)).toEqual([retries[1]!.id]);
    const [wakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakeAfter!.status).toBe("deferred_issue_execution");
  });
});

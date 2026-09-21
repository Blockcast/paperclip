import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  STALLED_COALESCE_BYPASS_SNAPSHOT_KEY,
  STALLED_COALESCE_MIN_BUDGET_MS,
} from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres timer wake coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

describeEmbeddedPostgres("heartbeat timer wake coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-wake-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("coalesces timer wakes into an existing heartbeat task row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const existingRunId = randomUUID();
    const existingWakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Co",
      status: "active",
      issuePrefix: "TIM",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: existingWakeupId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupId,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        taskKey: "__heartbeat__",
      },
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: "2026-06-12T20:00:00.000Z",
      },
    });

    expect(run?.id).toBe(existingRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      taskKey: "__heartbeat__",
      wakeReason: "heartbeat_timer",
      wakeSource: "timer",
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((wakeup) => wakeup.status).sort()).toEqual(["coalesced", "queued"]);
  });

  // -------------------------------------------------------------------------
  // PEN-1995: a running run that has overrun its heartbeat interval must stop
  // speaking for later timer wakes.
  //
  // These two cases pin the boundary from both sides. The run is deliberately
  // registered via `__test_unsafelyTrackActiveRunExecution` so it is NOT a
  // zombie — otherwise `filterZombieCoalesceTarget` would null it first and
  // the assertion would pass for a reason that has nothing to do with this fix.
  // -------------------------------------------------------------------------
  async function seedAgentWithRunningRun(input: {
    intervalSec: number;
    runStartedAt: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Overrun Co",
      status: "active",
      issuePrefix: "OVR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Overrun Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: input.intervalSec, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runningRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      startedAt: input.runStartedAt,
      // The signature of the stall this fix exists for: registered in
      // activeRunExecutions before the adapter invoke, so it never produced
      // output and never advanced past the pre-exec prefix.
      lastOutputSeq: 1,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        taskKey: "__heartbeat__",
      },
    });

    return { companyId, agentId, runningRunId };
  }

  async function fireTimerWake(heartbeat: ReturnType<typeof heartbeatService>, agentId: string) {
    return heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        // Only consulted on the mint path (resolveResponsibleUserIdForRunSeed
        // reads it first). The coalesce path never reaches it, so this does
        // not influence the branch under test — it just lets the fallthrough
        // actually produce a run instead of 422-ing on an unseeded fixture.
        responsibleUserId: "overrun-test-user",
      },
    });
  }

  // A demand wake at the SAME task scope as the timer wake above. The explicit
  // taskKey is what makes the comparison honest: for a non-timer wake
  // `deriveTaskKeyWithHeartbeatFallback` does not synthesize `__heartbeat__`,
  // so without it the wake would fall through on scope rather than on source
  // and the assertion would prove nothing about this fix.
  async function fireDemandWake(
    heartbeat: ReturnType<typeof heartbeatService>,
    agentId: string,
    source: "on_demand" | "automation",
  ) {
    return heartbeat.wakeup(agentId, {
      source,
      triggerDetail: source === "on_demand" ? "manual" : "system",
      reason: "manual_wake",
      requestedByActorType: "system",
      requestedByActorId: "overrun-test",
      contextSnapshot: {
        taskKey: "__heartbeat__",
        responsibleUserId: "overrun-test-user",
      },
    });
  }

  // PEN-1990: the bypass log is identified by the two fields only it carries —
  // the spread of the bypass record (`targetAgeMs`) plus the enqueue outcome.
  // Collected inside the mock rather than read from `mock.calls` afterwards,
  // because `mockRestore()` also clears the recorded calls.
  function captureBypassLogs() {
    const captured: Record<string, unknown>[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation(((fields: unknown) => {
      if (
        typeof fields === "object" &&
        fields !== null &&
        "targetAgeMs" in fields &&
        "outcome" in fields
      ) {
        captured.push(fields as Record<string, unknown>);
      }
    }) as never);
    return { captured, restore: () => spy.mockRestore() };
  }

  it("mints a new run instead of coalescing into a tracked run that has overrun its interval", async () => {
    // 3600s interval => 90 min budget (the floor). Started 4 h ago, so it has
    // already swallowed roughly three wakes it never serviced.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 3600,
      runStartedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    // Not a zombie: this is what makes the assertion attributable to this fix.
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const bypassLog = captureBypassLogs();
    let run: Awaited<ReturnType<typeof fireTimerWake>>;
    try {
      run = await fireTimerWake(heartbeat, agentId);
    } finally {
      bypassLog.restore();
    }

    expect(run).not.toBeNull();
    expect(run?.id).not.toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    // Non-terminating: the overrunning run is untouched and still free to
    // finish and deliver. This fix only removes it as a coalesce target.
    const stalled = runs.find((candidate) => candidate.id === runningRunId);
    expect(stalled?.status).toBe("running");

    // PEN-1990: the activation is recorded on the run it minted. Without this
    // the rule decides silently, and "has it ever fired in production?" can
    // only be answered by inferring it from overlapping run pairs — which
    // cannot tell a filter activation from any other overlap.
    const minted = runs.find((candidate) => candidate.id !== runningRunId);
    expect(minted?.contextSnapshot).toMatchObject({
      [STALLED_COALESCE_BYPASS_SNAPSHOT_KEY]: {
        targetRunId: runningRunId,
        budgetMs: STALLED_COALESCE_MIN_BUDGET_MS,
        intervalSec: 3600,
      },
    });
    const bypass = (minted?.contextSnapshot as Record<string, any>)[
      STALLED_COALESCE_BYPASS_SNAPSHOT_KEY
    ];
    // The age is the one the filter judged, so it must be past the budget it
    // reports — an age below the budget would mean the record and the decision
    // were taken off different clocks.
    expect(bypass.targetAgeMs).toBeGreaterThan(bypass.budgetMs);
    expect(Date.parse(bypass.targetStartedAt)).toBeGreaterThan(0);
    // The marker must not leak onto the run that was filtered out.
    expect(stalled?.contextSnapshot).not.toHaveProperty(STALLED_COALESCE_BYPASS_SNAPSHOT_KEY);

    // PEN-1990: the log is emitted post-commit and carries the outcome, so the
    // two records reconcile exactly — the snapshot marker's population is the
    // `outcome: "queued"` lines and nothing else. A log taken at the decision
    // point instead would also fire on the paths that end the wake without a
    // mint (daily cap, post-lock task-scope re-check, github-state coalesce),
    // leaving an operator with a count difference and no way to attribute it.
    expect(bypassLog.captured).toHaveLength(1);
    expect(bypassLog.captured[0]).toMatchObject({
      agentId,
      outcome: "queued",
      runId: run?.id,
      // `runId` carries the MINTED run and nothing else, so it is non-null
      // exactly when a marker was stamped. On the fold outcomes it is null and
      // the merged-into run is reported separately — without that split a
      // consumer grouping on `runId` would read a fold as a mint.
      coalescedIntoRunId: null,
      targetRunId: runningRunId,
    });
  });

  it("still coalesces into a tracked running run that is within its interval budget", async () => {
    // Control for the case above: same setup, same tracking, only the age
    // differs. Without this, the test above would also pass if the filter
    // fired unconditionally on every running run.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 3600,
      runStartedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const bypassLog = captureBypassLogs();
    let run: Awaited<ReturnType<typeof fireTimerWake>>;
    try {
      run = await fireTimerWake(heartbeat, agentId);
    } finally {
      bypassLog.restore();
    }

    expect(run?.id).toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    // PEN-1990: no activation, so no marker. A marker that also appeared on
    // the coalesce path would make every run look like a filter activation.
    expect(runs[0]?.contextSnapshot).not.toHaveProperty(STALLED_COALESCE_BYPASS_SNAPSHOT_KEY);
    // Same control for the log, whose failure mode is also over-reporting.
    expect(bypassLog.captured).toHaveLength(0);
  });

  it("holds a fast-cadence agent to the 90 min floor rather than 1.5x its interval", async () => {
    // 30s interval * 1.5 = 45s, which is below the measured p50 run duration.
    // Without the floor this run (20 min old) would be filtered and the agent
    // would mint a fresh run on nearly every wake.
    const { agentId, runningRunId } = await seedAgentWithRunningRun({
      intervalSec: 30,
      runStartedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

    const run = await fireTimerWake(heartbeat, agentId);

    expect(run?.id).toBe(runningRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The rule is scoped to timer wakes, and these pin that.
  //
  // Only a periodic cadence tick can be shown lost by elapsed time: it fires on
  // a schedule, so an interval that passed with no run is a tick that went
  // unserviced. A demand wake fires once, when something happened, so its age
  // proves nothing — and filtering on it would discard a live coalesce target
  // and mint a CONCURRENT run for a manual or recovery wake, changing behaviour
  // this fix has no evidence about and never intended to touch.
  //
  // `source` defaults to `on_demand`, so this gate is what keeps the rule on
  // the intended path rather than the default one.
  // -------------------------------------------------------------------------
  for (const source of ["on_demand", "automation"] as const) {
    it(`still coalesces an aged running target for a ${source} wake`, async () => {
      // Identical fixture to the minting case above — 3600s interval, started
      // 4 h ago, well past the 90 min budget. The ONLY difference is the wake
      // source, so a coalesce here is attributable to the source gate alone.
      const { agentId, runningRunId } = await seedAgentWithRunningRun({
        intervalSec: 3600,
        runStartedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
      });

      const heartbeat = heartbeatService(db, {
        penstockAvailabilityGate: allowPenstockGate,
        skipQueuedRunDispatch: true,
      });
      heartbeat.__test_unsafelyTrackActiveRunExecution(runningRunId);

      const run = await fireDemandWake(heartbeat, agentId, source);

      expect(run?.id).toBe(runningRunId);

      // No concurrent run minted: the whole point of the gate.
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);
      // PEN-1990: and nothing recorded an activation for a wake the rule is
      // not allowed to act on.
      expect(runs[0]?.contextSnapshot).not.toHaveProperty(STALLED_COALESCE_BYPASS_SNAPSHOT_KEY);
    });
  }
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";

/**
 * PEN-4036 — a run killed mid-flight by the provider must hand its session to
 * its retry instead of letting the retry start cold.
 *
 * Measured over 2026-10-11→13 (n=1000 runs): 69/69 runs that died with
 * `rate_limit_exhausted` persisted a `sessionIdAfter`, 53/53 of their retries
 * found that session available, and 51 of those 53 then discarded it at the
 * config-freshness gate — which fires on agent image bumps and issue-row
 * `updatedAt` mtimes, neither of which invalidates a conversation. The cost was
 * a median 26.6 minutes of streamed work re-burned per death.
 *
 * These tests pin the mint-time contract. They deliberately do NOT assert
 * `usageJson.sessionReused`: that field is written from the same variable as
 * `sessionIdBefore` (`heartbeat.ts` ~33750 / ~35416), so it is a tautological
 * restatement of it and cannot fail independently.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping PEN-4036 provider-death session resume tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PEN-4036 provider-death retry session resume", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pen4036-session-resume-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "PEN-4036 session resume cleanup",
      drainTimeoutMs: 30_000,
    });
  });

  async function seed(input: {
    errorCode: string;
    errorFamily: string;
    sessionIdAfter: string | null;
    taskSession?: { displayId: string; lastRunId: string | null; params: Record<string, unknown> } | null;
    contextExtras?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();

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
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "provider rate limit",
      errorCode: input.errorCode,
      finishedAt: now,
      sessionIdBefore: null,
      sessionIdAfter: input.sessionIdAfter,
      resultJson: { errorFamily: input.errorFamily },
      contextSnapshot: {
        issueId,
        taskKey: issueId,
        wakeReason: "issue_commented",
        ...(input.contextExtras ?? {}),
      },
      updatedAt: now,
      createdAt: now,
    });
    if (input.taskSession) {
      await db.insert(agentTaskSessions).values({
        companyId,
        agentId,
        adapterType: "claude_local",
        taskKey: issueId,
        sessionDisplayId: input.taskSession.displayId,
        sessionParamsJson: input.taskSession.params,
        lastRunId: input.taskSession.lastRunId,
      });
    }
    return { companyId, agentId, runId, issueId, now };
  }

  async function retryContextFor(runId: string, now: Date) {
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0.5 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("retry was not scheduled");
    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun).not.toBeNull();
    return (retryRun!.contextSnapshot ?? {}) as Record<string, unknown>;
  }

  it("hands the dead run's session to its retry", async () => {
    const { runId, now } = await seed({
      errorCode: "rate_limit_exhausted",
      errorFamily: "rate_limit_exhausted",
      sessionIdAfter: "sess-dead",
      taskSession: {
        displayId: "sess-dead",
        lastRunId: null,
        params: { sessionId: "sess-dead", cwd: "/tmp/pen4036-ws" },
      },
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeFromRunId).toBe(runId);
    expect(ctx.resumeSessionDisplayId).toBe("sess-dead");
    expect((ctx.resumeSessionParams as Record<string, unknown>).sessionId).toBe("sess-dead");
    // Full stored params, not a bare id: the resumed session has to carry its
    // workspace cwd or it resolves against the wrong tree.
    expect((ctx.resumeSessionParams as Record<string, unknown>).cwd).toBe("/tmp/pen4036-ws");
  });

  /**
   * The sharp one. 4 of the 73 retries measured on PEN-4036 did start from a
   * session — the WRONG one. Here the task session has since moved on to a
   * different session that the dead run never held, so an implementation that
   * simply forwards "whatever the task session currently points at" resumes
   * `sess-newer` and fails this test, while the contract ("resume the session
   * THIS run died holding") yields `sess-dead`.
   */
  it("resumes the predecessor's own session, not whatever the task session now points at", async () => {
    const { runId, now } = await seed({
      errorCode: "rate_limit_exhausted",
      errorFamily: "rate_limit_exhausted",
      sessionIdAfter: "sess-dead",
      taskSession: {
        displayId: "sess-newer",
        lastRunId: null,
        params: { sessionId: "sess-newer", cwd: "/tmp/pen4036-other" },
      },
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeSessionDisplayId).toBe("sess-dead");
    expect((ctx.resumeSessionParams as Record<string, unknown>).sessionId).toBe("sess-dead");
  });

  it("leaves non-provider-death transient retries starting cold", async () => {
    const { runId, now } = await seed({
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      sessionIdAfter: "sess-dead",
      taskSession: {
        displayId: "sess-dead",
        lastRunId: null,
        params: { sessionId: "sess-dead", cwd: "/tmp/pen4036-ws" },
      },
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeFromRunId).toBeUndefined();
    expect(ctx.resumeSessionDisplayId).toBeUndefined();
    expect(ctx.resumeSessionParams).toBeUndefined();
  });

  it("stamps nothing when the dead run never persisted a session", async () => {
    const { runId, now } = await seed({
      errorCode: "rate_limit_exhausted",
      errorFamily: "rate_limit_exhausted",
      sessionIdAfter: null,
      taskSession: null,
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeFromRunId).toBeUndefined();
    expect(ctx.resumeSessionDisplayId).toBeUndefined();
    expect(ctx.resumeSessionParams).toBeUndefined();
  });

  /**
   * Resume markers are scoped to the run that resolved them. A later attempt
   * that does not re-resolve one must not inherit a pointer the retried run has
   * already SUPERSEDED — otherwise a retry chain keeps shipping an older session
   * at the adapter and rewinds the conversation.
   *
   * "Superseded" is carried here by `sessionIdAfter: "sess-dead"`: that column is
   * written in exactly one place, at completion from the adapter result, so it is
   * durable proof this run reached the adapter and advanced past `sess-stale`.
   * Test 6 is this test's minimal pair — identical but for that one value — and
   * pins the opposite verdict, which is what keeps the rule here from being read
   * as "always clear".
   */
  it("drops resume markers the retried run superseded with a session of its own", async () => {
    const staleRunId = randomUUID();
    const { runId, now } = await seed({
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      sessionIdAfter: "sess-dead",
      taskSession: null,
      contextExtras: {
        resumeFromRunId: staleRunId,
        resumeSessionDisplayId: "sess-stale",
        resumeSessionParams: { sessionId: "sess-stale" },
      },
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeFromRunId).toBeUndefined();
    expect(ctx.resumeSessionDisplayId).toBeUndefined();
    expect(ctx.resumeSessionParams).toBeUndefined();
  });

  /**
   * Review follow-up (PR#2686, Ally Important #1). The minimal pair of test 5:
   * the ONLY difference is `sessionIdAfter: null`, i.e. this run died before it
   * ever reached the adapter.
   *
   * That is the real pre-adapter path — `scheduleBoundedRetryForRun` fires from
   * the vanished-Job reconciler under `adapterInvocationStarted !== true`, and a
   * successful-run handoff stamps exactly these three keys on the run it wakes.
   * Such a run never touched the inherited session, so the pointer was never
   * consumed and is still the correct one. Clearing it would drop the retry onto
   * the ordinary task-session lookup that `resolveTaskSessionConfigFreshness`
   * discards ~98.7% of the time — this PR's own failure mode, moved onto a
   * family it does not otherwise serve.
   *
   * The retry family here resolves no provider-death resume of its own (test 3),
   * so nothing re-stamps these keys: they survive only by being left alone.
   */
  it("keeps an inherited handoff resume when the retried run failed before the adapter started", async () => {
    const handoffRunId = randomUUID();
    const { runId, now } = await seed({
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      sessionIdAfter: null,
      taskSession: null,
      contextExtras: {
        resumeFromRunId: handoffRunId,
        resumeSessionDisplayId: "sess-handoff",
        resumeSessionParams: { sessionId: "sess-handoff", cwd: "/tmp/pen4036-handoff" },
      },
    });
    const ctx = await retryContextFor(runId, now);

    expect(ctx.resumeFromRunId).toBe(handoffRunId);
    expect(ctx.resumeSessionDisplayId).toBe("sess-handoff");
    expect((ctx.resumeSessionParams as Record<string, unknown>).sessionId).toBe("sess-handoff");
    expect((ctx.resumeSessionParams as Record<string, unknown>).cwd).toBe("/tmp/pen4036-handoff");
  });
});

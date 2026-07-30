import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin invoke fan-out tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression coverage for BLO-18847 / BLO-18848.
 *
 * `agents.invoke` used to send `payload: { prompt }` and nothing else, so
 * `deriveTaskKey` returned null for every plugin-originated wake. Because
 * `isSameTaskScope(null, null)` is true, a review request that arrived while the
 * target agent already had a run in flight was folded into that unrelated run and
 * recorded as `status: "coalesced"` — the webhook still returned 200, so the loss
 * was invisible. Nine `@ally` review requests went unanswered for 3-12h that way.
 */
describeEmbeddedPostgres("plugin agents.invoke wake fan-out", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-invoke-fanout-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  }, 20_000);

  afterEach(async () => {
    // Shared helper: cancels active runs and drains in-flight executions before
    // truncating, so a dispatched run can't leak a process into the next test or
    // trip an FK on teardown.
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedBusyAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
      // Wake dispatch requires a resolvable responsible user (#8825); these
      // tests assert that distinct invokes actually *dispatch* rather than
      // coalesce, so they reach that path and need an owner to resolve to.
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      // Single-slot concurrency keeps the seeded run occupying the only slot,
      // which is exactly the burst condition that triggered the original loss.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // An in-flight plugin-originated run with no task key — the coalesce target.
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      contextSnapshot: {},
    });

    return { companyId, agentId, activeRunId };
  }

  function hostServices(db: ReturnType<typeof createDb>) {
    return buildHostServices(
      db,
      "github-plugin-record-id",
      "paperclip.github",
      createEventBusStub(),
      undefined,
      undefined,
      { heartbeatOptions: { skipQueuedRunDispatch: true } },
    );
  }

  it("gives ten concurrent review requests ten distinct durable runs while the agent is busy", async () => {
    const { companyId, agentId, activeRunId } = await seedBusyAgent();
    const services = hostServices(db);

    const taskKeys = Array.from(
      { length: 10 },
      (_, i) => `pr_review:Blockcast/pim-multicast-gateway:${1800 + i}`,
    );

    const results = await Promise.all(
      taskKeys.map((taskKey) =>
        services.agents.invoke({
          agentId,
          companyId,
          prompt: `Review ${taskKey}`,
          reason: "pr_review_requested",
          taskKey,
        }),
      ),
    );

    // Every request got its own run, and none reused the busy run.
    const runIds = new Set(results.map((r) => r.runId));
    expect(runIds.size).toBe(10);
    expect(runIds.has(activeRunId)).toBe(false);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(11); // 10 new + the pre-existing active run

    const persistedTaskKeys = runs
      .map((run) => (run.contextSnapshot as Record<string, unknown> | null)?.taskKey)
      .filter((key): key is string => typeof key === "string");
    // Plugin keys are namespaced so they cannot collide with issue-execution runs.
    expect(new Set(persistedTaskKeys)).toEqual(
      new Set(taskKeys.map((key) => `plugin:github-plugin-record-id:${key}`)),
    );

    // Nothing was silently folded into another PR's run.
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(10);
    expect(wakeups.filter((w) => w.status === "coalesced")).toHaveLength(0);
    expect(wakeups.every((w) => w.runId !== null)).toBe(true);
  }, 60_000);

  it("does not coalesce concurrent invokes that omit a task key", async () => {
    const { companyId, agentId } = await seedBusyAgent();
    const services = hostServices(db);

    // An un-updated plugin that cannot supply a task key must still not lose
    // deliveries — keyless invokes default to distinct scopes, not to "same".
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        services.agents.invoke({
          agentId,
          companyId,
          prompt: `Keyless request ${i}`,
          reason: "pr_review_requested",
        }),
      ),
    );

    expect(new Set(results.map((r) => r.runId)).size).toBe(10);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.filter((w) => w.status === "coalesced")).toHaveLength(0);
  }, 60_000);

  it("replays a redelivered webhook onto the original run instead of queueing a second", async () => {
    const { companyId, agentId } = await seedBusyAgent();
    const services = hostServices(db);
    const deliveryId = "gh-delivery-7f3c9a10-0000-4000-8000-000000000001";

    const first = await services.agents.invoke({
      agentId,
      companyId,
      prompt: "Review penstock-llm-proxy-core#880",
      reason: "pr_review_requested",
      taskKey: "pr_review:Blockcast/penstock-llm-proxy-core:880",
      idempotencyKey: deliveryId,
    });

    const replay = await services.agents.invoke({
      agentId,
      companyId,
      prompt: "Review penstock-llm-proxy-core#880",
      reason: "pr_review_requested",
      taskKey: "pr_review:Blockcast/penstock-llm-proxy-core:880",
      idempotencyKey: deliveryId,
    });

    expect(replay.runId).toBe(first.runId);
    expect(replay.deduplicated).toBe(true);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]!.idempotencyKey).toBe(`plugin:github-plugin-record-id:${deliveryId}`);
  }, 60_000);

  it("keeps a plugin task key from targeting an unrelated issue-execution run", async () => {
    const { companyId, agentId } = await seedBusyAgent();
    const services = hostServices(db);

    // A live issue run, keyed by issue id the way issue wakes are.
    const issueId = randomUUID();
    const issueRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: issueRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      contextSnapshot: { taskKey: issueId, issueId, secretPlan: "untouched" },
    });

    // Coalescing merges the incoming snapshot over the target's, so a raw
    // plugin-supplied key equal to the issue id must not be able to land on it.
    const result = await services.agents.invoke({
      agentId,
      companyId,
      prompt: "attempt to land on the issue run",
      taskKey: issueId,
    });

    expect(result.runId).not.toBe(issueRunId);

    const [issueRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, issueRunId));
    const snapshot = issueRun!.contextSnapshot as Record<string, unknown>;
    expect(snapshot.secretPlan).toBe("untouched");
    expect(snapshot.prompt).toBeUndefined();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.filter((w) => w.status === "coalesced")).toHaveLength(0);
  }, 60_000);

  it("characterizes the original loss: keyless wakes coalesce into an unrelated active run", async () => {
    const { companyId, agentId } = await seedBusyAgent();

    // The burst shape from the incident: the first keyless request is already
    // queued behind the agent's occupied slot, and the next one arrives with an
    // equally keyless payload. `isSameTaskScope(null, null)` is true, so it lands
    // on that unrelated run instead of getting its own.
    //
    // The target is deliberately `queued`, not `running`: a `running` row with no
    // tracked process is a zombie, and `filterZombieCoalesceTarget` now refuses
    // it as a coalesce target. Queued runs pass through unchanged, so this pins
    // the scope-collision mechanism rather than the zombie path.
    const priorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      contextSnapshot: {},
    });

    // The pre-fix payload shape, sent straight at the heartbeat service. This
    // pins the mechanism the fix routes around; if coalescing semantics change,
    // this test should be revisited alongside the invoke path.
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "pr_review_requested",
      payload: { prompt: "Review some PR" },
      requestedByActorType: "system",
      requestedByActorId: "github-plugin-record-id",
    });

    expect(run?.id).toBe(priorRunId);
    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]!.status).toBe("coalesced");
    expect(companyId).toBeTruthy();
  }, 60_000);
});

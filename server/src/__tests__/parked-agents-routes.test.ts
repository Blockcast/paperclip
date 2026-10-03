import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY } from "../services/ccrotate-capacity-retry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres parked-agents route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * BLO-24011 acceptance criterion: "which agents are currently unable to run, and
 * until when?" must be answerable without invoking a heartbeat on each agent to
 * find out.
 */
describeEmbeddedPostgres("parked agents route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parked-agents-routes-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The authorization policy reads membership from the DB, not from the actor
    // object, so a board actor without this row is denied every agent:read.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    scheduledRetryAt?: Date | null;
    scheduledRetryReason?: string | null;
    scheduledRetryAttempt?: number;
    // Stamped by `promoteScheduledRetryRun` at the instant a due park becomes
    // `queued`, so it is what separates promotion lag from dispatch wait.
    queuedAt?: Date | null;
    resultJson?: Record<string, unknown>;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.status,
      scheduledRetryAt: input.scheduledRetryAt ?? null,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      queuedAt: input.queuedAt ?? null,
      errorCode: input.status === "scheduled_retry" ? "rate_limit_exhausted" : null,
      resultJson: input.resultJson ?? {},
    });
  }

  it("reports who is parked, until when, and why — soonest due first", async () => {
    const companyId = await seedCompany();
    const soonAgent = await seedAgent(companyId, "PlatformSREEngineer");
    const laterAgent = await seedAgent(companyId, "BackendEngineer");
    const runningAgent = await seedAgent(companyId, "FrontendEngineer");

    const soonDue = new Date(Date.now() + 5 * 60_000);
    const laterDue = new Date(Date.now() + 60 * 60_000);
    await seedRun({
      companyId,
      agentId: laterAgent,
      status: "scheduled_retry",
      scheduledRetryAt: laterDue,
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      resultJson: {
        penstockProvider: "anthropic",
        penstockModel: "claude-sonnet-5[1m]",
        penstockRetryAfterSeconds: 3834,
      },
    });
    await seedRun({
      companyId,
      agentId: soonAgent,
      status: "scheduled_retry",
      scheduledRetryAt: soonDue,
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 2,
    });
    // A healthy agent must not appear — the endpoint answers "cannot run", not
    // "has runs".
    await seedRun({ companyId, agentId: runningAgent, status: "running" });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(2);
    expect(res.body.agents.map((entry: { agentName: string }) => entry.agentName)).toEqual([
      "PlatformSREEngineer",
      "BackendEngineer",
    ]);

    const [soon, later] = res.body.agents;
    expect(soon.reason).toBe("ccrotate_capacity");
    expect(soon.attempt).toBe(2);
    expect(new Date(soon.scheduledRetryAt).toISOString()).toBe(soonDue.toISOString());
    expect(soon.retryInMs).toBeGreaterThan(0);
    expect(soon.overdueMs).toBe(0);

    // The provider's own claim travels with the row, so a park can be compared
    // against what was asked for without opening the run.
    expect(later.penstockProvider).toBe("anthropic");
    expect(later.penstockRetryAfterSeconds).toBe(3834);
  });

  it("distinguishes a 429 pool exhaustion from a 503 provider outage, which `reason` alone cannot", async () => {
    const companyId = await seedCompany();
    const exhaustedAgent = await seedAgent(companyId, "PlatformSREEngineer");
    const outageAgent = await seedAgent(companyId, "BackendEngineer");
    const unlabelledAgent = await seedAgent(companyId, "FrontendEngineer");

    // Both denials book the SAME `scheduledRetryReason` on purpose — the single
    // value is what preserves BLO-28919's census split-check. So `reason` is
    // identical across these two rows by design, and `penstockReason` is the
    // only thing that tells an empty pool from a dead provider (PEN-3323).
    await seedRun({
      companyId,
      agentId: exhaustedAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 5 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      resultJson: { penstockReason: "penstock.model_capacity_unavailable" },
    });
    await seedRun({
      companyId,
      agentId: outageAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 10 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      resultJson: { penstockReason: "penstock.model_temporarily_unavailable" },
    });
    // A park written before this key existed, or by a path that set no reason,
    // must read as null rather than being dropped from the census.
    await seedRun({
      companyId,
      agentId: unlabelledAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 15 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    const [exhausted, outage, unlabelled] = res.body.agents;
    expect(res.body.parkedRunCount).toBe(3);

    // The control: `reason` is the same on all three, so it cannot separate them.
    expect(
      res.body.agents.map((entry: { reason: string }) => entry.reason),
    ).toEqual(["ccrotate_capacity", "ccrotate_capacity", "ccrotate_capacity"]);

    expect(exhausted.penstockReason).toBe("penstock.model_capacity_unavailable");
    expect(outage.penstockReason).toBe("penstock.model_temporarily_unavailable");
    expect(unlabelled.penstockReason).toBeNull();
  });

  it("surfaces the advertised resume instant under the writer's key, so a rename cannot null it", async () => {
    // The alert runbook sends on-call here to see a capacity park's advertised
    // resume instant (BLO-35263). Seeding through the writer's binding rather
    // than the literal is the point: rename the constant and this row moves
    // with it, so a projection still reading the old literal returns null here.
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "PlatformSREEngineer");
    const advertisedResumeAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      resultJson: { [CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY]: advertisedResumeAt },
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.agents[0].penstockAdvertisedResumeAt).toBe(advertisedResumeAt);
  });

  it("flags a park whose due time has already passed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "PlatformSREEngineer");
    await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() - 90 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    // Due-but-still-parked is a different failure from a long park: the sweep is
    // not draining it. Distinguishing the two is the point of overdueMs.
    expect(res.body.overdueRunCount).toBe(1);
    expect(res.body.agents[0].overdueMs).toBeGreaterThan(60 * 60_000);
    expect(res.body.agents[0].retryInMs).toBe(0);
  });

  it("filters by retry reason", async () => {
    const companyId = await seedCompany();
    const capacityAgent = await seedAgent(companyId, "PlatformSREEngineer");
    const depAgent = await seedAgent(companyId, "BackendEngineer");
    await seedRun({
      companyId,
      agentId: capacityAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });
    await seedRun({
      companyId,
      agentId: depAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "dep_blocked",
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents?reason=ccrotate_capacity`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(1);
    expect(res.body.agents[0].agentName).toBe("PlatformSREEngineer");
    expect(res.body.reason).toBe("ccrotate_capacity");
  });

  it("is readable by a same-company agent actor, which is how the MCP tool calls it", async () => {
    // The whole point of the AC is that an agent can ask "who is parked?" instead
    // of waking each peer to discover it. Board-only gating would defeat that.
    const companyId = await seedCompany();
    const callerId = await seedAgent(companyId, "CTO");
    const parkedId = await seedAgent(companyId, "PlatformSREEngineer");
    await seedRun({
      companyId,
      agentId: parkedId,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });

    const res = await request(createApp(agentActor(companyId, callerId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(1);
    expect(res.body.agents[0].agentName).toBe("PlatformSREEngineer");
  });

  it("does not leak parked agents from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const otherAgent = await seedAgent(otherCompanyId, "OtherCompanyEngineer");
    await seedRun({
      companyId: otherCompanyId,
      agentId: otherAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(0);
    expect(res.body.agents).toEqual([]);
  });

  /**
   * PEN-3607. `promoteScheduledRetryRun` flips a due park to `queued` and
   * leaves `scheduledRetryAt` / `scheduledRetryReason` / `scheduledRetryAttempt`
   * set on the row. So a park that fired but was never claimed by dispatch is
   * a `queued` row with a past due time — and the old `status = 'scheduled_retry'`
   * predicate could not see it.
   *
   * Measured in production on UX Designer `bcba1cc7` (2026-09-29): seat dark
   * 33 h behind exactly this shape, and the census reported `overdueCount: 0`.
   *
   * The NEGATIVE CONTROL is the fixture itself: it contains **no**
   * `scheduled_retry` row at all. Under the pre-fix predicate this response is
   * necessarily empty, so every row asserted below is attributable solely to
   * the new arm. No mocking of the old code path is required for that to hold.
   */
  it("counts a promoted-but-unclaimed park — the shape the old `scheduled_retry` filter could not see", async () => {
    const companyId = await seedCompany();
    const darkAgent = await seedAgent(companyId, "UXDesigner");

    const dueAt = new Date(Date.now() - 29 * 60 * 60_000);
    await seedRun({
      companyId,
      agentId: darkAgent,
      // Promoted out of `scheduled_retry` 29 h ago and never claimed.
      status: "queued",
      scheduledRetryAt: dueAt,
      scheduledRetryReason: "ccrotate_capacity",
      // Never re-deferred: promoted on its first due-time hit.
      scheduledRetryAttempt: 0,
      // Promotion fired promptly (1 min after due), so essentially all of the
      // 29 h is dispatch wait. The test below separates the other case.
      queuedAt: new Date(Date.now() - (29 * 60 - 1) * 60_000),
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(1);
    // The assertion this ticket exists for.
    expect(res.body.overdueRunCount).toBe(1);
    // One run, one seat — the two units agree here, which is what makes the
    // stacked-park test below the one that can tell them apart.
    expect(res.body.overdueAgentCount).toBe(1);

    const [dark] = res.body.agents;
    expect(dark.agentName).toBe("UXDesigner");
    expect(dark.reason).toBe("ccrotate_capacity");
    expect(dark.attempt).toBe(0);
    // `queued`, not `scheduled_retry` — the park already fired; it is dispatch
    // that has not happened. Without this field the caller cannot tell the two
    // apart, and they have unrelated remedies.
    expect(dark.runStatus).toBe("queued");
    expect(dark.overdueMs).toBeGreaterThan(28 * 60 * 60_000);
    expect(dark.retryInMs).toBe(0);
    // Promotion was prompt, so the dispatch wait really is ~the whole overdue
    // span — this is the case where blaming the dispatcher is correct.
    expect(dark.queuedForMs).toBeGreaterThan(28 * 60 * 60_000);
  });

  /**
   * PEN-3607 (Ally review). `overdueMs` on a `queued` row spans park-due →
   * promotion → now, so it is promotion lag PLUS dispatch wait. Attributing all
   * of it to the dispatcher inverts the triage when the promotion sweep is the
   * thing that stalled — and that is the precise conflation `queued_at` was
   * added for: its schema docblock calls reading a promoted retry's backoff as
   * dispatch wait "the exact false-stranded-run signal BLO-21116 exists to
   * kill".
   *
   * This fixture is the adversarial case: a park due 29 h ago that promotion
   * only picked up 10 minutes ago. `overdueMs` must stay large (the park IS
   * that overdue) while `queuedForMs` stays small (dispatch has had it for 10
   * minutes and is not at fault). A single field cannot carry both.
   */
  it("separates promotion lag from dispatch wait on a late-promoted park", async () => {
    const companyId = await seedCompany();
    const lateAgent = await seedAgent(companyId, "LatePromotionEngineer");

    await seedRun({
      companyId,
      agentId: lateAgent,
      status: "queued",
      scheduledRetryAt: new Date(Date.now() - 29 * 60 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      // The sweep was wedged ~29 h and only promoted this row 10 min ago.
      queuedAt: new Date(Date.now() - 10 * 60_000),
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    const [late] = res.body.agents;
    // Unchanged meaning: this park really is 29 h past its own due time.
    expect(late.overdueMs).toBeGreaterThan(28 * 60 * 60_000);
    // ...but dispatch has only held it for 10 minutes. Reporting overdueMs as
    // the dispatch wait here would blame the dispatcher for a sweep stall.
    expect(late.queuedForMs).toBeLessThan(30 * 60_000);
    expect(late.queuedForMs).toBeGreaterThanOrEqual(10 * 60_000 - 5_000);
    // The gap between the two IS the promotion lag, and it must be visible.
    expect(late.overdueMs - late.queuedForMs).toBeGreaterThan(28 * 60 * 60_000);
  });

  /**
   * PEN-3607 (Ally review). A `queued` row promoted before `queued_at` existed
   * has no measurable dispatch wait. It must report null — "unmeasurable" —
   * rather than falling back to `scheduledRetryAt`, because that fallback is
   * exactly the park-due→now conflation above and would overstate the dispatch
   * wait on precisely the rows where the true value is unknown.
   */
  it("reports a null dispatch wait rather than guessing one from the park due time", async () => {
    const companyId = await seedCompany();
    const legacyAgent = await seedAgent(companyId, "LegacyPromotionEngineer");

    await seedRun({
      companyId,
      agentId: legacyAgent,
      status: "queued",
      scheduledRetryAt: new Date(Date.now() - 29 * 60 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      queuedAt: null,
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    const [legacy] = res.body.agents;
    expect(legacy.queuedForMs).toBeNull();
    expect(legacy.queuedAt).toBeNull();
    // The honest upper bound is still published, so the row is not silent.
    expect(legacy.overdueMs).toBeGreaterThan(28 * 60 * 60_000);
  });

  /**
   * PEN-3607 (Ally review). The production shape that motivated this change was
   * ONE dark seat holding TWO overdue `ccrotate_capacity` parks — UX Designer
   * `bcba1cc7`, 2026-09-29. Since the `queued` arm landed, several rows per seat
   * is the normal case, so run counts and seat counts diverge routinely and an
   * operator reading a run count as "how many agents are down" over-counts.
   *
   * This pins which field carries which unit. Without it, a future dedupe (or a
   * future failure to dedupe) would flip the answer silently in either
   * direction.
   */
  it("counts runs and seats separately when one agent holds several overdue parks", async () => {
    const companyId = await seedCompany();
    const darkAgent = await seedAgent(companyId, "UXDesigner");
    const otherAgent = await seedAgent(companyId, "BackendEngineer");

    // Two stacked parks on ONE seat, as measured in production.
    await seedRun({
      companyId,
      agentId: darkAgent,
      status: "queued",
      scheduledRetryAt: new Date(Date.now() - 29 * 60 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      queuedAt: new Date(Date.now() - 29 * 60 * 60_000),
    });
    await seedRun({
      companyId,
      agentId: darkAgent,
      status: "queued",
      scheduledRetryAt: new Date(Date.now() - 28 * 60 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      queuedAt: new Date(Date.now() - 28 * 60 * 60_000),
    });
    // A second seat, still parked rather than promoted, so the mix of the two
    // populations is covered too.
    await seedRun({
      companyId,
      agentId: otherAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() - 2 * 60 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    // Three parked RUNS...
    expect(res.body.parkedRunCount).toBe(3);
    expect(res.body.overdueRunCount).toBe(3);
    expect(res.body.agents).toHaveLength(3);
    // ...held between TWO seats. This is the number that answers "how many
    // agents cannot run right now", and it is not the number above.
    expect(res.body.parkedAgentCount).toBe(2);
    expect(res.body.overdueAgentCount).toBe(2);
    // The dark seat legitimately appears twice; `agents[]` is per run.
    expect(res.body.agents.filter((entry: { agentName: string }) => entry.agentName === "UXDesigner"))
      .toHaveLength(2);
    // The superseded names must be gone, not silently redefined — a stale
    // caller has to break rather than read a run count as a seat count.
    expect(res.body.parkedCount).toBeUndefined();
    expect(res.body.overdueCount).toBeUndefined();
  });

  /**
   * Bounds the widening above. A census that admitted every `queued` run would
   * report the whole dispatch queue as "cannot run" and be useless — and a test
   * that only asserted the positive case would pass just as happily against
   * that much looser predicate. These two rows are the ones that must STAY out.
   */
  it("does not admit a queued run that is not actually overdue", async () => {
    const companyId = await seedCompany();
    const futureParkAgent = await seedAgent(companyId, "FutureParkEngineer");
    const plainQueuedAgent = await seedAgent(companyId, "PlainQueuedEngineer");

    // A park promoted early, or re-parked forward: due time still ahead, so it
    // is waiting as designed and is not a dispatch fault.
    await seedRun({
      companyId,
      agentId: futureParkAgent,
      status: "queued",
      scheduledRetryAt: new Date(Date.now() + 30 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });
    // An ordinary queued run that was never parked at all. `scheduledRetryAt`
    // is NULL, so it must not be swept in by the new arm.
    await seedRun({ companyId, agentId: plainQueuedAgent, status: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedRunCount).toBe(0);
    expect(res.body.overdueRunCount).toBe(0);
    expect(res.body.agents).toEqual([]);
  });
});

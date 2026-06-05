import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import type {
  CcrotateGateCheckInput,
  CcrotateGateResult,
  CcrotateTierGate,
} from "../services/ccrotate-tier-gate.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "ok",
        resultJson: {},
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ccrotate capacity retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Deterministic gate that always defers with a fixed resumeAt. */
function denyingGate(resumeAt: Date | null): CcrotateTierGate {
  return {
    async checkAdapter(_input: CcrotateGateCheckInput): Promise<CcrotateGateResult> {
      return { allow: false, target: "claude", reason: "ccrotate.no_usable_account", resumeAt };
    },
    _resetForTesting() {},
  };
}

describeEmbeddedPostgres("heartbeat ccrotate capacity-defer → scheduled retry", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ccrotate-capacity-retry-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
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
    return { companyId, agentId };
  }

  it("schedules a capacity retry instead of dropping the wake when the gate defers", async () => {
    const { agentId } = await seedAgent();
    const resumeAt = new Date("2026-04-20T03:02:00.000Z");
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(resumeAt),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
    });

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun, "a heartbeatRuns row should be created instead of dropping the wake").not.toBeNull();
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(resumeAt.toISOString());
    expect(retryRun?.scheduledRetryReason).toBe("ccrotate_capacity");
    // The rate-limit family + retryNotBefore make the existing bounded-retry
    // backoff honor resumeAt as the floor.
    const resultJson = (retryRun?.resultJson ?? {}) as Record<string, unknown>;
    expect(resultJson.errorFamily).toBe("rate_limit_exhausted");
    expect(resultJson.retryNotBefore).toBe(resumeAt.toISOString());

    // The wake is NOT recorded as a terminal `skipped` drop.
    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")))
      .then((rows) => rows[0] ?? null);
    expect(skipped, "the capacity defer must not terminally drop the wake as skipped").toBeNull();
  });

  it("schedules with a bounded fallback delay when the gate returns no resumeAt", async () => {
    const { agentId } = await seedAgent();
    const before = Date.now();
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(null),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system" });

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.status).toBe("scheduled_retry");
    // A null resumeAt must NOT strand the row with a null scheduledRetryAt —
    // the sweep claims `scheduledRetryAt <= now`, which never matches null.
    expect(retryRun?.scheduledRetryAt, "null resumeAt must fall back to a bounded delay, not null").not.toBeNull();
    expect(retryRun!.scheduledRetryAt!.getTime()).toBeGreaterThan(before);
  });

  it("promotes the scheduled capacity retry when it becomes due", async () => {
    const { agentId } = await seedAgent();
    const resumeAt = new Date("2026-04-20T03:02:00.000Z");
    const heartbeat = heartbeatService(db, {
      ccrotateGate: denyingGate(resumeAt),
      skipQueuedRunDispatch: true,
    });

    await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system" });

    // Before due: still parked as scheduled_retry.
    const early = await heartbeat.promoteDueScheduledRetries(new Date("2026-04-20T03:01:59.000Z"));
    expect(early.promoted).toBe(0);

    // At/after due: the existing sweep claims and promotes it to the queued pool.
    const promotion = await heartbeat.promoteDueScheduledRetries(resumeAt);
    expect(promotion.promoted).toBe(1);

    const promoted = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(promoted?.status).toBe("queued");
  });
});

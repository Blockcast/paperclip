/**
 * BLO-20526 — rollout safety for the pr_review task-key casing transition.
 *
 * GitHub owner/repo identity is case-insensitive, so the task-key producers now
 * lowercase it. Every run enqueued before that change carries a mixed-case key
 * (`Blockcast/*` produced one on every repo we use) and stays live until its
 * review drains. During that window the two spellings must be treated as the
 * same scope everywhere, or a normalized wake queues *beside* the legacy run it
 * should have coalesced into — which is precisely the duplicate-run amplifier
 * this ticket exists to remove — and the cancel-on-close sweep leaves the
 * legacy run queued for a PR that has already closed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { heartbeatService } from "../services/heartbeat.ts";

/** What the producer wrote before normalization landed. */
const LEGACY_TASK_KEY = "pr_review:Blockcast/PiM-Multicast-Gateway:1911";
/** What every producer writes now. */
const NORMALIZED_TASK_KEY = "pr_review:blockcast/pim-multicast-gateway:1911";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pr_review task-key casing tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

describeEmbeddedPostgres("pr_review task key casing transition", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-pr-review-task-key-casing-");
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

  async function seedReviewerWithLegacyRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const existingRunId = randomUUID();
    const existingWakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Casing Co",
      status: "active",
      issuePrefix: "CAS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: existingWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "github_webhook",
    });
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupId,
      // context_task_key is generated over context_snapshot->>'taskKey', so this
      // is byte-for-byte what a pre-normalization webhook left behind.
      contextSnapshot: {
        wakeReason: "github_pr_review_requested",
        wakeSource: "github",
        taskKey: LEGACY_TASK_KEY,
      },
    });

    return { companyId, agentId, existingRunId };
  }

  it("coalesces a normalized wake into a live legacy mixed-case run", async () => {
    const { agentId, existingRunId } = await seedReviewerWithLegacyRun();

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "github_pr_review_requested",
      requestedByActorType: "system",
      requestedByActorId: "github_webhook",
      contextSnapshot: {
        wakeReason: "github_pr_review_requested",
        wakeSource: "github",
        taskKey: NORMALIZED_TASK_KEY,
      },
    });

    // Without the shared casing predicate this returns a *second* run id and
    // the reviewer burns two slots on one PR.
    expect(run?.id).toBe(existingRunId);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("cancels a live legacy mixed-case run when the sweep passes the normalized key", async () => {
    const { agentId, existingRunId } = await seedReviewerWithLegacyRun();

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    const cancelled = await heartbeat.cancelPendingRunsForTask(
      agentId,
      NORMALIZED_TASK_KEY,
      "pull request closed",
    );

    expect(cancelled).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, existingRunId));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("task_scope_cancelled");
  });

  it("does not treat unrelated non-PR task scopes as case-insensitive", async () => {
    const { companyId, agentId } = await seedReviewerWithLegacyRun();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: "issue:ABC-1" },
    });

    const heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: allowPenstockGate,
      skipQueuedRunDispatch: true,
    });

    // Issue keys are case-sensitive identifiers; the pr_review bridge must not
    // silently widen equality for every other task scope in the system.
    const cancelled = await heartbeat.cancelPendingRunsForTask(agentId, "issue:abc-1", "unrelated");
    expect(cancelled).toBe(0);
  });
});

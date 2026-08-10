import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import type { SuccessfulRunHandoffState } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  hydrateSuccessfulRunHandoffLiveness,
  SUCCESSFUL_RUN_HANDOFF_UNSTARTED_RUN_LIVENESS_MS,
} from "../services/successful-run-handoff-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping successful-run-handoff liveness tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * BLO-24190. `hasLiveContinuation` is the field a reader consults to answer
 * "is something already carrying this issue forward, or do I need to step in?".
 * It used to be true for any run in `queued`/`running`/`scheduled_retry`
 * targeting the issue, with no age bound and no `startedAt` check — so a
 * corrective run merely sitting behind a dispatch backlog reported a live
 * continuation indefinitely.
 *
 * That is not a cosmetic inaccuracy. On BLO-23010 it read `true` for a run
 * queued 21h07m, which was then cited as evidence the issue was progressing,
 * and again for a `dependency_blocked` retry whose issue lock the recovery
 * sweeper had already reaped as stale.
 */
describeEmbeddedPostgres("successful run handoff liveness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handoff-liveness-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Handoff issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  async function insertRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: string;
    createdAt: Date;
    startedAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      startedAt: input.startedAt ?? null,
      createdAt: input.createdAt,
      contextSnapshot: { issueId: input.issueId },
    });
    return id;
  }

  function requiredState(): Map<string, SuccessfulRunHandoffState> {
    return new Map([
      [
        "placeholder",
        {
          state: "required",
          required: true,
          hasLiveContinuation: false,
          sourceRunId: null,
          correctiveRunId: null,
          assigneeAgentId: null,
          detectedProgressSummary: null,
          createdAt: new Date(),
        } satisfies SuccessfulRunHandoffState,
      ],
    ]);
  }

  async function hydrateFor(companyId: string, issueId: string) {
    const states = requiredState();
    const state = states.get("placeholder")!;
    states.delete("placeholder");
    states.set(issueId, state);
    await hydrateSuccessfulRunHandoffLiveness(db, companyId, states);
    return states.get(issueId)!;
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

  it("does not report a live continuation for a queued run that never started past the bound", async () => {
    // The BLO-23010 shape: corrective run bc7fa04d, invocationSource
    // `automation`, created 2026-08-09T17:01:54Z and not dispatched until
    // 2026-08-10T14:08:45Z — 21h07m during which this field read `true`.
    const { companyId, agentId, issueId } = await seed();
    await insertRun({ companyId, agentId, issueId, status: "queued", createdAt: hoursAgo(21) });

    const state = await hydrateFor(companyId, issueId);

    expect(state.hasLiveContinuation).toBe(false);
    expect(state.liveRunId).toBeNull();
  });

  it("still reports a live continuation for a queued run inside the bound", async () => {
    // The bound must be a real bound, not an immediate release: a queued run
    // legitimately waits behind a backlog, and reporting every such run as dead
    // would replace a false positive with a false negative.
    const { companyId, agentId, issueId } = await seed();
    const runId = await insertRun({ companyId, agentId, issueId, status: "queued", createdAt: hoursAgo(1) });

    const state = await hydrateFor(companyId, issueId);

    expect(state.hasLiveContinuation).toBe(true);
    expect(state.liveRunId).toBe(runId);
  });

  it("does not report a live continuation for a never-started scheduled_retry past the bound", async () => {
    // Run 22059930 on BLO-23010: `scheduled_retry`, reason `dependency_blocked`,
    // attempt 11, startedAt null. sweepStaleIssueLocks had already released its
    // issue lock as `parked_retry_lock_expired` while this still read `true`.
    const { companyId, agentId, issueId } = await seed();
    await insertRun({ companyId, agentId, issueId, status: "scheduled_retry", createdAt: hoursAgo(9) });

    const state = await hydrateFor(companyId, issueId);

    expect(state.hasLiveContinuation).toBe(false);
    expect(state.liveRunId).toBeNull();
  });

  it("keeps a started-then-parked retry live regardless of age", async () => {
    // A run that actually executed and is parked for retry IS a continuation;
    // the bound is about never-started rows only.
    const { companyId, agentId, issueId } = await seed();
    const runId = await insertRun({
      companyId,
      agentId,
      issueId,
      status: "scheduled_retry",
      createdAt: hoursAgo(48),
      startedAt: hoursAgo(47),
    });

    const state = await hydrateFor(companyId, issueId);

    expect(state.hasLiveContinuation).toBe(true);
    expect(state.liveRunId).toBe(runId);
  });

  it("keeps a running run live regardless of age", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runId = await insertRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: hoursAgo(30),
      startedAt: hoursAgo(29),
    });

    const state = await hydrateFor(companyId, issueId);

    expect(state.hasLiveContinuation).toBe(true);
    expect(state.liveRunId).toBe(runId);
  });

  it("prefers the running run over a stale queued one when both target the issue", async () => {
    // Previously `liveRunId` was whichever row Postgres returned first, so two
    // reads of unchanged state could disagree about which run was carrying it.
    const { companyId, agentId, issueId } = await seed();
    await insertRun({ companyId, agentId, issueId, status: "queued", createdAt: hoursAgo(21) });
    const runningId = await insertRun({
      companyId,
      agentId,
      issueId,
      status: "running",
      createdAt: hoursAgo(2),
      startedAt: hoursAgo(1),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await hydrateFor(companyId, issueId);
      expect(state.hasLiveContinuation).toBe(true);
      expect(state.liveRunId).toBe(runningId);
    }
  });

  it("treats the bound as exactly STALE_PRE_CLAIM_ISSUE_LOCK_MS-aligned", async () => {
    // Pin the constant so a future edit that widens it past the point where the
    // recovery sweeper reaps the same run's issue lock is a deliberate change,
    // not an accident: beyond that horizon this surface would be calling a run
    // live that the platform has already written off.
    expect(SUCCESSFUL_RUN_HANDOFF_UNSTARTED_RUN_LIVENESS_MS).toBe(6 * 60 * 60 * 1000);
  });
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  classifyGateLookup,
  reconcileApprovalGates,
  startApprovalGateReconciler,
  type ApprovalGateReconcilerScheduler,
} from "../services/approval-gate-reconciler.js";
import type { WorkflowRunLookup } from "../services/github-app-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval-gate reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as never;

// BLO-29359: a board approval card is only a pointer at an external gate, and
// nothing reconciled the two — so a card outlived its run and kept asking humans
// to click something that no longer existed. These tests pin both directions: a
// terminated gate must close its card and say so, and everything short of positive
// evidence of termination must leave the card alone.
describeEmbeddedPostgres("reconcileApprovalGates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-gate-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "AGR") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(companyId: string, identifier: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      identifier,
      title: identifier,
      status: "in_progress",
      priority: "medium",
      originKind: "manual",
      originFingerprint: "default",
    });
    return id;
  }

  /** File a card, optionally carrying a gate, optionally linked to an issue. */
  async function insertApproval(input: {
    companyId: string;
    agentId: string;
    status?: string;
    gate?: Record<string, unknown> | null;
    issueId?: string;
    title?: string;
    createdAt?: Date;
  }) {
    const id = randomUUID();
    const payload: Record<string, unknown> = { title: input.title ?? "Deploy paperclip" };
    if (input.gate !== undefined && input.gate !== null) payload.gate = input.gate;
    await db.insert(approvals).values({
      id,
      companyId: input.companyId,
      type: "request_board_approval",
      requestedByAgentId: input.agentId,
      status: input.status ?? "pending",
      payload: payload as never,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    if (input.issueId) {
      await db.insert(issueApprovals).values({
        companyId: input.companyId,
        issueId: input.issueId,
        approvalId: id,
      });
    }
    return id;
  }

  const gateFor = (runId: number) => ({
    kind: "github_actions_run",
    repoFullName: "Blockcast/paperclip",
    runId,
    url: `https://github.com/Blockcast/paperclip/actions/runs/${runId}`,
  });

  async function approvalRow(id: string) {
    const rows = await db
      .select({
        status: approvals.status,
        decisionNote: approvals.decisionNote,
        decidedAt: approvals.decidedAt,
      })
      .from(approvals)
      .where(eq(approvals.id, id));
    return rows[0] ?? null;
  }

  async function commentsFor(issueId: string) {
    return db
      .select({ body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  const found = (status: string, conclusion: string | null): WorkflowRunLookup => ({
    outcome: "found",
    status,
    conclusion,
    htmlUrl: "https://github.com/Blockcast/paperclip/actions/runs/1",
  });

  it("leaves a card alone while its gate is still waiting for a human", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-1");
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(1), issueId });

    // The exact live state that produced BLO-29359's still-pending gate.
    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => found("waiting", null),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ examined: 1, closed: 0, live: 1, announced: 0 });
    expect(await approvalRow(approvalId)).toMatchObject({ status: "pending", decidedAt: null });
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("closes a card whose gate died undecided and announces it on the linked issue", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-2");
    const approvalId = await insertApproval({
      companyId,
      agentId,
      gate: gateFor(32338832082),
      issueId,
      title: "Deploy the pr_review_output_missing fix",
    });

    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => found("completed", "cancelled"),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ examined: 1, closed: 1, announced: 1, live: 0, deferred: 0 });

    const row = await approvalRow(approvalId);
    expect(row?.status).toBe("cancelled");
    expect(row?.decidedAt).not.toBeNull();
    expect(row?.decisionNote).toContain("died undecided");
    expect(row?.decisionNote).toContain("32338832082");

    const comments = await commentsFor(issueId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("died undecided");
    // The card title and a clickable run link are what make the comment actionable.
    expect(comments[0]?.body).toContain("Deploy the pr_review_output_missing fix");
    expect(comments[0]?.body).toContain("actions/runs/32338832082");
    // It must say the card can no longer be approved, or a reader will keep waiting.
    expect(comments[0]?.body).toContain("can no");
    expect(comments[0]?.metadata).toMatchObject({
      kind: "approval-gate-reconciler",
      approvalId,
      runId: 32338832082,
      gateSatisfied: false,
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.entityId, approvalId));
    expect(activity).toEqual([{ action: "approval.cancelled", entityId: approvalId }]);
  });

  it("distinguishes a gate that completed successfully from one that died", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-3");
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(3), issueId });

    await reconcileApprovalGates(db, {
      fetchRun: async () => found("completed", "success"),
      logger: silentLogger,
    });

    expect((await approvalRow(approvalId))?.status).toBe("cancelled");
    expect((await approvalRow(approvalId))?.decisionNote).toContain("completed before a decision");
    const comments = await commentsFor(issueId);
    expect(comments[0]?.body).toContain("has already completed");
    expect(comments[0]?.body).not.toContain("died undecided");
    expect(comments[0]?.metadata).toMatchObject({ gateSatisfied: true });
  });

  it("closes a card whose run has been deleted (404 is positive evidence)", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-4");
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(4), issueId });

    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => ({ outcome: "not_found" }),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ closed: 1, announced: 1 });
    expect((await approvalRow(approvalId))?.status).toBe("cancelled");
    expect((await commentsFor(issueId))[0]?.body).toContain("no longer exists");
  });

  it("defers rather than closing when GitHub cannot be read", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-5");
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(5), issueId });

    // A throttled GitHub must never be able to retire live gates in bulk.
    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => ({
        outcome: "error",
        retryable: true,
        reason: "workflow_run_rate_limited",
      }),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ examined: 1, closed: 0, deferred: 1, announced: 0 });
    expect((await approvalRow(approvalId))?.status).toBe("pending");
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("defers when the run fetch throws", async () => {
    const { companyId, agentId } = await createCompany();
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(6) });

    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => {
        throw new Error("socket hang up");
      },
      logger: silentLogger,
    });

    expect(result).toMatchObject({ closed: 0, deferred: 1 });
    expect((await approvalRow(approvalId))?.status).toBe("pending");
  });

  it("treats an unrecognised run state as live", async () => {
    const { companyId, agentId } = await createCompany();
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(7) });

    // GitHub may add run states after this code was written; unknown must not close.
    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => found("some_future_state", null),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ closed: 0, live: 1 });
    expect((await approvalRow(approvalId))?.status).toBe("pending");
  });

  it("lets a concurrent human decision win and posts no announcement", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-8");
    const approvalId = await insertApproval({ companyId, agentId, gate: gateFor(8), issueId });

    // Approve the card in the window between listing it and writing the close.
    const result = await reconcileApprovalGates(db, {
      logger: silentLogger,
      fetchRun: async () => {
        await db
          .update(approvals)
          .set({ status: "approved", decidedAt: new Date() })
          .where(eq(approvals.id, approvalId));
        return found("completed", "cancelled");
      },
    });

    expect(result).toMatchObject({ examined: 1, closed: 0, announced: 0 });
    expect((await approvalRow(approvalId))?.status).toBe("approved");
    expect(await commentsFor(issueId)).toHaveLength(0);
  });

  it("is idempotent across sweeps: no duplicate announcement", async () => {
    const { companyId, agentId } = await createCompany();
    const issueId = await insertIssue(companyId, "AGR-9");
    await insertApproval({ companyId, agentId, gate: gateFor(9), issueId });

    const fetchRun = async () => found("completed", "failure");
    const first = await reconcileApprovalGates(db, { fetchRun, logger: silentLogger });
    const second = await reconcileApprovalGates(db, { fetchRun, logger: silentLogger });

    expect(first).toMatchObject({ closed: 1, announced: 1 });
    // The card is no longer undecided, so it is not even a candidate any more.
    expect(second).toMatchObject({ examined: 0, closed: 0, announced: 0 });
    expect(await commentsFor(issueId)).toHaveLength(1);
  });

  it("ignores cards with no gate, and skips a malformed gate without spending a lookup", async () => {
    const { companyId, agentId } = await createCompany();
    await insertApproval({ companyId, agentId });
    await insertApproval({ companyId, agentId, gate: { kind: "something_else", runId: 1 } });
    // Right discriminator, unusable body: matches the SQL predicate, fails validation.
    await insertApproval({ companyId, agentId, gate: { kind: "github_actions_run", runId: -1 } });
    const fetchRun = vi.fn(async () => found("completed", "cancelled"));

    const result = await reconcileApprovalGates(db, { fetchRun, logger: silentLogger });

    expect(fetchRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ examined: 0, closed: 0 });
  });

  it("reports truncation instead of silently capping the sweep", async () => {
    const { companyId, agentId } = await createCompany();
    const base = Date.parse("2026-08-20T00:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      await insertApproval({
        companyId,
        agentId,
        gate: gateFor(100 + i),
        createdAt: new Date(base + i * 1000),
      });
    }

    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => found("waiting", null),
      maxLookups: 2,
      batchSize: 2,
      logger: silentLogger,
    });

    expect(result.truncated).toBe(true);
    expect(result.examined).toBe(2);
  });

  it("walks past live cards to reach later ones instead of re-checking the same batch", async () => {
    const { companyId, agentId } = await createCompany();
    const base = Date.parse("2026-08-20T00:00:00.000Z");
    // Two live cards ahead of the dead one: without a cursor the sweep would keep
    // re-reading the first batch and never reach it.
    await insertApproval({ companyId, agentId, gate: gateFor(201), createdAt: new Date(base) });
    await insertApproval({ companyId, agentId, gate: gateFor(202), createdAt: new Date(base + 1000) });
    const deadId = await insertApproval({
      companyId,
      agentId,
      gate: gateFor(203),
      createdAt: new Date(base + 2000),
    });

    const result = await reconcileApprovalGates(db, {
      batchSize: 2,
      logger: silentLogger,
      fetchRun: async ({ runId }) =>
        runId === 203 ? found("completed", "cancelled") : found("waiting", null),
    });

    expect(result).toMatchObject({ examined: 3, live: 2, closed: 1 });
    expect((await approvalRow(deadId))?.status).toBe("cancelled");
  });

  it("closes a revision_requested card too — it is undecided, not decided", async () => {
    const { companyId, agentId } = await createCompany();
    const approvalId = await insertApproval({
      companyId,
      agentId,
      status: "revision_requested",
      gate: gateFor(11),
    });

    await reconcileApprovalGates(db, {
      fetchRun: async () => found("completed", "cancelled"),
      logger: silentLogger,
    });

    expect((await approvalRow(approvalId))?.status).toBe("cancelled");
  });

  it("announces on every issue the card is linked to", async () => {
    const { companyId, agentId } = await createCompany();
    const firstIssue = await insertIssue(companyId, "AGR-12");
    const secondIssue = await insertIssue(companyId, "AGR-13");
    const approvalId = await insertApproval({
      companyId,
      agentId,
      gate: gateFor(12),
      issueId: firstIssue,
    });
    await db.insert(issueApprovals).values({ companyId, issueId: secondIssue, approvalId });

    const result = await reconcileApprovalGates(db, {
      fetchRun: async () => found("completed", "timed_out"),
      logger: silentLogger,
    });

    expect(result).toMatchObject({ closed: 1, announced: 2 });
    expect(await commentsFor(firstIssue)).toHaveLength(1);
    expect(await commentsFor(secondIssue)).toHaveLength(1);
  });

  it("runs immediately on start and again on the interval", async () => {
    const { companyId, agentId } = await createCompany();
    await insertApproval({ companyId, agentId, gate: gateFor(13) });
    const fetchRun = vi.fn(async () => found("waiting", null));
    let tick: (() => void) | null = null;
    const scheduler: ApprovalGateReconcilerScheduler = {
      setInterval: (cb) => {
        tick = cb;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {},
    };

    const stop = startApprovalGateReconciler(db, 60_000, { fetchRun, logger: silentLogger }, scheduler);
    // The immediate pass is what drains pre-existing debris without a full interval wait.
    await vi.waitFor(() => expect(fetchRun).toHaveBeenCalledTimes(1));

    tick?.();
    await vi.waitFor(() => expect(fetchRun).toHaveBeenCalledTimes(2));
    stop();
  });
});

// Pure classification — the fail-safe direction is asserted here so it holds even
// if the DB-backed suite is skipped on a host without embedded Postgres.
describe("classifyGateLookup", () => {
  const found = (status: string, conclusion: string | null): WorkflowRunLookup => ({
    outcome: "found",
    status,
    conclusion,
    htmlUrl: null,
  });

  it("treats every non-terminal and unknown run state as live", () => {
    for (const status of [
      "queued",
      "in_progress",
      "waiting",
      "requested",
      "pending",
      "action_required",
      "brand_new_github_state",
    ]) {
      expect(classifyGateLookup(found(status, null)).kind).toBe("live");
    }
  });

  it("treats terminal run states as terminal", () => {
    for (const status of ["completed", "cancelled", "failure", "timed_out", "skipped", "stale"]) {
      expect(classifyGateLookup(found(status, null)).kind).toBe("terminal");
    }
  });

  it("marks only a success conclusion as satisfied", () => {
    expect(classifyGateLookup(found("completed", "success"))).toMatchObject({
      kind: "terminal",
      satisfied: true,
    });
    expect(classifyGateLookup(found("completed", "cancelled"))).toMatchObject({
      kind: "terminal",
      satisfied: false,
    });
  });

  it("never closes a card on a read failure", () => {
    expect(
      classifyGateLookup({ outcome: "error", retryable: false, reason: "workflow_run_http_403" }),
    ).toMatchObject({ kind: "deferred" });
  });

  it("closes on a missing run", () => {
    expect(classifyGateLookup({ outcome: "not_found" })).toMatchObject({
      kind: "terminal",
      satisfied: false,
    });
  });
});

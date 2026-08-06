import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileStrandedBlockedIssues } from "../services/stranded-blocked-issue-reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-blocked-issue reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-21523 phase 1: clearing an issue's last blocker never recomputes
// `status`, so it stays permanently `blocked` with zero unresolved blockers.
// This reconciler drains that population while leaving two other legitimate
// zero-unresolved-blocker `blocked` populations untouched (see the module
// doc comment on stranded-blocked-issue-reconciler.ts for why each exists).
describeEmbeddedPostgres("reconcileStrandedBlockedIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-blocked-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "SBR") {
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

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status: string;
    assigneeAgentId?: string | null;
    executionState?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
      executionState: input.executionState ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function statusOf(issueId: string) {
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row[0]?.status ?? null;
  }

  it("drains an issue whose blockedByIssueIds edge was cleared directly (empty edges, no monitor)", async () => {
    const { companyId } = await createCompany("SB1");
    const stranded = await insertIssue({ companyId, identifier: "SB1-1", status: "blocked" });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(1);
    expect(await statusOf(stranded)).toBe("todo");
  });

  it("drains an issue whose sole blocker closed done but the edge was never cleared", async () => {
    const { companyId } = await createCompany("SB2");
    const blocker = await insertIssue({ companyId, identifier: "SB2-1", status: "done" });
    const dependent = await insertIssue({ companyId, identifier: "SB2-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(1);
    expect(await statusOf(dependent)).toBe("todo");
  });

  it("leaves a genuinely blocked issue alone: blocker is not done", async () => {
    const { companyId } = await createCompany("SB3");
    const blocker = await insertIssue({ companyId, identifier: "SB3-1", status: "todo" });
    const dependent = await insertIssue({ companyId, identifier: "SB3-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(dependent)).toBe("blocked");
  });

  it("leaves a cancelled-blocker dependent blocked (cancelled is not resolved, per existing system semantics)", async () => {
    const { companyId } = await createCompany("SB4");
    const blocker = await insertIssue({ companyId, identifier: "SB4-1", status: "cancelled" });
    const dependent = await insertIssue({ companyId, identifier: "SB4-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(dependent)).toBe("blocked");
  });

  it("does not sweep an issue the convergence-stall guard deliberately blocked", async () => {
    const { companyId } = await createCompany("SB5");
    const guarded = await insertIssue({
      companyId,
      identifier: "SB5-1",
      status: "blocked",
      executionState: {
        monitor: {
          status: "cleared",
          clearReason: "convergence_stalled",
          convergenceStallCount: 1,
        },
      },
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(guarded)).toBe("blocked");
  });

  it("does not sweep an issue blocked directly on a live monitor gate (no blockedBy edge ever existed)", async () => {
    const { companyId } = await createCompany("SB6");
    const gated = await insertIssue({
      companyId,
      identifier: "SB6-1",
      status: "blocked",
      executionState: {
        monitor: {
          status: "triggered",
          gateSignals: ["pr:example/repo#1:review"],
        },
      },
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(gated)).toBe("blocked");
  });

  it("does not sweep an issue with an active stranded-run recovery action pointing at itself", async () => {
    const { companyId, agentId } = await createCompany("SB7");
    const stranded = await insertIssue({ companyId, identifier: "SB7-1", status: "blocked" });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: stranded,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${stranded}:stranded_assigned_issue:${agentId}`,
      nextAction: "Restore a live execution path.",
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(stranded)).toBe("blocked");
  });

  it("is idempotent: a second sweep reconciles nothing further", async () => {
    const { companyId } = await createCompany("SB8");
    await insertIssue({ companyId, identifier: "SB8-1", status: "blocked" });

    const first = await reconcileStrandedBlockedIssues(db);
    const second = await reconcileStrandedBlockedIssues(db);

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
  });

  it("batches across multiple iterations when the backlog exceeds one batch", async () => {
    const { companyId } = await createCompany("SB9");
    for (let i = 0; i < 5; i += 1) {
      await insertIssue({ companyId, identifier: `SB9-${i}`, status: "blocked" });
    }

    const result = await reconcileStrandedBlockedIssues(db, { batchSize: 2 });

    expect(result.reconciled).toBe(5);
    expect(result.iterations).toBe(3);
  });
});

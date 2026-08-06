import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, branchRunClaims, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  acquireBranchRunClaim,
  BranchClaimConflictError,
  computeBranchClaimKey,
  releaseBranchRunClaim,
} from "../services/branch-run-claims.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// BLO-21602: three concurrent runs of one agent worked the same git branch
// via two different issues (a parent and its child) inside ~70 minutes,
// producing two independent duplicate implementations of the same review
// finding. Each run held a perfectly valid issue-scoped checkoutRunId /
// executionRunId on its OWN issue -- the issue-scoped run-ownership guard
// never saw a conflict because it never compares across issues. These tests
// simulate that exact shape at the branch-claim layer: two issues, two
// heartbeat runs, one shared branch.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres branch-run-claim tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("branch run claims", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-branch-run-claims-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(branchRunClaims);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
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
      name: "CTO",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssueAndRunningRun(input: {
    companyId: string;
    agentId: string;
    title: string;
    status?: string;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "in_progress",
      assigneeAgentId: input.agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date(),
    });
    return { issueId, runId };
  }

  it("refuses a second issue's run that resolves to the same branch, naming the holder", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Parent issue: BLO-19722-shaped.
    const parent = await seedIssueAndRunningRun({ companyId, agentId, title: "Parent issue" });
    // Child issue sharing the parent's branch/PR: BLO-20822-shaped.
    const child = await seedIssueAndRunningRun({ companyId, agentId, title: "Child issue" });

    const branchKey = computeBranchClaimKey({
      repoUrl: "https://github.com/Blockcast/paperclip.git",
      branchName: "cto/blo-20822-crash-marking",
    });

    const firstClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: parent.issueId,
      runId: parent.runId,
      agentId,
    });
    expect(firstClaim.heartbeatRunId).toBe(parent.runId);

    const conflict = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: child.issueId,
      runId: child.runId,
      agentId,
    }).catch((error) => error);
    expect(conflict).toBeInstanceOf(BranchClaimConflictError);
    expect(conflict).toMatchObject({
      holderRunId: parent.runId,
      holderIssueId: parent.issueId,
      branchKey,
    });

    // Exactly one active claim exists for the branch, and it is still the parent's.
    const activeRows = await db
      .select()
      .from(branchRunClaims)
      .where(eq(branchRunClaims.branchKey, branchKey));
    const active = activeRows.filter((row) => row.releasedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]?.heartbeatRunId).toBe(parent.runId);
    expect(active[0]?.issueId).toBe(parent.issueId);
  });

  it("allows two different issues' runs to proceed when they resolve to different branches", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueA = await seedIssueAndRunningRun({ companyId, agentId, title: "Issue A" });
    const issueB = await seedIssueAndRunningRun({ companyId, agentId, title: "Issue B" });

    const branchKeyA = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "cto/issue-a" });
    const branchKeyB = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "cto/issue-b" });

    const claimA = await acquireBranchRunClaim(db, {
      companyId,
      branchKey: branchKeyA,
      executionWorkspaceId: null,
      issueId: issueA.issueId,
      runId: issueA.runId,
      agentId,
    });
    const claimB = await acquireBranchRunClaim(db, {
      companyId,
      branchKey: branchKeyB,
      executionWorkspaceId: null,
      issueId: issueB.issueId,
      runId: issueB.runId,
      agentId,
    });

    expect(claimA.heartbeatRunId).toBe(issueA.runId);
    expect(claimB.heartbeatRunId).toBe(issueB.runId);
  });

  it("lets a claim from a terminal (dead) run be superseded instead of deadlocking the branch", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const deadHolder = await seedIssueAndRunningRun({ companyId, agentId, title: "Dead holder", status: "running" });
    const challenger = await seedIssueAndRunningRun({ companyId, agentId, title: "Challenger" });
    const branchKey = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "shared-branch" });

    await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: deadHolder.issueId,
      runId: deadHolder.runId,
      agentId,
    });

    // The holder's process was killed without a graceful release -- simulate
    // the run landing in a terminal state without calling releaseBranchRunClaim.
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, deadHolder.runId));

    const supersededClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: challenger.issueId,
      runId: challenger.runId,
      agentId,
    });
    expect(supersededClaim.heartbeatRunId).toBe(challenger.runId);
  });

  it("releases the claim automatically when the holding run's status trigger fires terminal", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const holder = await seedIssueAndRunningRun({ companyId, agentId, title: "Holder" });
    const branchKey = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "trigger-release-branch" });

    const claim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: holder.runId,
      agentId,
    });
    expect(claim.releasedAt).toBeNull();

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder.runId));

    const releasedRow = await db
      .select()
      .from(branchRunClaims)
      .where(eq(branchRunClaims.id, claim.id))
      .then((rows) => rows[0]);
    expect(releasedRow?.releasedAt).not.toBeNull();
  });

  it("releaseBranchRunClaim explicitly releases the active claim for a run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const holder = await seedIssueAndRunningRun({ companyId, agentId, title: "Holder" });
    const branchKey = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "explicit-release-branch" });

    await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: holder.runId,
      agentId,
    });

    const released = await releaseBranchRunClaim(db, { runId: holder.runId, reason: "run_succeeded" });
    expect(released?.releasedAt).not.toBeNull();

    const retry = await seedIssueAndRunningRun({ companyId, agentId, title: "Retry" });
    const second = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: retry.runId,
      agentId,
    });
    expect(second).toBeTruthy();
  });
});

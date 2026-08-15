import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, branchRunClaims, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  acquireBranchRunClaim,
  BranchClaimConflictError,
  computeBranchClaimKey,
  releaseBranchRunClaim,
  releaseBranchRunClaimForKey,
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

// BLO-21602 (Ally review, native-codex lens): computeBranchClaimKey's
// documented contract is that two workspaces referring to the same remote
// via different URL forms (SSH vs HTTPS, with/without .git) collide on the
// same identity. Pure string normalization (lowercase/trim/.git-strip)
// satisfies that for one form but not across forms -- these run without
// embedded Postgres since the function is pure.
describe("computeBranchClaimKey", () => {
  const branchName = "cto/blo-21602-branch-scoped-run-lock";

  it("collides SSH scp-like, ssh://, and https:// forms of the same repo", () => {
    const scpLike = computeBranchClaimKey({ repoUrl: "git@github.com:Blockcast/paperclip.git", branchName });
    const sshUrl = computeBranchClaimKey({ repoUrl: "ssh://git@github.com/Blockcast/paperclip.git", branchName });
    const gitSshUrl = computeBranchClaimKey({ repoUrl: "git+ssh://git@github.com/Blockcast/paperclip.git/", branchName });
    const https = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip", branchName });
    const httpsTrailingGitSlash = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git/", branchName });
    const mixedCase = computeBranchClaimKey({ repoUrl: "https://GitHub.com/Blockcast/Paperclip.git", branchName });

    expect(sshUrl).toBe(scpLike);
    expect(gitSshUrl).toBe(scpLike);
    expect(https).toBe(scpLike);
    expect(httpsTrailingGitSlash).toBe(scpLike);
    expect(mixedCase).toBe(scpLike);
  });

  it("does not collide different repos or different hosts", () => {
    const paperclip = computeBranchClaimKey({ repoUrl: "git@github.com:Blockcast/paperclip.git", branchName });
    const otherRepo = computeBranchClaimKey({ repoUrl: "git@github.com:Blockcast/other-repo.git", branchName });
    const otherHost = computeBranchClaimKey({ repoUrl: "git@gitlab.com:Blockcast/paperclip.git", branchName });
    const otherBranch = computeBranchClaimKey({ repoUrl: "git@github.com:Blockcast/paperclip.git", branchName: "other-branch" });

    expect(otherRepo).not.toBe(paperclip);
    expect(otherHost).not.toBe(paperclip);
    expect(otherBranch).not.toBe(paperclip);
  });

  it("falls back to a stable opaque key for a null or unrecognized repo url", () => {
    expect(computeBranchClaimKey({ repoUrl: null, branchName })).toBe(`unknown#${branchName}`);
    expect(computeBranchClaimKey({ repoUrl: "  ", branchName })).toBe(`unknown#${branchName}`);
    const localPathA = computeBranchClaimKey({ repoUrl: "/srv/repos/paperclip", branchName });
    const localPathB = computeBranchClaimKey({ repoUrl: "/srv/repos/paperclip", branchName });
    expect(localPathA).toBe(localPathB);
  });
});

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

  // BLO-21602 (Ally review, gstack/review lens): the fixed 30-minute lease
  // used to be acquired exactly once at run start and never renewed, so a
  // still-`running` holder past minute 30 lost the branch to a challenger --
  // recreating the exact divergent-commit race this guard exists to prevent.
  // The fix (heartbeat.ts's `branchClaimRenewalTimer`, started once the
  // adapter invocation begins) periodically re-acquires the SAME run's claim,
  // which extends `expiresAt` via the `existing.heartbeatRunId === input.runId`
  // branch below. This test simulates that renewal tick directly against the
  // claims layer, without needing to drive a full adapter invocation.
  it("a renewed claim survives past its original lease and still blocks a same-branch challenger", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const holder = await seedIssueAndRunningRun({ companyId, agentId, title: "Long-running holder" });
    const challenger = await seedIssueAndRunningRun({ companyId, agentId, title: "Challenger" });
    const branchKey = computeBranchClaimKey({ repoUrl: "https://github.com/Blockcast/paperclip.git", branchName: "long-running-branch" });

    const acquiredAt = new Date("2026-08-04T04:00:00.000Z");
    const firstClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: holder.runId,
      agentId,
      now: acquiredAt,
    });
    const originalExpiresAt = firstClaim.expiresAt.getTime();

    // Renewal tick at +5m (BRANCH_CLAIM_RENEWAL_INTERVAL_MS), well inside the
    // 30m default lease -- the holder is still `running` and re-acquires its
    // own claim, which extends expiresAt instead of throwing a conflict.
    const renewalTick = new Date(acquiredAt.getTime() + 5 * 60_000);
    const renewedClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: holder.runId,
      agentId,
      now: renewalTick,
    });
    expect(renewedClaim.heartbeatRunId).toBe(holder.runId);
    expect(renewedClaim.expiresAt.getTime()).toBeGreaterThan(originalExpiresAt);

    // At the moment the ORIGINAL (un-renewed) lease would have lapsed, the
    // holder is still `running` in the DB and its renewed lease is still
    // valid -- a challenger on a different issue sharing this branch must
    // still be refused, not allowed to supersede.
    const pastOriginalExpiry = new Date(originalExpiresAt + 60_000);
    const conflict = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: challenger.issueId,
      runId: challenger.runId,
      agentId,
      now: pastOriginalExpiry,
    }).catch((error) => error);
    expect(conflict).toBeInstanceOf(BranchClaimConflictError);
    expect(conflict).toMatchObject({ holderRunId: holder.runId, holderIssueId: holder.issueId });
  });

  it("keeps an expired claim owned by a still-running holder", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const holder = await seedIssueAndRunningRun({ companyId, agentId, title: "Live holder" });
    const challenger = await seedIssueAndRunningRun({ companyId, agentId, title: "Challenger" });
    const branchKey = computeBranchClaimKey({
      repoUrl: "git@github.com:Blockcast/paperclip.git",
      branchName: "cto/live-holder",
    });
    const acquiredAt = new Date("2026-08-06T00:00:00.000Z");

    const firstClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: holder.issueId,
      runId: holder.runId,
      agentId,
      now: acquiredAt,
      leaseMs: 1_000,
    });
    expect(firstClaim.expiresAt.getTime()).toBeLessThan(new Date("2026-08-06T00:01:00.000Z").getTime());

    const conflict = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: challenger.issueId,
      runId: challenger.runId,
      agentId,
      now: new Date("2026-08-06T00:01:00.000Z"),
      leaseMs: 1_000,
    }).catch((error) => error);

    expect(conflict).toBeInstanceOf(BranchClaimConflictError);
    expect(conflict).toMatchObject({
      holderRunId: holder.runId,
      holderIssueId: holder.issueId,
      branchKey,
    });

    const claimRows = await db
      .select()
      .from(branchRunClaims)
      .where(eq(branchRunClaims.branchKey, branchKey));
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      heartbeatRunId: holder.runId,
      issueId: holder.issueId,
      releasedAt: null,
      releaseReason: null,
    });
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

  it("lets an unreleased claim from a terminal run be superseded", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const deadHolder = await seedIssueAndRunningRun({
      companyId,
      agentId,
      title: "Already terminal holder",
      status: "failed",
    });
    const challenger = await seedIssueAndRunningRun({ companyId, agentId, title: "Challenger" });
    const branchKey = computeBranchClaimKey({
      repoUrl: "https://github.com/Blockcast/paperclip.git",
      branchName: "terminal-holder-branch",
    });

    await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: deadHolder.issueId,
      runId: deadHolder.runId,
      agentId,
      now: new Date("2026-08-06T00:00:00.000Z"),
      leaseMs: 1_000,
    });

    const supersededClaim = await acquireBranchRunClaim(db, {
      companyId,
      branchKey,
      executionWorkspaceId: null,
      issueId: challenger.issueId,
      runId: challenger.runId,
      agentId,
      now: new Date("2026-08-06T00:01:00.000Z"),
      leaseMs: 1_000,
    });
    expect(supersededClaim.heartbeatRunId).toBe(challenger.runId);

    const claimRows = await db
      .select()
      .from(branchRunClaims)
      .where(eq(branchRunClaims.branchKey, branchKey));
    expect(claimRows.find((row) => row.heartbeatRunId === deadHolder.runId)).toMatchObject({
      releasedAt: expect.any(Date),
      releaseReason: "holder_run_terminal",
    });
    expect(claimRows.find((row) => row.heartbeatRunId === challenger.runId)).toMatchObject({
      releasedAt: null,
      releaseReason: null,
    });
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

  // BLO-21602 (Ally round-3, Important #1). The claim is now taken BEFORE the
  // execution workspace is realized, using the durable
  // `execution_workspaces.branch_name` -- otherwise a losing sibling has
  // already restored/checked out the shared working tree by the time it
  // discovers the conflict, which is the divergent-sibling hazard itself.
  //
  // Realization can legitimately resolve a different branch than the recorded
  // one (a forward-branch reconcile), so executeRun re-keys: acquire the
  // resolved key, then drop the provisional one. These tests pin the two
  // properties that step depends on and that a naive implementation breaks --
  // (a) the run must not be left holding BOTH keys, and (b) dropping the
  // provisional key must not disturb the resolved claim it just took.
  describe("re-key after workspace realization", () => {
    it("frees the provisional branch for other runs once the run re-keys off it", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const mover = await seedIssueAndRunningRun({ companyId, agentId, title: "Re-keying run" });
      const provisionalKey = computeBranchClaimKey({
        repoUrl: "https://github.com/Blockcast/paperclip.git",
        branchName: "recorded-branch",
      });
      const resolvedKey = computeBranchClaimKey({
        repoUrl: "https://github.com/Blockcast/paperclip.git",
        branchName: "reconciled-branch",
      });

      // Pre-realization claim, from the persisted workspace row.
      await acquireBranchRunClaim(db, {
        companyId,
        branchKey: provisionalKey,
        executionWorkspaceId: null,
        issueId: mover.issueId,
        runId: mover.runId,
        agentId,
      });
      // Realization resolved a different branch: take it, then drop the old.
      await acquireBranchRunClaim(db, {
        companyId,
        branchKey: resolvedKey,
        executionWorkspaceId: null,
        issueId: mover.issueId,
        runId: mover.runId,
        agentId,
      });
      await releaseBranchRunClaimForKey(db, {
        runId: mover.runId,
        branchKey: provisionalKey,
        reason: "rekeyed_after_workspace_realization",
      });

      const active = await db
        .select()
        .from(branchRunClaims)
        .where(eq(branchRunClaims.heartbeatRunId, mover.runId))
        .then((rows) => rows.filter((row) => row.releasedAt === null));
      expect(active).toHaveLength(1);
      expect(active[0]!.branchKey).toBe(resolvedKey);

      // The abandoned branch must be claimable by a genuinely different run;
      // if the re-key leaked, this is where the branch would deadlock.
      const other = await seedIssueAndRunningRun({ companyId, agentId, title: "Other issue" });
      const reclaimed = await acquireBranchRunClaim(db, {
        companyId,
        branchKey: provisionalKey,
        executionWorkspaceId: null,
        issueId: other.issueId,
        runId: other.runId,
        agentId,
      });
      expect(reclaimed.heartbeatRunId).toBe(other.runId);
    });

    it("releaseBranchRunClaimForKey leaves the run's other branch claim intact", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const holder = await seedIssueAndRunningRun({ companyId, agentId, title: "Holder" });
      const keptKey = computeBranchClaimKey({
        repoUrl: "https://github.com/Blockcast/paperclip.git",
        branchName: "kept-branch",
      });
      const droppedKey = computeBranchClaimKey({
        repoUrl: "https://github.com/Blockcast/paperclip.git",
        branchName: "dropped-branch",
      });

      for (const branchKey of [keptKey, droppedKey]) {
        await acquireBranchRunClaim(db, {
          companyId,
          branchKey,
          executionWorkspaceId: null,
          issueId: holder.issueId,
          runId: holder.runId,
          agentId,
        });
      }

      await releaseBranchRunClaimForKey(db, {
        runId: holder.runId,
        branchKey: droppedKey,
        reason: "rekeyed_after_workspace_realization",
      });

      const rows = await db
        .select()
        .from(branchRunClaims)
        .where(eq(branchRunClaims.heartbeatRunId, holder.runId));
      const kept = rows.find((row) => row.branchKey === keptKey);
      const dropped = rows.find((row) => row.branchKey === droppedKey);
      expect(kept?.releasedAt).toBeNull();
      expect(dropped?.releasedAt).not.toBeNull();
      expect(dropped?.releaseReason).toBe("rekeyed_after_workspace_realization");

      // And the still-held branch must still refuse a sibling.
      const challenger = await seedIssueAndRunningRun({ companyId, agentId, title: "Challenger" });
      await expect(acquireBranchRunClaim(db, {
        companyId,
        branchKey: keptKey,
        executionWorkspaceId: null,
        issueId: challenger.issueId,
        runId: challenger.runId,
        agentId,
      })).rejects.toBeInstanceOf(BranchClaimConflictError);
    });
  });
});

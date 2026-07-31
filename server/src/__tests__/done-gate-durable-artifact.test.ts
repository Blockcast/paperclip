import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres done-gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Done-execution gate at the `issues.update()` call site (BLO-19081).
 *
 * The pure predicate is covered by `done-gate.test.ts`. This file covers the
 * part the predicate cannot: whether the CALLER derives
 * `hasDurableArtifactEvidence` from the right rows. That is the whole security
 * property — a comment body must not satisfy the gate, and an issue document
 * written by a real run must.
 *
 * Every case runs with `enableDoneExecutionGate: true`, which no other test
 * did before this one; the gate previously had no integration coverage at all.
 */
describeEmbeddedPostgres("PATCH /issues/:id done-execution gate — durable artifact evidence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-done-gate-artifact-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * Turn the gate on. Default is off, so without this nothing is exercised.
   * Upsert, not insert: migrations already seed the singleton row.
   */
  async function enableDoneExecutionGate() {
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: {},
        experimental: { enableDoneExecutionGate: true },
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { experimental: { enableDoneExecutionGate: true } },
      });
  }

  function createApp(agentId: string, companyId: string, runId: string | null) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Agent actor — the done gate never gates humans.
      (req as any).actor = {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  /**
   * Seed an issue in the state that produced this bug: `in_review`, assigned to
   * the agent, `executionRunId` already null because the transition out of
   * `in_progress` released the lock. Unlabeled, so the in_review evidence gate
   * has no required shapes to demand.
   */
  async function seedInReviewIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const prefix = `DG${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Done Gate Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "InvestigationBot",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Establish the config layer governing first cold requests",
      description: "Investigation. Scoped remediation-out by design; there is no commit to cite.",
      status: "in_review",
      priority: "high",
      issueNumber: 1,
      identifier: `${prefix}-1`,
      assigneeAgentId: agentId,
      // The lock was released by the in_progress -> in_review transition.
      executionRunId: null,
    });

    return { companyId, issueId, agentId, runId };
  }

  /** A sourced findings comment — prose only, deliberately no GitHub URL. */
  async function addFindingsComment(companyId: string, issueId: string, agentId: string, runId: string) {
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: [
        "## Findings",
        "Six sections of sourced analysis. The effective timeout is 60s, set at the",
        "ingress layer, confirmed from source at config/values.yaml:112.",
        "Concluding: the premise in the parent issue was wrong.",
      ].join("\n"),
      authorAgentId: agentId,
      authorUserId: null,
      createdByRunId: runId,
      createdAt: new Date(),
    });
  }

  /** Write a real issue document the way the route does: run-attributed revision. */
  async function addRunAttributedDocument(
    companyId: string,
    issueId: string,
    agentId: string,
    runId: string | null,
    key = "findings",
  ) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Findings",
      format: "markdown",
      latestBody: "## Findings\nThe effective timeout is 60s, set at the ingress layer.",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Findings",
      format: "markdown",
      body: "## Findings\nThe effective timeout is 60s, set at the ingress layer.",
      createdByAgentId: agentId,
      createdByRunId: runId,
    });
    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key,
    });
    return { documentId, revisionId };
  }

  async function patchToDone(agentId: string, companyId: string, runId: string | null, issueId: string) {
    return await request(createApp(agentId, companyId, runId))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
  }

  // (a) The invariant. If this ever returns 200 the gate has been deleted.
  it("rejects a close whose only evidence is a comment body, with the reason string unchanged", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addFindingsComment(companyId, issueId, agentId, runId);

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      reason: "no_execution_run_and_no_pr_evidence",
      issueId,
    });
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted.status).toBe("in_review");
  });

  // (b) The fix. Investigation-shaped: null executionRunId, no pr-link, but a
  // durable run-attributed document a reviewer can open.
  it("accepts a close backed by a run-attributed issue document (null executionRunId, no pr-link)", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addFindingsComment(companyId, issueId, agentId, runId);
    await addRunAttributedDocument(companyId, issueId, agentId, runId);

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted.status).toBe("done");
    // The premise of the test: neither legacy escape hatch was available.
    expect(persisted.executionRunId).toBeNull();
  });

  it("does not accept an old run-attributed document revision when the latest revision is runless", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId } = await addRunAttributedDocument(companyId, issueId, agentId, runId);
    const latestRevisionId = randomUUID();
    await db.insert(documentRevisions).values({
      id: latestRevisionId,
      companyId,
      documentId,
      revisionNumber: 2,
      title: "Findings",
      format: "markdown",
      body: "## Findings\nA board-side edit replaced the run-authored version.",
      createdByAgentId: agentId,
      createdByRunId: null,
    });
    await db
      .update(documents)
      .set({
        latestBody: "## Findings\nA board-side edit replaced the run-authored version.",
        latestRevisionId,
        latestRevisionNumber: 2,
      })
      .where(eq(documents.id, documentId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  // (c) Regression guard for the original gate behaviour.
  it("accepts a close when an execution run is still held, with no artifact and no pr-link", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted.status).toBe("done");
  });

  it("accepts a close backed by a run-attributed artifact work product", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      url: "https://paperclip.blockcast.net/BLO/artifacts/timeout-archaeology",
      status: "active",
      createdByRunId: runId,
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  it("accepts a close backed by an attachment-backed artifact work product", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const attachmentId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      status: "active",
      createdByRunId: runId,
      metadata: {
        attachmentId,
        contentType: "text/markdown",
        byteSize: 128,
        contentPath: `/api/attachments/${attachmentId}/content`,
        openPath: `/api/attachments/${attachmentId}/content`,
        downloadPath: `/api/attachments/${attachmentId}/content?download=1`,
      },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  // Narrowing tests: these are the shapes that must NOT qualify. Each one is a
  // way the gate could be silently widened by a later refactor.
  it("does not accept a plan document as completion evidence", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    // A plan is authored at the START of the work — intent, not deliverable.
    await addRunAttributedDocument(companyId, issueId, agentId, runId, "plan");

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept a continuation-summary document (platform scaffolding, not agent output)", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addRunAttributedDocument(companyId, issueId, agentId, runId, "continuation-summary");

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
  });

  it("does not accept a document with no run attribution (the runless board-API narrator)", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId } = await seedInReviewIssue();
    await addRunAttributedDocument(companyId, issueId, agentId, null);

    const response = await patchToDone(agentId, companyId, null, issueId);

    expect(response.status).toBe(422);
  });

  it("does not accept an empty document body", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId, revisionId } = await addRunAttributedDocument(
      companyId,
      issueId,
      agentId,
      runId,
    );
    await db.update(documents).set({ latestBody: "" }).where(eq(documents.id, documentId));
    await db.update(documentRevisions).set({ body: "" }).where(eq(documentRevisions.id, revisionId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
  });

  it("does not accept a whitespace-only document body", async () => {
    // The cheapest possible evasion: a body that is not `''` but carries
    // nothing. Must be indistinguishable from empty.
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId, revisionId } = await addRunAttributedDocument(companyId, issueId, agentId, runId);
    await db.update(documents).set({ latestBody: "   \n\t  \n" }).where(eq(documents.id, documentId));
    await db.update(documentRevisions).set({ body: "   \n\t  \n" }).where(eq(documentRevisions.id, revisionId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept an active title-only artifact work product", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      status: "active",
      createdByRunId: runId,
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept an inactive artifact work product, even with an inspectable locator", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      url: "https://paperclip.blockcast.net/BLO/artifacts/timeout-archaeology",
      status: "archived",
      createdByRunId: runId,
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept a pull_request work product as a durable artifact (pr-link path owns that)", async () => {
    // Narrow on purpose: if `pull_request` counted here, a work-product row
    // with no verified PR URL would bypass the pr-link evidence check.
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "not a verified PR link",
      status: "active",
      createdByRunId: runId,
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
  });

  it("leaves the gate off by default (no instance settings row)", async () => {
    // No enableDoneExecutionGate() call: the flag defaults to false, so even a
    // comment-only close succeeds. Guards against the gate becoming on-by-default.
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addFindingsComment(companyId, issueId, agentId, runId);

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });
});

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueAttachments,
  issueDocuments,
  issueWorkProducts,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const LOW_TRUST_REVIEW_PRESET = "low_trust_review" as const;

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
    await db.delete(issueAttachments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(assets);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(projects);
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
    sourceTrust: Record<string, unknown> | null = null,
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
      sourceTrust,
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

  async function addIssueAttachment(companyId: string, issueId: string, agentId: string) {
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "memory",
      objectKey: `test/${assetId}.md`,
      contentType: "text/markdown",
      byteSize: 128,
      sha256: "0".repeat(64),
      originalFilename: "findings.md",
      createdByAgentId: agentId,
    });
    await db.insert(issueAttachments).values({
      id: attachmentId,
      companyId,
      issueId,
      assetId,
    });
    return attachmentId;
  }

  async function addExecutionWorkspace(companyId: string, issueId: string) {
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Done Gate Project",
      status: "active",
    });
    await db.update(issues).set({ projectId }).where(eq(issues.id, issueId));
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "agent",
      strategyType: "isolated",
      name: "Investigation workspace",
      status: "active",
      cwd: "/tmp/paperclip-done-gate",
      providerType: "local_fs",
    });
    return workspaceId;
  }

  function quarantinedSourceTrust(issueId: string, runId: string, agentId: string) {
    return {
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "quarantined",
      sourceIssueId: issueId,
      sourceRunId: runId,
      sourceAgentId: agentId,
    };
  }

  function promotedSourceTrust(issueId: string, artifactKind: "document" | "work_product", artifactId: string) {
    return {
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "promoted",
      sourceIssueId: issueId,
      promotedFrom: {
        artifactKind,
        artifactId,
        issueId,
      },
      promotedByActorType: "user",
      promotedByActorId: "board-user",
      promotedAt: "2026-07-31T00:00:00.000Z",
    };
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

  it("does not accept a quarantined low-trust issue document as completion evidence", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addRunAttributedDocument(
      companyId,
      issueId,
      agentId,
      runId,
      "findings",
      quarantinedSourceTrust(issueId, runId, agentId),
    );

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("accepts a promoted low-trust issue document as completion evidence", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId } = await addRunAttributedDocument(companyId, issueId, agentId, runId);
    await db
      .update(documents)
      .set({ sourceTrust: promotedSourceTrust(issueId, "document", documentId) })
      .where(eq(documents.id, documentId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
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

  // (c) BLO-20691 — the false-positive close path.
  //
  // `executionRunId` is a DISPATCH lock: `heartbeat.ts` stamps it on a merely
  // queued run and never touches `checkoutRunId`, and the process-loss retry
  // path stamps it while explicitly nulling checkout. Under the old predicate
  // (`existingExecutionRunId != null → pass`) this state closed the issue on
  // comment-only prose, so anything that made the dispatcher touch an issue
  // satisfied the gate. Observed on BLO-20192: the same deliverable was
  // rejected at 04:43 with no run, then accepted at 04:45 once a queued run
  // held the lock.
  //
  // This case FAILS against master (it returns 200 there) and is the whole
  // point of the change.
  it("rejects a close held open only by a queued dispatch lock that never reached checkout", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addFindingsComment(companyId, issueId, agentId, runId);
    // Exactly what the dispatcher writes: the lock, with checkout still null.
    await db
      .update(issues)
      .set({ executionRunId: runId, checkoutRunId: null })
      .where(eq(issues.id, issueId));

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({
      reason: "no_execution_run_and_no_pr_evidence",
      issueId,
    });
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted.status).toBe("in_review");
    // The premise: the lock really was held, and it really was not a checkout.
    expect(persisted.executionRunId).toBe(runId);
    expect(persisted.checkoutRunId).toBeNull();
  });

  // (d) BLO-19081's regression guard, restated against the column that means
  // what it was always assumed to mean.
  //
  // The genuine single-patch close: a run checked the issue out (which sets
  // `checkoutRunId` AND `executionRunId` together — see the checkout path in
  // issues.ts), did the work, and closes straight from `in_progress` while the
  // lock is still held. This must keep passing with no artifact and no pr-link;
  // blocking it would trade one false negative for another.
  it("accepts a genuine single-patch in_progress -> done close by the run that checked out", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db
      .update(issues)
      .set({ status: "in_progress", checkoutRunId: runId, executionRunId: runId })
      .where(eq(issues.id, issueId));

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

  it("does not accept a syntactically non-openable artifact URL", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      url: "x",
      status: "active",
      createdByRunId: runId,
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept a quarantined low-trust artifact work product", async () => {
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
      sourceTrust: quarantinedSourceTrust(issueId, runId, agentId),
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("accepts a promoted low-trust artifact work product", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const workProductId = randomUUID();
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Timeout archaeology dump",
      url: "https://paperclip.blockcast.net/BLO/artifacts/timeout-archaeology",
      status: "active",
      createdByRunId: runId,
      sourceTrust: promotedSourceTrust(issueId, "work_product", workProductId),
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  it("accepts a close backed by a real attachment-backed artifact work product", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const attachmentId = await addIssueAttachment(companyId, issueId, agentId);
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

  it("does not accept a dangling attachment-backed artifact work product", async () => {
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

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("accepts a run-attributed work product that references a real issue document", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId } = await addRunAttributedDocument(companyId, issueId, agentId, runId);
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Findings document",
      status: "active",
      createdByRunId: runId,
      metadata: { documentId },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  it("accepts a run-attributed work product that references a real issue document by key", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addRunAttributedDocument(companyId, issueId, agentId, runId, "findings");
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Findings document",
      status: "active",
      createdByRunId: runId,
      metadata: { documentKey: "findings" },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  it("does not accept a document work product that points at a runless document by id", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const { documentId } = await addRunAttributedDocument(companyId, issueId, agentId, null);
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Runless findings pointer",
      status: "active",
      createdByRunId: runId,
      metadata: { documentId },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept a document work product that points at a runless document by key", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await addRunAttributedDocument(companyId, issueId, agentId, null, "findings");
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Runless findings pointer",
      status: "active",
      createdByRunId: runId,
      metadata: { documentKey: "findings" },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("accepts a run-attributed work product that references a real execution workspace file", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const workspaceId = await addExecutionWorkspace(companyId, issueId);
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: "Workspace findings file",
      status: "active",
      createdByRunId: runId,
      metadata: {
        resourceRef: {
          kind: "workspace_file",
          issueId,
          workspaceKind: "execution_workspace",
          workspaceId,
          relativePath: "findings.md",
          displayPath: "findings.md",
        },
      },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(200);
  });

  it("stamps route-created work products with the authenticated run and rejects forged run ids", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    const attachmentId = await addIssueAttachment(companyId, issueId, agentId);
    const app = createApp(agentId, companyId, runId);

    const forged = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "paperclip",
      title: "Forged artifact",
      url: "https://paperclip.blockcast.net/BLO/artifacts/forged",
      createdByRunId: randomUUID(),
    });
    expect(forged.status).toBe(403);
    expect(forged.body.error).toBe("createdByRunId must match the authenticated agent run");

    await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "paperclip",
      title: "Route artifact",
      url: "https://paperclip.blockcast.net/BLO/artifacts/route-artifact",
      metadata: { attachmentId },
      createdByRunId: runId,
    }).expect(201);

    const rows = await db
      .select({
        title: issueWorkProducts.title,
        createdByRunId: issueWorkProducts.createdByRunId,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId));
    expect(rows).toEqual([
      {
        title: "Route artifact",
        createdByRunId: runId,
      },
    ]);
  });

  it("does not accept a work product that references a dangling document id", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Findings document",
      status: "active",
      createdByRunId: runId,
      metadata: { documentId: randomUUID() },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
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

  it("does not accept an empty resourceRef artifact work product", async () => {
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
      metadata: { resourceRef: {} },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept fabricated attachment paths without a resolved attachment id", async () => {
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
      metadata: {
        contentPath: "/api/attachments/not-real/content",
        openPath: "/api/attachments/not-real/content",
        downloadPath: "/api/attachments/not-real/content?download=1",
      },
    });

    const response = await patchToDone(agentId, companyId, runId, issueId);

    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ reason: "no_execution_run_and_no_pr_evidence" });
  });

  it("does not accept a work product that references a dangling document key", async () => {
    await enableDoneExecutionGate();
    const { companyId, issueId, agentId, runId } = await seedInReviewIssue();
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "document",
      provider: "paperclip",
      title: "Findings document",
      status: "active",
      createdByRunId: runId,
      metadata: { documentKey: "nonexistent-findings" },
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

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issueLabels,
  issues,
  labels,
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
    `Skipping embedded Postgres issue evidence PATCH tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PATCH /issues/:id evidence gate", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-patch-evidence-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedFrontendIssue(status: "in_progress" | "in_review" = "in_progress") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const labelId = randomUUID();
    const prefix = `EG${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Evidence Gate Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "frontend",
      color: "#000000",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ship frontend change",
      description: "## Done when\n- desktop works\n- mobile works\n- tests pass",
      status,
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await db.insert(issueLabels).values({ issueId, labelId, companyId });

    return { companyId, issueId };
  }

  it("rejects a computed block with the structured 422 contract and rolls back", async () => {
    const { issueId } = await seedFrontendIssue();

    const response = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "missing-evidence",
      missing: expect.arrayContaining([
        "screenshot:1440x900",
        "screenshot:390x844",
        "checklist:done-when",
      ]),
    });
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted).toMatchObject({ status: "in_progress", lastEvidenceVerdict: null });
  });

  it("accepts a recent user override and persists its audit fields", async () => {
    const { companyId, issueId } = await seedFrontendIssue();
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "evidence-gate: override incident response requires landing now",
      authorUserId: "operator-1",
      authorAgentId: null,
      createdAt: new Date(),
    });

    const response = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: "in_review",
      lastEvidenceVerdict: {
        verdict: "pass",
        overridden: true,
        overrideReason: "incident response requires landing now",
      },
    });
  });

  it("grandfathers updates to an issue already in review", async () => {
    const { issueId } = await seedFrontendIssue("in_review");

    const response = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated while under review" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: "in_review",
      title: "Updated while under review",
      lastEvidenceVerdict: null,
    });
  });
});

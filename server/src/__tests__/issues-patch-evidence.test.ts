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
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueLabels);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(agents);
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
    const agentId = randomUUID();
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
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "EvidenceBot",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
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

    return { companyId, issueId, agentId };
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

  // BLO-19047 Defect A: the gate used to run only on the in_review TRANSITION,
  // so an agent following the documented remediation loop ("add the missing
  // evidence, comment again, re-send in_review") got a 200 with a stale verdict
  // and no way to tell "gate ran and still fails" from "gate never ran".
  describe("in_review -> in_review re-evaluation", () => {
    const COMPLETE_FRONTEND_EVIDENCE = [
      "![desktop](./shot_desktop_1440x900.png)",
      "![mobile](./shot_mobile_390x844.png)",
      "https://github.com/Blockcast/paperclip/pull/999",
      "",
      "| Criterion | Status |",
      "|---|---|",
      "| desktop works | ✅ |",
      "| mobile works | ✅ |",
      "| tests pass | ✅ |",
    ].join("\n");

    it("re-evaluates and records a verdict when status is re-sent as in_review", async () => {
      const { issueId } = await seedFrontendIssue("in_review");

      const response = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" });

      // 200 because a re-evaluation never rejects, but the verdict is now
      // recorded rather than left frozen at null.
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.lastEvidenceVerdict).toMatchObject({ verdict: "block" });
      expect(response.body.lastEvidenceVerdictEvaluatedAt).toBeTruthy();
    });

    it("clears a stale failing verdict once the missing evidence is posted", async () => {
      const { companyId, issueId, agentId } = await seedFrontendIssue("in_review");
      // Freeze a failing verdict, as the original in_review transition would.
      await db
        .update(issues)
        .set({
          lastEvidenceVerdict: { verdict: "block", missing: ["screenshot:1440x900"] } as any,
          lastEvidenceVerdictEvaluatedAt: new Date("2026-07-30T11:48:19.000Z"),
        })
        .where(eq(issues.id, issueId));
      await db.insert(issueComments).values({
        companyId,
        issueId,
        body: COMPLETE_FRONTEND_EVIDENCE,
        authorAgentId: agentId,
        authorUserId: null,
        createdAt: new Date(),
      });

      const response = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.lastEvidenceVerdict).toMatchObject({
        verdict: "pass",
        missing: [],
      });
      // The frozen 11:48:19Z evaluation must have been superseded.
      expect(
        new Date(response.body.lastEvidenceVerdictEvaluatedAt).getTime(),
      ).toBeGreaterThan(new Date("2026-07-30T11:48:19.000Z").getTime());
    });

    it("never rejects a re-evaluation, even when the verdict is block", async () => {
      const { issueId } = await seedFrontendIssue("in_review");

      const response = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review", title: "Still under review" });

      // A real transition into in_review with this evidence is a 422 (see the
      // first test in this file). Re-sending it on an already-in_review issue
      // must not start failing unrelated patches.
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        status: "in_review",
        title: "Still under review",
      });
    });

    it("keeps durable landing evidence that has aged out of the comment window", async () => {
      // done-gate.ts reads the STORED verdict's allDetected as the standing
      // record that a PR was attached. The evaluator only scans the 10 newest
      // agent comments, so a re-evaluation must not erase that record just
      // because the thread grew — that would fail a later `done` transition
      // with no_execution_run_and_no_pr_evidence on an issue that did ship.
      const { companyId, issueId, agentId } = await seedFrontendIssue("in_review");
      await db
        .update(issues)
        .set({
          lastEvidenceVerdict: {
            verdict: "pass",
            missing: [],
            allDetected: ["pr-link", "landing-artifact", "checklist:done-when"],
          } as any,
          lastEvidenceVerdictEvaluatedAt: new Date("2026-07-30T11:48:19.000Z"),
        })
        .where(eq(issues.id, issueId));
      // 12 newer comments with no PR link push the original out of the window.
      for (let i = 0; i < 12; i += 1) {
        await db.insert(issueComments).values({
          companyId,
          issueId,
          body: `review note ${i}`,
          authorAgentId: agentId,
          authorUserId: null,
          createdAt: new Date(Date.parse("2026-07-30T12:00:00.000Z") + i * 1000),
        });
      }

      const response = await request(createApp())
        .patch(`/api/issues/${issueId}`)
        .send({ status: "in_review" });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Freshly computed fields reflect the current window...
      expect(response.body.lastEvidenceVerdict).toMatchObject({ verdict: "block" });
      // ...but the durable landing fact survives.
      expect(response.body.lastEvidenceVerdict.allDetected).toEqual(
        expect.arrayContaining(["pr-link", "landing-artifact"]),
      );
    });
  });
});

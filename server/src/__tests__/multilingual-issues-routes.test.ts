import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres multilingual issue route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("multilingual issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;

  const title = "验证中文任务";
  const description = [
    "请用中文回复并保留上下文。",
    "日本語: 次の手順を書いてください。",
    "हिन्दी: कृपया स्थिति बताएं।",
  ].join("\n");
  const firstReply = [
    "结果: 中文响应保留。",
    "日本語の返信も保持。",
    "हिन्दी उत्तर भी सुरक्षित है।",
  ].join("\n");
  const completionNote = [
    "完成: 已验证中文。",
    "日本語: 完了しました。",
    "हिन्दी: सत्यापन पूरा हुआ।",
  ].join("\n");
  const documentBody = [
    "# QA notes",
    "",
    "- 中文: 可以创建、读取、搜索、评论。",
    "- 日本語: ドキュメント本文を保持します。",
    "- हिन्दी: दस्तावेज़ पाठ सुरक्षित रहता है।",
  ].join("\n");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-multilingual-issues-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "Multilingual tenant",
      issuePrefix: "LNG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in multilingual issue route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in multilingual issue route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        // cloud_tenant actors are never instance admins — reads flow through
        // the active company membership seeded in beforeAll.
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  it("creates an issue with multilingual title and description", async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title,
        description,
        status: "todo",
        priority: "medium",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      title,
      description,
      status: "todo",
      priority: "medium",
      identifier: "LNG-1",
    });
  });

  it("reads the multilingual title and description unchanged", async () => {
    const getRes = await request(app).get("/api/issues/LNG-1");
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body.title).toBe(title);
    expect(getRes.body.description).toBe(description);
  });

  it("finds the issue by Chinese search text", async () => {
    const searchRes = await request(app).get(`/api/companies/${companyId}/issues`).query({ q: "中文" });
    expect(searchRes.status, JSON.stringify(searchRes.body)).toBe(200);
    expect(searchRes.body.map((issue: { identifier: string }) => issue.identifier)).toContain("LNG-1");
  });

  it("preserves multilingual comment bodies", async () => {
    const commentRes = await request(app)
      .post("/api/issues/LNG-1/comments")
      .send({ body: firstReply });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(commentRes.body.body).toBe(firstReply);
  });

  it("preserves multilingual document bodies", async () => {
    const documentRes = await request(app)
      .put("/api/issues/LNG-1/documents/qa-notes")
      .send({
        title: "Multilingual QA",
        format: "markdown",
        body: documentBody,
      });
    expect(documentRes.status, JSON.stringify(documentRes.body)).toBe(201);
    expect(documentRes.body.body).toBe(documentBody);
  });

  it("preserves multilingual completion comments", async () => {
    const completeRes = await request(app)
      .patch("/api/issues/LNG-1")
      .send({ status: "done", comment: completionNote });
    expect(completeRes.status, JSON.stringify(completeRes.body)).toBe(200);
    expect(completeRes.body.status).toBe("done");
    expect(completeRes.body.comment.body).toBe(completionNote);
  });

  it("lists multilingual comments in write order", async () => {
    const commentsRes = await request(app).get("/api/issues/LNG-1/comments").query({ order: "asc" });
    expect(commentsRes.status, JSON.stringify(commentsRes.body)).toBe(200);
    expect(commentsRes.body.map((comment: { body: string }) => comment.body)).toEqual([
      firstReply,
      completionNote,
    ]);
  });

  it("exposes multilingual issue text in heartbeat context", async () => {
    const heartbeatContextRes = await request(app).get("/api/issues/LNG-1/heartbeat-context");
    expect(heartbeatContextRes.status, JSON.stringify(heartbeatContextRes.body)).toBe(200);
    expect(heartbeatContextRes.body.issue.title).toBe(title);
    expect(heartbeatContextRes.body.issue.description).toBe(description);
    expect(heartbeatContextRes.body.commentCursor.totalComments).toBe(2);
  });

  // PEN-5954. Until this row, `multilineTextSchema` rewrote a literal
  // backslash-n, backslash-r and backslash-r-backslash-n to a single U+000A
  // during input validation, so the field stored a different value than the
  // caller sent and nothing in the response reported it. These cases ride on
  // the same embedded-Postgres instance above and assert the round trip by
  // byte identity, read back through a separate request.
  //
  // `literalEscapeSpecimen` is deliberately a SINGLE line: every shape in it is
  // a literal backslash sequence, so a stored value carrying any U+000A at all
  // means the write path invented one.
  const literalEscapeSpecimen = [
    String.raw`\n`,
    String.raw`\r`,
    String.raw`\r\n`,
    String.raw`\\n`,
    String.raw`\t`,
    String.raw`\\`,
    String.raw`\"`,
    String.raw`\u0041`,
    String.raw`\U00000041`,
    String.raw`\x41`,
    String.raw`\0`,
    String.raw`\b`,
    String.raw`\f`,
    String.raw`\v`,
    String.raw`\a`,
    String.raw`\/`,
    String.raw`\'`,
    String.raw`\N`,
    String.raw`\z`,
  ].join(" ");

  it("stores literal backslash escapes in a title and description verbatim", async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: `escape specimen ${String.raw`\n`}`,
        description: literalEscapeSpecimen,
        status: "todo",
        priority: "medium",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body.identifier).toBe("LNG-2");

    const getRes = await request(app).get("/api/issues/LNG-2");
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body.title).toBe(`escape specimen ${String.raw`\n`}`);
    expect(getRes.body.description).toBe(literalEscapeSpecimen);
    expect(getRes.body.description).not.toContain("\n");
  });

  it("stores literal backslash escapes in a comment body verbatim", async () => {
    const commentRes = await request(app)
      .post("/api/issues/LNG-2/comments")
      .send({ body: literalEscapeSpecimen });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const commentsRes = await request(app).get("/api/issues/LNG-2/comments").query({ order: "asc" });
    expect(commentsRes.status, JSON.stringify(commentsRes.body)).toBe(200);
    expect(commentsRes.body.map((comment: { body: string }) => comment.body)).toEqual([
      literalEscapeSpecimen,
    ]);
    expect(commentsRes.body[0].body).not.toContain("\n");
  });

  it("stores literal backslash escapes in a document body verbatim", async () => {
    const documentRes = await request(app)
      .put("/api/issues/LNG-2/documents/escape-specimen")
      .send({
        title: "Escape specimen",
        format: "markdown",
        body: literalEscapeSpecimen,
      });
    expect(documentRes.status, JSON.stringify(documentRes.body)).toBe(201);

    const readRes = await request(app).get("/api/issues/LNG-2/documents/escape-specimen");
    expect(readRes.status, JSON.stringify(readRes.body)).toBe(200);
    expect(readRes.body.body).toBe(literalEscapeSpecimen);
    expect(readRes.body.body).not.toContain("\n");
  });

  it("keeps a real line break a real line break", async () => {
    // The control arm: the fix must not reach text that genuinely carries
    // U+000A, or the assertions above would pass on a path that strips
    // newlines instead of one that preserves bytes.
    const realNewlines = "first line\nsecond line";
    const commentRes = await request(app)
      .post("/api/issues/LNG-2/comments")
      .send({ body: realNewlines });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(commentRes.body.body).toBe(realNewlines);
    expect(commentRes.body.body.split("\n")).toHaveLength(2);
  });
});

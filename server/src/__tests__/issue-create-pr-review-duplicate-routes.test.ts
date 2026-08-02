/**
 * BLO-20526 — the server-side guard against duplicate "Review PR #N" issues
 * filed at the configured PR reviewer instead of using the sanctioned
 * `<!-- paperclip:review-request -->` marker-comment path.
 *
 * The guard must be narrow: it exists to kill one specific load amplifier
 * (44% of the reviewer's 24h runs at time of filing), not to make the reviewer
 * un-assignable. Most of the cases below are therefore negative cases pinning
 * down what it must NOT reject.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { __test_buildPrReviewerTaskKey } from "../routes/github-webhook.js";
import {
  DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE,
  buildPrReviewTaskKey,
  parsePullRequestRefs,
} from "../services/pr-review-duplicate-issue-guard.js";

const REPO = "Blockcast/pim-multicast-gateway";
const NORMALIZED_REPO = REPO.toLowerCase();
const PR_NUMBER = 1911;
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const NORMALIZED_PR_URL = `https://github.com/${NORMALIZED_REPO}/pull/${PR_NUMBER}`;
const TASK_KEY = `pr_review:${NORMALIZED_REPO}:${PR_NUMBER}`;

describe("pr review duplicate issue guard (pure helpers)", () => {
  it("builds the same task key the GitHub webhook writes to context_task_key", () => {
    // These two implementations live in different modules; if they ever drift
    // the guard silently stops matching live review scopes and the amplifier
    // comes back with no failing test. Pin the equivalence directly.
    const webhookKey = __test_buildPrReviewerTaskKey({
      repoFullName: REPO,
      prNumber: PR_NUMBER,
    } as never);
    expect(buildPrReviewTaskKey({ repoFullName: REPO, prNumber: PR_NUMBER })).toBe(webhookKey);
    expect(webhookKey).toBe(TASK_KEY);
  });

  it("extracts unique PR refs from title and description", () => {
    expect(
      parsePullRequestRefs(
        `Review ${REPO} PR #${PR_NUMBER} exact head 8ee6f12d60`,
        `See ${PR_URL} and http://www.github.com/Blockcast/paperclip/pull/925 and ${PR_URL} again`,
      ),
    ).toEqual([
      { repoFullName: NORMALIZED_REPO, prNumber: PR_NUMBER },
      { repoFullName: "blockcast/paperclip", prNumber: 925 },
    ]);
  });

  it("normalizes GitHub repository casing when parsing and keying PR refs", () => {
    const mixedCaseUrl = "https://github.com/BLOCKCAST/PiM-Multicast-Gateway/pull/1911";
    expect(parsePullRequestRefs(mixedCaseUrl)).toEqual([
      { repoFullName: NORMALIZED_REPO, prNumber: PR_NUMBER },
    ]);
    expect(buildPrReviewTaskKey({ repoFullName: "BLOCKCAST/PiM-Multicast-Gateway", prNumber: PR_NUMBER }))
      .toBe(TASK_KEY);
  });

  it("ignores a bare #N with no repo, and non-PR or non-GitHub URLs", () => {
    // A bare "#1911" cannot be resolved to a repo, so matching it would risk
    // rejecting a legitimate issue that shares a number with a busy PR.
    expect(parsePullRequestRefs("Review PR #1911 exact head abc", null)).toEqual([]);
    expect(parsePullRequestRefs(`https://github.com/${REPO}/issues/1911`)).toEqual([]);
    expect(parsePullRequestRefs(`https://gitlab.com/${REPO}/pull/1911`)).toEqual([]);
    expect(parsePullRequestRefs(`https://github.example.com/${REPO}/pull/1911`)).toEqual([]);
  });

  it("rejects PR numbers that are not canonical positive integers", () => {
    expect(parsePullRequestRefs(`https://github.com/${REPO}/pull/007`)).toEqual([]);
    expect(parsePullRequestRefs(`https://github.com/${REPO}/pull/0`)).toEqual([]);
  });

  it("is not corrupted by regex lastIndex state across calls", () => {
    const text = `${PR_URL} ${PR_URL.replace("1911", "1912")}`;
    expect(parsePullRequestRefs(text)).toHaveLength(2);
    expect(parsePullRequestRefs(text)).toHaveLength(2);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR-review duplicate guard route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create PR-review duplicate guard routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousReviewerEnv = process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-pr-review-guard-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    // Issue creation enqueues the assignee wake fire-and-forget, so an
    // agent_wakeup_requests row can land *after* an ordered per-table delete
    // and re-break the agents FK. TRUNCATE ... CASCADE is atomic and pulls in
    // every referencing table, so cleanup can't lose that race.
    await db.execute(
      sql`truncate table ${activityLog}, ${issues}, ${heartbeatRuns}, ${agentWakeupRequests}, ${agents}, ${companies} cascade`,
    );
    if (previousReviewerEnv === undefined) delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;
    else process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS = previousReviewerEnv;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning();
    return agent!;
  }

  /** Registers `agentId` as a configured PR reviewer for this test only. */
  function configureReviewer(...agentIds: string[]) {
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS = agentIds.join(",");
  }

  async function seedReviewRun(
    companyId: string,
    agentId: string,
    opts: { status: string; taskKey?: string } = { status: "queued" },
  ) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: opts.status,
      // context_task_key is a generated column over context_snapshot->>'taskKey',
      // exactly as the webhook writes it.
      contextSnapshot: { taskKey: opts.taskKey ?? TASK_KEY },
    }).returning();
    return run!;
  }

  async function setup() {
    const companyId = await seedCompany();
    const reviewer = await seedAgent(companyId, "Ally");
    configureReviewer(reviewer.id);
    return { companyId, reviewer, app: createApp() };
  }

  function reviewIssueBody(reviewerId: string, overrides: Record<string, unknown> = {}) {
    return {
      title: `Review ${REPO} PR #${PR_NUMBER} exact head 8ee6f12d60`,
      description: `Please review ${PR_URL} at head 8ee6f12d60.`,
      assigneeAgentId: reviewerId,
      ...overrides,
    };
  }

  it("rejects a duplicate review issue when the reviewer already has that PR queued", async () => {
    const { companyId, reviewer, app } = await setup();
    const run = await seedReviewRun(companyId, reviewer.id, { status: "queued" });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id))
      .expect(409);

    expect(res.body.code).toBe(DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE);
    // The error has to be actionable enough that the filing agent can recover
    // without reading the source — name the marker path and the live run.
    expect(res.body.remediation).toContain("<!-- paperclip:review-request -->");
    expect(res.body.remediation).toContain(NORMALIZED_PR_URL);
    expect(res.body.error).toContain(`${NORMALIZED_REPO}#${PR_NUMBER}`);
    expect(res.body.details).toMatchObject({
      taskKey: TASK_KEY,
      repoFullName: NORMALIZED_REPO,
      prNumber: PR_NUMBER,
      existingRunId: run.id,
      existingRunStatus: "queued",
    });
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("rejects when the PR URL appears only in the description", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id, { title: "Follow up on the multicast gateway change" }))
      .expect(409);
  });

  for (const status of ["queued", "running", "scheduled_retry"]) {
    it(`rejects while the existing review run is ${status}`, async () => {
      const { companyId, reviewer, app } = await setup();
      await seedReviewRun(companyId, reviewer.id, { status });

      await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send(reviewIssueBody(reviewer.id))
        .expect(409);
    });
  }

  it("also guards the child-create route", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent",
      status: "todo",
      priority: "medium",
    }).returning();

    await request(app)
      .post(`/api/issues/${parent!.id}/children`)
      .send(reviewIssueBody(reviewer.id))
      .expect(409);
  });

  // ---- Negative cases: what the guard must NOT reject ----

  it("accepts an issue for the reviewer that references no PR", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Improve the reviewer's own verdict-formatting tooling",
        description: "No pull request reference here.",
        assigneeAgentId: reviewer.id,
      })
      .expect(201);
  });

  it("accepts an issue referencing a different PR than the live run", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id, {
      status: "queued",
      taskKey: `pr_review:${NORMALIZED_REPO}:9999`,
    });

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id))
      .expect(201);
  });

  it("rejects when the live review is already running on another configured reviewer", async () => {
    const companyId = await seedCompany();
    const reviewerA = await seedAgent(companyId, "Ally A");
    const reviewerB = await seedAgent(companyId, "Ally B");
    configureReviewer(reviewerA.id, reviewerB.id);
    await seedReviewRun(companyId, reviewerA.id, { status: "running" });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewerB.id))
      .expect(409);

    expect(res.body.code).toBe(DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE);
    expect(res.body.details).toMatchObject({
      taskKey: TASK_KEY,
      repoFullName: NORMALIZED_REPO,
      prNumber: PR_NUMBER,
      existingRunStatus: "running",
    });
  });

  it("rejects lowercased PR URLs against already-live mixed-case task keys", async () => {
    const { companyId, reviewer, app } = await setup();
    const legacyTaskKey = `pr_review:${REPO}:${PR_NUMBER}`;
    const run = await seedReviewRun(companyId, reviewer.id, {
      status: "queued",
      taskKey: legacyTaskKey,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id, {
        title: "Review lowercased permalink",
        description: `Please review ${NORMALIZED_PR_URL}`,
      }))
      .expect(409);

    expect(res.body.details).toMatchObject({
      taskKey: legacyTaskKey,
      repoFullName: NORMALIZED_REPO,
      prNumber: PR_NUMBER,
      existingRunId: run.id,
    });
  });

  it("replays an idempotent create before applying the duplicate-review rejection", async () => {
    const { companyId, reviewer, app } = await setup();
    const idempotencyKey = `review-request-${randomUUID()}`;
    const body = reviewIssueBody(reviewer.id, { idempotencyKey });

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(body)
      .expect(201);
    await seedReviewRun(companyId, reviewer.id, { status: "queued" });

    const replayed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(body)
      .expect(200);

    expect(replayed.body.id).toBe(created.body.id);
    expect(replayed.body.deduplicated).toBe(true);
    expect(replayed.body.deduplicationReason).toBe("idempotency_key");
  });

  it("accepts a fresh review request once the previous run is terminal", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id, { status: "completed" });
    await seedReviewRun(companyId, reviewer.id, { status: "failed" });

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id))
      .expect(201);
  });

  it("accepts the same issue when the assignee is not a configured reviewer", async () => {
    const { companyId, reviewer, app } = await setup();
    const other = await seedAgent(companyId, "MulticastEngineer");
    await seedReviewRun(companyId, reviewer.id);

    // The live pr_review scope exists, but it belongs to someone else — the
    // guard keys on collision at the assignee, not on the PR being busy.
    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(other.id))
      .expect(201);
  });

  it("accepts when the reviewer's live run belongs to a different company", async () => {
    const { companyId, reviewer, app } = await setup();
    const otherCompanyId = await seedCompany();
    await db.insert(heartbeatRuns).values({
      companyId: otherCompanyId,
      agentId: reviewer.id,
      status: "queued",
      contextSnapshot: { taskKey: TASK_KEY },
    });

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id))
      .expect(201);
  });

  it("accepts when no reviewer is configured at all", async () => {
    const companyId = await seedCompany();
    const reviewer = await seedAgent(companyId, "Ally");
    configureReviewer();
    await seedReviewRun(companyId, reviewer.id);

    await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send(reviewIssueBody(reviewer.id))
      .expect(201);
  });

  it("accepts an unassigned issue that references a live PR review", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: `Track ${PR_URL} rollout`, description: PR_URL })
      .expect(201);
  });

  it("accepts a duplicate when the kill switch is set", async () => {
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);
    process.env.PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD = "true";
    try {
      await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send(reviewIssueBody(reviewer.id))
        .expect(201);
    } finally {
      delete process.env.PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD;
    }
  });
});

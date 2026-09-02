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
import { issueService } from "../services/issues.js";
import {
  __test_buildPrReviewerTaskKey,
  __test_buildPrReviewerTaskLockKeys,
} from "../routes/github-webhook.js";
import {
  DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE,
  NOT_A_REVIEW_REQUEST_MARKER,
  buildPrReviewTaskKey,
  parsePullRequestRefs,
  taskKeysMatch,
} from "../services/pr-review-duplicate-issue-guard.js";

const REPO = "Blockcast/pim-multicast-gateway";
const NORMALIZED_REPO = REPO.toLowerCase();
const PR_NUMBER = 1911;
const PR_URL = `https://github.com/${REPO}/pull/${PR_NUMBER}`;
const NORMALIZED_PR_URL = `https://github.com/${NORMALIZED_REPO}/pull/${PR_NUMBER}`;
const TASK_KEY = `pr_review:${NORMALIZED_REPO}:${PR_NUMBER}`;

describe("pr review duplicate issue guard (pure helpers)", () => {
  it("resolves the same scope as the legacy key the webhook writes during phase one", () => {
    const webhookKey = __test_buildPrReviewerTaskKey({
      repoFullName: REPO,
      prNumber: PR_NUMBER,
    } as never);
    expect(webhookKey).toBe(`pr_review:${REPO}:${PR_NUMBER}`);
    expect(taskKeysMatch(buildPrReviewTaskKey({ repoFullName: REPO, prNumber: PR_NUMBER }), webhookKey))
      .toBe(true);
  });

  it("does NOT case-fold task keys outside the pr_review scope", () => {
    // The JS predicate must stay behaviourally identical to the SQL one, which
    // only adds its lower() leg for pr_review keys. Without this case a
    // regression that dropped the isPrReviewTaskKey guard would widen equality
    // for EVERY task scope in the system and still ship green: the SQL half has
    // its negative (heartbeat-pr-review-task-key-casing.test.ts), the JS half
    // had only a positive.
    expect(taskKeysMatch("issue:ABC-1", "issue:abc-1")).toBe(false);
    expect(taskKeysMatch("ISSUE:abc-1", "issue:abc-1")).toBe(false);
    // ...while the pr_review scope still folds, in both directions.
    expect(taskKeysMatch(`pr_review:${REPO}:${PR_NUMBER}`, TASK_KEY)).toBe(true);
    expect(taskKeysMatch(TASK_KEY, `pr_review:${REPO}:${PR_NUMBER}`)).toBe(true);
  });

  it("caps how many PR references it will scan from one issue", () => {
    // MAX_SCANNED_PULL_REQUEST_REFS bounds the work a hostile description can
    // cause. Truncation is fail-open (the tail is unguarded), so this pins the
    // bound rather than leaving it as an untested constant.
    const many = Array.from(
      { length: 25 },
      (_, i) => `https://github.com/${NORMALIZED_REPO}/pull/${1000 + i}`,
    ).join("\n");
    expect(parsePullRequestRefs("scan cap", many)).toHaveLength(20);
  });

  it("locks both the normalized and legacy-casing namespaces during rollout", () => {
    // The advisory lock id is hashtextextended(taskKey, 0), so the key's
    // SPELLING is the namespace. A pod on the pre-normalization build derives it
    // from the raw mixed-case repo name; this build lowercases it. If the new
    // build locked only its own spelling, the two would serialize on different
    // ids and could dispatch the same PR concurrently for the whole rolling
    // deployment — assigning two reviewers to one PR, the exact duplicate cost
    // this change removes.
    const lockKeys = __test_buildPrReviewerTaskLockKeys({
      repoFullName: REPO,
      prNumber: PR_NUMBER,
    } as never);

    expect(lockKeys).toContain(TASK_KEY);
    expect(lockKeys).toContain(`pr_review:${REPO}:${PR_NUMBER}`);
    // Sorted and deduped, so two peers contending for the same PR always
    // acquire the pair in one order and cannot livelock on opposite halves.
    expect(lockKeys).toEqual([...lockKeys].sort());
    expect(new Set(lockKeys).size).toBe(lockKeys.length);
  });

  it("locks a single namespace when the repo name is already lowercase", () => {
    // No legacy spelling exists for an all-lowercase repo, so the extra lock
    // must not be taken — it would double advisory-lock traffic for nothing.
    expect(
      __test_buildPrReviewerTaskLockKeys({
        repoFullName: NORMALIZED_REPO,
        prNumber: PR_NUMBER,
      } as never),
    ).toEqual([TASK_KEY]);
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

  it("requires a real boundary after the PR number", () => {
    // "/pull/1911abc" is malformed or belongs to some other scheme; resolving it
    // to PR 1911 would hard-reject a create over text that never referenced it.
    expect(parsePullRequestRefs(`https://github.com/${REPO}/pull/${PR_NUMBER}abc`)).toEqual([]);
    expect(parsePullRequestRefs(`https://github.com/${REPO}/pull/${PR_NUMBER}-old`)).toEqual([]);
    // Legitimate trailing context must still parse.
    for (const suffix of ["", "/files", "#issuecomment-5154854829", ")", ".", " at head abc"]) {
      expect(parsePullRequestRefs(`${PR_URL}${suffix}`)).toEqual([
        { repoFullName: NORMALIZED_REPO, prNumber: PR_NUMBER },
      ]);
    }
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

  for (const [lockSpelling, webhookTaskKey] of [
    ["normalized", TASK_KEY],
    ["pre-compatibility mixed-case", `pr_review:${REPO}:${PR_NUMBER}`],
  ] as const) {
    it(`waits for a racing ${lockSpelling} webhook wake to commit before checking for a duplicate`, async () => {
      const { companyId, reviewer, app } = await setup();
      let releaseWebhook!: () => void;
      let reportLockAcquired!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        reportLockAcquired = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseWebhook = resolve;
      });

      const webhookTransaction = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${webhookTaskKey}, 0))`);
        reportLockAcquired();
        await release;
        await tx.insert(heartbeatRuns).values({
          companyId,
          agentId: reviewer.id,
          status: "queued",
          contextSnapshot: { taskKey: webhookTaskKey },
        });
      });
      await lockAcquired;

      const createRequest = request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send(reviewIssueBody(reviewer.id))
        .then((response) => response);
      await expect(
        Promise.race([
          createRequest.then(() => "settled"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
        ]),
      ).resolves.toBe("waiting");

      releaseWebhook();
      await webhookTransaction;
      const response = await createRequest;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe(DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE);
    });
  }

  it("gives up on the PR scope lock rather than blocking issue creation indefinitely", async () => {
    // The lock's other holder is the GitHub webhook. Waiting on it without a
    // bound would put an unbounded blocking wait on the product's hottest write
    // path, and enough concurrent waiters would exhaust the connection pool.
    // Serialization is an optimization on a guard that is fail-open by design,
    // so it must lose to issue creation, not the other way round.
    const { companyId, reviewer, app } = await setup();
    let releaseHolder!: () => void;
    let reportLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      reportLockAcquired = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    // Holds the scope for longer than the guard's acquisition budget and, unlike
    // the racing-webhook cases above, never commits a review run — so if the
    // create does come through it is genuinely unserialized, not merely late.
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${TASK_KEY}, 0))`);
      reportLockAcquired();
      await release;
    });
    await lockAcquired;

    try {
      const startedAt = Date.now();
      const response = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send(reviewIssueBody(reviewer.id));
      const elapsedMs = Date.now() - startedAt;

      // Fails open: no live review run exists, so the create is legitimate and
      // must succeed even though the guard never got its lock.
      expect(response.status).toBe(201);
      // Bounded. Generous vs. the 1s budget so a slow CI runner cannot flake it,
      // but far below "blocks until the holder commits" — which is unbounded and
      // is what this pins against.
      expect(elapsedMs).toBeLessThan(10_000);
      expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    } finally {
      releaseHolder();
      await holder;
    }
  }, 20_000);

  it("releases every PR-scope lock it acquired when it gives up on the rest", async () => {
    // Finding from review: the guard used to `return` from inside its
    // acquisition loop while still holding whichever keys it had already taken.
    // Those are pg_try_advisory_xact_lock, so they were held until the CREATE
    // transaction committed — seconds, not the guard's 1s budget.
    //
    // That is not merely wasteful. The webhook's dispatch path locks a PAIR of
    // spellings all-or-nothing, so a create parking exactly one half made the
    // webhook's acquisition unsatisfiable for the rest of the create — starving
    // every reviewer wake for that PR while the create had itself given up on
    // serializing. Acquisition is now scoped to a SAVEPOINT rolled back on
    // give-up.
    //
    // Keys sort as ["pr_review:Blockcast/...", "pr_review:blockcast/..."]
    // ('B' 0x42 < 'b' 0x62), so holding the LOWERCASE key forces the guard to
    // acquire the mixed-case one FIRST and then fail — the exact prefix-held
    // shape under test.
    const companyId = await seedCompany();
    const reviewer = await seedAgent(companyId, "Ally");
    configureReviewer(reviewer.id);
    const SOURCE_KEY = `pr_review:${REPO}:${PR_NUMBER}`;

    let releaseHolder!: () => void;
    let reportHeld!: () => void;
    const held = new Promise<void>((resolve) => { reportHeld = resolve; });
    const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${TASK_KEY}, 0))`);
      reportHeld();
      await holderRelease;
    });
    await held;

    let releaseCreate!: () => void;
    let reportPaused!: () => void;
    const paused = new Promise<void>((resolve) => { reportPaused = resolve; });
    const createRelease = new Promise<void>((resolve) => { releaseCreate = resolve; });

    // Pauses INSIDE the create transaction, after the guard has run and given
    // up. If the guard still held the mixed-case key, it would still be held
    // at this point.
    const issueCreate = issueService(db).create(companyId, {
      title: `Review ${REPO} PR #${PR_NUMBER}`,
      description: `Please review ${PR_URL}.`,
      assigneeAgentId: reviewer.id,
      status: "todo",
      priority: "medium",
      beforeSideEffects: async () => {
        reportPaused();
        await createRelease;
      },
    });

    const probe = createDb(tempDb!.connectionString);
    const tryLock = async (key: string) =>
      await probe.transaction(async (tx) => {
        const rows = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`,
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        return (row as Record<string, unknown> | null)?.acquired === true;
      });

    try {
      await Promise.race([
        paused,
        issueCreate.then(() => {
          throw new Error("issue create committed before reaching the guarded pause");
        }),
      ]);

      // THE ASSERTION: the key the guard acquired and then abandoned is free
      // again, while the create transaction is still open. Before the savepoint
      // fix this was false.
      expect(await tryLock(SOURCE_KEY)).toBe(true);

      // CONTROL: the key the holder still owns must NOT be acquirable. Without
      // this, the assertion above would also pass on a build where advisory
      // locks did nothing at all.
      expect(await tryLock(TASK_KEY)).toBe(false);
    } finally {
      releaseCreate();
      releaseHolder();
      await holder.catch(() => undefined);
      // Fail-open is unchanged: no live review run exists, so the create is
      // legitimate and must still succeed.
      await expect(issueCreate).resolves.toBeTruthy();
    }
  }, 30_000);

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

  it("accepts an issue about the SAME PR when it declares it is not a review request", async () => {
    // The guard fires on any canonical PR permalink and cannot tell a review
    // REQUEST from an issue that is merely ABOUT the review. Without an escape
    // hatch, a legitimate meta-issue like this one is hard-rejected and the
    // 409's remediation ("post a review-request marker comment on the PR") is
    // actively wrong advice — following it would queue a second review of a PR
    // whose review is already broken. Before the marker existed the only way
    // past this was the global kill switch.
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);

    await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: `Ally's review of ${PR_URL} exited with pr_review_output_missing`,
        description:
          `${NOT_A_REVIEW_REQUEST_MARKER}\nThe adapter produced no verdict; investigate.`,
        assigneeAgentId: reviewer.id,
      })
      .expect(201);
  });

  it("still rejects the same issue text without the marker", async () => {
    // Discriminator for the case above: identical body minus the marker must
    // still 409, or the marker test proves nothing about the marker.
    const { companyId, reviewer, app } = await setup();
    await seedReviewRun(companyId, reviewer.id);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: `Ally's review of ${PR_URL} exited with pr_review_output_missing`,
        description: "The adapter produced no verdict; investigate.",
        assigneeAgentId: reviewer.id,
      })
      .expect(409);
    expect(res.body).toMatchObject({ code: DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE });
    // The rejection must advertise the escape hatch, or a blocked filer has no
    // way to discover it.
    expect(res.body.remediation).toContain(NOT_A_REVIEW_REQUEST_MARKER);
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

  it("still creates the issue when the guard lookup itself errors", async () => {
    // The guard documents fail-open, but it runs inside the issue-creation
    // transaction: a statement error there aborts the whole transaction, so
    // merely catching it would leave every later statement failing with 25P02
    // and the create would still 500. Renaming the table out from under the
    // lookup forces a real SQL error on exactly that query; the create must
    // still succeed, which only holds while the lookup is savepoint-isolated.
    const { companyId, reviewer, app } = await setup();
    await db.execute(sql`alter table heartbeat_runs rename to heartbeat_runs_hidden`);
    let res: request.Response;
    try {
      res = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send(reviewIssueBody(reviewer.id));
    } finally {
      await db.execute(sql`alter table heartbeat_runs_hidden rename to heartbeat_runs`);
    }

    expect(res.status).toBe(201);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
  });
});

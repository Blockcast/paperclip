import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS,
  evaluatePrReviewCompletionEvidence,
  selectAgedPrReviewRunForFairDispatch,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";
import { githubWebhookRoutes, type GithubWebhookConfig } from "../routes/github-webhook.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// BLO-17518: integration/replay test for the full BLO-17456 incident chain —
// GitHub webhook events -> Paperclip heartbeat wake dispatch -> Ally posting a
// review -> pim-multicast-gateway's `review-gate` GitHub Action reading that
// review and setting the `review/ally-complete` commit status. Existing
// coverage (heartbeat-retry-scheduling.test.ts, heartbeat-pr-review-queue-
// fairness.test.ts, github-webhook.test.ts, and pim-multicast-gateway's own
// test/require-ally-review-script.test.ts) is unit-level per component; this
// file replays the exact failure sequence observed on PR
// Blockcast/pim-multicast-gateway#1656 end to end: a review posted on an old
// head, a fix pushed to a new head, a fresh review-request event, a backlog of
// unrelated review wakes ahead of it, a run that leaves no durable evidence,
// and the exact new-head review that finally flips the gate green.
//
// The chain is driven from a *signed synthetic webhook through the real Express
// route*, against a real database: the fresh-head reviewer run and wake row are
// the ones the route actually persisted, and every later stage consumes that
// persisted row rather than a fixture rebuilt in the test. So this file breaks
// if the route stops enqueueing the new head/task key, if the durable-evidence
// retry fix (PR #767, `pr_review_output_missing` on the retry allowlist) is
// reverted, or if the dispatch-fairness fix
// (`selectAgedPrReviewRunForFairDispatch`) is reverted.

// Fixture port of Blockcast/pim-multicast-gateway's exact-head review gate
// (scripts/require-ally-review.mjs @ 12a0f903ec6f396150e0991f09eb96c767ca9f20,
// the `review-gate` GitHub Action that sets the `review/ally-complete` commit
// status). Ported rather than imported because pim-multicast-gateway is a
// separate repo/package (BLO-17518 AC: "fixturing ... rather than requiring a
// live GitHub API") — only the pure head-attestation matching is reproduced,
// with no network fetch or event parsing. That repo's own
// test/require-ally-review-script.test.ts remains the authoritative unit
// coverage for the real script; if the source diverges, update this fixture
// to match.
const ALLY_LOGIN = "allyblockcast";
const REPO = "Blockcast/pim-multicast-gateway";
const PR_NUMBER = 1656;
// Real head SHAs from the BLO-17456 incident this test replays.
const OLD_HEAD = "a24708eac27007d4de3280e37b2a887467025146";
const NEW_HEAD = "0cbd6523c2d308e581295b4bf217d8c0b77d5679";
const TASK_KEY = `pr_review:${REPO}:${PR_NUMBER}`;
const FRESH_HEAD_DELIVERY_ID = "delivery-fresh-head";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REVIEWED_HEAD_PATTERN =
  /^\s*(?:[_*]+)?\s*Reviewed head:\s*`?([0-9a-f]{40})`?\s*(?:[_*]+)?\s*$/gm;
const REVIEWED_HEAD_MENTION_PATTERN = /reviewed head\s*:/gi;

function extractReviewedHeadSha(body: string | null | undefined) {
  const text = String(body ?? "");
  const matches = [...text.matchAll(REVIEWED_HEAD_PATTERN)];
  const mentions = [...text.matchAll(REVIEWED_HEAD_MENTION_PATTERN)];
  if (matches.length !== 1 || mentions.length !== 1) return null;
  return matches[0][1].toLowerCase();
}

function bodyAttestsToHead(body: string | null | undefined, headSha: string) {
  return FULL_SHA_PATTERN.test(headSha) && extractReviewedHeadSha(body) === headSha.toLowerCase();
}

type FixtureReview = {
  id: number;
  commit_id: string;
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "COMMENTED";
  submitted_at: string;
  user: { login: string; type: "User" | "Bot" };
};

function reviewAttestsToHead(review: FixtureReview | null, headSha: string) {
  return bodyAttestsToHead(review?.body, headSha);
}

function latestAllyReview(reviews: FixtureReview[]) {
  return (
    reviews
      .filter((review) => review?.user?.login === ALLY_LOGIN)
      .sort((left, right) => {
        const byTime = String(right?.submitted_at ?? "").localeCompare(String(left?.submitted_at ?? ""));
        return byTime || Number(right?.id ?? 0) - Number(left?.id ?? 0);
      })[0] ?? null
  );
}

function reviewSignalForHead(reviews: FixtureReview[], headSha: string) {
  const review = latestAllyReview(reviews);
  if (!review) return { state: "pending" as const, description: `Waiting for Ally approval of head ${headSha.slice(0, 7)}.` };
  if (review.user?.type !== "User") return { state: "pending" as const, description: "Ally review identity is not a REST User." };
  if (!reviewAttestsToHead(review, headSha)) {
    return { state: "pending" as const, description: `Latest Ally review does not attest head ${headSha.slice(0, 7)}.` };
  }
  if (review.state === "CHANGES_REQUESTED") return { state: "failure" as const, description: "Ally requested changes." };
  if (review.state === "DISMISSED") return { state: "failure" as const, description: "Ally approval was dismissed." };
  if (review.state !== "APPROVED") return { state: "pending" as const, description: "Waiting for formal Ally approval." };
  return { state: "success" as const, description: `Ally formally approved exact head ${headSha.slice(0, 7)}.` };
}

function allyReview(opts: {
  id: number;
  headSha: string;
  submittedAt: string;
  commitId?: string;
  state?: FixtureReview["state"];
}): FixtureReview {
  return {
    id: opts.id,
    commit_id: opts.commitId ?? opts.headSha,
    body: `Reviewed head: \`${opts.headSha}\`\n\nLGTM, no findings.`,
    state: opts.state ?? "APPROVED",
    submitted_at: opts.submittedAt,
    user: { login: ALLY_LOGIN, type: "User" },
  };
}

const OLD_HEAD_REVIEW = allyReview({ id: 1, headSha: OLD_HEAD, submittedAt: "2026-07-21T08:14:00.000Z" });
const NEW_HEAD_REVIEW = allyReview({ id: 2, headSha: NEW_HEAD, submittedAt: "2026-07-21T09:06:25.000Z" });

describe("BLO-17518: exact-head review gate semantics (review-gate fixture)", () => {
  it("step 1-2: the initial review attests the old head and satisfies the gate at that head", () => {
    expect(reviewSignalForHead([OLD_HEAD_REVIEW], OLD_HEAD)).toMatchObject({ state: "success" });
  });

  it("step 3: fixes pushed to a new head — the stale old-head review does NOT satisfy the gate", () => {
    expect(reviewSignalForHead([OLD_HEAD_REVIEW], NEW_HEAD)).toMatchObject({ state: "pending" });
  });

  it("step 6: the exact new-head review flips review/ally-complete to success, and approval stays head-scoped", () => {
    // Full review history (old + new) evaluated against the current head:
    // the latest, exact-head review resolves the gate success.
    expect(reviewSignalForHead([OLD_HEAD_REVIEW, NEW_HEAD_REVIEW], NEW_HEAD)).toMatchObject({ state: "success" });

    // GitHub may rewrite REST `review.commit_id` after an Update branch action;
    // the immutable explicit body attestation is what the gate should trust.
    const rewrittenCommitIdReview = allyReview({
      id: 3,
      headSha: NEW_HEAD,
      commitId: OLD_HEAD,
      submittedAt: "2026-07-21T09:07:00.000Z",
    });
    expect(reviewSignalForHead([rewrittenCommitIdReview], NEW_HEAD)).toMatchObject({ state: "success" });

    // The gate is exact-head, not "any approval ever": re-checking the OLD
    // head against the same history must not also read as success (there is
    // no live PR at the old head anymore, but the invariant — approval is
    // scoped to one head — must hold for whichever head is asked about).
    expect(reviewSignalForHead([OLD_HEAD_REVIEW, NEW_HEAD_REVIEW], OLD_HEAD)).toMatchObject({ state: "pending" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping BLO-17518 webhook->dispatch replay on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "BLO-17518: Ally exact-head re-review replay (webhook -> enqueue -> retry -> dispatch -> gate success)",
  () => {
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let db: ReturnType<typeof createDb>;
    const webhookSecret = "test-webhook-secret-do-not-use-in-prod";
    const allowPenstockGate: NonNullable<GithubWebhookConfig["heartbeatOptions"]>["penstockAvailabilityGate"] = {
      checkAdapter: async () => ({ allow: true }),
      _resetForTesting: () => {},
    };

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blo-17518-replay-test-");
      db = createDb(tempDb.connectionString);
    }, 120_000);

    beforeEach(async () => {
      if (!db) return;
      await db.execute(sql.raw(
        `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
      ));
      await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    }, 60_000);

    afterAll(async () => {
      await db?.execute(sql.raw(
        `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
      ));
      await db?.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
      await tempDb?.cleanup();
    }, 60_000);

    function buildApp(reviewerAgentId: string) {
      const app = express();
      app.use(express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }));
      app.use("/api/webhooks/github", githubWebhookRoutes(db, {
        webhookSecret,
        prReviewerAgentId: reviewerAgentId,
        heartbeatOptions: {
          penstockAvailabilityGate: allowPenstockGate,
          // Persist the wake + queued run without handing it to a live adapter;
          // the dispatch half is exercised below through the real fairness
          // selector against the persisted row.
          skipQueuedRunDispatch: true,
        },
      }));
      return app;
    }

    async function seedReviewerAgent() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Test",
        issuePrefix: "BLO",
        defaultResponsibleUserId: "test-board-user",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Ally",
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      // The PR references BLO-17456, so give the route a real issue to resolve.
      // Left unassigned deliberately: the issue-assignee wake path is out of
      // scope here, and keeping it inert means the only heartbeat run this
      // delivery produces is the reviewer run under test.
      await db.insert(issues).values({
        id: randomUUID(),
        companyId,
        title: "Fix Ally exact-head re-review delivery and durable evidence",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: null,
        issueNumber: 17456,
        identifier: "BLO-17456",
      });
      return { companyId, agentId };
    }

    /**
     * Step 3b — drive the real fresh-head `pull_request.synchronize` webhook
     * (signed, through the Express route) and return the reviewer run + wake
     * row the route persisted. Everything downstream consumes these rows.
     */
    async function deliverFreshHeadSynchronize(agentId: string) {
      const app = buildApp(agentId);
      const payload = {
        action: "synchronize",
        pull_request: {
          number: PR_NUMBER,
          title: "fix(review-gate): retry exact-head Ally review (BLO-17456)",
          body: "Closes BLO-17456",
          html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
          head: { ref: "fix/BLO-17456-exact-head-review", sha: NEW_HEAD },
          user: { login: "contributor" },
        },
        repository: { full_name: REPO },
      };
      const body = JSON.stringify(payload);
      const signature =
        "sha256=" + crypto.createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex");

      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", FRESH_HEAD_DELIVERY_ID)
        .set("content-type", "application/json")
        .send(body);
      expect(res.status).toBe(200);
      // The issue-match branch of the response does not report reviewerWakeFired;
      // the persisted rows below are the authoritative evidence that the
      // reviewer wake was enqueued.
      expect(res.body).toMatchObject({ ok: true });

      const runs = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);

      const wakes = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
          idempotencyKey: agentWakeupRequests.idempotencyKey,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakes).toHaveLength(1);

      return { reviewerRun: runs[0]!, wake: wakes[0]! };
    }

    it("step 3b: the fresh-head webhook persists a reviewer wake carrying the exact new head and PR task key", async () => {
      const { agentId } = await seedReviewerAgent();
      const { reviewerRun, wake } = await deliverFreshHeadSynchronize(agentId);

      expect(reviewerRun.status).toBe("queued");
      expect(reviewerRun.contextSnapshot).toMatchObject({
        taskKey: TASK_KEY,
        wakeReason: "github_pr_synchronized",
        wakeSource: "automation",
        githubEvent: "pull_request",
        githubDeliveryId: FRESH_HEAD_DELIVERY_ID,
        githubPrNumber: PR_NUMBER,
        githubRepoFullName: REPO,
        // The whole point of the incident: the queued reviewer work must be
        // pinned to the NEW head, not the head the stale review covered.
        githubHeadSha: NEW_HEAD,
        githubPaperclipIdentifiers: ["BLO-17456"],
        reviewKind: "pr_review",
        prRole: "reviewer",
      });
      expect(
        (reviewerRun.contextSnapshot as Record<string, unknown>).githubHeadSha,
      ).not.toBe(OLD_HEAD);

      expect(wake).toMatchObject({
        status: "queued",
        reason: "github_pr_synchronized",
        // Delivery-scoped so a redelivery of one push cannot be absorbed into
        // an unrelated PR's in-flight review (BLO-18953).
        idempotencyKey: `${TASK_KEY}:github_pr_synchronized:delivery:${FRESH_HEAD_DELIVERY_ID}`,
        payload: expect.objectContaining({
          taskKey: TASK_KEY,
          source: "github",
          event: "pull_request",
          deliveryId: FRESH_HEAD_DELIVERY_ID,
          prNumber: PR_NUMBER,
          repoFullName: REPO,
          headSha: NEW_HEAD,
          paperclipIdentifiers: ["BLO-17456"],
          reviewKind: "pr_review",
        }),
      });
    }, 60_000);

    it("step 4: the persisted fresh-head run leaving no durable evidence is retry-eligible, not stranded (BLO-17456 AC2 / PR #767)", async () => {
      const { agentId } = await seedReviewerAgent();
      const { reviewerRun } = await deliverFreshHeadSynchronize(agentId);
      const persistedContext = reviewerRun.contextSnapshot as Record<string, unknown>;

      const missingEvidence = evaluatePrReviewCompletionEvidence(persistedContext, {
        summary: `Fetching PR metadata and diff for head ${NEW_HEAD.slice(0, 7)}; investigating findings.`,
      });
      expect(missingEvidence).toMatchObject({ status: "missing", errorCode: "pr_review_output_missing" });

      // This is the exact assertion PR #767 fixed: before it,
      // pr_review_output_missing was terminal (not on the retry allowlist),
      // stranding the exact-head gate with no automatic retry path.
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode: missingEvidence.errorCode,
          resultJson: {},
          contextSnapshot: persistedContext,
        }),
      ).toBe(true);
    }, 60_000);

    it("step 4b: the persisted run is eventually dispatched, not starved behind older unrelated review wakes (dispatch-fairness)", async () => {
      const { agentId } = await seedReviewerAgent();
      const { reviewerRun } = await deliverFreshHeadSynchronize(agentId);

      // Age the clock past the fairness cutoff relative to when the route
      // actually queued this run.
      const queuedAt = new Date(reviewerRun.createdAt).getTime();
      const now = new Date(queuedAt + PR_REVIEW_QUEUE_FAIRNESS_MAX_WAIT_MS + 60_000);

      // Older unrelated PR-review wakes are genuinely ahead of the fresh,
      // merge-blocking run in createdAt/FIFO order. Under sustained mixed load,
      // fairness must eventually promote the target once older aged reviews
      // have had their turns.
      const olderUnrelatedBacklog = [
        {
          id: "older-unrelated-review-1",
          createdAt: new Date(queuedAt - 8 * 60_000),
          contextSnapshot: { taskKey: "pr_review:Blockcast/onprem-k8s:42" },
        },
        {
          id: "older-unrelated-review-2",
          createdAt: new Date(queuedAt - 4 * 60_000),
          contextSnapshot: { taskKey: "pr_review:Blockcast/hindsight:7" },
        },
      ];
      const afterIssueWork = { contextSnapshot: { issueId: "unrelated-issue-work" } };
      const afterReviewWork = { contextSnapshot: { reviewKind: "pr_review" } };
      const queue = [...olderUnrelatedBacklog, reviewerRun];

      expect(selectAgedPrReviewRunForFairDispatch(queue, afterIssueWork, now)).toBe("older-unrelated-review-1");

      // While the last-started run was itself a pr_review, fairness must not
      // promote a second one consecutively (the exact-head fix landing does not
      // get to monopolize the reviewer ahead of ordinary priority).
      expect(selectAgedPrReviewRunForFairDispatch(queue.slice(1), afterReviewWork, now)).toBeNull();

      expect(selectAgedPrReviewRunForFairDispatch(queue.slice(1), afterIssueWork, now)).toBe(
        "older-unrelated-review-2",
      );

      // Once the older backlog has drained, the persisted fresh-head run is the
      // one dispatch selects — by its real row id, not a fixture stand-in.
      expect(selectAgedPrReviewRunForFairDispatch([reviewerRun], afterIssueWork, now)).toBe(reviewerRun.id);
    }, 60_000);

    it("step 5-6: the review posted against the persisted fresh-head run counts as durable evidence and flips the gate", async () => {
      const { agentId } = await seedReviewerAgent();
      const { reviewerRun } = await deliverFreshHeadSynchronize(agentId);
      const persistedContext = reviewerRun.contextSnapshot as Record<string, unknown>;

      const newEvidence = evaluatePrReviewCompletionEvidence(persistedContext, {
        summary: `Posted the consolidated Ally review on \`${REPO}#${PR_NUMBER}\` for head ${NEW_HEAD}.`,
      });
      expect(newEvidence).toEqual({ status: "posted_review" });

      // That posted review, attesting the same head the webhook queued, is what
      // the review-gate reads to set review/ally-complete.
      const postedReview = allyReview({
        id: 2,
        headSha: String(persistedContext.githubHeadSha),
        submittedAt: "2026-07-21T09:06:25.000Z",
      });
      expect(reviewSignalForHead([OLD_HEAD_REVIEW, postedReview], NEW_HEAD)).toMatchObject({ state: "success" });
    }, 60_000);
  },
);

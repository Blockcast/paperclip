/**
 * Integration tests for the WIRED PR review-request ageing digest producer
 * (BLO-30259).
 *
 * These drive `humanGatedDigestTick` — the entry point `server/src/index.ts`
 * schedules — against seeded `pull_request_review_state` rows, never
 * `selectAgedReviewRequests` directly. `pr-review-request-ageing.test.ts` already
 * calls the pure functions, and that is exactly what let 22KB of tested logic sit
 * on master at zero production importers with full green CI: a test that imports
 * the module directly cannot tell wired from inert.
 *
 * The fixtures are built as traps rather than happy paths. In particular the
 * ally-review case exists because "does this PR have a review?" reads 158 of 206
 * onprem-k8s PRs as answered when a human had looked at 3 — a ~50x error — and the
 * unreadable cases exist because an unreadable probe rendered as an empty section
 * is a false all-clear, which is the failure this whole seam refuses.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  pullRequestReviewState,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  HUMAN_GATED_DIGEST_ORIGIN_KIND,
  humanGatedDigestOriginId,
  humanGatedDigestTick,
} from "../services/human-gated-ageing-digest.js";
import {
  PR_REVIEW_REQUEST_AGEING_SECTION_KEY,
  prReviewRequestAgeingProducer,
} from "../services/pr-review-request-ageing-producer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR review-request ageing digest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NOW = new Date("2026-08-25T12:00:00.000Z");
const HUMAN_USER_ID = "user_human_owner";

function daysAgo(days: number, from: Date = NOW): Date {
  return new Date(from.getTime() - days * 86_400_000);
}

describeEmbeddedPostgres("humanGatedDigestTick — PR review-request ageing producer (wired)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-review-ageing-digest-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(pullRequestReviewState);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PRA") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: HUMAN_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    return { companyId };
  }

  let nextPrNumber = 4000;

  async function seedPullRequest(input: {
    companyId: string;
    prCreatedAt: Date;
    authorLogin?: string | null;
    isDraft?: boolean;
    requestsReadable?: boolean;
    pendingReviewRequests?: Array<{
      requestedAt?: string | null;
      reviewerLogin?: string | null;
      reviewerSlug?: string | null;
    }>;
    reviewsReadable?: boolean;
    reviews?: Array<{ authorLogin?: string | null; submittedAt?: string | null; state?: string | null }>;
    unreadableReason?: string | null;
    title?: string;
    repoFullName?: string;
  }) {
    nextPrNumber += 1;
    const prNumber = nextPrNumber;
    const repoFullName = input.repoFullName ?? "Blockcast/onprem-k8s";
    await db.insert(pullRequestReviewState).values({
      companyId: input.companyId,
      repoFullName,
      prNumber,
      prCreatedAt: input.prCreatedAt,
      authorLogin: input.authorLogin === undefined ? "allyblockcast[bot]" : input.authorLogin,
      title: input.title ?? `PR ${prNumber}`,
      url: `https://github.com/${repoFullName}/pull/${prNumber}`,
      isDraft: input.isDraft ?? false,
      requestsReadable: input.requestsReadable ?? true,
      pendingReviewRequests:
        input.pendingReviewRequests ?? [{ reviewerSlug: "onprem-k8s-ally-reviewer", requestedAt: null }],
      reviewsReadable: input.reviewsReadable ?? true,
      reviews: input.reviews ?? [],
      unreadableReason: input.unreadableReason ?? null,
      observedAt: NOW,
    });
    return { prNumber, repoFullName };
  }

  async function digestBody(companyId: string): Promise<string> {
    const rows = await db
      .select({
        description: issues.description,
        originId: issues.originId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND));
    const mine = rows.filter((row) => row.originId === humanGatedDigestOriginId(companyId));
    expect(mine).toHaveLength(1);
    // AC3 of the parent seam: the digest is assigned to a human, not an agent.
    expect(mine[0]?.assigneeUserId).toBe(HUMAN_USER_ID);
    return mine[0]?.description ?? "";
  }

  it("reports an unanswered review request with its unanswered-days age", async () => {
    const { companyId } = await createCompany();
    const { prNumber } = await seedPullRequest({ companyId, prCreatedAt: daysAgo(17) });

    const result = await humanGatedDigestTick(db, { now: NOW, companyId });

    expect(result.outcomes[0]?.action).toBe("created");
    const body = await digestBody(companyId);
    expect(body).toContain(`Blockcast/onprem-k8s#${prNumber}`);
    expect(body).toContain("17.0d");
    expect(body).toContain("Unanswered PR review requests past 7d");
  });

  it("dates the clock from the review request, not PR creation, when the timeline supplied one", async () => {
    const { companyId } = await createCompany();
    // Opened 40d ago but only routed for review 12d ago. Ageing from creation
    // would over-state this by 28 days.
    await seedPullRequest({
      companyId,
      prCreatedAt: daysAgo(40),
      pendingReviewRequests: [
        { reviewerSlug: "onprem-k8s-ally-reviewer", requestedAt: daysAgo(12).toISOString() },
      ],
    });

    await humanGatedDigestTick(db, { now: NOW, companyId });

    const body = await digestBody(companyId);
    expect(body).toContain("12.0d");
    expect(body).not.toContain("40.0d");
  });

  it("does not let an ally review stop the clock", async () => {
    const { companyId } = await createCompany();
    // Both ally principals: the App that authors and the User seat that reviews.
    // A naive "has a review?" check calls this answered; a human has not looked.
    const { prNumber } = await seedPullRequest({
      companyId,
      prCreatedAt: daysAgo(20),
      reviews: [
        { authorLogin: "allyblockcast[bot]", submittedAt: daysAgo(19).toISOString(), state: "COMMENTED" },
        { authorLogin: "allyblockcast", submittedAt: daysAgo(18).toISOString(), state: "APPROVED" },
      ],
    });

    await humanGatedDigestTick(db, { now: NOW, companyId });

    const body = await digestBody(companyId);
    expect(body).toContain(`Blockcast/onprem-k8s#${prNumber}`);
    expect(body).toContain("ally-only reviews");
  });

  it("treats a genuine human review as answering, and a within-threshold PR as not overdue", async () => {
    const { companyId } = await createCompany();
    const answered = await seedPullRequest({
      companyId,
      prCreatedAt: daysAgo(30),
      reviews: [{ authorLogin: "kkroo", submittedAt: daysAgo(29).toISOString(), state: "APPROVED" }],
    });
    const fresh = await seedPullRequest({ companyId, prCreatedAt: daysAgo(2) });
    const overdue = await seedPullRequest({ companyId, prCreatedAt: daysAgo(9) });

    await humanGatedDigestTick(db, { now: NOW, companyId });

    const body = await digestBody(companyId);
    expect(body).toContain(`Blockcast/onprem-k8s#${overdue.prNumber}`);
    expect(body).not.toContain(`Blockcast/onprem-k8s#${answered.prNumber}`);
    expect(body).not.toContain(`Blockcast/onprem-k8s#${fresh.prNumber}`);
  });

  // AC6. This is the test the issue exists for: an unreadable probe must never
  // render as an empty section, because empty reads to a human as "no PRs are
  // waiting" — while 97 of 114 measured PRs did have a live request.
  it("renders unreadable review state as unreadable rather than as an empty section", async () => {
    const { companyId } = await createCompany();
    const { prNumber } = await seedPullRequest({
      companyId,
      prCreatedAt: daysAgo(21),
      requestsReadable: false,
      pendingReviewRequests: [],
      unreadableReason: "requested_reviewers probe failed",
    });

    const result = await humanGatedDigestTick(db, { now: NOW, companyId });

    const body = await digestBody(companyId);
    expect(body).toContain("Review state unreadable for 1 pull request");
    expect(body).toContain(`Blockcast/onprem-k8s#${prNumber}`);
    expect(body).toContain("requested_reviewers probe failed");
    // The seam must not have treated this as "ran clean, nothing overdue".
    expect(body).not.toContain("Nothing overdue this period");
    expect(result.outcomes[0]?.itemCount).toBeGreaterThan(0);
  });

  it("withholds a PR whose reviews are unreadable instead of guessing it is unanswered", async () => {
    const { companyId } = await createCompany();
    const { prNumber } = await seedPullRequest({
      companyId,
      prCreatedAt: daysAgo(25),
      reviewsReadable: false,
      reviews: [],
      unreadableReason: "reviews probe failed",
    });

    await humanGatedDigestTick(db, { now: NOW, companyId });

    const body = await digestBody(companyId);
    // Present as unreadable...
    expect(body).toContain("Review state unreadable");
    expect(body).toContain(`Blockcast/onprem-k8s#${prNumber}`);
    // ...and NOT asserted as an overdue unanswered request, which would be a
    // verdict reached without being able to see whether anyone replied.
    expect(body).not.toContain("25.0d");
  });

  it("does not create a second row or rewrite an unchanged body on a repeat tick", async () => {
    const { companyId } = await createCompany();
    await seedPullRequest({ companyId, prCreatedAt: daysAgo(17) });

    const first = await humanGatedDigestTick(db, { now: NOW, companyId });
    expect(first.outcomes[0]?.action).toBe("created");

    const second = await humanGatedDigestTick(db, { now: NOW, companyId });
    expect(second.outcomes[0]?.action).toBe("unchanged");

    const rows = await db
      .select({ originId: issues.originId })
      .from(issues)
      .where(eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND));
    expect(rows.filter((row) => row.originId === humanGatedDigestOriginId(companyId))).toHaveLength(1);
  });

  // AC4: `escalatedAt` is never populated, so an unanswered PR keeps being
  // reported. The escalate-once model would have made it vanish here while still
  // unanswered — the digest getting quieter as the backlog got worse.
  it("keeps reporting an unanswered PR on a later period rather than escalating once", async () => {
    const { companyId } = await createCompany();
    const { prNumber } = await seedPullRequest({ companyId, prCreatedAt: daysAgo(17) });

    await humanGatedDigestTick(db, { now: NOW, companyId });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    await humanGatedDigestTick(db, { now: later, companyId });

    const body = await digestBody(companyId);
    expect(body).toContain(`Blockcast/onprem-k8s#${prNumber}`);
    expect(body).toContain("25.0d");
  });

  it("skips drafts and non-agent-authored PRs", async () => {
    const { companyId } = await createCompany();
    const draft = await seedPullRequest({ companyId, prCreatedAt: daysAgo(30), isDraft: true });
    const human = await seedPullRequest({ companyId, prCreatedAt: daysAgo(30), authorLogin: "kkroo" });

    const result = await humanGatedDigestTick(db, { now: NOW, companyId });

    // Nothing overdue, nothing unreadable => the producer contributes no section.
    const rows = await db
      .select({ description: issues.description, originId: issues.originId })
      .from(issues)
      .where(eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND));
    const mine = rows.filter((row) => row.originId === humanGatedDigestOriginId(companyId));
    const body = mine[0]?.description ?? "";
    expect(body).not.toContain(`Blockcast/onprem-k8s#${draft.prNumber}`);
    expect(body).not.toContain(`Blockcast/onprem-k8s#${human.prNumber}`);
    expect(result.outcomes[0]?.action).toBe("skipped_empty");
  });

  it("is registered on the default producer set, not just importable", async () => {
    // AC1 in test form: the seam must actually carry this producer. Asserting on
    // the exported const alone would pass for a module nothing registers.
    const { DEFAULT_DIGEST_PRODUCERS } = await import("../services/human-gated-ageing-digest.js");
    expect(DEFAULT_DIGEST_PRODUCERS.map((producer) => producer.key)).toContain(
      PR_REVIEW_REQUEST_AGEING_SECTION_KEY,
    );
    expect(DEFAULT_DIGEST_PRODUCERS).toContain(prReviewRequestAgeingProducer);
  });
});

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueWorkProducts, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPullRequestWorkProductFields } from "../services/pull-request-work-products.js";
import { workProductService } from "../services/work-products.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR work-product tie tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// `updated_at` is second-granular, so events GitHub sends inside one second tie
// on sourceEventTimestampMs and are ordered by action rank alone (BLO-35779).
// The pure builder and the productivity-review tests both bypass that seam, so
// these drive real events through upsertByExternalId.
describeEmbeddedPostgres("PR work-product upsert: same-second merge-queue events", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-work-product-tie-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `QT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Queue Tie Co", issuePrefix });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queue tie",
      status: "in_progress",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, issueId };
  }

  async function deliver(companyId: string, issueId: string, action: string) {
    const fields = buildPullRequestWorkProductFields({
      repoFullName: "Blockcast/paperclip",
      prNumber: 4242,
      prTitle: "queue tie",
      headSha: "a".repeat(40),
      prUpdatedAt: "2026-09-25T10:00:00Z",
      action,
    });
    await workProductService(db).upsertByExternalId(
      issueId,
      companyId,
      { provider: "github", type: "pull_request", externalId: fields.externalId },
      {
        title: fields.title,
        url: fields.url,
        status: fields.status,
        metadata: fields.metadata,
        sourceTrust: fields.sourceTrust,
      },
    );
  }

  async function storedQueueState(issueId: string) {
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    return (row?.metadata as Record<string, unknown> | null)?.mergeQueueState;
  }

  it("records the queue entry when ready_for_review and enqueued share a second", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "ready_for_review");
    await deliver(companyId, issueId, "enqueued");
    expect(await storedQueueState(issueId)).toBe("enqueued");
  });

  it("records the ejection when enqueued and dequeued share a second", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "enqueued");
    await deliver(companyId, issueId, "dequeued");
    expect(await storedQueueState(issueId)).toBe("dequeued");
  });

  // The ordering the 45/46 ranks deliberately get WRONG. A dequeue and a
  // re-enqueue inside one second tie on timestamp, and because rank encodes
  // "which state is later" rather than arrival order, the lower-ranked
  // `enqueued` is rejected and the row keeps `dequeued` even though the PR is
  // really back in the queue. That is the chosen fail-closed ceiling: the PR
  // keeps its normal freshness window instead of the queue's extended one
  // (pull-request-work-products.ts, `pullRequestWorkProductSourceEventActionOrder`).
  //
  // What this case uniquely pins is NOT the ranks -- the enqueued->dequeued
  // case directly above already fails loudly on any re-rank, and no mutation
  // confined to the two ranks can red this one without redding that one too
  // (they are exact mirrors over the same pair). What it pins is the
  // STRICTNESS of the tie-break in work-products.ts `tieBreak`: that a
  // same-second tie is resolved by rank and never by arrival order. Relaxing
  // that comparison to accept the later arrival (`then true` at the rank
  // comparison) reds this case and no other in either PR work-product test
  // file, which is precisely the change to think twice about -- it would turn
  // the fail-closed ceiling above into a fail-open one.
  it("keeps the fail-closed dequeued when dequeued and enqueued share a second", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "dequeued");
    await deliver(companyId, issueId, "enqueued");
    expect(await storedQueueState(issueId)).toBe("dequeued");
  });
});

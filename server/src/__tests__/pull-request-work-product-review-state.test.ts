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
    `Skipping embedded Postgres PR work-product review-state tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// PEN-5850. Two separate defects, both measured on the two owning rows of
// `Blockcast/onprem-k8s#8006`, and one deliberate NON-defect that has to stay
// pinned so a future reader does not "fix" it.
describeEmbeddedPostgres("PR work-product upsert: reviewState and write-ordering", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-wp-review-state-");
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
    const issuePrefix = `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Review State Co", issuePrefix });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review state",
      status: "in_progress",
      priority: "medium",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    return { companyId, issueId };
  }

  async function deliver(
    companyId: string,
    issueId: string,
    action: string,
    overrides: { prUpdatedAt?: string; headSha?: string } = {},
  ) {
    const fields = buildPullRequestWorkProductFields({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 8006,
      prTitle: "review state",
      headSha: overrides.headSha ?? "f".repeat(40),
      prUpdatedAt: overrides.prUpdatedAt ?? "2026-11-06T12:20:21Z",
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

  async function storedRow(issueId: string) {
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    return row;
  }

  // Defect 2 (the sub-finding). `updatedAt` was bound from a JS `new Date()`
  // taken at the top of `upsertByExternalId`, while `createdAt` fell through to
  // the column's `defaultNow()` — evaluated by Postgres at statement execution,
  // after ~15 SQL fragments and a round trip. The row landed with `updatedAt`
  // 382ms (and on the sibling owner 88ms) EARLIER than `createdAt`, which makes
  // `updatedAt` useless as a monotonic change detector. `config.ts` reads this
  // very column for work-product recency.
  it("stamps createdAt and updatedAt from one clock, so updatedAt is never before createdAt", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "opened");

    const row = await storedRow(issueId);
    expect(row).toBeTruthy();
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(row!.updatedAt.getTime());
    expect(row!.updatedAt.getTime()).toBe(row!.createdAt.getTime());
  });

  // Defect 1, stated correctly. The filed hypothesis was "the opened webhook
  // sets reviewState and review events never update it". The truth is stronger:
  // the webhook never writes the column in ANY branch, so it sits at the schema
  // default for life. `none` on a GitHub PR row is therefore the CORRECT value
  // ("never board-reviewed"), not a stale one — and it says nothing whatever
  // about GitHub review.
  it("leaves reviewState at the none default across the PR lifecycle", async () => {
    const { companyId, issueId } = await seedIssue();

    await deliver(companyId, issueId, "opened");
    expect((await storedRow(issueId))!.reviewState).toBe("none");

    await deliver(companyId, issueId, "synchronize", { prUpdatedAt: "2026-11-06T14:02:19Z" });
    expect((await storedRow(issueId))!.reviewState).toBe("none");

    await deliver(companyId, issueId, "closed", { prUpdatedAt: "2026-11-06T15:00:00Z" });
    expect((await storedRow(issueId))!.reviewState).toBe("none");
  });

  // The deliberate NON-defect, and the reason reviewState must stay out of the
  // upsert's set clause. `reviewState` is Paperclip BOARD-REVIEW state, written
  // only by the low-trust promotion route. If a future change "fixes" the
  // stale-looking `none` by wiring review events into this upsert, PR traffic
  // would silently clobber a board decision. This test fails if that happens.
  it("never clobbers a board-set reviewState with a later webhook event", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "opened");

    // Stand in for the board acting via the low-trust promotion route.
    await db
      .update(issueWorkProducts)
      .set({ reviewState: "approved" })
      .where(eq(issueWorkProducts.issueId, issueId));

    // A strictly later event, which the upsert WILL accept for every field it
    // does manage (status/title/metadata all move here).
    await deliver(companyId, issueId, "synchronize", {
      prUpdatedAt: "2026-11-06T16:00:00Z",
      headSha: "a".repeat(40),
    });

    const row = await storedRow(issueId);
    expect(row!.reviewState).toBe("approved");
    // Control: prove the later event really was accepted, so the assertion
    // above is about reviewState being excluded and not about a rejected write.
    expect((row!.metadata as Record<string, unknown>).headSha).toBe("a".repeat(40));
  });
});

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
//
// PEN-4550 added the cases where the two events are NOT in the same second.
// Those never reach the tie-break at all — `acceptIncoming` compares
// `sourceEventTimestampMs` FIRST and the later arrival wins outright — which is
// exactly why the dequeue could overwrite a merged row, and why only the pure
// mapping (not the tie-break) can fix it.
describeEmbeddedPostgres("PR work-product upsert: merge-queue events", () => {
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

  async function deliver(
    companyId: string,
    issueId: string,
    action: string,
    overrides: { prUpdatedAt?: string; prMerged?: boolean; prMergedAt?: string | null } = {},
  ) {
    const fields = buildPullRequestWorkProductFields({
      repoFullName: "Blockcast/paperclip",
      prNumber: 4242,
      prTitle: "queue tie",
      headSha: "a".repeat(40),
      prUpdatedAt: "2026-09-25T10:00:00Z",
      action,
      ...overrides,
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

  async function storedRow(issueId: string) {
    const [row] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    return {
      status: row?.status,
      merged: (row?.metadata as Record<string, unknown> | null)?.merged,
      lastEventAction: (row?.metadata as Record<string, unknown> | null)?.lastEventAction,
    };
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

  // PEN-4550, reproduced end to end. On a mandatory merge queue EVERY merge
  // fires a `dequeued`, and its `updated_at` routinely lands 1-2s AFTER the
  // merge, so it beats the `closed` event outright — the tie-break that prefers
  // a terminal state is never consulted. Measured on `Blockcast/paperclip`
  // 2026-10-23: 3 of 6 inspected merged-PR rows had been demoted this way,
  // including #2946, whose stored row read `ready_for_review`/`merged:false`
  // while carrying its own `mergedAt: 2026-10-23T03:57:49Z`.
  const MERGED_AT = "2026-09-25T10:00:00Z";

  it("keeps the merge when the queue dequeue lands two seconds after it", async () => {
    const { companyId, issueId } = await seedIssue();
    // The merge, as `closed` reports it.
    await deliver(companyId, issueId, "closed", {
      prMerged: true,
      prMergedAt: MERGED_AT,
      prUpdatedAt: MERGED_AT,
    });
    expect((await storedRow(issueId)).status).toBe("merged");

    // The queue's own ejection event, strictly later. It carries `merged_at`
    // but no `merged` flag — the webhook gates that on `action === "closed"`.
    await deliver(companyId, issueId, "dequeued", {
      prMergedAt: MERGED_AT,
      prUpdatedAt: "2026-09-25T10:00:02Z",
    });

    const row = await storedRow(issueId);
    expect(row.lastEventAction).toBe("dequeued");
    // Before the fix this read `ready_for_review` / false: the later dequeue was
    // accepted outright and overwrote the merge. The demotion is PERMANENT —
    // a merged PR emits no further webhook to correct it.
    expect(row.status).toBe("merged");
    expect(row.merged).toBe(true);
  });

  it("records the merge when the dequeue arrives first and the close is older", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "dequeued", {
      prMergedAt: MERGED_AT,
      prUpdatedAt: "2026-09-25T10:00:02Z",
    });
    // The dequeue alone must already be enough: GitHub's delivery order between
    // the two is not guaranteed, so the merge cannot depend on `closed` landing.
    expect(await storedRow(issueId)).toMatchObject({ status: "merged", merged: true });

    await deliver(companyId, issueId, "closed", {
      prMerged: true,
      prMergedAt: MERGED_AT,
      prUpdatedAt: MERGED_AT,
    });
    expect(await storedRow(issueId)).toMatchObject({ status: "merged", merged: true });
  });

  it("does not promote a genuine queue ejection, which is still an open PR", async () => {
    const { companyId, issueId } = await seedIssue();
    await deliver(companyId, issueId, "enqueued", { prUpdatedAt: MERGED_AT });
    // Ejected, not merged: no `merged_at`. Promoting this would strip the
    // event-wake path PEN-2791's stranded-assigned sweep reads, on a PR that
    // demonstrably will emit more events.
    await deliver(companyId, issueId, "dequeued", {
      prMergedAt: null,
      prUpdatedAt: "2026-09-25T10:00:02Z",
    });

    const row = await storedRow(issueId);
    expect(row.status).toBe("ready_for_review");
    expect(row.merged).toBe(false);
    expect(await storedQueueState(issueId)).toBe("dequeued");
  });
});

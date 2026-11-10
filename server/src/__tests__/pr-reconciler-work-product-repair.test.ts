/**
 * PEN-6413. The merged-PR reconciler repairs a PR work product whose `closed`
 * webhook delivery was lost.
 *
 * These tests drive `reconcileMergedPullRequests` end to end against a real
 * database, rather than only `buildPullRequestWorkProductFields`, because the
 * two properties that matter are properties of the WRITE and of what the
 * READERS then see -- neither is observable from the field builder:
 *
 *   1. A repaired row must still read `provenance: "webhook"` through
 *      `listOwnersByExternalId`. Five readers gate on
 *      `metadata.source = 'github_pull_request_webhook'`, including the owner
 *      wake; a repaired row that fell out of them would have missed every
 *      FUTURE event too, which is worse than the defect being fixed.
 *   2. A CORRECTLY delivered row must not be churned. The ordering guard is
 *      only protective if the reconciler offers the MERGE INSTANT rather than
 *      the PR's current `updated_at`, which GitHub bumps on any later comment,
 *      label or bot post.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issuePullRequests,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

/**
 * The reconciler's only outbound calls are the search page and the PR detail.
 * Everything else it does is database work, which is what these tests assert.
 */
const githubResponses = vi.hoisted(() => ({ byUrl: new Map<string, unknown>() }));

vi.mock("../services/github-fetch.js", () => ({
  gitHubApiBase: () => "https://api.github.com",
  ghFetch: async (url: string) => ({
    ok: githubResponses.byUrl.has(url),
    status: githubResponses.byUrl.has(url) ? 200 : 404,
    json: async () => githubResponses.byUrl.get(url) ?? {},
  }),
  ghReadBody: async <T,>(_url: string, read: () => Promise<T>) => read(),
}));

const {
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
} = await import("../services/pull-request-work-products.js");
const { reconcileMergedPullRequests } = await import("../services/issue-pull-requests.js");
const { workProductService } = await import("../services/work-products.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const REPO = "Blockcast/penstock-llm-proxy-core";
const PR_NUMBER = 2991;
const EXTERNAL_ID = `${REPO}#${PR_NUMBER}`;
const MERGED_AT = "2026-11-07T02:49:13Z";
/** Later than the merge: a comment, label or deploy-bot post after it landed. */
const UPDATED_AT_AFTER_MERGE = "2026-11-09T18:02:44Z";

function stubGithub(identifier: string) {
  githubResponses.byUrl.clear();
  const searchUrl =
    "https://api.github.com/search/issues?q="
    + encodeURIComponent(
      `repo:${REPO} is:pr is:merged merged:2026-11-01..2026-11-10`,
    )
    + "&per_page=100&page=1";
  githubResponses.byUrl.set(searchUrl, {
    items: [{ number: PR_NUMBER, title: `docs: lane contention (${identifier})`, pull_request: {} }],
    total_count: 1,
  });
  githubResponses.byUrl.set(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`, {
    number: PR_NUMBER,
    title: `docs: lane contention (${identifier})`,
    body: `Owning row: ${identifier}`,
    merged_at: MERGED_AT,
    // Present on the real payload, and deliberately NOT read by the repair.
    updated_at: UPDATED_AT_AFTER_MERGE,
    html_url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
    head: { ref: "cto/lane-contention", sha: "53ed5002".padEnd(40, "0") },
    additions: 10,
    deletions: 2,
  });
}

async function runReconciler(db: Db, companyId: string) {
  return reconcileMergedPullRequests(db, {
    companyId,
    repoFullName: REPO,
    since: new Date("2026-11-01T00:00:00Z"),
    until: new Date("2026-11-10T00:00:00Z"),
    token: "t",
    enrichLoc: false,
  });
}

describeEmbeddedPostgres("merged-PR reconciler repairs PR work products (PEN-6413)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-reconciler-wp-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    // The reconciler writes the LINK table too, and it carries an FK to
    // `issues` -- deleting issues first fails the constraint.
    await db.delete(issuePullRequests);
    await db.delete(issues);
    await db.delete(companies);
    githubResponses.byUrl.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(status: "ready_for_review" | "merged", metadataExtras: Record<string, unknown>) {
    const company = await db
      .insert(companies)
      .values({
        name: `PR Reconciler ${randomUUID().slice(0, 8)}`,
        issuePrefix: `PRR${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const identifier = `${company.issuePrefix}-1`;
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        identifier,
        title: "Owning row",
        status: "in_review",
        priority: "medium",
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      issueId: issue.id,
      type: "pull_request",
      provider: "github",
      externalId: EXTERNAL_ID,
      title: EXTERNAL_ID,
      url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      status,
      sourceTrust: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
      metadata: {
        source: PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
        owningIdentifiers: [identifier],
        branch: "cto/lane-contention",
        ...metadataExtras,
      },
    });
    stubGithub(identifier);
    return { company, issue, identifier };
  }

  async function readRow(companyId: string) {
    const rows = await db.select().from(issueWorkProducts);
    expect(rows).toHaveLength(1);
    void companyId;
    return rows[0]!;
  }

  it("repairs a stale row AND leaves it readable as a webhook-maintained owner", async () => {
    // The lost-delivery shape: stuck at `opened`, stamped with that event's
    // `updated_at`, which is earlier than the merge.
    const { company, issue, identifier } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    const result = await runReconciler(db, company.id);
    expect(result.workProductsOffered).toBe(1);

    const row = await readRow(company.id);
    const metadata = row.metadata as Record<string, unknown>;
    expect(row.status).toBe("merged");
    expect(metadata.merged).toBe(true);
    expect(metadata.mergedAt).toBe(MERGED_AT);

    // (1) The repair must not take the row out of any `metadata.source` reader.
    expect(metadata.source).toBe(PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE);
    // ...and must still be distinguishable from a real delivery.
    expect(metadata.repairedBy).toBe(PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER);
    expect(typeof metadata.repairedAt).toBe("string");

    // Read it the way the fleet ownership directive tells callers to.
    const owners = await workProductService(db).listOwnersByExternalId(company.id, {
      provider: "github",
      type: "pull_request",
      externalId: EXTERNAL_ID,
    });
    expect(owners).toHaveLength(1);
    expect(owners[0]!.issue.id).toBe(issue.id);
    expect(owners[0]!.provenance).toBe("webhook");
    expect(owners[0]!.owningIdentifiers).toEqual([identifier]);
  });

  it("does not churn a correctly delivered row whose PR was updated after the merge", async () => {
    // Delivered `closed`, stamped with the `updated_at` that event carried.
    // The PR has since been commented on, so its CURRENT `updated_at` is two
    // days later -- using it here would take the strict-`>` branch and replace
    // this row, refreshing `updatedAt` and overwriting `metadata`.
    const { company } = await seed("merged", {
      lastEventAction: "closed",
      merged: true,
      mergedAt: MERGED_AT,
      sourceEventOrder: 30,
      sourceEventActionOrder: 50,
      sourceEventTimestamp: MERGED_AT,
      sourceEventTimestampMs: Date.parse(MERGED_AT),
    });
    const before = await readRow(company.id);

    const result = await runReconciler(db, company.id);
    // Offered, as the counter's name says -- and rejected by the guard.
    expect(result.workProductsOffered).toBe(1);

    const after = await readRow(company.id);
    const metadata = after.metadata as Record<string, unknown>;
    expect(metadata.source).toBe(PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE);
    // The decisive assertion: a delivered row is NOT relabelled as a backfill.
    expect(metadata.repairedBy ?? null).toBeNull();
    expect(after.status).toBe("merged");
    expect(metadata.sourceEventTimestampMs).toBe(Date.parse(MERGED_AT));
    // `updatedAt` is a liveness signal; a no-op sweep must not refresh it.
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});

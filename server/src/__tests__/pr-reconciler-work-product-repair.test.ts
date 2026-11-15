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
 * The reconciler's only outbound call is the merged-PR search page.
 * Everything else it does is database work, which is what these tests assert.
 *
 * PEN-6341 item 2: there used to be a SECOND outbound call -- one
 * `GET /repos/{repo}/pulls/{n}` per search result, because the REST search
 * returned issue stubs carrying no branch and no additions/deletions. The
 * GraphQL search returns `PullRequest` nodes, so that N+1 is gone and this
 * harness stubs one envelope instead of a URL map.
 *
 * The seam is `ghGraphQlQuery` -- the HTTP transport and nothing above it. The
 * reconciler's own node reader, its `__typename` filter and its paging all run
 * for real against the envelope, which is what the old `ghFetch` stub gave and
 * what keeps these assertions a test of the reconciler rather than an echo of
 * their own fixture. `ghFetch` stays mocked too, and now serves NOTHING: any
 * REST read from this path is a regression, not a fixture.
 */
const githubResponses = vi.hoisted(() => ({
  searchNodes: [] as unknown[],
  /**
   * PEN-6733: the envelope's `pageInfo`, as a fixture INPUT.
   *
   * The default is the single-page shape every assertion above the truncation
   * block relies on. The three paths that end the page loop early are
   * distinguished only by this object, so a test that wants to reach one has
   * to be able to set it -- with it hard-coded, two of the three were
   * unreachable and therefore untested.
   */
  pageInfo: { hasNextPage: false, endCursor: null } as {
    hasNextPage: boolean;
    endCursor: string | null;
  },
  /**
   * How many pages the reconciler actually asked for. The page-cap test
   * asserts the loop STOPPED at the cap: without this it would pass just as
   * well against a loop that ran forever and was killed by the test timeout.
   */
  pageCalls: 0,
}));

vi.mock("../services/github-fetch.js", () => ({
  gitHubApiBase: () => "https://api.github.com",
  gitHubGraphQlUrl: () => "https://api.github.com/graphql",
  ghFetch: async (url: string) => {
    throw new Error(`REST read regressed in the merged-PR reconciler: ${url}`);
  },
  ghReadBody: async <T,>(_url: string, read: () => Promise<T>) => read(),
}));

vi.mock("../services/github-app-auth.js", () => ({
  ghGraphQlQuery: async () => {
    githubResponses.pageCalls += 1;
    return {
      ok: true as const,
      data: {
        search: {
          pageInfo: githubResponses.pageInfo,
          nodes: githubResponses.searchNodes,
        },
      },
    };
  },
}));

const {
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST,
} = await import("../services/pull-request-work-products.js");
const {
  reconcileMergedPullRequests,
  __test_MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES: MAX_PAGES,
} = await import("../services/issue-pull-requests.js");
const { workProductService } = await import("../services/work-products.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const REPO = "Blockcast/penstock-llm-proxy-core";
const PR_NUMBER = 2991;
const EXTERNAL_ID = `${REPO}#${PR_NUMBER}`;
const MERGED_AT = "2026-11-07T02:49:13Z";
/**
 * Later than the merge: a comment, label or deploy-bot post after it landed.
 *
 * PEN-6341 item 2 made this stronger rather than redundant. The production
 * query does not SELECT `updatedAt` at all, so the field cannot be picked up
 * by accident -- but the stub payload still CARRIES it, and the assertions
 * below check the stored source timestamp against BOTH values: it must equal
 * the merge instant and must not equal this one.
 */
const UPDATED_AT_AFTER_MERGE = "2026-11-09T18:02:44Z";

function stubGithub(identifier: string) {
  githubResponses.searchNodes = [
    {
      __typename: "PullRequest",
      number: PR_NUMBER,
      title: `docs: lane contention (${identifier})`,
      body: `Owning row: ${identifier}`,
      mergedAt: MERGED_AT,
      // The decoy, carried deliberately: a field the query does NOT select,
      // placed in the payload anyway so "the reconciler must not read it"
      // stays an assertion about the reconciler and not about the fixture.
      updatedAt: UPDATED_AT_AFTER_MERGE,
      url: `https://github.com/${REPO}/pull/${PR_NUMBER}`,
      headRefName: "cto/lane-contention",
      headRefOid: "53ed5002".padEnd(40, "0"),
      additions: 10,
      deletions: 2,
    },
    // A plain Issue in the same page. `search(type: ISSUE)` returns both, and
    // the reconciler must drop this exactly as the REST path dropped a search
    // item with no `pull_request` key -- without it ever reaching `enumerated`.
    { __typename: "Issue", number: 12, title: "not a pull request" },
  ];
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
    githubResponses.searchNodes = [];
    githubResponses.pageInfo = { hasNextPage: false, endCursor: null };
    githubResponses.pageCalls = 0;
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
    // ONE, not two: the stub page also carries a plain Issue, which
    // `search(type: ISSUE)` really does return and which must never be
    // enumerated as a pull request.
    expect(result.enumerated).toBe(1);
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
    // The repair offered the MERGE INSTANT, never the PR's current timestamp.
    expect(metadata.sourceEventTimestampMs).toBe(Date.parse(MERGED_AT));
    expect(metadata.sourceEventTimestampMs).not.toBe(Date.parse(UPDATED_AT_AFTER_MERGE));

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
    // ONE, not two: the stub page also carries a plain Issue, which
    // `search(type: ISSUE)` really does return and which must never be
    // enumerated as a pull request.
    expect(result.enumerated).toBe(1);
    // Offered, as the counter's name says -- and rejected by the guard.
    expect(result.workProductsOffered).toBe(1);

    const after = await readRow(company.id);
    const metadata = after.metadata as Record<string, unknown>;
    expect(metadata.source).toBe(PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE);
    // The decisive assertion: a delivered row is NOT relabelled as a backfill.
    expect(metadata.repairedBy ?? null).toBeNull();
    expect(after.status).toBe("merged");
    expect(metadata.sourceEventTimestampMs).toBe(Date.parse(MERGED_AT));
    // The decoy is in the payload and must not have been read.
    expect(metadata.sourceEventTimestampMs).not.toBe(Date.parse(UPDATED_AT_AFTER_MERGE));
    // `updatedAt` is a liveness signal; a no-op sweep must not refresh it.
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
  /**
   * PEN-6733. The rollup must distinguish "nothing to repair" from "could not
   * read the work".
   *
   * `workProductsOffered: 0` is the correct report for a clean estate AND the
   * report a sweep gives when every pull request in the window was unreadable.
   * That is how the repair above ran for a full deployment and produced
   * nothing with no surface saying so: the failure mode and the success mode
   * were the same number on the same line.
   */
  it("reports unreadable pull-request nodes rather than a clean zero (PEN-6733)", async () => {
    const { company } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    // A node that SAYS it is a pull request and carries no usable number, so
    // `readMergedPullRequestNode` refuses it. The plain Issue beside it is NOT
    // a loss and must not be counted -- that is the control that keeps this
    // assertion about unreadable rows rather than about every dropped node.
    githubResponses.searchNodes = [
      { __typename: "PullRequest", number: null, title: "unreadable" },
      { __typename: "Issue", number: 12, title: "not a pull request" },
    ];

    const result = await runReconciler(db, company.id);

    // The zero that used to be the whole report...
    expect(result.workProductsOffered).toBe(0);
    expect(result.enumerated).toBe(0);
    // ...and the field that now says it is not a clean one. The Issue is
    // excluded, so this counts 1 and not 2.
    expect(result.unreadableNodes).toBe(1);
    // ...while truncation stays FALSE, and that is the point of this pair.
    // The stub page is the LAST one (`hasNextPage: false`), so the walk
    // reached the end of the window: rows were LOST, not left unread. The two
    // fields answer different questions -- `unreadableNodes` reports a loss,
    // `enumerationTruncated` reports a PREFIX -- and keeping them orthogonal
    // is what lets a consumer add `enumerated + unreadableNodes` and account
    // for the whole window. The truncation tests below drive the three paths
    // that do set the flag.
    expect(result.enumerationTruncated).toBe(false);

    // Nothing was repaired on work that was never read.
    const row = await readRow(company.id);
    expect(row.status).toBe("ready_for_review");
  });

  it("reports a genuinely clean sweep as clean (PEN-6733 control)", async () => {
    // The control arm. Without it the assertions above pass just as well
    // against an implementation that reports every sweep as unreadable.
    const { company } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    const result = await runReconciler(db, company.id);

    expect(result.unreadableNodes).toBe(0);
    expect(result.enumerationTruncated).toBe(false);
    // The repair still lands, so the two fields above are reporting on a sweep
    // that actually did its work.
    expect(result.workProductsOffered).toBe(1);
  });

  /**
   * PEN-6733. THREE code paths end the page loop early and every one of them
   * leaves `enumerated` a PREFIX of the window. Each gets its own test, and
   * the fixtures are built so that reverting any single
   * `enumerationTruncated = true` in `reconcileMergedPullRequests` fails
   * EXACTLY ONE of them -- which is the only thing that makes these a control
   * on the flag rather than three ways of observing one path.
   *
   * They are deliberately not table-driven: the three differ in what the
   * server says, not in a parameter, and a shared fixture would hide that the
   * paths are reached by different envelopes.
   */
  it("reports an all-unreadable page as truncated when more results remain (PEN-6733 path 1)", async () => {
    const { company } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    // Same unreadable page as the orthogonality test above -- the ONE thing
    // changed is the server saying another page exists. That is what turns a
    // short enumeration into a prefix, and it is the whole difference between
    // this test's `true` and that test's `false`.
    githubResponses.searchNodes = [
      { __typename: "PullRequest", number: null, title: "unreadable" },
      { __typename: "Issue", number: 12, title: "not a pull request" },
    ];
    githubResponses.pageInfo = { hasNextPage: true, endCursor: "cursor-page-2" };

    const result = await runReconciler(db, company.id);

    expect(result.enumerationTruncated).toBe(true);
    expect(result.enumerated).toBe(0);
    // The loss is still reported separately, and the loop still stopped: this
    // path breaks rather than following the cursor.
    expect(result.unreadableNodes).toBe(1);
    expect(githubResponses.pageCalls).toBe(1);
  });

  it("reports another page with no cursor as truncated (PEN-6733 path 2)", async () => {
    const { company } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    // "There is more" with nothing to follow it with. The page itself reads
    // fine, which is what separates this from path 1: a sweep can enumerate
    // and repair real work and STILL be reporting a prefix.
    githubResponses.pageInfo = { hasNextPage: true, endCursor: null };

    const result = await runReconciler(db, company.id);

    expect(result.enumerationTruncated).toBe(true);
    // Nothing was unreadable -- the flag is not leaking in from path 1.
    expect(result.unreadableNodes).toBe(0);
    expect(result.enumerated).toBe(1);
    // ...and the work on the page it DID read still landed.
    expect(result.workProductsOffered).toBe(1);
    expect(githubResponses.pageCalls).toBe(1);
  });

  it("reports hitting the page cap as truncated (PEN-6733 path 3)", async () => {
    const { company } = await seed("ready_for_review", {
      lastEventAction: "opened",
      sourceEventOrder: 10,
      sourceEventActionOrder: 10,
      sourceEventTimestamp: "2026-10-29T18:40:57Z",
      sourceEventTimestampMs: Date.parse("2026-10-29T18:40:57Z"),
    });

    // Every page says there is another one and hands back a usable cursor, so
    // the loop is bounded only by the cap. A window wider than the cap returns
    // a prefix that is arithmetically indistinguishable from a complete sweep.
    githubResponses.pageInfo = { hasNextPage: true, endCursor: "cursor-next" };

    const result = await runReconciler(db, company.id);

    expect(result.enumerationTruncated).toBe(true);
    // The loop STOPPED at the cap. Asserting against the exported constant
    // rather than a literal is the point of exporting it: a third copy of the
    // number could drift from the loop bound silently.
    expect(githubResponses.pageCalls).toBe(MAX_PAGES);
    expect(result.enumerated).toBe(MAX_PAGES);
    // Readable pages throughout -- this path owes nothing to the other two.
    expect(result.unreadableNodes).toBe(0);
  });
});

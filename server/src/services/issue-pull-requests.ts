/**
 * Issue ↔ merged-PR linkage + authored-LOC enrichment (BLO-9117 / BLO-9102 Diff 2).
 *
 * Two capture paths, both author-agnostic by construction:
 *   - Forward (webhook): recordMergedPullRequest() persists the link when a PR
 *     closes as merged, keyed on the BLO- ref the PR text carries.
 *   - Backfill (reconciler): reconcileMergedPullRequests() enumerates a repo's
 *     merged PRs over a window via the GitHub GraphQL search WITHOUT an `author:`
 *     qualifier, so PRs from kkroo, app/allyblockcast, and app/blockcast-ci-packages
 *     are all enumerated identically. The no-ref tail is stored with a null
 *     issueId (option (C): surfaced in the coverage %, never silently dropped).
 *
 * authored-LOC needs the per-file diff, which neither the webhook payload nor
 * the search result carries — enrichAuthoredLocForRow() fetches pulls/{n}/files
 * and applies the shared exclusion set.
 *
 * ⛔ THAT FILE READ STAYS ON REST DELIBERATELY, and PEN-6341 item 2 measured
 * why rather than leaving it as an omission: GraphQL's `PullRequestChangedFile`
 * exposes exactly `additions`, `changeType`, `deletions`, `path` and
 * `viewerViewedState` — there is NO `patch`. `computeAuthoredLoc`'s gitlink
 * rule needs BOTH zero line churn AND the absence of a real hunk, because
 * either signal alone also matches a pure rename or a mode-only change. Over
 * GraphQL `patch` would be permanently undefined, so every 0/0 file would be
 * classified gitlink-only and silently excluded from authored LOC. The loss
 * would be a confident wrong answer, not an error. Do not "finish the
 * migration" by moving this one.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issuePullRequests, issues } from "@paperclipai/db";
import { ghFetch, ghReadBody, gitHubApiBase } from "./github-fetch.js";
import { ghGraphQlQuery } from "./github-app-auth.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { computeAuthoredLoc, type GithubPullFile } from "./authored-loc.js";
import {
  buildPullRequestWorkProductFields,
  PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER,
} from "./pull-request-work-products.js";
import { workProductService } from "./work-products.js";
import {
  extractPaperclipIdentifiers,
  resolveLinkSourceForIdentifier,
  resolveOwningPaperclipIdentifiers,
  type PullRequestLinkSource,
} from "./paperclip-identifiers.js";

const GITHUB_HOST = "github.com";
// Describes HOW a link was found, and is used to break ties only after
// ownership has had its say -- see recordMergedPullRequest. It deliberately
// ranks the branch first, which is the opposite of the ownership tier order,
// and that disagreement is why it must not decide ownership on its own.
const LINK_SOURCE_STRENGTH: Record<PullRequestLinkSource, number> = {
  branch_ref: 4,
  title_ref: 3,
  body_ref: 2,
  reconciler: 1,
  manual: 0,
};

export interface RecordMergedPullRequestInput {
  repoFullName: string;
  prNumber: number;
  headSha?: string | null;
  mergedAt?: Date | null;
  additions?: number | null;
  deletions?: number | null;
  branch?: string | null;
  title?: string | null;
  body?: string | null;
  /**
   * Issues already resolved by identifier (the webhook scans issues once). Each
   * carries the company it belongs to. NOTE: there is no PR-author field here —
   * attribution is purely identifier-driven.
   */
  matchedIssues: Array<{ id: string; companyId: string; identifier: string | null }>;
}

export interface RecordedPullRequestRow {
  id: string;
  companyId: string;
  issueId: string | null;
  repoFullName: string;
  prNumber: number;
}

function resolveGithubApiToken(): string | null {
  // Same env names the agent runtime uses (GH_TOKEN / GITHUB_TOKEN). Optional:
  // public repos resolve unauthenticated; private repos (Blockcast/*) need it.
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

function githubApiHeaders(token?: string | null): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  const resolved = token ?? resolveGithubApiToken();
  if (resolved) headers.authorization = `Bearer ${resolved}`;
  return headers;
}

/**
 * Choose one issue per company: the issue the ownership resolver names wins;
 * only when it names none does the strongest link source decide, then first
 * seen. Pure, so the ownership-vs-strength precedence is testable without a DB.
 *
 * Deferring to ownership is load-bearing rather than tidy. This module ranks
 * `branch_ref` above `title_ref`, while resolveOwningPaperclipIdentifiers ranks
 * the branch LAST and documents the measurement behind it: branches get
 * repurposed, so over 175 PRs a branch tier disagreed with the curated
 * title/body answer 8 times and was the wrong issue in every one. Selecting on
 * link-source strength alone therefore let a stale branch ref outrank the
 * curated title owner -- for branch `fix/blo-1-stale`, title `Fix BLO-2`, body
 * `Related: BLO-1`, ownership correctly chooses BLO-2 while strength alone
 * persisted the PR against BLO-1.
 *
 * That was reachable only after resolveLinkSourceForIdentifier began reading the
 * branch case-insensitively (BLO-20886 round 6): before, a lowercase branch
 * scored `body_ref` here and lost to the title by accident. Fixing one half of
 * the module's disagreement about ownership exposed the other half, so the two
 * orderings are reconciled here instead of being left to coincide.
 *
 * `linkSource` still records which field carried the identifier -- that is
 * descriptive provenance, and it stays accurate for whichever issue is chosen.
 */
function selectIssuePerCompany(
  matchedIssues: RecordMergedPullRequestInput["matchedIssues"],
  fields: { branch?: string | null; title?: string | null; body?: string | null },
): Map<string, { issueId: string; identifier: string; linkSource: PullRequestLinkSource; owning: boolean }> {
  const owning = new Set(resolveOwningPaperclipIdentifiers(fields).owning);
  const bestPerCompany = new Map<
    string,
    { issueId: string; identifier: string; linkSource: PullRequestLinkSource; owning: boolean }
  >();
  for (const issue of matchedIssues) {
    if (!issue.identifier) continue;
    const linkSource = resolveLinkSourceForIdentifier(issue.identifier, fields) ?? "body_ref";
    const isOwning = owning.has(issue.identifier);
    const existing = bestPerCompany.get(issue.companyId);
    const better =
      !existing ||
      (isOwning && !existing.owning) ||
      (isOwning === existing.owning &&
        LINK_SOURCE_STRENGTH[linkSource] > LINK_SOURCE_STRENGTH[existing.linkSource]);
    if (better) {
      bestPerCompany.set(issue.companyId, {
        issueId: issue.id,
        identifier: issue.identifier,
        linkSource,
        owning: isOwning,
      });
    }
  }
  return bestPerCompany;
}

/**
 * Persist the issue↔PR link for every matched company (one row per
 * (company, repo, PR) — the unique key). See selectIssuePerCompany for how the
 * single issue per company is chosen.
 */
export async function recordMergedPullRequest(
  db: Db,
  input: RecordMergedPullRequestInput,
): Promise<RecordedPullRequestRow[]> {
  const fields = { branch: input.branch, title: input.title, body: input.body };
  const bestPerCompany = selectIssuePerCompany(input.matchedIssues, fields);

  const recorded: RecordedPullRequestRow[] = [];
  for (const [companyId, choice] of bestPerCompany) {
    const row = await upsertPullRequestRow(db, {
      companyId,
      issueId: choice.issueId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      headSha: input.headSha ?? null,
      mergedAt: input.mergedAt ?? null,
      additions: input.additions ?? null,
      deletions: input.deletions ?? null,
      linkSource: choice.linkSource,
      paperclipIdentifier: choice.identifier,
    });
    recorded.push(row);
  }
  return recorded;
}

interface UpsertPullRequestInput {
  companyId: string;
  issueId: string | null;
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
  mergedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  linkSource: PullRequestLinkSource;
  paperclipIdentifier: string | null;
}

async function upsertPullRequestRow(db: Db, input: UpsertPullRequestInput): Promise<RecordedPullRequestRow> {
  const [row] = await db
    .insert(issuePullRequests)
    .values({
      companyId: input.companyId,
      issueId: input.issueId,
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      headSha: input.headSha,
      mergedAt: input.mergedAt,
      additions: input.additions,
      deletions: input.deletions,
      linkSource: input.linkSource,
      paperclipIdentifier: input.paperclipIdentifier,
    })
    .onConflictDoUpdate({
      target: [issuePullRequests.companyId, issuePullRequests.repoFullName, issuePullRequests.prNumber],
      set: {
        // Re-link if a later signal resolved an issue; keep an existing link if
        // the new one is null (don't unlink on a bare re-delivery).
        issueId: sql`coalesce(${issuePullRequests.issueId}, excluded.issue_id)`,
        headSha: sql`coalesce(excluded.head_sha, ${issuePullRequests.headSha})`,
        mergedAt: sql`coalesce(excluded.merged_at, ${issuePullRequests.mergedAt})`,
        additions: sql`coalesce(excluded.additions, ${issuePullRequests.additions})`,
        deletions: sql`coalesce(excluded.deletions, ${issuePullRequests.deletions})`,
        linkSource: sql`coalesce(${issuePullRequests.linkSource}, excluded.link_source)`,
        paperclipIdentifier: sql`coalesce(${issuePullRequests.paperclipIdentifier}, excluded.paperclip_identifier)`,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: issuePullRequests.id,
      companyId: issuePullRequests.companyId,
      issueId: issuePullRequests.issueId,
      repoFullName: issuePullRequests.repoFullName,
      prNumber: issuePullRequests.prNumber,
    });
  return row;
}

/** Paginated `GET /repos/{repo}/pulls/{n}/files`. */
export async function fetchPullRequestFiles(
  repoFullName: string,
  prNumber: number,
  token?: string | null,
): Promise<GithubPullFile[]> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headers = githubApiHeaders(token);
  const files: GithubPullFile[] = [];
  const perPage = 100;
  for (let page = 1; page <= 30; page += 1) {
    const url = `${apiBase}/repos/${repoFullName}/pulls/${prNumber}/files?per_page=${perPage}&page=${page}`;
    const res = await ghFetch(url, { headers });
    if (!res.ok) {
      throw unprocessable(`pulls/${prNumber}/files page ${page} -> ${res.status}`);
    }
    const batch = (await ghReadBody(url, () => res.json())) as GithubPullFile[];
    files.push(...batch);
    if (batch.length < perPage) break;
  }
  return files;
}

/** Fetch the PR's file list, compute authored-LOC, and persist it on the row. */
export async function enrichAuthoredLocForRow(
  db: Db,
  row: { id: string; repoFullName: string; prNumber: number },
  opts: { token?: string | null } = {},
): Promise<void> {
  const files = await fetchPullRequestFiles(row.repoFullName, row.prNumber, opts.token);
  const loc = computeAuthoredLoc(files);
  await db
    .update(issuePullRequests)
    .set({
      authoredAdditions: loc.authoredAdditions,
      authoredDeletions: loc.authoredDeletions,
      additions: sql`coalesce(${issuePullRequests.additions}, ${loc.rawAdditions})`,
      deletions: sql`coalesce(${issuePullRequests.deletions}, ${loc.rawDeletions})`,
      excludedPaths: loc.excludedPaths,
      locEnrichedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(issuePullRequests.id, row.id));
}

/** Enrich rows whose authored-LOC has not been computed yet (webhook lost the
 * fire-and-forget, or the reconciler deferred it). */
export async function reconcilePendingLocEnrichment(
  db: Db,
  input: { companyId: string; limit?: number; token?: string | null },
): Promise<{ enriched: number; failed: number }> {
  const pending = await db
    .select({
      id: issuePullRequests.id,
      repoFullName: issuePullRequests.repoFullName,
      prNumber: issuePullRequests.prNumber,
    })
    .from(issuePullRequests)
    .where(and(eq(issuePullRequests.companyId, input.companyId), isNull(issuePullRequests.locEnrichedAt)))
    .limit(input.limit ?? 50);

  let enriched = 0;
  let failed = 0;
  for (const row of pending) {
    try {
      await enrichAuthoredLocForRow(db, row, { token: input.token });
      enriched += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, prNumber: row.prNumber, repoFullName: row.repoFullName }, "loc enrichment reconcile failed");
    }
  }
  return { enriched, failed };
}

/**
 * One merged pull request, carrying EVERY field the reconciler decides on.
 *
 * PEN-6341 item 2: this is what kills the N+1. The REST path ran
 * `GET /search/issues` and then one `GET /repos/{repo}/pulls/{n}` PER RESULT,
 * because -- as the old comment at that call site said -- "search results lack
 * branch + additions/deletions". The GraphQL search returns `PullRequest`
 * NODES rather than issue stubs, so those fields come back on the enumeration
 * itself and the detail reads are ELIMINATED rather than relocated.
 *
 * That matters for the budget specifically because the two legs sit on
 * DIFFERENT GitHub resources: the REST search leg draws on `search`, which is
 * not the exhausted shard, while the N detail reads draw on `core`. Migrating
 * the search alone would have bought shard B nothing; removing the N is the
 * entire win, so this site is priced by the N and never by the 1.
 *
 * `updated_at`/`updatedAt` is deliberately NOT selected. It is the PR's
 * CURRENT timestamp at sweep time, and it feeds the work-product ordering
 * guard -- see the `prUpdatedAt` argument below for why using it churns
 * correctly delivered rows. Not selecting it at all is stronger than not
 * reading it: the field cannot be picked up by accident.
 */
interface GithubMergedPullRequestNode {
  number: number;
  title: string | null;
  body: string | null;
  url: string | null;
  mergedAt: string | null;
  additions: number | null;
  deletions: number | null;
  headRefName: string | null;
  headRefOid: string | null;
}

const MERGED_PULL_REQUESTS_SEARCH_QUERY = `
query($q: String!, $first: Int!, $cursor: String) {
  search(query: $q, type: ISSUE, first: $first, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        body
        url
        mergedAt
        additions
        deletions
        headRefName
        headRefOid
      }
    }
  }
}`;

/**
 * Pages of 100 the merged-PR search will follow before giving up (PEN-6733).
 *
 * Named rather than inlined because the truncation test at the bottom of the
 * loop compares against it: as two literals they could drift apart silently,
 * and the symptom would be a prefix enumeration reported as a complete one.
 * Re-exported as `__test_MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES` for the same
 * reason -- `pr-reconciler-work-product-repair.test.ts` drives the loop to the
 * cap and must not hard-code a third copy of the number.
 */
const MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES = 10;

type SearchPullRequestsResponse = {
  search?: {
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
    nodes?: unknown;
  } | null;
};

function readMergedPullRequestNode(node: unknown): GithubMergedPullRequestNode | null {
  if (!node || typeof node !== "object") return null;
  const row = node as Record<string, unknown>;
  // `type: ISSUE` searches issues AND pull requests, so a plain Issue arrives
  // with none of the inline-fragment fields. The REST path filtered the same
  // population with `items.filter((it) => it.pull_request)`.
  if (row.__typename !== "PullRequest") return null;
  const number = row.number;
  if (typeof number !== "number" || !Number.isInteger(number)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    number,
    title: str(row.title),
    body: str(row.body),
    url: str(row.url),
    mergedAt: str(row.mergedAt),
    additions: num(row.additions),
    deletions: num(row.deletions),
    headRefName: str(row.headRefName),
    headRefOid: str(row.headRefOid),
  };
}

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Backfill reconciler — enumerate a repo's merged PRs over a window and persist
 * a link row for EACH, attributing by BLO- ref. **No `author:` qualifier**: the
 * enumeration is identity-agnostic by construction, so the kkroo /
 * app/allyblockcast / app/blockcast-ci-packages buckets are all counted. The
 * no-ref tail is stored with issueId=null + linkSource='reconciler' (option (C):
 * the coverage denominator counts it, it is never silently dropped).
 *
 * `companyId` scopes both the stored rows and the identifier→issue resolution:
 * the unattributed tail is "merged PRs in THIS company's repo window with no
 * resolvable ref", which is exactly the coverage % the rollup reports.
 */
export async function reconcileMergedPullRequests(
  db: Db,
  input: {
    companyId: string;
    repoFullName: string;
    since: Date;
    until: Date;
    token?: string | null;
    enrichLoc?: boolean;
  },
): Promise<{
  enumerated: number;
  linked: number;
  unlinked: number;
  enriched: number;
  workProductsOffered: number;
  /**
   * PEN-6733: merged pull-request nodes the enumeration could NOT read, summed
   * over every page.
   *
   * This is the field that makes `workProductsOffered` readable. On its own a
   * `0` there spans two opposite states -- a clean estate with nothing to
   * repair, and a sweep that could not read the work it was meant to do --
   * and nothing else on the rollup, or on the work product itself, separates
   * them. That is how the repair this reconciler carries ran for its first
   * full deployment and produced nothing, visibly to no one.
   */
  unreadableNodes: number;
  /**
   * PEN-6733: true when the enumeration stopped before the window was
   * exhausted, so `enumerated` is a PREFIX rather than a count.
   *
   * All three truncating paths below leave a log line -- two of their own, and
   * the all-unreadable path only through the per-page unreadable WARN -- and a
   * log line is not a value a caller can act on: the rollup still reported a
   * clean pass. A sweep that covered part of a window must not be
   * arithmetically indistinguishable from one that covered all of it.
   */
  enumerationTruncated: boolean;
}> {
  // Author-agnostic enumeration. Intentionally NO `author:` qualifier.
  const q = `repo:${input.repoFullName} is:pr is:merged merged:${toYmd(input.since)}..${toYmd(input.until)}`;

  // PEN-6341 item 2: GraphQL has no anonymous mode, where REST search had one.
  // Refusing here is the honest form of that: an unauthenticated sweep would
  // otherwise enumerate NOTHING and report `enumerated: 0`, which this
  // function's own caller reads as "no merged PRs in the window" and folds
  // into a coverage percentage. A thrown error stops the sweep for this repo
  // and leaves the prior numbers standing.
  const token = input.token ?? resolveGithubApiToken();
  if (!token) throw unprocessable("reconciler: no GitHub token for the merged-PR search");

  // Resolve this company's issue identifiers once for attribution.
  const companyIssues = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(eq(issues.companyId, input.companyId));
  const issueByIdentifier = new Map<string, string>();
  for (const issue of companyIssues) {
    if (issue.identifier) issueByIdentifier.set(issue.identifier, issue.id);
  }

  let enumerated = 0;
  let unreadableNodes = 0;
  let enumerationTruncated = false;
  let linked = 0;
  let unlinked = 0;
  let enriched = 0;
  let workProductsOffered = 0;
  const workProducts = workProductService(db);

  let cursor: string | null = null;
  for (let page = 1; page <= MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES; page += 1) {
    const result = await ghGraphQlQuery<SearchPullRequestsResponse>({
      token,
      query: MERGED_PULL_REQUESTS_SEARCH_QUERY,
      variables: { q, first: 100, cursor },
    });
    // Fail CLOSED, exactly as the REST pager's non-2xx did. An unreadable page
    // is not an empty one, and this function's return value feeds a coverage
    // percentage: a silent `enumerated: 0` would read as "the window really
    // held no merged PRs".
    if (!result.ok) throw unprocessable(`search merged PRs page ${page} -> ${result.reason}`);
    const connection = result.data.search;
    if (!connection || !Array.isArray(connection.nodes)) {
      throw unprocessable(`search merged PRs page ${page} -> payload_malformed`);
    }

    const items: GithubMergedPullRequestNode[] = [];
    let unreadableNodesThisPage = 0;
    for (const node of connection.nodes) {
      const row = readMergedPullRequestNode(node);
      // A non-PullRequest node is an ORDINARY Issue and is not a loss -- the
      // REST path dropped those too. A node that IS shaped like one and still
      // will not read is counted, because an enumeration whose whole job is
      // completeness must not skip it silently.
      //
      // PEN-6742 item 2: that is NARROWER than "a row this token could not
      // resolve", which this comment used to claim. A refusal arrives as a
      // non-empty `errors` array, so `ghGraphQlQuery` returns `ok: false` and
      // the `throw` above this loop fails the entire page -- it never reaches
      // the counter. What lands here is a `PullRequest` node whose `number`
      // is missing or non-integer, the single field the row reader requires.
      if (row === null) {
        if (node && typeof node === "object" && (node as Record<string, unknown>).__typename === "PullRequest") {
          unreadableNodesThisPage += 1;
        }
        continue;
      }
      items.push(row);
    }
    unreadableNodes += unreadableNodesThisPage;
    if (unreadableNodesThisPage > 0) {
      logger.warn(
        { repoFullName: input.repoFullName, page, unreadableNodes: unreadableNodesThisPage },
        "reconciler: merged-PR search returned pull-request nodes this token could not read",
      );
    }
    if (items.length === 0) {
      // PEN-6733: an empty page is not always the end of the results, and the
      // two reasons it can be empty take DIFFERENT reports.
      //
      // `hasNextPage === true` is the server's own statement that more results
      // exist, so breaking here leaves `enumerated` a PREFIX of the window.
      // That is a truncation and is reported as one.
      //
      // `hasNextPage === false` is the end of the window. A page whose
      // pull-request nodes ALL failed to read has LOST rows -- but it lost
      // them from a window this walk reached the end of, so the enumeration is
      // SHORT, not truncated, and `unreadableNodes` already reports the loss.
      // Setting the flag here as well would put one number across two states,
      // which is the exact conflation this change exists to remove, one field
      // over. Keeping the two orthogonal is what lets a consumer rely on
      // `enumerated + unreadableNodes` accounting for the whole window
      // whenever `enumerationTruncated` is false.
      //
      // The break itself is KEPT, and not because it is right: `endCursor` is
      // on this page and could be followed. It is kept because paging on
      // through unreadable results is a behavioural change with its own
      // budget cost, and the case for it should be made from a non-zero
      // `truncatedTargets` in production rather than guessed at here. What
      // changes is that the caller is TOLD, which is what makes that
      // measurement possible at all.
      if (connection.pageInfo?.hasNextPage === true) {
        enumerationTruncated = true;
      }
      break;
    }

    for (const item of items) {
      enumerated += 1;
      // PEN-6341 item 2: no per-result detail read. The search NODES carry
      // branch, head sha, additions and deletions, which is what the REST
      // path needed the N+1 for.
      const branch = item.headRefName;
      const title = item.title;
      const body = item.body;

      // Attribute by ref (branch/title/body), never by author.
      const identifiers = extractPaperclipIdentifiers(branch, title, body);
      let issueId: string | null = null;
      let identifier: string | null = null;
      let linkSource: PullRequestLinkSource = "reconciler";
      for (const id of identifiers) {
        const matchedIssueId = issueByIdentifier.get(id);
        if (matchedIssueId) {
          issueId = matchedIssueId;
          identifier = id;
          linkSource = resolveLinkSourceForIdentifier(id, { branch, title, body }) ?? "reconciler";
          break;
        }
      }

      const row = await upsertPullRequestRow(db, {
        companyId: input.companyId,
        issueId,
        repoFullName: input.repoFullName,
        prNumber: item.number,
        headSha: item.headRefOid,
        mergedAt: item.mergedAt ? new Date(item.mergedAt) : null,
        additions: item.additions,
        deletions: item.deletions,
        linkSource,
        paperclipIdentifier: identifier,
      });
      if (issueId) linked += 1;
      else unlinked += 1;

      // PEN-6413. Repair the PR WORK PRODUCT from the same GitHub read.
      //
      // Two merged-PR records exist and only one of them was repairable. The
      // link table above has this backfill but NO read route, so no consumer
      // can see it. `issue_work_products` is the opposite: it backs
      // `GET /issues/:id/work-products` and the by-external-id lookup that the
      // fleet's "whose row owns this PR?" directive depends on, and the webhook
      // is its ONLY writer -- so a lost `closed` delivery leaves it
      // permanently non-terminal. The table with the repair had no readers; the
      // table with the readers had no repair.
      //
      // Measured company-wide 2026-11-10 over 5815/5815 issues: 24 of 4592
      // bound PRs (0.52%) carry a non-terminal work-product status while GitHub
      // reports MERGED/CLOSED. The losses arrive in bursts -- four adjacent
      // pairs within 60s, one of them spanning two repos, P < 1e-5 against a
      // uniform null -- which rules out per-PR payload parsing and repo webhook
      // config, and points at ingestion windows. Nothing re-reads GitHub for
      // this table, so every one of those rows is permanent.
      //
      // Safe by construction against the ordering guard in
      // `upsertByExternalId`: this row is accepted only when its source
      // timestamp is strictly later than the stored one, and on an exact tie
      // two terminal rows fall through to equal action/source ranks and the
      // incoming one is REJECTED. A row already recording the merge is
      // therefore left alone rather than churned.
      //
      // That property is LOAD-BEARING ON `prUpdatedAt` BELOW, and nothing else
      // enforces it: pass the PR's current `updated_at` instead of the merge
      // instant and every correctly delivered row in the window is churned
      // rather than left alone. If you change that argument, this paragraph
      // stops being true.
      //
      // Provenance is carried by `metadata.repairedBy`, NOT by overriding
      // `metadata.source`. `source` is the trust key five readers gate on, and
      // a repaired row that failed their filter would stop receiving the owner
      // wake on every FUTURE event -- see the `repairedBy` docblock in
      // `pull-request-work-products.ts`.
      //
      // Writes one row per REFERENCED issue, mirroring the webhook, not just
      // the single `issueId` the link table keeps -- the work product is
      // evidence about the PR and every referencing row carries one.
      // `owningIdentifiers` is resolved the same way the webhook resolves it,
      // because `metadata` is replaced wholesale on accept: passing `null` here
      // would erase a recorded owning set and silently downgrade every
      // consumer's `relation` from "owner" to "undetermined".
      const mergedAtIso = item.mergedAt;
      if (mergedAtIso) {
        const owning = resolveOwningPaperclipIdentifiers({ branch, title, body }).owning;
        const targets = new Set<string>([...identifiers, ...owning]);
        const fields = buildPullRequestWorkProductFields({
          repoFullName: input.repoFullName,
          prNumber: item.number,
          prTitle: title,
          prUrl: item.url,
          headSha: item.headRefOid,
          previousHeadSha: null,
          prBranch: branch,
          prDraft: false,
          prMerged: true,
          prMergedAt: mergedAtIso,
          // THE MERGE INSTANT, never the PR's current `updated_at`.
          //
          // `prUpdatedAt` becomes `metadata.sourceEventTimestampMs`, which is
          // what `upsertByExternalId`'s guard compares. A correctly delivered
          // `closed` row stored the `updated_at` carried by that event, which
          // is >= `merged_at`. GitHub bumps `updated_at` on ANY later activity
          // -- a comment, a label, a deploy or review-gate bot post, all
          // routine on this fleet -- so the sweep-time value is strictly LATER
          // than the delivered row's, takes the strict-`>` branch, and
          // replaces a correct row wholesale: `metadata` is overwritten and
          // `updatedAt` (a liveness signal) is refreshed on a PR merged days
          // ago. Passing the merge instant makes a delivered row tie or win,
          // and two terminal rows of equal rank are rejected, so it is left
          // alone.
          //
          // Known and accepted gap: a stale row whose last delivered
          // `pull_request` event is itself POST-merge (a `labeled` that landed
          // while the `closed` was lost) stores a timestamp later than
          // `merged_at` and is not repaired. That fails CLOSED -- it leaves
          // the row exactly as stale as it already was -- which is the right
          // side to err on against relabelling every correctly delivered row
          // in the window.
          prUpdatedAt: mergedAtIso,
          action: "closed",
          owningIdentifiers: owning,
          repairedBy: PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER,
          repairedAt: new Date().toISOString(),
        });
        for (const targetIdentifier of targets) {
          const targetIssueId = issueByIdentifier.get(targetIdentifier);
          if (!targetIssueId) continue;
          try {
            await workProducts.upsertByExternalId(
              targetIssueId,
              input.companyId,
              { provider: "github", type: "pull_request", externalId: fields.externalId },
              {
                title: fields.title,
                url: fields.url,
                status: fields.status,
                metadata: fields.metadata,
                sourceTrust: fields.sourceTrust,
              },
            );
            workProductsOffered += 1;
          } catch (err) {
            // Best-effort, mirroring the webhook: a work-product write must
            // never break the link reconciliation this function exists for.
            logger.warn(
              { err, prNumber: item.number, targetIdentifier },
              "reconciler PR work-product repair failed",
            );
          }
        }
      }

      if (input.enrichLoc) {
        try {
          await enrichAuthoredLocForRow(db, row, { token: input.token });
          enriched += 1;
        } catch (err) {
          logger.warn({ err, prNumber: item.number }, "reconciler enrichment failed");
        }
      }
    }

    // `pageInfo.hasNextPage` is an explicit statement by the server where the
    // REST loop had to infer the end from a short page (`items.length < 100`).
    //
    // PEN-6742 item 4: that inference was SOUND, and an earlier revision of
    // this comment wrongly claimed it was broken by the PR-only `filter`.
    // Measured at the pre-migration commit `9dcd29e3`: the search query
    // already carried `is:pr`, so `items.filter((it) => it.pull_request)`
    // dropped nothing and `items.length` was the true page size. The gain
    // here is replacing a correct INFERENCE with an explicit server
    // statement -- a smaller claim than the one this comment used to make,
    // and the real one.
    if (connection.pageInfo?.hasNextPage !== true) break;
    const rawCursor: unknown = connection.pageInfo?.endCursor;
    cursor = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null;
    // "There is more" with no cursor to follow cannot be paged, and silently
    // stopping would report a PREFIX as the whole window.
    if (cursor === null) {
      logger.warn(
        { repoFullName: input.repoFullName, page },
        "reconciler: merged-PR search reported another page with no cursor; enumeration is a prefix",
      );
      // PEN-6733: the comment above already called this a prefix. Say so in
      // the RETURN VALUE as well, so a caller aggregating these numbers is not
      // the one reader who cannot tell.
      enumerationTruncated = true;
      break;
    }
    // PEN-6733: the third truncation, and the one that HAD no log line of its
    // own -- the server says there is another page and the loop simply runs
    // out of iterations. A window wider than the cap returns a PREFIX that is
    // arithmetically identical to a complete sweep.
    if (page === MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES) {
      logger.warn(
        {
          repoFullName: input.repoFullName,
          page,
          maxPages: MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES,
        },
        "reconciler: merged-PR search hit the page cap with more results pending; enumeration is a prefix",
      );
      enumerationTruncated = true;
    }
  }

  return {
    enumerated,
    linked,
    unlinked,
    enriched,
    workProductsOffered,
    unreadableNodes,
    enumerationTruncated,
  };
}

// Test-only re-exports.
export const __test_LINK_SOURCE_STRENGTH = LINK_SOURCE_STRENGTH;
export const __test_selectIssuePerCompany = selectIssuePerCompany;
export const __test_MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES = MERGED_PULL_REQUESTS_SEARCH_MAX_PAGES;

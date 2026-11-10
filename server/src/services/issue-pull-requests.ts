/**
 * Issue ↔ merged-PR linkage + authored-LOC enrichment (BLO-9117 / BLO-9102 Diff 2).
 *
 * Two capture paths, both author-agnostic by construction:
 *   - Forward (webhook): recordMergedPullRequest() persists the link when a PR
 *     closes as merged, keyed on the BLO- ref the PR text carries.
 *   - Backfill (reconciler): reconcileMergedPullRequests() enumerates a repo's
 *     merged PRs over a window via the GitHub search API WITHOUT an `author:`
 *     qualifier, so PRs from kkroo, app/allyblockcast, and app/blockcast-ci-packages
 *     are all enumerated identically. The no-ref tail is stored with a null
 *     issueId (option (C): surfaced in the coverage %, never silently dropped).
 *
 * authored-LOC needs the per-file diff, which neither the webhook payload nor
 * the search result carries — enrichAuthoredLocForRow() fetches pulls/{n}/files
 * and applies the shared exclusion set.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issuePullRequests, issues } from "@paperclipai/db";
import { ghFetch, ghReadBody, gitHubApiBase } from "./github-fetch.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { computeAuthoredLoc, type GithubPullFile } from "./authored-loc.js";
import {
  buildPullRequestWorkProductFields,
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE_RECONCILER,
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

interface GithubSearchItem {
  number: number;
  title?: string | null;
  body?: string | null;
  pull_request?: unknown;
}

interface GithubPullDetail {
  number: number;
  title?: string | null;
  body?: string | null;
  merged_at?: string | null;
  // PEN-6413: `updated_at` feeds the work-product ordering guard, which accepts
  // an incoming row only when its source timestamp is strictly later than the
  // stored one. `html_url` is the row's link. Both are already present on the
  // REST PR detail fetched below; neither was read before.
  html_url?: string | null;
  updated_at?: string | null;
  additions?: number | null;
  deletions?: number | null;
  head?: { ref?: string | null; sha?: string | null } | null;
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
  workProductsRepaired: number;
}> {
  const apiBase = gitHubApiBase(GITHUB_HOST);
  const headers = githubApiHeaders(input.token);

  // Author-agnostic enumeration. Intentionally NO `author:` qualifier.
  const q = `repo:${input.repoFullName} is:pr is:merged merged:${toYmd(input.since)}..${toYmd(input.until)}`;

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
  let linked = 0;
  let unlinked = 0;
  let enriched = 0;
  let workProductsRepaired = 0;
  const workProducts = workProductService(db);

  for (let page = 1; page <= 10; page += 1) {
    const url = `${apiBase}/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
    const res = await ghFetch(url, { headers });
    if (!res.ok) throw unprocessable(`search merged PRs page ${page} -> ${res.status}`);
    const json = (await ghReadBody(url, () => res.json())) as {
      items?: GithubSearchItem[];
      total_count?: number;
    };
    const items = (json.items ?? []).filter((it) => it.pull_request);
    if (items.length === 0) break;

    for (const item of items) {
      enumerated += 1;
      // Search results lack branch + additions/deletions; fetch the PR detail.
      let detail: GithubPullDetail | null = null;
      try {
        const prUrl = `${apiBase}/repos/${input.repoFullName}/pulls/${item.number}`;
        const prRes = await ghFetch(prUrl, { headers });
        if (prRes.ok) detail = (await ghReadBody(prUrl, () => prRes.json())) as GithubPullDetail;
      } catch (err) {
        logger.warn({ err, prNumber: item.number }, "reconciler PR detail fetch failed");
      }

      const branch = detail?.head?.ref ?? null;
      const title = detail?.title ?? item.title ?? null;
      const body = detail?.body ?? item.body ?? null;

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
        headSha: detail?.head?.sha ?? null,
        mergedAt: detail?.merged_at ? new Date(detail.merged_at) : null,
        additions: detail?.additions ?? null,
        deletions: detail?.deletions ?? null,
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
      // Writes one row per REFERENCED issue, mirroring the webhook, not just
      // the single `issueId` the link table keeps -- the work product is
      // evidence about the PR and every referencing row carries one.
      // `owningIdentifiers` is resolved the same way the webhook resolves it,
      // because `metadata` is replaced wholesale on accept: passing `null` here
      // would erase a recorded owning set and silently downgrade every
      // consumer's `relation` from "owner" to "undetermined".
      const mergedAtIso = detail?.merged_at ?? null;
      if (mergedAtIso) {
        const owning = resolveOwningPaperclipIdentifiers({ branch, title, body }).owning;
        const targets = new Set<string>([...identifiers, ...owning]);
        const fields = buildPullRequestWorkProductFields({
          repoFullName: input.repoFullName,
          prNumber: item.number,
          prTitle: title,
          prUrl: detail?.html_url ?? null,
          headSha: detail?.head?.sha ?? null,
          previousHeadSha: null,
          prBranch: branch,
          prDraft: false,
          prMerged: true,
          prMergedAt: mergedAtIso,
          // Falls back to the merge instant when the detail fetch above failed:
          // null here would drop the guard to its tie-break, which prefers a
          // terminal row and would accept this one against a LATER delivered
          // event. A present timestamp keeps the strict comparison.
          prUpdatedAt: detail?.updated_at ?? mergedAtIso,
          action: "closed",
          owningIdentifiers: owning,
          source: PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE_RECONCILER,
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
            workProductsRepaired += 1;
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

    if (items.length < 100) break;
  }

  return { enumerated, linked, unlinked, enriched, workProductsRepaired };
}

// Test-only re-exports.
export const __test_LINK_SOURCE_STRENGTH = LINK_SOURCE_STRENGTH;
export const __test_selectIssuePerCompany = selectIssuePerCompany;

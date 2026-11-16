/**
 * Merged-PR reconciler scheduling (BLO-9150 — follow-up to BLO-9117 / #308 / #309).
 *
 * #308 landed the forward webhook (`recordMergedPullRequest`) and the backfill
 * reconciler (`reconcileMergedPullRequests`) but deliberately left repo-discovery
 * and scheduling unwired. #309 added the `forwardOnly` honesty signal on
 * `CoverageReport`. This module is the missing caller: it discovers the repos a
 * company has merged PRs in and runs the backfill reconciler over a trailing
 * window so the no-ref tail is stored — which is what flips `forwardOnly` false
 * and makes the coverage % a measured number instead of a vacuous ~100%.
 *
 * Split for testability:
 *   - `selectReconcilerTargets` — thin DISTINCT query (integration concern).
 *   - `runReconcilerSweep` — pure orchestration (window math, per-repo error
 *     isolation, aggregation), unit-tested with injected fakes.
 *   - `reconcilerSweepTick` — the wiring index.ts schedules.
 */
import type { Db } from "@paperclipai/db";
import { issuePullRequests } from "@paperclipai/db";
import { reconcileMergedPullRequests } from "./issue-pull-requests.js";
import { logger as defaultLogger } from "../middleware/logger.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ReconcilerTarget {
  companyId: string;
  repoFullName: string;
}

export interface ReconcileResult {
  enumerated: number;
  linked: number;
  unlinked: number;
  enriched: number;
  /**
   * PEN-6413: PR work-product upserts that OFFERED a terminal state. This is an
   * UPPER BOUND on rows actually changed, not a count of repairs --
   * `upsertByExternalId` resolves the ordering guard in SQL and does not report
   * whether it accepted, so a row already recording the merge is counted here
   * and correctly left untouched. In steady state almost every count here is a
   * correct row being offered a no-op, so read it as reconciler REACH, never as
   * damage found. Named `...Offered` rather than `...Repaired` for exactly that
   * reason.
   */
  workProductsOffered: number;
  /**
   * PEN-6733: merged pull-request nodes the enumeration had to skip.
   *
   * NOT "nodes this token could not resolve" (PEN-6742 item 2). A node the
   * API refuses comes back as a non-empty `errors` array, which
   * `ghGraphQlQuery` reports as `ok: false` and the page loop turns into a
   * throw ABOVE this counter -- so a permission or `NOT_FOUND` failure fails
   * the whole page and is never counted here. What this counts is the
   * narrower thing that survives to the node loop: a node typed
   * `PullRequest` whose `number` is missing or not an integer, the one field
   * the row reader requires.
   *
   * Read this WITH `workProductsOffered`, never instead of it. Alone,
   * `workProductsOffered: 0` spans two opposite states and nothing on this
   * rollup separates them:
   *
   *   `{workProductsOffered: 0, unreadableNodes: 0}`   a clean estate
   *   `{workProductsOffered: 0, unreadableNodes: 912}` a sweep that read nothing
   *
   * The second is how the work-product repair ran for a full deployment and
   * produced nothing with no surface reporting it.
   */
  unreadableNodes: number;
  /**
   * PEN-6733: this repo's enumeration stopped before the window was exhausted,
   * so `enumerated` is a PREFIX rather than a count.
   *
   * Three paths reach it: a page that yielded no usable pull-request row
   * while the server said another page exists, a `hasNextPage` with no
   * cursor, and the page cap. Before this field each of them simply returned,
   * so a coverage percentage computed from `enumerated` was an OVERSTATEMENT
   * presented as a measurement.
   *
   * Do not read the LOG as the signal -- this flag is the signal. The
   * no-cursor and page-cap paths each warn, but the first path warns only
   * through the per-page unreadable-node WARN, which does not fire when the
   * page simply carried no pull-request nodes at all. That case needs
   * `is:pr` to be absent from the query to be reachable, so it is a hole in
   * the logging rather than a live gap -- but it is why the three paths are
   * not interchangeable in the log, and why the caller is told in the RETURN
   * VALUE instead.
   */
  enumerationTruncated: boolean;
}

/**
 * The summed rollup over every target (PEN-6733).
 *
 * Split from {@link ReconcileResult} rather than reusing it, because the two
 * disagree on exactly one field and reusing the name would force a per-repo
 * BOOLEAN to stand in for a COUNT. `enumerationTruncated` answers "is this
 * repo's number a prefix?"; summed over targets the useful question is "HOW
 * MANY of these numbers are prefixes?", which a boolean cannot carry and an
 * `||` across targets would silently flatten to "at least one".
 */
export interface SweepTotals {
  enumerated: number;
  linked: number;
  unlinked: number;
  enriched: number;
  workProductsOffered: number;
  unreadableNodes: number;
  /** Targets whose `enumerated` is a prefix. See `ReconcileResult.enumerationTruncated`. */
  truncatedTargets: number;
}

export interface SweepResult {
  targets: number;
  ok: number;
  failed: number;
  totals: SweepTotals;
  window: { since: Date; until: Date };
}

/** Trailing [now - windowDays, now] window. Derived from config, no magic floor. */
export function computeReconcilerWindow(now: Date, windowDays: number): { since: Date; until: Date } {
  return {
    since: new Date(now.getTime() - windowDays * MS_PER_DAY),
    until: now,
  };
}

/**
 * Discover the (company, repo) pairs to reconcile from rows we've already
 * forward-captured. Bootstrap source — a repo with zero forward-captured PRs is
 * not yet discovered (acceptable: the first matched PR seeds it, the reconciler
 * then backfills the tail). A complete source would enumerate GitHub App
 * installation repos; deferred until that limitation bites.
 */
export async function selectReconcilerTargets(db: Db): Promise<ReconcilerTarget[]> {
  const rows = await db
    .selectDistinct({
      companyId: issuePullRequests.companyId,
      repoFullName: issuePullRequests.repoFullName,
    })
    .from(issuePullRequests);
  return rows.map((r) => ({ companyId: r.companyId, repoFullName: r.repoFullName }));
}

type ReconcileFn = (
  target: ReconcilerTarget,
  window: { since: Date; until: Date },
) => Promise<ReconcileResult>;

/**
 * Pure orchestration: reconcile every target over one window. A single repo
 * throwing (rate limit, 404 on a private repo without a token) is isolated —
 * it increments `failed` and the sweep continues, so one bad repo never starves
 * the rest.
 */
export async function runReconcilerSweep(input: {
  targets: ReconcilerTarget[];
  now: Date;
  windowDays: number;
  reconcile: ReconcileFn;
  onError?: (target: ReconcilerTarget, err: unknown) => void;
}): Promise<SweepResult> {
  const window = computeReconcilerWindow(input.now, input.windowDays);
  const totals: SweepTotals = {
    enumerated: 0,
    linked: 0,
    unlinked: 0,
    enriched: 0,
    workProductsOffered: 0,
    unreadableNodes: 0,
    truncatedTargets: 0,
  };
  let ok = 0;
  let failed = 0;

  for (const target of input.targets) {
    try {
      const r = await input.reconcile(target, window);
      totals.enumerated += r.enumerated;
      totals.linked += r.linked;
      totals.unlinked += r.unlinked;
      totals.enriched += r.enriched;
      totals.workProductsOffered += r.workProductsOffered;
      totals.unreadableNodes += r.unreadableNodes;
      if (r.enumerationTruncated) totals.truncatedTargets += 1;
      ok += 1;
    } catch (err) {
      failed += 1;
      input.onError?.(target, err);
    }
  }

  return { targets: input.targets.length, ok, failed, totals, window };
}

/** One reconciler pass: discover targets, sweep them, log the rollup. */
export async function reconcilerSweepTick(
  db: Db,
  input: {
    windowDays: number;
    token: string | null;
    enrichLoc: boolean;
    now?: Date;
    logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  },
): Promise<SweepResult> {
  const log = input.logger ?? defaultLogger;
  const now = input.now ?? new Date();
  const targets = await selectReconcilerTargets(db);

  if (targets.length === 0) {
    log.info({ targets: 0 }, "pr-reconciler: no merged-PR repos discovered yet; nothing to reconcile");
    return {
      targets: 0,
      ok: 0,
      failed: 0,
      totals: {
        enumerated: 0,
        linked: 0,
        unlinked: 0,
        enriched: 0,
        workProductsOffered: 0,
        unreadableNodes: 0,
        truncatedTargets: 0,
      },
      window: computeReconcilerWindow(now, input.windowDays),
    };
  }

  const result = await runReconcilerSweep({
    targets,
    now,
    windowDays: input.windowDays,
    reconcile: (target, window) =>
      reconcileMergedPullRequests(db, {
        companyId: target.companyId,
        repoFullName: target.repoFullName,
        since: window.since,
        until: window.until,
        token: input.token,
        enrichLoc: input.enrichLoc,
      }),
    onError: (target, err) =>
      log.warn({ err, ...target }, "pr-reconciler: repo reconcile failed (isolated)"),
  });

  log.info(
    {
      targets: result.targets,
      ok: result.ok,
      failed: result.failed,
      ...result.totals,
      windowDays: input.windowDays,
    },
    "pr-reconciler: sweep complete",
  );
  return result;
}

/**
 * How this sweep authenticates to GitHub (PEN-6413).
 *
 * The reconciler enumerates merged PRs in PRIVATE repos, so it needs a token;
 * unauthenticated it 404s on every target and reports them all as `failed`.
 *
 * It originally read `GITHUB_TOKEN`/`GH_TOKEN` and skipped itself when neither
 * was set. Neither is set in this deployment and never has been: the fleet
 * convention is the App credentials (`GITHUB_APP_ID` /
 * `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY`), which the webhook,
 * the review gate and the rate-limit sampler all already use. So the whole
 * subsystem logged one WARN at boot and did nothing, measured first-party on
 * `paperclip-0` at 2026-11-14T14:39:13Z: "Merged-PR reconciler enabled but no
 * GITHUB_TOKEN/GH_TOKEN set ... Skipping reconciler."
 *
 * That made #3658's work-product repair INERT -- the repair shipped into a
 * caller that is never invoked, which is invisible from the fix's own side
 * because the code is present, correct and deployed.
 *
 * Two properties are load-bearing:
 *
 *  - An explicit `GITHUB_TOKEN`/`GH_TOKEN` still WINS. A deployment that pins a
 *    PAT keeps its behaviour exactly; this only adds a fallback.
 *  - Resolution is PER TICK, never once at startup. An installation token
 *    expires in ~1h while the sweep interval defaults to 6h, so a token
 *    resolved at boot is already dead when the second tick fires. Resolving
 *    once would have worked on the startup pass and then failed silently
 *    forever -- the hardest shape to notice, because the first observation is
 *    the one that succeeds.
 */
export type ReconcilerTokenResolution =
  | { ok: true; token: string; source: "env" | "github_app" }
  | { ok: false; reason: "no_credentials" | "github_app_token_unavailable" };

export async function resolveReconcilerToken(deps: {
  envToken: string | null;
  appCredentialsConfigured: () => boolean;
  getInstallationToken: () => Promise<string | null>;
}): Promise<ReconcilerTokenResolution> {
  if (deps.envToken) return { ok: true, token: deps.envToken, source: "env" };
  if (!deps.appCredentialsConfigured()) return { ok: false, reason: "no_credentials" };
  const token = await deps.getInstallationToken();
  if (!token) return { ok: false, reason: "github_app_token_unavailable" };
  return { ok: true, token, source: "github_app" };
}

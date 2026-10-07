/**
 * Measure the DELIVERY gap — how far production has fallen behind `master` —
 * so the stuck-approval critical can carry it (PEN-3744).
 *
 * WHY THIS EXISTS
 * ---------------
 * Two alerts watch this lane and they measure DIFFERENT obligations:
 *
 *   ProductionDeployApprovalStuck        critical, pushed by this workflow
 *     how long THIS approval has been pending.
 *   PaperclipApiProductionDeployStalled  warning, Prometheus rule in onprem-k8s
 *     how long production has been UNDEPLOYED.
 *
 * Alertmanager inhibits the second with the first (onprem-k8s BLO-37835), which
 * is the right call for the reason recorded there — without it the pair files
 * two Paperclip issues for one gate. But inhibition is keyed on SEVERITY, and
 * these two are not twins, so the delivery gap stopped reaching the
 * notification surface at all. Measured 2026-10-04 (PEN-3744): the warning read
 * `suppressed` with `silencedBy: []` — nobody muted it — continuously since
 * 2026-09-27T15:05:47Z, while the surviving critical said "awaiting human
 * approval for 27.8h" and production sat 612 commits / 12.5 days behind. An
 * operator reading Slack could see the 27.8h and could not see the 12.5 days.
 *
 * The fix is NOT to drop the inhibition — that reintroduces the double-ticket
 * BLO-37835 measured, and the warning reaches only the paperclip webhook
 * anyway, which is the leg PEN-2918 measured at zero human action. The fix is
 * to fold the delivery gap into the alert that IS delivered. See
 * `buildAlert` in post-pending-deploy-alert.mjs for where it lands.
 *
 * WHY THE GAP IS DERIVED FROM ACTIONS HISTORY RATHER THAN READ FROM PROMETHEUS
 * ---------------------------------------------------------------------------
 * `paperclip_api_deploy_commits_behind` already carries this number, and
 * Prometheus sits in the same namespace as the Alertmanager this workflow
 * already posts to. It is still the wrong source here: it would add a second
 * cluster-network dependency to the one path that must keep working when the
 * cluster is the thing that is broken, and it cannot be exercised by a unit
 * test. The Actions API is already reachable, already authenticated with the
 * `actions: read` this workflow holds, and is the dispatcher's OWN definition
 * of "last deployed" — guard (2) of scheduled-production-deploy.yml scans the
 * same runs for the same deploy-JOB conclusion.
 *
 * That definition agrees with the exporter exactly. Measured 2026-10-04T05:17Z:
 * this scan returned `f06c717a6b1d3d1cbaca3a2708c21adf81fd7bba`, which is the
 * live `paperclip_api_deploy_info{deployed_commit=...}` label verbatim, and
 * `GET /compare/f06c717a...master` returned `ahead_by: 612` against an exporter
 * reading of 612. Two independent instruments, no discrepancy.
 *
 * WHY GUARD (2) CANNOT JUST BE REUSED
 * -----------------------------------
 * It sits BELOW guard (1) in the dispatch step, and guard (1) is what exits
 * with `skipped-pending` — the outcome that arms this escalation. So in the one
 * case where the gap matters, the dispatcher never computes it. Hoisting the
 * scan would move a guard whose ORDER is pinned by
 * tests/scheduled-production-deploy-schedule.test.mjs for an unrelated reason
 * (BLO-33400). Computing it here instead touches no guard ordering.
 *
 * DIRECTION OF ERROR, stated deliberately
 * ---------------------------------------
 * Every uncertainty resolves toward reporting a LARGER gap, matching the
 * convention in deploy-stall-chain.mjs: the defect being fixed is
 * under-reporting, and an over-stated gap is a visible, self-correcting number
 * in an alert, while an under-stated one is the silence PEN-2848 exists to
 * prevent. Concretely — if a green deploy run shipped a stale sha (it can: see
 * `a green deploy run can ship a stale sha`), `ahead_by` against its head
 * OVERSTATES what production is missing, never understates it.
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * Nothing in this module may stop the escalation. The alert is the thing that
 * reaches a human; the gap is an enrichment of it. `resolveDeliveryGap` catches
 * everything and returns a reason string, and the caller falls back to the
 * pre-PEN-3744 wording — so the worst case is today's behaviour, not silence.
 */
import { DEPLOY_WORKFLOW_FILE } from './deploy-stall-record.mjs';

/**
 * GitHub caps `per_page` at 100, so any depth beyond that must be paged for.
 * Passing a larger `per_page` is silently clamped, not rejected — which is how
 * a "deeper scan" can look configured and not be.
 */
export const DEPLOY_SCAN_PAGE_SIZE = 100;

/**
 * How many runs back to look for a shipped deploy.
 *
 * DELIBERATELY DECOUPLED FROM GUARD (2)'s `--limit 20`, which this used to
 * mirror. The two scans ask different questions and the depth that serves one
 * is wrong for the other:
 *
 *   guard (2)            "has anything EVER deployed?"  — a yes/no that any
 *                        non-empty window answers; 20 is ample.
 *   findLastSuccessfulDeploy
 *                        "how far behind are we?"       — needs to reach PAST
 *                        the stall to find the last real deploy.
 *
 * The stall consumes the window, and that is the defect this depth fixes
 * (PEN-3744, Ally review of #2225). Every day a stall persists, the dispatcher
 * adds one `workflow_dispatch` run that concludes `success` with `deploy`
 * SKIPPED. Measured 2026-10-04 at 13 days of stall: the last real deploy
 * (`f06c717a`, run 35623928344) sat at position 6, behind 5 skipped-deploy runs
 * dated 09-27 through 10-01 — one per day. At ~1 run/day a 20-run window is
 * exhausted at ~20 days of stall, at which point this returns `null` and the
 * alert degrades to its pre-PEN-3744 wording — precisely as the gap becomes
 * most worth reporting.
 *
 * Scanning deeper can only improve that answer; it cannot make guard (2)'s
 * answer wrong, because finding a deploy further back still means one exists.
 * The divergence is safe in one direction only, which is why it is recorded
 * here rather than left to look like drift.
 *
 * 300 runs tolerates ~300 days of daily skipped dispatches, ~23x the worst
 * stall yet observed. Cost is bounded and scales with the stall, not with this
 * number: finding a deploy D positions back costs D+1 job probes, so a healthy
 * lane pays ~1 and only a genuinely never-deployed history pays the full 300.
 */
export const DEFAULT_DEPLOY_SCAN_LIMIT = 300;

/**
 * The newest `workflow_dispatch` run of the deploy workflow whose `deploy` JOB
 * concluded `success`.
 *
 * Run conclusion is NOT enough and the distinction is the whole point: a run
 * can conclude `success` with `deploy` skipped — by the pending guard, or by
 * never being approved — so filtering on the run alone reports a deploy that
 * never shipped. This is guard (2)'s reasoning, kept verbatim so the two
 * answers cannot drift apart.
 *
 * @returns {Promise<{databaseId:number, headSha:string, url:string, landedAt:string}|null>}
 */
export async function findLastSuccessfulDeploy({
  client,
  workflowFile = DEPLOY_WORKFLOW_FILE,
  scanLimit = DEFAULT_DEPLOY_SCAN_LIMIT,
}) {
  const runs = [];
  // Page until we hold `scanLimit` runs or the API runs out. A short page means
  // the history ended; stopping there keeps the scan at one list call while the
  // dispatch history still FITS one page. That is a property of history length,
  // not of lane health: measured 2026-10-06, docker.yml has 81 successful
  // `workflow_dispatch` runs, so page 1 is short and this costs one call no
  // matter how stalled the lane is. Once that history crosses
  // `DEPLOY_SCAN_PAGE_SIZE` — at ~1 dispatch/day, a few weeks out — the loop
  // fills to `scanLimit` before probing anything and pays three list calls on
  // every invocation, healthy or not. The cost that tracks the stall is the
  // job-probe count at `:113`; this one tracks the calendar.
  //
  // `per_page` is HELD CONSTANT across pages, and that is load-bearing rather
  // than tidy. GitHub's offset is `(page - 1) * per_page`, so shrinking
  // `per_page` on a final page moves the offset BACKWARDS and re-fetches runs
  // already held: measured on this repo's own docker.yml history, page 2 at
  // `per_page=50` begins at index 50 of the `per_page=100` page 1, not index
  // 100. Narrowing the last request to "not overshoot scanLimit" therefore
  // bought duplicates and scanned SHALLOWER than it claimed — for a scanLimit
  // of 150, runs 101-150 were never read at all. That is precisely the
  // stops-short-of-the-deploy failure this scan depth exists to prevent, so the
  // overshoot is trimmed locally below instead, where it costs nothing.
  for (let page = 1; runs.length < scanLimit; page += 1) {
    const path =
      `/actions/workflows/${encodeURIComponent(workflowFile)}/runs` +
      `?event=workflow_dispatch&status=success&per_page=${DEPLOY_SCAN_PAGE_SIZE}&page=${page}`;
    const body = await client.request('GET', path);
    const batch = body?.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < DEPLOY_SCAN_PAGE_SIZE) break;
  }

  // Sort explicitly rather than trusting list order. The API returns newest
  // `created_at` first today, but nothing in the contract says so, and an
  // ordering change would silently pick an OLDER deploy — which overstates the
  // gap, i.e. fails in the safe direction but for an invisible reason. Sorting
  // AFTER accumulating every page keeps that guarantee global: a per-page sort
  // would still trust the API to have paged in order.
  runs.sort((a, b) => Date.parse(b?.created_at ?? 0) - Date.parse(a?.created_at ?? 0));

  // Trim the over-fetch AFTER the sort, not before it. Paging can overshoot by
  // at most one page, and discarding the tail in API order would hand back the
  // guarantee the sort above just bought: if list order ever changes, the run
  // trimmed off might be the NEWEST one. Cutting the sorted tail keeps this
  // "the newest `scanLimit` runs" by date whatever order they arrived in.
  if (runs.length > scanLimit) runs.length = scanLimit;

  for (const run of runs) {
    if (!run?.id || !run?.head_sha) continue;
    const jobs = await client.request('GET', `/actions/runs/${run.id}/jobs?per_page=100`);
    // Exact match, and it is load-bearing: if `deploy` ever gains a matrix the
    // job names become `deploy (...)` and this silently finds nothing, taking
    // the fail-open branch. Guard (2) of scheduled-production-deploy.yml makes
    // the identical assumption, so the two stay consistent — but the coupling
    // is to the JOB NAME, not to either scan's depth. Widen both together.
    const shipped = (jobs?.jobs ?? []).some(
      (job) => job?.name === 'deploy' && job?.conclusion === 'success',
    );
    if (!shipped) continue;
    return {
      databaseId: run.id,
      headSha: run.head_sha,
      url: run.html_url ?? '',
      // `updated_at` is the run's last transition, which for a terminal run is
      // when it finished. This dates the DEPLOY EVENT, not the commit — the
      // commit can be much older than the deploy that shipped it, and the
      // warning alert this is standing in for measures deploy events.
      landedAt: run.updated_at ?? run.created_at ?? '',
    };
  }
  return null;
}

/**
 * How far `baseRef` has run ahead of the deployed commit.
 *
 * `ahead_by` on `/compare/base...head` is the count of commits reachable from
 * head and not from base — commits that exist and are not in production. That
 * is the same quantity `paperclip_api_deploy_commits_behind` exports.
 */
export async function measureDeliveryGap({ client, deployedSha, baseRef = 'master' }) {
  const body = await client.request(
    'GET',
    `/compare/${encodeURIComponent(deployedSha)}...${encodeURIComponent(baseRef)}`,
  );
  const commitsBehind = body?.ahead_by;
  if (!Number.isFinite(commitsBehind)) {
    throw new Error(`/compare returned no usable ahead_by (status=${body?.status ?? 'unknown'})`);
  }
  return {
    commitsBehind,
    compareStatus: body?.status ?? 'unknown',
    deployedCommitAt: body?.base_commit?.commit?.committer?.date ?? null,
  };
}

/**
 * Whole-number-ish days, one decimal. Hours would be unreadable at this scale
 * (300h) and a bare commit count hides a week-long stall behind a quiet repo.
 */
export function gapDays(landedAt, now) {
  const landedMs = Date.parse(landedAt ?? '');
  if (!Number.isFinite(landedMs)) return null;
  return (now.getTime() - landedMs) / 86_400_000;
}

/**
 * The phrase that leads the Slack summary. Kept short on purpose: the relay
 * forwards `summary` whole but caps the description's first paragraph at 400
 * characters (onprem-k8s monitoring/alertmanager-slack-relay.yaml), so every
 * character here competes with the approval age for the same line.
 */
export function formatDeliveryGap(gap) {
  if (!gap) return null;
  const days = Number.isFinite(gap.days) ? `${gap.days.toFixed(1)}d` : null;
  return days ? `${gap.commitsBehind} commits / ${days}` : `${gap.commitsBehind} commits`;
}

/**
 * Fail-open resolver. Returns `{ gap, reason }` where exactly one is non-null.
 *
 * `reason` is surfaced on the alert as an annotation rather than being
 * swallowed: an enrichment that silently stops working is how the next reader
 * concludes the gap is small when it is merely unmeasured.
 */
export async function resolveDeliveryGap({
  client,
  baseRef = 'master',
  now = new Date(),
  workflowFile = DEPLOY_WORKFLOW_FILE,
  scanLimit = DEFAULT_DEPLOY_SCAN_LIMIT,
}) {
  try {
    const last = await findLastSuccessfulDeploy({ client, workflowFile, scanLimit });
    if (!last) {
      return {
        gap: null,
        reason: `no deploy job concluded success in the last ${scanLimit} dispatch runs`,
      };
    }
    const measured = await measureDeliveryGap({ client, deployedSha: last.headSha, baseRef });
    return {
      gap: {
        ...measured,
        deployedSha: last.headSha,
        landedAt: last.landedAt,
        deployRunUrl: last.url,
        days: gapDays(last.landedAt, now),
      },
      reason: null,
    };
  } catch (err) {
    return { gap: null, reason: `lookup failed: ${err.message}` };
  }
}

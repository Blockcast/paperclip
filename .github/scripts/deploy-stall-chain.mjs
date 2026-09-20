/**
 * Derive how long production has ACTUALLY been waiting on a human approval,
 * across supersedes (PEN-3315 follow-up).
 *
 * Why this exists at all
 * ----------------------
 * `supersede-stale-deploy.mjs` cancels a stale pending deploy and dispatches a
 * fresh one at `master`. That is the fix PEN-3315 shipped, and it works — but it
 * resets the pending run's `createdAt` to now. Ageing the escalation off the run
 * alone therefore turns one continuous 46h stall into a train of 6.0h ones, and
 * the dispatcher goes green for ~5 of every 6 hourly slots while production sits
 * unshipped. Measured live on 2026-09-18: a genuine stall running since
 * 09-17T02:01:24Z reported `3.0h old, under the 6h threshold — not escalating`
 * while `paperclip_api_deploy_commits_behind` read 107.
 *
 * PEN-3315 solved this with a durable GitHub issue carrying the stall clock.
 * That channel is structurally unavailable here: `Blockcast/paperclip` has
 * `has_issues: false`, so `POST /issues` returns
 * `410 Issues has been disabled in this repository` on every escalation and no
 * token scope can change that. The permission reasoning was right; the feature
 * is switched off on the repository.
 *
 * So derive the clock instead of storing it. A supersede leaves a distinctive,
 * durable trace in the Actions run history — which is already retained 90 days
 * and readable with the `actions: read` this workflow holds:
 *
 *     run C: workflow_dispatch, conclusion=cancelled, head H_c
 *     run W: workflow_dispatch, status=waiting,       head H_w
 *     W.createdAt - C.cancelledAt <= CHAIN_WINDOW_MINUTES   (we cancel, then
 *                                                            dispatch, in one
 *                                                            script run)
 *     H_c is a strict ancestor of H_w                       (a forward replace)
 *
 * When that holds, W inherited C's stall, so the clock starts at C's
 * `createdAt`. Walk it backwards to find the true start. No artifact, no new
 * credential, no dead channel to warn about hourly.
 *
 * Direction of error, stated deliberately
 * ---------------------------------------
 * Every uncertainty here resolves toward reporting a LONGER stall, because the
 * defect being fixed is under-reporting and a silent green lane is the failure
 * PEN-2848 exists to prevent. The clock this returns is only ever fed to
 * `resolveStallStartedAt`, which takes the EARLIEST of its candidates, so a
 * wrong answer here can move the age basis earlier but never later — it cannot
 * mask a stall, only over-state one. An over-stated stall is a red dispatcher
 * run naming the run it aged from, which is visible and self-correcting; an
 * under-stated one is invisible.
 */

/**
 * Our own supersede cancels and then dispatches inside a single script run,
 * polling at most 8 x 3s for the cancel to land — so the real gap is seconds.
 * Five minutes is slack for API latency and runner scheduling, and is still far
 * tighter than the alternative shapes it must exclude: a human cancelling a
 * deploy they decided not to ship, followed by the NEXT hourly dispatcher slot
 * picking the lane up minutes-to-an-hour later. Widening this is how a
 * deliberate human cancel starts being read as a supersede.
 */
export const CHAIN_WINDOW_MINUTES = 5;

/**
 * A stall long enough to need 12 supersedes is >72h at the 6h threshold, which
 * is far past the point where the age's exact value changes any decision. The
 * cap exists so a pathological history cannot turn this into an unbounded walk
 * issuing an ancestry call per link.
 */
export const MAX_CHAIN_LINKS = 12;

/**
 * Walk the supersede chain backwards from the currently-waiting run.
 *
 * Pure apart from `isAncestor`, which is injected so the whole walk is testable
 * without the network.
 *
 * @param {object}   args
 * @param {object}   args.oldestWaitingRun  `{ databaseId, createdAt, headSha }`
 * @param {object[]} args.cancelledRuns     candidate predecessors, each
 *                                          `{ databaseId, createdAt, cancelledAt, headSha }`
 * @param {(baseSha: string, headSha: string) => Promise<boolean|null>} args.isAncestor
 *        `true` = base is a strict ancestor of head (a forward replace),
 *        `false` = definitively not, `null` = could not determine.
 * @returns {Promise<{stallStartedAt: string|null, links: object[], stoppedBecause: string}>}
 */
export async function deriveStallStartFromSupersedeChain({
  oldestWaitingRun,
  cancelledRuns,
  isAncestor,
  windowMinutes = CHAIN_WINDOW_MINUTES,
  maxLinks = MAX_CHAIN_LINKS,
}) {
  const links = [];
  if (!oldestWaitingRun || !Number.isFinite(Date.parse(oldestWaitingRun.createdAt))) {
    return { stallStartedAt: null, links, stoppedBecause: 'no-waiting-run' };
  }

  const windowMs = windowMinutes * 60_000;
  const pool = (cancelledRuns ?? []).filter(
    (run) =>
      run &&
      Number.isFinite(Date.parse(run.createdAt)) &&
      Number.isFinite(Date.parse(run.cancelledAt)),
  );

  const consumed = new Set();
  let current = oldestWaitingRun;
  let stoppedBecause = 'chain-exhausted';

  for (let depth = 0; depth < maxLinks; depth += 1) {
    const currentCreatedMs = Date.parse(current.createdAt);

    // A predecessor must have been cancelled at or before this run was created,
    // and within the window. Prefer the CLOSEST such cancel: with several in the
    // window, the one we dispatched against is the last one before us.
    const candidates = pool
      .filter((run) => !consumed.has(run.databaseId))
      .filter((run) => {
        const cancelledMs = Date.parse(run.cancelledAt);
        const gap = currentCreatedMs - cancelledMs;
        return gap >= 0 && gap <= windowMs;
      })
      .sort((a, b) => Date.parse(b.cancelledAt) - Date.parse(a.cancelledAt));

    // The ancestry test is what separates a forward supersede from every other
    // reason a dispatch might have been cancelled near a new one. `null` (the
    // compare call failed) chains anyway and records that it was unverified:
    // refusing the link on a transient API error would reintroduce the exact
    // under-report this module exists to fix, whereas chaining on a
    // time-proximate but unverified link can only over-state the age.
    //
    // A definitive `false` rejects only THAT CANDIDATE, never the walk. The
    // sort above anticipates several cancels in one window, and this workflow
    // has produced exactly that (`scheduled-production-deploy.yml`: "two
    // dispatches 28min apart", 2026-08-30). If a duplicate dispatch at the same
    // master sha is cancelled a few seconds nearer to us than the real
    // supersede, `identical` resolves to `false` — and abandoning the walk
    // there would report a 46h stall as 3h on a green dispatcher, which is the
    // one direction this module must never fail in (see "Direction of error").
    // So try the next-closest instead. Termination is unchanged: every
    // candidate is `consumed` before it is tested, so the window strictly
    // empties.
    let predecessor = null;
    let predecessorAncestry = null;
    let rejectedForAncestry = false;

    for (const candidate of candidates) {
      consumed.add(candidate.databaseId);

      let ancestry = null;
      try {
        ancestry = await isAncestor(candidate.headSha, current.headSha);
      } catch {
        ancestry = null;
      }

      if (ancestry === false) {
        rejectedForAncestry = true;
        continue;
      }

      predecessor = candidate;
      predecessorAncestry = ancestry;
      break;
    }

    if (!predecessor) {
      // An exhausted window still distinguishes its two causes: nothing was in
      // range at all, versus everything in range was tested and refused.
      if (rejectedForAncestry) {
        stoppedBecause = 'not-a-forward-replace';
      } else {
        stoppedBecause = depth === 0 ? 'no-supersede-found' : 'chain-complete';
      }
      break;
    }

    links.push({
      cancelledRunId: predecessor.databaseId,
      cancelledAt: predecessor.cancelledAt,
      createdAt: predecessor.createdAt,
      headSha: predecessor.headSha,
      replacedRunId: current.databaseId,
      ancestryVerified: predecessorAncestry === true,
    });

    current = predecessor;

    if (links.length >= maxLinks) {
      stoppedBecause = 'max-links';
      break;
    }
  }

  if (links.length === 0) {
    return { stallStartedAt: null, links, stoppedBecause };
  }

  // `current` is now the earliest run in the chain, so its creation is when the
  // lane first went pending.
  return {
    stallStartedAt: new Date(Date.parse(current.createdAt)).toISOString(),
    links,
    stoppedBecause: links.length >= maxLinks ? 'max-links' : stoppedBecause,
  };
}

/**
 * Normalise an Actions API run object into the shape the walk consumes.
 *
 * `cancelledAt` uses `updated_at`, the last write to the run row. For a run
 * whose conclusion is `cancelled` that write IS the cancellation, so it is the
 * closest thing the API offers to a cancel timestamp — `run_started_at` is when
 * it began waiting, not when it stopped.
 */
export function normaliseDispatchRun(run) {
  if (!run) return null;
  return {
    databaseId: run.id,
    createdAt: run.created_at,
    cancelledAt: run.updated_at,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
  };
}

/**
 * Fetch the recent `workflow_dispatch` runs of the deploy workflow that were
 * cancelled, newest first.
 *
 * Deliberately scoped to `event=workflow_dispatch`: `docker.yml` also runs on
 * `push`, and a cancelled push build has nothing to do with the reviewer gate.
 */
export async function fetchCancelledDispatchRuns({
  client,
  workflowFile = 'docker.yml',
  perPage = 50,
}) {
  const path =
    `/actions/workflows/${encodeURIComponent(workflowFile)}/runs` +
    `?event=workflow_dispatch&status=cancelled&per_page=${perPage}`;
  const body = await client.request('GET', path);
  return (body?.workflow_runs ?? []).map(normaliseDispatchRun).filter(Boolean);
}

/**
 * `true` when `baseSha` is a strict ancestor of `headSha`.
 *
 * `GET /compare/base...head` reports `ahead` when head is strictly ahead of
 * base, which is exactly a forward replace. `identical` is explicitly NOT a
 * supersede — it is the same commit re-dispatched — and `behind` / `diverged`
 * mean the replacement did not move forward, so both return `false`. This
 * mirrors the admission `supersede-stale-deploy.mjs` uses to decide whether a
 * pending run is stale in the first place, so the two cannot disagree about
 * what "stale" means.
 */
export function createAncestryProbe({ client }) {
  const cache = new Map();
  return async function isAncestor(baseSha, headSha) {
    if (!baseSha || !headSha) return null;
    if (baseSha === headSha) return false;
    const key = `${baseSha}...${headSha}`;
    if (cache.has(key)) return cache.get(key);

    let verdict = null;
    try {
      const body = await client.request('GET', `/compare/${baseSha}...${headSha}`);
      const status = body?.status;
      if (status === 'ahead') verdict = true;
      else if (status === 'identical' || status === 'behind' || status === 'diverged')
        verdict = false;
      else verdict = null;
    } catch {
      verdict = null;
    }

    cache.set(key, verdict);
    return verdict;
  };
}

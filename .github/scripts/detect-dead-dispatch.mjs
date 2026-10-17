/**
 * Did the deploy lane's last dispatch actually make it to the `deploy` job?
 * (PEN-4224)
 *
 * WHY THIS EXISTS
 * ---------------
 * `scheduled-production-deploy.yml` dispatches `docker.yml` once a day and,
 * until this module, never looked at what the dispatched run DID. A run that
 * dies in front of `deploy` consumes the day's slot exactly as a run that
 * deployed, and nothing retried, escalated, or reported it as abnormal.
 *
 * Measured 2026-10-17: dispatcher slot 39013968190 reported `dispatched` at
 * 07:31:45Z; the run it dispatched (39014044238) failed `build-and-push` in 84s
 * on `failed to solve: frontend grpc server closed unexpectedly`, with
 * `guard-pending-deploy-final` and `deploy` both SKIPPED. The builder recovered
 * unaided 37 minutes later (run 39016413187, `build-and-push` success), so one
 * retry would very likely have cleared it. Two hours on, with production 64
 * commits behind, the 09:30Z sampling slot reported `checked-no-pending` —
 * GREEN, and literally true, because a run that DIED leaves nothing PENDING to
 * age. Guard (1b) measures the reviewer gate's OCCUPANCY; "nothing is waiting"
 * reads identically whether a human cleared the lane or the dispatched run
 * never got far enough to enter it.
 *
 * Every prior hardening of that file was against a dispatch that lasted TOO
 * LONG — PEN-2848/BLO-33400 (a slot that skipped because something was already
 * waiting), PEN-3315 (a `waiting` dispatch that held the lane 41.2h, which
 * `supersede-stale-deploy.mjs` now bounds), BLO-25050 (that supersede's
 * threshold). `supersede-stale-deploy.mjs` acts on runs that are still
 * `waiting`; a run that reached a terminal `failure` in 84s is invisible to it.
 * Dying too fast was an unhandled shape, not a handled one that misfired.
 *
 * WHAT THIS DOES, AND DELIBERATELY DOES NOT DO
 * --------------------------------------------
 * It OBSERVES and REPORTS. It dispatches nothing, cancels nothing, and
 * approves nothing — it holds no write path of any kind, and
 * `tests/detect-dead-dispatch.test.mjs` pins that this file contains no
 * mutating request at all. The 2026-08-28 rejection of auto-approval is
 * untouched, and guard (1)'s anti-stacking property is untouched because
 * nothing here can produce a second dispatch.
 *
 * A manual lever already exists and always did: `IS_DISPATCH_SLOT` is
 * `github.event_name != 'schedule' || github.event.schedule == '23 7 * * *'`,
 * whose LEFT arm is true for every non-schedule event, so a `workflow_dispatch`
 * of the dispatcher dispatches at any hour. (Observed: an off-cadence dispatch
 * at 2026-10-16T18:35:53Z produced docker.yml run 38948553579.) ⛔ Do NOT read
 * that expression as a daily cadence — the same `||` has produced three
 * different wrong cadence claims from three readers, and the workflow's own
 * "exactly once daily" log line prints ONLY on the `schedule` branch that never
 * dispatches, so the sentence that would contradict you is on the one code path
 * you are not looking at.
 *
 * The fault was therefore never "no recovery is possible". It was that the day's
 * dispatch could die, a working lever sat right there, and every signal the
 * system emitted said things were fine. This module replaces that false green
 * with a true, specific warning naming the dead run — which is sufficient for a
 * human to pull a lever that already works, and which needs no retry logic, no
 * anti-stacking reasoning, and no new dispatch authority.
 *
 * WHY THE PREDICATE IS THIS NARROW
 * --------------------------------
 * `died before deploy` requires the run to be COMPLETED, its conclusion to be
 * `failure`, and the `deploy` JOB to have not executed (absent or `skipped`).
 * Each conjunct is load-bearing, measured over the 25 most recent
 * `workflow_dispatch` runs of docker.yml (2026-10-05 → 2026-10-17):
 *
 *   10 `failure` runs — 9 had `deploy` RUN and fail, 1 had `deploy` skipped.
 *    4 `cancelled` runs — all 4 had `deploy: cancelled`, build succeeded.
 *   11 `success` runs.
 *
 * So the predicate fires on exactly 1 of 25, and that one is the incident. The
 * nine deploy-job failures are the shape this must NOT claim — a failing
 * migration pre-flight, admission, or `helm upgrade` is a real deploy attempt
 * with its own owner (e.g. PEN-4176), and flagging it here would both duplicate
 * that signal and make this one untrustworthy.
 *
 * `cancelled` is excluded on its own evidence, not merely by the `failure`
 * conjunct: `supersede-stale-deploy.mjs` CANCELS a stale waiting dispatch as its
 * normal, correct operation, and every cancelled run measured above carries
 * `deploy: cancelled`. Treating cancellation as death would turn each successful
 * supersede into a false alarm.
 *
 * DIRECTION OF ERROR, stated deliberately
 * ---------------------------------------
 * Every uncertainty resolves toward SILENCE. An unreadable run, an unreadable
 * job list, an API failure, or a lane whose last deploy cannot be located all
 * yield `unknown`, and `unknown` reports nothing and reddens nothing — the
 * dispatcher behaves exactly as it did before this module existed. That is the
 * opposite convention to deploy-stall-chain.mjs / deploy-delivery-gap.mjs, which
 * resolve toward a LARGER reported gap, and the difference is deliberate: those
 * two annotate an alert a human is already reading, while this one can turn a
 * dispatcher run RED. A false red on this workflow is expensive in a specific
 * way — PEN-2848 made the dispatcher's `conclusion` itself load-bearing, so a
 * red that is not real degrades the one signal a stuck approval has.
 */
import { writeFileSync } from 'node:fs';

import { createGitHubClient, DEPLOY_WORKFLOW_FILE, setOutput } from './deploy-stall-record.mjs';
import { resolveDeliveryGap } from './deploy-delivery-gap.mjs';

/**
 * What the lane's most recent COMPLETED dispatch did.
 *
 * `survived` is "reached the deploy job", NOT "deployed successfully": a
 * `deploy` job that ran and failed is a real deploy attempt, owned by whatever
 * made it fail. This module's whole subject is the runs that never got that far.
 */
export const DISPATCH_FATE = Object.freeze({
  /** The `deploy` job executed — succeeded or failed. Not our business.  */
  SURVIVED: 'survived',
  /** Terminal `failure` with `deploy` never executed. The subject of PEN-4224. */
  DIED_BEFORE_DEPLOY: 'died-before-deploy',
  /** No completed dispatch run in the window, or the window is empty. */
  NONE: 'none',
  /** Anything unreadable. Reports nothing, reddens nothing. */
  UNKNOWN: 'unknown',
});

/**
 * How far back to look for the lane's last COMPLETED dispatch.
 *
 * Deliberately small, and deliberately NOT shared with
 * `DEFAULT_DEPLOY_SCAN_LIMIT` (300) in deploy-delivery-gap.mjs. The two scans
 * ask different questions: that one must reach PAST a stall to find the last
 * real deploy, and gets deeper every day a stall persists. This one asks only
 * "what did the most recent completed dispatch do", which is answered by the
 * first completed run in the list and never needs depth. The window exists
 * solely to step over runs that are still in flight.
 */
export const COMPLETED_SCAN_LIMIT = 20;

/**
 * The `deploy` job's name in docker.yml, matched EXACTLY.
 *
 * Load-bearing, and the coupling is shared: `findLastSuccessfulDeploy` in
 * deploy-delivery-gap.mjs and guard (2) of scheduled-production-deploy.yml make
 * the identical assumption. If `deploy` ever gains a matrix the job names become
 * `deploy (...)`, every one of the three silently finds nothing, and this
 * module's fail-quiet direction turns that into permanent silence rather than a
 * false alarm. Widen all three together.
 */
export const DEPLOY_JOB_NAME = 'deploy';

/**
 * Did this job list show `deploy` actually executing?
 *
 * `skipped` and absent both mean "did not execute". `cancelled` is NOT folded in
 * here: it means the job existed and was stopped, which is what a supersede
 * looks like, and the caller excludes those by run conclusion anyway.
 */
export function deployJobExecuted(jobs) {
  const deploy = (jobs ?? []).find((job) => job?.name === DEPLOY_JOB_NAME);
  if (!deploy) return false;
  return deploy.conclusion !== 'skipped' && deploy.conclusion !== null;
}

/**
 * Classify one run plus its job list. Pure — no I/O, so the table of live run
 * shapes in the test suite can be replayed against it directly.
 *
 * @param {{status?:string, conclusion?:string}} run
 * @param {Array<{name?:string, conclusion?:string}>} jobs
 */
export function classifyDispatchRun(run, jobs) {
  if (!run || run.status !== 'completed') return DISPATCH_FATE.UNKNOWN;
  // A run that reached `deploy` is `survived` whatever the run concluded —
  // including `failure`. That is the PEN-4176 shape (a deploy job that ran and
  // failed its migration pre-flight), and it is explicitly not this module's.
  if (deployJobExecuted(jobs)) return DISPATCH_FATE.SURVIVED;
  if (run.conclusion === 'failure') return DISPATCH_FATE.DIED_BEFORE_DEPLOY;
  // `cancelled` with deploy never executed, or `success` with deploy skipped by
  // the pending guard. Neither is a death this module may claim; both are
  // normal, owned behaviour of the lane.
  return DISPATCH_FATE.SURVIVED;
}

/**
 * The newest COMPLETED `workflow_dispatch` run of the deploy workflow, with its
 * fate.
 *
 * Only the NEWEST completed run is judged, not a window of them. "What did the
 * lane last do" is a statement about the lane's current state; scanning further
 * back would re-report a death that a later dispatch has already superseded.
 * The caller reaches this only after guard (1) has established that nothing is
 * non-terminal, so the newest completed run IS the lane's last word.
 */
export async function findLastCompletedDispatch({
  client,
  workflowFile = DEPLOY_WORKFLOW_FILE,
  scanLimit = COMPLETED_SCAN_LIMIT,
}) {
  const body = await client.request(
    'GET',
    `/actions/workflows/${encodeURIComponent(workflowFile)}/runs` +
      `?event=workflow_dispatch&per_page=${scanLimit}`,
  );
  const runs = [...(body?.workflow_runs ?? [])];
  // Sort rather than trust list order, for the reason recorded in
  // findLastSuccessfulDeploy: the API returns newest-first today and nothing in
  // the contract says so. Here an ordering change would judge an OLDER run,
  // which could resurrect a death already superseded by a later dispatch.
  runs.sort((a, b) => Date.parse(b?.created_at ?? 0) - Date.parse(a?.created_at ?? 0));

  const run = runs.find((candidate) => candidate?.status === 'completed');
  if (!run?.id) return { fate: DISPATCH_FATE.NONE, run: null };

  let jobs = null;
  try {
    const body2 = await client.request('GET', `/actions/runs/${run.id}/jobs?per_page=100`);
    jobs = body2?.jobs ?? [];
  } catch {
    // Unreadable jobs means unreadable fate. Silence, not a guess — a guess here
    // is a red dispatcher run.
    return { fate: DISPATCH_FATE.UNKNOWN, run };
  }

  return {
    fate: classifyDispatchRun(run, jobs),
    run: {
      databaseId: run.id,
      headSha: run.head_sha ?? '',
      url: run.html_url ?? '',
      conclusion: run.conclusion ?? '',
      createdAt: run.created_at ?? '',
      completedAt: run.updated_at ?? '',
    },
  };
}

/**
 * Should this report a dead lane?
 *
 * BOTH conjuncts are required. A dead dispatch with production already AT master
 * owes nothing — the lane is idle, not stalled — and reporting it would redden
 * the dispatcher for a build failure on a commit nobody is waiting to ship.
 * `commitsBehind` must be affirmatively positive: `null` (gap unmeasurable)
 * stays silent, per this module's fail-quiet direction.
 */
export function isDeadLane({ fate, commitsBehind }) {
  if (fate !== DISPATCH_FATE.DIED_BEFORE_DEPLOY) return false;
  return Number.isFinite(commitsBehind) && commitsBehind > 0;
}

/**
 * Read the lane's state. Never throws: every failure path resolves to
 * `UNKNOWN`, which reports nothing.
 */
export async function detectDeadDispatch({
  client,
  workflowFile = DEPLOY_WORKFLOW_FILE,
  baseRef = 'master',
  now = new Date(),
}) {
  let last;
  try {
    last = await findLastCompletedDispatch({ client, workflowFile });
  } catch (err) {
    return {
      fate: DISPATCH_FATE.UNKNOWN,
      run: null,
      gap: null,
      dead: false,
      reason: `lookup failed: ${err.message}`,
    };
  }

  if (last.fate !== DISPATCH_FATE.DIED_BEFORE_DEPLOY) {
    // Nothing else is worth an API call: the gap only ever qualifies a death.
    return { fate: last.fate, run: last.run, gap: null, dead: false, reason: null };
  }

  // resolveDeliveryGap already swallows its own failures into `{gap:null,reason}`
  // — reused rather than re-derived so this module's "is master ahead" and the
  // escalation's "how far behind is production" cannot drift apart. Both answer
  // it from the deploy JOB's conclusion, which is the dispatcher's own
  // definition of "last deployed".
  const { gap, reason } = await resolveDeliveryGap({ client, baseRef, now, workflowFile });
  const commitsBehind = gap?.commitsBehind ?? null;
  return {
    fate: last.fate,
    run: last.run,
    gap,
    dead: isDeadLane({ fate: last.fate, commitsBehind }),
    reason,
  };
}

async function main() {
  const outPath = process.env.DEAD_DISPATCH_JSON_PATH;
  const writeResult = (result) => {
    // Only the FATE is published as a step output. `dead` deliberately is not:
    // it is true on a dispatch slot whose PREVIOUS dispatch died, and that slot
    // goes on to dispatch a replacement — i.e. it recovers. Publishing `dead`
    // here would redden exactly the run that fixed the problem. The workflow
    // writes `dead_dispatch=true` itself, inside the sampling-slot branch, where
    // it is the whole statement being made.
    setOutput('last_dispatch_fate', result.fate);
    if (outPath) {
      // Written unconditionally, including on the failure paths, so the calling
      // shell always has a file to read. A missing file there would have to be
      // handled as a third state on a path whose whole job is to stay quiet.
      writeFileSync(outPath, `${JSON.stringify(result)}\n`);
    }
  };

  let result;
  try {
    result = await detectDeadDispatch({
      client: createGitHubClient(),
      baseRef: process.env.BASE_REF || 'master',
    });
  } catch (err) {
    // Belt and braces: detectDeadDispatch is written not to throw, and if that
    // ever stops being true this must still not redden the dispatcher.
    result = {
      fate: DISPATCH_FATE.UNKNOWN,
      run: null,
      gap: null,
      dead: false,
      reason: String(err?.message ?? err),
    };
  }

  writeResult(result);

  // Plain log, never an annotation. The workflow raises the ::warning:: on the
  // one branch where a dead lane is the final word; raising it here would also
  // mark the dispatch slot that is about to recover from it.
  console.log(
    `Last completed dispatch fate: ${result.fate}` +
      (result.dead ? ` (dead lane: master is ${result.gap?.commitsBehind} commit(s) ahead)` : '') +
      (result.reason ? ` (${result.reason})` : ''),
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Unreachable by construction; still non-fatal. The dispatcher's conclusion
    // is load-bearing (PEN-2848) and must not start meaning "detection failed".
    console.log(`::warning::detect-dead-dispatch failed unexpectedly: ${err?.stack ?? err}`);
  });
}

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
 * THE SECOND SHAPE: A LANE THAT IS SWITCHED OFF (PEN-5261)
 * --------------------------------------------------------
 * The same false green has a second cause, and the original predicate absorbed
 * it as `survived` by construction. Measured 2026-11-03: the 07:23Z slot
 * dispatched correctly, run 41596391238 built and pushed an image, and
 * `guard-pending-deploy`, `guard-pending-deploy-final` and `deploy` were ALL
 * skipped. The run concluded `success`, so the `failure` conjunct above did not
 * fire and the catch-all claimed a survival — while production sat 90 commits
 * behind, 22h past its last rollout, with every signal green.
 *
 * The cause was `vars.PAPERCLIP_CI_DEPLOY` no longer being `'true'`. That
 * variable gates the deploy lane's three jobs at the workflow level, so no
 * dispatch can ship while it is off, and — unlike a death — a replacement
 * dispatch does not recover it. Each one builds an image and skips identically.
 * Reporting it as a death would therefore send a human to a lever that cannot
 * work, which is why it classifies as its own fate and gets its own remedy.
 *
 * It is distinguishable, and distinguishable cheaply: see DEPLOY_GATE_JOB_NAME.
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
  /**
   * Terminal `success` in which the deploy lane's ENTRY GUARD never executed,
   * so `deploy` could not have run whatever the build did. The subject of
   * PEN-5261: the lane is SWITCHED OFF, not broken.
   *
   * Kept distinct from DIED_BEFORE_DEPLOY because the two have opposite
   * remedies, and reporting one as the other sends a human to the wrong lever.
   * A death is transient and a later dispatch recovers it; a gated-off lane
   * recovers from no number of dispatches at all, because every one of them
   * skips the same way.
   */
  LANE_GATED_OFF: 'lane-gated-off',
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
 * The deploy lane's ENTRY GUARD job in docker.yml, matched EXACTLY — same
 * coupling, and the same widening hazard, as DEPLOY_JOB_NAME above.
 *
 * This job is the lane's gate made observable. It carries the SAME
 * workflow-level condition `deploy` carries — the event, the
 * `vars.PAPERCLIP_CI_DEPLOY` switch, and the ref — and, unlike `deploy`, it
 * declares no `needs:`. So nothing upstream can cause it to skip: if it
 * skipped, that shared condition was false, and `deploy` was unreachable from
 * the moment the run started.
 *
 * That is what makes it the discriminator. Both the normal pending-guard skip
 * and a gated-off lane end with `deploy: skipped` on a GREEN run and are
 * indistinguishable by run conclusion; they differ here, and only here.
 */
export const DEPLOY_GATE_JOB_NAME = 'guard-pending-deploy';

/**
 * Was the whole deploy lane gated off before it could start?
 *
 * `skipped` on the entry guard means the shared condition was false. ABSENT is
 * deliberately NOT folded in: an absent guard job is what a renamed job, a
 * matrixed job, or an abbreviated fixture looks like, and claiming a switched-off
 * lane from a job list that simply does not mention the gate would turn this
 * module's one loud report into a guess. Absent stays quiet, which is this
 * module's standing direction everywhere else.
 *
 * `cancelled` is likewise excluded by returning false: a cancelled guard is a
 * supersede stopping the run, and the caller excludes that by run conclusion.
 */
export function deployLaneGatedOff(jobs) {
  const gate = (jobs ?? []).find((job) => job?.name === DEPLOY_GATE_JOB_NAME);
  return gate?.conclusion === 'skipped';
}

/**
 * The `deploy` job conclusions that prove the lane was actually REFILLED.
 *
 * Strictly narrower than `deployJobExecuted` below, and the two must not be
 * conflated — Ally caught exactly that conflation on this PR's first head.
 * `deployJobExecuted` answers the DETECTOR's question ("may I claim this run
 * died?") and is deliberately generous, so it says yes to a `cancelled` deploy
 * job. This answers the CLOSE GATE's question ("did a deploy attempt actually
 * happen?"), which needs proof, so a `cancelled` deploy — a supersede's normal
 * operation — must not count.
 *
 * `failure` DOES count: a `deploy` job that ran and failed is a real deploy
 * attempt, owned by whatever made it fail (the PEN-4176 migration pre-flight is
 * the live example). The stall record models "the gate was emptied and could
 * not be refilled"; a failed deploy refilled it. Whether production SHIPPED is
 * a different question, and `up-to-date` is the outcome that proves that one.
 */
export const DEPLOY_EXECUTED_CONCLUSIONS = Object.freeze(new Set(['success', 'failure']));

/**
 * Did the `deploy` job of this run actually execute? The strict signal, for the
 * stall record's close gate. See DEPLOY_EXECUTED_CONCLUSIONS.
 */
export function deployJobCompleted(jobs) {
  const deploy = (jobs ?? []).find((job) => job?.name === DEPLOY_JOB_NAME);
  return DEPLOY_EXECUTED_CONCLUSIONS.has(deploy?.conclusion);
}

/**
 * Did this job list show `deploy` actually executing?
 *
 * `skipped` and absent both mean "did not execute". `cancelled` is NOT folded in
 * here: it means the job existed and was stopped, which is what a supersede
 * looks like, and the caller excludes those by run conclusion anyway.
 *
 * ⚠️ This is the DETECTOR's generous predicate, not proof of a refill. Use
 * `deployJobCompleted` above for anything that needs proof — see
 * DEPLOY_EXECUTED_CONCLUSIONS for why the two must not be conflated.
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
  // PEN-5261. A GREEN run whose entry guard never executed is the lane being
  // switched off, and it was previously absorbed by the catch-all below as
  // "normal, owned behaviour" — which is true of the pending-guard skip the
  // catch-all was written for, and false of this. Measured 2026-11-03: the
  // 07:23Z slot dispatched, built an image, skipped all three deploy-lane jobs,
  // concluded `success`, and classified `survived`, while production sat 90
  // commits behind with nothing anywhere saying so.
  //
  // The `success` conjunct is what keeps the supersede path out: a cancelled
  // run shows `cancelled` on the guard, not `skipped`, and must stay SURVIVED.
  if (run.conclusion === 'success' && deployLaneGatedOff(jobs)) {
    return DISPATCH_FATE.LANE_GATED_OFF;
  }
  // `cancelled` with deploy never executed, or `success` with deploy skipped by
  // the pending guard — the guard having RUN and reported blocked. Neither is a
  // death this module may claim; both are normal, owned behaviour of the lane.
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
      // The strict refill signal. Only set on this path, where the job list was
      // read successfully — an unreadable job list returns the raw run object
      // above and carries no such field, so the close gate sees `false` and
      // withholds, which is this module's fail-quiet direction.
      deployExecuted: deployJobCompleted(jobs),
    },
  };
}

/**
 * The fates in which the lane was handed a dispatch and delivered nothing.
 *
 * Both qualify for the gap check and the report; they differ only in the
 * remedy the report names. Everything else — a survival, an empty window, an
 * unreadable run — is silent.
 */
export const LANE_FAILED_TO_DELIVER_FATES = Object.freeze(
  new Set([DISPATCH_FATE.DIED_BEFORE_DEPLOY, DISPATCH_FATE.LANE_GATED_OFF]),
);

/**
 * Should this report a dead lane?
 *
 * BOTH conjuncts are required. A dead dispatch with production already AT master
 * owes nothing — the lane is idle, not stalled — and reporting it would redden
 * the dispatcher for a build failure on a commit nobody is waiting to ship.
 * `commitsBehind` must be affirmatively positive: `null` (gap unmeasurable)
 * stays silent, per this module's fail-quiet direction.
 *
 * The gap conjunct is why a gated-off lane can join this without making the
 * dispatcher permanently red for a deliberate pause: a lane switched off while
 * production is already AT master reports nothing, and only starts reporting
 * once undelivered commits have actually accumulated behind the switch.
 */
export function isDeadLane({ fate, commitsBehind }) {
  if (!LANE_FAILED_TO_DELIVER_FATES.has(fate)) return false;
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

  if (!LANE_FAILED_TO_DELIVER_FATES.has(last.fate)) {
    // Nothing else is worth an API call: the gap only ever qualifies a lane
    // that was handed a dispatch and delivered nothing.
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
    // The FATE and the observed run's CREATION TIME are published as step
    // outputs; `dead` deliberately is not. `dead` is true on a dispatch slot
    // whose PREVIOUS dispatch died, and that slot goes on to dispatch a
    // replacement — i.e. it recovers. Publishing it here would redden exactly
    // the run that fixed the problem. The workflow writes `dead_dispatch=true`
    // itself, inside the sampling-slot branch, where it is the whole statement
    // being made.
    //
    // The timestamp exists because the fate ALONE cannot say which dispatch it
    // describes, and `laneRefilled` needs that. This module runs once per slot,
    // ABOVE the step that issues the day's dispatch — so on a `dispatched` slot
    // the fate is always the PREVIOUS run's, and only `createdAt` can
    // distinguish a survival belonging to the current stall from one that
    // predates it. Empty whenever no run was read, which blocks the close
    // rather than widening it.
    //
    // (Phrased without naming the CLI verb on purpose: the no-write-path test
    // in tests/detect-dead-dispatch.test.mjs bans that literal anywhere in this
    // file, comments included, and the bluntness is the point — it cannot be
    // talked around, only reworded.)
    setOutput('last_dispatch_fate', result.fate);
    setOutput('last_dispatch_at', result.run?.createdAt ?? '');
    // `deploy_executed`, NOT the fate, is what the stall record's close gate
    // reads. The fate's `survived` is a catch-all meaning "not a death this
    // module may claim" — it covers a `cancelled` run whose deploy never ran
    // and a `success` run whose deploy was SKIPPED by the pending guard. That
    // is right for a fail-quiet detector and wrong for a gate that needs proof.
    setOutput('last_dispatch_deploy_executed', result.run?.deployExecuted === true ? 'true' : 'false');
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

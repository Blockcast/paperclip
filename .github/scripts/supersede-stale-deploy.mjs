#!/usr/bin/env node
/**
 * supersede-stale-deploy.mjs
 *
 * Give scheduled-production-deploy.yml's guard (1) a bounded exit (PEN-3315).
 *
 * THE DEFECT
 * ----------
 * Guard (1) refuses to dispatch while a `docker.yml` dispatch is already
 * pending. It is correct — stacking a second approval request splits the
 * reviewer's attention and risks a double roll, observed live 2026-08-30. What
 * it has never had is a way to END the wait. The only exit is a human
 * cancelling or approving.
 *
 * On 2026-09-14 a dispatch at head `c316ff73` sat `waiting` on the
 * `paperclip-production` reviewer gate for 41.2h. For that entire window the
 * dispatcher correctly refused to dispatch anything newer, production shipped
 * nothing for 53h, and `paperclip_api_deploy_commits_behind` climbed to 164.
 * The pending run is pinned to the sha it was dispatched with, so the button in
 * front of the reviewer was, by the end, 100+ commits stale: pressing it would
 * have shipped a partial.
 *
 * The staleness is in the PENDING RUN, not in the dispatcher. The dispatcher
 * already computes every dispatch against `origin/master` at dispatch time and
 * has never re-dispatched a stale head.
 *
 * WHAT THIS DOES — AND, LOUDLY, WHAT IT DOES NOT
 * ----------------------------------------------
 * When a dispatch has been `waiting` past the SAME threshold that already arms
 * the escalation (PENDING_DEPLOY_ALERT_HOURS, 6h), and the head it would deploy
 * is a STRICT ANCESTOR of `origin/master`, this cancels it and dispatches a
 * fresh one at `master`.
 *
 * It APPROVES NOTHING. The 2026-08-28 rejection of auto-approval — "three green
 * guards prove the code builds, not that a human intends to ship it" — is
 * untouched, and this must never be read as reopening it. A human still presses
 * approve; they press it on a current head instead of a 41-hour-old one. It does
 * not make anyone press the button sooner, and if nobody ever presses it the
 * drift still climbs. What it guarantees is that the approvable head is always
 * current, so the click that does eventually land ships everything rather than a
 * 44-of-91 partial.
 *
 * WHY `head_sha` IS THE STALENESS TEST
 * -----------------------------------
 * `docker.yml` takes the deployed commit as a `target_sha` INPUT, and the
 * Actions API does not expose workflow_dispatch inputs on a run — there is no
 * field, and the only other copy is inside the run's logs. `head_sha` is what
 * the API does expose: the commit `refs/heads/master` pointed at when the run
 * was created. For every dispatch this workflow makes, the two are the same
 * value, both `git rev-parse origin/master` seconds apart. Verified against the
 * incident: run 34889856627 has head_sha `c316ff73`, which is 123 commits behind
 * master and 0 ahead, i.e. exactly the strict-ancestor case this fires on.
 *
 * Reading `head_sha` also fails in the safe direction for the case it cannot
 * see. A deliberate rollback — `target_sha` older than the ref it was dispatched
 * from — has `head_sha == master` while master has not moved, and is therefore
 * NOT superseded. Once master does move it becomes superseded like anything
 * else; that is a real, accepted limitation, it is announced in the step
 * summary, on the durable record and in the Alertmanager alert, and the remedy
 * is to re-dispatch. A rollback is approved in minutes during an incident, so
 * the >=6h precondition makes the collision unlikely rather than merely
 * survivable.
 *
 * THE RACE, AND WHY THE LIVE RE-CHECK IS NOT DECORATION
 * ----------------------------------------------------
 * A reviewer approving at the instant of cancellation loses the click and must
 * re-approve. Bounded by the >=6h precondition and by the replacement landing
 * within ~4 minutes, but bounded is not zero, so the run's status is re-read
 * from the API immediately before cancelling and anything other than a live
 * `waiting` aborts. The pending-runs file this step is handed was written
 * earlier in the job, and on a slow runner that is minutes of staleness.
 *
 * That window has a SECOND half, after the cancel. `POST .../cancel` is
 * asynchronous, so the run leaves `waiting` on its own schedule — and it can
 * leave `waiting` by being approved rather than cancelled. Only a terminal state
 * clears the lane, so the post-cancel poll requires `completed` and treats
 * `queued`/`in_progress` as the approval having won: it declines instead of
 * dispatching a replacement alongside a live production deploy. See
 * waitForCancel.
 *
 * WHEN THE GATE IS EMPTIED BUT NOT REFILLED
 * -----------------------------------------
 * Both failure paths here — the cancel not settling, and the dispatch failing
 * after a cancel that did — leave the reviewer gate EMPTY with production still
 * at the stale commit. The dispatcher reports an empty gate as
 * `checked-no-pending`, which is exactly what a human cancelling the run
 * produces, and which closes the durable stall record as resolved. So those
 * paths label the record (STALL_UNREFILLED_LABEL) and --resolve refuses to close
 * a labelled record until an outcome actually refills the lane. Recovery is the
 * daily dispatch slot, up to ~24h — the hourly sampling slots exit at guard (1b)
 * without dispatching — so the record must not read as prompt recovery.
 *
 * CONSERVATIVE BY CONSTRUCTION
 * ----------------------------
 * More than one `waiting` dispatch, or any `queued`/`in_progress` dispatch
 * alongside, and this does nothing: cancelling one of several still leaves the
 * lane held, and dispatching on top of a live build is the stacking guard (1)
 * exists to prevent. Every refusal is named in the log, so "did not supersede"
 * is never indistinguishable from "did not run".
 */
import { readFileSync } from 'node:fs';
import {
  DEPLOY_WORKFLOW_FILE,
  STALL_UNREFILLED_LABEL,
  createGitHubClient,
  renderSupersedeComment,
  renderSupersedeFailedComment,
  setOutput,
  tryComment,
} from './deploy-stall-record.mjs';

export const DEPLOY_REF = 'master';

/**
 * Pick the pending dispatch that MIGHT be supersedable, on the evidence the
 * dispatcher already collected. Deliberately the same selection as
 * selectStuckApproval: the run that arms the escalation is the run that gets
 * superseded, so the two can never disagree about which deploy is stuck.
 *
 * `ageHours` is the age of the RUN, not of the stall. The stall clock lives in
 * the durable record because a supersede resets the run's age by construction;
 * here the run's own age is the right input, since what is being judged is
 * whether THIS run has been sitting long enough to be worth replacing.
 */
export function selectSupersedeCandidate({ pendingRuns, alertAfterHours, now }) {
  const runs = pendingRuns ?? [];
  const waiting = runs.filter((run) => run?.status === 'waiting');

  if (waiting.length === 0) {
    return { eligible: false, reason: 'no-waiting-dispatch', candidate: null, ageHours: 0 };
  }
  if (waiting.length > 1) {
    // Cancelling one of several leaves the lane held anyway, and picking among
    // them is a judgement this step has no basis for.
    return {
      eligible: false,
      reason: 'multiple-waiting-dispatches',
      candidate: null,
      ageHours: 0,
    };
  }
  if (waiting.length !== runs.length) {
    // A queued or in-progress dispatch is a live build. Dispatching a second one
    // is precisely the stacking guard (1) refuses.
    return {
      eligible: false,
      reason: 'non-waiting-dispatch-present',
      candidate: null,
      ageHours: 0,
    };
  }

  const candidate = waiting[0];
  const createdMs = Date.parse(candidate.createdAt);
  if (!Number.isFinite(createdMs)) {
    // post-pending-deploy-alert treats this as fatal because it cannot judge an
    // age it needs. Here the consequence is narrower: we decline to act.
    return { eligible: false, reason: 'unreadable-created-at', candidate, ageHours: 0 };
  }

  const ageHours = (now.getTime() - createdMs) / 3_600_000;
  if (!(ageHours >= alertAfterHours)) {
    return { eligible: false, reason: 'below-threshold', candidate, ageHours };
  }
  return { eligible: true, reason: 'stale-and-past-threshold', candidate, ageHours };
}

/**
 * Second half of the decision, on evidence read live from the API.
 *
 * `compareStatus` is the `status` field of
 * `GET /repos/{repo}/compare/{headSha}...{masterSha}`:
 *
 *   ahead     - master is ahead of the run's head. The run is a STRICT ancestor,
 *               so approving it would ship stale code. This is the only value
 *               that supersedes.
 *   identical - the run already targets master. It is SLOW, not STALE, and must
 *               not be superseded; this is the negative case that keeps a
 *               reviewer's deliberation from being cancelled out from under them
 *               every six hours.
 *   behind    - master is behind the run's head. The run targets something not
 *   diverged    on master, or master moved backwards. Either way we do not
 *               understand the situation and decline to act on it.
 */
export function confirmSupersede({ liveStatus, compareStatus }) {
  if (liveStatus !== 'waiting') {
    // Approved, cancelled or started between the guard-(1) read and now.
    return { supersede: false, reason: `no-longer-waiting:${liveStatus ?? 'unknown'}` };
  }
  if (compareStatus === 'identical') {
    return { supersede: false, reason: 'target-is-current' };
  }
  if (compareStatus !== 'ahead') {
    return { supersede: false, reason: `unexpected-compare-status:${compareStatus ?? 'unknown'}` };
  }
  return { supersede: true, reason: 'stale-target-superseded' };
}

function readPendingRuns(path) {
  if (!path) throw new Error('PENDING_JSON_PATH is not set');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('expected a JSON array of runs');
  return parsed;
}

function declined(reason, detail) {
  setOutput('superseded', 'false');
  setOutput('supersede_reason', reason);
  console.log(`Not superseding the pending dispatch (${reason})${detail ? `: ${detail}` : ''}.`);
}

/**
 * Mark the stall record as "WE emptied this gate and could not refill it".
 *
 * Both failure paths below leave the reviewer gate EMPTY with production still
 * at the stale commit. On the next sampling slot the dispatcher then reports
 * `checked-no-pending`, which is otherwise indistinguishable from a human having
 * cleared the stall — and would close the durable record as *resolved* while
 * nothing has shipped. That is the one record whose entire purpose is to make
 * this incident auditable after the fact.
 *
 * The signal is a LABEL, not a comment: `--resolve` already reads the issue
 * object (labels included) to find the record, so this costs it no extra call
 * and no comment-pagination guesswork about which marker is the most recent. The
 * comment alongside is for the human reading the record, not for the machine.
 *
 * Best-effort throughout — annotating the audit trail must never be what turns a
 * cancel that already happened into an unreported one.
 */
async function noteSupersedeFailed(client, { reason, detail, runUrl }) {
  setOutput('superseded', 'false');
  setOutput('supersede_failed', 'true');
  setOutput('supersede_reason', reason);

  const issueNumber = Number(process.env.STALL_ISSUE_NUMBER || '') || null;
  if (!issueNumber) {
    console.log(
      '::warning::No stall record to mark as unrefilled (STALL_ISSUE_NUMBER is unset), so the ' +
        'next `checked-no-pending` slot cannot tell this apart from a human clearing the gate.',
    );
    return;
  }

  await tryComment(
    client,
    issueNumber,
    renderSupersedeFailedComment({ reason, detail, runUrl }),
    'supersede-failure',
  );
  try {
    await client.addLabel(issueNumber, STALL_UNREFILLED_LABEL);
  } catch (err) {
    console.log(
      `::warning::Could not label record #${issueNumber} as unrefilled: ${err.message}. ` +
        'The next no-pending slot may close it as resolved even though nothing shipped.',
    );
  }
}

/** ~24s total, which is far inside a cancel's observed settle time. */
export const CANCEL_POLL_ATTEMPTS = 8;
export const CANCEL_POLL_DELAY_MS = 3_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the cancel to land, and report WHICH WAY the run left `waiting` —
 * because those are two different questions and only one of them clears the lane.
 *
 * `POST .../cancel` returns 202 Accepted, not "cancelled", so the run leaves
 * `waiting` asynchronously. But it can also leave `waiting` by being APPROVED:
 * that is exactly the race this file's header documents, and an approved run
 * goes `waiting` -> `queued` -> `in_progress`, never straight to `completed`.
 *
 * Treating merely-not-`waiting` as "the cancel landed" would dispatch a
 * replacement alongside a live, approved production deploy — the stacking that
 * guard (1) exists to prevent. Nothing downstream would catch it either:
 * `guard-pending-deploy` and `guard-pending-deploy-final` both query
 * `workflows/docker.yml/runs?status=waiting`, so an `in_progress` sibling reads
 * as `blocked=false`. It is the `non-waiting-dispatch-present` refusal that
 * selectSupersedeCandidate already makes on the PRE-cancel side, missing on the
 * post-cancel side.
 *
 * So only a TERMINAL state clears the lane:
 *
 *   completed            - the cancel landed. Lane is empty; dispatch.
 *   queued / in_progress - the approval won the race. A human's deploy is live:
 *                          decline, and leave it alone.
 *   waiting              - the cancel has not settled yet; keep polling.
 *
 * A read failure counts as "not yet" for the same reason it always did: we would
 * rather not dispatch than dispatch into a guard that will refuse the
 * replacement and leave the lane looking healthy with nothing in it.
 */
export async function waitForCancel(client, runId, { sleep = defaultSleep } = {}) {
  let lastStatus = null;
  for (let attempt = 0; attempt < CANCEL_POLL_ATTEMPTS; attempt += 1) {
    await sleep(CANCEL_POLL_DELAY_MS);
    try {
      const run = await client.request('GET', `/actions/runs/${runId}`);
      lastStatus = run?.status ?? null;
      if (lastStatus === 'completed') {
        return { cleared: true, reason: 'cancel-landed', status: lastStatus };
      }
      if (lastStatus !== null && lastStatus !== 'waiting') {
        return { cleared: false, reason: 'approval-won-cancel-race', status: lastStatus };
      }
    } catch (err) {
      console.log(`::warning::Re-reading run ${runId} after cancel failed: ${err.message}`);
    }
  }
  return { cleared: false, reason: 'cancel-did-not-settle', status: lastStatus };
}

async function main() {
  const alertAfterHours = Number(process.env.ALERT_AFTER_HOURS ?? 6);
  if (!Number.isFinite(alertAfterHours) || alertAfterHours <= 0) {
    console.error(
      `::error::ALERT_AFTER_HOURS must be a positive number, got "${process.env.ALERT_AFTER_HOURS}".`,
    );
    process.exit(1);
  }

  const masterSha = (process.env.MASTER_SHA ?? '').trim();
  if (!/^[0-9a-f]{40}$/i.test(masterSha)) {
    // Without a master sha there is no staleness test, and superseding on no
    // test at all would be a blind cancel of a human's pending approval.
    console.error(`::error::MASTER_SHA must be a full 40-character sha, got "${masterSha}".`);
    process.exit(1);
  }

  const runUrl = process.env.RUN_URL ?? '';
  let pendingRuns;
  try {
    pendingRuns = readPendingRuns(process.env.PENDING_JSON_PATH);
  } catch (err) {
    console.error(`::error::Could not read pending dispatches: ${err.message}`);
    process.exit(1);
  }

  const selection = selectSupersedeCandidate({
    pendingRuns,
    alertAfterHours,
    now: new Date(),
  });
  if (!selection.eligible) {
    declined(selection.reason);
    return;
  }

  const client = createGitHubClient();
  const runId = selection.candidate.databaseId;

  let live;
  try {
    live = await client.request('GET', `/actions/runs/${runId}`);
  } catch (err) {
    console.error(`::error::Could not re-read run ${runId} before superseding it: ${err.message}`);
    process.exit(1);
  }

  const headSha = live?.head_sha;
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) {
    declined('unreadable-head-sha', `run ${runId} reported head_sha=${JSON.stringify(headSha)}`);
    return;
  }

  let compareStatus;
  try {
    const compare = await client.request('GET', `/compare/${headSha}...${masterSha}`);
    compareStatus = compare?.status;
  } catch (err) {
    console.error(`::error::Could not compare ${headSha}...${masterSha}: ${err.message}`);
    process.exit(1);
  }

  const verdict = confirmSupersede({ liveStatus: live?.status, compareStatus });
  if (!verdict.supersede) {
    declined(
      verdict.reason,
      `run ${runId} head ${headSha} vs master ${masterSha} (compare=${compareStatus})`,
    );
    return;
  }

  // Cancel first. docker.yml's workflow_dispatch concurrency group is
  // `cancel-in-progress: false`, so a replacement dispatched while this one
  // still holds the group would queue behind it rather than replace it — and a
  // queued run is exactly what guard (1) blocks on next slot.
  try {
    await client.request('POST', `/actions/runs/${runId}/cancel`);
  } catch (err) {
    console.error(`::error::Could not cancel stale pending run ${runId}: ${err.message}`);
    process.exit(1);
  }

  // ...and WAIT for the cancel to land before dispatching. `POST .../cancel`
  // returns 202 Accepted, not "cancelled": the run leaves `waiting`
  // asynchronously. docker.yml's own guard-pending-deploy re-queries
  // `workflows/docker.yml/runs?status=waiting` from inside the replacement, so
  // dispatching into that window would make the replacement block itself on the
  // run we just cancelled — a self-inflicted repeat of the stall.
  const cancelOutcome = await waitForCancel(client, runId);

  if (!cancelOutcome.cleared && cancelOutcome.reason === 'approval-won-cancel-race') {
    // A reviewer approved inside the cancel window, so the run left `waiting` by
    // being APPROVED rather than cancelled. Not an error, and not a failure path
    // that needs the record kept open: a human acted and production is
    // deploying, which is the outcome this whole step exists to reach. Declining
    // is the entire fix — dispatching here would stack a second deploy on a live
    // one, which is what guard (1) is for.
    declined(
      'approval-won-cancel-race',
      `run ${runId} left \`waiting\` as \`${cancelOutcome.status}\`, i.e. it was approved in the ` +
        'cancel window. NOT dispatching a replacement: that deploy is live',
    );
    return;
  }

  if (!cancelOutcome.cleared) {
    console.error(
      `::error::Cancelled run ${runId} but it had not reached a terminal state after ` +
        `${CANCEL_POLL_ATTEMPTS * CANCEL_POLL_DELAY_MS}ms (last status ` +
        `\`${cancelOutcome.status ?? 'unreadable'}\`). NOT dispatching a replacement: ` +
        "docker.yml's own pending-deploy guard would refuse it. The next scheduled slot " +
        're-evaluates from scratch.',
    );
    await noteSupersedeFailed(client, {
      reason: cancelOutcome.reason,
      detail:
        `The cancel of run ${runId} did not reach a terminal state within ` +
        `${CANCEL_POLL_ATTEMPTS * CANCEL_POLL_DELAY_MS}ms (last status ` +
        `\`${cancelOutcome.status ?? 'unreadable'}\`), so no replacement was dispatched. ` +
        'The cancel usually lands moments later, which leaves the gate EMPTY.',
      runUrl,
    });
    process.exit(1);
  }

  try {
    await client.request('POST', `/actions/workflows/${DEPLOY_WORKFLOW_FILE}/dispatches`, {
      ref: DEPLOY_REF,
      inputs: { target_sha: masterSha },
    });
  } catch (err) {
    // The stale run is already cancelled, so the lane is now EMPTY and the next
    // scheduled DISPATCH slot will dispatch on its own. Say so explicitly: a bare
    // failure here reads like the lane was left broken. Note "next dispatch slot"
    // is the daily `23 7 * * *` one — the hourly sampling slots exit at guard
    // (1b) without dispatching — so recovery is up to ~24h, not up to an hour.
    console.error(
      `::error::Cancelled stale run ${runId} but could not dispatch a replacement at ` +
        `${masterSha}: ${err.message}. The reviewer gate is now clear, so the next ` +
        'scheduled DISPATCH slot (daily) will re-dispatch — up to ~24h away.',
    );
    await noteSupersedeFailed(client, {
      reason: 'dispatch-failed-after-cancel',
      detail:
        `Run ${runId} was cancelled, but dispatching \`${DEPLOY_WORKFLOW_FILE}\` at ` +
        `\`${masterSha}\` failed: ${err.message}`,
      runUrl,
    });
    process.exit(1);
  }

  const runHtmlUrl =
    selection.candidate.url ?? `https://github.com/${client.repo}/actions/runs/${runId}`;

  console.log(
    `::warning::Superseded stale pending deploy ${runId} (head ${headSha}, ` +
      `${selection.ageHours.toFixed(1)}h on the reviewer gate) and dispatched docker.yml at ` +
      `master ${masterSha}. Nothing was approved — a human still has to press the button.`,
  );

  const summary = [
    '### Superseded a stale pending deploy',
    '',
    `Cancelled \`${runId}\` (${runHtmlUrl}) — it had been on the \`${process.env.ENVIRONMENT_NAME || 'paperclip-production'}\``,
    `reviewer gate for \`${selection.ageHours.toFixed(1)}h\` at head \`${headSha}\`, which is a strict`,
    'ancestor of `master`, so approving it would have shipped a partial.',
    '',
    `Dispatched \`docker.yml\` fresh at \`master\` = \`${masterSha}\`.`,
    '',
    '**No approval was granted or bypassed.** A named reviewer still has to approve the new run.',
    'If you were mid-click on the cancelled run, approve the replacement instead.',
    '',
    'If the cancelled run was a deliberate rollback to an older `target_sha`, re-dispatch it —',
    'this step judges staleness from the run\'s `head_sha`, which cannot distinguish a rollback',
    'from a stale dispatch once `master` has moved past it (PEN-3315).',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }

  // Best-effort: the audit note must never undo a cancel that already happened.
  const issueNumber = Number(process.env.STALL_ISSUE_NUMBER || '') || null;
  await tryComment(
    client,
    issueNumber,
    renderSupersedeComment({
      cancelledRunUrl: runHtmlUrl,
      cancelledHeadSha: headSha,
      cancelledAgeHours: selection.ageHours,
      masterSha,
      runUrl,
    }),
    'supersede',
  );

  setOutput('superseded', 'true');
  setOutput('supersede_reason', verdict.reason);
  setOutput('superseded_run_id', String(runId));
  setOutput('dispatched_sha', masterSha);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::supersede-stale-deploy failed unexpectedly: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

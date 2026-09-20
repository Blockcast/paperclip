#!/usr/bin/env node
/**
 * post-pending-deploy-alert.mjs
 *
 * Escalates a production deploy that has been parked on the
 * `paperclip-production` reviewer gate for longer than an agreed threshold.
 *
 * WHY THIS EXISTS (PEN-2848)
 * --------------------------
 * scheduled-production-deploy.yml's guard (1) refuses to stack a second
 * dispatch while one is already pending. The guard is correct. But the job it
 * protects is gated on three named human reviewers, so while any deploy sits
 * `waiting`, the daily dispatcher is a permanent no-op — and every skipped run
 * still reports `conclusion: success`. On 2026-09-01 that took production to 45
 * commits behind with an oldest-missing-commit age of 28.8h, and nothing
 * escalated: the mechanism built to remove a human from the loop disarms itself
 * precisely when the human is what is stuck.
 *
 * WHY severity=critical, WHEN THE SIBLING DRIFT ALERT IS ONLY `warning`
 * --------------------------------------------------------------------
 * `PaperclipApiOldestMissingCommitAge` is deliberately `warning` (BLO-22739):
 * it measures *commit age*, which a long-lived branch can push over the line
 * benignly, and its stated reasoning is that "the only remedy is a human
 * dispatching the manual release - there is no automated remediation to page
 * for". This alert is a different signal and does not inherit that reasoning.
 * It fires only when a named reviewer has a specific button in front of them
 * and has not pressed it, so it is actionable by construction. Alertmanager
 * routes `severity=~"critical|page"` to the slack-relay receiver; `warning`
 * reaches the paperclip webhook only — the very receiver whose outage this
 * alert may be needed to fix (PEN-2581). Reaching a human on a path
 * independent of that receiver is the whole point.
 *
 * WHY THIS PUSHES TO ALERTMANAGER RATHER THAN ADDING A PROMETHEUS RULE
 * -------------------------------------------------------------------
 * Both candidate homes for a rule-based version are Argo CD apps with no
 * `automated:` sync policy: `monitoring-rules` and `paperclip-api-deploy-drift`
 * were each `OutOfSync` when this was written (last synced 3 and 17 days
 * earlier). A rule added there merges green and deploys nothing, which is the
 * same defect this issue is about. The deploy-drift exporter also makes its
 * GitHub calls anonymously, so it cannot read `pending_deployments` at all
 * without a new credential. GitHub Actions deploys itself on merge; that is the
 * only plane here that reliably carries a fix.
 *
 * `endsAt` is set past the next scheduled run so the alert stays continuously
 * firing while the approval remains stuck, and auto-resolves (send_resolved:
 * true) once a run stops re-pushing it — so approving or rejecting produces a
 * "resolved" Slack message without this script detecting the fix itself.
 *
 * Delivery failure, an unreadable pending-runs file, a malformed threshold, and
 * an unparseable timestamp on a waiting run are all deliberately fatal. A silent
 * success in any of those cases would recreate the exact defect this check
 * exists to close: a control everyone believes is in place.
 *
 * WHAT PEN-3315 ADDED
 * -------------------
 * 1. A DURABLE second artifact alongside the Alertmanager push. The alert's
 *    `endsAt` is ALERT_TTL_MS, so three hours after the last push the only
 *    record of the escalation is gone from /api/v2/alerts. PEN-3289 tried to
 *    audit the 41.2h stall of 2026-09-14 after it cleared and got 0 hits on a
 *    positive-controlled query. See deploy-stall-record.mjs.
 * 2. A stall clock that survives a supersede. supersede-stale-deploy.mjs cancels
 *    a stale pending run and dispatches a fresh one, which resets that run's
 *    `createdAt` to now. Ageing the escalation off the run alone would turn one
 *    41h stall into a train of 6.0h ones, flapping firing/resolved on the
 *    threshold instead of firing continuously with a climbing age. The stall
 *    start comes from the durable record, and the age basis is the EARLIER of
 *    that and the oldest waiting run.
 *
 * WHAT ITS FOLLOW-UP CHANGED, AND WHY
 * -----------------------------------
 * (1) above is INERT on this repository. `Blockcast/paperclip` has
 * `has_issues: false`, so `POST /issues` returns `410 Issues has been disabled
 * in this repository` on every escalation; the permission reasoning was right
 * but the feature is switched off, and no token scope reaches it. The clock in
 * (2) therefore had no durable source, and the supersede shipped by PEN-3315
 * duly reset it. Measured live 2026-09-18: a genuine stall running since
 * 09-17T02:01:24Z reported `3.0h old, under the 6h threshold — not escalating`
 * on a GREEN dispatcher run while `paperclip_api_deploy_commits_behind` read
 * 107. That is the pre-PEN-2848 silent green, reintroduced by the fix.
 *
 * So the clock is now DERIVED rather than stored — from Actions run history,
 * which is already retained 90 days and readable with the `actions: read` this
 * workflow holds. See deploy-stall-chain.mjs. The issue record is kept for the
 * repositories where it does work, and its 410 is reported as a configuration
 * fact rather than an hourly warning.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  createGitHubClient,
  renderEscalationComment,
  renderStallIssueBody,
  resolveStallStartedAt,
  parseStallMarker,
  tryComment,
} from './deploy-stall-record.mjs';
import {
  createAncestryProbe,
  deriveStallStartFromSupersedeChain,
  fetchCancelledDispatchRuns,
} from './deploy-stall-chain.mjs';

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';
/**
 * Slightly longer than the hourly sampling cadence, so firing is continuous
 * across one delayed or failed slot while still resolving promptly once the
 * gate clears. Was 25h when the escalation was reachable only from the daily
 * 07:23 dispatch (BLO-33400 makes it hourly): at that TTL an approval granted
 * at 10:00 kept a critical alert firing until 11:00 the NEXT day, which is the
 * opposite defect to the one this script exists to fix. Three hours absorbs two
 * consecutive missed hourly slots — GitHub delays scheduled runs under load,
 * observed 5-17min late here — without which a single skipped slot would emit a
 * spurious resolved/firing pair.
 */
export const ALERT_TTL_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_ALERT_AFTER_HOURS = 6;

/**
 * Raised when a `waiting` run carries a timestamp we cannot age. Fatal by
 * design — see selectStuckApproval.
 */
export class UnreadableWaitingRunError extends Error {}

/**
 * Pick the oldest run parked on the human reviewer gate and decide whether it
 * has been there too long.
 *
 * Only `waiting` counts. `queued` and `in_progress` also block the dispatcher's
 * anti-stacking guard, but they are runner/build states — no human is being
 * waited on, and paging three named reviewers for a slow build would be the
 * wrong people and the start of alert fatigue. Their timestamps are never read,
 * so a malformed one on a non-waiting run is ignored rather than fatal.
 *
 * A `waiting` run whose `createdAt` will not parse is fatal, NOT skipped.
 * Excluding it fails open in the one case that matters: if the malformed record
 * is the genuinely stuck approval and some other waiting run is younger than the
 * threshold, dropping it lets this step report "not stuck" and exit 0 — the
 * silent green that PEN-2848 is entirely about. We cannot judge the age, so we
 * say so loudly and let the step fail; `conclusion: failure` is itself one of
 * this change's escalation paths.
 *
 * `stallStartedAt` (PEN-3315, optional) is the start of the STALL as recorded
 * durably, which outlives any individual run. When it is earlier than the oldest
 * waiting run — the case a supersede creates — it becomes the age basis, so
 * replacing the run cannot reset the clock. It can only ever move the basis
 * EARLIER, never later, so a missing or stale record degrades to the previous
 * behaviour instead of masking a stall. An unparseable value is ignored rather
 * than fatal: it comes from our own marker, and taking the escalation down over
 * a cosmetic edit to an issue body would be worse than the age it protects.
 */
export function selectStuckApproval({ pendingRuns, alertAfterHours, now, stallStartedAt = null }) {
  const waiting = (pendingRuns ?? []).filter((run) => run?.status === 'waiting');

  const unreadable = waiting.filter((run) => !Number.isFinite(Date.parse(run?.createdAt)));
  if (unreadable.length > 0) {
    const detail = unreadable
      .map(
        (run) => `run ${run?.databaseId ?? '(no id)'} createdAt=${JSON.stringify(run?.createdAt)}`,
      )
      .join('; ');
    throw new UnreadableWaitingRunError(
      `${unreadable.length} waiting deploy(s) have an unparseable createdAt, so their ` +
        `approval age cannot be judged: ${detail}`,
    );
  }

  waiting.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const oldest = waiting[0] ?? null;
  if (!oldest) {
    return {
      stuck: false,
      oldest: null,
      ageHours: 0,
      waitingCount: 0,
      stallStartedAt: null,
    };
  }

  const recordedMs = Date.parse(stallStartedAt);
  const basisMs = Math.min(
    Date.parse(oldest.createdAt),
    Number.isFinite(recordedMs) ? recordedMs : Number.POSITIVE_INFINITY,
  );

  const ageHours = (now.getTime() - basisMs) / 3_600_000;
  return {
    stuck: ageHours >= alertAfterHours,
    oldest,
    ageHours,
    waitingCount: waiting.length,
    stallStartedAt: new Date(basisMs).toISOString(),
  };
}

/**
 * The deploy workflow whose waiting-runs queue the alert points a human at.
 * Deliberately a local literal rather than an import from
 * supersede-stale-deploy.mjs: that module owns a `main()` that cancels
 * production deploys, and the alert path must stay importable without it. The
 * same string is already a literal in the description buildAlert renders.
 */
export const DEPLOY_WORKFLOW_FILE = 'docker.yml';

export function buildAlert({
  oldest,
  ageHours,
  waitingCount,
  alertAfterHours,
  runUrl,
  repo,
  environment,
  now,
  stallStartedAt = null,
  stallRecordUrl = null,
}) {
  const hours = ageHours.toFixed(1);
  const pendingUrl = oldest.url ?? '(url unavailable)';
  // The call to action must NOT be a run url. This step runs BEFORE the
  // supersede step that cancels the very run it names, so `pendingUrl` is dead
  // within seconds of every push and stays dead for the whole ~7h cycle —
  // measured 2026-09-19: alert posted 23:31:17Z naming run 35455142403,
  // cancelled 23:31:23Z, still named at 00:05Z. A human opening the link finds a
  // cancelled run, which is this alert's own subject matter (BLO-26972).
  //
  // The queue filter is correct unconditionally: it lists whatever is on the
  // gate at READ time, so no step ordering, no write-back of the replacement run
  // id, and no supersede can stale it. `pendingUrl` is kept as observed-at-alert
  // context and in the machine annotation, where a perishable value is honest.
  const pendingQueueUrl = `https://github.com/${repo}/actions/workflows/${DEPLOY_WORKFLOW_FILE}?query=is%3Awaiting`;
  // A supersede replaces the run but not the stall, so these two differ whenever
  // the lane has been refreshed. Saying only one of them would either understate
  // the outage or point at a run that no longer exists.
  const stallSince = stallStartedAt ?? oldest.createdAt;
  const superseded = stallSince !== oldest.createdAt;

  return {
    labels: {
      alertname: 'ProductionDeployApprovalStuck',
      severity: 'critical',
      namespace: 'paperclip',
      service: 'paperclip-production-deploy-gate',
      repo,
      environment,
    },
    annotations: {
      summary:
        `${repo} production deploy has been awaiting human approval for ${hours}h — ` +
        'the daily dispatcher is a no-op until it clears',
      description:
        `A docker.yml deploy has been parked on the ${environment} reviewer gate since ` +
        `${stallSince} (${hours}h; threshold ${alertAfterHours}h).\n\n` +
        "While it waits, scheduled-production-deploy.yml's anti-stacking guard skips every " +
        'daily slot, so production drift grows and each skipped run still reports ' +
        'conclusion=success. Nothing else escalates this.\n\n' +
        (superseded
          ? 'The pending run has been superseded at least once so the approvable head stays ' +
            `current, so it is younger than the stall: it has been waiting since ${oldest.createdAt}. ` +
            'Nothing has been approved — the age above is how long a human has been needed.\n\n'
          : '') +
        `Approve or reject the pending deploy to clear it: ${pendingQueueUrl}\n` +
        'That link lists whatever is on the gate right now. Do not bookmark an individual run: ' +
        'a stale one is cancelled and replaced whenever master moves past it, so approve ' +
        `whichever run is waiting there. At the time of this alert that was ${pendingUrl}.\n\n` +
        `${waitingCount} deploy(s) currently waiting on this gate.` +
        (stallRecordUrl ? `\n\nDurable record (survives this alert's TTL): ${stallRecordUrl}` : ''),
      pending_queue_url: pendingQueueUrl,
      pending_run_url: pendingUrl,
      pending_since: oldest.createdAt,
      stall_since: stallSince,
      ...(stallRecordUrl ? { stall_record_url: stallRecordUrl } : {}),
      run_url: runUrl,
      runbook_url: 'https://paperclip.blockcast.net/PEN/issues/PEN-2848',
    },
    startsAt: now.toISOString(),
    endsAt: new Date(now.getTime() + ALERT_TTL_MS).toISOString(),
  };
}

function setOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${name}=${value}\n`);
}

function readPendingRuns(path) {
  // Unlike the sibling protection alert, a missing file here is fatal rather
  // than "alert anyway": this step only runs because the dispatcher already
  // reported something pending, so an unreadable file means we cannot judge the
  // age — and reporting "not stuck" from a failed read is how a control goes
  // quietly blind.
  if (!path) {
    console.error('::error::PENDING_JSON_PATH is not set; cannot judge approval age.');
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of runs');
    return parsed;
  } catch (err) {
    console.error(`::error::Could not read pending dispatches from ${path}: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  const alertAfterHours = Number(process.env.ALERT_AFTER_HOURS ?? DEFAULT_ALERT_AFTER_HOURS);
  if (!Number.isFinite(alertAfterHours) || alertAfterHours <= 0) {
    // A misconfigured threshold must not silently disable the escalation.
    console.error(
      `::error::ALERT_AFTER_HOURS must be a positive number, got "${process.env.ALERT_AFTER_HOURS}".`,
    );
    process.exit(1);
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const environment = process.env.ENVIRONMENT_NAME || 'paperclip-production';
  const runUrl = process.env.RUN_URL ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  const now = new Date();
  const pendingRuns = readPendingRuns(process.env.PENDING_JSON_PATH);

  // Read the durable record first, so the age basis survives a supersede.
  //
  // A failed read is reported and then DEFERRED rather than exiting here. Going
  // fatal immediately would let a GitHub blip suppress the Alertmanager push,
  // which is the path that actually reaches a human; carrying on with the
  // run-only clock costs precision at worst. The deferred exit still turns the
  // run red, so the read failure is never silent.
  const client = createGitHubClient();
  let record = null;
  let recordReadFailed = false;
  // Tracked separately from the record read so the two degradations stay
  // distinguishable in the log, but folded into the same fatal condition: both
  // mean the stall age could not be established from a source that survives a
  // supersede, and reporting an unjudgeable age as "not stuck" is the silent
  // green PEN-2848 exists to prevent.
  let chainReadFailed = false;
  try {
    record = await client.findOpenStallIssue();
  } catch (err) {
    recordReadFailed = true;
    console.error(
      `::error::Could not read the durable deploy-stall record: ${err.message}. ` +
        'Ageing this escalation from the pending run alone, which UNDERSTATES the stall if ' +
        'the run has been superseded. Alerting anyway, then failing the step.',
    );
  }

  const marker = record ? parseStallMarker(record.body) : null;
  if (record && !marker) {
    console.log(
      `::warning::Issue #${record.number} carries no readable stall marker; falling back to its ` +
        'creation time, which understates the stall by at most the alert threshold.',
    );
  }

  let verdict;
  try {
    const waitingRuns = (pendingRuns ?? [])
      .filter((run) => run?.status === 'waiting' && Number.isFinite(Date.parse(run?.createdAt)))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const oldestWaitingCreatedAt = waitingRuns[0]?.createdAt;

    // Derive the stall clock from run history. This is what keeps the age honest
    // across a supersede in a repository where the durable record cannot be
    // written (`has_issues: false` -> 410). It runs BEFORE the stuck verdict
    // because it is an input to it.
    let chainStallStartedAt = null;
    if (waitingRuns[0]) {
      try {
        const cancelledRuns = await fetchCancelledDispatchRuns({ client });
        const chain = await deriveStallStartFromSupersedeChain({
          oldestWaitingRun: waitingRuns[0],
          cancelledRuns,
          isAncestor: createAncestryProbe({ client }),
        });
        chainStallStartedAt = chain.stallStartedAt;
        if (chain.links.length > 0) {
          const unverified = chain.links.filter((link) => !link.ancestryVerified).length;
          console.log(
            `Supersede chain: ${chain.links.length} link(s) back to ${chain.stallStartedAt} ` +
              `(stopped: ${chain.stoppedBecause}` +
              `${unverified > 0 ? `, ${unverified} ancestry-unverified` : ''}). ` +
              `Cancelled predecessors: ${chain.links.map((l) => l.cancelledRunId).join(', ')}.`,
          );
        }
      } catch (err) {
        // Non-fatal on its own: the chain is an enhancement over run-only
        // ageing, so losing it degrades to the previous behaviour rather than
        // breaking the escalation. It IS counted as a failed clock read below,
        // which is what makes the degradation visible instead of silent.
        chainReadFailed = true;
        console.error(
          `::error::Could not derive the stall clock from run history: ${err.message}. ` +
            'Ageing from the pending run alone, which UNDERSTATES the stall if it has been ' +
            'superseded.',
        );
      }
    }

    const { stallStartedAt, source } = resolveStallStartedAt({
      marker,
      issueCreatedAt: record?.created_at,
      oldestWaitingCreatedAt,
      chainStallStartedAt,
      alertAfterHours,
    });
    if (record || chainStallStartedAt) {
      console.log(`Stall start ${stallStartedAt} (source: ${source}).`);
    }

    verdict = selectStuckApproval({ pendingRuns, alertAfterHours, now, stallStartedAt });
  } catch (err) {
    if (!(err instanceof UnreadableWaitingRunError)) throw err;
    // Same reasoning as an unreadable pending-runs file: this step only runs
    // because the dispatcher already reported something pending, so being
    // unable to age it is a failed read, not a clean bill of health.
    console.error(
      `::error::Cannot judge production approval age: ${err.message}. ` +
        'Failing rather than reporting no stuck approval.',
    );
    process.exit(1);
  }

  if (!verdict.stuck) {
    setOutput('escalated', 'false');
    console.log(
      verdict.oldest
        ? `Oldest waiting deploy is ${verdict.ageHours.toFixed(1)}h old, under the ` +
            `${alertAfterHours}h threshold — skip recorded, not escalating.`
        : 'No deploy is waiting on a human reviewer (pending runs are queued/building) — ' +
            'not escalating.',
    );
    // Only fail on a failed record read if the record COULD have changed this
    // verdict. With no waiting run at all, selectStuckApproval returns
    // `stuck: false` before `stallStartedAt` is consulted, so the recorded stall
    // clock is provably irrelevant — and exiting 1 there would make a transient
    // GitHub API blip, during a slot where only queued/in_progress dispatches
    // exist, produce the exact red that PEN-2848 made mean "a production
    // approval is stuck". That is the same conflation the sibling close step is
    // careful to avoid: the dispatcher's `conclusion` must not start meaning
    // "housekeeping failed". The `::error::` annotation already makes the failed
    // read non-silent.
    //
    // With a waiting run under threshold the record IS record-sensitive — an
    // earlier recorded start would push the age over — so a failed read there is
    // still an unjudgeable age and still fatal.
    if ((recordReadFailed || chainReadFailed) && verdict.oldest) process.exit(1);
    return;
  }

  // Open the durable record BEFORE alerting, so the alert can name it. The
  // record is the artifact that outlives ALERT_TTL_MS; if delivery then fails,
  // an auditable trace of the escalation still exists, which is the whole point
  // of PEN-3315's second channel.
  const recordState = await upsertStallRecord({
    client,
    record,
    verdict,
    alertAfterHours,
    repo,
    environment,
    runUrl,
  });
  if (recordState.number) setOutput('stall_issue_number', String(recordState.number));
  setOutput('stall_started_at', verdict.stallStartedAt ?? '');

  const alert = buildAlert({
    ...verdict,
    alertAfterHours,
    runUrl,
    repo,
    environment,
    now,
    stallRecordUrl: recordState.url,
  });
  const url = `${base}/api/v2/alerts`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([alert]),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error(
      `::error::ALERT DELIVERY FAILED: could not reach Alertmanager at ${url}: ${err.message}. ` +
        `The stuck approval is still real — ${alert.annotations.pending_run_url}`,
    );
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(
      `::error::ALERT DELIVERY FAILED: Alertmanager ${url} returned ${res.status}: ${body.slice(0, 500)}`,
    );
    process.exit(1);
  }

  setOutput('escalated', 'true');
  console.log(
    `Pushed ${alert.labels.alertname} (severity=${alert.labels.severity}) to ${url}; ` +
      `firing until ${alert.endsAt}. Stall since ${alert.annotations.stall_since}; ` +
      `pending run waiting since ${alert.annotations.pending_since}.`,
  );
  if (recordReadFailed || chainReadFailed) process.exit(1);
}

/**
 * Create the durable record on the first escalation of a stall, comment on it
 * thereafter. Best-effort throughout: this is the audit trail, and failing it
 * would take down the Alertmanager push that follows.
 */
async function upsertStallRecord({
  client,
  record,
  verdict,
  alertAfterHours,
  repo,
  environment,
  runUrl,
}) {
  const shared = {
    stallStartedAt: verdict.stallStartedAt,
    ageHours: verdict.ageHours,
    alertAfterHours,
    pendingRunUrl: verdict.oldest.url ?? '(url unavailable)',
    pendingSince: verdict.oldest.createdAt,
    runUrl,
  };

  if (record) {
    await tryComment(client, record.number, renderEscalationComment(shared), 'escalation');
    return { number: record.number, url: record.html_url ?? null };
  }

  try {
    await client.ensureLabel();
    const created = await client.createStallIssue(
      renderStallIssueBody({
        ...shared,
        waitingCount: verdict.waitingCount,
        repo,
        environment,
      }),
    );
    console.log(
      `Opened durable deploy-stall record #${created.number} — ${created.html_url}. ` +
        'It closes automatically on the first slot that finds nothing pending.',
    );
    return { number: created.number, url: created.html_url ?? null };
  } catch (err) {
    // A 410 here is not a fault and not actionable: it means the repository has
    // Issues switched off (`has_issues: false`), so this channel can never
    // succeed and no token scope changes that. Measured on Blockcast/paperclip
    // 2026-09-18. Warning hourly about a configuration that is not going to
    // change is noise that trains people to ignore the annotation, so say it
    // once, plainly, and point at what actually carries the property: the
    // dispatcher's own run history, which is retained 90 days and is where the
    // stall clock is now derived from.
    if (err.status === 410) {
      console.log(
        'Durable issue record unavailable: Issues are disabled on this repository (410), so ' +
          'the escalation is audited from dispatcher run history instead — this red run and ' +
          'its ::error:: annotation are themselves the durable trace, and the stall clock is ' +
          'derived from the supersede chain (deploy-stall-chain.mjs).',
      );
      return { number: null, url: null };
    }
    console.log(
      `::warning::Could not open the durable deploy-stall record: ${err.message}. ` +
        'The Alertmanager push below is unaffected, but this escalation will not be ' +
        'auditable after the alert expires.',
    );
    return { number: null, url: null };
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // An unhandled rejection would still exit non-zero, but without an ::error::
  // annotation naming the cause — on a path whose whole purpose is being legible
  // from the Actions list, that is worth the four lines.
  main().catch((err) => {
    console.error(`::error::post-pending-deploy-alert failed unexpectedly: ${err?.stack ?? err}`);
    process.exit(1);
  });
}

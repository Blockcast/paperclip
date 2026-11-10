#!/usr/bin/env node
/**
 * post-master-health-alert.mjs
 *
 * Routes the verdict of `master-health.yml` (workflow `Master general tests`)
 * into Alertmanager, which fans every alert to the paperclip-plugin-alertmanager
 * webhook — so a RED MASTER becomes a Paperclip issue in the platform lane
 * instead of a red run nobody reads.
 *
 * THE GAP THIS CLOSES (PEN-6398). On 2026-11-10 the BLO-55110 regression landed
 * on master. `Master general tests` caught it, correctly, on two independent
 * runs — 42729590442 (push) and 42730863371 (schedule), both `failure` at head
 * 0e4e1b17f. NOTHING CONSUMED EITHER. Measured across all 46 workflow files at
 * master: the `workflow_run` consumers are dispatch-ally-verdict-ci.yml
 * (`workflows: [PR]`), docker-agent.yml (`["Docker"]`) and
 * report-merge-queue-ejection.yml (`["PR", "Comment-review gate (merge queue)"]`).
 * None names `Master general tests`. The red sat unannounced until the PR fleet
 * rediscovered the same defect independently, with at least four PRs burning a
 * full lane each on it — the exact cost BLO-27861 records and master-health.yml
 * was built to end. Detection worked; routing did not exist.
 *
 * WHY NOT GitHub Issues. Issues are DISABLED on this repository
 * (`gh api repos/Blockcast/paperclip --jq .has_issues` -> false, re-measured
 * 2026-11-10). BLO-33382 is the incident where an alert path assumed otherwise
 * and failed closed AND silently for 8 master failures in 27h. Alertmanager is
 * the channel this org runs on, is reachable from the in-cluster `arc-*` pools
 * with no credential, and already backs post-docker-agent-alert.mjs,
 * post-environment-protection-alert.mjs and post-guard-liveness-alert.mjs.
 *
 * ⛔ `cancelled` MUST ROUTE NEITHER WAY, AND THIS IS THE LOAD-BEARING DECISION.
 * `cancelled` is the MODAL outcome of this workflow, by design and at no cost:
 * `master-health.yml` sets `cancel-in-progress: ${{ github.event_name != 'push' }}`,
 * so a push run is never killed in flight and the cancellations are
 * concurrency-PENDING runs superseded before dispatch. Measured over the 50 most
 * recent runs (2026-11-09T04:23Z -> 2026-11-10T06:44Z): 41 cancelled, and 5 of 5
 * sampled returned `total_count: 0` jobs — they never took a runner. A cancelled
 * run therefore carries NO information about master's health in either
 * direction. Routing it as firing would flood the lane roughly hourly; routing
 * it as resolved would CLEAR a real red on the strength of a run that never
 * executed a single test. The second is silent and is the dangerous one.
 *
 * ⛔ A `success` IS NOT AUTOMATICALLY PROOF EITHER — require POSITIVE EVIDENCE
 * that the suite RAN. master-health's `gate` job can skip the whole matrix when
 * a merge_group build already proved the tree, and A SKIPPED JOB STILL CONCLUDES
 * `success`. That is not hypothetical: run 36648202266 reported SUCCESS on the
 * very head that was already red during BLO-38228, because the proof had expired
 * on the clock while the commit had not changed. Resolving on such a run would
 * clear a genuine red — the same silent direction as above. So this script
 * decides on the JOB rows, not on the run conclusion, and mirrors
 * master-health.yml's own `SERVER_SUITES_RAN` rule: proof is positive evidence
 * that the work happened, never the absence of a failure.
 *
 * ⛔ A RUN THAT DID NOT TEST `master` SAYS NOTHING ABOUT master. `push:` here
 * is pinned to master and `schedule:` always runs there, but master-health.yml's
 * `workflow_dispatch:` carries NO branch restriction, so
 * `gh workflow run master-health.yml --ref <branch>` produces a run whose
 * `workflow_run` event this consumer accepts. The label set below deliberately
 * carries no branch, so that run would resolve THE SAME alert identity as
 * master — clearing a standing red on the strength of a feature branch's green.
 * An ABSENT branch refuses too: "I cannot tell which tree this tested" is not
 * "it tested master".
 *
 * THIS IS ROUTING PLUS A CLASSIFICATION OVER ROWS IT IS HANDED. It makes no
 * GitHub API call, computes no threshold, and re-runs no test: the workflow
 * fetches the job rows and this script decides which of the three dispositions
 * they describe. Keeping the decision here, rather than in YAML `if:`
 * expressions, is what makes it testable — see tests/post-master-health-alert.test.mjs.
 *
 * LABEL CARDINALITY. The Alertmanager fingerprint hashes the ENTIRE label set
 * and the Paperclip bridge dedupes on it, refreshing one issue in place. Master
 * advances every ~10-20 minutes, so putting the head SHA (or the run id) in a
 * LABEL would mint a fresh issue per commit for one standing red — the flood
 * BLO-28616 documents. The head and the run are carried as ANNOTATIONS, which
 * give the operator the detail without touching alert identity.
 *
 * RESOLUTION IS EXPLICIT, NOT A TIMER. A green run that actually ran the suite
 * pushes `STATE=resolved`, so the lane clears on a FIX rather than on a clock.
 * That green path doubles as a continuous capability probe: it exercises the
 * exact delivery path the failure path depends on, which is the property
 * BLO-33382 was missing. Delivery failure is deliberately fatal — a silent
 * success here would recreate the defect this script exists to close.
 */

const DEFAULT_ALERTMANAGER_URL = 'http://alertmanager.monitoring.svc.cluster.local:9093';

/**
 * Backstop only; the green path is what normally clears this.
 *
 * It must comfortably exceed the gap between two CONCLUDED runs, or a standing
 * red would self-retire between them. That gap is not the cron interval: the
 * run cadence is set by the arc-paperclip-general queue, and measured
 * created->concluded wall clock over the 7 concluded runs in the 26.35h to
 * 2026-11-10T06:44Z was 4.2/4.2/4.4/4.8/5.1/5.5/6.8 hours, back-to-back. 24h
 * leaves roughly 3.5x headroom over the worst observed.
 *
 * If this workflow stops entirely the alert does go quiet after the TTL — that
 * residual is covered elsewhere and deliberately not re-implemented here:
 * `scripts/check-scheduled-guard-liveness.mjs` watches master-health's cron with
 * `event: "schedule"` and routes via post-guard-liveness-alert.mjs.
 */
export const ALERT_TTL_MS = 24 * 60 * 60 * 1000;

export const ALERTNAME = 'MasterGeneralTestsFailing';

/** The only branch this alert describes. See the branch rule in the header. */
export const MASTER_BRANCH = 'master';

/** Matrix jobs are `Master tests (server 1/4)`, `Master tests (workspaces-a)`, ... */
export const SUITE_JOB_PREFIX = 'Master tests (';

export const MAX_DETAIL_CHARS = 4000;

export function truncateDetail(detail, max = MAX_DETAIL_CHARS) {
  const text = String(detail ?? '').trim();
  if (text.length <= max) return text;
  // Keep the HEAD here, unlike post-guard-liveness-alert.mjs. That script
  // truncates to the tail because its detector prints its verdict last; this
  // detail is a list of failing job names, where the first entries are the ones
  // an operator acts on and the list has no summary line.
  return `${text.slice(0, max)}\n[...truncated, showing first ${max} characters...]`;
}

export function suiteJobs(jobs) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((j) => typeof j?.name === 'string' && j.name.startsWith(SUITE_JOB_PREFIX));
}

/**
 * The whole decision, over the run conclusion and the job rows.
 *
 * Returns { state: 'firing' | 'resolved' | 'skip', reason, failedJobs }.
 * `skip` means "this run says nothing about master" and MUST push neither way.
 */
export function decideAlertState({
  runConclusion,
  jobs,
  headBranch,
  headSha = '',
  isReplay = false,
  masterHeadSha = '',
}) {
  // ⛔ BRANCH FIRST, because it invalidates the run in BOTH directions. A
  // feature-branch dispatch of master-health (its `workflow_dispatch:` takes any
  // ref) reaches this consumer, and this alert's identity carries no branch
  // label, so a green one would RESOLVE master's standing red and a red one
  // would fire "master is RED" about a tree that is not master.
  //
  // Deliberately not `headBranch && headBranch !== MASTER_BRANCH`: an absent or
  // unreadable branch must refuse too. Unknown is not master.
  if (headBranch !== MASTER_BRANCH) {
    return {
      state: 'skip',
      reason:
        `run tested ${headBranch ? `branch '${headBranch}'` : 'an unknown branch'}, not ` +
        `'${MASTER_BRANCH}'. master-health.yml accepts workflow_dispatch on any ref, and this ` +
        'alert carries no branch label, so routing it either way would describe master using a ' +
        'tree that is not master.',
      failedJobs: [],
    };
  }

  if (runConclusion === 'cancelled') {
    return {
      state: 'skip',
      reason:
        'run was cancelled: on master-health.yml a cancelled run is a concurrency-pending run ' +
        'superseded before dispatch (push never cancels in flight), so it ran no tests and ' +
        'carries no information about master in either direction.',
      failedJobs: [],
    };
  }

  const suite = suiteJobs(jobs);
  const failed = suite.filter((j) => j.conclusion === 'failure');
  if (failed.length > 0) {
    return { state: 'firing', reason: `${failed.length} suite job(s) failed`, failedJobs: failed.map((j) => j.name) };
  }

  // ⛔ `failure` IS NOT THE ONLY NON-SUCCESS A SHARD CAN CARRY. A job-level
  // timeout concludes `timed_out`, an individual shard can be `cancelled`
  // inside a run that was not, and a protection rule leaves `action_required`.
  // Each is a shard whose result is UNKNOWN, and three green shards beside one
  // timed-out shard is not a green master — the unknown one may be exactly the
  // one that was red. So resolution requires every non-skipped row to be
  // `success`: the header's positive-evidence rule applied per-ROW, not
  // per-RUN. These do not FIRE either; an ambiguous shard is not evidence of a
  // failing test, and a standing alert simply keeps standing.
  const unresolved = suite.filter((j) => j.conclusion !== 'success' && j.conclusion !== 'skipped');
  if (unresolved.length > 0) {
    return {
      state: 'skip',
      reason:
        `${unresolved.length} suite job(s) neither succeeded nor were skipped ` +
        `(${unresolved.map((j) => `${j.name}: ${j.conclusion ?? 'no conclusion'}`).join(', ')}). ` +
        'A shard whose result is unknown cannot clear a red that nothing re-tested.',
      failedJobs: [],
    };
  }

  const succeeded = suite.filter((j) => j.conclusion === 'success');
  if (succeeded.length > 0) {
    // ⛔ A REPLAY RESOLVES ONLY AT THE CURRENT master HEAD. `workflow_dispatch`
    // takes an arbitrary run id, so replaying an OLD green run would clear an
    // alert raised by a red that landed AFTER it.
    //
    // A LIVE event is deliberately NOT held to this, and that asymmetry is the
    // point: the arc-paperclip-general queue puts ~3.5h between a push and its
    // verdict, so master has ALWAYS moved on by the time a run concludes.
    // Requiring equality on the live path would not be safer, it would make
    // resolution impossible — every green would skip and the lane would only
    // ever clear on the TTL.
    if (isReplay && (!headSha || !masterHeadSha || headSha !== masterHeadSha)) {
      return {
        state: 'skip',
        reason:
          `replayed run tested ${headSha || 'an unknown head'}, which is not the current ` +
          `${MASTER_BRANCH} head ${masterHeadSha || '(unreadable)'}. A replay of an older green ` +
          'run would clear an alert raised by a red that landed after it.',
        failedJobs: [],
      };
    }
    return {
      state: 'resolved',
      reason: `${succeeded.length} suite job(s) ran and succeeded, and none failed`,
      failedJobs: [],
    };
  }

  // Everything else — an all-skipped matrix (the gate found a merge_group
  // proof), a run that died before dispatching any suite job, or a conclusion
  // this script does not model. Positive evidence is absent, so say nothing.
  return {
    state: 'skip',
    reason:
      `no suite job concluded success or failure (run conclusion: ${runConclusion ?? 'unknown'}; ` +
      `${suite.length} suite job row(s) seen). A skipped matrix still concludes success, so ` +
      'treating this as proof would clear a red that nothing re-tested.',
    failedJobs: [],
  };
}

export function buildAlert({ state, repo, headSha, headBranch, runUrl, detail, now }) {
  const resolved = state === 'resolved';
  // Alertmanager rejects `startsAt >= endsAt` with `400 start time must be
  // before end time`, so a resolved push moves BOTH ends back — the live 400
  // BLO-33382's first cut hit on 2026-09-11.
  const endsAt = resolved ? new Date(now.getTime() - 1000) : new Date(now.getTime() + ALERT_TTL_MS);
  const startsAt = resolved ? new Date(now.getTime() - 2000) : new Date(now);

  return {
    // Stable label set ONLY — see the cardinality note in the file header. No
    // head SHA, no run id, no job name: all are per-occurrence and would
    // fragment the alert identity the Paperclip bridge dedupes on.
    labels: {
      alertname: ALERTNAME,
      severity: 'warning',
      namespace: 'paperclip',
      service: 'paperclip-master-health',
      repo,
    },
    annotations: {
      summary: `master is RED in ${repo}: the Master general tests suite failed on the trunk`,
      description:
        '`master-health.yml` ran the general test suite against the current `master` head and it ' +
        'FAILED. This is a trunk red, not a PR red: every PR whose server shard runs will now ' +
        'fail the required `verify` context, and merge-queue entries will be ejected one at a ' +
        'time, each burning a full build to rediscover the identical failure (BLO-27861).\n\n' +
        'Act on the trunk, not on the PRs. Do NOT push, rebase or `update-branch` an affected PR ' +
        'to clear it — the red is in nobody\'s tree, so a head move cannot clear it, and on this ' +
        'repo it discards the Ally review at that head and spends a scarce human ask for nothing. ' +
        'Land the fix on master, then re-run the failed job head-preservingly on each affected PR.\n\n' +
        'Detection latency here is set by the arc-paperclip-general queue (~3.5h from run ' +
        'creation to the first suite job starting), so the head named below may be several ' +
        'commits behind current master. Every master head contains all earlier ones, so the ' +
        'failure still reproduces on the newer head unless it has already been fixed.',
      head_sha: String(headSha ?? ''),
      head_branch: String(headBranch ?? ''),
      detail: truncateDetail(detail),
      run_url: runUrl,
      runbook_url: 'https://paperclip.blockcast.net/PEN/issues/PEN-6398',
    },
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

function parseJobs(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fail LOUD. An unreadable job list is not an empty one, and silently
    // treating it as empty would downgrade a real red to `skip`.
    throw new Error('MASTER_HEALTH_JOBS_JSON is not valid JSON');
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.jobs)) return parsed.jobs;
  throw new Error('MASTER_HEALTH_JOBS_JSON is neither an array nor an object with a `jobs` array');
}

async function main() {
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY ?? 'unknown/unknown';
  const runUrl = process.env.RUN_URL ?? '';
  const headSha = process.env.HEAD_SHA ?? '';
  const headBranch = process.env.HEAD_BRANCH ?? '';
  const runConclusion = process.env.RUN_CONCLUSION ?? '';
  // Set only on the workflow_dispatch replay path, where the operator chooses
  // the run id and it may be arbitrarily old.
  const isReplay = (process.env.IS_REPLAY ?? '') === 'true';
  const masterHeadSha = process.env.MASTER_HEAD_SHA ?? '';
  const base = (process.env.ALERTMANAGER_URL || DEFAULT_ALERTMANAGER_URL).replace(/\/+$/, '');

  let jobs;
  try {
    jobs = parseJobs(process.env.MASTER_HEALTH_JOBS_JSON);
  } catch (err) {
    console.error(
      `::error::ALERT ROUTING FAILED: ${err.message}. Refusing to decide on an unreadable job ` +
        'list — an unparseable list is not a healthy master.',
    );
    process.exit(1);
  }

  const { state, reason, failedJobs } = decideAlertState({
    runConclusion,
    jobs,
    headBranch,
    headSha,
    isReplay,
    masterHeadSha,
  });

  if (state === 'skip') {
    console.log(`Not routing: ${reason}`);
    return;
  }

  const detail =
    state === 'firing'
      ? `Failing suite jobs at ${headSha || 'the tested head'}:\n` + failedJobs.map((n) => `  - ${n}`).join('\n')
      : `All suite jobs that ran at ${headSha || 'the tested head'} succeeded. ${reason}.`;

  const alert = buildAlert({ state, repo, headSha, headBranch, runUrl, detail, now: new Date() });

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
        'A RED MASTER IS UNROUTED until this is fixed: master-health still reds, but nothing ' +
        'carries that red to a human.',
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

  console.log(
    `Pushed ${alert.labels.alertname} (state=${state}, severity=${alert.labels.severity}) to ${url}; ` +
      `reason: ${reason}; endsAt ${alert.endsAt}.`,
  );
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

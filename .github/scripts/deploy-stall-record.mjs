#!/usr/bin/env node
/**
 * deploy-stall-record.mjs
 *
 * The DURABLE half of the stuck-production-approval escalation (PEN-3315).
 *
 * WHY THIS EXISTS
 * ---------------
 * post-pending-deploy-alert.mjs pushes ProductionDeployApprovalStuck straight to
 * Alertmanager, and that is still the notifying path. But an Alertmanager alert
 * has an `endsAt` — ALERT_TTL_MS is 3h — and once the pushes stop the alert is
 * gone from /api/v2/alerts entirely. PEN-3289 tried to audit the 41.2h stall of
 * 2026-09-14 after it cleared and could not: the same query that returned 5 hits
 * for a live alert returned 0 for this one, because it had expired ~2.5h
 * earlier. An escalation whose only record evaporates three hours after it stops
 * cannot be reviewed after the fact.
 *
 * So each escalation also writes a GitHub issue in this repository,
 * deduplicated on a label so repeated escalations comment rather than re-file.
 * The property being bought is DURABILITY AND AUDITABILITY, not reach — a GitHub
 * issue is not evidence that a human reads it, and PEN-2918 owns that question.
 * It needs only `issues: write` on the existing GITHUB_TOKEN, i.e. no new
 * credential.
 *
 * WHY IT ALSO CARRIES THE STALL CLOCK
 * -----------------------------------
 * PEN-3315 adds supersede-stale-deploy.mjs, which cancels a stale `waiting`
 * dispatch and re-dispatches at master. That is the point of the change, and it
 * has one bad side effect: the replacement run's `createdAt` is NOW, so the
 * escalation's age basis resets on every supersede. A stall outliving
 * SUPERSEDE_AFTER_HOURS (48h since 2026-10-04, BLO-25050; 6h before that) would
 * report as a series of threshold-length stalls rather than one continuously
 * climbing age — and at the 6h this was written against, it also flapped the
 * alert firing/resolved on that cycle. That is a regression in the one control
 * that actually worked during the incident.
 *
 * This record is the state the dispatcher otherwise does not have: it is opened
 * at the FIRST escalation of a stall and carries `stallStartedAt` in a marker
 * comment, so the age survives any number of supersedes. It is closed on the
 * first slot that finds nothing pending, which ends the stall by definition.
 *
 * FAILURE POSTURE
 * ---------------
 * Reads are fatal to the caller that needs them (see post-pending-deploy-alert),
 * because reporting a healthy age from a failed read is the exact silent-green
 * failure PEN-2848 exists to close. Comments made for the audit trail alone are
 * best-effort: losing an annotation must never stop a cancel/dispatch or an
 * Alertmanager push.
 */
import { appendFileSync } from 'node:fs';

/**
 * The production deploy workflow: what the dispatcher dispatches, what
 * supersede cancels, and what the alert points a human at. It lives here
 * because every module in this lane already imports this one, so there is
 * exactly one spelling of it and no new module edge to get it.
 *
 * `scheduled-production-deploy.yml` spells it independently in shell
 * (`--workflow=docker.yml`); the schedule test pins the two together.
 */
export const DEPLOY_WORKFLOW_FILE = 'docker.yml';

export const STALL_LABEL = 'production-deploy-stall';
export const STALL_LABEL_COLOR = 'b60205';
export const STALL_ISSUE_TITLE =
  'Production deploy approval stuck on the paperclip-production reviewer gate';

/**
 * Applied when a supersede EMPTIED the reviewer gate but could not refill it.
 *
 * Without it, the next sampling slot reports `checked-no-pending` — "nothing is
 * on the gate" — and closes this record as resolved, while production is still
 * at the stale commit and nothing has shipped. "A human cleared it" and "we
 * emptied it and could not refill it" produce the identical dispatcher outcome,
 * and only this label separates them.
 */
export const STALL_UNREFILLED_LABEL = 'production-deploy-lane-emptied';
export const STALL_UNREFILLED_LABEL_COLOR = 'd93f0b';

/**
 * Machine-readable state, kept in an HTML comment so it renders as nothing. The
 * version field exists so a future shape change can be detected rather than
 * silently mis-parsed into a wrong — and therefore understated — age.
 */
export const STALL_MARKER_RE = /<!--\s*production-deploy-stall:(\{[\s\S]*?\})\s*-->/;
export const STALL_MARKER_VERSION = 1;

export function renderStallMarker({ stallStartedAt }) {
  return `<!-- production-deploy-stall:${JSON.stringify({
    version: STALL_MARKER_VERSION,
    stallStartedAt,
  })} -->`;
}

/**
 * Returns `{ stallStartedAt }` or null. Null covers absent, malformed, wrong
 * version, and unparseable-timestamp alike: every one of those means "we cannot
 * trust this value", and the caller has a bounded fallback for exactly that.
 * Throwing here would take the escalation down over a cosmetic edit to an issue
 * body, which is a worse outcome than a slightly understated age.
 */
export function parseStallMarker(body) {
  const match = STALL_MARKER_RE.exec(body ?? '');
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (parsed?.version !== STALL_MARKER_VERSION) return null;
  if (!Number.isFinite(Date.parse(parsed?.stallStartedAt))) return null;
  return { stallStartedAt: parsed.stallStartedAt };
}

/**
 * Decide which instant the current stall began.
 *
 * The answer is the EARLIEST defensible one, because every source here can only
 * understate the age and understating is what lets a real stall read as fresh:
 *
 *   marker            - exact. Written at the first escalation of this stall.
 *   issue created_at  - fallback when the marker is missing or unreadable. The
 *                       issue is opened at the first escalation, which by
 *                       construction happens at or after `alertAfterHours`, so
 *                       `created_at - alertAfterHours` is an upper bound on the
 *                       true start. Bounded understatement, never a zero.
 *   oldest waiting    - the run currently on the gate. Correct when no supersede
 *                       has happened, and the only source on a first escalation.
 *   supersede chain   - derived from Actions run history by walking cancelled
 *                       predecessors (deploy-stall-chain.mjs). This is the only
 *                       source that works in THIS repository, where the record
 *                       channel is unavailable by configuration: `has_issues` is
 *                       false, so `POST /issues` is a hard 410 and both
 *                       record-derived sources above are permanently null.
 *
 * Taking the minimum means a supersede cannot move the clock forward, and a
 * hand-edited or deleted marker degrades rather than resets.
 */
export function resolveStallStartedAt({
  marker,
  issueCreatedAt,
  oldestWaitingCreatedAt,
  chainStallStartedAt,
  alertAfterHours,
}) {
  const candidates = [];
  const push = (ms, source) => {
    if (Number.isFinite(ms)) candidates.push({ ms, source });
  };

  push(Date.parse(oldestWaitingCreatedAt), 'oldest-waiting-run');
  push(Date.parse(chainStallStartedAt), 'supersede-chain');
  if (marker) {
    push(Date.parse(marker.stallStartedAt), 'record-marker');
  } else if (issueCreatedAt) {
    const created = Date.parse(issueCreatedAt);
    if (Number.isFinite(created) && Number.isFinite(alertAfterHours)) {
      push(created - alertAfterHours * 3_600_000, 'record-created-at');
    }
  }

  if (candidates.length === 0) return { stallStartedAt: null, source: 'none' };
  candidates.sort((a, b) => a.ms - b.ms);
  return {
    stallStartedAt: new Date(candidates[0].ms).toISOString(),
    source: candidates[0].source,
  };
}

export function renderStallIssueBody({
  stallStartedAt,
  ageHours,
  alertAfterHours,
  pendingRunUrl,
  pendingSince,
  waitingCount,
  repo,
  environment,
  runUrl,
}) {
  return [
    renderStallMarker({ stallStartedAt }),
    '',
    `A \`docker.yml\` deploy has been parked on the \`${environment}\` reviewer gate in ` +
      `\`${repo}\` since **${stallStartedAt}** (${ageHours.toFixed(1)}h; threshold ` +
      `${alertAfterHours}h).`,
    '',
    'While it waits, `scheduled-production-deploy.yml` guard (1) refuses to dispatch anything',
    'newer, so production ships nothing and drift grows. **Approving or rejecting the pending',
    'run is the only thing that ends this.**',
    '',
    `- Pending run: ${pendingRunUrl}`,
    `- That run has been waiting since: ${pendingSince}`,
    `- Deploys currently on the gate: ${waitingCount}`,
    `- Dispatcher run that opened this: ${runUrl || '(unknown)'}`,
    '',
    'This issue is opened by the dispatcher itself and closes automatically on the first',
    'scheduled slot that finds nothing pending. It exists because the Alertmanager alert',
    '(`ProductionDeployApprovalStuck`, severity=critical) expires 3h after the last push and',
    'is then unauditable — see PEN-3315.',
    '',
    'Runbook: https://paperclip.blockcast.net/PEN/issues/PEN-2848',
  ].join('\n');
}

export function renderEscalationComment({
  stallStartedAt,
  ageHours,
  alertAfterHours,
  pendingRunUrl,
  pendingSince,
  runUrl,
}) {
  return [
    `Still stuck: **${ageHours.toFixed(1)}h** since ${stallStartedAt} (threshold ` +
      `${alertAfterHours}h). \`ProductionDeployApprovalStuck\` re-pushed to Alertmanager.`,
    '',
    `- Pending run: ${pendingRunUrl} (waiting since ${pendingSince})`,
    `- Dispatcher run: ${runUrl || '(unknown)'}`,
  ].join('\n');
}

export function renderSupersedeComment({
  cancelledRunUrl,
  cancelledHeadSha,
  cancelledAgeHours,
  masterSha,
  runUrl,
}) {
  return [
    '**Superseded the pending dispatch so the approvable head is current.**',
    '',
    `- Cancelled: ${cancelledRunUrl} — target \`${cancelledHeadSha}\`, ` +
      `${cancelledAgeHours.toFixed(1)}h on the gate`,
    `- Re-dispatched \`docker.yml\` at \`master\` = \`${masterSha}\``,
    `- Dispatcher run: ${runUrl || '(unknown)'}`,
    '',
    'Nothing was approved. A named reviewer still has to press the button — this only means',
    'the button now ships everything on `master` instead of a stale partial. If you were about',
    'to approve the cancelled run, approve the new one instead.',
  ].join('\n');
}

export function renderResolvedComment({ outcome, runUrl }) {
  return [
    `Resolved: the dispatcher found no deploy on the reviewer gate (outcome \`${outcome}\`).`,
    '',
    `Dispatcher run: ${runUrl || '(unknown)'}`,
  ].join('\n');
}

/**
 * Written by the supersede's two failure paths, both of which cancel the stale
 * run and then fail to dispatch a replacement. The lane ends up EMPTY with
 * production unchanged, which the dispatcher reports as `checked-no-pending` —
 * the same outcome a human cancelling the run produces.
 */
export function renderSupersedeFailedComment({ reason, detail, runUrl }) {
  return [
    '**The supersede emptied the reviewer gate but could not refill it.**',
    '',
    `- Reason: \`${reason}\``,
    ...(detail ? [`- Detail: ${detail}`] : []),
    `- Dispatcher run: ${runUrl || '(unknown)'}`,
    '',
    '**Production is still at the stale commit.** Nothing is on the reviewer gate now, so the',
    'escalation stops firing and there is nothing left to approve — but nothing has shipped',
    'either. This record therefore stays OPEN until a dispatch actually lands, so that "a human',
    'cleared it" is never recorded as having happened when it did not.',
    '',
    'The hourly sampling slots exit without dispatching, so the next automatic recovery is the',
    'daily `23 7 * * *` dispatch slot — up to ~24h away. To recover now, re-run',
    '`scheduled-production-deploy.yml` or dispatch `docker.yml` at `master` by hand.',
  ].join('\n');
}

/**
 * Minimal GitHub REST client. `fetchImpl` is injectable so the dedup and
 * create-vs-comment branches are testable without a network.
 */
export function createGitHubClient({
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY,
  apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com',
  fetchImpl = fetch,
} = {}) {
  const base = `${apiUrl.replace(/\/+$/, '')}/repos/${repo}`;

  async function request(method, path, body) {
    if (!token) throw new Error('no GitHub token available (GH_TOKEN / GITHUB_TOKEN)');
    if (!repo) throw new Error('no repository available (GH_REPO / GITHUB_REPOSITORY)');
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    repo,
    request,

    /** Idempotent: a 422 here means the label already exists, which is the goal. */
    async ensureLabel(
      name = STALL_LABEL,
      color = STALL_LABEL_COLOR,
      description = 'Opened by scheduled-production-deploy when an approval is stuck',
    ) {
      try {
        await request('POST', '/labels', { name, color, description });
      } catch (err) {
        if (err.status !== 422) throw err;
      }
    },

    /**
     * Mark an existing record. `POST /issues/{n}/labels` creates a missing label
     * on the fly with an arbitrary colour, so ensureLabel runs first purely to
     * pin the colour; a failure there is not worth losing the mark over.
     */
    async addLabel(issueNumber, name) {
      try {
        await this.ensureLabel(
          name,
          STALL_UNREFILLED_LABEL_COLOR,
          'The dispatcher emptied the reviewer gate and could not refill it',
        );
      } catch {
        // Non-fatal: the label add below creates it anyway.
      }
      return request('POST', `/issues/${issueNumber}/labels`, { labels: [name] });
    },

    /**
     * Deduplicate on the LABEL, not on a title search. The search API is
     * eventually consistent, so a title query can miss an issue opened minutes
     * earlier and file a duplicate on every hourly slot. A label filter reads
     * the issues list directly and is exact.
     */
    async findOpenStallIssue() {
      const issues = await request(
        'GET',
        `/issues?state=open&labels=${encodeURIComponent(STALL_LABEL)}&per_page=100`,
      );
      // `/issues` also returns pull requests; a PR can carry the label too.
      const candidates = (issues ?? []).filter((issue) => !issue.pull_request);
      if (candidates.length === 0) return null;
      // Oldest wins, so a duplicate created by a race is treated as the spare.
      candidates.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      return candidates[0];
    },

    async createStallIssue(body) {
      return request('POST', '/issues', {
        title: STALL_ISSUE_TITLE,
        body,
        labels: [STALL_LABEL],
      });
    },

    async comment(issueNumber, body) {
      return request('POST', `/issues/${issueNumber}/comments`, { body });
    },

    async closeIssue(issueNumber) {
      return request('PATCH', `/issues/${issueNumber}`, {
        state: 'closed',
        state_reason: 'completed',
      });
    },
  };
}

export function setOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${name}=${value}\n`);
}

/**
 * Best-effort annotation. Used by paths whose real job is elsewhere (cancel and
 * re-dispatch, Alertmanager delivery) and which must not fail over a comment.
 */
export async function tryComment(client, issueNumber, body, label) {
  if (!issueNumber) return false;
  try {
    await client.comment(issueNumber, body);
    return true;
  } catch (err) {
    console.log(`::warning::Could not append the ${label} note to issue #${issueNumber}: ${err.message}`);
    return false;
  }
}

/**
 * CLI: `node deploy-stall-record.mjs --resolve`.
 *
 * Runs on every dispatcher slot whose outcome is NOT `skipped-pending` — i.e.
 * `dispatched`, `up-to-date` and `checked-no-pending`, all three of which mean
 * no deploy is sitting on the reviewer gate. That is USUALLY the definition of
 * the stall being over, so the record closes and the next stall starts a fresh
 * clock.
 *
 * The exception is the one the supersede introduced: its two failure paths
 * cancel the stale run and then fail to dispatch, which empties the gate without
 * anything shipping. That reads as `checked-no-pending` too. Those paths label
 * the record STALL_UNREFILLED_LABEL, and an unrefilled record only closes on an
 * outcome that actually refilled the lane (REFILLING_OUTCOMES) — otherwise this
 * would record "a human cleared it" about a stall that is still running.
 *
 * Deliberately non-fatal: this is the audit trail's housekeeping, and failing a
 * green dispatch run over it would make the dispatcher's `conclusion` — which
 * PEN-2848 made load-bearing — mean something else again.
 */
/**
 * True when this record is only "no longer pending" because a supersede emptied
 * the gate and could not refill it. See STALL_UNREFILLED_LABEL.
 */
export function isUnrefilled(issue) {
  return (issue?.labels ?? []).some(
    (label) => (typeof label === 'string' ? label : label?.name) === STALL_UNREFILLED_LABEL,
  );
}

/**
 * The outcomes on which an unrefilled record may still close. `dispatched` means
 * the lane was refilled, `up-to-date` means production is already at master —
 * either way nothing is owed. `checked-no-pending` is the one that means
 * "empty, and we are the reason", so it must not close the record.
 */
export const REFILLING_OUTCOMES = new Set(['dispatched', 'up-to-date']);

/**
 * When did the stall this record describes begin?
 *
 * ⚠️ DELIBERATELY NOT `resolveStallStartedAt`, AND DELIBERATELY NOT THE MARKER
 * IT WRITES. That function takes the EARLIEST defensible instant, because it
 * answers "how old is this stall" and understating an age lets a real stall
 * read as fresh. This answers "which dispatches belong to this stall", where an
 * earlier start admits MORE runs as evidence of a refill — so the conservative
 * direction here is the LATEST defensible instant, not the earliest.
 *
 * The marker looks exact and is not: post-pending-deploy-alert.mjs writes it
 * from `resolveStallStartedAt`, whose candidate set includes the waiting run's
 * own `created_at`. So the marker is at or BEFORE the run W that the supersede
 * later cancelled — and W is precisely the run whose cancellation opened this
 * record. Bounding on the marker therefore admits W itself as evidence that the
 * lane was refilled, which closes the record on the very slot that issues the
 * replacement dispatch: the original PEN-4224 fail-open, rebuilt. (Found by
 * review on this change's first head; the first version of this function called
 * the marker "exact" and used it.)
 *
 * The record's own `created_at` is used instead, RAW. The record is opened at
 * the first escalation, which happens at or AFTER the true start — so it is a
 * genuine upper bound, where the marker is a lower one. Note
 * `resolveStallStartedAt` subtracts `alertAfterHours` from this same value to
 * reach back toward the true start — exactly the widening to avoid here.
 *
 * ⚠️ THIS BOUND ALONE DOES NOT EXCLUDE EVERY SUPERSEDED RUN, and it must not be
 * credited with doing so. It excludes the FIRST one, because W1 is what
 * escalated and so predates the record. But the record SURVIVES across
 * supersedes (`findOpenStallIssue` returns the oldest open one), so the lane
 * can go: W1 escalates and opens the record → a supersede cancels W1 and
 * dispatches W2 successfully → a later supersede cancels W2 and fails to
 * dispatch, which is what applies the label. W2 was created AFTER the record
 * and passes this bound. What rejects W2 is the OTHER conjunct in
 * `laneRefilled`: its `deploy` job concluded `cancelled`, so no deploy
 * executed. The two conjuncts are JOINTLY required and neither is redundant —
 * this one does not depend on job-list readability, that one does not depend on
 * clocks or on how many supersedes a stall has been through.
 *
 * `null` when it is unreadable, which blocks the close — see `laneRefilled`.
 */
export function recordStallStartedAt(issue) {
  return Number.isFinite(Date.parse(issue?.created_at)) ? issue.created_at : null;
}

/**
 * Did the lane actually get refilled?
 *
 * `REFILLING_OUTCOMES` alone answers this from the dispatcher's OWN DECISION,
 * and PEN-4224 showed that decision can be wrong about its own consequence:
 * `dispatched` asserts "the lane was refilled" when what happened is "a dispatch
 * was ISSUED". On 2026-10-17 a dispatch was issued and the lane was never
 * refilled, because the run it created failed `build-and-push` in 84s with
 * `deploy` skipped. Closing an unrefilled record on that would write "resolved,
 * nothing is on the reviewer gate" over a stall that is still running — the
 * identical fail-open that STALL_UNREFILLED_LABEL exists to prevent, arriving
 * through the one outcome the label's own check waves through.
 *
 * ⛔ THE OBSERVED FATE CANNOT DESCRIBE THE DISPATCH THIS SLOT JUST ISSUED, and
 * the first version of this guard got that wrong. detect-dead-dispatch.mjs runs
 * ONCE per slot, inside guard (1c) — before guard (2) and before the step that
 * issues the day's dispatch. So on a `dispatched` slot the observation
 * necessarily describes the PREVIOUS completed run; the run this slot created
 * has not started, let alone completed. A guard that merely refused an
 * affirmative `died-before-deploy` therefore proved nothing about the dispatch
 * it was gating: replay the 2026-10-17 timeline and the 07:31 slot reads the
 * healthy 10-16 dispatch as refilling and closes the record anyway.
 *
 * So the gate is positive evidence, time-bounded, and `dispatched` never clears
 * it on the slot that issues it:
 *
 *   up-to-date  - closes unconditionally. It is its OWN evidence: guard (2)
 *                 emits it only when a `deploy` job SUCCEEDED at exactly
 *                 master's head, so production demonstrably has the commits.
 *                 Nothing is owed and no corroboration is available or needed.
 *   dispatched  - closes only when a LATER slot observes the lane's last
 *                 completed dispatch to have actually EXECUTED its `deploy` job
 *                 AND that run was created strictly after this stall began.
 *                 BOTH conjuncts are load-bearing: a second-or-later superseded
 *                 run post-dates the record and is caught only by the first,
 *                 while a healthy pre-stall deploy executed and is caught only
 *                 by the second. See `recordStallStartedAt`.
 *
 * ⚠️ THE EVIDENCE IS `deployExecuted`, NOT THE FATE, and the distinction is
 * load-bearing. The detector's `survived` is a catch-all meaning "not a death I
 * may claim" — it also covers a `cancelled` run whose deploy never ran (a
 * supersede's normal operation) and a `success` run whose deploy was SKIPPED by
 * the pending guard. Neither refilled anything. Gating on the fate let both
 * close an unrefilled record; see DEPLOY_EXECUTED_CONCLUSIONS for the strict
 * signal this reads instead.
 *
 * DIRECTION OF ERROR, and it is the opposite of the first version's. Absent
 * evidence of an executed deploy, an unreadable run time or an unreadable stall
 * start all BLOCK the close now, because the gate asks for proof rather than
 * for the absence of a disproof. A record that never closes is still its own
 * kind of lie — it carries a dead stall's clock into the next, unrelated one —
 * so this is only tolerable because the record has a second exit that depends
 * on none of those reads: once production catches up, the next slot is
 * `up-to-date` and closes it outright. The cost of a missed close is therefore
 * a record that closes one slot late, not one that never closes.
 *
 * ⚠️ Inert on Blockcast/paperclip today — `has_issues: false`, so no record is
 * ever created for this to act on. PEN-4224 recorded the original fail-open as
 * found by READING, not as an incident, and it and both corrections ship with
 * tests rather than a postmortem. It is live wiring for repositories with
 * Issues enabled.
 */
export function laneRefilled({
  outcome,
  lastDispatchDeployExecuted,
  lastDispatchAt,
  stallStartedAt,
} = {}) {
  if (!REFILLING_OUTCOMES.has(outcome)) return false;
  if (outcome !== 'dispatched') return true;

  // The workflow passes a string; only the literal `true` is evidence.
  if (lastDispatchDeployExecuted !== true && lastDispatchDeployExecuted !== 'true') return false;
  const observedAt = Date.parse(lastDispatchAt ?? '');
  const stallStart = Date.parse(stallStartedAt ?? '');
  if (!Number.isFinite(observedAt) || !Number.isFinite(stallStart)) return false;
  // Strictly after: the record is opened while the superseded run is still on
  // the gate, so an inclusive bound would re-admit that run.
  return observedAt > stallStart;
}

async function resolveMain() {
  const outcome = process.env.DISPATCH_OUTCOME || '(unknown)';
  const runUrl = process.env.RUN_URL ?? '';
  const client = createGitHubClient();

  let open;
  try {
    open = await client.findOpenStallIssue();
  } catch (err) {
    console.log(`::warning::Could not look up the deploy-stall record to close it: ${err.message}`);
    return;
  }
  if (!open) {
    console.log('No open production-deploy-stall record to close.');
    return;
  }

  const lastDispatchDeployExecuted = process.env.LAST_DISPATCH_DEPLOY_EXECUTED || '';
  const lastDispatchAt = process.env.LAST_DISPATCH_AT || '';
  const stallStartedAt = recordStallStartedAt(open);
  if (
    isUnrefilled(open) &&
    !laneRefilled({ outcome, lastDispatchDeployExecuted, lastDispatchAt, stallStartedAt })
  ) {
    // Closing here would write "Resolved: the dispatcher found no deploy on the
    // reviewer gate" onto a stall that is not over — production is still at the
    // stale commit, and the gate is empty because WE emptied it. Stay open and
    // stay quiet: the supersede-failure comment already explains why, and this
    // path runs hourly, so commenting each time would bury it.
    console.log(
      `::warning::Not closing the production-deploy-stall record #${open.number}: it is ` +
        `labelled \`${STALL_UNREFILLED_LABEL}\`, so outcome \`${outcome}\` means "nothing ` +
        'pending because a supersede emptied the gate and could not refill it", not "a human ' +
        'cleared it". Production has not shipped. It closes on the first `up-to-date` slot, or ' +
        'on a later slot that OBSERVES a dispatch surviving into the `deploy` job — the fate ' +
        'read on a `dispatched` slot describes the PREVIOUS run, never the one just issued ' +
        `(last observed dispatch: deploy executed = \`${lastDispatchDeployExecuted || 'unreported'}\`, ` +
        `run created \`${lastDispatchAt || 'unreported'}\`; this stall began ` +
        `\`${stallStartedAt || 'unreadable'}\`).`,
    );
    return;
  }

  await tryComment(client, open.number, renderResolvedComment({ outcome, runUrl }), 'resolution');
  try {
    await client.closeIssue(open.number);
    console.log(`Closed the production-deploy-stall record #${open.number} (outcome ${outcome}).`);
  } catch (err) {
    console.log(`::warning::Could not close issue #${open.number}: ${err.message}`);
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--resolve')) {
    console.error('::error::deploy-stall-record.mjs is only executable with --resolve.');
    process.exit(1);
  }
  resolveMain().catch((err) => {
    console.log(`::warning::deploy-stall-record --resolve failed unexpectedly: ${err?.stack ?? err}`);
  });
}

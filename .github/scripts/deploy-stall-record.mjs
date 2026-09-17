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
 * escalation's age basis resets on every supersede. A 41h stall would report as
 * a series of 6.0h stalls, and the alert would flap firing/resolved on a ~6h
 * cycle instead of firing continuously with a climbing age. That is a regression
 * in the one control that actually worked during the incident.
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

export const STALL_LABEL = 'production-deploy-stall';
export const STALL_LABEL_COLOR = 'b60205';
export const STALL_ISSUE_TITLE =
  'Production deploy approval stuck on the paperclip-production reviewer gate';

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
 *
 * Taking the minimum means a supersede cannot move the clock forward, and a
 * hand-edited or deleted marker degrades rather than resets.
 */
export function resolveStallStartedAt({
  marker,
  issueCreatedAt,
  oldestWaitingCreatedAt,
  alertAfterHours,
}) {
  const candidates = [];
  const push = (ms, source) => {
    if (Number.isFinite(ms)) candidates.push({ ms, source });
  };

  push(Date.parse(oldestWaitingCreatedAt), 'oldest-waiting-run');
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
    async ensureLabel() {
      try {
        await request('POST', '/labels', {
          name: STALL_LABEL,
          color: STALL_LABEL_COLOR,
          description: 'Opened by scheduled-production-deploy when an approval is stuck',
        });
      } catch (err) {
        if (err.status !== 422) throw err;
      }
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
 * no deploy is sitting on the reviewer gate. That is the definition of the stall
 * being over, so the record closes and the next stall starts a fresh clock.
 *
 * Deliberately non-fatal: this is the audit trail's housekeeping, and failing a
 * green dispatch run over it would make the dispatcher's `conclusion` — which
 * PEN-2848 made load-bearing — mean something else again.
 */
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

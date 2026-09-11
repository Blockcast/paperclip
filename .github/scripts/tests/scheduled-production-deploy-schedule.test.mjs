// BLO-33400: the approval-age escalation must sample far more often than it
// dispatches. It used to do both on one daily cron, so PENDING_DEPLOY_ALERT_HOURS
// (6h) was evaluated once per 24h. Measured live on Blockcast/paperclip:
//
//   late   - docker.yml dispatch 34324444180 sat 27.8h on the reviewer gate; the
//            alert fired at 24.0h, 4x its own threshold.
//   silent - dispatch 34561898524 sat 15h28m (2026-09-11 04:21Z -> 19:50Z) and was
//            cancelled between samples. The single 07:23 sample caught it at 3h10m,
//            so ProductionDeployApprovalStuck never fired at all.
//
// The fix is a schedule, not new logic, which is exactly why it needs a test: every
// invariant below is one careless edit away and none of them fail loudly. A workflow
// that samples on the wrong cadence still runs green forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectStuckApproval } from '../post-pending-deploy-alert.mjs';

const WORKFLOW = 'scheduled-production-deploy.yml';
const DAILY_CRON = '23 7 * * *';
const SAMPLING_CRON = '23 0-6,8-23 * * *';

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../workflows',
  WORKFLOW,
);
const workflow = readFileSync(workflowPath, 'utf8');

// Every assertion below is about what the workflow DOES. The file's comments
// discuss these same cron strings and outcomes by name to explain why they are
// what they are, so matching against raw text would let the explanation of a rule
// satisfy the rule. Same hazard, and same remedy, as soak-workflow-triggers.
const code = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const crons = [...code.matchAll(/^\s*- cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);

/** Expand a cron hour field ("7", "*", "0-6,8-23") to the hours it matches. */
const hours = (cron) => {
  const field = cron.split(/\s+/)[1];
  if (field === '*') return new Set(Array.from({ length: 24 }, (_, h) => h));
  const out = new Set();
  for (const part of field.split(',')) {
    const [lo, hi = lo] = part.split('-').map(Number);
    for (let h = lo; h <= hi; h += 1) out.add(h);
  }
  return out;
};

test('workflow carries both a daily dispatch cron and an hourly sampling cron', () => {
  assert.deepEqual(crons, [DAILY_CRON, SAMPLING_CRON]);
});

test('the two crons never match the same minute', () => {
  // GitHub fires one run per MATCHING cron entry, so "23 * * * *" alongside the
  // daily entry would queue a redundant second run against the concurrency group
  // at 07:23 every day — harmless but confusing, and it makes `gh run list`
  // output unreadable for exactly the audit this workflow exists to support.
  const overlap = [...hours(DAILY_CRON)].filter((h) => hours(SAMPLING_CRON).has(h));
  assert.deepEqual(overlap, [], `crons overlap at hour(s) ${overlap.join(',')}`);

  // And between them they cover every hour: a gap would be a window in which a
  // gate crossing the threshold goes unsampled for 2h+.
  const covered = new Set([...hours(DAILY_CRON), ...hours(SAMPLING_CRON)]);
  assert.equal(covered.size, 24, 'the two crons must cover all 24 hours');
});

test('the dispatch-slot guard names the daily cron literally', () => {
  // This is the silent-failure guard. IS_DISPATCH_SLOT compares against the cron
  // STRING, so editing `- cron:` without editing the comparison would make every
  // slot a sampling slot and the daily dispatch would simply stop happening —
  // green, forever, with production drifting. Nothing else would notice.
  const match = code.match(/IS_DISPATCH_SLOT:\s*\$\{\{(.+?)\}\}/s);
  assert.ok(match, 'dispatch step must set IS_DISPATCH_SLOT');
  assert.ok(
    match[1].includes(`github.event.schedule == '${DAILY_CRON}'`),
    `IS_DISPATCH_SLOT must compare github.event.schedule to '${DAILY_CRON}'`,
  );
  // A manual kick is not a scheduled event and must still dispatch.
  assert.ok(
    match[1].includes("github.event_name != 'schedule'"),
    'workflow_dispatch must remain a dispatching path',
  );
});

test('a sampling slot can reach the escalation but never reaches the dispatch', () => {
  const at = (needle) => {
    const i = code.indexOf(needle);
    assert.notEqual(i, -1, `expected to find ${JSON.stringify(needle)} in ${WORKFLOW}`);
    return i;
  };
  // The shell dereference, NOT the bare name: `IS_DISPATCH_SLOT:` also appears in
  // the step's `env:` block above the script, so anchoring on the name would
  // measure the declaration's position and pass no matter where the guard sits.
  const GUARD = '"$IS_DISPATCH_SLOT"';

  // ORDER IS THE WHOLE FIX. Guard (1) emits `skipped-pending`, and that output is
  // what arms the escalation step. If the IS_DISPATCH_SLOT early-return is moved
  // above it, sampling slots exit before the pending check and the 6h threshold
  // goes back to being evaluated once per 24h — the original defect, restored by
  // a change that reads like a tidy-up.
  assert.ok(
    at('outcome=skipped-pending') < at(GUARD),
    'the pending-approval check must run BEFORE the sampling-slot early return',
  );

  // ...and the dispatch must sit after it, so a sampling slot cannot reach it.
  assert.ok(
    at(GUARD) < at('gh workflow run docker.yml'),
    'the sampling-slot early return must guard the docker.yml dispatch',
  );
});

test('the escalation is armed by the pending outcome, not by the cron', () => {
  // Both the Node setup and the escalation gate on `skipped-pending` — the one
  // condition every slot can reach. Gating either on the event or the cron would
  // silently re-couple sampling to the dispatch cadence.
  const gates = [...code.matchAll(/if:\s*steps\.dispatch\.outputs\.outcome\s*==\s*'([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(gates, ['skipped-pending', 'skipped-pending']);

  assert.ok(
    /if:\s*steps\.escalate\.outputs\.escalated\s*==\s*'true'/.test(code),
    'the red-run backstop must stay gated on the escalation actually firing',
  );
});

// Replay of the incident, against both cadences. This is the assertion that
// actually encodes the defect: the workflow-shape tests above would all have
// passed on the old daily-only schedule, because nothing about that schedule is
// malformed — it is merely too slow to observe the thing it measures.
test('replay 2026-09-11: hourly sampling catches the gate the daily cron structurally could not', () => {
  // Real values, docker.yml workflow_dispatch run 34561898524.
  const GATE = {
    databaseId: 34561898524,
    status: 'waiting',
    createdAt: '2026-09-11T04:21:32Z',
    url: 'https://github.com/Blockcast/paperclip/actions/runs/34561898524',
  };
  const CANCELLED_AT = Date.parse('2026-09-11T19:50:08Z');
  const THRESHOLD_HOURS = 6; // PENDING_DEPLOY_ALERT_HOURS default

  // Every :23 slot the gate was actually alive for, per cadence.
  const slotsWhileWaiting = (dispatchHoursOnly) =>
    Array.from({ length: 24 }, (_, h) => Date.parse(`2026-09-11T${String(h).padStart(2, '0')}:23:00Z`))
      .filter((t) => t > Date.parse(GATE.createdAt) && t < CANCELLED_AT)
      .filter((t) => !dispatchHoursOnly || new Date(t).getUTCHours() === 7);

  const escalations = (slots) =>
    slots.filter(
      (t) =>
        selectStuckApproval({
          pendingRuns: [GATE],
          alertAfterHours: THRESHOLD_HOURS,
          now: new Date(t),
        }).stuck,
    );

  // BEFORE: the daily cron gave exactly one sample, at 07:23, when the gate was
  // 3h02m old — under the 6h threshold. Zero escalations across 15h28m of a
  // production deploy parked on a human. This is the measured miss.
  const dailyOnly = slotsWhileWaiting(true);
  assert.equal(dailyOnly.length, 1, 'the daily cron sampled this gate exactly once');
  assert.deepEqual(escalations(dailyOnly), [], 'and that single sample was under threshold');

  // AFTER: the gate crosses 6h at 10:21:32Z and the very next sampling slot is
  // 10:23Z, so detection lands 2 minutes past the threshold rather than never.
  // Every slot from there to cancellation re-pushes, keeping the alert firing.
  const fired = escalations(slotsWhileWaiting(false));
  assert.ok(fired.length > 0, 'hourly sampling must escalate this gate at all');
  assert.equal(new Date(fired[0]).toISOString(), '2026-09-11T10:23:00.000Z');

  const latencyHours = (fired[0] - Date.parse(GATE.createdAt)) / 3_600_000;
  assert.ok(
    latencyHours < THRESHOLD_HOURS + 1,
    `detection must land within one sample period of the threshold, was ${latencyHours}h`,
  );
});

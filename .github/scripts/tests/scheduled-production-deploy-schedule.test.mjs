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
  // The escalation gates on `skipped-pending` — the one condition every slot can
  // reach. Gating it on the event or the cron would silently re-couple sampling
  // to the dispatch cadence. (The supersede added by PEN-3315 gates on the same
  // outcome behind a `!cancelled() &&`, asserted separately below.)
  const gates = [...code.matchAll(/if:\s*steps\.dispatch\.outputs\.outcome\s*==\s*'([^']+)'/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(gates, ['skipped-pending']);

  assert.ok(
    /if:\s*steps\.escalate\.outputs\.escalated\s*==\s*'true'/.test(code),
    'the red-run backstop must stay gated on the escalation actually firing',
  );
});

test('node is set up unconditionally, so the record-closing path is not silently skipped', () => {
  // PEN-3315 made this unconditional. `node` is not on the arc-deploy image's
  // PATH for `run:` steps, and the close step runs on the three NON-pending
  // outcomes — the exact outcomes the old `skipped-pending` gate excluded. Left
  // conditional, the close would fail `command not found` on every slot that was
  // supposed to run it, and one open record would carry its clock into the next,
  // unrelated stall.
  const setup = code.match(/- name: Set up Node\n(?:.*\n)*?\s+uses: actions\/setup-node/);
  assert.ok(setup, 'the workflow must still pin setup-node rather than trust a bare `node`');
  assert.ok(
    !/- name: Set up Node\n\s+if:[^\n]*steps\.dispatch\.outputs\.outcome/.test(code),
    'setup-node must not be gated on a dispatch outcome',
  );
});

// ---------------------------------------------------------------------------
// PEN-3315: guard (1)'s bounded exit, and the durable record.
//
// Guard (1) is correct and stays. What it never had was a way to END a wait —
// the only exit was a human. These pin the three things that make the supersede
// safe to leave running unattended: it is armed by the same condition as the
// escalation, it approves nothing, and it cannot be starved by an Alertmanager
// outage.
// ---------------------------------------------------------------------------

const stepIndex = (needle) => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `expected to find ${JSON.stringify(needle)} in ${WORKFLOW}`);
  return i;
};

test('the supersede runs AFTER the escalation, so the alert reports the pre-supersede run', () => {
  // Order matters twice. The durable record must exist before the supersede can
  // annotate it, and the Alertmanager alert must describe the run a reviewer was
  // actually looking at rather than the replacement dispatched seconds earlier.
  assert.ok(
    stepIndex('id: escalate') < stepIndex('id: supersede'),
    'the escalation must run before the supersede',
  );
  assert.ok(
    stepIndex('id: supersede') < stepIndex('supersede-stale-deploy.mjs'),
    'the supersede step id must belong to the supersede script step',
  );
});

test('the supersede survives a failed escalation — Alertmanager must not freeze the deploy lane', () => {
  // post-pending-deploy-alert is fatal on a failed push, by design. If the
  // supersede were `success()`-gated, an Alertmanager outage would ALSO stop the
  // lane being unblocked — coupling the repair to the notification, which is the
  // shape of defect this row is about.
  const step = code.slice(stepIndex('id: supersede'), stepIndex('supersede-stale-deploy.mjs'));
  assert.match(
    step,
    /if:\s*\$\{\{\s*!cancelled\(\)\s*&&\s*steps\.dispatch\.outputs\.outcome == 'skipped-pending'\s*\}\}/,
    'the supersede must be gated on !cancelled() && skipped-pending',
  );
});

test('the supersede reuses PENDING_DEPLOY_ALERT_HOURS — no second tunable', () => {
  // A separate threshold would let the two drift apart, so a slot could escalate
  // without superseding (or supersede a run nobody was told about). One signal,
  // one number.
  const step = code.slice(stepIndex('id: supersede'), stepIndex('supersede-stale-deploy.mjs'));
  assert.match(step, /ALERT_AFTER_HOURS:\s*\$\{\{\s*vars\.PENDING_DEPLOY_ALERT_HOURS/);
  assert.match(
    step,
    /MASTER_SHA:\s*\$\{\{\s*steps\.dispatch\.outputs\.master_sha\s*\}\}/,
    'the supersede must judge staleness against the master head guard (1) read',
  );
});

test('master_sha is published BEFORE guard (1) can exit, or the supersede has no master to compare', () => {
  // Guard (1)'s `skipped-pending` branch exits early, and that branch is the only
  // one the supersede ever runs on. A master_sha written after it would always be
  // empty exactly when it is needed, and the supersede would refuse forever while
  // looking correctly configured.
  assert.ok(
    stepIndex('master_sha=$MASTER_SHA') < stepIndex('outcome=skipped-pending'),
    'master_sha must be written before the skipped-pending early exit',
  );
});

test('the supersede APPROVES NOTHING — the red backstop stays gated on the escalation', () => {
  // The 2026-08-28 rejection of auto-approval is untouched: "three green guards
  // prove the code builds, not that a human intends to ship it". Refreshing the
  // head is not a human acting, so the run must stay red for as long as the
  // approval is outstanding. Gating the backstop on the SUPERSEDE instead would
  // turn a superseded stall green and hide it.
  assert.ok(
    /if:\s*steps\.escalate\.outputs\.escalated\s*==\s*'true'/.test(code),
    'the red-run backstop must stay gated on the escalation, not the supersede',
  );
  assert.ok(
    !/if:[^\n]*steps\.supersede\.outputs\.superseded/.test(code),
    'no step may be gated on the supersede having fired',
  );
  // And nothing in this workflow may touch the environment approval endpoint —
  // that is the line between "refresh the head" and "press the button".
  assert.ok(
    !/pending_deployments/.test(code),
    'the dispatcher must never reach for the environment approval API',
  );
});

test('the durable record is closed on every outcome that means nothing is pending', () => {
  // `dispatched`, `up-to-date` and `checked-no-pending` all mean the reviewer
  // gate is clear, which ends the stall by definition. Without a close, one open
  // record would carry its stall clock into the next, unrelated stall and report
  // it as days old from the first slot.
  const close = code.match(/- name: Close the durable deploy-stall record[\s\S]*?--resolve/);
  assert.ok(close, 'the workflow must close the stall record');
  assert.match(
    close[0],
    /steps\.dispatch\.outputs\.outcome != '' && steps\.dispatch\.outputs\.outcome != 'skipped-pending'/,
    'the close must run on the non-pending outcomes, and not on an empty outcome',
  );
});

test('the workflow grants exactly the permissions the new paths need, and no more', () => {
  // `issues: write` is the entire credential cost of the durable record — the
  // reason a GitHub issue was chosen over any external store. `actions: write`
  // was already there for the dispatch and now also covers the cancel. Anything
  // beyond these two on a workflow that holds a deploy dispatch is worth a stop.
  const block = code.split(/^permissions:\n/m)[1] ?? '';
  const granted = [];
  for (const line of block.split('\n')) {
    if (!/^ {2}\S/.test(line)) break; // first non-entry line ends the block
    const entry = line.replace(/#.*$/, '').trim();
    if (entry) granted.push(entry);
  }
  assert.deepEqual(granted, ['contents: read', 'actions: write', 'issues: write']);
});

// PEN-3315. The supersede resets the pending run's age by construction — it
// cancels one run and creates another — so the escalation's clock has to come
// from somewhere that outlives a run. Without this, a 41h stall reports as a
// train of 6.0h ones and the critical alert flaps firing/resolved on the
// threshold instead of firing continuously with a climbing age. That would be a
// regression in the one control that demonstrably worked during the incident.
test('a supersede cannot reset the escalation clock', () => {
  const STALL_START = '2026-09-14T19:55:57.000Z';
  const NOW = new Date('2026-09-16T13:00:00.000Z'); // ~41h into the real stall
  // The replacement run, dispatched 20 minutes ago by the supersede.
  const FRESH = {
    databaseId: 35100812969,
    status: 'waiting',
    createdAt: '2026-09-16T12:40:00.000Z',
    url: 'https://github.com/Blockcast/paperclip/actions/runs/35100812969',
  };

  // Without the recorded stall start, the escalation sees a 20-minute-old run
  // and reports a healthy gate in the middle of a 41-hour outage.
  const runOnly = selectStuckApproval({
    pendingRuns: [FRESH],
    alertAfterHours: 6,
    now: NOW,
  });
  assert.equal(runOnly.stuck, false, 'this is the regression the record exists to prevent');

  const withRecord = selectStuckApproval({
    pendingRuns: [FRESH],
    alertAfterHours: 6,
    now: NOW,
    stallStartedAt: STALL_START,
  });
  assert.equal(withRecord.stuck, true);
  assert.ok(withRecord.ageHours > 41 && withRecord.ageHours < 42);
  assert.equal(withRecord.stallStartedAt, STALL_START);
});

test('the recorded stall start can only move the clock EARLIER, never later', () => {
  // A record left open by a failed close must not be able to SHORTEN a real
  // stall. The basis is the minimum of the two, so a record that is somehow
  // younger than the run on the gate is simply ignored.
  const verdict = selectStuckApproval({
    pendingRuns: [
      {
        databaseId: 1,
        status: 'waiting',
        createdAt: '2026-09-01T02:00:00.000Z',
        url: 'https://github.com/Blockcast/paperclip/actions/runs/1',
      },
    ],
    alertAfterHours: 6,
    now: new Date('2026-09-01T12:00:00.000Z'),
    stallStartedAt: '2026-09-01T11:00:00.000Z',
  });

  assert.equal(verdict.ageHours, 10);
  assert.equal(verdict.stallStartedAt, '2026-09-01T02:00:00.000Z');
});

test('an unreadable recorded stall start degrades to the run, it does not disable the escalation', () => {
  // The value comes from a marker in an issue body that a human can edit. Going
  // fatal there would take the escalation down over a cosmetic change; ignoring
  // it costs precision only, and only until the next slot rewrites the marker.
  const verdict = selectStuckApproval({
    pendingRuns: [
      {
        databaseId: 1,
        status: 'waiting',
        createdAt: '2026-09-01T02:00:00.000Z',
        url: 'https://github.com/Blockcast/paperclip/actions/runs/1',
      },
    ],
    alertAfterHours: 6,
    now: new Date('2026-09-01T12:00:00.000Z'),
    stallStartedAt: 'not-a-date',
  });

  assert.equal(verdict.stuck, true);
  assert.equal(verdict.ageHours, 10);
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

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
import { DEPLOY_WORKFLOW_FILE, REFILLING_OUTCOMES } from '../deploy-stall-record.mjs';

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

/**
 * Guard (1) only: everything before it emits `outcome=skipped-pending`.
 *
 * Guard (2)'s `gh run list` is deliberately outside this region. A stale read
 * there causes a redundant dispatch; a stale read in guard (1) causes a MISSED
 * one, which is the BLO-38907 defect.
 */
const pendingReadRegion = (() => {
  const end = code.indexOf('outcome=skipped-pending');
  if (end === -1) throw new Error('expected guard (1) to emit outcome=skipped-pending');
  return code.slice(0, end);
})();

/**
 * Just the read itself: the `gh api` reads through the `jq -s` that writes
 * `$PENDING_JSON_PATH`. The query/status assertions scope HERE, not to the whole
 * region, because the region also holds the step-summary line
 * `WAITING="$(jq '[.[] | select(.status == "waiting")] | length' ...)"`. That line
 * always contributes `waiting`, so a filter rewritten in a form the derivation
 * cannot read (`IN(...)`, `test("x")`) still yields a non-empty `counted` — the
 * `counted.length > 0` fail-safe never fires, and `queued`/`in_progress` quietly
 * lose their second source. Scoping to the pipeline is what lets that guard fire.
 */
const pendingReadPipeline = () => {
  // Anchor the start to the brace group that feeds `jq -s`, NOT the first `gh api`
  // in the region. A diagnostic read placed before the group — say a `per_page=1`
  // count for the step summary — otherwise lands inside the slice and satisfies the
  // per-status query requirement on the union's behalf, so a real union member can
  // be dropped and the suite stays green. Measured at 4c85cde3: the diagnostic alone
  // is 26/0 and dropping `status=waiting` alone is 25/1, but anchored at the first
  // `gh api` the two TOGETHER are 26/0 — leaving `waiting` single-sourced on the read
  // measured to go stale, which is BLO-38907 itself. Anchored here, both are 25/1.
  // A missing `} | jq -s` needs no separate arm: indexOf returns -1, lastIndexOf
  // clamps that fromIndex to 0, and the region never starts with `{`, so `start`
  // is -1 and the check below throws. Verified — an explicit -1 arm has no failing
  // mutation, so it would be decoration (2026-09-17 CEO ruling on guard tests).
  // Derived lazily, not at module scope: a broken boundary should fail THIS test,
  // not abort the import and take the other 25 guards' signal with it — which is
  // what happens when the read is restructured, i.e. when that signal is most wanted.
  const start = pendingReadRegion.lastIndexOf('{', pendingReadRegion.indexOf('} | jq -s'));
  const end = pendingReadRegion.indexOf('> "$PENDING_JSON_PATH"');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'expected guard (1) to pipe a `{ ... } | jq -s` brace group of `gh api` reads into "$PENDING_JSON_PATH"',
    );
  }
  return pendingReadRegion.slice(start, end);
};

/**
 * The entries of the workflow's TOP-LEVEL `permissions:` block, in order.
 *
 * Scoped deliberately. Matching `actions:\s*write` against the whole file lets a
 * grant declared in an unrelated job — or merely discussed in a comment — satisfy
 * an assertion whose message claims the workflow itself holds it. Parsed from
 * `code`, so the header's own prose about these permissions cannot stand in for
 * them either.
 */
const topLevelPermissions = (() => {
  const block = code.split(/^permissions:\n/m)[1] ?? '';
  const granted = [];
  for (const line of block.split('\n')) {
    if (!/^ {2}\S/.test(line)) break; // first non-entry line ends the block
    const entry = line.replace(/#.*$/, '').trim();
    if (entry) granted.push(entry);
  }
  return granted;
})();

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
  // supposed to run it, and with no `continue-on-error` that fails the run.
  //
  // On THIS repository there is no record for that close to act on
  // (`has_issues: false`; see the workflow's escalation step), and the stall
  // clock is derived from run history (deploy-stall-chain.mjs), so the red run is
  // what this pin prevents here. Until 2026-10-05 this comment ended "and one
  // open record would carry its clock into the next, unrelated stall".
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
// safe to leave running unattended: it is armed by its own threshold, separate
// from the escalation (BLO-25050), it approves nothing, and it cannot be starved
// by an Alertmanager outage.
//
// "The durable record" in this banner is PEN-3315's design, not this
// repository's state: Blockcast/paperclip has `has_issues: false`, so the record
// write returns 410 and none ever exists here, and the stall clock comes from
// deploy-stall-chain.mjs. Until 2026-10-05 the banner carried no such
// qualification. The record wiring below is still pinned because
// deploy-stall-record.mjs keeps it for repositories with Issues enabled.
// ---------------------------------------------------------------------------

const stepIndex = (needle) => {
  const i = code.indexOf(needle);
  assert.notEqual(i, -1, `expected to find ${JSON.stringify(needle)} in ${WORKFLOW}`);
  return i;
};

test('the supersede runs AFTER the escalation, so the alert reports the pre-supersede run', () => {
  // The Alertmanager alert must describe the run a reviewer was actually looking
  // at rather than the replacement dispatched seconds earlier, and a durable
  // record, where one exists, can then be annotated by the supersede. On THIS
  // repository none does (`has_issues: false`), so STALL_ISSUE_NUMBER is always
  // empty here and the alert is why this ordering is pinned. Until 2026-10-05
  // this comment opened "Order matters twice. The durable record must exist
  // before the supersede can annotate it".
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

test('the supersede and the escalation read SEPARATE thresholds (BLO-25050)', () => {
  // This test used to assert the opposite — "the supersede reuses
  // PENDING_DEPLOY_ALERT_HOURS — no second tunable" — on the reasoning that a
  // separate threshold would let the two drift apart, so a slot could escalate
  // without superseding. One signal, one number.
  //
  // Escalating without superseding turns out to be CORRECT, because the gate
  // acquired a second consumer after that was written: a Paperclip board card
  // pins to the waiting run id via payload.gate and is retired by the BLO-29359
  // reconciler when that run terminates. A 6h supersede therefore destroys the
  // card's handle before the board can reach it. Measured 2026-10-04 on this
  // repo: three consecutive gate-holder runs lived 7.04h / 6.71h / 7.40h against
  // a 45.7h median time-to-decision for agent-requested cards (n=24, p25 27.7h,
  // p75 213h; only 4 of 24 decided inside 7h). The ask was unanswerable through
  // that channel by construction, and BLO-25050 sat 13 days while production
  // reached 611 commits behind.
  //
  // Re-coupling them is a one-line edit that runs green forever while silently
  // restoring an unanswerable gate — exactly the class this file exists to catch.
  const escalate = code.slice(stepIndex('id: escalate'), stepIndex('id: supersede'));
  const step = code.slice(stepIndex('id: supersede'), stepIndex('supersede-stale-deploy.mjs'));

  assert.match(
    escalate,
    /ALERT_AFTER_HOURS:\s*\$\{\{\s*vars\.PENDING_DEPLOY_ALERT_HOURS\s*\|\|\s*'6'/,
    'the escalation must still fire at 6h — BLO-25050 moved the supersede, not the alert',
  );
  assert.match(
    step,
    /SUPERSEDE_AFTER_HOURS:\s*\$\{\{\s*vars\.PENDING_DEPLOY_SUPERSEDE_HOURS\s*\|\|\s*'48'/,
    'the supersede must read its own variable, defaulted above card decision latency',
  );
  assert.doesNotMatch(
    step,
    /ALERT_AFTER_HOURS/,
    'the supersede step must not read the alert threshold — the coupling BLO-25050 removed',
  );
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
  // gate is clear, which ends the stall by definition. Where Issues are enabled,
  // an unclosed record's marker stays a stall-start candidate in
  // resolveStallStartedAt, so the next, unrelated stall would report as days old
  // from the first slot. On THIS repository no record exists
  // (`has_issues: false`) and the clock comes from deploy-stall-chain.mjs; the
  // condition is still pinned because it is the wiring deploy-stall-record.mjs
  // keeps for those repositories. Until 2026-10-05 this comment stated the
  // carried clock unconditionally: "Without a close, one open record would carry
  // its stall clock into the next, unrelated stall".
  const close = code.match(/- name: Close the durable deploy-stall record[\s\S]*?--resolve/);
  assert.ok(close, 'the workflow must close the stall record');
  assert.match(
    close[0],
    /steps\.dispatch\.outputs\.outcome != '' && steps\.dispatch\.outputs\.outcome != 'skipped-pending'/,
    'the close must run on the non-pending outcomes, and not on an empty outcome',
  );
});

test('the workflow grants exactly the permissions the new paths need, and no more', () => {
  // `issues: write` is retained for repositories with Issues enabled; on THIS
  // repository (`has_issues: false`) the record write returns 410 and the grant
  // is inert (see the workflow's `permissions:` block). Until 2026-10-05 this
  // comment called it "the entire credential cost of the durable record". It is
  // still pinned so the set cannot grow silently. `actions: write` was already
  // there for the dispatch and now also covers the cancel. Anything beyond these
  // two on a workflow that holds a deploy dispatch is worth a stop.
  const block = code.split(/^permissions:\n/m)[1] ?? '';
  const granted = [];
  for (const line of block.split('\n')) {
    if (!/^ {2}\S/.test(line)) break; // first non-entry line ends the block
    const entry = line.replace(/#.*$/, '').trim();
    if (entry) granted.push(entry);
  }
  assert.deepEqual(granted, ['contents: read', 'actions: write', 'issues: write']);
  assert.deepEqual(topLevelPermissions, granted, 'the shared parser must agree');
});

// PEN-3315. The supersede resets the pending run's age by construction — it
// cancels one run and creates another — so the escalation's clock has to come
// from somewhere that outlives a run. Without this, a 41h stall reports as a
// train of 6.0h ones and the critical alert flaps firing/resolved on the
// threshold instead of firing continuously with a climbing age. That would be a
// regression in the one control that demonstrably worked during the incident.
//
// These three exercise selectStuckApproval's `stallStartedAt` input, which they
// call the "recorded" stall start (and one assertion message, "the record"). On
// THIS repository that input never comes from a record (`has_issues: false`):
// resolveStallStartedAt takes it from the waiting run or the run-history
// derivation in deploy-stall-chain.mjs. The function does not know its source,
// so the pins hold for either.
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
  // Where Issues are enabled, the value can come from a marker in an issue body
  // that a human can edit. Going fatal there would take the escalation down over
  // a cosmetic change; ignoring it costs precision only, and only until the next
  // slot rewrites the marker. On THIS repository (`has_issues: false`) there is
  // no marker. Until 2026-10-05 this comment opened "The value comes from a
  // marker in an issue body".
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

// PEN-3315 follow-up. The supersede's failure paths empty the reviewer gate
// without anything shipping, and the dispatcher reports that as
// `checked-no-pending` — indistinguishable from a human having cancelled the
// pending run. The record opened to make the stall auditable would then be
// closed as RESOLVED while production sat at the stale commit, with the
// escalation no longer firing (nothing is waiting) and nothing new going out
// until the daily dispatch slot, up to ~24h later.
//
// The refusal lives in the script, not in the step `if:`, because a labelled
// record must still close on `dispatched` / `up-to-date`. These assert the wiring
// the script depends on is actually there.
//
// On THIS repository no record is opened (`has_issues: false`), so there is
// nothing to label or refuse to close; the wiring is pinned because
// deploy-stall-record.mjs keeps it for repositories with Issues enabled. Until
// 2026-10-05 this block described "The record opened to make the stall
// auditable" without that qualification.
test('the supersede can reach the record it must label on its failure paths', () => {
  const supersede = code.match(/- name: Supersede a stale pending deploy[\s\S]*?run: node/);
  assert.ok(supersede, 'the workflow must run the supersede');
  assert.match(
    supersede[0],
    /STALL_ISSUE_NUMBER:\s*\$\{\{\s*steps\.escalate\.outputs\.stall_issue_number\s*\}\}/,
    'without the record number the supersede cannot mark a gate it emptied',
  );
});

test('the record-closing step can tell WHICH non-pending outcome it is closing on', () => {
  // `--resolve` distinguishes "a human cleared it" from "we emptied it" by
  // outcome, so the outcome has to reach the script.
  const close = code.match(/- name: Close the durable deploy-stall record[\s\S]*?--resolve/);
  assert.ok(close, 'the workflow must close the stall record');
  assert.match(
    close[0],
    /DISPATCH_OUTCOME:\s*\$\{\{\s*steps\.dispatch\.outputs\.outcome\s*\}\}/,
    'the close must be told the outcome, or it cannot refuse a checked-no-pending close',
  );
});

test('every outcome the close step fires on is classified by the resolver', () => {
  // Guards the seam: a new outcome added to the dispatch step would otherwise
  // fall through REFILLING_OUTCOMES and silently close an unrefilled record.
  const emitted = [...code.matchAll(/echo "outcome=([a-z-]+)" >> "\$GITHUB_OUTPUT"/g)].map(
    (m) => m[1],
  );
  assert.ok(emitted.length >= 4, `expected the four dispatch outcomes, saw ${emitted.join(', ')}`);
  const nonPending = emitted.filter((outcome) => outcome !== 'skipped-pending');
  for (const outcome of nonPending) {
    assert.equal(
      typeof REFILLING_OUTCOMES.has(outcome),
      'boolean',
      `outcome ${outcome} must be classified`,
    );
  }
  // `checked-no-pending` is the one a failed supersede produces, so it is the one
  // that must NOT resolve the record on its own.
  assert.ok(nonPending.includes('checked-no-pending'));
  assert.equal(REFILLING_OUTCOMES.has('checked-no-pending'), false);
  assert.deepEqual(
    nonPending.filter((outcome) => REFILLING_OUTCOMES.has(outcome)).sort(),
    ['dispatched', 'up-to-date'],
  );
});

// ---------------------------------------------------------------------------
// The stall clock is derived from run history (deploy-stall-chain.mjs), which
// needs the waiting run's head to test whether a cancelled predecessor is a
// strict ancestor of it. That head arrives only through the pending-runs JSON
// this workflow writes, and dropping the field would make the derivation
// silently fall back to run-only ageing — which is the exact 2026-09-18
// under-report (a 46h stall reported as 3.0h on a green run) that it fixes.
// Unobservable until a deploy is already stuck for hours.
// ---------------------------------------------------------------------------

test('the pending-runs JSON carries headSha for the stall-clock derivation', () => {
  // BLO-38907 moved this read from `gh run list --json …` to the REST endpoint, so
  // the fields are now produced by a jq object construction rather than a CLI flag.
  // The invariant is unchanged: all five keys must reach the consumers, and the
  // REST endpoint returns snake_case, so the mapping is load-bearing — drop a key
  // and the consumer sees `undefined`, which for `createdAt` is an unparseable date
  // and for `databaseId` is a cancel call against `undefined`.
  for (const field of ['databaseId', 'status', 'createdAt', 'url', 'headSha']) {
    assert.match(
      pendingReadPipeline(),
      new RegExp(`\\b${field}\\s*:`),
      `pending-runs JSON must carry ${field}`,
    );
  }
});

test('the escalation step can read run history for the supersede chain', () => {
  // The derivation calls GET /actions/workflows/docker.yml/runs and GET
  // /compare. Both are `actions: read` / `contents: read`, which the workflow
  // already holds — assert it has not been narrowed below what the chain needs.
  // Block-scoped: a grant on some unrelated job would not give the ESCALATION
  // step these, so a whole-file match would pass while the chain read 403s.
  assert.ok(topLevelPermissions.length > 0, 'workflow must declare top-level permissions');
  assert.ok(
    topLevelPermissions.includes('actions: write'),
    'cancel+dispatch still needs actions: write',
  );
  assert.ok(
    topLevelPermissions.includes('contents: read'),
    'compare needs contents: read',
  );
});

test('the dispatcher and DEPLOY_WORKFLOW_FILE name the same workflow', () => {
  // The shell here spells the workflow independently of the JS constant, and
  // nothing else compares them. Rename docker.yml and you get a 404 approve
  // link in the alert with correct-looking prose, or the reverse — both of
  // which read as working. `code` is comment-stripped, so the file's own prose
  // about docker.yml cannot satisfy this.
  const invocations = [...code.matchAll(/--workflow=(\S+)/g)].map((m) => m[1]);
  // BLO-38907 moved guard (1) off `gh run list` and onto the REST endpoint, where
  // the workflow is spelled in a URL path rather than a `--workflow=` flag. Both
  // spellings must be checked or the new one is free to drift.
  const restPaths = [...code.matchAll(/actions\/workflows\/([^/]+)\/runs\?/g)].map((m) => m[1]);
  const named = [...invocations, ...restPaths];
  assert.ok(named.length > 0, 'the dispatcher must query the deploy workflow by name');
  for (const workflowFile of named) {
    assert.equal(
      workflowFile,
      DEPLOY_WORKFLOW_FILE,
      `dispatcher queries ${workflowFile} but the scripts build urls for ${DEPLOY_WORKFLOW_FILE}`,
    );
  }
});

// BLO-38907. Guard (1)'s read is the single point of failure for the whole chain:
// `skipped-pending` is what arms the escalation AND the supersede, and it is also
// what stops the daily slot stacking a second approval on production. A read that
// under-reports is therefore not a degraded signal, it is the absence of all three.
//
// Measured live 2026-10-01 on Blockcast/paperclip while run 36850416203 was
// `waiting`: `gh run list --workflow=docker.yml --event=workflow_dispatch` served a
// slice whose newest entry was 2026-09-10T12:15:25Z — no October run at all, at
// --limit 20 and --limit 50 — then returned the correct page on the next 11 calls.
// The production 17:31Z slot hit the stale branch and reported `checked-no-pending`
// with a deploy on the gate: no escalation, no supersede, and a GREEN run, which is
// precisely the `conclusion`-carries-the-signal contract PEN-2848 established.
//
// The region tested is everything BEFORE `outcome=skipped-pending`, i.e. guard (1)
// only — see `pendingReadRegion` at the top of this file.

test('guard (1) does not read the pending set through `gh run list --event=`', () => {
  assert.ok(
    // `(?:[^\n]|\\\n)*` crosses backslash-newline continuations: the pre-fix
    // form put `--event=` on the line AFTER `gh run list`, which `[^\n]*` missed.
    !/gh run list(?:[^\n]|\\\n)*--event=/.test(pendingReadRegion),
    'the pending read must not use `gh run list --event=` — measured to serve a ' +
      'three-week-stale slice intermittently, which reads as "nothing pending"',
  );
});

test('guard (1) unions independent run queries, so a stale slice cannot zero it', () => {
  // The fail-closed property, and it does not depend on any query being proven
  // sound: a stale slice can only REMOVE rows from a result, so a union of
  // differently-filtered reads cannot produce a false zero. One read alone can.
  // Dropping a query, or collapsing the union, restores the defect silently.
  const pipeline = pendingReadPipeline();
  const queries = [...pipeline.matchAll(/actions\/workflows\/[^/]+\/runs\?([^"'\s]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(
    queries.length >= 2,
    `guard (1) must union at least two run queries; found ${queries.length}: ${queries.join(' | ')}`,
  );
  assert.ok(
    queries.some((q) => q.includes('event=workflow_dispatch')),
    'one query must select the dispatch event',
  );
  assert.match(
    pipeline,
    /select\(\.event\s*==\s*"workflow_dispatch"\)[\s\S]*\{\s*databaseId:/,
    'guard (1) must drop non-dispatch runs returned by the unfiltered status queries',
  );
  // GitHub's `status` filter takes ONE value, so each non-terminal status guard (1)
  // counts needs its own query. A status read only through the event query is
  // single-sourced on the read measured to go stale — for `queued`/`in_progress`
  // that is a missed skip, i.e. the 2026-08-30 double roll.
  // Derived from the filter itself, not listed here: a hardcoded list lets a new
  // `or .status == "x"` arm land with no query. That arm is then single-sourced on
  // the stale event read, which fails as a silent false zero rather than an error,
  // so nothing else would catch it.
  const counted = [...new Set([...pipeline.matchAll(/\.status\s*==\s*"([a-z_]+)"/g)].map((m) => m[1]))];
  assert.ok(counted.length > 0, 'expected guard (1) to filter on `.status == "..."`');
  for (const status of counted) {
    assert.ok(
      queries.some((q) => q.includes(`status=${status}`)),
      `guard (1) must also query status=${status}, so it cannot go stale with the event query`,
    );
  }
  // `unique_by` is what makes the union a union rather than a double-count: the
  // event and status queries return the same waiting run on the common path, and WAITING is printed
  // to the step summary and read by the alert.
  assert.ok(
    /unique_by\(\.databaseId\)/.test(pipeline),
    'the union must be de-duplicated by run id',
  );
});

test('guard (1) step sets pipefail, so a failed read aborts instead of reading as zero', () => {
  // The `gh api` reads sit on the LEFT of a pipe into `jq`. Without pipefail the
  // pipeline's status is jq's, which succeeds on empty input: a failed read becomes
  // PENDING=0, the BLO-38907 false zero. `set -e` alone does not catch it.
  const step = pendingReadRegion.slice(pendingReadRegion.lastIndexOf('run: |'));
  assert.match(step, /^\s*set\s+-[\w\s-]*o\s+pipefail\b/m, 'guard (1) step must `set -o pipefail`');
});

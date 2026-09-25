import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATIFIED_REVIEWERS,
  evaluateEnvironmentProtection,
  fetchEnvironment,
} from '../check-production-environment-protection.mjs';

const user = (login) => ({ type: 'User', reviewer: { login } });

// ── evaluateEnvironmentProtection ────────────────────────────────────────────

// The EXACT live shape of paperclip-production, re-read 2026-09-21T07:0xZ:
//   {"can_admins_bypass":false,"updated_at":"2026-08-30T07:13:06Z",
//    "rules":[{"type":"branch_policy"},
//             {"type":"required_reviewers","prevent_self_review":false,
//              "reviewers":["kkroo"]}]}
// Ratified as intended by board approval 60e271b7 (2026-09-14), superseding
// b75f8156. This fixture IS the acceptance criterion for BLO-34896: the guard
// must be green on it *without* the environment moving. Note prevent_self_review
// is false here on purpose — see the "reported, not asserted" test below.
const COMPLIANT_ENV = {
  can_admins_bypass: false,
  updated_at: '2026-08-30T07:13:06Z',
  protection_rules: [
    { id: 61677470, type: 'branch_policy' },
    {
      id: 61904232,
      type: 'required_reviewers',
      prevent_self_review: false,
      reviewers: RATIFIED_REVIEWERS.map(user),
    },
  ],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

test('evaluateEnvironmentProtection: passes the board-ratified shape', () => {
  const result = evaluateEnvironmentProtection(COMPLIANT_ENV);
  assert.equal(result.compliant, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.observed.reviewers, RATIFIED_REVIEWERS);
});

test('evaluateEnvironmentProtection: the ratified reviewer set is the 60e271b7 set, not the superseded b75f8156 one', () => {
  // Pins the record that BLO-34896 exists to stop re-deriving. If someone
  // restores the two-reviewer set without a new board ruling, this fails and
  // the PR diff is the place that conversation happens.
  assert.deepEqual(RATIFIED_REVIEWERS, ['kkroo']);
});

test('evaluateEnvironmentProtection: flags the 2026-08-04 lapse shape (required_reviewers gone, admin bypass true)', () => {
  // Exact shape from GET /repos/Blockcast/paperclip/environments/paperclip-production
  // as recorded on board approval 06ff894e (updated_at 2026-08-04T09:21:50Z).
  const driftedEnv = {
    can_admins_bypass: true,
    protection_rules: [{ id: 61677470, type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  };

  const result = evaluateEnvironmentProtection(driftedEnv);
  assert.equal(result.compliant, false);
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0], /required_reviewers/);
  assert.match(result.violations[1], /can_admins_bypass/);
});

test('evaluateEnvironmentProtection: flags the 2026-08-08 WIDENING shape (extra admin reviewers + admin bypass)', () => {
  // Exact live shape re-probed 2026-08-14T08:46Z: the 08-08 "temporary" override
  // that was never restored. A non-emptiness check passes this; membership
  // comparison is what catches it. Regression guard for BLO-22329.
  const widenedEnv = {
    ...COMPLIANT_ENV,
    can_admins_bypass: true,
    updated_at: '2026-08-08T06:52:28Z',
    protection_rules: [
      { id: 61677470, type: 'branch_policy' },
      {
        id: 61904232,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: ['eyad-hussein', 'MohamedElmdary', 'kkroo'].map(user),
      },
    ],
  };

  const result = evaluateEnvironmentProtection(widenedEnv);
  assert.equal(result.compliant, false);
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0], /required_reviewers membership.*eyad-hussein.*MohamedElmdary/);
  assert.match(result.violations[1], /can_admins_bypass/);
});

test('evaluateEnvironmentProtection: flags a removed ratified reviewer', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [user('eyad-hussein')],
      },
    ],
  };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers membership.*missing.*kkroo/);
});

test('evaluateEnvironmentProtection: reviewer membership is case-insensitive', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [user('KKroo')],
      },
    ],
  };
  assert.equal(evaluateEnvironmentProtection(env).compliant, true);
});

test('evaluateEnvironmentProtection: honours an explicit expectedReviewers override', () => {
  const result = evaluateEnvironmentProtection(COMPLIANT_ENV, {
    expectedReviewers: ['someone-else'],
  });
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers membership/);
});

test('evaluateEnvironmentProtection: resolves Team reviewers by slug', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [{ type: 'Team', reviewer: { slug: 'release-approvers' } }],
      },
    ],
  };
  const result = evaluateEnvironmentProtection(env, { expectedReviewers: ['release-approvers'] });
  assert.equal(result.compliant, true);
  assert.deepEqual(result.observed.reviewers, ['release-approvers']);
});

// ── the dangerous state: no effective gate (BLO-34896 AC2) ───────────────────
// These two are the negative control for the reconciliation. The guard was made
// green against the live prevent_self_review=false shape; it must NOT have gone
// green by weakening its detection of "there is no approval gate at all".

test('evaluateEnvironmentProtection: flags empty reviewers as non-compliant even if the rule exists', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      { id: 2, type: 'required_reviewers', prevent_self_review: true, reviewers: [] },
    ],
  };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers/);
  assert.deepEqual(result.violationKinds, ['required_reviewers_rule']);
});

test('evaluateEnvironmentProtection: flags an absent required_reviewers rule', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }],
  };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.deepEqual(result.violationKinds, ['required_reviewers_rule']);
});

test('evaluateEnvironmentProtection: prevent_self_review is REPORTED but not asserted', () => {
  // Re-ratified as permitted-false by approval 60e271b7 (2026-09-14), so it must
  // not fail the run — that is the whole point of BLO-34896. It must still show
  // up in `observed`, which is what carries the single-approver posture into
  // every alert and run log.
  const result = evaluateEnvironmentProtection(COMPLIANT_ENV);
  assert.equal(result.compliant, true);
  assert.equal(result.observed.prevent_self_review, false);

  // ...and flipping it the other way is a strengthening, not a violation.
  const stricter = evaluateEnvironmentProtection({
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: RATIFIED_REVIEWERS.map(user),
      },
    ],
  });
  assert.equal(stricter.compliant, true);
});

test('evaluateEnvironmentProtection: prevent_self_review=false does NOT mask the membership check', () => {
  // The defect this reconciliation fixed. `prevent_self_review !== true` used to
  // be a disjunct of the required_reviewers_rule clause, and because `||`
  // short-circuits, the live false value sent every run down that branch and the
  // membership comparison in the `else` was unreachable. A tolerated drift was
  // hiding an untolerated one. Mutation guard: re-add that disjunct and this
  // fails, because the result collapses to required_reviewers_rule.
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [user('somebody-unratified')],
      },
    ],
  };
  const result = evaluateEnvironmentProtection(env);
  assert.deepEqual(result.violationKinds, ['required_reviewers_membership']);
});

test('evaluateEnvironmentProtection: flags missing deployment_branch_policy.protected_branches', () => {
  const env = { ...COMPLIANT_ENV, deployment_branch_policy: { protected_branches: false } };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /deployment_branch_policy/);
});

test('evaluateEnvironmentProtection: flags a null deployment_branch_policy (never configured)', () => {
  const env = { ...COMPLIANT_ENV, deployment_branch_policy: null };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /deployment_branch_policy/);
});

test('evaluateEnvironmentProtection: reports all three violations independently when everything is unset', () => {
  const result = evaluateEnvironmentProtection({});
  assert.equal(result.compliant, false);
  assert.equal(result.violations.length, 3);
});

// ── violationKinds ───────────────────────────────────────────────────────────
// The alert path promotes these slugs to an Alertmanager label so a changed
// violation set changes the fingerprint (PEN-2863). They therefore have to stay
// in lockstep with the prose and must not carry any observed value.

test('evaluateEnvironmentProtection: violationKinds stays in lockstep with violations', () => {
  const compliant = evaluateEnvironmentProtection(COMPLIANT_ENV);
  assert.deepEqual(compliant.violationKinds, []);

  const everythingUnset = evaluateEnvironmentProtection({});
  assert.equal(everythingUnset.violationKinds.length, everythingUnset.violations.length);
});

test('evaluateEnvironmentProtection: a membership widening is kind-tagged distinctly from a bypass flip', () => {
  // A membership widening with can_admins_bypass still false: an extra reviewer
  // beyond the ratified set, which is exactly the 2026-08-08 incident shape.
  const widened = evaluateEnvironmentProtection({
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 61677470, type: 'branch_policy' },
      {
        id: 61904232,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [...RATIFIED_REVIEWERS, 'eyad-hussein'].map(user),
      },
    ],
  });
  assert.deepEqual(widened.violationKinds, ['required_reviewers_membership']);

  // The 2026-08-08 compound: the same widening PLUS the admin bypass route.
  const compound = evaluateEnvironmentProtection({
    ...COMPLIANT_ENV,
    can_admins_bypass: true,
    protection_rules: [
      { id: 61677470, type: 'branch_policy' },
      {
        id: 61904232,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [...RATIFIED_REVIEWERS, 'eyad-hussein'].map(user),
      },
    ],
  });
  assert.deepEqual(compound.violationKinds, [
    'required_reviewers_membership',
    'can_admins_bypass',
  ]);
});

test('evaluateEnvironmentProtection: violation kinds carry no observed values', () => {
  // A slug that embedded a login would change the alert fingerprint whenever a
  // reviewer changed, re-firing for a drift that had not actually changed kind.
  const result = evaluateEnvironmentProtection({
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 61677470, type: 'branch_policy' },
      {
        id: 61904232,
        type: 'required_reviewers',
        prevent_self_review: true,
        reviewers: [...RATIFIED_REVIEWERS, 'eyad-hussein'].map(user),
      },
    ],
  });
  for (const kind of result.violationKinds) {
    assert.match(kind, /^[a-z_]+$/, `kind ${JSON.stringify(kind)} must be a bare slug`);
  }
});

// ── fetchEnvironment ──────────────────────────────────────────────────────────

test('fetchEnvironment: passes through the environment path, repo, and token', async () => {
  const calls = [];
  const fakeFetch = async (path, token) => {
    calls.push({ path, token });
    return COMPLIANT_ENV;
  };

  const result = await fetchEnvironment(fakeFetch, 'tok', 'Blockcast/paperclip', 'paperclip-production');

  assert.deepEqual(result, COMPLIANT_ENV);
  assert.deepEqual(calls, [
    { path: '/repos/Blockcast/paperclip/environments/paperclip-production', token: 'tok' },
  ]);
});

test('fetchEnvironment: wraps a 403/network failure in a distinguishable error rather than swallowing it', async () => {
  const failingFetch = async () => {
    throw new Error('GitHub API GET /repos/Blockcast/paperclip/environments/paperclip-production → 403: Resource not accessible by integration');
  };

  await assert.rejects(
    fetchEnvironment(failingFetch, 'bad-token', 'Blockcast/paperclip', 'paperclip-production'),
    /Could not read environment 'paperclip-production' on Blockcast\/paperclip.*403/s,
  );
});

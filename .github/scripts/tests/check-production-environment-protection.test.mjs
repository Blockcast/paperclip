import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATIFIED_REVIEWERS,
  evaluateEnvironmentProtection,
  fetchEnvironment,
} from '../check-production-environment-protection.mjs';

const user = (login) => ({ type: 'User', reviewer: { login } });

/** A required_reviewers rule, for the tests that still need one present. */
const reviewersRule = (logins, prevent_self_review = true) => ({
  id: 61904232,
  type: 'required_reviewers',
  prevent_self_review,
  reviewers: logins.map(user),
});

// ── evaluateEnvironmentProtection ────────────────────────────────────────────

// A TRANSCRIPT of the live shape of paperclip-production, read 2026-10-07:
//   {"can_admins_bypass":false,"protected_branches":true,
//    "rules":[{"id":61677470,"type":"branch_policy"}],
//    "revs":[],"psr":[],"updated_at":"2026-08-30T07:13:06Z"}
// There is no required_reviewers rule: the owner removed it on 2026-10-06 and
// recorded the decision in Blockcast/onprem-k8s#4913 (merged 641271378, merged
// by kkroo) — "That is correct, and it is intended." See the guard's header.
//
// ⛔ The earlier fixture carried a `required_reviewers` rule and an explicit
// note (PEN-2918) that it was NOT a transcript of the environment. That caveat
// is retired rather than deleted, because it is the reason this one says which
// it is: this fixture WAS read off the live environment in the run that changed
// it, field for field.
//
// `updated_at` is unchanged from the value recorded on 2026-08-30, across two
// subsequent edits to the rules. It does not track protection-rule changes and
// nothing asserts it.
const COMPLIANT_ENV = {
  can_admins_bypass: false,
  updated_at: '2026-08-30T07:13:06Z',
  protection_rules: [{ id: 61677470, type: 'branch_policy' }],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

test('evaluateEnvironmentProtection: passes the owner-ratified shape', () => {
  const result = evaluateEnvironmentProtection(COMPLIANT_ENV);
  assert.equal(result.compliant, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.observed.reviewers, []);
});

test('evaluateEnvironmentProtection: the ratified reviewer set is EMPTY per onprem-k8s#4913', () => {
  // Pins the record that BLO-34527 exists to stop re-deriving. If someone
  // restores a reviewer set without a new owner decision, this fails and the PR
  // diff is the place that conversation happens. #4913 carries the recipe for
  // the environment half of a revert.
  assert.deepEqual(RATIFIED_REVIEWERS, []);
});

test('evaluateEnvironmentProtection: an empty ratified set still flags a silently re-added reviewer', () => {
  // Empty is "nobody should be on this list", not "stop looking". The no-gate
  // clause is switched off; the membership comparison is not.
  const result = evaluateEnvironmentProtection({
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 61677470, type: 'branch_policy' }, reviewersRule(['kkroo'])],
  });
  assert.equal(result.compliant, false);
  assert.deepEqual(result.violationKinds, ['required_reviewers_membership']);
  assert.match(result.violations[0], /unexpected.*kkroo/);
});

test('evaluateEnvironmentProtection: flags the 2026-08-04 lapse shape (admin bypass true)', () => {
  // Exact shape from GET /repos/Blockcast/paperclip/environments/paperclip-production
  // as recorded on board approval 06ff894e (updated_at 2026-08-04T09:21:50Z).
  //
  // ⚠ This USED TO assert two violations — the missing reviewer rule and the
  // bypass flip. The reviewer half is gone by owner decision (#4913), so the
  // bypass assertion is now the ONLY thing standing between this shape and a
  // PASS. That is precisely why can_admins_bypass must keep asserting hard: it
  // is no longer defence in depth, it is the defence.
  const driftedEnv = {
    can_admins_bypass: true,
    protection_rules: [{ id: 61677470, type: 'branch_policy' }],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  };

  const result = evaluateEnvironmentProtection(driftedEnv);
  assert.equal(result.compliant, false);
  assert.deepEqual(result.violationKinds, ['can_admins_bypass']);
});

test('evaluateEnvironmentProtection: flags the 2026-08-08 WIDENING shape (extra admin reviewers + admin bypass)', () => {
  // Exact live shape re-probed 2026-08-14T08:46Z: the 08-08 "temporary" override
  // that was never restored. A non-emptiness check passes this; membership
  // comparison is what catches it. Regression guard for BLO-22329, and it still
  // fires now that the ratified set is empty — all three reviewers read as
  // unexpected rather than two.
  const widenedEnv = {
    ...COMPLIANT_ENV,
    can_admins_bypass: true,
    updated_at: '2026-08-08T06:52:28Z',
    protection_rules: [
      { id: 61677470, type: 'branch_policy' },
      reviewersRule(['eyad-hussein', 'MohamedElmdary', 'kkroo']),
    ],
  };

  const result = evaluateEnvironmentProtection(widenedEnv);
  assert.equal(result.compliant, false);
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0], /required_reviewers membership.*eyad-hussein.*MohamedElmdary/);
  assert.match(result.violations[1], /can_admins_bypass/);
});

test('evaluateEnvironmentProtection: flags a removed reviewer against a non-empty expected set', () => {
  // The override path, which is how the membership check behaves if a reviewer
  // is ever restored to RATIFIED_REVIEWERS.
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }, reviewersRule(['eyad-hussein'])],
  };
  const result = evaluateEnvironmentProtection(env, { expectedReviewers: ['kkroo'] });
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers membership.*missing.*kkroo/);
});

test('evaluateEnvironmentProtection: reviewer membership is case-insensitive', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }, reviewersRule(['KKroo'])],
  };
  assert.equal(
    evaluateEnvironmentProtection(env, { expectedReviewers: ['kkroo'] }).compliant,
    true,
  );
});

test('evaluateEnvironmentProtection: honours an explicit expectedReviewers override', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }, reviewersRule(['kkroo'])],
  };
  const result = evaluateEnvironmentProtection(env, { expectedReviewers: ['someone-else'] });
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
// These two are the negative control for the reconciliation. The no-gate clause
// is dormant for paperclip-production because the ratified set is empty — but
// the code path must still work, so that restoring a reviewer to
// RATIFIED_REVIEWERS re-arms it unchanged. They therefore pass an explicit
// non-empty expected set rather than relying on the default.
//
// ⛔ These must NOT be deleted on the grounds that the clause is dormant. A
// dormant guard with no test is a guard that silently stops working, and the
// owner decision that made it dormant is revertible by design (#4913).

test('evaluateEnvironmentProtection: flags empty reviewers as non-compliant even if the rule exists', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }, reviewersRule([])],
  };
  const result = evaluateEnvironmentProtection(env, { expectedReviewers: ['kkroo'] });
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers/);
  assert.deepEqual(result.violationKinds, ['required_reviewers_rule']);
});

test('evaluateEnvironmentProtection: flags an absent required_reviewers rule', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [{ id: 1, type: 'branch_policy' }],
  };
  const result = evaluateEnvironmentProtection(env, { expectedReviewers: ['kkroo'] });
  assert.equal(result.compliant, false);
  assert.deepEqual(result.violationKinds, ['required_reviewers_rule']);
});

test('evaluateEnvironmentProtection: prevent_self_review is REPORTED but not asserted', () => {
  // With no required_reviewers rule there is no field to read, so it reports
  // null — and that must not fail the run.
  assert.equal(evaluateEnvironmentProtection(COMPLIANT_ENV).observed.prevent_self_review, null);

  // When a rule IS present, both values are reported and neither is asserted.
  // The single-approver posture rides into every alert and run log on this
  // field; the residual risk is homed on BLO-22329, not asserted here.
  for (const value of [false, true]) {
    const result = evaluateEnvironmentProtection(
      {
        ...COMPLIANT_ENV,
        protection_rules: [{ id: 1, type: 'branch_policy' }, reviewersRule(['kkroo'], value)],
      },
      { expectedReviewers: ['kkroo'] },
    );
    assert.equal(result.compliant, true, `prevent_self_review=${value} must not fail the run`);
    assert.equal(result.observed.prevent_self_review, value);
  }
});

test('evaluateEnvironmentProtection: prevent_self_review=false does NOT mask the membership check', () => {
  // The defect this guard's reconciliation fixed. `prevent_self_review !== true`
  // used to be a disjunct of the required_reviewers_rule clause, and because
  // `||` short-circuits, an observed false value sent every run down that branch
  // and the membership comparison in the `else` was unreachable. A tolerated
  // drift was hiding an untolerated one. Mutation guard: re-add that disjunct
  // and this fails, because the result collapses to required_reviewers_rule.
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      reviewersRule(['somebody-unratified'], false),
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

test('evaluateEnvironmentProtection: reports the remaining violations independently when everything is unset', () => {
  // Two, not three: an absent reviewer rule is the ratified shape now. The two
  // that remain are the whole machine-enforced defence — see the guard header.
  const result = evaluateEnvironmentProtection({});
  assert.equal(result.compliant, false);
  assert.deepEqual(result.violationKinds, ['can_admins_bypass', 'protected_branches']);

  // ...and all three still fire when a reviewer gate is expected.
  const expectingReviewers = evaluateEnvironmentProtection({}, { expectedReviewers: ['kkroo'] });
  assert.equal(expectingReviewers.violations.length, 3);
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

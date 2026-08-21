import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATIFIED_REVIEWERS,
  evaluateEnvironmentProtection,
  fetchEnvironment,
} from '../check-production-environment-protection.mjs';

const user = (login) => ({ type: 'User', reviewer: { login } });

// ── evaluateEnvironmentProtection ────────────────────────────────────────────

const COMPLIANT_ENV = {
  can_admins_bypass: false,
  updated_at: '2026-08-06T05:55:07Z',
  protection_rules: [
    { id: 61677470, type: 'branch_policy' },
    {
      id: 61904232,
      type: 'required_reviewers',
      prevent_self_review: true,
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

test('evaluateEnvironmentProtection: flags the 2026-08-08 WIDENING shape (extra admin reviewer + admin bypass)', () => {
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
  assert.match(result.violations[0], /required_reviewers membership.*kkroo/);
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
  assert.match(result.violations[0], /required_reviewers membership.*missing.*MohamedElmdary/);
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
        reviewers: [user('Eyad-Hussein'), user('mohamedelmdary')],
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
});

test('evaluateEnvironmentProtection: flags prevent_self_review !== true even with reviewers present', () => {
  const env = {
    ...COMPLIANT_ENV,
    protection_rules: [
      { id: 1, type: 'branch_policy' },
      {
        id: 2,
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: RATIFIED_REVIEWERS.map(user),
      },
    ],
  };
  const result = evaluateEnvironmentProtection(env);
  assert.equal(result.compliant, false);
  assert.match(result.violations[0], /required_reviewers/);
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

#!/usr/bin/env node
/**
 * check-production-environment-protection.mjs
 *
 * Reads the live GitHub environment that gates `helm upgrade` (default:
 * paperclip-production) and asserts the controls the board ratified on
 * approval b75f8156:
 *   1. a `required_reviewers` protection rule with prevent_self_review === true
 *      whose reviewer set is exactly the ratified set
 *   2. can_admins_bypass === false
 *   3. deployment_branch_policy.protected_branches === true
 *
 * Why the reviewer set is compared by membership and not merely for
 * non-emptiness (BLO-22329): the 2026-08-08 drift *added* `kkroo` — a repo
 * admin — as a third reviewer and flipped `can_admins_bypass` to true, which
 * together route around `prevent_self_review`. A "does a required_reviewers
 * rule exist?" check passes that shape. Both prior drifts were full lapses;
 * this one was a widening, so the detector has to notice membership changes.
 *
 * Exit codes are load-bearing: a scheduled caller must be able to tell "drift"
 * apart from "I couldn't check" so an unreadable environment is never reported
 * as compliant.
 *   0 = compliant
 *   1 = drift — the environment was read successfully but violates >=1 condition
 *   2 = the environment could not be read (network/HTTP error, bad token, etc.)
 */
import { writeFileSync } from 'node:fs';
import { ghFetch } from './get-bot-token.mjs';

/**
 * The reviewer set ratified on approval b75f8156. Changing it is deliberately a
 * code change: the PR is the audit trail that the two silent edits lacked.
 */
export const RATIFIED_REVIEWERS = ['eyad-hussein', 'MohamedElmdary'];

/** A reviewer entry is either a User (login) or a Team (slug). */
function reviewerName(entry) {
  const r = entry?.reviewer ?? {};
  return r.login ?? r.slug ?? r.name ?? null;
}

export function evaluateEnvironmentProtection(env, options = {}) {
  const expected = options.expectedReviewers ?? RATIFIED_REVIEWERS;
  const violations = [];

  const rule = (env.protection_rules ?? []).find((r) => r.type === 'required_reviewers');
  const reviewers = Array.isArray(rule?.reviewers)
    ? rule.reviewers.map(reviewerName).filter(Boolean)
    : [];

  if (rule == null || reviewers.length === 0 || rule.prevent_self_review !== true) {
    violations.push(
      'required_reviewers: missing, or reviewers is empty, or prevent_self_review is not true',
    );
  } else {
    // Compare membership case-insensitively; GitHub logins are case-preserving
    // but not case-sensitive.
    const norm = (s) => s.toLowerCase();
    const actualSet = new Set(reviewers.map(norm));
    const expectedSet = new Set(expected.map(norm));
    const added = reviewers.filter((r) => !expectedSet.has(norm(r)));
    const removed = expected.filter((r) => !actualSet.has(norm(r)));

    if (added.length > 0 || removed.length > 0) {
      const parts = [];
      if (added.length > 0) parts.push(`unexpected ${JSON.stringify(added)}`);
      if (removed.length > 0) parts.push(`missing ${JSON.stringify(removed)}`);
      violations.push(
        `required_reviewers membership: ${parts.join(', ')} ` +
          `(ratified set is ${JSON.stringify(expected)})`,
      );
    }
  }

  if (env.can_admins_bypass !== false) {
    violations.push(
      `can_admins_bypass: expected false, got ${JSON.stringify(env.can_admins_bypass)}`,
    );
  }

  if (env.deployment_branch_policy?.protected_branches !== true) {
    violations.push(
      'deployment_branch_policy.protected_branches: expected true, got ' +
        `${JSON.stringify(env.deployment_branch_policy?.protected_branches)}`,
    );
  }

  return {
    compliant: violations.length === 0,
    violations,
    observed: {
      reviewers,
      prevent_self_review: rule?.prevent_self_review ?? null,
      can_admins_bypass: env.can_admins_bypass ?? null,
      protected_branches: env.deployment_branch_policy?.protected_branches ?? null,
      updated_at: env.updated_at ?? null,
    },
  };
}

export async function fetchEnvironment(fetchFn, token, repo, environmentName) {
  try {
    return await fetchFn(`/repos/${repo}/environments/${environmentName}`, token);
  } catch (err) {
    throw new Error(
      `Could not read environment '${environmentName}' on ${repo}: ${err.message}`,
      { cause: err },
    );
  }
}

/**
 * Emit the machine-readable result so the calling workflow can build an alert
 * payload without re-parsing human-facing log lines.
 */
function writeSummary(payload) {
  const out = process.env.ENV_CHECK_JSON_OUT;
  if (!out) return;
  try {
    writeFileSync(out, `${JSON.stringify(payload)}\n`);
  } catch (err) {
    // Never let summary-writing turn a clean PASS into a failure, but say so:
    // a caller that alerts off the summary needs to know it is absent.
    console.error(`WARNING: could not write ENV_CHECK_JSON_OUT=${out}: ${err.message}`);
  }
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('ERROR: GH_TOKEN env var not set.');
    writeSummary({ status: 'unreadable', reason: 'GH_TOKEN env var not set' });
    process.exitCode = 2;
    return;
  }

  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('ERROR: GH_REPO or GITHUB_REPOSITORY env var not set.');
    writeSummary({ status: 'unreadable', reason: 'GH_REPO/GITHUB_REPOSITORY env var not set' });
    process.exitCode = 2;
    return;
  }

  const environmentName = process.env.GH_ENVIRONMENT_NAME || 'paperclip-production';
  const expectedReviewers = process.env.EXPECTED_REVIEWERS
    ? process.env.EXPECTED_REVIEWERS.split(',').map((s) => s.trim()).filter(Boolean)
    : RATIFIED_REVIEWERS;

  let env;
  try {
    env = await fetchEnvironment(ghFetch, token, repo, environmentName);
  } catch (err) {
    console.error(`UNREADABLE: ${err.message}`);
    writeSummary({ status: 'unreadable', repo, environment: environmentName, reason: err.message });
    process.exitCode = 2;
    return;
  }

  const { compliant, violations, observed } = evaluateEnvironmentProtection(env, {
    expectedReviewers,
  });

  if (compliant) {
    console.log(
      `PASS: ${repo} environment '${environmentName}' matches the ratified protection shape ` +
        `(required_reviewers ${JSON.stringify(observed.reviewers)} + prevent_self_review, ` +
        'can_admins_bypass=false, deployment_branch_policy.protected_branches=true).',
    );
    writeSummary({ status: 'compliant', repo, environment: environmentName, observed });
    process.exitCode = 0;
    return;
  }

  console.error(
    `DRIFT: ${repo} environment '${environmentName}' no longer matches the board-ratified shape:`,
  );
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  writeSummary({ status: 'drift', repo, environment: environmentName, violations, observed });
  process.exitCode = 1;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

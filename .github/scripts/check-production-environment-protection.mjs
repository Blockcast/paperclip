#!/usr/bin/env node
/**
 * check-production-environment-protection.mjs
 *
 * Reads the live GitHub environment that gates `helm upgrade` (default:
 * paperclip-production) and asserts three controls:
 *   1. the required_reviewers rule matches the ratified reviewer set — which is
 *      currently EMPTY, so this assertion is dormant by default (see below)
 *   2. can_admins_bypass === false
 *   3. deployment_branch_policy.protected_branches === true
 *
 * ⛔ 2 AND 3 ARE NOW THE ENTIRE MACHINE-ENFORCED DEFENCE between a
 * `workflow_dispatch` and production. Read this before relaxing either. Until
 * 2026-10-06 the reviewer gate was the primary control and these two were
 * defence in depth; with the reviewer gate gone (below) a silent flip of either
 * is total loss with no backstop. Both must keep asserting hard, and #4913
 * lists exactly these two first among the controls it relies on.
 *
 * WHY THE REVIEWER ASSERTION IS DORMANT (BLO-34527 / BLO-34896) — do not
 * re-derive this. On 2026-10-06 ~22:58Z the repo owner removed the
 * required_reviewers rule from paperclip-production and recorded the decision in
 * their own first-person PR, Blockcast/onprem-k8s#4913, merged 2026-10-07T01:13:11Z
 * as 641271378 and merged by kkroo:
 *     "The background security review flagged this commit as a security-control
 *      regression. That is correct, and it is intended."
 * #4913 also names the accepted risk — anyone with write access to
 * Blockcast/paperclip can dispatch docker.yml and deploy any master commit with
 * a production-admin kubeconfig, with no second person involved — and the
 * controls that remain: the protected-branches-only deployment policy, master's
 * own merge rules, the workflow's reachable-from-master check on `target_sha`,
 * and the audit trail. It carries the revert recipe for the environment side.
 *
 * This SUPERSEDES the reviewer clause of board approval 60e271b7 (2026-09-14),
 * which itself superseded b75f8156 (2026-08-03). Superseded records, kept
 * compactly so a fifth run does not re-litigate them: b75f8156 ratified
 * [eyad-hussein, MohamedElmdary] plus prevent_self_review; 60e271b7 ratified
 * [kkroo]. Verified live 2026-10-07: protection_rules holds branch_policy only,
 * can_admins_bypass=false, protected_branches=true.
 *
 * `updated_at` still reads 2026-08-30T07:13:06Z — UNCHANGED across this edit and
 * across the 2026-10-04 one before it. It does not track protection-rule changes
 * on this object. Never promote it to a change detector (PEN-2918).
 *
 * prevent_self_review is reported under `observed` and never asserted. With no
 * required_reviewers rule it reads null; it becomes meaningful again only if a
 * reviewer is restored, which is a code change here (see RATIFIED_REVIEWERS).
 * The single-approver residual risk is homed on BLO-22329, not here: a detector
 * should assert the ratified shape, not re-argue it.
 *
 * Why the reviewer set is compared by membership and not merely for
 * non-emptiness (BLO-22329): the 2026-08-08 drift *added* `kkroo` — a repo
 * admin — as a third reviewer and flipped `can_admins_bypass` to true, which
 * together route around `prevent_self_review`. A "does a required_reviewers
 * rule exist?" check passes that shape. Membership comparison is what catches a
 * widening, and it is still live now that the ratified set is empty: any
 * reviewer that appears reads as unexpected.
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
 * The ratified reviewer set. EMPTY since Blockcast/onprem-k8s#4913 (2026-10-07)
 * removed the reviewer gate by owner decision — see the header.
 *
 * Empty is NOT "unchecked". It means "nobody should be on this list", so a
 * silently re-added reviewer is still flagged as a membership violation. What
 * it switches off is only the no-gate-at-all clause below, which would
 * otherwise be permanently red about a decision the owner made deliberately.
 *
 * Changing this is deliberately a code change: the PR is the audit trail that
 * the silent environment edits of 2026-08-04 and 2026-08-08 lacked.
 */
export const RATIFIED_REVIEWERS = [];

/** A reviewer entry is either a User (login) or a Team (slug). */
function reviewerName(entry) {
  const r = entry?.reviewer ?? {};
  return r.login ?? r.slug ?? r.name ?? null;
}

/**
 * Stable slugs for the five things this check can find wrong.
 *
 * These exist so a caller can key on *which* control broke without parsing the
 * human-facing prose, which embeds reviewer logins and observed values and so
 * changes for cosmetic reasons. The alert path promotes these to a label, where
 * the value has to be stable enough that an unchanged violation set produces an
 * unchanged Alertmanager fingerprint (BLO-22329 / PEN-2863).
 */
export const VIOLATION_KINDS = {
  /**
   * No rule of type `required_reviewers` exists on the environment at all.
   * Kept on the original slug deliberately: this is the shape that was live when
   * the two were split (PEN-3871), so the then-firing Alertmanager alert keeps
   * its fingerprint across that change instead of resolving and re-firing.
   */
  REQUIRED_REVIEWERS_RULE: 'required_reviewers_rule',
  /** The rule exists, but its reviewer list is empty. */
  REQUIRED_REVIEWERS_EMPTY: 'required_reviewers_empty',
  REQUIRED_REVIEWERS_MEMBERSHIP: 'required_reviewers_membership',
  CAN_ADMINS_BYPASS: 'can_admins_bypass',
  PROTECTED_BRANCHES: 'protected_branches',
};

export function evaluateEnvironmentProtection(env, options = {}) {
  const expected = options.expectedReviewers ?? RATIFIED_REVIEWERS;
  const violations = [];
  const violationKinds = [];

  /** Keep the prose and its slug in lockstep — a violation must never be one without the other. */
  const violation = (kind, message) => {
    violations.push(message);
    violationKinds.push(kind);
  };

  const rule = (env.protection_rules ?? []).find((r) => r.type === 'required_reviewers');
  const reviewers = Array.isArray(rule?.reviewers)
    ? rule.reviewers.map(reviewerName).filter(Boolean)
    : [];

  // THE DANGEROUS STATE: a reviewer gate is expected and there is none — no
  // rule, or a rule with nobody on it. Never weaken this clause to make a run
  // go green (BLO-34896 AC2). The ONLY sanctioned way to switch it off is to
  // empty RATIFIED_REVIEWERS, which is a reviewed code change recording an
  // owner decision.
  //
  // `expected.length > 0` is that switch. With the set empty — the state since
  // onprem-k8s#4913 — an absent rule IS the ratified shape, so evaluation falls
  // through to the membership comparison below, where any reviewer that appears
  // reads as unexpected. Restore a reviewer to RATIFIED_REVIEWERS and this
  // clause re-arms unchanged.
  //
  // `prevent_self_review` is deliberately NOT a disjunct here. It used to be,
  // and because `||` short-circuits, an observed prevent_self_review=false sent
  // every run down this branch and the membership comparison in the `else`
  // became UNREACHABLE — so the 2026-08-30 narrowing to [kkroo] was never
  // actually reported as a membership change, only as a self-review complaint.
  // A compound clause that skips a sibling check is how a tolerated drift masks
  // an untolerated one; keep this clause about "is there a gate at all".
  //
  // `expected.length > 0` is the reviewed switch that enables the gate.
  // With an empty ratified set, an absent rule is the current ratified shape and
  // falls through to membership comparison; otherwise keep missing and empty
  // rule states as distinct, actionable verdicts.
  if (expected.length > 0 && rule == null) {
    violation(
      VIOLATION_KINDS.REQUIRED_REVIEWERS_RULE,
      'required_reviewers: NO rule of this type exists on the environment — ' +
        'there is no effective approval gate on production deploys ' +
        `(remedy: create the rule with the ratified reviewer set ${JSON.stringify(expected)})`,
    );
  } else if (expected.length > 0 && reviewers.length === 0) {
    violation(
      VIOLATION_KINDS.REQUIRED_REVIEWERS_EMPTY,
      'required_reviewers: the rule exists but its reviewer list is EMPTY — ' +
        'there is no effective approval gate on production deploys ' +
        `(remedy: restore the ratified reviewer set ${JSON.stringify(expected)} on the existing rule)`,
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
      violation(
        VIOLATION_KINDS.REQUIRED_REVIEWERS_MEMBERSHIP,
        `required_reviewers membership: ${parts.join(', ')} ` +
          `(ratified set is ${JSON.stringify(expected)})`,
      );
    }
  }

  if (env.can_admins_bypass !== false) {
    violation(
      VIOLATION_KINDS.CAN_ADMINS_BYPASS,
      `can_admins_bypass: expected false, got ${JSON.stringify(env.can_admins_bypass)}`,
    );
  }

  if (env.deployment_branch_policy?.protected_branches !== true) {
    violation(
      VIOLATION_KINDS.PROTECTED_BRANCHES,
      'deployment_branch_policy.protected_branches: expected true, got ' +
        `${JSON.stringify(env.deployment_branch_policy?.protected_branches)}`,
    );
  }

  return {
    compliant: violations.length === 0,
    violations,
    violationKinds,
    observed: {
      reviewers,
      prevent_self_review: rule?.prevent_self_review ?? null,
      can_admins_bypass: env.can_admins_bypass ?? null,
      protected_branches: env.deployment_branch_policy?.protected_branches ?? null,
      // Informational only. No violation() above reads this, and no code in the
      // repo reads a GitHub environment `updated_at` by name other than this
      // line, so nothing is gated on it. (It does LEAVE this file:
      // post-environment-protection-alert.mjs:91 serialises `observed` wholesale
      // into the alert payload without naming any field. Printing is not gating,
      // but a promoter should know the value is already in flight. Repo-wide
      // greps for `updated_at` are dominated by ~500 unrelated Postgres column
      // references; this is a different field and they are not evidence about
      // it.) ⛔ Do NOT promote it to a change-detector without first settling
      // PEN-2918's open question: all three in-repo observations of a distinct
      // `updated_at` (the test's :93-96 08-08 widening, its :74-75 08-04 lapse,
      // and the transcription at its :24-30) ALSO changed reviewers or
      // can_admins_bypass, so whether a prevent_self_review-only edit bumps it
      // is untested. That is harmless while the field is inert — every payload
      // carrying it also carries the literal values it could otherwise mislead
      // about — and becomes load-bearing the moment it is compared.
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

  const { compliant, violations, violationKinds, observed } = evaluateEnvironmentProtection(env, {
    expectedReviewers,
  });

  if (compliant) {
    console.log(
      `PASS: ${repo} environment '${environmentName}' matches the ratified protection shape ` +
        `(required_reviewers ${JSON.stringify(observed.reviewers)} against ratified ` +
        `${JSON.stringify(expectedReviewers)}, can_admins_bypass=false, ` +
        `deployment_branch_policy.protected_branches=true). ` +
        `Observed prevent_self_review=${JSON.stringify(observed.prevent_self_review)} ` +
        '(reported, not asserted). The reviewer gate was removed by owner decision ' +
        '— Blockcast/onprem-k8s#4913; see this script\'s header.',
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
  writeSummary({ status: 'drift', repo, environment: environmentName, violations, violationKinds, observed });
  process.exitCode = 1;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

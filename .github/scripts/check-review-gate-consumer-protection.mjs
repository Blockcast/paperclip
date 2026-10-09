#!/usr/bin/env node
/**
 * check-review-gate-consumer-protection.mjs
 *
 * Asserts that the four `review-gate` consumer repositories still carry a
 * required-REVIEW control on their default branch.
 *
 * WHY A REVIEW AND NOT A STATUS CHECK (BLO-26736, measured end to end).
 * `review/ally-complete` is a commit STATUS, and on these repos any pull
 * request can mint a `statuses: write` token from its own branch and write that
 * status for its own head SHA — `pull_request_review` sources the workflow from
 * `refs/pull/N/merge`, so the PR author controls the file that runs. Proven at
 * run level on pim-multicast-gateway: two runs on the identical head
 * `ece5c5b2`, same filename, executed different step sets (31580402912 via
 * `pull_request_target` ran main's definition, 31580938507 via
 * `pull_request_review` ran the PR head's), and the PR-sourced run successfully
 * wrote a commit status on its own head.
 *
 * No in-repo change fixes that. Removing the trigger does nothing (the attacker
 * adds their own workflow file, which `pull_request_review` will run because it
 * carries no default-branch requirement); a read-only default token is a
 * starting point rather than a ceiling; and a CI assertion inside the protected
 * repo also runs from the PR head and can be disabled in the same PR. So a
 * required STATUS CHECK is not a security boundary against anyone who can push
 * a branch, and a required REVIEW is. The controls were applied by an operator
 * on 2026-10-05 (BLO-27563); this guard exists so their removal is noticed.
 *
 * THIS GUARD MUST LIVE OUTSIDE THE REPOS IT WATCHES, for the same reason: a
 * check that runs inside the protected repo is disable-able by the very PR it
 * is meant to stop.
 *
 * TWO SIGNALS, BECAUSE ONE DOES NOT COVER ALL FOUR.
 *   1. The ruleset read `GET /repos/{o}/{r}/rules/branches/{branch}` is the
 *      primary. It is precise, never goes void, and reports the exact
 *      parameters. It covers hang-mmt-fec, pim-multicast-gateway and
 *      penstock-vault-node.
 *   2. penstock-llm-proxy-core has NO ruleset — its control is classic branch
 *      protection, and `branches/{branch}/protection` is `403 Resource not
 *      accessible by integration` to an App token while `rules/branches`
 *      returns ruleset rules ONLY. So for core the primary reads `[]` whether
 *      the control exists or not, and signal 1 alone would silently leave a
 *      quarter of the surface uncovered. The fallback asks the question that
 *      actually matters — is a review REQUIRED IN FORCE — via `reviewDecision`
 *      on open pull requests that carry no approving review and are not
 *      already CHANGES_REQUESTED.
 *
 * The fallback is deliberately the weaker of the two and is only consulted when
 * the primary finds no rule, because it can go VOID: it needs at least one open
 * zero-approval pull request to observe. A void fallback exits 2 (unreadable),
 * never 0 — measured 2026-10-05, penstock-vault-node had exactly one open PR
 * and it was approved, so a behaviour-only guard would have been void on a live
 * repo on the day it shipped.
 *
 * Exit codes are load-bearing: a scheduled caller must be able to tell "drift"
 * apart from "I couldn't check", so an unreadable repo is never reported as
 * compliant.
 *   0 = every consumer compliant
 *   1 = drift — at least one consumer was read and has no effective review gate
 *   2 = at least one consumer could not be evaluated (and none drifted)
 */
import { writeFileSync } from 'node:fs';
import { ghFetch, exitFatal } from './get-bot-token.mjs';

/**
 * The four repositories that vendor the review gate (BLO-20920), with the
 * default branch each control was applied to. Changing this list is
 * deliberately a code change: the PR is the audit trail.
 */
export const CONSUMERS = [
  { repo: 'hang-mmt-fec', branch: 'main' },
  { repo: 'pim-multicast-gateway', branch: 'main' },
  { repo: 'penstock-vault-node', branch: 'master' },
  { repo: 'penstock-llm-proxy-core', branch: 'main' },
];

/** Stable slugs, so a caller can key on WHICH control broke without parsing prose. */
export const VIOLATION_KINDS = {
  NO_REVIEW_GATE: 'no_review_gate',
  APPROVING_REVIEW_COUNT: 'required_approving_review_count',
  LAST_PUSH_APPROVAL: 'require_last_push_approval',
  DISMISS_STALE_REVIEWS: 'dismiss_stale_reviews_on_push',
};

/**
 * GraphQL's maximum `first`. A repo past this needs real pagination, which the
 * truncation guard in `evaluateConsumer` turns into a loud `unreadable` rather
 * than a silent pass. The authoritative truncation signal is the connection's
 * `pageInfo.hasNextPage`; a page of exactly this length is only the fallback
 * tell, used when that flag is absent.
 * Measured 2026-10-07: penstock-llm-proxy-core, the only consumer that reaches
 * the behavioural arm, had 19 open pull requests on `main` against the then-cap
 * of 20 — one PR from the fail-open this guard now refuses.
 */
export const OPEN_PRS_PAGE_SIZE = 100;

/**
 * Evaluate one consumer from already-fetched data. Pure, so the whole decision
 * table is testable without the network.
 *
 * @param rules  the `rules/branches/{branch}` array, or null if it could not be read
 * @param openPullRequests  [{number, approvals, reviewDecision}], or null if not fetched
 * @param openPullRequestsTruncated  the probe's `pageInfo.hasNextPage`; when absent,
 *   a full page (length >= OPEN_PRS_PAGE_SIZE) is treated as truncated
 */
export function evaluateConsumer({ repo, branch, rules, openPullRequests, openPullRequestsTruncated }) {
  const base = { repo, branch };

  if (rules == null) {
    return { ...base, status: 'unreadable', reason: 'rules/branches could not be read', violationKinds: [] };
  }

  // `rules/branches/{branch}` FLATTENS the contributions of every ruleset that
  // applies to the branch — each entry carries its own `ruleset_id` — so two
  // rulesets can both contribute a `pull_request` rule. `.find()` would read
  // the first and silently ignore a second one's stricter parameters.
  // Measured 2026-10-07: no consumer has two today (hang 1, pim 1, vault 1,
  // core 0), so this is structural rather than currently exercised. Unioned
  // strictest-wins anyway, matching GitHub's own cross-ruleset evaluation:
  // a parameter is satisfied if ANY applying rule demands it.
  const prRules = rules.filter((r) => r?.type === 'pull_request');

  if (prRules.length > 0) {
    const params = prRules.map((r) => r.parameters ?? {});
    const p = {
      required_approving_review_count: Math.max(
        ...params.map((x) => Number(x.required_approving_review_count) || 0),
      ),
      require_last_push_approval: params.some((x) => x.require_last_push_approval === true),
      dismiss_stale_reviews_on_push: params.some((x) => x.dismiss_stale_reviews_on_push === true),
    };
    const violations = [];
    const violationKinds = [];
    const fail = (kind, message) => {
      violations.push(`${repo}: ${message}`);
      violationKinds.push(kind);
    };

    // >= 1 rather than === 1: the ratified value is 1, but a stricter setting
    // is not drift. Only the absence of a gate is.
    if (!(Number(p.required_approving_review_count) >= 1)) {
      fail(
        VIOLATION_KINDS.APPROVING_REVIEW_COUNT,
        `required_approving_review_count is ${p.required_approving_review_count} — a pull_request rule ` +
          'exists but requires no approving review, so it gates nothing',
      );
    }
    // Both of these were explicitly ratified on BLO-27563. Without
    // require_last_push_approval an attacker gets an approval on a benign head
    // and then pushes; without dismiss_stale_reviews_on_push the stale approval
    // keeps counting after that push. Each alone reopens the finding.
    if (p.require_last_push_approval !== true) {
      fail(VIOLATION_KINDS.LAST_PUSH_APPROVAL, 'require_last_push_approval is not true');
    }
    if (p.dismiss_stale_reviews_on_push !== true) {
      fail(VIOLATION_KINDS.DISMISS_STALE_REVIEWS, 'dismiss_stale_reviews_on_push is not true');
    }

    return {
      ...base,
      status: violations.length === 0 ? 'compliant' : 'drift',
      evidence: 'ruleset',
      rulesetIds: prRules.map((r) => r.ruleset_id ?? null),
      observed: {
        required_approving_review_count: p.required_approving_review_count,
        require_last_push_approval: p.require_last_push_approval,
        dismiss_stale_reviews_on_push: p.dismiss_stale_reviews_on_push,
      },
      violations,
      violationKinds,
    };
  }

  // No ruleset rule. That is the expected, permanent state for a repo on
  // classic branch protection, which an App token cannot read — so absence here
  // is NOT evidence the control is gone, and must not be reported as drift on
  // its own. Fall through to the in-force probe.
  if (openPullRequests == null) {
    return { ...base, status: 'unreadable', reason: 'no pull_request rule, and open pull requests could not be read', violationKinds: [] };
  }

  // CHANGES_REQUESTED is excluded for the same reason an approval is: it is
  // more blocking than REVIEW_REQUIRED, not less, so testing it against
  // REVIEW_REQUIRED would page drift on a repo whose control is in force
  // (penstock-llm-proxy-core#1888 carries exactly that shape: zero approvals,
  // reviewDecision=CHANGES_REQUESTED). It cannot refute the control either
  // way, so it is left out of the sample rather than counted.
  const eligible = openPullRequests.filter(
    (pr) => (pr.approvals ?? 0) === 0 && pr.reviewDecision !== 'CHANGES_REQUESTED',
  );

  // Drift first: an ungated pull request we DID see is a positive observation,
  // and stays drift whether or not the window behind it was complete.
  const ungated = eligible.filter((pr) => pr.reviewDecision !== 'REVIEW_REQUIRED');
  if (ungated.length > 0) {
    return {
      ...base,
      status: 'drift',
      evidence: 'behavioural',
      observed: { probed: eligible.length, ungated: ungated.map((pr) => pr.number) },
      violations: [
        `${repo}: pull request(s) ${ungated.map((pr) => `#${pr.number}`).join(', ')} carry zero approving ` +
          'reviews and do not report reviewDecision=REVIEW_REQUIRED — no review is required to merge',
      ],
      violationKinds: [VIOLATION_KINDS.NO_REVIEW_GATE],
    };
  }

  // A truncated window (`hasNextPage`, or a full page when that flag is
  // absent) dropped rows, and the query orders UPDATED_AT DESC — so the rows
  // dropped are the LEAST recently touched, which is exactly where a stale
  // ungated pull request sits. A `compliant` here would be a pass bought by
  // not looking. Not drift: nothing ungated was observed. Raising
  // OPEN_PRS_PAGE_SIZE only moves the cliff; this guard is what makes the
  // cliff loud instead of silent.
  if (openPullRequestsTruncated ?? (openPullRequests.length >= OPEN_PRS_PAGE_SIZE)) {
    return {
      ...base,
      status: 'unreadable',
      reason: `no pull_request rule, and the open-pull-request window came back full ` +
        `(${openPullRequests.length} = the ${OPEN_PRS_PAGE_SIZE} cap) — least-recently-updated pull ` +
        `requests were dropped unseen, so this sample cannot refute the control`,
      observed: { probed: eligible.length, truncated: true },
      violationKinds: [],
    };
  }

  if (eligible.length === 0) {
    // VOID, not a pass. With no zero-approval pull request there is nothing
    // that would read REVIEW_REQUIRED even if the control were deleted.
    return {
      ...base,
      status: 'unreadable',
      reason: `no pull_request rule, and no open zero-approval pull request on ${branch} without ` +
        `CHANGES_REQUESTED to probe ` +
        `(${openPullRequests.length} open) — the control is unmeasurable from here, which is not a pass`,
      violationKinds: [],
    };
  }

  return {
    ...base,
    status: 'compliant',
    evidence: 'behavioural',
    observed: { probed: eligible.length },
    violations: [],
    violationKinds: [],
  };
}

/** Roll the per-consumer verdicts up into one exit code. Drift outranks unreadable. */
export function summarize(results) {
  const drifted = results.filter((r) => r.status === 'drift');
  const unreadable = results.filter((r) => r.status === 'unreadable');
  return {
    exitCode: drifted.length > 0 ? 1 : unreadable.length > 0 ? 2 : 0,
    compliant: drifted.length === 0 && unreadable.length === 0,
    violations: [
      ...drifted.flatMap((r) => r.violations ?? []),
      ...unreadable.map((r) => `${r.repo}: NOT EVALUATED — ${r.reason}`),
    ],
    violationKinds: [...new Set(drifted.flatMap((r) => r.violationKinds ?? []))],
    unreadable: unreadable.map((r) => r.repo),
    observed: Object.fromEntries(
      results.map((r) => [r.repo, { status: r.status, evidence: r.evidence ?? null, ...(r.observed ?? {}) }]),
    ),
  };
}

const OPEN_PRS_QUERY = `query($o:String!,$r:String!,$b:String!){
  repository(owner:$o,name:$r){
    pullRequests(states:OPEN,baseRefName:$b,first:${OPEN_PRS_PAGE_SIZE},orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage }
      nodes{ number reviewDecision latestOpinionatedReviews(first:100,writersOnly:false){nodes{state}} }
    }
  }
}`;

/** null on any failure — the caller turns that into `unreadable`, never a pass. */
async function fetchRules(owner, repo, branch, token, fetchImpl = ghFetch) {
  try {
    return await fetchImpl(`/repos/${owner}/${repo}/rules/branches/${branch}`, token);
  } catch (err) {
    console.warn(`::warning::could not read rules for ${owner}/${repo}@${branch}: ${err.message}`);
    return null;
  }
}

async function fetchOpenPullRequests(owner, repo, branch, token, fetchImpl = ghFetch) {
  try {
    const body = await fetchImpl('/graphql', token, {
      method: 'POST',
      body: JSON.stringify({ query: OPEN_PRS_QUERY, variables: { o: owner, r: repo, b: branch } }),
    });
    // GraphQL answers 200 with an `errors` array, so an unchecked read here
    // would turn a permission failure into "zero open pull requests" — which
    // the caller cannot distinguish from a genuinely quiet repo.
    if (body?.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
    const { nodes, pageInfo } = body.data.repository.pullRequests;
    return {
      nodes: nodes.map((pr) => ({
        number: pr.number,
        reviewDecision: pr.reviewDecision,
        approvals: pr.latestOpinionatedReviews.nodes.filter((r) => r.state === 'APPROVED').length,
      })),
      // undefined when absent, so evaluateConsumer falls back to the length tell.
      truncated: pageInfo?.hasNextPage,
    };
  } catch (err) {
    console.warn(`::warning::could not read open pull requests for ${owner}/${repo}@${branch}: ${err.message}`);
    return null;
  }
}

export async function checkConsumers({ owner, token, consumers = CONSUMERS, fetchImpl = ghFetch }) {
  const results = [];
  for (const { repo, branch } of consumers) {
    const rules = await fetchRules(owner, repo, branch, token, fetchImpl);
    // Only pay for the fallback where the primary did not settle it.
    const needsProbe = rules != null && !rules.some((r) => r?.type === 'pull_request');
    const probe = needsProbe
      ? await fetchOpenPullRequests(owner, repo, branch, token, fetchImpl)
      : null;
    results.push(evaluateConsumer({
      repo,
      branch,
      rules,
      openPullRequests: probe?.nodes ?? null,
      openPullRequestsTruncated: probe?.truncated,
    }));
  }
  return results;
}

async function main() {
  const owner = process.env.CONSUMER_OWNER || 'Blockcast';
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('::error::GH_TOKEN is required');
    process.exit(2);
  }

  let results;
  try {
    results = await checkConsumers({ owner, token });
  } catch (err) {
    // exitFatal defaults to exit 1, which this script's contract reserves for
    // drift. A throw here evaluated nothing, so it must exit 2.
    exitFatal(err, 'review-gate-consumer-protection', () => process.exit(2));
    return;
  }

  const summary = summarize(results);
  for (const r of results) {
    console.log(`${r.status.toUpperCase().padEnd(10)} ${owner}/${r.repo}@${r.branch} (${r.evidence ?? r.reason})`);
  }
  for (const v of summary.violations) console.log(`  - ${v}`);

  if (process.env.CHECK_JSON_OUT) {
    writeFileSync(process.env.CHECK_JSON_OUT, JSON.stringify(summary, null, 2));
  }
  process.exit(summary.exitCode);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

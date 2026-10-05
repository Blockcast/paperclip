import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSUMERS,
  VIOLATION_KINDS,
  evaluateConsumer,
  summarize,
  checkConsumers,
} from '../check-review-gate-consumer-protection.mjs';

/**
 * The EXACT live shape read from
 * `GET /repos/Blockcast/pim-multicast-gateway/rules/branches/main` on
 * 2026-10-05, the day the operator applied the control (BLO-27563). This
 * fixture IS the acceptance criterion: the guard must be green on it without
 * anything moving.
 */
const RATIFIED_PR_RULE = {
  type: 'pull_request',
  ruleset_id: 24491729,
  parameters: {
    allowed_merge_methods: ['merge', 'squash', 'rebase'],
    dismiss_stale_reviews_on_push: true,
    require_code_owner_review: false,
    require_extra_approval_for_unattributed_changes: false,
    require_last_push_approval: true,
    required_approving_review_count: 1,
    required_review_thread_resolution: false,
    required_reviewers: [],
  },
};

const withParams = (overrides) => ({
  ...RATIFIED_PR_RULE,
  parameters: { ...RATIFIED_PR_RULE.parameters, ...overrides },
});

const consumer = (extra) => ({ repo: 'pim-multicast-gateway', branch: 'main', ...extra });

// ── the ratified shape ───────────────────────────────────────────────────────

test('the live 2026-10-05 ruleset shape is compliant', () => {
  const r = evaluateConsumer(consumer({ rules: [RATIFIED_PR_RULE] }));
  assert.equal(r.status, 'compliant');
  assert.equal(r.evidence, 'ruleset');
  assert.deepEqual(r.violationKinds, []);
});

test('a stricter approving-review count is not drift', () => {
  // The ratified value is 1; raising it is someone tightening the control, and
  // a guard that reds on that teaches people to ignore it.
  const r = evaluateConsumer(consumer({ rules: [withParams({ required_approving_review_count: 2 })] }));
  assert.equal(r.status, 'compliant');
});

// ── each ratified parameter is independently load-bearing ────────────────────
// One test per parameter, because a compound assertion passes when any single
// one of them is quietly dropped.

test('a pull_request rule requiring zero approvals is drift, not a pass', () => {
  const r = evaluateConsumer(consumer({ rules: [withParams({ required_approving_review_count: 0 })] }));
  assert.equal(r.status, 'drift');
  assert.deepEqual(r.violationKinds, [VIOLATION_KINDS.APPROVING_REVIEW_COUNT]);
});

test('require_last_push_approval=false is drift', () => {
  // Without it: get an approval on a benign head, then push the real change.
  const r = evaluateConsumer(consumer({ rules: [withParams({ require_last_push_approval: false })] }));
  assert.equal(r.status, 'drift');
  assert.deepEqual(r.violationKinds, [VIOLATION_KINDS.LAST_PUSH_APPROVAL]);
});

test('dismiss_stale_reviews_on_push=false is drift', () => {
  const r = evaluateConsumer(consumer({ rules: [withParams({ dismiss_stale_reviews_on_push: false })] }));
  assert.equal(r.status, 'drift');
  assert.deepEqual(r.violationKinds, [VIOLATION_KINDS.DISMISS_STALE_REVIEWS]);
});

test('several broken parameters are reported together, not short-circuited', () => {
  // A compound clause that stops at the first violation is how a tolerated
  // drift masks an untolerated one.
  const r = evaluateConsumer(
    consumer({ rules: [withParams({ require_last_push_approval: false, dismiss_stale_reviews_on_push: false })] }),
  );
  assert.deepEqual(r.violationKinds.sort(), [
    VIOLATION_KINDS.DISMISS_STALE_REVIEWS,
    VIOLATION_KINDS.LAST_PUSH_APPROVAL,
  ].sort());
});

// ── unreadable is never a pass ───────────────────────────────────────────────

test('rules that could not be read are unreadable, not compliant', () => {
  const r = evaluateConsumer(consumer({ rules: null }));
  assert.equal(r.status, 'unreadable');
});

test('an unreadable consumer exits 2 even when every other consumer is compliant', () => {
  const s = summarize([
    evaluateConsumer(consumer({ rules: [RATIFIED_PR_RULE] })),
    evaluateConsumer({ repo: 'hang-mmt-fec', branch: 'main', rules: null }),
  ]);
  assert.equal(s.exitCode, 2);
  assert.equal(s.compliant, false);
  assert.deepEqual(s.unreadable, ['hang-mmt-fec']);
});

test('drift outranks unreadable in the exit code', () => {
  const s = summarize([
    evaluateConsumer(consumer({ rules: [withParams({ required_approving_review_count: 0 })] })),
    evaluateConsumer({ repo: 'hang-mmt-fec', branch: 'main', rules: null }),
  ]);
  assert.equal(s.exitCode, 1);
});

// ── the behavioural fallback (penstock-llm-proxy-core) ───────────────────────

const core = (extra) => ({ repo: 'penstock-llm-proxy-core', branch: 'main', rules: [], ...extra });

test('no ruleset is NOT drift on its own — classic protection is unreadable to an App token', () => {
  // `rules/branches` returns ruleset rules only, and `branches/{b}/protection`
  // is 403 to the App token, so an empty read says nothing about whether the
  // control exists. Reporting it as drift would red this guard permanently
  // against a repo that is correctly protected.
  const r = evaluateConsumer(core({ openPullRequests: [{ number: 2237, approvals: 0, reviewDecision: 'REVIEW_REQUIRED' }] }));
  assert.equal(r.status, 'compliant');
  assert.equal(r.evidence, 'behavioural');
});

test('a zero-approval pull request that does not require review is drift', () => {
  const r = evaluateConsumer(
    core({ openPullRequests: [{ number: 2237, approvals: 0, reviewDecision: null }] }),
  );
  assert.equal(r.status, 'drift');
  assert.deepEqual(r.violationKinds, [VIOLATION_KINDS.NO_REVIEW_GATE]);
});

test('an already-approved pull request is not evidence either way, so it is excluded from the probe', () => {
  // Measured 2026-10-05: penstock-vault-node had exactly one open PR and it was
  // approved. An approved PR reports APPROVED whether or not a review is
  // required, so counting it as a pass would be reading the control off a
  // sample that cannot refute it.
  const r = evaluateConsumer(
    core({ openPullRequests: [{ number: 853, approvals: 1, reviewDecision: 'APPROVED' }] }),
  );
  assert.equal(r.status, 'unreadable');
  assert.match(r.reason, /no open zero-approval pull request/);
});

test('no open pull requests at all is VOID, not a pass', () => {
  const r = evaluateConsumer(core({ openPullRequests: [] }));
  assert.equal(r.status, 'unreadable');
});

test('pull requests that could not be read is VOID, not a pass', () => {
  const r = evaluateConsumer(core({ openPullRequests: null }));
  assert.equal(r.status, 'unreadable');
});

test('one ungated pull request is drift even when others require review', () => {
  const r = evaluateConsumer(
    core({
      openPullRequests: [
        { number: 1, approvals: 0, reviewDecision: 'REVIEW_REQUIRED' },
        { number: 2, approvals: 0, reviewDecision: null },
      ],
    }),
  );
  assert.equal(r.status, 'drift');
});

// ── the consumer list and the fetch plan ─────────────────────────────────────

test('all four review-gate consumers are watched', () => {
  assert.deepEqual(
    CONSUMERS.map((c) => `${c.repo}@${c.branch}`).sort(),
    [
      'hang-mmt-fec@main',
      'penstock-llm-proxy-core@main',
      'penstock-vault-node@master',
      'pim-multicast-gateway@main',
    ],
  );
});

test('the open-pull-request probe is only paid for where no pull_request rule was found', () => {
  const calls = [];
  const fetchImpl = async (path) => {
    calls.push(path);
    if (path.includes('/rules/branches/')) {
      return path.includes('with-rule') ? [RATIFIED_PR_RULE] : [];
    }
    return { data: { repository: { pullRequests: { nodes: [] } } } };
  };
  return checkConsumers({
    owner: 'Blockcast',
    token: 't',
    consumers: [
      { repo: 'with-rule', branch: 'main' },
      { repo: 'without-rule', branch: 'main' },
    ],
    fetchImpl,
  }).then(() => {
    assert.equal(calls.filter((p) => p === '/graphql').length, 1);
  });
});

test('a GraphQL errors array is unreadable, even when partial data came back with it', () => {
  // GraphQL answers 200 with `errors` AND, for a partial failure, a `data`
  // block holding only the fields it could resolve. That partial block is the
  // dangerous shape: without the explicit errors check it parses cleanly, so a
  // truncated pull-request list reads as the whole list and the probe returns
  // COMPLIANT off a sample it never actually saw.
  //
  // The fixture is deliberately partial-with-one-node, not errors-only: an
  // errors-only body makes `body.data.repository` throw into the same catch,
  // which returns `unreadable` anyway and leaves the guard untestable. Measured
  // — the errors-only version of this test survived removing the guard.
  const fetchImpl = async (path) =>
    path === '/graphql'
      ? {
          errors: [{ message: 'Something went wrong while executing your query' }],
          data: {
            repository: {
              pullRequests: {
                nodes: [{ number: 1, reviewDecision: 'REVIEW_REQUIRED', latestOpinionatedReviews: { nodes: [] } }],
              },
            },
          },
        }
      : [];
  return checkConsumers({
    owner: 'Blockcast',
    token: 't',
    consumers: [{ repo: 'without-rule', branch: 'main' }],
    fetchImpl,
  }).then((results) => {
    assert.equal(results[0].status, 'unreadable');
  });
});

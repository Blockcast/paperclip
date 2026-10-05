import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  budgetBoundFetch,
  qualityRetryBudgetMs,
  QUALITY_STEP_TIMEOUT_MS,
  REVIEW_JOB_TIMEOUT_MS,
  SECURITY_STEP_TIMEOUT_MS,
  buildComment,
  deliverComment,
  findExistingComment,
  isGraphifyReindexArtifactOnlyPr,
} from '../run-quality-gates.mjs';
import { RATE_LIMIT_MIN_WAIT_MS, exitFatal } from '../get-bot-token.mjs';

const workflow = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../workflows/commitperclip-review.yml',
  ),
  'utf8',
);

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else', type: 'User' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]', type: 'Bot' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]', type: 'Bot' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

// BLO-26636. The old predicate allowlisted the literal login
// `commitperclip[bot]`, but get-bot-token.mjs resolves whichever App
// COMMITPERCLIP_APP_ID points at — `allyblockcast[bot]` on Blockcast. So
// `existing` was permanently null there: every failing run POSTed a duplicate,
// and a passing run skipped the write entirely, stranding the failure comment.
// This fixture is the one the old code returns undefined for.
test('findExistingComment: matches whichever App posted it, not a hard-coded login', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 5654012482,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Hey @someone! Before this PR can be reviewed…\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1828);

  assert.equal(comment.id, 5654012482);
});

// `type === 'Bot'` is the whole guard against the PATCH path overwriting a
// human's comment — repo-write identities can edit others' comments via the
// API, so a human quoting the signature must not be treated as ours.
test('findExistingComment: ignores a human comment carrying the signature', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 9,
      user: { login: 'kkroo', type: 'User' },
      body: 'Quoting the bot here:\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1828);

  assert.equal(comment, null);
});

// On Blockcast every agent posts as `allyblockcast[bot]`, so `type === 'Bot'`
// cannot tell our gate comment from an agent comment that quotes the
// signature — and `.find` takes the first match in id order, so a quoting
// comment posted first would get PATCHed over. The signature is last in both
// buildComment branches; anchor there.
test('findExistingComment: ignores a bot comment that merely quotes the signature', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 11,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'The old code matched `— commitperclip` by login.\n\nSee the diff above.',
    },
    {
      id: 12,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Hey @someone! Before this PR can be reviewed…\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1889);

  assert.equal(comment.id, 12);
});

// Pins `.find` over `findLast` (BLO-26636). Both pass every other fixture, so
// nothing else in this suite would notice the swap. Our comment is posted by
// the first failing run, i.e. near PR open, and a bot comment quoting it can
// only exist after it does — so oldest-match is the genuine one and
// newest-match is the paste. Adopting the paste PATCHes over another agent's
// comment, which recurs; picking the older of two genuine gate comments only
// mattered for pre-fix duplicates. Those were deleted from the affected open
// PRs by a manual sweep, but the producing bug runs on `master` until this
// merges and keeps minting more (#1933 took two inside eleven minutes) — so
// sweep once more at merge time rather than treating the earlier sweep as
// durable. After merge the class cannot recur.
test('findExistingComment: adopts the oldest gate comment, not the newest', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 20,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Hey @someone! Before this PR can be reviewed…\n\n— commitperclip',
    },
    {
      id: 21,
      user: { login: 'allyblockcast[bot]', type: 'Bot' },
      body: 'Quoting the gate verbatim:\n\n> Hey @someone!\n\n— commitperclip',
    },
  ]), 'token', 'Blockcast/paperclip', 1889);

  assert.equal(comment.id, 20);
});

// Every other fixture here is a hand-written literal, so none of them pin the
// cross-function coupling the whole fix rests on: findExistingComment anchors
// on `endsWith(COMMENT_SIGNATURE)`, which is only correct while buildComment
// keeps the signature last in *both* branches. Append a footer after the
// signature — the edit anyone adding a run link would make — and `existing`
// goes permanently null again: failing runs POST a duplicate and passing runs
// fall through the `|| existing` guard, leaving the stale red comment up. That
// is the BLO-26636 defect restored, with the rest of this suite fully green.
test('findExistingComment: matches what buildComment actually produces', async () => {
  for (const body of [
    buildComment('someone', ['Missing section: **## Risks**'], []),
    buildComment('someone', [], []),
  ]) {
    const comment = await findExistingComment(async () => ([
      { id: 1, user: { login: 'allyblockcast[bot]', type: 'Bot' }, body },
    ]), 'token', 'Blockcast/paperclip', 1889);

    assert.equal(comment?.id, 1);
  }
});

test('findExistingComment: tolerates a comment with no body', async () => {
  const comment = await findExistingComment(async () => ([
    { id: 13, user: { login: 'allyblockcast[bot]', type: 'Bot' }, body: null },
  ]), 'token', 'Blockcast/paperclip', 1889);

  assert.equal(comment, null);
});

// BLO-26636. The failure the gate reports most often is a body/title
// violation, and the old text sent the author to push a commit — advice that
// re-runs nothing for a body edit and burns a CI matrix when followed.
test('buildComment: names editing the description, not just pushing a commit', () => {
  const body = buildComment('someone', ['Missing section: **## Risks**'], []);

  assert.match(body, /editing the PR description or title/);
  assert.doesNotMatch(body, /push a new commit and these checks will re-run/);
});

// The remedy above is only true because the workflow listens for `edited`.
// These assertions have to move together or the comment starts lying.
test('commitperclip-review: listens for edited without displacing the original triggers', () => {
  for (const type of ['opened', 'synchronize', 'reopened', 'edited']) {
    assert.match(workflow, new RegExp(`types:\\s*\\[[^\\]]*\\b${type}\\b`));
  }
  assert.match(workflow, /merge_group:\s*\n\s*types:\s*\[checks_requested\]/);
});

// pull_request_target hands secrets to a job triggered by an untrusted fork
// PR, so the base-branch checkout is what makes adding a trigger type safe at
// all. If this ever flips to the PR head, `edited` stops being a one-line
// change and becomes an arbitrary-code-execution path. The count is what bounds
// the blacklist problem: enumerating `ref:` spellings can only ever chase an
// unbounded set (`github.head_ref`, `refs/pull/`, `env.PR_HEAD_SHA`,
// `merge_commit_sha`, …). Asserting there is exactly one checkout, and that it
// is `master`, rejects every second *checkout step* regardless of how its
// `ref:` is written. Ceiling: a `run:` step fetching PR code itself (`git fetch
// origin pull/N/head`), or a third-party action taking its own `ref:` input, is
// outside any guard that reads this workflow as text. Neither exists today —
// the only `uses:` steps are checkout, dependency-review-action and setup-node
// — so if you add one, this test will not stop you.
test('commitperclip-review: still checks out master, never PR code', () => {
  assert.match(workflow, /uses:\s*actions\/checkout@[^\n]*\n\s*with:\s*\n\s*ref:\s*master/);
  assert.equal((workflow.match(/uses:\s*actions\/checkout@/g) ?? []).length, 1);
});

test('isGraphifyReindexArtifactOnlyPr: permits generated graphify reindex PRs', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [
      { filename: 'server/src/graphify-out/graph.json' },
      { filename: 'server/src/graphify-out/GRAPH_REPORT.md' },
      { filename: 'server/src/graphify-out/.graphify_labels.json' },
    ],
  });

  assert.equal(result, true);
});

test('isGraphifyReindexArtifactOnlyPr: rejects non-graphify authors', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'someone-else',
    branch: 'bot/graphify-reindex',
    files: [{ filename: 'server/src/graphify-out/graph.json' }],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects non-graphify branches', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'feature/change',
    files: [{ filename: 'server/src/graphify-out/graph.json' }],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects mixed source changes', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [
      { filename: 'server/src/graphify-out/graph.json' },
      { filename: 'server/src/routes/github-webhook.ts' },
    ],
  });

  assert.equal(result, false);
});

test('isGraphifyReindexArtifactOnlyPr: rejects empty file lists', () => {
  const result = isGraphifyReindexArtifactOnlyPr({
    author: 'allyblockcast[bot]',
    branch: 'bot/graphify-reindex',
    files: [],
  });

  assert.equal(result, false);
});

// A delivery failure arrives after every gate has already decided. It must
// leave the verdict standing instead of reaching exitFatal, which would exit 1
// regardless of the verdict.
test('deliverComment: a rate-limited read (flagged by ghFetch) does not throw', async () => {
  const delivered = await deliverComment(async () => {
    throw Object.assign(new Error('GitHub API rate limit exceeded'), { rateLimited: true });
  });
  assert.equal(delivered, false);
});

// The write shape ghFetch really produces: it never retries a POST/PATCH, so a
// rate-limited comment write is a plain Error with no `rateLimited` flag.
test('deliverComment: a rate-limited comment write (plain, unflagged Error) does not throw', async () => {
  const delivered = await deliverComment(async () => {
    throw new Error('GitHub API PATCH /repos/o/r/issues/comments/1 → 403: {"message":"API rate limit exceeded"}');
  });
  assert.equal(delivered, false);
});

test('deliverComment: reports success when the post completes', async () => {
  let posted = false;
  assert.equal(await deliverComment(async () => { posted = true; }), true);
  assert.equal(posted, true);
});

test('main posts the comment through deliverComment, not directly', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../run-quality-gates.mjs'),
    'utf8',
  );
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(main, /await deliverComment\(async \(\) => \{\s*const existing = await findExistingComment\(/);
  assert.equal((main.match(/findExistingComment\(/g) ?? []).length, 1);
});

test('deliverComment: a failed delivery records comment_delivered=false; a delivered one records nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rqg-'));
  const failed = path.join(dir, 'failed');
  const ok = path.join(dir, 'ok');
  writeFileSync(failed, '');
  writeFileSync(ok, '');
  await deliverComment(async () => { throw new Error('GitHub API POST → 403'); }, failed);
  await deliverComment(async () => {}, ok);
  assert.equal(readFileSync(failed, 'utf8'), 'comment_delivered=false\n');
  assert.equal(readFileSync(ok, 'utf8'), '');
});

test('commitperclip-review: an undelivered comment is not reported as "see commitperclip comment"', () => {
  assert.match(workflow, /QUALITY_COMMENT_DELIVERED: \$\{\{ steps\.quality\.outputs\.comment_delivered \}\}/);
  assert.match(workflow, /elif \[ "\$\{QUALITY_COMMENT_DELIVERED\}" = "false" \]; then\s*\n\s*echo "One or more quality gates failed, but the commitperclip comment could not be posted/);
});

// Each read gets only what is left of ONE budget measured from script start,
// so paginated reads cannot each draw a fresh per-call budget.
test('budgetBoundFetch: reads share one shrinking budget and get 0 once it is spent', async () => {
  const seen = [];
  let clock = 1_000;
  const gh = budgetBoundFetch(1_000, 100, async (_p, _t, options) => { seen.push(options.retryBudgetMs); }, () => clock);
  await gh('/a', 't');
  clock = 1_060;
  await gh('/b', 't');
  clock = 1_500;
  await gh('/c', 't');
  assert.deepEqual(seen, [100, 40, 0]);
});

// timeout-minutes of the block that starts at `marker`, up to the next sibling.
function timeoutMinutesOf(marker, sibling) {
  const block = workflow.slice(workflow.indexOf(marker));
  return Number(block.slice(0, block.indexOf(sibling)).match(/timeout-minutes: (\d+)/)[1]);
}

test('the budget constants mirror the three timeout-minutes in commitperclip-review.yml', () => {
  assert.equal(QUALITY_STEP_TIMEOUT_MS, timeoutMinutesOf('- name: Run quality gates', '\n      - name:') * 60_000);
  assert.equal(SECURITY_STEP_TIMEOUT_MS, timeoutMinutesOf('- name: Run security gates', '\n      - name:') * 60_000);
  assert.equal(REVIEW_JOB_TIMEOUT_MS, timeoutMinutesOf('\n  review:\n', '\n    steps:') * 60_000);
});

test('the review job records its start before any other step', () => {
  // Split the job's step list into items and take the first one, so this
  // checks position, not just presence: a Record job start step that drifts
  // behind checkout, Dependency Review or setup-node would make the budget
  // measure a near-zero elapsed on exactly the cold runner it exists for.
  const job = workflow.slice(workflow.indexOf('\n  review:\n'));
  const firstStep = job.slice(job.indexOf('    steps:\n')).split('\n      - ')[1];
  assert.match(firstStep, /^name: Record job start\n(        #[^\n]*\n)*        run: [^\n]*REVIEW_JOB_STARTED_AT_MS=\$\(\( \$\(date \+%s\) \* 1000 \)\)" >> "\$GITHUB_ENV"/);
});

// Whatever the steps before this one spent, the funded sleeps, the reserve and
// the security step's cap must still fit inside the job's cap, so the job is
// never cancelled mid-sleep (which would surface as a red `review` with no
// not_evaluated annotation). 23-75s is the measured warm range; 300s is the
// cold case the job's timeout comment describes.
test('qualityRetryBudgetMs never lets the job outlive its timeout, warm or cold', () => {
  for (const elapsed of [0, 23_000, 75_000, 180_000, 300_000, 420_000, 600_000]) {
    const budget = qualityRetryBudgetMs(1_000, 1_000 + elapsed);
    assert.ok(budget >= 0, `elapsed ${elapsed}: ${budget}`);
    assert.ok(budget <= QUALITY_STEP_TIMEOUT_MS - RATE_LIMIT_MIN_WAIT_MS, `elapsed ${elapsed}: ${budget}`);
    if (budget > 0) {
      assert.ok(
        elapsed + budget + RATE_LIMIT_MIN_WAIT_MS + SECURITY_STEP_TIMEOUT_MS <= REVIEW_JOB_TIMEOUT_MS,
        `elapsed ${elapsed}: budget ${budget} overruns the job`,
      );
    }
  }
});

test('qualityRetryBudgetMs refuses to guess when the job start was not recorded', () => {
  for (const missing of [Number(undefined), 0, Number('')]) {
    assert.throws(() => qualityRetryBudgetMs(missing, 1_000), /REVIEW_JOB_STARTED_AT_MS is not set/);
  }
});

// The throw fires before any gate runs, so it must reach the workflow as "did
// not run" (not_evaluated=true), not as a failure pointing at a comment that was
// never posted.
test('a missing job start reaches exitFatal as not-evaluated, with its own reason', () => {
  let thrown;
  try { qualityRetryBudgetMs(Number(undefined), 1_000); } catch (e) { thrown = e; }
  assert.ok(thrown, 'qualityRetryBudgetMs must throw without a recorded start');
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-not-evaluated-'));
  const out = path.join(dir, 'github_output');
  writeFileSync(out, '');
  const lines = [];
  const error = console.error;
  console.error = msg => lines.push(String(msg));
  let code;
  try {
    exitFatal(thrown, 'commitperclip quality gates', c => { code = c; }, out);
  } finally {
    console.error = error;
  }
  assert.equal(code, 1);
  assert.equal(readFileSync(out, 'utf8'), 'not_evaluated=true\n');
  const annotation = lines.find(l => l.includes('DID NOT EVALUATE THE DIFF'));
  assert.ok(annotation, lines.join('\n'));
  assert.match(annotation, /REVIEW_JOB_STARTED_AT_MS/);
  assert.doesNotMatch(annotation, /rate limit/i);
});

// On a warm runner the shared budget must still fund more than one headerless
// rate-limit wait. Model ghFetch's pre-sleep check with real request time: each
// read spends `rtt`, fails if the 60s floor exceeds what is left of its budget,
// else sleeps it and retries once (another `rtt`). The old per-call 120s funded
// the first read and failed the second at ~61s.
test('a warm job funds three headerless rate-limited reads with request time', async () => {
  const rtt = 1_000;
  let clock = 0;
  const funded = [];
  const fakeGhFetch = async (p, _t, { retryBudgetMs }) => {
    const deadline = clock + retryBudgetMs;
    clock += rtt;
    if (RATE_LIMIT_MIN_WAIT_MS > deadline - clock) throw new Error(`unfunded: ${p}`);
    clock += RATE_LIMIT_MIN_WAIT_MS + rtt;
    funded.push(p);
  };
  const warmElapsed = 30_000;
  const gh = budgetBoundFetch(0, qualityRetryBudgetMs(-warmElapsed + 1e12, 1e12), fakeGhFetch, () => clock);
  for (const p of ['/pull', '/files?page=2', '/comments?page=2']) await gh(p, 't');
  assert.deepEqual(funded, ['/pull', '/files?page=2', '/comments?page=2']);
  assert.ok(clock < QUALITY_STEP_TIMEOUT_MS - RATE_LIMIT_MIN_WAIT_MS, `used ${clock}ms`);
});

test('main routes every read through the shared budget, not bare ghFetch', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../run-quality-gates.mjs'),
    'utf8',
  );
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(main, /const gh = budgetBoundFetch\(startedAt, qualityRetryBudgetMs\(Number\(process\.env\.REVIEW_JOB_STARTED_AT_MS\), startedAt\)\)/);
  assert.equal((main.match(/\bghFetch\b/g) ?? []).length, 0);
  assert.match(main, /checkDependencies\([^)]*, gh\)/);
});

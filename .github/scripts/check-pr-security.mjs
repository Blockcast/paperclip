#!/usr/bin/env node
/**
 * check-pr-security.mjs
 * Runs 6 security checks against a PR diff. Never posts public comments.
 * Creates a draft security advisory in the repo if any check fires.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR
 * Exit: always 0 — security flags are silent, never block the PR visibly.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { resolveBaseRef } from './check-pr-dependencies.mjs';

// ── Pure check functions (exported for testing) ───────────────────────────────

const SECRET_PATTERNS = [
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{32,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/ },
  { name: 'High-entropy secret', re: /[a-zA-Z_]*(key|token|secret|password|credential)[a-zA-Z_]*\s*[=:]\s*["'][^"']{20,}["']/i },
];

export function scanSecrets(files) {
  const flags = [];
  for (const file of files) {
    if (!file.patch) continue;
    const added = file.patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    for (const line of added) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(line)) {
          flags.push({ check: 'secret-scan', file: file.filename, pattern: name, line: line.slice(0, 120) });
        }
      }
    }
  }
  return flags;
}

const CI_BUILD_SCRIPTS = [
  'scripts/release.sh',
  'scripts/check-docker-deps-stage.mjs',
  'scripts/check-release-package-bootstrap.mjs',
  'scripts/release-package-map.mjs',
  'scripts/docker-onboard-smoke.sh',
];

export function scanCITampering(files) {
  return files
    .filter(f => f.filename.startsWith('.github/workflows/') && f.status !== 'removed')
    .map(f => ({ check: 'ci-tampering', file: f.filename }));
}

export function scanBuildScripts(files) {
  return files
    .filter(f => CI_BUILD_SCRIPTS.includes(f.filename) && f.status !== 'removed')
    .map(f => ({ check: 'build-script-change', file: f.filename }));
}

export function scanSupplyChain(files) {
  const lockfile = files.find(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfile?.patch) return [];

  const added = new Set();
  const removed = new Set();

  for (const line of lockfile.patch.split('\n')) {
    const entry = parseLockfilePackageDiffEntry(line);
    if (!entry) continue;
    if (entry.sign === '+') added.add(entry.packageName);
    if (entry.sign === '-') removed.add(entry.packageName);
  }

  const netNew = [...added].filter(p => !removed.has(p));
  return netNew.length ? [{ check: 'supply-chain', packages: netNew }] : [];
}

function parseLockfilePackageDiffEntry(line) {
  const match = line.match(/^([+-])\s*(.+?)\s*$/);
  if (!match) return null;

  let [, sign, rawEntry] = match;
  if (!rawEntry.endsWith(':')) return null;

  rawEntry = rawEntry.slice(0, -1).trim();
  if ((rawEntry.startsWith("'") && rawEntry.endsWith("'")) || (rawEntry.startsWith('"') && rawEntry.endsWith('"'))) {
    rawEntry = rawEntry.slice(1, -1);
  }
  rawEntry = rawEntry.replace(/\(.*$/, '').trim();

  const versionSep = rawEntry.lastIndexOf('@');
  if (versionSep <= 0 || versionSep === rawEntry.length - 1) return null;

  const packageName = rawEntry.slice(0, versionSep);
  if (!/^(?:@[^/\s:]+\/)?[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(packageName)) return null;

  return { sign, packageName };
}

const TEST_FILE_RE = /\.(test|spec)\.(ts|js|tsx|jsx)$|\/(?:__tests__|tests?)\//;
const SUSPICIOUS_PATTERNS = [
  { name: 'outbound-network', re: /\+.*(fetch\(|axios\.|http\.request|https\.request)/ },
  { name: 'env-var-read', re: /\+.*process\.env\.(?!(?:NODE_ENV|CI|TEST|VITEST|npm_))([A-Z_]{4,})/ },
  { name: 'shell-exec', re: /\+.*(execSync\(|spawnSync\(|exec\(|spawn\()/ },
  { name: 'absolute-file-read', re: /\+.*(readFile|readFileSync)\s*\(\s*["'`]?\// },
];

export function scanTestPatterns(files) {
  const flags = [];
  for (const file of files) {
    if (!TEST_FILE_RE.test(file.filename) || !file.patch) continue;
    for (const { name, re } of SUSPICIOUS_PATTERNS) {
      if (re.test(file.patch)) {
        flags.push({ check: 'suspicious-test', file: file.filename, pattern: name });
      }
    }
  }
  return flags;
}

const SENSITIVE_PATHS = [
  // Advisory 1: codex-local adapter (inherited ChatGPT/Gmail OAuth scopes)
  'packages/adapters/codex-local/',
  // Advisory 2 & 11: OS command injection / privilege escalation via provisionCommand / cleanupCommand
  'server/src/services/workspace-realization.ts',
  'server/src/routes/execution-workspaces.ts',
  'server/src/routes/workspace-command-authz.ts',
  // Advisory 3 & 6: Cross-tenant agent API key minting and IDOR on /agents/:id/keys
  'server/src/routes/agents.ts',
  // Advisory 4: Approval decision attribution spoofing via decidedByUserId
  'server/src/routes/approvals.ts',
  // Advisory 5: Stored XSS via javascript: URLs in MarkdownBody (urlTransform)
  'ui/src/components/MarkdownBody.tsx',
  // Advisory 7: Unauthenticated access to authenticated-mode endpoints
  'server/src/routes/authz.ts',
  // Advisory 8: Unauthenticated RCE via import authorization bypass
  'server/src/routes/companies.ts',
  // Advisory 9: Malicious skills able to exfiltrate / destroy user data
  'server/src/routes/company-skills.ts',
  // Advisory 10: Arbitrary file read via agent-controlled instructionsFilePath
  'server/src/services/agent-instructions.ts',
];

export function scanSensitivePaths(files) {
  return files
    .filter(f => f.status !== 'removed' && SENSITIVE_PATHS.some(p => f.filename.startsWith(p)))
    .map(f => ({
      check: 'sensitive-path',
      file: f.filename,
      advisoryPath: SENSITIVE_PATHS.find(p => f.filename.startsWith(p)),
    }));
}

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename}?${new URLSearchParams({ ref }).toString()}`;
}

export async function validateSensitivePaths(token, repo, prNumber, baseRef, fetchFromGitHub = ghFetch) {
  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const stale = [];
  await Promise.all(SENSITIVE_PATHS.map(async (path) => {
    try {
      await fetchFromGitHub(buildContentsPath(repo, path, resolvedBaseRef), token);
    } catch (err) {
      // 404 means the file/directory no longer exists at this path
      if (String(err.message).includes('404')) stale.push(path);
      // Other errors (network, rate limit) — re-throw so we don't silently miss them
      else throw err;
    }
  }));
  return stale;
}

// ── Advisory creation ─────────────────────────────────────────────────────────

const SEVERITY_MAP = {
  'supply-chain': 'critical',
  'sensitive-path': 'critical',
  'secret-scan': 'high',
  'ci-tampering': 'high',
  'suspicious-test': 'high',
  'build-script-change': 'medium',
};

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function worstSeverity(flags) {
  return flags.reduce((worst, f) => {
    const s = SEVERITY_MAP[f.check] ?? 'medium';
    return SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst) ? s : worst;
  }, 'low');
}

export function formatFlagList(flags) {
  return flags.map(f => [
    `- \`${f.check}\`: ${f.file ?? ''}`,
    f.pattern ? ` (pattern: ${f.pattern})` : '',
    f.packages ? ` (packages: ${f.packages.join(', ')})` : '',
    f.line ? `\n  \`${f.line}\`` : '',
  ].join('')).join('\n');
}

const CHECK_RUN_TEXT_MAX_LENGTH = 60_000;
const CHECK_RUN_FLAG_MAX_LENGTH = 1_000;

function formatCheckRunFlag(flag) {
  return [
    `- \`${flag.check}\`: ${flag.file ?? ''}`,
    flag.pattern ? ` (pattern: ${flag.pattern})` : '',
    flag.packages ? ` (packages: ${flag.packages.join(', ')})` : '',
  ].join('').slice(0, CHECK_RUN_FLAG_MAX_LENGTH);
}

export function formatCheckRunFlagList(flags) {
  const header = '**Flags:**\n\n';
  const lines = [];

  for (const flag of flags) {
    const line = formatCheckRunFlag(flag);
    const omitted = flags.length - lines.length - 1;
    const suffix = omitted > 0 ? `\n\n_${omitted} finding(s) omitted due to check-run output limits._` : '';
    const candidate = `${header}${[...lines, line].join('\n')}${suffix}`;
    if (candidate.length > CHECK_RUN_TEXT_MAX_LENGTH) break;
    lines.push(line);
  }

  let text;
  do {
    const omitted = flags.length - lines.length;
    const suffix = omitted > 0 ? `\n\n_${omitted} finding(s) omitted due to check-run output limits._` : '';
    text = `${header}${lines.join('\n')}${suffix}`;
    if (text.length > CHECK_RUN_TEXT_MAX_LENGTH) lines.pop();
  } while (text.length > CHECK_RUN_TEXT_MAX_LENGTH);
  return text;
}

export function buildAdvisoryPayload(prNumber, prTitle, flags) {
  const checkNames = [...new Set(flags.map(f => f.check))].join(', ');
  return {
    summary: `🚨 Security flag — PR #${prNumber}: ${checkNames}`,
    description: [
    `**PR:** #${prNumber} — ${prTitle}`,
    `**Checks triggered:** ${checkNames}`,
    '',
    '**Details:**',
    formatFlagList(flags),
    '',
    '> This advisory was created automatically by commitperclip. Review and dismiss if not a real concern.',
    ].join('\n'),
    severity: worstSeverity(flags),
    vulnerabilities: [],
  };
}

export async function syncDraftAdvisory(fetchImpl, token, repo, prNumber, prTitle, flags, { signal } = {}) {
  const existing = await findExistingDraftAdvisory(fetchImpl, token, repo, prNumber, { signal });
  const payload = buildAdvisoryPayload(prNumber, prTitle, flags);

  if (existing) {
    const advisoryId = existing.ghsa_id ?? existing.id;
    if (!advisoryId) {
      throw new Error(`Existing advisory for PR #${prNumber} is missing both ghsa_id and id.`);
    }

    // PATCH rejects `vulnerabilities: []` with 422 ("Advisory must have at least one vulnerability").
    // The field is only valid on POST when creating the draft; updates must omit it.
    const { vulnerabilities, ...patchPayload } = payload;

    return fetchImpl(`/repos/${repo}/security-advisories/${advisoryId}`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchPayload),
      signal,
    });
  }

  return fetchImpl(`/repos/${repo}/security-advisories`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

// Cap pagination so a large backlog of unrelated draft advisories cannot stall
// the security gate (it runs inside a 5-minute workflow timeout).
const MAX_DRAFT_ADVISORY_PAGES = 20;

export async function findExistingDraftAdvisory(fetchImpl, token, repo, prNumber, { signal } = {}) {
  const prMarker = `PR #${prNumber}`;

  for (let page = 1; page <= MAX_DRAFT_ADVISORY_PAGES; page += 1) {
    const advisories = await fetchImpl(
      `/repos/${repo}/security-advisories?state=draft&per_page=100&page=${page}`,
      token,
      { signal },
    );

    if (!Array.isArray(advisories) || advisories.length === 0) return null;

    const existing = advisories.find(advisory =>
      typeof advisory?.summary === 'string' && advisory.summary.includes(prMarker)
    );
    if (existing) return existing;

    if (advisories.length < 100) return null;
  }

  console.warn(
    `[security] findExistingDraftAdvisory: hit ${MAX_DRAFT_ADVISORY_PAGES}-page cap without finding PR #${prNumber}; ` +
    'treating as new advisory. A duplicate draft may be created.',
  );
  return null;
}

// `advisoryResult` describes what actually happened to the draft-advisory sync
// so the check-run never asserts an advisory exists when it doesn't:
//   { ok: true, url }     — advisory created/updated; link it
//   { ok: false, error }  — sync failed; advisory state may be unknown
//   null                  — no advisory was attempted at all
export function buildSecurityCheckRunOutput(hasFlags, flags = [], advisoryResult = null) {
  if (!hasFlags) {
    return {
      title: 'Security Review Passed',
      summary: 'No security concerns detected.',
    };
  }

  if (advisoryResult?.ok) {
    return {
      title: 'Security Review Recommended',
      summary: `Draft advisory filed for maintainer review: ${advisoryResult.url}. Not a merge block — review the advisory at your leisure.`,
    };
  }

  const advisoryNote = advisoryResult
    ? `Draft advisory sync failed (${advisoryResult.error}) — advisory state is unknown.`
    : 'No draft advisory was created.';

  return {
    title: 'Security Review Recommended',
    summary: `${flags.length} security flag(s) detected. ${advisoryNote} Findings are inlined below. Not a merge block.`,
    text: formatCheckRunFlagList(flags),
  };
}

export async function postSecurityCheckRun(fetchImpl, token, repo, headSha, hasFlags, { flags = [], advisoryResult = null } = {}) {
  await fetchImpl(`/repos/${repo}/check-runs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'security-review',
      head_sha: headSha,
      // `completed/neutral` instead of `in_progress` so the check doesn't put
      // the PR in `mergeStateStatus: BLOCKED`. There is no completion path
      // that could ever flip an `in_progress` check-run back to completed on
      // the same head SHA, so it would hang forever.
      status: 'completed',
      conclusion: hasFlags ? 'neutral' : 'success',
      output: buildSecurityCheckRunOutput(hasFlags, flags, advisoryResult),
    }),
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Wall-clock budget for the whole script. The workflow job has a 5-minute
// timeout-minutes, and `continue-on-error: true` on a step does NOT override
// a job-level timeout — it only suppresses step failures. So if any API call
// (e.g. security-advisories POST/PATCH) hangs, the whole job is cancelled,
// failing the `review` check. This watchdog enforces the script's documented
// "always exit 0" contract regardless of API behaviour.
export const SCRIPT_WATCHDOG_MS = 90_000;

export function startScriptWatchdog(timeoutMs = SCRIPT_WATCHDOG_MS, exit = process.exit) {
  const timer = setTimeout(() => {
    console.warn(
      `[security] script exceeded ${timeoutMs}ms wall-clock budget; exiting 0 per always-exit-0 contract`
    );
    exit(0);
  }, timeoutMs);
  // Don't keep the event loop alive solely for the watchdog.
  timer.unref?.();
  return timer;
}

async function warnOnFailure(label, promise) {
  try {
    await promise;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[security] ${label} failed; continuing per always-exit-0 contract: ${message}`);
  }
}

export async function postFlaggedSecurityResult(
  fetchImpl,
  token,
  repo,
  pr,
  flags,
  advisoryBudgetMs,
) {
  const controller = new AbortController();
  const budgetError = new Error(`draft advisory sync exceeded ${advisoryBudgetMs}ms wall-clock budget`);
  let rejectBudget;
  const budgetExpired = new Promise((_, reject) => { rejectBudget = reject; });
  const timer = setTimeout(() => {
    controller.abort(budgetError);
    rejectBudget(budgetError);
  }, advisoryBudgetMs);

  let advisoryResult;
  try {
    const advisory = await Promise.race([
      syncDraftAdvisory(fetchImpl, token, repo, pr.number, pr.title, flags, { signal: controller.signal }),
      budgetExpired,
    ]);
    advisoryResult = { ok: true, url: advisory?.html_url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[security] draft advisory sync failed; continuing per always-exit-0 contract: ${message}`);
    advisoryResult = { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }

  await warnOnFailure(
    'security check-run update',
    postSecurityCheckRun(fetchImpl, token, repo, pr.head.sha, true, { flags, advisoryResult }),
  );
}

async function main() {
  const startedAt = Date.now();
  const watchdog = startScriptWatchdog();

  const { GH_TOKEN, GH_REPO, PR_NUMBER } = process.env;

  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER required');
    process.exit(1);
  }

  // Sanitize inputs before use in URL construction (prevents SSRF)
  const prNumber = parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  // Validate SENSITIVE_PATHS — fails loudly if any have been refactored away on the PR base branch
  const stalePaths = await validateSensitivePaths(GH_TOKEN, GH_REPO, prNumber);
  if (stalePaths.length > 0) {
    console.error('ERROR: Stale sensitive paths in check-pr-security.mjs:');
    for (const p of stalePaths) console.error(`  - ${p}`);
    console.error('');
    console.error('These paths no longer exist on the PR base branch. The security gate will silently produce no signal for them.');
    console.error('Update SENSITIVE_PATHS in check-pr-security.mjs to reflect the current code structure.');
    process.exit(1);
  }

  const [pr, files] = await Promise.all([
    ghFetch(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(ghFetch, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const allFlags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];

  if (allFlags.length > 0) {
    console.error(`[security] ${allFlags.length} flag(s) detected — creating draft advisory and pending check run`);

    // Reserve enough of the global watchdog for ghFetch's 15-second check-run
    // POST timeout plus cleanup, even if earlier GitHub reads were slow.
    const advisoryBudgetMs = Math.max(0, SCRIPT_WATCHDOG_MS - (Date.now() - startedAt) - 20_000);
    await postFlaggedSecurityResult(
      ghFetch,
      GH_TOKEN,
      GH_REPO,
      { ...pr, number: prNumber },
      allFlags,
      advisoryBudgetMs,
    );
  } else {
    console.log('[security] all clear');
    await warnOnFailure('security check-run update', postSecurityCheckRun(ghFetch, GH_TOKEN, GH_REPO, pr.head.sha, false));
  }

  // Always exit 0 — security flags are silent, never block the PR publicly
  clearTimeout(watchdog);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

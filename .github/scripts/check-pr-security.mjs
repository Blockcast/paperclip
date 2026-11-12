#!/usr/bin/env node
/**
 * check-pr-security.mjs
 * Runs 6 security checks against a PR diff. Never posts public comments.
 * Creates a draft security advisory in the repo if any check fires.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR
 * Exit: 0 on any completed run, including one that flagged — security flags are
 *   silent and never block the PR visibly, and the watchdog holds that at 90s.
 *   1 only when the run did not complete: exitFatal, which also annotates that
 *   no check evaluated the diff so the red step is not read as a finding.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch, exitFatal, GH_FETCH_DEFAULT_TIMEOUT_MS } from './get-bot-token.mjs';
import { fetchAllPullRequestFiles } from './fetch-pr-files.mjs';
import { resolveBaseRef } from './check-pr-dependencies.mjs';

// ── Pure check functions (exported for testing) ───────────────────────────────

const SECRET_PATTERNS = [
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{32,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z\-_]{35}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key', re: /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/ },
  // PEN-6162: this `\s*[=:]\s*` is the only spacing-tolerant reading of an
  // assignment anywhere in this repo. The push door's ASSIGNMENT_RE
  // (packages/adapter-utils/src/github-egress-scrub.ts) requires an UNSPACED
  // `NAME=VALUE`, so an opaque secret in prettier/PEP8/gofmt formatting reaches
  // this pattern and nothing else. It is NOT a door, in four ways:
  //   - it never refuses anything — this script exits 0 whether or not it flags
  //     (see the header), so a flag is a silent advisory;
  //   - it reads the PR diff, so it never sees a push to a branch with no PR;
  //   - it is repo-local, and the sibling repos are NOT the backstop a reader
  //     assumes. Measured first-party 2026-11-08 (PEN-6170) over both branch-
  //     protection surfaces plus a content grep of each tracked tree:
  //       * penstock-llm-proxy-core DOES gate — .github/workflows/security.yml
  //         and ci.yml run gitleaks pinned 8.28.0, diff-aware, `--exit-code 2`,
  //         and `secret-scan` is a REQUIRED status context on `main`;
  //       * onprem-k8s does NOT. It carries a .gitleaks.toml (`useDefault =
  //         true`), but nothing scans with it: the only gitleaks mention under
  //         .github/ installs the binary in a workflow_dispatch-gated harness
  //         and runs `gitleaks version`. Its required contexts are
  //         `ci/dispatched-lanes` and `review/ally-complete`. Its own CLAUDE.md
  //         says "a `.gitleaks.toml` gate exists" — that is config, not a gate;
  //       * this repo has neither a .gitleaks.toml nor a gitleaks workflow, so
  //         this line is all there is.
  //     A config is not a scan, and a scan is not a required check. Check all
  //     three before citing any repo as covered, and re-read before relying on
  //     this — it describes OTHER repos, which can gain or lose a scanner
  //     without this file changing;
  //   - it is name-anchored on detection, which github-egress-scrub.ts
  //     documents as unsound for exactly that: material hides under names
  //     nobody enumerated. Measured 2026-11-08, one synthetic value — it flags
  //     under `SESSION_SIGNING_KEY` and `WEBHOOK_SECRET`, and passes under
  //     `signingMaterial`, `SEED`, `sig` and `hmacMaterial`. gitleaks' own
  //     generic-api-key rule is anchored the same way
  //     (access|auth|api|credential|creds|key|password|secret|token), so
  //     adopting either sibling config HERE would not close this gap. Measured
  //     against the pinned gitleaks 8.28.0 (PEN-6170): with default rules and
  //     with each sibling config, one synthetic opaque value passes under
  //     `signingMaterial = "<v>"`, `signingMaterial: "<v>"`, a k8s stringData
  //     `seed-value: "<v>"` and `nonce = "<v>"`, while the same bytes under
  //     `apiSecret` are caught — same naming blind spot as this line, reached
  //     by a different tool. Closing it needs a name-free entropy rule, which
  //     fires 13,609 times on this tree today (1,297 excluding generated
  //     artifacts and lockfiles), so it is not a drop-in.
  // Do not read a green run here as evidence that a secret is not in the diff.
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

// `exec` and `spawn` are not shell-only names. Matching the bare token made
// this arm fire on `RegExp.prototype.exec` and on a Postgres client's
// `pg.exec()` -- 94 lines across 53 tracked test files that never mention
// `child_process` (PEN-6177). A noisy advisory detector trains its readers to
// dismiss it, which costs the true positives too, so the arm is split in three:
//
//   1. a call with NO receiver -- `execSync(...)` after a destructured import,
//      and the spread form `...spawnSync(...)` -- reported on its own;
//   2. a member call on a SHELL-CAPABLE receiver -- `Bun.spawn(...)` --
//      reported on its own, because the receiver names the mechanism; and
//   3. any other member call -- `cp.exec(...)` after `import * as cp from
//      "node:child_process"` -- reported only when the same patch also brings
//      `child_process` in.
//
// All three accept the optional-call form, `execSync?.(...)`, which still
// invokes (PEN-6204 item 2).
//
// Honest bound -- these are the gaps this arm is KNOWN to have. It is not a
// proof that there are no others, and a reader who treats it as one stops
// looking:
//
//   * The main gap is (3): this scanner only ever sees `file.patch`, so an
//     import that sits outside the hunks is invisible to it and a member call
//     in such a patch is not reported. (1) and (2) are unaffected, and a
//     destructured import is the dominant shape.
//   * (2)'s receiver allowlist is `Bun` alone. Measured on this tree
//     2026-11-08: zero `Bun.*` references and zero other shell-capable
//     receivers, against 20 `execSync(` call sites as a positive control
//     (PEN-6204 item 1). A runtime namespace nobody here uses yet is not
//     covered, and the list has to be extended by hand when one arrives.
//   * Indirection defeats all three -- `const e = execSync; e(cmd)`, a call
//     reached through `globalThis[name]`, or a name rebuilt from fragments.
//   * `fork` is a real `child_process` entry point and is deliberately NOT in
//     the name set: measured on this tree, zero corroborated `*.fork(` call
//     sites against five bare `fork(` ones, so today it buys noise only
//     (PEN-6204 item 5).
const SHELL_EXEC_FNS = 'execSync|spawnSync|execFileSync|execFile|exec|spawn';
// Receivers that identify the shell mechanism without corroboration.
const SHELL_EXEC_RECEIVERS = 'Bun';
// `(` or the optional-call `?.(`; both invoke.
const CALL_OPEN = String.raw`(?:\?\.)?\(`;
// `^...` under /m: a patch line that is genuinely ADDED. Unanchored, a `+`
// anywhere earlier in a context or removed line satisfied `\+.*` and the arm
// reported a line the PR does not introduce (PEN-6204 item 4).
const ADDED_LINE = String.raw`^\+.*`;

const SHELL_EXEC_CALL_RE = new RegExp(
  String.raw`${ADDED_LINE}(?:(?<![.\w$])|(?<=\.\.\.))(?:${SHELL_EXEC_FNS})${CALL_OPEN}`, 'm');
const SHELL_EXEC_RECEIVER_CALL_RE = new RegExp(
  String.raw`${ADDED_LINE}(?<![.\w$])(?:${SHELL_EXEC_RECEIVERS})\??\.(?:${SHELL_EXEC_FNS})${CALL_OPEN}`, 'm');
const SHELL_EXEC_MEMBER_CALL_RE = new RegExp(
  String.raw`${ADDED_LINE}\??\.(?:${SHELL_EXEC_FNS})${CALL_OPEN}`, 'm');
const CHILD_PROCESS_RE = /child_process/;

// The arms that may report in THIS patch. Returning the list rather than a
// boolean is what lets the flag name the line it matched: reporting a line
// matched by an arm that did not fire would point the reader at the wrong one.
function shellExecArms(patch) {
  const arms = [SHELL_EXEC_CALL_RE, SHELL_EXEC_RECEIVER_CALL_RE];
  if (CHILD_PROCESS_RE.test(patch)) arms.push(SHELL_EXEC_MEMBER_CALL_RE);
  return arms;
}

function matchesShellExec(patch) {
  return shellExecArms(patch).some(re => re.test(patch));
}

const SUSPICIOUS_PATTERNS = [
  { name: 'outbound-network', re: /^\+.*(fetch\(|axios\.|http\.request|https\.request)/m },
  { name: 'env-var-read', re: /^\+.*process\.env\.(?!(?:NODE_ENV|CI|TEST|VITEST|npm_))([A-Z_]{4,})/m },
  { name: 'shell-exec', match: matchesShellExec, arms: shellExecArms },
  { name: 'absolute-file-read', re: /^\+.*(readFile|readFileSync)\s*\(\s*["'`]?\//m },
];

// The matched line, so a reader can act on the flag without re-deriving the
// pattern from this file and grepping for it (PEN-6204 item 3). Same shape and
// same 120-char cap as `scanSecrets` above; `formatFlagList` already renders a
// `line`, and `formatCheckRunFlag` deliberately still omits it, so the check-run
// summary is unchanged.
const FLAG_LINE_MAX_LENGTH = 120;

function firstMatchingLine(patch, arms) {
  for (const line of patch.split('\n')) {
    if (arms.some(re => re.test(line))) return line.slice(0, FLAG_LINE_MAX_LENGTH);
  }
  return null;
}

export function scanTestPatterns(files) {
  const flags = [];
  for (const file of files) {
    if (!TEST_FILE_RE.test(file.filename) || !file.patch) continue;
    for (const { name, re, match, arms } of SUSPICIOUS_PATTERNS) {
      if (!(match ? match(file.patch) : re.test(file.patch))) continue;
      const line = firstMatchingLine(file.patch, arms ? arms(file.patch) : [re]);
      flags.push({ check: 'suspicious-test', file: file.filename, pattern: name, ...(line ? { line } : {}) });
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
      // A rate-limited read never completed, so it says nothing about the
      // path. Re-throw it BEFORE the 404 match: its message carries wait and
      // budget seconds, and any of them can be 404. ghFetch has already spent
      // its retry budget, and the error carries RATE_LIMIT_NOT_EVALUATED so
      // the fatal handler can say the gate never ran (BLO-37010).
      if (err?.rateLimited) throw err;
      // 404 means the file/directory no longer exists at this path. Match
      // ghFetch's own "→ <status>" delimiter, not a bare "404": the message
      // also carries the request URL, whose ref is a base SHA that can
      // contain those digits.
      if (String(err.message).includes('→ 404')) stale.push(path);
      // Everything else re-throws so we don't silently miss it.
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

// Render arbitrary text as a markdown code span that it cannot break out of.
//
// The advisory body and the check-run summary are both markdown, and three of
// the fields interpolated into them are repo-controlled: the flagged file path,
// the matched source line, and the lockfile package names. Left bare, an
// ORDINARY path renders wrong -- `server/src/__tests__/a.test.ts` comes out as
// `server/src/<strong>tests</strong>/a.test.ts`, which a maintainer cannot copy
// -- and a backtick in a matched line closes the span early, so the rest of that
// line renders as live markup instead of as the evidence it is.
//
// CommonMark 6.2 lets a code span use any fence length provided its content
// holds no backtick run that long, so pick the fence from the content rather
// than escaping the content. Content that starts or ends with a backtick or a
// space is padded with one space, which the renderer strips back off, so the
// round trip is exact.
export function mdCode(value) {
  const text = String(value ?? '').replace(/\r\n|[\r\n]/g, ' ');
  if (text === '') return '';

  const longestBacktickRun = (text.match(/`+/g) ?? [])
    .reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = '`'.repeat(longestBacktickRun + 1);
  // All-space content is never stripped, so padding it would change it.
  const pad = /^[` ]|[` ]$/.test(text) && !/^ +$/.test(text) ? ' ' : '';

  return `${fence}${pad}${text}${pad}${fence}`;
}

// `check` and `pattern` are internal constants -- 6 check names and 9 pattern
// names, every one of them `[\w .-]+` -- so they are not reachable by repo
// content and are left unfenced. Route them through `mdCode` too if either set
// ever grows a markdown metacharacter.
export function formatFlagList(flags) {
  return flags.map(f => [
    `- \`${f.check}\`: ${mdCode(f.file ?? '')}`,
    f.pattern ? ` (pattern: ${f.pattern})` : '',
    f.packages ? ` (packages: ${f.packages.map(p => mdCode(p)).join(', ')})` : '',
    f.line ? `\n  ${mdCode(f.line)}` : '',
  ].join('')).join('\n');
}

const CHECK_RUN_TEXT_MAX_LENGTH = 60_000;
const CHECK_RUN_FLAG_MAX_LENGTH = 1_000;

function formatCheckRunFlag(flag) {
  const parts = [
    `- \`${flag.check}\`: ${mdCode(flag.file ?? '')}`,
    flag.pattern ? ` (pattern: ${flag.pattern})` : '',
    flag.packages ? ` (packages: ${flag.packages.map(p => mdCode(p)).join(', ')})` : '',
  ];

  // Drop whole parts to fit instead of slicing the joined string: a slice can
  // land inside a code span and leave an unterminated fence, which would render
  // the remainder of the check-run summary as code. The first part is always
  // kept so no flag is reported as blank; `formatCheckRunFlagList` enforces the
  // real ceiling over the whole block and says what it omitted.
  let line = parts[0];
  for (const part of parts.slice(1)) {
    if (line.length + part.length > CHECK_RUN_FLAG_MAX_LENGTH) break;
    line += part;
  }
  return line;
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

// `prTitle` is author free text and so is repo-controlled, exactly like the
// `file` / `line` / `packages` fields `formatFlagList` fences -- but it is
// interpolated HERE, one function away, so those fences never reached it
// (PEN-6561). Fence the FIELD wherever it is interpolated; do not reason
// about which function happens to carry it today.
export function buildAdvisoryPayload(prNumber, prTitle, flags) {
  const checkNames = [...new Set(flags.map(f => f.check))].join(', ');
  return {
    summary: `🚨 Security flag — PR #${prNumber}: ${checkNames}`,
    description: [
    `**PR:** #${prNumber} — ${mdCode(prTitle)}`,
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

// Under `pull_request_target`, `pr.head.sha` (from the live API read) is the
// commit that actually lands. Under `merge_group`, it is not — the queue
// rebases the PR onto master's tip into a distinct candidate commit, and
// that candidate (not the original PR head) is what merges. The workflow
// passes that candidate via PR_HEAD_SHA (falling back to the PR head for
// pull_request_target runs, where the two are the same) so the check-run
// lands on the commit that is actually being evaluated for merge.
export function resolveTargetSha(pr, envHeadSha) {
  return envHeadSha || pr.head.sha;
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

// After a rate-limit sleep the retried read can still take a full per-call
// timeout, so the budget must end at least that long before the watchdog.
export const WATCHDOG_RETRY_RESERVE_MS = GH_FETCH_DEFAULT_TIMEOUT_MS + 5_000;

// ghFetch's default retry budget is longer than SCRIPT_WATCHDOG_MS. A rate-limit
// wait that crossed the watchdog would end in its silent exit(0), and the
// not-evaluated annotation from exitFatal would never print. Each read gets
// only the budget left before the watchdog, measured when that read starts.
export function watchdogBoundFetch(startedAt, fetchImpl = ghFetch, now = Date.now) {
  return (path, token, options = {}) => fetchImpl(path, token, {
    retryBudgetMs: Math.max(0, startedAt + SCRIPT_WATCHDOG_MS - WATCHDOG_RETRY_RESERVE_MS - now()),
    ...options,
  });
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
  // The commit the check-run must land on. Under `merge_group` this is the
  // queue's candidate commit, not `pr.head.sha`. Defaults to the PR head so
  // existing `pull_request_target` callers keep their behaviour exactly.
  targetSha = pr.head.sha,
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
    postSecurityCheckRun(fetchImpl, token, repo, targetSha, true, { flags, advisoryResult }),
  );
}

async function main() {
  const startedAt = Date.now();
  const watchdog = startScriptWatchdog();
  const gh = watchdogBoundFetch(startedAt);

  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_HEAD_SHA } = process.env;

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
  const stalePaths = await validateSensitivePaths(GH_TOKEN, GH_REPO, prNumber, undefined, gh);
  if (stalePaths.length > 0) {
    console.error('ERROR: Stale sensitive paths in check-pr-security.mjs:');
    for (const p of stalePaths) console.error(`  - ${p}`);
    console.error('');
    console.error('These paths no longer exist on the PR base branch. The security gate will silently produce no signal for them.');
    console.error('Update SENSITIVE_PATHS in check-pr-security.mjs to reflect the current code structure.');
    process.exit(1);
  }

  const [pr, files] = await Promise.all([
    gh(`/repos/${GH_REPO}/pulls/${prNumber}`, GH_TOKEN),
    fetchAllPullRequestFiles(gh, GH_REPO, prNumber, GH_TOKEN),
  ]);

  const allFlags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];

  const targetSha = resolveTargetSha(pr, PR_HEAD_SHA);

  if (allFlags.length > 0) {
    console.error(`[security] ${allFlags.length} flag(s) detected — creating draft advisory and pending check run`);

    // Reserve enough of the global watchdog for ghFetch's 15-second check-run
    // POST timeout plus cleanup, even if earlier GitHub reads were slow.
    const advisoryBudgetMs = Math.max(0, SCRIPT_WATCHDOG_MS - (Date.now() - startedAt) - 20_000);
    await postFlaggedSecurityResult(
      gh,
      GH_TOKEN,
      GH_REPO,
      { ...pr, number: prNumber },
      allFlags,
      advisoryBudgetMs,
      targetSha,
    );
  } else {
    console.log('[security] all clear');
    await warnOnFailure('security check-run update', postSecurityCheckRun(gh, GH_TOKEN, GH_REPO, targetSha, false));
  }

  // Always exit 0 — security flags are silent, never block the PR publicly
  clearTimeout(watchdog);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => exitFatal(e, 'commitperclip security gates'));
}

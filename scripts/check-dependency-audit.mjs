#!/usr/bin/env node
/**
 * PEN-5285: the only live-feed dependency check in this repo runs nowhere.
 *
 * THE GAP
 *
 * `grep -rln 'pnpm audit\|npm audit' .github/workflows/` returned nothing. The
 * repo's dependency-security posture was entirely STATIC: `pnpm.overrides`
 * floors, a `securityAuditRemediations` ledger, and per-package guard tests
 * asserting the lockfile honours those floors. Every one of those compares the
 * tree against a number a human wrote into the repo. None of them can see an
 * advisory published after that number was written — which is not hypothetical:
 * `pnpm.overrides` already pinned `hono: ^4.12.21` and `qs: ^6.15.2`, both
 * green, while the live feed wanted >=4.13.11 and >=6.16.1 respectively.
 *
 * `scripts/security-audit-overrides.test.js` does consult the live feed, but it
 * is reachable from no workflow, deliberately (PEN-5272): a live feed cannot
 * gate a PR without making every PR hostage to upstream publication.
 *
 * WHY A BASELINE, AND WHY NOT THE TWO SIMPLER CRITERIA
 *
 * Adding a bare `pnpm audit --prod` lane lands immediately red — 36 moderate
 * advisories were already on master at 6ce2ed8f0 (2026-11-02). A permanently
 * red scheduled lane is worse than none: it trains everyone to ignore it, and
 * the next genuinely new advisory arrives into noise. That is PEN-2847's
 * finding about ally-review-consistency, and scheduled-guard-liveness.yml
 * declined age-since-SUCCESS for exactly this reason. So the criterion has to
 * land green on 36 known moderates WITHOUT hiding the 37th.
 *
 *   * "Fail only on high/critical" (currently zero, so green on day one) is a
 *     BLANKET suppression of an entire severity class. All 36 known advisories
 *     are moderate, so a 37th moderate would be just as invisible as the 36.
 *     It buys the green lane by abandoning the thing the lane is for.
 *
 *   * "Triage all 36 to zero, then gate at zero" is honest but open-ended: the
 *     remediation set includes four major-version bumps (glob 10->14,
 *     minimatch 3/9->11, @hono/node-server 1->2, and a second
 *     postcss-selector-parser major). Gating the detector on that work means no
 *     detector until it lands, while the feed keeps moving.
 *
 * So: fail on anything NOT INDIVIDUALLY ACCOUNTED FOR, where being accounted
 * for carries an expiry. Each of the 36 is enumerated by (advisory, package)
 * with a verdict, a reason and a `reviewBy` date. There is no wildcard and no
 * package-level or severity-level blanket — the silence is per-advisory and
 * dated, so a 37th advisory matches nothing and fails.
 *
 * THE THREE FAILING CONDITIONS
 *
 *   unbaselined         a live advisory at >= moderate with no baseline entry.
 *                       This is the 37th-advisory case.
 *   expired             a baseline entry whose `reviewBy` has passed AND which
 *                       the live feed still reports. This is what stops an
 *                       accepted risk from becoming permanent invisible
 *                       silence — the same disease as the static tables.
 *   severity-escalated  a baselined entry the feed now rates HIGHER than the
 *                       severity recorded at triage. A known id is not a
 *                       licence to ignore it becoming critical.
 *
 * Reported but NOT failing: advisories below the fail threshold, and baseline
 * entries the feed no longer reports (remediated — good news; an expiry that
 * fired on good news would be the false-alarm class this file exists to avoid).
 *
 * KEYED ON (advisory, package), NOT ADVISORY ALONE
 *
 * One GHSA id can appear under more than one package: GHSA-82fw-gwwq-j7x9 is
 * reported against BOTH `vitest` and `@vitest/mocker` in this very tree. Keying
 * the baseline on the id alone would let one entry silently suppress the other
 * package's finding — a fail-open. `advisoryKey()` is the composite, and
 * check-dependency-audit.test.mjs pins it against that real pair.
 *
 * NETWORK BOUNDARY
 *
 * Everything exported here is pure: it takes an already-parsed audit document.
 * `pnpm audit` is invoked only by the CLI entry point at the bottom. That split
 * is what lets pr.yml test the COMPARISON LOGIC deterministically with no
 * network, while the live feed stays on the scheduled lane where it belongs.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SEVERITY_ORDER = ["info", "low", "moderate", "high", "critical"];
export const DEFAULT_FAIL_SEVERITIES = ["moderate", "high", "critical"];
export const VALID_VERDICTS = ["remediate", "risk-accept", "not-applicable"];

export function severityRank(severity) {
  const index = SEVERITY_ORDER.indexOf(severity);
  // An unrecognized severity ranks above everything known rather than below it.
  // A feed that invents a new top severity must fail loudly, not silently pass
  // the threshold comparison by sorting to -1.
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Composite key. See the "KEYED ON (advisory, package)" note above. */
export function advisoryKey(ghsa, packageName) {
  return `${ghsa}::${packageName}`;
}

/**
 * Normalize `pnpm audit --json` into the flat shape the comparison works on.
 * pnpm keys `advisories` by npm's numeric advisory id; the GHSA id is the
 * stable identifier across feeds, so that is what the baseline records.
 */
export function normalizeAudit(auditDocument) {
  // FAIL CLOSED ON AN UNRECOGNIZED DOCUMENT. `advisories: {}` alongside a
  // populated `metadata.vulnerabilities` is the legitimate clean tree. A
  // document with NO `advisories` key is a different thing entirely — pnpm
  // changing its JSON shape, or an empty/partial capture — and treating it as
  // "nothing found" would read every baseline entry as remediated and take the
  // lane green having measured nothing. That is the same fail-open shape as
  // keying the baseline on the advisory id alone, and it is the more dangerous
  // one because it needs no new advisory to trigger.
  if (!auditDocument || typeof auditDocument !== "object") {
    throw new Error("audit document is not an object; refusing to report a clean tree");
  }
  if (!auditDocument.advisories || typeof auditDocument.advisories !== "object") {
    throw new Error(
      "audit document has no `advisories` object — pnpm audit output shape is unrecognized. " +
        "Refusing to report a clean tree; fix the parser rather than the symptom.",
    );
  }
  if (!auditDocument.metadata?.vulnerabilities) {
    throw new Error(
      "audit document has no `metadata.vulnerabilities` — output shape is unrecognized. " +
        "Refusing to report a clean tree.",
    );
  }
  const advisories = auditDocument.advisories;
  return Object.values(advisories).map((advisory) => ({
    ghsa: advisory.github_advisory_id,
    package: advisory.module_name,
    severity: advisory.severity,
    title: advisory.title,
    patched: advisory.patched_versions,
    url: advisory.url,
    versions: [
      ...new Set((advisory.findings ?? []).map((finding) => finding.version)),
    ].sort(),
  }));
}

/**
 * Structural checks on the baseline document itself. These are deliberately
 * CLOCK-FREE: pr.yml runs them, and a check that compared `reviewBy` against
 * `Date.now()` here would turn every PR red the day an entry expired — a time
 * bomb in the merge gate, which is the failure this whole design avoids.
 * Expiry is evaluated only in evaluateAudit(), on the scheduled lane.
 */
export function validateBaseline(baseline) {
  const problems = [];
  if (baseline?.version !== 1) {
    problems.push(`baseline.version must be 1, got ${JSON.stringify(baseline?.version)}`);
  }
  if (!Array.isArray(baseline?.entries)) {
    problems.push("baseline.entries must be an array");
    return problems;
  }

  const seen = new Set();
  for (const [index, entry] of baseline.entries.entries()) {
    const at = `entries[${index}]`;
    if (typeof entry.ghsa !== "string" || !/^GHSA-/.test(entry.ghsa)) {
      problems.push(`${at}.ghsa must be a GHSA- identifier, got ${JSON.stringify(entry.ghsa)}`);
    }
    if (typeof entry.package !== "string" || entry.package === "") {
      problems.push(`${at}.package must be a non-empty string`);
    }
    if (!SEVERITY_ORDER.includes(entry.severity)) {
      problems.push(`${at}.severity must be one of ${SEVERITY_ORDER.join(", ")}, got ${JSON.stringify(entry.severity)}`);
    }
    if (!VALID_VERDICTS.includes(entry.verdict)) {
      problems.push(`${at}.verdict must be one of ${VALID_VERDICTS.join(", ")}, got ${JSON.stringify(entry.verdict)}`);
    }
    // A reason is the whole point of the artifact: an entry without one is an
    // undocumented suppression, which is what the static tables already were.
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      problems.push(`${at}.reason must be a substantive string (>= 20 chars)`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy ?? "")) {
      problems.push(`${at}.reviewBy must be an ISO yyyy-mm-dd date, got ${JSON.stringify(entry.reviewBy)}`);
    } else if (Number.isNaN(Date.parse(`${entry.reviewBy}T00:00:00Z`))) {
      problems.push(`${at}.reviewBy is not a real date: ${entry.reviewBy}`);
    }

    const key = advisoryKey(entry.ghsa, entry.package);
    if (seen.has(key)) {
      problems.push(`${at} duplicates ${key}; one entry per (advisory, package)`);
    }
    seen.add(key);
  }
  return problems;
}

/**
 * Compare the live feed against the baseline.
 * Returns { violations, notices } — violations fail the lane, notices do not.
 */
export function evaluateAudit({ audit, baseline, now = new Date() }) {
  const failFrom = severityRank(
    baseline?.failSeverities?.[0] ?? DEFAULT_FAIL_SEVERITIES[0],
  );
  const live = normalizeAudit(audit);
  const byKey = new Map(
    (baseline?.entries ?? []).map((entry) => [advisoryKey(entry.ghsa, entry.package), entry]),
  );
  const matched = new Set();

  const violations = [];
  const notices = [];

  for (const advisory of live) {
    const key = advisoryKey(advisory.ghsa, advisory.package);
    const entry = byKey.get(key);
    const atOrAboveThreshold = severityRank(advisory.severity) >= failFrom;

    if (entry) matched.add(key);

    if (!entry) {
      if (atOrAboveThreshold) {
        violations.push({
          kind: "unbaselined",
          key,
          package: advisory.package,
          severity: advisory.severity,
          detail:
            `NEW advisory ${advisory.ghsa} (${advisory.severity}) on ${advisory.package}` +
            `@${advisory.versions.join(",")} — ${advisory.title}. Fixed in ${advisory.patched}.`,
        });
      } else {
        notices.push({
          kind: "below-threshold",
          key,
          detail: `${advisory.ghsa} (${advisory.severity}) on ${advisory.package} is below the ${baseline?.failSeverities?.[0] ?? "moderate"} fail threshold; reported only.`,
        });
      }
      continue;
    }

    if (severityRank(advisory.severity) > severityRank(entry.severity)) {
      violations.push({
        kind: "severity-escalated",
        key,
        package: advisory.package,
        severity: advisory.severity,
        detail:
          `${advisory.ghsa} on ${advisory.package} was triaged at ${entry.severity} and the feed now rates it ` +
          `${advisory.severity}. Re-triage: the recorded verdict (${entry.verdict}) was reached against the lower severity.`,
      });
      continue;
    }

    // Expiry bites only while the advisory is still live. An expired entry the
    // feed no longer reports is remediated, and is a notice below.
    if (atOrAboveThreshold && isExpired(entry.reviewBy, now)) {
      violations.push({
        kind: "expired",
        key,
        package: advisory.package,
        severity: advisory.severity,
        detail:
          `${advisory.ghsa} on ${advisory.package} was accepted as "${entry.verdict}" with reviewBy ${entry.reviewBy}, ` +
          `which has passed and the advisory is still present. Re-triage it or remediate; do not simply move the date.`,
      });
    }
  }

  for (const [key, entry] of byKey) {
    if (matched.has(key)) continue;
    notices.push({
      kind: "resolved",
      key,
      detail:
        `baseline entry ${entry.ghsa} on ${entry.package} is no longer reported by the feed ` +
        `(verdict was "${entry.verdict}"). Remove it at the next revisit — a stale entry is a standing suppression.`,
    });
  }

  return { violations, notices };
}

function isExpired(reviewBy, now) {
  // End-of-day UTC, so an entry is not expired ON its review date.
  return Date.parse(`${reviewBy}T23:59:59Z`) < now.getTime();
}

export function formatReport({ violations, notices }) {
  const lines = [];
  if (violations.length === 0) {
    lines.push("Dependency audit: no unaccounted advisories.");
  } else {
    lines.push(`Dependency audit: ${violations.length} violation(s).`);
    for (const violation of violations) {
      lines.push(`  [${violation.kind}] ${violation.detail}`);
    }
  }
  if (notices.length > 0) {
    lines.push(`Notices (${notices.length}, non-failing):`);
    for (const notice of notices) lines.push(`  [${notice.kind}] ${notice.detail}`);
  }
  return lines.join("\n");
}

export async function runPnpmAudit(cwd = process.cwd()) {
  // pnpm audit exits non-zero whenever it finds anything, so a non-zero exit is
  // not an error here — only an unparseable stdout is.
  try {
    const { stdout } = await execFileAsync("pnpm", ["audit", "--prod", "--json"], {
      cwd,
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error?.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        throw new Error(
          `pnpm audit produced unparseable JSON (exit ${error.code}): ${String(error.stdout).slice(0, 500)}`,
        );
      }
    }
    throw error;
  }
}

async function main() {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const baseline = JSON.parse(
    await readFile(new URL("./dependency-audit-baseline.json", import.meta.url), "utf8"),
  );

  const schemaProblems = validateBaseline(baseline);
  if (schemaProblems.length > 0) {
    console.error("::error::dependency-audit-baseline.json is malformed:");
    for (const problem of schemaProblems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const audit = await runPnpmAudit(repoRoot);
  const result = evaluateAudit({ audit, baseline, now: new Date() });
  console.log(formatReport(result));

  if (result.violations.length > 0) {
    console.error(`::error::${result.violations.length} dependency advisory violation(s); see the report above.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

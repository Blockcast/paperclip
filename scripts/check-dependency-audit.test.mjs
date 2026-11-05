/**
 * PEN-5285. Pins the COMPARISON LOGIC of the scheduled dependency-audit lane.
 *
 * This file runs in pr.yml and must stay deterministic and offline: every case
 * below feeds a hand-built audit document to the pure evaluator. The live
 * `pnpm audit` call lives behind runPnpmAudit() and is exercised only by the
 * scheduled workflow — a PR gate that reached the advisory feed would go red
 * for reasons no PR caused, which is the whole reason the lane is scheduled.
 *
 * For the same reason nothing here compares a baseline `reviewBy` against the
 * real clock. Expiry is tested with an injected `now`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_FAIL_SEVERITIES,
  SEVERITY_ORDER,
  advisoryKey,
  evaluateAudit,
  formatReport,
  normalizeAudit,
  severityRank,
  validateBaseline,
} from "./check-dependency-audit.mjs";

const NOW = new Date("2026-11-02T12:00:00Z");

function advisory({ id, ghsa, pkg, severity = "moderate", version = "1.0.0", patched = ">=2.0.0" }) {
  return {
    [id]: {
      id,
      github_advisory_id: ghsa,
      module_name: pkg,
      severity,
      title: `${pkg} is vulnerable`,
      patched_versions: patched,
      cves: [],
      url: `https://github.com/advisories/${ghsa}`,
      findings: [{ version, paths: [] }],
    },
  };
}

/** Wrap advisories in the document shape pnpm actually emits. */
function auditDoc(advisories = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const a of Object.values(advisories)) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  return { advisories, metadata: { vulnerabilities: counts } };
}

function baselineOf(entries, overrides = {}) {
  return {
    version: 1,
    scope: "pnpm audit --prod",
    failSeverities: DEFAULT_FAIL_SEVERITIES,
    entries,
    ...overrides,
  };
}

function entry(partial) {
  return {
    ghsa: "GHSA-aaaa-bbbb-cccc",
    package: "pkg",
    severity: "moderate",
    verdict: "risk-accept",
    reviewBy: "2027-01-01",
    reason: "a sufficiently long recorded reason for this suppression",
    ...partial,
  };
}

test("an unbaselined moderate advisory fails the lane", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 1, ghsa: "GHSA-new1-aaaa-bbbb", pkg: "left-pad" })),
    baseline: baselineOf([]),
    now: NOW,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "unbaselined");
  assert.match(violations[0].detail, /GHSA-new1-aaaa-bbbb/);
});

test("an unbaselined advisory BELOW the fail threshold is a notice, not a violation", () => {
  // The lane must land green on a tree carrying low-severity findings; master
  // had six of them when this was written.
  const { violations, notices } = evaluateAudit({
    audit: auditDoc(advisory({ id: 2, ghsa: "GHSA-low1-aaaa-bbbb", pkg: "cli", severity: "low" })),
    baseline: baselineOf([]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "below-threshold");
});

test("a baselined advisory inside its review window does not fail the lane", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 3, ghsa: "GHSA-know-aaaa-bbbb", pkg: "hono" })),
    baseline: baselineOf([entry({ ghsa: "GHSA-know-aaaa-bbbb", package: "hono", reviewBy: "2027-01-01" })]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
});

test("the review-by date is inclusive: an entry is not expired ON its own date", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 4, ghsa: "GHSA-edge-aaaa-bbbb", pkg: "hono" })),
    baseline: baselineOf([entry({ ghsa: "GHSA-edge-aaaa-bbbb", package: "hono", reviewBy: "2026-11-02" })]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
});

test("a baselined advisory past its review-by, still live, fails the lane", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 5, ghsa: "GHSA-old1-aaaa-bbbb", pkg: "hono" })),
    baseline: baselineOf([entry({ ghsa: "GHSA-old1-aaaa-bbbb", package: "hono", reviewBy: "2026-11-01" })]),
    now: NOW,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "expired");
  assert.match(violations[0].detail, /do not simply move the date/);
});

test("an expired entry the feed NO LONGER reports is a notice, not a violation", () => {
  // Remediation must not turn the lane red. An expiry that fired on good news
  // is the false-alarm class this design exists to avoid.
  const { violations, notices } = evaluateAudit({
    audit: auditDoc({}),
    baseline: baselineOf([entry({ ghsa: "GHSA-gone-aaaa-bbbb", package: "hono", reviewBy: "2020-01-01" })]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "resolved");
});

test("a baselined advisory the feed escalates above its triaged severity fails the lane", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 6, ghsa: "GHSA-esc1-aaaa-bbbb", pkg: "hono", severity: "critical" })),
    baseline: baselineOf([entry({ ghsa: "GHSA-esc1-aaaa-bbbb", package: "hono", severity: "moderate" })]),
    now: NOW,
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, "severity-escalated");
});

test("a DE-escalated advisory does not fail the lane", () => {
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 7, ghsa: "GHSA-de01-aaaa-bbbb", pkg: "hono", severity: "low" })),
    baseline: baselineOf([entry({ ghsa: "GHSA-de01-aaaa-bbbb", package: "hono", severity: "moderate" })]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
});

test("one GHSA id under two packages needs two entries — one must not suppress the other", () => {
  // THE FAIL-OPEN THIS KEY SHAPE EXISTS TO CLOSE. GHSA-82fw-gwwq-j7x9 is
  // reported against BOTH vitest and @vitest/mocker in this repo's real audit.
  // Keyed on the advisory id alone, baselining either would silence both.
  const audit = auditDoc({
    ...advisory({ id: 8, ghsa: "GHSA-82fw-gwwq-j7x9", pkg: "vitest" }),
    ...advisory({ id: 9, ghsa: "GHSA-82fw-gwwq-j7x9", pkg: "@vitest/mocker" }),
  });
  const { violations } = evaluateAudit({
    audit,
    baseline: baselineOf([entry({ ghsa: "GHSA-82fw-gwwq-j7x9", package: "vitest" })]),
    now: NOW,
  });
  assert.equal(violations.length, 1, "the unbaselined package must still fail");
  assert.equal(violations[0].kind, "unbaselined");
  assert.equal(violations[0].package, "@vitest/mocker");
  assert.equal(advisoryKey("GHSA-82fw-gwwq-j7x9", "vitest") !== advisoryKey("GHSA-82fw-gwwq-j7x9", "@vitest/mocker"), true);
});

test("an unrecognized severity ranks above every known one rather than below", () => {
  // Sorting an unknown severity to -1 would let a feed that invents a new top
  // severity slip under the threshold silently.
  assert.ok(severityRank("apocalyptic") > severityRank("critical"));
  assert.ok(severityRank("moderate") > severityRank("low"));
  const { violations } = evaluateAudit({
    audit: auditDoc(advisory({ id: 10, ghsa: "GHSA-unk1-aaaa-bbbb", pkg: "pkg", severity: "apocalyptic" })),
    baseline: baselineOf([]),
    now: NOW,
  });
  assert.equal(violations.length, 1);
});

test("normalizeAudit dedupes and sorts the resolved versions of a multi-finding advisory", () => {
  const rows = normalizeAudit(auditDoc({
      11: {
        github_advisory_id: "GHSA-mult-aaaa-bbbb",
        module_name: "minimatch",
        severity: "moderate",
        title: "t",
        patched_versions: ">=11.0.1",
        findings: [{ version: "9.0.9" }, { version: "3.1.5" }, { version: "9.0.9" }],
      },
  }));
  assert.deepEqual(rows[0].versions, ["3.1.5", "9.0.9"]);
});

test("validateBaseline rejects every malformed field shape", () => {
  assert.ok(validateBaseline({ version: 2, entries: [] }).some((p) => /version must be 1/.test(p)));
  assert.ok(validateBaseline({ version: 1 }).some((p) => /entries must be an array/.test(p)));
  const bad = (patch, pattern) =>
    assert.ok(
      validateBaseline(baselineOf([entry(patch)])).some((p) => pattern.test(p)),
      `expected a problem matching ${pattern}`,
    );
  bad({ ghsa: "CVE-2026-1" }, /must be a GHSA- identifier/);
  bad({ package: "" }, /package must be a non-empty string/);
  bad({ severity: "spicy" }, /severity must be one of/);
  bad({ verdict: "ignore" }, /verdict must be one of/);
  bad({ reason: "too short" }, /reason must be a substantive string/);
  bad({ reviewBy: "soon" }, /reviewBy must be an ISO/);
  bad({ reviewBy: "2026-13-45" }, /reviewBy/);
});

test("validateBaseline rejects a duplicate (advisory, package) pair but allows the same id twice", () => {
  const dup = validateBaseline(
    baselineOf([entry({ ghsa: "GHSA-dup1-aaaa-bbbb", package: "a" }), entry({ ghsa: "GHSA-dup1-aaaa-bbbb", package: "a" })]),
  );
  assert.ok(dup.some((p) => /duplicates GHSA-dup1-aaaa-bbbb::a/.test(p)));

  const sameIdDifferentPackage = validateBaseline(
    baselineOf([entry({ ghsa: "GHSA-dup1-aaaa-bbbb", package: "a" }), entry({ ghsa: "GHSA-dup1-aaaa-bbbb", package: "b" })]),
  );
  assert.deepEqual(sameIdDifferentPackage, []);
});

test("the checked-in baseline is structurally valid", async () => {
  const baseline = JSON.parse(
    await readFile(new URL("./dependency-audit-baseline.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateBaseline(baseline), []);
  assert.ok(baseline.entries.length > 0, "baseline must not be empty");
  // Every entry carries a verdict that says what was decided, not merely that
  // something was. A bare count is not the deliverable (PEN-5285 done-when 3).
  for (const e of baseline.entries) {
    assert.ok(e.introducedVia === null || typeof e.introducedVia === "string");
    assert.ok(e.reason.length >= 20, `${e.ghsa}::${e.package} reason too thin`);
  }
});

test("formatReport names the green case explicitly", () => {
  assert.match(formatReport({ violations: [], notices: [] }), /no unaccounted advisories/);
  assert.match(
    formatReport({ violations: [{ kind: "unbaselined", detail: "d" }], notices: [] }),
    /1 violation\(s\)[\s\S]*\[unbaselined\] d/,
  );
});

test("an unrecognized audit document shape throws rather than reporting a clean tree", () => {
  // THE FAIL-OPEN THIS GUARD CLOSES. If pnpm's JSON shape changes, or the
  // capture is empty/partial, `advisories` goes missing. Treating that as
  // "nothing found" would mark every baseline entry remediated and take the
  // lane GREEN having measured nothing — and unlike a new advisory, this needs
  // no external event to trigger.
  const baseline = baselineOf([entry({ ghsa: "GHSA-know-aaaa-bbbb", package: "hono" })]);
  for (const bad of [null, undefined, "{}", { metadata: { vulnerabilities: {} } }, { advisories: {} }]) {
    assert.throws(
      () => evaluateAudit({ audit: bad, baseline, now: NOW }),
      /refusing to report a clean tree|Refusing to report a clean tree/i,
      `shape ${JSON.stringify(bad)} must not read as clean`,
    );
  }
});

test("a genuinely clean tree — empty advisories WITH metadata — is accepted", () => {
  // The legitimate counterpart: this must stay green, or remediating everything
  // would break the lane.
  const { violations, notices } = evaluateAudit({
    audit: auditDoc({}),
    baseline: baselineOf([entry({ ghsa: "GHSA-know-aaaa-bbbb", package: "hono" })]),
    now: NOW,
  });
  assert.deepEqual(violations, []);
  assert.equal(notices[0].kind, "resolved");
});

test("an expired entry whose advisory has fallen BELOW the fail threshold does not fail the lane", () => {
  // The `atOrAboveThreshold &&` conjunct on the expiry check. Without it, an
  // entry triaged at moderate and since de-escalated to low would fail the lane
  // on its review date — re-introducing noise from an advisory the threshold
  // says we are not gating on. Found by mutation: deleting the conjunct passed
  // the whole suite until this case existed.
  const { violations, notices } = evaluateAudit({
    audit: auditDoc(advisory({ id: 12, ghsa: "GHSA-dexp-aaaa-bbbb", pkg: "hono", severity: "low" })),
    baseline: baselineOf([
      entry({ ghsa: "GHSA-dexp-aaaa-bbbb", package: "hono", severity: "moderate", reviewBy: "2020-01-01" }),
    ]),
    now: NOW,
  });
  assert.deepEqual(violations, [], "a below-threshold advisory must not fail on expiry");
  assert.deepEqual(notices, [], "it is baselined, so it is not a below-threshold notice either");
});

test("a typo in failSeverities is refused, and cannot invert the threshold into a fail-open", () => {
  // Ally's measured case on #3290: `{failSeverities:["hgih"]}` validated clean
  // and a live HIGH advisory with no entry produced ZERO violations. The cause
  // is that severityRank fails CLOSED for advisories (unknown ranks above
  // critical) — applied to the threshold, that same rule means nothing can ever
  // meet it. validateBaseline now refuses the typo at the PR gate.
  const problems = validateBaseline(baselineOf([], { failSeverities: ["hgih"] }));
  assert.ok(problems.some((p) => /failSeverities contains "hgih"/.test(p)));

  assert.ok(
    validateBaseline(baselineOf([], { failSeverities: [] }))
      .some((p) => /non-empty array/.test(p)),
  );
  assert.ok(
    validateBaseline(baselineOf([], { failSeverities: "moderate" }))
      .some((p) => /non-empty array/.test(p)),
  );
  // Omitted is legal — the default applies.
  assert.deepEqual(validateBaseline({ version: 1, entries: [] }), []);
});

test("failSeverities is a SET: reordering it cannot raise the threshold", () => {
  // Taking element [0] let `["critical","moderate"]` silently gate at critical
  // while reading as though moderate were still covered. The min is
  // order-independent, so both spellings gate identically.
  const high = auditDoc(advisory({ id: 13, ghsa: "GHSA-hi01-aaaa-bbbb", pkg: "left-pad", severity: "high" }));
  const moderate = auditDoc(advisory({ id: 14, ghsa: "GHSA-mo01-aaaa-bbbb", pkg: "left-pad" }));

  for (const order of [["moderate", "high", "critical"], ["critical", "moderate", "high"]]) {
    const baseline = baselineOf([], { failSeverities: order });
    assert.equal(evaluateAudit({ audit: high, baseline, now: NOW }).violations.length, 1, `high, order ${order}`);
    assert.equal(evaluateAudit({ audit: moderate, baseline, now: NOW }).violations.length, 1, `moderate, order ${order}`);
  }

  // A genuinely raised threshold still works: gating only at critical lets a
  // moderate through as a notice, and that must stay true.
  const criticalOnly = baselineOf([], { failSeverities: ["critical"] });
  assert.deepEqual(evaluateAudit({ audit: moderate, baseline: criticalOnly, now: NOW }).violations, []);
  assert.equal(evaluateAudit({ audit: high, baseline: criticalOnly, now: NOW }).violations.length, 0);
});

test("the checked-in baseline's failSeverities is itself valid", () => {
  // The whole point of validating this knob is that the REAL file is checked on
  // every PR, so a typo cannot reach the scheduled lane.
  const baseline = JSON.parse(
    readFileSync(new URL("./dependency-audit-baseline.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(validateBaseline(baseline), []);
  assert.ok(baseline.failSeverities.every((s) => SEVERITY_ORDER.includes(s)));
});

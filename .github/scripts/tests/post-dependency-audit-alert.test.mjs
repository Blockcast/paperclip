// Coverage for `post-dependency-audit-alert.mjs` — PEN-5285.
//
// The alert is the only part of the scheduled dependency-audit lane that
// reaches a human, so the properties worth pinning are the two that decide
// whether the route keeps believing it: that NOTICES never page (the lane
// reports below-threshold advisories and remediated baseline entries, and
// paging on good news is how an alert gets ignored), and that the TTL exceeds
// the daily cadence so a persistent advisory deduplicates instead of re-firing
// as new every morning.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_TTL_MS, buildAlert, extractViolations } from "../post-dependency-audit-alert.mjs";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const base = { runUrl: "https://run", repo: "Blockcast/paperclip", now: NOW };

const REPORT = [
  "Dependency audit: 3 violation(s).",
  "  [unbaselined] NEW advisory GHSA-new1-aaaa-bbbb (high) on left-pad@1.0.0 — bad. Fixed in >=2.",
  "  [expired] GHSA-old1-aaaa-bbbb on hono was accepted as \"risk-accept\" with reviewBy 2026-01-01",
  "  [severity-escalated] GHSA-esc1-aaaa-bbbb on qs was triaged at moderate",
  "Notices (2, non-failing):",
  "  [below-threshold] GHSA-low1-aaaa-bbbb (low) on cli is below the moderate fail threshold",
  "  [resolved] baseline entry GHSA-gone-aaaa-bbbb on mermaid is no longer reported",
].join("\n");

test("extractViolations takes the three failing kinds and drops notices", () => {
  const found = extractViolations(REPORT);
  assert.equal(found.length, 3);
  assert.ok(found.every((line) => !/below-threshold|resolved/.test(line)));
  assert.match(found[0], /^\[unbaselined\]/);
  assert.match(found[1], /^\[expired\]/);
  assert.match(found[2], /^\[severity-escalated\]/);
});

test("a report with notices only yields no violations", () => {
  // The green case. If this ever returned a line, every green run would page.
  const green = [
    "Dependency audit: no unaccounted advisories.",
    "Notices (1, non-failing):",
    "  [below-threshold] GHSA-low1-aaaa-bbbb (low) on cli is below the moderate fail threshold",
  ].join("\n");
  assert.deepEqual(extractViolations(green), []);
});

test("extractViolations tolerates a missing or empty report", () => {
  assert.deepEqual(extractViolations(null), []);
  assert.deepEqual(extractViolations(""), []);
});

test("the alert carries stable dedupe labels and a runbook link", () => {
  const alert = buildAlert({ ...base, violations: extractViolations(REPORT) });
  assert.equal(alert.labels.alertname, "DependencyAdvisoryUnaccounted");
  assert.equal(alert.labels.service, "paperclip-dependency-audit");
  assert.equal(alert.labels.repo, "Blockcast/paperclip");
  assert.equal(alert.labels.branch, "master");
  assert.match(alert.annotations.runbook_url, /runbooks\/dependency-audit\.md$/);
  assert.match(alert.annotations.description, /GHSA-new1-aaaa-bbbb/);
});

test("the TTL outlives the daily cadence so a persistent advisory deduplicates", () => {
  // A TTL below 24h would let the alert resolve between runs and re-fire as new
  // every day — which is exactly the "trains everyone to ignore it" failure the
  // lane's baseline design exists to prevent, reintroduced at the alert layer.
  assert.ok(ALERT_TTL_MS > 24 * 60 * 60 * 1000, "TTL must exceed the 24h schedule interval");
  const alert = buildAlert({ ...base, violations: ["x"] });
  assert.equal(new Date(alert.endsAt) - new Date(alert.startsAt), ALERT_TTL_MS);
});

test("an unreadable report still produces a deliverable alert", () => {
  // Losing the detail must not lose the page -- it only changes which alert.
  const alert = buildAlert({ ...base, violations: null });
  assert.match(alert.annotations.description, /see the run log/);
  assert.equal(alert.labels.alertname, "DependencyAuditIncomplete");
  assert.match(alert.annotations.runbook_url, /runbooks\/dependency-audit\.md$/);
});

test("a lane that could not COMPLETE gets a different alertname than one that found an advisory", () => {
  // The two failures route to different people: an unaccounted advisory is a
  // triage task, a lane that could not run at all (registry unreachable, pnpm
  // error document, malformed baseline, unrecognized audit shape) is an infra
  // task. One alertname for both sent the on-call hunting for an advisory that
  // was never reported. Raised by Ally on #3290.
  const found = buildAlert({ ...base, violations: ["[unbaselined] NEW advisory GHSA-x"] });
  const incomplete = buildAlert({ ...base, violations: null });

  assert.equal(found.labels.alertname, "DependencyAdvisoryUnaccounted");
  assert.equal(incomplete.labels.alertname, "DependencyAuditIncomplete");
  assert.notEqual(found.labels.alertname, incomplete.labels.alertname);

  assert.match(found.annotations.summary, /dependency advisory with no triage entry/);
  assert.match(incomplete.annotations.summary, /could not complete/);
  assert.doesNotMatch(
    incomplete.annotations.summary,
    /advisory with no triage entry/,
    "an infra failure must not be described as an advisory finding",
  );

  // An empty array is the same condition as null: extractViolations found none.
  assert.equal(buildAlert({ ...base, violations: [] }).labels.alertname, "DependencyAuditIncomplete");
  // Both still deduplicate on the same service label.
  assert.equal(found.labels.service, incomplete.labels.service);
});

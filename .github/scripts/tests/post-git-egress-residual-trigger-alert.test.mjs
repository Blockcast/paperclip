// Coverage for `post-git-egress-residual-trigger-alert.mjs` — PEN-4988.
//
// The alert is the only part of this guard that reaches a human, so the property
// worth pinning is that exit 1 and exit 2 stay DISTINGUISHABLE. Collapsing them
// would report "bypass 3 has re-opened" when the truth is "nothing is watching
// for bypass 3 re-opening" — a condition nobody has observed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALERT_TTL_MS, buildAlert, parseReasons } from "../post-git-egress-residual-trigger-alert.mjs";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const REPORT = [
  "PEN-3183 §7.2 trigger 2 — agent Job rendered a broad data mount",
  "occurrences    = 3",
  "verdict        = fired",
  "reasons        = foreign_claim, isolation_disabled",
].join("\n");

const base = { detail: REPORT, runUrl: "https://run", repo: "Blockcast/paperclip", now: NOW };

test("exit 1 and exit 2 carry different alertnames", () => {
  assert.equal(buildAlert({ ...base, exitCode: "1" }).labels.alertname, "GitEgressResidualTriggerFired");
  assert.equal(
    buildAlert({ ...base, exitCode: "2" }).labels.alertname,
    "GitEgressResidualTriggerCheckUnreadable",
  );
});

test("anything that is not exactly '1' is treated as unreadable, never as fired", () => {
  // Fail-safe direction: a garbled exit code must not be able to raise the
  // stronger alarm, and must not be silently dropped either.
  for (const exitCode of ["", "0", "2", "nonsense", undefined]) {
    assert.notEqual(buildAlert({ ...base, exitCode }).labels.alertname, "GitEgressResidualTriggerFired");
  }
});

test("the fired alert carries the gate leg, which is the remedy selector", () => {
  const alert = buildAlert({ ...base, exitCode: "1" });
  assert.match(alert.annotations.description, /foreign_claim, isolation_disabled/);
  assert.match(alert.annotations.description, /ENDS THE RESIDUAL ACCEPTANCE EARLY/);
  assert.match(alert.annotations.summary, /trigger 2 FIRED/);
});

test("a report with no reasons line degrades to a pointer, not to a crash", () => {
  assert.equal(parseReasons("verdict = fired"), null);
  const alert = buildAlert({ ...base, detail: "verdict = fired", exitCode: "1" });
  assert.match(alert.annotations.description, /\(see the run log\)/);
});

test("the unreadable alert says it is NOT a clear verdict", () => {
  const alert = buildAlert({ ...base, exitCode: "2" });
  assert.match(alert.annotations.description, /NOT reporting that/);
  assert.match(alert.annotations.description, /FALSE CLEAR/);
});

test("labels are stable so Alertmanager deduplicates the hourly re-firing", () => {
  // A fired trigger re-fires every hour until someone acts; without stable
  // labels that is a new alert per run.
  const a = buildAlert({ ...base, exitCode: "1" });
  const b = buildAlert({ ...base, exitCode: "1", now: new Date(NOW.getTime() + 3_600_000) });
  assert.deepEqual(a.labels, b.labels);
  assert.equal(a.labels.severity, "critical");
  assert.equal(a.labels.service, "paperclip-git-egress-residual-trigger-check");
});

test("the alert expires, so a resolved trigger stops paging on its own", () => {
  const alert = buildAlert({ ...base, exitCode: "1" });
  assert.equal(new Date(alert.endsAt) - new Date(alert.startsAt), ALERT_TTL_MS);
  // TTL must exceed the hourly cadence or the alert gaps between runs.
  assert.ok(ALERT_TTL_MS > 60 * 60 * 1000);
});

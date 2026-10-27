import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildAlert,
  parseDetail,
} from "../../.github/scripts/post-stranded-approval-lock-alert.mjs";

const workflowSource = readFileSync(
  new URL("../../.github/workflows/stranded-approval-lock-check.yml", import.meta.url),
  "utf8",
);

// A verbatim stranded report from scripts/check-stranded-approval-lock.sh,
// using the real PEN-4841 values. Held as a fixture rather than regenerated,
// because the parser's whole job is to survive THIS layout: the script pads its
// keys to a column, so `lock_digest` and `lock_owner` carry runs of spaces
// around the `=` that a naive split would fold into the value and make the
// pasted pair silently wrong.
const STRANDED_REPORT = `lock_digest        = sha256:c3c65a0480cd5e8c8fb0fed0438dc02fa2eb06f179432b64f37cebb29f2730f9
lock_owner         = 1cc6378456ba6d8b70a88ae48d70a8606cbd166e3097faf28e0373822ae2babe
lock_written_at    = 2026-10-26T07:50:12Z
lock_age_minutes   = 745
grace_minutes      = 155
image_match        = true
marker_match       = true
advanced           = true
serving_healthy    = true
server_plan_match  = false  (locked 326761a8, live 303744d2)
rollout_complete   = true
verdict=stranded
This lock's rollout completed, but the live Deployment no longer canonicalizes to the
server plan the approval recorded, so the next approval still refuses to advance it.
`;

describe("parseDetail", () => {
  it("lifts the retirement pair out of the column-padded report", () => {
    const { digest, owner, verdict } = parseDetail(STRANDED_REPORT);
    assert.equal(
      digest,
      "sha256:c3c65a0480cd5e8c8fb0fed0438dc02fa2eb06f179432b64f37cebb29f2730f9",
    );
    assert.equal(owner, "1cc6378456ba6d8b70a88ae48d70a8606cbd166e3097faf28e0373822ae2babe");
    assert.equal(verdict, "stranded");
  });

  it("returns null rather than a partial value when the report is missing", () => {
    assert.deepEqual(parseDetail(""), { digest: null, owner: null, verdict: null });
    assert.deepEqual(parseDetail(undefined), { digest: null, owner: null, verdict: null });
  });
});

describe("buildAlert", () => {
  const now = new Date("2026-10-27T09:00:00.000Z");

  it("carries the pasteable pair into the alert body on exit 1", () => {
    const alert = buildAlert({
      exitCode: "1",
      detail: STRANDED_REPORT,
      runUrl: "https://example/run/1",
      repo: "Blockcast/paperclip",
      now,
    });

    assert.equal(alert.labels.alertname, "StrandedApprovalLockDetected");
    assert.equal(alert.labels.severity, "critical");

    // The remedy has to survive the trip to Slack. An alert that only says
    // "a lock is stranded" sends the reader back to the run log for the two
    // values they need, which is the latency this whole row exists to remove.
    assert.match(alert.annotations.description, /abandon_in_flight: +sha256:c3c65a04/);
    assert.match(alert.annotations.description, /abandon_in_flight_owner: +1cc63784/);

    // target_sha is `required: true` on docker.yml's dispatch form. PEN-4841's
    // first write-up omitted it and an operator following that text would have
    // met an unfillable required box.
    assert.match(alert.annotations.description, /target_sha/);
  });

  it("gives exit 2 its own alertname and never implies the lock is fine", () => {
    const alert = buildAlert({
      exitCode: "2",
      detail: "",
      runUrl: "https://example/run/2",
      repo: "Blockcast/paperclip",
      now,
    });

    // Different condition, different remedy. Folding "cannot see the cluster"
    // into "a lock is stranded" would report a thing nobody observed.
    assert.equal(alert.labels.alertname, "StrandedApprovalLockCheckUnreadable");
    assert.notEqual(alert.labels.alertname, "StrandedApprovalLockDetected");
    assert.match(alert.annotations.description, /NOT reporting that the lock is fine/);
  });

  it("degrades to a pointer rather than printing a bogus pair when the report is unparseable", () => {
    const alert = buildAlert({
      exitCode: "1",
      detail: "verdict=stranded\n(the report did not render)",
      runUrl: "https://example/run/3",
      repo: "Blockcast/paperclip",
      now,
    });

    // `abandon_in_flight: null` pasted into a dispatch form is worse than an
    // explicit pointer back to the log.
    assert.doesNotMatch(alert.annotations.description, /null/);
    assert.match(alert.annotations.description, /see the run log/);
  });
});

describe("the workflow wiring", () => {
  // Both non-zero exits must reach the alert step AND the failing step. The
  // detector exits 1 and 2 for different reasons and `!= '0'` is what covers
  // both; an `== '1'` would silently drop every unreadable run on the floor,
  // which is the exact shape of "nothing is watching" this row is about.
  it("alerts and fails on every non-zero exit, not only on stranded", () => {
    const conditions = [...workflowSource.matchAll(/if: steps\.check\.outputs\.exit_code (\S+) '(\d)'/g)]
      .map((m) => `${m[1]} ${m[2]}`);

    assert.ok(conditions.length >= 2, "the alert and fail steps are no longer gated on exit_code");
    for (const condition of conditions) {
      assert.equal(condition, "!= 0", "a step is gated on one specific exit code");
    }
  });

  it("keeps continue-on-error on the check, so a non-zero exit reaches the alert", () => {
    // Without it the job stops at the check and the alert — the only part that
    // reaches a human — never fires. A red run alone notifies the last
    // committer, which is the failure mode this workflow exists to avoid.
    assert.match(workflowSource, /id: check\n\s+continue-on-error: true/);
  });

  it("declares no environment, so hourly runs cannot bury the production deploy record", () => {
    // Declaring `environment:` is the only way to read
    // KUBECONFIG_PAPERCLIP_CI_DEPLOY, and it would also mint a GitHub deployment
    // record on EVERY run. paperclip-production carries ~1 record per daily
    // deploy today; ~24/day from a read-only detector would bury that audit
    // trail. The workflow header records the fallback if the repo-level
    // credential turns out to lack the two `get`s.
    assert.doesNotMatch(workflowSource, /^\s*environment:/m);
  });

  it("runs on a lane with proven cluster reach", () => {
    // arc-paperclip-deploy is restricted to three allowlisted workflows, so a
    // new workflow there would queue with no eligible runner, forever — green
    // -looking and never executing. arc-paperclip-light is where
    // relay-ssl-multicert-guard.yml already reaches the cluster hourly.
    assert.match(workflowSource, /runs-on: arc-paperclip-light/);
    assert.doesNotMatch(workflowSource, /runs-on: arc-paperclip-deploy/);
  });

  it("invokes the detector rather than restating its predicates", () => {
    // A detector that disagrees with the gate it detects for is worse than
    // none; the script derives every predicate from the shipping approval
    // script for that reason. This workflow must not grow its own copy.
    assert.match(workflowSource, /scripts\/check-stranded-approval-lock\.sh/);
  });
});

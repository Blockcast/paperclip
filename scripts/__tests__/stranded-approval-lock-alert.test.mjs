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

// The same report for a lock carrying no owner annotation. The detector pads and
// renders the placeholder itself; this is its output, not a hand-made string.
const OWNERLESS_REPORT = STRANDED_REPORT.replace(
  /^lock_owner +=.*$/m,
  "lock_owner         = <empty>",
);

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

  it("reads the detector's angle-bracketed placeholder as absent, not as a value", () => {
    // check-stranded-approval-lock.sh:263 renders a lock with no owner
    // annotation as `lock_owner         = <empty>`. Taken literally that became
    // `abandon_in_flight_owner: <empty>` in the alert -- an instruction to paste
    // the word "<empty>" into docker.yml's dispatch form.
    const { digest, owner } = parseDetail(
      OWNERLESS_REPORT,
    );
    assert.equal(
      digest,
      "sha256:c3c65a0480cd5e8c8fb0fed0438dc02fa2eb06f179432b64f37cebb29f2730f9",
    );
    assert.equal(owner, null);
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

  it("never tells the operator to paste the placeholder for an ownerless lock", () => {
    const alert = buildAlert({
      exitCode: "1",
      detail: OWNERLESS_REPORT,
      runUrl: "https://example/run/4",
      repo: "Blockcast/paperclip",
      now,
    });

    // `<empty>` is not a value docker.yml's form accepts. The detector's own
    // pasteable block (check-stranded-approval-lock.sh:322) says such a lock has
    // to be retired by hand; the alert must carry that, not the placeholder.
    assert.doesNotMatch(alert.annotations.description, /abandon_in_flight_owner: +<empty>/);
    assert.match(alert.annotations.description, /abandon_in_flight_owner: +<MISSING/);
    assert.match(alert.annotations.description, /retire it by hand/);

    // The digest still rendered, so the half of the remedy that IS pasteable
    // must not be degraded along with the half that is not.
    assert.match(alert.annotations.description, /abandon_in_flight: +sha256:c3c65a04/);
  });

  it("names every cause of exit 2, not RBAC alone", () => {
    const alert = buildAlert({
      exitCode: "2",
      detail: "",
      runUrl: "https://example/run/5",
      repo: "Blockcast/paperclip",
      now,
    });

    // Exit 2 covers a missing tool and an unconfigured kubeconfig as well as
    // RBAC -- and since the kubeconfig step is continue-on-error, the
    // kubeconfig case is now the one most likely to land here. Naming only RBAC
    // sends the reader to check permissions that were never the problem.
    assert.match(alert.annotations.description, /KUBECONFIG_PAPERCLIP_CI_DEPLOY/);
    assert.match(alert.annotations.description, /lacks get on ConfigMap/);
    assert.match(alert.annotations.description, /kubectl, jq, sha256sum/);
  });

  it("does not claim its list of exit-2 causes is exhaustive", () => {
    const alert = buildAlert({
      exitCode: "2",
      detail: "",
      runUrl: "https://example/run/6",
      repo: "Blockcast/paperclip",
      now,
    });

    // The detector also exits 2 on a non-integer
    // PAPERCLIP_STRANDED_LOCK_GRACE_MINUTES (check-stranded-approval-lock.sh:142)
    // and on an undecidable jq predicate (:203, :242). An operator who has
    // ruled out the three named causes must not conclude the alert is lying;
    // the text has to send them to stderr instead.
    assert.doesNotMatch(alert.annotations.description, /Three distinct faults/);
    assert.match(alert.annotations.description, /NOT an exhaustive list/);
    assert.match(alert.annotations.description, /stderr/);
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

  it("keeps continue-on-error on the kubeconfig step, so a credential fault still alerts", () => {
    // Easy to miss and silent when wrong: an explicit `if:` carrying no status
    // function still implies `success()`. Without continue-on-error a failed
    // kubeconfig step aborts the job, so BOTH `exit_code != '0'` steps skip and
    // the run goes red having alerted nobody -- the "only the last committer
    // hears" mode this workflow was written to remove. With it, the detector
    // runs, cannot reach the cluster, and exits 2 into its own alertname.
    assert.match(workflowSource, /- name: Configure kubeconfig\n\s+continue-on-error: true/);
  });

  it("keeps continue-on-error on Install kubectl, the same silent path one step earlier", () => {
    // A failed install aborts the job before `check`, so both alert steps skip
    // and the run goes red having alerted nobody. Allowed to fail, the
    // detector's own dependency check (check-stranded-approval-lock.sh:38)
    // reports the missing binary as exit 2 and a human hears about it.
    assert.match(workflowSource, /- name: Install kubectl\n\s+continue-on-error: true/);
  });

  it("does NOT put continue-on-error on checkout, which would only hide the failure", () => {
    // Deliberate asymmetry, recorded so it is not "fixed" for consistency:
    // without the repo there is no post-stranded-approval-lock-alert.mjs to run
    // either, so continuing past a failed checkout cannot produce an alert.
    assert.doesNotMatch(workflowSource, /- name: Checkout repository\n\s+continue-on-error: true/);
  });

  it("reads the CI-deploy credential without minting a deployment record", () => {
    // BLO-49651: the repo-level BLOCKCAST_KUBE_CONFIG_B64 identity is Forbidden
    // on the approval ConfigMap, so the job reads KUBECONFIG_PAPERCLIP_CI_DEPLOY,
    // an environment secret of paperclip-production. `deployment: false` is
    // what keeps an hourly read-only detector out of that environment's
    // deployment history, which the deploy-supersede/stall scripts read.
    assert.match(workflowSource, /environment:\n\s+name: paperclip-production\n\s+deployment: false\n/);
    assert.match(workflowSource, /secrets\.KUBECONFIG_PAPERCLIP_CI_DEPLOY/);
    assert.doesNotMatch(workflowSource, /secrets\.BLOCKCAST_KUBE_CONFIG_B64/);
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

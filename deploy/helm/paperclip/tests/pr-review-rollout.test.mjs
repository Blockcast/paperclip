import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function helmAvailable() {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function renderApiDeployment() {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      "templates/deployment-api.yaml",
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// Every other suite in this directory degrades rather than throwing ENOENT on a
// host without helm; match that instead of hard-failing.
const SKIP = helmAvailable() ? undefined : { skip: "helm is not installed" };

/**
 * Asserts the rollout flag is EXPLICITLY SET, not that it is set to "true".
 *
 * Pinning "true" would make this test fail at exactly the moment the rollout it
 * describes completes — the one moment the chart change is correct — so the
 * only way to finish the rollout would be to delete the test. Asserting
 * "explicitly decided" keeps it useful across the whole rollout: it still
 * catches the flag being dropped by accident, which is the real hazard, because
 * an absent flag means the guard silently starts rejecting issue creates.
 */
test("Blockcast pins the PR-review duplicate guard rollout state explicitly", SKIP, () => {
  const rendered = renderApiDeployment();

  const match = rendered.match(
    /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n\s+value: "([^"]*)"/,
  );
  assert.ok(
    match,
    "PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD must be rendered explicitly. "
      + "Omitting it leaves the duplicate guard ENABLED, which rejects issue "
      + "creates with 409 for any issue that merely cites a PR under review.",
  );

  // Must be a spelling guardDisabled() actually recognizes. "yes"/"on" are
  // accepted by the code; anything outside this set leaves the guard enforcing.
  const recognized = ["1", "true", "yes", "on", "enabled", "0", "false", "no", "off", "disabled"];
  assert.ok(
    recognized.includes(match[1].trim().toLowerCase()),
    `PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD="${match[1]}" is not a recognized `
      + `value; the guard would stay ENABLED. Use one of: ${recognized.join(", ")}`,
  );
});

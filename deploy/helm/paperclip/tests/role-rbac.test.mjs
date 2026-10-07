import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderRole() {
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
      "templates/role.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// Extract the verbs of the rule whose resources are exactly ["pods"] (NOT
// ["pods/log"], which has its own rule). role.yaml authors these as inline
// YAML flow arrays, so a targeted regex is sufficient and robust to comment
// churn above the rule.
function podsVerbs(rendered) {
  const match = rendered.match(
    /resources:\s*\["pods"\]\s*\n\s*verbs:\s*\[([^\]]*)\]/,
  );
  assert.ok(match, 'role.yaml must render a rule for resources: ["pods"]');
  return match[1].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

// Same shape as podsVerbs, for the rule whose resources are exactly
// ["secrets"].
function secretsVerbs(rendered) {
  const match = rendered.match(
    /resources:\s*\["secrets"\]\s*\n\s*verbs:\s*\[([^\]]*)\]/,
  );
  assert.ok(match, 'role.yaml must render a rule for resources: ["secrets"]');
  return match[1].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
}

test('paperclip-k8s-adapters Role grants pods:delete for the BLO-16850 orphaned-pod reaper', () => {
  // The server-side cleanupOrphanedManagedPods reaper (reapOrphanedRuns in
  // server/src/services/heartbeat.ts) force-deletes an orphaned Running agent
  // pod after its run finalizes — the owning Job's Background-propagation
  // cascade does not force-kill a wedged container, so the pod must be deleted
  // directly. Verified in prod: without pods:delete the reaper 403s on every
  // deleteNamespacedPod and the orphan survives (only jobs:delete was granted,
  // because the old code only ever deleted Jobs). Pin the grant so a future
  // edit to role.yaml cannot silently regress it and re-break the reaper.
  const verbs = podsVerbs(renderRole());
  assert.ok(
    verbs.includes("delete"),
    `pods verbs must include "delete" for the reaper (got: [${verbs.join(", ")}])`,
  );
});

test("paperclip-k8s-adapters Role retains pods:get + pods:list (adapter log preflight)", () => {
  // get/list back the adapters' own pod-liveness + log-streaming preflight
  // (opencode-k8s execute.js:311 + :552); the reaper's delete is additive to,
  // not a replacement for, these.
  const verbs = podsVerbs(renderRole());
  assert.ok(
    verbs.includes("get") && verbs.includes("list"),
    `pods verbs must retain get + list (got: [${verbs.join(", ")}])`,
  );
});

test("paperclip-k8s-adapters Role still grants secrets:update pending the BLO-34510 decision", () => {
  // ORIGINAL REASON, NOW STALE — kept because it is the measurement, not the
  // rationale: createOrAdoptRunSecret recovered from a create 409 by calling
  // replaceNamespacedSecret, a PUT, which the RBAC authorizer maps to `update`
  // and NOT to the `patch` this Role already grants. Measured in prod
  // 2026-09-13: 7 runs, 4 agents, one 7h window, all failing on
  // `cannot update resource "secrets"`.
  //
  // BLO-32424 converted that call site to a merge PATCH, so it no longer needs
  // `update` and this test no longer pins what its name used to say. Do NOT
  // read it as asserting that some caller still requires the verb — as of that
  // change no in-release-namespace consumer of `update` is known to remain (see
  // the justification block in templates/role.yaml for what was checked).
  //
  // What it pins now is narrower and still worth pinning: the verb set does not
  // drift as a side effect of an unrelated edit. Retiring `update` is a stated
  // decision tracked as BLO-34510, and that decision updates THIS test in the
  // same change. Until then, an incidental "tidy the verb list" edit should
  // still fail here rather than land unreviewed.
  const verbs = secretsVerbs(renderRole());
  assert.ok(
    verbs.includes("update"),
    `secrets verbs must include "update" until BLO-34510 records the retirement decision (got: [${verbs.join(", ")}])`,
  );
});

test("paperclip-k8s-adapters Role retains secrets:create + secrets:patch", () => {
  // update is additive: create still mints the per-run Secret, and patch is
  // still the verb used for the mid-run updates at claude-k8s execute.js:884 /
  // opencode-k8s execute.js:1052.
  const verbs = secretsVerbs(renderRole());
  assert.ok(
    verbs.includes("create") && verbs.includes("patch"),
    `secrets verbs must retain create + patch (got: [${verbs.join(", ")}])`,
  );
});

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

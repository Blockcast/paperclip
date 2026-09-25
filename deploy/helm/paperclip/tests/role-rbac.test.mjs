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

test("paperclip-k8s-adapters Role does NOT grant secrets:update (retired, BLO-34510)", () => {
  // WHY IT EXISTED, kept because the measurement is what makes the removal
  // safe rather than merely tidy: createOrAdoptRunSecret recovered from a
  // create 409 by calling replaceNamespacedSecret, a PUT, which the RBAC
  // authorizer maps to `update` and NOT to the `patch` this Role already
  // grants. Measured in prod 2026-09-13: 7 runs, 4 agents, one 7h window, all
  // failing on `cannot update resource "secrets"`.
  //
  // WHY IT IS GONE: BLO-32424 (#1873, merged 2026-10-06) converted that call
  // site to a merge PATCH, removing the verb's only in-release-namespace
  // consumer. Enumerated at master 73231dec — claude-k8s adopt path (PATCH, no
  // PUT), both adapters' SSAR self-tests (probe create/delete/get, never
  // update), opencode-k8s at the current pin (zero PUT in non-test src/), and
  // an in-tree sweep of server//packages//scripts/ whose one hit is the
  // sandbox-provider plugin's PUT in a TENANT namespace this Role does not
  // cover. See the justification block in templates/role.yaml.
  //
  // This assertion is the inverse of the one it replaces, deliberately: a
  // standing grant is retired by a stated decision, so re-adding `update` must
  // fail here and be argued, not drift back in beside an unrelated edit.
  const verbs = secretsVerbs(renderRole());
  assert.ok(
    !verbs.includes("update"),
    `secrets:update was retired by BLO-34510; re-adding it needs a named in-release-namespace consumer and an update to this test (got: [${verbs.join(", ")}])`,
  );
});

test("paperclip-k8s-adapters Role grants secrets:list for the BLO-21857 orphan-Secret sweep", () => {
  // sweepOrphanedRunSecrets (vendor/paperclip-adapter-claude-k8s/src/server/
  // secret-sweep.ts) opens with listNamespacedSecret under a label selector.
  // Without `list` that first call 403s, createSweepGate's catch swallows it as
  // non-fatal, and maybeSweep returns null on every replica forever — so the
  // sweep ships inert. Pin it, because this regression is *invisible*: a sweep
  // that 403s and a sweep that finds zero orphans both delete nothing and both
  // leave the orphan gauge flat, so the feature's own dashboard cannot
  // distinguish them. Same shape as the pods:delete pin above.
  const verbs = secretsVerbs(renderRole());
  assert.ok(
    verbs.includes("list"),
    `secrets verbs must include "list" for sweepOrphanedRunSecrets' listNamespacedSecret (got: [${verbs.join(", ")}])`,
  );
});

test("paperclip-k8s-adapters Role retains secrets:create + secrets:patch", () => {
  // These are what survive the BLO-34510 retirement and they carry the whole
  // Secret lifecycle: create mints the per-run Secret, patch covers both the
  // mid-run updates (claude-k8s execute.js:884 / opencode-k8s execute.js:1052)
  // and the adopt-on-collision path that used to need `update`. Losing either
  // breaks every agent run, so pin them alongside the removal.
  const verbs = secretsVerbs(renderRole());
  assert.ok(
    verbs.includes("create") && verbs.includes("patch"),
    `secrets verbs must retain create + patch (got: [${verbs.join(", ")}])`,
  );
});

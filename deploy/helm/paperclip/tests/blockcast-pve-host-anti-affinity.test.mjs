import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderTemplate(template, extraArgs = []) {
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
      template,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// BLO-32054: pve3 is CPU-oversubscribed and steals 20-40% from every guest on
// it; a 5 s liveness probe on a stalled vCPU misses its deadline and the
// kubelet kills a healthy container. Production must not land on a node whose
// PVE host is pve3. The nodes already carry blockcast.net/pve-storage-domain
// with the host name, so the rule keys on that label.
const PVE3_RULE =
  /nodeAffinity:\s*\n\s*requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*?key: blockcast\.net\/pve-storage-domain\s*\n\s*operator: NotIn\s*\n\s*values:\s*\n\s*- pve3/;

test("API deployment requires a node whose PVE host is not pve3", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(rendered, PVE3_RULE);
  // The chart merges values.affinity beside its own podAntiAffinity; adding
  // nodeAffinity must not drop the replica spread hint.
  assert.match(rendered, /podAntiAffinity:/);
});

test("worker StatefulSet requires a node whose PVE host is not pve3", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, PVE3_RULE);
});

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
  /nodeAffinity:[\s\S]*?requiredDuringSchedulingIgnoredDuringExecution:\s*\n\s*nodeSelectorTerms:\s*\n\s*- matchExpressions:\s*\n\s*- key: blockcast\.net\/pve-storage-domain\s*\n\s*operator: NotIn\s*\n\s*values:\s*\n\s*- pve3/;

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

// pve2 saturates whenever CI runner bursts land on paperclip-5/-10/-11, but it
// cannot be excluded outright: the API's hard two-host spread needs a second
// eligible node and pve4 only hosts paperclip-3. A preferred rule steers one
// replica to pve4 and lets the spread rule place the other on pve2.
const PREFER_NOT_PVE2 =
  /preferredDuringSchedulingIgnoredDuringExecution:\s*\n\s*- preference:\s*\n\s*matchExpressions:\s*\n\s*- key: blockcast\.net\/pve-storage-domain\s*\n\s*operator: NotIn\s*\n\s*values:\s*\n\s*- pve2\s*\n\s*weight: 100/;

test("API deployment prefers a node whose PVE host is not pve2", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(rendered, PREFER_NOT_PVE2);
});

test("worker StatefulSet prefers a node whose PVE host is not pve2", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, PREFER_NOT_PVE2);
});

// A stalled vCPU can hold /healthz past 5 s for a couple of periods without
// the process being wedged; the worker already tolerates 10 s x 6. Killing
// the API on 3 x 5 s is how 2026-09-05's outage happened.
test("API liveness tolerates 10 s x 6 like the worker", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(
    rendered,
    /livenessProbe:[\s\S]*?failureThreshold: 6[\s\S]*?timeoutSeconds: 10/,
  );
});

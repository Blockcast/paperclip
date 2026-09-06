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
// eligible node, pve4 hosts only paperclip-3, and the pve1 nodes carry reserved
// taints production does not tolerate. So pve4 is preferred outright and any
// non-pve2 host is the fallback, leaving the spread rule to place the second
// replica on pve2.
const PREFER_PVE4_THEN_NOT_PVE2 =
  /preferredDuringSchedulingIgnoredDuringExecution:\s*\n\s*- preference:\s*\n\s*matchExpressions:\s*\n\s*- key: blockcast\.net\/pve-storage-domain\s*\n\s*operator: In\s*\n\s*values:\s*\n\s*- pve4\s*\n\s*weight: 100\s*\n\s*- preference:\s*\n\s*matchExpressions:\s*\n\s*- key: blockcast\.net\/pve-storage-domain\s*\n\s*operator: NotIn\s*\n\s*values:\s*\n\s*- pve2\s*\n\s*weight: 50/;

test("API deployment prefers pve4, then any host that is not pve2", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(rendered, PREFER_PVE4_THEN_NOT_PVE2);
});

test("worker StatefulSet prefers pve4, then any host that is not pve2", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, PREFER_PVE4_THEN_NOT_PVE2);
});

// Slice one probe block out of the rendered container spec so assertions
// cannot drift onto a neighbouring probe or a future sidecar.
function probeBlock(rendered, name) {
  const match = rendered.match(
    new RegExp(`\\n(\\s+)${name}:\\n([\\s\\S]*?)\\n\\1[a-zA-Z]`),
  );
  assert.ok(match, `${name} block not found`);
  return match[2];
}

// A stalled vCPU can hold /healthz past 5 s for a couple of periods without
// the process being wedged; the worker already tolerates 10 s x 6. Killing
// the API on 3 x 5 s is how 2026-09-05's outage happened.
test("API liveness tolerates 10 s x 6 like the worker", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  const liveness = probeBlock(rendered, "livenessProbe");
  assert.match(liveness, /failureThreshold: 6\b/);
  assert.match(liveness, /timeoutSeconds: 10\b/);
  // Readiness keeps the chart default so a slow replica still leaves rotation.
  const readiness = probeBlock(rendered, "readinessProbe");
  assert.match(readiness, /failureThreshold: 3\b/);
  assert.match(readiness, /timeoutSeconds: 5\b/);
});

// With pve3 excluded, the hard two-host spread left pve2 as the only host for
// the second API replica, and pve2 saturates under CI bursts (34-49% steal on
// paperclip-10, 2026-09-06 03:00Z, pod-local /api/health up to 9.9 s against a
// 10 s liveness timeout). paperclip-8 (pve1) idles at 87% with three
// multicast-integ runners (a reserved floor), so production tolerates that
// node's reserved taint and the pve4-then-not-pve2 preference lands the second
// replica there.
// Slice the pod-spec tolerations list (key at six spaces, entries at eight, in
// both templates) so the assertion cannot be satisfied by a tolerations key
// elsewhere in the document.
function podTolerations(rendered) {
  const match = rendered.match(/\n {6}tolerations:\n((?: {8}- .*\n(?: {10}.*\n)*)+)/);
  assert.ok(match, "pod-spec tolerations block not found");
  return match[1];
}

// Helm marshals map keys alphabetically, so the rendered entry order is
// effect/key/operator/value regardless of how the values file lists them.
const MULTICAST_INTEG_TOLERATION =
  / {8}- effect: NoSchedule\n {10}key: blockcast\.net\/arc-multicast-integ-reserved\n {10}operator: Equal\n {10}value: "true"\n/;
const DEDICATED_TOLERATION =
  / {8}- effect: NoSchedule\n {10}key: dedicated\n {10}operator: Equal\n {10}value: paperclip\n/;

test("API deployment tolerates the paperclip-8 multicast-integ reserved taint", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  const tolerations = podTolerations(rendered);
  assert.match(tolerations, MULTICAST_INTEG_TOLERATION);
  // The dedicated=paperclip toleration must survive alongside it.
  assert.match(tolerations, DEDICATED_TOLERATION);
});

test("worker StatefulSet tolerates the paperclip-8 multicast-integ reserved taint", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  const tolerations = podTolerations(rendered);
  assert.match(tolerations, MULTICAST_INTEG_TOLERATION);
  assert.match(tolerations, DEDICATED_TOLERATION);
});

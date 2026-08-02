import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderTemplate(extraArgs = []) {
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
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("API deployment hard-enforces node spread by default (BLO-20901)", () => {
  const rendered = renderTemplate();

  assert.match(rendered, /topologySpreadConstraints:/);
  assert.match(rendered, /maxSkew: 1/);
  assert.match(rendered, /minDomains: 2/);
  assert.match(rendered, /whenUnsatisfiable: DoNotSchedule/);
  // The hard constraint must target the API pods specifically, not every
  // paperclip component, or it would also constrain the worker StatefulSet's
  // label surface by accident.
  assert.match(
    rendered,
    /topologySpreadConstraints:[\s\S]*?matchLabels:[\s\S]*?app\.kubernetes\.io\/component: api/,
  );
  // The soft preference stays alongside the hard constraint rather than
  // replacing it.
  assert.match(rendered, /podAntiAffinity:/);
  assert.match(rendered, /preferredDuringSchedulingIgnoredDuringExecution:/);
});

test("API deployment drops the hard constraint when spreadAcrossNodes is disabled", () => {
  const rendered = renderTemplate(["--set", "api.spreadAcrossNodes=false"]);

  assert.doesNotMatch(rendered, /topologySpreadConstraints:/);
  assert.doesNotMatch(rendered, /podAntiAffinity:/);
});

test("API deployment topologySpreadConstraints merges with custom .Values.affinity", () => {
  const rendered = renderTemplate([
    "--set",
    "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=workload",
    "--set",
    "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=In",
    "--set",
    "affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=paperclip",
  ]);

  assert.match(rendered, /topologySpreadConstraints:/);
  assert.match(rendered, /nodeAffinity:/);
  assert.match(rendered, /requiredDuringSchedulingIgnoredDuringExecution:/);
});

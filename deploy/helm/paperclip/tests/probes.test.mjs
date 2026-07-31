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

test("worker StatefulSet uses HTTP probes so readiness requires a listening server", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, /livenessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /readinessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /startupProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /path: \/healthz/);
  assert.doesNotMatch(rendered, /grep -qa 'server\/dist\/index\.js'/);
});

test("API deployment keeps HTTP health probes", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(rendered, /livenessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /readinessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /startupProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /path: \/healthz/);
  assert.doesNotMatch(rendered, /grep -qa 'server\/dist\/index\.js'/);
});

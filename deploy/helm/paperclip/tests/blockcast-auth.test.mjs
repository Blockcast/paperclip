import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

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

test("Blockcast Paperclip is Dex-only SSO", () => {
  const rendered = renderApiDeployment();

  assert.match(
    rendered,
    /- name: PAPERCLIP_AUTH_EMAIL_PASSWORD_ENABLED\n\s+value: "false"/,
  );
  assert.match(
    rendered,
    /- name: PAPERCLIP_DEX_OIDC_ISSUER\n\s+value: ["']?https:\/\/dex\.sfo12\.bcast\.id["']?/,
  );
  assert.match(
    rendered,
    /- name: PAPERCLIP_DEX_OIDC_CLIENT_ID\n\s+value: ["']?paperclip["']?/,
  );
  assert.match(rendered, /name: paperclip-dex-oidc/);
  assert.doesNotMatch(rendered, /MICROSOFT_|paperclip-microsoft-oidc/);
});

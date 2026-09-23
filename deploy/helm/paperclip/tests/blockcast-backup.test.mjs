import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

test("Blockcast uses the cluster-managed PostgreSQL backup job", () => {
  for (const template of ["templates/deployment-api.yaml", "templates/statefulset.yaml"]) {
    const rendered = execFileSync(
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
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.match(
      rendered,
      /- name: PAPERCLIP_DB_BACKUP_ENABLED\n\s+value: "false"/,
    );
  }
});

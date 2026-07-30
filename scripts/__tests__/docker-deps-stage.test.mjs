import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const checker = path.join(repoRoot, "scripts", "check-docker-deps-stage.mjs");

test("rejects stale literal Dockerfile COPY sources", (t) => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "paperclip-docker-deps-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  mkdirSync(path.join(fixtureRoot, "packages", "active"), { recursive: true });
  writeFileSync(path.join(fixtureRoot, "packages", "active", "package.json"), "{}\n");
  writeFileSync(path.join(fixtureRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(
    path.join(fixtureRoot, "Dockerfile"),
    [
      "FROM node:24 AS deps",
      "COPY packages/active/package.json packages/active/",
      "COPY packages/deleted/package.json packages/deleted/",
      "FROM node:24 AS production",
      "",
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [checker], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Dockerfile deps stage references missing COPY source: packages\/deleted\/package\.json/,
  );
});

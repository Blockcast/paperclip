import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("brace-expansion resolves at the GHSA-mh99-v99m-4gvg patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["brace-expansion"], "^5.0.8");
  assert.equal(
    packageJson.pnpm.patchedDependencies["brace-expansion@5.0.8"],
    "patches/brace-expansion@5.0.8.patch",
  );
  assert.match(lockfile, /^  brace-expansion@5\.0\.(?:[89]|[1-9]\d|\d{3,}):$/m);
  assert.doesNotMatch(lockfile, /^  brace-expansion@(?:[1-4]\.|5\.0\.[0-7]:)/m);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("brace-expansion manifest uses the GHSA-rgw5-rvv9-x895 patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const patch = await readFile("patches/brace-expansion@5.0.9.patch", "utf8");

  assert.equal(packageJson.pnpm.overrides["brace-expansion"], "5.0.9");
  assert.equal(
    packageJson.pnpm.patchedDependencies["brace-expansion@5.0.9"],
    "patches/brace-expansion@5.0.9.patch",
  );
  assert.match(patch, /module\.exports = expand;/);
});

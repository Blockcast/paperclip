import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("PostCSS resolves above the GHSA-r28c-9q8g-f849 patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides.postcss, "^8.5.18");
  assert.match(lockfile, /^  postcss@8\.5\.(?:1[89]|[2-9]\d|\d{3,}):$/m);
  assert.doesNotMatch(lockfile, /^  postcss@8\.5\.(?:[0-9]|1[0-7]):$/m);
});

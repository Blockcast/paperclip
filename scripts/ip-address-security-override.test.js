import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ip-address resolves above the GHSA-mwp4-54f8-5fhr patched floor", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(packageJson.pnpm.overrides["ip-address"], "^10.3.1");

  const resolutions = [
    ...lockfile.matchAll(/^  ip-address@(\d+)\.(\d+)\.(\d+):$/gm),
  ];
  assert.ok(resolutions.length > 0, "lockfile missing ip-address resolution");

  for (const resolution of resolutions) {
    const version = resolution.slice(1).map(Number);
    assert.ok(
      version[0] > 10 ||
        (version[0] === 10 &&
          (version[1] > 3 || (version[1] === 3 && version[2] >= 1))),
      `lockfile resolved vulnerable ip-address ${version.join(".")}`,
    );
  }
});

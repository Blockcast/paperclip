import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PLUGIN_VERSION } from "../src/constants.js";

// Regression guard for BLO-14052: package.json's version was frozen at 0.9.3
// for the plugin's entire lifetime while PLUGIN_VERSION drifted to 0.9.4,
// which silently defeated the kkroo bundled-plugin bootstrap's version-drift
// self-heal (server/src/bootstrap/kkroo-bundled-plugins.ts compares
// package.json's version against the registry-recorded version to decide
// whether to re-sync the plugin's installed copy from the fresh in-image
// bundle). If these two ever diverge again, a real feature/tool addition
// could ship in this repo and never become reachable on the live deployment.
describe("plugin version sync", () => {
  it("keeps package.json's version equal to PLUGIN_VERSION", () => {
    const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string };
    expect(packageJson.version).toBe(PLUGIN_VERSION);
  });
});

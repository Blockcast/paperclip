import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackMetadata(packDestination: string) {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", packDestination], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const metadata = JSON.parse(output);
  if (!Array.isArray(metadata) || metadata.length === 0 || typeof metadata[0]?.filename !== "string") {
    throw new Error(`Unexpected npm pack output from ${packageRoot}: ${output}`);
  }
  return metadata[0] as { filename: string; files: Array<{ path: string }> };
}

describe("skills catalog package artifacts", () => {
  const cleanup: string[] = [];

  function createPackDestination() {
    const destination = mkdtempSync(path.join(tmpdir(), "paperclip-skills-catalog-pack-"));
    cleanup.push(destination);
    return destination;
  }

  afterEach(async () => {
    await Promise.all(cleanup.map((entry) => rm(entry, { force: true, recursive: true })));
    cleanup.length = 0;
  });

  it("packs dist manifest and catalog files for npm artifact consumers", () => {
    if (!existsSync(path.join(packageRoot, "dist/generated/catalog.json"))) {
      execFileSync("pnpm", ["--filter", "@paperclipai/skills-catalog", "build"], {
        cwd: packageRoot,
        stdio: "ignore",
      });
    }

    const metadata = readPackMetadata(createPackDestination());
    const paths = metadata.files.map((entry) => entry.path);

    expect(paths).toContain("dist/generated/catalog.json");
    expect(paths).toContain("generated/catalog.json");
    expect(paths).toContain("catalog/bundled/software-development/github-pr-workflow/SKILL.md");
    expect(paths).toContain("catalog/optional/browser/agent-browser/SKILL.md");
    expect(paths).toContain("package.json");
    // 300s, not 120s: this test shells out to `npm pack` (and a cold `pnpm build`),
    // so its wall-time tracks runner speed, which varies ~3.7x across the fleet.
    // Measured 2026-09-21 over five CI runs: 33.5s / 35.8s / 67.3s / 93.1s / 123.2s
    // -- the last one blew the old 120s cap and ejected an unrelated PR (BLO-28886).
    // Same trade as the e2e caps in BLO-33320: a slow runner costs wall-time, not a red.
  }, 300_000);
});

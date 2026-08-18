import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../../../", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

const rootPackageJson = JSON.parse(
  await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
);
const serverPackageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

function isVulnerableNanoidVersion([major, minor, patch]: number[]) {
  return (
    major === 4 ||
    (major === 5 && (minor === 0 || (minor === 1 && patch <= 15)))
  );
}

async function copyLockfileFixture(fixtureRoot: string) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "--",
      "package.json",
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "pnpmfile.cjs",
      "pnpmfile.js",
      "pnpmfile.mjs",
      "patches",
    ],
    { cwd: repoRootPath },
  );

  for (const sourceRelativePath of stdout.split("\n").filter(Boolean)) {
    const source = join(repoRootPath, sourceRelativePath);
    const destination = join(fixtureRoot, sourceRelativePath);

    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
  }
}

describe("PEN-1198 audit dependency remediation", () => {
  it("keeps high-risk production dependency paths on patched ranges", () => {
    const overrides = rootPackageJson.pnpm.overrides;

    expect(overrides["@connectrpc/connect-node>undici"]).toBe(
      ">=6.27.0 <7",
    );
    expect(overrides["jsdom>undici"]).toBe(">=7.29.0 <8");
    expect(overrides["js-yaml"]).toBe(">=4.3.1 <5");
    expect(overrides.multer).toBe(">=2.2.0 <3");
    expect(serverPackageJson.dependencies.multer).toBe("^2.2.0");
  });

  it("documents the advisories that the patched ranges address", () => {
    const remediations = rootPackageJson.securityAuditRemediations["PEN-1198"];

    expect(remediations["@connectrpc/connect-node>undici"]).toMatchObject({
      patchedRange: ">=6.27.0 <7",
      advisories: expect.arrayContaining([
        "GHSA-vrm6-8vpv-qv8q",
        "GHSA-vxpw-j846-p89q",
      ]),
    });
    expect(remediations["jsdom>undici"]).toMatchObject({
      patchedRange: ">=7.29.0 <8",
      advisories: expect.arrayContaining([
        "GHSA-4cwx-7wf7-3272",
        "GHSA-vmh5-mc38-953g",
        "GHSA-hm92-r4w5-c3mj",
      ]),
    });
    expect(remediations.multer).toMatchObject({
      patchedRange: ">=2.2.0 <3",
      advisories: expect.arrayContaining([
        "GHSA-72gw-mp4g-v24j",
        "GHSA-3p4h-7m6x-2hcm",
      ]),
    });
    expect(remediations["js-yaml"]).toMatchObject({
      patchedRange: ">=4.3.1 <5",
      advisories: expect.arrayContaining(["GHSA-5p4m-2wfm-xmqj"]),
    });
  });

  it(
    "keeps nanoid outside the GHSA-28wg-ghj8-5hjv vulnerable range",
    async () => {
      const tmpRoot = await mkdtemp(join(tmpdir(), "paperclip-nanoid-"));
      const fixtureRoot = join(tmpRoot, "repo");

      try {
        await copyLockfileFixture(fixtureRoot);

        // Human and agent PRs do not commit lockfile changes. Seed the fixture
        // from the tracked base lockfile, then recreate the policy-job artifact
        // from the current workspace manifests before checking the graph.
        await execFileAsync(
          "pnpm",
          [
            "install",
            "--lockfile-only",
            "--ignore-scripts",
            "--no-frozen-lockfile",
          ],
          { cwd: fixtureRoot, maxBuffer: 1024 * 1024 * 20 },
        );

        const fixturePackageJson = JSON.parse(
          await readFile(join(fixtureRoot, "package.json"), "utf8"),
        );
        const lockfile = await readFile(
          join(fixtureRoot, "pnpm-lock.yaml"),
          "utf8",
        );

        expect(fixturePackageJson.pnpm.overrides.nanoid).toBe(">=5.1.16 <6");
        expect(lockfile).toMatch(
          /^  nanoid@5\.1\.16:\n    resolution: \{integrity: .+\}$/m,
        );

        const vulnerableVersions = Array.from(
          lockfile.matchAll(
            /^  nanoid@(\d+)\.(\d+)\.(\d+)(?=[:(])/gm,
          ),
          ([, major, minor, patch]) => [
            Number(major),
            Number(minor),
            Number(patch),
          ],
        )
          .filter(isVulnerableNanoidVersion)
          .map((version) => version.join("."));

        expect(vulnerableVersions).toEqual([]);
      } finally {
        await rm(tmpRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCatalogManifest } from "./catalog-builder.js";

const tempDirs: string[] = [];

/**
 * `writeCatalogManifest` used to write `generated/catalog.json` in place with
 * `fs.writeFile`, which truncates the destination before it writes. Anything
 * reading the manifest inside that window saw an empty or partial file and failed
 * on `JSON.parse` with `Unexpected end of JSON input` — and `validateCatalog`
 * reported a spurious "is stale" on top of it, because it diffs whatever text it
 * managed to read.
 *
 * That is a live path rather than a hypothetical. `packaged-artifacts.test.ts`
 * shells out to `pnpm … build` (which runs this) whenever `dist/` is absent, which
 * is always true on a fresh CI checkout, while sibling tests in the same vitest
 * project read `generated/catalog.json`. The race ejected PR #3089 from the merge
 * queue with a failure that named neither test.
 *
 * The size of the manifest is not what makes it tearable: the truncate happens when
 * the handle is opened, so the destination is observably empty even for content
 * small enough to land in a single write.
 */
describe("writeCatalogManifest atomicity", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("never exposes a truncated manifest to a concurrent reader", async () => {
    const packageDir = await createCatalogPackage();
    const manifestPath = path.join(packageDir, "generated", "catalog.json");

    // Seed the file first so that a reader failure means a torn write rather than a
    // cold start, and assert the fixture itself is sound before racing it.
    const seeded = await writeCatalogManifest(packageDir);
    expect(seeded.errors).toEqual([]);

    const failures: string[] = [];
    let reading = true;
    const reader = (async () => {
      while (reading) {
        try {
          JSON.parse(await fs.readFile(manifestPath, "utf8"));
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
    })();

    for (let index = 0; index < 40; index += 1) {
      const result = await writeCatalogManifest(packageDir);
      expect(result.errors).toEqual([]);
    }

    reading = false;
    await reader;

    expect(failures).toEqual([]);
  });

  it("leaves no temp files behind in generated/", async () => {
    const packageDir = await createCatalogPackage();
    await writeCatalogManifest(packageDir);

    const entries = await fs.readdir(path.join(packageDir, "generated"));
    expect(entries).toEqual(["catalog.json"]);
  });
});

async function createCatalogPackage() {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-catalog-atomic-"));
  tempDirs.push(packageDir);
  await fs.mkdir(path.join(packageDir, "catalog", "bundled"), { recursive: true });
  await fs.mkdir(path.join(packageDir, "catalog", "optional"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version: "0.3.1" }), "utf8");

  await writeSkill(packageDir, "bundled", "software-development", "github-pr-workflow", [
    "name: GitHub PR Workflow",
    "description: Prepare pull requests and verification notes.",
  ]);
  await writeSkill(packageDir, "optional", "browser", "agent-browser", [
    "name: Agent Browser",
    "description: Drive a browser from an agent run.",
  ]);

  return packageDir;
}

async function writeSkill(
  packageDir: string,
  kind: "bundled" | "optional",
  category: string,
  slug: string,
  frontmatter: string[],
) {
  const skillDir = path.join(packageDir, "catalog", kind, category, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\n${frontmatter.join("\n")}\n---\n\nUse this skill.\n`,
    "utf8",
  );
}

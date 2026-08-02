import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildExpectedCatalogManifest, formatCatalogManifest, validateCatalog } from "./catalog-builder.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const GENERATED_MANIFEST = path.join(PACKAGE_DIR, "generated", "catalog.json");
const REGENERATE = "pnpm --filter @paperclipai/skills-catalog build:manifest";

/**
 * `generated/catalog.json` is tracked and pins a `sizeBytes` + `sha256` per skill
 * file plus a per-skill `contentHash`, so editing any `SKILL.md` invalidates it.
 * Nothing else in the suite compares the manifest to the files it describes, so a
 * hand-staled manifest used to be green and shipped hashes describing content that
 * was not in the tree.
 *
 * Remote catalog references are reused from the committed manifest here rather
 * than refetched, which keeps this standard CI test network-free. Reuse is not
 * circular: `catalog-ref.json` pins the expected name, description, and an
 * inventory digest over every file's path, kind, size, and sha256, so a
 * coordinated edit to the generated manifest — swap a digest, recompute the
 * fields derived from it — disagrees with the descriptor and fails here.
 */
describe("generated catalog manifest freshness", () => {
  it("describes the catalog files actually on disk", async () => {
    const { manifest, errors } = await buildExpectedCatalogManifest(PACKAGE_DIR, {
      referencedSkillResolution: "reuse-existing",
    });
    expect(errors).toEqual([]);

    const committedText = await readFile(GENERATED_MANIFEST, "utf8");
    const committed = JSON.parse(committedText) as typeof manifest;

    // Name the drifted skills first: a raw diff of the whole manifest is unreadable,
    // and the actionable fact is which SKILL.md changed without a regenerate.
    const expectedHashById = new Map(manifest.skills.map((skill) => [skill.id, skill.contentHash]));
    const drifted = committed.skills
      .filter((skill) => expectedHashById.get(skill.id) !== skill.contentHash)
      .map((skill) => skill.key);
    expect(drifted, `stale manifest entries — run \`${REGENERATE}\``).toEqual([]);

    // Then byte-exact, which also catches added/removed skills, header changes, and
    // hand-editing of the generated file that leaves contentHash untouched.
    expect(formatCatalogManifest(manifest), `manifest is stale — run \`${REGENERATE}\``).toBe(committedText);
  });

  it("reports the same drift through validateCatalog, which `pnpm validate` runs", async () => {
    const { errors } = await validateCatalog(PACKAGE_DIR, {
      referencedSkillResolution: "reuse-existing",
    });
    expect(errors).toEqual([]);
  });
});

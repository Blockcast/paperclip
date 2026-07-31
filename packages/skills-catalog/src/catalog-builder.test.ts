import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildExpectedCatalogManifest,
  buildCatalogManifest,
  formatCatalogManifest,
  validateCatalog,
} from "./catalog-builder.js";

const tempDirs: string[] = [];

const REMOTE_RESEARCH_NAME = "Remote Research";
const REMOTE_RESEARCH_DESCRIPTION = "Research recent discussion from a pinned upstream skill.";
const REMOTE_SKILL_MARKDOWN = [
  "---",
  `name: ${REMOTE_RESEARCH_NAME}`,
  `description: ${REMOTE_RESEARCH_DESCRIPTION}`,
  "---",
  "",
  "Use this skill.",
  "",
].join("\n");
const REMOTE_SCRIPT = "print('hello')\n";

/** The inventory the reuse-path tests write into `generated/catalog.json`. */
const REUSABLE_REMOTE_FILES: RemoteResearchManifestFile[] = [
  { path: "SKILL.md", kind: "skill", sizeBytes: 128, sha256: "a".repeat(64) },
  { path: "scripts/run.py", kind: "script", sizeBytes: 14, sha256: "b".repeat(64) },
];
const REUSABLE_SKILL_ONLY_FILES: RemoteResearchManifestFile[] = [REUSABLE_REMOTE_FILES[0]!];

describe("skills catalog manifest", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    vi.unstubAllGlobals();
  });

  it("builds stable manifest entries from catalog skill directories", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "software-development", "github-pr-workflow", {
      frontmatter: [
        "name: GitHub PR Workflow",
        "description: Prepare pull requests and verification notes.",
        "key: paperclipai/bundled/software-development/github-pr-workflow",
        "recommendedForRoles:",
        "  - engineer",
        "tags:",
        "  - github",
        "  - pull-requests",
      ],
      files: {
        "references/checklist.md": "# Checklist\n",
      },
    });

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.manifest.skills[0]).toMatchObject({
      id: "paperclipai:bundled:software-development:github-pr-workflow",
      key: "paperclipai/bundled/software-development/github-pr-workflow",
      kind: "bundled",
      category: "software-development",
      slug: "github-pr-workflow",
      name: "GitHub PR Workflow",
      trustLevel: "markdown_only",
      compatibility: "compatible",
      recommendedForRoles: ["engineer"],
      tags: ["github", "pull-requests"],
    });
    expect(result.manifest.skills[0]!.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
    expect(result.manifest.skills[0]!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("builds stable manifest entries from pinned GitHub references", async () => {
    const packageDir = await createCatalogPackage();
    const skillMarkdown = REMOTE_SKILL_MARKDOWN;
    const script = REMOTE_SCRIPT;
    const descriptor = remoteResearchDescriptor({
      files: ["SKILL.md", "scripts/**"],
      pinnedFiles: [
        remoteFileEntry("SKILL.md", "skill", skillMarkdown),
        remoteFileEntry("scripts/run.py", "script", script),
      ],
    });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/remote-research/SKILL.md", type: "blob", size: Buffer.byteLength(skillMarkdown) },
            { path: "skills/remote-research/scripts/run.py", type: "blob", size: Buffer.byteLength(script) },
            { path: "README.md", type: "blob", size: 9 },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/skills/remote-research/SKILL.md")) {
        return new Response(skillMarkdown, { status: 200 });
      }
      if (url.endsWith("/skills/remote-research/scripts/run.py")) {
        return new Response(script, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.skills[0]).toMatchObject({
      id: "paperclipai:optional:research:remote-research",
      key: "paperclipai/optional/research/remote-research",
      path: "catalog/optional/research/remote-research",
      trustLevel: "scripts_executables",
      recommendedForRoles: ["researcher"],
      tags: ["research"],
      source: {
        type: "github",
        owner: "example",
        repo: "remote-skill",
        ref: "v1.0.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "skills/remote-research",
        descriptorSha256: descriptorSha256(descriptor),
      },
    });
    expect(result.manifest.skills[0]!.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.py",
    ]);
    expect(result.manifest.skills[0]!.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("reuses unchanged pinned GitHub references without network fetches", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await writeExistingRemoteResearchManifest(packageDir, descriptor, REUSABLE_REMOTE_FILES);
    const fetchMock = vi.fn(async () => {
      throw new Error("clean manifest freshness checks must not fetch pinned remote files");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(result.errors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.manifest.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("reports changed pinned GitHub references in reuse-only mode without network fetches", async () => {
    const packageDir = await createCatalogPackage();
    const oldDescriptor = remoteResearchDescriptor({ files: ["SKILL.md"], pinnedFiles: REUSABLE_SKILL_ONLY_FILES });
    const newDescriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", newDescriptor);
    await writeExistingRemoteResearchManifest(packageDir, oldDescriptor, REUSABLE_SKILL_ONLY_FILES);
    const fetchMock = vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch descriptor changes");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      expect.stringContaining("changed or is missing from generated/catalog.json"),
    ]);
  });

  it("rebuilds pinned GitHub references in fetch mode when the descriptor changes", async () => {
    const packageDir = await createCatalogPackage();
    const skillMarkdown = REMOTE_SKILL_MARKDOWN;
    const script = REMOTE_SCRIPT;
    const oldDescriptor = remoteResearchDescriptor({ files: ["SKILL.md"], pinnedFiles: REUSABLE_SKILL_ONLY_FILES });
    const newDescriptor = remoteResearchDescriptor({
      files: ["SKILL.md", "scripts/**"],
      pinnedFiles: [
        remoteFileEntry("SKILL.md", "skill", skillMarkdown),
        remoteFileEntry("scripts/run.py", "script", script),
      ],
    });
    await writeReference(packageDir, "optional", "research", "remote-research", newDescriptor);
    await writeExistingRemoteResearchManifest(packageDir, oldDescriptor, REUSABLE_SKILL_ONLY_FILES);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/remote-research/SKILL.md", type: "blob", size: Buffer.byteLength(skillMarkdown) },
            { path: "skills/remote-research/scripts/run.py", type: "blob", size: Buffer.byteLength(script) },
          ],
        }), { status: 200 });
      }
      if (url.endsWith("/skills/remote-research/SKILL.md")) {
        return new Response(skillMarkdown, { status: 200 });
      }
      if (url.endsWith("/skills/remote-research/scripts/run.py")) {
        return new Response(script, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.manifest.skills[0]?.source?.descriptorSha256).toBe(descriptorSha256(newDescriptor));
    expect(result.manifest.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("rejects unsupported GitHub hostnames before fetching pinned references", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({
      files: ["SKILL.md"],
      hostname: "metadata.google.internal",
    });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    const fetchMock = vi.fn(async () => {
      throw new Error("unsupported hostnames must not be fetched");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.manifest.skills).toEqual([]);
    expect(result.errors).toEqual([
      "catalog/optional/research/remote-research/catalog-ref.json source.hostname must be github.com.",
    ]);
  });

  it("validates reused generated manifest file metadata before accepting it", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await writeExistingRemoteResearchManifest(packageDir, descriptor, REUSABLE_REMOTE_FILES, {
      contentHash: `sha256:${"c".repeat(64)}`,
      trustLevel: "markdown_only",
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch corrupted entries");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("has stale trustLevel"),
        expect.stringContaining("has stale contentHash"),
      ]),
    );
  });

  it("rejects a coordinated generated-manifest edit that stays internally consistent", async () => {
    // The reuse path rebuilds a referenced entry out of generated/catalog.json, so
    // recomputing contentHash and trustLevel from the manifest's own file records
    // only catches *inconsistent* edits. Swap a digest and let the derived fields
    // follow and the manifest agrees with itself — only catalog-ref.json disagrees.
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    const tampered: RemoteResearchManifestFile[] = [
      { path: "SKILL.md", kind: "skill", sizeBytes: 128, sha256: "d".repeat(64) },
      REUSABLE_REMOTE_FILES[1]!,
    ];
    await writeExistingRemoteResearchManifest(packageDir, descriptor, tampered);
    const fetchMock = vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch tampered entries");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    // Anti-vacuity: the self-consistency checks really are satisfied, so the pin is
    // the only thing standing between this manifest and a green build.
    expect(result.errors).not.toContainEqual(expect.stringContaining("has stale contentHash"));
    expect(result.errors).not.toContainEqual(expect.stringContaining("has stale trustLevel"));
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match catalog-ref.json pinned.inventorySha256"),
      ]),
    );
  });

  it("rejects a generated-manifest sizeBytes edit that contentHash cannot see", async () => {
    // contentHash digests path + sha256 only, so a size-only edit leaves every
    // derived field intact. The inventory digest covers kind and sizeBytes too.
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await writeExistingRemoteResearchManifest(packageDir, descriptor, [
      { ...REUSABLE_REMOTE_FILES[0]!, sizeBytes: 999 },
      REUSABLE_REMOTE_FILES[1]!,
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch tampered entries");
    }));

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(result.errors).not.toContainEqual(expect.stringContaining("has stale contentHash"));
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match catalog-ref.json pinned.inventorySha256"),
      ]),
    );
  });

  it("rejects generated-manifest metadata that disagrees with the descriptor pins", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await writeExistingRemoteResearchManifest(packageDir, descriptor, REUSABLE_REMOTE_FILES, {
      name: "Totally Different Skill",
      description: "A description nobody reviewed.",
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch tampered entries");
    }));

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match catalog-ref.json pinned.name"),
        expect.stringContaining("does not match catalog-ref.json pinned.description"),
      ]),
    );
  });

  it("refuses to verify a reused entry when the descriptor pins nothing", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"], pinned: null });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await writeExistingRemoteResearchManifest(packageDir, descriptor, REUSABLE_REMOTE_FILES);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("reuse-only freshness checks must not fetch unpinned descriptors");
    }));

    const result = await buildExpectedCatalogManifest(packageDir, {
      referencedSkillResolution: "reuse-existing",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not pin name, description, and inventorySha256"),
      ]),
    );
  });

  it("reports the pin to add when a fetched reference has no descriptor pins", async () => {
    const packageDir = await createCatalogPackage();
    await writeReference(packageDir, "optional", "research", "remote-research", remoteResearchDescriptor({
      files: ["SKILL.md"],
      pinned: null,
    }));
    vi.stubGlobal("fetch", remoteResearchFetchMock());

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    const expectedDigest = inventoryDigestForFiles([
      remoteFileEntry("SKILL.md", "skill", REMOTE_SKILL_MARKDOWN),
    ]);
    expect(result.errors).toEqual([
      expect.stringContaining(`"inventorySha256":"${expectedDigest}"`),
    ]);
  });

  it("rejects a descriptor pin that disagrees with the fetched commit", async () => {
    const packageDir = await createCatalogPackage();
    await writeReference(packageDir, "optional", "research", "remote-research", remoteResearchDescriptor({
      files: ["SKILL.md"],
      pinned: {
        name: REMOTE_RESEARCH_NAME,
        description: REMOTE_RESEARCH_DESCRIPTION,
        inventorySha256: `sha256:${"e".repeat(64)}`,
      },
    }));
    vi.stubGlobal("fetch", remoteResearchFetchMock());

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([
      expect.stringContaining("pinned.inventorySha256 is stale; the pinned commit yields sha256:"),
    ]);
  });

  it("reports malformed GitHub tree members instead of throwing", async () => {
    // entry.type and entry.path are dereferenced during the tree walk, so an
    // untyped member used to throw a TypeError out of manifest generation.
    const packageDir = await createCatalogPackage();
    await writeReference(packageDir, "optional", "research", "remote-research", remoteResearchDescriptor({
      files: ["SKILL.md"],
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [
            null,
            { type: "blob", size: 12 },
            { path: 42, type: "blob" },
            { path: "skills/remote-research/other.md" },
            { path: "skills/remote-research/SKILL.md", type: "blob", size: "big" },
          ],
        }), { status: 200 });
      }
      return new Response(REMOTE_SKILL_MARKDOWN, { status: 200 });
    }));

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GitHub tree entry 0 is not an object."),
        expect.stringContaining("GitHub tree entry 1 is missing a string path."),
        expect.stringContaining("GitHub tree entry 2 is missing a string path."),
        expect.stringContaining("GitHub tree entry 3 (skills/remote-research/other.md) is missing a string type."),
        expect.stringContaining("GitHub tree entry 4 (skills/remote-research/SKILL.md) has an invalid size."),
      ]),
    );
  });

  it("reports a GitHub tree response with no usable tree array", async () => {
    const packageDir = await createCatalogPackage();
    await writeReference(packageDir, "optional", "research", "remote-research", remoteResearchDescriptor({
      files: ["SKILL.md"],
    }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: "not-an-array" }), { status: 200 });
      }
      return new Response(REMOTE_SKILL_MARKDOWN, { status: 200 });
    }));

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("GitHub tree response tree must be an array."),
      ]),
    );
  });

  it("aborts stalled GitHub tree body reads", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    const skillMarkdown = [
      "---",
      "name: Remote Research",
      "description: Research recent discussion from a pinned upstream skill.",
      "---",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/trees/")) return stalledBodyResponse(init);
      return new Response(skillMarkdown, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
      fetchTimeoutMs: 20,
    });

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("failed to fetch GitHub tree: stalled body aborted"),
      ]),
    );
  });

  it("aborts stalled pinned GitHub file body reads", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({
          tree: [
            { path: "skills/remote-research/SKILL.md", type: "blob", size: 128 },
          ],
        }), { status: 200 });
      }
      return stalledBodyResponse(init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
      fetchTimeoutMs: 20,
    });

    expect(Date.now() - start).toBeLessThan(1_000);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("failed to fetch pinned GitHub file: stalled body aborted"),
      ]),
    );
  });

  it("reuses the existing manifest entry when a pinned GitHub reference is temporarily unavailable", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({ files: ["SKILL.md", "scripts/**"] });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      existingRemoteResearchManifestText(descriptor, REUSABLE_REMOTE_FILES),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.manifest.skills[0]?.name).toBe("Remote Research");
    expect(result.manifest.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });

  it("reuses the existing manifest entry when the GitHub tree is unavailable but SKILL.md can be fetched", async () => {
    const packageDir = await createCatalogPackage();
    const descriptor = remoteResearchDescriptor({
      files: ["SKILL.md", "scripts/**"],
      pinnedFiles: REUSABLE_SKILL_ONLY_FILES,
    });
    await writeReference(packageDir, "optional", "research", "remote-research", descriptor);
    await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      existingRemoteResearchManifestText(descriptor, REUSABLE_SKILL_ONLY_FILES),
      "utf8",
    );
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("---\nname: Remote Research\ndescription: Research recent discussion from a pinned upstream skill.\n---\n");
    }));

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.manifest.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("reports frontmatter, directory, uniqueness, and inventory errors together", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "Bad_Category", "duplicate", {
      frontmatter: [
        "name: Duplicate",
        "key: paperclipai/bundled/software-development/other",
        "recommendedForRoles: engineer",
      ],
    });
    await writeSkill(packageDir, "optional", "software-development", "duplicate", {
      frontmatter: [
        "name: Duplicate Optional",
        "description: Optional duplicate slug.",
      ],
    });
    await fs.mkdir(path.join(packageDir, "catalog", "bundled", "software-development", "missing-skill"), {
      recursive: true,
    });
    await fs.mkdir(path.join(packageDir, "catalog", "misc"), { recursive: true });
    await fs.writeFile(path.join(packageDir, "catalog", "misc", "SKILL.md"), "# Misplaced\n", "utf8");

    const result = await buildCatalogManifest({
      packageDir,
      generatedAt: "2026-05-26T00:00:00.000Z",
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("catalog/misc/SKILL.md is not under catalog/<bundled|optional>/<category>/<slug>/{SKILL.md,catalog-ref.json}"),
        expect.stringContaining("catalog/bundled/software-development/missing-skill is missing SKILL.md or catalog-ref.json"),
        expect.stringContaining("has invalid category"),
        expect.stringContaining("frontmatter must include description"),
        expect.stringContaining("key must be paperclipai/bundled/Bad_Category/duplicate"),
        expect.stringContaining("field recommendedForRoles must be an array of strings"),
        expect.stringContaining("Duplicate catalog slug \"duplicate\""),
      ]),
    );
  });

  it("detects stale generated manifests", async () => {
    const packageDir = await createCatalogPackage();
    await writeSkill(packageDir, "bundled", "software-development", "review", {
      frontmatter: [
        "name: Review",
        "description: Review implementation work.",
      ],
    });
    await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "generated", "catalog.json"),
      formatCatalogManifest({
        schemaVersion: 1,
        packageName: "@paperclipai/skills-catalog",
        packageVersion: "0.3.1",
        generatedAt: "2026-05-26T00:00:00.000Z",
        skills: [],
      }),
      "utf8",
    );

    const result = await validateCatalog(packageDir);

    expect(result.errors).toContain(
      "generated/catalog.json is stale. Run pnpm --filter @paperclipai/skills-catalog build:manifest.",
    );
  });
});

function remoteResearchDescriptor(options: {
  files: string[];
  hostname?: string;
  pinnedFiles?: RemoteResearchManifestFile[];
  pinned?: Record<string, unknown> | null;
}) {
  const pinned = options.pinned === undefined
    ? {
      name: REMOTE_RESEARCH_NAME,
      description: REMOTE_RESEARCH_DESCRIPTION,
      inventorySha256: inventoryDigestForFiles(options.pinnedFiles ?? REUSABLE_REMOTE_FILES),
    }
    : options.pinned;
  return {
    source: {
      type: "github",
      hostname: options.hostname ?? "github.com",
      owner: "example",
      repo: "remote-skill",
      ref: "v1.0.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      path: "skills/remote-research",
    },
    files: options.files,
    ...(pinned === null ? {} : { pinned }),
    recommendedForRoles: ["researcher"],
    tags: ["research"],
  };
}

function stalledBodyResponse(init?: RequestInit) {
  return new Response(new ReadableStream({
    start(controller) {
      const abort = () => controller.error(new Error("stalled body aborted"));
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      init?.signal?.addEventListener("abort", abort, { once: true });
    },
  }), { status: 200 });
}

function formatReferenceDescriptor(descriptor: Record<string, unknown>) {
  return `${JSON.stringify(descriptor, null, 2)}\n`;
}

function descriptorSha256(descriptor: Record<string, unknown>) {
  return createHash("sha256").update(formatReferenceDescriptor(descriptor)).digest("hex");
}

async function writeExistingRemoteResearchManifest(
  packageDir: string,
  descriptor: Record<string, unknown>,
  files: RemoteResearchManifestFile[],
  options: ExistingRemoteResearchManifestOptions = {},
) {
  const manifestText = existingRemoteResearchManifestText(descriptor, files, options);
  await fs.mkdir(path.join(packageDir, "generated"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "generated", "catalog.json"), manifestText, "utf8");
  return manifestText;
}

function existingRemoteResearchManifestText(
  descriptor: Record<string, unknown>,
  files: RemoteResearchManifestFile[],
  options: ExistingRemoteResearchManifestOptions = {},
) {
  const sortedFiles = sortCatalogFiles(files);
  return formatCatalogManifest({
    schemaVersion: 1,
    packageName: "@paperclipai/skills-catalog",
    packageVersion: "0.3.1",
    generatedAt: "2026-05-26T00:00:00.000Z",
    skills: [{
      id: "paperclipai:optional:research:remote-research",
      key: "paperclipai/optional/research/remote-research",
      kind: "optional",
      category: "research",
      slug: "remote-research",
      name: options.name ?? REMOTE_RESEARCH_NAME,
      description: options.description ?? REMOTE_RESEARCH_DESCRIPTION,
      path: "catalog/optional/research/remote-research",
      entrypoint: "SKILL.md",
      trustLevel: options.trustLevel ?? trustLevelForFiles(sortedFiles),
      compatibility: "compatible",
      defaultInstall: false,
      recommendedForRoles: ["researcher"],
      requires: [],
      tags: ["research"],
      files: sortedFiles,
      contentHash: options.contentHash ?? contentHashForFiles(sortedFiles),
      source: {
        type: "github",
        hostname: (descriptor.source as { hostname?: string }).hostname ?? "github.com",
        owner: "example",
        repo: "remote-skill",
        ref: "v1.0.0",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "skills/remote-research",
        url: "https://github.com/example/remote-skill/tree/v1.0.0/skills/remote-research",
        descriptorSha256: descriptorSha256(descriptor),
      },
    }],
  });
}

type RemoteResearchManifestFile = {
  path: string;
  kind: "skill" | "markdown" | "reference" | "script" | "asset" | "other";
  sizeBytes: number;
  sha256: string;
};

type ExistingRemoteResearchManifestOptions = {
  contentHash?: string;
  trustLevel?: "markdown_only" | "assets" | "scripts_executables";
  name?: string;
  description?: string;
};

function sortCatalogFiles(files: RemoteResearchManifestFile[]) {
  return [...files].sort((a, b) => {
    if (a.path === "SKILL.md") return -1;
    if (b.path === "SKILL.md") return 1;
    return a.path.localeCompare(b.path);
  });
}

function trustLevelForFiles(files: RemoteResearchManifestFile[]) {
  if (files.some((file) => file.kind === "script")) return "scripts_executables";
  if (files.some((file) => file.kind === "asset" || file.kind === "other")) return "assets";
  return "markdown_only";
}

function contentHashForFiles(files: RemoteResearchManifestFile[]) {
  const hashInput = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
  }));
  return `sha256:${createHash("sha256").update(Buffer.from(JSON.stringify(hashInput))).digest("hex")}`;
}

// Mirrors buildInventoryDigest in catalog-builder.ts: wider than contentHash
// (kind and sizeBytes too) and sorted by code point rather than SKILL.md-first.
function inventoryDigestForFiles(files: RemoteResearchManifestFile[]) {
  const hashInput = [...files]
    .map((file) => ({
      path: file.path,
      kind: file.kind,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256.toLowerCase(),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `sha256:${createHash("sha256").update(Buffer.from(JSON.stringify(hashInput))).digest("hex")}`;
}

/** Serves only SKILL.md at the pinned commit. */
function remoteResearchFetchMock() {
  return vi.fn(async (url: string) => {
    if (url.includes("/git/trees/")) {
      return new Response(JSON.stringify({
        tree: [
          {
            path: "skills/remote-research/SKILL.md",
            type: "blob",
            size: Buffer.byteLength(REMOTE_SKILL_MARKDOWN),
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/skills/remote-research/SKILL.md")) {
      return new Response(REMOTE_SKILL_MARKDOWN, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

function remoteFileEntry(
  filePath: string,
  kind: RemoteResearchManifestFile["kind"],
  content: string,
): RemoteResearchManifestFile {
  return {
    path: filePath,
    kind,
    sizeBytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(Buffer.from(content)).digest("hex"),
  };
}

async function createCatalogPackage() {
  const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "skills-catalog-"));
  tempDirs.push(packageDir);
  await fs.mkdir(path.join(packageDir, "catalog", "bundled"), { recursive: true });
  await fs.mkdir(path.join(packageDir, "catalog", "optional"), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ version: "0.3.1" }),
    "utf8",
  );
  return packageDir;
}

async function writeSkill(
  packageDir: string,
  kind: "bundled" | "optional",
  category: string,
  slug: string,
  options: {
    frontmatter: string[];
    files?: Record<string, string>;
  },
) {
  const skillDir = path.join(packageDir, "catalog", kind, category, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\n${options.frontmatter.join("\n")}\n---\n\nUse this skill.\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(options.files ?? {})) {
    const filePath = path.join(skillDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

async function writeReference(
  packageDir: string,
  kind: "bundled" | "optional",
  category: string,
  slug: string,
  descriptor: Record<string, unknown>,
) {
  const skillDir = path.join(packageDir, "catalog", kind, category, slug);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "catalog-ref.json"),
    formatReferenceDescriptor(descriptor),
    "utf8",
  );
}

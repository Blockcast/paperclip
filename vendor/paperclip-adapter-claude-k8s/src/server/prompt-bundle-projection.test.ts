import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";

import {
  PROMPT_BUNDLE_ESCALATION_RATIO,
  PROMPT_BUNDLE_INSTRUCTIONS_PATH,
  PROMPT_BUNDLE_SECRET_MAX_BYTES,
  PROMPT_BUNDLE_SKILLS_DIR,
  PromptBundleOverBudgetError,
  PromptBundleTooManyFilesError,
  buildPromptBundleSecretProjection,
  skillSourceNeedsProjection,
} from "./prompt-bundle-projection.js";

let tmpRoot = "";

function entry(overrides: Partial<PaperclipSkillEntry> & { key: string; source: string }): PaperclipSkillEntry {
  return { runtimeName: overrides.key, ...overrides } as PaperclipSkillEntry;
}

async function writeSkill(name: string, files: Record<string, string | Buffer>): Promise<string> {
  const dir = path.join(tmpRoot, "skills", name);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    if (Buffer.isBuffer(contents)) await fs.writeFile(abs, contents);
    else await fs.writeFile(abs, contents, "utf-8");
  }
  return dir;
}

/** Every key's value, whichever Secret channel it travelled on, as raw bytes. */
function valueBytes(projection: { stringData: Record<string, string>; base64Data: Record<string, string> }, key: string): Buffer {
  if (key in projection.stringData) return Buffer.from(projection.stringData[key]!, "utf8");
  return Buffer.from(projection.base64Data[key]!, "base64");
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pen4932-projection-"));
});

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("skillSourceNeedsProjection", () => {
  const noCatalog = new Set<string>();

  it("projects an entry under the server data mount", () => {
    expect(
      skillSourceNeedsProjection(entry({ key: "a", source: "/paperclip/skills/co/a" }), "/paperclip", noCatalog),
    ).toBe(true);
  });

  it("leaves an adapter-bundled image path alone", () => {
    // `/app/skills/...` is the same absolute path in both namespaces because both come
    // from the same image layer, so projecting it would copy bytes the pod already has.
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/app/skills/a" }), "/paperclip", noCatalog)).toBe(
      false,
    );
  });

  it("projects a catalog-backed skill whose source is NOT under the server mount", () => {
    // The regression this guards. A catalog source is a PAPERCLIP_HOME path and the
    // server mount is SELF_POD_DATA_MOUNT_PATH: two variables that coincide today, not
    // one. Keyed on the prefix alone, an operator PAPERCLIP_HOME outside /paperclip
    // makes every catalog skill look image-bundled and drop out silently — the exact
    // dangling-skill outcome this channel exists to prevent.
    expect(
      skillSourceNeedsProjection(
        entry({ key: "a", source: "/srv/paperclip-home/skills/co/a" }),
        "/paperclip",
        new Set(["a"]),
      ),
    ).toBe(true);
  });

  it("projects everything when the server mount is unknown", () => {
    // An unnecessary copy costs budget; a missing one costs the agent its skill.
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/app/skills/a" }), undefined, noCatalog)).toBe(true);
  });

  it("projects everything when no caller has identified the catalog set", () => {
    // Same fail-open direction as `prompt-cache.ts`'s own `?? true`: with the
    // discriminator absent, nothing has distinguished the image set.
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/app/skills/a" }), "/paperclip", undefined)).toBe(
      true,
    );
  });

  it("does not treat a sibling directory sharing a name prefix as being under the mount", () => {
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/paperclip-other/a" }), "/paperclip", noCatalog)).toBe(
      false,
    );
  });
});

describe("buildPromptBundleSecretProjection", () => {
  // `catalogBackedSkillKeys` is an explicit empty set rather than omitted: omitting it
  // fails open and projects everything, which would make the mount-prefix assertions
  // below pass for the wrong reason.
  const base = {
    companyId: "co-1",
    runLabel: "run-1",
    serverDataMountPath: tmpRoot,
    catalogBackedSkillKeys: new Set<string>(),
  };

  it("returns null when there is nothing to carry", async () => {
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: undefined,
      skills: [],
      instructionsContents: null,
    });
    expect(projection).toBeNull();
  });

  it("projects the instructions file at the path the bundle writes", async () => {
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: undefined,
      skills: [],
      instructionsContents: "# instructions",
    });
    expect(projection!.items).toEqual([{ key: "bundle-0", path: PROMPT_BUNDLE_INSTRUCTIONS_PATH }]);
    expect(projection!.stringData["bundle-0"]).toBe("# instructions");
    expect(projection!.fileCount).toBe(1);
  });

  it("projects a skill tree under .claude/skills/<runtimeName>, recursing into subdirectories", async () => {
    const source = await writeSkill("dataviz", {
      "SKILL.md": "body",
      "references/palette.md": "palette",
    });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "dataviz", runtimeName: "dataviz", source })],
      instructionsContents: null,
    });
    // `localeCompare` collates case-insensitively, so `references/...` precedes
    // `SKILL.md`. The order is asserted as the implementation produces it because what
    // this channel needs is *determinism* — the Job command feeds the prompt-cache key
    // — not a particular collation.
    expect(projection!.items.map((i) => i.path)).toEqual([
      `${PROMPT_BUNDLE_SKILLS_DIR}/dataviz/references/palette.md`,
      `${PROMPT_BUNDLE_SKILLS_DIR}/dataviz/SKILL.md`,
    ]);
  });

  it("uses positional keys so two lawful paths cannot collide on one key", async () => {
    // `a/b.md` and `a__b.md` both transform to `a__b` under the obvious `/`->`__`
    // scheme, which would deliver one file's bytes under the other's name.
    const source = await writeSkill("s", { "a/b.md": "nested", "a__b.md": "flat" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "s", runtimeName: "s", source })],
      instructionsContents: null,
    });
    expect(new Set(projection!.items.map((i) => i.key)).size).toBe(2);
    const byPath = new Map(projection!.items.map((i) => [i.path, projection!.stringData[i.key]]));
    expect(byPath.get(`${PROMPT_BUNDLE_SKILLS_DIR}/s/a/b.md`)).toBe("nested");
    expect(byPath.get(`${PROMPT_BUNDLE_SKILLS_DIR}/s/a__b.md`)).toBe("flat");
  });

  it("is deterministic across skill input order", async () => {
    const alpha = await writeSkill("alpha", { "SKILL.md": "a" });
    const beta = await writeSkill("beta", { "SKILL.md": "b" });
    const forward = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "alpha", source: alpha }), entry({ key: "beta", source: beta })],
      instructionsContents: null,
    });
    const reversed = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "beta", source: beta }), entry({ key: "alpha", source: alpha })],
      instructionsContents: null,
    });
    expect(reversed!.items).toEqual(forward!.items);
    expect(reversed!.stringData).toEqual(forward!.stringData);
    expect(reversed!.base64Data).toEqual(forward!.base64Data);
  });

  it("measures decoded UTF-8 bytes, not base64 — the quantity ValidateSecret checks", async () => {
    // A 3-byte UTF-8 character is 4 base64 bytes. Measuring the encoded form would
    // report the escalation trigger a third of the way early (see the module header).
    const source = await writeSkill("s", { "SKILL.md": "€" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "s", source })],
      instructionsContents: null,
    });
    expect(projection!.totalValueBytes).toBe(3);
    expect(Buffer.from("€", "utf8").toString("base64").length).toBe(4);
  });

  it("excludes image-path skills from the projection and from the byte total", async () => {
    const onVolume = await writeSkill("managed", { "SKILL.md": "12345" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      // Neither is catalog-backed, so `bundled` is excluded on the mount test alone —
      // which is the only condition under which exclusion is correct.
      catalogBackedSkillKeys: new Set<string>(),
      skills: [entry({ key: "managed", source: onVolume }), entry({ key: "bundled", source: "/app/skills/bundled" })],
      instructionsContents: null,
    });
    expect(projection!.totalValueBytes).toBe(5);
    expect(Object.keys(projection!.bytesBySkillKey)).toEqual(["managed"]);
  });

  it("refuses over budget rather than truncating, naming company, run and bytes", async () => {
    const source = await writeSkill("fat", { "SKILL.md": "x".repeat(64) });
    const promise = buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "fat", source })],
      instructionsContents: null,
      maxBytes: 32,
    });
    await expect(promise).rejects.toBeInstanceOf(PromptBundleOverBudgetError);
    const err = await promise.catch((e: PromptBundleOverBudgetError) => e);
    expect(err.companyId).toBe("co-1");
    expect(err.runLabel).toBe("run-1");
    expect(err.totalValueBytes).toBe(64);
    expect(err.message).toContain("co-1");
    expect(err.message).toContain("run-1");
    expect(err.message).toContain('skill "fat"');
  });

  it("accepts a projection exactly at the budget", async () => {
    const source = await writeSkill("edge", { "SKILL.md": "x".repeat(32) });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "edge", source })],
      instructionsContents: null,
      maxBytes: 32,
    });
    expect(projection!.totalValueBytes).toBe(32);
  });

  it("flags the escalation threshold on the same quantity the budget uses", async () => {
    const source = await writeSkill("half", { "SKILL.md": "x".repeat(50) });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "half", source })],
      instructionsContents: null,
      maxBytes: 100,
    });
    expect(PROMPT_BUNDLE_ESCALATION_RATIO).toBe(0.5);
    expect(projection!.escalationThresholdCrossed).toBe(true);
  });

  it("does not flag the escalation threshold below it", async () => {
    const source = await writeSkill("small", { "SKILL.md": "x".repeat(49) });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "small", source })],
      instructionsContents: null,
      maxBytes: 100,
    });
    expect(projection!.escalationThresholdCrossed).toBe(false);
  });

  it("refuses a skill tree over the file bound rather than truncating it", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) files[`f${i}.md`] = "x";
    const source = await writeSkill("many", files);
    await expect(
      buildPromptBundleSecretProjection({
        ...base,
        serverDataMountPath: tmpRoot,
        skills: [entry({ key: "many", source })],
        instructionsContents: null,
        maxFilesPerSkill: 5,
      }),
    ).rejects.toBeInstanceOf(PromptBundleTooManyFilesError);
  });

  it("steps over symlinks rather than following them out of the tree", async () => {
    const source = await writeSkill("linky", { "SKILL.md": "real" });
    const outside = path.join(tmpRoot, "outside.md");
    await fs.writeFile(outside, "escaped", "utf-8");
    await fs.symlink(outside, path.join(source, "link.md"));
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "linky", source })],
      instructionsContents: null,
    });
    expect(projection!.items.map((i) => i.path)).toEqual([`${PROMPT_BUNDLE_SKILLS_DIR}/linky/SKILL.md`]);
    expect(Object.values(projection!.stringData)).not.toContain("escaped");
    // Counted, not merely skipped: a skipped link is a file the pod will not get, and
    // leaving it out of the report would under-count the measurement in silence.
    expect(projection!.skippedSymlinkCount).toBe(1);
  });

  it("reports zero skipped links for a tree that has none", async () => {
    const source = await writeSkill("plain", { "SKILL.md": "real" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "plain", source })],
      instructionsContents: null,
    });
    expect(projection!.skippedSymlinkCount).toBe(0);
    expect(projection!.skippedNonRegularCount).toBe(0);
  });

  it("carries a non-UTF-8 file base64 through `data`, byte-for-byte", async () => {
    // A PNG header: 0x89 is not a legal UTF-8 lead byte. Read as a string it becomes
    // U+FFFD, which both corrupts the delivered bytes and inflates the measurement to
    // 3 bytes per substitution — wrong for exactly the trees this measurement sizes.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const source = await writeSkill("assets", { "SKILL.md": "body", "logo.png": png });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "assets", source })],
      instructionsContents: null,
    });
    const pngKey = projection!.items.find((i) => i.path.endsWith("/logo.png"))!.key;
    expect(projection!.base64Data[pngKey]).toBe(png.toString("base64"));
    expect(projection!.stringData[pngKey]).toBeUndefined();
    expect(valueBytes(projection!, pngKey)).toEqual(png);
    expect(projection!.binaryFileCount).toBe(1);
    // The measurement is the RAW length, not the length of a lossy re-encoding. Read
    // as UTF-8 the two invalid bytes would have measured 3 each, giving 14.
    expect(projection!.totalValueBytes).toBe(png.length + 4);
    expect(projection!.bytesBySkillKey.assets).toBe(png.length + 4);
  });

  it("keeps a UTF-8 file on `stringData` and counts no binary", async () => {
    const source = await writeSkill("text", { "SKILL.md": "héllo" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "text", source })],
      instructionsContents: null,
    });
    expect(projection!.stringData["bundle-0"]).toBe("héllo");
    expect(projection!.base64Data).toEqual({});
    expect(projection!.binaryFileCount).toBe(0);
    expect(projection!.totalValueBytes).toBe(Buffer.byteLength("héllo", "utf8"));
  });

  it("preserves a UTF-8 BOM rather than stripping it", async () => {
    // `TextDecoder` strips a leading U+FEFF unless `ignoreBOM` is set, which would drop
    // three bytes from the delivered file and desync the byte count from the payload.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# title", "utf8")]);
    const source = await writeSkill("bom", { "SKILL.md": withBom });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "bom", source })],
      instructionsContents: null,
    });
    expect(valueBytes(projection!, "bundle-0")).toEqual(withBom);
    expect(projection!.totalValueBytes).toBe(withBom.length);
    expect(projection!.binaryFileCount).toBe(0);
  });

  it("budgets a binary file on its decoded length, not its base64 length", async () => {
    // Kubernetes base64-decodes `data` before `ValidateSecret` sums it, so a 48-byte
    // asset costs 48 against the cap and not the 64 its base64 form occupies. Budgeting
    // the encoded length would refuse runs that fit.
    const blob = Buffer.alloc(48, 0xff);
    const source = await writeSkill("blob", { "a.bin": blob });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      serverDataMountPath: tmpRoot,
      skills: [entry({ key: "blob", source })],
      instructionsContents: null,
      maxBytes: 48,
    });
    expect(projection!.totalValueBytes).toBe(48);
    expect(Object.values(projection!.base64Data)[0]!.length).toBe(64);
  });

  it("projects a catalog-backed skill that sits outside the server data mount", async () => {
    // PAPERCLIP_HOME need not be under SELF_POD_DATA_MOUNT_PATH. Keyed on the prefix
    // alone this skill would vanish from the projection with no signal.
    const source = await writeSkill("catalogue", { "SKILL.md": "catalog body" });
    const projection = await buildPromptBundleSecretProjection({
      ...base,
      // A mount the source is demonstrably NOT under.
      serverDataMountPath: path.join(tmpRoot, "elsewhere"),
      catalogBackedSkillKeys: new Set(["catalogue"]),
      skills: [entry({ key: "catalogue", source })],
      instructionsContents: null,
    });
    expect(projection!.fileCount).toBe(1);
    expect(projection!.bytesBySkillKey.catalogue).toBe(Buffer.byteLength("catalog body", "utf8"));
  });

  it("defaults the budget to the Kubernetes MaxSecretSize", () => {
    expect(PROMPT_BUNDLE_SECRET_MAX_BYTES).toBe(1024 * 1024);
  });
});

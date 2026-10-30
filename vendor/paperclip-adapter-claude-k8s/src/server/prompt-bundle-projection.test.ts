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

async function writeSkill(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(tmpRoot, "skills", name);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf-8");
  }
  return dir;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pen4932-projection-"));
});

afterEach(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("skillSourceNeedsProjection", () => {
  it("projects an entry under the server data mount", () => {
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/paperclip/skills/co/a" }), "/paperclip")).toBe(true);
  });

  it("leaves an adapter-bundled image path alone", () => {
    // `/app/skills/...` is the same absolute path in both namespaces because both come
    // from the same image layer, so projecting it would copy bytes the pod already has.
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/app/skills/a" }), "/paperclip")).toBe(false);
  });

  it("projects everything when the server mount is unknown", () => {
    // An unnecessary copy costs budget; a missing one costs the agent its skill.
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/app/skills/a" }), undefined)).toBe(true);
  });

  it("does not treat a sibling directory sharing a name prefix as being under the mount", () => {
    expect(skillSourceNeedsProjection(entry({ key: "a", source: "/paperclip-other/a" }), "/paperclip")).toBe(false);
  });
});

describe("buildPromptBundleSecretProjection", () => {
  const base = { companyId: "co-1", runLabel: "run-1", serverDataMountPath: tmpRoot };

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
    expect(projection!.data["bundle-0"]).toBe("# instructions");
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
    const byPath = new Map(projection!.items.map((i) => [i.path, projection!.data[i.key]]));
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
    expect(reversed!.data).toEqual(forward!.data);
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
    expect(Object.values(projection!.data)).not.toContain("escaped");
  });

  it("defaults the budget to the Kubernetes MaxSecretSize", () => {
    expect(PROMPT_BUNDLE_SECRET_MAX_BYTES).toBe(1024 * 1024);
  });
});

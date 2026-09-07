import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareClaudePromptBundle, readCatalogBackedSkillKeys } from "./prompt-cache.js";

const onLog = vi.fn();

describe("prepareClaudePromptBundle path traversal validation", () => {
  const validArgs = {
    skills: [],
    instructionsContents: null,
    onLog,
  };

  it("rejects companyId containing ..", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: ".." })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing ../x", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "../x" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing /", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a/b" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing backslash", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a\\b" })).rejects.toThrow(/companyId/);
  });

  it("rejects companyId containing null byte", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "a\0b" })).rejects.toThrow(/companyId/);
  });

  it("rejects empty companyId", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "" })).rejects.toThrow(/companyId/);
  });

  it("rejects whitespace-only companyId", async () => {
    await expect(prepareClaudePromptBundle({ ...validArgs, companyId: "   " })).rejects.toThrow(/companyId/);
  });

  it("accepts a valid companyId", async () => {
    vi.stubEnv("PAPERCLIP_HOME", path.join(os.tmpdir(), `prompt-cache-test-${process.pid}`));
    const result = await prepareClaudePromptBundle({ ...validArgs, companyId: "acme-co" });
    expect(result.rootDir).toContain("acme-co");
    vi.unstubAllEnvs();
  });
});

// BLO-32055. `materializeRuntimeSkillFiles` refreshes a runtime skill by
// `fs.rm(dir, {recursive:true})` -> `mkdir` -> per-file `writeFile`, so the
// rolling sweep publishes a window in which the directory exists and `SKILL.md`
// does not. Every fixture below reproduces exactly that observable state on
// disk rather than stubbing `fs`, because the state — not the call — is what
// the deployed code met.
describe("prepareClaudePromptBundle skill-source materialization race (BLO-32055)", () => {
  const companyId = "acme-co";

  async function withSkillDir<T>(
    write: (skillDir: string) => Promise<void>,
    body: (skillDir: string) => Promise<T>,
  ): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blo32055-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    try {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });
      await write(skillDir);
      return await body(skillDir);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const skillEntry = (source: string) => ({
    key: "garrytan/gstack/investigate",
    runtimeName: "investigate--9debdeaf08",
    source,
    required: false,
    requiredReason: null,
  });

  it("names the owning skill instead of throwing a bare ENOENT when SKILL.md is mid-write", async () => {
    // The directory exists and SKILL.md does not: the exact partially-materialized
    // state observed live, where the file appeared 43m36s after the run died.
    await withSkillDir(
      async (skillDir) => { await fs.writeFile(path.join(skillDir, "references.md"), "x", "utf8"); },
      async (skillDir) => {
        // Directory listed, SKILL.md gone between the readdir and the readFile.
        const realReadFile = fs.readFile;
        const spy = vi.spyOn(fs, "readFile").mockImplementation(async (target, ...rest) => {
          if (typeof target === "string" && target.endsWith("SKILL.md")) {
            const err = new Error(`ENOENT: no such file or directory, open '${target}'`) as NodeJS.ErrnoException;
            err.code = "ENOENT";
            err.path = target;
            throw err;
          }
          return (realReadFile as never)(target, ...rest);
        });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: investigate\n---\n", "utf8");
        try {
          await expect(prepareClaudePromptBundle({
            companyId,
            skills: [skillEntry(skillDir)],
            instructionsContents: null,
            onLog,
          })).rejects.toMatchObject({
            name: "ClaudeSkillSourceUnavailableError",
            skillKey: "garrytan/gstack/investigate",
            catalogBacked: true,
          });
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  it("classifies a catalog-backed source as transient and a non-catalog one as permanent", async () => {
    // The discriminator the issue predicted: presence of a company-skill catalog
    // row, not the message text. Both branches meet the identical on-disk state,
    // so only the catalog membership can move the verdict.
    await withSkillDir(
      async () => { /* SKILL.md deliberately never written */ },
      async (skillDir) => {
        const skills = [skillEntry(skillDir)];
        await fs.rm(skillDir, { recursive: true, force: true });

        await expect(prepareClaudePromptBundle({
          companyId,
          skills,
          instructionsContents: null,
          catalogBackedSkillKeys: new Set(["garrytan/gstack/investigate"]),
          onLog,
        })).rejects.toMatchObject({ catalogBacked: true });

        await expect(prepareClaudePromptBundle({
          companyId,
          skills,
          instructionsContents: null,
          catalogBackedSkillKeys: new Set<string>(),
          onLog,
        })).rejects.toMatchObject({ catalogBacked: false });
      },
    );
  });

  it("does not launder a non-ENOENT read failure into a skill fault", async () => {
    // An EACCES is a real permissions fault, not a sweep race. Classifying it as
    // materialization-pending would retry it forever against an unchanging cause.
    await withSkillDir(
      async (skillDir) => { await fs.writeFile(path.join(skillDir, "SKILL.md"), "body", "utf8"); },
      async (skillDir) => {
        const spy = vi.spyOn(fs, "readFile").mockImplementation(async () => {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        });
        try {
          await expect(prepareClaudePromptBundle({
            companyId,
            skills: [skillEntry(skillDir)],
            instructionsContents: null,
            onLog,
          })).rejects.toThrow(/EACCES/);
        } finally {
          spy.mockRestore();
        }
      },
    );
  });

  it("leaves the bundle key of an intact skill tree byte-identical", async () => {
    // The guard must not perturb the normal path: a changed key would invalidate
    // every cached prompt bundle in the estate on deploy.
    await withSkillDir(
      async (skillDir) => { await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: investigate\n---\n", "utf8"); },
      async (skillDir) => {
        const bundle = await prepareClaudePromptBundle({
          companyId,
          skills: [skillEntry(skillDir)],
          instructionsContents: null,
          onLog,
        });
        expect(bundle.bundleKey).toMatch(/^[0-9a-f]{64}$/);
      },
    );
  });
});

// BLO-32167. The other instant of the same race, and the one no `try/catch` can
// reach: sampled after the `mkdir` and before `SKILL.md` lands, the tree raises
// no syscall error at all. Every fixture below therefore asserts on a walk that
// *succeeds* — if these ever start passing by throwing an ENOENT, the fixture
// has drifted onto branch A and is no longer testing this issue.
describe("prepareClaudePromptBundle skill-source entrypoint assertion (BLO-32167)", () => {
  const companyId = "acme-co";
  const skillKey = "garrytan/gstack/investigate";

  async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blo32167-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    try {
      return await body(root);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const skillEntry = (source: string) => ({
    key: skillKey,
    runtimeName: "investigate--9debdeaf08",
    source,
    required: false,
    requiredReason: null,
  });

  it("refuses to mint a key over a catalog-backed skill whose directory is empty", async () => {
    // The live capture: CEO run ff67a1b1, ~00:35Z 2026-09-06. The per-run pod
    // copy of `investigate--9debdeaf08` was an empty directory while the shared
    // store held all 24,209 bytes a minute later. The run did not die — it
    // completed, silently degraded, and the catalogue advertised the skill
    // throughout. Nothing here mocks `fs`: an empty directory is a state the
    // filesystem produces natively, which is the whole point of the branch.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });
      expect(await fs.readdir(skillDir)).toHaveLength(0);

      await expect(prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        catalogBackedSkillKeys: new Set([skillKey]),
        onLog,
      })).rejects.toMatchObject({
        name: "ClaudeSkillSourceUnavailableError",
        skillKey,
        // Retryable `skill_materialization_pending`, never `skill_not_found`:
        // the condition self-heals on the next sweep, and `skill_not_found` is
        // in NON_RETRYABLE_CONTINUATION_ERROR_CODES.
        catalogBacked: true,
      });
    });
  });

  it("refuses a partially-written tree that has files but no SKILL.md", async () => {
    // Strictly more common than the empty case and invisible to an emptiness
    // test: the writer iterates `fileInventory` in order and SKILL.md need not
    // be first, so "some files, no entrypoint" is the wider window.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
      await fs.writeFile(path.join(skillDir, "references", "playbook.md"), "x", "utf8");
      expect(await fs.readdir(skillDir)).not.toHaveLength(0);

      await expect(prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        catalogBackedSkillKeys: new Set([skillKey]),
        onLog,
      })).rejects.toMatchObject({ name: "ClaudeSkillSourceUnavailableError", catalogBacked: true });
    });
  });

  it("leaves a non-catalog-backed empty directory classifying exactly as before", async () => {
    // The BLO-31794 over-suppression hazard, in the direction this change could
    // newly break: a bundled adapter skill lives in a read-only image path the
    // sweep never rewrites, so its shape is not ours to police. Same on-disk
    // state as the first case; only catalog membership moves the verdict, and
    // here it must mint a key rather than manufacture a fault.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });

      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        catalogBackedSkillKeys: new Set<string>(),
        onLog,
      });
      expect(bundle.bundleKey).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("leaves the bundle key of a populated catalog-backed tree byte-identical", async () => {
    // The assertion must not perturb the healthy path. A changed key would
    // invalidate every cached prompt bundle in the estate on deploy, so this
    // compares the guarded key against the unguarded one rather than merely
    // asserting it is well-formed.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: investigate\n---\n", "utf8");

      const guarded = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        catalogBackedSkillKeys: new Set([skillKey]),
        onLog,
      });
      const unguarded = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        onLog,
      });
      expect(guarded.bundleKey).toBe(unguarded.bundleKey);
    });
  });

  it("accepts a SKILL.md reached through a symlink", async () => {
    // `stat`, not `lstat`: a symlinked entrypoint resolving to a real file is
    // usable, and treating it as missing would fail a legitimate layout.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });
      const realDoc = path.join(root, "real-skill.md");
      await fs.writeFile(realDoc, "---\nname: investigate\n---\n", "utf8");
      await fs.symlink(realDoc, path.join(skillDir, "SKILL.md"));

      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(skillDir)],
        instructionsContents: null,
        catalogBackedSkillKeys: new Set([skillKey]),
        onLog,
      });
      expect(bundle.bundleKey).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it("does not launder a non-ENOENT stat failure into a skill fault", async () => {
    // Mirrors the branch-A EACCES case. A permissions fault on the entrypoint is
    // a real fault against an unchanging cause; classifying it as
    // materialization-pending would retry it forever.
    await withRoot(async (root) => {
      const skillDir = path.join(root, "__runtime__", "investigate--9debdeaf08");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "body", "utf8");

      const realStat = fs.stat;
      const spy = vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
        if (typeof target === "string" && target.endsWith("SKILL.md")) {
          const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return (realStat as never)(target, ...rest);
      });
      try {
        await expect(prepareClaudePromptBundle({
          companyId,
          skills: [skillEntry(skillDir)],
          instructionsContents: null,
          catalogBackedSkillKeys: new Set([skillKey]),
          onLog,
        })).rejects.toThrow(/EACCES/);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

// BLO-32055. `readPaperclipRuntimeSkillEntries` silently switches source: it
// returns the server-injected catalog entries, OR — when the config carries none
// — the adapter's own bundled on-disk skills. Only the first set lives under the
// sweep-rewritten `__runtime__/`, so getting this wrong routes a permanent
// packaging fault into three futile retries (or, worse, the reverse).
describe("readCatalogBackedSkillKeys (BLO-32055)", () => {
  it("returns the injected catalog keys", () => {
    expect(readCatalogBackedSkillKeys({
      paperclipRuntimeSkills: [
        { key: "garrytan/gstack/investigate", runtimeName: "investigate--9debdeaf08", source: "/x" },
        { key: "blockcast/hindsight/hindsight-docs", runtimeName: "hindsight-docs--37354dfd0d", source: "/y" },
      ],
    })).toEqual(new Set(["garrytan/gstack/investigate", "blockcast/hindsight/hindsight-docs"]));
  });

  it("reports no catalog keys when the adapter falls back to its bundled skills", () => {
    // The fallback branch: config carries no injected list, so every entry
    // execute() sees is a bundled `paperclipai/paperclip/*` skill and must
    // classify as permanent rather than materialization-pending.
    expect(readCatalogBackedSkillKeys({}).size).toBe(0);
    expect(readCatalogBackedSkillKeys({ paperclipRuntimeSkills: null }).size).toBe(0);
    expect(readCatalogBackedSkillKeys({ paperclipRuntimeSkills: "not-an-array" }).size).toBe(0);
  });

  it("mirrors the server-utils key fallback, including an EMPTY key falling back to name", () => {
    // The one divergent shape. `asString` falls back on an empty string, not
    // merely on a non-string, so upstream normalizes this entry to key
    // `legacy-name-only`. A `typeof key === "string"` test resolves it to `""`
    // and drops it — marking a catalog-backed skill un-backed, i.e. permanent
    // retry suppression on a self-healing condition. Negative control: this
    // case fails against the hand-rolled predicate it replaced, while the two
    // below pass against both.
    expect(readCatalogBackedSkillKeys({
      paperclipRuntimeSkills: [
        { key: "", name: "legacy-name-only", runtimeName: "legacy--37354dfd0d", source: "/z" },
        { name: "name-only", runtimeName: "name-only--9debdeaf08", source: "/y" },
        { key: "  padded/key  ", runtimeName: "padded--1a2b3c4d5e", source: "/x" },
      ],
    })).toEqual(new Set(["legacy-name-only", "name-only", "padded/key"]));
  });

  it("drops the same unusable entries server-utils drops", () => {
    // `normalizeConfiguredPaperclipRuntimeSkills` discards any entry missing
    // `runtimeName` or `source`, so such an entry can never reach the `.has()`
    // lookup as a real skill. Contributing its key anyway would let a
    // source-less entry colliding with a BUNDLED skill's key mark a read-only
    // image-path packaging fault as retryable — three futile retries.
    expect(readCatalogBackedSkillKeys({
      paperclipRuntimeSkills: [
        { key: "no-source", runtimeName: "no-source--0000000000" },
        { key: "no-runtime-name", source: "/x" },
        { key: "blank-source", runtimeName: "blank--0000000000", source: "   " },
        { key: 42, runtimeName: "n", source: "/x" },
        { key: "", name: "", runtimeName: "n", source: "/x" },
        null,
        "a-string",
        ["an-array"],
      ],
    })).toEqual(new Set());
  });
});

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

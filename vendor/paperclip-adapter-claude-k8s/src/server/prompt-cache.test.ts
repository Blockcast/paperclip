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

// BLO-37760. The bundle is the one prompt-cache artifact with a writer in the
// paperclip process and a reader in the agent pod, and under a custom
// `config.workspaceMountPath` those two reach the shared volume at DIFFERENT
// absolute paths. Every fixture below uses two REAL directories — one standing
// in for the pod's mount, one for the server's — so "the server wrote at the
// pod's address" is caught on CONTENT rather than on a permission error, which
// is what makes the mutation tests below fail for the right reason.
describe("prepareClaudePromptBundle two address spaces (BLO-37760)", () => {
  const companyId = "acme-co";
  const instructionsContents = "# charter\n";

  async function withMounts<T>(
    body: (mounts: { podMount: string; serverMount: string; podRootDir: string }) => Promise<T>,
  ): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blo37760-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    try {
      const podMount = path.join(root, "pod-mnt");
      const serverMount = path.join(root, "srv-mnt");
      // Both exist and are writable: a reverted guard genuinely succeeds in
      // writing to the wrong one, which is the state this must detect.
      await fs.mkdir(podMount, { recursive: true });
      await fs.mkdir(serverMount, { recursive: true });
      return await body({
        podMount,
        serverMount,
        podRootDir: path.posix.join(podMount, "instances/default/data/k8s-isolation/acme-co/agent-1/key-1/prompt-cache"),
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const exists = (target: string) => fs.stat(target).then(() => true).catch(() => false);

  it("writes the skills bundle at the SERVER address while reporting the POD address to the container", async () => {
    await withMounts(async ({ podMount, serverMount, podRootDir }) => {
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [],
        instructionsContents: null,
        rootDir: podRootDir,
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        onLog,
      });

      // What the CONTAINER is handed (--add-dir) is a pod address.
      expect(bundle.addDir.startsWith(`${podMount}/`)).toBe(true);
      expect(bundle.rootDir).toBe(bundle.addDir);

      // AC: the server path is the server mount joined to the SAME
      // volume-relative subpath the pod path carries — derived from the pod
      // path, never asserted as a second string literal.
      const volumeRelative = bundle.addDir.slice(`${podMount}/`.length);
      expect(bundle.serverRootDir).toBe(path.posix.join(serverMount, volumeRelative));

      // ...and the bytes are really there, not merely named there.
      expect(await exists(path.join(bundle.serverRootDir, ".claude", "skills"))).toBe(true);

      // The defect itself: nothing may be created at the pod address, which on
      // this process's filesystem is a different directory entirely.
      expect(await exists(bundle.addDir)).toBe(false);
    });
  });

  it("applies the same translation to instructionsFilePath / --append-system-prompt-file", async () => {
    await withMounts(async ({ podMount, serverMount, podRootDir }) => {
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [],
        instructionsContents,
        rootDir: podRootDir,
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        onLog,
      });

      expect(bundle.instructionsFilePath).not.toBeNull();
      const podInstructions = bundle.instructionsFilePath as string;
      expect(podInstructions.startsWith(`${podMount}/`)).toBe(true);

      const volumeRelative = podInstructions.slice(`${podMount}/`.length);
      const serverInstructions = path.posix.join(serverMount, volumeRelative);
      expect(await fs.readFile(serverInstructions, "utf8")).toBe(instructionsContents);
      expect(await exists(podInstructions)).toBe(false);
    });
  });

  it("leaves an off-volume root untranslated (the managed PAPERCLIP_HOME default has no pod counterpart)", async () => {
    await withMounts(async ({ podMount, serverMount }) => {
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [],
        instructionsContents: null,
        // No rootDir => the managed PAPERCLIP_HOME default, which is already a
        // server path. Rewriting it would relocate it somewhere it never was.
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        onLog,
      });
      expect(bundle.serverRootDir).toBe(bundle.rootDir);
      expect(bundle.serverRootDir.startsWith(`${serverMount}/`)).toBe(false);
      expect(await exists(path.join(bundle.serverRootDir, ".claude", "skills"))).toBe(true);
    });
  });

  // AC 3, the required no-op control: the default mount is the only
  // configuration in production use, so every emitted path must be
  // byte-identical to what today's code produces.
  it("is a byte-for-byte no-op when the two mounts coincide, and when they are omitted", async () => {
    await withMounts(async ({ podMount, podRootDir }) => {
      const args = {
        companyId,
        skills: [],
        instructionsContents,
        rootDir: podRootDir,
        onLog,
      };
      const coinciding = await prepareClaudePromptBundle({
        ...args,
        podDataMountPath: podMount,
        serverDataMountPath: podMount,
      });
      const omitted = await prepareClaudePromptBundle(args);

      for (const bundle of [coinciding, omitted]) {
        expect(bundle.rootDir).toBe(bundle.addDir);
        expect(bundle.serverRootDir).toBe(bundle.rootDir);
        expect(bundle.rootDir.startsWith(`${podRootDir}/`)).toBe(true);
        expect(await exists(path.join(bundle.rootDir, ".claude", "skills"))).toBe(true);
        expect(await fs.readFile(bundle.instructionsFilePath as string, "utf8")).toBe(instructionsContents);
      }
      expect(omitted.rootDir).toBe(coinciding.rootDir);
      expect(omitted.instructionsFilePath).toBe(coinciding.instructionsFilePath);
      expect(omitted.bundleKey).toBe(coinciding.bundleKey);
    });
  });

  // Ally review of #2107 (Important): `toServerAddress`'s "not under the pod
  // mount" early return keeps the WRITE correct but hands the container a path
  // that is not on its data mount, and nothing said so. Each case below is a
  // path the container is handed via `--add-dir`, so the report is keyed on the
  // pod mount alone.
  async function offVolumeWarnings(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run();
      return warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "claude_k8s.prompt_bundle_off_volume");
    } finally {
      warn.mockRestore();
    }
  }

  it("reports an operator-set root on the SERVER mount but off a custom pod mount", async () => {
    await withMounts(async ({ podMount, serverMount }) => {
      // The shape `resolvePromptCacheRoot` returns verbatim for
      // `config.promptCacheRoot`: a `/paperclip/...` path while the pod mounts
      // the volume elsewhere. The write lands on the volume; the read cannot.
      const configuredRoot = path.posix.join(serverMount, "operator/prompt-cache");
      let rootDir = "";
      const warnings = await offVolumeWarnings(async () => {
        ({ rootDir } = await prepareClaudePromptBundle({
          companyId,
          skills: [],
          instructionsContents: null,
          rootDir: configuredRoot,
          podDataMountPath: podMount,
          serverDataMountPath: serverMount,
          onLog,
        }));
      });
      expect(warnings).toEqual([
        expect.objectContaining({ rootDir, podDataMountPath: podMount, serverDataMountPath: serverMount }),
      ]);
    });
  });

  it("reports the managed PAPERCLIP_HOME default when it is off the pod mount", async () => {
    await withMounts(async ({ podMount, serverMount }) => {
      const warnings = await offVolumeWarnings(() =>
        prepareClaudePromptBundle({
          companyId,
          skills: [],
          instructionsContents: null,
          podDataMountPath: podMount,
          serverDataMountPath: serverMount,
          onLog,
        }),
      );
      expect(warnings).toHaveLength(1);
    });
  });

  it("reports a root off the mount even when the two mounts coincide", async () => {
    await withMounts(async ({ podMount, serverMount }) => {
      // Equal mounts do not make an off-mount root readable: the server still
      // writes to its own filesystem. Guards against gating on `pod !== server`.
      const warnings = await offVolumeWarnings(() =>
        prepareClaudePromptBundle({
          companyId,
          skills: [],
          instructionsContents: null,
          rootDir: path.posix.join(serverMount, "prompt-cache"),
          podDataMountPath: podMount,
          serverDataMountPath: podMount,
          onLog,
        }),
      );
      expect(warnings).toHaveLength(1);
    });
  });

  it("does not report a root on the pod mount, nor when the mounts are unknown", async () => {
    await withMounts(async ({ podMount, serverMount, podRootDir }) => {
      const warnings = await offVolumeWarnings(async () => {
        for (const mounts of [
          { podDataMountPath: podMount, serverDataMountPath: serverMount },
          { podDataMountPath: podMount, serverDataMountPath: podMount },
          {},
        ]) {
          await prepareClaudePromptBundle({
            companyId,
            skills: [],
            instructionsContents: null,
            rootDir: podRootDir,
            ...mounts,
            onLog,
          });
        }
      });
      expect(warnings).toEqual([]);
    });
  });
});

// BLO-37961. BLO-37760 above makes the bundle DIRECTORY resolve from both
// address spaces. It does not fix what the directory CONTAINS: each entry in
// `.claude/skills/` is an absolute symlink, and a catalog-backed skill's
// `source` arrives from a server service (`resolveManagedSkillsRoot`) as a
// SERVER address. Written verbatim it is a link the pod cannot follow —
// present, correctly named, and dangling.
//
// Every fixture materializes the skill tree under BOTH mounts at the same
// volume-relative subpath, because that is what ONE shared volume mounted twice
// actually looks like. That is also why `exists()` alone cannot discriminate
// here: in a single test process both mounts are real directories, so a link
// carrying the WRONG address still stats fine. The pod-namespace predicate is
// therefore two clauses, and the `startsWith` clause is the load-bearing one —
// it is what "resolves in the POD's mount namespace" means when you cannot
// actually enter that namespace. Do not "simplify" it to a bare stat.
describe("prompt-bundle skill symlinks carry POD addresses (BLO-37961)", () => {
  const companyId = "acme-co";
  const runtimeName = "investigate--9debdeaf08";
  // The volume-relative location of a catalog-backed skill, i.e. what
  // `resolveManagedSkillsRoot(companyId)/__runtime__/<name>` reduces to once
  // the mount prefix is removed. Declared once so neither leg can drift.
  const volumeRelativeSkill = `instances/default/skills/${companyId}/__runtime__/${runtimeName}`;

  async function withVolume<T>(
    body: (ctx: {
      podMount: string;
      serverMount: string;
      podRootDir: string;
      serverSkillSource: string;
      podSkillSource: string;
      offMountSkillSource: string;
    }) => Promise<T>,
  ): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blo37961-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    try {
      const podMount = path.join(root, "pod-mnt");
      const serverMount = path.join(root, "srv-mnt");
      const serverSkillSource = path.posix.join(serverMount, volumeRelativeSkill);
      const podSkillSource = path.posix.join(podMount, volumeRelativeSkill);
      // `resolveManagedSkillsRoot` under a PAPERCLIP_HOME that is NOT under the
      // server mount: on no volume at all, so `toPodAddress` cannot translate it.
      const offMountSkillSource = path.posix.join(root, "home", volumeRelativeSkill);
      // Same bytes, two mount points. Both carry a real SKILL.md because the
      // server hashes the source tree to derive the bundle key, so a source
      // that does not exist server-side never reaches the symlink code at all.
      for (const dir of [serverSkillSource, podSkillSource, offMountSkillSource]) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: probe\n---\n", "utf8");
      }
      return await body({
        podMount,
        serverMount,
        podRootDir: path.posix.join(podMount, "instances/default/data/k8s-isolation/acme-co/agent-1/prompt-cache"),
        serverSkillSource,
        podSkillSource,
        offMountSkillSource,
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const skillEntry = (source: string, name = runtimeName) => ({
    key: "garrytan/gstack/investigate",
    runtimeName: name,
    source,
    required: false,
    requiredReason: null,
  });

  /** The link target the pod would actually follow, read off the emitted bundle. */
  const linkTarget = (bundle: { serverRootDir: string }, name = runtimeName) =>
    fs.readlink(path.join(bundle.serverRootDir, ".claude", "skills", name));

  it("rewrites a catalog-backed SERVER source to the POD address for the same bytes", async () => {
    await withVolume(async ({ podMount, serverMount, podRootDir, serverSkillSource, podSkillSource }) => {
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(serverSkillSource)],
        instructionsContents: null,
        rootDir: podRootDir,
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        onLog,
      });

      const target = await linkTarget(bundle);

      // (1) It is a POD address — the clause that fails when the rewrite is
      //     reverted, since the raw source is under serverMount.
      expect(target.startsWith(`${podMount}/`)).toBe(true);
      // (2) ...and the bytes are really at that address, so this is resolution
      //     and not string manipulation that happens to look right.
      expect(await fs.stat(path.join(target, "SKILL.md")).then(() => true, () => false)).toBe(true);
      // Derived from the input rather than restated, so the two cannot drift.
      expect(target).toBe(podSkillSource);
      expect(target).not.toBe(serverSkillSource);
    });
  });

  it("leaves an IMAGE path (/app/skills/...) byte-identical — rewriting it would break it", async () => {
    await withVolume(async ({ podMount, serverMount, podRootDir, offMountSkillSource }) => {
      // The adapter's own bundled on-disk skills (`/app/skills/paperclip`). Same
      // absolute path in both namespaces because both come from the image
      // layer, not the volume, so this is the set that works TODAY and the
      // rewrite must not touch it. Stood in for by `offMountSkillSource`, a real
      // directory outside both mounts that reaches the identical `toPodAddress`
      // branch: the source is hashed before any link is written, so the literal
      // `/app/skills/...` would only run on a host that has it. The empty key
      // set is what `execute.ts` passes for a bundled (non-catalog) entry.
      const imageSource = offMountSkillSource;
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(imageSource, "paperclip")],
        instructionsContents: null,
        rootDir: podRootDir,
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        catalogBackedSkillKeys: new Set<string>(),
        onLog,
      });

      expect(await linkTarget(bundle, "paperclip")).toBe(imageSource);
    });
  });

  it("is a byte-for-byte no-op when the mounts coincide, and when they are omitted", async () => {
    // The default deployment (41/41 live agent Jobs measured 2026-09-29) and the
    // claude-local shape. Both must emit exactly the pre-BLO-37961 target.
    //
    // Each leg gets its OWN volume, and that is load-bearing rather than tidy.
    // Both legs derive the same content-hashed `bundleKey` from the same root,
    // so sharing a volume shares ONE bundle directory: the first leg's symlink
    // is still sitting there when the second runs, and since the symlink write
    // is inside a try/catch that only logs, a leg that fails outright still
    // reads the previous leg's link back and passes. That is how this test
    // first passed with the unknown-mount guard deleted (BLO-34263: a guard
    // with no failing mutation is a comment).
    for (const mounts of [
      (podMount: string) => ({ podDataMountPath: podMount, serverDataMountPath: podMount }),
      () => ({}),
    ]) {
      await withVolume(async ({ podMount, podRootDir, serverSkillSource }) => {
        const bundle = await prepareClaudePromptBundle({
          companyId,
          skills: [skillEntry(serverSkillSource)],
          instructionsContents: null,
          rootDir: podRootDir,
          ...mounts(podMount),
          onLog,
        });
        expect(await linkTarget(bundle)).toBe(serverSkillSource);
      });
    }
  });

  it("repairs a STALE pre-fix link when an operator adopts a custom pod mount", async () => {
    // The migration this row exists for, and the one shape a fresh-bundle test
    // cannot reach. `bundleKey` is derived from skill CONTENT and the server's
    // own mount does not move, so `serverRootDir` resolves to the SAME server
    // directory before and after the pod mount changes: run two lands on run
    // one's bundle, stale links included.
    await withVolume(async ({ podMount, serverMount, serverSkillSource, podSkillSource }) => {
      const volumeRelativeRoot = "instances/default/data/k8s-isolation/acme-co/agent-1/prompt-cache";
      const skills = [skillEntry(serverSkillSource)];

      // Run 1 — today's deployment: the pod reaches the volume where the server
      // does, so the root is a server-mount address and the link is written
      // absolute-to-server. This is the pre-BLO-37961 artifact, produced by the
      // real code path rather than hand-planted.
      const before = await prepareClaudePromptBundle({
        companyId,
        skills,
        instructionsContents: null,
        rootDir: path.posix.join(serverMount, volumeRelativeRoot),
        podDataMountPath: serverMount,
        serverDataMountPath: serverMount,
        onLog,
      });
      expect(await linkTarget(before)).toBe(serverSkillSource);

      // Run 2 — `workspaceMountPath` now points elsewhere. Only the POD mount
      // moves; the server still reaches the volume exactly where it did.
      const after = await prepareClaudePromptBundle({
        companyId,
        skills,
        instructionsContents: null,
        rootDir: path.posix.join(podMount, volumeRelativeRoot),
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        onLog,
      });

      // Same bundle directory — the premise. If this ever goes false the test
      // below is vacuous, so assert it rather than assuming it.
      expect(after.serverRootDir).toBe(before.serverRootDir);
      expect(await linkTarget(after)).toBe(podSkillSource);
    });
  });

  it("rewrites the catalog entry and spares the image entry in the SAME bundle", async () => {
    // The live set is MIXED, which is why the defect was not obvious: a bundle
    // whose image-path links all resolve looks healthy. One leg per shape in one
    // call, so a rewrite that is unconditional in either direction fails here.
    await withVolume(async ({ podMount, serverMount, podRootDir, serverSkillSource, podSkillSource, offMountSkillSource }) => {
      // The image entry is `offMountSkillSource` standing in for
      // `/app/skills/paperclip`, as in the IMAGE-path test above. It gets its
      // own key so the key set can mark only the catalog entry, as `execute.ts`
      // does for a mixed bundle.
      const imageEntry = { ...skillEntry(offMountSkillSource, "paperclip"), key: "paperclipai/paperclip/paperclip" };
      const bundle = await prepareClaudePromptBundle({
        companyId,
        skills: [skillEntry(serverSkillSource), imageEntry],
        instructionsContents: null,
        rootDir: podRootDir,
        podDataMountPath: podMount,
        serverDataMountPath: serverMount,
        catalogBackedSkillKeys: new Set([skillEntry(serverSkillSource).key]),
        onLog,
      });

      expect(await linkTarget(bundle)).toBe(podSkillSource);
      expect(await linkTarget(bundle, "paperclip")).toBe(offMountSkillSource);
    });
  });

  // Ally review of #2114 (Important): `toPodAddress`'s "not under the server
  // mount" return is right for an IMAGE path only. A catalog-backed source is a
  // PAPERCLIP_HOME path, and the server mount is `SELF_POD_DATA_MOUNT_PATH`; where
  // those diverge the source passes through untranslated and dangles in the pod.
  // Keyed on the pod mount alone, as `prompt_bundle_off_volume` is.
  const catalogKey = skillEntry("").key;
  async function skillOffVolumeWarnings(run: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run();
      return warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "claude_k8s.prompt_bundle_skill_off_volume");
    } finally {
      warn.mockRestore();
    }
  }

  it("reports a catalog-backed source toPodAddress cannot translate, with or without the key set", async () => {
    await withVolume(async ({ podMount, serverMount, podRootDir, offMountSkillSource }) => {
      // Omitting the set defaults every entry to catalog-backed, the same
      // direction `buildClaudePromptBundleKey` takes, so it must report too.
      for (const catalogBackedSkillKeys of [new Set([catalogKey]), undefined]) {
        const warnings = await skillOffVolumeWarnings(() =>
          prepareClaudePromptBundle({
            companyId,
            skills: [skillEntry(offMountSkillSource)],
            instructionsContents: null,
            rootDir: podRootDir,
            podDataMountPath: podMount,
            serverDataMountPath: serverMount,
            catalogBackedSkillKeys,
            onLog,
          }),
        );
        expect(warnings).toEqual([
          expect.objectContaining({
            skillKey: catalogKey,
            linkTarget: offMountSkillSource,
            podDataMountPath: podMount,
            serverDataMountPath: serverMount,
          }),
        ]);
      }
    });
  });

  it("reports it even when the two mounts coincide", async () => {
    await withVolume(async ({ podMount, podRootDir, offMountSkillSource }) => {
      // Equal mounts do not put a PAPERCLIP_HOME path on the volume. Guards
      // against gating on `pod !== server`.
      const warnings = await skillOffVolumeWarnings(() =>
        prepareClaudePromptBundle({
          companyId,
          skills: [skillEntry(offMountSkillSource)],
          instructionsContents: null,
          rootDir: podRootDir,
          podDataMountPath: podMount,
          serverDataMountPath: podMount,
          catalogBackedSkillKeys: new Set([catalogKey]),
          onLog,
        }),
      );
      expect(warnings).toHaveLength(1);
    });
  });

  it("does not report a followable catalog link, a non-catalog entry, or unknown mounts", async () => {
    await withVolume(async ({ podMount, serverMount, podRootDir, serverSkillSource, offMountSkillSource }) => {
      const catalog = new Set([catalogKey]);
      const legs = [
        // Translated onto the pod mount: followable.
        { source: serverSkillSource, keys: catalog, pod: podMount, server: serverMount },
        // Mounts coincide, so `toPodAddress` returns the source UNCHANGED, yet it
        // is on the mount and followable. "Unchanged" is not the defect.
        { source: serverSkillSource, keys: catalog, pod: serverMount, server: serverMount },
        // Same off-mount path, only the discriminator differs: an image entry
        // is off the volume by design.
        { source: offMountSkillSource, keys: new Set<string>(), pod: podMount, server: serverMount },
        // No pod mount, nothing to compare against.
        { source: offMountSkillSource, keys: catalog, pod: undefined, server: undefined },
      ];
      const warnings = await skillOffVolumeWarnings(async () => {
        for (const leg of legs) {
          await prepareClaudePromptBundle({
            companyId,
            skills: [skillEntry(leg.source)],
            instructionsContents: null,
            rootDir: podRootDir,
            podDataMountPath: leg.pod,
            serverDataMountPath: leg.server,
            catalogBackedSkillKeys: leg.keys,
            onLog,
          });
        }
      });
      expect(warnings).toEqual([]);
    });
  });
});

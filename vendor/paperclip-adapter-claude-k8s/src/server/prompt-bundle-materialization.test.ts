import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPromptBundleMaterializationShell, isSafeBundlePath } from "./prompt-bundle-materialization.js";

/** The quoting the job manifests pass in; duplicated here so the test is self-contained. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe("isSafeBundlePath", () => {
  it("accepts the shapes the projection actually emits", () => {
    expect(isSafeBundlePath("agent-instructions.md")).toBe(true);
    expect(isSafeBundlePath(".claude/skills/dataviz/SKILL.md")).toBe(true);
    expect(isSafeBundlePath(".claude/skills/dataviz/references/palette.md")).toBe(true);
  });

  it("rejects every way out of the bundle root", () => {
    expect(isSafeBundlePath("")).toBe(false);
    expect(isSafeBundlePath("/etc/passwd")).toBe(false);
    expect(isSafeBundlePath("../escape.md")).toBe(false);
    expect(isSafeBundlePath(".claude/../../escape.md")).toBe(false);
    expect(isSafeBundlePath("./a.md")).toBe(false);
    expect(isSafeBundlePath("a//b.md")).toBe(false);
  });

  it("rejects a newline, which would split the emitted for-list into two paths", () => {
    expect(isSafeBundlePath("a.md\nb.md")).toBe(false);
    expect(isSafeBundlePath("a\u0000.md")).toBe(false);
  });
});

describe("buildPromptBundleMaterializationShell", () => {
  let root = "";
  let secretMount = "";
  let bundleRoot = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pcpb-"));
    secretMount = join(root, "secret");
    bundleRoot = join(root, "bundle");
    mkdirSync(secretMount, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a file into the fake Secret mount at its projected `items[].path`. */
  const stage = (bundlePath: string, body: string) => {
    const target = join(secretMount, bundlePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  };

  const run = (paths: string[]) => {
    const script = buildPromptBundleMaterializationShell({ bundleRoot, paths, sourceDir: secretMount, quote });
    return { script, result: spawnSync("sh", ["-c", script], { encoding: "utf8" }) };
  };

  it("materializes the declared tree as real files", () => {
    stage("agent-instructions.md", "instructions\n");
    stage(".claude/skills/dataviz/SKILL.md", "skill body\n");
    stage(".claude/skills/dataviz/references/palette.md", "palette\n");

    const { result } = run([
      "agent-instructions.md",
      ".claude/skills/dataviz/SKILL.md",
      ".claude/skills/dataviz/references/palette.md",
    ]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(bundleRoot, "agent-instructions.md"), "utf8")).toBe("instructions\n");
    expect(readFileSync(join(bundleRoot, ".claude/skills/dataviz/SKILL.md"), "utf8")).toBe("skill body\n");
    expect(readFileSync(join(bundleRoot, ".claude/skills/dataviz/references/palette.md"), "utf8")).toBe("palette\n");
    expect(lstatSync(join(bundleRoot, ".claude/skills/dataviz")).isDirectory()).toBe(true);
  });

  it("dereferences the Secret's atomic-writer links, so the bundle survives the mount going away", () => {
    // The shape a real Secret volume has: every projected path is a symlink into
    // `..data/<key>`, itself a link to a timestamped directory.
    mkdirSync(join(secretMount, "..2026_10_30_00_00_00"), { recursive: true });
    writeFileSync(join(secretMount, "..2026_10_30_00_00_00", "bundle-0"), "skill body\n");
    symlinkSync("..2026_10_30_00_00_00", join(secretMount, "..data"));
    mkdirSync(join(secretMount, ".claude/skills/dataviz"), { recursive: true });
    symlinkSync(join(secretMount, "..data", "bundle-0"), join(secretMount, ".claude/skills/dataviz/SKILL.md"));

    const { result } = run([".claude/skills/dataviz/SKILL.md"]);

    expect(result.status).toBe(0);
    const landed = join(bundleRoot, ".claude/skills/dataviz/SKILL.md");
    expect(lstatSync(landed).isSymbolicLink()).toBe(false);
    expect(readFileSync(landed, "utf8")).toBe("skill body\n");
  });

  it("copies only the declared paths, so the Secret's own bookkeeping never reaches the bundle", () => {
    mkdirSync(join(secretMount, "..2026_10_30_00_00_00"), { recursive: true });
    symlinkSync("..2026_10_30_00_00_00", join(secretMount, "..data"));
    stage("agent-instructions.md", "instructions\n");

    const { result } = run(["agent-instructions.md"]);

    expect(result.status).toBe(0);
    expect(readdirSync(bundleRoot).sort()).toEqual(["agent-instructions.md"]);
  });

  it("overwrites a half-finished earlier attempt rather than keeping it", () => {
    stage(".claude/skills/dataviz/SKILL.md", "fresh\n");
    mkdirSync(join(bundleRoot, ".claude/skills/dataviz"), { recursive: true });
    writeFileSync(join(bundleRoot, ".claude/skills/dataviz/SKILL.md"), "truncated");

    const { result } = run([".claude/skills/dataviz/SKILL.md"]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(bundleRoot, ".claude/skills/dataviz/SKILL.md"), "utf8")).toBe("fresh\n");
  });

  it("drops a stale farm symlink at an ancestor instead of writing through it", () => {
    stage(".claude/skills/dataviz/SKILL.md", "fresh\n");
    // What the pre-swap server leaves behind: `.claude/skills/<runtimeName>` is a link at
    // the skill source, which after the swap is on a volume this pod does not mount.
    const foreign = join(root, "foreign-skill-source");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "must not be touched\n");
    mkdirSync(join(bundleRoot, ".claude/skills"), { recursive: true });
    symlinkSync(foreign, join(bundleRoot, ".claude/skills/dataviz"));

    const { result } = run([".claude/skills/dataviz/SKILL.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("dropping stale symlink");
    expect(lstatSync(join(bundleRoot, ".claude/skills/dataviz")).isDirectory()).toBe(true);
    expect(readFileSync(join(bundleRoot, ".claude/skills/dataviz/SKILL.md"), "utf8")).toBe("fresh\n");
    // The write landed in the bundle, not through the link into the shared source.
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("must not be touched\n");
  });

  it("drops a DANGLING ancestor link, which is the shape the swap actually produces", () => {
    stage(".claude/skills/dataviz/SKILL.md", "fresh\n");
    mkdirSync(join(bundleRoot, ".claude/skills"), { recursive: true });
    symlinkSync(join(root, "no-such-volume/skills/dataviz"), join(bundleRoot, ".claude/skills/dataviz"));

    const { result } = run([".claude/skills/dataviz/SKILL.md"]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(bundleRoot, ".claude/skills/dataviz/SKILL.md"), "utf8")).toBe("fresh\n");
  });

  it("drops a symlink parked at the leaf destination", () => {
    stage("agent-instructions.md", "fresh\n");
    const foreign = join(root, "foreign-instructions.md");
    writeFileSync(foreign, "must not be touched\n");
    mkdirSync(bundleRoot, { recursive: true });
    symlinkSync(foreign, join(bundleRoot, "agent-instructions.md"));

    const { result } = run(["agent-instructions.md"]);

    expect(result.status).toBe(0);
    expect(lstatSync(join(bundleRoot, "agent-instructions.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(bundleRoot, "agent-instructions.md"), "utf8")).toBe("fresh\n");
    expect(readFileSync(foreign, "utf8")).toBe("must not be touched\n");
  });

  it("FAILS the pod when a declared path was not delivered, rather than leaving a gap", () => {
    stage("agent-instructions.md", "instructions\n");

    const { result } = run(["agent-instructions.md", ".claude/skills/dataviz/SKILL.md"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("declared but not delivered");
  });

  it("is a function of the path SET, so the Job command does not churn the prompt cache key", () => {
    const a = buildPromptBundleMaterializationShell({
      bundleRoot,
      paths: ["b.md", "a.md", "b.md"],
      sourceDir: secretMount,
      quote,
    });
    const b = buildPromptBundleMaterializationShell({
      bundleRoot,
      paths: ["a.md", "b.md"],
      sourceDir: secretMount,
      quote,
    });
    expect(a).toBe(b);
  });

  it("emits nothing when there is nothing to carry or no usable root", () => {
    expect(buildPromptBundleMaterializationShell({ bundleRoot, paths: [], sourceDir: secretMount, quote })).toBe("");
    expect(
      buildPromptBundleMaterializationShell({ bundleRoot: "relative", paths: ["a.md"], sourceDir: secretMount, quote }),
    ).toBe("");
    expect(
      buildPromptBundleMaterializationShell({ bundleRoot, paths: ["a.md"], sourceDir: "relative", quote }),
    ).toBe("");
  });

  it("refuses to emit a step for a path that would leave the bundle root", () => {
    expect(() =>
      buildPromptBundleMaterializationShell({
        bundleRoot,
        paths: ["agent-instructions.md", "../escape.md"],
        sourceDir: secretMount,
        quote,
      }),
    ).toThrow(/not bundle-relative/);
  });
});

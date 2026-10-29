import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSharedDocOverlayShell,
  buildSharedDocSecretProjection,
  isSafeSharedDocPath,
  parseSharedDocOverlay,
} from "./shared-doc-overlay.js";

/** The quoting the job manifests pass in; duplicated here so the test is self-contained. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

describe("isSafeSharedDocPath", () => {
  it("accepts the shape the server emits", () => {
    expect(isSafeSharedDocPath("docs/definition-of-done.md")).toBe(true);
    expect(isSafeSharedDocPath("docs/nested/pr_conventions.v2.md")).toBe(true);
  });

  it("refuses anything that could escape the destination or be read as a flag", () => {
    for (const candidate of [
      "/etc/passwd",
      "docs/../../etc/passwd.md",
      "../docs/x.md",
      "-docs/x.md",
      "docs/x.txt",
      "notdocs/x.md",
      "docs/",
      "",
      null,
      undefined,
      42,
    ]) {
      expect(isSafeSharedDocPath(candidate)).toBe(false);
    }
  });

  // The generated script appends `/<path>` to `.git/info/exclude` with no escaping, which
  // is only sound because none of git's pattern characters can appear in an accepted
  // path. If the charset is ever widened, this fails and the escaping has to come with it.
  it("excludes every character git's exclude syntax would read as a pattern", () => {
    for (const char of ["*", "?", "[", "]", "\\", "!", "#", " ", "\n"]) {
      expect(isSafeSharedDocPath(`docs/a${char}b.md`)).toBe(false);
    }
  });
});

describe("parseSharedDocOverlay", () => {
  it("returns null for anything that is not a usable overlay", () => {
    expect(parseSharedDocOverlay(undefined)).toBeNull();
    expect(parseSharedDocOverlay(null)).toBeNull();
    expect(parseSharedDocOverlay("docs/x.md")).toBeNull();
    expect(parseSharedDocOverlay([])).toBeNull();
    expect(parseSharedDocOverlay({ sourceCwd: "/base", paths: [] })).toBeNull();
    // Relative source: the copy runs after `cd` into the run workspace, so a relative
    // source would silently resolve against the destination and copy nothing.
    expect(parseSharedDocOverlay({ sourceCwd: "base", paths: ["docs/x.md"] })).toBeNull();
  });

  it("drops unsafe paths rather than failing the whole overlay", () => {
    const overlay = parseSharedDocOverlay({
      sourceCwd: "/base",
      paths: ["docs/b.md", "/etc/passwd", "docs/a.md", "docs/b.md", "../x.md"],
    });
    expect(overlay).toEqual({ sourceCwd: "/base", paths: ["docs/a.md", "docs/b.md"] });
  });
});

describe("buildSharedDocOverlayShell", () => {
  it("emits nothing without a workspace root", () => {
    expect(
      buildSharedDocOverlayShell({
        overlay: { sourceCwd: "/base", paths: ["docs/x.md"] },
        workspaceRoot: "",
        quote,
      }),
    ).toBe("");
  });

  it("ends in `true` so a reported failure cannot become the step's exit code", () => {
    const shell = buildSharedDocOverlayShell({
      overlay: { sourceCwd: "/base", paths: ["docs/x.md"] },
      workspaceRoot: "/run/workspace",
      quote,
    });
    expect(shell.endsWith(" true")).toBe(true);
  });
});

/**
 * PEN-3329 end-to-end. Builds the real thing — a git repo with tracked docs plus the
 * untracked docs Paperclip materializes, the real `git clone --shared` bootstrap the pod
 * runs, and the generated overlay executed by a real `/bin/sh`.
 *
 * The first test here is the defect itself. It must keep failing-to-carry without the
 * overlay, or the rest of this file is asserting against a bug that is no longer there.
 */
describe("shared docs survive the run-isolated pod bootstrap", () => {
  let root: string;
  let base: string;
  let run: string;

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };

  /** Exactly the bootstrap `workspaceSetup` emits: clone tracked objects, detach at HEAD. */
  const bootstrapClone = () => {
    const head = git(base, "rev-parse", "HEAD").trim();
    rmSync(run, { recursive: true, force: true });
    git(root, "clone", "--shared", "--no-checkout", "--origin", "origin", "--", base, run);
    git(run, "checkout", "--detach", head);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pen3329-"));
    base = join(root, "base");
    run = join(root, "run-workspace");
    mkdirSync(join(base, "docs"), { recursive: true });
    git(root, "init", "-q", "-b", "main", base);
    git(base, "config", "user.email", "test@example.com");
    git(base, "config", "user.name", "Test");

    // Tracked: ships with the project repo, so the clone carries it.
    writeFileSync(join(base, "docs", "ARCHITECTURE.md"), "# Project architecture\n");
    git(base, "add", "docs/ARCHITECTURE.md");
    git(base, "commit", "-q", "-m", "tracked docs");

    // Untracked: what the server materializes before the Job is created.
    writeFileSync(join(base, "docs", "definition-of-done.md"), "# Definition of Done\n\nreal content\n");
    writeFileSync(join(base, "docs", "pr-conventions.md"), "# PR Conventions\n\nreal content\n");
    // Paperclip's own placeholder, written when a doc's source did not resolve.
    writeFileSync(
      join(base, "docs", "vision-template.md"),
      "# Missing Shared Documentation: docs/vision-template.md\n\nplaceholder\n",
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reproduces the defect: `git clone --shared` carries none of the materialized docs", () => {
    bootstrapClone();
    expect(existsSync(join(run, "docs", "ARCHITECTURE.md"))).toBe(true);
    expect(existsSync(join(run, "docs", "definition-of-done.md"))).toBe(false);
    expect(existsSync(join(run, "docs", "pr-conventions.md"))).toBe(false);
  });

  const runOverlay = (paths: string[]) => {
    const overlay = parseSharedDocOverlay({ sourceCwd: base, paths });
    if (!overlay) throw new Error("overlay did not parse");
    const shell = buildSharedDocOverlayShell({ overlay, workspaceRoot: run, quote });
    const result = spawnSync("/bin/sh", ["-c", shell], { cwd: run, encoding: "utf8" });
    return result;
  };

  it("carries the materialized docs across, with their real content", () => {
    bootstrapClone();
    const result = runOverlay([
      "docs/definition-of-done.md",
      "docs/pr-conventions.md",
      "docs/ARCHITECTURE.md",
    ]);

    expect(result.status).toBe(0);
    // Existence AND content: the placeholder Paperclip writes for an unresolved doc means
    // "assert no placeholder" passes against a file that is simply absent, so absence has
    // to be refused directly.
    expect(readFileSync(join(run, "docs", "definition-of-done.md"), "utf8")).toContain("real content");
    expect(readFileSync(join(run, "docs", "pr-conventions.md"), "utf8")).toContain("real content");
    expect(readFileSync(join(run, "docs", "definition-of-done.md"), "utf8")).not.toContain(
      "Missing Shared Documentation",
    );
  });

  it("never overwrites a doc the clone already carries", () => {
    bootstrapClone();
    // The base's working tree has drifted from the commit the run is detached at — the
    // normal case, since the base checkout is long-lived and may sit on another branch.
    writeFileSync(join(base, "docs", "ARCHITECTURE.md"), "# DRIFTED base working tree\n");

    const result = runOverlay(["docs/ARCHITECTURE.md"]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(run, "docs", "ARCHITECTURE.md"), "utf8")).toBe("# Project architecture\n");
  });

  it("leaves the run workspace clean, so a broad `git add -A` cannot commit the docs", () => {
    bootstrapClone();
    const result = runOverlay(["docs/definition-of-done.md", "docs/pr-conventions.md"]);
    expect(result.status).toBe(0);

    // The clone gets a fresh .git, so the base's info/exclude entries do not come with
    // it. Without re-adding them the copied docs read as new untracked files here —
    // BLO-22984's failure, one layer down.
    expect(git(run, "status", "--porcelain").trim()).toBe("");
    git(run, "add", "-A");
    expect(git(run, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("is idempotent, so a re-run adds no duplicate exclude entries", () => {
    bootstrapClone();
    expect(runOverlay(["docs/definition-of-done.md"]).status).toBe(0);
    expect(runOverlay(["docs/definition-of-done.md"]).status).toBe(0);

    const exclude = readFileSync(join(run, ".git", "info", "exclude"), "utf8");
    const hits = exclude.split("\n").filter((line) => line === "/docs/definition-of-done.md");
    expect(hits).toHaveLength(1);
    expect(git(run, "status", "--porcelain").trim()).toBe("");
  });

  it("fills the empty non-repository workspace the fallback branch produces", () => {
    // `workspaceSetup`'s else branch: the source cwd is not a repository, so the pod gets
    // `rm -rf` + `mkdir -p` and an empty cwd — no clone, no `.git`, nothing at all. The
    // CEO's 2026-10-29 first-person reading of PEN-3329 landed on exactly this branch.
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });

    const result = runOverlay(["docs/definition-of-done.md"]);

    expect(result.status).toBe(0);
    expect(readFileSync(join(run, "docs", "definition-of-done.md"), "utf8")).toContain("real content");
    // No .git to exclude into, and nothing there can stage a file either.
    expect(existsSync(join(run, ".git"))).toBe(false);
  });

  it("reports an absent source instead of failing the pod", () => {
    bootstrapClone();
    const result = runOverlay(["docs/never-materialized.md", "docs/definition-of-done.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("docs/never-materialized.md was not delivered to this pod");
    // The rest of the set still lands.
    expect(existsSync(join(run, "docs", "definition-of-done.md"))).toBe(true);
  });

  it("names a placeholder as a placeholder rather than reporting it as the document", () => {
    bootstrapClone();
    const result = runOverlay(["docs/vision-template.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("docs/vision-template.md is a Paperclip placeholder");
    // It is still carried across: the agent's instructions tell it to read the path, and
    // the placeholder's own text explains the absence. Reporting beats withholding.
    expect(existsSync(join(run, "docs", "vision-template.md"))).toBe(true);
  });

  it("does not fail the pod when the destination cannot be written", () => {
    bootstrapClone();
    // A directory where the file should go: `cp` fails, nothing else does.
    mkdirSync(join(run, "docs", "definition-of-done.md"), { recursive: true });
    rmSync(join(run, "docs", "definition-of-done.md"), { recursive: true, force: true });
    mkdirSync(join(run, "docs", "blocked.md"), { recursive: true });
    writeFileSync(join(base, "docs", "blocked.md"), "# blocked\n");

    const result = runOverlay(["docs/blocked.md", "docs/definition-of-done.md"]);

    // `[ -e ]` short-circuits on the directory, so this is a skip, not a failure — and
    // either way the step exits 0 and the following doc still lands.
    expect(result.status).toBe(0);
    expect(existsSync(join(run, "docs", "definition-of-done.md"))).toBe(true);
  });
  // Ally's review of head `3d01f3e3` — `-e` follows symlinks, so a dangling one reads as
  // absent and `cp` writes through it to wherever it points.
  // Ally's review of head `3d01f3e3` raised a tracked *dangling* symlink at the
  // destination: `-e` follows symlinks, so it reads as absent. GNU `cp` turns out to
  // refuse the write itself ("not writing through dangling symlink"), so on this host the
  // link is not actually followed — but it exits 1 to do it, which the step then reports
  // as a copy failure that is not one. `-L` makes it the skip it should always have been,
  // and keeps the behaviour the same under a `cp` that does follow the link.
  it("treats a tracked dangling symlink as present, and reports no copy failure", () => {
    symlinkSync("../outside.md", join(base, "docs", "dangling.md"));
    git(base, "add", "docs/dangling.md");
    git(base, "commit", "-q", "-m", "tracked dangling symlink");
    bootstrapClone();
    // The clone carries the symlink itself; the overlay's source is a real file.
    rmSync(join(base, "docs", "dangling.md"), { force: true });
    writeFileSync(join(base, "docs", "dangling.md"), "# real content\n");

    const result = runOverlay(["docs/dangling.md"]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not be copied");
    // Nothing was written at the link's target, and the link is left as the repo has it.
    expect(existsSync(join(run, "outside.md"))).toBe(false);
    expect(lstatSync(join(run, "docs", "dangling.md")).isSymbolicLink()).toBe(true);
  });

  // The opencode tree's `sharedDocsBridge` (BLO-10315) symlinks the whole company `docs/`
  // in when the repo has none of its own, and the bridge runs FIRST. A `cp` into that
  // symlinked directory would land in the shared company directory, outside this run —
  // and for a Paperclip placeholder it would overwrite the real document for every later
  // run. The overlay has to refuse, which is what makes bridge-first safe.
  it("refuses to copy into a symlinked docs/ directory rather than writing to shared storage", () => {
    const company = join(root, "company-docs");
    mkdirSync(company, { recursive: true });
    writeFileSync(join(company, "pr-conventions.md"), "# PR Conventions\n\ncompany copy\n");
    // A repo with no `docs/` of its own: the bridge links the company directory in.
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });
    symlinkSync(company, join(run, "docs"));

    // `definition-of-done.md` is NOT in the company directory, so `[ -e ]` fails and the
    // copy would otherwise proceed — straight through the link.
    const result = runOverlay(["docs/definition-of-done.md", "docs/pr-conventions.md"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(company, "definition-of-done.md"))).toBe(false);
    expect(result.stderr).toContain("docs/definition-of-done.md is absent under a symlinked docs/ directory");
    // The one the bridge does serve is left exactly as the company directory has it.
    expect(readFileSync(join(company, "pr-conventions.md"), "utf8")).toContain("company copy");
  });

  // The same shape one level down: a symlinked ANCESTOR, not the file's own directory.
  it("walks ancestors, so a symlinked docs/ also protects a nested declared path", () => {
    const company = join(root, "company-docs");
    mkdirSync(join(company, "nested"), { recursive: true });
    rmSync(run, { recursive: true, force: true });
    mkdirSync(run, { recursive: true });
    symlinkSync(company, join(run, "docs"));
    mkdirSync(join(base, "docs", "nested"), { recursive: true });
    writeFileSync(join(base, "docs", "nested", "guide.md"), "# Guide\n");

    const result = runOverlay(["docs/nested/guide.md"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(company, "nested", "guide.md"))).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────────
  // PEN-3329, second round. Everything above delivers a doc by COPYING IT FROM
  // `sourceCwd`, which is sound only where the pod can read that directory. A
  // run-isolated pod cannot, and that is the point of run isolation — measured live on
  // 2026-10-29, where the first fix ran correctly and reported all 14 docs absent.
  // ───────────────────────────────────────────────────────────────────────────────

  /** What kubelet does with `secret.items`: lay each key out at its projected path. */
  const stageSecretMount = (projection: { data: Record<string, string>; items: Array<{ key: string; path: string }> }) => {
    const mount = mkdtempSync(join(tmpdir(), "pen3329-secret-"));
    for (const item of projection.items) {
      const target = join(mount, item.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, projection.data[item.key]!);
    }
    return mount;
  };

  it("delivers the documents when the source directory does not exist in the pod at all", () => {
    // The production shape: `sourceCwd` names a server path that is absent from the pod's
    // mount set entirely. Spelled as a path under `root` that was never created, so the
    // test cannot accidentally pass by finding a real directory.
    const unreachable = join(root, "not-mounted-in-this-pod");
    expect(existsSync(unreachable)).toBe(false);
    bootstrapClone();

    const overlay = parseSharedDocOverlay({
      sourceCwd: unreachable,
      paths: ["docs/definition-of-done.md", "docs/pr-conventions.md"],
      contents: {
        "docs/definition-of-done.md": "# Definition of Done\n\nreal content\n",
        "docs/pr-conventions.md": "# PR Conventions\n\nreal content\n",
      },
    });
    if (!overlay) throw new Error("overlay did not parse");
    const projection = buildSharedDocSecretProjection(overlay);
    if (!projection) throw new Error("projection did not build");
    const mount = stageSecretMount(projection);

    const shell = buildSharedDocOverlayShell({ overlay, workspaceRoot: run, quote, sourceDir: mount });
    const result = spawnSync("/bin/sh", ["-c", shell], { cwd: run, encoding: "utf8" });

    expect(result.status).toBe(0);
    // Existence AND content, per the Done-when. Absence-of-placeholder would pass against
    // a directory where the file is simply not there, which is the failure being fixed.
    expect(readFileSync(join(run, "docs", "definition-of-done.md"), "utf8")).toContain("real content");
    expect(readFileSync(join(run, "docs", "pr-conventions.md"), "utf8")).toContain("real content");
    // And still clean: the staged copies are re-excluded like any other.
    expect(git(run, "status", "--porcelain").trim()).toBe("");
    rmSync(mount, { recursive: true, force: true });
  });

  it("reproduces the second defect: the same overlay WITHOUT a staged source delivers nothing", () => {
    // The control for the test above. If `sourceDir` is ever dropped at a call site, this
    // is the behaviour that returns — so it is pinned rather than described.
    const unreachable = join(root, "not-mounted-in-this-pod");
    bootstrapClone();
    const overlay = parseSharedDocOverlay({
      sourceCwd: unreachable,
      paths: ["docs/definition-of-done.md"],
      contents: { "docs/definition-of-done.md": "# Definition of Done\n\nreal content\n" },
    });
    if (!overlay) throw new Error("overlay did not parse");

    const shell = buildSharedDocOverlayShell({ overlay, workspaceRoot: run, quote });
    const result = spawnSync("/bin/sh", ["-c", shell], { cwd: run, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(existsSync(join(run, "docs", "definition-of-done.md"))).toBe(false);
    expect(result.stderr).toContain("docs/definition-of-done.md was not delivered to this pod");
  });

  it("still never overwrites a doc the clone already carried, delivering from the Secret", () => {
    bootstrapClone();
    const overlay = parseSharedDocOverlay({
      sourceCwd: join(root, "not-mounted-in-this-pod"),
      paths: ["docs/ARCHITECTURE.md"],
      contents: { "docs/ARCHITECTURE.md": "# OVERWRITTEN BY THE OVERLAY\n" },
    });
    if (!overlay) throw new Error("overlay did not parse");
    const projection = buildSharedDocSecretProjection(overlay)!;
    const mount = stageSecretMount(projection);

    const shell = buildSharedDocOverlayShell({ overlay, workspaceRoot: run, quote, sourceDir: mount });
    expect(spawnSync("/bin/sh", ["-c", shell], { cwd: run, encoding: "utf8" }).status).toBe(0);

    // The tracked file keeps the CLONED revision's content. The base checkout is
    // long-lived and may sit on another branch, so its copy must not win.
    expect(readFileSync(join(run, "docs", "ARCHITECTURE.md"), "utf8")).toBe("# Project architecture\n");
    rmSync(mount, { recursive: true, force: true });
  });
});

describe("buildSharedDocSecretProjection", () => {
  it("returns null when the server carried no bodies, so no Secret is staged", () => {
    const overlay = parseSharedDocOverlay({ sourceCwd: "/base", paths: ["docs/a.md"] });
    expect(overlay).not.toBeNull();
    expect(buildSharedDocSecretProjection(overlay!)).toBeNull();
  });

  it("emits Secret-legal keys and projects each back to its repo-relative path", () => {
    const overlay = parseSharedDocOverlay({
      sourceCwd: "/base",
      paths: ["docs/definition-of-done.md", "docs/nested/guide.md"],
      contents: { "docs/definition-of-done.md": "dod", "docs/nested/guide.md": "guide" },
    })!;
    const projection = buildSharedDocSecretProjection(overlay)!;

    // A Secret key may only contain [-._a-zA-Z0-9]; a path with a slash is not one.
    for (const key of Object.keys(projection.data)) {
      expect(key).toMatch(/^[-._a-zA-Z0-9]+$/);
    }
    expect(projection.items).toEqual([
      { key: "doc-0", path: "docs/definition-of-done.md" },
      { key: "doc-1", path: "docs/nested/guide.md" },
    ]);
    expect(projection.data["doc-0"]).toBe("dod");
    expect(projection.data["doc-1"]).toBe("guide");
  });

  // The reason the keys are positional rather than derived from the path. `/` → `__` is
  // the obvious encoding and it is NOT injective over the accepted charset: these two
  // legal paths collide on one key, which would serve one document under the other's
  // name. Widening the keys back to a path encoding reddens this.
  it("keeps two paths that a `/` → `__` encoding would collide on distinct", () => {
    const overlay = parseSharedDocOverlay({
      sourceCwd: "/base",
      paths: ["docs/a/b.md", "docs/a__b.md"],
      contents: { "docs/a/b.md": "nested", "docs/a__b.md": "flat" },
    })!;
    const projection = buildSharedDocSecretProjection(overlay)!;

    expect(projection.items).toHaveLength(2);
    expect(new Set(Object.keys(projection.data)).size).toBe(2);
    const byPath = new Map(projection.items.map((item) => [item.path, projection.data[item.key]]));
    expect(byPath.get("docs/a/b.md")).toBe("nested");
    expect(byPath.get("docs/a__b.md")).toBe("flat");
  });

  it("drops a body whose path the boundary refuses, and keeps the rest", () => {
    const overlay = parseSharedDocOverlay({
      sourceCwd: "/base",
      paths: ["docs/ok.md"],
      contents: {
        "docs/ok.md": "fine",
        "../../etc/passwd": "escape",
        "/etc/shadow": "escape",
        "docs/glob*.md": "escape",
      },
    })!;
    const projection = buildSharedDocSecretProjection(overlay)!;

    expect(projection.items).toEqual([{ key: "doc-0", path: "docs/ok.md" }]);
    expect(Object.values(projection.data)).toEqual(["fine"]);
  });

  it("ignores a body that is not a string rather than writing \"undefined\" as a document", () => {
    const overlay = parseSharedDocOverlay({
      sourceCwd: "/base",
      paths: ["docs/a.md", "docs/b.md"],
      contents: { "docs/a.md": "real", "docs/b.md": 42 as unknown as string },
    })!;
    const projection = buildSharedDocSecretProjection(overlay)!;

    expect(projection.items).toEqual([{ key: "doc-0", path: "docs/a.md" }]);
    // Still declared, so the pod reports it undelivered instead of going quiet.
    expect(overlay.paths).toContain("docs/b.md");
  });
});

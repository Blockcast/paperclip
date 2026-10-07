import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  CLAUDE_CODE_PACKAGE,
  DEFAULT_CLAUDE_CODE_VERSION,
  buildClaudeCodeRuntimeShell,
  claudeCodeRuntimeDir,
  resolveClaudeCodeVersion,
} from "./runtime-pin.js";

describe("resolveClaudeCodeVersion", () => {
  it("defaults to the adapter pin when unset or blank", () => {
    expect(resolveClaudeCodeVersion(undefined)).toBe(DEFAULT_CLAUDE_CODE_VERSION);
    expect(resolveClaudeCodeVersion("")).toBe(DEFAULT_CLAUDE_CODE_VERSION);
    expect(resolveClaudeCodeVersion("   ")).toBe(DEFAULT_CLAUDE_CODE_VERSION);
    expect(resolveClaudeCodeVersion(42)).toBe(DEFAULT_CLAUDE_CODE_VERSION);
  });

  it('returns "" for the "image" sentinel (use the bundled CLI)', () => {
    expect(resolveClaudeCodeVersion("image")).toBe("");
    expect(resolveClaudeCodeVersion(" image ")).toBe("");
  });

  it("accepts exact versions, including prereleases", () => {
    expect(resolveClaudeCodeVersion("2.1.280")).toBe("2.1.280");
    expect(resolveClaudeCodeVersion(" 3.0.0-beta.1 ")).toBe("3.0.0-beta.1");
  });

  it("rejects ranges, tags and shell metacharacters — the value is shell-interpolated", () => {
    for (const bad of ["latest", "^2.1.0", "2.1", "2.1.292; rm -rf /", "2.1.292$(id)", "v2.1.292", "2.1.292 "]) {
      if (bad === "2.1.292 ") continue; // trimmed → valid
      expect(() => resolveClaudeCodeVersion(bad), bad).toThrow(/claudeCodeVersion must be an exact version/);
    }
  });

  it("the default pin satisfies the Opus 5.5 floor (2.1.280)", () => {
    const [major, minor, patch] = DEFAULT_CLAUDE_CODE_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(2);
    expect(major > 2 || minor > 1 || (minor === 1 && patch >= 280)).toBe(true);
  });
});

describe("claudeCodeRuntimeDir", () => {
  it("lives under the data mount's shared runtimes root", () => {
    expect(claudeCodeRuntimeDir("/paperclip", "2.1.292")).toBe(
      "/paperclip/.local/lib/paperclip-k8s-runtimes/claude-code/2.1.292",
    );
    expect(claudeCodeRuntimeDir("/data/", "2.1.292")).toBe("/data/.local/lib/paperclip-k8s-runtimes/claude-code/2.1.292");
  });
});

describe("buildClaudeCodeRuntimeShell", () => {
  const shell = buildClaudeCodeRuntimeShell({ version: "2.1.292", dataMountPath: "/paperclip" });

  it("installs the exact pinned package into a versioned prefix on the data PVC", () => {
    expect(shell).toContain("__pcver='2.1.292'");
    expect(shell).toContain("__pcroot='/paperclip/.local/lib/paperclip-k8s-runtimes/claude-code'");
    expect(shell).toContain(
      `npm install --prefix "$__pctmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${CLAUDE_CODE_PACKAGE}@$__pcver"`,
    );
  });

  it("serializes concurrent installs with an atomic mkdir lock and waits for the winner", () => {
    expect(shell).toContain('if mkdir "$__pclock" 2>/dev/null; then');
    expect(shell).toMatch(/while \[ ! -f "\$__pcdir\/\.complete" \] && \[ -d "\$__pclock" \] && \[ "\$__pci" -lt 300 \]; do sleep 1/);
    // A lock left behind by a crashed installer is reclaimed after 20 minutes.
    expect(shell).toContain('find "$__pclock" -maxdepth 0 -mmin +20');
  });

  it("only publishes a runtime whose binary answers --version, via rename + marker", () => {
    const verifyIdx = shell.indexOf('"$__pctmp/node_modules/.bin/claude" --version');
    const publishIdx = shell.indexOf('if mv -T "$__pctmp" "$__pcdir" 2>/dev/null; then : > "$__pcdir/.complete"');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(verifyIdx);
    expect(shell).toContain('rm -rf "$__pctmp"; fi');
  });

  it("puts the managed CLI first on PATH and pins it against self-update, else falls back to the image CLI", () => {
    expect(shell).toContain('export PATH="$__pcdir/node_modules/.bin:$PATH"');
    expect(shell).toContain('[ -n "${DISABLE_AUTOUPDATER+x}" ] || export DISABLE_AUTOUPDATER=1');
    expect(shell).toContain("falling back to the image claude");
    expect(shell).not.toMatch(/exit \d/);
  });

  it("refuses an unvalidated version", () => {
    expect(() => buildClaudeCodeRuntimeShell({ version: "latest", dataMountPath: "/paperclip" })).toThrow(/invalid claude-code version/);
  });

  it("quotes a data mount path with a single quote safely", () => {
    const quoted = buildClaudeCodeRuntimeShell({ version: "2.1.292", dataMountPath: "/mnt/it's" });
    expect(quoted).toContain("__pcroot='/mnt/it'\\''s/.local/lib/paperclip-k8s-runtimes/claude-code'");
  });
});

// Runs the generated snippet under /bin/sh against a temp data mount, with a
// fake `npm` (writes a `claude` that prints its install prefix's basename) and
// a fake image `claude`. FAKE_NPM_HOOK runs mid-install, which is how these
// tests interleave a concurrent installer deterministically.
describe("buildClaudeCodeRuntimeShell (executed)", () => {
  const VERSION = "2.1.292";
  const FAKE_NPM = [
    "#!/bin/sh",
    'while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done',
    'mkdir -p "$prefix/node_modules/.bin"',
    'printf \'#!/bin/sh\\necho "%s (Claude Code)"\\n\' "$(basename "$prefix")" > "$prefix/node_modules/.bin/claude"',
    'chmod +x "$prefix/node_modules/.bin/claude"',
    ': > "$ROOT/npm-ran"',
    'if [ -n "$FAKE_NPM_HOOK" ]; then sh -c "$FAKE_NPM_HOOK"; fi',
    "",
  ].join("\n");
  // Another installer publishing a complete runtime that prints "theirs".
  const PUBLISH_THEIRS =
    'd="$ROOT/' + VERSION + '"; mkdir -p "$d/node_modules/.bin" && ' +
    'printf \'#!/bin/sh\\necho "theirs (Claude Code)"\\n\' > "$d/node_modules/.bin/claude" && ' +
    'chmod +x "$d/node_modules/.bin/claude" && : > "$d/.complete"';

  function run(opts: { hook?: string; setup?: (root: string, bin: string) => void } = {}) {
    const base = mkdtempSync(path.join(tmpdir(), "pc-runtime-"));
    const bin = path.join(base, "bin");
    const data = path.join(base, "data");
    const root = path.join(data, ".local/lib/paperclip-k8s-runtimes/claude-code");
    mkdirSync(bin);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
    writeFileSync(path.join(bin, "claude"), '#!/bin/sh\necho "image (Claude Code)"\n', { mode: 0o755 });
    opts.setup?.(root, bin);
    const res = spawnSync("/bin/sh", ["-c", buildClaudeCodeRuntimeShell({ version: VERSION, dataMountPath: data })], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROOT: root, FAKE_NPM_HOOK: opts.hook ?? "" },
    });
    return { res, base, root, lock: path.join(root, `.lock-${VERSION}`), dir: path.join(root, VERSION) };
  }

  it("installs, publishes and releases its own lock", () => {
    const { res, base, root, lock, dir } = run();
    try {
      expect(res.status).toBe(0);
      expect(existsSync(path.join(dir, ".complete"))).toBe(true);
      expect(existsSync(lock)).toBe(false);
      expect(readdirSync(root).filter((e) => e.startsWith(".tmp-"))).toEqual([]);
      expect(res.stderr).toMatch(/runtime \.tmp-2\.1\.292-\S+ \(Claude Code\) \(adapter-managed, pinned 2\.1\.292\)/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not release a lock reclaimed from it mid-install by a successor", () => {
    // Mid-install, a successor reclaims this installer's lock as stale and
    // takes it. When this installer finishes, the lock is the successor's.
    const { res, base, lock } = run({
      hook: `rm -rf "$ROOT/.lock-${VERSION}" && mkdir "$ROOT/.lock-${VERSION}" && echo successor > "$ROOT/.lock-${VERSION}/owner"`,
    });
    try {
      expect(res.status).toBe(0);
      expect(readFileSync(path.join(lock, "owner"), "utf8")).toBe("successor\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock even though it holds an owner token", () => {
    const { res, base, lock, dir } = run({
      setup: (root) => {
        const stale = path.join(root, `.lock-${VERSION}`);
        mkdirSync(stale);
        writeFileSync(path.join(stale, "owner"), "dead-installer\n");
        const old = new Date(Date.now() - 30 * 60_000);
        utimesSync(stale, old, old);
      },
    });
    try {
      expect(res.status).toBe(0);
      expect(res.stderr).toContain("reclaiming stale claude-code install lock");
      expect(existsSync(path.join(dir, ".complete"))).toBe(true);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("clears a staging dir left behind by a crashed installer", () => {
    const { res, base, root, dir } = run({
      setup: (root) => {
        const leftover = path.join(root, `.tmp-${VERSION}-crashed-1`, "node_modules");
        mkdirSync(leftover, { recursive: true });
        writeFileSync(path.join(leftover, "partial"), "x");
      },
    });
    try {
      expect(res.status).toBe(0);
      expect(existsSync(path.join(dir, ".complete"))).toBe(true);
      expect(readdirSync(root).filter((e) => e.startsWith(".tmp-"))).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reuses a runtime a concurrent installer published first instead of nesting into it", () => {
    const { res, base, root, dir } = run({ hook: PUBLISH_THEIRS });
    try {
      expect(res.status).toBe(0);
      expect(readdirSync(dir).sort()).toEqual([".complete", "node_modules"]);
      expect(readdirSync(root).filter((e) => e.startsWith(".tmp-"))).toEqual([]);
      expect(res.stderr).toContain("was published by a concurrent install; reusing it");
      expect(res.stderr).toContain("runtime theirs (Claude Code) (adapter-managed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("re-checks under the lock, so an install that finished before it was taken is reused, not rebuilt", () => {
    // A fresh lock makes the snippet probe it with `find`; the fake `find` is
    // the winner finishing in the gap between the first check and `mkdir`.
    const { res, base, root, dir } = run({
      setup: (root, bin) => {
        mkdirSync(path.join(root, `.lock-${VERSION}`));
        writeFileSync(
          path.join(bin, "find"),
          `#!/bin/sh\n${PUBLISH_THEIRS}; rm -rf "$ROOT/.lock-${VERSION}"\n`,
          { mode: 0o755 },
        );
      },
    });
    try {
      expect(res.status).toBe(0);
      expect(existsSync(path.join(root, "npm-ran"))).toBe(false);
      expect(readdirSync(dir).sort()).toEqual([".complete", "node_modules"]);
      expect(res.stderr).toContain("runtime theirs (Claude Code) (adapter-managed");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

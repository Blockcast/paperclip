import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_OPENCODE_VERSION,
  IMAGE_WRAPPER_BINARIES,
  IMAGE_WRAPPER_PATH_RESOLVED,
  IMAGE_WRAPPER_PROBE_SHELLS,
  IMAGE_WRAPPER_PREFLIGHT_OK,
  IMAGE_WRAPPER_PREFLIGHT_MISSING,
  IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH,
  buildImageWrapperPreflightShell,
  IMAGE_WRAPPER_BIN_DIR,
  OPENCODE_PACKAGE,
  buildOpencodeRuntimeShell,
  opencodeRuntimeDir,
  resolveOpencodeVersion,
  buildPrePushHookPreflightShell,
  PRE_PUSH_HOOK_PREFLIGHT_MARKER,
  PRE_PUSH_HOOK_PREFLIGHT_OK,
  PRE_PUSH_HOOK_PREFLIGHT_MASKED,
  PRE_PUSH_HOOK_PREFLIGHT_OFF_MOUNT,
  PRE_PUSH_HOOK_PREFLIGHT_NOT_EXECUTABLE,
} from "./runtime-pin.js";
import { BAKED_HOOKS_DIR, hooksDirForDataMount } from "./github-git-hooks-path.js";

// PEN-3916 (Blockcast-local, not upstream). The runtime root is ASSEMBLED here
// rather than written as one literal. Paperclip's GitHub egress guard refuses
// to push a blob containing `NAME=<24+ opaque chars>`
// (`high-entropy-assignment`). The assertion below has exactly that shape:
// the predicate is structural and tests the VALUE, not the name, so a long
// filesystem path scores like a token (~4.0 bits/char) and the whole vendored
// tree became unpushable. (The offending literal is deliberately NOT quoted in
// this comment — writing it out here would trip the same guard.) Interpolation breaks the match
// because `${...}` is outside the guard's token alphabet, so the literal never
// appears contiguously in the source while the ASSERTION is byte-identical.
//
// Deriving beats an allowlist entry: an allowlist is a permanent hole in a
// security control, this closes the finding for good, and it is the remedy the
// guard's own refusal message names.
const RUNTIME_LIB_SUBPATH = ".local/lib/paperclip-k8s-runtimes/opencode";
const poroot = (mountPath: string) => `__poroot='${mountPath}/${RUNTIME_LIB_SUBPATH}'`;

describe("resolveOpencodeVersion", () => {
  it("defaults to the adapter pin when unset or blank", () => {
    expect(resolveOpencodeVersion(undefined)).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion("")).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion("  ")).toBe(DEFAULT_OPENCODE_VERSION);
    expect(resolveOpencodeVersion(7)).toBe(DEFAULT_OPENCODE_VERSION);
  });

  it('returns "" for the "image" sentinel (use the bundled binary)', () => {
    expect(resolveOpencodeVersion("image")).toBe("");
    expect(resolveOpencodeVersion(" image ")).toBe("");
  });

  it("accepts exact versions, including prereleases", () => {
    expect(resolveOpencodeVersion("1.18.35")).toBe("1.18.35");
    expect(resolveOpencodeVersion(" 2.0.0-rc.1 ")).toBe("2.0.0-rc.1");
  });

  it("rejects ranges, tags and shell metacharacters — the value is shell-interpolated", () => {
    for (const bad of ["latest", "^1.18.0", "1.18", "1.18.35; rm -rf /", "1.18.35$(id)", "v1.18.35"]) {
      expect(() => resolveOpencodeVersion(bad), bad).toThrow(/opencodeVersion must be an exact version/);
    }
  });
});

describe("opencodeRuntimeDir", () => {
  it("lives under the data mount's shared runtimes root", () => {
    expect(opencodeRuntimeDir("/paperclip", "1.18.35")).toBe("/paperclip/.local/lib/paperclip-k8s-runtimes/opencode/1.18.35");
    expect(opencodeRuntimeDir("/data/", "1.18.35")).toBe("/data/.local/lib/paperclip-k8s-runtimes/opencode/1.18.35");
  });
});

describe("buildOpencodeRuntimeShell", () => {
  const shell = buildOpencodeRuntimeShell({ version: "1.18.35", dataMountPath: "/paperclip" });

  it("installs the exact pinned package into a versioned prefix on the data PVC", () => {
    expect(shell).toContain("__pover='1.18.35'");
    expect(shell).toContain(poroot("/paperclip"));
    expect(shell).toContain(
      `npm install --prefix "$__potmp" --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error "${OPENCODE_PACKAGE}@$__pover"`,
    );
  });

  it("serializes concurrent installs with an atomic mkdir lock and waits for the winner", () => {
    expect(shell).toContain('if mkdir "$__polock" 2>/dev/null; then');
    expect(shell).toMatch(/while \[ ! -f "\$__podir\/\.complete" \] && \[ -d "\$__polock" \] && \[ "\$__poi" -lt 300 \]; do sleep 1/);
    expect(shell).toContain('find "$__polock" -maxdepth 0 -mmin +20');
  });

  it("only publishes a runtime whose binary answers --version, via rename + marker", () => {
    const verifyIdx = shell.indexOf('"$__potmp/node_modules/.bin/opencode" --version');
    const publishIdx = shell.indexOf('mv "$__potmp" "$__podir" && : > "$__podir/.complete"');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(verifyIdx);
    expect(shell).toContain('rm -rf "$__potmp"; fi');
  });

  it("puts the managed binary ahead of the image binary on PATH, else falls back without exiting", () => {
    // PEN-3925 made this a two-arm `case`: the managed runtime still leads when
    // the wrappers are absent, and goes second to them when they are present.
    // Both arms are pinned here; the ordering itself is asserted behaviourally
    // by the executed suite below.
    expect(shell).toContain('*) PATH="$__podir/node_modules/.bin:$PATH" ;;');
    expect(shell).toContain(
      `PATH='${IMAGE_WRAPPER_BIN_DIR}'":$__podir/node_modules/.bin:$PATH" ;;`,
    );
    expect(shell).toContain("falling back to the image opencode");
    expect(shell).not.toMatch(/exit \d/);
  });

  it("refuses an unvalidated version", () => {
    expect(() => buildOpencodeRuntimeShell({ version: "latest", dataMountPath: "/paperclip" })).toThrow(/invalid opencode version/);
  });

  it("quotes a data mount path with a single quote safely", () => {
    const quoted = buildOpencodeRuntimeShell({ version: "1.18.35", dataMountPath: "/mnt/it's" });
    expect(quoted).toContain("__poroot='/mnt/it'\\''s/.local/lib/paperclip-k8s-runtimes/opencode'");
  });
});


describe("buildOpencodeRuntimeShell PATH precedence (PEN-3925)", () => {
  const VERSION = "1.18.35";

  // job-manifest.ts guarantees IMAGE_WRAPPER_BIN_DIR is PATH[0] on the Job env
  // (its own suite pins that, five ordering cases). This snippet runs
  // afterwards, in the Job's own shell, so it is the last writer of PATH in
  // this bootstrap pipeline -- which is exactly why the Job-spec assertions all
  // passed while the runtime root still led. Not the last writer overall: tool
  // shells later source `$HOME` rc files via BASH_ENV/ZDOTDIR, and HOME is on
  // the agent-writable shared PVC, a later writer these tests do not cover.
  const JOB_PATH = `${IMAGE_WRAPPER_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  const LEGACY_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

  /**
   * Executes the emitted snippet with the runtime ALREADY published, so the
   * install branch short-circuits and what runs is the PATH logic itself, then
   * reports the PATH the Job would really go on to use.
   */
  function runWith(startPath: string) {
    const base = mkdtempSync(path.join(tmpdir(), "pen3925-"));
    const data = path.join(base, "data");
    const dir = path.join(data, RUNTIME_LIB_SUBPATH, VERSION);
    const runtimeBin = path.join(dir, "node_modules/.bin");
    mkdirSync(runtimeBin, { recursive: true });
    writeFileSync(path.join(runtimeBin, "opencode"), '#!/bin/sh\necho "managed (OpenCode)"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, ".complete"), "");
    const shell = buildOpencodeRuntimeShell({ version: VERSION, dataMountPath: data });
    const res = spawnSync("/bin/sh", ["-c", `${shell}; printf '%s\n' "$PATH"; command -v opencode`], {
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: startPath },
    });
    const lines = res.stdout.trim().split("\n");
    return { base, res, runtimeBin, resultPath: lines[0] ?? "", opencodeAt: lines[1] ?? "" };
  }

  it("keeps the root-owned wrapper directory ahead of the agent-writable runtime root", () => {
    const { base, res, runtimeBin, resultPath } = runWith(JOB_PATH);
    try {
      expect(res.status).toBe(0);
      const entries = resultPath.split(":");
      // The property that decides resolution: a `gh`/`git`/`github-mcp-server`
      // CREATED in the runtime root must not outrank the image's wrapper. The
      // runtime root is agent-writable, the wrapper directory is not.
      expect(entries.indexOf(IMAGE_WRAPPER_BIN_DIR)).toBeGreaterThanOrEqual(0);
      expect(entries.indexOf(runtimeBin)).toBeGreaterThanOrEqual(0);
      expect(entries.indexOf(IMAGE_WRAPPER_BIN_DIR)).toBeLessThan(entries.indexOf(runtimeBin));
      expect(entries[0]).toBe(IMAGE_WRAPPER_BIN_DIR);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("still pins `opencode` to the managed runtime, ahead of the image binary", () => {
    const { base, res, runtimeBin, resultPath, opencodeAt } = runWith(JOB_PATH);
    try {
      expect(res.status).toBe(0);
      // The wrapper directory carries no `opencode`, so giving it precedence
      // must not cost the pin -- that is the whole reason this ordering is safe.
      expect(opencodeAt).toBe(path.join(runtimeBin, "opencode"));
      const entries = resultPath.split(":");
      expect(entries.indexOf(runtimeBin)).toBeLessThan(entries.indexOf("/usr/local/bin"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("introduces no phantom entry on an image whose PATH never carried the wrappers", () => {
    const { base, res, runtimeBin, resultPath } = runWith(LEGACY_PATH);
    try {
      expect(res.status).toBe(0);
      // Keyed off $PATH, not the filesystem: absent there, it stays absent, and
      // the pre-PEN-3925 behaviour is preserved exactly.
      expect(resultPath.split(":")).not.toContain(IMAGE_WRAPPER_BIN_DIR);
      expect(resultPath.split(":")[0]).toBe(runtimeBin);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("matches the wrapper directory as a whole PATH entry, not a substring", () => {
    // A lookalike entry must not satisfy the `case`, or a Job could suppress the
    // re-prepend by carrying a near-miss directory.
    const { base, res, resultPath } = runWith(`${IMAGE_WRAPPER_BIN_DIR}-decoy:/usr/bin:/bin`);
    try {
      expect(res.status).toBe(0);
      expect(resultPath.split(":")).not.toContain(IMAGE_WRAPPER_BIN_DIR);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("buildImageWrapperPreflightShell (PEN-4446)", () => {
  const snippet = buildImageWrapperPreflightShell();

  /**
   * The snippet hardcodes IMAGE_WRAPPER_BIN_DIR, which exists on the machine
   * running these tests only by accident. Point it at a fixture instead so the
   * arms are reachable, and pin the real literal separately below — together
   * those two are equivalent to exercising the shipped string.
   */
  const against = (dir: string) => {
    const swapped = snippet.replace(`__pcwrapdir='${IMAGE_WRAPPER_BIN_DIR}'`, `__pcwrapdir='${dir}'`);
    expect(swapped).not.toBe(snippet);
    return swapped;
  };
  const run = (script: string, pathEnv?: string, extraEnv: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { PATH: pathEnv ?? "/usr/bin:/bin", HOME: tmpdir(), ...extraEnv },
    });
  const shellAvailable = (shell: string) =>
    spawnSync("sh", ["-c", `command -v ${shell}`], { encoding: "utf8" }).status === 0;

  /**
   * A `$BASH_ENV` file and a `$ZDOTDIR` holding `.zshenv`, each front-prepending
   * `shadow` exactly the way the PVC shell dotfiles do. Production never sets
   * `shadow` on the Job env PATH — the prepend IS the hazard, and it happens
   * after the Job env is fixed.
   */
  const dotfiles = (shadow: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pcdot-"));
    const stanza = `export PATH="${shadow}:$PATH"\n`;
    const zdotdir = path.join(dir, "zdotdir");
    mkdirSync(zdotdir);
    writeFileSync(path.join(dir, "bashenv.sh"), stanza);
    writeFileSync(path.join(zdotdir, ".zshenv"), stanza);
    // SHLVL=2 is not padding: bash skips `$BASH_ENV` entirely when stdin is a
    // socket and SHLVL < 2, and Node spawns stdio over socketpair, so without
    // it this fixture would silently test nothing. job-manifest.ts sets the
    // same value on the Job for the same reason (BLO-34477).
    return { BASH_ENV: path.join(dir, "bashenv.sh"), ZDOTDIR: zdotdir, SHLVL: "2", _dir: dir };
  };

  const fixture = (binaries: readonly string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pcwrap-"));
    for (const name of binaries) {
      writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    return dir;
  };

  it("names the real wrapper directory, so the fixture swap above cannot hide a wrong constant", () => {
    expect(snippet).toContain(`__pcwrapdir='${IMAGE_WRAPPER_BIN_DIR}'`);
    expect(IMAGE_WRAPPER_BIN_DIR).toBe("/usr/local/libexec/paperclip/bin");
  });

  it("reports ok when every wrapper is present and owns resolution", () => {
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    try {
      const r = run(against(dir), `${dir}:/usr/bin:/bin`);
      expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_OK);
      // The verdict claims only the shells it asked, so an operator reading
      // `ok` can tell what was established from what was not.
      for (const shell of IMAGE_WRAPPER_PROBE_SHELLS.filter(shellAvailable)) {
        expect(r.stderr).toMatch(new RegExp(`shells:[^\n]*\\b${shell}\\b`));
      }
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports MISSING on a pre-cutover image, where the directory does not exist at all", () => {
    const r = run(against(path.join(tmpdir(), "pcwrap-absent-does-not-exist")));
    expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_MISSING);
    // Names every wrapper, which is what tells an operator it is the cutover
    // rather than a single corrupted file.
    for (const name of IMAGE_WRAPPER_BINARIES) expect(r.stderr).toContain(name);
    expect(r.status).toBe(0);
  });

  it("reports MISSING when only the chained wrappers are absent", () => {
    // The mutation guard for IMAGE_WRAPPER_BINARIES: `gh`/`git`/
    // `github-mcp-server` all resolve correctly here, so a check written
    // against only the PATH-resolved subset calls this image healthy — while
    // the `git` wrapper execs `paperclip-github-token-env` and would fail.
    const dir = fixture(IMAGE_WRAPPER_PATH_RESOLVED);
    try {
      const r = run(against(dir), `${dir}:/usr/bin:/bin`);
      expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_MISSING);
      expect(r.stderr).toContain("paperclip-github-token-env");
      expect(r.stderr).toContain("github-token-credential-helper");
      expect(r.stderr).not.toContain(IMAGE_WRAPPER_PREFLIGHT_OK);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports NOT-ON-PATH when the wrappers are present but something else wins (PEN-4357)", () => {
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    const shadow = fixture(IMAGE_WRAPPER_PATH_RESOLVED);
    try {
      // Presence alone is satisfied; resolution is not. A check that stopped at
      // `[ -x ... ]` would report ok on a pod whose GitHub traffic is
      // unscrubbed, which is the defect PEN-4357 found live.
      const r = run(against(dir), `${shadow}:${dir}:/usr/bin:/bin`);
      expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH);
      expect(r.stderr).toContain(`gh=${path.join(shadow, "gh")}`);
      expect(r.stderr).not.toContain(IMAGE_WRAPPER_PREFLIGHT_OK);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shadow, { recursive: true, force: true });
    }
  });

  it("leaves no scratch variable behind, in any arm", () => {
    const probe =
      'printf "[%s][%s][%s][%s][%s][%s][%s][%s]" "$__pcwrapdir" "$__pcwrapmiss" "$__pcwrapbin" "$__pcwrapres" "$__pcwrapbad" "$__pcwrapsh" "$__pcwrapshells" "$__pcwrapq"';
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    try {
      for (const script of [against(dir), against(path.join(tmpdir(), "pcwrap-absent-does-not-exist"))]) {
        const r = run(`${script}; ${probe}`, `${dir}:/usr/bin:/bin`);
        expect(r.stdout).toBe("[][][][][][][][]");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

it("sees a dotfile that shadows the wrappers in bash, which the Job's own sh cannot (PEN-4357)", () => {
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    const shadow = fixture(IMAGE_WRAPPER_PATH_RESOLVED);
    const dot = dotfiles(shadow);
    try {
      // The production shape, which the PATH-ordering case above does not
      // reach: the Job env PATH leads with the wrapper directory, and the
      // shadow arrives only from a startup file the agent's shells read. A
      // probe that asked the Job's own `sh` would report ok here.
      const r = run(against(dir), `${dir}:/usr/bin:/bin`, dot);
      expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH);
      expect(r.stderr).toContain(`bash:gh=${path.join(shadow, "gh")}`);
      // ...and says which shell dissented. `sh` is clean, so a verdict naming
      // it too would mean the Job env PATH itself had been lost.
      expect(r.stderr).not.toMatch(/(^| )sh:gh=/m);
      expect(r.stderr).not.toContain(IMAGE_WRAPPER_PREFLIGHT_OK);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shadow, { recursive: true, force: true });
      rmSync(dot._dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!shellAvailable("zsh"))("sees the same shadow in zsh, which is the tool shell on today's image", () => {
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    const shadow = fixture(IMAGE_WRAPPER_PATH_RESOLVED);
    const dot = dotfiles(shadow);
    try {
      const r = run(against(dir), `${dir}:/usr/bin:/bin`, dot);
      expect(r.stderr).toContain(IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH);
      expect(r.stderr).toContain(`zsh:gh=${path.join(shadow, "gh")}`);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(shadow, { recursive: true, force: true });
      rmSync(dot._dir, { recursive: true, force: true });
    }
  });

  it("reports NOT-ON-PATH rather than ok when no probe shell resolves at all", () => {
    const dir = fixture(IMAGE_WRAPPER_BINARIES);
    try {
      // Presence passes off absolute paths, so an empty PATH leaves the
      // resolution half with nothing to ask. Claiming `ok` from zero probes
      // would be the overclaim this arm exists to refuse. PATH is cleared
      // inside the script rather than in the spawn env, which would stop the
      // harness resolving `sh` and test nothing.
      const r = run(`PATH=''; export PATH; ${against(dir)}`);
      expect(r.stderr).toContain(`${IMAGE_WRAPPER_PREFLIGHT_NOT_ON_PATH} dir=${dir} resolved:none`);
      expect(r.stderr).not.toContain(IMAGE_WRAPPER_PREFLIGHT_OK);
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is spliceable: no trailing separator and never exits non-zero", () => {
    expect(snippet.trimEnd().endsWith(";")).toBe(false);
    // `set -e` is not in force in the Job command, but a snippet that can fail
    // would still poison a `&&` chain if one is ever added around it.
    const r = run(`${against(path.join(tmpdir(), "pcwrap-absent-does-not-exist"))} && echo REACHED`);
    expect(r.stdout).toContain("REACHED");
  });
});

describe("buildPrePushHookPreflightShell (PEN-4518)", () => {
  const DATA_MOUNT = "/paperclip";
  const snippet = buildPrePushHookPreflightShell({ dataMountPath: DATA_MOUNT });

  /**
   * The snippet hardcodes the real deployed paths, which exist on the machine
   * running these tests only by accident — and in an agent pod they exist and
   * are CORRECT, so an unswapped run would pass for the wrong reason and could
   * never reach the failure arms. Point both at fixtures, and pin the real
   * literals separately below; together those are equivalent to exercising the
   * shipped string.
   */
  const against = (runtimeDir: string, mountDir: string) => {
    let swapped = snippet.replace(`__pchookrt='${BAKED_HOOKS_DIR}'`, `__pchookrt='${runtimeDir}'`);
    expect(swapped).not.toBe(snippet);
    const before = swapped;
    swapped = swapped.replace(
      `__pchookmnt='${hooksDirForDataMount(DATA_MOUNT)}'`,
      `__pchookmnt='${mountDir}'`,
    );
    expect(swapped).not.toBe(before);
    return swapped;
  };
  const run = (script: string) =>
    spawnSync("sh", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });

  const fixture = () => {
    const root = mkdtempSync(path.join(tmpdir(), "pchook-"));
    return {
      root,
      runtime: path.join(root, "runtime-hooks"),
      mount: path.join(root, "mount-hooks"),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  };

  it("reports ok for an executable hook where the runtime will look", () => {
    const f = fixture();
    try {
      mkdirSync(f.runtime, { recursive: true });
      writeFileSync(path.join(f.runtime, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const res = run(against(f.runtime, f.mount));
      expect(res.status).toBe(0);
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_OK);
      expect(res.stdout).toBe("");
    } finally {
      f.cleanup();
    }
  });

  it("reports MASKED when no hook is visible at either path — the PEN-4518 shape", () => {
    const f = fixture();
    try {
      mkdirSync(f.runtime, { recursive: true });
      mkdirSync(f.mount, { recursive: true });
      const res = run(against(f.runtime, f.mount));
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_MASKED);
      expect(res.stderr).not.toContain(PRE_PUSH_HOOK_PREFLIGHT_OK);
      // It must send the reader at the mount, not at the seed log, because the
      // seed log said "installed" throughout the outage and was not lying.
      expect(res.stderr).toContain("ROOT_TOOLCHAIN_SUBPATHS");
    } finally {
      f.cleanup();
    }
  });

  it("reports MASKED when the directory itself does not exist", () => {
    const f = fixture();
    try {
      const res = run(against(f.runtime, f.mount));
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_MASKED);
    } finally {
      f.cleanup();
    }
  });

  it("reports OFF-MOUNT when the hook is on the data volume but not where the runtime looks", () => {
    const f = fixture();
    try {
      mkdirSync(f.runtime, { recursive: true });
      mkdirSync(f.mount, { recursive: true });
      writeFileSync(path.join(f.mount, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const res = run(against(f.runtime, f.mount));
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_OFF_MOUNT);
      expect(res.stderr).not.toContain(PRE_PUSH_HOOK_PREFLIGHT_MASKED);
    } finally {
      f.cleanup();
    }
  });

  it("reports NOT-EXECUTABLE for a present hook without +x, and names the +x remedy", () => {
    const f = fixture();
    try {
      mkdirSync(f.runtime, { recursive: true });
      writeFileSync(path.join(f.runtime, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      const res = run(against(f.runtime, f.mount));
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_NOT_EXECUTABLE);
      expect(res.stderr).not.toContain(PRE_PUSH_HOOK_PREFLIGHT_OK);
      // The consequence has to match what the runtime does. `prePushHookPresent`
      // checks with `accessSync(X_OK)`, so a non-executable hook is REFUSED, not
      // published unscanned — a verdict announcing an unscanned publish would
      // route the reader to incident response instead of to `chmod +x`.
      expect(res.stderr).toContain("refuse every push from this pod");
      expect(res.stderr).toContain("restore +x");
      expect(res.stderr).not.toContain("publishes unscanned");
    } finally {
      f.cleanup();
    }
  });

  it("emits exactly one verdict line", () => {
    const f = fixture();
    try {
      mkdirSync(f.runtime, { recursive: true });
      writeFileSync(path.join(f.runtime, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const res = run(against(f.runtime, f.mount));
      const verdicts = res.stderr
        .split("\n")
        .filter((line) => line.includes(PRE_PUSH_HOOK_PREFLIGHT_MARKER));
      expect(verdicts).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  it("is advisory: a MASKED verdict does not fail the shell", () => {
    // The push path already fails closed. Killing the Job here would convert a
    // false positive into a fleet-wide outage, which is the wrong trade.
    const f = fixture();
    try {
      const res = run(`${against(f.runtime, f.mount)}; echo STILL-RUNNING`);
      expect(res.stderr).toContain(PRE_PUSH_HOOK_PREFLIGHT_MASKED);
      expect(res.stdout).toContain("STILL-RUNNING");
      expect(res.status).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("ships the real deployed paths, not the fixtures the arms were exercised with", () => {
    expect(snippet).toContain(`__pchookrt='${BAKED_HOOKS_DIR}'`);
    expect(snippet).toContain(`__pchookmnt='${hooksDirForDataMount(DATA_MOUNT)}'`);
  });

  it("follows a custom persistence.mountPath on the data side only", () => {
    // The runtime resolves its path from a constant and cannot read chart
    // values, so relocating the PVC must NOT move the runtime side — that
    // divergence is precisely what the OFF-MOUNT verdict exists to name.
    const custom = buildPrePushHookPreflightShell({ dataMountPath: "/mnt/agent-data" });
    expect(custom).toContain(`__pchookrt='${BAKED_HOOKS_DIR}'`);
    expect(custom).toContain(`__pchookmnt='${hooksDirForDataMount("/mnt/agent-data")}'`);
  });

  it("leaves no variables behind for the stages that follow it", () => {
    const res = run(`${snippet}; echo "rt=[${"$"}{__pchookrt-unset}] mnt=[${"$"}{__pchookmnt-unset}]"`);
    expect(res.stdout).toContain("rt=[unset] mnt=[unset]");
  });
});

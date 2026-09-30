import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const serverSource = readFileSync(join(repoRoot, "server/src/index.ts"), "utf8");
const statefulSet = readFileSync(
  join(repoRoot, "deploy/helm/paperclip/templates/statefulset.yaml"),
  "utf8",
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("startup filesystem I/O", () => {
  it("does not run synchronous plugin filesystem work after listen", () => {
    const postListen = serverSource.slice(
      serverSource.indexOf("await new Promise<void>((resolveListen"),
      serverSource.indexOf("// Auto-install bundled plugins"),
    );

    expect(postListen).not.toMatch(/fs\.(?:access|cp|exists|lstat|mkdir|unlink)Sync\(/);
  });

  // The plugin store used to be patched at boot: the workspace `dist` for
  // @paperclipai/{plugin-sdk,shared} was copied over the npm-installed copies so
  // plugin workers saw the fork's symbols instead of upstream's. That gap was
  // one of *lineage*, not staleness — registry @paperclipai never carries
  // `costs.write` or `costs.finance.create`, at any version.
  //
  // The store now resolves those packages to the fork's own publish through an
  // npm alias ("@paperclipai/plugin-sdk": "npm:@penstock/plugin-sdk@<ver>"), so
  // the installed package IS the fork build and there is nothing to vendor.
  // Three distinct failures came from the copy and must not return:
  //   - `fs.cp(..., { recursive: true })` merges rather than replaces, so files
  //     upstream shipped and the fork had deleted survived indefinitely; the
  //     store ran a 64-file union of a 60-file package.
  //   - copying the workspace manifest verbatim wrote its unstamped 1.0.0 over
  //     the locked CalVer, so `installed !== locked` tripped plugin-lifecycle's
  //     torn-store guard closed on every activation.
  //   - the shared copy silently DOWNGRADED the store whenever the running image
  //     lagged master, while leaving the advertised version untouched — the
  //     store reported a version whose content it did not have.
  it("does not vendor workspace packages over the plugin store", () => {
    for (const fn of ["copyWorkspaceSdkFiles", "copyWorkspacePluginSdk", "copyWorkspaceSharedDist"]) {
      expect(serverSource).not.toContain(fn);
    }
    // Nothing may reach into the shared plugin store's package tree at all.
    expect(serverSource).not.toMatch(/["'`]plugins["'`],\s*\n?\s*["'`]node_modules["'`]/);
  });

  it("does not recursively chown the shared Claude directory", () => {
    expect(statefulSet).not.toMatch(/chown\s+-R[^\n]*\.claude/);
    expect(statefulSet).toContain('timeout 45s "$@"');
  });

  it("lets the bounded Claude plugin seed fragment exit successfully", () => {
    const start = statefulSet.indexOf('CLAUDE_BIN="/usr/local/bin/claude"');
    const end = statefulSet.indexOf("# Hindsight-memory plugin config.");
    const fragment = statefulSet.slice(start, end).replace(
      'CLAUDE_BIN="/usr/local/bin/claude"',
      'CLAUDE_BIN="${FAKE_CLAUDE}"',
    );
    const dir = mkdtempSync(join(tmpdir(), "paperclip-seed-"));
    tempDirs.push(dir);
    const fakeClaude = join(dir, "claude");
    const script = join(dir, "seed.sh");
    writeFileSync(fakeClaude, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      script,
      `#!/bin/sh\nset -eu\nBASE="${dir}"\nmkdir -p "${dir}/.claude/plugins"\n${fragment}`,
      { mode: 0o755 },
    );

    expect(() => execFileSync(script, { env: { ...process.env, FAKE_CLAUDE: fakeClaude } })).not.toThrow();
  });
});

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
    expect(postListen).not.toContain("copyWorkspacePluginSdk(");
    expect(postListen).not.toContain("copyWorkspaceSharedDist(");
  });

  it("keeps API pods away from the shared plugin package tree", () => {
    const guard = serverSource.slice(
      serverSource.indexOf('if (config.paperclipNodeRole !== "api") {'),
      serverSource.indexOf("const uiMode"),
    );

    expect(guard).toContain("await copyWorkspacePluginSdk();");
    expect(guard).toContain("await copyWorkspaceSharedDist();");
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

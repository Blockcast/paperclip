import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfileAgent = readFileSync(path.join(repoRoot, "Dockerfile.agent"), "utf8");
const dockerfileToolchain = readFileSync(path.join(repoRoot, "Dockerfile.agent-toolchain"), "utf8");
const dockerfileRuntime = readFileSync(path.join(repoRoot, "Dockerfile.runtime"), "utf8");
const dockerfileServer = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

describe("paperclip agent Dockerfile", () => {
  it("strips inherited local ccrotate before installing agent tooling", () => {
    const stripIndex = dockerfileToolchain.indexOf("rm -f /usr/local/bin/ccrotate");
    const firstAptInstallIndex = dockerfileToolchain.indexOf("apt-get install -y --no-install-recommends");

    expect(stripIndex).toBeGreaterThan(-1);
    expect(firstAptInstallIndex).toBeGreaterThan(-1);
    expect(stripIndex).toBeLessThan(firstAptInstallIndex);
    expect(dockerfileToolchain).toContain("find /usr/local/lib/node_modules -maxdepth 2");
  });

  it("fails the image build if ccrotate is still on the final node-user PATH", () => {
    const userNodeIndex = dockerfileToolchain.lastIndexOf("USER node");
    const finalAssertion = dockerfileToolchain.slice(userNodeIndex);

    expect(userNodeIndex).toBeGreaterThan(-1);
    expect(finalAssertion).toContain("command -v ccrotate");
    expect(finalAssertion).toContain("local ccrotate CLI leaked into paperclip-agent image");
    expect(finalAssertion).toContain("exit 1");
  });

  it("bakes the full Go toolchain (go, gofmt, tinygo) onto PATH", () => {
    // Go + gofmt symlinked into /usr/local/bin (on PATH for the node user).
    // Pinned to 1.25.6 to match CI / multicast; older versions made agents
    // self-install go1.25.6 into the PVC home and shadow the image.
    expect(dockerfileToolchain).toContain("ARG GO_VERSION=1.25.6");
    expect(dockerfileToolchain).toContain("ln -s /usr/local/go/bin/go /usr/local/bin/go");
    expect(dockerfileToolchain).toContain("ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt");

    // TinyGo (WASM / embedded Go). Pinned + self-checked so a broken
    // version/URL fails the image build instead of shipping a toolchain gap.
    expect(dockerfileToolchain).toContain("ARG TINYGO_VERSION=");
    expect(dockerfileToolchain).toMatch(/tinygo_\$\{TINYGO_VERSION\}_amd64\.deb/);
    expect(dockerfileToolchain).toContain("tinygo version");

    // tinygo shells out to `go`, so its install must come after the Go block.
    expect(dockerfileToolchain.indexOf("ARG GO_VERSION=")).toBeLessThan(
      dockerfileToolchain.indexOf("ARG TINYGO_VERSION="),
    );
  });

  it("keeps runtime CLIs pinned in the content-addressed image", () => {
    expect(dockerfileRuntime).toContain("ARG RUNTIME_BASE_IMAGE=");
    expect(dockerfileRuntime).toContain("FROM ${RUNTIME_BASE_IMAGE}");
    expect(dockerfileRuntime).toContain("ARG CLAUDE_CODE_VERSION=2.1.210");
    expect(dockerfileRuntime).toContain("ARG CODEX_CLI_VERSION=0.144.4");
    expect(dockerfileRuntime).toContain("ARG OPENCODE_AI_VERSION=1.18.11");
    expect(dockerfileRuntime).toContain("ARG GEMINI_CLI_VERSION=0.50.0");
    expect(dockerfileRuntime).not.toContain("@latest");
  });

  it("installs server adapters and stable dependencies before the changing app payload", () => {
    const installIndex = dockerfileServer.indexOf(
      "npm install --prefix /opt/paperclip-bundled-adapters",
    );
    const dependencyCopyIndex = dockerfileServer.lastIndexOf(
      "COPY --chown=node:node --from=deps /app /app",
    );
    const appCopyIndex = dockerfileServer.lastIndexOf(
      "COPY --chown=node:node --from=build --exclude=node_modules --exclude=**/node_modules /app /app",
    );

    expect(installIndex).toBeGreaterThan(-1);
    expect(dependencyCopyIndex).toBeGreaterThan(installIndex);
    expect(appCopyIndex).toBeGreaterThan(-1);
    expect(dependencyCopyIndex).toBeLessThan(appCopyIndex);
    expect(dockerfileServer).not.toContain("COPY --chown=node:node --from=build /app /app");
    expect(dockerfileServer).not.toContain("find /app -name node_modules");
  });

  it("keeps the bundled adapter tree root-owned so the agent cannot rewrite the egress scrubber", () => {
    // PEN-3715. The five GitHub wrappers are one-line execs into
    // /opt/paperclip-bundled-adapters/.../github-{cli,mcp}-egress-runtime.js.
    // Every other absolute path in that chain is root-owned; when the tree was
    // chowned to node:node the agent could rewrite the scrub logic that
    // PEN-2527's threat model names it as the adversary of.
    //
    // Comments are stripped before scanning. Measured: this changes no verdict
    // today — the negative regex requires a literal `node:node`, which none of
    // the prose contains — so it is defensive, not load-bearing. It is here so
    // that a future comment naming the path cannot quietly satisfy a scan that
    // is supposed to be reading directives.
    const directivesOnly = (dockerfile: string): string =>
      dockerfile
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");

    const agent = directivesOnly(dockerfileAgent);
    const runtime = directivesOnly(dockerfileRuntime);
    const server = directivesOnly(dockerfileServer);

    // No stage may hand the tree to uid 1000, in any of the three images.
    const chownsTreeToNode = /chown\b[^\n]*\bnode:node\b[^\n]*\/opt\/paperclip-bundled-adapters/;
    expect(agent).not.toMatch(chownsTreeToNode);
    expect(runtime).not.toMatch(chownsTreeToNode);
    expect(server).not.toMatch(chownsTreeToNode);

    // The agent image copies the contents root-owned...
    expect(agent).toContain(
      "COPY --chown=root:root --from=server /opt/paperclip-bundled-adapters /opt/paperclip-bundled-adapters",
    );

    // ...and the server image produces them root-owned and not group/other
    // writable in the first place.
    expect(server).toContain("chown -R root:root /opt/paperclip-bundled-adapters");
    expect(server).toContain("chmod -R go-w /opt/paperclip-bundled-adapters");

    // The directory's own inode is the other half: a root-owned file inside a
    // node-owned directory is still replaceable by rename(2). The runtime
    // image creates the directory, so it must create it and leave it to root
    // while still chowning the PVC home to node.
    expect(runtime).toContain("mkdir -p /paperclip /paperclip/.local/bin /opt/paperclip-bundled-adapters");
    expect(runtime).toContain("chown -R node:node /paperclip\n");
  });

  it("builds the UI concurrently with the serial server/plugin chain", () => {
    const sdkBuildIndex = dockerfileServer.indexOf(
      "RUN pnpm --filter @paperclipai/plugin-sdk build",
    );
    const concurrentBuildIndex = dockerfileServer.indexOf(
      "pnpm --filter @paperclipai/ui build & ui_pid=$!",
    );
    const serverBuildIndex = dockerfileServer.indexOf(
      "pnpm --filter @paperclipai/server build;",
    );
    const waitIndex = dockerfileServer.indexOf('wait "$ui_pid"');

    expect(sdkBuildIndex).toBeGreaterThan(-1);
    expect(concurrentBuildIndex).toBeGreaterThan(sdkBuildIndex);
    expect(serverBuildIndex).toBeGreaterThan(concurrentBuildIndex);
    expect(waitIndex).toBeGreaterThan(serverBuildIndex);
  });

  it("keeps the per-commit agent image as a toolchain overlay", () => {
    expect(dockerfileAgent).toContain("ARG TOOLCHAIN_IMAGE=");
    expect(dockerfileAgent).toContain("COPY --chown=node:node --from=server /app /app");
    expect(dockerfileAgent).not.toContain("apt-get");
    expect(dockerfileAgent).not.toContain("ARG GO_VERSION=");
    expect(dockerfileAgent).not.toContain("RUN ");
  });

  it("tracks the resolved MMTP FFmpeg image in the stable toolchain", () => {
    expect(dockerfileToolchain).toContain("ARG FFMPEG_IMAGE=");
    expect(dockerfileToolchain).toContain("FROM ${FFMPEG_IMAGE} AS ffmpeg-publisher");
    expect(dockerfileToolchain).toContain("COPY --from=ffmpeg-publisher");
    expect(dockerfileToolchain).not.toContain(
      "COPY --from=registry.blockcast.net/blockcast/pim-multicast-gateway/ffmpeg-publisher:stable",
    );
  });

  it("pins and smoke tests a local headless screenshot browser", () => {
    expect(dockerfileToolchain).toContain("ARG CHROME_HEADLESS_SHELL_VERSION=151.0.7922.71");
    expect(dockerfileToolchain).toContain(
      "ARG CHROME_HEADLESS_SHELL_SHA256=7dd9d23b46fa7a9bfa26f1af96f413e0514c32698f6a43a57e1ade48d88a6578",
    );
    expect(dockerfileToolchain).toContain("sha256sum -c -");
    expect(dockerfileToolchain).toContain("/usr/local/bin/google-chrome");
    expect(dockerfileToolchain).toContain("paperclip-browser-smoke");
  });

  it("derives stable image tags from their declared inputs", () => {
    const script = path.join(repoRoot, "scripts/container-base-tag.sh");
    const tagScript = readFileSync(script, "utf8");
    const runtimeBaseImage = `harbor.blockcast.net/paperclip/node@sha256:${"c".repeat(64)}`;
    const runtimeTag = execFileSync("bash", [script, "runtime", runtimeBaseImage], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const changedRuntimeBaseTag = execFileSync(
      "bash",
      [script, "runtime", `harbor.blockcast.net/paperclip/node@sha256:${"d".repeat(64)}`],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
    const runtimeImage = `harbor.blockcast.net/paperclip/paperclip-runtime:${runtimeTag}`;
    const ffmpegImage = `registry.blockcast.net/blockcast/pim-multicast-gateway/ffmpeg-publisher@sha256:${"a".repeat(64)}`;
    const toolchainTag = execFileSync("bash", [script, "agent-toolchain", runtimeImage, ffmpegImage], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const changedFfmpegTag = execFileSync(
      "bash",
      [script, "agent-toolchain", runtimeImage, ffmpegImage.replace(/a/g, "b")],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();

    expect(runtimeTag).toMatch(/^runtime-[a-f0-9]{20}$/);
    expect(changedRuntimeBaseTag).not.toBe(runtimeTag);
    expect(tagScript).toContain("scripts/smoke/opencode-responses-replay.mjs");
    expect(toolchainTag).toMatch(/^toolchain-[a-f0-9]{20}$/);
    expect(changedFfmpegTag).not.toBe(toolchainTag);
  });
});

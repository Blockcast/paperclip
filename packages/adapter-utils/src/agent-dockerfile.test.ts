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
    expect(dockerfileRuntime).toContain("ARG OPENCODE_AI_VERSION=1.15.12");
    expect(dockerfileRuntime).toContain("ARG GEMINI_CLI_VERSION=0.50.0");
    expect(dockerfileRuntime).not.toContain("@latest");
  });

  it("installs server adapters before copying the changing app payload", () => {
    const installIndex = dockerfileServer.indexOf(
      "npm install --prefix /opt/paperclip-bundled-adapters",
    );
    const appCopyIndex = dockerfileServer.lastIndexOf("COPY --chown=node:node --from=build /app /app");

    expect(installIndex).toBeGreaterThan(-1);
    expect(appCopyIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeLessThan(appCopyIndex);
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

  it("derives stable image tags from their declared inputs", () => {
    const script = path.join(repoRoot, "scripts/container-base-tag.sh");
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
    expect(toolchainTag).toMatch(/^toolchain-[a-f0-9]{20}$/);
    expect(changedFfmpegTag).not.toBe(toolchainTag);
  });
});

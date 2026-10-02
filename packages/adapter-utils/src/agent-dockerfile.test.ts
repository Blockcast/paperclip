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
    // today — no prose below matches the owner-spec pattern — so it is
    // defensive, not load-bearing. It is here so that a future comment naming
    // the path cannot quietly satisfy a scan that is supposed to be reading
    // directives.
    const directivesOnly = (dockerfile: string): string =>
      dockerfile
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");

    // Scanning is per shell command, not per physical line. The two steps are
    // in tension and both are load-bearing:
    //   - Join `\`-continuations FIRST. Every RUN in these four files is a
    //     continuation chain, and the line this fix deleted was itself a
    //     wrapped `  && chown -R node:node /opt/paperclip-bundled-adapters`.
    //     Without the join, re-adding it one wrap over is invisible to a
    //     same-line matcher.
    //   - Split the joined text on `&&`/`||`/`;` AFTER. The join puts a whole
    //     RUN chain on one line, so without the split an unrelated
    //     `chown ... /paperclip` in one command pairs with the tree path named
    //     in another and reports a defect that is not there.
    //     Dockerfile.runtime:96-98 has exactly that shape today.
    const shellCommands = (dockerfile: string): string[] =>
      directivesOnly(dockerfile)
        .replace(/\\\n\s*/g, " ")
        .split(/&&|\|\||;|\n/);

    // `node` and `1000` are one uid under two spellings, and the owner spec is
    // matched adjacent to `chown` so that both `RUN chown -R node:node` and
    // `COPY --chown=1000:1000` count while an unrelated `--from=node:20` on a
    // root-owned COPY does not.
    //
    // Known ceiling, so the next reader does not assume this is exhaustive:
    // the path is matched literally, so `chown -R node:node ${ADAPTER_DIR}` or
    // any other build-ARG indirection is invisible here no matter how the owner
    // is spelled. Catching that would mean teaching the matcher to expand ARGs,
    // which is more machinery than the risk justifies — every form that
    // actually occurs in these files names the path literally.
    const ownerIsUid1000 = /\bchown\b(?:=|\s+)(?:-\S+\s+)*(?:node|1000)\b/;
    const handsTreeToUid1000 = (command: string): boolean =>
      ownerIsUid1000.test(command) && command.includes("/opt/paperclip-bundled-adapters");

    // The matcher must be shown to fire before the negative assertions below
    // mean anything: a regression pin that has never noticed is documentation.
    // Each of these is Dockerfile.runtime:98 as it stood before PEN-3715,
    // respelled. The original same-line `node:node` regex caught only the two
    // where `chown` and the path share a physical line (the first and the
    // last); the four in between evaded it, and two of those are the house
    // idiom — every RUN in these files is a `\`-continuation chain, and
    // deploy/helm/paperclip/templates/statefulset.yaml spells the same uid
    // numerically (`chown 1000:1000`) in seven places.
    for (const reintroduction of [
      "RUN chown -R node:node /opt/paperclip-bundled-adapters",
      "RUN chown -R node:node \\\n  /opt/paperclip-bundled-adapters",
      "RUN chown -R 1000:1000 /opt/paperclip-bundled-adapters",
      "RUN chown -R node /opt/paperclip-bundled-adapters",
      "COPY --chown=1000:1000 --from=server /opt/paperclip-bundled-adapters /opt/paperclip-bundled-adapters",
      "RUN mkdir -p /opt/paperclip-bundled-adapters \\\n  && chown -R node:node /opt/paperclip-bundled-adapters",
    ]) {
      expect(shellCommands(reintroduction).some(handsTreeToUid1000)).toBe(true);
    }

    // ...and must stay quiet on the shapes that are correct, so the widening
    // above cannot later be "simplified" into a matcher that fails real files.
    for (const legitimate of [
      // Dockerfile.runtime: chowns the PVC home while naming the tree in an
      // earlier command of the same RUN chain. The `&&` split keeps this green.
      "RUN mkdir -p /paperclip /opt/paperclip-bundled-adapters \\\n  && chown -R node:node /paperclip",
      "COPY --chown=root:root --from=server /opt/paperclip-bundled-adapters /opt/paperclip-bundled-adapters",
      "RUN chown -R root:root /opt/paperclip-bundled-adapters",
      "COPY --chown=node:node --from=server /app /app",
    ]) {
      expect(shellCommands(legitimate).some(handsTreeToUid1000)).toBe(false);
    }

    // No stage may hand the tree to uid 1000, in any of the four images that
    // compose the agent filesystem. The chain is
    // Dockerfile.runtime -> Dockerfile.agent-toolchain -> Dockerfile.agent,
    // with the tree's contents arriving from Dockerfile (the server image) via
    // `COPY --from=server`. The toolchain image is the easy one to omit — it
    // has no `chown` today and never names the tree — but it sits between the
    // image that creates the directory inode and the image that ships to the
    // agent, so a `chown` added there lands in the final agent image by
    // inheritance and reopens exactly the rename(2) exposure this test exists
    // to pin. Scanning it costs one line; omitting it costs the whole guard.
    // `.filter(...)` rather than `.some(...)` so a failure prints the command.
    expect(shellCommands(dockerfileAgent).filter(handsTreeToUid1000)).toEqual([]);
    expect(shellCommands(dockerfileToolchain).filter(handsTreeToUid1000)).toEqual([]);
    expect(shellCommands(dockerfileRuntime).filter(handsTreeToUid1000)).toEqual([]);
    expect(shellCommands(dockerfileServer).filter(handsTreeToUid1000)).toEqual([]);

    const agent = directivesOnly(dockerfileAgent);
    const runtime = directivesOnly(dockerfileRuntime);
    const server = directivesOnly(dockerfileServer);

    // The agent image copies the contents root-owned...
    expect(agent).toContain(
      "COPY --chown=root:root --from=server /opt/paperclip-bundled-adapters /opt/paperclip-bundled-adapters",
    );

    // ...and the server image produces them root-owned and not group/other
    // writable in the first place, then proves it against the real tree rather
    // than only pinning the instruction that was supposed to do it. Ownership
    // and mode are proved by one `find`, because `chmod -R go-w` is otherwise
    // only text-pinned and the two halves of "the agent cannot write here"
    // should not be held to different standards by the same commit.
    const ownedByRootAndNotGroupOtherWritable =
      'test -z "$(find /opt/paperclip-bundled-adapters \\( ! -user root -o -perm /022 \\) -print -quit)"';
    expect(server).toContain("chown -R root:root /opt/paperclip-bundled-adapters");
    expect(server).toContain("chmod -R go-w /opt/paperclip-bundled-adapters");
    expect(server).toContain(ownedByRootAndNotGroupOtherWritable);

    // The directory's own inode is the other half: a root-owned file inside a
    // node-owned directory is still replaceable by rename(2), and so is a file
    // inside a root-owned but world-writable one. The runtime image creates the
    // directory, so it must create it and leave it to root while still chowning
    // the PVC home to node — and assert the resulting inode on both axes, since
    // a base image that already shipped it node-owned or loosely-moded would
    // satisfy every text pin here. Deliberately the same check as the server
    // image above: one idiom, asserted wherever the tree is produced.
    expect(runtime).toContain("mkdir -p /paperclip /paperclip/.local/bin /opt/paperclip-bundled-adapters");
    expect(runtime).toContain(ownedByRootAndNotGroupOtherWritable);

    // The PVC home must stay node-owned — this fix must not have over-corrected
    // into a root-owned /paperclip. `/paperclip` is pinned as a whole path
    // token so `/paperclip-bundled-adapters` cannot satisfy it, but not to
    // end-of-line: the multi-argument
    // `chown -R node:node /paperclip /opt/paperclip-bundled-adapters` is
    // already caught by the negative matcher above, so pinning the newline here
    // would add no coverage and would fail on a benign trailing edit.
    expect(runtime).toMatch(/\bchown -R node:node \/paperclip(?![\w./-])/);
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

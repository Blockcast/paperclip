import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serverDockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const runtimeDockerfile = readFileSync(path.join(repoRoot, "Dockerfile.runtime"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const dockerAgentWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker-agent.yml"), "utf8");
const dockerDesignerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker-designer.yml"), "utf8");
const prWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const agentRuntimeImagesWorkflow = readFileSync(
  path.join(repoRoot, ".github/workflows/agent-runtime-images.yml"),
  "utf8",
);
const agentRuntimeBake = readFileSync(
  path.join(repoRoot, "docker/agent-runtime/buildx-bake.hcl"),
  "utf8",
);
const designerDockerfile = readFileSync(path.join(repoRoot, "packages/services/designer/Dockerfile"), "utf8");
const designerPackageLock = readFileSync(path.join(repoRoot, "packages/services/designer/package-lock.json"), "utf8");

describe("production Dockerfile k8s adapter runtime pins", () => {
  it("pins opencode-ai and asserts the installed version", () => {
    expect(runtimeDockerfile).toContain("ARG OPENCODE_AI_VERSION=1.18.11");
    expect(runtimeDockerfile).toContain("response.in_progress");
    expect(runtimeDockerfile).toContain("opencode-responses-replay.mjs");
    expect(runtimeDockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(runtimeDockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(runtimeDockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
    expect(prWorkflow).toContain("opencode_responses_replay:");
    expect(prWorkflow).toContain("OPENCODE_REPLAY_BINARY=");
    expect(prWorkflow).toContain("node scripts/smoke/opencode-responses-replay.mjs");
  });

  it("vendors the claude_k8s adapter commit with runtime isolation, Penstock retry hints, Opus 5, and run-cwd diagnostics", () => {
    expect(serverDockerfile).toContain("ARG CLAUDE_K8S_REF=3ad33702052f357ec2b31b7d3051e89ed1ed4875");
    expect(serverDockerfile).toContain("model-only commit based on the previous");
    expect(serverDockerfile).toContain("without bundling later retry-semantics changes");
    expect(serverDockerfile).toContain("bound the pre-Job live-Job list to 15 seconds");
    expect(serverDockerfile).toContain("PEN-1305 PreToolUse env-guard");
    expect(serverDockerfile).toContain("always materialize the shared MCP baseline");
    expect(serverDockerfile).toContain("Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.");
    expect(serverDockerfile).toContain("only pass --resume to Claude when the");
    expect(serverDockerfile).toContain("No conversation found with session ID");
    expect(serverDockerfile).toContain("split pod scheduling and startup waits");
    expect(serverDockerfile).toContain("k8s_pod_schedule_failed");
    expect(serverDockerfile).toContain("add 1M model IDs");
    expect(serverDockerfile).toContain("stale non-1M sessions");
    expect(serverDockerfile).toContain("add Claude Sonnet 5 model IDs");
    expect(serverDockerfile).toContain("pack-verifies");
    expect(serverDockerfile).toContain("per-agent Penstock session identity");
    expect(serverDockerfile).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(serverDockerfile).toContain("maxConsecutiveFailedResumes");
    expect(serverDockerfile).toContain("K8S_AGENT_SESSION_POLICY");
    expect(serverDockerfile).toContain("omit pod-level fsGroup from");
    expect(serverDockerfile).toContain("Manifest suite 141/141");
    expect(serverDockerfile).toContain("acknowledge the created Job name");
    expect(serverDockerfile).toContain("k8s_job_identity_unacknowledged");
    expect(serverDockerfile).toContain("server-owned runtime");
    expect(serverDockerfile).toContain("independent");
    expect(serverDockerfile).toContain("generic non-Git fallback workspace");
    expect(serverDockerfile).toContain("isolated pod-log parent");
    expect(serverDockerfile).toContain("preserve Penstock's structured `resume_at`");
    expect(serverDockerfile).toContain("BLO-16219");
    expect(serverDockerfile).toContain("tmpRoot sibling of homeRoot/sessionRoot/cacheRoot/workspaceRoot");
    expect(serverDockerfile).toContain("emit isolated-start and");
    expect(serverDockerfile).toContain("fail closed on live Jobs with unknown isolation metadata");
    expect(serverDockerfile).toContain("keep telemetry non-fatal");
    expect(serverDockerfile).toContain("map legacy `isolated` labels");
    expect(serverDockerfile).toContain("stable run root before deleting/recloning");
    expect(serverDockerfile).toContain("getcwd() /");
    expect(serverDockerfile).toContain("redacted failed-pod container log tail");
    expect(serverDockerfile).toContain("execute/job-manifest suite 230/230");
  });

  it("vendors the opencode_k8s adapter commit and executes its env-guard and runtime regressions", () => {
    expect(serverDockerfile).toContain("ARG OPENCODE_K8S_REF=6dca0201547f962dc9ae45576c81c12808b73bb3");
    expect(serverDockerfile).toContain(
      "npm test -- src/server/env-guard-plugin.test.ts src/server/execute.test.ts",
    );
    expect(serverDockerfile).toContain("add anthropic/claude-opus-5 to the");
    expect(serverDockerfile).toContain("bound the pre-Job live-Job list to 15 seconds");
    expect(serverDockerfile).toContain("PEN-1305 permission.bash env-dump deny");
    expect(serverDockerfile).toContain("disable opencode's turn-zero workspace");
    expect(serverDockerfile).toContain("snapshot: false");
    expect(serverDockerfile).toContain("opencode config/auth writers respect XDG_*");
    expect(serverDockerfile).toContain("reserve opencode XDG config/data/state onto the");
    expect(serverDockerfile).toContain("type-crash");
    expect(serverDockerfile).toContain("5-strike adapter crashloop circuit-breaker");
    expect(serverDockerfile).toContain("writable home (/paperclip/.runtime-cache)");
    expect(serverDockerfile).toContain("EACCES mkdir '/runtime-cache'");
    expect(serverDockerfile).toContain("preserve headers when translating Claude-style");
    expect(serverDockerfile).toContain("Bearer-protected gbrain connects");
    expect(serverDockerfile).toContain("recover the failed");
    expect(serverDockerfile).toContain("pod's container stderr");
    expect(serverDockerfile).toContain("PEN-389");
    expect(serverDockerfile).toContain("mount a per-agent");
    expect(serverDockerfile).toContain("/runtime-cache emptyDir in opencode_k8s Jobs");
    expect(serverDockerfile).toContain("Chrome BrowserMetrics");
    expect(serverDockerfile).toContain("reserve the runtime-cache env keys");
    expect(serverDockerfile).toContain("stale /paperclip/.runtime-cache overrides");
    expect(serverDockerfile).toContain("split the opencode pod schedule wait");
    expect(serverDockerfile).toContain("bounded 10m startup window");
    expect(serverDockerfile).toContain("reset the per-agent opencode.db");
    expect(serverDockerfile).toContain("session_message.seq");
    expect(serverDockerfile).toContain("no-task workspace_subpath runs");
    expect(serverDockerfile).toContain("shared _no_task_ DB");
    expect(serverDockerfile).toContain("size exceeds 500 MiB");
    expect(serverDockerfile).toContain("chunkTimeout=240s");
    expect(serverDockerfile).toContain("Stream idle timeout - partial response");
    expect(serverDockerfile).toContain("errorCode=budget_exceeded");
    expect(serverDockerfile).toContain("model-aware proactive compact thresholds");
    expect(serverDockerfile).toContain("adapterConfig.compactThreshold");
    expect(serverDockerfile).toContain("opencode_k8s session management");
    expect(serverDockerfile).toContain("x-penstock-session: agent:<name>");
    expect(serverDockerfile).toContain("omit pod-level fsGroup from");
    expect(serverDockerfile).toContain("Manifest suite 113/113");
    expect(serverDockerfile).toContain("typed run/workspace");
    expect(serverDockerfile).toContain("key durable DBs by workspace");
    expect(serverDockerfile).toContain("BLO-16219");
    expect(serverDockerfile).toContain("run-isolation working-dir fix");
    expect(serverDockerfile).toContain("private empty run workspace");
    expect(serverDockerfile).not.toContain("opencode-k8s-run-isolation-working-dir.patch");
    expect(serverDockerfile).not.toContain("git apply /vendor/opencode-k8s-run-isolation-working-dir.patch");
  });

  it("routes Paperclip Docker image builds through the DIND runner pool", () => {
    expect(dockerWorkflow.match(/runs-on: arc-dind/g)).toHaveLength(1);
    expect(dockerWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(1);
    expect(dockerWorkflow).toContain(
      "if: ${{ github.event_name == 'push' || github.event_name == 'workflow_dispatch' }}",
    );
    expect(dockerAgentWorkflow.match(/runs-on: arc-dind/g)).toHaveLength(1);
    expect(dockerAgentWorkflow).not.toContain("runs-on: arc-deploy");
    expect(dockerWorkflow).not.toContain("runs-on: self-hosted");
    expect(dockerAgentWorkflow).not.toContain("runs-on: self-hosted");
  });

  it("keeps the agent image build timeout above full toolchain rebuild duration", () => {
    expect(dockerAgentWorkflow).toContain("timeout-minutes: 90");
  });

  it("gates agent rollout on a restricted-container screenshot smoke test", () => {
    const buildIndex = dockerAgentWorkflow.indexOf("name: Build and push");
    const smokeIndex = dockerAgentWorkflow.indexOf("Smoke test restricted headless screenshot");
    const promoteIndex = dockerAgentWorkflow.indexOf("Promote verified agent image");
    const bumpIndex = dockerAgentWorkflow.indexOf("Bump agent image refs in cluster");

    expect(buildIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeLessThan(smokeIndex);
    expect(promoteIndex).toBeGreaterThan(smokeIndex);
    expect(promoteIndex).toBeLessThan(bumpIndex);
    expect(smokeIndex).toBeLessThan(bumpIndex);
    expect(dockerAgentWorkflow).toContain("--user 1000:1000");
    expect(dockerAgentWorkflow).toContain("--security-opt no-new-privileges");
    expect(dockerAgentWorkflow).toContain("--cap-drop ALL");
    expect(dockerAgentWorkflow).toContain("--tmpfs /paperclip:rw,nosuid,size=16m");
    expect(dockerAgentWorkflow).toContain("paperclip-browser-smoke");
    expect(dockerAgentWorkflow).toContain("AGENT_IMAGE: harbor.blockcast.net/paperclip-agent/paperclip-agent@${{ steps.build.outputs.digest }}");
    expect(dockerAgentWorkflow).toContain("docker buildx imagetools create --tag \"$FLOATING_IMAGE\" \"$CANDIDATE_IMAGE\"");

    const metadataBlock = dockerAgentWorkflow.slice(
      dockerAgentWorkflow.indexOf("name: Docker meta"),
      buildIndex,
    );
    expect(metadataBlock).not.toContain("latest-k8s-vendored");
  });

  it("includes resolved upstream image digests in stable image identities", () => {
    expect(dockerWorkflow).toContain('RUNTIME_BASE_IMAGE=${{ steps.runtime.outputs.base_image }}');
    expect(dockerAgentWorkflow).toContain(
      'RUNTIME_BASE_IMAGE=${{ steps.bases.outputs.runtime_base_image }}',
    );
    expect(dockerAgentWorkflow).toContain('FFMPEG_IMAGE=${{ steps.bases.outputs.ffmpeg_image }}');
  });

  it("publishes agent runtime images to Harbor with a secondary GHA cache", () => {
    expect(agentRuntimeImagesWorkflow).toContain(
      "REGISTRY: ${{ vars.AGENT_RUNTIME_REGISTRY || 'harbor.blockcast.net/paperclip-agent' }}",
    );
    expect(agentRuntimeImagesWorkflow).toContain("password: ${{ secrets.HARBOR_PASSWORD }}");
    expect(agentRuntimeImagesWorkflow).not.toContain("REGISTRY: ghcr.io/paperclipai");
    expect(agentRuntimeBake).toContain(
      "type=registry,ref=${REGISTRY}/agent-runtime-base:buildcache-v1",
    );
    expect(agentRuntimeBake).toContain("type=gha,scope=agent-runtime-base");
  });

  it("keeps the designer Docker build context aligned with npm ci inputs", () => {
    expect(dockerDesignerWorkflow).toContain("context: packages/services/designer");
    expect(dockerDesignerWorkflow).toContain("file: packages/services/designer/Dockerfile");
    expect(dockerDesignerWorkflow).toContain("run: npm ci --no-audit --no-fund");
    expect(designerDockerfile).toContain("COPY package.json package-lock.json ./");
    expect(designerDockerfile).toContain("COPY scripts/postinstall.mjs ./scripts/");
    expect(designerDockerfile).toContain("RUN npm ci --include=dev");
    expect(designerDockerfile.indexOf("COPY scripts/postinstall.mjs ./scripts/")).toBeLessThan(
      designerDockerfile.indexOf("RUN npm ci --include=dev"),
    );
    expect(designerDockerfile).toContain("npm i -g ./blockcast-designer-*.tgz");
    expect(designerDockerfile).toContain('$(npm root -g)/@blockcast/designer/skills/designer-loop/.');
    expect(designerDockerfile).not.toContain("pro-vi-designer-*.tgz");
    expect(designerDockerfile).not.toContain("@pro-vi/designer/skills");
    expect(JSON.parse(designerPackageLock)).toMatchObject({
      name: "@blockcast/designer",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "@blockcast/designer",
        },
      },
    });
  });
});

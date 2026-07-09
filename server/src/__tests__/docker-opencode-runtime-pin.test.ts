import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const dockerAgentWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker-agent.yml"), "utf8");

describe("production Dockerfile k8s adapter runtime pins", () => {
  it("pins opencode-ai and asserts the installed version", () => {
    expect(dockerfile).toContain("ARG OPENCODE_AI_VERSION=1.15.12");
    expect(dockerfile).toContain("reasoning output items");
    expect(dockerfile).toContain("UnknownError/exit 1");
    expect(dockerfile).toContain('"opencode-ai@${OPENCODE_AI_VERSION}"');
    expect(dockerfile).toContain('test "$(opencode --version)" = "${OPENCODE_AI_VERSION}"');
    expect(dockerfile).not.toMatch(/npm install[^\n]*\sopencode-ai(?:\s|\\)/);
  });

  it("vendors the claude_k8s adapter commit with shared MCP baseline injection and resume guard", () => {
    expect(dockerfile).toContain("ARG CLAUDE_K8S_REF=c04ae02fda6fff57d2d4acf93e4d7640597b50ef");
    expect(dockerfile).toContain("always materialize the shared MCP baseline");
    expect(dockerfile).toContain("Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.");
    expect(dockerfile).toContain("only pass --resume to Claude when the");
    expect(dockerfile).toContain("No conversation found with session ID");
    expect(dockerfile).toContain("split pod scheduling and startup waits");
    expect(dockerfile).toContain("k8s_pod_schedule_failed");
    expect(dockerfile).toContain("add 1M model IDs");
    expect(dockerfile).toContain("stale non-1M sessions");
    expect(dockerfile).toContain("add Claude Sonnet 5 model IDs");
    expect(dockerfile).toContain("pack-verifies");
    expect(dockerfile).toContain("per-agent Penstock session identity");
    expect(dockerfile).toContain("ANTHROPIC_CUSTOM_HEADERS");
    expect(dockerfile).toContain("maxConsecutiveFailedResumes");
    expect(dockerfile).toContain("K8S_AGENT_SESSION_POLICY");
  });

  it("vendors the opencode_k8s adapter commit with crash, runtime-cache, MCP header, pod-stderr, startup-wait, opencode-db, chunkTimeout, budget-cap, and compact-threshold fixes", () => {
    expect(dockerfile).toContain("ARG OPENCODE_K8S_REF=30466007c5bb5e8e52ee51b8d0b3ebf2cf2f9120");
    expect(dockerfile).toContain("opencode config/auth writers respect XDG_*");
    expect(dockerfile).toContain("reserve opencode XDG config/data/state onto the");
    expect(dockerfile).toContain("type-crash");
    expect(dockerfile).toContain("5-strike adapter crashloop circuit-breaker");
    expect(dockerfile).toContain("writable home (/paperclip/.runtime-cache)");
    expect(dockerfile).toContain("EACCES mkdir '/runtime-cache'");
    expect(dockerfile).toContain("preserve headers when translating Claude-style");
    expect(dockerfile).toContain("Bearer-protected gbrain connects");
    expect(dockerfile).toContain("recover the failed");
    expect(dockerfile).toContain("pod's container stderr");
    expect(dockerfile).toContain("PEN-389");
    expect(dockerfile).toContain("mount a per-agent");
    expect(dockerfile).toContain("/runtime-cache emptyDir in opencode_k8s Jobs");
    expect(dockerfile).toContain("Chrome BrowserMetrics");
    expect(dockerfile).toContain("reserve the runtime-cache env keys");
    expect(dockerfile).toContain("stale /paperclip/.runtime-cache overrides");
    expect(dockerfile).toContain("split the opencode pod schedule wait");
    expect(dockerfile).toContain("bounded 10m startup window");
    expect(dockerfile).toContain("reset the per-agent opencode.db");
    expect(dockerfile).toContain("session_message.seq");
    expect(dockerfile).toContain("no-task workspace_subpath runs");
    expect(dockerfile).toContain("shared _no_task_ DB");
    expect(dockerfile).toContain("size exceeds 500 MiB");
    expect(dockerfile).toContain("chunkTimeout=240s");
    expect(dockerfile).toContain("Stream idle timeout - partial response");
    expect(dockerfile).toContain("errorCode=budget_exceeded");
    expect(dockerfile).toContain("model-aware proactive compact thresholds");
    expect(dockerfile).toContain("adapterConfig.compactThreshold");
    expect(dockerfile).toContain("opencode_k8s session management");
    expect(dockerfile).toContain("x-penstock-session: agent:<name>");
  });

  it("routes Paperclip Docker image builds through the DIND runner pool", () => {
    expect(dockerWorkflow.match(/runs-on: arc-dind/g)).toHaveLength(1);
    expect(dockerWorkflow.match(/runs-on: arc-deploy/g)).toHaveLength(1);
    expect(dockerAgentWorkflow.match(/runs-on: arc-dind/g)).toHaveLength(1);
    expect(dockerAgentWorkflow).not.toContain("runs-on: arc-deploy");
    expect(dockerWorkflow).not.toContain("runs-on: self-hosted");
    expect(dockerAgentWorkflow).not.toContain("runs-on: self-hosted");
  });

  it("keeps the agent image build timeout above full toolchain rebuild duration", () => {
    expect(dockerAgentWorkflow).toContain("timeout-minutes: 90");
  });
});

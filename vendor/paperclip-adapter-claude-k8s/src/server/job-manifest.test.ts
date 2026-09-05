import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildJobManifest,
  buildPodLogPath,
  sanitizeLabelValue,
  isSensitiveEnvName,
  classifyEnvName,
  ENV_NAME_CLASSIFICATION,
  findLiteralSensitiveEnvVars,
  findLiteralSensitiveEnvVarsInPodSpec,
  findServerOnlyEnvVarsInPodSpec,
} from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    ...overrides,
  };
}

function makeSelfPod(overrides: Partial<SelfPodInfo> = {}): SelfPodInfo {
  return {
    namespace: "paperclip",
    image: "paperclipai/paperclip:latest",
    imagePullSecrets: [{ name: "regcred" }],
    dnsConfig: undefined,
    nodeSelector: {},
    tolerations: [],
    pvcClaimName: "paperclip-data",
    secretVolumes: [],
    inheritedEnv: {},
    inheritedEnvValueFrom: [],
    inheritedEnvFrom: [],
    ...overrides,
  };
}

function setRuntimeIsolation(ctx: AdapterExecutionContext, isolation: Record<string, unknown>) {
  ctx.runtime = {
    ...ctx.runtime,
    isolation: isolation as NonNullable<AdapterExecutionContext["runtime"]["isolation"]>,
  };
}

function isolatedStorage(workspace: "ephemeral" | "persistent" = "persistent") {
  return {
    workspace,
    home: workspace,
    session: workspace,
    cache: "ephemeral",
  };
}

function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function createClaudeConfigDirWithSession(sessionId: string, workingDir = "/paperclip"): string {
  const configDir = mkdtempSync(join(tmpdir(), "claude-k8s-session-"));
  const projectDir = join(configDir, "projects", encodeClaudeCwd(workingDir));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "{}\n");
  return configDir;
}

// serviceAccountName is now required (BLO-21812): buildJobManifest throws
// when neither the per-agent config nor this fleet-wide env fallback
// resolves. File-scoped so every describe block below gets a working
// default; the "serviceAccountName" describe block overrides/clears it
// per case to exercise the actual resolution and refusal behavior.
beforeEach(() => {
  process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME = "test-default-sa";
});

afterEach(() => {
  delete process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME;
});

describe("buildJobManifest", () => {
  let ctx: AdapterExecutionContext;
  let selfPod: SelfPodInfo;
  let tempDirs: string[];

  beforeEach(() => {
    ctx = makeCtx();
    selfPod = makeSelfPod();
    tempDirs = [];
    process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH = "";
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("job naming", () => {
    it("uses ac- prefix", () => {
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName).toMatch(/^ac-/);
    });

    it("includes sanitized agent id slug (up to 16 chars)", () => {
      ctx.agent.id = "Agent-ABC!@#";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      // sanitizeForK8sName: lowercase, strip non-alphanumeric (not dashes), slice 0-16
      expect(jobName).toContain("agent-abc");
    });

    it("includes sanitized run id slug (up to 16 chars)", () => {
      ctx.runId = "RUN-ABC-12345";
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName).toContain("run-abc-12345");
    });

    it("includes a deterministic hash suffix", () => {
      const result1 = buildJobManifest({ ctx, selfPod });
      const result2 = buildJobManifest({ ctx, selfPod });
      expect(result1.jobName).toBe(result2.jobName);
      // Hash suffix is 6 hex chars at the end
      expect(result1.jobName).toMatch(/-[0-9a-f]{6}$/);
    });

    it("different agent+run pairs produce different names", () => {
      const result1 = buildJobManifest({ ctx, selfPod });
      ctx.runId = "run-different";
      const result2 = buildJobManifest({ ctx, selfPod });
      expect(result1.jobName).not.toBe(result2.jobName);
    });

    it("stays within 63-char DNS label limit", () => {
      ctx.agent.id = "a".repeat(100);
      ctx.runId = "r".repeat(100);
      const { jobName } = buildJobManifest({ ctx, selfPod });
      expect(jobName.length).toBeLessThanOrEqual(63);
    });
  });

  describe("job spec", () => {
    it("sets backoffLimit to 0 for fail-fast", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.backoffLimit).toBe(0);
    });

    it("sets activeDeadlineSeconds when timeoutSec > 0", () => {
      ctx.config = { timeoutSec: 300 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.activeDeadlineSeconds).toBe(300);
    });

    it("omits activeDeadlineSeconds when timeoutSec is 0", () => {
      ctx.config = { timeoutSec: 0 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.activeDeadlineSeconds).toBeUndefined();
    });

    it("sets ttlSecondsAfterFinished default 300", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.ttlSecondsAfterFinished).toBe(300);
    });

    it("uses configured ttlSecondsAfterFinished", () => {
      ctx.config = { ttlSecondsAfterFinished: 600 };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.ttlSecondsAfterFinished).toBe(600);
    });
  });

  describe("labels", () => {
    it("includes required paperclip labels", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const labels = job.metadata?.labels ?? {};
      expect(labels["app.kubernetes.io/managed-by"]).toBe("paperclip");
      expect(labels["app.kubernetes.io/component"]).toBe("agent-job");
      expect(labels["paperclip.io/agent-id"]).toBe("agent-abc");
      expect(labels["paperclip.io/run-id"]).toBe("run-abc12345");
      expect(labels["paperclip.io/company-id"]).toBe("co1");
      expect(labels["paperclip.io/adapter-type"]).toBe("claude_k8s");
    });

    it("includes extra labels from config", () => {
      ctx.config = { labels: { "env": "prod", "team": "platform" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.team).toBe("platform");
    });

    it("merges extra labels with required ones", () => {
      ctx.config = { labels: { "env": "prod" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.["paperclip.io/adapter-type"]).toBe("claude_k8s");
    });

    it("adds task-id label when context provides taskId", () => {
      ctx.context = { taskId: "task-xyz-789" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBe("task-xyz-789");
    });

    it("falls back to issueId when taskId absent", () => {
      ctx.context = { issueId: "issue-42" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBe("issue-42");
    });

    it("adds session-id label when runtime provides sessionId", () => {
      ctx.runtime = { ...ctx.runtime, sessionId: "sess-abc-1234" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBe("sess-abc-1234");
    });

    it("adds isolation labels in isolated mode", () => {
      ctx.config = { isolationMode: "isolated", isolationKey: "pr-review-123" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/isolation-mode"]).toBe("workspace");
      expect(job.metadata?.labels?.["paperclip.io/isolation-key"]).toBe("pr-review-123");
    });

    it("labels runtime isolation with its typed mode", () => {
      setRuntimeIsolation(ctx, {
        isolationMode: "run",
        isolationKey: "run:run-abc12345",
        workspaceRoot: "/runtime-cache/paperclip-runs/run-abc12345/workspace",
        homeRoot: "/runtime-cache/paperclip-runs/run-abc12345/home",
        sessionRoot: "/runtime-cache/paperclip-runs/run-abc12345/session",
        cacheRoot: "/runtime-cache/paperclip-runs/run-abc12345/cache",
        tmpRoot: "/runtime-cache/paperclip-runs/run-abc12345/tmp",
        storage: isolatedStorage("ephemeral"),
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/isolation-mode"]).toBe("run");
      expect(job.metadata?.labels?.["paperclip.io/isolation-key"]).toBe("runrun-abc12345");
    });

    it("reads sessionId from runtime.sessionParams when sessionId prop missing", () => {
      ctx.runtime = { ...ctx.runtime, sessionParams: { sessionId: "sess-from-params" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBe("sess-from-params");
    });

    it("omits task-id and session-id labels when neither is provided", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/task-id"]).toBeUndefined();
      expect(job.metadata?.labels?.["paperclip.io/session-id"]).toBeUndefined();
    });

    it("drops user label with paperclip.io/ prefix", () => {
      ctx.config = { labels: { "paperclip.io/run-id": "hijacked" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["paperclip.io/run-id"]).not.toBe("hijacked");
      expect(skippedLabels).toContain("paperclip.io/run-id");
    });

    it("drops user label with app.kubernetes.io/ prefix", () => {
      ctx.config = { labels: { "app.kubernetes.io/managed-by": "attacker" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["app.kubernetes.io/managed-by"]).toBe("paperclip");
      expect(skippedLabels).toContain("app.kubernetes.io/managed-by");
    });

    it("passes through user label without reserved prefix", () => {
      ctx.config = { labels: { "custom.io/team": "platform" } };
      const { job, skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.["custom.io/team"]).toBe("platform");
      expect(skippedLabels).not.toContain("custom.io/team");
    });

    it("populates skippedLabels with all dropped keys", () => {
      ctx.config = {
        labels: {
          "paperclip.io/agent-id": "x",
          "app.kubernetes.io/component": "y",
          "safe": "z",
        },
      };
      const { skippedLabels } = buildJobManifest({ ctx, selfPod });
      expect(skippedLabels).toHaveLength(2);
      expect(skippedLabels).toContain("paperclip.io/agent-id");
      expect(skippedLabels).toContain("app.kubernetes.io/component");
    });
  });

  describe("system label sanitization (N4)", () => {
    it("sanitizes agent.id with @ to a valid RFC 1123 label", () => {
      ctx.agent.id = "user@example.com";
      const { job } = buildJobManifest({ ctx, selfPod });
      const label = job.metadata?.labels?.["paperclip.io/agent-id"];
      expect(label).toMatch(/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/);
      expect(label).not.toContain("@");
    });

    it("sanitizes agent.id with spaces to a valid RFC 1123 label", () => {
      ctx.agent.id = "my agent id";
      const { job } = buildJobManifest({ ctx, selfPod });
      const label = job.metadata?.labels?.["paperclip.io/agent-id"];
      expect(label).toMatch(/^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/);
    });

    it("omits paperclip.io/run-id when sanitized value is null (all-invalid runId)", () => {
      // inject an all-special-chars runId via context override — buildJobManifest
      // uses ctx.runId directly. Use characters that are path-valid but label-invalid.
      const badCtx = makeCtx({ runId: "@@@" });
      expect(() => buildJobManifest({ ctx: badCtx, selfPod })).toThrow("Invalid runId");
    });

    it("selector matches sanitized agent-id label", () => {
      ctx.agent.id = "Agent@Test";
      const { job } = buildJobManifest({ ctx, selfPod });
      const agentLabel = job.metadata?.labels?.["paperclip.io/agent-id"];
      // the label should equal what sanitizeLabelValue produces
      expect(agentLabel).toBe("AgentTest");
    });
  });

  describe("annotations", () => {
    it("includes adapter type and agent name annotations", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.annotations?.["paperclip.io/adapter-type"]).toBe("claude_k8s");
      expect(job.metadata?.annotations?.["paperclip.io/agent-name"]).toBe("Test Agent");
    });
  });

  describe("pod spec", () => {
    it("sets restartPolicy to Never", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.restartPolicy).toBe("Never");
    });

    it("sets the non-root uid and primary gid without requesting volume ownership changes", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const sc = job.spec?.template?.spec?.securityContext;
      expect(sc?.runAsNonRoot).toBe(true);
      expect(sc?.runAsUser).toBe(1000);
      expect(sc?.runAsGroup).toBe(1000);
      expect(sc?.fsGroup).toBeUndefined();
      expect(sc?.fsGroupChangePolicy).toBeUndefined();
    });

    it("includes imagePullSecrets from selfPod", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.imagePullSecrets).toEqual([{ name: "regcred" }]);
    });

    it("omits imagePullSecrets when empty", () => {
      selfPod.imagePullSecrets = [];
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.imagePullSecrets).toBeUndefined();
    });

    it("includes dnsConfig from selfPod when present", () => {
      selfPod.dnsConfig = { nameservers: ["8.8.8.8"], searches: ["svc.cluster.local"] };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.dnsConfig).toEqual({ nameservers: ["8.8.8.8"], searches: ["svc.cluster.local"] });
    });

    it("omits dnsConfig when not present", () => {
      selfPod.dnsConfig = undefined;
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.dnsConfig).toBeUndefined();
    });
  });

  describe("init containers", () => {
    it("has write-prompt init container with busybox image", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.name).toBe("write-prompt");
      expect(init?.image).toBe("busybox:1.36");
      expect(init?.imagePullPolicy).toBe("IfNotPresent");
    });

    it("write-prompt writes PROMPT_CONTENT to /tmp/prompt/prompt.txt", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.command?.[0]).toBe("sh");
      expect(init?.command?.[1]).toBe("-c");
      expect(init?.command?.[2]).toContain("printf '%s' \"$PROMPT_CONTENT\" > /tmp/prompt/prompt.txt");
    });

    it("write-prompt redirects Chrome BrowserMetrics to ephemeral runtime-cache (BLO-10699)", () => {
      // The agent-browser designer tool launches Chrome with the default
      // /paperclip/.config/google-chrome profile; its BrowserMetrics *.pma
      // spool leaked 42GiB onto the shared CephFS HOME and walled the fleet
      // with EDQUOT. Only BrowserMetrics is redirected (profile auth stays
      // persistent), idempotently, to a per-pod path that dies with the pod.
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      const cmd = init?.command?.[2] ?? "";
      // Paths are shell-quoted because they are operator-configurable
      // (`config.workspaceMountPath` / `config.homeRoot`) and land in the init
      // container's `sh -c`, which runs before the PreToolUse guard exists.
      expect(cmd).toContain("[ -L '/paperclip/.config/google-chrome/BrowserMetrics' ]");
      expect(cmd).toContain(
        "ln -sfn '/runtime-cache/chrome-browser-metrics' '/paperclip/.config/google-chrome/BrowserMetrics'",
      );
    });

    it("shell-quotes configured mount paths in the init command, and rejects shell-active ones", () => {
      // A mount path of `/tmp/x; env; #` would otherwise execute mid-`sh -c`
      // with the prompt/MCP/PVC mounts already attached, ahead of the guard.
      ctx.config.workspaceMountPath = "/srv/agent data";
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/unsafe in a shell command/);
      ctx.config.workspaceMountPath = "/tmp/x; env; #";
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/unsafe in a shell command/);
      ctx.config.workspaceMountPath = "relative/path";
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/must be an absolute path/);
      // A legitimate custom absolute path still builds, and is quoted.
      ctx.config.workspaceMountPath = "/srv/agent-data";
      const { job } = buildJobManifest({ ctx, selfPod });
      const initCmd = job.spec?.template?.spec?.initContainers?.[0]?.command?.[2] ?? "";
      expect(initCmd).toContain("'/srv/agent-data/.config/google-chrome'");
    });

    // Round 6: `assertSafeAbsolutePath` validates the SHAPE of the configured
    // path but not whether that path is already taken. A `workspaceMountPath`
    // equal to a mount this builder already emits produced a Pod with two
    // volumeMounts at one mountPath, which Kubernetes rejects outright — so the
    // operator saw an opaque admission error instead of the config mistake.
    // These paths are all shape-valid, so they get past the checks above.
    for (const reserved of ["/tmp/prompt", "/runtime-cache"]) {
      it(`rejects workspaceMountPath colliding with the reserved ${reserved} mount`, () => {
        ctx.config.workspaceMountPath = reserved;
        expect(() => buildJobManifest({ ctx, selfPod })).toThrow(
          /must not collide with the reserved/,
        );
      });

      it(`rejects ${reserved} even with a trailing slash (same mount path to Kubernetes)`, () => {
        ctx.config.workspaceMountPath = `${reserved}/`;
        expect(() => buildJobManifest({ ctx, selfPod })).toThrow(
          /must not collide with the reserved/,
        );
      });
    }

    it("rejects workspaceMountPath colliding with an inherited secret mount", () => {
      // Inherited secret mounts come from the running Deployment, so this is
      // reachable without touching adapter config at all.
      selfPod.secretVolumes = [
        { volumeName: "gh-token", secretName: "gh", mountPath: "/paperclip/.secrets/gh", defaultMode: 0o400 },
      ];
      ctx.config.workspaceMountPath = "/paperclip/.secrets/gh";
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(
        /must not collide with inherited secret mount/,
      );
    });

    it("rejects workspaceMountPath colliding with the DinD socket mount", () => {
      // /var/run is appended AFTER the targeted workspace check, so only the
      // per-container backstop catches this one.
      ctx.config.enableDocker = true;
      ctx.config.workspaceMountPath = "/var/run";
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/duplicate volumeMounts at \/var\/run/);
    });

    it("still allows a NESTED workspace mount path — only exact duplicates are illegal", () => {
      // Kubernetes permits /runtime-cache alongside /runtime-cache/workspace;
      // the collision check must not over-reject and break valid layouts.
      ctx.config.workspaceMountPath = "/runtime-cache/workspace";
      const { job } = buildJobManifest({ ctx, selfPod });
      const mounts = job.spec?.template?.spec?.containers[0]?.volumeMounts ?? [];
      expect(mounts).toContainEqual({ name: "data", mountPath: "/runtime-cache/workspace" });
    });

    it("emits no duplicate mountPath in either container across the manifest matrix", () => {
      // The invariant itself, asserted over the combinations that vary the
      // mount set, rather than one case per bug.
      for (const enableDocker of [false, true]) {
        for (const pvcClaimName of ["", "paperclip-data"]) {
          for (const secretVolumes of [
            [],
            [{ volumeName: "gh", secretName: "gh", mountPath: "/paperclip/.secrets/gh", defaultMode: 0o400 }],
          ]) {
            selfPod.pvcClaimName = pvcClaimName;
            selfPod.secretVolumes = secretVolumes;
            ctx.config = { enableDocker };
            const { job } = buildJobManifest({ ctx, selfPod });
            const spec = job.spec?.template?.spec;
            const containers = [
              ...(spec?.initContainers ?? []),
              ...(spec?.containers ?? []),
            ];
            for (const container of containers) {
              const paths = (container.volumeMounts ?? []).map((m) => m.mountPath);
              expect(new Set(paths).size, `${container.name} has duplicate mountPaths: ${paths.join(", ")}`).toBe(
                paths.length,
              );
            }
          }
        }
      }
    });

    it("write-prompt mounts the runtime-cache emptyDir so the BrowserMetrics symlink target resolves", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.volumeMounts).toContainEqual({ name: "runtime-cache", mountPath: "/runtime-cache" });
    });

    it("write-prompt mounts prompt volume", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.volumeMounts).toContainEqual({ name: "prompt", mountPath: "/tmp/prompt" });
    });

    it("write-prompt mounts the data PVC at /paperclip so mkdir of run-logs succeeds as runAsUser:1000", () => {
      // Without this mount, the init container's `mkdir -p /paperclip/instances/...`
      // fails with EACCES because uid 1000 cannot write to the container image's
      // root filesystem. The data volume is the shared RWX PVC where run logs and
      // session state live.
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.volumeMounts).toContainEqual({ name: "data", mountPath: "/paperclip" });
    });

    it("prompt env var contains rendered prompt text", () => {
      const { job, prompt } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      const promptEnv = init?.env?.find((e: { name: string }) => e.name === "PROMPT_CONTENT");
      expect(promptEnv?.value).toBe(prompt);
    });
  });

  describe("claude container", () => {
    it("names container 'claude'", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.name).toBe("claude");
    });

    it("uses selfPod image by default", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.image).toBe("paperclipai/paperclip:latest");
    });

    it("uses configured image override", () => {
      ctx.config = { image: "my-image:v2" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.image).toBe("my-image:v2");
    });

    it("sets imagePullPolicy from config", () => {
      ctx.config = { imagePullPolicy: "Always" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.imagePullPolicy).toBe("Always");
    });

    it("defaults imagePullPolicy to IfNotPresent", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.imagePullPolicy).toBe("IfNotPresent");
    });

    it("sets workingDir to /paperclip by default", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/paperclip");
    });

    it("uses workspace cwd when available", () => {
      ctx.context = { paperclipWorkspace: { cwd: "/workspace/myproject" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/workspace/myproject");
    });

    it("prefers workspace cwd over configured cwd", () => {
      ctx.config = { cwd: "/custom/path" };
      ctx.context = { paperclipWorkspace: { cwd: "/workspace/myproject" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.containers[0]?.workingDir).toBe("/workspace/myproject");
    });
  });

  describe("volumes", () => {
    it("creates prompt emptyDir volume", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const promptVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "prompt");
      expect(promptVol?.emptyDir).toEqual({});
    });

    it("mounts runtime cache emptyDir outside /paperclip", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cacheVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "runtime-cache");
      expect(cacheVol?.emptyDir?.sizeLimit).toBe("20Gi");
      const cacheMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find((vm) => vm.name === "runtime-cache");
      expect(cacheMount?.mountPath).toBe("/runtime-cache");
    });

    it("mounts data PVC at /paperclip when pvcClaimName is set", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const dataVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
      expect(dataVol?.persistentVolumeClaim?.claimName).toBe("paperclip-data");
      const dataMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find((vm) => vm.mountPath === "/paperclip");
      expect(dataMount?.name).toBe("data");
      const securityContext = job.spec?.template?.spec?.securityContext;
      expect(securityContext?.fsGroup).toBeUndefined();
      expect(securityContext?.fsGroupChangePolicy).toBeUndefined();
    });

    it("backs the data volume with an emptyDir when no PVC is configured, so the Pod can still start", () => {
      // Previously this asserted the volume was OMITTED. That was the root of a
      // two-stage bug: an unconditional mount then named an undeclared volume
      // (admission rejects the whole Pod), and making the mount conditional
      // merely moved the failure later — the init container still runs
      // `mkdir -p /paperclip/...` as runAsUser:1000, which is EACCES on the
      // image's root filesystem. Declaring the volume unconditionally removes
      // the condition rather than duplicating it: always declared, always
      // mounted, always writable; ephemeral when there is no claim.
      selfPod.pvcClaimName = null;
      const { job } = buildJobManifest({ ctx, selfPod });
      const dataVolume = job.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
      expect(dataVolume).toEqual({ name: "data", emptyDir: {} });
      expect(dataVolume?.persistentVolumeClaim).toBeUndefined();
      // Both containers still mount it, so the mkdir the init container performs
      // unconditionally has a writable target.
      expect(job.spec?.template?.spec?.containers[0]?.volumeMounts).toContainEqual({
        name: "data",
        mountPath: "/paperclip",
      });
      expect(job.spec?.template?.spec?.initContainers?.[0]?.volumeMounts).toContainEqual({
        name: "data",
        mountPath: "/paperclip",
      });
    });

    it("backs the data volume with the PVC when a claim IS configured", () => {
      // Guards the other direction: the emptyDir fallback must not shadow a real
      // claim, or every run would silently lose its persistent state.
      selfPod.pvcClaimName = "paperclip-data";
      const { job } = buildJobManifest({ ctx, selfPod });
      const dataVolume = job.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
      expect(dataVolume).toEqual({
        name: "data",
        persistentVolumeClaim: { claimName: "paperclip-data" },
      });
      expect(dataVolume?.emptyDir).toBeUndefined();
    });

    // Kubernetes rejects the entire Pod when any volumeMount names a volume the
    // spec does not declare, so a mount/volume mismatch is not a degradation —
    // it is an unschedulable Job. The init container used to mount `data`
    // unconditionally while the volume itself was conditional on a claim, so
    // every no-PVC configuration produced an invalid manifest. Assert the
    // invariant over BOTH containers across the PVC/secret matrix rather than
    // spot-checking one case, so the two lists cannot drift apart again.
    describe("every volumeMount resolves to a declared volume", () => {
      // Each row returns the name of the optional volume it is meant to bring
      // into play (or null), so a row cannot silently stop exercising its case.
      const matrix: Array<[string, () => string | null]> = [
        ["with PVC", () => "data"],
        ["no PVC", () => { selfPod.pvcClaimName = null; return null; }],
        ["no PVC + secret volumes", () => {
          selfPod.pvcClaimName = null;
          selfPod.secretVolumes = [{
            volumeName: "my-secret",
            secretName: "app-secret",
            mountPath: "/secrets/app",
            defaultMode: 420,
          }];
          return "my-secret";
        }],
        ["no PVC + large prompt", () => {
          selfPod.pvcClaimName = null;
          // >256 KiB switches prompt delivery to the Secret-volume path, which
          // adds its own init-container mount.
          ctx.config = { promptTemplate: "x".repeat(300 * 1024) };
          return "prompt-secret";
        }],
      ];

      for (const [name, setup] of matrix) {
        it(name, () => {
          const expectVolume = setup();
          const { job } = buildJobManifest({ ctx, selfPod });
          const spec = job.spec?.template?.spec;
          const declared = new Set((spec?.volumes ?? []).map((v) => v.name));
          // Guard against a vacuous row: if a case is meant to exercise an
          // optional volume, prove that volume is actually in play.
          if (expectVolume) expect([...declared]).toContain(expectVolume);
          const containers = [...(spec?.initContainers ?? []), ...(spec?.containers ?? [])];
          expect(containers.length).toBeGreaterThan(0);
          const dangling = containers.flatMap((c) =>
            (c.volumeMounts ?? [])
              .filter((vm) => !declared.has(vm.name))
              .map((vm) => `${c.name}:${vm.name}`),
          );
          expect(dangling).toEqual([]);
        });
      }
    });

    it("mounts secret volumes", () => {
      selfPod.secretVolumes = [{
        volumeName: "my-secret",
        secretName: "app-secret",
        mountPath: "/secrets/app",
        defaultMode: 420,
      }];
      const { job } = buildJobManifest({ ctx, selfPod });
      const secretVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "my-secret");
      expect(secretVol?.secret?.secretName).toBe("app-secret");
      const secretMount = job.spec?.template?.spec?.containers[0]?.volumeMounts?.find((vm) => vm.mountPath === "/secrets/app");
      expect(secretMount?.readOnly).toBe(true);
    });

    it("preserves the source volume's items selector so the Job sees no extra keys", () => {
      // Mirrors the live paperclip-api spec: the gbrain-authbot-service-key
      // volume projects exactly ONE key out of a 7-key Secret. Before this was
      // preserved, agent pods mounted all 7 — more key material than the
      // container the mount was copied from.
      selfPod.secretVolumes = [{
        volumeName: "gbrain-authbot-service-key",
        secretName: "authbot-mcp-consumer-service-keys",
        mountPath: "/var/run/authbot",
        defaultMode: 292,
        items: [{ key: "gbrain-plugin-service-key", path: "gbrain-plugin-service-key" }],
      }];
      const { job } = buildJobManifest({ ctx, selfPod });
      const vol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "gbrain-authbot-service-key");
      expect(vol?.secret?.items).toEqual([
        { key: "gbrain-plugin-service-key", path: "gbrain-plugin-service-key" },
      ]);
    });

    it("leaves items unset when the source volume projects the whole Secret", () => {
      selfPod.secretVolumes = [{
        volumeName: "github-merge-token",
        secretName: "paperclip-github-merge-token",
        mountPath: "/paperclip/.secrets/github-merge-token",
        defaultMode: 292,
      }];
      const { job } = buildJobManifest({ ctx, selfPod });
      const vol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "github-merge-token");
      expect(vol?.secret?.items).toBeUndefined();
      // Still optional, so a Secret absent in the agent namespace cannot
      // hard-fail the Job.
      expect(vol?.secret?.optional).toBe(true);
    });
  });

  describe("environment variables", () => {
    it("sets HOME to /paperclip", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const home = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "HOME");
      expect(home?.value).toBe("/paperclip");
    });

    it("scopes HOME, Claude config, caches, cwd, and logs to the isolation key", () => {
      ctx.config = { isolationMode: "isolated", isolationKey: "pr-review-123" };
      const { job, podLogPath, envSecret } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      const env = new Map(container?.env?.map((e) => [e.name, e.value]));
      const command = container?.command?.join(" ") ?? "";
      const root = "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/pr-review-123";
      expect(container?.workingDir).toBe(`${root}/workspace`);
      expect(env.get("HOME")).toBe(`${root}/home`);
      expect(env.get("CLAUDE_CONFIG_DIR")).toBe(`${root}/home/.claude`);
      expect(env.get("XDG_CACHE_HOME")).toBe(`${root}/cache/xdg`);
      expect(env.get("TMPDIR")).toBe(`${root}/tmp`);
      expect(env.get("TMP")).toBe(`${root}/tmp`);
      expect(env.get("TEMP")).toBe(`${root}/tmp`);
      // PAPERCLIP_K8S_ISOLATION_KEY matches the sensitive-name pattern (contains
      // "KEY") even though it's a path-scoping identifier, not a credential —
      // an accepted false positive (BLO-17980): it still routes through
      // secretKeyRef instead of a literal value.
      const isolationKeyEntry = container?.env?.find((e) => e.name === "PAPERCLIP_K8S_ISOLATION_KEY");
      expect(isolationKeyEntry?.value).toBeUndefined();
      expect(isolationKeyEntry?.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
      expect(envSecret?.data.PAPERCLIP_K8S_ISOLATION_KEY).toBe("pr-review-123");
      expect(podLogPath).toBe("/paperclip/instances/default/data/run-logs/co1/agent-abc/isolated/pr-review-123/run-abc12345.pod.ndjson");
      expect(command).toContain(
        "mkdir -p '/paperclip/instances/default/data/run-logs/co1/agent-abc/isolated/pr-review-123'",
      );
    });

    it("prefers run-scoped runtime roots over manual config and clones an independent workspace", () => {
      ctx.config = {
        isolationMode: "isolated",
        isolationKey: "config-key",
        workspaceRoot: "/paperclip/config-workspace",
      };
      ctx.context = { paperclipWorkspace: { cwd: "/paperclip/source-worktree" } };
      setRuntimeIsolation(ctx, {
        isolationMode: "run",
        isolationKey: "run:run-abc12345",
        workspaceRoot: "/runtime-cache/paperclip-runs/run-abc12345/workspace",
        homeRoot: "/runtime-cache/paperclip-runs/run-abc12345/home",
        sessionRoot: "/runtime-cache/paperclip-runs/run-abc12345/session",
        cacheRoot: "/runtime-cache/paperclip-runs/run-abc12345/cache",
        tmpRoot: "/runtime-cache/paperclip-runs/run-abc12345/tmp",
        storage: isolatedStorage("ephemeral"),
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      const env = new Map(container?.env?.map((entry) => [entry.name, entry.value]));
      const command = container?.command?.join(" ") ?? "";
      expect(container?.workingDir).toBe("/runtime-cache/paperclip-runs/run-abc12345");
      expect(env.get("HOME")).toBe("/runtime-cache/paperclip-runs/run-abc12345/home");
      expect(env.get("CLAUDE_CONFIG_DIR")).toBe("/runtime-cache/paperclip-runs/run-abc12345/session/.claude");
      expect(env.get("XDG_CACHE_HOME")).toBe("/runtime-cache/paperclip-runs/run-abc12345/cache/xdg");
      expect(env.get("TMPDIR")).toBe("/runtime-cache/paperclip-runs/run-abc12345/tmp");
      expect(env.get("TMP")).toBe("/runtime-cache/paperclip-runs/run-abc12345/tmp");
      expect(env.get("TEMP")).toBe("/runtime-cache/paperclip-runs/run-abc12345/tmp");
      expect(env.get("PAPERCLIP_WORKSPACE_CWD")).toBe("/runtime-cache/paperclip-runs/run-abc12345/workspace");
      expect(command).toContain("if git -C '/paperclip/source-worktree' rev-parse --verify HEAD");
      expect(command).toContain("git clone --shared --no-checkout --origin origin -- '/paperclip/source-worktree' '/runtime-cache/paperclip-runs/run-abc12345/workspace'");
      expect(command).toContain("checkout --detach \"$source_head\"");
      // BLO-31359: no recorded upstream, so the clone is left with no remote at
      // all rather than one aimed back at the clone source — plus a breadcrumb,
      // so the resulting "'origin' does not appear to be a git repository" is
      // self-explaining.
      expect(command).toContain("git -C '/runtime-cache/paperclip-runs/run-abc12345/workspace' remote remove origin");
      expect(command).not.toContain("remote add origin");
      expect(command).not.toContain("fetch --no-tags");
      // Nothing that presumes a remote may leak onto the no-upstream path.
      expect(command).not.toContain("remote set-head");
      expect(command).toContain("config paperclip.originRemoved");
      expect(command).toContain("else rm -rf '/runtime-cache/paperclip-runs/run-abc12345/workspace' && mkdir -p '/runtime-cache/paperclip-runs/run-abc12345/workspace'");
      expect(command).toContain("fi && cd '/runtime-cache/paperclip-runs/run-abc12345/workspace' || exit $?");
      const syntaxCheck = spawnSync("/bin/sh", ["-n", "-c", command], { encoding: "utf8" });
      expect(syntaxCheck.stderr).toBe("");
      expect(syntaxCheck.status).toBe(0);
      expect(command).not.toContain("/paperclip/config-workspace");
    });

    // BLO-31359: `git clone` aims the clone's `origin` at its source, so cloning
    // the project base checkout makes that shared base a push target — git only
    // refuses a push to the base's *currently checked out* branch, so any other
    // refname lands inside it. Repointing `origin` at the real upstream is what
    // keeps an ephemeral run's push traffic leaving the cluster.
    it("repoints the ephemeral clone's origin at the real upstream, never the clone source", () => {
      ctx.context = {
        paperclipWorkspace: {
          cwd: "/paperclip/instances/default/projects/co1/proj-1/paperclip",
          repoUrl: "https://github.com/Blockcast/paperclip.git",
        },
      };
      setRuntimeIsolation(ctx, {
        isolationMode: "run",
        isolationKey: "run:run-abc12345",
        workspaceRoot: "/runtime-cache/paperclip-runs/run-abc12345/workspace",
        homeRoot: "/runtime-cache/paperclip-runs/run-abc12345/home",
        sessionRoot: "/runtime-cache/paperclip-runs/run-abc12345/session",
        cacheRoot: "/runtime-cache/paperclip-runs/run-abc12345/cache",
        tmpRoot: "/runtime-cache/paperclip-runs/run-abc12345/tmp",
        storage: isolatedStorage("ephemeral"),
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command?.join(" ") ?? "";
      const workspaceRoot = "/runtime-cache/paperclip-runs/run-abc12345/workspace";

      // The clone still comes off local disk — that is what makes provisioning
      // cheap — but the base must not survive as a remote.
      expect(command).toContain(
        `git clone --shared --no-checkout --origin origin -- '/paperclip/instances/default/projects/co1/proj-1/paperclip' '${workspaceRoot}'`,
      );
      expect(command).toContain(`git -C '${workspaceRoot}' remote remove origin`);
      expect(command).toContain(
        `git -C '${workspaceRoot}' remote add origin -- 'https://github.com/Blockcast/paperclip.git'`,
      );
      // Remove must precede add, or the add fails and the base stays wired up.
      expect(command.indexOf("remote remove origin")).toBeLessThan(command.indexOf("remote add origin"));
      // Fail-closed: the two commands that establish the security property sit
      // in the `&&` chain unguarded, so a failure aborts the run rather than
      // handing back a base-writable workspace.
      expect(command).not.toMatch(/remote (remove|add) origin[^&|]*\|\|/);

      const syntaxCheck = spawnSync("/bin/sh", ["-n", "-c", command], { encoding: "utf8" });
      expect(syntaxCheck.stderr).toBe("");
      expect(syntaxCheck.status).toBe(0);
    });

    // `git remote remove` also deletes every refs/remotes/origin/*, so without
    // this the workspace has no remote-tracking refs and `git rebase
    // origin/master` fails with `unknown revision`. The refetch is ergonomics,
    // not security, so unlike the remove/add pair it is guarded — an offline pod
    // must degrade to "fetch first", never to a failed run.
    it("refetches remote-tracking refs and origin/HEAD after repointing origin, without letting a fetch failure fail the run", () => {
      // Each path is read twice — once to build the fixture, once to spell the
      // `git -C` prefixes the assertions match on — so bind them rather than
      // re-typing the literals. The desync fails closed but points the wrong
      // way: editing a fixture literal alone leaves both calls unrecognised, so
      // the suite reports "unclassified git call" and sends the reader to the
      // run-workspace git block they did not touch instead of the path they did.
      const sourceCheckout = "/paperclip/instances/default/projects/co1/proj-1/paperclip";
      const workspaceRoot = "/runtime-cache/paperclip-runs/run-abc12345/workspace";
      ctx.context = {
        paperclipWorkspace: {
          cwd: sourceCheckout,
          repoUrl: "https://github.com/Blockcast/paperclip.git",
        },
      };
      setRuntimeIsolation(ctx, {
        isolationMode: "run",
        isolationKey: "run:run-abc12345",
        workspaceRoot,
        homeRoot: "/runtime-cache/paperclip-runs/run-abc12345/home",
        sessionRoot: "/runtime-cache/paperclip-runs/run-abc12345/session",
        cacheRoot: "/runtime-cache/paperclip-runs/run-abc12345/cache",
        tmpRoot: "/runtime-cache/paperclip-runs/run-abc12345/tmp",
        storage: isolatedStorage("ephemeral"),
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command?.join(" ") ?? "";
      const boundedGit = `git -C '${workspaceRoot}' -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15`;

      expect(command).toContain(`fetch --no-tags --quiet origin`);
      // Fetch only after origin points at upstream — fetching earlier would pull
      // the base's refs back in under the name `origin`.
      expect(command.indexOf("remote add origin")).toBeLessThan(command.indexOf("fetch --no-tags"));
      // Guarded, and in a subshell: `a && b || true` would parse as
      // `(a && b) || true` and swallow failures of the unguarded security
      // commands earlier in the chain.
      expect(command).toContain(`(git -C '${workspaceRoot}' -c http.lowSpeedLimit=1000`);
      expect(command).toContain("config paperclip.originFetchFailed");

      // `fetch` restores refs/remotes/origin/<branch> but not the symbolic
      // refs/remotes/origin/HEAD, so `set-head` is paired with it — otherwise
      // `git symbolic-ref refs/remotes/origin/HEAD` stays broken in every
      // run-isolated workspace.
      expect(command).toContain("remote set-head origin -a");
      expect(command.indexOf("fetch --no-tags")).toBeLessThan(command.indexOf("remote set-head"));
      // set-head carries its own nested guard, so a set-head failure after a
      // successful fetch cannot fall through to the "fetch failed" breadcrumb.
      // It records its own breadcrumb instead of failing silently, so every
      // failure path in this block explains itself on the workspace.
      expect(command).toContain(
        `(${boundedGit} remote set-head origin -a >/dev/null 2>&1 || git -C '${workspaceRoot}' config paperclip.originHeadUnset`,
      );

      // Both calls in this block reach the network — `set-head -a` queries the
      // remote for its default branch even when the tracking refs are already
      // local — so the bound must be on both, not just the fetch.
      expect(command).toContain(`${boundedGit} fetch --no-tags --quiet origin`);
      expect(command).toContain(`${boundedGit} remote set-head origin -a`);

      // The guard against future drift is the *invariant* "every network-reaching
      // git call carries the bound", not a count of how often the bound appears.
      // Counting the bound asserts the inverse of what it looks like it asserts:
      // a third call added WITHOUT the bound leaves the count at 2 and passes
      // silently — exactly the regression worth catching — while a correctly
      // bounded one pushes it to 3 and fails, training the next reader to bump
      // the literal instead of reading the block.
      const boundFlags = ["-c http.lowSpeedLimit=1000", "-c http.lowSpeedTime=15"];
      const gitPrefix = `git -C '${workspaceRoot}'`;
      // Deny-list, deliberately, because the two sets are not symmetric: the
      // verbs this block uses that stay local are enumerable, the ones that can
      // reach a remote are not. An allowlist of network verbs fails OPEN — an
      // unnamed verb is classified local, so an unbounded call using it passes
      // every assertion below. `remote prune` and `remote show` are two that
      // exist today: both block on an unreachable remote exactly as
      // `set-head -a` does. Treating anything unrecognised as network-reaching
      // fails CLOSED instead, so a new verb reddens this suite until a human
      // classifies it — which is the whole point of a drift guard.
      const staysLocal = (args: string) =>
        /^\s*(config|checkout|rev-parse|symbolic-ref)\b/.test(args) ||
        /^\s*remote\s+(add|remove|rename|set-url)\b/.test(args);
      const reachesNetwork = (args: string) => !staysLocal(args);

      const invocations = command
        .split(gitPrefix)
        .slice(1)
        .map((tail) => {
          // One invocation ends at the next shell separator.
          const raw = tail.split(/&&|\|\||[;|)]/, 1)[0] ?? "";
          // Peel every leading `-c <key>=<value>` so boundedness is a question
          // of which flags are present, not of them being adjacent and in this
          // exact order — and so the verb match sees the subcommand either way.
          let rest = raw.trimStart();
          const flags: string[] = [];
          for (let m = rest.match(/^-c\s+(\S+)\s+/); m; m = rest.match(/^-c\s+(\S+)\s+/)) {
            flags.push(`-c ${m[1]}`);
            rest = rest.slice(m[0].length);
          }
          return { args: rest, bounded: boundFlags.every((flag) => flags.includes(flag)) };
        });

      const networkCalls = invocations.filter((i) => reachesNetwork(i.args));
      // Scope, closed rather than described. The parser above only sees calls
      // spelled exactly `git -C '<workspaceRoot>'`. Enumerating the forms that
      // evade it would read as exhaustive without being so: `git -c k=v -C
      // '<root>'` and `git --git-dir '<root>/.git'` both slip the prefix match,
      // and this block ENDS with a literal `cd '<workspaceRoot>'`, so a call
      // appended after that needs no path argument at all to act on this repo
      // and would mention neither `-C` nor the root. Classify every git call
      // instead and let anything unrecognised fail here — that is what makes
      // the boundedness assertions below load-bearing rather than merely
      // well-labelled.
      //
      // Command position excludes three non-calls: the `.git` suffix inside a
      // repo URL, the `git ...` spelled inside the breadcrumb prose (always
      // preceded by a backtick), and the tail of a flag such as `--git-dir`,
      // which is reported by the flag's own call rather than twice.
      //
      // Scope is deliberately the WHOLE container command, not just this block:
      // the command also carries buildEnvGuardSetupShell(), ccrotateRefresh,
      // DIND_WAIT_PREAMBLE, claudeArgsEscaped and failFastFilter. That is the
      // fail-closed choice — a git call added to any of them still lands here —
      // but the coupling runs the other way too, so an unrelated file can redden
      // this assertion. If that happens the fix is to classify the new call, not
      // to narrow this match back to the block.
      const unclassifiedGitCalls = [...command.matchAll(/(?<![-.`\w])git\b/g)]
        .map((m) => command.slice(m.index))
        .filter(
          (call) =>
            // The three shapes this block is allowed to use.
            !call.startsWith(`git -C '${workspaceRoot}'`) &&
            !call.startsWith(`git -C '${sourceCheckout}'`) &&
            !call.startsWith("git clone "),
        )
        .map((call) => call.slice(0, 60));
      expect(unclassifiedGitCalls).toEqual([]);
      // The real guard: no unbounded network call, however this block grows.
      // Needs no edit when a third bounded call is legitimately added, and the
      // scope check above is what guarantees "every call" really means every
      // call rather than every call written in one particular style.
      expect(networkCalls.filter((i) => !i.bounded).map((i) => i.args.trim())).toEqual([]);
      // ...and nothing that stays local pays the bound, so the bound tracks the
      // set of network calls in both directions.
      expect(invocations.filter((i) => i.bounded && !reachesNetwork(i.args)).map((i) => i.args.trim())).toEqual([]);
      // Deliberate change-tripwire, NOT a boundedness check: the two calls above
      // are the whole network surface of run-workspace setup today. A third one
      // is a decision worth a human reading this block. Which edit is correct
      // depends on what was added, and the count alone will not tell you:
      //   - a genuinely NEW network call — bump this literal, and the
      //     boundedness invariant above keeps the addition honest.
      //   - a new LOCAL call whose verb `staysLocal` does not yet name — the
      //     deny-list classifies it as network-reaching (that is the fail-closed
      //     design, not a bug), so it inflates this count too. Add its verb to
      //     `staysLocal`; bumping the literal here would paper over the
      //     misclassification and leave a local call asserted to carry a bound
      //     it has no reason to carry.
      expect(networkCalls).toHaveLength(2);

      const syntaxCheck = spawnSync("/bin/sh", ["-n", "-c", command], { encoding: "utf8" });
      expect(syntaxCheck.stderr).toBe("");
      expect(syntaxCheck.status).toBe(0);
    });

    it("gives two concurrent stateless runs distinct, non-colliding TMPDIR/TMP/TEMP values", () => {
      const buildForRun = (runId: string) => {
        const runCtx = makeCtx({ runId });
        setRuntimeIsolation(runCtx, {
          isolationMode: "run",
          isolationKey: `run:${runId}`,
          workspaceRoot: `/runtime-cache/paperclip-runs/${runId}/workspace`,
          homeRoot: `/runtime-cache/paperclip-runs/${runId}/home`,
          sessionRoot: `/runtime-cache/paperclip-runs/${runId}/session`,
          cacheRoot: `/runtime-cache/paperclip-runs/${runId}/cache`,
          tmpRoot: `/runtime-cache/paperclip-runs/${runId}/tmp`,
          storage: isolatedStorage("ephemeral"),
        });
        const { job } = buildJobManifest({ ctx: runCtx, selfPod });
        const env = new Map(job.spec?.template?.spec?.containers[0]?.env?.map((e) => [e.name, e.value]));
        return { TMPDIR: env.get("TMPDIR"), TMP: env.get("TMP"), TEMP: env.get("TEMP") };
      };

      const first = buildForRun("run-11111111");
      const second = buildForRun("run-22222222");

      expect(first.TMPDIR).toBe("/runtime-cache/paperclip-runs/run-11111111/tmp");
      expect(second.TMPDIR).toBe("/runtime-cache/paperclip-runs/run-22222222/tmp");
      expect(first.TMPDIR).not.toBe(second.TMPDIR);
      expect(first.TMP).toBe(first.TMPDIR);
      expect(first.TEMP).toBe(first.TMPDIR);
      expect(second.TMP).toBe(second.TMPDIR);
      expect(second.TEMP).toBe(second.TMPDIR);
    });

    it("keeps durable workspace sessions persistent while caches remain ephemeral", () => {
      ctx.context = { paperclipWorkspace: { cwd: "/paperclip/workspaces/workspace-1" } };
      setRuntimeIsolation(ctx, {
        isolationMode: "workspace",
        isolationKey: "workspace:workspace-1",
        workspaceRoot: "/paperclip/workspaces/workspace-1",
        homeRoot: "/paperclip/k8s-isolation/workspace-1/home",
        sessionRoot: "/paperclip/k8s-isolation/workspace-1/session",
        cacheRoot: "/runtime-cache/paperclip-workspaces/workspace-1/cache",
        tmpRoot: "/runtime-cache/paperclip-workspaces/workspace-1/tmp",
        storage: isolatedStorage(),
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      const env = new Map(container?.env?.map((entry) => [entry.name, entry.value]));
      expect(container?.workingDir).toBe("/paperclip/workspaces/workspace-1");
      expect(env.get("HOME")).toBe("/paperclip/k8s-isolation/workspace-1/home");
      expect(env.get("CLAUDE_CONFIG_DIR")).toBe("/paperclip/k8s-isolation/workspace-1/session/.claude");
      expect(env.get("TMPDIR")).toBe("/runtime-cache/paperclip-workspaces/workspace-1/tmp");
      expect(env.get("XDG_CACHE_HOME")).toBe("/runtime-cache/paperclip-workspaces/workspace-1/cache/xdg");
      expect(container?.command?.join(" ")).not.toContain("git clone --shared");
    });

    it("lets a runtime shared descriptor override legacy isolated config", () => {
      ctx.config = { isolationMode: "isolated", isolationKey: "config-key" };
      ctx.context = { paperclipWorkspace: { cwd: "/paperclip/shared-workspace" } };
      setRuntimeIsolation(ctx, {
        isolationMode: "shared",
        isolationKey: "agent-shared:agent-abc",
      });

      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      const env = new Map(container?.env?.map((entry) => [entry.name, entry.value]));
      expect(container?.workingDir).toBe("/paperclip/shared-workspace");
      expect(env.get("HOME")).toBe("/paperclip");
      expect(env.get("TMPDIR")).toBeUndefined();
      expect(job.metadata?.labels?.["paperclip.io/isolation-mode"]).toBe("shared");
      expect(job.metadata?.labels?.["paperclip.io/isolation-key"]).toBe("agent-sharedagent-abc");
    });

    it("defaults build and package caches to runtime-cache emptyDir", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const env = new Map(job.spec?.template?.spec?.containers[0]?.env?.map((e) => [e.name, e.value]));
      expect(env.get("XDG_CACHE_HOME")).toBe("/runtime-cache/xdg");
      expect(env.get("GOCACHE")).toBe("/runtime-cache/go-build");
      expect(env.get("GOMODCACHE")).toBe("/runtime-cache/gomod");
      expect(env.get("npm_config_cache")).toBe("/runtime-cache/npm");
      expect(env.get("BUN_INSTALL_CACHE")).toBe("/runtime-cache/bun");
      expect(env.get("PIP_CACHE_DIR")).toBe("/runtime-cache/pip");
      expect(env.get("PLAYWRIGHT_BROWSERS_PATH")).toBe("/runtime-cache/ms-playwright");
    });

    it("overrides inherited cache paths with the job-local runtime-cache mount", () => {
      selfPod.inheritedEnv = { XDG_CACHE_HOME: "/paperclip/.cache", GOCACHE: "/paperclip/.cache/go-build" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const env = new Map(job.spec?.template?.spec?.containers[0]?.env?.map((e) => [e.name, e.value]));
      expect(env.get("XDG_CACHE_HOME")).toBe("/runtime-cache/xdg");
      expect(env.get("GOCACHE")).toBe("/runtime-cache/go-build");
    });

    it("preserves explicit adapter cache env overrides", () => {
      ctx.config = { env: { XDG_CACHE_HOME: "/custom-cache", GOCACHE: "/custom-go-cache" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      const env = new Map(job.spec?.template?.spec?.containers[0]?.env?.map((e) => [e.name, e.value]));
      expect(env.get("XDG_CACHE_HOME")).toBe("/custom-cache");
      expect(env.get("GOCACHE")).toBe("/custom-go-cache");
    });

    it("inherits env vars from selfPod, routing the credential-shaped one through a Secret", () => {
      selfPod.inheritedEnv = { ANTHROPIC_API_KEY: "sk-abc", AWS_REGION: "us-east-1" };
      const { job, envSecret } = buildJobManifest({ ctx, selfPod });
      const env = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const envNames = env.map((e) => e.name);
      expect(envNames).toContain("ANTHROPIC_API_KEY");
      expect(envNames).toContain("AWS_REGION");
      const apiKeyEntry = env.find((e) => e.name === "ANTHROPIC_API_KEY");
      expect(apiKeyEntry?.value).toBeUndefined();
      expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
      expect(envSecret?.data.ANTHROPIC_API_KEY).toBe("sk-abc");
      const regionEntry = env.find((e) => e.name === "AWS_REGION");
      expect(regionEntry?.value).toBe("us-east-1");
    });

    it("inherits ANTHROPIC_AUTH_TOKEN from selfPod for API auth via secretKeyRef, not a literal value", () => {
      selfPod.inheritedEnv = { ANTHROPIC_AUTH_TOKEN: "sk-test" };
      const { job, envSecret } = buildJobManifest({ ctx, selfPod });
      const authEntry = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "ANTHROPIC_AUTH_TOKEN");
      expect(authEntry?.value).toBeUndefined();
      expect(authEntry?.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
      expect(envSecret?.data.ANTHROPIC_AUTH_TOKEN).toBe("sk-test");
    });


    it("user env config overrides inherited env", () => {
      selfPod.inheritedEnv = { AWS_REGION: "us-east-1" };
      ctx.config = { env: { AWS_REGION: "us-west-2" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      const awsRegion = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "AWS_REGION");
      expect(awsRegion?.value).toBe("us-west-2");
    });

    it("sets PAPERCLIP_RUN_ID", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const runId = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_RUN_ID");
      expect(runId?.value).toBe("run-abc12345");
    });

    it("routes PAPERCLIP_API_KEY (from authToken) through a Secret instead of a literal value (BLO-17980)", () => {
      ctx.authToken = "pk_abc123";
      const { job, envSecret } = buildJobManifest({ ctx, selfPod });
      const apiKey = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_API_KEY");
      expect(apiKey?.value).toBeUndefined();
      expect(apiKey?.valueFrom?.secretKeyRef?.key).toBe("PAPERCLIP_API_KEY");
      expect(apiKey?.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
      expect(envSecret?.data.PAPERCLIP_API_KEY).toBe("pk_abc123");
    });

    it("inherited PAPERCLIP_API_URL from selfPod takes precedence", () => {
      ctx.authToken = "pk_abc";
      selfPod.inheritedEnv = { PAPERCLIP_API_URL: "http://paperclip:8080" };
      const { job } = buildJobManifest({ ctx, selfPod });
      const apiUrl = job.spec?.template?.spec?.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_API_URL");
      expect(apiUrl?.value).toBe("http://paperclip:8080");
    });

    it("includes valueFrom env vars from selfPod", () => {
      selfPod.inheritedEnvValueFrom = [
        { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: "api-keys", key: "anthropic" } } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const envList = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const apiKeyEntry = envList.find((e) => e.name === "ANTHROPIC_API_KEY");
      expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe("api-keys");
      expect(apiKeyEntry?.valueFrom?.secretKeyRef?.key).toBe("anthropic");
      expect(apiKeyEntry?.value).toBeUndefined();
    });

    it("stamps x-penstock-session: agent:<name> into ANTHROPIC_CUSTOM_HEADERS, via the Secret (BLO-21858)", () => {
      const { job, envSecret } = buildJobManifest({ ctx, selfPod });
      const envList = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const headers = envList.find((e) => e.name === "ANTHROPIC_CUSTOM_HEADERS");
      // AC1: never a literal. AC4: the value still reaches the container.
      expect(headers?.value).toBeUndefined();
      expect(headers?.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
      expect(headers?.valueFrom?.secretKeyRef?.key).toBe("ANTHROPIC_CUSTOM_HEADERS");
      expect(envSecret?.data.ANTHROPIC_CUSTOM_HEADERS).toContain("x-penstock-session: agent:");
    });

    it("appends the session header to an existing ANTHROPIC_CUSTOM_HEADERS and respects a manual override", () => {
      const withExisting = {
        ...ctx,
        config: { ...(ctx.config as Record<string, unknown>), env: { ANTHROPIC_CUSTOM_HEADERS: "X-Custom: 1" } },
      };
      const r1 = buildJobManifest({ ctx: withExisting, selfPod });
      const h1 = (r1.job.spec?.template?.spec?.containers[0]?.env ?? []).find(
        (e) => e.name === "ANTHROPIC_CUSTOM_HEADERS",
      );
      expect(h1?.value).toBeUndefined();
      expect(r1.envSecret?.data.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Custom: 1");
      expect(r1.envSecret?.data.ANTHROPIC_CUSTOM_HEADERS).toContain("x-penstock-session: agent:");

      const withOverride = {
        ...ctx,
        config: {
          ...(ctx.config as Record<string, unknown>),
          env: { ANTHROPIC_CUSTOM_HEADERS: "x-penstock-session: manual-pin" },
        },
      };
      const r2 = buildJobManifest({ ctx: withOverride, selfPod });
      const h2 = (r2.job.spec?.template?.spec?.containers[0]?.env ?? []).find(
        (e) => e.name === "ANTHROPIC_CUSTOM_HEADERS",
      );
      expect(h2?.value).toBeUndefined();
      expect(r2.envSecret?.data.ANTHROPIC_CUSTOM_HEADERS).toBe("x-penstock-session: manual-pin");
    });

    it("literal env overrides valueFrom with the same name", () => {
      selfPod.inheritedEnv = { MY_VAR: "literal-value" };
      selfPod.inheritedEnvValueFrom = [
        { name: "MY_VAR", valueFrom: { secretKeyRef: { name: "sec", key: "k" } } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const envList = job.spec?.template?.spec?.containers[0]?.env ?? [];
      const myVar = envList.filter((e) => e.name === "MY_VAR");
      expect(myVar).toHaveLength(1);
      expect(myVar[0]?.value).toBe("literal-value");
      expect(myVar[0]?.valueFrom).toBeUndefined();
    });

    it("includes envFrom sources from selfPod on the container", () => {
      selfPod.inheritedEnvFrom = [
        { secretRef: { name: "api-secrets" } },
        { configMapRef: { name: "app-config" } },
      ];
      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      expect(container?.envFrom).toHaveLength(2);
      expect(container?.envFrom?.[0]?.secretRef?.name).toBe("api-secrets");
      expect(container?.envFrom?.[1]?.configMapRef?.name).toBe("app-config");
    });

    it("omits envFrom when selfPod has none", () => {
      selfPod.inheritedEnvFrom = [];
      const { job } = buildJobManifest({ ctx, selfPod });
      const container = job.spec?.template?.spec?.containers[0];
      expect(container?.envFrom).toBeUndefined();
    });
  });

  describe("resources", () => {
    it("sets default resource requests and limits", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const resources = job.spec?.template?.spec?.containers[0]?.resources;
      expect(resources?.requests).toEqual({ cpu: "1000m", memory: "2Gi" });
      expect(resources?.limits).toEqual({ cpu: "4000m", memory: "8Gi" });
    });

    it("uses configured resource overrides", () => {
      ctx.config = {
        "resources.requests.cpu": "500m",
        "resources.requests.memory": "1Gi",
        "resources.limits.cpu": "2000m",
        "resources.limits.memory": "4Gi",
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const resources = job.spec?.template?.spec?.containers[0]?.resources;
      expect(resources?.requests).toEqual({ cpu: "500m", memory: "1Gi" });
      expect(resources?.limits).toEqual({ cpu: "2000m", memory: "4Gi" });
    });
  });

  describe("nodeSelector and tolerations", () => {
    it("applies nodeSelector from config", () => {
      ctx.config = { nodeSelector: { "topology.kubernetes.io/zone": "us-east-1a" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ "topology.kubernetes.io/zone": "us-east-1a" });
    });

    it("applies tolerations from config", () => {
      ctx.config = { tolerations: [{ key: "disk", operator: "Equal", value: "ssd", effect: "NoSchedule" }] };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.tolerations).toHaveLength(1);
    });

    it("omits nodeSelector when empty", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toBeUndefined();
    });

    it("omits tolerations when empty", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.tolerations).toBeUndefined();
    });

    it("inherits nodeSelector from the paperclip pod by default", () => {
      selfPod = makeSelfPod({ nodeSelector: { workload: "paperclip" } });
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ workload: "paperclip" });
    });

    it("inherits tolerations from the paperclip pod by default", () => {
      const inherited = [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }];
      selfPod = makeSelfPod({ tolerations: inherited });
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.tolerations).toEqual(inherited);
    });

    it("allows explicit empty scheduling config to opt out of inherited scheduling", () => {
      selfPod = makeSelfPod({
        nodeSelector: { workload: "paperclip" },
        tolerations: [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }],
      });
      ctx.config = { nodeSelector: "", tolerations: [] };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toBeUndefined();
      expect(job.spec?.template?.spec?.tolerations).toBeUndefined();
    });
  });

  describe("claude args", () => {
    it("builds --print - - --output-format stream-json --verbose", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--print");
      expect(claudeArgs).toContain("-");
      expect(claudeArgs).toContain("--output-format");
      expect(claudeArgs).toContain("stream-json");
      expect(claudeArgs).toContain("--verbose");
    });

    it("adds --model when configured", () => {
      ctx.config = { model: "claude-opus-4-6" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--model");
      expect(claudeArgs).toContain("claude-opus-4-6");
    });

    it("adds --effort when configured", () => {
      ctx.config = { effort: "high" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--effort");
      expect(claudeArgs).toContain("high");
    });

    it("adds --max-turns when configured", () => {
      ctx.config = { maxTurnsPerRun: 10 };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--max-turns");
      expect(claudeArgs).toContain("10");
    });

    it("adds --resume when matching Claude session file exists", () => {
      const configDir = createClaudeConfigDirWithSession("sess_abc");
      tempDirs.push(configDir);
      ctx.config = { env: { CLAUDE_CONFIG_DIR: configDir } };
      ctx.runtime.sessionId = "sess_abc";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--resume");
      expect(claudeArgs).toContain("sess_abc");
    });

    it("adds --resume when configured model matches session model", () => {
      const configDir = createClaudeConfigDirWithSession("sess_abc");
      tempDirs.push(configDir);
      ctx.config = {
        model: "claude-sonnet-4-6[1m]",
        env: { CLAUDE_CONFIG_DIR: configDir },
      };
      ctx.runtime.sessionParams = {
        sessionId: "sess_abc",
        model: "claude-sonnet-4-6[1m]",
      };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--resume");
      expect(claudeArgs).toContain("sess_abc");
    });

    it("starts a fresh Claude session when configured model differs from session model", () => {
      const configDir = createClaudeConfigDirWithSession("sess_abc");
      tempDirs.push(configDir);
      ctx.config = {
        model: "claude-sonnet-4-6[1m]",
        instructionsFilePath: "/paperclip/instructions.md",
        env: { CLAUDE_CONFIG_DIR: configDir },
      };
      ctx.runtime.sessionParams = {
        sessionId: "sess_abc",
        model: "claude-sonnet-4-5",
      };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--resume");
      expect(claudeArgs).not.toContain("sess_abc");
      expect(claudeArgs).toContain("--append-system-prompt-file");
    });

    it("starts a fresh Claude session when configured model has no recorded session model", () => {
      const configDir = createClaudeConfigDirWithSession("sess_abc");
      tempDirs.push(configDir);
      ctx.config = {
        model: "claude-sonnet-4-6[1m]",
        instructionsFilePath: "/paperclip/instructions.md",
        env: { CLAUDE_CONFIG_DIR: configDir },
      };
      ctx.runtime.sessionParams = { sessionId: "sess_abc" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--resume");
      expect(claudeArgs).not.toContain("sess_abc");
      expect(claudeArgs).toContain("--append-system-prompt-file");
    });

    it("starts a fresh Claude session when runtime sessionId has no local Claude session file", () => {
      const configDir = mkdtempSync(join(tmpdir(), "claude-k8s-session-missing-"));
      tempDirs.push(configDir);
      ctx.config = {
        instructionsFilePath: "/paperclip/instructions.md",
        env: { CLAUDE_CONFIG_DIR: configDir },
      };
      ctx.runtime.sessionId = "a24fcff7-99a3-43ad-b0d0-1e145827369c";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--resume");
      expect(claudeArgs).not.toContain("a24fcff7-99a3-43ad-b0d0-1e145827369c");
      expect(claudeArgs).toContain("--append-system-prompt-file");
      expect(claudeArgs).toContain("/paperclip/instructions.md");
    });

    it("adds --dangerously-skip-permissions by default", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--dangerously-skip-permissions");
    });

    it("adds --append-system-prompt-file (config fallback) when instructionsFilePath set and no session", () => {
      ctx.config = { instructionsFilePath: "/paperclip/instructions.md" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--append-system-prompt-file");
      expect(claudeArgs).toContain("/paperclip/instructions.md");
    });

    it("omits --append-system-prompt-file on session resume (avoids token waste)", () => {
      const configDir = createClaudeConfigDirWithSession("sess_existing");
      tempDirs.push(configDir);
      ctx.config = {
        instructionsFilePath: "/paperclip/instructions.md",
        env: { CLAUDE_CONFIG_DIR: configDir },
      };
      ctx.runtime.sessionId = "sess_existing";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--append-system-prompt-file");
    });

    it("adds --add-dir when promptBundle is provided", () => {
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: null,
      };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).toContain("--add-dir");
      expect(claudeArgs).toContain(promptBundle.addDir);
    });

    it("uses bundle instructionsFilePath for --append-system-prompt-file when promptBundle provided", () => {
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123/agent-instructions.md",
      };
      ctx.config = { instructionsFilePath: "/raw/path/AGENTS.md" };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).toContain("--append-system-prompt-file");
      const idx = claudeArgs.indexOf("--append-system-prompt-file");
      expect(claudeArgs[idx + 1]).toBe(promptBundle.instructionsFilePath);
      expect(claudeArgs).not.toContain("/raw/path/AGENTS.md");
    });

    it("omits --append-system-prompt-file from bundle on session resume", () => {
      const configDir = createClaudeConfigDirWithSession("sess_existing");
      tempDirs.push(configDir);
      const promptBundle = {
        bundleKey: "abc123",
        rootDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        addDir: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123",
        instructionsFilePath: "/paperclip/instances/default/companies/co1/claude-prompt-cache/abc123/agent-instructions.md",
      };
      ctx.config = { env: { CLAUDE_CONFIG_DIR: configDir } };
      ctx.runtime.sessionId = "sess_existing";
      const { claudeArgs } = buildJobManifest({ ctx, selfPod, promptBundle });
      expect(claudeArgs).not.toContain("--append-system-prompt-file");
      // --add-dir must still be present even on resume
      expect(claudeArgs).toContain("--add-dir");
    });

    it("omits --add-dir when no promptBundle", () => {
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).not.toContain("--add-dir");
    });

    it("appends extraArgs when configured", () => {
      ctx.config = { extraArgs: ["--no-input", "--verbose"] };
      const { claudeArgs } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--no-input");
      expect(claudeArgs).toContain("--verbose");
    });
  });

  describe("prompt rendering", () => {
    it("includes agent name in default prompt template", () => {
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toContain("Test Agent");
    });

    it("uses custom promptTemplate when set", () => {
      ctx.config = { promptTemplate: "You are a helpful assistant." };
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toBe("You are a helpful assistant.");
    });

    it("includes workspace context in prompt when available", () => {
      ctx.context = {
        paperclipWorkspace: {
          cwd: "/project",
          strategy: "read-only",
          workspaceId: "ws1",
          repoUrl: "https://github.com/org/repo",
          branchName: "main",
        },
      };
      const { prompt } = buildJobManifest({ ctx, selfPod });
      expect(prompt).toContain("Test Agent");
    });

    it("returns promptMetrics with char counts", () => {
      const { promptMetrics } = buildJobManifest({ ctx, selfPod });
      expect(promptMetrics.promptChars).toBeGreaterThan(0);
      expect(typeof promptMetrics.promptChars).toBe("number");
    });
  });

  describe("serviceAccountName", () => {
    it("sets custom serviceAccountName when configured", () => {
      ctx.config = { serviceAccountName: "paperclip-agent" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBe("paperclip-agent");
    });

    it("echoes the resolved serviceAccountName on the result for log/manifest discoverability", () => {
      ctx.config = { serviceAccountName: "paperclip-agent" };
      const { serviceAccountName } = buildJobManifest({ ctx, selfPod });
      expect(serviceAccountName).toBe("paperclip-agent");
    });

    it("falls back to PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME when the per-agent value is unset", () => {
      process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME = "paperclip";
      const { job, serviceAccountName } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBe("paperclip");
      expect(serviceAccountName).toBe("paperclip");
    });

    it("prefers the per-agent serviceAccountName over the fleet default", () => {
      process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME = "paperclip";
      ctx.config = { serviceAccountName: "paperclip-agent" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBe("paperclip-agent");
    });

    // Both `.trim()` calls in resolveServiceAccountName are load-bearing:
    // serviceAccountName is a `type: "text"` field, so a whitespace-only value
    // is reachable from the UI form, and a bare `||` would pass it straight
    // through as a Job SA name the API server rejects.
    it("treats a whitespace-only per-agent serviceAccountName as unset and falls back to the fleet default", () => {
      process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME = "paperclip";
      ctx.config = { serviceAccountName: "   " };
      const { job, serviceAccountName } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.serviceAccountName).toBe("paperclip");
      expect(serviceAccountName).toBe("paperclip");
    });

    it("refuses to build the manifest when both the per-agent value and the fleet default are whitespace-only", () => {
      process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME = "  ";
      ctx.config = { serviceAccountName: "  " };
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/serviceAccountName/);
    });

    it("refuses to build the manifest — never silently lands on the namespace `default` ServiceAccount — when neither serviceAccountName nor the fleet default is set", () => {
      delete process.env.PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME;
      expect(() => buildJobManifest({ ctx, selfPod })).toThrow(/serviceAccountName/);
    });
  });

  describe("namespace", () => {
    it("uses selfPod namespace by default", () => {
      const { namespace } = buildJobManifest({ ctx, selfPod });
      expect(namespace).toBe("paperclip");
    });

    it("uses configured namespace override", () => {
      ctx.config = { namespace: "agents" };
      const { namespace, job } = buildJobManifest({ ctx, selfPod });
      expect(namespace).toBe("agents");
      expect(job.metadata?.namespace).toBe("agents");
    });
  });

  describe("return value", () => {
    it("returns job, jobName, namespace, prompt, claudeArgs, promptMetrics, promptSecret", () => {
      const result = buildJobManifest({ ctx, selfPod });
      expect(result.job).toBeDefined();
      expect(result.jobName).toBeDefined();
      expect(result.namespace).toBeDefined();
      expect(result.prompt).toBeDefined();
      expect(result.claudeArgs).toBeDefined();
      expect(result.promptMetrics).toBeDefined();
      expect(result.promptSecret).toBeNull();
    });
  });

  describe("nodeSelector key=value parsing", () => {
    it("parses key=value multiline text", () => {
      ctx.config = { nodeSelector: "disktype=ssd\ntopology.kubernetes.io/zone=us-east-1a" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({
        disktype: "ssd",
        "topology.kubernetes.io/zone": "us-east-1a",
      });
    });

    it("still accepts JSON objects", () => {
      ctx.config = { nodeSelector: { disktype: "ssd" } };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });

    it("parses JSON string format", () => {
      ctx.config = { nodeSelector: '{"disktype":"ssd"}' };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });

    it("skips comment lines and blank lines", () => {
      ctx.config = { nodeSelector: "# comment\n\ndisktype=ssd\n" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.spec?.template?.spec?.nodeSelector).toEqual({ disktype: "ssd" });
    });
  });

  describe("labels key=value parsing", () => {
    it("parses key=value multiline text for extra labels", () => {
      ctx.config = { labels: "env=prod\nteam=platform" };
      const { job } = buildJobManifest({ ctx, selfPod });
      expect(job.metadata?.labels?.env).toBe("prod");
      expect(job.metadata?.labels?.team).toBe("platform");
    });
  });

  describe("large prompt Secret fallback", () => {
    it("returns null promptSecret for small prompts", () => {
      const { promptSecret } = buildJobManifest({ ctx, selfPod });
      expect(promptSecret).toBeNull();
    });

    it("returns promptSecret for prompts >256 KiB", () => {
      // Build a prompt >256 KiB via a custom template
      const largePrompt = "x".repeat(300 * 1024);
      ctx.config = { promptTemplate: largePrompt };
      const { promptSecret, job } = buildJobManifest({ ctx, selfPod });
      expect(promptSecret).not.toBeNull();
      expect(promptSecret!.data["prompt.txt"]).toBe(largePrompt);
      // Init container should copy from secret volume, not use PROMPT_CONTENT env
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.command).toContainEqual(expect.stringContaining("cp"));
      expect(init?.env).toBeUndefined();
      // Should have prompt-secret volume
      const secretVol = job.spec?.template?.spec?.volumes?.find((v) => v.name === "prompt-secret");
      expect(secretVol?.secret?.secretName).toBe(promptSecret!.name);
    });

    it("uses env var init container for small prompts", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const init = job.spec?.template?.spec?.initContainers?.[0];
      expect(init?.env?.[0]?.name).toBe("PROMPT_CONTENT");
    });
  });

  describe("pod log file tailing", () => {
    it("adds ccrotate preflight but does not add rtk when enableRtk is false (default)", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command;
      // Command should refresh Claude auth via `next` only (no pre-snap;
      // claude-code's Stop hook handles end-of-session snap and pre-snap
      // raced with another concurrent Job's `next` mid-write — see
      // ccrotateRefresh comment). Then `cat ... | claude ... | tee ... |
      // <fail-fast awk> > /dev/null` so a terminal rate-limit event
      // unwinds the pipeline non-zero (RCA 2026-05-06). The PEN-1305 env-guard
      // setup is installed first (after `set -o pipefail`, before the ccrotate
      // preflight) so the PreToolUse hook is in place before Claude launches.
      const command = cmd?.[2] ?? "";
      expect(command).toMatch(/^set -o pipefail;/);
      expect(command).toMatch(/\(command -v ccrotate .*ccrotate next --yes --target claude.*\) \|\| true/);
      expect(command).toMatch(/cat \/tmp\/prompt\/prompt\.txt \| claude .* \| tee .* \| awk .* > \/dev\/null$/);
      expect(command.indexOf("paperclip-env-guard.mjs")).toBeLessThan(command.indexOf("ccrotate next"));
      expect(command.indexOf("ccrotate next")).toBeLessThan(command.indexOf("mkdir -p '/paperclip/instances/default/data/run-logs"));
      expect(command.indexOf("mkdir -p '/paperclip/instances/default/data/run-logs")).toBeLessThan(command.indexOf("cat /tmp/prompt/prompt.txt"));
      expect(command).not.toContain("ccrotate snap");
      expect(command).not.toContain("rtk-filter");
    });

    it("includes fail-fast awk for `out_of_credits` overage rejection (RCA 2026-05-06)", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      // Both substring matches must be present in the awk pattern so
      // we exit only on the specific terminal combination, not on
      // every `rate_limit_event` (most of which are informational
      // "allowed" status events with overage available).
      expect(cmd).toContain('"overageStatus":"rejected"');
      expect(cmd).toContain('"overageDisabledReason":"out_of_credits"');
      expect(cmd).toContain("[wrapper] terminal rate-limit");
      expect(cmd).toContain("exit 1");
      // Ordering matters — awk must run after `tee` so the trigger
      // event is persisted to the pod log before pipefail unwinds.
      expect(cmd.indexOf("tee ")).toBeLessThan(cmd.indexOf("awk "));
    });

    it("appends --accounts <csv> to ccrotate next when providers.anthropic.accounts is populated", () => {
      ctx.config = {
        providers: {
          anthropic: {
            accounts: ["a@b.net", "c@d.net"],
          },
        },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("ccrotate next --yes --target claude --accounts 'a@b.net,c@d.net'");
    });

    // The pool is operator config interpolated into the main container's
    // `sh -c` string. Unquoted, an account carrying shell syntax runs as its
    // own command *before* claude starts — i.e. ahead of the PreToolUse
    // env-guard — so `env` there would dump the pod's inherited credentials to
    // the log. Validation drops it; quoting is the backstop.
    it("does not let shell metacharacters in an account become a command", () => {
      ctx.config = {
        providers: {
          anthropic: {
            accounts: ["a@example.test; env; #", "b@example.test"],
          },
        },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      // The injected payload is gone entirely, and the surviving account is
      // still passed through.
      expect(cmd).not.toContain("; env; #");
      expect(cmd).toContain("--accounts 'b@example.test'");
      // ccrotate remains a single command: nothing escaped the segment.
      expect(cmd).toMatch(/\(command -v ccrotate .*ccrotate next --yes --target claude --accounts '[^']*'.*\) \|\| true/);
    });

    it("shell-quotes the accounts value so a quote cannot break out", () => {
      ctx.config = {
        providers: { anthropic: { accounts: ["ok@example.test"] } },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("--accounts 'ok@example.test'");
    });

    it("skips rotation entirely when a configured account pool has no valid entry (fail closed)", () => {
      // This test previously asserted the OPPOSITE — that we fall back to global
      // rotation. That was fail-*open*: an operator who scoped this environment
      // to a specific pool would silently get ccrotate's global rotation and
      // consume credentials from outside the pool they asked for, on nothing
      // worse than a config typo. Absent config and invalid config are different
      // things; only the former means "global rotation is intended".
      ctx.config = {
        providers: { anthropic: { accounts: ["$(id)", "`id`", "a; rm -rf /"] } },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).not.toContain("ccrotate next");
      expect(cmd).not.toContain("--accounts");
      // The injection payloads must not survive into the command in any form.
      expect(cmd).not.toContain("rm -rf /");
      expect(cmd).not.toContain("$(id)");
      expect(cmd).not.toContain("`id`");
      // Operators need to know why rotation was skipped, or this is a silent no-op.
      // The message names the config key, so the reason is actionable without
      // reading this source.
      expect(cmd).toContain("no entry in providers.anthropic.accounts is a valid account identifier");
      expect(cmd).toContain("skipping ccrotate rather than falling back to global rotation");
    });

    // Round 6: the fail-closed branch above only fired for a well-formed ARRAY
    // whose entries all failed validation. A configured pool of the wrong SHAPE
    // took a different path: `Array.isArray(...) ? ... : null` collapsed it to
    // the same `null` used for "absent", so it read as "no pool configured" and
    // selected unrestricted GLOBAL rotation — the exact widening this block
    // exists to prevent, reachable by the single likeliest typo (`accounts:
    // "a@b.test"` as a bare string instead of a list).
    //
    // `parseObject` returns `{}` for any non-object, so `providers.anthropic`
    // has the identical failure mode one level up; both levels are covered here.
    for (const [label, providers] of [
      ["accounts is a bare string", { anthropic: { accounts: "a@example.test" } }],
      ["accounts is a comma string", { anthropic: { accounts: "a@example.test,b@example.test" } }],
      ["accounts is an object", { anthropic: { accounts: { primary: "a@example.test" } } }],
      ["accounts is a number", { anthropic: { accounts: 42 } }],
      ["accounts is a boolean", { anthropic: { accounts: true } }],
      ["anthropic is a string", { anthropic: "a@example.test" }],
      ["anthropic is an array", { anthropic: ["a@example.test"] }],
    ] as ReadonlyArray<readonly [string, Record<string, unknown>]>) {
      it(`skips rotation instead of widening to global when ${label} (fail closed)`, () => {
        ctx.config = { providers };
        const { job } = buildJobManifest({ ctx, selfPod });
        const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
        // The load-bearing assertion: a malformed pool must NOT reach the
        // unrestricted global-rotation command.
        expect(cmd).not.toContain("ccrotate next");
        expect(cmd).not.toContain("--accounts");
        expect(cmd).toContain("skipping ccrotate rather than falling back to global rotation");
        expect(cmd).toContain("must be an");
        // The offending value is never echoed: this config sits next to
        // credential material and the message lands in the pod log.
        expect(cmd).not.toContain("a@example.test");
      });
    }

    it("treats an explicitly empty pool as configured-but-unusable, not as absent", () => {
      // `accounts: []` is a deliberate statement that no account is eligible.
      // Widening that to every account on the box is the same fail-open in
      // miniature, so it skips rotation rather than falling back to global.
      ctx.config = { providers: { anthropic: { accounts: [] } } };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).not.toContain("ccrotate next");
      expect(cmd).toContain("empty list");
    });

    it("still takes the global-rotation path when accounts is explicitly null/undefined", () => {
      // Absent really does mean absent — an operator writing `null` is saying
      // "no pool", which is the documented default, not a malformed value.
      for (const accounts of [null, undefined]) {
        ctx.config = { providers: { anthropic: { accounts } } };
        const { job } = buildJobManifest({ ctx, selfPod });
        const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
        expect(cmd).toContain("ccrotate next --yes --target claude");
        expect(cmd).not.toContain("--accounts");
      }
    });

    it("does not add --accounts when providers is undefined (global rotation path)", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("ccrotate next --yes --target claude");
      expect(cmd).not.toContain("--accounts");
    });

    it("does not add --accounts when providers has only openai (wrong key for claude)", () => {
      ctx.config = {
        providers: {
          openai: {
            accounts: ["x@y.net"],
          },
        },
      };
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("ccrotate next --yes --target claude");
      expect(cmd).not.toContain("--accounts");
    });

    it("command includes tee to pod log path", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const cmd = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      expect(cmd).toContain("| tee");
      expect(cmd).toContain("/paperclip/instances/default/data/run-logs/");
    });

    it("podLogPath is returned from buildJobManifest", () => {
      const result = buildJobManifest({ ctx, selfPod });
      expect(result.podLogPath).toBe(
        "/paperclip/instances/default/data/run-logs/co1/agent-abc/run-abc12345.pod.ndjson",
      );
    });

    it("buildPodLogPath returns correctly formatted path", () => {
      expect(buildPodLogPath("co1", "agent-abc", "run-abc12345")).toBe(
        "/paperclip/instances/default/data/run-logs/co1/agent-abc/run-abc12345.pod.ndjson",
      );
    });

    it("main container creates the pod log directory before tee", () => {
      const { job } = buildJobManifest({ ctx, selfPod });
      const command = job.spec?.template?.spec?.containers[0]?.command?.[2] ?? "";
      const mkdir = "mkdir -p '/paperclip/instances/default/data/run-logs/co1/agent-abc'";
      const tee = "tee '/paperclip/instances/default/data/run-logs/co1/agent-abc/run-abc12345.pod.ndjson'";
      expect(command).toContain(mkdir);
      expect(command).toContain(tee);
      expect(command.indexOf(mkdir)).toBeLessThan(command.indexOf(tee));
    });

    it("sanitizes companyId with / to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        agent: { ...ctx.agent, companyId: "co/1" },
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // / is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("co1/");
    });

    it("sanitizes agentId with @ to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        agent: { ...ctx.agent, id: "agent@123" },
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // @ is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("/agent123/");
    });

    it("sanitizes runId with underscore to valid path component for log path", () => {
      const badCtx = {
        ...ctx,
        runId: "run_123",
      };
      const { podLogPath } = buildJobManifest({ ctx: badCtx as typeof ctx, selfPod });
      // _ is stripped by sanitizeForK8sPath
      expect(podLogPath).toContain("/run123.pod.ndjson");
    });
  });
});

describe("sanitizeLabelValue", () => {
  it("passes through already-valid UUIDs and slugs", () => {
    expect(sanitizeLabelValue("abc-123-def")).toBe("abc-123-def");
    expect(sanitizeLabelValue("0d8b4472-c42c-4052-aab1-e32897909afa")).toBe("0d8b4472-c42c-4052-aab1-e32897909afa");
  });

  it("strips characters outside [a-zA-Z0-9._-]", () => {
    expect(sanitizeLabelValue("task:xyz/123")).toBe("taskxyz123");
    expect(sanitizeLabelValue("abc 123")).toBe("abc123");
  });

  it("trims leading/trailing non-alphanumeric characters", () => {
    expect(sanitizeLabelValue("--abc--")).toBe("abc");
    expect(sanitizeLabelValue("...123...")).toBe("123");
  });

  it("truncates to the configured maxLen", () => {
    const long = "a".repeat(200);
    const out = sanitizeLabelValue(long, 63);
    expect(out?.length).toBe(63);
  });

  it("returns null when no alphanumeric characters remain", () => {
    expect(sanitizeLabelValue("---")).toBeNull();
    expect(sanitizeLabelValue("")).toBeNull();
    expect(sanitizeLabelValue("   ")).toBeNull();
  });
});

describe("per-agent mcp.json layering", () => {
  let ctx: AdapterExecutionContext;
  let selfPod: SelfPodInfo;

  beforeEach(() => {
    ctx = makeCtx();
    selfPod = makeSelfPod();
    process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH = "";
  });

  it("does not inject --mcp-config when adapterConfig.mcpServers is empty", () => {
    const { claudeArgs, job, mcpConfigSecret } = buildJobManifest({ ctx, selfPod });
    expect(claudeArgs).not.toContain("--mcp-config");
    expect(claudeArgs).not.toContain("--strict-mcp-config");
    const init = job.spec!.template.spec!.initContainers![0];
    const initEnvNames = (init.env ?? []).map((e) => e.name);
    expect(initEnvNames).not.toContain("MCP_CONFIG");
    expect(mcpConfigSecret).toBeNull();
  });

  it("ships the shared baseline even when adapterConfig.mcpServers is empty, via a Secret-backed volume rather than a literal env var (BLO-17980)", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-k8s-mcp-"));
    const baselinePath = join(dir, ".mcp.json");
    try {
      writeFileSync(
        baselinePath,
        JSON.stringify({
          mcpServers: {
            paperclip: {
              command: "node",
              args: ["/app/packages/mcp-server/dist/stdio.js"],
            },
          },
        }),
      );
      process.env.PAPERCLIP_SHARED_MCP_BASELINE_PATH = baselinePath;

      const { claudeArgs, job, mcpConfigSecret } = buildJobManifest({ ctx, selfPod });
      expect(claudeArgs).toContain("--mcp-config");
      expect(claudeArgs).toContain("/tmp/prompt/mcp.json");
      expect(claudeArgs).toContain("--strict-mcp-config");

      const init = job.spec!.template.spec!.initContainers![0];
      const initEnvNames = (init.env ?? []).map((e) => e.name);
      expect(initEnvNames).not.toContain("MCP_CONFIG");

      expect(mcpConfigSecret).not.toBeNull();
      const parsed = JSON.parse(mcpConfigSecret!.data["mcp.json"]) as {
        mcpServers: Record<string, { command?: string; args?: string[] }>;
      };
      expect(parsed.mcpServers.paperclip).toEqual({
        command: "node",
        args: ["/app/packages/mcp-server/dist/stdio.js"],
      });

      // The Secret is mounted read-only and copied into the shared prompt emptyDir
      const volumes = job.spec!.template.spec!.volumes ?? [];
      const secretVolume = volumes.find((v) => v.name === "mcp-config-secret");
      expect(secretVolume?.secret?.secretName).toBe(mcpConfigSecret!.name);
      const initMount = (init.volumeMounts ?? []).find((m) => m.name === "mcp-config-secret");
      expect(initMount?.mountPath).toBe("/tmp/mcp-secret");
      expect(initMount?.readOnly).toBe(true);
      const initCmd = (init.command ?? []).join(" ");
      expect(initCmd).toContain("cp /tmp/mcp-secret/mcp.json /tmp/prompt/mcp.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges per-agent overrides on top of the shared baseline and ships --mcp-config + --strict-mcp-config, staging mcp.json as a Secret instead of a literal env var (BLO-17980)", () => {
    ctx = makeCtx({
      config: {
        mcpServers: {
          kubernetes: {
            type: "sse",
            url: "http://kubernetes-mcp-server-admin.paperclip.svc.cluster.local:8080/sse",
          },
          figma: {
            type: "http",
            url: "http://figma-mcp-server.paperclip.svc.cluster.local:8080/mcp",
          },
        },
      },
    });
    const { claudeArgs, job, mcpConfigSecret } = buildJobManifest({ ctx, selfPod });
    expect(claudeArgs).toContain("--mcp-config");
    expect(claudeArgs).toContain("/tmp/prompt/mcp.json");
    expect(claudeArgs).toContain("--strict-mcp-config");

    const init = job.spec!.template.spec!.initContainers![0];
    const initEnvNames = (init.env ?? []).map((e) => e.name);
    expect(initEnvNames).not.toContain("MCP_CONFIG");

    expect(mcpConfigSecret).not.toBeNull();
    const parsed = JSON.parse(mcpConfigSecret!.data["mcp.json"]) as {
      mcpServers: Record<string, { type?: string; url?: string }>;
    };
    // Per-agent overrides land verbatim
    expect(parsed.mcpServers.kubernetes).toEqual({
      type: "sse",
      url: "http://kubernetes-mcp-server-admin.paperclip.svc.cluster.local:8080/sse",
    });
    expect(parsed.mcpServers.figma).toEqual({
      type: "http",
      url: "http://figma-mcp-server.paperclip.svc.cluster.local:8080/mcp",
    });
    // The init shell command copies the file from the mounted Secret volume, never printf's a literal value
    const initCmd = (init.command ?? []).join(" ");
    expect(initCmd).toContain("cp /tmp/mcp-secret/mcp.json /tmp/prompt/mcp.json");
    expect(initCmd).not.toContain("MCP_CONFIG");
  });

  it("never leaks an mcpServers Authorization header into any literal env value on any container (BLO-17980/BLO-17973 regression)", () => {
    ctx = makeCtx({
      config: {
        mcpServers: {
          gbrain: {
            url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
            type: "http",
            headers: { Authorization: "Bearer gbrain_at_test-token-should-never-leak" },
          },
        },
      },
    });
    const { job, mcpConfigSecret } = buildJobManifest({ ctx, selfPod });
    const allContainers = [
      ...(job.spec!.template.spec!.initContainers ?? []),
      ...job.spec!.template.spec!.containers,
    ];
    for (const c of allContainers) {
      for (const e of c.env ?? []) {
        expect(e.value ?? "").not.toContain("gbrain_at_test-token-should-never-leak");
      }
    }
    // The header only lives in the Secret payload, never inline in the Job spec.
    expect(mcpConfigSecret!.data["mcp.json"]).toContain("gbrain_at_test-token-should-never-leak");
  });
});

describe("paperclipTaskMarkdown surfacing", () => {
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Server-side heartbeat composes context.paperclipTaskMarkdown for wakes
  // that carry first-class task context (notably PR-review wakes via the
  // github webhook handler, which set contextSnapshot.githubPrNumber +
  // githubRepoFullName but never produce a paperclipWake because there's
  // no issue tied to the PR). Without this prompt slot, the PR review
  // agent reaches the pod with NO information about which PR to review.
  //
  // See:
  //   - server/services/heartbeat.ts buildPaperclipTaskMarkdown
  //   - server/routes/github-webhook.ts (the wake call that sets
  //     contextSnapshot.githubPrNumber + reviewKind)
  it("includes context.paperclipTaskMarkdown in the assembled prompt", () => {
    const taskMd = [
      "Paperclip task context:",
      "- PR: \"Blockcast/paperclip#59\"",
      "- Wake reason: \"github_pr_opened\"",
      "",
      "GitHub PR review directive:",
      "A GitHub webhook woke you to review this pull request.",
    ].join("\n");
    const ctx = makeCtx({ context: { paperclipTaskMarkdown: taskMd } });
    const result = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    expect(result.prompt).toContain("Blockcast/paperclip#59");
    expect(result.prompt).toContain("github_pr_opened");
    expect(result.prompt).toContain("GitHub PR review directive");
    expect(result.promptMetrics.taskMarkdownChars).toBe(taskMd.length);
  });

  it("does NOT inject anything when paperclipTaskMarkdown is absent (no spurious newlines)", () => {
    const result = buildJobManifest({ ctx: makeCtx(), selfPod: makeSelfPod() });
    expect(result.promptMetrics.taskMarkdownChars).toBe(0);
  });

  it("trims surrounding whitespace from paperclipTaskMarkdown before inclusion", () => {
    const taskMd = "\n\n  GitHub PR review directive:\n  ...\n\n";
    const ctx = makeCtx({ context: { paperclipTaskMarkdown: taskMd } });
    const result = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    expect(result.promptMetrics.taskMarkdownChars).toBe(taskMd.trim().length);
    expect(result.prompt).toContain("GitHub PR review directive");
  });

  // The whole point of inserting `taskMarkdown` at a *specific* position
  // is so the agent reads task context (what to work on) after wake
  // context (why it woke) but before the session handoff narrative
  // (which may reference the task). A position-blind .toContain check
  // would silently accept a reorder; this test pins the contract.
  it("places taskMarkdown after wakePrompt and before sessionHandoffNote", () => {
    // claude-k8s has a local minimal renderPaperclipWakePrompt that only
    // emits "Wake reason: <reason>" lines (no issue identifier), so the
    // wake sentinel must live in the `reason` field rather than
    // `issue.identifier`.
    const ctx = makeCtx({
      context: {
        paperclipWake: {
          reason: "WAKE_SENTINEL_REASON",
          issue: { id: "x", identifier: "BLO-X", title: "t" },
        },
        paperclipTaskMarkdown: "TASK-SENTINEL paperclipTaskMarkdown body",
        paperclipSessionHandoffMarkdown: "HANDOFF-SENTINEL paperclipSessionHandoffMarkdown body",
      },
    });
    const result = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    const wakeIdx = result.prompt.indexOf("WAKE_SENTINEL_REASON");
    const taskIdx = result.prompt.indexOf("TASK-SENTINEL");
    const handoffIdx = result.prompt.indexOf("HANDOFF-SENTINEL");
    expect(wakeIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(wakeIdx);
    expect(handoffIdx).toBeGreaterThan(taskIdx);
  });

  // PR-review wakes overwhelmingly arrive WITH a resumed session: the
  // reviewer agent keeps a long-running claude session across wakes. The
  // resume-delta gate `Boolean(runtimeSessionId) && wakePrompt.length > 0`
  // evaluates to `false` for that shape (paperclipWake is null when
  // there's no issue tied to the PR), so `renderedPrompt` is NOT
  // suppressed — the agent gets the full bootstrap + the PR directive.
  // This test pins that behavior so a future refactor (e.g. gating
  // resume-delta on `taskMarkdown.length > 0`) doesn't silently land.
  it("does not gate resume-delta on taskMarkdown (PR-review wake shape: resumed session + no paperclipWake)", () => {
    const configDir = createClaudeConfigDirWithSession("ses_pr_review");
    tempDirs.push(configDir);
    const ctx = makeCtx({
      config: { env: { CLAUDE_CONFIG_DIR: configDir } },
      runtime: {
        sessionId: "ses_pr_review",
        sessionParams: { sessionId: "ses_pr_review" },
        sessionDisplayId: "ses_pr_review",
        taskKey: null,
      },
      context: {
        paperclipTaskMarkdown: "GitHub PR review directive: review PR #59",
      },
    });
    const result = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    expect(result.prompt).toContain("GitHub PR review directive");
    expect(result.promptMetrics.taskMarkdownChars).toBeGreaterThan(0);
    // wakePrompt is empty (no paperclipWake) → resume-delta gate is OFF
    // → heartbeat prompt template still renders.
    expect(result.promptMetrics.wakePromptChars).toBe(0);
    expect(result.promptMetrics.heartbeatPromptChars).toBeGreaterThan(0);
  });

  // The complementary shape: issue-wake with both paperclipWake AND
  // paperclipTaskMarkdown set, on a resumed session. Resume-delta DOES
  // engage (wakePrompt > 0), so `renderedPrompt` IS suppressed — but
  // taskMarkdown must survive the suppression.
  it("preserves taskMarkdown even when resume-delta suppresses the heartbeat prompt", () => {
    const configDir = createClaudeConfigDirWithSession("ses_issue_wake");
    tempDirs.push(configDir);
    const ctx = makeCtx({
      config: { env: { CLAUDE_CONFIG_DIR: configDir } },
      runtime: {
        sessionId: "ses_issue_wake",
        sessionParams: { sessionId: "ses_issue_wake" },
        sessionDisplayId: "ses_issue_wake",
        taskKey: null,
      },
      context: {
        paperclipWake: {
          reason: "issue_assigned",
          issue: { id: "iw", identifier: "BLO-1234", title: "t" },
        },
        paperclipTaskMarkdown: "Paperclip task context:\n- Issue: BLO-1234",
      },
    });
    const result = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    expect(result.prompt).toContain("Paperclip task context");
    expect(result.promptMetrics.taskMarkdownChars).toBeGreaterThan(0);
    expect(result.promptMetrics.wakePromptChars).toBeGreaterThan(0);
    expect(result.promptMetrics.heartbeatPromptChars).toBe(0);
  });
});

describe("fail-closed sensitive-env guard covers every container on the pod", () => {
  // BLO-21593 review finding: the guard used to enumerate the envVars/initEnv
  // locals, so the DinD sidecar — whose env is built inside buildDindSidecar()
  // and never flows through those locals — silently bypassed it. These pin the
  // check to the assembled pod spec instead.

  it("flags a sensitive literal in a sidecar container, not just the main one", () => {
    const podSpec = {
      initContainers: [
        { name: "write-prompt", env: [{ name: "PROMPT_FILE", value: "/tmp/p" }] },
        { name: "dind", env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }, { name: "REGISTRY_TOKEN", value: "leaked" }] },
      ],
      containers: [{ name: "claude", env: [{ name: "AWS_REGION", value: "us-east-1" }] }],
    } as unknown as Parameters<typeof findLiteralSensitiveEnvVarsInPodSpec>[0];

    // The old per-array check, applied to the main container's env only, sees nothing.
    expect(findLiteralSensitiveEnvVars(podSpec.containers![0].env ?? [])).toEqual([]);
    // The pod-spec-wide check catches it, and names the offending container.
    expect(findLiteralSensitiveEnvVarsInPodSpec(podSpec)).toEqual(["dind/REGISTRY_TOKEN"]);
  });

  it("ignores the sidecar's non-sensitive literals", () => {
    const podSpec = {
      initContainers: [{ name: "dind", env: [{ name: "DOCKER_TLS_CERTDIR", value: "" }] }],
      containers: [{ name: "claude", env: [] }],
    } as unknown as Parameters<typeof findLiteralSensitiveEnvVarsInPodSpec>[0];
    expect(findLiteralSensitiveEnvVarsInPodSpec(podSpec)).toEqual([]);
  });

  it("guards the DinD sidecar that buildJobManifest actually assembles", () => {
    const ctx = makeCtx({ config: { enableDocker: true } });
    const { job } = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    const podSpec = job.spec!.template.spec!;
    // The sidecar is on the pod...
    expect(podSpec.initContainers!.map((c) => c.name)).toContain("dind");
    // ...and is inside the guard's field of view (it returns clean today).
    expect(findLiteralSensitiveEnvVarsInPodSpec(podSpec)).toEqual([]);
  });
});

/**
 * BLO-21858 (from the BLO-21593 review of adapter PR #31, probe 6).
 *
 * ANTHROPIC_CUSTOM_HEADERS carries arbitrary "Name: value" header lines that
 * Claude Code forwards on every Anthropic API call, so it can hold a literal
 * `Authorization:` header — but its name matches none of the six patterns in
 * SENSITIVE_ENV_NAME_RE, so before this fix it shipped as a literal
 * env[].value readable through a plain read-only `GET Pod` (BLO-17973).
 */
describe("ANTHROPIC_CUSTOM_HEADERS is always Secret-backed (BLO-21858)", () => {
  const HEADER = "Authorization: Bearer sk-leaked-via-a-header-line";

  it("never ships ANTHROPIC_CUSTOM_HEADERS as a literal env value on any container, even when set via adapterConfig.env", () => {
    const ctx = makeCtx({ config: { env: { ANTHROPIC_CUSTOM_HEADERS: HEADER } } });
    const { job, envSecret } = buildJobManifest({ ctx, selfPod: makeSelfPod() });
    const podSpec = job.spec!.template.spec!;
    const allContainers = [
      ...(podSpec.initContainers ?? []),
      ...(podSpec.containers ?? []),
      ...((podSpec.ephemeralContainers ?? []) as unknown as typeof podSpec.containers),
    ];

    // (a) the header text appears in no literal env value on any container.
    for (const c of allContainers) {
      for (const e of c.env ?? []) {
        expect(e.value ?? "").not.toContain("Authorization:");
        expect(e.value ?? "").not.toContain("sk-leaked-via-a-header-line");
      }
    }

    // (b) it is present as a secretKeyRef, and the value still reaches the
    //     container through the per-Job EnvSecret (AC4 — runs keep working).
    const entry = podSpec.containers![0].env!.find((e) => e.name === "ANTHROPIC_CUSTOM_HEADERS");
    expect(entry).toBeDefined();
    expect(entry!.value).toBeUndefined();
    expect(entry!.valueFrom?.secretKeyRef?.name).toBe(envSecret?.name);
    expect(entry!.valueFrom?.secretKeyRef?.key).toBe("ANTHROPIC_CUSTOM_HEADERS");
    expect(envSecret?.data.ANTHROPIC_CUSTOM_HEADERS).toContain(HEADER);
  });

  it("is treated as sensitive by name, case-insensitively, despite matching none of the six patterns", () => {
    // The negative control: it genuinely does not match the regex, so this is
    // the pinned-name path doing the work, not an accidental substring hit.
    expect(/(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH)/i.test("ANTHROPIC_CUSTOM_HEADERS")).toBe(false);
    expect(isSensitiveEnvName("ANTHROPIC_CUSTOM_HEADERS")).toBe(true);
    expect(isSensitiveEnvName("anthropic_custom_headers")).toBe(true);
    // Unrelated non-sensitive names stay literal (AC4 — no collateral).
    expect(isSensitiveEnvName("ANTHROPIC_BASE_URL")).toBe(false);
    expect(isSensitiveEnvName("ANTHROPIC_MODEL")).toBe(false);
  });

  it("the fail-closed guard flags a literal ANTHROPIC_CUSTOM_HEADERS if a future code path reintroduces one", () => {
    // buildJobManifest throws on any non-empty result from this function (see
    // the "refusing to build Job manifest" throw), so flagging here is the
    // rejection. Driven off a synthetic spec because the routing above makes
    // the literal unreachable through buildJobManifest today — which is the
    // point of a backstop.
    const podSpec = {
      initContainers: [{ name: "write-prompt", env: [{ name: "PROMPT_FILE", value: "/tmp/p" }] }],
      containers: [{ name: "claude", env: [{ name: "ANTHROPIC_CUSTOM_HEADERS", value: HEADER }] }],
    } as unknown as Parameters<typeof findLiteralSensitiveEnvVarsInPodSpec>[0];

    expect(findLiteralSensitiveEnvVarsInPodSpec(podSpec)).toEqual(["claude/ANTHROPIC_CUSTOM_HEADERS"]);
    expect(findLiteralSensitiveEnvVars(podSpec.containers![0].env ?? [])).toEqual(["ANTHROPIC_CUSTOM_HEADERS"]);
  });
});

/**
 * BLO-22514: agent Job pods used to inherit the paperclip server's entire secret
 * env, so any single agent could mint tokens as any other agent. The primary
 * control is the allowlist in getSelfPodInfo() (see inherit-allowlist.test.ts
 * and k8s-client.test.ts); these tests pin the invariant on the artifact this
 * file actually produces.
 *
 * Both directions are asserted deliberately. A test suite that only proved the
 * secrets are gone would pass just as happily if the filter dropped everything
 * and broke every agent run in the fleet.
 */
describe("buildJobManifest — server credential propagation (BLO-22514)", () => {
  const SERVER_ONLY = [
    "PAPERCLIP_AGENT_JWT_SECRET",
    "DATABASE_URL",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
    "PAPERCLIP_DEX_OIDC_CLIENT_SECRET",
    "PAPERCLIP_ALERTMANAGER_WEBHOOK_TOKEN",
  ];

  function agentEnvNames(job: ReturnType<typeof buildJobManifest>["job"]): string[] {
    const podSpec = job.spec!.template.spec!;
    return [
      ...(podSpec.initContainers ?? []),
      ...(podSpec.containers ?? []),
    ].flatMap((c) => (c.env ?? []).map((e) => e.name!));
  }

  it.each(SERVER_ONLY)("refuses to build a Job that would carry %s", (name) => {
    // SelfPodInfo is a plain object, so a caller (or a future code path) can put
    // a server credential in it without going through getSelfPodInfo's filter.
    // buildJobManifest must fail closed rather than emit the manifest.
    const selfPod = makeSelfPod({ inheritedEnv: { [name]: "leaked-value" } });
    expect(() => buildJobManifest({ ctx: makeCtx(), selfPod })).toThrow(
      /server-only credential env var\(s\) would be propagated/,
    );
  });

  it("fails closed on a secretKeyRef too, not just a literal value", () => {
    // A secretKeyRef hides the value from `GET Pod`, which is why an earlier
    // analysis called these "fine". The kubelet still resolves it into the
    // container env, so the agent reads it either way.
    const selfPod = makeSelfPod({
      inheritedEnvValueFrom: [
        {
          name: "PAPERCLIP_AGENT_JWT_SECRET",
          valueFrom: { secretKeyRef: { name: "paperclip-jwt", key: "secret" } },
        },
      ],
    });
    expect(() => buildJobManifest({ ctx: makeCtx(), selfPod })).toThrow(
      /server-only credential env var\(s\) would be propagated/,
    );
  });

  it("names the offending container and variable in the refusal", () => {
    const selfPod = makeSelfPod({ inheritedEnv: { DATABASE_URL: "postgres://leaked" } });
    expect(() => buildJobManifest({ ctx: makeCtx(), selfPod })).toThrow(/claude\/DATABASE_URL/);
  });

  it("still propagates every keep-set env var an agent depends on", () => {
    // The other half of the invariant: the filter must not have been "fixed" by
    // dropping everything. These are the names derived from the adapter's own
    // by-name reads plus deploy/helm/paperclip's agent-facing vars.
    const keep: Record<string, string> = {
      PAPERCLIP_API_URL: "http://paperclip-api.paperclip.svc:3000",
      CLAUDE_CONFIG_DIR: "/paperclip/.claude",
      PAPERCLIP_HOME: "/paperclip",
      PAPERCLIP_INSTANCE_ID: "default",
      PATH: "/usr/local/bin:/usr/bin",
      PAPERCLIP_GITHUB_TOKEN_FILE: "/paperclip/.secrets/github-token/token",
      ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
      OPENAI_BASE_URL: "https://api.penstock.run/openai",
    };
    const { job } = buildJobManifest({ ctx: makeCtx(), selfPod: makeSelfPod({ inheritedEnv: keep }) });
    const names = agentEnvNames(job);
    for (const name of Object.keys(keep)) {
      expect(names).toContain(name);
    }
  });

  it("carries an allowlisted provider credential through as a secretKeyRef", () => {
    // ANTHROPIC_AUTH_TOKEN is an *agent* credential: the agent cannot call a
    // model without it. It must survive the filter, while still being routed
    // away from a literal value by the existing BLO-17980 guard.
    const selfPod = makeSelfPod({
      inheritedEnvValueFrom: [
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          valueFrom: { secretKeyRef: { name: "paperclip-penstock-org-key", key: "token" } },
        },
      ],
    });
    const { job } = buildJobManifest({ ctx: makeCtx(), selfPod });
    expect(agentEnvNames(job)).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("builds clean from a realistic filtered SelfPodInfo", () => {
    // End-to-end sanity: the shape getSelfPodInfo actually returns post-filter
    // must still produce a manifest, and must trip neither guard.
    const selfPod = makeSelfPod({
      inheritedEnv: {
        PAPERCLIP_API_URL: "http://paperclip-api.paperclip.svc:3000",
        PATH: "/usr/local/bin:/usr/bin",
        ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
      },
      inheritedEnvValueFrom: [
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          valueFrom: { secretKeyRef: { name: "paperclip-penstock-org-key", key: "token" } },
        },
      ],
      secretVolumes: [
        {
          volumeName: "github-merge-token",
          secretName: "paperclip-github-merge-token",
          mountPath: "/paperclip/.secrets/github-merge-token",
          defaultMode: 0o444,
        },
      ],
    });
    const { job } = buildJobManifest({ ctx: makeCtx(), selfPod });
    const podSpec = job.spec!.template.spec!;
    expect(findServerOnlyEnvVarsInPodSpec(podSpec)).toEqual([]);
    expect(findLiteralSensitiveEnvVarsInPodSpec(podSpec)).toEqual([]);
    expect(podSpec.volumes!.map((v) => v.name)).toContain("github-merge-token");
  });
});

/**
 * BLO-29804 — the declare-or-fail gate on env classification.
 *
 * SENSITIVE_ENV_NAME_RE is fail-open against a credential-carrying variable
 * whose name doesn't match one of its six patterns; BLO-21858
 * (ANTHROPIC_CUSTOM_HEADERS) is the proof. Pinning names one at a time only
 * fixes the instances someone notices. These tests are the forcing function:
 * a new env var introduced in job-manifest.ts reddens CI in the pull request
 * that introduces it, naming the variable, and the author has to declare it
 * SECRET or SAFE_LITERAL rather than inheriting a default.
 */
describe("env name classification gate (BLO-29804)", () => {
  /**
   * Names the test itself injects through the three operator-supplied
   * channels. Their names are data, not code, so they cannot be pre-declared
   * in ENV_NAME_CLASSIFICATION; subtracting exactly what we supplied leaves
   * only code-originated names, which is what the table must cover.
   *
   * `inheritedEnv` is separately governed by AGENT_ENV_ALLOWLIST in
   * inherit-allowlist.ts — the same declare-or-refuse shape at that boundary.
   */
  const OPERATOR_CONFIG_ENV = {
    OPERATOR_TUNABLE: "some-value",
    OPERATOR_API_TOKEN: "should-be-secret-backed",
  };
  const OPERATOR_INHERITED_ENV = {
    PAPERCLIP_API_URL: "http://paperclip.paperclip.svc.cluster.local:3100",
    GH_TOKEN: "inherited-and-secret-backed",
  };
  const OPERATOR_VALUE_FROM = [
    { name: "INHERITED_VALUE_FROM_DEPLOYMENT", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
  ];

  const OPERATOR_SUPPLIED_NAMES = new Set([
    ...Object.keys(OPERATOR_CONFIG_ENV),
    ...Object.keys(OPERATOR_INHERITED_ENV),
    ...OPERATOR_VALUE_FROM.map((e) => e.name),
  ]);

  /**
   * A context populated on every optional field, so the conditional
   * setIfPresent branches in buildEnvVars all fire. A var that only appears
   * when, say, an approval wake supplies approvalId is still a var the table
   * has to classify.
   */
  function maximalCtx(config: Record<string, unknown>): AdapterExecutionContext {
    const ctx = makeCtx({
      authToken: "pk_test_token",
      context: {
        taskId: "task-1",
        issueId: "issue-1",
        wakeReason: "issue_assigned",
        wakeCommentId: "comment-1",
        commentId: "comment-1",
        approvalId: "approval-1",
        approvalStatus: "approved",
        issueIds: ["issue-1", "issue-2"],
        paperclipWake: { issue: { identifier: "BLO-1" }, comments: [] },
        paperclipWorkspace: {
          cwd: "/paperclip/workspace",
          source: "git_repo",
          strategy: "project_primary",
          workspaceId: "ws-1",
          repoUrl: "https://github.com/Blockcast/paperclip.git",
          repoRef: "master",
          branchName: "feature",
          worktreePath: "/paperclip/wt",
          agentHome: "/paperclip/home",
        },
        paperclipWorkspaces: [{ id: "ws-1", name: "paperclip" }],
        paperclipRuntimeServiceIntents: [{ name: "web", port: 3000 }],
        paperclipRuntimeServices: [{ name: "web", url: "http://web:3000" }],
        paperclipRuntimePrimaryUrl: "http://web:3000",
      } as AdapterExecutionContext["context"],
    });
    ctx.config = config;
    return ctx;
  }

  /** The four AC permutations, as a full 2x2x2x2 cross product. */
  function permutations(): { label: string; ctx: AdapterExecutionContext }[] {
    const out: { label: string; ctx: AdapterExecutionContext }[] = [];
    for (const isolation of [false, true]) {
      for (const dind of [false, true]) {
        for (const operatorEnv of [false, true]) {
          for (const mcp of [false, true]) {
            const config: Record<string, unknown> = { enableDocker: dind };
            if (isolation) {
              config.isolationMode = "isolated";
              config.isolationKey = "pr-review-123";
            }
            if (operatorEnv) config.env = { ...OPERATOR_CONFIG_ENV };
            if (mcp) config.mcpServers = { extra: { command: "node", args: ["server.js"] } };
            out.push({
              label: `isolation=${isolation} dind=${dind} adapterConfigEnv=${operatorEnv} mcpServers=${mcp}`,
              ctx: maximalCtx(config),
            });
          }
        }
      }
    }
    return out;
  }

  const selfPodWithInherited = () =>
    makeSelfPod({
      inheritedEnv: { ...OPERATOR_INHERITED_ENV },
      inheritedEnvValueFrom: OPERATOR_VALUE_FROM,
    });

  /** Every env name on every container of the assembled pod spec. */
  function allEnvNames(podSpec: k8s.V1PodSpec): string[] {
    const containers: k8s.V1Container[] = [
      ...(podSpec.initContainers ?? []),
      ...(podSpec.containers ?? []),
      ...((podSpec.ephemeralContainers ?? []) as unknown as k8s.V1Container[]),
    ];
    return containers.flatMap((c) => (c.env ?? []).map((e) => e.name).filter((n): n is string => !!n));
  }

  it("classifies every code-originated env name across all 16 config permutations", () => {
    const undeclared = new Map<string, string[]>();

    for (const { label, ctx } of permutations()) {
      const { job } = buildJobManifest({ ctx, selfPod: selfPodWithInherited() });
      for (const name of allEnvNames(job.spec!.template.spec!)) {
        if (OPERATOR_SUPPLIED_NAMES.has(name)) continue;
        if (classifyEnvName(name) !== null) continue;
        undeclared.set(name, [...(undeclared.get(name) ?? []), label]);
      }
    }

    // Name the variable, not just the failure — that is the whole point of the
    // gate. A PR adding an env var reads its own name out of this message.
    expect(
      [...undeclared.entries()].map(
        ([name, labels]) =>
          `${name} (emitted under: ${labels[0]}) — declare it SECRET or SAFE_LITERAL in ENV_NAME_CLASSIFICATION in job-manifest.ts`,
      ),
    ).toEqual([]);
  });

  it("agrees with isSensitiveEnvName on every name it declares", () => {
    // The table must describe what the code actually does. A SECRET entry the
    // routing does not treat as sensitive, or a SAFE_LITERAL entry it does,
    // means the classification has drifted from behaviour.
    const disagreements = ENV_NAME_CLASSIFICATION.filter((e) => !e.prefix).filter(
      (e) => isSensitiveEnvName(e.name) !== (e.classification === "SECRET"),
    );
    expect(disagreements.map((e) => `${e.name} declared ${e.classification}`)).toEqual([]);
  });

  it("does not let a prefix entry silently absolve a credential-shaped name", () => {
    // The check above only covers exact entries, so a prefix family is the one
    // way a new credential-shaped name could enter classified without anyone
    // deciding: `PAPERCLIP_WORKSPACE_AUTH_TOKEN` inherits SAFE_LITERAL from
    // the `PAPERCLIP_WORKSPACE_` family while isSensitiveEnvName routes it to
    // a secretKeyRef. Runtime would be right and the table would be lying.
    // Assert the two agree on every name actually emitted, which is what
    // closes the prefix escape hatch without banning prefixes.
    const drifted = new Set<string>();

    for (const { ctx } of permutations()) {
      const { job } = buildJobManifest({ ctx, selfPod: selfPodWithInherited() });
      for (const name of allEnvNames(job.spec!.template.spec!)) {
        if (OPERATOR_SUPPLIED_NAMES.has(name)) continue;
        const declared = classifyEnvName(name);
        if (declared === null) continue; // the coverage test above owns this case
        if (isSensitiveEnvName(name) !== (declared === "SECRET")) {
          drifted.add(
            `${name} classifies as ${declared} but isSensitiveEnvName says ${isSensitiveEnvName(name) ? "sensitive" : "not sensitive"} — declare it explicitly in ENV_NAME_CLASSIFICATION instead of inheriting a prefix`,
          );
        }
      }
    }

    expect([...drifted]).toEqual([]);
  });

  it("requires a stated reason on every entry", () => {
    // Non-empty is the whole machine-checkable invariant, deliberately. A
    // character-count floor looks stricter but measures nothing a reviewer
    // cares about — it is satisfied by padding and it reddens on a reason
    // that is short because the variable is simple ("pip cache path."). The
    // useful reason is the one a reviewer reads instead of re-deriving
    // whether the value can carry a credential, and that is a review
    // judgement, not a length.
    expect(ENV_NAME_CLASSIFICATION.filter((e) => e.reason.trim().length === 0).map((e) => e.name)).toEqual([]);
  });

  it("keeps the Secret-backed name set identical to the pre-change set (no behaviour change)", () => {
    // The no-behaviour-change proof required by BLO-29804. This is the set as
    // it stood before the classification table existed: regex matches plus the
    // one name BLO-21858 pinned. If introducing the table ever moves a var
    // between literal and secretKeyRef, this reddens.
    const EXPECTED_SECRET_BACKED = [
      "ANTHROPIC_CUSTOM_HEADERS",
      "GH_TOKEN",
      "OPERATOR_API_TOKEN",
      "PAPERCLIP_API_KEY",
      "PAPERCLIP_K8S_ISOLATION_KEY",
    ];

    const ctx = maximalCtx({
      isolationMode: "isolated",
      isolationKey: "pr-review-123",
      enableDocker: true,
      env: { ...OPERATOR_CONFIG_ENV },
      mcpServers: { extra: { command: "node", args: ["server.js"] } },
    });
    const { job, envSecret } = buildJobManifest({ ctx, selfPod: selfPodWithInherited() });

    const mainEnv = job.spec!.template.spec!.containers[0]?.env ?? [];
    const secretBacked = mainEnv
      .filter((e) => e.valueFrom?.secretKeyRef?.name === envSecret?.name)
      .map((e) => e.name!)
      .sort();

    expect(secretBacked).toEqual(EXPECTED_SECRET_BACKED);
    expect(Object.keys(envSecret?.data ?? {}).sort()).toEqual(EXPECTED_SECRET_BACKED);
  });
});

/**
 * BLO-20801: `hasActiveJobForAgent` used to be agent-scoped only (no run-id
 * awareness), so a Job surviving a worker crash blocked ALL dispatch for that
 * agent until the reaper's 45-minute EXTERNAL_LIFECYCLE_HARD_STALE_MS ceiling
 * cleared it, even when every one of the agent's runs was already terminal in
 * the DB. These tests exercise the real async `hasActiveJobForAgent` against
 * a mocked `@kubernetes/client-node` client (unlike the pure-function tests
 * in k8s-job-liveness.test.ts) so the run-id wiring itself -- not just
 * `jobBlocksDispatch` in isolation -- is covered.
 *
 * Run against pre-fix `master`, the "surviving active-phase Job labelled with
 * a terminal run-id" case below fails: `hasActiveJobForAgent` returns `true`
 * (blocking dispatch) because the pre-fix function has no `isRunTerminal`
 * parameter to consult and it did not exist at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockListNamespacedJob = vi.hoisted(() => vi.fn());
const mockListNamespacedPod = vi.hoisted(() => vi.fn());

vi.mock("@kubernetes/client-node", () => {
  class FakeBatchV1Api {}
  class FakeCoreV1Api {}
  class FakeKubeConfig {
    loadFromCluster() {}
    makeApiClient(ApiClass: unknown) {
      if (ApiClass === FakeBatchV1Api) return { listNamespacedJob: mockListNamespacedJob };
      if (ApiClass === FakeCoreV1Api) return { listNamespacedPod: mockListNamespacedPod };
      throw new Error("unexpected k8s api class requested in test");
    }
  }
  return { KubeConfig: FakeKubeConfig, BatchV1Api: FakeBatchV1Api, CoreV1Api: FakeCoreV1Api };
});

let hasActiveJobForAgent: typeof import("../services/k8s-job-liveness.js")["hasActiveJobForAgent"];
let resetClient: typeof import("../services/k8s-job-liveness.js")["__resetK8sJobLivenessClient"];

beforeAll(async () => {
  // ENABLE_K8S_JOB_LIVENESS_IN_TESTS is captured as a module-level const at
  // import time, so it must be stubbed before the dynamic import below.
  vi.stubEnv("PAPERCLIP_ENABLE_K8S_JOB_LIVENESS_IN_TESTS", "true");
  vi.stubEnv("KUBERNETES_SERVICE_HOST", "10.96.0.1");
  const mod = await import("../services/k8s-job-liveness.js");
  hasActiveJobForAgent = mod.hasActiveJobForAgent;
  resetClient = mod.__resetK8sJobLivenessClient;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  mockListNamespacedJob.mockReset();
  mockListNamespacedPod.mockReset();
  mockListNamespacedPod.mockResolvedValue({ items: [] });
  resetClient();
});

function terminalJob(runId: string, status: { active?: number; succeeded?: number; failed?: number } | null) {
  return {
    metadata: {
      name: "agent-job-1",
      uid: "job-uid-1",
      labels: { "app.kubernetes.io/managed-by": "paperclip", "paperclip.io/agent-id": "agent-1", "paperclip.io/run-id": runId },
    },
    status: status ?? undefined,
  };
}

describe("hasActiveJobForAgent run-id awareness (BLO-20801)", () => {
  it("dispatches immediately: a surviving active-phase Job labelled with an all-terminal run-id no longer blocks", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 1, succeeded: 0, failed: 0 })] });

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async (runIds) => new Set(runIds.filter((id) => id === "run-terminal")),
    });

    expect(result).toBe(false);
  });

  it("resolves the status-absent false positive once the run is terminal in the DB", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
  });

  it("resolves the all-zero-counters false positive once the run is terminal in the DB", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 0, succeeded: 0, failed: 0 })] });

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
  });

  it("still blocks dispatch for a live Job mapped to a live (non-terminal) run", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-live", { active: 1, succeeded: 0, failed: 0 })] });

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async () => new Set(), // nothing terminal
    });

    expect(result).toBe(true);
  });

  it("preserves old agent-scoped-only behavior when no isRunTerminal is supplied (agent-image-bump.ts caller)", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });

    const result = await hasActiveJobForAgent("agent-1");

    expect(result).toBe(true);
  });

  it("still blocks when the pod is Terminating, even though its Job's run-id is already terminal (RWO PVC multi-attach guard)", async () => {
    // Job-level check resolves to not-blocking (Complete Job, terminal run).
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 0, succeeded: 1, failed: 0 })] });
    // But the pod itself is still terminating and could be holding the RWO PVC.
    mockListNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: "agent-pod-1", uid: "pod-uid-1", deletionTimestamp: "2026-08-02T00:00:00Z" },
          status: { phase: "Running" },
        },
      ],
    });

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
  });

  it("still fails open (returns false) when the kube API call throws", async () => {
    mockListNamespacedJob.mockRejectedValue(new Error("connection refused"));

    const result = await hasActiveJobForAgent("agent-1", {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
  });
});

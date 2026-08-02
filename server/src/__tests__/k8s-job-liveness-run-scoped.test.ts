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
 * Run against pre-fix `master`, the "surviving stale-status Job labelled with
 * a terminal run-id" cases below fail: `hasActiveJobForAgent` returns `true`
 * (blocking dispatch) because the pre-fix function has no `isRunTerminal`
 * parameter to consult and it did not exist at all.
 *
 * PR #946 review also flagged that the first pass waived a Job's DB-terminal
 * run-id regardless of its live `active` count, and that the waiver trusted
 * a single snapshot even though a Job's controller can create/retry a pod at
 * any point afterward. The fix now (a) never waives a Job Kubernetes reports
 * as currently active, and (b) deletes-and-reconfirms the exact stale Job
 * before treating a status-absent/all-zero waiver as safe, failing closed
 * unless the delete confirms the Job is gone. The "delayed pod creation /
 * controller retry" and "still genuinely active" cases below cover that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockListNamespacedJob = vi.hoisted(() => vi.fn());
const mockListNamespacedPod = vi.hoisted(() => vi.fn());
const mockReadNamespacedJob = vi.hoisted(() => vi.fn());
const mockDeleteNamespacedJob = vi.hoisted(() => vi.fn());

vi.mock("@kubernetes/client-node", () => {
  class FakeBatchV1Api {}
  class FakeCoreV1Api {}
  class FakeKubeConfig {
    loadFromCluster() {}
    makeApiClient(ApiClass: unknown) {
      if (ApiClass === FakeBatchV1Api) {
        return {
          listNamespacedJob: mockListNamespacedJob,
          readNamespacedJob: mockReadNamespacedJob,
          deleteNamespacedJob: mockDeleteNamespacedJob,
        };
      }
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
  mockReadNamespacedJob.mockReset();
  mockDeleteNamespacedJob.mockReset();
  mockListNamespacedPod.mockResolvedValue({ items: [] });
  resetClient();
});

const AGENT_ID = "agent-1";
const JOB_NAME = "agent-job-1";
const JOB_UID = "job-uid-1";

function terminalJob(runId: string, status: { active?: number; succeeded?: number; failed?: number } | null) {
  return {
    metadata: {
      name: JOB_NAME,
      uid: JOB_UID,
      labels: { "app.kubernetes.io/managed-by": "paperclip", "paperclip.io/agent-id": AGENT_ID, "paperclip.io/run-id": runId },
    },
    status: status ?? undefined,
  };
}

/** The identity-checked re-read `deleteStaleTerminalJob` performs before deleting. */
function mockRereadAs(status: { active?: number; succeeded?: number; failed?: number } | null, runId: string) {
  mockReadNamespacedJob.mockResolvedValueOnce(terminalJob(runId, status));
}

/**
 * The confirmation re-read `deleteStaleTerminalJob` performs *after* issuing
 * the delete (BLO-20801 review round 3) -- queued to resolve on the call
 * immediately following `mockRereadAs`'s pre-delete read.
 */
function mockConfirmDeleted() {
  mockReadNamespacedJob.mockRejectedValueOnce({ statusCode: 404 });
}

describe("hasActiveJobForAgent run-id awareness (BLO-20801)", () => {
  it("still blocks on a genuinely active Job even once its run-id is terminal in the DB", async () => {
    // Regression guard (PR #946 review): a currently-active Job is real, live
    // evidence and must never be waived by a DB-terminal run-id -- otherwise
    // dispatch could admit a second run while the old Job can still execute.
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 1, succeeded: 0, failed: 0 })] });

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async (runIds) => new Set(runIds.filter((id) => id === "run-terminal")),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("dispatches immediately: a status-absent Job labelled with a terminal run-id is deleted and no longer blocks", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockRereadAs(null, "run-terminal");
    mockDeleteNamespacedJob.mockResolvedValue({});
    mockConfirmDeleted();

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
    expect(mockDeleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: JOB_NAME, body: { preconditions: { uid: JOB_UID } } }),
      expect.anything(),
    );
  });

  it("resolves the all-zero-counters false positive once the run is terminal in the DB and the Job is deleted", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 0, succeeded: 0, failed: 0 })] });
    mockRereadAs({ active: 0, succeeded: 0, failed: 0 }, "run-terminal");
    mockDeleteNamespacedJob.mockResolvedValue({});
    mockConfirmDeleted();

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
  });

  it("still blocks dispatch for a live Job mapped to a live (non-terminal) run", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-live", { active: 1, succeeded: 0, failed: 0 })] });

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(), // nothing terminal
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("preserves old agent-scoped-only behavior when no isRunTerminal is supplied (agent-image-bump.ts caller)", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });

    const result = await hasActiveJobForAgent(AGENT_ID);

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("still blocks when the pod is Terminating, even though its Job's run-id is already terminal (RWO PVC multi-attach guard)", async () => {
    // Job-level check resolves to not-blocking (Complete Job, terminal run) --
    // no deletion needed since a genuinely completed Job is left alone.
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

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("still fails open (returns false) when the kube API call throws", async () => {
    mockListNamespacedJob.mockRejectedValue(new Error("connection refused"));

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
  });

  it("fails closed (returns true, still blocking) when isRunTerminal rejects after an active Job was observed", async () => {
    // Kubernetes itself is healthy and returned a real active-phase Job -- this
    // must NOT be mistaken for a kube-API failure and fail open. Regression for
    // https://github.com/Blockcast/paperclip/pull/946#issuecomment-5156164869:
    // a DB-lookup rejection landing in the outer catch used to report `false`
    // (no active Job), letting startNextQueuedRunForAgent dispatch overlapping
    // work onto a Job that was, in fact, still active.
    mockListNamespacedJob.mockResolvedValue({
      items: [terminalJob("run-unknown", { active: 1, succeeded: 0, failed: 0 })],
    });

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => {
        throw new Error("db connection reset");
      },
    });

    expect(result).toBe(true);
  });

  it("fails closed on delayed pod creation: the Job gained an active pod between the list and the delete re-check", async () => {
    // Review follow-up (PR #946): the initial list snapshot showed no active
    // pods, but the Job's controller created/retried one before the deletion
    // re-read landed. The re-check must see the now-active Job and refuse to
    // delete it, and the caller must fail closed instead of admitting a
    // second run alongside it.
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", { active: 0, succeeded: 0, failed: 0 })] });
    mockRereadAs({ active: 1, succeeded: 0, failed: 0 }, "run-terminal");

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("fails closed when the stale Job's identity no longer matches on re-read (controller replaced it)", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockReadNamespacedJob.mockResolvedValue({
      metadata: {
        name: JOB_NAME,
        uid: "a-different-uid",
        labels: { "app.kubernetes.io/managed-by": "paperclip", "paperclip.io/agent-id": AGENT_ID, "paperclip.io/run-id": "run-terminal" },
      },
      status: undefined,
    });

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("treats a Job already gone on re-read (404) as confirmed removed and does not block", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockReadNamespacedJob.mockRejectedValue({ statusCode: 404 });

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(false);
    expect(mockDeleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("fails closed when the deletion call itself errors", async () => {
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockRereadAs(null, "run-terminal");
    mockDeleteNamespacedJob.mockRejectedValue(new Error("etcd unavailable"));

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
  });

  it("fails closed when an accepted DELETE has not actually removed the Job by the time the retry budget is exhausted", async () => {
    // Ally review (PR #946, round 3): a successful DELETE response with
    // Background propagation only means the request was accepted -- the Job
    // can still be present (e.g. pending finalizers) when dispatch would
    // otherwise trust the waiver. Every confirmation re-read here keeps
    // returning the Job present and inactive, so the retry budget must
    // exhaust and fail closed rather than treating the accepted DELETE call
    // itself as proof of removal.
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockReadNamespacedJob.mockResolvedValue(terminalJob("run-terminal", null));
    mockDeleteNamespacedJob.mockResolvedValue({});

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Job's controller creates a pod after an accepted DELETE but before removal is confirmed", async () => {
    // Ally review (PR #946, round 3): the DELETE call succeeding does not
    // stop the Job's controller reconciliation mid-flight. If the
    // confirmation re-read observes a newly active pod, that's real live
    // evidence and must block exactly like the pre-delete "delayed pod
    // creation" case, not be masked by the earlier accepted DELETE.
    mockListNamespacedJob.mockResolvedValue({ items: [terminalJob("run-terminal", null)] });
    mockRereadAs(null, "run-terminal");
    mockReadNamespacedJob.mockResolvedValueOnce(terminalJob("run-terminal", { active: 1, succeeded: 0, failed: 0 }));
    mockDeleteNamespacedJob.mockResolvedValue({});

    const result = await hasActiveJobForAgent(AGENT_ID, {
      isRunTerminal: async () => new Set(["run-terminal"]),
    });

    expect(result).toBe(true);
    expect(mockDeleteNamespacedJob).toHaveBeenCalledTimes(1);
  });
});

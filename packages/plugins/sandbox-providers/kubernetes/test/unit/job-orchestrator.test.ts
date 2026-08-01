import { describe, it, expect, vi } from "vitest";
import { createJob, deleteJob, getJobStatus, findPodForJob, JobTimeoutError, waitForJobCompletion } from "../../src/job-orchestrator.js";

describe("createJob", () => {
  it("calls batch.createNamespacedJob with the manifest", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "abc-uid" } });
    const clients = { batch: { createNamespacedJob: create } };
    const jobManifest = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "r-1", namespace: "ns" }, spec: { template: {} } };
    const result = await createJob(clients as never, "ns", jobManifest);
    expect(create).toHaveBeenCalledWith({ namespace: "ns", body: jobManifest });
    expect(result.uid).toBe("abc-uid");
  });

  // The guard itself is unit-tested, but without these the choke-point call in
  // createJob could be deleted and the suite would stay green. Asserting the
  // client was never touched is the point: a leaking manifest must not reach
  // the API server at all, rather than being rejected after the fact.
  it("refuses a leaking manifest before calling the Kubernetes client", async () => {
    const create = vi.fn().mockResolvedValue({ metadata: { uid: "abc-uid" } });
    const clients = { batch: { createNamespacedJob: create } };
    const leaking = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "r-1", namespace: "ns" },
      spec: {
        template: {
          spec: { containers: [{ name: "agent", env: [{ name: "ANTHROPIC_API_KEY", value: "sk-leak" }] }] },
        },
      },
    };
    await expect(createJob(clients as never, "ns", leaking)).rejects.toThrow(
      /agent\.env\[ANTHROPIC_API_KEY\]/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a manifest whose only leak is in an initContainer", async () => {
    const create = vi.fn();
    const clients = { batch: { createNamespacedJob: create } };
    const leaking = {
      apiVersion: "batch/v1",
      kind: "Job",
      spec: {
        template: {
          spec: { initContainers: [{ name: "init", env: [{ name: "MCP_CONFIG", value: "{}" }] }] },
        },
      },
    };
    await expect(createJob(clients as never, "ns", leaking)).rejects.toThrow(/init\.env\[MCP_CONFIG\]/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("getJobStatus", () => {
  it("returns phase=Succeeded when succeeded count is 1", async () => {
    const get = vi.fn().mockResolvedValue({ status: { succeeded: 1, conditions: [{ type: "Complete", status: "True" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Succeeded");
    expect(status.complete).toBe(true);
  });

  it("returns phase=Failed when failed count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { failed: 1, conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }] } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Failed");
    expect(status.reason).toBe("DeadlineExceeded");
  });

  it("returns phase=Running when active count is >0", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Running");
  });

  it("returns phase=Pending when no active/succeeded/failed counters set", async () => {
    const get = vi.fn().mockResolvedValue({ status: {} });
    const clients = { batch: { readNamespacedJobStatus: get } };
    const status = await getJobStatus(clients as never, "ns", "r-1");
    expect(status.phase).toBe("Pending");
  });
});

describe("findPodForJob", () => {
  it("lists pods by job-name label and returns the first running pod", async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ metadata: { name: "r-1-xyz" }, status: { phase: "Running" } }] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ namespace: "ns", labelSelector: "job-name=r-1" }));
    expect(podName).toBe("r-1-xyz");
  });

  it("returns null when no pod is found", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const clients = { core: { listNamespacedPod: list } };
    const podName = await findPodForJob(clients as never, "ns", "r-1");
    expect(podName).toBeNull();
  });
});

describe("deleteJob", () => {
  it("calls batch.deleteNamespacedJob with foreground propagation", async () => {
    const del = vi.fn().mockResolvedValue({});
    const clients = { batch: { deleteNamespacedJob: del } };
    await deleteJob(clients as never, "ns", "r-1");
    expect(del).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        name: "r-1",
        propagationPolicy: "Foreground",
      }),
    );
  });
});

describe("waitForJobCompletion", () => {
  it("throws JobTimeoutError when the deadline is exceeded", async () => {
    const get = vi.fn().mockResolvedValue({ status: { active: 1 } });
    const clients = { batch: { readNamespacedJobStatus: get } };
    await expect(
      waitForJobCompletion(clients as never, "ns", "r-1", { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });
});

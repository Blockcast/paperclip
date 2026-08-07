import { describe, it, expect, vi } from "vitest";
import {
  createJob,
  deleteJob,
  getJobStatus,
  findPodForJob,
  JobAlreadyExistsError,
  JobTimeoutError,
  waitForJobCompletion,
} from "../../src/job-orchestrator.js";

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

  // The allowlist is keyed on name *and* value. Allowlisting `HOME` by name
  // alone would let a credential ride in under an approved name.
  it("refuses an allowlisted env name carrying a non-allowlisted value", async () => {
    const create = vi.fn();
    const clients = { batch: { createNamespacedJob: create } };
    const leaking = {
      apiVersion: "batch/v1",
      kind: "Job",
      spec: {
        template: {
          spec: { containers: [{ name: "agent", env: [{ name: "HOME", value: "sk-ant-leak" }] }] },
        },
      },
    };
    await expect(createJob(clients as never, "ns", leaking)).rejects.toThrow(
      /agent\.env\[HOME\] \(value-not-allowlisted\)/,
    );
    expect(create).not.toHaveBeenCalled();
  });

  const identityLabels = {
    "paperclip.io/run-id": "run-abc",
    "paperclip.io/company-id": "company-abc",
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
    "paperclip.io/adapter": "codex_local",
  };

  // BLO-22454: a concurrent create of the same run can 409 against its
  // in-flight Job. It is safe to adopt only the Job carrying that run's
  // immutable Paperclip identity labels.
  it("adopts the existing Job's uid on a 409 AlreadyExists", async () => {
    const create = vi.fn().mockRejectedValue({ code: 409 });
    const read = vi.fn().mockResolvedValue({ metadata: { uid: "existing-uid", labels: identityLabels } });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };
    const jobManifest = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "r-1", namespace: "ns", labels: identityLabels },
      spec: { template: {} },
    };
    const result = await createJob(clients as never, "ns", jobManifest);
    expect(read).toHaveBeenCalledWith({ namespace: "ns", name: "r-1" });
    expect(result.uid).toBe("existing-uid");
  });

  it("rejects an existing Job whose identity labels do not match the manifest", async () => {
    const create = vi.fn().mockRejectedValue({ code: 409 });
    const read = vi.fn().mockResolvedValue({
      metadata: { uid: "existing-uid", labels: { ...identityLabels, "paperclip.io/run-id": "other-run" } },
    });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };
    const jobManifest = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "r-1", namespace: "ns", labels: identityLabels },
      spec: { template: {} },
    };

    await expect(createJob(clients as never, "ns", jobManifest)).rejects.toThrow(/expected Paperclip identity labels/);
  });

  // A Job under foreground deletion is unsafe to adopt, but it is transient:
  // wait for the observed UID to disappear, then retry the same manifest.
  it("retries creation after a conflicting terminating Job disappears", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ code: 409 })
      .mockResolvedValueOnce({ metadata: { uid: "replacement-uid" } });
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        metadata: { uid: "existing-uid", deletionTimestamp: "2026-08-06T12:00:00Z", labels: identityLabels },
      })
      .mockRejectedValueOnce({ code: 404 });
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };
    const jobManifest = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "r-1", namespace: "ns", labels: identityLabels },
      spec: { template: {} },
    };
    const result = await createJob(clients as never, "ns", jobManifest, { conflictRetryTimeoutMs: 0 });

    expect(result.uid).toBe("replacement-uid");
    expect(create).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("throws a typed error naming the run id when the existing Job can't be read", async () => {
    const create = vi.fn().mockRejectedValue({ statusCode: 409 });
    const read = vi.fn().mockRejectedValue(new Error("boom"));
    const clients = { batch: { createNamespacedJob: create, readNamespacedJob: read } };
    const jobManifest = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "r-2", namespace: "ns", labels: { ...identityLabels, "paperclip.io/run-id": "run-xyz" } },
      spec: { template: {} },
    };
    const error = await createJob(clients as never, "ns", jobManifest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobAlreadyExistsError);
    expect(error).toMatchObject({ message: expect.stringMatching(/run-xyz/) });
  });

  it("re-throws non-409 errors from createNamespacedJob unchanged", async () => {
    const boom = new Error("server exploded");
    const create = vi.fn().mockRejectedValue(boom);
    const clients = { batch: { createNamespacedJob: create } };
    const jobManifest = { apiVersion: "batch/v1", kind: "Job", metadata: { name: "r-3", namespace: "ns" }, spec: { template: {} } };
    await expect(createJob(clients as never, "ns", jobManifest)).rejects.toBe(boom);
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

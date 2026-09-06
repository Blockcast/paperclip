import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";

// execute.ts reaches for the cluster at import time only through these three
// factories, so a minimal stub is enough to load the module. The unit under
// test takes its CoreV1Api as a parameter, so nothing here is ever called.
vi.mock("./k8s-client.js", () => ({
  getLogApi: () => ({ log: vi.fn() }),
  getBatchApi: () => ({}),
  getCoreApi: () => ({}),
  getAuthzApi: () => ({}),
  getSelfPodInfo: vi.fn(),
  resetCache: vi.fn(),
}));

const { isK8s409, createOrAdoptRunSecret } = await import("./execute.js");

const NS = "paperclip";
const NAME = "ac-4eca1725-632f-45-f6fd03d0-4940-43-b1387d-env";
const RUN_ID = "f6fd03d0-4940-43ab-9c11-000000000000";

const MANAGED_BY = "app.kubernetes.io/managed-by";
const ADAPTER_TYPE = "paperclip.io/adapter-type";
const RUN_ID_LABEL = "paperclip.io/run-id";

/**
 * The error shape observed in the BLO-31665 incident: @kubernetes/client-node
 * surfaced the status only inside the message string.
 */
function k8sErr(code: number, reason: string): Error {
  return new Error(
    `HTTP-Code: ${code}\nMessage: ${reason}\nBody: {"kind":"Status","status":"Failure",` +
      `"message":"secrets \\"${NAME}\\" already exists","reason":"${reason}","code":${code}}`,
  );
}

/** Same status, but carried structurally instead of in the message. */
function structuredErr(code: number): Error {
  const err = new Error("api error");
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

function makeCoreApi(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  const api = {
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    readNamespacedSecret: vi.fn(),
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  return api as unknown as k8s.CoreV1Api & typeof api;
}

const INPUT = { name: NAME, namespace: NS, runId: RUN_ID, data: { FOO: "bar" } };

describe("isK8s409", () => {
  it("detects the production shape, where the status is only in the message", () => {
    // This is the regression that matters: the sibling implementation in
    // packages/plugins/sandbox-providers/kubernetes/src/secret-manager.ts
    // inspects code/statusCode only and returns false for exactly this error.
    expect(isK8s409(k8sErr(409, "AlreadyExists"))).toBe(true);
  });

  it("detects structurally-carried statuses", () => {
    expect(isK8s409(structuredErr(409))).toBe(true);
    const viaStatusCode = new Error("x");
    (viaStatusCode as unknown as Record<string, unknown>).statusCode = 409;
    expect(isK8s409(viaStatusCode)).toBe(true);
    const viaResponse = new Error("x");
    (viaResponse as unknown as Record<string, unknown>).response = { statusCode: 409 };
    expect(isK8s409(viaResponse)).toBe(true);
  });

  it("does not fire on other statuses or non-Errors", () => {
    expect(isK8s409(k8sErr(404, "NotFound"))).toBe(false);
    expect(isK8s409(structuredErr(500))).toBe(false);
    expect(isK8s409("HTTP-Code: 409")).toBe(false);
    expect(isK8s409(null)).toBe(false);
    // Must not match 4090 or similar via a loose prefix test.
    expect(isK8s409(new Error("HTTP-Code: 4091"))).toBe(false);
  });
});

describe("createOrAdoptRunSecret", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates the Secret with the adapter's provenance labels", async () => {
    const coreApi = makeCoreApi();
    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("created");

    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const body = coreApi.createNamespacedSecret.mock.calls[0][0].body;
    expect(body.metadata.labels).toEqual({
      [MANAGED_BY]: "paperclip",
      [ADAPTER_TYPE]: "claude_k8s",
      [RUN_ID_LABEL]: RUN_ID,
    });
    expect(body.stringData).toEqual({ FOO: "bar" });
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it("adopts a leftover Secret from the same run instead of failing the run", async () => {
    // The BLO-31665 incident: a benign leftover from an earlier attempt of
    // this same run used to return k8s_env_secret_create_failed and kill it.
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: {
          name: NAME,
          resourceVersion: "12345",
          labels: { [MANAGED_BY]: "paperclip", [RUN_ID_LABEL]: RUN_ID },
        },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");

    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    const call = coreApi.replaceNamespacedSecret.mock.calls[0][0];
    expect(call.name).toBe(NAME);
    // resourceVersion must be carried through, or the replace races blind.
    expect(call.body.metadata.resourceVersion).toBe("12345");
    expect(call.body.metadata.labels[RUN_ID_LABEL]).toBe(RUN_ID);
    expect(call.body.stringData).toEqual({ FOO: "bar" });
  });

  it("adopts an unlabelled Secret written by an older adapter build", async () => {
    // Transition tolerance. A gate that *requires* labels would refuse to
    // adopt precisely the objects that need adopting, leaving the fix inert
    // on first contact. The name already encodes (agentId, runId).
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: NAME, resourceVersion: "7" } }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");
    expect(coreApi.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the existing Secret belongs to a different run", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "9", labels: { [RUN_ID_LABEL]: "some-other-run" } },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/belongs to run some-other-run/);
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it("fails closed when the existing Secret is managed by something else", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "9", labels: { [MANAGED_BY]: "helm" } },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/managed by helm/);
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it("re-creates when the Secret is deleted between the create and the read", async () => {
    // create says "exists", read says "gone" — the adapter's own cleanup
    // reaper racing a retry. Resurfacing the stale 409 here (what the
    // sandbox-provider sibling does) fails a run that had nothing wrong.
    const create = vi
      .fn()
      .mockRejectedValueOnce(k8sErr(409, "AlreadyExists"))
      .mockResolvedValueOnce({});
    const coreApi = makeCoreApi({
      createNamespacedSecret: create,
      readNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(404, "NotFound")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("recreated");
    expect(create).toHaveBeenCalledTimes(2);
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
  });

  it("rethrows a non-409 create failure untouched", async () => {
    const boom = new Error("HTTP-Code: 403\nMessage: Forbidden");
    const coreApi = makeCoreApi({ createNamespacedSecret: vi.fn().mockRejectedValue(boom) });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toBe(boom);
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it("reports an unreadable existing Secret rather than masking it", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(k8sErr(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockRejectedValue(new Error("HTTP-Code: 500")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/already exists and could not be read/);
    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();
  });
});

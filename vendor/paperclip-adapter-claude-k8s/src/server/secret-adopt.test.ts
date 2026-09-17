import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import { ApiException } from "@kubernetes/client-node";

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
 * A real `ApiException` from the installed client, not a hand-rolled stand-in.
 * Constructing the genuine class is what makes these tests evidence about the
 * error shape the adapter actually sees at runtime: it sets `code` and leaves
 * `statusCode`/`response` undefined, which a hand-written fake would get wrong
 * in whichever direction the author happened to assume.
 */
function apiException(code: number, reason: string): Error {
  return new ApiException(
    code,
    reason,
    { kind: "Status", status: "Failure", message: `secrets "${NAME}" already exists`, reason, code },
    {},
  ) as unknown as Error;
}

/** Legacy/plain-Error shape: the status survives only in the message text. */
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
    patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    // Kept wired so the merge-PATCH test can assert the PUT is NOT used.
    // Removing it would make that assertion vacuously pass on `undefined`.
    replaceNamespacedSecret: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
  return api as unknown as k8s.CoreV1Api & typeof api;
}

const INPUT = { name: NAME, namespace: NS, runId: RUN_ID, data: { FOO: "bar" } };

describe("isK8s409", () => {
  it("detects a real ApiException, which carries `code` but not `statusCode`", () => {
    // Measured against the installed @kubernetes/client-node (1.4.0):
    // ApiException sets ONLY `this.code`; `statusCode` and `response` are
    // both undefined. So `code` is the load-bearing branch here — note the
    // pre-existing isK8s404 does not check it at all and works purely on its
    // message regex.
    const err = apiException(409, "AlreadyExists");
    expect((err as unknown as Record<string, unknown>).code).toBe(409);
    expect((err as unknown as Record<string, unknown>).statusCode).toBeUndefined();
    expect(isK8s409(err)).toBe(true);
  });

  it("also detects an error carrying the status only in the message text", () => {
    // Redundant for a genuine ApiException, kept for symmetry with isK8s404
    // and to cover an error re-thrown as a plain Error.
    expect(isK8s409(new Error(apiException(409, "AlreadyExists").message))).toBe(true);
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
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: {
          name: NAME,
          resourceVersion: "12345",
          labels: { [MANAGED_BY]: "paperclip", [RUN_ID_LABEL]: RUN_ID },
        },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");

    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1);
    const call = coreApi.patchNamespacedSecret.mock.calls[0][0];
    expect(call.name).toBe(NAME);
    // resourceVersion must be carried through, or the write races blind.
    expect(call.body.metadata.resourceVersion).toBe("12345");
    expect(call.body.metadata.labels[RUN_ID_LABEL]).toBe(RUN_ID);
    expect(call.body.stringData).toEqual({ FOO: "bar" });
  });

  it("writes the adoption as a merge PATCH, on the verb this path already held", async () => {
    // BLO-32424. This is the load-bearing assertion of that fix, and it is
    // about the HTTP verb, not about a race. `replaceNamespacedSecret` is a
    // PUT == the `update` verb, and when this was written the adapter's service
    // account was measured holding create/patch/delete/get on secrets but NOT
    // update:
    //
    //   secrets create -> true   secrets update -> false
    //   secrets patch  -> true   (control: zzzfakeres update -> false)
    //
    // so the old replace returned 403 on EVERY collision, deterministically,
    // never reaching the races the rest of this file guards. Two live agents
    // were failing to launch on exactly that.
    //
    // That measurement is now stale — #1837 granted `update` on 2026-09-16 —
    // so do NOT read this test as pinning the absence of a verb. The durable
    // reason is the one `execute.ts` gives at the call site: `patch` was
    // already granted before #1837, so this path needs no widened verb and
    // cannot be broken by `update` being retired later. If someone reverts to
    // a PUT, or drops the explicit Content-Type (the client's default for
    // patch is json-patch+json, which would reject this object body), this
    // fails.
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "12345", labels: { [RUN_ID_LABEL]: RUN_ID } },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");

    expect(coreApi.replaceNamespacedSecret).not.toHaveBeenCalled();

    // `setHeaderOptions` returns middleware closures, so the header is only
    // observable by running them. The middleware does nothing but call
    // `setHeaderParam`, so a two-line stub is the whole harness.
    const [, options] = coreApi.patchNamespacedSecret.mock.calls[0];
    const headers: Record<string, string> = {};
    for (const mw of options.middleware) {
      mw.pre({ setHeaderParam: (k: string, v: string) => void (headers[k] = v) });
    }
    expect(headers["Content-Type"]).toBe("application/merge-patch+json");
  });

  it("re-creates when the Secret is deleted between the read and the adoption write", async () => {
    // AC1. The reaper freeing the name in the read->write gap used to throw
    // from inside `catch`, escaping the retry loop entirely and surfacing as
    // the very k8s_*_secret_create_failed the adoption path exists to prevent.
    const create = vi.fn().mockRejectedValueOnce(apiException(409, "AlreadyExists")).mockResolvedValueOnce({});
    const coreApi = makeCoreApi({
      createNamespacedSecret: create,
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "12345", labels: { [RUN_ID_LABEL]: RUN_ID } },
      }),
      patchNamespacedSecret: vi.fn().mockRejectedValueOnce(apiException(404, "NotFound")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("recreated");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("re-reads and retries when the carried resourceVersion has gone stale", async () => {
    // AC2. A concurrent writer bumps resourceVersion, so the optimistic-
    // concurrency precondition fails 409. Correct move is to re-read the fresh
    // version and try again inside the same loop — not to die, and not to drop
    // resourceVersion to dodge the conflict.
    const create = vi.fn().mockRejectedValue(apiException(409, "AlreadyExists"));
    const read = vi
      .fn()
      .mockResolvedValueOnce({ metadata: { name: NAME, resourceVersion: "1", labels: { [RUN_ID_LABEL]: RUN_ID } } })
      .mockResolvedValueOnce({ metadata: { name: NAME, resourceVersion: "2", labels: { [RUN_ID_LABEL]: RUN_ID } } });
    const patch = vi.fn().mockRejectedValueOnce(apiException(409, "Conflict")).mockResolvedValueOnce({});
    const coreApi = makeCoreApi({
      createNamespacedSecret: create,
      readNamespacedSecret: read,
      patchNamespacedSecret: patch,
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");
    expect(read).toHaveBeenCalledTimes(2);
    // The retry must carry the *fresh* version, else it loses the same race again.
    expect(patch.mock.calls[1][0].body.metadata.resourceVersion).toBe("2");
  });

  it("gives up with the original 409 when the adoption write keeps conflicting", async () => {
    // AC3. The new paths reuse the loop's existing `attempt === 0` bound, so a
    // permanently-contended name is capped at two passes rather than spinning.
    // Pinning the counts is what stops a later change raising the budget quietly.
    const err = apiException(409, "AlreadyExists");
    const writeErr = apiException(409, "Conflict");
    const patch = vi.fn().mockRejectedValue(writeErr);
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(err),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "1", labels: { [RUN_ID_LABEL]: RUN_ID } },
      }),
      patchNamespacedSecret: patch,
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toBe(err);
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenCalledTimes(2);
    // The thrown identity is the create-time 409 (above), so without this the
    // adoption failure would be discarded and the give-up would read as
    // `AlreadyExists` with no trace of which mode was churning the name.
    expect((err as { cause?: unknown }).cause).toBe(writeErr);
  });

  it("fails closed with its own error when the adoption write is neither 404 nor 409", async () => {
    // AC4. A 403 is the shape actually observed in production before this fix.
    // It must surface with its own identity, not be laundered into a retry.
    const boom = new Error("HTTP-Code: 403\nMessage: Forbidden");
    const create = vi.fn().mockRejectedValue(apiException(409, "AlreadyExists"));
    const coreApi = makeCoreApi({
      createNamespacedSecret: create,
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "1", labels: { [RUN_ID_LABEL]: RUN_ID } },
      }),
      patchNamespacedSecret: vi.fn().mockRejectedValue(boom),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toBe(boom);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("adopts an unlabelled Secret written by an older adapter build", async () => {
    // Transition tolerance. A gate that *requires* labels would refuse to
    // adopt precisely the objects that need adopting, leaving the fix inert
    // on first contact. The name already encodes (agentId, runId).
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({ metadata: { name: NAME, resourceVersion: "7" } }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the existing Secret belongs to a different run", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "9", labels: { [RUN_ID_LABEL]: "some-other-run" } },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/belongs to run some-other-run/);
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("fails closed when the existing Secret is managed by something else", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockResolvedValue({
        metadata: { name: NAME, resourceVersion: "9", labels: { [MANAGED_BY]: "helm" } },
      }),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/managed by helm/);
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("re-creates when the Secret is deleted between the create and the read", async () => {
    // create says "exists", read says "gone" — the adapter's own cleanup
    // reaper racing a retry. Resurfacing the stale 409 here (what the
    // sandbox-provider sibling does) fails a run that had nothing wrong.
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiException(409, "AlreadyExists"))
      .mockResolvedValueOnce({});
    const coreApi = makeCoreApi({
      createNamespacedSecret: create,
      readNamespacedSecret: vi.fn().mockRejectedValue(apiException(404, "NotFound")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("recreated");
    expect(create).toHaveBeenCalledTimes(2);
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("adopts when the re-created name is taken again by a second racer", async () => {
    // The re-create is itself a create and can itself 409. Previously it was
    // unguarded, so a second racer resurfaced the raw error and killed the run
    // with the very code this change exists to prevent.
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiException(409, "AlreadyExists"))
      .mockRejectedValueOnce(apiException(409, "AlreadyExists"));
    const read = vi
      .fn()
      .mockRejectedValueOnce(apiException(404, "NotFound"))
      .mockResolvedValueOnce({
        metadata: { name: NAME, resourceVersion: "3", labels: { [RUN_ID_LABEL]: RUN_ID } },
      });
    const coreApi = makeCoreApi({ createNamespacedSecret: create, readNamespacedSecret: read });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).resolves.toBe("adopted");
    expect(create).toHaveBeenCalledTimes(2);
    expect(coreApi.patchNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("gives up with the original 409 rather than spinning on a churning name", async () => {
    // create-409 -> read-404 twice running means something is actively
    // creating and deleting this name. Bounded at two passes.
    const err = apiException(409, "AlreadyExists");
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(err),
      readNamespacedSecret: vi.fn().mockRejectedValue(apiException(404, "NotFound")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toBe(err);
    expect(coreApi.createNamespacedSecret).toHaveBeenCalledTimes(2);
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();
  });

  it("rethrows a non-409 create failure untouched", async () => {
    const boom = new Error("HTTP-Code: 403\nMessage: Forbidden");
    const coreApi = makeCoreApi({ createNamespacedSecret: vi.fn().mockRejectedValue(boom) });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toBe(boom);
    expect(coreApi.readNamespacedSecret).not.toHaveBeenCalled();
  });

  it("reports an unreadable existing Secret rather than masking it", async () => {
    const coreApi = makeCoreApi({
      createNamespacedSecret: vi.fn().mockRejectedValue(apiException(409, "AlreadyExists")),
      readNamespacedSecret: vi.fn().mockRejectedValue(new Error("HTTP-Code: 500")),
    });

    await expect(createOrAdoptRunSecret(coreApi, INPUT)).rejects.toThrow(/already exists and could not be read/);
    expect(coreApi.patchNamespacedSecret).not.toHaveBeenCalled();
  });
});

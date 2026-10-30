import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cover for `getPvc`'s not-found handling.
 *
 * In its own file rather than in `k8s-client.test.ts`: that suite mocks
 * `@kubernetes/client-node` with a fake whose API client exposes only
 * `readNamespacedPod`, built to observe the self-pod cache. Extending it to
 * serve PVC reads would entangle two unrelated subjects; vitest gives each
 * file its own module registry, so a second mock is the cheap option.
 *
 * The case that matters is the `code`-only error. @kubernetes/client-node's
 * `ApiException` is constructed as `super("HTTP-Code: " + code + ...)` and then
 * sets ONLY `this.code` — `statusCode` and `response` are both undefined. A
 * predicate that checks the response shape alone therefore falls through to a
 * message regex, and a missed 404 turns "this claim does not exist yet" into a
 * thrown error that fails the run instead of provisioning the volume.
 */

let readImpl: () => Promise<unknown> = async () => ({});
let createImpl: (arg: unknown) => Promise<unknown> = async () => ({});

class FakeKubeConfig {
  loadFromFile() {}
  loadFromCluster() {}
  makeApiClient() {
    return {
      readNamespacedPersistentVolumeClaim: () => readImpl(),
      createNamespacedPersistentVolumeClaim: (arg: unknown) => createImpl(arg),
    };
  }
}

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: FakeKubeConfig,
  CoreV1Api: class {},
  BatchV1Api: class {},
  AuthorizationV1Api: class {},
  Log: class {},
}));

const { getPvc, createPvc, resetCache } = await import("./k8s-client.js");

/** An `ApiException` exactly as the library builds it: only `code` is set. */
function apiException(code: number): Error {
  const err = new Error(`HTTP-Code: ${code}`);
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

/**
 * An error carrying the status ONLY as a structured field, with an opaque
 * message. A genuine `ApiException` happens to carry both (its message is
 * built from the code), so a fixture shaped like one cannot distinguish the
 * `code` check from the message regex — it passes either way. This fixture is
 * what makes the `code` branch load-bearing in a test rather than incidental.
 */
function codeOnlyError(code: number): Error {
  const err = new Error("request failed");
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

/** A v0.x-shaped error, where the status lived under `response`. */
function legacyError(statusCode: number): Error {
  const err = new Error("boom");
  (err as unknown as Record<string, unknown>).response = { statusCode };
  return err;
}

beforeEach(() => {
  resetCache();
  readImpl = async () => ({});
  createImpl = async () => ({});
});

describe("getPvc", () => {
  it("returns the claim when it exists", async () => {
    readImpl = async () => ({ metadata: { name: "agent-workspace-x" } });
    await expect(getPvc("paperclip", "agent-workspace-x")).resolves.toEqual({
      metadata: { name: "agent-workspace-x" },
    });
  });

  it("returns null for a genuine ApiException 404", async () => {
    readImpl = async () => {
      throw apiException(404);
    };
    await expect(getPvc("paperclip", "absent")).resolves.toBeNull();
  });

  // The regression this file exists for, and the one assertion here that the
  // message regex cannot satisfy. Fails if `code` is dropped from the predicate.
  it("returns null for a 404 carried only as a structured `code`", async () => {
    readImpl = async () => {
      throw codeOnlyError(404);
    };
    await expect(getPvc("paperclip", "absent")).resolves.toBeNull();
  });

  it("returns null for a v0.x-shaped 404 under `response`", async () => {
    readImpl = async () => {
      throw legacyError(404);
    };
    await expect(getPvc("paperclip", "absent")).resolves.toBeNull();
  });

  // Must NOT be swallowed: a 403 means RBAC does not allow the read, and
  // reporting that as "absent" would send the caller on to create a claim it
  // is equally unable to create — reporting the wrong fault.
  it("propagates a 403 rather than reporting the claim absent", async () => {
    readImpl = async () => {
      throw apiException(403);
    };
    await expect(getPvc("paperclip", "denied")).rejects.toThrow(/HTTP-Code: 403/);
  });

  it("propagates a non-Error rejection", async () => {
    readImpl = async () => {
      throw "not an Error";
    };
    await expect(getPvc("paperclip", "weird")).rejects.toBeTruthy();
  });
});

describe("createPvc", () => {
  it("passes the namespace and body straight through", async () => {
    const seen: unknown[] = [];
    createImpl = async (arg) => {
      seen.push(arg);
      return { metadata: { name: "created" } };
    };

    const body = { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: "created" } };
    await createPvc("paperclip", body);

    expect(seen).toEqual([{ namespace: "paperclip", body }]);
  });

  // Deliberately NOT swallowed here. `ensureAgentWorkspacePvc` decides whether
  // an AlreadyExists is benign, because only the caller knows the name encodes
  // the agent identity.
  it("does not swallow a 409", async () => {
    createImpl = async () => {
      throw apiException(409);
    };
    await expect(createPvc("paperclip", {})).rejects.toThrow(/HTTP-Code: 409/);
  });
});

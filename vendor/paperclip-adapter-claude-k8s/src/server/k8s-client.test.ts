import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the self-pod introspection cache.
 *
 * `getSelfPodInfo()` used to memoize into a single process-global slot, while
 * both the API-client helpers and `execute()` accept a per-request kubeconfig
 * path. The first execution to populate that slot therefore handed its
 * cluster's image, scheduling, PVC, env and Secret references to every later
 * execution running against a *different* cluster — the Job would be created
 * through cluster B's client but templated from cluster A's pod.
 */

/** Records which kubeconfig file each KubeConfig instance was loaded from. */
class FakeKubeConfig {
  loadedFrom = "";
  loadFromFile(p: string) {
    this.loadedFrom = p;
  }
  loadFromCluster() {
    this.loadedFrom = "<in-cluster>";
  }
  makeApiClient() {
    const loadedFrom = this.loadedFrom;
    return {
      readNamespacedPod: async () => podFixtures[loadedFrom],
    };
  }
}

/** Distinct pod spec per kubeconfig, so a cache mix-up is directly observable. */
const podFixtures: Record<string, unknown> = {};

vi.mock("@kubernetes/client-node", () => ({
  KubeConfig: FakeKubeConfig,
  CoreV1Api: class {},
  BatchV1Api: class {},
  AuthorizationV1Api: class {},
  Log: class {},
}));

function makePod(image: string, nodeSelectorValue: string) {
  return {
    spec: {
      containers: [
        {
          name: "paperclip",
          image,
          env: [{ name: "CLUSTER_TAG", value: nodeSelectorValue }],
          volumeMounts: [],
        },
      ],
      nodeSelector: { workload: nodeSelectorValue },
      volumes: [],
      imagePullSecrets: [],
      tolerations: [],
    },
  };
}

describe("getSelfPodInfo cache keying", () => {
  const KC_A = "/tmp/kubeconfig-cluster-a";
  const KC_B = "/tmp/kubeconfig-cluster-b";

  beforeEach(async () => {
    process.env.HOSTNAME = "paperclip-abc123";
    process.env.PAPERCLIP_NAMESPACE = "paperclip";
    podFixtures[KC_A] = makePod("registry/a:v1", "cluster-a");
    podFixtures[KC_B] = makePod("registry/b:v2", "cluster-b");
    const { resetCache } = await import("./k8s-client.js");
    resetCache();
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_NAMESPACE;
  });

  it("does not leak one kubeconfig's pod spec into another's execution", async () => {
    const { getSelfPodInfo } = await import("./k8s-client.js");

    // Populate the cache from cluster A first — this is the call that used to
    // poison every subsequent lookup.
    const a = await getSelfPodInfo(KC_A);
    expect(a.image).toBe("registry/a:v1");

    const b = await getSelfPodInfo(KC_B);
    expect(b.image).toBe("registry/b:v2");
    expect(b.nodeSelector).toEqual({ workload: "cluster-b" });
    expect(b.inheritedEnv.CLUSTER_TAG).toBe("cluster-b");
  });

  it("still caches per kubeconfig (second call does not re-hit the API)", async () => {
    const { getSelfPodInfo } = await import("./k8s-client.js");

    const first = await getSelfPodInfo(KC_A);
    // Remove the fixture: a cache hit returns the memoized object, whereas a
    // re-read would throw on the now-undefined pod.
    delete podFixtures[KC_A];
    const second = await getSelfPodInfo(KC_A);
    expect(second).toBe(first);
  });

  it("resetCache clears every kubeconfig entry", async () => {
    const { getSelfPodInfo, resetCache } = await import("./k8s-client.js");

    await getSelfPodInfo(KC_A);
    resetCache();
    podFixtures[KC_A] = makePod("registry/a:v99", "cluster-a");
    const refreshed = await getSelfPodInfo(KC_A);
    expect(refreshed.image).toBe("registry/a:v99");
  });
});

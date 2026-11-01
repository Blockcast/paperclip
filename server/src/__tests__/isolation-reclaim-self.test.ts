import { describe, expect, it, vi } from "vitest";

import {
  type ReclaimSelfPodIdentityResult,
  mountCoversPath,
  readReclaimSelfPodIdentity,
  resolveSelfDataClaimName,
  resolveSelfPodName,
  selectSelfContainer,
} from "../services/isolation-reclaim-self.js";

/**
 * The real root, written out rather than imported.
 *
 * A fixture derived from the constant under test cannot constrain it: if the
 * constant moved, every path here would move with it and the suite would still
 * be green against a module reading the wrong tree.
 */
const ROOT = "/paperclip/instances/default/data/k8s-isolation/workspaces";

/**
 * Container name, position and mount path are given three DIFFERENT values on
 * purpose throughout. In the production manifest the server container is named
 * `paperclip`, is first, and its data volume is named `data` and is first --
 * so a fixture that copies the manifest agrees with a module reading any of
 * those by accident, and reading `containers[0]` or `volumes[0]` passes.
 */
function podSpec(overrides: Record<string, unknown> = {}): any {
  return {
    containers: [
      { name: "istio-proxy", image: "mesh/proxy:1", volumeMounts: [{ name: "certs", mountPath: "/certs" }] },
      {
        name: "paperclip",
        image: "harbor.example/paperclip@sha256:abc",
        imagePullPolicy: "IfNotPresent",
        volumeMounts: [
          { name: "cache", mountPath: "/runtime-cache" },
          { name: "store", mountPath: "/paperclip" },
        ],
      },
    ],
    volumes: [
      { name: "cache", emptyDir: {} },
      { name: "store", persistentVolumeClaim: { claimName: "paperclip-data" } },
      { name: "certs", secret: { secretName: "certs" } },
    ],
    imagePullSecrets: [{ name: "registry-pull" }],
    nodeSelector: { workload: "paperclip" },
    tolerations: [{ key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" }],
    ...overrides,
  };
}

function coreApiReturning(pod: unknown): any {
  return { readNamespacedPod: vi.fn().mockResolvedValue(pod) };
}

async function read(pod: unknown, isolationRoot = ROOT): Promise<ReclaimSelfPodIdentityResult> {
  return readReclaimSelfPodIdentity(coreApiReturning(pod), {
    podName: "paperclip-1",
    namespace: "paperclip",
    isolationRoot,
  });
}

describe("resolveSelfPodName", () => {
  it("prefers HOSTNAME over os.hostname", () => {
    expect(resolveSelfPodName({ HOSTNAME: "paperclip-1" } as any, () => "container-id")).toBe(
      "paperclip-1",
    );
  });

  it("falls back to os.hostname when HOSTNAME is unset or blank", () => {
    expect(resolveSelfPodName({} as any, () => "paperclip-0")).toBe("paperclip-0");
    expect(resolveSelfPodName({ HOSTNAME: "   " } as any, () => "paperclip-0")).toBe("paperclip-0");
  });

  it("returns null when neither source answers, rather than an empty name", () => {
    expect(resolveSelfPodName({} as any, () => "")).toBeNull();
  });
});

describe("selectSelfContainer", () => {
  it("matches by name, not by position", () => {
    const result = selectSelfContainer(podSpec().containers);
    expect(result.ok).toBe(true);
    // The sidecar is first. A positional read returns it and this is the assertion
    // that fails.
    expect(result.ok && result.container.name).toBe("paperclip");
    expect(result.ok && result.container.image).toBe("harbor.example/paperclip@sha256:abc");
  });

  it("accepts a single container whatever it is called", () => {
    const result = selectSelfContainer([{ name: "server", image: "x" } as any]);
    expect(result.ok && result.container.name).toBe("server");
  });

  it("refuses an ambiguous pod rather than guessing a sidecar", () => {
    const result = selectSelfContainer([
      { name: "istio-proxy", image: "mesh/proxy:1" },
      { name: "vault-agent", image: "vault:1" },
    ] as any);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("none is named");
  });

  it("refuses a pod with no containers", () => {
    expect(selectSelfContainer([]).ok).toBe(false);
    expect(selectSelfContainer(undefined).ok).toBe(false);
  });
});

describe("mountCoversPath", () => {
  it("covers on a segment boundary, not a string prefix", () => {
    expect(mountCoversPath("/paperclip", ROOT)).toBe(true);
    // The bug a bare startsWith() has.
    expect(mountCoversPath("/paper", ROOT)).toBe(false);
    expect(mountCoversPath("/paperclip-other", ROOT)).toBe(false);
  });

  it("treats the mount path itself as covered, and normalises a trailing slash", () => {
    expect(mountCoversPath("/paperclip/instances", "/paperclip/instances")).toBe(true);
    expect(mountCoversPath("/paperclip/", ROOT)).toBe(true);
  });

  it("covers everything from the root mount, and rejects a relative path", () => {
    expect(mountCoversPath("/", ROOT)).toBe(true);
    expect(mountCoversPath("paperclip", ROOT)).toBe(false);
    expect(mountCoversPath(undefined, ROOT)).toBe(false);
  });

  it("does not cover a sibling tree", () => {
    expect(mountCoversPath("/runtime-cache", ROOT)).toBe(false);
  });
});

describe("resolveSelfDataClaimName", () => {
  it("finds the claim by mount path when volume name and position both disagree", () => {
    const spec = podSpec();
    const container = spec.containers[1];
    // `store` is neither named `data` nor first in spec.volumes.
    expect(resolveSelfDataClaimName(spec, container, ROOT)).toEqual({
      ok: true,
      claimName: "paperclip-data",
    });
  });

  // Asserted in BOTH mount orderings. With only one, whichever ordering puts
  // the deep mount first is satisfied by `covering[0]` and the test proves
  // nothing -- which is exactly how this one first passed against a positional
  // read.
  it.each([
    ["deep mount declared first", ["deep", "shallow"]],
    ["shallow mount declared first", ["shallow", "deep"]],
  ])("prefers the longest covering mount, the way the kernel resolves it (%s)", (_label, order) => {
    const mounts: Record<string, unknown> = {
      deep: { name: "deep", mountPath: "/paperclip/instances/default/data" },
      shallow: { name: "shallow", mountPath: "/paperclip" },
    };
    const spec = podSpec({
      containers: [
        {
          name: "paperclip",
          image: "i",
          volumeMounts: (order as string[]).map((key) => mounts[key]),
        },
      ],
      volumes: [
        { name: "shallow", persistentVolumeClaim: { claimName: "outer-claim" } },
        { name: "deep", persistentVolumeClaim: { claimName: "inner-claim" } },
      ],
    });
    expect(resolveSelfDataClaimName(spec, spec.containers[0], ROOT)).toEqual({
      ok: true,
      claimName: "inner-claim",
    });
  });

  it("reports null for a covering mount that is verifiably not a PVC", () => {
    const spec = podSpec({
      containers: [{ name: "paperclip", image: "i", volumeMounts: [{ name: "scratch", mountPath: "/paperclip" }] }],
      volumes: [{ name: "scratch", emptyDir: {} }],
    });
    expect(resolveSelfDataClaimName(spec, spec.containers[0], ROOT)).toEqual({
      ok: true,
      claimName: null,
    });
  });

  it("REFUSES when nothing covers the root — that is not a null claim", () => {
    const spec = podSpec({
      containers: [{ name: "paperclip", image: "i", volumeMounts: [{ name: "cache", mountPath: "/runtime-cache" }] }],
    });
    const result = resolveSelfDataClaimName(spec, spec.containers[0], ROOT);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(ROOT);
  });

  it("refuses when the mounted volume is absent from the pod spec", () => {
    const spec = podSpec({
      containers: [{ name: "paperclip", image: "i", volumeMounts: [{ name: "ghost", mountPath: "/paperclip" }] }],
      volumes: [{ name: "store", persistentVolumeClaim: { claimName: "paperclip-data" } }],
    });
    const result = resolveSelfDataClaimName(spec, spec.containers[0], ROOT);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("ghost");
  });

  it("treats a blank claim name as no claim rather than an empty-string claim", () => {
    const spec = podSpec({
      containers: [{ name: "paperclip", image: "i", volumeMounts: [{ name: "store", mountPath: "/paperclip" }] }],
      volumes: [{ name: "store", persistentVolumeClaim: { claimName: "   " } }],
    });
    expect(resolveSelfDataClaimName(spec, spec.containers[0], ROOT)).toEqual({
      ok: true,
      claimName: null,
    });
  });
});

describe("readReclaimSelfPodIdentity", () => {
  it("derives claim, image and scheduling from the live pod", async () => {
    const result = await read({ spec: podSpec() });
    expect(result).toEqual({
      ok: true,
      identity: {
        podName: "paperclip-1",
        claimName: "paperclip-data",
        image: "harbor.example/paperclip@sha256:abc",
        imagePullPolicy: "IfNotPresent",
        imagePullSecrets: [{ name: "registry-pull" }],
        nodeSelector: { workload: "paperclip" },
        tolerations: [
          { key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" },
        ],
      },
    });
  });

  it("omits scheduling fields the pod does not carry rather than emitting empties", async () => {
    const result = await read({
      spec: {
        containers: [{ name: "paperclip", image: "i", volumeMounts: [{ name: "s", mountPath: "/paperclip" }] }],
        volumes: [{ name: "s", persistentVolumeClaim: { claimName: "c" } }],
        nodeSelector: {},
        tolerations: [],
        imagePullSecrets: [],
      },
    });
    expect(result).toEqual({
      ok: true,
      identity: { podName: "paperclip-1", claimName: "c", image: "i" },
    });
  });

  it("fails closed when the API read throws", async () => {
    const coreApi: any = { readNamespacedPod: vi.fn().mockRejectedValue(new Error("forbidden")) };
    const result = await readReclaimSelfPodIdentity(coreApi, {
      podName: "paperclip-1",
      namespace: "paperclip",
      isolationRoot: ROOT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("forbidden");
  });

  it("fails closed on a pod with no spec, and on a container with no image", async () => {
    expect((await read({})).ok).toBe(false);
    const noImage = await read({
      spec: {
        containers: [{ name: "paperclip", volumeMounts: [{ name: "s", mountPath: "/paperclip" }] }],
        volumes: [{ name: "s", persistentVolumeClaim: { claimName: "c" } }],
      },
    });
    expect(noImage.ok).toBe(false);
    expect(noImage.ok === false && noImage.reason).toContain("no image");
  });

  it("reads the pod named in the options, in the namespace given", async () => {
    const coreApi = coreApiReturning({ spec: podSpec() });
    await readReclaimSelfPodIdentity(coreApi, {
      podName: "paperclip-0",
      namespace: "other-ns",
      isolationRoot: ROOT,
    });
    expect(coreApi.readNamespacedPod).toHaveBeenCalledWith({
      name: "paperclip-0",
      namespace: "other-ns",
    });
  });

  it("defaults the isolation root to the reaper's, so one constant defines the tree", async () => {
    // No isolationRoot passed: the production root must be what gets covered.
    const result = await readReclaimSelfPodIdentity(coreApiReturning({ spec: podSpec() }), {
      podName: "paperclip-1",
      namespace: "paperclip",
    });
    expect(result).toMatchObject({ ok: true, identity: { claimName: "paperclip-data" } });
  });
});

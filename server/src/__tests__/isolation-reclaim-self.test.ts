import { describe, expect, it, vi } from "vitest";

import {
  type ReclaimSelfPodIdentityResult,
  mountCoversPath,
  readReclaimSelfPodIdentity,
  resolveSelfDataClaimName,
  resolveSelfImage,
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

/**
 * Two LITERAL digests, neither derived from the other or from the fixture's
 * spec image. The whole point of this resolver is that the kubelet's answer
 * and the operator's can disagree, so a test in which they are spelled from
 * one source cannot see the disagreement.
 */
const SERVER_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const SIDECAR_DIGEST = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

describe("resolveSelfImage", () => {
  it("prefers the digest the kubelet resolved over the reference the operator wrote", () => {
    expect(resolveSelfImage("harbor.example/paperclip:main", `harbor.example/paperclip@${SERVER_DIGEST}`)).toBe(
      `harbor.example/paperclip@${SERVER_DIGEST}`,
    );
  });

  it("strips a docker-pullable:// scheme prefix before judging the reference", () => {
    expect(
      resolveSelfImage("harbor.example/paperclip:main", `docker-pullable://harbor.example/paperclip@${SERVER_DIGEST}`),
    ).toBe(`harbor.example/paperclip@${SERVER_DIGEST}`);
  });

  it.each([
    // Names a build, cannot be pulled: no repository. This is the one a
    // credulous `imageID ?? specImage` would hand to the Job verbatim, and the
    // Job would then never start -- reported as a deadline, not as a manifest
    // problem.
    ["a bare digest with no repository", SERVER_DIGEST],
    ["a reference carrying no digest at all", "harbor.example/paperclip:main"],
    ["a truncated digest", "harbor.example/paperclip@sha256:abc"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["undefined", undefined],
  ])("falls back to the spec image for %s", (_label, imageID) => {
    expect(resolveSelfImage("harbor.example/paperclip:main", imageID as string | undefined)).toBe(
      "harbor.example/paperclip:main",
    );
  });
});

describe("readReclaimSelfPodIdentity image resolution", () => {
  /**
   * `containerStatuses` is NOT ordered to match `spec.containers`, so both
   * orderings are asserted with the same expected answer. With only one, a
   * positional read is green and the Job is launched from a sidecar's build on
   * exactly the multi-container pod the name match exists to survive.
   */
  it.each([
    ["statuses in spec order", ["istio-proxy", "paperclip"]],
    ["statuses in reverse order", ["paperclip", "istio-proxy"]],
  ])("matches the container status by name, not position (%s)", async (_label, order) => {
    const digests: Record<string, string> = {
      paperclip: `harbor.example/paperclip@${SERVER_DIGEST}`,
      "istio-proxy": `mesh/proxy@${SIDECAR_DIGEST}`,
    };
    const result = await read({
      spec: podSpec(),
      status: { containerStatuses: order.map((name) => ({ name, imageID: digests[name] })) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.image).toBe(`harbor.example/paperclip@${SERVER_DIGEST}`);
  });

  it("keeps the spec image when this pod has no status for its own container", async () => {
    const result = await read({
      spec: podSpec(),
      status: { containerStatuses: [{ name: "istio-proxy", imageID: `mesh/proxy@${SIDECAR_DIGEST}` }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.image).toBe("harbor.example/paperclip@sha256:abc");
  });
});

import * as k8s from "@kubernetes/client-node";

import { DEFAULT_ISOLATION_WORKSPACE_ROOT } from "./isolation-workspace-reaper.js";

/**
 * What this deployment needs to know about ITSELF before it may sweep a
 * foreign claim (PEN-5151).
 *
 * The fleet sweep needs two facts that are not in any config file, and both
 * are properties of the running pod rather than of the deployment's intent:
 *
 * - **`claimName`** — the claim this server itself mounts, which the sweep
 *   must EXCLUDE. `listReclaimableClaims` takes it as a required argument for
 *   a reason: naming the server's own PVC in an agent's
 *   `workspaceVolumeClaim` is a realistic operator choice (the adapter's own
 *   fixtures use `paperclip-data`), and failing open here means launching
 *   recursive unlinks against the volume the mounted reaper is already
 *   walking.
 * - **`image`** — the executor ships INSIDE the server image, so reading it
 *   off this pod means the Job always runs the executor from the same build as
 *   the server that planned it. That is exactly the skew
 *   `report_unsupported_version` exists to catch, closed here by construction
 *   instead. An env var would let the two drift and call it configuration.
 *
 * The scheduling fields come along for a duller reason: the Job has to be
 * ABLE to run. This deployment's nodes carry a `workload` selector and a
 * `dedicated` taint, and the image is in a private registry — a Job built
 * without them is admitted and then sits Pending forever, which the runner
 * reports as a deadline rather than as a manifest problem. Inheriting them
 * from the pod that is demonstrably scheduled is the one derivation that
 * cannot go stale.
 *
 * ## Why the container is matched by name, and what happens when it is not
 *
 * `getSelfPodInfo` in the vendored claude_k8s adapter does the same read and
 * is not importable from here (it is not a workspace member), so this is a
 * deliberate re-derivation rather than a missed reuse — the same position the
 * port module takes on `kubernetesStatusIs`. It differs in one place on
 * purpose: the adapter falls back to `containers[0]` when no container is
 * named `paperclip`, documented there as matching prior behaviour. Picking a
 * service-mesh sidecar's image here would launch the unlink Job from the wrong
 * build, so this refuses an ambiguous pod instead — but only a genuinely
 * ambiguous one. A single-container pod is unambiguous whatever its container
 * is called, so it is accepted by count; refusing it would strand a dev
 * deployment that has nothing wrong with it.
 *
 * ## The claim is found by MOUNT PATH, not by volume name or position
 *
 * The volume happens to be called `data` and happens to be first. Neither is a
 * fact about this deployment that anything enforces, and a test fixture that
 * encodes either passes while the code reads the wrong volume. What IS
 * load-bearing is that the claim we must exclude is the one holding the tree
 * the mounted reaper walks — so the mount is found by asking which
 * `volumeMounts` entry COVERS {@link DEFAULT_ISOLATION_WORKSPACE_ROOT}, with
 * the LONGEST match winning the way the kernel resolves it. A deployment that
 * splits the data directory onto its own volume is then read correctly with no
 * change here, and the derivation is tied to the one constant that already
 * defines what is being reclaimed.
 *
 * ## Two different answers, and only one of them is `null`
 *
 * - **No covering mount at all ⇒ refuse.** Not knowing which of our own
 *   volumes holds the isolation tree means not understanding this pod, and the
 *   next act is `rm -rf` somewhere.
 * - **A covering mount that is not a PVC ⇒ `claimName: null`.** That is a
 *   measured "this deployment holds no claim to exclude" — an `emptyDir` or a
 *   host path — which is the exact thing `selfClaimName: null` is specified to
 *   mean. It is a finding, not a shrug.
 *
 * A read that throws is reported as `{ ok: false }` and the caller does not
 * start the sweep, which is the whole fail-closed posture: a server that
 * cannot name its own claim has no business naming anyone else's.
 */
export interface ReclaimSelfPodIdentity {
  /** The pod this process is running in. */
  podName: string;
  /**
   * The claim mounted over the isolation root, or `null` when that mount is
   * verified not to be a PVC. Never `null` for "could not tell" — see header.
   */
  claimName: string | null;
  /** This pod's own image, so the executor is the same build as the planner. */
  image: string;
  imagePullPolicy?: string;
  imagePullSecrets?: k8s.V1LocalObjectReference[];
  nodeSelector?: Record<string, string>;
  tolerations?: k8s.V1Toleration[];
}

export type ReclaimSelfPodIdentityResult =
  | { ok: true; identity: ReclaimSelfPodIdentity }
  | { ok: false; reason: string };

/**
 * The pod name, from the same pair `scheduler-lease.ts` uses.
 *
 * `HOSTNAME` is set by the kubelet to the pod's hostname and `os.hostname()`
 * agrees with it in a pod; taking both keeps this working under a runtime that
 * sets only one. The StatefulSet sets `spec.hostname` explicitly, so the value
 * is the pod name rather than a truncated or generated one.
 */
export function resolveSelfPodName(
  env: NodeJS.ProcessEnv,
  osHostname: () => string,
): string | null {
  const fromEnv = env.HOSTNAME?.trim();
  if (fromEnv) return fromEnv;
  const fromOs = osHostname()?.trim();
  return fromOs || null;
}

/** The container name the chart gives the server. */
export const SELF_CONTAINER_NAME = "paperclip";

/**
 * The container this process is. Named match first, then an unambiguous
 * single-container pod, then refusal. See the header for why the adapter's
 * positional fallback is not reproduced.
 */
export function selectSelfContainer(
  containers: ReadonlyArray<k8s.V1Container> | undefined,
): { ok: true; container: k8s.V1Container } | { ok: false; reason: string } {
  const list = containers ?? [];
  if (list.length === 0) return { ok: false, reason: "pod spec lists no containers" };
  const named = list.find((container) => container.name === SELF_CONTAINER_NAME);
  if (named) return { ok: true, container: named };
  if (list.length === 1) return { ok: true, container: list[0]! };
  return {
    ok: false,
    reason:
      `pod has ${list.length} containers and none is named "${SELF_CONTAINER_NAME}" ` +
      `(${list.map((container) => container.name).join(", ")})`,
  };
}

/**
 * Does a mount at `mountPath` cover `target`?
 *
 * Compared on path SEGMENTS, not as a string prefix: `/paper` must not cover
 * `/paperclip/...`, which a bare `startsWith` would say it does. A trailing
 * slash is normalised away so `/paperclip/` and `/paperclip` answer alike, and
 * a mount at `/` covers everything.
 */
export function mountCoversPath(mountPath: string | undefined, target: string): boolean {
  if (!mountPath || !mountPath.startsWith("/")) return false;
  const normalized =
    mountPath.length > 1 && mountPath.endsWith("/") ? mountPath.replace(/\/+$/, "") : mountPath;
  if (normalized === "/") return true;
  return target === normalized || target.startsWith(`${normalized}/`);
}

/**
 * The claim backing the volume mounted over `isolationRoot`.
 *
 * Longest covering mount wins, matching mount resolution: a deployment with
 * both `/paperclip` and `/paperclip/instances/default/data` mounted stores the
 * tree on the second.
 */
export function resolveSelfDataClaimName(
  spec: k8s.V1PodSpec,
  container: k8s.V1Container,
  isolationRoot: string,
): { ok: true; claimName: string | null } | { ok: false; reason: string } {
  const covering = (container.volumeMounts ?? []).filter((mount) =>
    mountCoversPath(mount.mountPath, isolationRoot),
  );
  if (covering.length === 0) {
    return {
      ok: false,
      reason: `no volume mount on container "${container.name}" covers ${isolationRoot}`,
    };
  }
  const best = covering.reduce((longest, candidate) =>
    (candidate.mountPath?.length ?? 0) > (longest.mountPath?.length ?? 0) ? candidate : longest,
  );
  const volume = (spec.volumes ?? []).find((entry) => entry.name === best.name);
  if (!volume) {
    return {
      ok: false,
      reason: `volume "${best.name}" is mounted at ${best.mountPath} but absent from the pod spec`,
    };
  }
  // A verified non-PVC mount, not a failure: see the header.
  return { ok: true, claimName: volume.persistentVolumeClaim?.claimName?.trim() || null };
}

export interface ReadReclaimSelfPodIdentityOptions {
  podName: string;
  namespace: string;
  /** Overridable for tests; production always reclaims under the reaper's root. */
  isolationRoot?: string;
}

/** Read this pod and derive everything the sweep needs from it. */
export async function readReclaimSelfPodIdentity(
  coreApi: Pick<k8s.CoreV1Api, "readNamespacedPod">,
  options: ReadReclaimSelfPodIdentityOptions,
): Promise<ReclaimSelfPodIdentityResult> {
  const isolationRoot = options.isolationRoot ?? DEFAULT_ISOLATION_WORKSPACE_ROOT;
  let pod: k8s.V1Pod;
  try {
    pod = await coreApi.readNamespacedPod({
      name: options.podName,
      namespace: options.namespace,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `reading pod ${options.namespace}/${options.podName} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const spec = pod.spec;
  if (!spec) return { ok: false, reason: `pod ${options.podName} has no spec` };

  const selected = selectSelfContainer(spec.containers);
  if (!selected.ok) return selected;
  const image = selected.container.image?.trim();
  if (!image) {
    return { ok: false, reason: `container "${selected.container.name}" has no image` };
  }

  const claim = resolveSelfDataClaimName(spec, selected.container, isolationRoot);
  if (!claim.ok) return claim;

  return {
    ok: true,
    identity: {
      podName: options.podName,
      claimName: claim.claimName,
      image,
      ...(selected.container.imagePullPolicy
        ? { imagePullPolicy: selected.container.imagePullPolicy }
        : {}),
      ...(spec.imagePullSecrets?.length ? { imagePullSecrets: [...spec.imagePullSecrets] } : {}),
      ...(spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0
        ? { nodeSelector: { ...spec.nodeSelector } }
        : {}),
      ...(spec.tolerations?.length ? { tolerations: [...spec.tolerations] } : {}),
    },
  };
}

/**
 * Build an in-cluster client and read this pod with it.
 *
 * In-cluster only, with no `loadFromDefault` fallback — the same position
 * `createInClusterIsolationReclaimJobPort` takes, for the same reason. A
 * kubeconfig picked up from a developer's home directory would answer this
 * question about a different cluster's pod, and the answer is the claim name a
 * recursive unlink is aimed at.
 */
export async function readInClusterReclaimSelfPodIdentity(
  options: ReadReclaimSelfPodIdentityOptions,
): Promise<ReclaimSelfPodIdentityResult> {
  if (!process.env.KUBERNETES_SERVICE_HOST) {
    return { ok: false, reason: "not running in a kubernetes pod" };
  }
  let coreApi: k8s.CoreV1Api;
  try {
    const kubeConfig = new k8s.KubeConfig();
    kubeConfig.loadFromCluster();
    coreApi = kubeConfig.makeApiClient(k8s.CoreV1Api);
  } catch (error) {
    return {
      ok: false,
      reason: `in-cluster kube config failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return readReclaimSelfPodIdentity(coreApi, options);
}

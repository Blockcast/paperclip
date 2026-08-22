import * as k8s from "@kubernetes/client-node";
import { readFileSync } from "node:fs";
import {
  isAgentInheritableEnvFromRef,
  isAgentInheritableEnvName,
  isAgentInheritableSecretVolume,
} from "./inherit-allowlist.js";

/**
 * Cached self-pod introspection result. Queried once on first execute(),
 * then reused for all subsequent Job builds so every Job inherits the
 * Deployment's image, imagePullSecrets, DNS config, PVC claim, and scheduling.
 */
export interface SelfPodSecretVolume {
  volumeName: string;
  secretName: string;
  mountPath: string;
  defaultMode: number | undefined;
  /**
   * The source volume's `items:` key selector, when it has one.
   *
   * A source volume that projects a single key out of a multi-key Secret must
   * keep projecting a single key after propagation. Dropping this widened the
   * Job pod's view of the Secret to *every* key in it — the agent pod ended up
   * holding more key material than the container the mount was copied from.
   *
   * Optional, mirroring `V1SecretVolumeSource.items` upstream: most mounts
   * project the whole Secret and legitimately have no selector.
   */
  items?: k8s.V1KeyToPath[];
}

export interface SelfPodInfo {
  namespace: string;
  image: string;
  imagePullSecrets: Array<{ name: string }>;
  dnsConfig: k8s.V1PodDNSConfig | undefined;
  nodeSelector: Record<string, string>;
  tolerations: k8s.V1Toleration[];
  pvcClaimName: string | null;
  secretVolumes: SelfPodSecretVolume[];
  /**
   * Env vars inherited from the Deployment container (literal name/value pairs).
   *
   * Filtered through `isAgentInheritableEnvName` (BLO-22514) — this is NOT the
   * server's full env, and callers must not assume an arbitrary server var is
   * present here.
   */
  inheritedEnv: Record<string, string>;
  /**
   * Env vars with valueFrom (secretKeyRef, configMapKeyRef, etc.) from the
   * Deployment container. Filtered on the same allowlist as `inheritedEnv`:
   * a secretKeyRef is hidden from `GET Pod` but is still fully readable by the
   * agent process, so it gets no exemption.
   */
  inheritedEnvValueFrom: k8s.V1EnvVar[];
  /**
   * envFrom sources (secretRef, configMapRef) from the Deployment container.
   * Allowlisted by referenced object name; empty allowlist by default.
   */
  inheritedEnvFrom: k8s.V1EnvFromSource[];
}

/**
 * Self-pod introspection cache, keyed by (kubeconfig path, namespace, hostname).
 * A process-global single-entry cache would be wrong: API clients and
 * `execute()` accept a different kubeconfig per request, so the first
 * execution to populate the cache would hand its cluster's image, scheduling,
 * PVC, env and Secret references to every later execution running against a
 * *different* cluster.
 */
const selfPodCache = new Map<string, SelfPodInfo>();

/**
 * Cache keyed by kubeconfig path (empty string = in-cluster).
 * Supports multiple agents with different kubeconfigs.
 */
const kcCache = new Map<string, k8s.KubeConfig>();

function getKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const key = kubeconfigPath ?? "";
  let kc = kcCache.get(key);
  if (!kc) {
    kc = new k8s.KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      // Bare loadFromCluster() throws ENOENT on
      // /var/run/secrets/kubernetes.io/serviceaccount/ca.crt when the pod's
      // ServiceAccount token isn't mounted. That message buried the real
      // misconfiguration (Helm serviceAccount.automountToken=false) in
      // adapter logs, so swap it for an actionable error.
      if (!process.env.KUBERNETES_SERVICE_HOST) {
        throw new Error(
          "claude_k8s: in-cluster auth unavailable — KUBERNETES_SERVICE_HOST is unset (not running in a Kubernetes pod) and no kubeconfig path was provided",
        );
      }
      try {
        kc.loadFromCluster();
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(
          `claude_k8s: failed to load in-cluster kubeconfig — the pod's ServiceAccount token is not mounted (set Helm serviceAccount.automountToken=true and rbac.create=true). Underlying error: ${cause}`,
        );
      }
    }
    kcCache.set(key, kc);
  }
  return kc;
}

export function getBatchApi(kubeconfigPath?: string): k8s.BatchV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.BatchV1Api);
}

export function getCoreApi(kubeconfigPath?: string): k8s.CoreV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.CoreV1Api);
}

export function getAuthzApi(kubeconfigPath?: string): k8s.AuthorizationV1Api {
  return getKubeConfig(kubeconfigPath).makeApiClient(k8s.AuthorizationV1Api);
}

export function getLogApi(kubeconfigPath?: string): k8s.Log {
  return new k8s.Log(getKubeConfig(kubeconfigPath));
}

/**
 * Read the current pod's namespace. Checks (in order):
 * 1. PAPERCLIP_NAMESPACE env var (set explicitly in Deployment)
 * 2. Service account namespace file (standard in-cluster path)
 * 3. POD_NAMESPACE env var (Downward API convention)
 * Falls back to "default" only if none of the above are available.
 */
function readInClusterNamespace(): string {
  const fromEnv = process.env.PAPERCLIP_NAMESPACE ?? process.env.POD_NAMESPACE;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/namespace", "utf-8").trim();
  } catch {
    return "default";
  }
}

/**
 * Query the K8s API for our own pod spec and cache the result.
 * Extracts image, imagePullSecrets, dnsConfig, scheduling, PVC claim name,
 * and environment variables to forward to Job pods.
 */
export async function getSelfPodInfo(kubeconfigPath?: string): Promise<SelfPodInfo> {
  const hostname = process.env.HOSTNAME;
  if (!hostname) {
    throw new Error("claude_k8s: HOSTNAME env var not set — cannot introspect running pod");
  }

  const namespace = readInClusterNamespace();
  // NUL-joined so no component can forge a key boundary via its own content.
  const cacheKey = [kubeconfigPath ?? "", namespace, hostname].join("\u0000");
  const cached = selfPodCache.get(cacheKey);
  if (cached) return cached;

  const coreApi = getCoreApi(kubeconfigPath);
  const pod = await coreApi.readNamespacedPod({ name: hostname, namespace });

  const spec = pod.spec;
  if (!spec) {
    throw new Error(`claude_k8s: pod ${hostname} has no spec`);
  }

  // Match the Paperclip container by name ("paperclip") to avoid service-mesh
  // sidecars or other injected containers being picked up as the source of
  // truth for the Job spec (finding #9, FAR-15).  Fall back to the first
  // container if no name match is found (matches prior behavior).
  const mainContainer =
    spec.containers.find((c) => c.name === "paperclip") ?? spec.containers[0];
  if (!mainContainer?.image) {
    throw new Error(`claude_k8s: pod ${hostname} has no container image`);
  }

  // Find PVC claim name from volumes mounted at /paperclip
  let pvcClaimName: string | null = null;
  const dataMount = mainContainer.volumeMounts?.find(
    (vm) => vm.mountPath === "/paperclip",
  );
  if (dataMount) {
    const volume = spec.volumes?.find((v) => v.name === dataMount.name);
    pvcClaimName = volume?.persistentVolumeClaim?.claimName ?? null;
  }

  // Discover secret volumes mounted on the main container.
  //
  // Allowlisted (BLO-22514): everything collected here is re-mounted onto every
  // agent Job pod by job-manifest.ts, so an un-allowlisted server mount would
  // hand its key material to every agent under /paperclip/.secrets/...
  const secretVolumes: SelfPodSecretVolume[] = [];
  for (const vm of mainContainer.volumeMounts ?? []) {
    const vol = spec.volumes?.find((v) => v.name === vm.name);
    if (vol?.secret?.secretName) {
      if (!isAgentInheritableSecretVolume(vol.secret.secretName)) continue;
      secretVolumes.push({
        volumeName: vm.name,
        secretName: vol.secret.secretName,
        mountPath: vm.mountPath,
        defaultMode: vol.secret.defaultMode,
        items: vol.secret.items ? [...vol.secret.items] : undefined,
      });
    }
  }

  // Collect env vars from the pod spec's container definition.
  // Agent config env (set in buildEnvVars) will override these.
  //
  // Allowlisted (BLO-22514). This is the single chokepoint for inheritance:
  // job-manifest.ts replays these onto every agent Job in four separate places,
  // so filtering here — rather than at each replay site — means a new replay
  // site cannot reintroduce the leak by forgetting to filter.
  //
  // The `valueFrom` branch is filtered on exactly the same basis as the literal
  // branch. A `secretKeyRef` entry is invisible to a read-only `GET Pod`, which
  // is why an earlier analysis called those "fine" — but invisibility to the
  // Kubernetes API is not confidentiality from the agent: the kubelet resolves
  // it and the value lands in the container's environment either way.
  const inheritedEnv: Record<string, string> = {};
  const inheritedEnvValueFrom: k8s.V1EnvVar[] = [];
  for (const envItem of mainContainer.env ?? []) {
    if (!envItem.name) continue;
    if (!isAgentInheritableEnvName(envItem.name)) continue;
    if (envItem.valueFrom) {
      // Preserve valueFrom entries (secretKeyRef, configMapKeyRef, fieldRef, etc.)
      inheritedEnvValueFrom.push({ name: envItem.name, valueFrom: envItem.valueFrom });
    } else {
      const value = envItem.value ?? "";
      if (value) inheritedEnv[envItem.name] = value;
    }
  }

  // Capture envFrom sources (secretRef, configMapRef) from the container spec.
  //
  // Allowlisted (BLO-22514) by referenced object name. envFrom injects every key
  // of a Secret/ConfigMap under names this filter never observes, so it cannot
  // be reconciled with a per-name allowlist; the allowlist is empty by default
  // and no envFrom exists in deploy/helm/paperclip today.
  const inheritedEnvFrom: k8s.V1EnvFromSource[] = (mainContainer.envFrom ?? []).filter(
    (src) => {
      const refName = src.secretRef?.name ?? src.configMapRef?.name;
      return typeof refName === "string" && isAgentInheritableEnvFromRef(refName);
    },
  );

  const info: SelfPodInfo = {
    namespace,
    image: mainContainer.image,
    imagePullSecrets: (spec.imagePullSecrets ?? []).map((s) => ({
      name: s.name ?? "",
    })).filter((s) => s.name.length > 0),
    dnsConfig: spec.dnsConfig,
    nodeSelector: { ...(spec.nodeSelector ?? {}) },
    tolerations: [...(spec.tolerations ?? [])],
    pvcClaimName,
    secretVolumes,
    inheritedEnv,
    inheritedEnvValueFrom,
    inheritedEnvFrom,
  };

  selfPodCache.set(cacheKey, info);
  return info;
}

/** Reset cached state — useful for tests. */
export function resetCache(): void {
  kcCache.clear();
  selfPodCache.clear();
}

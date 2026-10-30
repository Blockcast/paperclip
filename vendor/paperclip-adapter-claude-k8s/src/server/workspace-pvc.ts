import type * as k8s from "@kubernetes/client-node";

import { getPvc, createPvc } from "./k8s-client.js";

/**
 * PEN-4932 stage 4b — the per-agent workspace claim.
 *
 * Today every agent Job mounts ONE RWX CephFS claim (`paperclip-data`), so
 * every agent pod on a node shares a single ceph-csi volume handle. ceph-csi
 * serialises per-volume-ID (`internal/util/idlocker.go`), and its
 * `NodeUnstageVolume` hold is an uninterruptible kernel `umount` with no
 * timeout — so one wedged unstage strands every agent pod on that node. The
 * measured baseline was 3 independent wedges in 30h; concentration has since
 * made it worse (19 of 21 running agent pods on `k8s-paperclip-3`).
 *
 * This module provisions the replacement: one claim per AGENT. Distinct
 * claims get distinct CephFS subvolumes and therefore distinct volume
 * handles, which is the whole mechanism — the lock keys on the Volume ID, so
 * a wedge is confined to one agent instead of one node.
 *
 * ## Why ReadWriteMany, when the in-tree precedent is ReadWriteOnce
 *
 * `opencode-db-<agentId>` (`paperclip.io/pvc-type=agent-db`) is the existing
 * per-agent claim in this tree and it is RWO. **Its access mode does not
 * transfer, and copying it would be an outage.** One agent runs up to
 * `maxConcurrentRuns` Job pods at once and the scheduler does NOT co-locate
 * them — measured 2026-10-28 in namespace `paperclip`, agent `29033747` held
 * pods on `k8s-paperclip-3` (x2), `-7` and `-11` simultaneously. An RWO claim
 * there hits `Multi-Attach` and wedges every concurrent run of that agent:
 * strictly worse, and far more frequent, than the blast radius it would be
 * fixing. The opencode claim gets away with RWO because exactly one opencode
 * process uses each.
 *
 * RWX costs nothing against the objective. Each dynamically provisioned
 * CephFS PVC gets its own subvolume and its own `volumeHandle` regardless of
 * access mode — it is DISTINCTNESS that buys the smaller blast radius, not
 * exclusivity.
 *
 * ## This module is deliberately not wired yet
 *
 * Nothing calls `ensureAgentWorkspacePvc` on the run path. The claim cannot be
 * adopted until the prompt bundle reaches the pod over a channel that does not
 * assume a shared volume — on a per-agent claim the server writes a complete
 * bundle into its OWN volume and the pod gets the seeded, empty directory, so
 * `--append-system-prompt-file` names a file that does not exist and the agent
 * silently loses its instructions (invariant 1; see `prompt-bundle-projection.ts`,
 * which is built and measuring but not yet delivering). Landing the provisioner
 * reviewed and inert ahead of the flip is the same posture #3153/#3157/#3158
 * took for that channel.
 */

/** Label marking a claim this module owns. Mirrors `agent-db` on the opencode claims. */
export const AGENT_WORKSPACE_PVC_TYPE = "agent-workspace";

/** Default capacity request. See `ensureAgentWorkspacePvc` for how this was chosen. */
export const DEFAULT_AGENT_WORKSPACE_CAPACITY = "50Gi";

/**
 * Default StorageClass. `cephfs` is the cluster default and is what
 * `paperclip-data` itself uses (`cephfs.csi.ceph.com`, RWX, Delete,
 * `allowVolumeExpansion: true`) — verified against the live cluster rather
 * than assumed, because the whole design needs a class that can dynamically
 * provision RWX.
 */
export const DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS = "cephfs";

/**
 * Claim name for an agent's workspace volume.
 *
 * Pure and exported so the manifest builder and the provisioner derive the
 * name the same way. Two places computing a claim name independently is how a
 * Job ends up mounting a claim nothing provisioned.
 *
 * Agent ids are UUIDs, so the sanitiser is a backstop rather than the normal
 * path. It is still required: a name that is not a DNS-1123 subdomain is
 * rejected by the API server at create time, which would surface as an opaque
 * admission error rather than as the bad id that caused it.
 */
export function agentWorkspaceClaimName(agentId: string): string {
  const slug = agentId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
  if (!slug) {
    throw new Error(
      `cannot derive a workspace claim name from agent id ${JSON.stringify(agentId)}: ` +
        `it contains no DNS-1123 characters`,
    );
  }
  return `agent-workspace-${slug}`;
}

export interface EnsureAgentWorkspacePvcInput {
  agentId: string;
  namespace: string;
  /** StorageClass name. Defaults to `cephfs`. */
  storageClass?: string;
  /** Capacity request. Defaults to `200Gi`. */
  capacity?: string;
  kubeconfigPath?: string;
}

/**
 * Create the agent's workspace claim if it does not exist, and return its name.
 *
 * Idempotent by get-then-create: the claim is long-lived and shared by every
 * concurrent run of the agent, so the common path is a single read.
 *
 * ## Capacity
 *
 * `50Gi` by default, derived from measurement rather than picked.
 *
 * A per-agent claim does NOT just carry agent-scoped data. The company-scoped
 * trees — the project checkout, `wt/<companyId>`, the pnpm store,
 * `work/<companyId>` — are read by every agent of the same company, so
 * per-agent volumes DUPLICATE them. That duplication is the price of the fix,
 * not an option inside it: the lock keys on the volume handle, so one
 * surviving `subPath` to the shared handle preserves the whole node-wide
 * wedge, and a "keep the shared trees shared" compromise pays the full
 * provisioning cost for zero blast-radius reduction.
 *
 * Measured on the Penstock subtree (plan §5, corroborated independently
 * 2026-10-30 from a live agent pod: `projects` 4.9 G, pnpm store 3.0 G):
 * ≈13.2 G per company, the bulk of it checkout + worktrees + pnpm. `50Gi`
 * is therefore ~4x the measured steady state.
 *
 * It is a ceiling, not an allocation — CephFS subvolume quotas are thin
 * provisioned, so 21 agents at 50Gi do not reserve 1 Ti. And it is not a
 * one-way door: the `cephfs` class sets `allowVolumeExpansion: true`, so a
 * claim that outgrows it can be expanded in place.
 *
 * Two reasons the number is a request and not a guarantee, both worth knowing
 * before the flip: `du` counts allocated blocks and pnpm's hardlink sharing
 * does NOT survive a copy to a separate volume, so the duplicated copies are
 * genuinely additive; and worktree count grows over time.
 *
 * ## Concurrency
 *
 * Two concurrent runs of the same agent can both observe "absent" and both
 * create. The loser gets a 409 `AlreadyExists`, which is treated as success —
 * the winner created exactly the object this call wanted, and the name encodes
 * the agent identity, so there is no ambiguity about whose claim it is. Any
 * other error propagates: failing the run is correct when we cannot establish
 * the volume it is about to mount.
 */
export async function ensureAgentWorkspacePvc(
  input: EnsureAgentWorkspacePvcInput,
): Promise<string> {
  const { agentId, namespace, kubeconfigPath } = input;
  const pvcName = agentWorkspaceClaimName(agentId);

  const existing = await getPvc(namespace, pvcName, kubeconfigPath);
  if (existing) return pvcName;

  const storageClassName =
    (input.storageClass ?? "").trim() || DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS;
  const storage = (input.capacity ?? "").trim() || DEFAULT_AGENT_WORKSPACE_CAPACITY;

  const body: k8s.V1PersistentVolumeClaim = {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: pvcName,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "paperclip",
        "paperclip.io/agent-id": agentId,
        "paperclip.io/pvc-type": AGENT_WORKSPACE_PVC_TYPE,
      },
    },
    spec: {
      // RWX, NOT RWO. See the module header — an agent's concurrent run pods
      // land on different nodes, so RWO would Multi-Attach and wedge them.
      accessModes: ["ReadWriteMany"],
      storageClassName,
      resources: { requests: { storage } },
    },
  };

  try {
    await createPvc(namespace, body, kubeconfigPath);
  } catch (err) {
    // A concurrent run of this same agent won the race. That is the object we
    // wanted, under a name that encodes the agent id, so this is success.
    if (!isAlreadyExists(err)) throw err;
  }

  return pvcName;
}

/**
 * Kubernetes 409 (`AlreadyExists`).
 *
 * Duplicated from `execute.ts`'s `isK8s409` rather than imported, to keep this
 * module free of that module's import graph — `execute.ts` pulls in the whole
 * run path, and a provisioner that only needs two Core API calls should not
 * drag it into every test that touches claim naming.
 *
 * `code` is the reliable signal: @kubernetes/client-node's `ApiException` is
 * constructed as `super("HTTP-Code: " + code + ...)` and then sets only
 * `this.code`, leaving `statusCode` and `response` undefined. The other probes
 * cover a v0.x-shaped error and an error re-thrown as a plain Error carrying
 * just the message text.
 */
function isAlreadyExists(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as unknown as Record<string, unknown>;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp?.statusCode === 409 || resp?.status === 409) return true;
  if (e.statusCode === 409 || e.code === 409) return true;
  return /HTTP-Code:\s*409\b/.test(err.message);
}

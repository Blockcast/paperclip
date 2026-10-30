import { describe, it, expect } from "vitest";
import type * as k8s from "@kubernetes/client-node";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest } from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

// BLO-48361: the root overlay on narrowed runs hid the chart-seeded pre-push
// hook, so the egress guard refused every push. The fix was to re-expose the
// hook dir read-only from `data` while its `.local/share` siblings (the mkcert
// CA key) stayed behind the overlay.
//
// PEN-4932 stage 3b-iii retires that fix by removing what it repaired: the hook
// is baked into the agent image (`BAKED_HOOKS_DIR`) and `hooksDirectory()`
// resolves there unconditionally, so the overlay hiding the PVC copy is no
// longer an outage — it is the intended end state, and `ROOT_TOOLCHAIN_SUBPATHS`
// is empty.
//
// This file is kept, inverted, rather than deleted. BLO-48361 cost 2h17m of
// fleet-wide publishing and the seed's own success log stayed true throughout,
// because the seed writes to the PVC and the Job pod sees an overlay. The
// standing lesson is that this join is only ever visible from the MANIFEST, so
// the manifest keeps a test — now asserting that neither path is reachable off
// the shared volume, which is the state the push path actually depends on.

const ctx: AdapterExecutionContext = {
  runId: "run-abc12345",
  agent: { id: "agent-abc", companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig: {} },
  runtime: {
    sessionId: null,
    sessionParams: null,
    sessionDisplayId: null,
    taskKey: null,
    isolation: {
      isolationMode: "workspace",
      isolationKey: "workspace:ws-1",
      workspaceRoot: "/paperclip/instances/default/projects/co1/proj-1/_default",
      homeRoot: "/paperclip/instances/default/data/k8s-isolation/workspaces/ws-1/home",
      sessionRoot: "/paperclip/instances/default/data/k8s-isolation/workspaces/ws-1/session",
      cacheRoot: "/runtime-cache/paperclip-workspaces/ws-1/cache",
      tmpRoot: "/runtime-cache/paperclip-workspaces/ws-1/tmp",
      storage: { workspace: "persistent", home: "persistent", session: "persistent", cache: "ephemeral" },
    } as unknown as NonNullable<AdapterExecutionContext["runtime"]["isolation"]>,
  },
  config: { serviceAccountName: "test-sa" },
  context: {},
  onLog: async () => {},
};

const selfPod: SelfPodInfo = {
  namespace: "paperclip",
  image: "paperclipai/paperclip:latest",
  imagePullSecrets: [],
  dnsConfig: undefined,
  nodeSelector: {},
  tolerations: [],
  pvcClaimName: "paperclip-data",
  secretVolumes: [],
  inheritedEnv: {},
  inheritedEnvValueFrom: [],
  inheritedEnvFrom: [],
};

/** The mount a container sees `target` through: the deepest at or above it. */
function deepestMount(mounts: k8s.V1VolumeMount[], target: string): k8s.V1VolumeMount | undefined {
  let best: k8s.V1VolumeMount | undefined;
  for (const m of mounts) {
    if (target !== m.mountPath && !target.startsWith(`${m.mountPath}/`)) continue;
    if (!best || m.mountPath.length > best.mountPath.length) best = m;
  }
  return best;
}

describe("pre-push hook on narrowed runs (BLO-48361, PEN-4932 stage 3b-iii)", () => {
  it("binds nothing under .local/share off data — hook and mkcert both sit behind the overlay", () => {
    const { job } = buildJobManifest({ ctx, selfPod });
    const spec = job.spec?.template?.spec;
    expect(spec?.volumes?.find((v) => v.name === "root-overlay")?.emptyDir).toBeTruthy();
    for (const container of [spec?.containers[0], spec?.initContainers?.find((c) => c.name === "write-prompt")]) {
      const mounts = container?.volumeMounts ?? [];
      expect(deepestMount(mounts, "/paperclip/.local/share/paperclip-git-hooks/pre-push")?.name).toBe(
        "root-overlay",
      );
      expect(deepestMount(mounts, "/paperclip/.local/share/mkcert/rootCA-key.pem")?.name).toBe("root-overlay");
      // Stated on the subPath as well, not only through `deepestMount`: a bind
      // re-added at a different mountPath would still put the hook back on the
      // shared handle, and the resolution check above would not see it.
      expect(mounts.some((m) => m.subPath === ".local/share/paperclip-git-hooks")).toBe(false);
    }
  });
});

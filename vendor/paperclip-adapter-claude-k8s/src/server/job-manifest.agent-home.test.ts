import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest } from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-2585 — AGENT_HOME must name a path the POD mounts.
//
// The defect, measured 2026-11-07 on the live Cto pod: the server `mkdir -p`s
// `<instanceRoot>/workspaces/<agentId>` on its OWN `/paperclip` mount and exports that
// path to a pod whose `instances/default` is the 16 MiB `instance-overlay` emptyDir with
// `data/` and `skills/` bound over it and NOTHING at `workspaces/`. The variable is set,
// the directory is absent, and every `$AGENT_HOME/...` read is ENOENT — including the 4
// `$AGENT_HOME`-relative paths in the `para-memory-files` skill that at least one seat
// has MANDATED through `desiredSkills`.
//
// A manifest test rather than a unit test on the resolver for the same reason the
// instructions-root suite is one: the property that matters is a JOIN of the env
// projection and what the pod actually mounts, and neither half alone can show it.
// The positive control below is exactly that join — the root AGENT_HOME now names has
// to appear as a real volumeMount on the agent container, or the variable is still
// pointing at nothing and this suite would pass on a fix that fixed nothing.

const AGENT_ID = "29033747-e513-46d5-8a13-dcb5dac10017";
const INSTRUCTIONS_ROOT = "/paperclip/.paperclip/instances/default/companies/Penstock/agents/cto";
const INSTRUCTIONS_SUBPATH = ".paperclip/instances/default/companies/Penstock/agents/cto";

/** What the server hands over today, and what the pod cannot see. */
const SERVER_SIDE_HOME_DIR = `/paperclip/instances/default/workspaces/${AGENT_ID}`;

function makeCtx(config: Record<string, unknown> = {}): AdapterExecutionContext {
  return {
    runId: "run-abc12345",
    agent: { id: AGENT_ID, companyId: "co1", name: "Test Agent", adapterType: "claude_k8s", adapterConfig: {} },
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
    config: {
      serviceAccountName: "test-sa",
      // The live Cto values, 2026-11-07. `instructionsRootPath` arrives from instance
      // scope for every agent in the fleet, so this is not a Cto-only shape.
      instructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md`,
      instructionsRootPath: INSTRUCTIONS_ROOT,
      instructionsEntryFile: "AGENTS.md",
      instructionsBundleMode: "external",
      ...config,
    },
    context: {
      paperclipWorkspace: {
        cwd: "/paperclip/instances/default/projects/co1/proj-1/_default",
        source: "project_primary",
        agentHome: SERVER_SIDE_HOME_DIR,
      },
    } as unknown as AdapterExecutionContext["context"],
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

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
} as unknown as SelfPodInfo;

type Built = ReturnType<typeof buildJobManifest>;

function agentContainer(built: Built) {
  const spec = built.job.spec?.template?.spec;
  if (!spec) throw new Error("no pod spec");
  return spec.containers?.find((c) => c.name === "agent") ?? spec.containers?.[0];
}

function agentHomeEnv(built: Built): string | undefined {
  return agentContainer(built)?.env?.find((e) => e.name === "AGENT_HOME")?.value;
}

describe("AGENT_HOME on an external instructions bundle (PEN-2585)", () => {
  it("points at the instructions root, not the unmounted server-side workspace dir", () => {
    const built = buildJobManifest({ ctx: makeCtx(), selfPod });
    expect(agentHomeEnv(built)).toBe(INSTRUCTIONS_ROOT);
    expect(agentHomeEnv(built)).not.toBe(SERVER_SIDE_HOME_DIR);
  });

  it("names a root the pod actually mounts", () => {
    // The join the bug lived in. An env var naming a durable-looking path proves
    // nothing on its own — that is precisely what shipped. Assert the value is backed
    // by a real volumeMount on the same container that reads it.
    const built = buildJobManifest({ ctx: makeCtx(), selfPod });
    const home = agentHomeEnv(built);
    const mounts = agentContainer(built)?.volumeMounts ?? [];
    expect(mounts).toContainEqual({
      name: "data",
      mountPath: INSTRUCTIONS_ROOT,
      subPath: INSTRUCTIONS_SUBPATH,
    });
    expect(mounts.some((m) => m.mountPath === home)).toBe(true);
  });

  it("negative control: the server-side workspace dir is mounted nowhere", () => {
    // If this ever starts passing as a mount, the premise of the fix changed and the
    // fallback below is no longer a fallback onto nothing.
    const built = buildJobManifest({ ctx: makeCtx(), selfPod });
    const mounts = agentContainer(built)?.volumeMounts ?? [];
    expect(mounts.some((m) => m.mountPath === SERVER_SIDE_HOME_DIR)).toBe(false);
  });

  it("falls back to the workspace agent home when the bundle is not external", () => {
    // Single-file / legacy agents — unchanged behaviour, stated so the change is not
    // read as fleet-wide.
    const built = buildJobManifest({
      ctx: makeCtx({ instructionsBundleMode: "inline" }),
      selfPod,
    });
    expect(agentHomeEnv(built)).toBe(SERVER_SIDE_HOME_DIR);
  });

  it("falls back when the bundle is external but no root is configured", () => {
    const built = buildJobManifest({
      ctx: makeCtx({ instructionsRootPath: "" }),
      selfPod,
    });
    expect(agentHomeEnv(built)).toBe(SERVER_SIDE_HOME_DIR);
  });
});

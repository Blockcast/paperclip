import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest, resolveMountedAgentBundleHome } from "./job-manifest.js";
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

// A `managed` bundle — the ONLY other mode `agent-instructions.ts` can persist
// (`type BundleMode = "managed" | "external"`). Its canonical file sits one level
// deeper, under `instructions/`, so `instructionsRootPath` (= `dirname(file)`) and
// the mounted `agentBundleRoot` (= its PARENT) DISAGREE here. That divergence is the
// whole reason this resolves through `agentBundleRoot` and not through the root path.
const MANAGED_AGENT_ID = "6f9c2a71-0b3d-4e52-9a18-5c7d0e4b1f88";
const MANAGED_AGENT_DIR = `/paperclip/instances/default/companies/co1/agents/${MANAGED_AGENT_ID}`;
const MANAGED_INSTRUCTIONS_ROOT = `${MANAGED_AGENT_DIR}/instructions`;
const MANAGED_AGENT_SUBPATH = `instances/default/companies/co1/agents/${MANAGED_AGENT_ID}`;

/** An operator-set bundle outside the data mount — nothing binds it into the pod. */
const OFF_VOLUME_ROOT = "/srv/agent-bundles/cto";

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

  it("falls back to the workspace agent home when there is no instructions bundle", () => {
    // The real legacy shape. `syncInstructionsBundleConfigFromFilePath` DELETES the
    // mode, root and entry keys whenever `instructionsFilePath` is absent, so "no
    // bundle" is all four fields unset together — never a bundle file with the mode
    // or root cleared out from under it. Unchanged behaviour, stated so the change is
    // not read as fleet-wide.
    const built = buildJobManifest({
      ctx: makeCtx({
        instructionsFilePath: "",
        instructionsRootPath: "",
        instructionsEntryFile: "",
        instructionsBundleMode: "",
      }),
      selfPod,
    });
    expect(agentHomeEnv(built)).toBe(SERVER_SIDE_HOME_DIR);
  });

  it("falls back when the bundle is off the data mount, and does not name it", () => {
    // `agentBundleRoot` only refuses the volume ROOT — it does not test that the path
    // is on the volume at all. Without the on-volume half of the join, an operator-set
    // bundle outside the data mount would become a durable-LOOKING AGENT_HOME that no
    // mount backs: PEN-2585 again, by a new route. This is the control for that half.
    const built = buildJobManifest({
      ctx: makeCtx({
        instructionsFilePath: `${OFF_VOLUME_ROOT}/AGENTS.md`,
        instructionsRootPath: OFF_VOLUME_ROOT,
        instructionsBundleMode: "external",
      }),
      selfPod,
    });
    expect(agentHomeEnv(built)).toBe(SERVER_SIDE_HOME_DIR);
    expect(agentHomeEnv(built)).not.toBe(OFF_VOLUME_ROOT);
    const mounts = agentContainer(built)?.volumeMounts ?? [];
    expect(mounts.some((m) => m.mountPath === OFF_VOLUME_ROOT)).toBe(false);
  });
});

describe("AGENT_HOME on a managed instructions bundle (PEN-2585)", () => {
  function managedCtx() {
    return makeCtx({
      instructionsFilePath: `${MANAGED_INSTRUCTIONS_ROOT}/AGENTS.md`,
      instructionsRootPath: MANAGED_INSTRUCTIONS_ROOT,
      instructionsBundleMode: "managed",
    });
  }

  it("points at the agent dir, NOT one level deeper at the instructions root", () => {
    // The regression this suite exists to hold. Keying the fix on `instructionsRootPath`
    // passes every `external` fixture — the two derivations coincide there — and hands a
    // `managed` seat an AGENT_HOME inside its own instructions bundle, putting
    // `$AGENT_HOME/memory/` somewhere mounted, durable and silently wrong forever.
    const built = buildJobManifest({ ctx: managedCtx(), selfPod });
    expect(agentHomeEnv(built)).toBe(MANAGED_AGENT_DIR);
    expect(agentHomeEnv(built)).not.toBe(MANAGED_INSTRUCTIONS_ROOT);
    expect(agentHomeEnv(built)).not.toBe(SERVER_SIDE_HOME_DIR);
  });

  it("names a root the pod actually mounts", () => {
    // Same join as the external case. It is the point of asserting it in BOTH modes:
    // against the `instructionsRootPath` spelling this assertion is vacuous for
    // `external` (the derivations agree) and is the one that fails for `managed`.
    const built = buildJobManifest({ ctx: managedCtx(), selfPod });
    const home = agentHomeEnv(built);
    const mounts = agentContainer(built)?.volumeMounts ?? [];
    expect(mounts).toContainEqual({
      name: "data",
      mountPath: MANAGED_AGENT_DIR,
      subPath: MANAGED_AGENT_SUBPATH,
    });
    expect(mounts.some((m) => m.mountPath === home)).toBe(true);
  });

  it("covers a sibling memory/ dir, which the instructions root would not", () => {
    // `resolveScopedWritableMounts` opens the whole agent dir precisely so `memory/`
    // is covered. Assert AGENT_HOME is an ancestor of that tree rather than a peer
    // inside the bundle — the difference between the two candidate spellings.
    const built = buildJobManifest({ ctx: managedCtx(), selfPod });
    const home = agentHomeEnv(built) ?? "";
    expect(`${MANAGED_AGENT_DIR}/memory`.startsWith(`${home}/`)).toBe(true);
    expect(`${MANAGED_AGENT_DIR}/memory`.startsWith(`${MANAGED_INSTRUCTIONS_ROOT}/`)).toBe(false);
  });
});

describe("resolveMountedAgentBundleHome (PEN-2585)", () => {
  // The resolver `buildEnvVars` exports as AGENT_HOME and `execute.ts` names in the
  // durable-memory directive. It is shared so those two cannot disagree: both
  // spellings of a durable path look durable from inside the pod, and a run handed
  // the wrong one has no way to find out before its memory is already gone.

  it("returns the agent dir for an external bundle", () => {
    expect(resolveMountedAgentBundleHome({ instructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md` })).toBe(
      INSTRUCTIONS_ROOT,
    );
  });

  it("climbs out of instructions/ for a managed bundle", () => {
    expect(
      resolveMountedAgentBundleHome({ instructionsFilePath: `${MANAGED_INSTRUCTIONS_ROOT}/AGENTS.md` }),
    ).toBe(MANAGED_AGENT_DIR);
  });

  it("returns empty for a bundle the pod does not mount", () => {
    // The on-volume half of the join. `agentBundleRoot` alone refuses only the volume
    // root, so an operator-set bundle elsewhere would otherwise come back as a
    // durable-LOOKING root that nothing backs — the filed bug by a new route.
    expect(resolveMountedAgentBundleHome({ instructionsFilePath: `${OFF_VOLUME_ROOT}/AGENTS.md` })).toBe("");
  });

  it("returns empty when there is no bundle at all", () => {
    // Legacy / single-file agents. The caller must fall back, and the directive must
    // say there is no durable root rather than printing the server-made one.
    expect(resolveMountedAgentBundleHome({})).toBe("");
    expect(resolveMountedAgentBundleHome({ instructionsFilePath: "" })).toBe("");
  });

  it("refuses the data-mount root itself", () => {
    // Returning it would make AGENT_HOME the whole volume and `$AGENT_HOME/memory/`
    // a shared directory every company could write.
    expect(resolveMountedAgentBundleHome({ instructionsFilePath: "/paperclip/AGENTS.md" })).toBe("");
  });

  it("agrees with the AGENT_HOME the manifest exports, in both bundle modes", () => {
    // The join itself, asserted directly rather than inferred from the two suites
    // above passing separately. This is the invariant the directive rests on.
    for (const cfg of [
      { instructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md`, instructionsRootPath: INSTRUCTIONS_ROOT },
      {
        instructionsFilePath: `${MANAGED_INSTRUCTIONS_ROOT}/AGENTS.md`,
        instructionsRootPath: MANAGED_INSTRUCTIONS_ROOT,
        instructionsBundleMode: "managed",
      },
    ]) {
      const built = buildJobManifest({ ctx: makeCtx(cfg), selfPod });
      expect(agentHomeEnv(built)).toBe(resolveMountedAgentBundleHome(makeCtx(cfg).config));
    }
  });

  it("does NOT agree when there is no mounted bundle — the caller's fallback is visible here", () => {
    // Negative control for the assertion above, so it cannot pass vacuously: where the
    // resolver returns "" the manifest deliberately falls back to the server-provided
    // home, and that fallback is still a path the pod cannot see. The directive's
    // no-durable-root branch exists for exactly this run.
    const cfg = { instructionsFilePath: `${OFF_VOLUME_ROOT}/AGENTS.md`, instructionsRootPath: OFF_VOLUME_ROOT };
    const built = buildJobManifest({ ctx: makeCtx(cfg), selfPod });
    expect(resolveMountedAgentBundleHome(makeCtx(cfg).config)).toBe("");
    expect(agentHomeEnv(built)).toBe(SERVER_SIDE_HOME_DIR);
  });
});

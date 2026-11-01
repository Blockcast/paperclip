import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildJobManifest, resolveScopedWritableMounts, resolveSeedShape } from "./job-manifest.js";
import type { ClaudePromptBundle } from "./prompt-cache.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-4932 invariant 8 (PEN-5191) — the instructions tree in the WRITE direction.
//
// Invariant 6 (PEN-5183) asked whether an opted-in run can READ the files its
// charter names. This asks the opposite question about the same tree, and the
// answer measured on the builder was NOT the one the issue supposed: on a
// per-agent claim the instructions-root mount came out BYTE-IDENTICAL to the
// shared-claim one — same mountPath, same subPath, no `readOnly`. The tree was
// never read-only there. It was WRITABLE, EMPTY and SEVERED: a per-agent claim
// is a fresh subvolume, and the server assembles the next run's instructions by
// reading the canonical charter through its OWN mount, so an edit made on the
// per-agent claim lands on a volume nothing consults.
//
// That is the harness-memory failure one layer down — a write that succeeds and
// is reported recorded while the register never moves. This suite pins the
// remedy: on a claim the server does not hold, the bind is READ-ONLY, so the
// write fails EROFS where the run can see it.
//
// Worth a manifest test rather than a resolver unit test for the same reason
// the stage-4b suite is: the property is a JOIN of the claim predicate, the
// derived candidate set, and what the two containers actually mount. None of
// it is visible from the resolver alone.

const AGENT_ID = "29033747-e513-46d5-8a13-dcb5dac10017";
const INSTRUCTIONS_ROOT = "/paperclip/.paperclip/instances/default/companies/Penstock/agents/cto";
const INSTRUCTIONS_SUBPATH = ".paperclip/instances/default/companies/Penstock/agents/cto";

const PROMPT_CACHE_ROOT =
  "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/k/prompt-cache/bundlekey123";

const promptBundle: ClaudePromptBundle = {
  bundleKey: "bundlekey123",
  rootDir: PROMPT_CACHE_ROOT,
  addDir: PROMPT_CACHE_ROOT,
  instructionsFilePath: `${PROMPT_CACHE_ROOT}/agent-instructions.md`,
  serverRootDir: PROMPT_CACHE_ROOT,
};

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
      // The live Cto values, 2026-11-01. `instructionsRootPath` arrives from
      // instance scope for every agent in the fleet, so this is not a Cto-only
      // shape — Devops's own `adapterConfig` is `{}` and its pod carries the
      // same mount (measured on PEN-5183).
      instructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md`,
      instructionsRootPath: INSTRUCTIONS_ROOT,
      instructionsEntryFile: "AGENTS.md",
      instructionsBundleMode: "external",
      ...config,
    },
    context: {},
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

function podSpec(built: Built) {
  const spec = built.job.spec?.template?.spec;
  if (!spec) throw new Error("no pod spec");
  return spec;
}

function agentMounts(built: Built) {
  const spec = podSpec(built);
  const agent = spec.containers?.find((c) => c.name === "agent") ?? spec.containers?.[0];
  return agent?.volumeMounts ?? [];
}

function initMounts(built: Built) {
  const spec = podSpec(built);
  // The run's own init container, not the uid-0 seeder (which mounts the
  // volume ROOT and has no subPath binds).
  const init = spec.initContainers?.find((c) => c.name !== "seed-writable-dirs" && c.name !== "own-volume-root");
  return init?.volumeMounts ?? [];
}

const isInstructionsRoot = (m: { mountPath?: string; subPath?: string }) =>
  m.mountPath === INSTRUCTIONS_ROOT && m.subPath === INSTRUCTIONS_SUBPATH;

describe("the agent's instructions root on the SHARED claim (PEN-5191 negative control)", () => {
  // Done-when #3. Every live run is on this path today — measured 2026-11-01
  // against the cluster, where the only per-agent claims are the unrelated
  // `opencode-db-*` (`pvc-type=agent-db`) ones and no `agent-workspace-*` claim
  // exists at all. If this moves, the change was not inert.

  it("is mounted READ-WRITE, byte for byte as before", () => {
    const mount = agentMounts(buildJobManifest({ ctx: makeCtx(), selfPod })).find(isInstructionsRoot);
    // Deep equality, not a property check: a `readOnly: false` or any other new
    // key would be a manifest change for the whole fleet and must fail here.
    expect(mount).toEqual({ name: "data", mountPath: INSTRUCTIONS_ROOT, subPath: INSTRUCTIONS_SUBPATH });
    expect(mount && "readOnly" in mount).toBe(false);
  });

  it("is read-write in the init container too", () => {
    const mount = initMounts(buildJobManifest({ ctx: makeCtx(), selfPod })).find(isInstructionsRoot);
    expect(mount).toEqual({ name: "data", mountPath: INSTRUCTIONS_ROOT, subPath: INSTRUCTIONS_SUBPATH });
  });

  it("is unchanged when a prompt bundle is present", () => {
    const built = buildJobManifest({ ctx: makeCtx(), selfPod, promptBundle });
    expect(agentMounts(built).find(isInstructionsRoot)).toEqual({
      name: "data",
      mountPath: INSTRUCTIONS_ROOT,
      subPath: INSTRUCTIONS_SUBPATH,
    });
  });

  it("defaults to read-write when the resolver is called without the claim fact", () => {
    // Back-compat for every existing caller. The default has to be the
    // permissive one here and only here: the shared claim IS the durable tree,
    // and an omitted argument that silently withdrew write access would break
    // the fleet rather than the opt-in.
    const mounts = resolveScopedWritableMounts({
      dataMountPath: "/paperclip",
      isolation: { enabled: true, homeRoot: "", sessionRoot: "", workspaceRoot: "", cacheRoot: "", tmpRoot: "", promptCacheRoot: "", storage: { workspace: "persistent" } } as never,
      podLogPath: "/paperclip/instances/default/data/run-logs/co1/a/x/log.ndjson",
      instructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md`,
      agentInstructionsFilePath: `${INSTRUCTIONS_ROOT}/AGENTS.md`,
      addDir: null,
      companyId: "co1",
    });
    const mount = mounts.find((m) => m.mountPath === INSTRUCTIONS_ROOT);
    expect(mount).toBeDefined();
    expect(mount?.readOnly).toBeUndefined();
  });
});

describe("the agent's instructions root on a claim the server does NOT hold (PEN-5191)", () => {
  const optedIn = () => buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });

  it("is mounted READ-ONLY, so a durable-register write fails EROFS instead of succeeding into a severed tree", () => {
    // The whole issue, in one assertion. Before this change the mount came back
    // identical to the shared-claim one above — writable, and pointed at an
    // empty subtree on a volume the server never reads back.
    expect(agentMounts(optedIn()).find(isInstructionsRoot)).toEqual({
      name: "data",
      mountPath: INSTRUCTIONS_ROOT,
      subPath: INSTRUCTIONS_SUBPATH,
      readOnly: true,
    });
  });

  it("is read-only in the init container too", () => {
    // A container holding the tree rw while the agent holds it ro is a boundary
    // only as strong as the init script.
    expect(initMounts(optedIn()).find(isInstructionsRoot)?.readOnly).toBe(true);
  });

  it("is still MOUNTED, not dropped", () => {
    // Dropping it would leave the path inside the pod-local root-overlay
    // `emptyDir`, where a write succeeds and dies with the pod. That is the
    // silent loss being closed, not a fix for it — so the mount has to stay and
    // only its direction may change.
    expect(agentMounts(optedIn()).filter(isInstructionsRoot)).toHaveLength(1);
  });

  it("is still SEEDED, so the bind has a target to land on", () => {
    const seeder = podSpec(optedIn()).initContainers?.find((c) => c.name === "seed-writable-dirs");
    // `command` on the split (foreign-claim) shape, `args` on the self-claim
    // one — read both rather than pinning the shape this test is not about.
    expect(JSON.stringify([...(seeder?.command ?? []), ...(seeder?.args ?? [])])).toContain(INSTRUCTIONS_SUBPATH);
  });

  it("leaves EVERY OTHER scoped mount read-write", () => {
    // Surgical, and asserted as such. `resolveScopedWritableMounts` is the
    // derived set the whole BLO-32734 narrowing rests on; a change that
    // withdrew write access from the workspace or the isolation roots would
    // break every opted-in run in a way no single-path assertion would catch.
    const others = agentMounts(optedIn()).filter((m) => m.name === "data" && m.subPath && !isInstructionsRoot(m));
    expect(others.length).toBeGreaterThan(5);
    // The company skill tree is read-only by its own prior design (it is not a
    // scoped WRITABLE mount); everything else must still be writable.
    const unexpectedlyReadOnly = others.filter((m) => m.readOnly && !m.subPath?.includes("/skills/"));
    expect(unexpectedlyReadOnly).toEqual([]);
  });

  it("keeps the prompt-cache copy of the instructions WRITABLE", () => {
    // The discriminator, and the reason the rule matches on the resolved path
    // rather than on which candidate produced it. With a prompt bundle,
    // `instructionsFilePath` is the prompt-cache COPY — the file the run
    // actually reads, materialized into a tree the pod owns. Catching that too
    // would make the bundle root unwritable and break delivery itself.
    const built = buildJobManifest({
      ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }),
      selfPod,
      promptBundle,
    });
    const bundleMount = agentMounts(built).find((m) => m.mountPath === PROMPT_CACHE_ROOT);
    expect(bundleMount).toBeDefined();
    expect(bundleMount?.readOnly).toBeUndefined();
    // ...while the canonical root beside it is still withdrawn.
    expect(agentMounts(built).find(isInstructionsRoot)?.readOnly).toBe(true);
  });

  it("does not turn the seeder into the shape `resolveSeedShape` refuses", () => {
    // `split` (the foreign-claim seeder) walks paths as uid 1000 and would
    // create a declared read-only subPath as the agent uid. That refusal keys
    // on `readOnlySubPaths`, which derives from `ROOT_TOOLCHAIN_SUBPATHS` and
    // not from this mount — so the instructions root is seeded like any other
    // target and the guard is left exactly as strict as it was.
    expect(podSpec(optedIn()).initContainers?.some((c) => c.name === "seed-writable-dirs")).toBe(true);
    expect(
      resolveSeedShape({
        narrowWritableSurface: true,
        serverCanPreCreate: false,
        seedSubPathCount: 10,
        readOnlySubPaths: [],
      }),
    ).toBe("split");
  });

  it("withdraws the write for a MANAGED bundle's whole agent dir, `memory/` included", () => {
    // `agentBundleRoot` opens the grandparent for `.../agents/<id>/instructions/<file>`
    // so `memory/` is covered. On a foreign claim that tree is empty and severed
    // for the same reason, so it gets the same answer.
    const managedRoot = "/paperclip/instances/default/data/agents/agent-xyz";
    const built = buildJobManifest({
      ctx: makeCtx({
        enablePerAgentWorkspaceVolume: true,
        instructionsFilePath: `${managedRoot}/instructions/AGENTS.md`,
        instructionsRootPath: `${managedRoot}/instructions`,
        instructionsBundleMode: "managed",
      }),
      selfPod,
    });
    const mount = agentMounts(built).find((m) => m.mountPath === managedRoot);
    expect(mount?.readOnly).toBe(true);
  });
});

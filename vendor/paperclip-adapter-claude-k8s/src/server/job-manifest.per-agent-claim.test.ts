import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildJobManifest,
  resolveAgentWorkspaceClaimName,
  resolveDataClaimName,
  serverHoldsJobDataClaim,
} from "./job-manifest.js";
import { agentWorkspaceClaimName } from "./workspace-pvc.js";
import type { SelfPodInfo } from "./k8s-client.js";

// PEN-4932 stage 4b — the `dataClaimName` swap itself.
//
// This is the change the whole issue exists for: the Job's `data` volume stops
// naming the one shared RWX CephFS claim and names a claim of this agent's own,
// so two agent pods on one node hold DISTINCT ceph-csi volume handles and a
// wedged `NodeUnstageVolume` strands one agent instead of one node.
//
// What is worth a manifest test rather than a unit test of the resolver: the
// swap is a JOIN of three things that are each individually correct — the pure
// name derivation (`workspace-pvc.ts`), the precedence (`resolveDataClaimName`)
// and the four gates that read the resulting claim identity
// (`narrowWritableSurface`, `serverCanPreCreate`, the seeder shape, and the
// prompt-bundle delivery channel). A swap that renamed the claim but left any
// of those reading the old identity is the failure mode, and none of it is
// visible from the resolver alone.

const AGENT_ID = "29033747-e513-46d5-8a13-dcb5dac10017";

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
    config: { serviceAccountName: "test-sa", ...config },
    context: {},
    onLog: async () => {},
  };
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
};

function dataVolume(job: ReturnType<typeof buildJobManifest>["job"]) {
  return job.spec?.template?.spec?.volumes?.find((v) => v.name === "data");
}

describe("resolveAgentWorkspaceClaimName (PEN-4932 stage 4b rollout gate)", () => {
  it("is OFF by default, so an agent that has not opted in gets no claim", () => {
    // The inertness property, and the reason this can land without a flag day.
    // A per-agent claim is a FRESH, EMPTY volume — no checkout, no worktrees, no
    // pnpm store — so the flip is per agent rather than fleet-wide.
    expect(resolveAgentWorkspaceClaimName({ config: {}, agentId: AGENT_ID })).toBe("");
    expect(
      resolveAgentWorkspaceClaimName({ config: { enablePerAgentWorkspaceVolume: false }, agentId: AGENT_ID }),
    ).toBe("");
  });

  it("names this agent's claim once opted in, by the SAME derivation the provisioner uses", () => {
    // Asserted against the exported function rather than a literal on purpose:
    // `execute.ts` provisions `agentWorkspaceClaimName(agentId)` and the Job
    // mounts whatever this returns. A literal here would still pass if the two
    // derivations drifted, which is exactly the defect that leaves a Job
    // mounting a claim nothing created.
    expect(
      resolveAgentWorkspaceClaimName({ config: { enablePerAgentWorkspaceVolume: true }, agentId: AGENT_ID }),
    ).toBe(agentWorkspaceClaimName(AGENT_ID));
  });

  it("falls back to the shared claim when there is no agent id to key one to", () => {
    expect(resolveAgentWorkspaceClaimName({ config: { enablePerAgentWorkspaceVolume: true }, agentId: "" })).toBe("");
    expect(resolveAgentWorkspaceClaimName({ config: { enablePerAgentWorkspaceVolume: true }, agentId: null })).toBe("");
  });

  it("refuses an opted-in agent whose id cannot carry the `paperclip.io/agent-id` label", () => {
    // Fails the run rather than silently serving the shared claim: a silent
    // fallback would make the opt-in look applied while the Job mounted the very
    // volume the opt-in exists to leave.
    expect(() =>
      resolveAgentWorkspaceClaimName({ config: { enablePerAgentWorkspaceVolume: true }, agentId: "a".repeat(64) }),
    ).toThrow(/paperclip\.io\/agent-id/);
  });
});

describe("resolveDataClaimName precedence (PEN-4932 stage 4b)", () => {
  it("puts the per-agent claim ABOVE the server's own claim", () => {
    expect(
      resolveDataClaimName({
        workspaceVolumeClaim: undefined,
        agentWorkspaceClaimName: "agent-workspace-abc",
        selfPodPvcClaimName: "paperclip-data",
      }),
    ).toBe("agent-workspace-abc");
  });

  it("keeps an explicit operator claim ABOVE the per-agent one", () => {
    // An operator naming a claim has already answered the question the gate
    // asks; the per-agent claim is a default, not an override.
    expect(
      resolveDataClaimName({
        workspaceVolumeClaim: "operator-claim",
        agentWorkspaceClaimName: "agent-workspace-abc",
        selfPodPvcClaimName: "paperclip-data",
      }),
    ).toBe("operator-claim");
  });

  it("is unchanged for every caller that supplies no per-agent claim", () => {
    expect(
      resolveDataClaimName({ workspaceVolumeClaim: undefined, selfPodPvcClaimName: "paperclip-data" }),
    ).toBe("paperclip-data");
    expect(
      resolveDataClaimName({
        workspaceVolumeClaim: undefined,
        agentWorkspaceClaimName: "   ",
        selfPodPvcClaimName: "paperclip-data",
      }),
    ).toBe("paperclip-data");
    expect(
      resolveDataClaimName({ workspaceVolumeClaim: undefined, agentWorkspaceClaimName: null, selfPodPvcClaimName: null }),
    ).toBe("");
  });
});

describe("buildJobManifest mounts the per-agent claim (PEN-4932 done-when 1)", () => {
  it("NEGATIVE CONTROL: an agent that has not opted in still mounts the shared claim", () => {
    // Byte-level statement of "this change is inert for the fleet". Every agent
    // Job measured over Prometheus's full retention window named
    // `paperclip-data`; this is that behaviour, unchanged.
    const built = buildJobManifest({ ctx: makeCtx(), selfPod });
    expect(dataVolume(built.job)?.persistentVolumeClaim?.claimName).toBe("paperclip-data");
  });

  it("mounts `agent-workspace-<agentId>` once the agent is opted in", () => {
    const built = buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });
    const claimName = dataVolume(built.job)?.persistentVolumeClaim?.claimName;
    expect(claimName).toBe(agentWorkspaceClaimName(AGENT_ID));
    // The point of the whole issue: it is NOT the shared handle any more.
    expect(claimName).not.toBe(selfPod.pvcClaimName);
  });

  it("gives two different agents two different claims, which is the blast-radius mechanism", () => {
    // ceph-csi's per-volume lock keys on the volume ID, so distinctness is the
    // entire mechanism — a wedge is confined to one agent only if no two agents
    // name the same claim.
    const a = buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });
    const otherCtx = makeCtx({ enablePerAgentWorkspaceVolume: true });
    otherCtx.agent.id = "11b9c48f-aee6-4ac4-8f4a-5ba60c73fb9c";
    const b = buildJobManifest({ ctx: otherCtx, selfPod });
    expect(dataVolume(a.job)?.persistentVolumeClaim?.claimName).not.toBe(
      dataVolume(b.job)?.persistentVolumeClaim?.claimName,
    );
  });

  it("flips the claim-identity gates the rest of stage 4 keys off", () => {
    // The swap's real consequence. `serverHoldsJobDataClaim` going false is what
    // selects the split seeder shape (invariant 4) and what routes the prompt
    // bundle onto the Secret channel (invariant 1). If the claim changed but
    // this predicate still read true, the pod would come up with an empty
    // prompt bundle and lose its instructions silently.
    const built = buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });
    const dataClaimName = dataVolume(built.job)?.persistentVolumeClaim?.claimName ?? "";
    expect(serverHoldsJobDataClaim({ dataClaimName, selfPodPvcClaimName: selfPod.pvcClaimName })).toBe(false);
    // ...and the server must NOT try to pre-create this Job's subPath targets
    // through its own mount, which would `mkdir` them inside the wrong volume.
    expect(built.scopedWritableDirs).toEqual([]);
    // Meaningful only because the same fixture WITHOUT the opt-in pre-creates a
    // non-empty list through the server's own mount.
    expect(buildJobManifest({ ctx: makeCtx(), selfPod }).scopedWritableDirs.length).toBeGreaterThan(0);
  });

  it("selects the SPLIT seeder shape, which is what invariant 4 landed for", () => {
    // The self claim keeps one uid-0 `seed-writable-dirs`; a claim the server
    // does not hold gets `own-volume-root` (uid 0, CHOWN only, one inode) then
    // `seed-writable-dirs` at uid 1000. Asserted here rather than only in
    // #3165's own suite because the swap is what makes the split reachable on
    // the fleet, and the thing that can be wrong is the SELECTION.
    const opted = buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });
    const names = (opted.job.spec?.template?.spec?.initContainers ?? []).map((c) => c.name);
    expect(names).toContain("own-volume-root");
    expect(names).toContain("seed-writable-dirs");
    const root = opted.job.spec?.template?.spec?.initContainers?.find((c) => c.name === "own-volume-root");
    expect(root?.securityContext?.runAsUser).toBe(0);
    const seeder = opted.job.spec?.template?.spec?.initContainers?.find((c) => c.name === "seed-writable-dirs");
    expect(seeder?.securityContext?.runAsUser).toBe(1000);

    // Negative control on the same fixture: the shared claim is byte-identical
    // to today — one uid-0 seeder, no `own-volume-root` at all.
    const shared = buildJobManifest({ ctx: makeCtx(), selfPod });
    const sharedNames = (shared.job.spec?.template?.spec?.initContainers ?? []).map((c) => c.name);
    expect(sharedNames).not.toContain("own-volume-root");
    expect(sharedNames).toContain("seed-writable-dirs");
    expect(
      shared.job.spec?.template?.spec?.initContainers?.find((c) => c.name === "seed-writable-dirs")
        ?.securityContext?.runAsUser,
    ).toBe(0);
  });

  it("still narrows the writable surface, so the root overlay is not lost", () => {
    // §4.1's correction: a per-agent volume is a DIFFERENT volume, not an empty
    // one, and the narrowing is what keeps the agent off the volume root. The
    // naive swap lost `rootMounts` and exposed the server's `node` home.
    const built = buildJobManifest({ ctx: makeCtx({ enablePerAgentWorkspaceVolume: true }), selfPod });
    const claude = built.job.spec?.template?.spec?.containers?.find((c) => c.name === "claude");
    const dataMounts = (claude?.volumeMounts ?? []).filter((m) => m.name === "data");
    expect(dataMounts.length).toBeGreaterThan(0);
    // Every `data` mount the agent container holds is a subPath bind; none of
    // them is the volume root.
    expect(dataMounts.every((m) => (m.subPath ?? "") !== "")).toBe(true);
  });
});

describe("the session-resume predicate is gated on the claim (PEN-4932 invariant 7 / PEN-5189)", () => {
  // `resolveResumableClaudeSessionId` decides whether to resume by stat-ing the
  // transcript — in the SERVER process, at a POD address. On the shared claim
  // those are one file. On a per-agent claim they are two volumes, and because
  // the opt-in migrates nothing the server's copy is still THERE: the check
  // returns a false POSITIVE, not a false negative.
  //
  // These two tests are deliberately the same fixture, same transcript on disk,
  // differing ONLY in the claim — which is what makes the second one a statement
  // about the volume rather than about a missing file.
  const SESSION_ID = "11111111-2222-3333-4444-555555555555";
  const MODEL = "claude-opus-5";
  const WORKSPACE_ROOT = "/paperclip/instances/default/projects/co1/proj-1/_default";
  const PROMPT_MARKER = "PEN-5189-FULL-PROMPT-TEMPLATE";
  const INSTRUCTIONS_PATH = "/paperclip/instances/default/companies/co1/agents/test/AGENTS.md";

  let sessionRoot = "";

  beforeEach(() => {
    sessionRoot = mkdtempSync(path.join(tmpdir(), "pen5189-"));
    const projects = path.join(
      sessionRoot,
      ".claude",
      "projects",
      // Mirrors `encodeClaudeCwd`, which is module-private. Pinning the encoder
      // is not this test's job; reaching the same directory is.
      WORKSPACE_ROOT.replace(/[^a-zA-Z0-9-]/g, "-"),
    );
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(projects, `${SESSION_ID}.jsonl`), '{"type":"summary"}\n');
  });

  afterEach(() => {
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
  });

  function build(config: Record<string, unknown> = {}) {
    const ctx = makeCtx({
      model: MODEL,
      promptTemplate: `${PROMPT_MARKER} for {{agent.id}}`,
      instructionsFilePath: INSTRUCTIONS_PATH,
      ...config,
    });
    ctx.runtime.sessionId = SESSION_ID;
    ctx.runtime.sessionParams = { sessionId: SESSION_ID, model: MODEL };
    (ctx.runtime.isolation as unknown as Record<string, unknown>).sessionRoot = sessionRoot;
    // Non-empty so `shouldUseResumeDeltaPrompt` can fire — without a wake there
    // is no delta to collapse the main template into, and the third assertion
    // below would pass for the wrong reason.
    ctx.context = { paperclipWake: { reason: "issue_monitor_due" } };
    return buildJobManifest({ ctx, selfPod });
  }

  it("NEGATIVE CONTROL: on the server's own claim a resumable session still resumes", () => {
    // Today's entire fleet. This change must be inert here, and the three
    // suppressions are CORRECT here — the pod really can read that transcript.
    const built = build();
    expect(dataVolume(built.job)?.persistentVolumeClaim?.claimName).toBe(selfPod.pvcClaimName);
    expect(built.claudeArgs).toContain("--resume");
    expect(built.claudeArgs).toContain(SESSION_ID);
    expect(built.claudeArgs).not.toContain("--append-system-prompt-file");
    expect(built.prompt).not.toContain(PROMPT_MARKER);
  });

  it("refuses to resume on a claim the server does not hold, even though the file is right there", () => {
    const built = build({ enablePerAgentWorkspaceVolume: true });
    // The file the predicate stats is UNCHANGED and still present — the only
    // thing that moved is which volume the pod will mount. That is the whole
    // point: an `existsSync`-based answer cannot be right here at any path.
    expect(
      existsSync(
        path.join(
          sessionRoot,
          ".claude",
          "projects",
          WORKSPACE_ROOT.replace(/[^a-zA-Z0-9-]/g, "-"),
          `${SESSION_ID}.jsonl`,
        ),
      ),
    ).toBe(true);
    expect(dataVolume(built.job)?.persistentVolumeClaim?.claimName).toBe(agentWorkspaceClaimName(AGENT_ID));
    expect(built.claudeArgs).not.toContain("--resume");
  });

  it("delivers all four things the false positive used to suppress", () => {
    // Each of these is suppressed by `claudeResumeSessionId` being truthy, and
    // each is justified in source by "it is already in the session" — the
    // premise that is false once the pod cannot read the transcript. A run
    // missing them still exits 0 and still emits parseable stdout, so without
    // this assertion the degradation is invisible.
    const built = build({ enablePerAgentWorkspaceVolume: true });
    // 1. the `--resume` target
    expect(built.claudeArgs).not.toContain("--resume");
    // 2 + 3. the instructions file, and the FULL prompt template rather than
    //        the wake delta alone
    expect(built.claudeArgs).toContain("--append-system-prompt-file");
    expect(built.claudeArgs).toContain(INSTRUCTIONS_PATH);
    expect(built.prompt).toContain(PROMPT_MARKER);
    // 4. the wake delta is still there — the fix ADDS the template back, it does
    //    not swap one for the other.
    expect(built.prompt).toContain("issue_monitor_due");
  });

  it("keeps the bootstrap prompt, which the resume path zeroes out", () => {
    const built = build({ enablePerAgentWorkspaceVolume: true, bootstrapPromptTemplate: "PEN-5189-BOOTSTRAP" });
    expect(built.prompt).toContain("PEN-5189-BOOTSTRAP");
    // Meaningful only against the control: the same fixture on the shared claim
    // resumes, and therefore drops it.
    expect(build({ bootstrapPromptTemplate: "PEN-5189-BOOTSTRAP" }).prompt).not.toContain("PEN-5189-BOOTSTRAP");
  });
});

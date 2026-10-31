import { describe, it, expect, vi, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildJobManifest,
  resolveDataClaimName,
  serverHoldsJobDataClaim,
} from "./job-manifest.js";
import type { SelfPodInfo } from "./k8s-client.js";
import type { ClaudePromptBundle } from "./prompt-cache.js";
import type { PromptBundleSecretProjection } from "./prompt-bundle-projection.js";
import { buildPromptBundleMaterializationShell } from "./prompt-bundle-materialization.js";
import {
  PROMPT_BUNDLE_SECRET_MOUNT_PATH,
  PROMPT_BUNDLE_SECRET_VOLUME_NAME,
} from "./prompt-bundle-projection.js";

// PEN-4932 stage 4b, invariant 1 — the prompt bundle's delivery channel.
//
// `execute.ts` writes the bundle at `SELF_POD_DATA_MOUNT_PATH` and the pod reads
// it at `dataMountPath`, under a comment stating the assumption exactly: "One
// volume, TWO mount points". That holds only while the two are the same VOLUME.
// On a per-agent claim the server writes a complete bundle into its own volume
// and the pod gets the seeded, empty directory — the agent silently loses its
// instructions.
//
// What makes this worth a manifest test rather than a unit test of the pieces:
// the projection and the materialization shell are both already tested in
// isolation and both already correct. The thing that can be wrong here is the
// JOIN — whether the Secret is staged on the right claims, whether the volume
// the pod mounts and the Secret the server creates agree, and whether the copy
// step is actually spliced into the command the container runs. None of that is
// visible from either piece alone, and it is the same shape of join BLO-48361
// cost 2h17m of fleet-wide publishing to learn is only visible from the
// manifest.

const promptBundle: ClaudePromptBundle = {
  bundleKey: "bundlekey123",
  rootDir: "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/k/prompt-cache/bundlekey123",
  addDir: "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/k/prompt-cache/bundlekey123",
  instructionsFilePath:
    "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/k/prompt-cache/bundlekey123/agent-instructions.md",
  // Equal to `rootDir` here, which is the shared-claim shape. The point of this
  // suite is the case where they are NOT the same volume, and that difference is
  // carried by the claim name, not by this field.
  serverRootDir:
    "/paperclip/instances/default/data/k8s-isolation/co1/agent-abc/k/prompt-cache/bundlekey123",
};

/**
 * A projection with one UTF-8 file and one binary file.
 *
 * The binary half is not decoration: `createOrAdoptRunSecret` writes a single
 * record to `stringData`, so a wiring that carried only that map would drop
 * every non-UTF-8 file while `items[]` still projected its key — a Secret whose
 * key is missing, i.e. a pod that never starts.
 */
const projection: PromptBundleSecretProjection = {
  stringData: { "bundle-0": "# instructions\n", "bundle-1": "# skill\n" },
  base64Data: { "bundle-2": "iVBORw0KGgo=" },
  items: [
    { key: "bundle-0", path: "agent-instructions.md" },
    { key: "bundle-1", path: ".claude/skills/dataviz/SKILL.md" },
    { key: "bundle-2", path: ".claude/skills/dataviz/logo.png" },
  ],
  totalValueBytes: 42,
  fileCount: 3,
  binaryFileCount: 1,
  resolvedSymlinkCount: 0,
  danglingSymlinkCount: 0,
  skippedNonRegularCount: 0,
  bytesBySkillKey: { dataviz: 24 },
  escalationThresholdCrossed: false,
};

function makeCtx(workspaceVolumeClaim?: string): AdapterExecutionContext {
  return {
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
    config: {
      serviceAccountName: "test-sa",
      ...(workspaceVolumeClaim ? { workspaceVolumeClaim } : {}),
    },
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

/** The agent container's command string — where the materialization step lands. */
function agentCommand(job: ReturnType<typeof buildJobManifest>["job"]): string {
  // `command` is `["sh", "-c", <script>]`; the script is the third element.
  return job.spec?.template?.spec?.containers?.[0]?.command?.[2] ?? "";
}

describe("resolveDataClaimName / serverHoldsJobDataClaim (PEN-4932 stage 4b)", () => {
  it("prefers an operator-supplied claim over the server's own", () => {
    expect(
      resolveDataClaimName({ workspaceVolumeClaim: "agent-workspace-abc", selfPodPvcClaimName: "paperclip-data" }),
    ).toBe("agent-workspace-abc");
  });

  it("falls back to the server's own claim, then to none", () => {
    expect(resolveDataClaimName({ workspaceVolumeClaim: undefined, selfPodPvcClaimName: "paperclip-data" })).toBe(
      "paperclip-data",
    );
    expect(resolveDataClaimName({ workspaceVolumeClaim: "  ", selfPodPvcClaimName: null })).toBe("");
  });

  it("reports the server as holding the claim only when the two names are equal AND non-empty", () => {
    expect(serverHoldsJobDataClaim({ dataClaimName: "paperclip-data", selfPodPvcClaimName: "paperclip-data" })).toBe(
      true,
    );
    expect(serverHoldsJobDataClaim({ dataClaimName: "agent-workspace-abc", selfPodPvcClaimName: "paperclip-data" })).toBe(
      false,
    );
    // The `emptyDir` case. Two empties are not a match: an emptyDir is not the
    // server's volume either, so no server-materialized tree reaches it.
    expect(serverHoldsJobDataClaim({ dataClaimName: "", selfPodPvcClaimName: "" })).toBe(false);
    expect(serverHoldsJobDataClaim({ dataClaimName: "", selfPodPvcClaimName: null })).toBe(false);
  });
});

describe("prompt-bundle Secret delivery (PEN-4932 stage 4b, invariant 1)", () => {
  it("stages nothing on the server's own claim, even when a projection is supplied", () => {
    // The inertness property. Every agent on the fleet today resolves to the
    // server's own PVC, so this is the branch the whole fleet takes — and the
    // reason this change can land before the `dataClaimName` swap.
    const built = buildJobManifest({
      ctx: makeCtx(),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });
    expect(built.promptBundleSecret).toBeNull();
    expect(built.job.spec?.template?.spec?.volumes?.some((v) => v.name === PROMPT_BUNDLE_SECRET_VOLUME_NAME)).toBe(
      false,
    );
    expect(agentCommand(built.job)).not.toContain(PROMPT_BUNDLE_SECRET_MOUNT_PATH);
  });

  it("stages nothing on the server's own claim when the run is NOT isolated", () => {
    // The mutation this test exists for, and the one the other fixtures cannot
    // reach: `serverCanPreCreate` and `serverHoldsDataClaim` are EQUAL whenever
    // `narrowWritableSurface` holds, so every isolated fixture above passes with
    // either gate. They part exactly here — a non-isolated run on the server's
    // own PVC has `serverCanPreCreate === false` but the server DOES hold the
    // claim, so the pod can already read the bundle off the volume.
    //
    // Gating on the narrowing instead of on claim identity would therefore turn
    // this channel on for a slice of TODAY's fleet, where the Secret buys
    // nothing and the only thing it can do is fail the run over a budget that
    // was never load-bearing. That is the opposite of the inertness this change
    // claims, which is why it is pinned rather than argued.
    const ctx = makeCtx();
    const nonIsolated = {
      ...ctx,
      runtime: { ...ctx.runtime, isolation: null },
    } as AdapterExecutionContext;
    const built = buildJobManifest({
      ctx: nonIsolated,
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });
    expect(built.promptBundleSecret).toBeNull();
    expect(agentCommand(built.job)).not.toContain(PROMPT_BUNDLE_SECRET_MOUNT_PATH);
  });

  it("stages the Secret, the volume and the copy step on a foreign claim", () => {
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });

    const secret = built.promptBundleSecret;
    expect(secret).not.toBeNull();
    expect(secret?.name).toBe(`${built.jobName}-prompt-bundle`);
    expect(secret?.namespace).toBe("paperclip");
    // BOTH halves reach the caller. A wiring that carried only `stringData`
    // would drop `bundle-2` while the volume below still projected its key.
    expect(secret?.stringData).toEqual(projection.stringData);
    expect(secret?.base64Data).toEqual(projection.base64Data);

    const volume = built.job.spec?.template?.spec?.volumes?.find(
      (v) => v.name === PROMPT_BUNDLE_SECRET_VOLUME_NAME,
    );
    expect(volume?.secret?.secretName).toBe(secret?.name);
    // `optional: false` — a Secret that failed to create must surface as a pod
    // that cannot start, not as an agent running without its instructions.
    expect(volume?.secret?.optional).toBe(false);
    expect(volume?.secret?.items).toEqual(projection.items);

    const mount = built.job.spec?.template?.spec?.containers?.[0]?.volumeMounts?.find(
      (m) => m.name === PROMPT_BUNDLE_SECRET_VOLUME_NAME,
    );
    expect(mount?.mountPath).toBe(PROMPT_BUNDLE_SECRET_MOUNT_PATH);
    expect(mount?.readOnly).toBe(true);
  });

  it("every key the volume projects is a key the Secret actually carries", () => {
    // The join the two maps make easy to get wrong, asserted as a set equality
    // rather than per-file: a projected key with no Secret entry is a pod stuck
    // in `CreateContainerConfigError`, and it is invisible from either side.
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });
    const secret = built.promptBundleSecret;
    const carried = new Set([...Object.keys(secret?.stringData ?? {}), ...Object.keys(secret?.base64Data ?? {})]);
    const volume = built.job.spec?.template?.spec?.volumes?.find(
      (v) => v.name === PROMPT_BUNDLE_SECRET_VOLUME_NAME,
    );
    for (const item of volume?.secret?.items ?? []) expect(carried.has(item.key)).toBe(true);
    expect(carried.size).toBe((volume?.secret?.items ?? []).length);
  });

  it("splices the copy step into the agent command, under `|| exit $?`", () => {
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });
    const command = agentCommand(built.job);
    expect(command).toContain(PROMPT_BUNDLE_SECRET_MOUNT_PATH);
    // Into the bundle root the CLI is handed as `--add-dir`, not the server's
    // own view of it.
    expect(command).toContain(promptBundle.rootDir);
    // Compared against the step the shell builder actually produces, not against
    // a fragment: this is the join under test, so an assertion that only matched
    // a substring would pass on a truncated or re-ordered splice.
    const expected = buildPromptBundleMaterializationShell({
      bundleRoot: promptBundle.rootDir,
      paths: projection.items.map((item) => item.path),
      sourceDir: PROMPT_BUNDLE_SECRET_MOUNT_PATH,
      quote: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
    });
    expect(expected).not.toBe("");
    // A copy failure must fail the pod rather than under-deliver: an agent that
    // could not get its skills must not look like one that chose not to use them.
    expect(command).toContain(`${expected} || exit $?;`);
  });

  it("runs the copy AFTER workspace setup, so the bundle root's ancestors exist", () => {
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
    });
    const command = agentCommand(built.job);
    const copyAt = command.indexOf("__pcpb_src=");
    expect(copyAt).toBeGreaterThan(-1);
    // The shared-doc overlay copies into the same workspace and must stay AFTER
    // the bundle step, so that ordering is pinned here too where both exist.
    const overlayAt = command.indexOf("__pcsd_");
    if (overlayAt > -1) expect(copyAt).toBeLessThan(overlayAt);
    // `set -o pipefail` opens the script; the copy is spliced well past it, not
    // prepended ahead of the preflights that make the tree exist.
    expect(copyAt).toBeGreaterThan(command.indexOf("set -o pipefail"));
  });

  it("stages nothing when there is no projection to deliver", () => {
    // `buildPromptBundleSecretProjection` returns null for "nothing to carry".
    // That is a complete delivery of an empty bundle, not a failure — there were
    // no bytes for the shared volume to have carried either.
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: null,
    });
    expect(built.promptBundleSecret).toBeNull();
    expect(agentCommand(built.job)).not.toContain(PROMPT_BUNDLE_SECRET_MOUNT_PATH);
  });

  it("stages nothing when there is no prompt bundle at all", () => {
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle: null,
      promptBundleProjection: projection,
    });
    expect(built.promptBundleSecret).toBeNull();
  });

  it("stops reporting the bundle as absent once the Secret carries it", () => {
    // `data_claim_foreign` is the warning a per-agent run emits on EVERY run,
    // forever. Left unchanged it would keep naming the prompt-cache root as an
    // unpopulated tree and keep saying the agent loses its instructions — the
    // exact fault this change fixes — and send whoever reads it chasing a
    // resolved bug. A stale warning is a defect with a long tail precisely
    // because nothing fails.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildJobManifest({
        ctx: makeCtx("agent-workspace-abc"),
        selfPod,
        promptBundle,
        promptBundleProjection: projection,
      });
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes("claude_k8s.data_claim_foreign"));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line!) as {
        msg: string;
        unpopulatedSubPaths: string[];
        promptBundleDelivery: string;
      };
      expect(parsed.promptBundleDelivery).toBe("secret");
      expect(parsed.msg).not.toContain("prompt bundle absent");
      expect(parsed.unpopulatedSubPaths.some((p) => p.includes("prompt-cache"))).toBe(false);
      // The skills tree is NOT fixed by this change and must still be reported:
      // the projection carries the run's resolved skill entries, not the
      // company tree the server materializes.
      expect(parsed.unpopulatedSubPaths.some((p) => p.includes("skills/co1"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("still reports the bundle as absent when no Secret is staged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildJobManifest({
        ctx: makeCtx("agent-workspace-abc"),
        selfPod,
        promptBundle,
        promptBundleProjection: null,
      });
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes("claude_k8s.data_claim_foreign"));
      const parsed = JSON.parse(line!) as {
        msg: string;
        unpopulatedSubPaths: string[];
        promptBundleDelivery: string;
      };
      expect(parsed.promptBundleDelivery).toBe("none");
      expect(parsed.msg).toContain("prompt bundle absent");
      expect(parsed.unpopulatedSubPaths.some((p) => p.includes("prompt-cache"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("relinks image-path skills, which the Secret deliberately does not carry", () => {
    // Found by review on #3170, and it is the failure this whole channel exists
    // to prevent reached from the other side. `skillSourceNeedsProjection`
    // leaves image-path skills out on the correct grounds that the pod already
    // has their bytes — but the agent reaches a skill through its
    // `.claude/skills/<runtimeName>` farm link, and `prepareClaudePromptBundle`
    // writes that link into the SERVER'S volume. On a foreign claim the pod
    // never sees it, so every adapter-bundled skill would be absent from
    // `--add-dir` with nothing reporting it.
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
      promptBundleSkillLinks: [{ runtimeName: "dataviz-image", target: "/app/skills/dataviz" }],
    });
    const command = agentCommand(built.job);
    expect(command).toContain("ln -s '/app/skills/dataviz'");
    expect(command).toContain(`${promptBundle.rootDir}/.claude/skills`);
    // Replaced, not merged into: a bare `ln -s`/`ln -sfn` would create the link
    // INSIDE a real directory parked at the destination, silently leaving the
    // skill unreachable. Asserted against the exact destination expression, not
    // a bare "rm -rf" — that substring occurs elsewhere in the command and a
    // loose match passes with this guard removed.
    expect(command).toContain(`rm -rf "$__pcpl_dst"/'dataviz-image' || exit $?;`);
    // A link that cannot be created is a skill the agent will not have, and
    // nothing else in the run would say so.
    expect(command).toContain(`ln -s '/app/skills/dataviz' "$__pcpl_dst"/'dataviz-image' || exit $?;`);
  });

  it("relinks even when the projection is empty — an all-image-path run", () => {
    // The gate that would have been easy to get wrong: tying the link step to
    // the projection would leave a run whose skills are ALL image-path with an
    // empty bundle root and no signal, since such a run projects nothing.
    const built = buildJobManifest({
      ctx: makeCtx("agent-workspace-abc"),
      selfPod,
      promptBundle,
      promptBundleProjection: null,
      promptBundleSkillLinks: [{ runtimeName: "dataviz-image", target: "/app/skills/dataviz" }],
    });
    expect(built.promptBundleSecret).toBeNull();
    expect(agentCommand(built.job)).toContain("ln -s '/app/skills/dataviz'");
  });

  it("emits no link step on the server's own claim", () => {
    const built = buildJobManifest({
      ctx: makeCtx(),
      selfPod,
      promptBundle,
      promptBundleProjection: projection,
      promptBundleSkillLinks: [{ runtimeName: "dataviz-image", target: "/app/skills/dataviz" }],
    });
    expect(agentCommand(built.job)).not.toContain("__pcpl_dst=");
  });

  it("refuses a runtimeName that is not a single safe path segment", () => {
    // `rm -rf` is written against a destination bounded to one segment under the
    // bundle root. That bound IS this check, so it refuses rather than quotes.
    for (const runtimeName of ["../escape", "a/b", "..", ""]) {
      expect(() =>
        buildJobManifest({
          ctx: makeCtx("agent-workspace-abc"),
          selfPod,
          promptBundle,
          promptBundleProjection: projection,
          promptBundleSkillLinks: [{ runtimeName, target: "/app/skills/x" }],
        }),
      ).toThrow(/not a safe path segment/);
    }
  });

  it("refuses a link target that is not an absolute pod path", () => {
    expect(() =>
      buildJobManifest({
        ctx: makeCtx("agent-workspace-abc"),
        selfPod,
        promptBundle,
        promptBundleProjection: projection,
        promptBundleSkillLinks: [{ runtimeName: "x", target: "relative/path" }],
      }),
    ).toThrow(/not absolute pod paths/);
  });

  it("names the right empty tree in the warning — skills arrive, the TREE does not", () => {
    // An earlier revision said "company skills will be empty" on the delivered
    // branch. That was backwards: the projection carries the run's RESOLVED
    // skill entries, so company skills are exactly what does arrive. Naming the
    // wrong half is worse than naming neither, because it sends the reader to
    // the tree that is working.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildJobManifest({
        ctx: makeCtx("agent-workspace-abc"),
        selfPod,
        promptBundle,
        promptBundleProjection: projection,
        promptBundleSkillLinks: [{ runtimeName: "dataviz-image", target: "/app/skills/dataviz" }],
      });
      const line = warn.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes("claude_k8s.data_claim_foreign"))!;
      const parsed = JSON.parse(line) as {
        msg: string;
        promptBundleProjectedFiles: number;
        promptBundleRelinkedSkills: number;
      };
      expect(parsed.msg).not.toContain("company skills will be empty");
      expect(parsed.msg).toContain("image-path skills are relinked in-pod");
      expect(parsed.promptBundleProjectedFiles).toBe(projection.fileCount);
      expect(parsed.promptBundleRelinkedSkills).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to build a step for a path that is not bundle-relative", () => {
    // Deliberately a throw, not a filter. A projection carrying such a path is a
    // bug in the projection, and emitting a step that silently dropped the file
    // would reintroduce the exact silent loss this channel exists to remove.
    expect(() =>
      buildJobManifest({
        ctx: makeCtx("agent-workspace-abc"),
        selfPod,
        promptBundle,
        promptBundleProjection: {
          ...projection,
          items: [{ key: "bundle-0", path: "../escape.md" }],
        },
      }),
    ).toThrow(/not bundle-relative/);
  });
});

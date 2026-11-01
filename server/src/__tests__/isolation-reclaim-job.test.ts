import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS,
  DEFAULT_RECLAIM_TTL_SECONDS,
  MAX_RECLAIM_PLAN_ENV_BYTES,
  RECLAIM_CLAIM_MOUNT_PATH,
  RECLAIM_EXECUTOR_PATH,
  RECLAIM_HOME_MOUNT_PATH,
  RECLAIM_TSX_LOADER_PATH,
  RECLAIM_WORKSPACES_ROOT,
  buildIsolationReclaimJobManifest,
  reclaimJobName,
} from "../services/isolation-reclaim-job.js";
import type { IsolationReclaimJobSpec } from "../services/isolation-reclaim-job.js";
import { RECLAIM_PLAN_ENV } from "../services/isolation-reclaim-report.js";
import { DEFAULT_ISOLATION_WORKSPACE_ROOT } from "../services/isolation-workspace-reaper.js";

const CLAIM = "agent-workspace-29033747-e513-46d5-8a13-dcb5dac10017";
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

/** DNS-1123 label, which is what a Job name must be. */
const DNS_1123 = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function base() {
  return {
    claimName: CLAIM,
    namespace: "paperclip",
    image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
    invocationId: "20261101T0300Z-a1b2c3",
  };
}

function podSpec(
  mode: "inventory" | "execute",
  extra: Partial<IsolationReclaimJobSpec> = {},
): k8s.V1PodSpec {
  const { job } = buildIsolationReclaimJobManifest({ ...base(), mode, ...extra });
  const spec = job.spec?.template.spec;
  if (!spec) throw new Error("manifest has no pod spec");
  return spec;
}

describe("reclaim Job manifest (PEN-5151)", () => {
  it("aims the container at the claim's isolation tree, not the server's", () => {
    const built = buildIsolationReclaimJobManifest({ ...base(), mode: "inventory" });
    const container = built.job.spec?.template.spec?.containers[0];

    expect(container?.args).toEqual([
      RECLAIM_EXECUTOR_PATH,
      "inventory",
      "--root",
      RECLAIM_WORKSPACES_ROOT,
    ]);
    expect(built.root).toBe(RECLAIM_WORKSPACES_ROOT);

    // The whole point of the separate mount path: `--root` must NOT be the
    // server's own tree. If these ever coincide, a misconfigured Job aims a
    // recursive unlink at the claim the mounted sweep already owns.
    expect(RECLAIM_WORKSPACES_ROOT).not.toBe(DEFAULT_ISOLATION_WORKSPACE_ROOT);
    expect(RECLAIM_WORKSPACES_ROOT.startsWith(`${RECLAIM_CLAIM_MOUNT_PATH}/`)).toBe(true);
  });

  it("puts the tsx loader in front of the executor, in both modes", () => {
    // Regression guard for a failure no amount of unit testing of the executor
    // itself can catch, because it happens before `main`: the executor's import
    // graph reaches `@paperclipai/db`, whose runtime-image `exports` points at
    // TypeScript source whose own re-exports are spelled `.js`, so bare Node
    // dies with ERR_MODULE_NOT_FOUND on `src/client.js`. A loader-less
    // container exits non-zero having written no report line, which the
    // transport reads as `absent` — "go and look at the pod" — for every Job
    // this module builds. See RECLAIM_TSX_LOADER_PATH for the measurement.
    for (const mode of ["inventory", "execute"] as const) {
      const container = podSpec(
        mode,
        mode === "execute" ? { plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] } } : {},
      ).containers[0];

      expect(container?.command).toEqual(["node", "--import", RECLAIM_TSX_LOADER_PATH]);
      // The loader must precede the script: `--import` is a node option, and
      // anything after the entry path is argv for the program.
      expect(container?.args?.[0]).toBe(RECLAIM_EXECUTOR_PATH);
      expect([...(container?.command ?? []), ...(container?.args ?? [])]).toEqual([
        "node",
        "--import",
        RECLAIM_TSX_LOADER_PATH,
        RECLAIM_EXECUTOR_PATH,
        mode,
        "--root",
        RECLAIM_WORKSPACES_ROOT,
      ]);
    }
  });

  it("mounts the named claim, and nothing else that can carry a credential", () => {
    const spec = podSpec("inventory");

    const pvcVolumes = (spec.volumes ?? []).filter((v) => v.persistentVolumeClaim);
    expect(pvcVolumes).toHaveLength(1);
    expect(pvcVolumes[0]?.persistentVolumeClaim?.claimName).toBe(CLAIM);

    // Credential-free, asserted as the ABSENCE of every channel that could
    // carry one into a pod whose job is recursive deletion.
    expect(spec.automountServiceAccountToken).toBe(false);
    expect((spec.volumes ?? []).some((v) => v.secret)).toBe(false);
    expect((spec.volumes ?? []).some((v) => v.configMap)).toBe(false);
    expect(spec.containers[0]?.envFrom).toBeUndefined();
    expect(spec.containers[0]?.env?.some((e) => e.valueFrom)).toBe(false);
  });

  it("keeps PAPERCLIP_HOME on an emptyDir, off the volume being reclaimed", () => {
    const spec = podSpec("inventory");
    const home = spec.containers[0]?.env?.find((e) => e.name === "PAPERCLIP_HOME");

    expect(home?.value).toBe(RECLAIM_HOME_MOUNT_PATH);
    // `middleware/logger.ts` mkdirSyncs a logs dir under PAPERCLIP_HOME at
    // IMPORT time, so a home under the claim would write into the tree the
    // process is about to delete from. Two independent things stop that, and
    // both are asserted: the home is backed by an emptyDir, and it does not
    // sit under the claim's mount path.
    const homeVolume = (spec.volumes ?? []).find((v) => v.name === "reclaim-home");
    expect(homeVolume?.emptyDir).toBeDefined();
    expect(RECLAIM_HOME_MOUNT_PATH.startsWith(`${RECLAIM_CLAIM_MOUNT_PATH}/`)).toBe(false);
    expect(RECLAIM_HOME_MOUNT_PATH).not.toBe(RECLAIM_CLAIM_MOUNT_PATH);
  });

  it("runs as uid 1000 — the uid that owns these trees — and never as root", () => {
    const spec = podSpec("execute", { plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] } });

    expect(spec.securityContext?.runAsUser).toBe(1000);
    expect(spec.securityContext?.runAsGroup).toBe(1000);
    expect(spec.securityContext?.runAsNonRoot).toBe(true);
    const container = spec.containers[0]?.securityContext;
    expect(container?.runAsUser).toBe(1000);
    expect(container?.runAsNonRoot).toBe(true);
    expect(container?.allowPrivilegeEscalation).toBe(false);
    expect(container?.capabilities?.drop).toEqual(["ALL"]);
  });

  it("creates exactly one pod per Job, which is what keeps the log unambiguous", () => {
    const built = buildIsolationReclaimJobManifest({
      ...base(),
      mode: "execute",
      plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] },
    });

    // The transport refuses a log carrying two marked lines rather than
    // guessing which process wrote which. `backoffLimit: 0` + `Never` is what
    // keeps the normal path off that branch.
    expect(built.job.spec?.backoffLimit).toBe(0);
    expect(built.job.spec?.template.spec?.restartPolicy).toBe("Never");
  });

  it("bounds a wedged pod, and leaves the driver time to read the log back", () => {
    const built = buildIsolationReclaimJobManifest({ ...base(), mode: "inventory" });

    expect(built.job.spec?.activeDeadlineSeconds).toBe(DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS);
    // The TTL controller takes the pod log with the pod, so a TTL at or below
    // the pod's own deadline could delete the report before anything read it —
    // surfacing as `absent`, the failure whose remedy is "go look at the pod".
    expect(DEFAULT_RECLAIM_TTL_SECONDS).toBeGreaterThan(DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS);
    expect(built.job.spec?.ttlSecondsAfterFinished).toBe(DEFAULT_RECLAIM_TTL_SECONDS);
  });

  it("carries the plan in the environment on execute, and not at all on inventory", () => {
    const plan = { planBuiltAtMs: 1_700_000_000_000, eligibleIds: [UUID_A, UUID_B], maxDeletes: 200 };
    const exec = buildIsolationReclaimJobManifest({ ...base(), mode: "execute", plan });
    const planEnv = exec.job.spec?.template.spec?.containers[0]?.env?.find(
      (e) => e.name === RECLAIM_PLAN_ENV,
    );
    expect(JSON.parse(planEnv?.value ?? "null")).toEqual(plan);
    expect(exec.planBytes).toBe(Buffer.byteLength(JSON.stringify(plan), "utf8"));

    const inv = podSpec("inventory");
    expect(inv.containers[0]?.env?.some((e) => e.name === RECLAIM_PLAN_ENV)).toBe(false);
  });

  it("stamps what the Job will actually DO, not what the field literally held", () => {
    // `dryRun` defaults to true in the executor and only a JSON `false`
    // disables it, so an omitted field must annotate as a dry run.
    const omitted = buildIsolationReclaimJobManifest({
      ...base(),
      mode: "execute",
      plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] },
    });
    expect(omitted.job.metadata?.annotations?.["paperclip.io/reclaim-dry-run"]).toBe("true");

    const live = buildIsolationReclaimJobManifest({
      ...base(),
      mode: "execute",
      plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A], dryRun: false },
    });
    expect(live.job.metadata?.annotations?.["paperclip.io/reclaim-dry-run"]).toBe("false");
  });

  it("gives both modes the same root and the same mounts", () => {
    // This is the premise the executor's hoisted root check rests on: an
    // `execute` against an unmounted root is caught by the next inventory tick
    // ONLY IF the two Jobs are aimed at the same place by construction.
    const inv = podSpec("inventory");
    const exe = podSpec("execute", { plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] } });

    expect(exe.volumes).toEqual(inv.volumes);
    expect(exe.containers[0]?.volumeMounts).toEqual(inv.containers[0]?.volumeMounts);
    const rootOf = (s: typeof inv) => s.containers[0]?.args?.slice(-2);
    expect(rootOf(exe)).toEqual(rootOf(inv));
  });

  it("refuses a mode/plan mismatch in both directions", () => {
    expect(() => buildIsolationReclaimJobManifest({ ...base(), mode: "execute" })).toThrow(
      /requires a plan/,
    );
    expect(() =>
      buildIsolationReclaimJobManifest({
        ...base(),
        mode: "inventory",
        plan: { planBuiltAtMs: 1, eligibleIds: [UUID_A] },
      }),
    ).toThrow(/takes no plan/);
  });

  it("refuses a plan too large to survive the kernel's env limit", () => {
    // Far past any plan `DEFAULT_MAX_DELETES_PER_TICK` can produce; this guards
    // a caller that ignored `maxEntries`, and it must fail HERE rather than as
    // an opaque container-create error naming neither the variable nor the plan.
    const eligibleIds = Array.from({ length: 5_000 }, (_, i) =>
      `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
    );
    expect(() =>
      buildIsolationReclaimJobManifest({
        ...base(),
        mode: "execute",
        plan: { planBuiltAtMs: 1, eligibleIds },
      }),
    ).toThrow(/over the \d+-byte environment ceiling/);

    // And the ceiling itself stays under MAX_ARG_STRLEN (128 KiB), which is
    // the fact that makes "the plan rides the environment" sound at all.
    expect(MAX_RECLAIM_PLAN_ENV_BYTES).toBeLessThan(128 * 1024);
  });

  it("refuses a Job with no claim to mount", () => {
    expect(() =>
      buildIsolationReclaimJobManifest({ ...base(), mode: "inventory", claimName: "  " }),
    ).toThrow(/claimName is required/);
  });

  it("names a Job inside the 63-char DNS-1123 limit, keeping the invocation id intact", () => {
    const longClaim = `agent-workspace-${"c".repeat(120)}`;
    const name = reclaimJobName({
      mode: "execute",
      claimName: longClaim,
      invocationId: "20261101T0300Z-a1b2c3",
    });

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(DNS_1123);
    // The claim is what gets truncated; the invocation id is what makes the
    // name unique and has to survive whole.
    expect(name.endsWith("20261101t0300z-a1b2c3")).toBe(true);
  });

  it("gives the two modes distinct Job names for one invocation", () => {
    const inventory = reclaimJobName({ mode: "inventory", claimName: CLAIM, invocationId: "inv1" });
    const execute = reclaimJobName({ mode: "execute", claimName: CLAIM, invocationId: "inv1" });

    expect(inventory).not.toBe(execute);
    for (const name of [inventory, execute]) {
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(DNS_1123);
    }
  });

  it("refuses an invocation id too long to leave a usable name", () => {
    // Truncating the invocation id instead would let two invocations collide
    // on one Job name, and the second create would return `AlreadyExists` —
    // which the driver cannot tell from a successful idempotent re-create.
    expect(() =>
      reclaimJobName({ mode: "execute", claimName: CLAIM, invocationId: "i".repeat(60) }),
    ).toThrow(/leaves no room under the 63-character DNS-1123 limit/);
  });

  it("refuses an invocation id that cannot name anything", () => {
    expect(() => reclaimJobName({ mode: "inventory", claimName: CLAIM, invocationId: "///" })).toThrow(
      /contains no DNS-1123 characters/,
    );
  });

  it("does not let a caller's labels lie about the Job's own mode or claim", () => {
    const built = buildIsolationReclaimJobManifest({
      ...base(),
      mode: "inventory",
      extraLabels: {
        "paperclip.io/agent-id": "29033747-e513-46d5-8a13-dcb5dac10017",
        "paperclip.io/reclaim-mode": "execute",
        "app.kubernetes.io/component": "something-else",
      },
    });

    const labels = built.job.metadata?.labels ?? {};
    expect(labels["paperclip.io/reclaim-mode"]).toBe("inventory");
    expect(labels["app.kubernetes.io/component"]).toBe("isolation-reclaim");
    // A non-conflicting label still lands — this is a precedence rule, not a
    // refusal to accept caller labels at all.
    expect(labels["paperclip.io/agent-id"]).toBe("29033747-e513-46d5-8a13-dcb5dac10017");
    // Pod template and Job carry the same set, so a selector finds both.
    expect(built.job.spec?.template.metadata?.labels).toEqual(labels);
  });

  it("keeps the untruncated claim name readable even when the label is clipped", () => {
    const longClaim = `agent-workspace-${"d".repeat(120)}`;
    const built = buildIsolationReclaimJobManifest({
      ...base(),
      mode: "inventory",
      claimName: longClaim,
    });

    expect((built.job.metadata?.labels ?? {})["paperclip.io/reclaim-claim"]?.length)
      .toBeLessThanOrEqual(63);
    expect(built.job.metadata?.annotations?.["paperclip.io/reclaim-claim-name"]).toBe(longClaim);
    // The volume must use the real name, never the label-safe one.
    expect(
      built.job.spec?.template.spec?.volumes?.find((v) => v.persistentVolumeClaim)
        ?.persistentVolumeClaim?.claimName,
    ).toBe(longClaim);
  });
});

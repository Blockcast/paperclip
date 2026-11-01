import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  RECLAIM_JOB_CLAIM_ANNOTATION,
  RECLAIM_JOB_CONTAINER_NAME,
  RECLAIM_JOB_MODE_LABEL,
  RECLAIM_TARGET_VOLUME_NAME,
  buildIsolationReclaimJobManifest,
  reclaimJobModeOf,
  reclaimMountedClaimOf,
} from "../services/isolation-reclaim-job.js";
import type {
  IsolationReclaimJobManifest,
  IsolationReclaimJobSpec,
} from "../services/isolation-reclaim-job.js";
import {
  ISOLATION_RECLAIM_REPORT_VERSION,
  encodeIsolationReclaimReport,
} from "../services/isolation-reclaim-report.js";
import type { IsolationReclaimReport } from "../services/isolation-reclaim-report.js";
import {
  DEFAULT_RECLAIM_STARTUP_GRACE_MS,
  reclaimWaitBudgetMs,
  runIsolationReclaimJob,
} from "../services/isolation-reclaim-runner.js";
import type { ReclaimJobPort } from "../services/isolation-reclaim-runner.js";

const CLAIM = "agent-workspace-29033747-e513-46d5-8a13-dcb5dac10017";
const NAMESPACE = "paperclip";

function manifestFor(
  mode: "inventory" | "execute",
  extra: Partial<IsolationReclaimJobSpec> = {},
): IsolationReclaimJobManifest {
  return buildIsolationReclaimJobManifest({
    claimName: CLAIM,
    namespace: NAMESPACE,
    image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
    invocationId: "20261101T0300Z-a1b2c3",
    mode,
    ...(mode === "execute"
      ? { plan: { planBuiltAtMs: 1_762_000_000_000, eligibleIds: [] } }
      : {}),
    ...extra,
  });
}

function job(overrides: {
  conditions?: k8s.V1JobCondition[];
  active?: number;
  succeeded?: number;
  /** The claim the Job MOUNTS. `null` drops the volume entirely. */
  mountedClaim?: string | null;
  /**
   * The claim the Job's annotation CLAIMS, independently of what it mounts.
   *
   * Decoupled on purpose. When the fixture stamped this from `mountedClaim`,
   * the two could never disagree, and swapping the adoption check between them
   * passed every test — the mutation that caught it is `N4`.
   */
  claimAnnotation?: string | null;
}): k8s.V1Job {
  const mounted = overrides.mountedClaim === undefined ? CLAIM : overrides.mountedClaim;
  const annotated =
    overrides.claimAnnotation === undefined ? mounted : overrides.claimAnnotation;
  return {
    metadata: {
      name: "pc-reclaim-inv-x",
      namespace: NAMESPACE,
      annotations: annotated === null ? {} : { [RECLAIM_JOB_CLAIM_ANNOTATION]: annotated },
    },
    spec: {
      template: {
        spec: {
          containers: [],
          volumes:
            mounted === null
              ? []
              : [
                  {
                    name: RECLAIM_TARGET_VOLUME_NAME,
                    persistentVolumeClaim: { claimName: mounted },
                  },
                ],
        },
      },
    },
    status: {
      conditions: overrides.conditions ?? [],
      active: overrides.active ?? 0,
      succeeded: overrides.succeeded ?? 0,
    },
  };
}

const COMPLETE: k8s.V1JobCondition[] = [{ type: "Complete", status: "True" } as k8s.V1JobCondition];
const FAILED: k8s.V1JobCondition[] = [
  { type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "exit 1" } as k8s.V1JobCondition,
];
const DEADLINE: k8s.V1JobCondition[] = [
  { type: "Failed", status: "True", reason: "DeadlineExceeded", message: "past deadline" } as k8s.V1JobCondition,
];

function pod(name: string): k8s.V1Pod {
  return { metadata: { name, namespace: NAMESPACE } };
}

const INVENTORY_REPORT: IsolationReclaimReport = {
  v: ISOLATION_RECLAIM_REPORT_VERSION,
  kind: "inventory",
  ok: true,
  inventory: [],
};

const EXECUTE_REPORT: IsolationReclaimReport = {
  v: ISOLATION_RECLAIM_REPORT_VERSION,
  kind: "execute",
  ok: true,
  result: {
    requested: 0,
    deleted: 0,
    wouldDelete: 0,
    skippedUnsafeName: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    vanished: 0,
    failed: 0,
    notAttempted: 0,
    capped: false,
    stopReason: "complete",
  },
};

interface FakePortOptions {
  create?: "created" | "already_exists";
  /** One entry per `readJob` call; the last repeats. */
  jobs?: (k8s.V1Job | null)[];
  pods?: k8s.V1Pod[];
  log?: string;
  logError?: Error;
}

function fakePort(options: FakePortOptions): ReclaimJobPort & { reads: number; sleeps: number } {
  let reads = 0;
  const handle = {
    reads: 0,
    sleeps: 0,
    async createJob(): Promise<"created" | "already_exists"> {
      return options.create ?? "created";
    },
    async readJob(): Promise<k8s.V1Job | null> {
      const series = options.jobs ?? [job({ conditions: COMPLETE })];
      const next = series[Math.min(reads, series.length - 1)] ?? null;
      reads += 1;
      handle.reads = reads;
      return next;
    },
    async listJobPods(): Promise<k8s.V1Pod[]> {
      return options.pods ?? [pod("pc-reclaim-inv-x-abcde")];
    },
    async readPodLog(): Promise<string> {
      if (options.logError) throw options.logError;
      return options.log ?? encodeIsolationReclaimReport(INVENTORY_REPORT);
    },
  };
  return handle;
}

/** A clock that advances only when the run sleeps, so the wait is deterministic. */
function fakeClock(startMs = 1_762_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
    },
    get nowMs() {
      return nowMs;
    },
  };
}

/**
 * `mode` is passed only to pick the manifest; the runner is never told it. That
 * is the point of the signature — see `derives its identity from the manifest`.
 */
function run(
  manifest: IsolationReclaimJobManifest,
  _mode: "inventory" | "execute",
  port: ReclaimJobPort,
  clock = fakeClock(),
) {
  return runIsolationReclaimJob({ manifest, port, now: clock.now, sleep: clock.sleep });
}

describe("reclaimWaitBudgetMs", () => {
  it("outlasts the Job's own activeDeadlineSeconds by the startup grace", () => {
    const manifest = manifestFor("inventory", { activeDeadlineSeconds: 600 });
    expect(reclaimWaitBudgetMs(manifest, DEFAULT_RECLAIM_STARTUP_GRACE_MS)).toBe(
      DEFAULT_RECLAIM_STARTUP_GRACE_MS + 600_000,
    );
  });

  it("tracks the manifest rather than a constant of its own", () => {
    // The point of deriving the budget: raising the Job's deadline must raise
    // the wait, or a large claim is abandoned mid-unlink.
    const small = reclaimWaitBudgetMs(manifestFor("inventory", { activeDeadlineSeconds: 60 }), 0);
    const large = reclaimWaitBudgetMs(manifestFor("inventory", { activeDeadlineSeconds: 3600 }), 0);
    expect(large - small).toBe(3_540_000);
  });

  it("falls back to the grace alone when the Job carries no deadline", () => {
    const manifest = manifestFor("inventory");
    // Strip it the way a hand-edited manifest could.
    delete manifest.job.spec?.activeDeadlineSeconds;
    expect(reclaimWaitBudgetMs(manifest, 42)).toBe(42);
  });
});

describe("runIsolationReclaimJob — the happy path", () => {
  it("creates, waits, reads the pod log and returns the report", async () => {
    const outcome = await run(manifestFor("inventory"), "inventory", fakePort({}));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report).toEqual(INVENTORY_REPORT);
    expect(outcome.podName).toBe("pc-reclaim-inv-x-abcde");
    expect(outcome.adopted).toBe(false);
    expect(outcome.claimName).toBe(CLAIM);
  });

  it("polls until the Job leaves the active phase", async () => {
    const port = fakePort({
      jobs: [
        job({ active: 1 }),
        job({ active: 1 }),
        job({ conditions: COMPLETE }),
      ],
    });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(true);
    expect(port.reads).toBe(3);
  });

  it("reads the report from the container the manifest actually names", async () => {
    let seenContainer: string | null = null;
    const port = fakePort({});
    port.readPodLog = async (_ns: string, _pod: string, container: string) => {
      seenContainer = container;
      return encodeIsolationReclaimReport(INVENTORY_REPORT);
    };
    await run(manifestFor("inventory"), "inventory", port);
    expect(seenContainer).toBe(RECLAIM_JOB_CONTAINER_NAME);
    // Pinned to the manifest, not to the string: one constant, both sides.
    const containers = manifestFor("inventory").job.spec?.template.spec?.containers ?? [];
    expect(containers.map((c) => c.name)).toEqual([seenContainer]);
  });
});

describe("runIsolationReclaimJob — adoption", () => {
  it("adopts an existing Job that mounts the same claim", async () => {
    const port = fakePort({ create: "already_exists" });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.adopted).toBe(true);
  });

  it("refuses an existing Job that mounts a different claim", async () => {
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: "agent-workspace-someone-else" })],
    });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("name_collision");
    expect(outcome.detail).toContain("agent-workspace-someone-else");
    // Nothing was created, so nothing can have unlinked.
    expect(outcome.deletionOutcomeUnknown).toBe(false);
  });

  it("refuses an existing Job that mounts no readable claim at all", async () => {
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: null })],
    });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("name_collision");
  });

  it("refuses a Job whose annotation agrees but whose volume does not", async () => {
    // The whole reason the check reads the volume: the annotation is a *claim
    // about* the mount, and a Job can carry a right-looking one while mounting
    // something else. Reading the annotation here adopts the wrong volume and,
    // on `execute`, waits on a pod deleting from a different tree.
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: "someone-elses-claim", claimAnnotation: CLAIM })],
    });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("name_collision");
    expect(outcome.detail).toContain("someone-elses-claim");
  });

  it("adopts a Job whose volume agrees even when its annotation does not", async () => {
    // The other direction, so the test cannot pass by refusing everything.
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: CLAIM, claimAnnotation: "stale-annotation" })],
    });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.adopted).toBe(true);
  });

  it("refuses a Job that mounts nothing readable even when it is annotated", async () => {
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: null, claimAnnotation: CLAIM })],
    });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("name_collision");
    expect(outcome.detail).toContain("no readable claim");
  });

  it("does not read a pod log for a refused adoption", async () => {
    let logReads = 0;
    const port = fakePort({
      create: "already_exists",
      jobs: [job({ conditions: COMPLETE, mountedClaim: "other" })],
    });
    port.readPodLog = async () => {
      logReads += 1;
      return "";
    };
    await run(manifestFor("execute"), "execute", port);
    expect(logReads).toBe(0);
  });
});

describe("runIsolationReclaimJob — identity comes from the manifest", () => {
  // The finding this block exists for (Ally, #3196): mode and claim used to be
  // parameters beside the manifest, so a caller could hand an `execute`
  // manifest and say `inventory`, and every failure would then report
  // deletionOutcomeUnknown: false for a Job that unlinks.
  it("takes the mode from the Job's own label, with nothing else to take it from", () => {
    expect(reclaimJobModeOf(manifestFor("execute").job)).toBe("execute");
    expect(reclaimJobModeOf(manifestFor("inventory").job)).toBe("inventory");
  });

  it("picks the target volume by name, not by position", () => {
    // `volumes[0]` happens to be the target in a real manifest, so a reader
    // that indexed instead of searching passed every other test here (mutation
    // `N6`). The home emptyDir carries no claim, so an off-by-position read
    // would silently answer `null` and refuse every adoption.
    const reordered = manifestFor("execute");
    const spec = reordered.job.spec?.template.spec;
    if (spec?.volumes) spec.volumes = [...spec.volumes].reverse();
    expect(spec?.volumes?.[0]?.name).not.toBe(RECLAIM_TARGET_VOLUME_NAME);
    expect(reclaimMountedClaimOf(reordered.job)).toBe(CLAIM);
  });

  it("takes the claim from the mounted volume, not from the annotation", () => {
    const manifest = manifestFor("execute");
    expect(reclaimMountedClaimOf(manifest.job)).toBe(CLAIM);
    // Rewrite the annotation and leave the volume alone: the volume still wins,
    // because the volume is what the pod mounts.
    const annotations = manifest.job.metadata?.annotations ?? {};
    annotations[RECLAIM_JOB_CLAIM_ANNOTATION] = "a-different-claim";
    expect(reclaimMountedClaimOf(manifest.job)).toBe(CLAIM);
  });

  it("cannot be told a claim that disagrees with what its pod mounts", async () => {
    // Same probe through the runner: the annotation is wrong, the volume is
    // right, and the adoption comparison tracks the volume.
    const manifest = manifestFor("inventory");
    const annotations = manifest.job.metadata?.annotations ?? {};
    annotations[RECLAIM_JOB_CLAIM_ANNOTATION] = "a-different-claim";
    const clock = fakeClock();
    const outcome = await runIsolationReclaimJob({
      manifest,
      port: fakePort({ create: "already_exists" }),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.claimName).toBe(CLAIM);
  });

  it("reports an execute manifest as an unknown even though no caller said execute", async () => {
    const outcome = await run(manifestFor("execute"), "execute", fakePort({ logError: new Error("x") }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.mode).toBe("execute");
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("refuses a manifest with no mode label, before creating anything", async () => {
    const manifest = manifestFor("execute");
    delete manifest.job.metadata?.labels?.[RECLAIM_JOB_MODE_LABEL];
    let creates = 0;
    const port = fakePort({});
    port.createJob = async () => {
      creates += 1;
      return "created";
    };
    const outcome = await runIsolationReclaimJob({ manifest, port });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("manifest_unreadable");
    expect(outcome.detail).toContain(RECLAIM_JOB_MODE_LABEL);
    expect(creates).toBe(0);
    // Refused before the create, so nothing can have deleted.
    expect(outcome.deletionOutcomeUnknown).toBe(false);
  });

  it("refuses a manifest with no target volume", async () => {
    const manifest = manifestFor("execute");
    const spec = manifest.job.spec?.template.spec;
    if (spec) spec.volumes = spec.volumes?.filter((v) => v.name !== RECLAIM_TARGET_VOLUME_NAME);
    const outcome = await runIsolationReclaimJob({ manifest, port: fakePort({}) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("manifest_unreadable");
    expect(outcome.detail).toContain(RECLAIM_TARGET_VOLUME_NAME);
  });

  it("names both gaps when a manifest records neither", async () => {
    const manifest = manifestFor("execute");
    delete manifest.job.metadata?.labels?.[RECLAIM_JOB_MODE_LABEL];
    const spec = manifest.job.spec?.template.spec;
    if (spec) spec.volumes = [];
    const outcome = await runIsolationReclaimJob({ manifest, port: fakePort({}) });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.detail).toContain(" or ");
  });

  it("ignores an extraLabels attempt to rewrite the mode", () => {
    // The builder spreads caller labels first, so the identifying ones win.
    const manifest = buildIsolationReclaimJobManifest({
      claimName: CLAIM,
      namespace: NAMESPACE,
      image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
      invocationId: "20261101T0300Z-a1b2c3",
      mode: "execute",
      plan: { planBuiltAtMs: 1_762_000_000_000, eligibleIds: [] },
      extraLabels: { [RECLAIM_JOB_MODE_LABEL]: "inventory" },
    });
    expect(reclaimJobModeOf(manifest.job)).toBe("execute");
  });

  it("refuses an unrecognized mode label rather than passing it through", () => {
    const manifest = manifestFor("inventory");
    const labels = manifest.job.metadata?.labels ?? {};
    labels[RECLAIM_JOB_MODE_LABEL] = "wipe-everything";
    expect(reclaimJobModeOf(manifest.job)).toBeNull();
  });
});

describe("runIsolationReclaimJob — deletionOutcomeUnknown", () => {
  // The field the module exists to get right: on `execute`, every failure after
  // the Job could have started is an unknown, never a zero.
  const failures: Array<[string, () => ReclaimJobPort]> = [
    ["job_failed", () => fakePort({ jobs: [job({ conditions: FAILED })], log: "" })],
    ["deadline_exceeded", () => fakePort({ jobs: [job({ conditions: DEADLINE })] })],
    ["pod_absent", () => fakePort({ jobs: [job({ conditions: COMPLETE })], pods: [] })],
    [
      "pod_ambiguous",
      () => fakePort({ pods: [pod("a"), pod("b")] }),
    ],
    ["log_unreadable", () => fakePort({ logError: new Error("connection reset") })],
    ["report_malformed", () => fakePort({ log: "@@PCRECLAIM@@{not json" })],
  ];

  for (const [kind, build] of failures) {
    it(`reports ${kind} on execute as an unknown deletion outcome`, async () => {
      const outcome = await run(manifestFor("execute"), "execute", build());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.kind).toBe(kind);
      expect(outcome.deletionOutcomeUnknown).toBe(true);
    });

    it(`reports ${kind} on inventory as a known-zero deletion outcome`, async () => {
      const outcome = await run(manifestFor("inventory"), "inventory", build());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.deletionOutcomeUnknown).toBe(false);
    });
  }
});

describe("runIsolationReclaimJob — terminal classification", () => {
  it("names DeadlineExceeded rather than the missing pod it causes", async () => {
    // The controller deletes the pod on a deadline kill, so `pod_absent` would
    // be true and would name the wrong cause.
    const port = fakePort({ jobs: [job({ conditions: DEADLINE })], pods: [] });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("deadline_exceeded");
    expect(outcome.detail).toContain("unlink loop");
  });

  it("returns a report recovered from a FAILED Job rather than the exit code", async () => {
    // The executor exits non-zero on every refusal, so Failed is the normal
    // shape of a correct refusal report.
    const refusal: IsolationReclaimReport = {
      v: ISOLATION_RECLAIM_REPORT_VERSION,
      kind: "execute",
      ok: false,
      error: "plan is stale",
    };
    const port = fakePort({
      jobs: [job({ conditions: FAILED })],
      log: `warning: something\n${encodeIsolationReclaimReport(refusal)}\n`,
    });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report).toEqual(refusal);
  });

  it("falls back to the Job's own reason when a failed Job reported nothing", async () => {
    const port = fakePort({ jobs: [job({ conditions: FAILED })], log: "boom\n" });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("job_failed");
    expect(outcome.detail).toContain("BackoffLimitExceeded");
  });

  it("refuses two pods rather than letting one speak for the Job", async () => {
    const port = fakePort({ pods: [pod("b-second"), pod("a-first")] });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("pod_ambiguous");
    // Sorted, so the message is stable across list orders.
    expect(outcome.detail).toContain("a-first, b-second");
  });

  it("refuses a report whose kind is not the mode that was launched", async () => {
    const port = fakePort({ log: encodeIsolationReclaimReport(EXECUTE_REPORT) });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("report_mode_mismatch");
  });

  it("maps every parse failure to its own kind", async () => {
    const duplicate = `${encodeIsolationReclaimReport(INVENTORY_REPORT)}\n${encodeIsolationReclaimReport(
      INVENTORY_REPORT,
    )}`;
    const future = encodeIsolationReclaimReport({
      ...INVENTORY_REPORT,
      v: ISOLATION_RECLAIM_REPORT_VERSION + 1,
    });
    const cases: Array<[string, string]> = [
      ["report_absent", "nothing marked here\n"],
      ["report_duplicate", duplicate],
      ["report_malformed", "@@PCRECLAIM@@{clipped"],
      ["report_unsupported_version", future],
    ];
    for (const [kind, log] of cases) {
      const outcome = await run(manifestFor("inventory"), "inventory", fakePort({ log }));
      expect(outcome.ok, `${kind}: ${log}`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.kind, `log: ${log}`).toBe(kind);
    }
  });
});

describe("runIsolationReclaimJob — the wait budget", () => {
  it("gives up once the budget elapses and says so", async () => {
    const port = fakePort({ jobs: [job({ active: 1 })], log: "still working\n" });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("wait_timeout");
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("does not poll forever: the number of reads is bounded by the budget", async () => {
    const port = fakePort({ jobs: [job({ active: 1 })], log: "" });
    const clock = fakeClock();
    await run(manifestFor("execute"), "execute", port, clock);
    const budget = reclaimWaitBudgetMs(manifestFor("execute"), DEFAULT_RECLAIM_STARTUP_GRACE_MS);
    // One read per poll interval plus the final one that observes the deadline.
    expect(port.reads).toBeLessThanOrEqual(Math.ceil(budget / 5_000) + 2);
    expect(port.reads).toBeGreaterThan(1);
  });

  it("still takes a report that landed after the last poll", async () => {
    // The race the late read exists for: the executor wrote its line between
    // the final `readJob` and the log read.
    const port = fakePort({
      jobs: [job({ active: 1 })],
      log: encodeIsolationReclaimReport(INVENTORY_REPORT),
    });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(true);
  });
});

describe("runIsolationReclaimJob — the Job vanishing", () => {
  it("reports a Job deleted mid-wait as an unknown on execute", async () => {
    const port = fakePort({ jobs: [job({ active: 1 }), null] });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("job_failed");
    expect(outcome.detail).toContain("disappeared");
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("reports an AlreadyExists whose Job vanished as an UNKNOWN on execute", async () => {
    // The Job name embeds the invocation id, so the likeliest owner of a Job
    // under this exact name is our own earlier attempt. If that attempt was an
    // `execute` that ran and was then TTL-cleaned in this window, deletions
    // happened — "it never ran" is an assumption, not an observation.
    const port = fakePort({ create: "already_exists", jobs: [null] });
    const outcome = await run(manifestFor("execute"), "execute", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("job_failed");
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("reports the same vanished AlreadyExists as a known-zero on inventory", async () => {
    const port = fakePort({ create: "already_exists", jobs: [null] });
    const outcome = await run(manifestFor("inventory"), "inventory", port);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.deletionOutcomeUnknown).toBe(false);
  });
});

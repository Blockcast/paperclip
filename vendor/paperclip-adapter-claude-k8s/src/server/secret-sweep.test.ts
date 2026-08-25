import { describe, expect, it, vi } from "vitest";

import {
  ADAPTER_TYPE_LABEL,
  createSweepGate,
  DEFAULT_LAUNCH_LEASE_SEC,
  createLaunchLeaseHeartbeat,
  DEFAULT_SWEEP_AGE_FLOOR_SEC,
  deriveOwningJobName,
  LAUNCH_LEASE_ANNOTATION,
  launchLeaseExpiry,
  MANAGED_BY_LABEL,
  RUN_ID_LABEL,
  sweepOrphanedRunSecrets,
  type SecretSweepObjectMeta,
} from "./secret-sweep.js";

const NOW = Date.parse("2026-08-22T02:00:00.000Z");
const AGE_FLOOR_MS = DEFAULT_SWEEP_AGE_FLOOR_SEC * 1000;

function secret(
  name: string,
  opts: {
    runId?: string | null;
    ageSec?: number;
    owned?: boolean;
    deleting?: boolean;
    creationTimestamp?: Date | string;
    /** Value for the launch-lease annotation; omit for a pre-lease Secret. */
    lease?: string;
  } = {},
): { metadata: SecretSweepObjectMeta } {
  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: "paperclip",
    [ADAPTER_TYPE_LABEL]: "claude_k8s",
  };
  if (opts.runId !== null) labels[RUN_ID_LABEL] = opts.runId ?? "run-abc";
  const metadata: SecretSweepObjectMeta = { name, labels };
  if (opts.lease !== undefined) {
    metadata.annotations = { [LAUNCH_LEASE_ANNOTATION]: opts.lease };
  }
  if (opts.owned) {
    metadata.ownerReferences = [{ apiVersion: "batch/v1", kind: "Job", name: "ac-x", uid: "u1" }];
  }
  if (opts.deleting) metadata.deletionTimestamp = new Date(NOW);
  metadata.creationTimestamp =
    "creationTimestamp" in opts
      ? opts.creationTimestamp
      : new Date(NOW - (opts.ageSec ?? 3600) * 1000);
  return { metadata };
}

function job(name: string, runId?: string | null): { metadata: SecretSweepObjectMeta } {
  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: "paperclip",
    [ADAPTER_TYPE_LABEL]: "claude_k8s",
  };
  if (runId) labels[RUN_ID_LABEL] = runId;
  return { metadata: { name, labels } };
}

/** What the API server returns for a Job that is not there. */
function notFound(): Error & { code: number } {
  return Object.assign(new Error("jobs.batch \"x\" not found"), { code: 404 });
}

function harness(
  secrets: { metadata: SecretSweepObjectMeta }[],
  jobs: { metadata: SecretSweepObjectMeta }[] = [],
  deleteImpl?: (req: { name: string; namespace: string }) => Promise<unknown>,
  readImpl?: (req: { name: string; namespace: string }) => Promise<unknown>,
) {
  const deleted: string[] = [];
  const logs: { stream: string; message: string }[] = [];
  const listNamespacedSecret = vi.fn(async () => ({ items: secrets }));
  const listNamespacedJob = vi.fn(async () => ({ items: jobs }));
  // Default: agree with the list snapshot, so the pre-delete re-read confirms
  // absence for anything the snapshot did not show.
  const readNamespacedJob = vi.fn(async (req: { name: string; namespace: string }) => {
    if (readImpl) return readImpl(req);
    if (jobs.some((j) => j.metadata.name === req.name)) return {};
    throw notFound();
  });
  const deleteNamespacedSecret = vi.fn(async (req: { name: string; namespace: string }) => {
    if (deleteImpl) return deleteImpl(req);
    deleted.push(req.name);
    return {};
  });
  return {
    deleted,
    logs,
    listNamespacedSecret,
    listNamespacedJob,
    readNamespacedJob,
    deleteNamespacedSecret,
    opts: {
      namespace: "paperclip",
      coreApi: { listNamespacedSecret, deleteNamespacedSecret },
      batchApi: { listNamespacedJob, readNamespacedJob },
      onLog: (stream: string, message: string) => {
        logs.push({ stream, message });
      },
      ageFloorMs: AGE_FLOOR_MS,
      now: NOW,
    },
  };
}

describe("sweepOrphanedRunSecrets", () => {
  // The two tests named in BLO-21857's Verifying signal.
  it("deletes an ownerless Secret with no matching Job past the age floor", async () => {
    // Simulates a control-plane crash between createNamespacedSecret and the
    // ownerReferences patch: the Secret exists, carries the run-id label, has
    // no owner, and no Job was ever created for it.
    const h = harness([secret("ac-agent-run-abc123-prompt", { runId: "run-abc", ageSec: 3600 })]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual(["ac-agent-run-abc123-prompt"]);
    expect(h.deleted).toEqual(["ac-agent-run-abc123-prompt"]);
    expect(h.deleteNamespacedSecret).toHaveBeenCalledWith({
      name: "ac-agent-run-abc123-prompt",
      namespace: "paperclip",
    });
    expect(h.logs.some((l) => l.stream === "stdout" && l.message.includes("Swept ownerless Secret"))).toBe(true);
  });

  it("does not collect a fresh ownerless Secret inside the age floor", async () => {
    // The normal launch path: Secret created seconds ago, its Job is about to
    // be created. The sweep must never race this.
    const h = harness([secret("ac-agent-run-fresh-prompt", { runId: "run-fresh", ageSec: 5 })]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-fresh-prompt", reason: "too_young" }]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
    // No candidates => the Job list is never even fetched.
    expect(h.listNamespacedJob).not.toHaveBeenCalled();
  });

  // BLO-21857 review follow-up (PR #1459, allyblockcast[bot]): the age floor
  // does not bound the launch window, and a single Job-list snapshot can be
  // stale by the time the delete runs. Both are live-credential-loss paths, so
  // both get a test.
  it("does not collect a Secret whose launch lease has not expired, however old it is", async () => {
    // A launch wedged well past the age floor — a slow or retrying K8s API call
    // between createNamespacedSecret and createNamespacedJob. Nothing in
    // execute.ts bounds that gap, so age alone must not authorise a delete.
    const h = harness([
      secret("ac-agent-run-slow-prompt", {
        runId: "run-slow",
        ageSec: 600,
        lease: new Date(NOW + 300_000).toISOString(),
      }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([
      { name: "ac-agent-run-slow-prompt", reason: "launch_in_flight" },
    ]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("collects a Secret whose launch lease has expired", async () => {
    // Same Secret, lease now in the past: the launch that claimed it is gone.
    const h = harness([
      secret("ac-agent-run-dead-prompt", {
        runId: "run-dead",
        ageSec: 3600,
        lease: new Date(NOW - 1_000).toISOString(),
      }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual(["ac-agent-run-dead-prompt"]);
  });

  it("treats an unparseable launch lease as a live launch rather than ignoring it", async () => {
    const h = harness([
      secret("ac-agent-run-junk-prompt", { runId: "run-junk", ageSec: 3600, lease: "not-a-date" }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([
      { name: "ac-agent-run-junk-prompt", reason: "launch_in_flight" },
    ]);
  });

  it("re-reads the Job before deleting, so one created after the list snapshot is honoured", async () => {
    // The cross-replica race: replica A's createNamespacedJob lands between this
    // sweep's Job list and its delete. The snapshot says no Job; the point read
    // says otherwise, and the point read wins.
    const h = harness(
      [secret("ac-agent-run-racy-prompt", { runId: "run-racy", ageSec: 3600 })],
      [],
      undefined,
      async () => ({ metadata: { name: "ac-agent-run-racy" } }),
    );

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-racy-prompt", reason: "unverifiable" }]);
    expect(h.readNamespacedJob).toHaveBeenCalledWith({
      name: "ac-agent-run-racy",
      namespace: "paperclip",
    });
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("keeps the Secret when the pre-delete re-read fails for any reason but 404", async () => {
    // Throttling, a timeout, an RBAC change. We do not know the Job is gone, and
    // not knowing is not grounds for deleting a credential.
    const h = harness(
      [secret("ac-agent-run-throttled-prompt", { runId: "run-throttled", ageSec: 3600 })],
      [],
      undefined,
      async () => {
        throw Object.assign(new Error("too many requests"), { code: 429 });
      },
    );

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([
      { name: "ac-agent-run-throttled-prompt", reason: "unverifiable" },
    ]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("retains a run Secret whose name yields no Job to re-read", async () => {
    // No derivable Job name means absence can never be proven, so the snapshot
    // alone must not authorise a delete.
    const h = harness([secret("ac-agent-run-oddname", { runId: "run-odd", ageSec: 3600 })]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-oddname", reason: "unverifiable" }]);
    expect(h.readNamespacedJob).not.toHaveBeenCalled();
  });

  it("leaves a Secret alone while a Job with its run-id still exists", async () => {
    // Crash after Job create, before the ownerReferences patch. The Job is
    // still around, so the Secret is retained; it becomes collectable only
    // once ttlSecondsAfterFinished removes the Job.
    const h = harness(
      [secret("ac-agent-run-live-env", { runId: "run-live", ageSec: 3600 })],
      [job("ac-agent-run-live", "run-live")],
    );

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-live-env", reason: "job_exists" }]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("leaves a Secret alone on the job-name check even when the Job has no run-id label", async () => {
    // sanitizeLabelValue(runId) can yield null, in which case job-manifest
    // omits paperclip.io/run-id from the Job entirely. The name-derived check
    // must still protect the Secret.
    const h = harness(
      [secret("ac-agent-run-nolabel-mcp", { runId: "run-nolabel", ageSec: 3600 })],
      [job("ac-agent-run-nolabel", null)],
    );

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-nolabel-mcp", reason: "job_exists" }]);
  });

  it("never deletes an owned Secret", async () => {
    const h = harness([secret("ac-agent-run-owned-prompt", { owned: true, ageSec: 3600 })]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-owned-prompt", reason: "owned" }]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("retains an ownerless Secret whose run-id label is empty rather than guessing", async () => {
    const h = harness([secret("ac-agent-run-norunid-prompt", { runId: "", ageSec: 3600 })]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-norunid-prompt", reason: "no_run_id" }]);
  });

  it("treats an unreadable creation timestamp as too young", async () => {
    const h = harness([
      secret("ac-agent-run-badts-prompt", { runId: "run-badts", creationTimestamp: "not-a-date" }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([{ name: "ac-agent-run-badts-prompt", reason: "too_young" }]);
  });

  it("skips a Secret already being deleted", async () => {
    const h = harness([
      secret("ac-agent-run-going-prompt", { runId: "run-going", ageSec: 3600, deleting: true }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toEqual([]);
    expect(result.retained).toEqual([]);
    expect(h.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("sweeps all three run Secrets for one dead run with a single Job list call", async () => {
    const h = harness([
      secret("ac-agent-run-dead-prompt", { runId: "run-dead", ageSec: 3600 }),
      secret("ac-agent-run-dead-env", { runId: "run-dead", ageSec: 3600 }),
      secret("ac-agent-run-dead-mcp", { runId: "run-dead", ageSec: 3600 }),
    ]);

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.swept).toHaveLength(3);
    // A cleanup path must not multiply load on the API server.
    expect(h.listNamespacedJob).toHaveBeenCalledTimes(1);
  });

  it("records a failed delete without throwing or aborting the sweep", async () => {
    const h = harness(
      [
        secret("ac-agent-run-a-prompt", { runId: "run-a", ageSec: 3600 }),
        secret("ac-agent-run-b-prompt", { runId: "run-b", ageSec: 3600 }),
      ],
      [],
      async (req) => {
        if (req.name === "ac-agent-run-a-prompt") throw new Error("403 forbidden");
        return {};
      },
    );

    const result = await sweepOrphanedRunSecrets(h.opts);

    expect(result.failed).toEqual([{ name: "ac-agent-run-a-prompt", error: "403 forbidden" }]);
    expect(result.swept).toEqual(["ac-agent-run-b-prompt"]);
    expect(h.logs.some((l) => l.stream === "stderr")).toBe(true);
  });

  it("scopes the Secret query to paperclip-managed claude_k8s run Secrets", async () => {
    const h = harness([]);

    await sweepOrphanedRunSecrets(h.opts);

    expect(h.listNamespacedSecret).toHaveBeenCalledWith({
      namespace: "paperclip",
      labelSelector: `${MANAGED_BY_LABEL}=paperclip,${ADAPTER_TYPE_LABEL}=claude_k8s,${RUN_ID_LABEL}`,
    });
  });
});

describe("launchLeaseExpiry", () => {
  it("stamps a lease the sweep reads back as still in flight", async () => {
    const lease = launchLeaseExpiry(NOW);
    expect(Date.parse(lease)).toBe(NOW + DEFAULT_LAUNCH_LEASE_SEC * 1000);

    // Round-trip: a Secret stamped by execute.ts at NOW, judged by a sweep one
    // age-floor later, is still protected.
    const h = harness([secret("ac-agent-run-rt-prompt", { runId: "run-rt", lease })]);
    const result = await sweepOrphanedRunSecrets({ ...h.opts, now: NOW + AGE_FLOOR_MS + 1 });

    expect(result.retained).toEqual([{ name: "ac-agent-run-rt-prompt", reason: "launch_in_flight" }]);
  });

  it("renews a Secret while a launch API call is still stalled", async () => {
    vi.useFakeTimers();
    const patchNamespacedSecret = vi.fn().mockResolvedValue({});
    const heartbeat = createLaunchLeaseHeartbeat({
      coreApi: { patchNamespacedSecret },
      leaseMs: 9_000,
    });
    heartbeat.add({ name: "ac-agent-run-stalled-prompt", namespace: "paperclip" });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(patchNamespacedSecret).toHaveBeenCalledWith(expect.objectContaining({
      name: "ac-agent-run-stalled-prompt",
      namespace: "paperclip",
      body: { metadata: { annotations: { [LAUNCH_LEASE_ANNOTATION]: expect.any(String) } } },
    }));
    heartbeat.stop();
    vi.useRealTimers();
  });
});

describe("deriveOwningJobName", () => {  it("strips each known run-Secret suffix", () => {
    expect(deriveOwningJobName("ac-agent-run-abc-prompt")).toBe("ac-agent-run-abc");
    expect(deriveOwningJobName("ac-agent-run-abc-env")).toBe("ac-agent-run-abc");
    expect(deriveOwningJobName("ac-agent-run-abc-mcp")).toBe("ac-agent-run-abc");
  });

  it("returns null for a name that does not follow the convention", () => {
    expect(deriveOwningJobName("some-other-secret")).toBeNull();
    expect(deriveOwningJobName("-prompt")).toBeNull();
  });
});

describe("createSweepGate", () => {
  it("sweeps on first call and then rate-limits until the interval elapses", async () => {
    const gate = createSweepGate();
    const h = harness([secret("ac-agent-run-x-prompt", { runId: "run-x", ageSec: 3600 })]);
    const intervalMs = 300_000;

    const first = await gate({ ...h.opts, intervalMs, now: NOW });
    expect(first?.swept).toEqual(["ac-agent-run-x-prompt"]);

    const second = await gate({ ...h.opts, intervalMs, now: NOW + intervalMs - 1 });
    expect(second).toBeNull();
    expect(h.listNamespacedSecret).toHaveBeenCalledTimes(1);

    const third = await gate({ ...h.opts, intervalMs, now: NOW + intervalMs });
    expect(third).not.toBeNull();
    expect(h.listNamespacedSecret).toHaveBeenCalledTimes(2);
  });

  it("swallows a listing failure so a run is never failed by cleanup", async () => {
    const gate = createSweepGate();
    const logs: { stream: string; message: string }[] = [];

    const result = await gate({
      namespace: "paperclip",
      coreApi: {
        listNamespacedSecret: async () => {
          throw new Error("apiserver unreachable");
        },
        deleteNamespacedSecret: async () => ({}),
      },
      batchApi: { listNamespacedJob: async () => ({ items: [] }) },
      onLog: (stream, message) => {
        logs.push({ stream, message });
      },
      now: NOW,
    });

    expect(result).toBeNull();
    expect(logs.some((l) => l.stream === "stderr" && l.message.includes("sweep failed (non-fatal)"))).toBe(true);
  });
});

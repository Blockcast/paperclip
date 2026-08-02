import type { V1ContainerStatus, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  ADAPTER_TYPE_LABEL,
  classifyAgentJobRunStatus,
  classifyManagedAgentPod,
  indexUniqueAgentJobRunStatuses,
  isActiveOrTerminatingAgentPod,
  jobBlocksDispatch,
  matchExactAgentJob,
  pickDiagnosticPod,
  readContainerDiagnostic,
  type ManagedAgentJob,
} from "../services/k8s-job-liveness.js";

function managedJob(overrides: Partial<ManagedAgentJob> = {}): ManagedAgentJob {
  return {
    phase: "active",
    reason: null,
    message: null,
    runId: "run-1",
    agentId: "agent-1",
    name: "job-1",
    uid: "uid-1",
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("classifyAgentJobRunStatus", () => {
  it("keeps multi-completion Jobs active when only one pod succeeded and no Complete condition exists", () => {
    const job = {
      spec: { completions: 2 },
      status: {
        active: 1,
        succeeded: 1,
        conditions: [],
      },
    } as unknown as V1Job satisfies V1Job;

    expect(classifyAgentJobRunStatus(job)).toEqual({
      phase: "active",
      reason: null,
      message: null,
    });
  });

  it("keeps a Job active when pods have failed but no terminal Failed condition exists", () => {
    const job = {
      status: {
        active: 0,
        failed: 1,
        conditions: [],
      },
    } satisfies V1Job;

    expect(classifyAgentJobRunStatus(job)).toEqual({
      phase: "active",
      reason: null,
      message: null,
    });
  });
});

function jobWithRunLabel(
  runId: string | null,
  status?: { active?: number; succeeded?: number; failed?: number } | null,
): V1Job {
  return {
    metadata: {
      name: "job-1",
      uid: "uid-1",
      labels: runId ? { "paperclip.io/run-id": runId } : {},
    },
    status: status === null ? undefined : { active: 0, succeeded: 0, failed: 0, ...status },
  } as unknown as V1Job;
}

describe("jobBlocksDispatch (BLO-20801)", () => {
  it("blocks on a Job with no status subresource when its run is not known terminal", () => {
    const job = jobWithRunLabel("run-live", null);
    expect(jobBlocksDispatch(job, new Set())).toBe(true);
  });

  it("no longer blocks on a Job with no status subresource once its run is terminal in the DB", () => {
    const job = jobWithRunLabel("run-terminal", null);
    expect(jobBlocksDispatch(job, new Set(["run-terminal"]))).toBe(false);
  });

  it("blocks on a Job with active/succeeded/failed all zero when its run is not known terminal", () => {
    const job = jobWithRunLabel("run-live", { active: 0, succeeded: 0, failed: 0 });
    expect(jobBlocksDispatch(job, new Set())).toBe(true);
  });

  it("no longer blocks on a Job with all-zero counters once its run is terminal in the DB", () => {
    const job = jobWithRunLabel("run-terminal", { active: 0, succeeded: 0, failed: 0 });
    expect(jobBlocksDispatch(job, new Set(["run-terminal"]))).toBe(false);
  });

  it("still blocks on a genuinely active Job even once its run-id is terminal in the DB", () => {
    // Regression guard (PR #946 review): a terminal DB row is not proof the
    // Job's controller has stopped -- process_lost is minted on ambiguous/
    // lost-visibility conditions, not confirmed pod death. A Job Kubernetes
    // reports as active > 0 right now is real, live evidence that must never
    // be waived by the DB row alone, or dispatch could admit a second run
    // while the old Job can still execute.
    const job = jobWithRunLabel("run-terminal", { active: 1, succeeded: 0, failed: 0 });
    expect(jobBlocksDispatch(job, new Set(["run-terminal"]))).toBe(true);
  });

  it("still blocks on a live Job mapped to a live (non-terminal) run", () => {
    const job = jobWithRunLabel("run-live", { active: 1, succeeded: 0, failed: 0 });
    expect(jobBlocksDispatch(job, new Set(["some-other-terminal-run"]))).toBe(true);
  });

  it("treats a Job with no run-id label as unaffected by the terminal-run set", () => {
    const job = jobWithRunLabel(null, null);
    expect(jobBlocksDispatch(job, new Set(["run-terminal"]))).toBe(true);
  });

  it("does not block a genuinely completed Job (succeeded, no active) regardless of terminal-run set", () => {
    const job = jobWithRunLabel("run-live", { active: 0, succeeded: 1, failed: 0 });
    expect(jobBlocksDispatch(job, new Set())).toBe(false);
  });
});

describe("isActiveOrTerminatingAgentPod", () => {
  it("treats terminating pods as active so RWO volumes can detach before retry dispatch", () => {
    const pod = {
      metadata: {
        deletionTimestamp: "2026-06-11T19:45:40.000Z",
      },
      status: {
        phase: "Running",
      },
    } as unknown as V1Pod;

    expect(isActiveOrTerminatingAgentPod(pod)).toBe(true);
  });

  it("ignores completed pods that are not terminating", () => {
    const pod = {
      status: {
        phase: "Succeeded",
      },
    } as V1Pod;

    expect(isActiveOrTerminatingAgentPod(pod)).toBe(false);
  });
});

describe("managed Job reconciliation", () => {
  it("omits duplicate run labels instead of collapsing them by list order", () => {
    const statuses = indexUniqueAgentJobRunStatuses([
      managedJob(),
      managedJob({ name: "job-duplicate", uid: "uid-duplicate" }),
      managedJob({ runId: "run-2", name: "job-2", uid: "uid-2" }),
    ]);

    expect(statuses.has("run-1")).toBe(false);
    expect(statuses.get("run-2")).toMatchObject({ name: "job-2", uid: "uid-2" });
  });

  it("matches only one exact run, agent, name, and UID tuple", () => {
    const exact = managedJob();
    expect(matchExactAgentJob([exact], {
      runId: "run-1",
      agentId: "agent-1",
      name: "job-1",
      uid: "uid-1",
    })).toEqual({ kind: "exact", job: exact });

    expect(matchExactAgentJob([exact], {
      runId: "run-1",
      agentId: "agent-1",
      name: "job-1",
      uid: "replacement-uid",
    })).toMatchObject({ kind: "ambiguous" });

    expect(matchExactAgentJob([exact], {
      runId: "run-1",
      agentId: "agent-replacement",
      name: "job-1",
      uid: "uid-1",
    })).toMatchObject({ kind: "ambiguous" });
  });
});

function podFixture(overrides: {
  name?: string | null;
  uid?: string | null;
  phase?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
}): V1Pod {
  return {
    metadata: {
      name: overrides.name === undefined ? "agent-opencode-a-b-c" : overrides.name ?? undefined,
      uid: overrides.uid === undefined ? "pod-uid-1" : overrides.uid ?? undefined,
      labels: overrides.labels ?? {
        "app.kubernetes.io/managed-by": "paperclip",
        "paperclip.io/run-id": "run-1",
        "paperclip.io/agent-id": "agent-1",
        "paperclip.io/adapter-type": "opencode_k8s",
      },
      deletionTimestamp: overrides.deletionTimestamp as unknown as Date | undefined,
      creationTimestamp: (overrides.creationTimestamp ?? "2026-07-18T00:00:00Z") as unknown as Date,
    },
    status: { phase: overrides.phase ?? "Running" },
  } as V1Pod;
}

describe("classifyManagedAgentPod", () => {
  it("maps labels, phase, and identity from a running managed pod", () => {
    const result = classifyManagedAgentPod(podFixture({}));
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      name: "agent-opencode-a-b-c",
      uid: "pod-uid-1",
      runId: "run-1",
      agentId: "agent-1",
      adapterType: "opencode_k8s",
      phase: "Running",
      isActiveOrTerminating: true,
      deletionTimestamp: null,
    });
    expect(result!.createdAt).toBeInstanceOf(Date);
  });

  it("returns null when name or uid is missing (cannot be exact-deleted)", () => {
    expect(classifyManagedAgentPod(podFixture({ name: null }))).toBeNull();
    expect(classifyManagedAgentPod(podFixture({ uid: null }))).toBeNull();
  });

  it("treats a terminating pod as active even when phase is Running", () => {
    const result = classifyManagedAgentPod(
      podFixture({ deletionTimestamp: "2026-07-18T01:00:00Z" }),
    );
    expect(result!.isActiveOrTerminating).toBe(true);
    expect(result!.deletionTimestamp).toBeInstanceOf(Date);
  });

  it("marks a Succeeded pod as not active", () => {
    const result = classifyManagedAgentPod(podFixture({ phase: "Succeeded" }));
    expect(result!.isActiveOrTerminating).toBe(false);
  });

  it("exposes the adapter-type label constant", () => {
    expect(ADAPTER_TYPE_LABEL).toBe("paperclip.io/adapter-type");
  });
});

describe("readContainerDiagnostic", () => {
  it("names the container, exit code and reason a Job Failed condition omits", () => {
    // Reproduces the BLO-18145 exit-128 signature: init container exits 0, the
    // app container dies ~4s in. The Job condition for this only ever says
    // "Job has reached the specified backoff limit".
    const status = {
      name: "claude",
      state: {
        terminated: {
          exitCode: 128,
          reason: "Error",
          startedAt: new Date("2026-07-26T17:02:20.000Z"),
          finishedAt: new Date("2026-07-26T17:02:24.000Z"),
        },
      },
    } as unknown as V1ContainerStatus;

    expect(readContainerDiagnostic(status, "app")).toEqual({
      container: "claude",
      kind: "app",
      exitCode: 128,
      reason: "Error",
      signal: null,
      terminationMessage: null,
      startedAt: "2026-07-26T17:02:20.000Z",
      finishedAt: "2026-07-26T17:02:24.000Z",
    });
  });

  it("scrubs secrets out of the termination message", () => {
    const status = {
      name: "claude",
      state: {
        terminated: {
          exitCode: 1,
          reason: "Error",
          message: 'boot failed: ANTHROPIC_API_KEY=sk-ant-abc123secret not accepted',
        },
      },
    } as unknown as V1ContainerStatus;

    const result = readContainerDiagnostic(status, "app");
    expect(result!.terminationMessage).not.toContain("sk-ant-abc123secret");
    expect(result!.terminationMessage).toContain("REDACTED");
  });

  it("falls back to lastState so a restarted container still reports why it died", () => {
    const status = {
      name: "claude",
      state: { running: { startedAt: new Date("2026-08-01T00:00:00.000Z") } },
      lastState: { terminated: { exitCode: 137, reason: "OOMKilled", signal: 9 } },
    } as unknown as V1ContainerStatus;

    const result = readContainerDiagnostic(status, "app");
    expect(result).toMatchObject({ exitCode: 137, reason: "OOMKilled", signal: 9 });
  });

  it("returns null for a container that never terminated", () => {
    const status = {
      name: "claude",
      state: { waiting: { reason: "PodInitializing" } },
    } as unknown as V1ContainerStatus;

    expect(readContainerDiagnostic(status, "app")).toBeNull();
  });
});

describe("pickDiagnosticPod", () => {
  function diagPod(name: string, phase: string, startTime: string): V1Pod {
    return {
      metadata: { name, creationTimestamp: new Date(startTime) },
      status: { phase, startTime: new Date(startTime) },
    } as unknown as V1Pod;
  }

  it("prefers a Failed pod over a newer Succeeded one", () => {
    // A Job at its backoff limit can leave several pods behind; the attempts
    // that succeeded explain nothing about the failure.
    const chosen = pickDiagnosticPod([
      diagPod("succeeded-newer", "Succeeded", "2026-08-01T02:00:00Z"),
      diagPod("failed-older", "Failed", "2026-08-01T01:00:00Z"),
    ]);
    expect(chosen!.metadata!.name).toBe("failed-older");
  });

  it("picks the most recently started pod among several Failed ones", () => {
    const chosen = pickDiagnosticPod([
      diagPod("failed-old", "Failed", "2026-08-01T01:00:00Z"),
      diagPod("failed-new", "Failed", "2026-08-01T03:00:00Z"),
    ]);
    expect(chosen!.metadata!.name).toBe("failed-new");
  });

  it("returns null when the pods are already GC'd", () => {
    expect(pickDiagnosticPod([])).toBeNull();
  });
});

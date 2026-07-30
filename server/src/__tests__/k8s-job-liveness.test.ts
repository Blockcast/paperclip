import type { V1ContainerStatus, V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  ADAPTER_TYPE_LABEL,
  classifyAgentJobRunStatus,
  classifyManagedAgentPod,
  indexUniqueAgentJobRunStatuses,
  isActiveOrTerminatingAgentPod,
  matchExactAgentJob,
  readContainerTermination,
  scoreFailedPodCandidate,
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

// BLO-18145: the Job-level `Failed` condition only ever says "Job has reached
// the specified backoff limit" — it names no container and carries no exit code.
// These cover the container-level read that makes an opaque exit 128 diagnosable.
describe("readContainerTermination", () => {
  it("reads exit code, reason and redacted message from a terminated container", () => {
    const result = readContainerTermination(
      {
        name: "claude",
        restartCount: 0,
        state: {
          terminated: {
            exitCode: 128,
            reason: "Error",
            message: "ANTHROPIC_API_KEY=sk-ant-leaked-value",
            startedAt: new Date("2026-07-30T14:29:46.000Z"),
            finishedAt: new Date("2026-07-30T14:29:46.000Z"),
          },
        },
      } as unknown as V1ContainerStatus,
      "app",
    );

    expect(result).toMatchObject({
      container: "claude",
      kind: "app",
      exitCode: 128,
      reason: "Error",
      restartCount: 0,
      fromLastState: false,
    });
    expect(result!.startedAt).toBe("2026-07-30T14:29:46.000Z");
    // The captured text is persisted and surfaced, so secrets must not survive it.
    expect(result!.message).not.toContain("sk-ant-leaked-value");
  });

  it("falls back to lastState so a restarted container still reports its exit", () => {
    const result = readContainerTermination(
      {
        name: "claude",
        restartCount: 2,
        state: { running: { startedAt: new Date("2026-07-30T14:30:00.000Z") } },
        lastState: { terminated: { exitCode: 128, reason: "Error" } },
      } as unknown as V1ContainerStatus,
      "app",
    );

    expect(result).toMatchObject({ exitCode: 128, fromLastState: true, restartCount: 2 });
  });

  it("returns null for a container that never terminated", () => {
    expect(
      readContainerTermination(
        { name: "claude", state: { waiting: { reason: "PodInitializing" } } } as unknown as V1ContainerStatus,
        "app",
      ),
    ).toBeNull();
  });
});

describe("scoreFailedPodCandidate", () => {
  function podWithExit(exitCode: number | null, phase = "Failed") {
    return {
      status: {
        phase,
        containerStatuses: exitCode === null
          ? []
          : [{ name: "claude", state: { terminated: { exitCode } } }],
      },
    } as unknown as V1Pod;
  }

  it("ranks a non-zero exit above a merely Failed pod, and Failed above the rest", () => {
    const nonZeroExit = scoreFailedPodCandidate(podWithExit(128));
    const failedNoExit = scoreFailedPodCandidate(podWithExit(null, "Failed"));
    const running = scoreFailedPodCandidate(podWithExit(null, "Running"));

    expect(nonZeroExit).toBeGreaterThan(failedNoExit);
    expect(failedNoExit).toBeGreaterThan(running);
  });

  it("does not treat a clean exit 0 as the failing pod", () => {
    expect(scoreFailedPodCandidate(podWithExit(0, "Running")))
      .toBe(scoreFailedPodCandidate(podWithExit(null, "Running")));
  });
});

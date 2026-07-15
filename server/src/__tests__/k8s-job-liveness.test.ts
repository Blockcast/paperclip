import type { V1Job, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  classifyAgentJobRunStatus,
  indexUniqueAgentJobRunStatuses,
  isActiveOrTerminatingAgentPod,
  matchExactAgentJob,
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

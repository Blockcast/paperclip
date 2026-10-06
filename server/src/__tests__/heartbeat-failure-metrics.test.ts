import { describe, expect, it } from "vitest";
import { buildHeartbeatRunFailedMetricInput } from "../services/heartbeat.js";

describe("heartbeat failure metric finalization input", () => {
  // BLO-17953 A1f: the builder threads the caller's roster straight through to
  // `recordHeartbeatRunFailed`, which is where `normalizeAgentId` enforces the
  // `agent_id` bound. Assert the pass-through here so a caller that silently
  // stops supplying a roster fails at this seam rather than at the metric.
  const ROSTER: ReadonlySet<string> = new Set(["agent-1"]);

  it("passes the source issue and derived run isolation to the failure metric", () => {
    expect(buildHeartbeatRunFailedMetricInput({
      agent: { id: "agent-1", adapterType: "opencode_k8s" },
      issueId: "issue-1",
      run: {
        errorCode: "k8s_pod_schedule_failed",
        contextSnapshot: { wakeReason: "issue_assigned" },
      },
      k8sRunIsolation: { isolationMode: "run" },
      knownAgentIds: ROSTER,
    })).toEqual({
      agentId: "agent-1",
      issueId: "issue-1",
      adapter: "opencode_k8s",
      errorCode: "k8s_pod_schedule_failed",
      invocationSource: "issue_assigned",
      isolationMode: "run",
      knownAgentIds: ROSTER,
    });
  });

  it("recovers persisted isolation when an external-lifecycle finalizer has no local descriptor", () => {
    expect(buildHeartbeatRunFailedMetricInput({
      agent: { id: "agent-1", adapterType: "claude_k8s" },
      issueId: "issue-1",
      run: {
        errorCode: "oom_killed",
        contextSnapshot: {
          wakeReason: "issue_assigned",
          paperclipK8sIsolation: { isolationMode: "workspace" },
        },
      },
      k8sRunIsolation: null,
      knownAgentIds: ROSTER,
    })).toMatchObject({
      adapter: "claude_k8s",
      errorCode: "oom_killed",
      isolationMode: "workspace",
    });
  });
});

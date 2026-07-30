import { describe, expect, it } from "vitest";
import { buildHeartbeatRunFailedMetricInput } from "../services/heartbeat.js";

describe("heartbeat failure metric finalization input", () => {
  it("passes the source issue and derived run isolation to the failure metric", () => {
    expect(buildHeartbeatRunFailedMetricInput({
      agent: { id: "agent-1", adapterType: "opencode_k8s" },
      issueId: "issue-1",
      run: {
        errorCode: "k8s_pod_schedule_failed",
        contextSnapshot: { wakeReason: "issue_assigned" },
      },
      k8sRunIsolation: { isolationMode: "run" },
    })).toEqual({
      agentId: "agent-1",
      issueId: "issue-1",
      adapter: "opencode_k8s",
      errorCode: "k8s_pod_schedule_failed",
      invocationSource: "issue_assigned",
      isolationMode: "run",
    });
  });
});

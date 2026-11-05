import { describe, expect, it, beforeEach } from "vitest";

import {
  K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC,
  K8S_ISOLATION_CONFLICT_DEFERRAL_ATTEMPT_METRIC,
  __resetMetricsForTest,
  normalizeK8sIsolationConflictCause,
  normalizeK8sIsolationKeyShape,
  recordK8sIsolationConflictDeferral,
  renderMetrics,
} from "./metrics.js";

/**
 * PEN-5684: a rolled-back K8s dispatch cycle had no fleet measurand. The run is
 * pushed back to `queued` with `startedAt: null` and a re-stamped `queuedAt`, so
 * it is invisible in `startedAt` and in every `coalesce(queued_at, created_at)`
 * age gauge. These cases pin the two properties that make the new counter
 * usable: bounded label cardinality, and the key-shape / cause splits that the
 * live census showed are load-bearing.
 */
describe("K8s isolation conflict deferral metrics (PEN-5684)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  describe("normalizeK8sIsolationKeyShape", () => {
    it("keeps the shared project checkout apart from a per-issue tree", () => {
      // The whole point of the split. `resolveWorkspaceWriterTreeKey` emits
      // both shapes under one `workspace-tree:` prefix, and they have different
      // remedies: only the first serializes every seat of a project on one
      // directory.
      expect(
        normalizeK8sIsolationKeyShape("workspace-tree:project-primary:9f258778-c10f-4bb7-a58f-1e4f72ab81f0"),
      ).toBe("workspace-tree:project-primary");
      expect(
        normalizeK8sIsolationKeyShape(
          "workspace-tree:9f258778-c10f-4bb7-a58f-1e4f72ab81f0:bf9a108c-fd59-4057-b81d-e6cba2d1464d",
        ),
      ).toBe("workspace-tree:per-issue");
      // An un-backfilled issue keys on the literal sentinel, not a UUID.
      expect(
        normalizeK8sIsolationKeyShape("workspace-tree:no-project-workspace:bf9a108c-fd59-4057-b81d-e6cba2d1464d"),
      ).toBe("workspace-tree:per-issue");
    });

    it("recognizes every non-tree key shape that can reach a bind", () => {
      expect(normalizeK8sIsolationKeyShape("workspace:769a51e8-0000-4000-8000-000000000000")).toBe("workspace");
      expect(normalizeK8sIsolationKeyShape("agent-shared:11b9c48f-aee6-4ac4-8f4a-5ba60c73fb9c")).toBe("agent-shared");
      expect(normalizeK8sIsolationKeyShape("run:086cf7a9-5f62-4007-850a-67f220942346")).toBe("run");
      expect(normalizeK8sIsolationKeyShape("legacy:086cf7a9-5f62-4007-850a-67f220942346")).toBe("legacy");
      expect(normalizeK8sIsolationKeyShape("pending:086cf7a9-5f62-4007-850a-67f220942346")).toBe("pending");
    });

    it("never lets an unbounded value through as a label", () => {
      // Cardinality guardrail. A key is UUID-bearing by construction, so an
      // unrecognized head must collapse rather than mint a series per run.
      expect(normalizeK8sIsolationKeyShape("some-future-scheme:abc")).toBe("other");
      expect(normalizeK8sIsolationKeyShape("")).toBe("other");
      expect(normalizeK8sIsolationKeyShape("   ")).toBe("other");
      expect(normalizeK8sIsolationKeyShape(null)).toBe("other");
      expect(normalizeK8sIsolationKeyShape(undefined)).toBe("other");
    });
  });

  describe("normalizeK8sIsolationConflictCause", () => {
    it("passes the three real causes and collapses anything else", () => {
      expect(normalizeK8sIsolationConflictCause("active_writer")).toBe("active_writer");
      expect(normalizeK8sIsolationConflictCause("elder_waiter")).toBe("elder_waiter");
      expect(normalizeK8sIsolationConflictCause("legacy_writer")).toBe("legacy_writer");
      expect(normalizeK8sIsolationConflictCause("typo_writer")).toBe("other");
      expect(normalizeK8sIsolationConflictCause(null)).toBe("other");
    });
  });

  describe("recordK8sIsolationConflictDeferral", () => {
    it("counts one rolled-back cycle per call, split by shape and cause", async () => {
      recordK8sIsolationConflictDeferral({
        isolationKey: "workspace-tree:project-primary:9f258778-c10f-4bb7-a58f-1e4f72ab81f0",
        cause: "active_writer",
        retryAttempt: 1,
      });
      recordK8sIsolationConflictDeferral({
        isolationKey: "workspace-tree:project-primary:9f258778-c10f-4bb7-a58f-1e4f72ab81f0",
        cause: "elder_waiter",
        retryAttempt: 16,
      });
      // The 44% of the census that a project_primary-only reading would miss.
      recordK8sIsolationConflictDeferral({
        isolationKey: "workspace:769a51e8-0000-4000-8000-000000000000",
        cause: "active_writer",
        retryAttempt: 4,
      });

      const body = (await renderMetrics()).body;
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC}{key_shape="workspace-tree:project-primary",cause="active_writer"} 1`,
      );
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC}{key_shape="workspace-tree:project-primary",cause="elder_waiter"} 1`,
      );
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRALS_METRIC}{key_shape="workspace",cause="active_writer"} 1`,
      );
    });

    it("returns the normalized labels so the log line cannot drift from the graph", () => {
      const labels = recordK8sIsolationConflictDeferral({
        isolationKey: "workspace-tree:project-primary:9f258778-c10f-4bb7-a58f-1e4f72ab81f0",
        cause: "nonsense",
        retryAttempt: 2,
      });
      expect(labels).toEqual({ keyShape: "workspace-tree:project-primary", cause: "other" });
    });

    it("observes the attempt depth so a saturated ladder is distinguishable from fresh conflicts", async () => {
      // 40 runs deferred once and one run deferred 40 times produce the same
      // counter rate; only the histogram separates them. The backoff saturates
      // at 300 s by attempt 6, so everything past that bucket is a run
      // re-stamping `queuedAt` every 5 minutes indefinitely.
      recordK8sIsolationConflictDeferral({ isolationKey: "workspace:a", cause: "active_writer", retryAttempt: 1 });
      recordK8sIsolationConflictDeferral({ isolationKey: "workspace:a", cause: "active_writer", retryAttempt: 48 });

      const body = (await renderMetrics()).body;
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_bucket{le="1",key_shape="workspace"} 1`,
      );
      // The measured 2026-11-02 tail must land inside a finite bucket, not +Inf.
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_bucket{le="34",key_shape="workspace"} 1`,
      );
      expect(body).toContain(
        `${K8S_ISOLATION_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_bucket{le="55",key_shape="workspace"} 2`,
      );
      expect(body).toContain(`${K8S_ISOLATION_CONFLICT_DEFERRAL_ATTEMPT_METRIC}_count{key_shape="workspace"} 2`);
    });

    it("floors a malformed attempt rather than poisoning the histogram", () => {
      expect(() =>
        recordK8sIsolationConflictDeferral({
          isolationKey: "workspace:a",
          cause: "active_writer",
          retryAttempt: Number.NaN,
        }),
      ).not.toThrow();
      expect(() =>
        recordK8sIsolationConflictDeferral({
          isolationKey: "workspace:a",
          cause: "active_writer",
          retryAttempt: -5,
        }),
      ).not.toThrow();
    });
  });
});

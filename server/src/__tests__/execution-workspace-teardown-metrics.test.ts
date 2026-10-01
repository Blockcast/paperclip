import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupExecutionWorkspaceArtifacts } from "../services/workspace-runtime.js";
import {
  EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES,
  EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC,
  EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC,
  EXECUTION_WORKSPACE_TEARDOWN_METHODS,
  EXECUTION_WORKSPACE_TEARDOWN_METRIC,
  EXECUTION_WORKSPACE_TEARDOWN_TRIGGERS,
  __resetMetricsForTest,
  recordExecutionWorkspaceCollectorPass,
  recordExecutionWorkspaceTeardown,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-3692 instrumentation.
 *
 * The row attributed the worker cgroup's reclaimable-slab fill to FAILED runs
 * across two regimes either side of a single boundary — magnitude-only
 * discrimination on an uncontrolled natural experiment. These series exist to
 * replace that with a continuous measurement, so the assertions below are about
 * the two properties the measurement actually depends on: that teardown work is
 * attributable to the caller that caused it, and that an idle collector is
 * distinguishable from a dead one.
 */

afterEach(() => {
  __resetMetricsForTest();
});

describe("execution-workspace teardown metrics", () => {
  it("separates the collector's teardown work from the per-failure run teardown", async () => {
    // The question PEN-3692 could not answer: both callers reach the same
    // removal function, so without this label their work is one undivided sum.
    recordExecutionWorkspaceTeardown({
      trigger: "run_teardown",
      method: "worktree_remove",
      succeeded: true,
      durationMs: 1500,
    });
    recordExecutionWorkspaceTeardown({
      trigger: "collector",
      method: "worktree_remove",
      succeeded: true,
      durationMs: 400,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="run_teardown",method="worktree_remove",outcome="succeeded"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="collector",method="worktree_remove",outcome="succeeded"} 1`,
    );
    // The work integral, split by caller — this is the quantity the slab
    // residual gets regressed against.
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="run_teardown",method="worktree_remove"} 1.5`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="worktree_remove"} 0.4`,
    );
  });

  it("counts a failed removal and still charges the work it did before failing", async () => {
    // A worktree removal that throws is caught and demoted to a warning, so the
    // tree is still on disk — but the walk it performed was still paid for by
    // the cgroup. Excluding it would bias the integral down exactly when
    // reclamation is going wrong.
    recordExecutionWorkspaceTeardown({
      trigger: "collector",
      method: "remove_local_fs",
      succeeded: false,
      durationMs: 2000,
    });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="collector",method="remove_local_fs",outcome="failed"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="remove_local_fs"} 2`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_count{trigger="collector",method="remove_local_fs"} 1`,
    );
  });

  it("keeps 'no teardown of this shape yet' distinguishable from 'teardown was free'", async () => {
    recordExecutionWorkspaceTeardown({
      trigger: "operator",
      method: "worktree_remove",
      succeeded: true,
      durationMs: 10,
    });

    const { body } = await renderMetrics();
    // Deliberately not pre-seeded: an absent series means this process has torn
    // down nothing of that shape. Pre-seeding zeros would make a worker that
    // never collects look identical to one that collects instantly.
    expect(body).not.toContain(`${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="collector"`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="operator"`);
  });

  it("bounds every label to its allowlist, so no call site can widen cardinality", () => {
    // Worst case is triggers x methods x outcomes = 4 x 2 x 2 = 16 series on the
    // counter. Bounded by these constants, never by a caller-supplied string.
    expect(EXECUTION_WORKSPACE_TEARDOWN_TRIGGERS).toEqual([
      "run_teardown",
      "collector",
      "operator",
      "unknown",
    ]);
    expect(EXECUTION_WORKSPACE_TEARDOWN_METHODS).toEqual(["worktree_remove", "remove_local_fs"]);
  });
});

describe("cleanupExecutionWorkspaceArtifacts wiring", () => {
  async function makeDisposableWorkspace() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pen3692-"));
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "nested", "file.txt"), "x");
    return dir;
  }

  function localFsWorkspace(cwd: string) {
    return {
      id: "ws-pen3692",
      cwd,
      providerType: "local_fs",
      providerRef: null,
      branchName: null,
      repoUrl: null,
      baseRef: null,
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: null,
      // The local_fs removal branch is gated on this flag.
      metadata: { createdByRuntime: true },
    };
  }

  it("charges a real removal to the trigger the caller declared", async () => {
    // Driven through the real function against a real directory rather than
    // asserting on the recorder: a recorder-only test proves the metric can be
    // written, not that the removal path reaches it with the right label.
    const dir = await makeDisposableWorkspace();
    const result = await cleanupExecutionWorkspaceArtifacts({
      trigger: "run_teardown",
      workspace: localFsWorkspace(dir),
    });

    expect(result.cleaned).toBe(true);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="run_teardown",method="remove_local_fs",outcome="succeeded"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_count{trigger="run_teardown",method="remove_local_fs"} 1`,
    );
  });

  it("falls back to trigger=unknown when a call site does not classify itself", async () => {
    // This is the signal that the split has stopped partitioning the work: a
    // new call site added without a trigger shows up here rather than silently
    // joining somebody else's bucket.
    const dir = await makeDisposableWorkspace();
    await cleanupExecutionWorkspaceArtifacts({ workspace: localFsWorkspace(dir) });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="unknown",method="remove_local_fs",outcome="succeeded"} 1`,
    );
  });
});

describe("execution-workspace collector pass metrics", () => {
  it("records a pass census and materializes every outcome child", async () => {
    recordExecutionWorkspaceCollectorPass(
      { stamped: 3, scanned: 7, collected: 4, skipped: 2, failed: 1 },
      () => 1_760_000_000_000,
    );

    const { body } = await renderMetrics();
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 7`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC} 3`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC} 1`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC}{outcome="collected"} 4`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC}{outcome="skipped"} 2`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC}{outcome="failed"} 1`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} 1760000000`);
  });

  it("emits a zero 'failed' child on a clean pass rather than no data", async () => {
    // A dashboard must be able to read "0 failed collections", which is a
    // different statement from "this metric has never reported".
    recordExecutionWorkspaceCollectorPass(
      { stamped: 0, scanned: 2, collected: 2, skipped: 0, failed: 0 },
      () => 1_760_000_000_000,
    );

    const { body } = await renderMetrics();
    for (const outcome of EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES) {
      expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC}{outcome="${outcome}"}`);
    }
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC}{outcome="failed"} 0`);
  });

  it("advances the liveness gauge while an idle pass leaves every counter at zero", async () => {
    // The failure this gauge exists for: a collector that has stopped ticking
    // and one that is ticking over an empty registry both add zero to every
    // counter above. Only the timestamp separates them.
    recordExecutionWorkspaceCollectorPass(
      { stamped: 0, scanned: 0, collected: 0, skipped: 0, failed: 0 },
      () => 1_760_000_000_000,
    );
    const first = await renderMetrics();
    expect(first.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 0`);
    expect(first.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} 1760000000`);

    recordExecutionWorkspaceCollectorPass(
      { stamped: 0, scanned: 0, collected: 0, skipped: 0, failed: 0 },
      () => 1_760_000_600_000,
    );
    const second = await renderMetrics();
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 0`);
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC} 2`);
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} 1760000600`);
  });
});

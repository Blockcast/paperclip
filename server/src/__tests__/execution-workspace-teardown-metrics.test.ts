import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanupExecutionWorkspaceArtifacts,
  inspectWorktreeReclaimSafety,
  RECLAIM_FS_OUTSTANDING_LIMIT,
} from "../services/workspace-runtime.js";
import { executionWorkspaceCleanupService } from "../services/execution-workspace-cleanup.js";
import {
  EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES,
  EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC,
  EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC,
  EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC,
  EXECUTION_WORKSPACE_CLEANUP_REASONS,
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

// Lets one test hold the collector's entry gate shut without parking real
// threadpool threads; `null` defers to the real count.
const reclaimFs = vi.hoisted(() => ({ outstanding: null as number | null }));
vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    reclaimFsOutstandingCount: () => reclaimFs.outstanding ?? actual.reclaimFsOutstandingCount(),
  };
});

afterEach(() => {
  reclaimFs.outstanding = null;
  __resetMetricsForTest();
});

describe("execution-workspace teardown metrics", () => {
  it("separates the collector's teardown work from the per-failure run teardown", async () => {
    // The question PEN-3692 could not answer: both callers reach the same
    // removal function, so without this label their work is one undivided sum.
    recordExecutionWorkspaceTeardown({
      trigger: "persist_rollback",
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
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="persist_rollback",method="worktree_remove",cleanup_reason="not_applicable",outcome="succeeded"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="collector",method="worktree_remove",cleanup_reason="not_applicable",outcome="succeeded"} 1`,
    );
    // The removal term of the work integral, split by caller.
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="persist_rollback",method="worktree_remove",cleanup_reason="not_applicable"} 1.5`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="worktree_remove",cleanup_reason="not_applicable"} 0.4`,
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
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="collector",method="remove_local_fs",cleanup_reason="not_applicable",outcome="failed"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="remove_local_fs",cleanup_reason="not_applicable"} 2`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_count{trigger="collector",method="remove_local_fs",cleanup_reason="not_applicable"} 1`,
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
    // Worst case on the counter is triggers x removal-methods x cleanup_reasons
    // x outcomes = 4 x 2 x 4 x 2 = 64; the histogram adds `inspect_safety` and
    // drops outcome, so 4 x 3 x 4 = 48. Both are worst cases, not expected
    // counts: cleanup_reason only varies under trigger="collector", and every
    // other caller pins it to `not_applicable`. Bounded by these constants,
    // never by a caller-supplied string — in particular `cleanup_reason` is
    // mapped from the DB column through a closed branch rather than passed
    // through, so adding a new `cleanupReason` value in the schema cannot
    // widen this.
    expect(EXECUTION_WORKSPACE_TEARDOWN_TRIGGERS).toEqual([
      "persist_rollback",
      "collector",
      "operator",
      "unknown",
    ]);
    expect(EXECUTION_WORKSPACE_TEARDOWN_METHODS).toEqual([
      "worktree_remove",
      "remove_local_fs",
      "inspect_safety",
    ]);
    expect(EXECUTION_WORKSPACE_CLEANUP_REASONS).toEqual([
      "run_ended",
      "idle_backfill",
      "unknown",
      "not_applicable",
    ]);
  });

  it("keeps run-attributable teardown separable from idle reclamation", () => {
    // The defect Ally found on d729b09: `trigger` cannot answer PEN-3692's
    // question, because run end performs NO inline teardown — it stamps
    // cleanupReason="run_ended" and defers to the collector. So both
    // run-attributable and idle work arrive as trigger="collector" and are
    // distinguishable only here. Reading a flat `persist_rollback` (the old
    // `run_teardown`) against a large `collector` and concluding "per-failure
    // teardown is negligible" is attribution by magnitude against an
    // uninstrumented alternative — the PEN-3692 error in a new costume.
    __resetMetricsForTest();
    recordExecutionWorkspaceTeardown({
      trigger: "collector",
      method: "worktree_remove",
      succeeded: true,
      durationMs: 3000,
      cleanupReason: "run_ended",
    });
    recordExecutionWorkspaceTeardown({
      trigger: "collector",
      method: "worktree_remove",
      succeeded: true,
      durationMs: 1000,
      cleanupReason: "idle_backfill",
    });

    return renderMetrics().then(({ body }) => {
      // Same trigger, same method — separated only by cleanup_reason.
      expect(body).toContain(
        `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="worktree_remove",cleanup_reason="run_ended"} 3`,
      );
      expect(body).toContain(
        `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_sum{trigger="collector",method="worktree_remove",cleanup_reason="idle_backfill"} 1`,
      );
    });
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
      trigger: "persist_rollback",
      workspace: localFsWorkspace(dir),
    });

    expect(result.cleaned).toBe(true);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="persist_rollback",method="remove_local_fs",cleanup_reason="not_applicable",outcome="succeeded"} 1`,
    );
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_count{trigger="persist_rollback",method="remove_local_fs",cleanup_reason="not_applicable"} 1`,
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
      `${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{trigger="unknown",method="remove_local_fs",cleanup_reason="not_applicable",outcome="succeeded"} 1`,
    );
  });
});

describe("reclaim-safety inspection is in the work integral", () => {
  // Ally's Important #2 on this PR: the duration histogram's _sum was called
  // "the work integral to regress the cgroup's reclaimable-slab residual
  // against", but the measured region excluded `inspectWorktreeReclaimSafety`'s
  // `git status --porcelain` tree walk — which the collector runs up to twice
  // per candidate and which the PR itself called the largest term. PEN-3692
  // §3(b) makes that integral the row's closing criterion, so an integral
  // missing its dominant term would reproduce the mis-attribution the row
  // exists to replace. These two assertions are the contract that fix created.

  it("observes the safety walk into the duration histogram under its own method", async () => {
    // Driven through the real exported function, matching this file's rule that
    // a recorder-only test proves the metric can be written, not that the real
    // path reaches it.
    const absent = path.join(os.tmpdir(), `pen3692-absent-${Date.now()}`);
    await inspectWorktreeReclaimSafety(absent, { trigger: "collector" });

    const { body } = await renderMetrics();
    expect(body).toContain(
      `${EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC}_count{trigger="collector",method="inspect_safety",cleanup_reason="not_applicable"} 1`,
    );
  });

  it("does NOT count an inspection as a removal", async () => {
    // The reason the fix is histogram-only. `teardown_total` means "removals
    // attempted"; booking a tree walk there would corrupt the removal rate and
    // make a wedged mount — which inspects repeatedly and removes nothing —
    // read as a burst of teardown activity.
    const absent = path.join(os.tmpdir(), `pen3692-absent-${Date.now()}`);
    await inspectWorktreeReclaimSafety(absent, { trigger: "collector" });

    const { body } = await renderMetrics();
    expect(body).not.toContain(`method="inspect_safety",outcome=`);
    for (const line of body.split("\n")) {
      if (line.startsWith(`${EXECUTION_WORKSPACE_TEARDOWN_METRIC}{`)) {
        expect(line).not.toContain("inspect_safety");
      }
    }
  });
});

describe("execution-workspace collector pass metrics", () => {
  it("records a pass census and materializes every outcome child", async () => {
    recordExecutionWorkspaceCollectorPass(
      { stamped: 3, scanned: 7, collected: 4, skipped: 2, failed: 1 },
      { stopReason: "complete", now: () => 1_760_000_000_000 },
    );

    const { body } = await renderMetrics();
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 7`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC} 3`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC}{stop_reason="complete"} 1`);
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
      { stopReason: "complete", now: () => 1_760_000_000_000 },
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
      { stopReason: "complete", now: () => 1_760_000_000_000 },
    );
    const first = await renderMetrics();
    expect(first.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 0`);
    expect(first.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} 1760000000`);

    recordExecutionWorkspaceCollectorPass(
      { stamped: 0, scanned: 0, collected: 0, skipped: 0, failed: 0 },
      { stopReason: "complete", now: () => 1_760_000_600_000 },
    );
    const second = await renderMetrics();
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC} 0`);
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC}{stop_reason="complete"} 2`);
    expect(second.body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} 1760000600`);
  });

  it("records a pass the threadpool gate skipped instead of going silent", async () => {
    // The entry gate is the wedged-mount regime this census exists to explain.
    // Driven through the real collector: the gate returns before any query, so
    // no database is needed, and an unrecorded skip leaves no passes series.
    reclaimFs.outstanding = RECLAIM_FS_OUTSTANDING_LIMIT;
    const result = await executionWorkspaceCleanupService({} as never).reconcileExecutionWorkspaceCleanup();
    expect(result.scanned).toBe(0);

    const { body } = await renderMetrics();
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC}{stop_reason="skipped_saturated"} 1`);
    expect(body).toContain(`${EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC}{stop_reason="complete"} 0`);
    expect(body).toMatch(new RegExp(`^${EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC} [1-9]\\d*$`, "m"));
  });
});

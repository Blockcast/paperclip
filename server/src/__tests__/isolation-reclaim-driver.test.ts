import { describe, expect, it } from "vitest";

import { RECLAIM_PLAN_ENV } from "../services/isolation-reclaim-report.js";
import type { IsolationReclaimReport } from "../services/isolation-reclaim-report.js";
import { RECLAIM_JOB_CONTAINER_NAME } from "../services/isolation-reclaim-job.js";
import type { IsolationReclaimJobManifest } from "../services/isolation-reclaim-job.js";
import { driveIsolationReclaim } from "../services/isolation-reclaim-driver.js";
import type {
  DriveIsolationReclaimOptions,
  ReclaimClaimTemplate,
} from "../services/isolation-reclaim-driver.js";
import type { ReclaimJobPort, ReclaimRunOutcome } from "../services/isolation-reclaim-runner.js";
import {
  DEFAULT_RECLAIM_STARTUP_GRACE_MS,
  reclaimWaitBudgetMs,
} from "../services/isolation-reclaim-runner.js";
import {
  DEFAULT_MAX_DELETES_PER_TICK,
  DEFAULT_MAX_PLAN_AGE_MS,
} from "../services/isolation-workspace-reaper.js";
import type {
  IsolationReclaimExecutionResult,
  ReclaimableClaim,
  WorkspaceUsageLookup,
} from "../services/isolation-workspace-reaper.js";

const CLAIM: ReclaimableClaim = {
  claimName: "agent-workspace-29033747-e513-46d5-8a13-dcb5dac10017",
  source: "agent_per_agent_volume",
  agentId: "29033747-e513-46d5-8a13-dcb5dac10017",
};

const TEMPLATE: ReclaimClaimTemplate = {
  namespace: "paperclip",
  image: "harbor.blockcast.net/paperclip/paperclip@sha256:abc",
};

/** Workspace ids as the inventory reports them. */
const IDLE_A = "11111111-1111-4111-8111-111111111111";
const IDLE_B = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";

const NOW = 1_762_000_000_000;
const DAY = 86_400_000;

/** Nothing in `execution_workspaces`: every id falls to the mtime arm. */
const noRows: WorkspaceUsageLookup = async () => new Map();

const unusedPort: ReclaimJobPort = {
  createJob: async () => {
    throw new Error("port should not be reached");
  },
  readJob: async () => {
    throw new Error("port should not be reached");
  },
  listJobPods: async () => {
    throw new Error("port should not be reached");
  },
  readPodLog: async () => {
    throw new Error("port should not be reached");
  },
};

function inventoryReport(names: string[], mtimeMs: number): IsolationReclaimReport {
  return {
    v: 1,
    kind: "inventory",
    ok: true,
    inventory: names.map((name) => ({ name, mtimeMs })),
  };
}

function executionResult(
  overrides: Partial<IsolationReclaimExecutionResult> = {},
): IsolationReclaimExecutionResult {
  return {
    requested: 2,
    deleted: 2,
    wouldDelete: 0,
    skippedUnsafeName: 0,
    skippedLayout: 0,
    retainedNestedCheckout: 0,
    vanished: 0,
    failed: 0,
    notAttempted: 0,
    capped: false,
    stopReason: "complete",
    ...overrides,
  };
}

function ranOk(
  manifest: IsolationReclaimJobManifest,
  report: IsolationReclaimReport,
  adopted = false,
): ReclaimRunOutcome {
  return {
    ok: true,
    report,
    jobName: manifest.jobName,
    namespace: manifest.namespace,
    mode: report.kind,
    claimName: CLAIM.claimName,
    podName: `${manifest.jobName}-pod`,
    adopted,
  };
}

interface Recorded {
  manifest: IsolationReclaimJobManifest;
  mode: "inventory" | "execute";
}

/**
 * A `runJob` seam that answers each phase from a script and records the
 * manifests it was handed.
 *
 * The recorded manifests are the artefact every assertion about the plan is
 * made against — the drive's own return value restates its inputs, so asserting
 * only on that would let a drive that built the Job from the wrong numbers pass.
 */
function scriptedRun(script: {
  inventory: (m: IsolationReclaimJobManifest) => ReclaimRunOutcome | Promise<ReclaimRunOutcome>;
  execute?: (m: IsolationReclaimJobManifest) => ReclaimRunOutcome | Promise<ReclaimRunOutcome>;
}): { runJob: DriveIsolationReclaimOptions["runJob"]; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runJob: DriveIsolationReclaimOptions["runJob"] = async ({ manifest }) => {
    const mode = manifest.jobName.startsWith("pc-reclaim-inv") ? "inventory" : "execute";
    calls.push({ manifest, mode });
    if (mode === "inventory") return script.inventory(manifest);
    if (!script.execute) throw new Error("execute phase was not expected");
    return script.execute(manifest);
  };
  return { runJob, calls };
}

function planEnvOf(manifest: IsolationReclaimJobManifest): {
  planBuiltAtMs: number;
  eligibleIds: string[];
  maxDeletes?: number;
  maxPlanAgeMs?: number;
  dryRun?: boolean;
} {
  const container = manifest.job.spec?.template.spec?.containers.find(
    (c) => c.name === RECLAIM_JOB_CONTAINER_NAME,
  );
  const raw = container?.env?.find((e) => e.name === RECLAIM_PLAN_ENV)?.value;
  if (!raw) throw new Error("execute manifest carries no plan environment");
  return JSON.parse(raw) as ReturnType<typeof planEnvOf>;
}

function drive(
  overrides: Partial<DriveIsolationReclaimOptions> & {
    runJob: DriveIsolationReclaimOptions["runJob"];
  },
): ReturnType<typeof driveIsolationReclaim> {
  return driveIsolationReclaim({
    claim: CLAIM,
    template: TEMPLATE,
    port: unusedPort,
    lookupWorkspaceUsage: noRows,
    maxAgeDays: 7,
    invocationId: "20261101t0300z-a1b2c3",
    now: () => NOW,
    ...overrides,
  });
}

describe("driveIsolationReclaim", () => {
  it("drives inventory -> plan -> execute and reports the executor's result", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A, IDLE_B], NOW - 30 * DAY)),
      execute: (m) =>
        ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult({ deleted: 2 }) }),
    });

    const outcome = await drive({ runJob });

    expect(outcome.ok).toBe(true);
    expect(outcome.phase).toBe("execute");
    expect(outcome.result?.deleted).toBe(2);
    expect(outcome.plan?.eligibleIds).toEqual([IDLE_A, IDLE_B]);
    expect(outcome.deletionOutcomeUnknown).toBe(false);
    expect(calls.map((c) => c.mode)).toEqual(["inventory", "execute"]);
    // Asserted on the Job, not on the returned plan: the manifest is what the
    // pod will actually be given.
    expect(planEnvOf(calls[1]!.manifest).eligibleIds).toEqual([IDLE_A, IDLE_B]);
  });

  it("retains a fresh directory, so the plan is the planner's and not the inventory's", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => {
        const report = inventoryReport([IDLE_A], NOW - 30 * DAY);
        if (report.kind !== "inventory" || !report.ok) throw new Error("unreachable");
        report.inventory.push({ name: FRESH, mtimeMs: NOW - 60_000 });
        return ranOk(m, report);
      },
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    const outcome = await drive({ runJob });

    expect(outcome.plan?.retainedFresh).toBe(1);
    expect(planEnvOf(calls[1]!.manifest).eligibleIds).toEqual([IDLE_A]);
  });

  it("launches no execute Job when nothing is eligible", async () => {
    const { runJob, calls } = scriptedRun({
      // Everything materialized a minute ago: fresh, so nothing is eligible.
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A, IDLE_B], NOW - 60_000)),
    });

    const outcome = await drive({ runJob });

    expect(outcome.ok).toBe(true);
    expect(outcome.nothingEligible).toBe(true);
    expect(outcome.phase).toBe("plan");
    expect(outcome.result).toBeNull();
    expect(outcome.executeJobName).toBeNull();
    expect(calls.map((c) => c.mode)).toEqual(["inventory"]);
  });

  it("refuses an inventory report that was recovered but says ok:false", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) =>
        ranOk(m, { v: 1, kind: "inventory", ok: false, error: "root /reclaim/... is not there" }),
    });

    const outcome = await drive({ runJob });

    // The run succeeded in RECOVERING a report. The drive must not read that as
    // the phase having worked: there is no `inventory` array on this payload.
    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe("inventory_refused");
    expect(outcome.detail).toContain("is not there");
    expect(outcome.plan).toBeNull();
    expect(calls.map((c) => c.mode)).toEqual(["inventory"]);
  });

  it("refuses an execute report that was recovered but says ok:false", async () => {
    const { runJob } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: false, error: "plan env unreadable" }),
    });

    const outcome = await drive({ runJob });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe("execute_refused");
    expect(outcome.result).toBeNull();
    // Still an unknown. Every cause that reaches this branch today is pre-loop,
    // but the executor CLI wraps the whole `executeIsolationReclaimPlan` call in
    // one `catch`, so a throw raised INSIDE the loop — after some `fs.rm` calls
    // — would arrive here as the same `ok: false` payload. Narrowing would rest
    // on an invariant of a module this one does not own, and it is the only
    // branch here that would. (Ally, review of #3198.)
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("carries the unknown on EVERY execute-phase failure, with no narrowable branch", async () => {
    // The rule stated without an exception, asserted over every way the execute
    // phase can fail: a reported refusal, a run failure, and a port throw.
    const kinds: Array<[string, DriveIsolationReclaimOptions["runJob"]]> = [
      [
        "execute_refused",
        scriptedRun({
          inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
          execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: false, error: "refused" }),
        }).runJob,
      ],
      [
        "execute_run_failed (reported)",
        scriptedRun({
          inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
          execute: (m) => ({
            ok: false,
            kind: "job_failed",
            detail: "no report",
            jobName: m.jobName,
            namespace: m.namespace,
            mode: "execute",
            claimName: CLAIM.claimName,
            podName: null,
            adopted: false,
            deletionOutcomeUnknown: true,
          }),
        }).runJob,
      ],
      [
        "execute_run_failed (thrown)",
        scriptedRun({
          inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
          execute: () => {
            throw new Error("boom");
          },
        }).runJob,
      ],
      [
        // The branch the title would otherwise overclaim: a report the runner
        // recovered whose `kind` is not `execute`. The driver forces the flag
        // here -- the runner's outcome says `ok`, so there is nothing to
        // propagate. (Ally, review of #3198.)
        "execute kind mismatch",
        scriptedRun({
          inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
          execute: (m) => ({
            ...ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
            report: {
              v: 1,
              kind: "inventory",
              ok: true,
              inventory: [],
            } as IsolationReclaimReport,
          }),
        }).runJob,
      ],
    ];

    for (const [label, runJob] of kinds) {
      const outcome = await drive({ runJob });
      expect(outcome.ok, label).toBe(false);
      expect(outcome.deletionOutcomeUnknown, label).toBe(true);
      expect(outcome.phase, label).toBe("execute");
    }
  });

  it("propagates deletionOutcomeUnknown from a failed execute run", async () => {
    const { runJob } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ({
        ok: false,
        kind: "deadline_exceeded",
        detail: "activeDeadlineSeconds elapsed",
        jobName: m.jobName,
        namespace: m.namespace,
        mode: "execute",
        claimName: CLAIM.claimName,
        podName: null,
        adopted: false,
        deletionOutcomeUnknown: true,
      }),
    });

    const outcome = await drive({ runJob });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe("execute_run_failed");
    expect(outcome.detail).toContain("deadline_exceeded");
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("reports an unknown when the port throws during execute, and a known zero during inventory", async () => {
    const thrownDuringExecute = await drive({
      runJob: scriptedRun({
        inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
        execute: () => {
          throw new Error("etcdserver: request timed out");
        },
      }).runJob,
    });
    expect(thrownDuringExecute.failureKind).toBe("execute_run_failed");
    expect(thrownDuringExecute.deletionOutcomeUnknown).toBe(true);

    const thrownDuringInventory = await drive({
      runJob: scriptedRun({
        inventory: () => {
          throw new Error("etcdserver: request timed out");
        },
      }).runJob,
    });
    expect(thrownDuringInventory.failureKind).toBe("inventory_run_failed");
    // An inventory Job unlinks nothing, whichever port call raised.
    expect(thrownDuringInventory.deletionOutcomeUnknown).toBe(false);
  });

  it("does NOT narrow the unknown under dryRun, because the Job may have been adopted", async () => {
    const { runJob } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ({
        ok: false,
        kind: "wait_timeout",
        detail: "still active",
        jobName: m.jobName,
        namespace: m.namespace,
        mode: "execute",
        claimName: CLAIM.claimName,
        podName: null,
        adopted: true,
        deletionOutcomeUnknown: true,
      }),
    });

    const outcome = await drive({ runJob, dryRun: true });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.adoptedExecute).toBe(true);
    expect(outcome.deletionOutcomeUnknown).toBe(true);
  });

  it("passes dryRun into the plan the pod receives", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) =>
        ranOk(m, {
          v: 1,
          kind: "execute",
          ok: true,
          result: executionResult({ deleted: 0, wouldDelete: 1, requested: 1 }),
        }),
    });

    await drive({ runJob, dryRun: true });

    expect(planEnvOf(calls[1]!.manifest).dryRun).toBe(true);
  });

  it("gives the planner and the executor the SAME bound", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A, IDLE_B], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    // A literal, deliberately not derived from DEFAULT_MAX_DELETES_PER_TICK:
    // a test whose input comes from the value under test cannot constrain it.
    const outcome = await drive({ runJob, maxDeletes: 1 });

    // The planner truncated to 1...
    expect(outcome.plan?.eligibleIds).toHaveLength(1);
    expect(outcome.plan?.truncated).toBe(true);
    // ...and the executor was given the same 1, not its own default.
    expect(planEnvOf(calls[1]!.manifest).maxDeletes).toBe(1);
  });

  it("defaults both halves to the per-tick constant when no bound is given", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    await drive({ runJob });

    expect(planEnvOf(calls[1]!.manifest).maxDeletes).toBe(DEFAULT_MAX_DELETES_PER_TICK);
  });

  it("stamps planBuiltAtMs no later than the planner's own database read", async () => {
    // A clock that advances on every read, so "before" and "after" the planner
    // are distinguishable values rather than the same number.
    let tick = NOW;
    const clock = (): number => {
      tick += 1_000;
      return tick;
    };
    const observed: number[] = [];
    const lookup: WorkspaceUsageLookup = async () => {
      observed.push(tick);
      return new Map();
    };

    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    await drive({ runJob, now: clock, lookupWorkspaceUsage: lookup });

    const stamped = planEnvOf(calls[1]!.manifest).planBuiltAtMs;
    expect(observed).toHaveLength(1);
    // Stamping AFTER the read would describe the snapshot as newer than it is,
    // which is the fail-open direction: the plan outlives the evidence.
    expect(stamped).toBeLessThanOrEqual(observed[0]!);
  });

  // --- the plan must outlive the wait -------------------------------------
  //
  // The executor re-checks the plan's age per entry against a control-plane
  // stamp, and its own default is 10 minutes. This driver waits startup grace
  // (10 min) + activeDeadlineSeconds (15 min) = 25 min. Left to the default,
  // an execute Job is handed a plan that expires well inside the wait, and the
  // whole tick comes back `notAttempted`/`plan_stale` while REPORTING SUCCESS.

  it("gives the execute Job a plan lifetime covering the wait it is willing to grant", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    await drive({ runJob });

    const executeManifest = calls[1]!.manifest;
    const budget = reclaimWaitBudgetMs(executeManifest, DEFAULT_RECLAIM_STARTUP_GRACE_MS);
    // Derived from the manifest actually emitted, not restated: a template that
    // overrides activeDeadlineSeconds must move both together.
    expect(planEnvOf(executeManifest).maxPlanAgeMs).toBe(budget);
    // The point of the fix: strictly longer than what the executor would have
    // defaulted to on its own.
    expect(budget).toBeGreaterThan(DEFAULT_MAX_PLAN_AGE_MS);
  });

  it("derives that lifetime from the actual startup grace, not from a constant", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    const startupGraceMs = DEFAULT_RECLAIM_STARTUP_GRACE_MS + 5 * 60_000;
    await drive({ runJob, startupGraceMs });

    const executeManifest = calls[1]!.manifest;
    expect(planEnvOf(executeManifest).maxPlanAgeMs).toBe(
      reclaimWaitBudgetMs(executeManifest, startupGraceMs),
    );
    // A driver willing to wait longer must hand over a plan that lives longer;
    // pinning the delta proves the grace is read rather than ignored.
    expect(planEnvOf(executeManifest).maxPlanAgeMs).toBe(
      reclaimWaitBudgetMs(executeManifest, DEFAULT_RECLAIM_STARTUP_GRACE_MS) + 5 * 60_000,
    );
  });

  it("lets an explicit caller value win over the derived one", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    const maxPlanAgeMs = 90 * 60_000;
    await drive({ runJob, maxPlanAgeMs });

    const executeManifest = calls[1]!.manifest;
    expect(planEnvOf(executeManifest).maxPlanAgeMs).toBe(maxPlanAgeMs);
    // Guards the override against being silently replaced by the derivation.
    expect(maxPlanAgeMs).not.toBe(
      reclaimWaitBudgetMs(executeManifest, DEFAULT_RECLAIM_STARTUP_GRACE_MS),
    );
  });

  it("gives the two phases distinct Job names under one invocation id", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
      execute: (m) => ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }),
    });

    const outcome = await drive({ runJob });

    expect(outcome.inventoryJobName).not.toEqual(outcome.executeJobName);
    expect(calls[0]!.manifest.jobName).toBe(outcome.inventoryJobName);
    expect(calls[1]!.manifest.jobName).toBe(outcome.executeJobName);
  });

  it("refuses an invocation id that cannot produce a Job name, before any Job exists", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
    });

    const outcome = await drive({ runJob, invocationId: "!!!" });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe("inventory_manifest_refused");
    expect(outcome.deletionOutcomeUnknown).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("carries the claim's attribution onto the outcome", async () => {
    const environmentClaim: ReclaimableClaim = {
      claimName: "operator-shared-workspaces",
      source: "environment_claim",
      agentId: null,
    };
    const { runJob } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([], NOW - 30 * DAY)),
    });

    const outcome = await drive({ runJob, claim: environmentClaim });

    expect(outcome.claimName).toBe("operator-shared-workspaces");
    expect(outcome.source).toBe("environment_claim");
    expect(outcome.agentId).toBeNull();
  });

  it("reports adoption on each phase separately", async () => {
    const { runJob } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY), true),
      execute: (m) =>
        ranOk(m, { v: 1, kind: "execute", ok: true, result: executionResult() }, false),
    });

    const outcome = await drive({ runJob });

    expect(outcome.adoptedInventory).toBe(true);
    expect(outcome.adoptedExecute).toBe(false);
  });

  it("reports a planner failure without launching an execute Job", async () => {
    const { runJob, calls } = scriptedRun({
      inventory: (m) => ranOk(m, inventoryReport([IDLE_A], NOW - 30 * DAY)),
    });

    const outcome = await drive({
      runJob,
      lookupWorkspaceUsage: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe("plan_failed");
    expect(outcome.detail).toContain("connection terminated");
    expect(calls.map((c) => c.mode)).toEqual(["inventory"]);
  });
});

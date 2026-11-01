import type * as k8s from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS,
  RECLAIM_JOB_CLAIM_ANNOTATION,
} from "../services/isolation-reclaim-job.js";
import {
  ISOLATION_RECLAIM_REPORT_VERSION,
  RECLAIM_PLAN_ENV,
  encodeIsolationReclaimReport,
} from "../services/isolation-reclaim-report.js";
import type {
  IsolationReclaimReport,
  ReclaimPlanEnvelope,
} from "../services/isolation-reclaim-report.js";
import { DEFAULT_RECLAIM_STARTUP_GRACE_MS } from "../services/isolation-reclaim-runner.js";
import type { ReclaimJobPort } from "../services/isolation-reclaim-runner.js";
import {
  RECLAIM_JOB_AGENT_LABEL,
  runIsolationReclaimCycle,
} from "../services/isolation-reclaim-cycle.js";
import type { RunIsolationReclaimCycleOptions } from "../services/isolation-reclaim-cycle.js";
import type { ReclaimableClaim } from "../services/isolation-workspace-reaper.js";
import type { WorkspaceUsageRow } from "../services/isolation-workspace-reaper.js";

const CLAIM: ReclaimableClaim = {
  claimName: "agent-workspace-29033747-e513-46d5-8a13-dcb5dac10017",
  source: "agent_per_agent_volume",
  agentId: "29033747-e513-46d5-8a13-dcb5dac10017",
};
const NAMESPACE = "paperclip";
const IMAGE = "harbor.blockcast.net/paperclip/paperclip@sha256:abc";
const INVOCATION = "20261101T0600Z-a1b2c3";

const NOW = 1_762_000_000_000;
const DAY = 86_400_000;

/** Four uuids, so a plan can be non-trivial. */
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

const COMPLETE = [{ type: "Complete", status: "True" }] as k8s.V1JobCondition[];
const FAILED = [
  { type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "exit 1" },
] as k8s.V1JobCondition[];

function terminalJob(claim: string): k8s.V1Job {
  return {
    metadata: {
      name: "ignored",
      namespace: NAMESPACE,
      annotations: { [RECLAIM_JOB_CLAIM_ANNOTATION]: claim },
    },
    spec: { template: { spec: { containers: [] } } },
    status: { conditions: COMPLETE, active: 0, succeeded: 1 },
  };
}

function failedJob(claim: string): k8s.V1Job {
  return {
    ...terminalJob(claim),
    status: { conditions: FAILED, active: 0, succeeded: 0 },
  };
}

function inventoryReport(names: string[], ageMs = 40 * DAY): IsolationReclaimReport {
  return {
    v: ISOLATION_RECLAIM_REPORT_VERSION,
    kind: "inventory",
    ok: true,
    inventory: names.map((name) => ({ name, mtimeMs: NOW - ageMs })),
  };
}

function executeReport(
  overrides: Partial<Extract<IsolationReclaimReport, { kind: "execute"; ok: true }>["result"]> = {},
): IsolationReclaimReport {
  return {
    v: ISOLATION_RECLAIM_REPORT_VERSION,
    kind: "execute",
    ok: true,
    result: {
      requested: 0,
      deleted: 0,
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
    },
  };
}

interface FakeOptions {
  /** Log text per mode, keyed by the Job-name prefix the manifest builder uses. */
  inventoryLog?: string;
  executeLog?: string;
  /** Terminal Job status per mode. */
  inventoryJob?: k8s.V1Job;
  executeJob?: k8s.V1Job;
  /** Drop the pod for a mode, to drive `pod_absent`. */
  noPodFor?: "inventory" | "execute";
}

interface FakePort extends ReclaimJobPort {
  created: string[];
  plans: ReclaimPlanEnvelope[];
  /** Labels on each created Job, in creation order. */
  labels: Record<string, string>[];
  /** `activeDeadlineSeconds` on each created Job, in creation order. */
  deadlines: (number | undefined)[];
}

function modeOfJobName(jobName: string): "inventory" | "execute" {
  return jobName.startsWith("pc-reclaim-inv") ? "inventory" : "execute";
}

function fakePort(options: FakeOptions = {}): FakePort {
  const created: string[] = [];
  const plans: ReclaimPlanEnvelope[] = [];
  const labels: Record<string, string>[] = [];
  const deadlines: (number | undefined)[] = [];
  return {
    created,
    plans,
    labels,
    deadlines,
    async createJob(_ns: string, job: k8s.V1Job): Promise<"created" | "already_exists"> {
      const name = job.metadata?.name ?? "";
      created.push(name);
      labels.push({ ...(job.metadata?.labels ?? {}) });
      deadlines.push(job.spec?.activeDeadlineSeconds);
      // The plan only exists on the wire, as one env var. Capturing it here is
      // the only way a test can assert what the executor would actually be
      // handed -- the cycle's return value does not carry it.
      const env = job.spec?.template?.spec?.containers?.[0]?.env ?? [];
      const planVar = env.find((e) => e.name === RECLAIM_PLAN_ENV);
      if (planVar?.value) plans.push(JSON.parse(planVar.value) as ReclaimPlanEnvelope);
      return "created";
    },
    async readJob(_ns: string, name: string): Promise<k8s.V1Job | null> {
      return modeOfJobName(name) === "inventory"
        ? (options.inventoryJob ?? terminalJob(CLAIM.claimName))
        : (options.executeJob ?? terminalJob(CLAIM.claimName));
    },
    async listJobPods(_ns: string, jobName: string): Promise<k8s.V1Pod[]> {
      const mode = modeOfJobName(jobName);
      if (options.noPodFor === mode) return [];
      return [{ metadata: { name: `${jobName}-pod`, namespace: NAMESPACE } }];
    },
    async readPodLog(_ns: string, podName: string): Promise<string> {
      const mode = modeOfJobName(podName);
      if (mode === "inventory") {
        return options.inventoryLog ?? encodeIsolationReclaimReport(inventoryReport([]));
      }
      return options.executeLog ?? encodeIsolationReclaimReport(executeReport());
    },
  };
}

/** Nothing is in use: every inventoried name is idle. */
const noUsage = async (): Promise<Map<string, WorkspaceUsageRow>> => new Map();

function cycle(
  port: ReclaimJobPort,
  overrides: Partial<RunIsolationReclaimCycleOptions> = {},
) {
  return runIsolationReclaimCycle({
    claim: CLAIM,
    namespace: NAMESPACE,
    image: IMAGE,
    invocationId: INVOCATION,
    lookupWorkspaceUsage: noUsage,
    maxAgeDays: 30,
    port,
    now: () => NOW,
    sleep: async () => {},
    ...overrides,
  });
}

describe("runIsolationReclaimCycle", () => {
  describe("the plan's lifetime", () => {
    it("grants the plan exactly the wait the driver itself budgets", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeLog: encodeIsolationReclaimReport(executeReport({ requested: 4, deleted: 4 })),
      });

      const result = await cycle(port);

      // The number the module exists to set. The executor's own
      // DEFAULT_MAX_PLAN_AGE_MS is 10 minutes, which is the startup grace
      // ALONE -- a plan carrying it is stale before a slow image pull finishes.
      const expected =
        DEFAULT_RECLAIM_STARTUP_GRACE_MS + DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS * 1000;
      expect(result.planAgeBudgetMs).toBe(expected);
      expect(port.plans).toHaveLength(1);
      expect(port.plans[0]?.maxPlanAgeMs).toBe(expected);
      // Strictly longer than the window the pod can even be alive for, is the
      // property that matters; the equality above is how it is achieved.
      expect(port.plans[0]?.maxPlanAgeMs).toBeGreaterThan(DEFAULT_RECLAIM_STARTUP_GRACE_MS);
    });

    it("tracks a raised activeDeadlineSeconds, so one knob moves both bounds", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });

      const result = await cycle(port, {
        jobDefaults: { activeDeadlineSeconds: 3600 },
      });

      const expected = DEFAULT_RECLAIM_STARTUP_GRACE_MS + 3_600_000;
      expect(result.planAgeBudgetMs).toBe(expected);
      expect(port.plans[0]?.maxPlanAgeMs).toBe(expected);
    });

    it("gives both Jobs the same deadline, which is what makes the budget sound", async () => {
      // `planAgeBudgetMs` is read off the INVENTORY manifest and spent on the
      // EXECUTE Job. That is only sound while the two carry the same deadline
      // -- if they could diverge, the plan's lifetime would be derived from a
      // Job other than the one it is handed to.
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });

      const result = await cycle(port, { jobDefaults: { activeDeadlineSeconds: 1800 } });

      expect(port.deadlines).toEqual([1800, 1800]);
      expect(result.planAgeBudgetMs).toBe(DEFAULT_RECLAIM_STARTUP_GRACE_MS + 1_800_000);
      expect(port.plans[0]?.maxPlanAgeMs).toBe(result.planAgeBudgetMs);
    });

    it("tracks the startup grace too", async () => {
      const port = fakePort({ inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)) });

      const result = await cycle(port, { startupGraceMs: 60_000 });

      expect(result.planAgeBudgetMs).toBe(60_000 + DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS * 1000);
    });

    it("stamps planBuiltAtMs no later than the database read it describes", async () => {
      // The stamp must sit BEFORE the plan's `lastUsedAt` read, not after it.
      // Over-stating a plan's age retains a directory; under-stating it widens
      // the window a resurrection can hide in, and only one of those is the
      // safe direction. Anchored against the clock as the LOOKUP sees it --
      // comparing against the final value only proves the stamp happened at
      // some point, which a stamp taken afterwards also satisfies.
      let t = NOW;
      const tick = (): number => {
        t += 1000;
        return t;
      };
      let clockAtLookup = 0;
      const port = fakePort({ inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)) });

      await cycle(port, {
        now: tick,
        lookupWorkspaceUsage: async () => {
          clockAtLookup = t;
          return new Map<string, WorkspaceUsageRow>();
        },
      });

      expect(clockAtLookup).toBeGreaterThan(NOW);
      expect(port.plans).toHaveLength(1);
      expect(port.plans[0]?.planBuiltAtMs).toBeLessThanOrEqual(clockAtLookup);
    });
  });

  describe("an empty plan launches no pod", () => {
    it("stops at plan when the inventory is empty, creating only the inventory Job", async () => {
      const port = fakePort();

      const result = await cycle(port);

      // The decision was skipped, not taken, so the stage does not claim it.
      expect(result.stage).toBe("inventory");
      expect(result.halted).toBe("inventory_empty");
      expect(result.inventorySize).toBe(0);
      expect(result.plan).toBeNull();
      expect(result.execution).toBeNull();
      expect(result.failure).toBeNull();
      expect(port.created).toHaveLength(1);
      expect(port.created[0]).toMatch(/^pc-reclaim-inv/);
    });

    it("stops at plan when the tree is there but nothing is idle enough", async () => {
      const port = fakePort({
        // Materialized an hour ago, against a 30-day window.
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS, 3_600_000)),
      });

      const result = await cycle(port);

      expect(result.stage).toBe("plan");
      expect(result.halted).toBe("nothing_eligible");
      expect(result.inventorySize).toBe(4);
      expect(result.plan?.eligibleIds).toEqual([]);
      expect(result.plan?.retainedFresh).toBe(4);
      expect(port.created).toHaveLength(1);
    });

    it("does launch the execute Job once something is eligible", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeLog: encodeIsolationReclaimReport(executeReport({ requested: 4, deleted: 4 })),
      });

      const result = await cycle(port);

      expect(result.stage).toBe("execute");
      expect(result.halted).toBeNull();
      expect(result.execution?.deleted).toBe(4);
      expect(result.deletionOutcomeUnknown).toBe(false);
      expect(port.created).toHaveLength(2);
      expect(port.created[1]).toMatch(/^pc-reclaim-exe/);
      expect(port.plans[0]?.eligibleIds).toEqual(IDS);
    });
  });

  describe("an inventory failure stops the cycle and never substitutes an empty one", () => {
    it("reports the transport failure and launches no execute Job", async () => {
      const port = fakePort({ inventoryLog: "no marker here" });

      const result = await cycle(port);

      expect(result.stage).toBe("inventory");
      expect(result.failure?.stage).toBe("inventory");
      expect(result.failure?.kind).toBe("report_absent");
      // The distinction the whole module rests on: an unobserved claim is NOT
      // an empty one.
      expect(result.inventorySize).toBeNull();
      expect(result.halted).toBeNull();
      expect(result.plan).toBeNull();
      expect(port.created).toHaveLength(1);
    });

    it("keeps deletionOutcomeUnknown false, because an inventory Job unlinks nothing", async () => {
      const port = fakePort({ noPodFor: "inventory" });

      const result = await cycle(port);

      expect(result.failure?.kind).toBe("pod_absent");
      expect(result.deletionOutcomeUnknown).toBe(false);
    });

    it("treats an executor that refuses to report as a failure, not an empty tree", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport({
          v: ISOLATION_RECLAIM_REPORT_VERSION,
          kind: "inventory",
          ok: false,
          error: "root is not a directory",
        }),
      });

      const result = await cycle(port);

      expect(result.stage).toBe("inventory");
      expect(result.failure?.detail).toContain("root is not a directory");
      expect(result.inventorySize).toBeNull();
      expect(port.created).toHaveLength(1);
    });
  });

  describe("deletionOutcomeUnknown is carried, never computed as zero", () => {
    it("marks a failed execute Job unknown rather than reporting nothing reclaimed", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeJob: failedJob(CLAIM.claimName),
        executeLog: "the pod said nothing a parser can use",
      });

      const result = await cycle(port);

      expect(result.stage).toBe("execute");
      expect(result.failure?.stage).toBe("execute");
      expect(result.deletionOutcomeUnknown).toBe(true);
      // The field that must NOT read as "reclaimed 0".
      expect(result.execution).toBeNull();
      // The plan survives on the result, so a sweep can still say how much was
      // at risk.
      expect(result.plan?.eligibleIds).toEqual(IDS);
    });

    it("marks an ok:false execute report unknown, since the executor reports then exits", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeJob: failedJob(CLAIM.claimName),
        executeLog: encodeIsolationReclaimReport({
          v: ISOLATION_RECLAIM_REPORT_VERSION,
          kind: "execute",
          ok: false,
          error: "plan env var was not set",
        }),
      });

      const result = await cycle(port);

      expect(result.deletionOutcomeUnknown).toBe(true);
      expect(result.execution).toBeNull();
      expect(result.failure?.detail).toContain("plan env var was not set");
    });

    it("reports a stale-plan stop as a result, not a failure", async () => {
      // `plan_stale` is now a real signal rather than the ordinary outcome: it
      // means the Job outran the budget this cycle granted it.
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeLog: encodeIsolationReclaimReport(
          executeReport({ requested: 4, deleted: 1, notAttempted: 3, stopReason: "plan_stale" }),
        ),
      });

      const result = await cycle(port);

      expect(result.failure).toBeNull();
      expect(result.deletionOutcomeUnknown).toBe(false);
      expect(result.execution?.stopReason).toBe("plan_stale");
      expect(result.execution?.notAttempted).toBe(3);
    });
  });

  describe("a plan too large to ship is this claim's failure, not the pass's", () => {
    /** Enough distinct uuids to push the envelope past MAX_RECLAIM_PLAN_ENV_BYTES. */
    function manyIds(count: number): string[] {
      return Array.from({ length: count }, (_, i) => {
        const hex = i.toString(16).padStart(12, "0");
        return `00000000-0000-4000-8000-${hex}`;
      });
    }

    it("returns plan_unshippable instead of throwing, so the sweep can continue", async () => {
      const ids = manyIds(2000);
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(ids)),
      });

      // The throw is reachable only once an operator raises maxEntries past
      // what the single env var can carry -- which is a property of THIS
      // claim's backlog, not of the deployment, so it must not end the pass.
      const result = await cycle(port, { maxEntries: 2000 });

      expect(result.failure?.kind).toBe("plan_unshippable");
      expect(result.failure?.stage).toBe("plan");
      expect(result.stage).toBe("plan");
      expect(result.failure?.detail).toContain("maxEntries");
      // Nothing was created for the execute mode, so nothing could have been
      // unlinked.
      expect(port.created).toHaveLength(1);
      expect(result.deletionOutcomeUnknown).toBe(false);
      // The plan survives, so a sweep can report how much went unreclaimed.
      expect(result.plan?.eligibleIds).toHaveLength(2000);
    });

    it("ships the same backlog fine at the default bound", async () => {
      const ids = manyIds(2000);
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(ids)),
      });

      const result = await cycle(port);

      expect(result.failure).toBeNull();
      expect(result.plan?.truncated).toBe(true);
      expect(port.created).toHaveLength(2);
    });
  });

  describe("the two Jobs are the same claim, bounded the same way", () => {
    it("passes maxEntries to both the plan and the executor's own bound", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });

      const result = await cycle(port, { maxEntries: 2 });

      expect(result.plan?.eligibleIds).toHaveLength(2);
      expect(result.plan?.truncated).toBe(true);
      expect(port.plans[0]?.eligibleIds).toHaveLength(2);
      // Restated on the envelope as well: the plan truncating is not the same
      // guarantee as the executor refusing to exceed the bound, and the
      // executor is the process that calls `fs.rm`.
      expect(port.plans[0]?.maxDeletes).toBe(2);
    });

    it("carries dryRun onto the envelope", async () => {
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
        executeLog: encodeIsolationReclaimReport(executeReport({ requested: 4, wouldDelete: 4 })),
      });

      const result = await cycle(port, { dryRun: true });

      expect(port.plans[0]?.dryRun).toBe(true);
      expect(result.execution?.wouldDelete).toBe(4);
      expect(result.execution?.deleted).toBe(0);
    });

    it("labels both Jobs with the agent, and omits the label when there is no agent", async () => {
      const withAgent = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });
      await cycle(withAgent);

      expect(withAgent.labels).toHaveLength(2);
      for (const labels of withAgent.labels) {
        expect(labels[RECLAIM_JOB_AGENT_LABEL]).toBe(CLAIM.agentId);
      }

      const envClaim: ReclaimableClaim = {
        claimName: "operator-shared-workspaces",
        source: "environment_claim",
        agentId: null,
      };
      const withoutAgent = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });
      const envResult = await cycle(withoutAgent, { claim: envClaim });

      expect(envResult.agentId).toBeNull();
      expect(envResult.source).toBe("environment_claim");
      // Absent, not empty: an empty value is a label a selector matches.
      for (const labels of withoutAgent.labels) {
        expect(labels).not.toHaveProperty(RECLAIM_JOB_AGENT_LABEL);
      }
    });

    it("omits the agent label rather than letting the API server refuse the Job", async () => {
      // `agent_workspace_claim` rows carry `agentId` through without the
      // label-safety check `listReclaimableClaims` applies on the DERIVED-name
      // arm, so an unsafe id reaches here intact. An invalid label value is
      // rejected at createJob, which throws past this function and ends the
      // pass -- so the label is dropped and the sweep continues.
      const unsafe: ReclaimableClaim = {
        claimName: "operator-named-claim",
        source: "agent_workspace_claim",
        agentId: "-starts-with-a-dash",
      };
      const port = fakePort({
        inventoryLog: encodeIsolationReclaimReport(inventoryReport(IDS)),
      });

      const result = await cycle(port, { claim: unsafe });

      expect(result.stage).toBe("execute");
      expect(result.failure).toBeNull();
      expect(port.labels).toHaveLength(2);
      for (const labels of port.labels) {
        expect(labels).not.toHaveProperty(RECLAIM_JOB_AGENT_LABEL);
      }
      // The attribution is still on the RESULT, which is where a sweep reads it.
      expect(result.agentId).toBe("-starts-with-a-dash");
    });

    it("reports the claim it swept on every outcome", async () => {
      const ok = await cycle(fakePort());
      const failed = await cycle(fakePort({ inventoryLog: "junk" }));

      for (const result of [ok, failed]) {
        expect(result.claimName).toBe(CLAIM.claimName);
        expect(result.agentId).toBe(CLAIM.agentId);
        expect(result.source).toBe("agent_per_agent_volume");
      }
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  buildProcessLossCapture,
  classifyProcessLoss,
  type ProcessLossJobLiveness,
} from "../services/process-loss-classification.js";

describe("classifyProcessLoss (BLO-16181)", () => {
  it("buckets a non-external (local) reap as 'local'", () => {
    expect(
      classifyProcessLoss({
        externalLifecycleRun: false,
        preAdapter: false,
        externalRunIdStamped: false,
        preAdapterJobLiveness: null,
      }),
    ).toBe("local");
  });

  it("buckets a pre-adapter reap with no persisted Job name as 'pre_adapter_job_unstamped'", () => {
    // The dominant fleet case: reaped during setup before external_run_id was
    // ever written, so no Job was navigably created -> unreattachable.
    expect(
      classifyProcessLoss({
        externalLifecycleRun: true,
        preAdapter: true,
        externalRunIdStamped: false,
        preAdapterJobLiveness: "dead",
      }),
    ).toBe("pre_adapter_job_unstamped");
  });

  it("stamped-ness wins over liveness: unstamped stays 'unstamped' even when kube is unknown", () => {
    expect(
      classifyProcessLoss({
        externalLifecycleRun: true,
        preAdapter: true,
        externalRunIdStamped: false,
        preAdapterJobLiveness: "unknown",
      }),
    ).toBe("pre_adapter_job_unstamped");
  });

  it("buckets a pre-adapter reap with a stamped Job name + dead liveness as 'pre_adapter_job_stamped'", () => {
    expect(
      classifyProcessLoss({
        externalLifecycleRun: true,
        preAdapter: true,
        externalRunIdStamped: true,
        preAdapterJobLiveness: "dead",
      }),
    ).toBe("pre_adapter_job_stamped");
  });

  it("buckets a pre-adapter reap with a stamped Job name but unknown kube state as 'pre_adapter_kube_unknown'", () => {
    // A real measurement gap, not a confirmed loss -- must be distinguishable so
    // the monitor does not over-count genuine process losses.
    expect(
      classifyProcessLoss({
        externalLifecycleRun: true,
        preAdapter: true,
        externalRunIdStamped: true,
        preAdapterJobLiveness: "unknown",
      }),
    ).toBe("pre_adapter_kube_unknown");
  });

  it("buckets any post-adapter reap that reaches the mint as 'started_job_absent'", () => {
    // At the process_lost mint a started run always had no live Job and went
    // silent; a confirmed exact-name 404 is finalized upstream as job_missing and
    // never reaches here, so there is no separate 'missing' bucket.
    for (const externalRunIdStamped of [true, false]) {
      expect(
        classifyProcessLoss({
          externalLifecycleRun: true,
          preAdapter: false,
          externalRunIdStamped,
          preAdapterJobLiveness: null,
        }),
      ).toBe("started_job_absent");
    }
  });
});

describe("buildProcessLossCapture (BLO-16181)", () => {
  it("returns a minimal marker for local reaps", () => {
    expect(
      buildProcessLossCapture({
        externalLifecycleRun: false,
        preAdapter: false,
        externalRunId: null,
        preAdapterJobLiveness: null,
      }),
    ).toEqual({ externalLifecycleRun: false, classification: "local" });
  });

  it("derives externalRunIdStamped=false from a null/blank Job name", () => {
    for (const externalRunId of [null, undefined, "", "   "] as Array<string | null | undefined>) {
      const capture = buildProcessLossCapture({
        externalLifecycleRun: true,
        preAdapter: true,
        externalRunId,
        preAdapterJobLiveness: "dead",
      });
      expect(capture.externalRunIdStamped).toBe(false);
      expect(capture.externalRunId).toBeNull();
      expect(capture.classification).toBe("pre_adapter_job_unstamped");
    }
  });

  it("trims and preserves a stamped Job name and derives the started_job_absent bucket", () => {
    const capture = buildProcessLossCapture({
      externalLifecycleRun: true,
      preAdapter: false,
      externalRunId: "  agent-claude-abc123  ",
      preAdapterJobLiveness: null,
    });
    expect(capture).toEqual({
      externalLifecycleRun: true,
      preAdapter: false,
      externalRunIdStamped: true,
      externalRunId: "agent-claude-abc123",
      preAdapterJobLiveness: null,
      classification: "started_job_absent",
    });
  });

  it("carries the resolved pre-adapter liveness through into the capture", () => {
    const liveness: ProcessLossJobLiveness = "unknown";
    const capture = buildProcessLossCapture({
      externalLifecycleRun: true,
      preAdapter: true,
      externalRunId: "agent-opencode-xyz",
      preAdapterJobLiveness: liveness,
    });
    expect(capture.preAdapterJobLiveness).toBe("unknown");
    expect(capture.classification).toBe("pre_adapter_kube_unknown");
  });
});

describe("pre-adapter <-> classification invariant (BLO-16185 non-goal tripwire)", () => {
  // The "checkpoint/resume is a non-goal" decision (docs/plans/2026-07-14-
  // process-loss-recovery-non-goal.md) rests on the classifier faithfully mapping
  // the pre/post-adapter boundary onto its bucket family: pre-adapter reaps carry
  // no work product, started reaps are the small tail. If adapter.invoke ever
  // moves earlier the runtime `preAdapter` share shifts (visible on the BLO-16184
  // metric split) -- but the classifier must never blur the mapping itself, or
  // that tripwire reads the wrong bucket. This pins the mapping across every
  // combination of the other inputs.
  const livenesses: ProcessLossJobLiveness[] = ["alive", "dead", "unknown", null];

  it("maps every external pre-adapter signal set to a pre_adapter_* bucket", () => {
    for (const externalRunIdStamped of [true, false]) {
      for (const preAdapterJobLiveness of livenesses) {
        const c = classifyProcessLoss({
          externalLifecycleRun: true,
          preAdapter: true,
          externalRunIdStamped,
          preAdapterJobLiveness,
        });
        expect(c.startsWith("pre_adapter_")).toBe(true);
      }
    }
  });

  it("never maps an external started (post-adapter) signal set to a pre_adapter_* bucket", () => {
    for (const externalRunIdStamped of [true, false]) {
      for (const preAdapterJobLiveness of livenesses) {
        const c = classifyProcessLoss({
          externalLifecycleRun: true,
          preAdapter: false,
          externalRunIdStamped,
          preAdapterJobLiveness,
        });
        expect(c.startsWith("pre_adapter_")).toBe(false);
        expect(c).toBe("started_job_absent");
      }
    }
  });

  it("never maps a non-external reap to a pre_adapter_* or started bucket", () => {
    for (const preAdapter of [true, false]) {
      const c = classifyProcessLoss({
        externalLifecycleRun: false,
        preAdapter,
        externalRunIdStamped: false,
        preAdapterJobLiveness: null,
      });
      expect(c).toBe("local");
    }
  });
});

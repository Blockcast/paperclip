import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  readObservedHeartbeatRunTimeout,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";
import type { HeartbeatRunOutcome } from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});

describe("PEN-4023: a fired timeout names the bound that fired", () => {
  // The PEN-4016 reproduction, verbatim. Agent Jobs carry
  // `spec.activeDeadlineSeconds: 7200` that the adapter never set and does not
  // know about; the agent's own `adapterConfig` says `timeoutSec: 0`. Before
  // this fix the stored record read
  //   { timeoutFired: true, timeoutSource: "config",
  //     timeoutConfigured: false, effectiveTimeoutSec: 0 }
  // on run cc411d48-57b6-4faa-b8b2-de58c4ec1dc4 — a real 121-minute kill whose
  // bound appeared nowhere, so nobody could grep for it.
  const PEN_4016_CONFIG = { timeoutSec: 0 } as const;

  it("reports the Job's observed deadline, not the configured zero", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_k8s",
        adapterConfig: PEN_4016_CONFIG,
        outcome: "timed_out",
        errorCode: "timeout",
        errorMessage: "Timed out after 7200s (Job activeDeadlineSeconds; adapter timeoutSec=0)",
        observedTimeout: { seconds: 7200, source: "job_deadline" },
      }),
    ).toEqual({
      effectiveTimeoutSec: 7200,
      timeoutConfigured: true,
      timeoutSource: "observed",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("records an unnameable bound as unknown rather than as the configured zero", () => {
    // A timeout fired and no adapter reported a bound. The honest record is
    // "a bound was in force, its value is unknown" — never `0`, which is what
    // `Timed out after 0s` was made of.
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_k8s",
        adapterConfig: PEN_4016_CONFIG,
        outcome: "timed_out",
        errorCode: "timeout",
      }),
    ).toEqual({
      effectiveTimeoutSec: null,
      timeoutConfigured: true,
      timeoutSource: "unknown",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("leaves a configured positive bound alone when nothing was observed", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: { timeoutSec: 45 },
        outcome: "timed_out",
        errorCode: "timeout",
      }),
    ).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("keeps the millisecond field in step with the observed bound for http", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "http",
        adapterConfig: { timeoutMs: 30_000 },
        outcome: "timed_out",
        errorCode: "timeout",
        observedTimeout: { seconds: 600, source: "gateway_deadline" },
      }),
    ).toEqual({
      effectiveTimeoutSec: 600,
      effectiveTimeoutMs: 600_000,
      timeoutConfigured: true,
      timeoutSource: "observed",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("does not disturb the config policy on any non-timeout outcome", () => {
    // The reconciliation is reached only by a fired timeout. A run that did
    // not time out still reports its configuration exactly as it always did,
    // even when an adapter volunteered an observed bound.
    for (const outcome of ["succeeded", "interrupted", "failed", "cancelled"] as const) {
      expect(
        buildHeartbeatRunStopMetadata({
          adapterType: "claude_k8s",
          adapterConfig: PEN_4016_CONFIG,
          outcome,
          observedTimeout: { seconds: 7200, source: "job_deadline" },
        }),
      ).toMatchObject({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "config",
        timeoutFired: false,
      });
    }
  });

  // THE REGRESSION PIN. Assert the *pair*, never the fields separately: each
  // field was individually correct before this fix — `timeoutFired` truly
  // restated the outcome and `timeoutConfigured` truly restated the config —
  // and that is precisely why the contradiction survived review. Only their
  // conjunction is the defect.
  it("never pairs timeoutFired with timeoutConfigured: false, across the input space", () => {
    const outcomes: HeartbeatRunOutcome[] = [
      "succeeded",
      "interrupted",
      "failed",
      "cancelled",
      "timed_out",
    ];
    const adapterTypes = [
      "claude_k8s",
      "codex_local",
      "claude_local",
      "openclaw_gateway",
      "http",
      "process",
      "some_adapter_nobody_has_written_yet",
    ];
    const configs: Array<Record<string, unknown> | null> = [
      null,
      {},
      { timeoutSec: 0 },
      { timeoutSec: 45 },
      { timeoutSec: "0" },
      { timeoutSec: Number.NaN },
      { timeoutMs: 0 },
      { timeoutMs: 30_000 },
    ];
    const errorCodes = [null, "timeout", "process_lost", "max_turns_exhausted"];
    const observations: Array<{ seconds: number | null; source: string | null } | null> = [
      null,
      { seconds: null, source: "job_deadline" },
      { seconds: 0, source: "job_deadline" },
      { seconds: 7200, source: "job_deadline" },
      { seconds: Number.NaN, source: "job_deadline" },
      { seconds: -1, source: null },
    ];

    let timeoutCases = 0;
    for (const adapterType of adapterTypes) {
      for (const adapterConfig of configs) {
        for (const outcome of outcomes) {
          for (const errorCode of errorCodes) {
            for (const observedTimeout of observations) {
              const metadata = buildHeartbeatRunStopMetadata({
                adapterType,
                adapterConfig,
                outcome,
                errorCode,
                observedTimeout: observedTimeout
                  ? readObservedHeartbeatRunTimeout({
                      observedTimeoutSec: observedTimeout.seconds,
                      observedTimeoutSource: observedTimeout.source,
                    })
                  : null,
              });

              const context = JSON.stringify({ adapterType, adapterConfig, outcome, errorCode, observedTimeout });
              expect(
                metadata.timeoutFired && !metadata.timeoutConfigured,
                `self-contradictory stop metadata for ${context}`,
              ).toBe(false);

              if (metadata.timeoutFired) {
                timeoutCases += 1;
                // A fired timeout must also *name* a bound: either a positive
                // number, or an explicit "unknown". A null-or-zero bound
                // labelled `config` is the exact shape that misled PEN-4016 —
                // it reads as "the configured timeout elapsed" when no
                // configured timeout existed.
                if (metadata.effectiveTimeoutSec == null || metadata.effectiveTimeoutSec <= 0) {
                  expect(
                    metadata.timeoutSource,
                    `unnamed bound on a fired timeout for ${context}`,
                  ).toBe("unknown");
                }
                // ...and the converse, so "unknown" cannot creep onto a run
                // whose bound is in fact known.
                if (metadata.timeoutSource === "unknown") {
                  expect(metadata.effectiveTimeoutSec, context).toBeNull();
                }
              }
            }
          }
        }
      }
    }

    // Positive control: the loop must actually reach the timeout branch. An
    // assertion that never runs is not a pin, and a future change to
    // `inferHeartbeatRunStopReason` could silently empty this sweep.
    expect(timeoutCases).toBeGreaterThan(0);
  });

  it("persists the reconciled pair through the resultJson merge", () => {
    // The pin above covers the builder. This one covers what is actually
    // stored: `mergeHeartbeatRunStopMetadata` is the writer, and it is the
    // merged object that run `cc411d48` was read from.
    const adapterResultJson = {
      summary: "killed at the wall",
      observedTimeoutSec: 7200,
      observedTimeoutSource: "job_deadline",
      configuredTimeoutSec: 0,
    };

    const stored = mergeHeartbeatRunStopMetadata(
      adapterResultJson,
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_k8s",
        adapterConfig: PEN_4016_CONFIG,
        outcome: "timed_out",
        errorCode: "timeout",
        observedTimeout: readObservedHeartbeatRunTimeout(adapterResultJson),
      }),
    );

    expect(stored).toMatchObject({
      summary: "killed at the wall",
      stopReason: "timeout",
      timeoutFired: true,
      timeoutConfigured: true,
      timeoutSource: "observed",
      effectiveTimeoutSec: 7200,
      // Adapter-reported provenance survives the merge, so the record says
      // where 7200 came from as well as what it was.
      observedTimeoutSource: "job_deadline",
      configuredTimeoutSec: 0,
    });
  });
});

describe("readObservedHeartbeatRunTimeout", () => {
  it("returns null when the adapter reported nothing", () => {
    expect(readObservedHeartbeatRunTimeout(null)).toBeNull();
    expect(readObservedHeartbeatRunTimeout({})).toBeNull();
    expect(readObservedHeartbeatRunTimeout({ summary: "x" })).toBeNull();
  });

  it("treats anything but a finite positive value as absent", () => {
    // Degrading to `unknown` is safe; degrading to a number rebuilds the
    // defect. Zero is in this list deliberately: nothing fires after zero
    // seconds, so a reported `0` is a broken reading, not a bound.
    for (const observedTimeoutSec of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, "nonsense", {}, null]) {
      expect(readObservedHeartbeatRunTimeout({ observedTimeoutSec })).toEqual({
        seconds: null,
        source: null,
      });
    }
  });

  it("degrades a zero observation to unknown rather than to a zero bound", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_k8s",
        adapterConfig: { timeoutSec: 0 },
        outcome: "timed_out",
        errorCode: "timeout",
        observedTimeout: readObservedHeartbeatRunTimeout({
          observedTimeoutSec: 0,
          observedTimeoutSource: "job_deadline",
        }),
      }),
    ).toMatchObject({
      effectiveTimeoutSec: null,
      timeoutConfigured: true,
      timeoutSource: "unknown",
      timeoutFired: true,
    });
  });

  it("parses the shape the k8s adapter writes", () => {
    expect(
      readObservedHeartbeatRunTimeout({
        observedTimeoutSec: 7200,
        observedTimeoutSource: "job_deadline",
        configuredTimeoutSec: 0,
      }),
    ).toEqual({ seconds: 7200, source: "job_deadline" });
  });
});

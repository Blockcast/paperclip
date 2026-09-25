/**
 * BLO-34699: `producedPrReviewGateVerdict` — may this terminal run's outcome be
 * published as a verdict about the PR head?
 *
 * A commit status is a claim about the HEAD, not about the run. A reviewer run
 * whose pod never scheduled invoked no adapter, read no diff, and formed no
 * judgement, so writing `review/ally-complete = failure` on its behalf asserts
 * something nobody has established.
 *
 * Measured on Blockcast/paperclip 2026-09-19: four heads carried that status
 * with "ended ambiguously and was not replayed; no review was confirmed", and a
 * genuine non-stale formal review landed at that exact head on three of them
 * 4h59m–5h48m later (#1929, #1931, #1932). The run behind #1931's stamp,
 * b3ed7bde, died `k8s_pod_schedule_failed` with no `adapter.invoke` event.
 * `review/ally-complete` has no writer that ever clears it, so #1929 still
 * carried that red beside a `gate/ally-comment-findings: success` for the same
 * head ~14h on — two gates contradicting each other about one fact.
 *
 * Mutation check (BLO-34263): each guard in the function has a test below that
 * fails when that guard alone is reverted. Remove `return false` on the
 * terminal-outcome line and `ignores a run that is not a PR-review terminal
 * outcome` fails; replace the `adapterInvocationStarted` line with `return true`
 * and both `k8s_pod_schedule_failed` cases fail.
 */
import { describe, expect, it } from "vitest";

import { producedPrReviewGateVerdict } from "../services/heartbeat.js";

function run(overrides: Record<string, unknown> = {}) {
  return {
    errorCode: null,
    resultJson: null,
    contextSnapshot: null,
    ...overrides,
  } as Parameters<typeof producedPrReviewGateVerdict>[0];
}

function invoked(started: boolean) {
  return { externalLifecycleRecovery: { adapterInvocationStarted: started } };
}

describe("producedPrReviewGateVerdict", () => {
  it("does not grade a pod that never scheduled", () => {
    // Verbatim shape of run b3ed7bde: `adapterInvocationStarted` is not merely
    // false here, it is never computed — `hasAdapterInvocationEvent` is
    // consulted only for job_failed/job_missing — so the absent key is the
    // production shape, not a contrived one.
    expect(producedPrReviewGateVerdict(run({ errorCode: "k8s_pod_schedule_failed" }))).toBe(false);
  });

  it("does not grade a pod-schedule failure even with an explicit negative proof", () => {
    expect(
      producedPrReviewGateVerdict(
        run({ errorCode: "k8s_pod_schedule_failed", resultJson: invoked(false) }),
      ),
    ).toBe(false);
  });

  it("grades a missing Job once the adapter demonstrably ran", () => {
    // The genuine case this feature exists for: the reviewer was invoked and the
    // Job then vanished, so no review is coming from that run. Guards against
    // fixing the false positive by failing closed on every infra code.
    expect(
      producedPrReviewGateVerdict(run({ errorCode: "job_missing", resultJson: invoked(true) })),
    ).toBe(true);
  });

  it("does not grade a missing Job that never reached its adapter", () => {
    expect(
      producedPrReviewGateVerdict(run({ errorCode: "job_missing", resultJson: invoked(false) })),
    ).toBe(false);
  });

  it("still grades a reviewer run that ran and posted nothing", () => {
    // BLO-17456's original case, unchanged: these arms already proved invocation.
    for (const errorCode of ["pr_review_output_missing", "pr_review_verification_unavailable"]) {
      expect(producedPrReviewGateVerdict(run({ errorCode, resultJson: invoked(true) }))).toBe(true);
    }
  });

  it("ignores a run that is not a PR-review terminal outcome", () => {
    // `process_lost` is ~67 of the reviewer's last 1000 runs and is handled by
    // retry, not by the gate. Without the terminal-outcome guard the invocation
    // proof alone would grade it.
    expect(
      producedPrReviewGateVerdict(run({ errorCode: "process_lost", resultJson: invoked(true) })),
    ).toBe(false);
    expect(producedPrReviewGateVerdict(run({ errorCode: null, resultJson: invoked(true) }))).toBe(
      false,
    );
  });
});

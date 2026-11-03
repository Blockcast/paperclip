import { describe, expect, it } from "vitest";

import { PIPELINE_STAGE_EXIT_CANCELLATION_REASON } from "../services/heartbeat.js";
import { pipelineStageExitAutomationCancellationNotice } from "../services/pipelines.js";

/**
 * PEN-5061. This reason is rendered verbatim to the operator: it reaches the UI
 * as a run-cancellation toast on the pipelines board, so it is prosumer copy and
 * not an internal diagnostic.
 *
 * It already had a guard — `expectProsumerVocabulary` in
 * `tests/e2e/pipelines-tutorial-flow.spec.ts` — and that guard caught the leak
 * correctly. But it caught it through a full browser matrix, and only when the
 * toast happened to still be on screen at the moment the assertion read
 * `body.innerText()`. That made a deterministic copy defect present as an
 * intermittently red `e2e`: observed on run 40963887553 (PR #3115) and again on
 * run 41532234608 (PR #3301), neither of which touched any pipelines code.
 *
 * The cost of discovering it that way is the point of this file. `e2e` is not a
 * required check on `master`, but `failingChecks` in `scripts/land-clean-prs.mjs`
 * does not consult required-ness — any non-passing context makes the lander skip
 * the PR — so one word in this string stalls unrelated work from landing.
 *
 * The three rules below mirror `expectProsumerVocabulary` exactly. Keep them in
 * step with it: this test is the cheap, deterministic half of the same rule, not
 * a replacement for the end-to-end check.
 */
describe("pipeline stage-exit cancellation reason", () => {
  const reason = PIPELINE_STAGE_EXIT_CANCELLATION_REASON;

  it("is the single source for every stage-exit cancellation message", () => {
    expect(reason).toBeTypeOf("string");
    expect(reason.trim()).not.toHaveLength(0);
  });

  it("does not leak the internal noun `case` into operator-facing copy", () => {
    expect(reason).not.toMatch(/\bcase\b/i);
  });

  it("does not leak internal transition vocabulary", () => {
    expect(reason).not.toMatch(/\breview_decided\b|\btransition_forced\b/);
  });

  it("does not leak a bare HTTP status code", () => {
    expect(reason).not.toMatch(/\b(?:400|401|403|404|409|422|500)\b/);
  });
});

/**
 * The run-cancellation reason is not the only copy this event emits. The same
 * stage exit also posts a notice on the stage-entry automation issue, and the
 * original sweep missed it because `git grep "pipeline case"` is case-sensitive
 * and the notice opens with a capitalised "Pipeline case". Both strings are
 * operator-facing, so both are held to the same three rules.
 */
describe("pipeline stage-exit automation cancellation notice", () => {
  const notice = pipelineStageExitAutomationCancellationNotice({
    caseTitle: "Renew the Hadley lease",
    caseKey: "PIPE-204",
    stageName: "Drafting",
  });

  it("renders the operator's own values back to them", () => {
    expect(notice).toContain("Renew the Hadley lease");
    expect(notice).toContain("PIPE-204");
    expect(notice).toContain("Drafting");
  });

  it("does not leak the internal noun `case` into operator-facing copy", () => {
    expect(notice).not.toMatch(/\bcase\b/i);
  });

  it("does not leak internal transition vocabulary", () => {
    expect(notice).not.toMatch(/\breview_decided\b|\btransition_forced\b/);
  });

  it("does not leak a bare HTTP status code", () => {
    expect(notice).not.toMatch(/\b(?:400|401|403|404|409|422|500)\b/);
  });
});

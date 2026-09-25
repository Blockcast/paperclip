/**
 * PEN-2400 (Ally non-blocking suggestion 2, from the PR #1195 review).
 *
 * `EXTERNAL_WAIT_RESUME_WAKE_REASONS` was declared twice — a hardcoded 8-entry
 * literal in `recovery/service.ts` and a `GITHUB_STATE_CHANGE_WAKE_REASONS`-derived
 * set in `heartbeat.ts`. They were identical, but nothing held them so. Divergence
 * is silent and asymmetric: a resume reason present in one set and absent from the
 * other wakes one path while the other suppresses it, which presents as a run
 * parked on an external wait that never resumes, with no error to attribute it to.
 *
 * `recovery/service.ts` now owns both sets and `heartbeat.ts` re-exports them.
 *
 * The identity assertions are the load-bearing ones: `toBe` fails the moment
 * `heartbeat.ts` grows its own literal again, even one spelled identically — which
 * is exactly how the drift would be re-introduced. The membership assertions catch
 * the other direction (a reason quietly added or dropped from the shared set).
 */
import { describe, expect, it } from "vitest";

import {
  EXTERNAL_WAIT_RESUME_WAKE_REASONS as HEARTBEAT_EXTERNAL_WAIT_RESUME_WAKE_REASONS,
  GITHUB_STATE_CHANGE_WAKE_REASONS as HEARTBEAT_GITHUB_STATE_CHANGE_WAKE_REASONS,
} from "../services/heartbeat.js";
import {
  EXTERNAL_WAIT_RESUME_WAKE_REASONS,
  GITHUB_STATE_CHANGE_WAKE_REASONS,
} from "../services/recovery/service.js";

const EXPECTED_GITHUB_STATE_CHANGE_WAKE_REASONS = [
  "github_check_completed",
  "github_check_suite_completed",
  "github_workflow_completed",
];

const EXPECTED_EXTERNAL_WAIT_RESUME_WAKE_REASONS = [
  ...EXPECTED_GITHUB_STATE_CHANGE_WAKE_REASONS,
  "github_pr_closed",
  "github_pr_converted_to_draft",
  "github_pr_review_submitted",
  "github_pr_synchronized",
  "issue_monitor_due",
];

describe("external-wait resume wake reasons are single-sourced (PEN-2400)", () => {
  it("resolves the SAME set object through heartbeat.ts and recovery/service.ts", () => {
    // Deliberately identity, not deep-equality: a re-introduced literal in
    // heartbeat.ts would be deep-equal on the day it was written and would drift
    // later. Only identity forbids the second declaration outright.
    expect(HEARTBEAT_EXTERNAL_WAIT_RESUME_WAKE_REASONS).toBe(EXTERNAL_WAIT_RESUME_WAKE_REASONS);
    expect(HEARTBEAT_GITHUB_STATE_CHANGE_WAKE_REASONS).toBe(GITHUB_STATE_CHANGE_WAKE_REASONS);
  });

  it("carries exactly the expected resume reasons", () => {
    expect([...EXTERNAL_WAIT_RESUME_WAKE_REASONS].sort()).toEqual(
      [...EXPECTED_EXTERNAL_WAIT_RESUME_WAKE_REASONS].sort(),
    );
    expect([...GITHUB_STATE_CHANGE_WAKE_REASONS].sort()).toEqual(
      [...EXPECTED_GITHUB_STATE_CHANGE_WAKE_REASONS].sort(),
    );
  });

  it("keeps every GitHub state-change reason inside the resume set", () => {
    // The derivation (`...GITHUB_STATE_CHANGE_WAKE_REASONS`) makes this structural
    // today. Asserting it means a future hand-written membership list cannot drop a
    // check/suite/workflow completion — the reasons that resume a run waiting on CI.
    for (const reason of GITHUB_STATE_CHANGE_WAKE_REASONS) {
      expect(EXTERNAL_WAIT_RESUME_WAKE_REASONS.has(reason)).toBe(true);
    }
    expect(GITHUB_STATE_CHANGE_WAKE_REASONS.size).toBeLessThan(
      EXTERNAL_WAIT_RESUME_WAKE_REASONS.size,
    );
  });
});

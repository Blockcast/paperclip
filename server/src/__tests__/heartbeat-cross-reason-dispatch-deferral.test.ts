import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyHeartbeatWakeClass } from "../services/heartbeat.js";
import { KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS } from "../services/metrics.js";

/**
 * PEN-6407. `cancelQueuedRunForDuplicateDispatch` cancels a queued run when
 * another run is already dispatched FOR THE SAME ISSUE, and justified it with
 * "the surviving run will continue the work". The gate never read why either
 * run was woken, so that premise was asserted and not checked.
 *
 * Measured over `heartbeat_runs`: of the `github_*` wakes cancelled this way,
 * 22 of 23 on 2026-11-06 and 33 of 47 classifiable on 2026-11-10 had a
 * NON-github incumbent. On `Blockcast/paperclip#3452` all 9 github wakes across
 * a 3h24m review strand were cancelled against a comment-driven incumbent, and
 * none carried `scheduledRetryAt` or any successor — the deliveries were
 * destroyed, not deferred.
 *
 * The asymmetry is the one `isStaleMaintenanceSweepCandidate` already encodes
 * (BLO-35488): an issue-local wake has a successor that re-reads the whole row,
 * a GitHub webhook fires once per push or review request.
 */

const HEARTBEAT_SOURCE = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

/**
 * Slice the dispatch candidate loop out of the service closure.
 *
 * Deliberately a local copy of the slicer in
 * `queued-run-claim-refusal-instrumentation.test.ts` rather than an import:
 * importing a symbol from a `.test.ts` file executes that file's whole suite a
 * second time inside this one, which double-counts ~34 tests and reports any
 * failure in it twice under this file's name.
 */
function readDispatchCandidateLoopSource(source: string): string {
  const start = source.indexOf("        for (const queuedRun of prioritizedRuns) {");
  if (start < 0) throw new Error("dispatch candidate loop not found in heartbeat.ts");
  const rest = source.slice(start);
  const end = rest.indexOf("\n      } catch (err) {");
  if (end < 0) throw new Error("dispatch candidate loop end not found in heartbeat.ts");
  return rest.slice(0, end);
}

describe("classifyHeartbeatWakeClass", () => {
  it("classifies every github webhook reason seen in the census as a webhook wake", () => {
    // Taken from the measured incumbent/arrival population, not invented: these
    // are the reasons that actually appear on cancelled rows.
    for (const wakeReason of [
      "github_pr_review_requested",
      "github_pr_review_submitted",
      "github_check_suite_completed",
      "github_check_completed",
      "github_workflow_completed",
      "github_pr_closed",
      "github_pr_opened",
      "github_pr_merge_queue_evicted",
    ]) {
      expect(classifyHeartbeatWakeClass({ wakeReason })).toBe("github_webhook");
    }
  });

  it("classifies row-local reasons as issue_local", () => {
    for (const wakeReason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_monitor_due",
      "issue_assigned",
      "issue_status_changed",
      "issue_park_expired",
      "issue_blockers_resolved",
      "heartbeat_timer",
    ]) {
      expect(classifyHeartbeatWakeClass({ wakeReason })).toBe("issue_local");
    }
  });

  it("returns null when the class cannot be established, rather than guessing a side", () => {
    // `null` is not a third class — it is the absence of evidence, and the gate
    // reads it as "the duplicate premise is unestablished".
    expect(classifyHeartbeatWakeClass({})).toBeNull();
    expect(classifyHeartbeatWakeClass({ wakeReason: "" })).toBeNull();
    expect(classifyHeartbeatWakeClass({ wakeReason: "   " })).toBeNull();
    expect(classifyHeartbeatWakeClass({ wakeReason: 42 })).toBeNull();
    expect(classifyHeartbeatWakeClass(null)).toBeNull();
    expect(classifyHeartbeatWakeClass(undefined)).toBeNull();
  });

  it("does not match a reason that merely contains 'github'", () => {
    // The gate turns on a PREFIX. A substring match would classify a row-local
    // reason that happens to mention the provider as a webhook delivery and
    // defer a wake that has a successor.
    expect(classifyHeartbeatWakeClass({ wakeReason: "issue_github_link_added" })).toBe(
      "issue_local",
    );
  });
});

describe("the cross-reason deferral gates the cancel", () => {
  const loopSource = readDispatchCandidateLoopSource(HEARTBEAT_SOURCE);

  it("reports an arm the metric allow-list knows", () => {
    expect(
      (KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS as readonly string[]).includes(
        "duplicate_dispatch_cross_reason_deferred",
      ),
    ).toBe(true);
  });

  it("decides the class BEFORE cancelling, not after", () => {
    // Order is the whole fix. The cancel is destructive and irreversible — the
    // wakeup is marked `skipped` and nothing re-delivers it — so the class
    // check has to run first. If a later edit moves the cancel above this
    // branch the gate still compiles, still passes the arm allow-list, and
    // silently goes back to destroying cross-class deliveries.
    const deferralAt = loopSource.indexOf('"duplicate_dispatch_cross_reason_deferred"');
    const cancelAt = loopSource.indexOf("cancelQueuedRunForDuplicateDispatch(");
    expect(deferralAt).toBeGreaterThanOrEqual(0);
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(deferralAt).toBeLessThan(cancelAt);
  });

  it("leaves the deferred row queued — it must not call the cancel on this path", () => {
    // Everything between the deferral arm and its `continue` must be free of a
    // status write. "Deferred" is only true if the row is still claimable.
    const deferralAt = loopSource.indexOf('"duplicate_dispatch_cross_reason_deferred"');
    const continueAt = loopSource.indexOf("continue;", deferralAt);
    expect(continueAt).toBeGreaterThan(deferralAt);
    const branchTail = loopSource.slice(deferralAt, continueAt);
    expect(branchTail).not.toMatch(/setRunStatus|cancelQueuedRun|setWakeupStatus/);
  });
});

describe("the duplicate-dispatch cancel reason", () => {
  it("no longer predicts that the surviving run will do the suppressed work", () => {
    // PEN-6407 done-when 3. The string is user-visible on the cancelled row and
    // was the only account anyone had of why their wake vanished.
    const start = HEARTBEAT_SOURCE.indexOf("async function cancelQueuedRunForDuplicateDispatch(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = HEARTBEAT_SOURCE.slice(start, start + 2_000);
    expect(body).not.toContain("the surviving run will continue the work");
    expect(body).toContain("sibling run is already dispatched");
  });

  it("keeps the routine-execution cancel's wording, which a sibling matches verbatim", () => {
    // Not a duplicate of the assertion above — the opposite direction. The
    // routine-execution cancel sits ~90 lines away and reads almost
    // identically; `recovery/service.ts` matches its text verbatim and
    // `issue-recovery-actions.test.ts` asserts it. Editing the wrong one of the
    // two is the cheap mistake this guards.
    expect(HEARTBEAT_SOURCE).toContain(
      "already owns this dispatch lock; the owner run will continue the work",
    );
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyHeartbeatWakeClass,
  contextCarriesGithubWake,
  describeDuplicateDispatchDeferralMiss,
  mergeCoalescedContextSnapshot,
} from "../services/heartbeat.js";
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
 *
 * Two halves, and the second is NOT a corner case. Deferring leaves the row
 * `queued`, and a queued row is the FIRST coalesce target, so the next
 * `issue_commented` wake merges into it and `{...existing, ...incoming}`
 * overwrites `wakeReason` — after which the row reads issue-local and is
 * cancelled as an ordinary duplicate. On this strand the hold is long precisely
 * because comments keep arriving, so that merge is the normal case. Hence the
 * sticky `carriesGithubWake` marker and the coalesce suite below.
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

/**
 * PEN-6407 review follow-up. A deferred row is a COALESCE TARGET, so the
 * sticky-marker half of the fix is what keeps the deferral from being undone by
 * ordinary comment traffic — which is the normal case on the strand this gate
 * exists for, not a corner case.
 */
describe("github provenance survives a coalesce onto a deferred row", () => {
  const githubRow = {
    issueId: "issue-1",
    wakeReason: "github_pr_review_requested",
    githubPrNumber: 3452,
    githubRepoFullName: "Blockcast/paperclip",
  };

  it("keeps the row readable as a github wake after an issue-local wake merges in", () => {
    // Without the sticky key this is the whole defect: the spread overwrites
    // `wakeReason`, the next pass reads the row as issue-local, and the webhook
    // is cancelled as an ordinary duplicate.
    const merged = mergeCoalescedContextSnapshot(githubRow, {
      issueId: "issue-1",
      wakeReason: "issue_commented",
    });

    expect(merged.wakeReason).toBe("issue_commented");
    expect(classifyHeartbeatWakeClass(merged)).toBe("issue_local");
    expect(contextCarriesGithubWake(merged)).toBe(true);
  });

  it("survives a SECOND coalesce, so a run of comments cannot wear it off", () => {
    const once = mergeCoalescedContextSnapshot(githubRow, {
      issueId: "issue-1",
      wakeReason: "issue_commented",
    });
    const twice = mergeCoalescedContextSnapshot(once, {
      issueId: "issue-1",
      wakeReason: "issue_monitor_due",
    });
    expect(contextCarriesGithubWake(twice)).toBe(true);
  });

  it("survives a coalesce naming a DIFFERENT pull request", () => {
    // `GITHUB_PR_CONTEXT_KEYS` are dropped as a unit when the incoming wake
    // names another PR — which is why the marker must not be one of them. A
    // webhook is still owed a dispatch whichever PR it was for.
    const merged = mergeCoalescedContextSnapshot(githubRow, {
      issueId: "issue-1",
      wakeReason: "issue_commented",
      githubPrNumber: 9999,
      githubRepoFullName: "Blockcast/paperclip",
    });
    expect(contextCarriesGithubWake(merged)).toBe(true);
  });

  it("does NOT invent github provenance where there was none (negative control)", () => {
    // The marker must be earned. Without this, the test above would pass just
    // as well against a helper that returned `true` for everything.
    const merged = mergeCoalescedContextSnapshot(
      { issueId: "issue-1", wakeReason: "issue_assigned" },
      { issueId: "issue-1", wakeReason: "issue_commented" },
    );
    expect(contextCarriesGithubWake(merged)).toBe(false);
    expect(merged.carriesGithubWake).toBeUndefined();
  });

  it("sets the marker when the INCOMING wake is the github one", () => {
    // The other direction: a webhook coalescing onto a queued issue-local row.
    const merged = mergeCoalescedContextSnapshot(
      { issueId: "issue-1", wakeReason: "issue_commented" },
      { issueId: "issue-1", wakeReason: "github_pr_review_requested" },
    );
    expect(contextCarriesGithubWake(merged)).toBe(true);
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

  it("reads the arrival through the sticky marker, not the raw wake class", () => {
    // The one-character difference between the fix and the defect. If this
    // reverts to `arrivalWakeClass === "github_webhook"` the gate still
    // compiles, still defers a freshly-arrived webhook, and silently loses
    // every webhook that a later comment coalesced onto.
    const guard = loopSource.slice(
      loopSource.indexOf("const crossReasonGithubWake"),
      loopSource.indexOf('"duplicate_dispatch_cross_reason_deferred"'),
    );
    expect(guard).toContain("contextCarriesGithubWake(queuedSnapshot)");
    expect(guard).not.toContain('arrivalWakeClass === "github_webhook"');
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
    // PEN-6575 widened this window from 2_000: the function grew a comment
    // block and the reason string now starts past the old cut, so the slice
    // ended BEFORE the text being asserted. A short slice fails toward
    // `not.toContain` passing vacuously, which is the direction that reads green.
    const body = HEARTBEAT_SOURCE.slice(start, start + 4_000);
    expect(body).toContain("sibling run is already dispatched");
    expect(body).not.toContain("the surviving run will continue the work");
  });

  it("no longer asserts that the arriving wake needed no dispatch of its own", () => {
    // PEN-6575 done-when 4. Reaching the cancel establishes only that a sibling
    // is dispatched. Measured 2026-11-13 over 24h77: all 10 `issue_commented`
    // cancels were created AFTER the incumbent had started, so the incumbent's
    // context predates the comment and provably cannot carry it.
    //
    // Asserted over the WHOLE file, not the function slice: the claim is that
    // the literal survives nowhere, so the construct above paraphrases it
    // rather than quoting it. A quotation here would satisfy this test with the
    // defect still live — the junk a worked example generates is indistinguishable
    // from signal.
    expect(HEARTBEAT_SOURCE).not.toContain("does not require its own dispatch");
    expect(HEARTBEAT_SOURCE).not.toContain("require its own dispatch");
  });

  it("tells a non-github arrival which branch of the deferral arm it missed", () => {
    // The retired tail named the github-arrival branch unconditionally, so the
    // largest reader of this string — a non-github arrival, 26 of 112 cancels
    // in the measured window — was pointed at an arm it fails in BOTH positions.
    //
    // PEN-6629 moved the three string-content assertions that used to live here
    // into the executed suite below, where they run against the real return
    // value instead of against a text slice of a 2.3 MB file. What a slice can
    // still say, and nothing else can, is that the reason USES the per-arrival
    // computation rather than a literal: swap the call for a constant and every
    // executed assertion below would still pass on its own fixtures.
    const start = HEARTBEAT_SOURCE.indexOf("async function cancelQueuedRunForDuplicateDispatch(");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = HEARTBEAT_SOURCE.slice(start, start + 4_000);
    // The branch is computed from THIS arrival, not stated unconditionally.
    expect(body).toContain(
      "const deferralMiss = describeDuplicateDispatchDeferralMiss(arrivalSnapshot)",
    );
    // Reaching the cancel falsifies `carriesGithubWake(arrival) && !incumbent.has(github)`,
    // so the two branches are exhaustive — there is no third, unhandled case.
    expect(body).toContain("The duplicate_dispatch_cross_reason_deferred arm did not apply");
  });

  it("no longer names a tracker row as OWNING the population the arm misses", () => {
    // PEN-6629 fix 2, asserted over the WHOLE file for the same reason the
    // assertion above it is: the claim is that the retired literal survives
    // nowhere, so the comment explaining the fix paraphrases it rather than
    // quoting it. A quotation would satisfy this test with the defect live.
    expect(HEARTBEAT_SOURCE).not.toContain("owns the uncovered population");
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

/**
 * PEN-6629. Both claims the cancel reason makes about the arrival, pinned by
 * EXECUTION rather than by slicing `heartbeat.ts` as text.
 *
 * The slice window in the suite above already had to be widened once
 * (2_000 -> 4_000) because the function grew past the cut, and a short slice
 * fails toward `not.toContain` passing vacuously. Nothing here can go vacuous:
 * every assertion runs against a real return value, and the negative controls
 * below would fail against a helper that returned one constant for everything.
 */
describe("describeDuplicateDispatchDeferralMiss", () => {
  it("names the github branch when the incumbent already carries a github wake", () => {
    expect(describeDuplicateDispatchDeferralMiss({ wakeReason: "github_pr_review_requested" })).toContain(
      "the incumbent already carries a github wake",
    );
  });

  it("reads the STICKY marker, not the raw wake class", () => {
    // A webhook that a later comment coalesced onto still belongs in the github
    // branch; `wakeReason` alone reads issue-local by then. Same one-character
    // difference the gate's own guard test pins, on the reason-string side.
    const merged = mergeCoalescedContextSnapshot(
      { issueId: "issue-1", wakeReason: "github_pr_review_requested" },
      { issueId: "issue-1", wakeReason: "issue_commented" },
    );
    expect(classifyHeartbeatWakeClass(merged)).toBe("issue_local");
    expect(describeDuplicateDispatchDeferralMiss(merged)).toContain(
      "the incumbent already carries a github wake",
    );
  });

  it("says issue-local only where the class was actually established", () => {
    for (const wakeReason of ["issue_commented", "issue_comment_mentioned", "issue_monitor_due"]) {
      expect(describeDuplicateDispatchDeferralMiss({ wakeReason })).toContain(
        "this arrival is issue-local",
      );
    }
  });

  it("does NOT assert issue-local for an arrival whose class was never established", () => {
    // PEN-6629 fix 1, and the whole defect. `contextCarriesGithubWake` is false
    // for an unclassifiable arrival as well as an issue-local one, so a single
    // `false` branch spoke for both and asserted a class the code never read.
    // Branch SELECTION was right either way — neither can satisfy the deferral
    // arm — so only the reason given over-claimed. The reason string renders
    // the same `null` as "unclassified" a clause earlier, so the sentence
    // contradicted itself inside one line.
    const unclassifiable: Array<Record<string, unknown> | null | undefined> = [
      {},
      { wakeReason: "" },
      { wakeReason: "   " },
      { wakeReason: 42 },
      null,
      undefined,
    ];
    for (const arrival of unclassifiable) {
      expect(classifyHeartbeatWakeClass(arrival)).toBeNull();
      expect(contextCarriesGithubWake(arrival)).toBe(false);
      const miss = describeDuplicateDispatchDeferralMiss(arrival);
      expect(miss).not.toContain("this arrival is issue-local");
      expect(miss).toContain("no established class");
    }
  });

  it("states the standing decision as fact and cites the rows, naming no owner", () => {
    // PEN-6629 fix 2. The retired tail was a STATUS CLAIM about a tracker row,
    // persisted in a string that admits no adjacent correction — and it does
    // not decay, it INVERTS: PEN-6575 done-when 3 declined the cross-reason
    // widening on measurement, so from the moment that row closed the sentence
    // told a reader somebody was on it when the standing decision is nobody is.
    //
    // Dropping the identifiers is NOT the remedy: a reader of a cancelled run
    // cannot reach the code comment, and those rows are the only address for
    // the census behind the sentence. So they stay, as citations.
    const miss = describeDuplicateDispatchDeferralMiss({ wakeReason: "issue_commented" });
    expect(miss).toContain("measured and declined");
    expect(miss).toContain("PEN-6575");
    expect(miss).toContain("PEN-6625");
    expect(miss).not.toMatch(/\bowns\b/);
  });

  it("names no owner on ANY branch, and discriminates between them (negative control)", () => {
    // Without the second half, every assertion in this suite would also pass
    // against a helper that ignored its argument and returned one constant.
    const github = describeDuplicateDispatchDeferralMiss({
      wakeReason: "github_pr_review_requested",
    });
    const issueLocal = describeDuplicateDispatchDeferralMiss({ wakeReason: "issue_commented" });
    const unclassified = describeDuplicateDispatchDeferralMiss({});
    for (const miss of [github, issueLocal, unclassified]) {
      expect(miss).not.toMatch(/\bowns\b/);
      expect(miss.length).toBeGreaterThan(0);
    }
    expect(new Set([github, issueLocal, unclassified]).size).toBe(3);
  });

  it("returns a clause the reason template can splice without double punctuation", () => {
    // The caller appends "...arm did not apply: ${deferralMiss}." — so a
    // trailing period here would render "...(PEN-6625).." on every cancelled
    // row. Cheap to get wrong while rewording, invisible until someone reads a
    // real cancel.
    for (const arrival of [
      { wakeReason: "github_pr_review_requested" },
      { wakeReason: "issue_commented" },
      {},
    ]) {
      expect(describeDuplicateDispatchDeferralMiss(arrival).endsWith(".")).toBe(false);
    }
  });
});

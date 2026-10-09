// PEN-3633 item 4. The cause of an inherited-workspace-reuse failure must reach
// the issue comment an operator actually reads.
//
// It did not. Both issue-comment summarizers reduce a run error to its first
// non-empty line and then middle-ellipse it at 240 chars (head 119 + "..." +
// tail 118). The old message was composed as one sentence —
//
//   Issue <id> requested inherited execution workspace reuse for <ws>, but the
//   workspace could not be restored because <cause>. <remediation>
//
// — which is 151 chars of context, then the cause, then 186 chars of generic
// remediation. The cause therefore sat in the deleted middle and the
// remediation in the surviving tail, *for every cause length*, so the surface
// reported a 33-run / 8.6 h episode as boilerplate with no diagnosis in it.
//
// The fix is in the producer, not the truncator. `truncateText` has 12 callers,
// and the sibling guarantee "keeps the causal tail of a long plain failure"
// (`recovery/strand-comment-provider-capacity.test.ts`) depends on the
// middle-ellipsis preserving the *tail* for errors whose cause trails a long
// path prefix. That shape wants the opposite bias from this one, so changing
// the truncation mode cannot satisfy both — it would just move the elision onto
// a different failure class. Putting the cause on its own first line keeps the
// remediation out of the summary source entirely instead.
//
// Several cases below carry an explicit LEGACY control: the same cause composed
// the old way, asserted to lose its cause through the same summarizer. Without
// it, a test that merely asserts "the cause is present" would still pass if the
// fix were reverted and the cause happened to be short enough to survive — the
// control proves these assertions discriminate.
import { describe, expect, it } from "vitest";
import {
  provisionExecutionWorkspaceForFreshnessDecision,
  summarizeRunFailureForIssueComment as summarizeOnHeartbeatPath,
} from "./heartbeat.js";
import { summarizeRunFailureForIssueComment as summarizeOnRecoveryPath } from "./recovery/service.js";

const ISSUE_REF = { id: "d0810b79-e7fd-4bd4-8c1b-bb7f6bf4c9d9", identifier: "PEN-3633" };
const RUN_ID = "fe294986-9141-480d-abc8-684a418f0cf5";
const WORKSPACE_ID = "9ba3b757-0b1b-477e-ad8d-aac636837a3e";

// The real episode-2 refusal, 224 chars — the message class this row exists for.
const EPISODE_2_CAUSE =
  'No verified managed checkout exists for expected repository "https://github.com/Blockcast/penstock-llm-proxy-core.git"; ' +
  'refusing to start from "/paperclip/instances/default/projects/b1d3f3d3/1eb0ea12/penstock-llm-proxy-core"';

const REMEDIATION_FAILED =
  "Inspect the referenced execution workspace restore/provision logs, repair or unarchive the workspace, " +
  "or intentionally clear the issue's reuse_existing workspace binding before retrying.";

const FRESHNESS = {
  action: "reuse" as const,
  shouldReuseExisting: true,
  shouldRefreshConfigSnapshot: false,
  reasons: [],
  changedCategories: [],
  storedFingerprint: null,
  inferredFingerprint: null,
  nextFingerprint: null,
  storedFingerprintPresent: false,
};

/** Drive the real producer and return the message it throws. */
async function composeReuseFailure(options: { cause?: unknown; restoreReturnsNull?: boolean }) {
  try {
    await provisionExecutionWorkspaceForFreshnessDecision<{ warnings?: string[] }>({
      requestedShouldReuseExisting: true,
      existingExecutionWorkspaceId: WORKSPACE_ID,
      issueRef: ISSUE_REF,
      runId: RUN_ID,
      workspaceConfigFreshness: FRESHNESS as never,
      restoreExistingWorkspace: async () => {
        if (options.restoreReturnsNull) return null;
        throw options.cause;
      },
      realizeWorkspace: async () => ({}),
    });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected provisionExecutionWorkspaceForFreshnessDecision to throw");
}

/** The pre-fix one-sentence composition, kept only as a discrimination control. */
function composeLegacyOneSentence(cause: string) {
  return (
    `Issue ${ISSUE_REF.identifier} requested inherited execution workspace reuse for ${WORKSPACE_ID}, ` +
    `but the workspace could not be restored because ${cause}. ${REMEDIATION_FAILED}`
  );
}

const asRun = (error: string) => ({ error, errorCode: "setup_failed" }) as never;

describe("inherited execution workspace reuse failure — the cause survives summarization", () => {
  it("retains the causal clause for the real episode-2 refusal, where the legacy shape lost it", async () => {
    const message = await composeReuseFailure({ cause: new Error(EPISODE_2_CAUSE) });

    const summary = summarizeOnRecoveryPath(asRun(message))!;
    expect(summary).toContain("because");
    expect(summary).toContain("No verified managed checkout exists for expected repository");
    // The generic remediation is the text that used to be ALL that survived.
    expect(summary).not.toContain("intentionally clear the issue's reuse_existing");

    // Discrimination control: same cause, legacy composition, same summarizer.
    const legacySummary = summarizeOnRecoveryPath(asRun(composeLegacyOneSentence(EPISODE_2_CAUSE)))!;
    expect(legacySummary).not.toContain("No verified managed checkout exists");
    expect(legacySummary).toContain("intentionally clear the issue's reuse_existing");
  });

  it("holds on the heartbeat-side summarizer too, not just the recovery one", async () => {
    const message = await composeReuseFailure({ cause: new Error(EPISODE_2_CAUSE) });

    const summary = summarizeOnHeartbeatPath(asRun(message))!;
    expect(summary).toContain("No verified managed checkout exists for expected repository");
    expect(summary).not.toContain("intentionally clear the issue's reuse_existing");

    const legacySummary = summarizeOnHeartbeatPath(asRun(composeLegacyOneSentence(EPISODE_2_CAUSE)))!;
    expect(legacySummary).not.toContain("No verified managed checkout exists");
  });

  it("passes a short cause through whole, with no ellipsis at all", async () => {
    const cause = "git rev-parse --git-dir failed: Stale file handle";
    const message = await composeReuseFailure({ cause: new Error(cause) });

    const summary = summarizeOnRecoveryPath(asRun(message))!;
    expect(summary).toContain(cause);
    expect(summary).not.toContain("...");

    // Even a 49-char cause was elided by the legacy shape: the 151-char context
    // prefix alone overran the head window. This is why the bug was not a
    // "cap too small" problem.
    expect(summarizeOnRecoveryPath(asRun(composeLegacyOneSentence(cause)))!).not.toContain(cause);
  });

  it("collapses multi-line git stderr so the whole cause reaches the summary", async () => {
    // git writes multi-line stderr. The summarizers take only the FIRST line, so
    // an uncollapsed cause would reduce the summary to its opening clause and
    // silently drop the operative part — here, the actual path.
    const cause =
      "fatal: detected dubious ownership in repository at '/paperclip/instances/default/projects/b1d3f3d3'\n" +
      "To add an exception for this directory, call:\n" +
      "\tgit config --global --add safe.directory /paperclip/instances/default/projects/b1d3f3d3";
    const message = await composeReuseFailure({ cause: new Error(cause) });

    expect(message.split("\n")[0]).toContain("safe.directory");
    expect(summarizeOnRecoveryPath(asRun(message))!).toContain("fatal: detected dubious ownership");
  });

  it("states the condition when restore reported no workspace and no cause", async () => {
    const message = await composeReuseFailure({ restoreReturnsNull: true });

    const summary = summarizeOnRecoveryPath(asRun(message))!;
    expect(summary).toContain("could not be restored, and no cause was reported");
    expect(summary).not.toContain("intentionally clear the issue's reuse_existing");
  });

  it("keeps the layout the guarantee rests on: cause line, context line, remediation line", async () => {
    const message = await composeReuseFailure({ cause: new Error(EPISODE_2_CAUSE) });
    const lines = message.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`Inherited execution workspace reuse failed because ${EPISODE_2_CAUSE}.`);
    // The ids stay reachable in the full run error even though they leave the summary.
    expect(lines[1]).toContain(ISSUE_REF.identifier);
    expect(lines[1]).toContain(WORKSPACE_ID);
    expect(lines[2]).toBe(REMEDIATION_FAILED);
  });
});

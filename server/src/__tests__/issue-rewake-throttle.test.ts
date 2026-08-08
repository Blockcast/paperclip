import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  ISSUE_REWAKE_MAX_COOLDOWN_MS,
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  type IssueRewakeActivityRow,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-07-12T18:14:00.000Z");
const AGENT_ID = "agent-1";
const OTHER_AGENT_ID = "agent-2";

function runSample(input: {
  id: string;
  status?: string;
  finishedSecondsAgo: number;
}) {
  return {
    id: input.id,
    status: input.status ?? "succeeded",
    finishedAt: new Date(NOW.getTime() - input.finishedSecondsAgo * 1000),
  };
}

function comment(input: { runId?: string | null; agentId: string | null; secondsAgo: number }): IssueRewakeActivityRow {
  return {
    runId: input.runId ?? null,
    action: "issue.comment_added",
    agentId: input.agentId,
    createdAt: new Date(NOW.getTime() - input.secondsAgo * 1000),
  };
}

function mutation(input: { runId?: string | null; agentId: string | null; secondsAgo: number }): IssueRewakeActivityRow {
  return {
    runId: input.runId ?? null,
    action: "issue.updated",
    agentId: input.agentId,
    createdAt: new Date(NOW.getTime() - input.secondsAgo * 1000),
  };
}

describe("isThrottleCandidateIssueRewake", () => {
  const base = {
    reason: "issue_assigned",
    wakeCommentId: null,
    forceFreshSession: false,
    hasExplicitResume: false,
  };

  it("throttles state-poll reasons and reason-less invokes", () => {
    expect(isThrottleCandidateIssueRewake(base)).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: null })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_continuation_needed" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_assignment_recovery" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_graph_liveness_backstop" })).toBe(true);
  });

  it("never throttles wakes that carry new information or an explicit escalation", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, wakeCommentId: "comment-1" })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(false);
  });

  it("passes event-shaped wake reasons through", () => {
    for (const reason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_monitor_due",
      "process_lost_retry",
      "run_liveness_continuation",
    ]) {
      expect(isThrottleCandidateIssueRewake({ ...base, reason })).toBe(false);
    }
  });
});

describe("computeIssueRewakeCooldownMs", () => {
  it("starts at the base cooldown and doubles per extra no-progress run, capped", () => {
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 3)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 8);
    expect(computeIssueRewakeCooldownMs(100)).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
  });
});

describe("evaluateIssueRewakeThrottle", () => {
  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [],
        activityRows: [],
      }),
    ).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      activityRows: [],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks inside the cooldown once the streak reaches the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      activityRows: [],
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_BASE_COOLDOWN_MS,
      );
    }
  });

  it("allows again after the cooldown elapses", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 1 }),
        runSample({ id: "r1", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 30 }),
      ],
      activityRows: [],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 2 });
  });

  it("escalates the cooldown as the streak grows", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 30 }),
        runSample({ id: "r2", finishedSecondsAgo: 60 }),
        runSample({ id: "r1", finishedSecondsAgo: 90 }),
      ],
      activityRows: [],
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("resets at the most recent run with a real mutation", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      activityRows: [mutation({ runId: "r2", agentId: AGENT_ID, secondsAgo: 41 })],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      activityRows: [],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      activityRows: [mutation({ agentId: OTHER_AGENT_ID, secondsAgo: 5 })],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  // BLO-23081: a self-authored status comment must not be able to defeat the
  // throttle it is supposed to be subject to.
  describe("self-authored vs. foreign-authored comments (BLO-23081)", () => {
    it("a self-authored comment on the run itself does not count as progress", () => {
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        // r2's only issue-visible activity is its own status comment.
        activityRows: [comment({ runId: "r2", agentId: AGENT_ID, secondsAgo: 11 })],
      });
      expect(decision.blocked).toBe(true);
      if (decision.blocked) expect(decision.noProgressStreak).toBe(2);
    });

    it("a self-authored comment posted after the last run does not count as new input", () => {
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        // Same-agent comment landing after r2 finished — e.g. a second run
        // that only posted a status ping and produced no run record here.
        activityRows: [comment({ agentId: AGENT_ID, secondsAgo: 5 })],
      });
      expect(decision.blocked).toBe(true);
      if (decision.blocked) expect(decision.noProgressStreak).toBe(2);
    });

    it("a comment attributed to a run never counts as that run's progress, regardless of author", () => {
      // comment_added is excluded from the progress-action set entirely: a
      // run must leave a real mutation behind, not just any comment. Author
      // only matters for the separate new-input bypass, checked below.
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        activityRows: [comment({ runId: "r2", agentId: OTHER_AGENT_ID, secondsAgo: 11 })],
      });
      expect(decision.blocked).toBe(true);
      if (decision.blocked) expect(decision.noProgressStreak).toBe(2);
    });

    it("a foreign-agent comment after the last run bypasses the throttle immediately", () => {
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        activityRows: [comment({ agentId: OTHER_AGENT_ID, secondsAgo: 5 })],
      });
      expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
    });

    it("a board-user comment (null agentId) bypasses the throttle immediately", () => {
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        activityRows: [comment({ agentId: null, secondsAgo: 5 })],
      });
      expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
    });

    it("commenting alongside a real mutation in the same run still counts as progress", () => {
      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: [
          runSample({ id: "r2", finishedSecondsAgo: 10 }),
          runSample({ id: "r1", finishedSecondsAgo: 40 }),
        ],
        activityRows: [
          comment({ runId: "r2", agentId: AGENT_ID, secondsAgo: 11 }),
          mutation({ runId: "r2", agentId: AGENT_ID, secondsAgo: 11 }),
        ],
      });
      expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
    });

    it("escalates a self-commenting agent's cooldown to the 30-minute cap within 6 no-progress runs", () => {
      // Six consecutive runs, each finishing 5 minutes apart, each leaving
      // only a self-authored status comment behind. The wake attempted right
      // after each run finishes must eventually be held back until the
      // escalating cooldown reaches the 30-minute ceiling.
      const runs = Array.from({ length: 6 }, (_, i) =>
        runSample({ id: `r${6 - i}`, finishedSecondsAgo: (i + 1) * 300 }),
      );
      const activityRows = runs.map((run) =>
        comment({ runId: run.id, agentId: AGENT_ID, secondsAgo: (NOW.getTime() - run.finishedAt!.getTime()) / 1000 }),
      );

      const decision = evaluateIssueRewakeThrottle({
        now: NOW,
        agentId: AGENT_ID,
        recentTerminalRuns: runs,
        activityRows,
      });

      expect(decision.blocked).toBe(true);
      if (decision.blocked) {
        expect(decision.noProgressStreak).toBe(6);
        expect(decision.cooldownMs).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
      }
    });
  });

  it("does not delay recovery after a failed run even when it carries a self-comment", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      agentId: AGENT_ID,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      activityRows: [comment({ runId: "r2", agentId: AGENT_ID, secondsAgo: 11 })],
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});

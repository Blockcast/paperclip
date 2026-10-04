import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueExecutionPolicy, TrustAuthorizationPolicy } from "@paperclipai/shared";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000002";
const ISSUE_ID = "00000000-0000-4000-8000-00000000000a";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REVIEW_PRESET = {
  id: "low_trust_review",
  version: 1,
  rawOutputDisposition: "quarantine",
} as const;

const AUTHORIZATION_POLICY: TrustAuthorizationPolicy = {
  trustPreset: "low_trust_review",
  reviewPreset: REVIEW_PRESET,
  trustBoundary: {
    mode: "low_trust_review",
    allowedAgentIds: [AGENT_ID],
    allowedToolClasses: ["git.read", "tests.local"],
    allowedSecretBindingIds: [],
    outputPromotionTarget: { type: "issue", issueId: ISSUE_ID },
  },
};

function policy(overrides: Partial<IssueExecutionPolicy> = {}): IssueExecutionPolicy {
  return { mode: "normal", commentRequired: true, stages: [], ...overrides };
}

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });

  // BLO-39945: the board UI sends a whole-policy REPLACE, so anything this
  // helper fails to re-emit is silently deleted on the next reviewer toggle.
  describe("productivityReviewDisabled carry-forward", () => {
    const optedOut: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [],
      productivityReviewDisabled: true,
    };

    it("survives a reviewer toggle on a stageless, monitorless, opted-out row", () => {
      const policy = buildExecutionPolicy({
        existingPolicy: optedOut,
        reviewerValues: [`agent:${AGENT_ID}`],
        approverValues: [],
      });

      expect(policy?.productivityReviewDisabled).toBe(true);
      expect(policy?.stages).toHaveLength(1);
      expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    });

    it("blocks the collapse to null when the flag is the only thing in the policy", () => {
      // Guards the `:110` collapse directly: clearing the last reviewer off an
      // opted-out row must not return null, or the opt-out goes with it.
      const policy = buildExecutionPolicy({
        existingPolicy: optedOut,
        reviewerValues: [],
        approverValues: [],
      });

      expect(policy).not.toBeNull();
      expect(policy?.productivityReviewDisabled).toBe(true);
    });

    // Negative controls — without these both tests above pass on code that
    // sets the flag unconditionally and never collapses.
    it("still collapses to null when the flag is absent", () => {
      expect(
        buildExecutionPolicy({
          existingPolicy: { mode: "normal", commentRequired: true, stages: [] },
          reviewerValues: [],
          approverValues: [],
        }),
      ).toBeNull();
    });

    it("does not invent the flag on a policy that never carried it", () => {
      const policy = buildExecutionPolicy({
        existingPolicy: null,
        reviewerValues: [`agent:${AGENT_ID}`],
        approverValues: [],
      });

      expect(policy).not.toBeNull();
      expect(policy).not.toHaveProperty("productivityReviewDisabled");
    });
  });

  // BLO-40082. `PATCH /issues/:id` replaces the whole policy with no server-side
  // merge, so anything this helper fails to re-emit is deleted.
  describe("carries non-rebuilt policy fields through a board edit (BLO-40082)", () => {
    it("preserves authorizationPolicy and reviewPreset when a reviewer is toggled on", () => {
      const existingPolicy = policy({
        reviewPreset: REVIEW_PRESET,
        authorizationPolicy: AUTHORIZATION_POLICY,
      });

      const next = buildExecutionPolicy({
        existingPolicy,
        reviewerValues: [`agent:${OTHER_AGENT_ID}`],
        approverValues: [],
      });

      expect(next?.authorizationPolicy).toEqual(existingPolicy.authorizationPolicy);
      expect(next?.reviewPreset).toEqual(existingPolicy.reviewPreset);
      // Deep-equal, not merely present: the boundary's contents are the payload.
      expect(next?.authorizationPolicy?.trustBoundary).toEqual({
        mode: "low_trust_review",
        allowedAgentIds: [AGENT_ID],
        allowedToolClasses: ["git.read", "tests.local"],
        allowedSecretBindingIds: [],
        outputPromotionTarget: { type: "issue", issueId: ISSUE_ID },
      });
      expect(next?.stages).toHaveLength(1);
      expect(issueExecutionPolicySchema.safeParse(next).success).toBe(true);
    });

    it("preserves them when the last reviewer is removed, instead of collapsing to null", () => {
      const existingPolicy = policy({
        stages: [{
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "22222222-2222-4222-8222-222222222222", type: "agent", agentId: AGENT_ID, userId: null }],
        }],
        reviewPreset: REVIEW_PRESET,
        authorizationPolicy: AUTHORIZATION_POLICY,
      });

      const next = buildExecutionPolicy({ existingPolicy, reviewerValues: [], approverValues: [] });

      expect(next).not.toBeNull();
      expect(next?.stages).toEqual([]);
      expect(next?.authorizationPolicy).toEqual(AUTHORIZATION_POLICY);
      expect(next?.reviewPreset).toEqual(REVIEW_PRESET);
    });

    it("does not collapse a policy whose only content is a reviewPreset", () => {
      const next = buildExecutionPolicy({
        existingPolicy: policy({ reviewPreset: REVIEW_PRESET }),
        reviewerValues: [],
        approverValues: [],
      });

      expect(next).not.toBeNull();
      expect(next?.reviewPreset).toEqual(REVIEW_PRESET);
    });

    it("does not collapse a policy whose only content is an authorizationPolicy", () => {
      const next = buildExecutionPolicy({
        existingPolicy: policy({ authorizationPolicy: AUTHORIZATION_POLICY }),
        reviewerValues: [],
        approverValues: [],
      });

      expect(next).not.toBeNull();
      expect(next?.authorizationPolicy).toEqual(AUTHORIZATION_POLICY);
    });

    // Negative controls. Without these the four tests above also pass on an
    // implementation that emits the keys unconditionally, or that never
    // collapses at all.
    it("still collapses to null when nothing but the rebuilt fields is present", () => {
      expect(buildExecutionPolicy({
        existingPolicy: policy(),
        reviewerValues: [],
        approverValues: [],
      })).toBeNull();

      expect(buildExecutionPolicy({
        existingPolicy: policy({
          stages: [{
            id: "11111111-1111-4111-8111-111111111111",
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "22222222-2222-4222-8222-222222222222", type: "agent", agentId: AGENT_ID, userId: null }],
          }],
        }),
        reviewerValues: [],
        approverValues: [],
      })).toBeNull();
    });

    it("invents no keys for a policy that carries neither field", () => {
      const next = buildExecutionPolicy({
        existingPolicy: policy({
          monitor: { nextCheckAt: "2026-04-11T12:30:00.000Z", notes: "re-check", scheduledBy: "board" },
        }),
        reviewerValues: [`agent:${AGENT_ID}`],
        approverValues: [],
      });

      expect(Object.keys(next ?? {}).sort()).toEqual(["commentRequired", "mode", "monitor", "stages"]);
    });

    // An explicit `monitor: null` is the one carried value that would survive
    // the spread as an invented key, and it is the only mutation of the
    // destructure list that the tests above do not already catch.
    it("treats an explicit monitor:null as rebuilt, not as content worth carrying", () => {
      const withNullMonitor = { ...policy(), monitor: null } as IssueExecutionPolicy;

      expect(buildExecutionPolicy({
        existingPolicy: withNullMonitor,
        reviewerValues: [],
        approverValues: [],
      })).toBeNull();

      const next = buildExecutionPolicy({
        existingPolicy: withNullMonitor,
        reviewerValues: [`agent:${AGENT_ID}`],
        approverValues: [],
      });
      expect(Object.keys(next ?? {}).sort()).toEqual(["commentRequired", "mode", "stages"]);
    });

    it("rebuilt fields win over the carried copy", () => {      const next = buildExecutionPolicy({
        existingPolicy: policy({
          commentRequired: false,
          stages: [{
            id: "11111111-1111-4111-8111-111111111111",
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: "22222222-2222-4222-8222-222222222222", type: "agent", agentId: AGENT_ID, userId: null }],
          }],
          authorizationPolicy: AUTHORIZATION_POLICY,
        }),
        reviewerValues: [],
        approverValues: [],
      });

      expect(next?.commentRequired).toBe(true);
      expect(next?.stages).toEqual([]);
    });
  });
});

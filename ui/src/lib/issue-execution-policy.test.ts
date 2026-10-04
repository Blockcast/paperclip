import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema, type IssueExecutionPolicy } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
});

import { describe, expect, it } from "vitest";
import {
  ISSUE_RECOVERY_ACTION_RESOLVE_ROUTE,
  RESOLVE_ISSUE_RECOVERY_ACTION_OUTCOMES,
  RESTORED_CONTRADICTING_ISSUE_STATUSES,
  buildManualResolutionGuidance,
  isContradictedRestoredClaim,
  issueRecoveryActionResolvePath,
  resolveIssueRecoveryActionSchema,
} from "./validators/issue.js";

/**
 * PEN-5707. These assertions are not style checks — each one pins a sentence whose
 * ABSENCE is a measured, reproduced wrong conclusion by a competent reader:
 *
 *   - no route             => four path-shaped guesses, all 404, written up as
 *                             "the disposition cannot be recorded in the field built
 *                             for it", then propagated to three other seats;
 *   - no "body" note       => the id goes in the path, which is the one-segment trap;
 *   - no "omit" note       => the `sourceIssueStatus` enum has no `in_progress`
 *                             member, so a reader concludes that discharging a live
 *                             row requires falsifying its status (it does not);
 *   - no outcome list      => the agent reaches for the verb in the prose, "restore",
 *                             on cases it does not fit (PEN-3991).
 */
const ISSUE_ID = "d0e00907-d164-4bf3-8131-95f1378661a3";

describe("issueRecoveryActionResolvePath", () => {
  it("renders the mounted route for a concrete issue", () => {
    expect(issueRecoveryActionResolvePath(ISSUE_ID)).toBe(
      `/issues/${ISSUE_ID}/recovery-actions/resolve`,
    );
  });

  it("keeps `resolve` a literal segment with no action id before it", () => {
    // The whole PEN-5707 trap: every natural guess inserts the action id here.
    expect(ISSUE_RECOVERY_ACTION_RESOLVE_ROUTE).toMatch(/\/recovery-actions\/resolve$/);
    expect(ISSUE_RECOVERY_ACTION_RESOLVE_ROUTE).not.toContain(":actionId");
  });
});

describe("buildManualResolutionGuidance", () => {
  const guidance = buildManualResolutionGuidance(ISSUE_ID);

  it("names the route it is registered at", () => {
    // Pins the prose to the mounted path. `routes/issues.ts` registers the endpoint
    // from ISSUE_RECOVERY_ACTION_RESOLVE_ROUTE, so a rename moves both or fails here.
    expect(guidance).toContain(issueRecoveryActionResolvePath(ISSUE_ID));
    expect(guidance).toContain("POST");
  });

  it("says the action id is optional and belongs in the body", () => {
    expect(guidance).toContain('"actionId" is OPTIONAL and belongs in the BODY');
    expect(guidance).toContain("never in the path");
  });

  it("says omitting sourceIssueStatus leaves the status untouched", () => {
    expect(guidance).toContain('OMIT "sourceIssueStatus"');
    expect(guidance).toContain("in_progress");
  });

  it("names every resolve outcome, derived from the enum", () => {
    // Derived, not retyped: a new outcome cannot land without this text moving.
    for (const outcome of RESOLVE_ISSUE_RECOVERY_ACTION_OUTCOMES) {
      expect(guidance).toContain(outcome);
    }
  });

  it("names the constraints that make an outcome refuse, not just the vocabulary", () => {
    expect(guidance).toContain("board-only");
    expect(guidance).toContain("unresolved first-class blocker");
    expect(guidance).toContain("restored_unverified");
  });

  // PEN-5714 Part B.1: the route and the example body are the two fragments a
  // reader copy-pastes. Unspanned, they render proportional and the {"..."}
  // quoting blends into the surrounding prose quotes.
  it("renders the route and the example body as code spans", () => {
    expect(guidance).toContain(`\`POST ${issueRecoveryActionResolvePath(ISSUE_ID)}\``);
    expect(guidance).toContain('`{"outcome":"restored","resolutionNote":"<why>"}`');
  });

  // PEN-5714 Part B.2: disclosing the downgrade is not the same as naming the
  // way out of it. The copy-paste example omits `sourceIssueStatus`, and on an
  // already-`blocked` row that records `restored_unverified` -- truthfully, but
  // a reader who wants a verified `restored` was left to derive the field.
  it("names the verified hand-back path, not just the downgrade", () => {
    expect(guidance).toContain('`"sourceIssueStatus":"todo"`');
    expect(guidance).toContain("VERIFIED");
  });

  it("names a hand-back status the schema actually accepts for `restored`", () => {
    // The sentence above is only worth adding if it is true: `todo` has to pass
    // the schema AND clear the contradiction check. Derived from the exported
    // constant, so widening the contradicting set fails here rather than
    // leaving the prose quietly wrong.
    expect(resolveIssueRecoveryActionSchema.safeParse({
      outcome: "restored",
      sourceIssueStatus: "todo",
    }).success).toBe(true);
    expect(RESTORED_CONTRADICTING_ISSUE_STATUSES as readonly string[]).not.toContain("todo");
    expect(isContradictedRestoredClaim({
      requestedSourceIssueStatus: "todo",
      currentIssueStatus: "blocked",
    })).toBe(false);
    // Control: the same call WITHOUT the field is the downgrade the prose warns
    // about, so this pair shows the sentence changes the outcome.
    expect(isContradictedRestoredClaim({
      requestedSourceIssueStatus: null,
      currentIssueStatus: "blocked",
    })).toBe(true);
  });
});

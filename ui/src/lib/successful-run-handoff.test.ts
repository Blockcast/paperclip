import { describe, expect, it } from "vitest";
import { ISSUE_STATUS_ADJUDICATION_DOCUMENT_KEY, ISSUE_STATUS_ADJUDICATION_DOCUMENT_ROUTE } from "@paperclipai/shared";
import {
  SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_PREFIX,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX,
  SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION,
  isSuccessfulRunHandoffComment,
  isSuccessfulRunHandoffEscalationComment,
  successfulRunHandoffActivityTone,
} from "./successful-run-handoff";

describe("successful run handoff UI helpers", () => {
  it("matches both required and escalated production comments", () => {
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toBe(true);
    expect(isSuccessfulRunHandoffComment("## This issue still needs a next step\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment("## Successful run missing issue disposition\n\n- Source run: abc")).toBe(true);
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY)).toBe(true);
    expect(
      isSuccessfulRunHandoffComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(
      isSuccessfulRunHandoffEscalationComment(
        "Paperclip exhausted the bounded successful-run handoff correction for this issue, but it still has no clear next-step disposition.",
      ),
    ).toBe(true);
    expect(isSuccessfulRunHandoffComment("Ordinary issue comment")).toBe(false);
  });

  // PEN-7126: both matchers above tested the body by EQUALITY. The server
  // bodies now carry the status-adjudication carrier sentence after their
  // historical first sentence, and every notice already in the database carries
  // that sentence alone — so a prefix test is what keeps both shapes rendering
  // as system notices instead of as ordinary agent comments.
  it("classifies both the pre-carrier and the current notice bodies (PEN-7126)", () => {
    expect(isSuccessfulRunHandoffComment(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX)).toBe(true);
    expect(isSuccessfulRunHandoffEscalationComment(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_PREFIX)).toBe(true);
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY).toContain(ISSUE_STATUS_ADJUDICATION_DOCUMENT_KEY);
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY).toContain(ISSUE_STATUS_ADJUDICATION_DOCUMENT_ROUTE);
    expect(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY).toContain(ISSUE_STATUS_ADJUDICATION_DOCUMENT_ROUTE);
    // Control: the prefixes do not already carry the key, so the assertions
    // above test the appended sentence rather than pre-existing text.
    expect(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_PREFIX).not.toContain(ISSUE_STATUS_ADJUDICATION_DOCUMENT_KEY);
  });

  it("returns shared tones for required, escalated, and neutral activity", () => {
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_REQUIRED_ACTION).className).toContain("amber");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_ESCALATED_ACTION).className).toContain("red");
    expect(successfulRunHandoffActivityTone(SUCCESSFUL_RUN_HANDOFF_RESOLVED_ACTION).className).toContain("border");
  });
});

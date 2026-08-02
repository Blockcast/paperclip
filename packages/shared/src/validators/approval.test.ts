import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";
import { APPROVAL_TYPES } from "../constants.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });
});

describe("createApprovalSchema payload.title requirement", () => {
  it.each(APPROVAL_TYPES)("rejects an absent payload.title for type %s", (type) => {
    expect(() =>
      createApprovalSchema.parse({
        type,
        payload: { summary: "Rich context but no title" },
      }),
    ).toThrowError(/payload\.title/);
  });

  it.each(APPROVAL_TYPES)("rejects an empty-string payload.title for type %s", (type) => {
    expect(() => createApprovalSchema.parse({ type, payload: { title: "" } })).toThrowError(
      /payload\.title/,
    );
  });

  it.each(APPROVAL_TYPES)("rejects a whitespace-only payload.title for type %s", (type) => {
    expect(() => createApprovalSchema.parse({ type, payload: { title: "   " } })).toThrowError(
      /payload\.title/,
    );
  });

  it("names the payload.title field on the thrown ZodError so callers can self-correct", () => {
    try {
      createApprovalSchema.parse({ type: "request_board_approval", payload: {} });
      expect.unreachable("expected parse to throw");
    } catch (err) {
      const zodError = err as { issues: Array<{ path: unknown[]; message: string }> };
      expect(zodError.issues).toContainEqual(
        expect.objectContaining({
          path: ["payload", "title"],
          message: expect.stringContaining("payload.title"),
        }),
      );
    }
  });

  it.each(APPROVAL_TYPES)("accepts a non-empty payload.title for type %s", (type) => {
    expect(() =>
      createApprovalSchema.parse({ type, payload: { title: "Approve hosting spend" } }),
    ).not.toThrow();
  });
});

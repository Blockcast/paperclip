import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  listApprovalsQuerySchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

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
  // BLO-19132: dedupe token + cheap existence check.

  it("accepts an idempotency key on create and trims it", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: { title: "Rotate credentials" },
      idempotencyKey: "  rotate-creds-blo-18969  ",
    });
    expect(parsed.idempotencyKey).toBe("rotate-creds-blo-18969");
  });

  it("keeps the idempotency key optional so existing callers are unaffected", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: { title: "Rotate credentials" },
    });
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it("rejects an empty or oversized idempotency key", () => {
    const base = { type: "request_board_approval", payload: {} };
    expect(createApprovalSchema.safeParse({ ...base, idempotencyKey: "   " }).success).toBe(false);
    expect(createApprovalSchema.safeParse({ ...base, idempotencyKey: "x".repeat(256) }).success).toBe(false);
    expect(createApprovalSchema.safeParse({ ...base, idempotencyKey: "x".repeat(255) }).success).toBe(true);
  });

  it("defaults the listing view to full so the existing listing contract is unchanged", () => {
    expect(listApprovalsQuerySchema.parse({}).view).toBe("full");
  });

  it("accepts the cheap listing views and the narrowing filters", () => {
    const parsed = listApprovalsQuerySchema.parse({
      view: "summary",
      status: "pending",
      type: "request_board_approval",
      issueId: "00000000-0000-0000-0000-000000000001",
    });
    expect(parsed).toMatchObject({ view: "summary", status: "pending" });
    expect(listApprovalsQuerySchema.parse({ view: "count" }).view).toBe("count");
  });

  it("rejects an unknown view and an unknown status rather than coercing them", () => {
    expect(listApprovalsQuerySchema.safeParse({ view: "everything" }).success).toBe(false);
    expect(listApprovalsQuerySchema.safeParse({ status: "pendinggg" }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  listApprovalsQuerySchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
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
    const base = { type: "request_board_approval", payload: { title: "Rotate credentials" } };
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

  it("exposes payload.title as a structural field for MCP/tool contracts", () => {
    const payloadSchema = createApprovalSchema.shape.payload;
    expect(Object.keys(payloadSchema.shape)).toContain("title");
    expect(payloadSchema.safeParse({ branch: "pap-1167" }).success).toBe(false);
    expect(payloadSchema.safeParse({ title: "Approve hosting spend", branch: "pap-1167" }).success)
      .toBe(true);
  });
});

describe("resubmitApprovalSchema payload.title requirement", () => {
  it("allows resubmission without a replacement payload", () => {
    expect(resubmitApprovalSchema.parse({})).toEqual({});
  });

  it.each([
    ["absent", {}],
    ["empty string", { title: "" }],
    ["whitespace-only", { title: "   " }],
  ])("rejects a replacement payload with a %s payload.title", (_case, payload) => {
    expect(() => resubmitApprovalSchema.parse({ payload })).toThrowError(/payload\.title/);
  });

  it("accepts a replacement payload with a non-empty payload.title and extra fields", () => {
    expect(resubmitApprovalSchema.parse({
      payload: { title: "Revise agent hire", branch: "pap-1167" },
    })).toEqual({
      payload: { title: "Revise agent hire", branch: "pap-1167" },
    });
  });
});

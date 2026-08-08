import { describe, expect, it, vi } from "vitest";
import { approvals } from "@paperclipai/db";
import { insertApproval, insertApprovalRecord } from "../services/approval-insert.js";

function makeDb() {
  const returning = vi.fn(async () => [{ id: "approval-1" }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as any, insert, values };
}

describe("insertApproval", () => {
  it("inserts an internal approval with a non-empty title", async () => {
    const { db, insert, values } = makeDb();

    await insertApproval(db, {
      companyId: "company-1",
      type: "budget_override_required",
      status: "pending",
      payload: { title: "Budget override: production" },
    } as any);

    expect(insert).toHaveBeenCalledWith(approvals);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("rejects a blank title before writing", () => {
    const { db, insert } = makeDb();

    expect(() => insertApproval(db, {
      companyId: "company-1",
      type: "budget_override_required",
      status: "pending",
      payload: { title: "   " },
    } as any)).toThrow(/non-empty string/);

    expect(insert).not.toHaveBeenCalled();
  });
});

describe("insertApprovalRecord", () => {
  it.each(["title", "name", "summary", "recommendedAction"])(
    "accepts a non-empty %s as an approval-card subject",
    async (key) => {
      const { db, values } = makeDb();
      const subject = "Human-readable approval subject";

      await insertApprovalRecord(db, {
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        payload: { [key]: subject, title: key === "title" ? subject : null },
      } as any);

      expect(values).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a payload with no usable subject before writing", () => {
    const { db, insert } = makeDb();

    expect(() => insertApprovalRecord(db, {
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: { title: " ", name: "", summary: null, scopeId: "scope-1" },
    } as any)).toThrow(/title, name, summary, or recommendedAction/);

    expect(insert).not.toHaveBeenCalled();
  });
});

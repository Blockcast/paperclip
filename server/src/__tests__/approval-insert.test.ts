import { describe, expect, it, vi } from "vitest";
import { approvals } from "@paperclipai/db";
import { insertApproval, insertApprovalRecord } from "../services/approval-insert.js";

function makeDb() {
  const returning = vi.fn(async () => [{ id: "approval-1" }]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as any, insert, values, returning };
}

describe("insertApproval", () => {
  it("inserts when payload.title is a non-empty string", async () => {
    const { db, insert, values } = makeDb();
    await insertApproval(db, {
      companyId: "company-1",
      type: "budget_override_required",
      status: "pending",
      payload: { title: "Budget override: prod exceeded billed_cents hard cap" },
    } as any);
    expect(insert).toHaveBeenCalledWith(approvals);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("throws on a blank payload.title without touching the db", async () => {
    const { db, insert } = makeDb();
    expect(() =>
      insertApproval(db, {
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
        payload: { title: "   " },
      } as any),
    ).toThrow(/non-empty string/);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("insertApprovalRecord", () => {
  it("inserts when the payload has a title", async () => {
    const { db, values } = makeDb();
    await insertApprovalRecord(db, {
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Approve pricing change" },
    } as any);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("inserts when the payload only has a name (hire_agent's job-title-as-null case)", async () => {
    const { db, values } = makeDb();
    await insertApprovalRecord(db, {
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: { name: "New Agent", title: null },
    } as any);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("inserts when the payload only has a summary or recommendedAction", async () => {
    const { db, values } = makeDb();
    await insertApprovalRecord(db, {
      companyId: "company-1",
      type: "approve_ceo_strategy",
      status: "pending",
      payload: { summary: "Q3 pricing strategy" },
    } as any);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("throws when the payload has no title, name, summary, or recommendedAction", async () => {
    const { db, insert } = makeDb();
    expect(() =>
      insertApprovalRecord(db, {
        companyId: "company-1",
        type: "request_board_approval",
        status: "pending",
        payload: { scopeId: "scope-1" },
      } as any),
    ).toThrow(/title, name, summary, or recommendedAction/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("throws when every subject field is blank", async () => {
    const { db, insert } = makeDb();
    expect(() =>
      insertApprovalRecord(db, {
        companyId: "company-1",
        type: "request_board_approval",
        status: "pending",
        payload: { title: "  ", name: "", summary: null },
      } as any),
    ).toThrow(/title, name, summary, or recommendedAction/);
    expect(insert).not.toHaveBeenCalled();
  });
});

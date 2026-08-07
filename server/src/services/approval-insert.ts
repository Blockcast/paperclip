import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";

type ApprovalInsertValues = typeof approvals.$inferInsert;

/**
 * Shared choke point for server-internal approval producers that build
 * `db.insert(approvals)` values themselves, bypassing routes/approvals.ts
 * and the `createApprovalSchema` Zod validation that runs there. Requiring
 * `payload.title` in this function's own type turns a forgotten title into
 * a compile error instead of an untitled, structurally-undecidable board
 * card. See BLO-21032 (blank-title cards) and BLO-22705 (this guard).
 */
export function insertApproval(
  db: Db,
  values: Omit<ApprovalInsertValues, "payload"> & {
    payload: ApprovalInsertValues["payload"] & { title: string };
  },
) {
  if (!values.payload.title.trim()) {
    throw new Error("insertApproval: payload.title must be a non-empty string");
  }
  return db.insert(approvals).values(values);
}

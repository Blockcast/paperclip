import type { Db } from "@paperclipai/db";
import { approvals } from "@paperclipai/db";

type ApprovalInsertValues = typeof approvals.$inferInsert;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Choke point for server-internal producers that construct an approval row
 * directly rather than using the HTTP route's approval schema.
 */
export function insertApproval(
  db: Db,
  values: Omit<ApprovalInsertValues, "payload"> & {
    payload: ApprovalInsertValues["payload"] & { title: string };
  },
) {
  if (!isNonBlankString(values.payload.title)) {
    throw new Error("insertApproval: payload.title must be a non-empty string");
  }
  return db.insert(approvals).values(values);
}

const APPROVAL_SUBJECT_KEYS = ["title", "name", "summary", "recommendedAction"] as const;

function hasApprovalSubject(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return APPROVAL_SUBJECT_KEYS.some((key) => isNonBlankString(record[key]));
}

/**
 * Choke point for approvalService.create(). Some valid internal hire payloads
 * use `name` as the board-card subject while `title` is nullable job metadata.
 */
export function insertApprovalRecord(db: Db, values: ApprovalInsertValues) {
  if (!hasApprovalSubject(values.payload)) {
    throw new Error(
      "insertApprovalRecord: payload must include a non-empty title, name, summary, or recommendedAction",
    );
  }
  return db.insert(approvals).values(values).returning();
}

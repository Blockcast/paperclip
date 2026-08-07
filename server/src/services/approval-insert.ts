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

// Mirrors ui/src/components/ApprovalPayload.tsx's approvalSubject() fallback
// chain. Kept in sync manually (server and ui do not share a validators
// package for this) rather than requiring literal `title`, because
// `payload.title` is overloaded: for a hire_agent payload it is the hired
// agent's own (legitimately nullable) job title, not the card subject, and
// `payload.name` already covers the card there.
const APPROVAL_SUBJECT_KEYS = ["title", "name", "summary", "recommendedAction"] as const;

function hasApprovalSubject(payload: Record<string, unknown>): boolean {
  return APPROVAL_SUBJECT_KEYS.some(
    (key) => typeof payload[key] === "string" && payload[key].trim().length > 0,
  );
}

/**
 * Choke point for approvalService(db).create() — the generic, caller-supplied-
 * payload entrypoint used by both the HTTP route (already validated by
 * createApprovalSchema) and internal callers building hire_agent payloads.
 * Because hire_agent's `payload.title` is job-title metadata rather than a
 * card subject (see above), this only requires that SOME subject field is
 * present, not `title` specifically. Every other db.insert(approvals) call
 * site in server/src must go through here or insertApproval() above — see
 * approval-payload-title-guard.test.ts, which enforces that structurally.
 */
export function insertApprovalRecord(db: Db, values: ApprovalInsertValues) {
  const payload = values.payload as Record<string, unknown>;
  if (!hasApprovalSubject(payload)) {
    throw new Error(
      "insertApprovalRecord: payload must include a non-empty title, name, summary, or recommendedAction",
    );
  }
  return db.insert(approvals).values(values).returning();
}

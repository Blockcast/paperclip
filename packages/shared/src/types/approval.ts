import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  linkedAgentId: string | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  /**
   * The edit marker (PEN-5766). `payloadRevision` counts in-place payload edits and
   * is 0 on a card that has never been edited; `payloadEditedAt` is when the last
   * edit landed, or null if there was none. These are what make an editable payload
   * safe: a decider can see that a card's text moved after it was filed. Superseded
   * versions are readable at `GET /approvals/:id/payload-revisions`.
   *
   * ⚠️ Any surface that offers a decision MUST render this, not merely carry it
   * (PEN-6107). Prevention — an `expectedPayloadRevision` interlock on the decision
   * routes — was deliberately deferred, so disclosure is the whole mitigation, and a
   * field present on the wire but absent from the screen discloses nothing.
   */
  payloadRevision: number;
  payloadEditedAt: Date | null;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A superseded payload, archived when an in-place edit replaced it. `revision` is
 * the number the archived text HELD, counting from 0, so the live card's
 * `payloadRevision` is always one past the newest row here.
 */
export interface ApprovalPayloadRevision {
  id: string;
  companyId: string;
  approvalId: string;
  revision: number;
  payload: Record<string, unknown>;
  editedByAgentId: string | null;
  editedByUserId: string | null;
  createdAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

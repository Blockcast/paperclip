import { PencilLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { timeAgo } from "../lib/timeAgo";
import type { Approval } from "@paperclipai/shared";

/**
 * "This card's text changed after it was filed."
 *
 * An approval payload is editable in place (PEN-5766), and that was accepted on a
 * single trade: the edit is DISCLOSED. Prevention — an `expectedPayloadRevision`
 * interlock on the decision routes — was priced and deliberately deferred, so there
 * is no second line of defence behind this marker. It therefore has to appear
 * wherever a decision can be made, which includes the queue card carrying Approve
 * and Reject, not only the detail page a decider may never open (PEN-6107).
 *
 * `payloadRevision` is 0 on a card that was never edited, and an older server omits
 * the field entirely — both read as "not edited", which is the safe direction here:
 * the marker claims nothing it cannot support.
 */
export function approvalWasEdited(approval: Pick<Approval, "payloadRevision">) {
  return typeof approval.payloadRevision === "number" && approval.payloadRevision > 0;
}

/**
 * ⚠️ The safe fallback above is exactly what hides a projection regression: the
 * marker stops rendering, nothing goes red, and every card reads as never-edited.
 * Each client-facing read path (`listSummary`, `listApprovalsForIssue`, and
 * `GET /approvals/:id`) names the two columns in its own explicit select, and the
 * shared type declares `payloadRevision` non-optional, so the compiler cannot flag
 * the next projection that drops them (PEN-6107, Ally on PR 3550).
 *
 * So say so in development, once per page load, the way `Dashboard` reports its own
 * missing-shape case. In production this is silent: the fallback is still the right
 * behaviour there, and an older server legitimately omits the field.
 */
let missingMarkerWarned = false;
function warnIfMarkerMissing(approval: Pick<Approval, "payloadRevision">) {
  if (!import.meta.env.DEV || missingMarkerWarned) return;
  if (approval.payloadRevision !== undefined) return;
  missingMarkerWarned = true;
  console.warn(
    "[paperclip] an approval reached a decision surface with no `payloadRevision` — whatever projection served it dropped the edit marker, so an edited card is rendering as never-edited (PEN-6107)",
  );
}

export function ApprovalEditMarker({
  approval,
  className,
}: {
  approval: Pick<Approval, "payloadRevision" | "payloadEditedAt">;
  className?: string;
}) {
  warnIfMarkerMissing(approval);
  if (!approvalWasEdited(approval)) return null;

  const editedAt = approval.payloadEditedAt;
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200",
        className,
      )}
      title={
        editedAt
          ? `The text of this request was edited after it was filed (revision ${approval.payloadRevision}, last edited ${new Date(editedAt).toLocaleString()}).`
          : `The text of this request was edited after it was filed (revision ${approval.payloadRevision}).`
      }
    >
      <PencilLine />
      <span>Edited{editedAt ? ` ${timeAgo(editedAt)}` : ""}</span>
    </Badge>
  );
}

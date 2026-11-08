import type { CostByProject } from "@paperclipai/shared";

/**
 * PEN-6084: display shaping for the "By project" card.
 *
 * The card's job changed when `costs/by-project` stopped dropping spend that resolves to
 * no project. It now serves an UNATTRIBUTED bucket (`projectId === null`), so the rows
 * sum to `costs/summary` over the same window and the two cards on the page agree. The
 * label and the reconciliation check live here rather than in `Costs.tsx` so they are
 * testable without mounting the page.
 */

/** DESIGN.md principle 7: one name per concept, declared once. */
export const UNATTRIBUTED_PROJECT_LABEL = "Unattributed";

export interface ProjectCostRow {
  key: string;
  label: string;
  costCents: number;
  /** The residual bucket, not a project. Rendered muted and always last. */
  unattributed: boolean;
}

export function toProjectCostRows(rows: CostByProject[] | undefined): ProjectCostRow[] {
  return (rows ?? []).map((row) => {
    const unattributed = row.projectId === null;
    return {
      key: unattributed ? "unattributed" : row.projectId!,
      // A named project that somehow arrives without a name still has to render as
      // something an operator can act on, so fall back to its id rather than to the
      // bucket label -- which would claim it was unattributed when it is not.
      label: unattributed ? UNATTRIBUTED_PROJECT_LABEL : (row.projectName ?? row.projectId!),
      costCents: row.costCents,
      unattributed,
    };
  });
}

export interface ProjectCostReconciliation {
  totalCents: number;
  summaryCents: number;
  /** `totalCents - summaryCents`; negative means the card under-reports the Summary card. */
  differenceCents: number;
  reconciles: boolean;
}

/**
 * Compare the card's own total against the Summary card rendered beside it.
 *
 * Both are fetched over the SAME `from`/`to`, so after PEN-6084 this is expected to hold
 * exactly and the mismatch copy should never render. It is checked on screen anyway: the
 * defect this replaces was silent, and an invariant nobody looks at is how it stayed
 * silent for as long as it did.
 */
export function reconcileProjectCosts(
  rows: ProjectCostRow[],
  summaryCents: number,
): ProjectCostReconciliation {
  const totalCents = rows.reduce((sum, row) => sum + row.costCents, 0);
  return {
    totalCents,
    summaryCents,
    differenceCents: totalCents - summaryCents,
    reconciles: totalCents === summaryCents,
  };
}

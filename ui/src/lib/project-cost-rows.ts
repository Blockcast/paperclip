import type { CostByProject } from "@paperclipai/shared";

/**
 * PEN-6084: display shaping for the "By project" card.
 *
 * The card's job changed when `costs/by-project` stopped dropping spend that resolves to
 * no project. It now serves an UNATTRIBUTED bucket (`projectId === null`), so the rows
 * sum to the window total served beside them. The label and the reconciliation check live
 * here rather than in `Costs.tsx` so they are testable without mounting the page.
 *
 * PEN-6038 note: the page clamps the `by-project` REQUEST to the server's window cap
 * (`lib/by-project-window.ts`), so this card's window can be narrower than the one the
 * Summary card shows. Everything below is therefore stated against the window THIS
 * response answered for -- do not restate it as "the two cards on the page agree", which
 * holds only while the selection fits inside the cap.
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
    // Narrowing on the id itself rather than on a separate `unattributed` boolean is what
    // lets the attributed branch use `row.projectId` without a non-null assertion.
    if (row.projectId === null) {
      return {
        key: "unattributed",
        label: UNATTRIBUTED_PROJECT_LABEL,
        costCents: row.costCents,
        unattributed: true,
      };
    }
    return {
      key: row.projectId,
      // A named project that somehow arrives without a name still has to render as
      // something an operator can act on, so fall back to its id rather than to the
      // bucket label -- which would claim it was unattributed when it is not.
      label: row.projectName ?? row.projectId,
      costCents: row.costCents,
      unattributed: false,
    };
  });
}

/**
 * The window's total spend as the SAME response reported it.
 *
 * Every row carries an identical `windowTotalCents`, so reading the first is reading the
 * statement's own total. Absent only when the window served no rows at all, where the
 * total is zero by construction -- `by-project` emits the unattributed bucket for any
 * spend that resolves to no project, so an empty row set means an empty window.
 */
export function projectCostWindowTotal(rows: CostByProject[] | undefined): number {
  return rows?.[0]?.windowTotalCents ?? 0;
}

export interface ProjectCostReconciliation {
  /** Sum of the rendered rows. */
  totalCents: number;
  /** What the same response said the window holds. */
  windowTotalCents: number;
  /** `totalCents - windowTotalCents`; negative means the card under-reports the window. */
  differenceCents: number;
  reconciles: boolean;
}

/**
 * Check the card's rows against the window total served BESIDE them.
 *
 * Both numbers come from one statement and therefore one database snapshot, so this holds
 * exactly after PEN-6084 and the mismatch copy should never render. It is checked on
 * screen anyway: the defect this replaces was silent, and an invariant nobody looks at is
 * how it stayed silent for as long as it did.
 *
 * It deliberately no longer compares against the Summary card's `costs/summary` figure.
 * That is a SEPARATE request and so a separate snapshot, and the two refetch
 * independently, so an event committing between the two reads rendered a mismatch warning
 * against a correct split -- routinely, because the only windows this card can show are
 * narrow ones that usually end in the future. The cross-route invariant (`sum(by-project)
 * == summary`) is pinned deterministically by the server test instead, which is where a
 * check that must not race belongs.
 */
export function reconcileProjectCosts(
  rows: ProjectCostRow[],
  windowTotalCents: number,
): ProjectCostReconciliation {
  const totalCents = rows.reduce((sum, row) => sum + row.costCents, 0);
  return {
    totalCents,
    windowTotalCents,
    differenceCents: totalCents - windowTotalCents,
    reconciles: totalCents === windowTotalCents,
  };
}

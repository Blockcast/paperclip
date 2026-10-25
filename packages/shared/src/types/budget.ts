import type {
  BudgetIncidentResolutionAction,
  BudgetIncidentStatus,
  BudgetMetric,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
  PauseReason,
} from "../constants.js";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: PauseReason | null;
  /**
   * When the board adjudicated this window's hard-stop crossing and resumed the
   * scope without lifting the cap over observed spend, or null (PEN-4742).
   *
   * Non-null means the hard stop is measured from this instant for the rest of
   * the window, so `observedAmount` can sit above `amount` with the scope still
   * running. `observedAmount` and `utilizationPercent` deliberately stay TRUE
   * window figures -- enforcement rebaselines, reporting does not, or a forgiven
   * scope would render healthy while carrying an overshoot (PEN-1972 defect 3).
   * This field is what lets a reader tell "over cap and running by decision"
   * from "over cap and running because the gauge is broken".
   */
  hardStopForgivenSince: Date | null;
  windowStart: Date;
  windowEnd: Date;
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: BudgetThresholdType;
  amountLimit: number;
  amountObserved: number;
  status: BudgetIncidentStatus;
  /** Which board action closed this incident; null for system closures (PEN-4742). */
  resolutionAction: BudgetIncidentResolutionAction | null;
  approvalId: string | null;
  approvalStatus: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
}

export interface BudgetPolicyUpsertInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  metric?: BudgetMetric;
  windowKind?: BudgetWindowKind;
  amount: number;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
}

export interface BudgetIncidentResolutionInput {
  action: BudgetIncidentResolutionAction;
  amount?: number;
  decisionNote?: string | null;
}

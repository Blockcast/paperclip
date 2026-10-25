import { z } from "zod";
import {
  BUDGET_INCIDENT_RESOLUTION_ACTIONS,
  BUDGET_METRICS,
  BUDGET_SCOPE_TYPES,
  BUDGET_WINDOW_KINDS,
} from "../constants.js";

export const upsertBudgetPolicySchema = z.object({
  scopeType: z.enum(BUDGET_SCOPE_TYPES),
  scopeId: z.string().guid(),
  metric: z.enum(BUDGET_METRICS).prefault("billed_cents"),
  windowKind: z.enum(BUDGET_WINDOW_KINDS).prefault("calendar_month_utc"),
  amount: z.number().int().nonnegative(),
  warnPercent: z.number().int().min(1).max(99).prefault(80),
  hardStopEnabled: z.boolean().prefault(true),
  notifyEnabled: z.boolean().prefault(true),
  isActive: z.boolean().prefault(true),
});

export type UpsertBudgetPolicy = z.infer<typeof upsertBudgetPolicySchema>;

export const resolveBudgetIncidentSchema = z.object({
  action: z.enum(BUDGET_INCIDENT_RESOLUTION_ACTIONS),
  amount: z.number().int().nonnegative().optional(),
  decisionNote: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if (value.action === "raise_budget_and_resume" && typeof value.amount !== "number") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "amount is required when raising a budget",
      path: ["amount"],
    });
  }
  // `resume_without_raise` deliberately does NOT require an amount: its whole
  // point is that the board need not restate a figure to get a scope running
  // again, and omitting it keeps the cap exactly as it stands (PEN-4742). An
  // amount IS accepted, and unlike the raise path it may sit at or below
  // observed spend -- that is the ratchet this action exists to break.
});

export type ResolveBudgetIncident = z.infer<typeof resolveBudgetIncidentSchema>;

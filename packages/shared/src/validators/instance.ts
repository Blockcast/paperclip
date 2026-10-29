import { z } from "zod";
import { partialNoDefaults } from "../zod-compat.js";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").prefault(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").prefault(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").prefault(DEFAULT_BACKUP_RETENTION.monthlyMonths),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().prefault(false),
  keyboardShortcuts: z.boolean().prefault(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.prefault(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.prefault(DEFAULT_BACKUP_RETENTION),
  // Bounded because these are the only settings strings a request turns into
  // filesystem syscalls: the hook-command audit stats every script-like token,
  // so an unbounded string is unbounded synchronous work on the API event loop
  // (BLO-28872 review). 4 KiB is ~40x the longest real hook command.
  quotaExhaustedCmd: z.string().max(4096).nullable().prefault(null),
  preRunCmd: z.string().max(4096).nullable().prefault(null),
  postRunCmd: z.string().max(4096).nullable().prefault(null),
  // Execution policy. Absent/"any" = unrestricted; "kubernetes" forces the
  // Kubernetes sandbox provider and denies local/ssh execution (cloud_tenant).
  executionMode: z.enum(["kubernetes", "any"]).optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.apply(partialNoDefaults);

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().prefault(false),
  enableIsolatedWorkspaces: z.boolean().prefault(false),
  enableStreamlinedLeftNavigation: z.boolean().prefault(true),
  enableApps: z.boolean().prefault(false),
  enablePipelines: z.boolean().prefault(false),
  enableCases: z.boolean().prefault(false),
  enableConferenceRoomChat: z.boolean().prefault(false),
  enableTaskWatchdogs: z.boolean().prefault(false),
  enableIssuePlanDecompositions: z.boolean().prefault(false),
  enableExperimentalFileViewer: z.boolean().prefault(false),
  enableCloudSync: z.boolean().prefault(false),
  enableDoneExecutionGate: z.boolean().prefault(false),
  enableExternalObjects: z.boolean().prefault(false),
  enableSmokeLab: z.boolean().prefault(false),
  enableBuiltInAgents: z.boolean().prefault(false),
  enableSummaries: z.boolean().prefault(false),
  enableDecisions: z.boolean().prefault(false),
  enableGoalsSidebarLink: z.boolean().prefault(false),
  enableServerInfoDebugView: z.boolean().prefault(false),
  autoRestartDevServerWhenIdle: z.boolean().prefault(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().prefault(false),
  enableWorkspaceBranchReconcileForward: z.boolean().prefault(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().prefault(true),
  enableWorktreeRunExecution: z.boolean().prefault(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().prefault(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().prefault(null),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .prefault(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema
  .omit({
    worktreeRunExecutionActivatedAt: true,
    worktreeRunExecutionActivationInstanceId: true,
  })
  .apply(partialNoDefaults)
  .strip();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().guid().nullable().optional(),
}).strict();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type PatchInstanceSettings = z.infer<typeof patchInstanceSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;

export const instanceSettingsSchema = z.object({
  id: z.string().guid(),
  defaultEnvironmentId: z.string().guid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();

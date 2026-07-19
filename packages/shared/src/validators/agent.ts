import { z } from "zod";
import {
  AGENT_ICON_NAMES,
  AGENT_ROLES,
  AGENT_STATUSES,
  INBOX_MINE_ISSUE_STATUS_FILTER,
} from "../constants.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema, trustPresetSchema } from "./trust-policy.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";

export const agentPermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional().default(false),
  canCreateSkills: z.boolean().optional().default(true),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

export const HEARTBEAT_POLICY_INTERVAL_MIN_SEC = 30;
export const HEARTBEAT_POLICY_INTERVAL_MAX_SEC = 86_400;
export const HEARTBEAT_POLICY_COOLDOWN_MIN_SEC = 0;
export const HEARTBEAT_POLICY_COOLDOWN_MAX_SEC = 3_600;
export const HEARTBEAT_POLICY_MAX_CONCURRENT_MIN = 1;
export const HEARTBEAT_POLICY_MAX_CONCURRENT_MAX = 50;

export const heartbeatPresetSchema = z.enum(["economic", "balanced", "aggressive"]);
export type HeartbeatPreset = z.infer<typeof heartbeatPresetSchema>;

export type HeartbeatPresetConfig = {
  enabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
  cooldownSec: number;
  maxConcurrentRuns: number;
};

export const HEARTBEAT_PRESET_CONFIGS: Record<HeartbeatPreset, HeartbeatPresetConfig> = {
  economic: {
    enabled: true,
    intervalSec: 1800,
    wakeOnDemand: true,
    cooldownSec: 30,
    maxConcurrentRuns: 1,
  },
  balanced: {
    enabled: true,
    intervalSec: 600,
    wakeOnDemand: true,
    cooldownSec: 10,
    maxConcurrentRuns: 2,
  },
  aggressive: {
    enabled: true,
    intervalSec: 120,
    wakeOnDemand: true,
    cooldownSec: 5,
    maxConcurrentRuns: 3,
  },
};

export const heartbeatPolicySchema = z
  .object({
    preset: heartbeatPresetSchema.optional(),
    enabled: z.boolean().optional(),
    intervalSec: z.number().int().optional(),
    wakeOnDemand: z.boolean().optional(),
    cooldownSec: z.number().int().optional(),
    maxConcurrentRuns: z.number().int().optional(),
    /**
     * Default-off eligibility gate for external-lifecycle (k8s) concurrency
     * (BLO-15959). When false/absent, external-lifecycle adapters are held to
     * one run regardless of `maxConcurrentRuns`. Only when explicitly true
     * does `maxConcurrentRuns` (bounded further by the operational slot
     * ceiling) take effect for those adapters.
     */
    concurrencyEnabled: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (
      value.intervalSec !== undefined
      && (value.intervalSec < HEARTBEAT_POLICY_INTERVAL_MIN_SEC || value.intervalSec > HEARTBEAT_POLICY_INTERVAL_MAX_SEC)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.intervalSec must be between ${HEARTBEAT_POLICY_INTERVAL_MIN_SEC} and ${HEARTBEAT_POLICY_INTERVAL_MAX_SEC}`,
        path: ["intervalSec"],
      });
    }

    if (
      value.cooldownSec !== undefined
      && (value.cooldownSec < HEARTBEAT_POLICY_COOLDOWN_MIN_SEC || value.cooldownSec > HEARTBEAT_POLICY_COOLDOWN_MAX_SEC)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.cooldownSec must be between ${HEARTBEAT_POLICY_COOLDOWN_MIN_SEC} and ${HEARTBEAT_POLICY_COOLDOWN_MAX_SEC}`,
        path: ["cooldownSec"],
      });
    }

    if (
      value.maxConcurrentRuns !== undefined
      && (value.maxConcurrentRuns < HEARTBEAT_POLICY_MAX_CONCURRENT_MIN || value.maxConcurrentRuns > HEARTBEAT_POLICY_MAX_CONCURRENT_MAX)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `heartbeat.maxConcurrentRuns must be between ${HEARTBEAT_POLICY_MAX_CONCURRENT_MIN} and ${HEARTBEAT_POLICY_MAX_CONCURRENT_MAX}`,
        path: ["maxConcurrentRuns"],
      });
    }

    if (
      value.enabled === true
      && value.cooldownSec !== undefined
      && value.intervalSec !== undefined
      && value.cooldownSec > value.intervalSec
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "heartbeat.cooldownSec cannot exceed heartbeat.intervalSec when heartbeat is enabled",
        path: ["cooldownSec"],
      });
    }

  });

export const agentInstructionsBundleModeSchema = z.enum(["managed", "external"]);

export const updateAgentInstructionsBundleSchema = z.object({
  mode: agentInstructionsBundleModeSchema.optional(),
  rootPath: z.string().trim().min(1).nullable().optional(),
  entryFile: z.string().trim().min(1).optional(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpdateAgentInstructionsBundle = z.infer<typeof updateAgentInstructionsBundleSchema>;

export const upsertAgentInstructionsFileSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  clearLegacyPromptTemplate: z.boolean().optional().default(false),
});

export type UpsertAgentInstructionsFile = z.infer<typeof upsertAgentInstructionsFileSchema>;

const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  const envValue = value.env;
  if (envValue === undefined) return;
  const parsed = envConfigSchema.safeParse(envValue);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "adapterConfig.env must be a map of valid env bindings",
      path: ["env"],
    });
  }
});

export const createAgentInstructionsBundleSchema = z.object({
  entryFile: z.string().trim().min(1).optional(),
  files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
    message: "instructionsBundle.files must contain at least one file",
  }),
});

const agentModelProfileConfigSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().trim().min(1).optional(),
  adapterConfig: adapterConfigSchema,
}).strict();

export const agentRuntimeConfigSchema = z.object({
  modelProfiles: z.object({
    cheap: agentModelProfileConfigSchema.optional(),
  }).strict().optional(),
}).catchall(z.unknown()).superRefine((value, ctx) => {
  // kkroo: validate optional heartbeat policy if present
  const heartbeatValue = (value as Record<string, unknown>).heartbeat;
  if (heartbeatValue === undefined) return;
  const parsed = heartbeatPolicySchema.safeParse(heartbeatValue);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: ["heartbeat", ...issue.path],
    });
  }
});

export const createAgentSchema = z.object({
  name: z.string().min(1),
  role: z.enum(AGENT_ROLES).optional().default("general"),
  title: z.string().optional().nullable(),
  icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
  reportsTo: z.string().uuid().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
  adapterType: agentAdapterTypeSchema,
  adapterConfig: adapterConfigSchema.optional().default({}),
  instructionsBundle: createAgentInstructionsBundleSchema.optional(),
  defaultEnvironmentId: z.string().uuid().optional().nullable(),
  runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  permissions: agentPermissionsSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type CreateAgent = z.infer<typeof createAgentSchema>;

export const builtInAgentProvisionSchema = z.object({
  adapterType: agentAdapterTypeSchema.optional(),
  adapterConfig: adapterConfigSchema.optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
}).strict();

export type BuiltInAgentProvision = z.infer<typeof builtInAgentProvisionSchema>;

export const builtInAgentEmptyMutationSchema = z.object({}).strict().default({});

export type BuiltInAgentEmptyMutation = z.infer<typeof builtInAgentEmptyMutationSchema>;

export const builtInAgentResetSchema = z.object({
  resources: z.array(z.enum(["agent", "instructions", "skill", "routine"])).optional(),
}).strict().default({});

export type BuiltInAgentReset = z.infer<typeof builtInAgentResetSchema>;

export const createAgentHireSchema = createAgentSchema.extend({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceIssueIds: z.array(z.string().uuid()).optional(),
});

export type CreateAgentHire = z.infer<typeof createAgentHireSchema>;

export const updateAgentSchema = createAgentSchema
  .omit({ permissions: true })
  .partial()
  .extend({
    permissions: z.never().optional(),
    replaceAdapterConfig: z.boolean().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    pauseReason: z.string().min(1).optional().nullable(),
    pausedAt: z.coerce.date().optional().nullable(),
  });

export type UpdateAgent = z.infer<typeof updateAgentSchema>;

export const updateAgentInstructionsPathSchema = z.object({
  path: z.string().trim().min(1).nullable(),
  adapterConfigKey: z.string().trim().min(1).optional(),
});

export type UpdateAgentInstructionsPath = z.infer<typeof updateAgentInstructionsPathSchema>;

export const taskBridgeAgentKeyScopeSchema = z.object({
  kind: z.literal("task_bridge"),
  projectId: z.string().uuid().optional().nullable(),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  parentIssueId: z.string().uuid().optional().nullable(),
  parentIssueIds: z.array(z.string().uuid()).max(50).optional(),
  allowedAssigneeAgentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict().superRefine((value, ctx) => {
  const hasProjectBoundary = Boolean(value.projectId) || Boolean(value.projectIds?.length);
  const hasParentBoundary = Boolean(value.parentIssueId) || Boolean(value.parentIssueIds?.length);
  if (!hasProjectBoundary && !hasParentBoundary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_bridge keys require at least one project or parent issue boundary",
      path: ["projectId"],
    });
  }
});

export const standardAgentKeyScopeSchema = z.object({
  kind: z.literal("standard"),
}).strict();

export const skillTestAgentKeyScopeSchema = z.object({
  kind: z.literal("skill_test"),
  issueId: z.string().uuid(),
}).strict();

export const agentApiKeyScopeSchema = z.union([
  standardAgentKeyScopeSchema,
  taskBridgeAgentKeyScopeSchema,
  skillTestAgentKeyScopeSchema,
]);

export type AgentApiKeyScope = z.infer<typeof agentApiKeyScopeSchema>;
export type TaskBridgeAgentKeyScope = z.infer<typeof taskBridgeAgentKeyScopeSchema>;
export type SkillTestAgentKeyScope = z.infer<typeof skillTestAgentKeyScopeSchema>;

export function normalizeAgentApiKeyScope(value: unknown): AgentApiKeyScope {
  const parsed = agentApiKeyScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : { kind: "standard" };
}

export const createAgentKeySchema = z.object({
  name: z.string().min(1).default("default"),
  scope: agentApiKeyScopeSchema.optional().default({ kind: "standard" }),
});

export type CreateAgentKey = z.infer<typeof createAgentKeySchema>;

export const agentMineInboxQuerySchema = z.object({
  userId: z.string().trim().min(1),
  status: z.string().trim().min(1).optional().default(INBOX_MINE_ISSUE_STATUS_FILTER),
});

export type AgentMineInboxQuery = z.infer<typeof agentMineInboxQuerySchema>;

export const wakeAgentSchema = z.object({
  source: z.enum(["timer", "assignment", "on_demand", "automation"]).optional().default("on_demand"),
  triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
  reason: z.string().optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  forceFreshSession: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.boolean().optional().default(false),
  ),
});

export type WakeAgent = z.infer<typeof wakeAgentSchema>;

export const resetAgentSessionSchema = z.object({
  taskKey: z.string().min(1).optional().nullable(),
});

export type ResetAgentSession = z.infer<typeof resetAgentSessionSchema>;

export const testAdapterEnvironmentSchema = z.object({
  adapterConfig: adapterConfigSchema.optional().default({}),
  /**
   * Optional environment to run the adapter test inside. When omitted, the
   * test runs against the local Paperclip host. When provided and the
   * environment is non-local (SSH/sandbox), the test probes are executed
   * inside that environment so the result reflects real agent execution.
   * (For the k8s-vendored deploy, the pod has no per-user codex/claude
   * credentials, so a non-null environmentId is effectively required.)
   */
  environmentId: z.string().uuid().nullable().optional(),
});

export type TestAdapterEnvironment = z.infer<typeof testAdapterEnvironmentSchema>;

export const updateAgentPermissionsSchema = z.object({
  canCreateAgents: z.boolean(),
  canCreateSkills: z.boolean().optional(),
  canAssignTasks: z.boolean(),
  trustPreset: trustPresetSchema.optional(),
  authorizationPolicy: trustAuthorizationPolicySchema.optional(),
});

export type UpdateAgentPermissions = z.infer<typeof updateAgentPermissionsSchema>;

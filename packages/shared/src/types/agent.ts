import type {
  AgentAdapterType,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";
import type {
  TrustAuthorizationPolicy,
  TrustPreset,
} from "../trust-policy.js";
import type { AgentOrgChainHealth } from "../agent-eligibility.js";
import type { AgentApiKeyScope } from "../validators/agent.js";

export interface AgentPermissions extends Record<string, unknown> {
  canCreateAgents: boolean;
  canCreateSkills?: boolean;
  trustPreset?: TrustPreset;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

/**
 * Why an agent may assign tasks. Derived server-side from the subject's role,
 * permissions, grants and membership — it answers "who do I escalate to, and
 * on what basis" WITHOUT the inventory it was derived from, which is what lets
 * `AgentAccessStateRestricted` drop `grants` and stay useful (PEN-5232).
 */
export type AgentTaskAssignSource =
  | "simple_default"
  | "explicit_grant"
  | "agent_creator"
  | "ceo_role"
  | "none";

/** The access state a reader entitled to the subject's configuration receives. */
export interface AgentAccessStateFull {
  canAssignTasks: boolean;
  taskAssignSource: AgentTaskAssignSource;
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

/**
 * The access state a PEER reader receives — one that fails `agent_config:read`
 * and is therefore served by `redactForRestrictedAgentView` (PEN-5232).
 *
 * `grants` is ABSENT, not empty. `grants?: never` is load-bearing: an empty
 * array is indistinguishable from "this agent holds no grants", which is the
 * withheld-is-not-absent defect PEN-5230 closed one field over, so the type
 * forbids the shape rather than trusting a comment. The response says the
 * inventory was withheld through `withheldFields`, not through a sentinel
 * value.
 *
 * `membership` is projected to `status` alone. The full row is a bare
 * `select *` over `company_memberships` (PEN-5258), so passing it through
 * whole would let a column added later reach a peer by default — the same
 * default-open shape this projection exists to close.
 */
export interface AgentAccessStateRestricted {
  canAssignTasks: boolean;
  taskAssignSource: AgentTaskAssignSource;
  membership: { status: CompanyMembership["status"] } | null;
  grants?: never;
}

/**
 * Discriminate on `grants` before reading it. A restricted response carries
 * the derived `canAssignTasks` / `taskAssignSource` answer and nothing else
 * about the subject's authorization.
 */
export type AgentAccessState = AgentAccessStateFull | AgentAccessStateRestricted;

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  /**
   * Withheld-is-not-absent markers (PEN-5230, implementing the PEN-5228
   * ruling). Present ONLY on the restricted peer projection, where
   * `adapterConfig` / `runtimeConfig` are served as `{}` because the reader
   * lacks the entitlement — never on a response that carries the real config.
   * So their ABSENCE is itself the signal that nothing was withheld, and a
   * client must treat `{}`-with-no-marker as "genuinely empty" rather than
   * "withheld".
   *
   * Both are constants on the server. `withheldFields` always names both
   * columns, not only the populated ones, and `withheldByAction` names the
   * gate the READER lacks — a fact about the reader, not the subject — so the
   * pair discloses zero bits about the agent being read. Do not infer config
   * presence from either.
   */
  withheldFields?: string[];
  withheldByAction?: string;
  defaultEnvironmentId?: string | null;
  /**
   * Display mirror of the monthly cap. Kept equal to the enforcing policy by
   * every writer that goes through `budgets.upsertPolicy`, but the paths that
   * write it alone can leave it stale — prefer `enforcedBudgetMonthlyCents`
   * for anything that decides or reports. See BLO-27626.
   */
  budgetMonthlyCents: number;
  /**
   * Amount of the active enforcing budget policy (agent scope, `billed_cents`,
   * `calendar_month_utc`) — the value that actually stops the agent. `null`
   * when no active policy exists, i.e. uncapped, which is distinct from `0`.
   * Derived on read; absent on write responses.
   */
  enforcedBudgetMonthlyCents?: number | null;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  errorReason?: string | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  orgChainHealth?: AgentOrgChainHealth;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export type ClearAgentErrorResponse = Agent;

export interface AgentKeyCreated {
  id: string;
  name: string;
  scope: AgentApiKeyScope;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

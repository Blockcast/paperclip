/**
 * Webhook handler tests — drives `handleWebhook` directly with a mock
 * PluginContext so we don't need to spin up the full worker RPC host.
 *
 * Test pattern mirrors `paperclip-plugin-slack/src/__tests__/user-mapping.test.ts`:
 * a `mkCtx()` factory that returns vitest-mocked clients, plus a typed
 * `unknownCast` helper to keep us inside strict TS.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  AlertDeliveryIncompleteError,
  WebhookUnauthorizedError,
  handleWebhook,
  verifyBearerToken,
} from "../webhook-handler.js";
import {
  BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
  BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
  BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
  DEFAULT_ISSUE_ROUTE_MAP,
} from "../constants.js";
import { ORIGIN_KIND } from "../types.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
  AlertStateRecord,
} from "../types.js";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { joinAggregate } from "../aggregate-store.js";
import { reconcileAggregateLifecycle } from "../aggregate-reconciliation.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TOKEN = "super-secret-token";

const baseAlert = (overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert => ({
  status: "firing",
  labels: {
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    team: "platform",
    node: "pve-3",
  },
  annotations: {
    summary: "261 GB of EGRESS traffic dropped on pve-3 in 21h",
    description: "Sustained policy-denied drops",
    runbook_url: "https://wiki/runbooks/cilium-drops",
    dashboard_url: "https://grafana/d/cilium",
  },
  startsAt: "2026-04-29T08:00:00Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus-0:9090/graph?g0.expr=foo",
  fingerprint: "9a3b1e4c5f6d7890",
  ...overrides,
});

const baseEnvelope = (
  overrides: Partial<AlertmanagerWebhookPayload> = {},
): AlertmanagerWebhookPayload => ({
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupLabels: { alertname: "CiliumPolicyDropsHigh" },
  commonLabels: { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: [baseAlert()],
  ...overrides,
});

const baseConfig = (
  overrides: Partial<AlertmanagerPluginConfig> = {},
): AlertmanagerPluginConfig => ({
  defaultCompanyId: "company-1",
  webhookToken: TOKEN,
  acceptOnlyLabels: {},
  severityToPriority: { critical: "critical", warning: "high", info: "medium" },
  autoCloseOnResolve: false,
  ownerMap: { team: { platform: "alice@example.com" } },
  fallbackAgentName: "Alert Fallback",
  ...overrides,
});

const baseInput = (
  overrides: Partial<PluginWebhookInput> = {},
): PluginWebhookInput => ({
  companyId: "company-1",
  endpointKey: "alertmanager",
  headers: { authorization: `Bearer ${TOKEN}` },
  rawBody: JSON.stringify(baseEnvelope()),
  parsedBody: baseEnvelope(),
  requestId: "req-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock context factory
// ---------------------------------------------------------------------------

interface MockClients {
  db: {
    query: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    namespace: string;
    beforeComplete?: () => Promise<void>;
    allowClaimSteal?: boolean;
  };
  state: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  users: { get: ReturnType<typeof vi.fn>; findByEmail: ReturnType<typeof vi.fn> };
  issues: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    listComments: ReturnType<typeof vi.fn>;
    createComment: ReturnType<typeof vi.fn>;
  };
  agents: { list: ReturnType<typeof vi.fn> };
  events: { emit: ReturnType<typeof vi.fn> };
  metrics: { write: ReturnType<typeof vi.fn> };
  activity: { log: ReturnType<typeof vi.fn> };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

const mkCtx = (): { ctx: PluginContext; mocks: MockClients } => {
  const aggregates = new Map<string, Record<string, unknown>>();
  const members = new Map<string, { firing: boolean }>();
  const stateValues = new Map<string, unknown>();
  const stateKey = (ref: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${ref.scopeKind}:${ref.scopeId ?? ""}:${ref.stateKey}`;
  const mocks: MockClients = {
    db: {
      namespace: "alertmanager_test",
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("INSERT INTO") && sql.includes("alert_aggregates")) {
          const [key, companyId, alertname, severity, fingerprint] = params as string[];
          const aggregateId = `${companyId}:${key}`;
          const current = aggregates.get(aggregateId);
          const reopenRequired = Boolean(
            current?.reopen_required ||
              current?.resolution_claim ||
              current?.final_resolved_at,
          );
          aggregates.set(aggregateId, {
            aggregate_key: key,
            company_id: companyId,
            paperclip_issue_id: current?.paperclip_issue_id ?? null,
            alertname,
            severity,
            assignee_user_id: current?.assignee_user_id ?? null,
            assignee_agent_id: current?.assignee_agent_id ?? null,
            final_resolved_at: null,
            resolution_claim: current?.resolution_claim ?? null,
            resolution_claimed_at: current?.resolution_claimed_at ?? null,
            resolution_generation: current?.resolution_generation ?? null,
            resolution_requested_at: current?.resolution_requested_at ?? null,
            reopen_required: reopenRequired,
            generation: Number(current?.generation ?? 0) + (current ? 1 : 0),
            active_fingerprints: current
              ? Array.from(
                  new Set([
                    ...((current.active_fingerprints as string[]) ?? []),
                    fingerprint,
                  ]),
                )
              : [fingerprint],
          });
          return { rowCount: 1 };
        }
        if (sql.includes("INSERT INTO") && sql.includes("alert_members")) {
          const [companyId, key, fingerprint] = params as string[];
          members.set(`${companyId}:${key}:${fingerprint}`, { firing: true });
          return { rowCount: 1 };
        }
        if (sql.includes("SET paperclip_issue_id")) {
          const [companyId, key, issueId, userId, agentId] = params as string[];
          const aggregate = aggregates.get(`${companyId}:${key}`);
          if (aggregate) {
            aggregate.paperclip_issue_id ??= issueId;
            aggregate.assignee_user_id ??= userId;
            aggregate.assignee_agent_id ??= agentId;
          }
          return { rowCount: aggregate ? 1 : 0 };
        }
        if (sql.trim().startsWith('UPDATE "alertmanager_test"."alert_members"')) {
          const [companyId, key, fingerprint] = params as string[];
          const member = members.get(`${companyId}:${key}:${fingerprint}`);
          if (!member?.firing) return { rowCount: 0 };
          member.firing = false;
          return { rowCount: 1 };
        }
        if (sql.includes("resolution_claim = CASE")) {
          const [companyId, key, fingerprint, claim] = params as string[];
          const aggregate = aggregates.get(`${companyId}:${key}`);
          const known =
            (aggregate?.active_fingerprints as string[] | undefined)?.includes(fingerprint) ||
            members.has(`${companyId}:${key}:${fingerprint}`);
          if (!aggregate || !known) return { rowCount: 0 };
          aggregate.active_fingerprints = (
            (aggregate.active_fingerprints as string[]) ?? []
          ).filter((value) => value !== fingerprint);
          const hasFiring = (aggregate.active_fingerprints as string[]).length > 0;
          if (
            !hasFiring &&
            (!aggregate.resolution_claim || mocks.db.allowClaimSteal) &&
            !aggregate.final_resolved_at
          ) {
            aggregate.resolution_claim = claim;
            aggregate.resolution_claimed_at = new Date().toISOString();
            aggregate.resolution_generation = aggregate.generation;
            aggregate.resolution_requested_at = params[4];
          }
          return { rowCount: 1 };
        }
        if (sql.includes("SET final_resolved_at")) {
          const [companyId, key, claim, resolvedAt] = params as string[];
          let aggregate = aggregates.get(`${companyId}:${key}`);
          const hook = mocks.db.beforeComplete;
          mocks.db.beforeComplete = undefined;
          if (hook) await hook();
          aggregate = aggregates.get(`${companyId}:${key}`);
          const hasFiring =
            ((aggregate?.active_fingerprints as string[] | undefined)?.length ?? 0) > 0;
          if (!aggregate || aggregate.resolution_claim !== claim || hasFiring) {
            return { rowCount: 0 };
          }
          aggregate.final_resolved_at = resolvedAt;
          aggregate.resolution_claim = null;
          aggregate.reopen_required = false;
          return { rowCount: 1 };
        }
        if (sql.includes("SET resolution_claim = NULL") && sql.includes("resolution_claim = $3")) {
          const [companyId, key, claim] = params as string[];
          const aggregate = aggregates.get(`${companyId}:${key}`);
          if (!aggregate || aggregate.resolution_claim !== claim) return { rowCount: 0 };
          aggregate.resolution_claim = null;
          aggregate.resolution_claimed_at = null;
          aggregate.resolution_generation = null;
          return { rowCount: 1 };
        }
        if (sql.includes("SET reopen_required = false")) {
          const [companyId, key, claim] = params as string[];
          const aggregate = aggregates.get(`${companyId}:${key}`);
          if (!aggregate || !((aggregate.active_fingerprints as string[])?.length > 0)) {
            return { rowCount: 0 };
          }
          if (
            (claim && aggregate.resolution_claim !== claim) ||
            (!claim && aggregate.resolution_claim)
          ) {
            return { rowCount: 0 };
          }
          aggregate.reopen_required = false;
          aggregate.resolution_claim = null;
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }),
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        const [companyId, key, fingerprint] = params as string[];
        if (sql.includes("WITH candidates AS")) {
          const claim = params[2] as string;
          const rows = [...aggregates.values()].filter(
            (aggregate) =>
              aggregate.company_id === companyId &&
              aggregate.paperclip_issue_id &&
              !aggregate.final_resolved_at &&
              ((aggregate.active_fingerprints as string[]) ?? []).length === 0 &&
              !aggregate.resolution_claim,
          );
          return rows.map((aggregate) => {
            aggregate.resolution_claim = claim;
            aggregate.resolution_claimed_at = new Date().toISOString();
            aggregate.resolution_generation = aggregate.generation;
            aggregate.reopen_required = false;
            return {
              ...aggregate,
              resolved_at:
                aggregate.resolution_requested_at ?? new Date().toISOString(),
            };
          });
        }
        if (sql.includes("FROM") && sql.includes("alert_aggregates")) {
          if (sql.includes("AND reopen_required")) {
            return [...aggregates.values()].filter(
              (aggregate) =>
                aggregate.company_id === companyId &&
                aggregate.reopen_required &&
                ((aggregate.active_fingerprints as string[]) ?? []).length > 0 &&
                !aggregate.resolution_claim,
            );
          }
          const aggregate = aggregates.get(`${companyId}:${key}`);
          if (sql.includes("cardinality(active_fingerprints)")) {
            return aggregate
              ? [{ present: ((aggregate.active_fingerprints as string[]) ?? []).length > 0 }]
              : [];
          }
          if (sql.includes("SELECT resolution_claim")) {
            return aggregate ? [{ resolution_claim: aggregate.resolution_claim }] : [];
          }
          return aggregate ? [aggregate] : [];
        }
        if (sql.includes("FROM") && sql.includes("alert_members")) {
          if (fingerprint) {
            const member = members.get(`${companyId}:${key}:${fingerprint}`);
            return member ? [member] : [];
          }
          const firing = [...members.entries()].some(
            ([memberKey, member]) =>
              memberKey.startsWith(`${companyId}:${key}:`) && member.firing,
          );
          return firing ? [{ present: true }] : [];
        }
        return [];
      }),
    },
    state: {
      get: vi.fn(async (ref: { scopeKind: string; scopeId?: string; stateKey: string }) => stateValues.get(stateKey(ref)) ?? null),
      set: vi.fn(async (ref: { scopeKind: string; scopeId?: string; stateKey: string }, value: unknown) => {
        stateValues.set(stateKey(ref), value);
      }),
      delete: vi.fn(async (ref: { scopeKind: string; scopeId?: string; stateKey: string }) => {
        stateValues.delete(stateKey(ref));
      }),
    },
    users: {
      get: vi.fn(async () => null),
      findByEmail: vi.fn(async () => null),
    },
    issues: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "issue-1" })),
      update: vi.fn(async () => ({ id: "issue-1" })),
      listComments: vi.fn(async () => []),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
    },
    agents: {
      list: vi.fn(async () => [
        { id: "agent-fallback", name: "Alert Fallback", status: "idle" },
      ]),
    },
    events: { emit: vi.fn(async () => {}) },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  // The cast is contained to test code where it's documented and the
  // mocks satisfy the subset of the surface the handler actually touches.
  const ctx = mocks as unknown as PluginContext;
  return { ctx, mocks };
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// verifyBearerToken — direct unit tests
// ---------------------------------------------------------------------------

describe("verifyBearerToken", () => {
  it("rejects when no expected token is configured", () => {
    expect(verifyBearerToken({ authorization: `Bearer x` }, null)).toBe(false);
    expect(verifyBearerToken({ authorization: `Bearer x` }, "")).toBe(false);
  });

  it("rejects when the header is missing", () => {
    expect(verifyBearerToken({}, TOKEN)).toBe(false);
  });

  it("rejects on length mismatch (constant-time-safe)", () => {
    expect(verifyBearerToken({ authorization: `Bearer wrong` }, TOKEN)).toBe(false);
  });

  it("rejects on a near-miss with the same length", () => {
    const sameLengthBad = "x".repeat(TOKEN.length);
    expect(verifyBearerToken({ authorization: `Bearer ${sameLengthBad}` }, TOKEN)).toBe(false);
  });

  it("accepts a correctly formed Authorization header", () => {
    expect(verifyBearerToken({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });

  it("matches the capitalized Authorization header too", () => {
    expect(verifyBearerToken({ Authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook — integration-flavored tests
// ---------------------------------------------------------------------------

describe("handleWebhook — auth", () => {
  it("throws WebhookUnauthorizedError when bearer token is missing", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: {} });
    await expect(handleWebhook(ctx, config, TOKEN, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("throws WebhookUnauthorizedError on a bad token", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: { authorization: "Bearer nope" } });
    await expect(handleWebhook(ctx, config, TOKEN, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("accepts a correct bearer token and processes the payload", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });
});

describe("handleWebhook — schema validation", () => {
  it("drops malformed payloads (writes a metric, returns 200-equivalent)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ parsedBody: { not: "an alertmanager payload" } });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.malformed",
      1,
    );
  });

  it("drops payloads with unsupported schema version", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const envelope = baseEnvelope({ version: "5" });
    const input = baseInput({
      parsedBody: envelope,
      rawBody: JSON.stringify(envelope),
    });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.unsupported_version",
      1,
      { version: "5" },
    );
  });

  it("ignores unknown endpointKey", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ endpointKey: "something-else" });
    await handleWebhook(ctx, config, TOKEN, input);
    expect(mocks.issues.create).not.toHaveBeenCalled();
  });
});

describe("handleWebhook — firing first time", () => {
  it("creates an issue with the right title, priority, originKind, and assignee", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    // owner-by-email cache miss → falls through to ctx.users.findByEmail
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-42",
      email: "alice@example.com",
      name: "Alice",
    });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.companyId).toBe("company-1");
    expect(createArgs.title).toBe("[critical] CiliumPolicyDropsHigh · platform");
    expect(createArgs.priority).toBe("critical");
    expect(createArgs.originKind).toBe(ORIGIN_KIND);
    expect(createArgs.originId).toBe(
      'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]',
    );
    expect(createArgs.assigneeUserId).toBe("user-42");
    expect(createArgs.description).toContain("[Dashboard](https://grafana/d/cilium)");
    expect(createArgs.description).toContain("[Runbook](https://wiki/runbooks/cilium-drops)");

    // State row written, scoped to the company that owns the issue (BLO-20467)
    expect(mocks.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "alert:9a3b1e4c5f6d7890",
      },
      expect.objectContaining({
        paperclipIssueId: "issue-1",
        paperclipCompanyId: "company-1",
        assigneeUserId: "user-42",
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        resolvedAt: null,
      }),
    );

    // Firing event emitted
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.firing",
      "company-1",
      expect.objectContaining({
        fingerprint: "9a3b1e4c5f6d7890",
        paperclipIssueId: "issue-1",
        assigneeUserId: "user-42",
        reFired: false,
      }),
    );
    // Activity + metric
    expect(mocks.activity.log).toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.handled",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("assigns the named fallback agent when no owner resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
    expect(createArgs.assigneeAgentId).toBe("agent-fallback");
  });

  it("forwards billing_code label to ctx.issues.create", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      labels: {
        alertname: "X",
        severity: "warning",
        billing_code: "cost-ctr-7",
      },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.billingCode).toBe("cost-ctr-7");
  });

  it("routes physical-infra class alerts into the physical-infra project queue", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
      ownerMap: {
        class: {
          physical_infra_bmc: "support@blockcast.net",
        },
      },
    });
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "support-user",
      email: "support@blockcast.net",
      name: "Support",
    });
    const alert = baseAlert({
      labels: {
        alertname: "PhysicalInfraBmcPowerSupplyStateBad",
        severity: "critical",
        class: "physical_infra_bmc",
        team: "platform",
      },
      fingerprint: "physical-bmc-1",
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.projectId).toBe(BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID);
    expect(createArgs.goalId).toBe(BLOCKCAST_PHYSICAL_INFRA_GOAL_ID);
    expect(createArgs.status).toBe("todo");
    expect(createArgs.assigneeAgentId).toBe(BLOCKCAST_PHYSICAL_INFRA_AGENT_ID);
    expect(createArgs.assigneeUserId).toBeUndefined();
    expect(mocks.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "alert:physical-bmc-1",
      },
      expect.objectContaining({
        assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
        assigneeUserId: null,
      }),
    );
  });

  it.each([
    ["pod_pending", "PodPendingCritical"],
    ["pod_init_stuck", "PodContainerCreatingStuck"],
    ["pod_crashloop", "PodCrashLooping"],
    ["pod_create_error", "PodCreateError"],
    ["pod_config_error", "PodConfigError"],
    ["pod_image_pull", "PodImagePullBackOff"],
  ])(
    "routes %s pod-health alerts to the Platform/SRE owner",
    async (className, alertname) => {
      const { ctx, mocks } = mkCtx();
      const config = baseConfig({
        issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
        ownerMap: {},
      });
      const alert = baseAlert({
        labels: {
          alertname,
          severity: "critical",
          class: className,
          namespace: "paperclip",
        },
        fingerprint: `pod-health-${className}`,
      });
      const envelope = baseEnvelope({ alerts: [alert] });

      await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

      const createArgs = mocks.issues.create.mock.calls[0][0];
      expect(createArgs.projectId).toBe(BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID);
      expect(createArgs.goalId).toBe(BLOCKCAST_PHYSICAL_INFRA_GOAL_ID);
      expect(createArgs.status).toBe("todo");
      expect(createArgs.assigneeAgentId).toBe(BLOCKCAST_PHYSICAL_INFRA_AGENT_ID);
      expect(createArgs.assigneeUserId).toBeUndefined();
    },
  );

  it("leaves non-routed alerts on the existing create path", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP });
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-42",
      email: "alice@example.com",
      name: "Alice",
    });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.projectId).toBeUndefined();
    expect(createArgs.goalId).toBeUndefined();
    expect(createArgs.status).toBeUndefined();
    expect(createArgs.assigneeUserId).toBe("user-42");
    expect(createArgs.assigneeAgentId).toBeUndefined();
  });

  it("applies configured issue route overrides", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      issueRouteMap: {
        class: {
          physical_infra_disk: {
            projectId: "project-override",
            goalId: "goal-override",
            assigneeAgentId: "agent-override",
            status: "todo",
          },
        },
      },
      ownerMap: {},
    });
    const alert = baseAlert({
      labels: {
        alertname: "PhysicalInfraDiskReallocatedSectorsHigh",
        severity: "warning",
        class: "physical_infra_disk",
      },
      fingerprint: "physical-disk-1",
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.projectId).toBe("project-override");
    expect(createArgs.goalId).toBe("goal-override");
    expect(createArgs.status).toBe("todo");
    expect(createArgs.assigneeAgentId).toBe("agent-override");
  });

  it("lets explicit assignee overrides win over route assignees", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
      ownerMap: {},
    });
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const alert = baseAlert({
      labels: {
        alertname: "PhysicalInfraProxmoxApiDown",
        severity: "critical",
        class: "physical_infra_proxmox",
        paperclip_assignee_email: "bob@example.com",
      },
      fingerprint: "physical-proxmox-1",
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.projectId).toBe(BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID);
    expect(createArgs.goalId).toBe(BLOCKCAST_PHYSICAL_INFRA_GOAL_ID);
    expect(createArgs.status).toBe("todo");
    expect(createArgs.assigneeUserId).toBe("user-bob");
    expect(createArgs.assigneeAgentId).toBeUndefined();
  });
});

describe("handleWebhook — dedup on re-fire", () => {
  it("does not create a second issue when an open one already exists", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "in_progress" });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).not.toHaveBeenCalled();
    // It should bump the description but not change status
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
    );
    const updatePatch = mocks.issues.update.mock.calls[0][1];
    expect(updatePatch.status).toBeUndefined();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.deduped",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("re-opens a closed issue on re-fire after manual resolve (§8.3)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: "2026-04-29T09:00:00Z",
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "done" });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ status: "todo" }),
      "company-1",
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.reopened",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("does not re-open an operator-cancelled issue on re-fire", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.firing.reopened",
      expect.any(Number),
      expect.any(Object),
    );
  });
});

describe("handleWebhook — resolved", () => {
  it("posts a comment when autoCloseOnResolve=false", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.listComments).toHaveBeenCalledWith(
      "issue-existing",
      "company-1",
    );
    expect(mocks.issues.createComment).toHaveBeenCalledWith(
      "issue-existing",
      "Alert resolved at 2026-04-29T10:00:00Z.",
      "company-1",
    );
    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.resolved",
      "company-1",
      expect.objectContaining({
        paperclipIssueId: "issue-existing",
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("does not duplicate an existing resolved comment on retry", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.listComments.mockResolvedValueOnce([
      { body: "Alert resolved at 2026-04-29T10:00:00Z." },
    ]);

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "alert:9a3b1e4c5f6d7890",
      },
      expect.objectContaining({
        paperclipIssueId: "issue-existing",
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("cancels the issue when autoCloseOnResolve=true", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "X",
      severity: "info",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("fails the delivery without marking resolved when issue cancellation fails", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });
    mocks.issues.update.mockRejectedValueOnce(new Error("issues.update RPC unavailable"));

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await expect(
      handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope })),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    expect(mocks.state.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolvedAt: "2026-04-29T10:00:00Z" }),
    );
  });

  it("fails the delivery without marking resolved when the resolution comment fails", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.createComment.mockRejectedValueOnce(
      new Error("issues.createComment RPC unavailable"),
    );

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await expect(
      handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope })),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    expect(mocks.issues.listComments).toHaveBeenCalledWith(
      "issue-existing",
      "company-1",
    );
    expect(mocks.state.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolvedAt: "2026-04-29T10:00:00Z" }),
    );
  });

  it("fails the delivery without marking resolved when cover cleanup fails", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    const execute = mocks.db.execute.getMockImplementation()!;
    mocks.db.execute.mockImplementation(async (...args) => {
      if (String(args[0]).includes("alert_escalation_cover_members")) {
        throw new Error("cover DB unavailable");
      }
      return execute(...args);
    });

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await expect(
      handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope })),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    expect(mocks.issues.createComment).toHaveBeenCalledWith(
      "issue-existing",
      "Alert resolved at 2026-04-29T10:00:00Z.",
      "company-1",
    );
    expect(mocks.state.set).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resolvedAt: "2026-04-29T10:00:00Z" }),
    );
  });

  it("cancels the issue when autoCloseOnResolve is omitted", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: undefined });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "PhysicalInfraQaSyntheticDiskRouteTest",
      severity: "warning",
      firstSeenAt: "2026-06-27T08:00:00Z",
      lastFiredAt: "2026-06-27T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      labels: {
        alertname: "PhysicalInfraQaSyntheticDiskRouteTest",
        severity: "warning",
        route_test: "true",
        qa_run: "BLO-12204",
        class: "physical_infra_disk",
      },
      endsAt: "2026-06-27T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("recovers missing state from the issue origin before cancelling", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    mocks.state.get.mockResolvedValueOnce(null);
    mocks.issues.list.mockResolvedValueOnce([
      {
        id: "issue-existing",
        assigneeUserId: null,
        assigneeAgentId: "agent-1",
      },
    ]);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.list).toHaveBeenCalledWith({
      companyId: "company-1",
      originKind: ORIGIN_KIND,
      originId: 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]',
      limit: 1,
    });
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.resolved",
      "company-1",
      expect.objectContaining({ paperclipIssueId: "issue-existing" }),
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      {
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "alert:9a3b1e4c5f6d7890",
      },
      expect.objectContaining({
        paperclipIssueId: "issue-existing",
        paperclipCompanyId: "company-1",
        assigneeAgentId: "agent-1",
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("does not recover and cancel an already-terminal issue", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    mocks.state.get.mockResolvedValueOnce(null);
    mocks.issues.list.mockResolvedValueOnce([
      {
        id: "issue-existing",
        status: "done",
        assigneeUserId: null,
        assigneeAgentId: "agent-1",
      },
    ]);

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
  });

  it("logs and drops resolved-without-state (no action taken)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.state.get.mockResolvedValueOnce(null);

    const resolvedAlert = baseAlert({ status: "resolved" });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
  });
});

describe("handleWebhook — acceptOnlyLabels filter", () => {
  it("skips alerts that don't match the filter", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ acceptOnlyLabels: { paperclip: "true" } });

    await handleWebhook(ctx, config, TOKEN, baseInput());

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.filtered",
      1,
      { alertname: "CiliumPolicyDropsHigh" },
    );
  });

  it("processes alerts that match the filter", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ acceptOnlyLabels: { paperclip: "true" } });
    const alert = baseAlert({
      labels: {
        alertname: "Watchdog",
        severity: "warning",
        paperclip: "true",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });
});

describe("handleWebhook — severity → priority", () => {
  it("maps severity=warning to priority=high using the default map", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ severityToPriority: undefined });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "warning" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("high");
  });

  it("operator severity-to-priority overrides the default", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      severityToPriority: { critical: "low" },
    });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("low");
  });

  it("falls back to medium for unknown severities", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      labels: { alertname: "X", severity: "page" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("medium");
  });
});

describe("handleWebhook — observability link rendering", () => {
  it("renders all reserved annotation keys plus generatorURL", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      annotations: {
        summary: "x",
        dashboard_url: "https://grafana/d/x",
        trace_url: "https://grafana/t",
        profile_url: "https://pyroscope/p",
        flow_query_url: "https://hubble/f",
        runbook_url: "https://runbooks/r",
        // Unsupported observability key — must NOT appear in the output.
        random_url: "https://attacker/",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const desc = mocks.issues.create.mock.calls[0][0].description as string;
    expect(desc).toContain("[Dashboard](https://grafana/d/x)");
    expect(desc).toContain("[Tempo trace](https://grafana/t)");
    expect(desc).toContain("[Pyroscope flamegraph](https://pyroscope/p)");
    expect(desc).toContain("[Hubble flow query](https://hubble/f)");
    expect(desc).toContain("[Runbook](https://runbooks/r)");
    expect(desc).toContain("[Source query in Prometheus](http://prometheus-0:9090/graph?g0.expr=foo)");
    expect(desc).not.toContain("https://attacker/");
  });
});

describe("handleWebhook — owner resolution fallback chain", () => {
  it("label override beats the owner-map", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-bob",
      email: "bob@example.com",
      name: "Bob",
    });
    const alert = baseAlert({
      labels: {
        alertname: "X",
        severity: "warning",
        team: "platform",
        paperclip_assignee_email: "bob@example.com",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).toHaveBeenCalledWith("bob@example.com");
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-bob");
  });

  it("owner-map resolves when no override is present", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-alice",
      email: "alice@example.com",
      name: "Alice",
    });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.users.findByEmail).toHaveBeenCalledWith("alice@example.com");
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-alice");
  });

  it("annotation override is the last resort before unassigned", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    mocks.users.findByEmail.mockResolvedValueOnce({
      id: "user-carol",
      email: "carol@example.com",
      name: "Carol",
    });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "warning" },
      annotations: { paperclip_assignee_email: "carol@example.com" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-carol");
  });

  it("uses the configured fallback agent when nothing resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "warning" },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).not.toHaveBeenCalled();
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
    expect(createArgs.assigneeAgentId).toBe("agent-fallback");
  });
});

describe("handleWebhook — issue creation floor", () => {
  it("creates no issue and writes no state for severity=info", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = baseAlert({
      labels: { alertname: "HindsightConsolidationStalled", severity: "info" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, baseConfig(), TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.below_issue_floor",
      1,
      { alertname: "HindsightConsolidationStalled", severity: "info" },
    );
  });

  it("honors paperclip_issue=false before side effects at any severity", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = baseAlert({
      labels: {
        alertname: "SuppressedCritical",
        severity: "critical",
        paperclip_issue: "false",
      },
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(ctx, baseConfig(), TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.db.execute).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.issue_opt_out",
      1,
      { alertname: "SuppressedCritical" },
    );
  });

  it("fails closed when fallback configuration cannot resolve", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.agents.list.mockResolvedValueOnce([]);
    const alert = baseAlert({
      labels: { alertname: "NoOwner", severity: "warning" },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });

    await handleWebhook(
      ctx,
      baseConfig({ ownerMap: {}, fallbackAgentName: "Missing Agent" }),
      TOKEN,
      baseInput({ parsedBody: envelope }),
    );

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.owner.fallback_failed",
      1,
      { alertname: "NoOwner", severity: "warning" },
    );
  });
});

describe("handleWebhook — aggregate lifecycle", () => {
  const aggregateAlerts = () =>
    ["fp-a", "fp-b", "fp-c"].map((fingerprint, index) =>
      baseAlert({
        fingerprint,
        labels: {
          alertname: "HindsightConsolidationStalled",
          severity: "warning",
          instance: `worker-${index}`,
        },
        annotations: {},
      }),
    );

  it("consolidates three label sets for one alertname into one issue", async () => {
    const { ctx, mocks } = mkCtx();
    const envelope = baseEnvelope({ alerts: aggregateAlerts() });

    await handleWebhook(ctx, baseConfig({ ownerMap: {} }), TOKEN, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.aggregate.joined",
      1,
      expect.objectContaining({ alertname: "HindsightConsolidationStalled" }),
    );
  });

  it("allows only one durable issue across concurrent first deliveries", async () => {
    const { ctx, mocks } = mkCtx();
    const issuesByOrigin = new Map<string, { id: string; status: string }>();
    mocks.issues.create.mockImplementation(async (input: { originId: string }) => {
      if (issuesByOrigin.has(input.originId)) throw new Error("unique violation");
      const issue = { id: "aggregate-issue", status: "todo" };
      issuesByOrigin.set(input.originId, issue);
      await Promise.resolve();
      return issue;
    });
    mocks.issues.list.mockImplementation(async (input: { originId: string }) => {
      const issue = issuesByOrigin.get(input.originId);
      return issue ? [issue] : [];
    });
    const [first, second] = aggregateAlerts();

    await Promise.all(
      [first, second].map((alert) => {
        const envelope = baseEnvelope({ alerts: [alert] });
        return handleWebhook(
          ctx,
          baseConfig({ ownerMap: {} }),
          TOKEN,
          baseInput({ parsedBody: envelope }),
        );
      }),
    );

    expect(issuesByOrigin).toHaveLength(1);
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.list).not.toHaveBeenCalled();
  });

  it("applies resolution only after the final firing member resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const alerts = aggregateAlerts();
    await handleWebhook(
      ctx,
      baseConfig({ ownerMap: {}, autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts }) }),
    );
    mocks.issues.update.mockClear();
    mocks.issues.get.mockResolvedValue({ id: "issue-1", status: "todo" });

    for (const [index, alert] of alerts.entries()) {
      const resolved = {
        ...alert,
        status: "resolved" as const,
        endsAt: `2026-04-29T10:0${index}:00Z`,
      };
      await handleWebhook(
        ctx,
        baseConfig({ ownerMap: {}, autoCloseOnResolve: true }),
        TOKEN,
        baseInput({
          parsedBody: baseEnvelope({ status: "resolved", alerts: [resolved] }),
        }),
      );
      expect(mocks.issues.update).toHaveBeenCalledTimes(index === 2 ? 1 : 0);
    }
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.aggregate.final_resolved",
      1,
      expect.objectContaining({ alertname: "HindsightConsolidationStalled" }),
    );
  });

  it("keeps explicit dedupe domains as distinct issues", async () => {
    const { ctx, mocks } = mkCtx();
    const alerts = ["node-a", "node-b"].map((node, index) =>
      baseAlert({
        fingerprint: `domain-${index}`,
        labels: {
          alertname: "NodeDiskPressure",
          severity: "warning",
          paperclip_dedupe_domain: node,
        },
      }),
    );

    await handleWebhook(
      ctx,
      baseConfig(),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts }) }),
    );

    expect(mocks.issues.create).toHaveBeenCalledTimes(2);
    expect(
      mocks.issues.create.mock.calls.map(([input]) => input.originId),
    ).toEqual([
      'alert-aggregate:v1:["NodeDiskPressure","node-a"]',
      'alert-aggregate:v1:["NodeDiskPressure","node-b"]',
    ]);
  });

  it("keeps identical aggregate keys isolated by company", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = aggregateAlerts()[0];
    const input = baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) });

    await handleWebhook(ctx, baseConfig({ defaultCompanyId: "company-a" }), TOKEN, input);
    await handleWebhook(ctx, baseConfig({ defaultCompanyId: "company-b" }), TOKEN, input);

    expect(mocks.issues.create).toHaveBeenCalledTimes(2);
    expect(mocks.issues.create.mock.calls.map(([value]) => value.companyId)).toEqual([
      "company-a",
      "company-b",
    ]);
  });

  it("reopens when another worker re-fires before final completion", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = aggregateAlerts()[0];
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );
    mocks.issues.update.mockClear();
    mocks.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "todo" })
      .mockResolvedValueOnce({ id: "issue-1", status: "cancelled" });
    mocks.db.beforeComplete = async () => {
      await joinAggregate(ctx, "company-1", alert);
    };

    const resolved = { ...alert, status: "resolved" as const, endsAt: "2026-04-29T10:00:00Z" };
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ status: "resolved", alerts: [resolved] }) }),
    );

    expect(mocks.issues.update.mock.calls.map(([, patch]) => patch)).toEqual([
      { status: "cancelled" },
      { status: "todo" },
    ]);
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.aggregate.final_resolved",
      expect.anything(),
      expect.anything(),
    );
    const aggregateState = await mocks.state.get({
      scopeKind: "instance",
      stateKey:
        'alert-aggregate:company-1:alert-aggregate:v1:["HindsightConsolidationStalled",null]',
    });
    expect(aggregateState).toEqual(expect.objectContaining({ resolvedAt: null }));
  });

  it("repairs a re-fire after the resolving worker dies following issue closure", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = aggregateAlerts()[0];
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );
    let issueStatus = "todo";
    mocks.issues.get.mockImplementation(async () => ({
      id: "issue-1",
      status: issueStatus,
    }));
    mocks.issues.update.mockImplementationOnce(async () => {
      issueStatus = "cancelled";
      await joinAggregate(ctx, "company-1", alert);
      throw new Error("worker died after external close");
    });
    const resolved = {
      ...alert,
      status: "resolved" as const,
      endsAt: "2026-04-29T10:00:00Z",
    };

    await expect(handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({
        parsedBody: baseEnvelope({ status: "resolved", alerts: [resolved] }),
      }),
    )).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    mocks.issues.update.mockImplementation(async (_id, patch) => {
      issueStatus = patch.status;
      return { id: "issue-1", status: issueStatus };
    });
    await reconcileAggregateLifecycle(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
    );

    expect(issueStatus).toBe("todo");
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("repaired re-fire"),
    );
  });

  it("retries final resolution for an already-resolved member", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = aggregateAlerts()[0];
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );
    mocks.issues.get.mockResolvedValue({ id: "issue-1", status: "todo" });
    mocks.issues.update
      .mockRejectedValueOnce(new Error("transient update failure"))
      .mockResolvedValue({ id: "issue-1" });
    const resolved = { ...alert, status: "resolved" as const, endsAt: "2026-04-29T10:00:00Z" };
    const input = baseInput({
      parsedBody: baseEnvelope({ status: "resolved", alerts: [resolved] }),
    });

    await expect(
      handleWebhook(ctx, baseConfig({ autoCloseOnResolve: true }), TOKEN, input),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    await reconcileAggregateLifecycle(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
    );

    expect(mocks.issues.update).toHaveBeenCalledTimes(2);
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.aggregate.final_resolved",
      1,
      expect.objectContaining({ alertname: "HindsightConsolidationStalled" }),
    );
  });

  it("allows a resolved legacy info alert through the creation floor", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = baseAlert({
      fingerprint: "legacy-info",
      status: "resolved",
      labels: { alertname: "LegacyInfo", severity: "info" },
      endsAt: "2026-04-29T10:00:00Z",
    });
    await mocks.state.set(
      { scopeKind: "instance", stateKey: "alert:legacy-info" },
      {
        paperclipIssueId: "legacy-issue",
        paperclipCompanyId: "company-1",
        alertname: "LegacyInfo",
        severity: "info",
        firstSeenAt: "2026-04-29T09:00:00Z",
        lastFiredAt: "2026-04-29T09:00:00Z",
        resolvedAt: null,
      },
    );
    mocks.issues.get.mockResolvedValue({ id: "legacy-issue", status: "todo" });

    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({
        parsedBody: baseEnvelope({ status: "resolved", alerts: [alert] }),
      }),
    );

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "legacy-issue",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.webhook.below_issue_floor",
      expect.anything(),
      expect.anything(),
    );
  });

  it("reopens a resolved aggregate when a new fingerprint joins", async () => {
    const { ctx, mocks } = mkCtx();
    const first = aggregateAlerts()[0];
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts: [first] }) }),
    );
    mocks.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "todo" })
      .mockResolvedValueOnce({ id: "issue-1", status: "cancelled" });
    const resolved = { ...first, status: "resolved" as const, endsAt: "2026-04-29T10:00:00Z" };
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ status: "resolved", alerts: [resolved] }) }),
    );
    const newcomer = { ...aggregateAlerts()[1], fingerprint: "fp-new" };
    await handleWebhook(
      ctx,
      baseConfig({ autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ parsedBody: baseEnvelope({ alerts: [newcomer] }) }),
    );

    expect(mocks.issues.update.mock.calls.map(([, patch]) => patch)).toEqual([
      { status: "cancelled" },
      expect.objectContaining({ status: "todo" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// BLO-20467 — per-company alert state.
//
// These use a Map-backed state store keyed by the full serialized ScopeKey
// rather than `vi.fn(async () => null)`, because the bug under test is
// specifically that two tenants resolved to the SAME key. A mock that always
// returns null cannot express a collision, so it would pass either way.
// ---------------------------------------------------------------------------

const mkStatefulCtx = (): { ctx: PluginContext; mocks: MockClients; store: Map<string, unknown> } => {
  const { ctx, mocks } = mkCtx();
  const store = new Map<string, unknown>();
  const keyOf = (ref: { scopeKind: string; scopeId?: string; stateKey: string }) =>
    `${ref.scopeKind}/${ref.scopeId ?? "-"}/${ref.stateKey}`;
  mocks.state.get.mockImplementation(async (ref) => store.get(keyOf(ref)) ?? null);
  mocks.state.set.mockImplementation(async (ref, value) => {
    store.set(keyOf(ref), value);
  });
  mocks.state.delete.mockImplementation(async (ref) => {
    store.delete(keyOf(ref));
  });
  return { ctx, mocks, store };
};

describe("BLO-20467 — alert state is namespaced per company", () => {
  it("two tenants reporting the SAME fingerprint each get their own issue", async () => {
    const { ctx, mocks } = mkStatefulCtx();
    // Same alert, same fingerprint — routine when two tenants run the same
    // alerting rules off the same upstream dashboards.
    const alert = baseAlert();
    const envelope = baseEnvelope({ alerts: [alert] });

    mocks.issues.create.mockImplementationOnce(async () => ({ id: "issue-A" }));
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-A" }),
      TOKEN,
      baseInput({ companyId: "company-A", parsedBody: envelope }),
    );

    mocks.issues.create.mockImplementationOnce(async () => ({ id: "issue-B" }));
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-B" }),
      TOKEN,
      baseInput({ companyId: "company-B", parsedBody: envelope }),
    );

    // Before the fix, B found A's instance-scoped row and took the re-fire
    // branch: one issue total, filed under A, and B's alert never tracked.
    expect(mocks.issues.create).toHaveBeenCalledTimes(2);
    expect(mocks.issues.create.mock.calls[0][0].companyId).toBe("company-A");
    expect(mocks.issues.create.mock.calls[1][0].companyId).toBe("company-B");

    expect(mocks.state.set).toHaveBeenCalledWith(
      { scopeKind: "company", scopeId: "company-A", stateKey: `alert:${alert.fingerprint}` },
      expect.objectContaining({ paperclipIssueId: "issue-A", paperclipCompanyId: "company-A" }),
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      { scopeKind: "company", scopeId: "company-B", stateKey: `alert:${alert.fingerprint}` },
      expect.objectContaining({ paperclipIssueId: "issue-B", paperclipCompanyId: "company-B" }),
    );
  });

  it("one tenant's resolution cannot close another tenant's issue on a shared fingerprint", async () => {
    const { ctx, mocks } = mkStatefulCtx();
    const alert = baseAlert();

    mocks.issues.create.mockImplementationOnce(async () => ({ id: "issue-A" }));
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-A" }),
      TOKEN,
      baseInput({ companyId: "company-A", parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );

    // Company B resolves the same fingerprint. B has no record of it, and must
    // not reach for A's. `issues.list` returns [] so recoverStateFromIssue —
    // which is already company-scoped — finds nothing either.
    //
    // issues.get must return an OPEN issue: handleResolved only calls update
    // when the looked-up issue exists and is still open, so leaving the default
    // `null` here would make the assertions below pass even with the bug.
    mocks.issues.get.mockImplementation(async () => ({ id: "issue-A", status: "todo" }));
    const resolvedEnvelope = baseEnvelope({
      status: "resolved",
      alerts: [{ ...alert, status: "resolved", endsAt: "2026-04-29T10:00:00Z" }],
    });
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-B", autoCloseOnResolve: true }),
      TOKEN,
      baseInput({ companyId: "company-B", parsedBody: resolvedEnvelope }),
    );

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("adopts a pre-upgrade instance-scoped row for the company that owns it", async () => {
    const { ctx, mocks, store } = mkStatefulCtx();
    const alert = baseAlert();
    // A row written by the old build, before state was company-scoped.
    const legacy: AlertStateRecord = {
      paperclipIssueId: "issue-legacy",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    store.set(`instance/-/alert:${alert.fingerprint}`, legacy);
    mocks.issues.get.mockImplementation(async () => ({ id: "issue-legacy", status: "todo" }));

    await handleWebhook(ctx, baseConfig(), TOKEN, baseInput());

    // Treated as a re-fire of the tracked issue, NOT as a brand-new alert.
    // Without the read-through, every alert firing across the upgrade would
    // duplicate its issue and orphan the original.
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(store.get(`company/company-1/alert:${alert.fingerprint}`)).toBeTruthy();
    // Legacy row removed so it cannot be re-adopted later.
    expect(store.has(`instance/-/alert:${alert.fingerprint}`)).toBe(false);
  });

  it("refuses to adopt a legacy row belonging to a different company", async () => {
    const { ctx, mocks, store } = mkStatefulCtx();
    const alert = baseAlert();
    const legacy: AlertStateRecord = {
      paperclipIssueId: "issue-other-tenant",
      paperclipCompanyId: "company-OTHER",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    store.set(`instance/-/alert:${alert.fingerprint}`, legacy);

    await handleWebhook(ctx, baseConfig(), TOKEN, baseInput());

    // company-1 files its own issue and never touches company-OTHER's.
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create.mock.calls[0][0].companyId).toBe("company-1");
    expect(mocks.issues.update).not.toHaveBeenCalled();
    // The other tenant's row is left exactly where it was.
    expect(store.get(`instance/-/alert:${alert.fingerprint}`)).toEqual(legacy);
  });
});

// ---------------------------------------------------------------------------
// Delivery acknowledgement semantics
//
// Regression cover for BLO-20467: the per-alert catch swallowed downstream
// failures and returned normally, so the host recorded `success` + HTTP 200 and
// Alertmanager stopped retrying a delivery that produced no durable issue or
// state row. Batch isolation is preserved — siblings still run — but the
// delivery must FAIL so the alert survives.
// ---------------------------------------------------------------------------

describe("handleWebhook — delivery acknowledgement", () => {
  const twoAlertEnvelope = () =>
    baseEnvelope({
      alerts: [
        baseAlert({ fingerprint: "aaaa1111" }),
        baseAlert({ fingerprint: "bbbb2222" }),
      ],
    });

  it("rejects the delivery when issue creation fails", async () => {
    const { ctx } = mkCtx();
    (ctx as unknown as MockClients).issues.create.mockRejectedValue(
      new Error("issues.create RPC unavailable"),
    );

    await expect(
      handleWebhook(ctx, baseConfig(), TOKEN, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
  });

  it("rejects the delivery when persisting alert state fails", async () => {
    const { ctx } = mkCtx();
    (ctx as unknown as MockClients).state.set.mockRejectedValue(
      new Error("plugin state store unavailable"),
    );

    await expect(
      handleWebhook(ctx, baseConfig(), TOKEN, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
  });

  it("still processes sibling alerts, then fails the delivery naming only the failed one", async () => {
    // Batch isolation and non-acknowledgement are both required; a fix that
    // aborted the loop on first failure would pass the assertions above and
    // still regress the behaviour this catch exists for.
    const { ctx, mocks } = mkCtx();
    // Fail the first alert only; the mapper owns title construction, so drive
    // the failure off call order rather than asserting on issue fields here.
    let call = 0;
    mocks.issues.create.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error("issues.create RPC unavailable");
      return { id: "issue-ok" };
    });

    const err = await handleWebhook(
      ctx,
      baseConfig(),
      TOKEN,
      baseInput({ parsedBody: twoAlertEnvelope() }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AlertDeliveryIncompleteError);
    // The second alert was still attempted despite the first one failing.
    expect(mocks.issues.create).toHaveBeenCalledTimes(2);
    expect((err as AlertDeliveryIncompleteError).fingerprints).toEqual(["aaaa1111"]);
  });

  it("acknowledges (returns) when every alert succeeds", async () => {
    const { ctx } = mkCtx();
    await expect(
      handleWebhook(ctx, baseConfig(), TOKEN, baseInput({ parsedBody: twoAlertEnvelope() })),
    ).resolves.toBeUndefined();
  });

  it("still acknowledges a malformed payload — permanent, so retrying is pointless", async () => {
    const { ctx } = mkCtx();
    await expect(
      handleWebhook(ctx, baseConfig(), TOKEN, baseInput({ parsedBody: { nope: true } })),
    ).resolves.toBeUndefined();
  });

  it("does not let a metrics outage abort the remaining alerts", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.issues.create.mockRejectedValue(new Error("issues.create RPC unavailable"));
    mocks.metrics.write.mockRejectedValue(new Error("metrics sink unavailable"));

    const err = await handleWebhook(
      ctx,
      baseConfig(),
      TOKEN,
      baseInput({ parsedBody: twoAlertEnvelope() }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AlertDeliveryIncompleteError);
    expect((err as AlertDeliveryIncompleteError).fingerprints).toEqual([
      "aaaa1111",
      "bbbb2222",
    ]);
  });
});

// ---------------------------------------------------------------------------
// BLO-20467 — a retried delivery must not duplicate the issue the failed
// attempt already created.
//
// `issues.create` commits before its `state.set`. Once a lost alert stopped
// being acknowledged, a state-store failure between those two calls started
// producing a *retry* — and a retry that trusted the state miss would file a
// second issue for the same fingerprint. Under a repeating state-store outage
// that is an unbounded duplicate-issue storm, so this is a regression guard on
// the fix for silent loss, not an independent nicety.
//
// Both tests drive the handler TWICE; a single invocation cannot observe the
// duplicate at all. They also fail only the `alert:` write rather than "the
// first state.set" — the firing path writes an owner-email cache entry first
// and swallows its failure, so a blanket `mockRejectedValueOnce` is absorbed
// there, the delivery succeeds, and the test passes against unfixed code.
// ---------------------------------------------------------------------------
describe("BLO-20467 — firing retries are idempotent across create/state-write", () => {
  /** Stateful ctx whose *alert-state* writes fail while `fail.on` is true. */
  const mkFlakyStateCtx = () => {
    const { ctx, mocks, store } = mkStatefulCtx();
    const fail = { on: true };
    const prior = mocks.state.set.getMockImplementation()!;
    mocks.state.set.mockImplementation(async (ref: { stateKey: string }, value: unknown) => {
      if (fail.on && ref.stateKey.startsWith("alert:")) {
        throw new Error("plugin state store unavailable");
      }
      return prior(ref, value);
    });
    return { ctx, mocks, store, fail };
  };

  const liveIssue = [
    { id: "issue-from-attempt-1", status: "todo", assigneeUserId: null, assigneeAgentId: null },
  ];

  it("adopts the issue the failed attempt created instead of filing a second one", async () => {
    const { ctx, mocks, fail } = mkFlakyStateCtx();
    const input = baseInput({ parsedBody: baseEnvelope({ alerts: [baseAlert()] }) });
    mocks.issues.create.mockResolvedValue({ id: "issue-from-attempt-1" });

    // Attempt 1: the issue commits, then its state write fails.
    await expect(handleWebhook(ctx, baseConfig(), TOKEN, input)).rejects.toBeInstanceOf(
      AlertDeliveryIncompleteError,
    );
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);

    // Attempt 2 is Alertmanager's retry. The state store is still empty — the
    // write that would have populated it is exactly what failed — so the only
    // way to avoid a duplicate is to reconcile against the existing issue.
    fail.on = false;
    mocks.issues.list.mockResolvedValue(liveIssue);
    await handleWebhook(ctx, baseConfig(), TOKEN, input);

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    // The retry must also leave durable state behind, or every later delivery
    // repeats this reconciliation and the ladder never arms.
    expect(mocks.state.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeKind: "company", stateKey: "alert:9a3b1e4c5f6d7890" }),
      expect.objectContaining({ paperclipIssueId: "issue-from-attempt-1", resolvedAt: null }),
    );
  });

  it("arms the escalation ladder on the adopted record", async () => {
    // Recovery rebuilds the record from the issue, which carries no ladder
    // fields, and the re-fire branch passes them through unchanged. Leaving
    // them unset would silently disarm escalation for exactly the alert whose
    // state was lost — dedup still works, so the assertions above pass either
    // way and cannot catch this.
    const { ctx, mocks, fail } = mkFlakyStateCtx();
    const input = baseInput({ parsedBody: baseEnvelope({ alerts: [baseAlert()] }) });
    mocks.issues.create.mockResolvedValue({ id: "issue-from-attempt-1" });

    await handleWebhook(ctx, baseConfig(), TOKEN, input).catch(() => {});
    fail.on = false;
    mocks.issues.list.mockResolvedValue(liveIssue);
    await handleWebhook(ctx, baseConfig(), TOKEN, input);

    const persisted = mocks.state.set.mock.calls.at(-1)?.[1] as {
      nextEscalationAt: string | null;
      escalationComplete?: boolean;
    };
    expect(persisted.nextEscalationAt).toEqual(expect.any(String));
    expect(persisted.escalationComplete).toBe(false);
  });
});

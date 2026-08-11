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
import { getCredentialHealth, resetCredentialHealth } from "../credential-health.js";
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
  db: {
    namespace: string;
    execute: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
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
  const mocks: MockClients = {
    state: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
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
    db: {
      namespace: "alertmanager",
      execute: vi.fn(async () => ({ rowCount: 0 })),
      query: vi.fn(async () => []),
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
  resetCredentialHealth();
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

// ---------------------------------------------------------------------------
// BLO-20572 — credential-resolution health, derived from delivery outcomes
// ---------------------------------------------------------------------------

describe("handleWebhook — credential health (BLO-20572)", () => {
  it("reports ok when no delivery has happened yet", () => {
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("reports degraded, naming the company, after a delivery resolves no token", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ companyId: "company-no-token", headers: {} });

    // resolvedToken is null: this company's config has no credential at all,
    // same as what config-scope.ts's resolveWebhookToken() returns.
    await expect(handleWebhook(ctx, config, null, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );

    const health = getCredentialHealth();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("company-no-token");
    expect(health.details).toEqual({ companyIds: ["company-no-token"] });
  });

  it("does not flag a company whose token is configured but was presented wrong", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({
      companyId: "company-real-token",
      headers: { authorization: "Bearer wrong-value" },
    });

    // resolvedToken is non-null: the company DOES have a credential
    // configured. This request just presented the wrong one — an auth
    // failure, not a misconfiguration, and must not report unhealthy.
    await expect(handleWebhook(ctx, config, TOKEN, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );

    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("clears once a later delivery for the same company resolves a credential — no restart needed", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();

    await expect(
      handleWebhook(ctx, config, null, baseInput({ companyId: "company-1", headers: {} })),
    ).rejects.toBeInstanceOf(WebhookUnauthorizedError);
    expect(getCredentialHealth().status).toBe("degraded");

    await handleWebhook(ctx, config, TOKEN, baseInput({ companyId: "company-1" }));

    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("tracks multiple companies independently and never leaks a token value", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();

    await expect(
      handleWebhook(ctx, config, null, baseInput({ companyId: "company-a", headers: {} })),
    ).rejects.toBeInstanceOf(WebhookUnauthorizedError);
    await expect(
      handleWebhook(ctx, config, null, baseInput({ companyId: "company-b", headers: {} })),
    ).rejects.toBeInstanceOf(WebhookUnauthorizedError);
    await handleWebhook(ctx, config, TOKEN, baseInput({ companyId: "company-c" }));

    const health = getCredentialHealth();
    expect(health.details).toEqual({ companyIds: ["company-a", "company-b"] });
    expect(JSON.stringify(health)).not.toContain(TOKEN);

    // company-a recovers; company-b remains flagged.
    await handleWebhook(ctx, config, TOKEN, baseInput({ companyId: "company-a" }));
    expect(getCredentialHealth().details).toEqual({ companyIds: ["company-b"] });
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
    expect(createArgs.originId).toBe("9a3b1e4c5f6d7890");
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

  it("creates the issue unassigned when no owner resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    await handleWebhook(ctx, config, TOKEN, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
  });

  it("forwards billing_code label to ctx.issues.create", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const alert = baseAlert({
      labels: {
        alertname: "X",
        severity: "info",
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
    mocks.db.execute.mockRejectedValueOnce(new Error("cover DB unavailable"));

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
      originId: resolvedAlert.fingerprint,
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
        severity: "info",
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
        severity: "info",
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
      labels: { alertname: "X", severity: "info" },
      annotations: { paperclip_assignee_email: "carol@example.com" },
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-carol");
  });

  it("creates the issue unassigned when nothing resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "info" },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, TOKEN, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).not.toHaveBeenCalled();
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
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

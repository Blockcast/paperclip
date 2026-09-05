/**
 * Webhook handler tests — drives `handleWebhook` directly with a mock
 * PluginContext so we don't need to spin up the full worker RPC host.
 *
 * Test pattern mirrors `paperclip-plugin-slack/src/__tests__/user-mapping.test.ts`:
 * a `mkCtx()` factory that returns vitest-mocked clients, plus a typed
 * `unknownCast` helper to keep us inside strict TS.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  AlertDeliveryIncompleteError,
  WebhookUnauthorizedError,
  decideRefire,
  handleWebhook,
  handleFiring,
  recoverAggregateFiring,
  verifyBearerToken,
} from "../webhook-handler.js";
import {
  handleRecoveryApiRequest,
  listAggregateFiringFences,
  LIST_AGGREGATE_FIRING_FENCES_ROUTE,
  RECOVER_AGGREGATE_FIRING_ROUTE,
  RECOVER_AGGREGATE_FIRING_ACTION,
  registerRecoveryAction,
} from "../recovery-action.js";
import {
  CompanyScopeUnavailableError,
  authenticateWebhook,
  resolveCompanyScope,
} from "../config-scope.js";
import { getCredentialHealth, resetCredentialHealth } from "../credential-health.js";
import {
  BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
  BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
  BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
  DEFAULT_ISSUE_ROUTE_MAP,
  MAX_OPERATOR_SUPPRESSION_HOURS,
} from "../constants.js";
import { ORIGIN_KIND } from "../types.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
  AlertStateRecord,
} from "../types.js";
import type {
  PluginApiRequestInput,
  PluginContext,
  PluginPerformActionContext,
  PluginWebhookInput,
} from "@paperclipai/plugin-sdk";

/**
 * BLO-31036 — the firing tail is guarded, so `ctx.state.set` and
 * `ctx.events.emit` take one more argument on that path: the generation the
 * host checks.
 *
 * The two are pinned separately and under different option names on purpose,
 * because the guarantees differ. `state.set`'s `fencing` is a true fence — the
 * host takes the generation lock inside the write's own transaction and holds
 * it to commit. `events.emit`'s `ownershipCheck` is a best-effort pre-dispatch
 * check on an in-memory fan-out that has no transaction to join; a steal in the
 * check -> dispatch window still delivers. Both halves are pinned at the host in
 * `server/src/__tests__/plugin-events-ownership-check.test.ts`.
 *
 * Pinned, not ignored. Relaxing these to `expect.anything()` — or dropping the
 * trailing argument so vitest only checks a prefix — would leave them green
 * with the guard removed, which is the exact regression they now catch. The
 * token itself is a per-claim UUID, so its presence and the phase holding it
 * are the strongest things assertable without reaching into the fence table.
 */
const FIRING_GENERATION_MATCH = {
  table: "alertmanager_aggregate_lifecycle_fences",
  match: expect.objectContaining({
    phase: "firing",
    firing_token: expect.any(String),
  }),
};

/** `ctx.state.set(..., { fencing })` — a true transactional fence. */
const FIRING_FENCE_ARG = { fencing: FIRING_GENERATION_MATCH };

/** `ctx.events.emit(..., { ownershipCheck })` — best-effort, not a fence. */
const FIRING_EMIT_OWNERSHIP_ARG = { ownershipCheck: FIRING_GENERATION_MATCH };

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TOKEN = "super-secret-token";

// Named fallback owner (BLO-21310 item 1). The harness models a *correctly
// configured* instance: without a resolvable `fallbackAgentName`, creation now
// fails closed rather than filing an ownerless issue, so every creation test
// would otherwise be exercising the misconfiguration path.
const FALLBACK_AGENT_NAME = "Ops Triage";
const FALLBACK_AGENT_ID = "agent-fallback-1";

/**
 * The firing-generation barrier's read (BLO-31036): "do I still hold the fence
 * I claimed?", issued before the delivery's first aggregate side effect.
 *
 * Every firing scenario in this file is a single uncontended delivery, so the
 * truthful answer is yes. A mock that answered `[]` would be asserting that
 * each of them was displaced mid-flight, which is not what they are about.
 * Fence *contention* is exercised against a real PostgreSQL in
 * aggregate-fence-restart-safety.test.ts — reproducing it here would only
 * re-assert the mock, the trap that file's header documents.
 */
const FENCE_GENERATION_SELECT =
  /SELECT 1[\s\S]*alertmanager_aggregate_lifecycle_fences[\s\S]*firing_token/i;
const HELD_FENCE = [{ "?column?": 1 }];

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
  state: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  users: { get: ReturnType<typeof vi.fn>; findByEmail: ReturnType<typeof vi.fn> };
  agents: { list: ReturnType<typeof vi.fn> };
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
  actions: { register: ReturnType<typeof vi.fn> };
  secrets: { resolve: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  config: { get: ReturnType<typeof vi.fn> };
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
    agents: {
      list: vi.fn(async () => [
        { id: "agent-fallback", name: "Alert Fallback", status: "idle" },
      ]),
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
      execute: vi.fn(async (sql: string) => {
        if (
          /INSERT INTO alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
          /INSERT INTO alertmanager\.alertmanager_aggregate_members/i.test(sql) ||
          /DELETE FROM alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
          /INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql) ||
          /UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)
        ) {
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }),
      query: vi.fn(async (sql: string) => {
        if (FENCE_GENERATION_SELECT.test(sql)) return HELD_FENCE;
        return [];
      }),
    },
    events: { emit: vi.fn(async () => {}) },
    metrics: { write: vi.fn(async () => {}) },
    activity: { log: vi.fn(async () => {}) },
    actions: { register: vi.fn() },
    secrets: {
      resolve: vi.fn(async () => TOKEN),
      verify: vi.fn(async (_ref, presented) => presented === TOKEN),
    },
    // Company-scoped config RPC. `resolveCompanyScope` is the only credential
    // -health recorder now that `handleWebhook` takes a verdict rather than a
    // credential, so the health tests below drive this rather than the handler.
    config: {
      get: vi.fn(async (companyId?: string) => ({
        ...baseConfig(),
        defaultCompanyId: companyId ?? "company-1",
      })),
    },
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
  issuedContexts.push(mocks);
  return { ctx, mocks };
};

// Every `ctx.db.query` the plugin issues has to satisfy the host's SELECT-only
// contract (`validatePluginRuntimeQuery`, server/src/services/plugin-database.ts).
// This mock used to accept any SQL, so an `UPDATE ... RETURNING` routed through
// `ctx.db.query` passed every test in this file and then threw
// "ctx.db.query only allows SELECT statements" against the real host, 502-ing
// every resolve delivery for an aggregate-tracked fingerprint for ~26.5h
// (BLO-31035). Asserting the rule over the recorded calls — rather than inside
// the mock implementation — keeps the guard in force for the tests that install
// their own `db.query` implementation, so each of them covers the bug class too.
const issuedContexts: MockClients[] = [];

const assertQueryIsSelectOnly = (sql: string) => {
  const normalized = sql.trim().toLowerCase().replace(/\s+/g, " ");
  const preview = sql.trim().slice(0, 140);
  expect(
    normalized.startsWith("select ") || normalized.startsWith("with "),
    `ctx.db.query only allows SELECT statements, got: ${preview}`,
  ).toBe(true);
  expect(
    /\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized),
    `ctx.db.query cannot contain mutation or DDL keywords, got: ${preview}`,
  ).toBe(false);
};

beforeEach(() => {
  issuedContexts.length = 0;
  vi.clearAllMocks();
  resetCredentialHealth();
});

afterEach(() => {
  for (const mocks of issuedContexts) {
    for (const call of mocks.db.query.mock.calls) {
      const sql = call[0];
      if (typeof sql === "string") assertQueryIsSelectOnly(sql);
    }
  }
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
  it("uses host verification for secret refs without resolving the secret", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ webhookToken: undefined, webhookTokenRef: "secret-ref" });
    const input = baseInput();

    const authenticated = await authenticateWebhook(ctx, config, input);
    await handleWebhook(ctx, config, authenticated, input);

    expect(mocks.secrets.verify).toHaveBeenCalledWith("secret-ref", TOKEN, {
      companyId: "company-1",
      configPath: "webhookTokenRef",
    });
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing bearer before calling host verification", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ webhookToken: undefined, webhookTokenRef: "secret-ref" });

    await expect(authenticateWebhook(ctx, config, baseInput({ headers: {} }))).resolves.toBe(false);
    expect(mocks.secrets.verify).not.toHaveBeenCalled();
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
  });

  it("prefers a secret ref over a stale inline fallback", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.secrets.verify.mockResolvedValueOnce(false);
    const config = baseConfig({ webhookToken: TOKEN, webhookTokenRef: "secret-ref" });

    await expect(authenticateWebhook(ctx, config, baseInput())).resolves.toBe(false);
    expect(mocks.secrets.verify).toHaveBeenCalledTimes(1);
  });

  // The inline-token branch (config-scope.ts:147) authenticates every tenant
  // that has not moved to a ref, so it is exercised end to end here rather
  // than only implied by `verifyBearerToken`'s unit tests above.
  it("authenticates an inline token without consulting the host", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();

    await expect(authenticateWebhook(ctx, config, baseInput())).resolves.toBe(true);
    expect(mocks.secrets.verify).not.toHaveBeenCalled();
    expect(mocks.secrets.resolve).not.toHaveBeenCalled();
  });

  it("throws WebhookUnauthorizedError when bearer token is missing", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: {} });
    const authenticated = await authenticateWebhook(ctx, config, input);
    expect(authenticated).toBe(false);
    await expect(handleWebhook(ctx, config, authenticated, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("throws WebhookUnauthorizedError on a bad token", async () => {
    const { ctx } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ headers: { authorization: "Bearer nope" } });
    const authenticated = await authenticateWebhook(ctx, config, input);
    expect(authenticated).toBe(false);
    await expect(handleWebhook(ctx, config, authenticated, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );
  });

  it("accepts a correct bearer token and processes the payload", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput();
    const authenticated = await authenticateWebhook(ctx, config, input);
    expect(authenticated).toBe(true);
    await handleWebhook(ctx, config, authenticated, input);
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// BLO-20572 — credential-resolution health, derived from delivery outcomes
//
// Driven through `resolveCompanyScope`, which is the only recorder on the
// delivery path. `handleWebhook` deliberately records nothing: it is handed an
// authentication verdict rather than a credential (BLO-20738), so it cannot
// tell "no credential configured" from "wrong bearer presented" — and letting
// a wrong bearer mark a tenant degraded is the conflation this surface exists
// to avoid. The "presented wrong" case below pins exactly that.
// ---------------------------------------------------------------------------

describe("credential health (BLO-20572)", () => {
  // A stored config for `companyId` that carries neither credential shape.
  const configWithoutCredential = (companyId: string) => ({
    ...baseConfig({ webhookToken: undefined }),
    defaultCompanyId: companyId,
  });

  it("reports ok when no delivery has happened yet", () => {
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("reports degraded, naming the company, after a delivery resolves no token", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.config.get.mockResolvedValueOnce(configWithoutCredential("company-no-token"));

    await resolveCompanyScope(ctx, "company-no-token");

    const health = getCredentialHealth();
    expect(health.status).toBe("degraded");
    expect(health.message).toContain("company-no-token");
    expect(health.details).toEqual({ companyIds: ["company-no-token"] });
  });

  it("reports degraded when the company has no stored config at all", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.config.get.mockResolvedValueOnce({});

    await expect(resolveCompanyScope(ctx, "company-unconfigured")).rejects.toBeInstanceOf(
      CompanyScopeUnavailableError,
    );

    expect(getCredentialHealth().details).toEqual({ companyIds: ["company-unconfigured"] });
  });

  it("does not flag a company whose token is configured but was presented wrong", async () => {
    const { ctx } = mkCtx();
    const input = baseInput({
      companyId: "company-real-token",
      headers: { authorization: "Bearer wrong-value" },
    });

    const scope = await resolveCompanyScope(ctx, "company-real-token");
    const authenticated = await authenticateWebhook(ctx, scope!.config, input);
    expect(authenticated).toBe(false);
    await expect(handleWebhook(ctx, scope!.config, authenticated, input)).rejects.toBeInstanceOf(
      WebhookUnauthorizedError,
    );

    // The company DOES have a credential configured; this request just
    // presented the wrong one. That is an auth failure, not a
    // misconfiguration, and must not report unhealthy.
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("treats a webhookTokenRef company as credentialed even when the bearer is wrong", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.config.get.mockResolvedValueOnce({
      ...baseConfig({ webhookToken: undefined, webhookTokenRef: "secret-ref" }),
      defaultCompanyId: "company-ref",
    });
    const input = baseInput({
      companyId: "company-ref",
      headers: { authorization: "Bearer wrong-value" },
    });

    const scope = await resolveCompanyScope(ctx, "company-ref");
    await expect(authenticateWebhook(ctx, scope!.config, input)).resolves.toBe(false);

    // A ref-configured tenant resolves no inline token by design, so recording
    // the resolved token would report every such tenant credential-less while
    // its deliveries authenticate perfectly.
    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("clears once a later delivery for the same company resolves a credential — no restart needed", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.config.get.mockResolvedValueOnce(configWithoutCredential("company-1"));

    await resolveCompanyScope(ctx, "company-1");
    expect(getCredentialHealth().status).toBe("degraded");

    await resolveCompanyScope(ctx, "company-1");

    expect(getCredentialHealth()).toEqual({ status: "ok" });
  });

  it("tracks multiple companies independently and never leaks a token value", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.config.get
      .mockResolvedValueOnce(configWithoutCredential("company-a"))
      .mockResolvedValueOnce(configWithoutCredential("company-b"));

    await resolveCompanyScope(ctx, "company-a");
    await resolveCompanyScope(ctx, "company-b");
    await resolveCompanyScope(ctx, "company-c");

    const health = getCredentialHealth();
    expect(health.details).toEqual({ companyIds: ["company-a", "company-b"] });
    expect(JSON.stringify(health)).not.toContain(TOKEN);

    // company-a recovers; company-b remains flagged.
    await resolveCompanyScope(ctx, "company-a");
    expect(getCredentialHealth().details).toEqual({ companyIds: ["company-b"] });
  });
});

describe("handleWebhook — schema validation", () => {
  it("drops malformed payloads (writes a metric, returns 200-equivalent)", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const input = baseInput({ parsedBody: { not: "an alertmanager payload" } });
    await handleWebhook(ctx, config, true, input);
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
    await handleWebhook(ctx, config, true, input);
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
    await handleWebhook(ctx, config, true, input);
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

    await handleWebhook(ctx, config, true, baseInput());

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
      FIRING_FENCE_ARG,
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
      FIRING_EMIT_OWNERSHIP_ARG,
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
    await handleWebhook(ctx, config, true, baseInput());
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
    expect(createArgs.assigneeAgentId).toBe("agent-fallback");
  });

  it("fails closed when the fallback agent configuration is missing", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {}, fallbackAgentName: undefined });
    // The fail-closed guarantee (BLO-26613) is unchanged and still asserted
    // below: no ownerless issue, no state row. PEN-2581 changed only how the
    // drop is *reported* — an unresolvable owner is a config/roster fact no
    // retry can fix, so the delivery acknowledges it instead of failing.
    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).resolves.toBeUndefined();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.owner.fallback_failed",
      1,
      {
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        refusal: "permanent",
      },
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("drops one ownerless alert without aborting the loop or failing the delivery", async () => {
    // What this pins, stated precisely, because the obvious reading is wrong:
    // the per-alert catch in `handleWebhook` ALREADY kept the rest of the batch
    // processing before PEN-2581. The catch is inside the loop and
    // `AlertDeliveryIncompleteError` is thrown only after it completes, so a
    // sibling alert's issue was created on the first attempt even when the
    // delivery reported 502. Verified by running it, not assumed, and
    // reproducible as written: neutralise the carve-out (`const permanent =
    // false` at the per-alert catch in `webhook-handler.ts`), then comment out
    // BOTH the outcome assertion below and the `permanent_error` assertion at
    // the end — on the pre-change source that alert reports through
    // `alertmanager.alert.error`. The `issues.create` and `alert:` state
    // assertions still pass. Both have to be neutralised first because Vitest
    // aborts a test at its first failing assertion, so a run that trips the
    // outcome assertion never reaches the ones that carry the point.
    //
    // What PEN-2581 actually changed is the delivery's reported *outcome*: the
    // ownerless fingerprint is no longer accumulated, so Alertmanager is no
    // longer told to retry a batch 15-17× for a fault no retry can fix, and the
    // resulting failure storm no longer masks genuinely-transient failures that
    // retrying would have fixed.
    //
    // The production incident did dark-tier every alert, but for an
    // incident-specific reason rather than a structural one: with
    // `fallbackAgentName` unset, *every* unmapped alert in the batch took this
    // same throw, so there were no healthy siblings left to survive. That case
    // is real and reachable — it is just not what "one ownerless alert" does to
    // a mixed batch, which is what this test covers.
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ fallbackAgentName: undefined });
    // team=platform resolves through ownerMap; team=storage is unmapped, and
    // with no fallbackAgentName it is permanently ownerless.
    mocks.users.findByEmail.mockResolvedValue({
      id: "user-42",
      email: "alice@example.com",
      name: "Alice",
    });
    const owned = baseAlert({
      labels: {
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        team: "platform",
        node: "pve-3",
      },
      fingerprint: "aaaa1111",
    });
    const ownerless = baseAlert({
      labels: {
        alertname: "CephOsdNearFull",
        severity: "critical",
        team: "storage",
        node: "pve-4",
      },
      fingerprint: "bbbb2222",
    });

    await expect(
      handleWebhook(
        ctx,
        config,
        true,
        baseInput({
          parsedBody: baseEnvelope({ alerts: [ownerless, owned] }),
        }),
      ),
    ).resolves.toBeUndefined();

    // The healthy alert still became tracked work — and it is ordered SECOND in
    // the payload, behind the ownerless one, so this pins that the permanent
    // drop does not abort the remainder of the loop.
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create.mock.calls[0][0].title).toBe(
      "[critical] CiliumPolicyDropsHigh · platform",
    );
    // The other half of the BLO-26613 fail-closed guarantee, asserted here and
    // not only in the single-alert tests: the ownerless alert must leave no
    // state row behind, and a multi-alert batch is where that is easiest to
    // regress.
    //
    // Filtered to `alert:` keys rather than counting `state.set` calls
    // outright: the healthy alert's owner lookup also memoises
    // `owner-by-email:…` on the instance scope, so a raw count would be 2 and
    // would couple this fail-closed assertion to an unrelated cache. Keying on
    // the fingerprint says the thing we actually mean — one alert row, and it
    // belongs to the alert that got an issue.
    const alertStateWrites = mocks.state.set.mock.calls.filter((call) =>
      String(call[0].stateKey).startsWith("alert:"),
    );
    expect(alertStateWrites).toHaveLength(1);
    expect(alertStateWrites[0][0].stateKey).toBe(`alert:${owned.fingerprint}`);
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      { alertname: "CephOsdNearFull", severity: "critical" },
    );
  });

  // The permanent drop above is driven by *unset config*, which returns before
  // `agents.list` is ever called. This one is driven by roster contents: the
  // name is configured and correct-looking, and the refusal is decided by what
  // the list came back with. That is the branch every roster-derived permanent
  // refusal actually takes in production — `agents.list` filters terminated
  // agents out, so a terminated fallback owner never reaches the eligibility
  // ladder and lands here as an unmatched name instead.
  it("permanently drops when the configured name is absent from the roster", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    // A non-empty roster that simply does not contain the configured name —
    // indistinguishable from a typo, and correctly permanent.
    mocks.agents.list.mockResolvedValue([
      { id: "agent-other", name: "Someone Else", status: "idle" },
    ]);

    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).resolves.toBeUndefined();

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.owner.fallback_failed",
      1,
      {
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        refusal: "permanent",
      },
    );
  });

  // The guard that separates a degraded host from a wrong name. Same "no
  // match" outcome as the test directly above, opposite refusal class, and the
  // only difference in the input is that the roster is empty rather than merely
  // lacking the name. An `agents.list` that fails by *returning* `[]` instead
  // of throwing would otherwise be dropped at 200 and never retried, while the
  // throwing variant of the identical fault keeps its retry window.
  it("keeps the retry window when the roster comes back empty", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    mocks.agents.list.mockResolvedValue([]);

    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);

    // Fail-closed is intact either way — the class change is about the
    // reporting channel, never about creating an ownerless issue.
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.owner.fallback_failed",
      1,
      {
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        refusal: "transient",
      },
    );
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      expect.anything(),
    );
  });

  it("keeps the retry window when the fallback agent is only paused", async () => {
    // The counterpart to the permanent drop above, and the case that makes the
    // refusal *class* load-bearing rather than cosmetic. A paused fallback owner
    // becomes invokable again with nobody editing config, so Alertmanager's
    // 15-17 retries are the only thing that lets the alert land within minutes
    // of the unpause instead of waiting out a whole `repeat_interval`. Dropping
    // it at 200 here would be a time-to-detect regression for a critical alert.
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    mocks.agents.list.mockResolvedValue([
      { id: "agent-fallback", name: "Alert Fallback", status: "paused" },
    ]);

    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);

    // Fail-closed is still intact — a paused owner is no more assignable than a
    // terminated one; only the reporting channel differs.
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    // Reported as transient, NOT permanent.
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.error",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      expect.anything(),
    );
    // The `refusal` label's other value, pinned here because the permanent test
    // above pins only `"permanent"`. Splitting drop-from-retry within this one
    // series is the label's entire purpose, so a regression that hardcoded
    // `"permanent"` at the write site would otherwise pass the whole suite —
    // the alert-level metric split asserted just above would still be correct.
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.owner.fallback_failed",
      1,
      {
        alertname: "CiliumPolicyDropsHigh",
        severity: "critical",
        refusal: "transient",
      },
    );
    // The operator-facing warning names the blocking reason, so the next
    // occurrence is diagnosable from the log alone (PEN-2581).
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("agent-fallback=paused"),
    );
  });

  it("still acknowledges a permanent drop when the metrics write fails", async () => {
    // The permanent drop's own invariant must not depend on telemetry being up.
    // If the `fallback_failed` write threw, handleFiring would surface a
    // *metrics* error instead of PermanentAlertError, the per-alert catch would
    // treat it as transient and push the fingerprint, and the delivery would
    // 502 — reinstating the doomed retry burst this path exists to remove, and
    // taking the rest of the batch down with it.
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {}, fallbackAgentName: undefined });
    mocks.metrics.write.mockImplementation(async (name: string) => {
      if (name === "alertmanager.owner.fallback_failed") {
        throw new Error("metrics backend unavailable");
      }
    });

    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).resolves.toBeUndefined();

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    // The permanent classification survived the telemetry outage.
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    // And the swallowed metrics failure is still audible in the log.
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to record fallback owner metric"),
    );
  });

  it("still fails the delivery for a transient per-alert fault", async () => {
    // Control for the two tests above: the permanent carve-out must not have
    // widened into "swallow every per-alert failure". A transient fault still
    // owes Alertmanager a retry, so it still fails the delivery and still
    // reports through the transient metric (BLO-20467's silent-loss guard).
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    mocks.issues.create.mockRejectedValueOnce(new Error("issue RPC timed out"));

    await expect(
      handleWebhook(ctx, config, true, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.error",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.alert.permanent_error",
      1,
      expect.anything(),
    );
  });

  it("joins an active aggregate winner before requiring fallback ownership", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {}, fallbackAgentName: undefined });
    mocks.issues.list.mockImplementation(async (input) =>
      input.originFingerprint && input.status === "in_progress"
        ? [{ id: "issue-winner", status: "in_progress", assigneeAgentId: "agent-owner" }]
        : [],
    );

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.agents.list).not.toHaveBeenCalled();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        paperclipIssueId: "issue-winner",
        assigneeAgentId: "agent-owner",
      }),
      FIRING_FENCE_ARG,
    );
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
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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
      FIRING_FENCE_ARG,
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

      await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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

    await handleWebhook(ctx, config, true, baseInput());

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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
    mocks.issues.get.mockResolvedValueOnce({
      id: "issue-existing",
      status: "in_progress",
    });

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.issues.create).not.toHaveBeenCalled();
    // It should bump the description but not change status
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    const updatePatch = mocks.issues.update.mock.calls[0][1];
    expect(updatePatch.status).toBeUndefined();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.deduped",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("preserves same-fingerprint re-fire behavior for a legacy info alert", async () => {
    const { ctx, mocks } = mkCtx();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-42",
      assigneeAgentId: null,
      alertname: "LegacyInformationalAlert",
      severity: "info",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({
      id: "issue-existing",
      status: "in_progress",
    });
    const alert = baseAlert({
      fingerprint: "legacy-info-1",
      labels: { alertname: "LegacyInformationalAlert", severity: "info" },
    });

    await handleWebhook(
      ctx,
      baseConfig(),
      true,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ lastFiredAt: expect.any(String), resolvedAt: null }),
      FIRING_FENCE_ARG,
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.firing",
      "company-1",
      expect.objectContaining({ fingerprint: "legacy-info-1", reFired: true }),
      FIRING_EMIT_OWNERSHIP_ARG,
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.deduped",
      1,
      { alertname: "LegacyInformationalAlert", severity: "info" },
    );
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.webhook.below_issue_floor",
      expect.any(Number),
      expect.any(Object),
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

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ status: "todo" }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.reopened",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("rebinds a resolved same-fingerprint re-fire to the active aggregate winner", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig();
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-old-cancelled",
      paperclipCompanyId: "company-1",
      assigneeUserId: "user-old",
      assigneeAgentId: null,
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: "2026-04-29T09:00:00Z",
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({
      id: "issue-old-cancelled",
      status: "cancelled",
    });
    mocks.issues.list.mockImplementation(async (input) =>
      input.originFingerprint && input.status === "todo"
        ? [
            {
              id: "issue-winner",
              status: "todo",
              assigneeAgentId: "agent-owner",
            },
          ]
        : [],
    );

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalledWith(
      "issue-old-cancelled",
      expect.objectContaining({ status: "todo" }),
      "company-1",
    );
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-winner",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        paperclipIssueId: "issue-winner",
        assigneeAgentId: "agent-owner",
        resolvedAt: null,
      }),
      FIRING_FENCE_ARG,
    );
    expect(mocks.events.emit).toHaveBeenCalledWith(
      "alertmanager.alert.firing",
      "company-1",
      expect.objectContaining({
        paperclipIssueId: "issue-winner",
        reFired: true,
      }),
      FIRING_EMIT_OWNERSHIP_ARG,
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.aggregate.rebound",
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

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.metrics.write).not.toHaveBeenCalledWith(
      "alertmanager.firing.reopened",
      expect.any(Number),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// BLO-24234 — operator suppression is bounded and observable
//
// The pre-existing contract (test above) is that an operator closing an alert
// issue by hand suppresses re-opens. That is deliberate and preserved. What was
// wrong was that the suppression was *permanent* and *silent*: the re-fire
// emitted only `firing.deduped`, indistinguishable from a healthy re-fire
// against an open issue, so a delivered page could produce no visible artifact
// forever. These tests pin the four decision points.
// ---------------------------------------------------------------------------

describe("handleWebhook — operator suppression (BLO-24234)", () => {
  const suppressedState = (
    overrides: Partial<AlertStateRecord> = {},
  ): AlertStateRecord => ({
    paperclipIssueId: "issue-existing",
    paperclipCompanyId: "company-1",
    assigneeUserId: "user-42",
    assigneeAgentId: null,
    alertname: "CiliumPolicyDropsHigh",
    severity: "critical",
    firstSeenAt: "2026-04-29T08:00:00Z",
    lastFiredAt: "2026-04-29T08:00:00Z",
    resolvedAt: null,
    ...overrides,
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  it("stamps the suppression anchor and emits firing.suppressed on first sight", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(suppressedState());
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.suppressed",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    // The anchor must be persisted, or the window can never expire.
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toEqual(expect.any(String));
    expect(Date.parse(written.operatorSuppressedAt as string)).toBeGreaterThan(0);
    // A muted fingerprint is a warning, not routine.
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("suppressing re-open until"),
    );
  });

  it("keeps suppressing — and preserves the original anchor — inside the window", async () => {
    const { ctx, mocks } = mkCtx();
    const anchor = hoursAgo(5);
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: anchor }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.suppressed",
      1,
      expect.any(Object),
    );
    // Re-anchoring on every re-fire would make the window slide forever and
    // recreate the permanent mute this change exists to remove.
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toBe(anchor);
  });

  it("re-opens once the suppression window expires, with an explanatory comment", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: hoursAgo(25) }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      expect.objectContaining({ status: "todo" }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.suppression_expired",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    expect(mocks.issues.createComment).toHaveBeenCalledWith(
      "issue-existing",
      expect.stringContaining("kept firing past"),
      "company-1",
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toBeNull();
  });

  it("re-arms the escalation ladder on a suppression-expiry re-open", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({
        operatorSuppressedAt: hoursAgo(25),
        // Frozen while the issue sat closed; a re-open that left these alone
        // would surface the issue but never page anyone about it again.
        nextEscalationAt: "2026-04-29T09:00:00Z",
        escalationComplete: true,
      }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.nextEscalationAt).not.toBe("2026-04-29T09:00:00Z");
    expect(Date.parse(written.nextEscalationAt as string)).toBeGreaterThan(Date.now());
  });

  it("suppresses indefinitely when operatorSuppressionHours=0", async () => {
    const { ctx, mocks } = mkCtx();
    const config = { ...baseConfig(), operatorSuppressionHours: 0 };
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: hoursAgo(24 * 365) }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, config, true, baseInput());

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.suppressed",
      1,
      expect.any(Object),
    );
  });

  it("clears a stale suppression anchor once the issue is open again", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: hoursAgo(5) }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "in_progress" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    // Body refresh, no status change — the ordinary re-fire path.
    const updatePatch = mocks.issues.update.mock.calls[0][1];
    expect(updatePatch.status).toBeUndefined();
    // A carried-over anchor would let a later close inherit an already-expired
    // window and re-open immediately, defeating the operator's decision.
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toBeNull();
  });

  it("re-anchors rather than muting forever when the anchor is unparseable", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: "not-a-timestamp" }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "cancelled" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(Date.parse(written.operatorSuppressedAt as string)).toBeGreaterThan(0);
  });

  it("reports a re-fire whose tracked issue has vanished", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(suppressedState());
    mocks.issues.get.mockResolvedValueOnce(null);

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.firing.issue_missing",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
    expect(mocks.issues.update).not.toHaveBeenCalled();
  });

  it("does not bank a suppression anchor when the issue RPC failed", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(suppressedState());
    mocks.issues.get.mockRejectedValueOnce(new Error("issues.get exploded"));

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    // Persisting an anchor off a call that never landed would start the
    // suppression clock on a status nobody actually observed.
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toBeNull();
  });

  it("restarts the ladder on resolve→re-fire even when the issue is already open", async () => {
    // Regression guard: an operator can re-open the issue by hand between the
    // resolve and the re-fire, which makes this a plain description refresh
    // rather than a plugin re-open. `handleResolved` has still nulled
    // `nextEscalationAt` and set `escalationComplete`, so gating the ladder
    // restart on the re-open branch would leave this alert permanently
    // un-escalatable.
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({
        resolvedAt: "2026-04-29T09:00:00Z",
        nextEscalationAt: null,
        escalationComplete: true,
        escalationAttempt: 3,
      }),
    );
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.escalationComplete).toBe(false);
    expect(written.escalationAttempt).toBe(0);
    expect(Date.parse(written.nextEscalationAt as string)).toBeGreaterThan(Date.now());
  });

  it("preserves the suppression anchor when the issue could not be read", async () => {
    const { ctx, mocks } = mkCtx();
    const anchor = hoursAgo(5);
    mocks.state.get.mockResolvedValueOnce(
      suppressedState({ operatorSuppressedAt: anchor }),
    );
    mocks.issues.get.mockResolvedValueOnce(null);

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    // Dropping it would restart the window on the next readable re-fire,
    // extending the mute past what the operator's close bought.
    const written = mocks.state.set.mock.calls.at(-1)?.[1] as AlertStateRecord;
    expect(written.operatorSuppressedAt).toBe(anchor);
  });
});

describe("aggregate firing fence recovery", () => {
  const aggregateKey = 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]';
  const interruptedToken = "firing-token-interrupted";
  const newerToken = "firing-token-newer";

  const userActionContext = {
    actor: {
      type: "user" as const,
      userId: "operator-1",
      agentId: null,
      runId: null,
      companyId: "company-1",
    },
    companyId: "company-1",
  } satisfies PluginPerformActionContext;

  it("only recovers the exact firing fence token and leaves a newer fence untouched", async () => {
    const { ctx, mocks } = mkCtx();
    let phase: "active" | "firing" = "firing";
    let currentToken: string | null = interruptedToken;
    mocks.db.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!/UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)) {
        return { rowCount: 0 };
      }
      const [companyId, requestedAggregateKey, requestedToken] = params ?? [];
      if (
        phase === "firing" &&
        companyId === "company-1" &&
        requestedAggregateKey === aggregateKey &&
        requestedToken === currentToken
      ) {
        phase = "active";
        currentToken = null;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });

    await expect(
      recoverAggregateFiring(
        ctx,
        "company-1",
        aggregateKey,
        "wrong-token",
      ),
    ).resolves.toBe(false);
    expect(phase).toBe("firing");
    expect(currentToken).toBe(interruptedToken);

    await expect(
      recoverAggregateFiring(
        ctx,
        "company-1",
        aggregateKey,
        interruptedToken,
      ),
    ).resolves.toBe(true);
    expect(phase).toBe("active");
    expect(currentToken).toBeNull();

    // A delayed operator action carrying the old token cannot release a
    // subsequent firing fence. This is the CAS that prevents stale recovery
    // from reopening a fence owned by a newer delivery.
    phase = "firing";
    currentToken = newerToken;
    await expect(
      recoverAggregateFiring(
        ctx,
        "company-1",
        aggregateKey,
        interruptedToken,
      ),
    ).resolves.toBe(false);
    expect(phase).toBe("firing");
    expect(currentToken).toBe(newerToken);

    await expect(
      recoverAggregateFiring(ctx, "company-1", aggregateKey, newerToken),
    ).resolves.toBe(true);
    expect(phase).toBe("active");
    expect(currentToken).toBeNull();
    expect(mocks.db.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("AND firing_token = $3"),
      ["company-1", aggregateKey, newerToken],
    );
  });

  it("recovers an interrupted delivery and permits the next firing", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    let phase: "active" | "firing" = "active";
    let currentToken: string | null = null;
    let failFirstFinish = true;
    let state: AlertStateRecord | null = null;

    mocks.state.get.mockImplementation(async (ref) =>
      ref.stateKey === "alert:9a3b1e4c5f6d7890" ? state : null,
    );
    mocks.state.set.mockImplementation(async (_ref, value) => {
      state = value as AlertStateRecord;
    });
    mocks.db.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql) &&
        /phase, firing_token/i.test(sql)
      ) {
        const token = params?.[2];
        if (phase !== "active" || typeof token !== "string") return { rowCount: 0 };
        phase = "firing";
        currentToken = token;
        return { rowCount: 1 };
      }

      if (
        /UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql) &&
        /firing_token = NULL/i.test(sql)
      ) {
        const token = params?.[2];
        if (failFirstFinish) {
          // Simulate the process/DB interruption between the durable begin
          // transition and its completion CAS. The row remains firing.
          failFirstFinish = false;
          return { rowCount: 0 };
        }
        if (phase === "firing" && token === currentToken) {
          phase = "active";
          currentToken = null;
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      }

      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /DELETE FROM alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /INSERT INTO alertmanager\.alertmanager_aggregate_members/i.test(sql)
      ) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });

    await expect(handleFiring(ctx, config, baseAlert())).rejects.toThrow(
      "firing fence was lost",
    );
    expect(phase).toBe("firing");
    expect(currentToken).toBeTypeOf("string");
    expect(state).toEqual(expect.objectContaining({ paperclipIssueId: "issue-1" }));

    registerRecoveryAction(ctx);
    expect(mocks.actions.register).toHaveBeenCalledWith(
      RECOVER_AGGREGATE_FIRING_ACTION,
      expect.any(Function),
    );
    const recover = mocks.actions.register.mock.calls[0]?.[1] as (
      params: Record<string, unknown>,
      context: PluginPerformActionContext,
    ) => Promise<{ recovered: boolean }>;

    if (currentToken === null) throw new Error("interrupted firing token was not retained");
    const token = currentToken;
    await expect(
      recover(
        { companyId: "company-1", aggregateKey, firingToken: token },
        userActionContext,
      ),
    ).resolves.toEqual({ recovered: true });
    expect(phase).toBe("active");
    expect(currentToken).toBeNull();

    await expect(
      handleFiring(ctx, config, baseAlert()),
    ).resolves.toBeUndefined();
    expect(phase).toBe("active");
    expect(currentToken).toBeNull();
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.state.set).toHaveBeenCalledTimes(2);
  });

  it("restricts recovery to authenticated users in the host company and redacts the token", async () => {
    const { ctx, mocks } = mkCtx();
    const token = "firing-token-never-in-output";
    let recovered = false;
    mocks.db.execute.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (params?.[2] === token && !recovered) {
        recovered = true;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
    registerRecoveryAction(ctx);
    const recover = mocks.actions.register.mock.calls[0]?.[1] as (
      params: Record<string, unknown>,
      context: PluginPerformActionContext,
    ) => Promise<{ recovered: boolean }>;
    const params = {
      companyId: "company-1",
      aggregateKey,
      firingToken: token,
    };

    await expect(
      recover(params, {
        actor: {
          type: "agent",
          userId: null,
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-1",
        },
        companyId: "company-1",
      }),
    ).rejects.toThrow("Alertmanager aggregate firing recovery failed");
    await expect(
      recover(params, {
        actor: {
          type: "system",
          userId: null,
          agentId: null,
          runId: null,
          companyId: "company-1",
        },
        companyId: "company-1",
      }),
    ).rejects.toThrow("Alertmanager aggregate firing recovery failed");
    await expect(
      recover(params, {
        actor: {
          type: "user",
          userId: "operator-1",
          agentId: null,
          runId: null,
          companyId: "company-2",
        },
        companyId: "company-2",
      }),
    ).rejects.toThrow("Alertmanager aggregate firing recovery failed");

    const result = await recover(params, userActionContext);
    expect(result).toEqual({ recovered: true });
    expect(JSON.stringify(mocks.activity.log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    await expect(
      recover(params, userActionContext),
    ).resolves.toEqual({ recovered: false });
    expect(JSON.stringify(mocks.activity.log.mock.calls)).not.toContain(token);

    await expect(
      recover(
        { ...params, firingToken: "different-token" },
        userActionContext,
      ),
    ).resolves.toEqual({ recovered: false });
    expect(JSON.stringify(mocks.activity.log.mock.calls)).not.toContain(token);
  });

  it("returns a held fence with its phase through the board operator API and marks the token response non-cacheable", async () => {
    const { ctx, mocks } = mkCtx();
    const token = "firing-token-for-operator";
    mocks.db.query.mockResolvedValueOnce([
      {
        aggregate_key: aggregateKey,
        phase: "firing",
        firing_token: token,
        updated_at: "2026-08-11T19:10:00.000Z",
      },
    ]);

    const result = await handleRecoveryApiRequest(ctx, {
      routeKey: LIST_AGGREGATE_FIRING_FENCES_ROUTE,
      method: "GET",
      path: "/aggregate-firing-fences",
      params: {},
      query: { companyId: "company-1" },
      body: null,
      actor: {
        actorType: "user",
        actorId: "operator-1",
        userId: "operator-1",
        agentId: null,
        runId: null,
      },
      companyId: "company-1",
      headers: {},
    } satisfies PluginApiRequestInput);

    expect(result).toEqual({
      headers: { "cache-control": "no-store" },
      body: {
        fences: [{
          aggregateKey,
          phase: "firing",
          firingToken: token,
          updatedAt: "2026-08-11T19:10:00.000Z",
        }],
      },
    });
    expect(mocks.db.query).toHaveBeenCalledWith(
      expect.stringContaining("phase = 'firing'"),
      ["company-1"],
    );
  });

  it("recovers an exact token through the board operator API without returning or auditing it", async () => {
    const { ctx, mocks } = mkCtx();
    const token = "firing-token-api-secret";
    mocks.db.execute.mockResolvedValueOnce({ rowCount: 1 });

    const result = await handleRecoveryApiRequest(ctx, {
      routeKey: RECOVER_AGGREGATE_FIRING_ROUTE,
      method: "POST",
      path: "/aggregate-firing-fences/recover",
      params: {},
      query: {},
      body: {
        companyId: "company-1",
        aggregateKey,
        firingToken: token,
      },
      actor: {
        actorType: "user",
        actorId: "operator-1",
        userId: "operator-1",
        agentId: null,
        runId: null,
      },
      companyId: "company-1",
      headers: {},
    } satisfies PluginApiRequestInput);

    expect(result).toEqual({
      headers: { "cache-control": "no-store" },
      body: { recovered: true },
    });
    expect(mocks.db.execute).toHaveBeenCalledWith(
      expect.stringContaining("AND firing_token = $3"),
      ["company-1", aggregateKey, token],
    );
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(mocks.activity.log.mock.calls)).not.toContain(token);
  });

  it("redacts a token if untrusted aggregate-key input happens to contain it", async () => {
    const { ctx, mocks } = mkCtx();
    const token = "firing-token-in-aggregate-key";
    mocks.db.execute.mockResolvedValueOnce({ rowCount: 1 });
    const maliciousAggregateKey = `synthetic:${token}`;

    await expect(handleRecoveryApiRequest(ctx, {
      routeKey: RECOVER_AGGREGATE_FIRING_ROUTE,
      method: "POST",
      path: "/aggregate-firing-fences/recover",
      params: {},
      query: {},
      body: {
        companyId: "company-1",
        aggregateKey: maliciousAggregateKey,
        firingToken: token,
      },
      actor: {
        actorType: "user",
        actorId: "operator-1",
        userId: "operator-1",
        agentId: null,
        runId: null,
      },
      companyId: "company-1",
      headers: {},
    } satisfies PluginApiRequestInput)).resolves.toEqual({
      headers: { "cache-control": "no-store" },
      body: { recovered: true },
    });
    expect(JSON.stringify(mocks.activity.log.mock.calls)).not.toContain(token);
    expect(JSON.stringify(mocks.activity.log.mock.calls)).toContain("[redacted]");
  });

  it("does not expose the fence API to non-user actors or cross-company request bodies", async () => {
    const { ctx, mocks } = mkCtx();
    const input = {
      routeKey: RECOVER_AGGREGATE_FIRING_ROUTE,
      method: "POST",
      path: "/aggregate-firing-fences/recover",
      params: {},
      query: {},
      body: {
        companyId: "company-2",
        aggregateKey,
        firingToken: interruptedToken,
      },
      actor: {
        actorType: "agent",
        actorId: "agent-1",
        userId: null,
        agentId: "agent-1",
        runId: "run-1",
      },
      companyId: "company-1",
      headers: {},
    } satisfies PluginApiRequestInput;

    await expect(handleRecoveryApiRequest(ctx, input)).resolves.toEqual({
      status: 403,
      body: { error: "Alertmanager aggregate firing recovery failed" },
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();

    await expect(handleRecoveryApiRequest(ctx, {
      ...input,
      actor: {
        ...input.actor,
        actorType: "user",
        actorId: "operator-1",
        userId: "operator-1",
        agentId: null,
        runId: null,
      },
    })).resolves.toEqual({
      status: 400,
      body: { error: "Alertmanager aggregate firing recovery failed" },
    });
    expect(mocks.db.execute).not.toHaveBeenCalled();
  });
});

describe("PEN-2581 — a wedged aggregate fence names the phase that actually blocked it", () => {
  const aggregateKey = 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]';

  /**
   * Refuse the firing-fence upsert and report `heldPhase` on read-back, which is
   * exactly what production looked like: the conditional upsert matched no row,
   * so the delivery threw and Alertmanager retried the whole batch forever.
   */
  const wedgeFenceAt = (mocks: MockClients, heldPhase: string) => {
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (/INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)) {
        return { rowCount: 0 };
      }
      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /INSERT INTO alertmanager\.alertmanager_aggregate_members/i.test(sql) ||
        /DELETE FROM alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)
      ) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
    mocks.db.query.mockImplementation(async (sql: string) =>
      /SELECT phase/i.test(sql) ? [{ phase: heldPhase }] : [],
    );
  };

  // The regression that cost six days of fleet-wide alert loss. The upsert
  // admits 'active' and 'finalizing', so 'finalizing' is the one phase that
  // CANNOT refuse a firing claim — yet the old message named it unconditionally.
  // Operators diagnosed against a condition that was never occurring.
  it.each(["firing", "cancelling"])(
    "reports the real holding phase %s, and never claims 'finalizing'",
    async (heldPhase) => {
      const { ctx, mocks } = mkCtx();
      wedgeFenceAt(mocks, heldPhase);

      await expect(
        handleWebhook(ctx, baseConfig(), true, baseInput()),
      ).rejects.toThrow(AlertDeliveryIncompleteError);

      const logged = mocks.logger.error.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(logged).toContain(`is held in phase '${heldPhase}'`);
      expect(logged).toContain(aggregateKey);
      // The precise false statement that misdirected the investigation.
      expect(logged).not.toContain("is finalizing");
      // A fence abandoned by a dead process now self-clears via its slot's next
      // worker (BLO-31036), so a *persistent* refusal means the holder is live
      // or in another slot. The error must still name the operator escape hatch
      // for that case.
      expect(logged).toContain("recover-aggregate-firing");
    },
  );

  it("reports 'unknown' rather than a phase it did not read when the fence row is gone", async () => {
    const { ctx, mocks } = mkCtx();
    wedgeFenceAt(mocks, "firing");
    mocks.db.query.mockImplementation(async () => []);

    await expect(
      handleWebhook(ctx, baseConfig(), true, baseInput()),
    ).rejects.toThrow(AlertDeliveryIncompleteError);

    const logged = mocks.logger.error.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("is held in phase 'unknown'");
  });
});

describe("PEN-2581 — an interrupted cancellation is listable and recoverable", () => {
  const aggregateKey = 'alert-aggregate:v1:["CdnEdgePublicPrDown",null]';
  const resolutionToken = "resolution-token-interrupted";

  // A resolver that dies between beginAggregateCancellation and
  // releaseAggregateFinalization leaves phase='cancelling' held by a token no
  // live process has. That refuses every later firing claim, so without these
  // two paths the aggregate is wedged permanently: previously it was neither
  // listed (the query filtered phase='firing') nor releasable.
  it("lists a stuck cancelling fence so the operator can find its token", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.db.query.mockResolvedValueOnce([
      {
        aggregate_key: aggregateKey,
        phase: "cancelling",
        firing_token: resolutionToken,
        updated_at: "2026-08-25T21:20:24.000Z",
      },
    ]);

    await expect(listAggregateFiringFences(ctx, "company-1")).resolves.toEqual([
      {
        aggregateKey,
        phase: "cancelling",
        firingToken: resolutionToken,
        updatedAt: "2026-08-25T21:20:24.000Z",
      },
    ]);

    const [sql] = mocks.db.query.mock.calls[0];
    expect(sql).toContain("phase = 'cancelling'");
    expect(sql).toContain("resolution_token IS NOT NULL");
  });

  it("releases a cancelling fence on its resolution token, and only that token", async () => {
    const { ctx, mocks } = mkCtx();
    let phase: "cancelling" | "active" = "cancelling";
    mocks.db.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      const [companyId, requestedKey, requestedToken] = params ?? [];
      const matches =
        companyId === "company-1" &&
        requestedKey === aggregateKey &&
        requestedToken === resolutionToken;
      if (/AND phase = 'cancelling'/i.test(sql) && phase === "cancelling" && matches) {
        phase = "active";
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });

    // Wrong token releases nothing — the same CAS discipline as the firing path.
    await expect(
      recoverAggregateFiring(ctx, "company-1", aggregateKey, "wrong-token"),
    ).resolves.toBe(false);
    expect(phase).toBe("cancelling");

    await expect(
      recoverAggregateFiring(ctx, "company-1", aggregateKey, resolutionToken),
    ).resolves.toBe(true);
    expect(phase).toBe("active");
    expect(mocks.db.execute).toHaveBeenLastCalledWith(
      expect.stringContaining("AND resolution_token = $3"),
      ["company-1", aggregateKey, resolutionToken],
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      {
        status: "cancelled",
        expectedCurrentCheckoutRunId: null,
        expectedCurrentExecutionRunId: null,
      },
      "company-1",
    );
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
  });

  it("does not cancel a shared aggregate issue while sibling members remain firing", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-winner",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: "agent-owner",
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (/SELECT issue_id\s+FROM alertmanager\.alertmanager_aggregate_members/i.test(sql)) {
        return [{ issue_id: "issue-winner" }];
      }
      if (/SELECT 1 AS one/i.test(sql)) return [{ one: 1 }];
      return [];
    });
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-winner", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalledWith(
      "issue-winner",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        paperclipIssueId: "issue-winner",
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("cancels a shared aggregate issue when the last member resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-winner",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: "agent-owner",
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (/SELECT issue_id\s+FROM alertmanager\.alertmanager_aggregate_members/i.test(sql)) {
        return [{ issue_id: "issue-winner" }];
      }
      if (/SELECT 1 AS one/i.test(sql)) return [];
      return [];
    });
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-winner", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-winner",
      {
        status: "cancelled",
        expectedCurrentCheckoutRunId: null,
        expectedCurrentExecutionRunId: null,
      },
      "company-1",
    );
  });

  it("uses the firing-time aggregate key and fails closed when that membership is missing", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const firingAggregateKey =
      'alert-aggregate:v1:["CiliumPolicyDropsHigh","domain-when-firing"]';
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-winner",
      paperclipCompanyId: "company-1",
      aggregateKey: firingAggregateKey,
      assigneeUserId: null,
      assigneeAgentId: "agent-owner",
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.db.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/SELECT issue_id\s+FROM alertmanager\.alertmanager_aggregate_members/i.test(sql)) {
        expect(params).toEqual([
          "company-1",
          firingAggregateKey,
          "9a3b1e4c5f6d7890",
        ]);
      }
      return [];
    });

    const resolvedAlert = baseAlert({
      status: "resolved",
      annotations: { paperclip_dedupe_domain: "domain-when-resolved" },
      endsAt: "2026-04-29T10:00:00Z",
    });
    await handleWebhook(
      ctx,
      config,
      true,
      baseInput({ parsedBody: baseEnvelope({ status: "resolved", alerts: [resolvedAlert] }) }),
    );

    expect(mocks.issues.get).not.toHaveBeenCalled();
    expect(mocks.issues.update).not.toHaveBeenCalledWith(
      "issue-winner",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        aggregateKey: firingAggregateKey,
        resolvedAt: "2026-04-29T10:00:00Z",
      }),
    );
  });

  it("retries final resolution when a concurrent firing takes the aggregate fence", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const aggregateKey = 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]';
    const resolvedFingerprint = "9a3b1e4c5f6d7890";
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-winner",
      paperclipCompanyId: "company-1",
      aggregateKey,
      assigneeUserId: null,
      assigneeAgentId: "agent-owner",
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockImplementation(async (ref) =>
      ref.stateKey === `alert:${resolvedFingerprint}` ? existing : null,
    );
    mocks.issues.list.mockImplementation(async (input) => {
      if (input.originFingerprint && input.status === "todo") {
        return [{ id: "issue-winner", status: "todo", assigneeAgentId: "agent-owner" }];
      }
      return [];
    });

    let phase: "active" | "firing" | "finalizing" | "cancelling" = "active";
    let hasConcurrentMember = false;
    let releaseCancellation!: () => void;
    let cancellationReached!: () => void;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const reachedCancellation = new Promise<void>((resolve) => {
      cancellationReached = resolve;
    });
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (/INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)) {
        if (/phase, firing_token/i.test(sql)) {
          if (phase === "active" || phase === "finalizing") {
            phase = "firing";
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        return { rowCount: 1 };
      }
      if (/UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)) {
        if (/SET phase = 'finalizing'/i.test(sql)) {
          if (phase === "active" && !hasConcurrentMember) {
            phase = "finalizing";
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        if (/SET phase = 'cancelling'/i.test(sql)) {
          cancellationReached();
          await cancellationGate;
          if (phase === "finalizing") {
            phase = "cancelling";
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        if (/firing_token = NULL/i.test(sql)) {
          if (phase === "firing") {
            phase = "active";
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        return { rowCount: 1 };
      }
      if (/INSERT INTO alertmanager\.alertmanager_aggregate_members/i.test(sql)) {
        hasConcurrentMember = true;
        return { rowCount: 1 };
      }
      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /DELETE FROM alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql)
      ) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (FENCE_GENERATION_SELECT.test(sql)) return HELD_FENCE;
      if (/SELECT issue_id\s+FROM alertmanager\.alertmanager_aggregate_members/i.test(sql)) {
        return [{ issue_id: "issue-winner" }];
      }
      if (/SELECT 1 AS one/i.test(sql)) return hasConcurrentMember ? [{ one: 1 }] : [];
      return [];
    });

    const resolving = handleWebhook(
      ctx,
      config,
      true,
      baseInput({
        parsedBody: baseEnvelope({
          status: "resolved",
          alerts: [baseAlert({ status: "resolved", endsAt: "2026-04-29T10:00:00Z" })],
        }),
      }),
    );
    await reachedCancellation;

    await handleWebhook(
      ctx,
      config,
      true,
      baseInput({
        parsedBody: baseEnvelope({
          alerts: [baseAlert({ fingerprint: "concurrent-firing" })],
        }),
      }),
    );
    releaseCancellation();

    await expect(resolving).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
    expect(mocks.issues.update).not.toHaveBeenCalledWith(
      "issue-winner",
      { status: "cancelled" },
      "company-1",
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "alert:concurrent-firing" }),
      expect.objectContaining({ paperclipIssueId: "issue-winner", resolvedAt: null }),
      FIRING_FENCE_ARG,
    );
  });

  it("retries a firing delivery while final-member cancellation owns the aggregate fence", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.state.get.mockResolvedValueOnce({
      paperclipIssueId: "issue-winner",
      paperclipCompanyId: "company-1",
      aggregateKey: 'alert-aggregate:v1:["CiliumPolicyDropsHigh",null]',
      assigneeUserId: null,
      assigneeAgentId: "agent-owner",
      alertname: "CiliumPolicyDropsHigh",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    } satisfies AlertStateRecord);
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql) &&
        /phase, firing_token/i.test(sql)
      ) {
        // Refuse the claim: the fence is held by a canceller that could still
        // act — either a live delivery in this same process, or a holder in
        // another slot. Neither is stealable, because a delayed canceller could
        // otherwise close the issue after this firing attached a live member.
        //
        // Refused unconditionally rather than by sniffing the SQL for
        // `'cancelling'`: since BLO-31036 the claim statement names that phase
        // in its own steal predicate, so the literal is no longer a proxy for
        // the stored phase. Which owners are and are not stealable is asserted
        // against a modelled fence table in
        // `aggregate-fence-restart-safety.test.ts`.
        return { rowCount: 0 };
      }
      return { rowCount: 1 };
    });

    await expect(
      handleWebhook(
        ctx,
        baseConfig(),
        true,
        baseInput({ parsedBody: baseEnvelope({ alerts: [baseAlert()] }) }),
      ),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);

    expect(mocks.issues.list).not.toHaveBeenCalled();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
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
      handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope })),
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
      handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope })),
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
      handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope })),
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      {
        status: "cancelled",
        expectedCurrentCheckoutRunId: null,
        expectedCurrentExecutionRunId: null,
      },
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.list).toHaveBeenCalledWith({
      companyId: "company-1",
      originKind: ORIGIN_KIND,
      originId: resolvedAlert.fingerprint,
      limit: 1,
    });
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      {
        status: "cancelled",
        expectedCurrentCheckoutRunId: null,
        expectedCurrentExecutionRunId: null,
      },
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
  });

  it("recovers the active aggregate member when the first per-fingerprint issue is an older cancelled row", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: false });
    const aggregateKey = 'alert-aggregate:v1:["CiliumPolicyDropsHigh","tenant-a"]';
    const resolvedMember = {
      issue_id: "issue-aggregate-winner",
      aggregate_key: aggregateKey,
    };

    // State is missing after a prior state-store failure. The origin lookup
    // returns the historical per-fingerprint issue first, but it is no longer
    // the live issue for this firing.
    mocks.state.get.mockResolvedValueOnce(null);
    mocks.issues.list.mockResolvedValueOnce([
      {
        id: "issue-old-cancelled",
        status: "cancelled",
        assigneeUserId: null,
        assigneeAgentId: "agent-old",
      },
    ]);
    mocks.db.query.mockImplementation(async (sql: string) => {
      if (FENCE_GENERATION_SELECT.test(sql)) return HELD_FENCE;
      if (/SELECT issue_id, aggregate_key/i.test(sql)) return [resolvedMember];
      return [];
    });
    mocks.issues.get.mockResolvedValue({
      id: "issue-aggregate-winner",
      status: "todo",
      assigneeUserId: null,
      assigneeAgentId: "agent-winner",
    });

    await handleWebhook(
      ctx,
      config,
      true,
      baseInput({
        parsedBody: baseEnvelope({
          alerts: [
            baseAlert({
              annotations: {
                ...baseAlert().annotations,
                paperclip_dedupe_domain: "tenant-a",
              },
            }),
          ],
        }),
      }),
    );

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-aggregate-winner",
      expect.objectContaining({ description: expect.any(String) }),
      "company-1",
      undefined,
      expect.objectContaining({
        fencing: {
          table: "alertmanager_aggregate_lifecycle_fences",
          match: expect.objectContaining({
            company_id: "company-1",
            phase: "firing",
            firing_token: expect.any(String),
          }),
        },
      }),
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "alert:9a3b1e4c5f6d7890",
      }),
      expect.objectContaining({
        paperclipIssueId: "issue-aggregate-winner",
        aggregateKey,
        assigneeAgentId: "agent-winner",
        resolvedAt: null,
      }),
      FIRING_FENCE_ARG,
    );
    expect(mocks.db.query).toHaveBeenCalledWith(
      expect.stringContaining("resolved_at IS NULL"),
      ["company-1", "9a3b1e4c5f6d7890"],
    );
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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.issues.update).not.toHaveBeenCalled();
    expect(mocks.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalled();
  });

  it("allows paperclip_issue=false resolved deliveries to clear tracked alerts", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ autoCloseOnResolve: true });
    const existing: AlertStateRecord = {
      paperclipIssueId: "issue-existing",
      paperclipCompanyId: "company-1",
      assigneeUserId: null,
      assigneeAgentId: null,
      alertname: "OptedOutAlert",
      severity: "critical",
      firstSeenAt: "2026-04-29T08:00:00Z",
      lastFiredAt: "2026-04-29T08:00:00Z",
      resolvedAt: null,
    };
    mocks.state.get.mockResolvedValueOnce(existing);
    mocks.issues.get.mockResolvedValueOnce({ id: "issue-existing", status: "todo" });

    const resolvedAlert = baseAlert({
      status: "resolved",
      labels: {
        alertname: "OptedOutAlert",
        severity: "critical",
        paperclip_issue: "false",
      },
      endsAt: "2026-04-29T10:00:00Z",
    });
    const envelope = baseEnvelope({
      status: "resolved",
      alerts: [resolvedAlert],
    });

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

    expect(mocks.state.get).toHaveBeenCalled();
    expect(mocks.issues.update).toHaveBeenCalledWith(
      "issue-existing",
      {
        status: "cancelled",
        expectedCurrentCheckoutRunId: null,
        expectedCurrentExecutionRunId: null,
      },
      "company-1",
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ resolvedAt: "2026-04-29T10:00:00Z" }),
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.resolved.handled",
      1,
      { alertname: "OptedOutAlert", severity: "critical" },
    );
  });
});

describe("handleWebhook — acceptOnlyLabels filter", () => {
  it("skips alerts that don't match the filter", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ acceptOnlyLabels: { paperclip: "true" } });

    await handleWebhook(ctx, config, true, baseInput());

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));

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

    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.priority).toBe("high");
  });

  it("operator severity-to-priority overrides the default", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({
      severityToPriority: { critical: "low" },
    });
    await handleWebhook(ctx, config, true, baseInput());
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
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
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
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
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
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
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
    await handleWebhook(ctx, config, true, baseInput());
    expect(mocks.users.findByEmail).toHaveBeenCalledWith("alice@example.com");
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-alice");
  });

  it("annotation override is the last resort before the named fallback", async () => {
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
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBe("user-carol");
  });

  it("uses the named fallback agent when nothing resolves", async () => {
    const { ctx, mocks } = mkCtx();
    const config = baseConfig({ ownerMap: {} });
    const alert = baseAlert({
      labels: { alertname: "X", severity: "warning" },
      annotations: {},
    });
    const envelope = baseEnvelope({ alerts: [alert] });
    await handleWebhook(ctx, config, true, baseInput({ parsedBody: envelope }));
    expect(mocks.users.findByEmail).not.toHaveBeenCalled();
    const createArgs = mocks.issues.create.mock.calls[0][0];
    expect(createArgs.assigneeUserId).toBeUndefined();
    expect(createArgs.assigneeAgentId).toBe("agent-fallback");
  });
});

describe("handleWebhook — creation policy", () => {
  it("drops firing info alerts before owner, issue, state, event, or activity side effects", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = baseAlert({
      labels: { alertname: "InformationalAlert", severity: "info" },
      annotations: {},
    });
    await handleWebhook(
      ctx,
      baseConfig(),
      true,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );

    expect(mocks.agents.list).not.toHaveBeenCalled();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.activity.log).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.below_issue_floor",
      1,
      { alertname: "InformationalAlert", severity: "info" },
    );
  });

  it("acknowledges a firing info alert when floor telemetry fails", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.metrics.write.mockRejectedValueOnce(new Error("metrics unavailable"));
    const alert = baseAlert({
      labels: { alertname: "InformationalAlert", severity: "info" },
      annotations: {},
    });

    await expect(
      handleWebhook(
        ctx,
        baseConfig(),
        true,
        baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
      ),
    ).resolves.toBeUndefined();

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to record issue floor metric"),
    );
  });

  it.each(["label", "annotation"])(
    "honors paperclip_issue=false from the %s before every state side effect",
    async (source) => {
      const { ctx, mocks } = mkCtx();
      const alert = baseAlert({
        labels: {
          alertname: "OptedOutAlert",
          severity: "critical",
          ...(source === "label" ? { paperclip_issue: " FALSE " } : {}),
        },
        annotations: source === "annotation" ? { paperclip_issue: " false " } : {},
      });
      await handleWebhook(
        ctx,
        baseConfig(),
        true,
        baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
      );

      expect(mocks.agents.list).not.toHaveBeenCalled();
      expect(mocks.issues.create).not.toHaveBeenCalled();
      expect(mocks.state.set).not.toHaveBeenCalled();
      expect(mocks.events.emit).not.toHaveBeenCalled();
      expect(mocks.activity.log).not.toHaveBeenCalled();
      expect(mocks.metrics.write).toHaveBeenCalledWith(
        "alertmanager.webhook.issue_opt_out",
        1,
        { alertname: "OptedOutAlert" },
      );
    },
  );

  it("acknowledges an opted-out alert when opt-out telemetry fails", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.metrics.write.mockRejectedValueOnce(new Error("metrics unavailable"));
    const alert = baseAlert({
      labels: {
        alertname: "OptedOutAlert",
        severity: "critical",
        paperclip_issue: "false",
      },
    });

    await expect(
      handleWebhook(
        ctx,
        baseConfig(),
        true,
        baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
      ),
    ).resolves.toBeUndefined();

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to record issue opt-out metric"),
    );
  });

  it("honors annotation opt-out when the label explicitly enables issue creation", async () => {
    const { ctx, mocks } = mkCtx();
    const alert = baseAlert({
      labels: {
        alertname: "ConflictingOptOutAlert",
        severity: "critical",
        paperclip_issue: "true",
      },
      annotations: { paperclip_issue: " false " },
    });

    await handleWebhook(
      ctx,
      baseConfig(),
      true,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );

    expect(mocks.agents.list).not.toHaveBeenCalled();
    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.get).not.toHaveBeenCalled();
    expect(mocks.state.set).not.toHaveBeenCalled();
    expect(mocks.events.emit).not.toHaveBeenCalled();
    expect(mocks.activity.log).not.toHaveBeenCalled();
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.webhook.issue_opt_out",
      1,
      { alertname: "ConflictingOptOutAlert" },
    );
  });

  it("permanently rejects a malformed opt-out value and handles valid siblings", async () => {
    const { ctx, mocks } = mkCtx();
    const malformed = baseAlert({
      fingerprint: "malformed-policy",
      labels: {
        alertname: "MalformedPolicyAlert",
        severity: "critical",
        paperclip_issue: false as unknown as string,
      },
    });
    const valid = baseAlert({ fingerprint: "valid-sibling" });

    await handleWebhook(
      ctx,
      baseConfig(),
      true,
      baseInput({ parsedBody: baseEnvelope({ alerts: [malformed, valid] }) }),
    );

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    expect(mocks.issues.create.mock.calls[0][0].originId).toBe("valid-sibling");
    expect(mocks.state.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "alert:malformed-policy" }),
      expect.anything(),
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.alert.malformed",
      1,
      { alertname: "MalformedPolicyAlert" },
    );
  });

  it("joins the aggregate winner when this delivery loses the creation claim", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.users.findByEmail.mockResolvedValue({
      id: "user-owner",
      email: "alice@example.com",
      name: "Alice",
    });
    let claimAttempted = false;
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (/INSERT INTO alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql)) {
        claimAttempted = true;
        return { rowCount: 0 };
      }
      if (
        /INSERT INTO alertmanager\.alertmanager_aggregate_members/i.test(sql) ||
        /DELETE FROM alertmanager\.alertmanager_aggregate_creation_claims/i.test(sql) ||
        /INSERT INTO alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql) ||
        /UPDATE alertmanager\.alertmanager_aggregate_lifecycle_fences/i.test(sql)
      ) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
    mocks.issues.list.mockImplementation(async (input) => {
      if (!input.originFingerprint) return [];
      if (claimAttempted && input.status === "todo") {
        return [
          {
            id: "issue-winner",
            status: "todo",
            assigneeAgentId: "agent-fallback",
          },
        ];
      }
      return [];
    });
    const alert = baseAlert({ fingerprint: "series-loser" });

    await handleWebhook(
      ctx,
      baseConfig(),
      true,
      baseInput({ parsedBody: baseEnvelope({ alerts: [alert] }) }),
    );

    expect(mocks.issues.create).not.toHaveBeenCalled();
    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "alert:series-loser" }),
      expect.objectContaining({ paperclipIssueId: "issue-winner" }),
      FIRING_FENCE_ARG,
    );
    expect(mocks.metrics.write).toHaveBeenCalledWith(
      "alertmanager.aggregate.joined",
      1,
      { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
    );
  });

  it("finds an active conflict winner behind more than 20 terminal issues", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.issues.create.mockRejectedValueOnce(
      new Error("Alertmanager aggregate creation conflict"),
    );
    const terminalIssues = Array.from({ length: 25 }, (_, index) => ({
      id: `terminal-${index}`,
      status: index % 2 === 0 ? "done" : "cancelled",
    }));
    mocks.issues.list.mockImplementation(async (input) => {
      if (!input.originFingerprint) return [];
      if (input.status === "done" || input.status === "cancelled") return terminalIssues;
      if (input.status === "blocked") {
        return [{ id: "issue-winner", status: "blocked", assigneeAgentId: "agent-owner" }];
      }
      return [];
    });

    await handleWebhook(ctx, baseConfig(), true, baseInput());

    expect(mocks.state.set).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ paperclipIssueId: "issue-winner" }),
      FIRING_FENCE_ARG,
    );
    expect(mocks.issues.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: "blocked", limit: 1 }),
    );
    expect(mocks.issues.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "done" }),
    );
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
      true,
      baseInput({ companyId: "company-A", parsedBody: envelope }),
    );

    mocks.issues.create.mockImplementationOnce(async () => ({ id: "issue-B" }));
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-B" }),
      true,
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
      FIRING_FENCE_ARG,
    );
    expect(mocks.state.set).toHaveBeenCalledWith(
      { scopeKind: "company", scopeId: "company-B", stateKey: `alert:${alert.fingerprint}` },
      expect.objectContaining({ paperclipIssueId: "issue-B", paperclipCompanyId: "company-B" }),
      FIRING_FENCE_ARG,
    );
  });

  it("one tenant's resolution cannot close another tenant's issue on a shared fingerprint", async () => {
    const { ctx, mocks } = mkStatefulCtx();
    const alert = baseAlert();

    mocks.issues.create.mockImplementationOnce(async () => ({ id: "issue-A" }));
    await handleWebhook(
      ctx,
      baseConfig({ defaultCompanyId: "company-A" }),
      true,
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
      true,
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

    await handleWebhook(ctx, baseConfig(), true, baseInput());

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

    await handleWebhook(ctx, baseConfig(), true, baseInput());

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
      handleWebhook(ctx, baseConfig(), true, baseInput()),
    ).rejects.toBeInstanceOf(AlertDeliveryIncompleteError);
  });

  it("rejects the delivery when persisting alert state fails", async () => {
    const { ctx } = mkCtx();
    (ctx as unknown as MockClients).state.set.mockRejectedValue(
      new Error("plugin state store unavailable"),
    );

    await expect(
      handleWebhook(ctx, baseConfig(), true, baseInput()),
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
      true,
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
      handleWebhook(ctx, baseConfig(), true, baseInput({ parsedBody: twoAlertEnvelope() })),
    ).resolves.toBeUndefined();
  });

  it("still acknowledges a malformed payload — permanent, so retrying is pointless", async () => {
    const { ctx } = mkCtx();
    await expect(
      handleWebhook(ctx, baseConfig(), true, baseInput({ parsedBody: { nope: true } })),
    ).resolves.toBeUndefined();
  });

  it("does not let a metrics outage abort the remaining alerts", async () => {
    const { ctx, mocks } = mkCtx();
    mocks.issues.create.mockRejectedValue(new Error("issues.create RPC unavailable"));
    mocks.metrics.write.mockRejectedValue(new Error("metrics sink unavailable"));

    const err = await handleWebhook(
      ctx,
      baseConfig(),
      true,
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
    await expect(handleWebhook(ctx, baseConfig(), true, input)).rejects.toBeInstanceOf(
      AlertDeliveryIncompleteError,
    );
    expect(mocks.issues.create).toHaveBeenCalledTimes(1);

    // Attempt 2 is Alertmanager's retry. The state store is still empty — the
    // write that would have populated it is exactly what failed — so the only
    // way to avoid a duplicate is to reconcile against the existing issue.
    fail.on = false;
    mocks.issues.list.mockResolvedValue(liveIssue);
    await handleWebhook(ctx, baseConfig(), true, input);

    expect(mocks.issues.create).toHaveBeenCalledTimes(1);
    // The retry must also leave durable state behind, or every later delivery
    // repeats this reconciliation and the ladder never arms.
    expect(mocks.state.set).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeKind: "company", stateKey: "alert:9a3b1e4c5f6d7890" }),
      expect.objectContaining({ paperclipIssueId: "issue-from-attempt-1", resolvedAt: null }),
      FIRING_FENCE_ARG,
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

    await handleWebhook(ctx, baseConfig(), true, input).catch(() => {});
    fail.on = false;
    mocks.issues.list.mockResolvedValue(liveIssue);
    await handleWebhook(ctx, baseConfig(), true, input);

    const persisted = mocks.state.set.mock.calls.at(-1)?.[1] as {
      nextEscalationAt: string | null;
      escalationComplete?: boolean;
    };
    expect(persisted.nextEscalationAt).toEqual(expect.any(String));
    expect(persisted.escalationComplete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideRefire — the re-fire decision table as a pure function (BLO-24234)
//
// The handler tests above drive these branches through a whole webhook
// delivery, which is the right level for asserting side effects (metrics,
// comments, state writes). These assert the decision itself, so the table in
// the README has a direct, cheap counterpart in code — and so a future change
// to the branch order fails here with an obvious diff rather than as a
// surprising side effect three layers up.
// ---------------------------------------------------------------------------

describe("decideRefire", () => {
  const NOW = Date.parse("2026-05-01T12:00:00Z");
  const cfg = (hours?: number): AlertmanagerPluginConfig => ({
    defaultCompanyId: "company-1",
    ...(hours === undefined ? {} : { operatorSuppressionHours: hours }),
  });
  const ago = (h: number) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

  it("refreshes any non-terminal issue regardless of suppression state", () => {
    for (const status of ["todo", "in_progress", "in_review", "blocked"]) {
      expect(
        decideRefire({ status }, { resolvedAt: null, operatorSuppressedAt: ago(99) }, cfg(), NOW),
      ).toEqual({ kind: "refresh" });
    }
  });

  it("re-opens a terminal issue the plugin closed on resolve", () => {
    for (const status of ["done", "cancelled"]) {
      expect(
        decideRefire({ status }, { resolvedAt: ago(1), operatorSuppressedAt: null }, cfg(), NOW),
      ).toEqual({ kind: "reopen", reason: "plugin_resolved" });
    }
  });

  it("suppresses an operator close, anchoring on first observation", () => {
    expect(
      decideRefire({ status: "cancelled" }, { resolvedAt: null, operatorSuppressedAt: null }, cfg(), NOW),
    ).toEqual({
      kind: "suppressed",
      suppressedAt: new Date(NOW).toISOString(),
      firstObservation: true,
    });
  });

  it("keeps the original anchor while inside the window", () => {
    const anchor = ago(23);
    expect(
      decideRefire({ status: "cancelled" }, { resolvedAt: null, operatorSuppressedAt: anchor }, cfg(), NOW),
    ).toEqual({ kind: "suppressed", suppressedAt: anchor, firstObservation: false });
  });

  it("re-opens once the window has elapsed", () => {
    expect(
      decideRefire({ status: "cancelled" }, { resolvedAt: null, operatorSuppressedAt: ago(24) }, cfg(), NOW),
    ).toEqual({ kind: "reopen", reason: "suppression_expired" });
  });

  it("treats the boundary as expired, not as still-suppressed", () => {
    // Exactly 24h. `>=` matters: a `>` here would leave a re-fire landing on
    // the tick suppressed for another whole window.
    const anchor = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
    expect(
      decideRefire({ status: "cancelled" }, { resolvedAt: null, operatorSuppressedAt: anchor }, cfg(), NOW).kind,
    ).toBe("reopen");
  });

  it("honours a custom window", () => {
    const existing = { resolvedAt: null, operatorSuppressedAt: ago(2) };
    expect(decideRefire({ status: "cancelled" }, existing, cfg(1), NOW).kind).toBe("reopen");
    expect(decideRefire({ status: "cancelled" }, existing, cfg(4), NOW).kind).toBe("suppressed");
  });

  it("never expires when operatorSuppressionHours is 0", () => {
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: ago(24 * 365) },
        cfg(0),
        NOW,
      ).kind,
    ).toBe("suppressed");
  });

  it("falls back to the default window for nonsense settings", () => {
    // A negative or NaN setting must not read as 0 ("mute forever") — that
    // would turn a config typo into a silently unpageable alert.
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        decideRefire(
          { status: "cancelled" },
          { resolvedAt: null, operatorSuppressedAt: ago(25) },
          cfg(bad),
          NOW,
        ).kind,
      ).toBe("reopen");
    }
  });

  it("re-anchors an unparseable anchor instead of muting forever", () => {
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: "garbage" },
        cfg(),
        NOW,
      ),
    ).toEqual({
      kind: "suppressed",
      suppressedAt: new Date(NOW).toISOString(),
      firstObservation: true,
    });
  });

  it("reports a missing issue", () => {
    for (const missing of [null, undefined]) {
      expect(
        decideRefire(missing, { resolvedAt: ago(1), operatorSuppressedAt: null }, cfg(), NOW),
      ).toEqual({ kind: "issue_missing" });
    }
  });

  it("prefers the plugin-resolved re-open over suppression when both could apply", () => {
    // A row carrying both a resolve and a stale anchor is a close→re-fire→
    // close→resolve history. The resolve is the more recent fact, so this must
    // not be read as an operator mute.
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: ago(1), operatorSuppressedAt: ago(2) },
        cfg(),
        NOW,
      ),
    ).toEqual({ kind: "reopen", reason: "plugin_resolved" });
  });

  // -------------------------------------------------------------------------
  // Clamp (Ally review on #1349). `Number.isFinite` is checked on the
  // configured hours, but the window is that value * 3.6e6 — so a finite
  // input can still produce a non-finite window, and `now - anchor >= Infinity`
  // is never true. That is the unbounded mute BLO-24234 removed, reachable
  // again through a config typo.
  // -------------------------------------------------------------------------

  it("clamps a window whose millisecond conversion would overflow to Infinity", () => {
    // 1e308 is finite and positive, so it passes the isFinite guard, but
    // 1e308 * 3.6e6 === Infinity. Pre-clamp this suppressed forever.
    for (const huge of [1e308, Number.MAX_VALUE]) {
      expect(
        decideRefire(
          { status: "cancelled" },
          { resolvedAt: null, operatorSuppressedAt: ago(24 * 31) },
          cfg(huge),
          NOW,
        ).kind,
      ).toBe("reopen");
    }
  });

  it("clamps a finite-but-geological window", () => {
    // 1e15 hours never overflows — it is just ~1e11 years. A finiteness check
    // on the product alone would let this through; only a ceiling catches it.
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: ago(24 * 31) },
        cfg(1e15),
        NOW,
      ).kind,
    ).toBe("reopen");
  });

  it("clamps to exactly MAX_OPERATOR_SUPPRESSION_HOURS, not to the default", () => {
    // Just inside the ceiling stays suppressed — the clamp must not collapse
    // an over-large value down to the 24h default, which would silently
    // shorten a deliberate long mute rather than bounding it.
    const overCeiling = MAX_OPERATOR_SUPPRESSION_HOURS * 10;
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: ago(MAX_OPERATOR_SUPPRESSION_HOURS - 1) },
        cfg(overCeiling),
        NOW,
      ).kind,
    ).toBe("suppressed");
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: ago(MAX_OPERATOR_SUPPRESSION_HOURS) },
        cfg(overCeiling),
        NOW,
      ).kind,
    ).toBe("reopen");
  });

  it("leaves 0 as the explicit opt-in to indefinite suppression", () => {
    // The clamp must not turn the documented "mute forever" escape hatch into
    // a 30-day window; Math.min(0, ceiling) is still 0.
    expect(
      decideRefire(
        { status: "cancelled" },
        { resolvedAt: null, operatorSuppressedAt: ago(24 * 365 * 100) },
        cfg(0),
        NOW,
      ).kind,
    ).toBe("suppressed");
  });
});

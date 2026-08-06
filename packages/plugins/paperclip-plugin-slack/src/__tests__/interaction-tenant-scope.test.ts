import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import { WEBHOOK_KEYS } from "../constants.js";

// BLO-21083: the scheduled-jobs fix (BLO-20959 / PR #974) resolved each
// company's Slack config and token per job tick. It deliberately left the
// INTERACTIVE surface untouched — every Slack-originated request path
// (reactions, slash commands, modal submissions, block_actions) still read a
// module-level `pluginToken`, and derived its companyId by guessing (the
// first company on `ctx.companies.list()`) rather than from the delivery
// itself. On a multi-company install the bootstrap config the host hands the
// worker is always `{}` (server/src/services/plugin-loader.ts), so
// `pluginToken` could never be populated, and the guessed companyId could
// name a DIFFERENT tenant than the one that actually sent the request —
// authenticating one company's interaction against another company's bot
// token, or another company's data.
//
// Every case below is proven against the pre-fix worker before being
// accepted: see the BLO-21083 PR description for the revert-and-rerun
// transcript. `ctx.companies.list` is mocked to throw so any code path that
// still falls back to it (instead of using the webhook's own `companyId`)
// fails loudly rather than silently guessing.

const SIGNING_SECRET = "sig-secret-value";

interface CompanyFixture {
  slackTokenRef?: string;
  slackSigningSecretRef?: string;
  approvalReactorSlackIds?: string[];
  paperclipBaseUrl?: string;
}

interface MkCtxOptions {
  /** Per-company config returned by `ctx.config.get(companyId)`. */
  companyConfigs?: Record<string, CompanyFixture>;
  /** Secret resolution behaviour, keyed by ref. */
  secrets?: Record<string, string | Error>;
  /** Initial plugin state, keyed as scopeKind:scopeId:stateKey. */
  state?: Record<string, unknown>;
}

const stateId = (key: { scopeKind: string; scopeId: string; stateKey: string }) =>
  `${key.scopeKind}:${key.scopeId}:${key.stateKey}`;

function mkCtx(options: MkCtxOptions = {}) {
  const { companyConfigs = {}, secrets = {}, state = {} } = options;
  const storedState = new Map(Object.entries(state));
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const ctx: any = {
    config: {
      // Bootstrap (no companyId) is always `{}` on a multi-company install —
      // exactly the shape plugin-loader.ts hands every worker. Per-company
      // rows come only from `companyConfigs`, keyed strictly by companyId —
      // there is no "first configured company" fallback here, so any code
      // path that guesses instead of using the delivery's own companyId gets
      // `{}` (or the WRONG company's row) rather than silently working.
      get: vi.fn(async (companyId?: string) =>
        companyId ? (companyConfigs[companyId] ?? {}) : {},
      ),
    },
    secrets: {
      resolve: vi.fn(async (ref: string, _opts?: { companyId?: string }) => {
        const value = secrets[ref];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`no such secret: ${ref}`);
        return value;
      }),
    },
    // Any code path that still lists companies to guess a tenant (the
    // pre-fix `resolveTargetCompanyId`) fails loudly here instead of quietly
    // resolving to "whichever company is first".
    companies: {
      list: vi.fn(async () => {
        throw new Error(
          "ctx.companies.list() called — an interactive path guessed a tenant instead of using the delivery's own companyId",
        );
      }),
    },
    jobs: { register: vi.fn() },
    events: { on: vi.fn(), emit: vi.fn(async () => undefined) },
    state: {
      get: vi.fn(async (key: Parameters<typeof stateId>[0]) =>
        storedState.get(stateId(key)) ?? null,
      ),
      set: vi.fn(async (key: Parameters<typeof stateId>[0], value: unknown) => {
        storedState.set(stateId(key), value);
      }),
      delete: vi.fn(async (key: Parameters<typeof stateId>[0]) => {
        storedState.delete(stateId(key));
      }),
    },
    issues: { list: vi.fn(async () => []) },
    agents: { list: vi.fn(async () => []), invoke: vi.fn(async () => ({ runId: "run-1" })) },
    http: {
      fetch: vi.fn(async (url: string, init: any) => {
        fetchCalls.push({ url, init });
        return {
          status: 200,
          headers: new Headers(),
          json: async () => ({ ok: true, ts: "123.456" }),
        };
      }),
    },
    rpc: {
      call: vi.fn(async (_method: string, params: Record<string, unknown>) => ({
        id: params.approvalId,
        companyId: params.companyId,
        type: "request_board_approval",
        status: "approved",
        requestedByAgentId: null,
        requestedByUserId: null,
        decisionNote: null,
        decidedByUserId: params.decidedByUserId,
        decidedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        applied: true,
      })),
    },
    metrics: { write: vi.fn(async () => undefined) },
    activity: { log: vi.fn(async () => undefined) },
    tools: { register: vi.fn() },
    webhooks: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  return { ctx, storedState, fetchCalls };
}

/** Authorization header actually sent on a given fetch call. */
function bearerOf(call: { init: any } | undefined): string | undefined {
  const auth = call?.init?.headers?.Authorization as string | undefined;
  return auth?.replace(/^Bearer /, "");
}

function approvalByTsKey(companyId: string, channel: string, ts: string) {
  return `company:${companyId}:approval-by-ts-${channel}-${ts}`;
}

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const CHANNEL = "C_APPROVALS";
const TS = "1717200000.000100";
const APPROVAL_B = "approval-b-1";

/** Valid `x-slack-signature` + `x-slack-request-timestamp` headers for `rawBody`. */
function signedHeaders(secret: string, rawBody: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
  return { "x-slack-request-timestamp": ts, "x-slack-signature": sig };
}

describe("Slack interactive surface tenant scoping (BLO-21083)", () => {
  it("a reaction-driven approval on company B resolves and uses ONLY company B's token — company A's ref is never touched", async () => {
    const { ctx, storedState, fetchCalls } = mkCtx({
      companyConfigs: {
        // Company A is configured too, so a guess-the-first-company bug has
        // something plausible to guess wrong into.
        [COMPANY_A]: {
          slackTokenRef: "ref-a",
          slackSigningSecretRef: "sig-ref",
          approvalReactorSlackIds: ["U_A"],
        },
        [COMPANY_B]: {
          slackTokenRef: "ref-b",
          slackSigningSecretRef: "sig-ref",
          approvalReactorSlackIds: ["U_B"],
          paperclipBaseUrl: "http://pc.local",
        },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b", "sig-ref": SIGNING_SECRET },
      state: {
        [approvalByTsKey(COMPANY_B, CHANNEL, TS)]: APPROVAL_B,
      },
    });
    await plugin.definition.setup?.(ctx as any);

    const rawBody = JSON.stringify({
      type: "event_callback",
      event: {
        type: "reaction_added",
        reaction: "white_check_mark",
        user: "U_B",
        item: { channel: CHANNEL, ts: TS },
      },
    });
    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.slackEvents,
      headers: signedHeaders(SIGNING_SECRET, rawBody),
      rawBody,
      parsedBody: JSON.parse(rawBody),
      requestId: "req-1",
    } as any);

    // Resolved company B's own credential...
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-b", { companyId: COMPANY_B });
    // ...and never touched company A's, even though A is configured too.
    expect(ctx.secrets.resolve).not.toHaveBeenCalledWith("ref-a", expect.anything());

    // The staged-decision card edit actually used company B's bot token.
    const cardEdit = fetchCalls.find((c) => c.url === "https://slack.com/api/chat.update");
    expect(cardEdit).toBeDefined();
    expect(bearerOf(cardEdit)).toBe("xoxb-b");

    // And it was staged (authorized reactor for B), not dropped.
    expect(storedState.get(`company:${COMPANY_B}:approval-pending-${APPROVAL_B}`)).toMatchObject({
      decision: "approve",
      by: "U_B",
    });
  });

  it("an interaction whose delivery carries no companyId is dropped with one explanatory warn — never guesses a tenant", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        [COMPANY_B]: { slackTokenRef: "ref-b", slackSigningSecretRef: "sig-ref" },
      },
      secrets: { "ref-b": "xoxb-b", "sig-ref": SIGNING_SECRET },
      state: { [approvalByTsKey(COMPANY_B, CHANNEL, TS)]: APPROVAL_B },
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      companyId: "",
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: {},
      rawBody: "",
      parsedBody: {
        payload: JSON.stringify({
          type: "block_actions",
          response_url: "https://hooks.slack.test/action",
          user: { id: "U_B" },
          actions: [{ action_id: "approval_approve", value: APPROVAL_B }],
        }),
      },
      requestId: "req-2",
    } as any);

    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(ctx.rpc.call).not.toHaveBeenCalled();
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("carried no companyId"),
    );
  });

  it("an interaction for a company with no stored Slack config is refused — never falls back to a different company's token", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        // Only B is configured. The delivery below claims to be for
        // "company-c", which has no config row at all.
        [COMPANY_B]: {
          slackTokenRef: "ref-b",
          slackSigningSecretRef: "sig-ref",
          approvalReactorSlackIds: ["U_B"],
        },
      },
      secrets: { "ref-b": "xoxb-b", "sig-ref": SIGNING_SECRET },
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      companyId: "company-c",
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: {},
      rawBody: "",
      parsedBody: {
        payload: JSON.stringify({
          type: "block_actions",
          response_url: "https://hooks.slack.test/action",
          user: { id: "U_B" },
          actions: [{ action_id: "approval_approve", value: APPROVAL_B }],
        }),
      },
      requestId: "req-3",
    } as any);

    // Never resolved company B's token to serve company C's request.
    expect(ctx.secrets.resolve).not.toHaveBeenCalledWith("ref-b", expect.anything());
    expect(ctx.rpc.call).not.toHaveBeenCalled();
    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no stored config"),
    );
  });

  it("a slash command on a multi-company install works after a cold worker start with no config edit", async () => {
    const { ctx, fetchCalls } = mkCtx({
      companyConfigs: {
        [COMPANY_A]: { slackTokenRef: "ref-a" },
        [COMPANY_B]: { slackTokenRef: "ref-b" },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b" },
    });
    // Cold start: setup() only ever sees the empty bootstrap snapshot.
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.slashCommand,
      headers: {},
      rawBody:
        "command=/clip&text=acp status&user_id=U_B&channel_id=C_THREAD&response_url=https://hooks.slack.test/slash",
      parsedBody: undefined,
      requestId: "req-4",
    } as any);

    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-b", { companyId: COMPANY_B });
    expect(ctx.secrets.resolve).not.toHaveBeenCalledWith("ref-a", expect.anything());
    const posted = fetchCalls.find((c) => c.url === "https://slack.com/api/chat.postMessage");
    expect(posted).toBeDefined();
    expect(bearerOf(posted)).toBe("xoxb-b");
  });

  it("an approval button click (block_actions) commits through the delivering company's own credential and RPC scope", async () => {
    const { ctx, fetchCalls } = mkCtx({
      companyConfigs: {
        [COMPANY_A]: {
          slackTokenRef: "ref-a",
          slackSigningSecretRef: "sig-ref",
          approvalReactorSlackIds: ["U_A"],
        },
        [COMPANY_B]: {
          slackTokenRef: "ref-b",
          slackSigningSecretRef: "sig-ref",
          approvalReactorSlackIds: ["U_B"],
        },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b", "sig-ref": SIGNING_SECRET },
    });
    await plugin.definition.setup?.(ctx as any);

    const interactivityJson = JSON.stringify({
      type: "block_actions",
      response_url: "https://hooks.slack.test/action",
      user: { id: "U_B" },
      actions: [{ action_id: "approval_approve", value: APPROVAL_B }],
    });
    const rawBody = `payload=${encodeURIComponent(interactivityJson)}`;
    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: signedHeaders(SIGNING_SECRET, rawBody),
      rawBody,
      parsedBody: { payload: interactivityJson },
      requestId: "req-5",
    } as any);

    expect(ctx.rpc.call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ companyId: COMPANY_B, decidedByUserId: "slack:U_B" }),
    );
    const respond = fetchCalls.find((c) => c.url === "https://hooks.slack.test/action");
    expect(respond).toBeDefined();
    expect(bearerOf(respond)).toBe("xoxb-b");
  });

  it("a company with its own signing secret is served on a multi-company install — the mutating gate is not permanently closed by an unresolved bootstrap snapshot", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        [COMPANY_A]: {
          slackTokenRef: "ref-a",
          slackSigningSecretRef: "sig-ref-a",
          approvalReactorSlackIds: ["U_A"],
        },
        [COMPANY_B]: { slackTokenRef: "ref-b" },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b", "sig-ref-a": SIGNING_SECRET },
    });
    await plugin.definition.setup?.(ctx as any);

    const interactivityJson = JSON.stringify({
      type: "block_actions",
      response_url: "https://hooks.slack.test/action",
      user: { id: "U_A" },
      actions: [{ action_id: "approval_approve", value: "approval-a-1" }],
    });
    const rawBody = `payload=${encodeURIComponent(interactivityJson)}`;
    await plugin.definition.onWebhook?.({
      companyId: COMPANY_A,
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: signedHeaders(SIGNING_SECRET, rawBody),
      rawBody,
      parsedBody: { payload: interactivityJson },
      requestId: "req-6",
    } as any);

    // On the pre-fix worker this is unconditionally rejected: the module-level
    // signing secret is only ever populated from the setup() bootstrap
    // snapshot, which the host always hands the worker as `{}` once more than
    // one company has configured the plugin — so it never resolves for ANY
    // company, regardless of what that company's own config says.
    expect(ctx.rpc.call).toHaveBeenCalledWith(
      "approvals.resolve",
      expect.objectContaining({ companyId: COMPANY_A, decidedByUserId: "slack:U_A" }),
    );
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      "Rejected mutating Slack approval webhook: missing Slack signing secret",
      expect.anything(),
    );
  });

  // Regression guard, not new-coverage evidence: on a multi-company install
  // the pre-fix worker also rejects this delivery, but only because its
  // single module-level signing secret never resolves for ANY company (see
  // the test above) — not because it correctly scoped the check to company B.
  // Kept so a future change that reintroduces a cross-company fallback (e.g.
  // "use A's secret if B's is missing") would be caught here even though this
  // specific assertion doesn't discriminate pre-fix vs post-fix on its own.
  it("a company with no signing secret of its own is rejected — never served under a different company's secret", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        // Company A has a signing secret configured; company B does not.
        [COMPANY_A]: { slackTokenRef: "ref-a", slackSigningSecretRef: "sig-ref-a" },
        [COMPANY_B]: { slackTokenRef: "ref-b" },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b", "sig-ref-a": SIGNING_SECRET },
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers: {},
      rawBody: "",
      parsedBody: {
        payload: JSON.stringify({
          type: "block_actions",
          response_url: "https://hooks.slack.test/action",
          user: { id: "U_B" },
          actions: [{ action_id: "approval_approve", value: APPROVAL_B }],
        }),
      },
      requestId: "req-7",
    } as any);

    // Company B has no signing secret of its own — the action must be
    // rejected rather than accepted under company A's secret.
    expect(ctx.rpc.call).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Rejected mutating Slack approval webhook: missing Slack signing secret",
      { source: "interactivity" },
    );
  });
});

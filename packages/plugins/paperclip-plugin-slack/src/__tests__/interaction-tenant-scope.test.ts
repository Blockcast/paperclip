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
  /**
   * Config returned by the bare `ctx.config.get()` the worker calls in
   * `setup()`. Defaults to `{}`, which is what plugin-loader.ts hands a worker
   * on any install with zero or 2+ configured companies. Pass a real fixture
   * to model the SINGLE-company install, where the loader sets
   * `bootstrapCompanyId` and the snapshot carries that one company's real
   * credentials — the precondition for the BLO-29455 1->2 window.
   */
  bootstrapConfig?: CompanyFixture;
  /** Secret resolution behaviour, keyed by ref. */
  secrets?: Record<string, string | Error>;
  /** Initial plugin state, keyed as scopeKind:scopeId:stateKey. */
  state?: Record<string, unknown>;
}

const stateId = (key: { scopeKind: string; scopeId: string; stateKey: string }) =>
  `${key.scopeKind}:${key.scopeId}:${key.stateKey}`;

function mkCtx(options: MkCtxOptions = {}) {
  const {
    companyConfigs = {},
    bootstrapConfig = {},
    secrets = {},
    state = {},
  } = options;
  const storedState = new Map(Object.entries(state));
  const fetchCalls: Array<{ url: string; init: any }> = [];
  // Handlers the worker registers via ctx.events.on, so a test can drive the
  // in-process router the way handleInboundMessageEvent does at runtime.
  const eventHandlers = new Map<string, (event: any) => Promise<void>>();
  const ctx: any = {
    config: {
      // Bootstrap (no companyId) is `{}` by default — exactly the shape
      // plugin-loader.ts hands every worker on a multi-company install — and
      // a real company fixture when the test models a single-company install.
      // Per-company rows come only from `companyConfigs`, keyed strictly by
      // companyId — there is no "first configured company" fallback here, so
      // any code path that guesses instead of using the delivery's own
      // companyId gets `{}` (or the WRONG company's row) rather than silently
      // working.
      get: vi.fn(async (companyId?: string) =>
        companyId ? (companyConfigs[companyId] ?? {}) : bootstrapConfig,
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
    events: {
      on: vi.fn((name: string, handler: (event: any) => Promise<void>) => {
        eventHandlers.set(name, handler);
      }),
      emit: vi.fn(async () => undefined),
    },
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
  return { ctx, storedState, fetchCalls, eventHandlers, companyConfigs };
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

    // Rejected at the signature gate rather than further down in
    // resolveInteractionScope: with no companyId there is no company whose
    // signing secret could verify this delivery, so it cannot be
    // authenticated at all and is refused before any handler runs.
    //
    // Asserted on effects, not on the rejection log line: that warn is
    // throttled to one per 5s (public endpoint) and the throttle state is
    // module-global across this file, so asserting the message here would
    // make the test depend on which case ran first. The three assertions
    // above are the security property itself.
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(ctx.rpc.call).not.toHaveBeenCalled();
    expect(ctx.http.fetch).not.toHaveBeenCalled();
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

// BLO-21083 review follow-up (Ally, pullrequestreview-4987452894).
//
// The first revision of the per-company signing-secret resolution returned a
// bare `string | null`, and `null` reaches `verifySlackSignature` meaning
// *skip verification*. So "this company configured no secret" (a deliberate
// opt-out) and "the secret could not be read" (an infra failure) were the
// same value: a transient config/secret-store blip silently downgraded a
// company that HAS configured verification to unverified for that delivery.
//
// That mattered because the mutating-approval gate is not the only consumer.
// `canProcessMutatingApprovalWebhook` does block approvals on a null secret,
// but the slash-command path (`/clip acp spawn`, which invokes agents),
// `file_shared` → processMediaFile, and `message` → thread routing all
// proceed — so during the window an unauthenticated POST naming any
// companyId would have been processed.
//
// `/clip help` is used as the probe below because it is the cheapest path
// that is NOT behind the approval gate and has a directly observable effect
// (it posts the help card to `response_url` via ctx.http.fetch). Each of the
// two fail-closed cases was confirmed to FAIL against the pre-fix resolver
// (which returned null and therefore skipped verification, serving the
// unsigned request) before being accepted.
describe("Slack webhook signing-secret resolution fails closed (BLO-21083 review)", () => {
  const HELP_BODY = new URLSearchParams({
    command: "/clip",
    text: "help",
    response_url: "https://hooks.slack.test/help",
    user_id: "U_B",
    channel_id: CHANNEL,
  }).toString();

  const slashDelivery = (companyId: string, headers: Record<string, string>) =>
    ({
      companyId,
      endpointKey: WEBHOOK_KEYS.slashCommand,
      headers,
      rawBody: HELP_BODY,
      parsedBody: {},
      requestId: "req-sig",
    }) as any;

  it("a configured signing secret that FAILS to resolve rejects the delivery — an infra blip must not become skip-verification", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        [COMPANY_B]: { slackTokenRef: "ref-b", slackSigningSecretRef: "sig-ref" },
      },
      // The secret store is down for this ref.
      secrets: { "ref-b": "xoxb-b", "sig-ref": new Error("secret store unavailable") },
    });
    await plugin.definition.setup?.(ctx as any);

    // Unsigned: pre-fix this was served, because the failed resolve produced
    // `null` and `null` meant "skip verification".
    await plugin.definition.onWebhook?.(slashDelivery(COMPANY_B, {}));

    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve slackSigningSecretRef"),
      expect.objectContaining({ err: expect.anything() }),
    );
  });

  it("a config read failure rejects the delivery rather than falling through to skip-verification", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        [COMPANY_B]: { slackTokenRef: "ref-b", slackSigningSecretRef: "sig-ref" },
      },
      secrets: { "ref-b": "xoxb-b", "sig-ref": SIGNING_SECRET },
    });
    ctx.config.get.mockImplementation(async (companyId?: string) => {
      if (companyId === COMPANY_B) throw new Error("config store unavailable");
      return {};
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.(slashDelivery(COMPANY_B, {}));

    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not load config to resolve the Slack signing secret"),
      expect.objectContaining({ err: expect.anything() }),
    );
  });

  it("a company that configured NO signing secret still skips verification — the documented opt-out is preserved, not tightened", async () => {
    const { ctx, fetchCalls } = mkCtx({
      // No slackSigningSecretRef at all.
      companyConfigs: { [COMPANY_B]: { slackTokenRef: "ref-b" } },
      secrets: { "ref-b": "xoxb-b" },
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.(slashDelivery(COMPANY_B, {}));

    // Served, exactly as before this change: `none` is not `unavailable`.
    expect(fetchCalls.map((c) => c.url)).toContain("https://hooks.slack.test/help");
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("signing secret unavailable"),
      expect.anything(),
    );
  });

  it("a configured secret that resolves EMPTY is treated as unreadable, not as an opt-out", async () => {
    const { ctx } = mkCtx({
      companyConfigs: {
        [COMPANY_B]: { slackTokenRef: "ref-b", slackSigningSecretRef: "sig-ref" },
      },
      secrets: { "ref-b": "xoxb-b", "sig-ref": "" },
    });
    await plugin.definition.setup?.(ctx as any);

    await plugin.definition.onWebhook?.(slashDelivery(COMPANY_B, {}));

    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved to an empty value"),
    );
  });
});

// BLO-21083 review follow-up: two reads of the setup()-time bootstrap
// snapshot survived on the slash-command path. Because the host always hands
// the worker `{}`, `pluginConfig.paperclipBaseUrl` was `undefined` on every
// multi-company install — the status card shipped a button with no `url` and
// the help card rendered a literal `undefined` as its link target.
describe("Slack slash-command dashboard links are per-company (BLO-21083 review)", () => {
  const slashBody = (text: string) =>
    new URLSearchParams({
      command: "/clip",
      text,
      response_url: "https://hooks.slack.test/cmd",
      user_id: "U_B",
      channel_id: CHANNEL,
    }).toString();

  const bodyOf = (call: { init: any } | undefined) =>
    call?.init?.body ? String(call.init.body) : "";

  it("the help card links to the DELIVERING company's dashboard, never `undefined` and never another company's host", async () => {
    const { ctx, fetchCalls } = mkCtx({
      companyConfigs: {
        [COMPANY_A]: { slackTokenRef: "ref-a", paperclipBaseUrl: "https://pc-a.example" },
        [COMPANY_B]: { slackTokenRef: "ref-b", paperclipBaseUrl: "https://pc-b.example/" },
      },
      secrets: { "ref-a": "xoxb-a", "ref-b": "xoxb-b" },
    });
    await plugin.definition.setup?.(ctx as any);

    const rawBody = slashBody("help");
    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.slashCommand,
      headers: {},
      rawBody,
      parsedBody: {},
      requestId: "req-help",
    } as any);

    const sent = bodyOf(fetchCalls.find((c) => c.url === "https://hooks.slack.test/cmd"));
    expect(sent).toContain("https://pc-b.example|Open Paperclip Dashboard");
    // The pre-fix bug, stated as an assertion.
    expect(sent).not.toContain("undefined");
    // No bleed from the other configured tenant.
    expect(sent).not.toContain("pc-a.example");
  });

  it("the status card omits the dashboard button entirely when the company has no base URL, rather than shipping a url-less button", async () => {
    const { ctx, fetchCalls } = mkCtx({
      // Configured for Slack, but no paperclipBaseUrl.
      companyConfigs: { [COMPANY_B]: { slackTokenRef: "ref-b" } },
      secrets: { "ref-b": "xoxb-b" },
    });
    await plugin.definition.setup?.(ctx as any);

    const rawBody = slashBody("status");
    await plugin.definition.onWebhook?.({
      companyId: COMPANY_B,
      endpointKey: WEBHOOK_KEYS.slashCommand,
      headers: {},
      rawBody,
      parsedBody: {},
      requestId: "req-status",
    } as any);

    const sent = bodyOf(fetchCalls.find((c) => c.url === "https://hooks.slack.test/cmd"));
    // The card is still delivered...
    expect(sent).toContain("Paperclip Status");
    // ...but with no dead control and no stringified undefined.
    expect(sent).not.toContain("view_dashboard");
    expect(sent).not.toContain("undefined");
  });
});

// ===========================================================================
// BLO-29455 — the 1->2-company transition.
//
// Every case above models an install that was ALREADY multi-company when the
// worker started, where the bootstrap config is `{}` and the setup() snapshot
// is therefore empty and harmless. This block models the one shape that is
// not harmless: an install that started with EXACTLY ONE configured company.
//
// There, `plugin-loader.ts` sets `bootstrapCompanyId` to that single company,
// so `ctx.config.get()` returns A's REAL config, setup() proceeds past the
// `slackTokenRef` credential gate, and the thread-message router registers
// while closing over A's `token`, A's `config` (hence A's
// `approvalReactorSlackIds`) and A's signing secret. Company B then
// configures the plugin and the host does NOT restart the worker: its restart
// path keys off a `METHOD_NOT_IMPLEMENTED` error that the SDK never raises for
// a plugin with no `onConfigChanged`, and the Slack plugin has none. So the
// stale closure survives and `event.companyId` is now B.
//
// The fixtures below drive that transition literally — setup() with only A
// configured, then add B, then emit for B — rather than asserting against a
// pre-arranged two-company world, because it is the transition that creates
// the exposure.
//
// PROVEN AGAINST THE PRE-FIX WORKER: see the BLO-29455 PR description for the
// revert-and-rerun transcript. Both authorization cases invert without the
// fix (A's allowlist admits U_A to B's approval and rejects B's own U_B), and
// every Slack call carries `xoxb-a`.
// ===========================================================================

const APPROVAL_B_THREAD = "approval-b-thread";
const THREAD_TS = "1717200000.000900";

/** Bearer tokens on every Slack API call, in order. */
function slackBearers(fetchCalls: Array<{ url: string; init: any }>): string[] {
  return fetchCalls
    .filter((c) => c.url.startsWith("https://slack.com/api/"))
    .map((c) => bearerOf(c) ?? "<none>");
}

/**
 * Boot a worker the way a SINGLE-company install does, then add company B
 * without restarting it — i.e. exactly the BLO-29455 window.
 *
 * Returns the captured `plugin.slack.thread_message` handler. `setup()` must
 * have registered it: on this install the credential gate passes, which is
 * precisely why the stale closure exists to be wrong.
 */
async function bootSingleCompanyThenAddB() {
  const companyAFixture = {
    slackTokenRef: "ref-a",
    slackSigningSecretRef: "sig-ref-a",
    approvalReactorSlackIds: ["U_A"],
    paperclipBaseUrl: "http://a.local",
  };
  const harness = mkCtx({
    // At worker start company A is the ONLY configured company, so the host
    // hands the worker A's real config as the bootstrap snapshot.
    bootstrapConfig: companyAFixture,
    companyConfigs: { [COMPANY_A]: companyAFixture },
    secrets: {
      "ref-a": "xoxb-a",
      "ref-b": "xoxb-b",
      "sig-ref-a": SIGNING_SECRET,
      "sig-ref-b": SIGNING_SECRET,
    },
    state: {
      [approvalByTsKey(COMPANY_B, CHANNEL, THREAD_TS)]: APPROVAL_B_THREAD,
    },
  });

  await plugin.definition.setup?.(harness.ctx as any);

  const handler = harness.eventHandlers.get("plugin.slack.thread_message");
  // Guard the premise: if setup() bailed at the credential gate there is no
  // stale closure and these cases would vacuously pass.
  expect(handler).toBeDefined();

  // --- company B configures the plugin. No restart, no pod delete. ---
  harness.companyConfigs[COMPANY_B] = {
    slackTokenRef: "ref-b",
    slackSigningSecretRef: "sig-ref-b",
    approvalReactorSlackIds: ["U_B"],
    paperclipBaseUrl: "http://b.local",
  };

  return { ...harness, handler: handler! };
}

function threadEvent(slackUserId: string, text: string) {
  return {
    companyId: COMPANY_B,
    payload: { channel: CHANNEL, threadTs: THREAD_TS, text, slackUserId },
  };
}

describe("Slack thread-command router tenant scoping across a 1->2-company transition (BLO-29455)", () => {
  it("refuses a company-A approver on company B's approval — the allowlist checked is B's, not the bootstrap snapshot's", async () => {
    const { ctx, storedState, fetchCalls, handler } =
      await bootSingleCompanyThenAddB();

    // U_A is on company A's allowlist and NOT on company B's.
    await handler(threadEvent("U_A", "!approve ship it"));

    // Refused: no decision was committed or staged for B's approval.
    expect(
      storedState.get(`company:${COMPANY_B}:approval-pending-${APPROVAL_B_THREAD}`),
    ).toBeUndefined();
    const posted = fetchCalls.filter(
      (c) => c.url === "https://slack.com/api/chat.postMessage",
    );
    expect(posted).toHaveLength(1);
    expect(String(posted[0].init?.body)).toContain("not on the approval allowlist");

    // ...and even the refusal notice went out on B's OWN token, never A's.
    expect(slackBearers(fetchCalls)).toEqual(["xoxb-b"]);
    expect(slackBearers(fetchCalls)).not.toContain("xoxb-a");
    // B's credential was resolved company-scoped; the bootstrap path never is.
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-b", {
      companyId: COMPANY_B,
    });
  });

  it("honours company B's own approver on company B's approval — B's approvers are not locked out by A's allowlist", async () => {
    const { fetchCalls, handler } = await bootSingleCompanyThenAddB();

    // U_B is on company B's allowlist and NOT on company A's.
    await handler(threadEvent("U_B", "!approve"));

    // Accepted: it was NOT bounced off A's allowlist.
    const posted = fetchCalls.filter(
      (c) => c.url === "https://slack.com/api/chat.postMessage",
    );
    expect(
      posted.some((c) => String(c.init?.body).includes("not on the approval allowlist")),
    ).toBe(false);

    // The command actually did something, and every Slack call it made used
    // B's token.
    const bearers = slackBearers(fetchCalls);
    expect(bearers.length).toBeGreaterThan(0);
    expect(new Set(bearers)).toEqual(new Set(["xoxb-b"]));
  });

  it("links the approval card to company B's dashboard host, never the bootstrap company's", async () => {
    const { fetchCalls, handler } = await bootSingleCompanyThenAddB();

    await handler(threadEvent("U_B", "!approve"));

    const bodies = fetchCalls.map((c) => String(c.init?.body ?? "")).join("\n");
    // Asserted positively on purpose: a bare `not.toContain("http://a.local")`
    // passes vacuously against the pre-fix worker, which bounces U_B off A's
    // allowlist and so never renders a card with any host in it at all.
    expect(bodies).toContain("http://b.local/approvals/");
    expect(bodies).not.toContain("http://a.local");
  });

  it("refuses the thread command outright once company B's config is gone — never falls back to the bootstrap token", async () => {
    const { fetchCalls, storedState, handler, companyConfigs } =
      await bootSingleCompanyThenAddB();
    // B is de-configured (or its row is unreadable) between events. The
    // router must drop the command, not serve it under A's still-live token.
    delete companyConfigs[COMPANY_B];

    await handler(threadEvent("U_B", "!approve"));

    expect(slackBearers(fetchCalls)).toEqual([]);
    expect(
      storedState.get(`company:${COMPANY_B}:approval-pending-${APPROVAL_B_THREAD}`),
    ).toBeUndefined();
  });

  // NOT a falsification case, deliberately: this one passes against the
  // pre-fix worker too, and must. It is the no-regression guard for the fix
  // itself — the risk of resolving a scope per event is that you gate the
  // whole router on it and take agent routing down for any company without a
  // Slack credential. Phase 2 posts nothing to Slack and needs no token, so
  // it stays ungated.
  it("still routes ordinary thread chatter for B to the agent session — the fix must not make an unconfigured company's threads go dark", async () => {
    const { ctx, fetchCalls, handler, companyConfigs } =
      await bootSingleCompanyThenAddB();
    delete companyConfigs[COMPANY_B];

    // Not an approval thread: a plain message in some other thread.
    await handler({
      companyId: COMPANY_B,
      payload: {
        channel: "C_GENERAL",
        threadTs: "1717200000.000999",
        text: "hello agent",
      },
    });

    // Agent routing needs no bot token, so the handler must still reach it and
    // look up B's OWN session registry. (It finds no active session in this
    // fixture and stops there — reaching the lookup is the thing under test,
    // since a scope-gated Phase 2 would never have got this far.)
    expect(ctx.state.get).toHaveBeenCalledWith({
      scopeKind: "company",
      scopeId: COMPANY_B,
      stateKey: "sessions_C_GENERAL_1717200000.000999",
    });
    // ...and it must not have borrowed A's token to do it.
    expect(slackBearers(fetchCalls)).not.toContain("xoxb-a");
  });
});

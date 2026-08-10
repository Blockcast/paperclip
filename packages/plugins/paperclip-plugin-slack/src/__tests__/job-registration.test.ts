import { describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import manifest from "../manifest.js";

// BLO-20959: setup() used to early-return (on a missing slackTokenRef) before
// reaching any `ctx.jobs.register(...)` call, so the scheduler was left with
// no handler for any Slack job — forever, since there is no onConfigChanged
// to replay setup(). Handlers must now register unconditionally, before the
// slackTokenRef check.
//
// Registration alone is not sufficient. The host always hands the worker an
// empty bootstrap config (`plugin-loader.ts`: "Workers receive an empty
// bootstrap config and must use ctx.config.get(companyId) at runtime"), so a
// handler that read a setup()-resolved module token would be registered but
// permanently inert. The tests below therefore also prove a registered handler
// does real work once the company's own config carries a resolvable token.
const MANIFEST_JOB_KEYS = manifest.jobs?.map((job) => job.jobKey) ?? [];

interface MkCtxOptions {
  /** Bootstrap config returned by `ctx.config.get()` with no companyId. */
  bootstrapConfig?: Record<string, unknown>;
  /** Per-company config returned by `ctx.config.get(companyId)`. */
  companyConfigs?: Record<string, Record<string, unknown>>;
  /** Companies `ctx.companies.list()` reports. */
  companies?: Array<{ id: string }>;
  /** Secret resolution behaviour, keyed by ref. */
  secrets?: Record<string, string | Error>;
  /** Initial plugin state, keyed as scopeKind:scopeId:stateKey. */
  state?: Record<string, unknown>;
}

const stateId = (key: {
  scopeKind: string;
  scopeId: string;
  stateKey: string;
}) => `${key.scopeKind}:${key.scopeId}:${key.stateKey}`;

const mkCtx = (options: MkCtxOptions = {}) => {
  const {
    bootstrapConfig = {},
    companyConfigs = {},
    companies = [],
    secrets = {},
    state = {},
  } = options;
  const storedState = new Map(Object.entries(state));
  const registeredJobs = new Map<string, (...args: unknown[]) => unknown>();
  const eventHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx: any = {
    config: {
      get: vi.fn(async (companyId?: string) =>
        companyId ? (companyConfigs[companyId] ?? {}) : bootstrapConfig,
      ),
    },
    secrets: {
      resolve: vi.fn(async (ref: string) => {
        const value = secrets[ref];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`no such secret: ${ref}`);
        return value;
      }),
    },
    companies: { list: vi.fn(async () => companies) },
    jobs: {
      register: vi.fn((jobKey: string, fn: (...args: unknown[]) => unknown) => {
        registeredJobs.set(jobKey, fn);
      }),
    },
    events: {
      on: vi.fn((eventType: string, fn: (...args: unknown[]) => unknown) => {
        eventHandlers.set(eventType, fn);
      }),
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
    agents: {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => ({ runId: "run-1" })),
    },
    http: {
      fetch: vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: true, ts: "123.456" }),
      })),
    },
    metrics: { write: vi.fn() },
    tools: { register: vi.fn() },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  return { ctx, registeredJobs, eventHandlers, storedState };
};

describe("worker setup() job registration (BLO-20959)", () => {
  it("declares at least the four scheduled jobs in manifest.ts", () => {
    expect(MANIFEST_JOB_KEYS).toEqual(
      expect.arrayContaining([
        "daily-digest",
        "check-escalation-timeouts",
        "check-watches",
        "commit-pending-approvals",
      ]),
    );
  });

  it("registers a handler for every manifest jobKey even when slackTokenRef is missing", async () => {
    const { ctx, registeredJobs } = mkCtx();

    await plugin.definition.setup(ctx);

    expect(ctx.config.get).toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No slackTokenRef configured"),
    );
    for (const jobKey of MANIFEST_JOB_KEYS) {
      expect(registeredJobs.has(jobKey)).toBe(true);
    }
  });

  // Ally review on PR #974: the previous fix left the jobs registered but
  // permanently no-op, because nothing on the startup path can ever populate a
  // module-level token. This is the test that would have caught it — start
  // with no credential, make one available on the company's own config row,
  // and prove the already-registered handler now does its work.
  it("a registered handler works once the company config carries a resolvable token", async () => {
    const companyConfigs: Record<string, Record<string, unknown>> = {};
    const { ctx, registeredJobs } = mkCtx({
      bootstrapConfig: {},
      companyConfigs,
      companies: [{ id: "company-1" }],
      secrets: { "slack-token-ref": "xoxb-real-token" },
    });

    await plugin.definition.setup(ctx);
    const watchesJob = registeredJobs.get("check-watches");
    expect(watchesJob).toBeTypeOf("function");

    // Before any config exists, the handler no-ops without touching state.
    await expect(watchesJob!()).resolves.toBeUndefined();
    expect(ctx.state.get).not.toHaveBeenCalled();

    // Operator configures the company. No restart, no onConfigChanged.
    companyConfigs["company-1"] = { slackTokenRef: "slack-token-ref" };

    await expect(watchesJob!()).resolves.toBeUndefined();
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("slack-token-ref", {
      companyId: "company-1",
    });
    // Proof of real work: the handler read this company's watch-event state,
    // which it only reaches after resolving a token.
    expect(ctx.state.get).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKind: "company",
        scopeId: "company-1",
        stateKey: "recent-watch-events",
      }),
    );
  });

  it("captures a watchable event on empty bootstrap and the scheduled job performs the watch action", async () => {
    const companyConfigs: Record<string, Record<string, unknown>> = {};
    const { ctx, registeredJobs, eventHandlers, storedState } = mkCtx({
      bootstrapConfig: {},
      companyConfigs,
      companies: [{ id: "company-1" }],
      secrets: { "slack-token-ref": "xoxb-real-token" },
      state: {
        "instance:global:global-watches-list": [
          {
            id: "watch-1",
            companyId: "company-1",
            eventPattern: "issue.created",
            prompt: "Investigate ${event.payload.title}",
            agentId: "agent-1",
            channelId: "C123",
            createdAt: "2026-08-04T00:00:00.000Z",
            triggerCount: 0,
          },
        ],
      },
    });

    await plugin.definition.setup(ctx);

    const issueCreated = eventHandlers.get("issue.created");
    expect(issueCreated).toBeTypeOf("function");
    await issueCreated!({
      eventType: "issue.created",
      companyId: "company-1",
      entityId: "issue-1",
      payload: { title: "broken relay" },
    });
    expect(
      storedState.get("company:company-1:recent-watch-events"),
    ).toEqual([
      {
        eventType: "issue.created",
        payload: { title: "broken relay" },
      },
    ]);

    // Company credentials become available without restarting the worker.
    companyConfigs["company-1"] = { slackTokenRef: "slack-token-ref" };
    await registeredJobs.get("check-watches")!();

    expect(ctx.agents.invoke).toHaveBeenCalledWith(
      "agent-1",
      "company-1",
      expect.objectContaining({
        prompt: "Investigate broken relay",
        reason: "Proactive watch trigger: issue.created",
      }),
    );
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      storedState.get("company:company-1:recent-watch-events"),
    ).toEqual([]);
  });

  it("skips only the unconfigured company and still serves a configured one", async () => {
    const { ctx, registeredJobs } = mkCtx({
      companyConfigs: {
        "company-ok": { slackTokenRef: "ref-ok" },
        // company-missing has no stored config at all
      },
      companies: [{ id: "company-missing" }, { id: "company-ok" }],
      secrets: { "ref-ok": "xoxb-ok" },
    });

    await plugin.definition.setup(ctx);
    await registeredJobs.get("check-watches")!();

    expect(ctx.state.get).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "company-ok" }),
    );
    expect(ctx.state.get).not.toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: "company-missing" }),
    );
  });

  it("a job whose company token cannot be resolved warns and no-ops instead of throwing", async () => {
    const { ctx, registeredJobs } = mkCtx({
      companyConfigs: { "company-1": { slackTokenRef: "broken-ref" } },
      companies: [{ id: "company-1" }],
      secrets: { "broken-ref": new Error("vault unavailable") },
    });

    await plugin.definition.setup(ctx);
    ctx.logger.warn.mockClear();

    const commitJob = registeredJobs.get("commit-pending-approvals");
    await expect(commitJob!()).resolves.toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resolve slackTokenRef"),
      expect.anything(),
    );
  });
});

// Ally review on PR #974: registering jobs above the credential gate does not
// help if setup() then rejects on the gate itself — the worker fails and takes
// the registrations with it.
describe("worker setup() credential-failure resilience (BLO-20959)", () => {
  it("completes with jobs registered when secrets.resolve rejects", async () => {
    const { ctx, registeredJobs } = mkCtx({
      bootstrapConfig: { slackTokenRef: "unavailable-ref" },
      secrets: { "unavailable-ref": new Error("secret backend down") },
    });

    await expect(plugin.definition.setup(ctx)).resolves.not.toThrow();

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not resolve slackTokenRef"),
      expect.anything(),
    );
    for (const jobKey of MANIFEST_JOB_KEYS) {
      expect(registeredJobs.has(jobKey)).toBe(true);
    }
  });
});

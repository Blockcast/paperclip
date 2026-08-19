import { describe, expect, it, vi } from "vitest";

import { createPenstockAvailabilityGate } from "../services/penstock-availability-gate.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

function gateWith(fetchImpl: typeof fetch) {
  log.info.mockClear();
  log.warn.mockClear();
  return createPenstockAvailabilityGate({
    fetchImpl,
    log,
    cacheTtlMs: 30_000,
    now: () => new Date("2026-06-30T08:00:00.000Z"),
  });
}

describe("createPenstockAvailabilityGate", () => {
  it("allows adapters that are not Penstock-backed claude_k8s", async () => {
    const fetchMock = vi.fn();
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_local",
      agentId: "agent-1",
      adapterConfig: { model: "claude-sonnet-4-6[1m]" },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: {
        ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
        ANTHROPIC_API_KEY: "psk_test",
      },
    });

    expect(result).toEqual({ allow: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a configured Penstock model when capacity readback reports a transient limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            state: "rate_limited",
            reason: "penstock.capacity_rate_limited",
            resume_at: "2026-06-30T08:05:00.000Z",
            retry_after_seconds: 5,
          }),
          { status: 200 },
        ),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: {
          ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" },
        },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 5,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.penstock.run/v1/pools/default/capacity?provider=anthropic&model=claude-sonnet-4-6%5B1m%5D",
    );
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).body).toBeUndefined();
  });

  it("defers on an authoritative unknown capacity readback without probing messages", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          provider: "anthropic",
          state: "unknown",
          reason: "penstock.capacity_no_healthy_route",
          routeCount: 0,
          healthyRouteCount: 0,
        }),
        { status: 200 },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_temporarily_unavailable",
      model: "claude-opus-4-8[1m]",
      retryAfterSeconds: 300,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.penstock.run/v1/pools/default/capacity?provider=anthropic&model=claude-opus-4-8%5B1m%5D",
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        capacityState: "unknown",
        capacityReason: "penstock.capacity_no_healthy_route",
      }),
      "heartbeat dispatch deferred: penstock model unavailable",
    );
  });

  it("caches the probe result per endpoint and model", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ state: "available" }), { status: 200 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);
    const input = {
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    };

    await gate.checkAdapter(input);
    await gate.checkAdapter({ ...input, agentId: "agent-2" });
    await gate.checkAdapter({
      ...input,
      agentId: "agent-3",
      adapterConfig: {
        ...input.adapterConfig,
        model: "claude-sonnet-4-6[1m]",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the legacy message probe when capacity readback is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "All subscriptions for provider 'anthropic' are rate-limited; capacity resets at 2026-06-30T08:05:00.000Z; retry in 5s",
          }),
          { status: 429, headers: { "retry-after": "5" } },
        ),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: {
          ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" },
        },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.penstock.run/v1/pools/default/capacity?provider=anthropic&model=claude-sonnet-4-6%5B1m%5D",
    );
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.penstock.run/anthropic/v1/messages");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      model: "claude-sonnet-4-6[1m]",
      max_tokens: 1,
    });
  });

  it("falls back and defers for provider-shaped Anthropic 429 without a capacity retry signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Error" },
            request_id: "req_011CcZYx",
          }),
          { status: 429 },
        ),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 300,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 429, model: "claude-sonnet-4-6[1m]" }),
      "heartbeat dispatch deferred: penstock model unavailable",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("defers for Penstock auth failures instead of launching doomed runs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-sonnet-4-6[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_temporarily_unavailable",
      model: "claude-sonnet-4-6[1m]",
      retryAfterSeconds: 300,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:05:00.000Z");
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, model: "claude-sonnet-4-6[1m]" }),
      "heartbeat dispatch deferred: penstock model unavailable",
    );
  });

  it("defers when Penstock reports temporary unavailability", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_temporarily_unavailable",
      model: "claude-opus-4-8[1m]",
      retryAfterSeconds: 300,
    });
    expect(log.info).toHaveBeenCalled();
  });

  it("fails open for unexpected non-capacity probe errors", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-1",
      adapterConfig: {
        model: "claude-opus-4-8[1m]",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });

    expect(result).toEqual({ allow: true });
    expect(log.warn).toHaveBeenCalled();
  });
  // BLO-27147: the gate was introduced for the 2026-06-30 Anthropic exhaustion
  // (BLO-12953) and guarded on `adapterType !== "claude_k8s"`, which made it a
  // structural no-op for every opencode_k8s/codex IC. These cover the widening.
  it("denies an opencode_k8s agent when the codex pool is rate limited", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          state: "rate_limited",
          reason: "penstock.capacity_rate_limited",
          resume_at: "2026-06-30T08:03:11.000Z",
          retry_after_seconds: 191,
        }),
        { status: 200 },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-ally",
      adapterConfig: {
        model: "gpt-5.6-sol",
        env: { OPENAI_BASE_URL: { value: "https://api.penstock.run/v1" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { OPENAI_API_KEY: "psk_test" },
    });

    expect(result).toMatchObject({
      allow: false,
      provider: "codex",
      reason: "penstock.model_capacity_unavailable",
      model: "gpt-5.6-sol",
      retryAfterSeconds: 191,
    });
    expect(result.allow === false ? result.resumeAt?.toISOString() : null).toBe("2026-06-30T08:03:11.000Z");
    // The provider query parameter must be codex, not the hardcoded anthropic.
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://api.penstock.run/v1/pools/default/capacity?provider=codex&model=gpt-5.6-sol",
    );
  });

  it("allows an opencode_k8s agent when the codex pool has capacity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ state: "available", reason: "penstock.capacity_available" }),
        { status: 200 },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-ally",
      adapterConfig: {
        model: "gpt-5.6-terra",
        env: { OPENAI_BASE_URL: { value: "https://api.penstock.run/v1" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { OPENAI_API_KEY: "psk_test" },
    });

    expect(result).toEqual({ allow: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails open for codex without attempting the Anthropic messages probe", async () => {
    // 404 makes the capacity readback inconclusive. For anthropic that falls
    // back to a /v1/messages probe; codex has no such probe, so it must fail
    // open after exactly one call rather than POST an Anthropic-shaped body
    // at an OpenAI endpoint.
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-ally",
      adapterConfig: {
        model: "gpt-5.6-sol",
        env: { OPENAI_BASE_URL: { value: "https://api.penstock.run/v1" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { OPENAI_API_KEY: "psk_test" },
    });

    expect(result).toEqual({ allow: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");
  });

  it("allows an opencode_k8s agent whose base URL is not Penstock-backed", async () => {
    const fetchMock = vi.fn();
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-ally",
      adapterConfig: {
        model: "gpt-5.6-sol",
        env: { OPENAI_BASE_URL: { value: "https://api.openai.com/v1" } },
      },
      now: new Date("2026-06-30T08:00:00.000Z"),
      env: { OPENAI_API_KEY: "psk_test" },
    });

    expect(result).toEqual({ allow: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keys the cache per provider so codex and anthropic do not collide", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ state: "available", reason: "penstock.capacity_available" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            state: "exhausted",
            reason: "penstock.capacity_exhausted",
            retry_after_seconds: 42,
          }),
          { status: 200 },
        ),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);
    const now = new Date("2026-06-30T08:00:00.000Z");

    const anthropic = await gate.checkAdapter({
      adapterType: "claude_k8s",
      agentId: "agent-cto",
      adapterConfig: {
        model: "shared-model",
        env: { ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/v1" } },
      },
      now,
      env: { ANTHROPIC_API_KEY: "psk_test" },
    });
    const codex = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-ally",
      adapterConfig: {
        model: "shared-model",
        env: { OPENAI_BASE_URL: { value: "https://api.penstock.run/v1" } },
      },
      now,
      env: { OPENAI_API_KEY: "psk_test" },
    });

    // Same origin, path and model: only the provider differs. A cache key that
    // omitted the provider would serve anthropic's allow to codex.
    expect(anthropic).toEqual({ allow: true });
    expect(codex).toMatchObject({ allow: false, provider: "codex" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the cache per credential so an exhausted agent is not released by a healthy one", async () => {
    // PEN-2385. Penstock answers per credential, so an `available` computed for
    // the reviewer's token says nothing about an author's token. Ordered
    // healthy-then-exhausted deliberately: this is the direction that *launches*
    // a doomed run rather than merely delaying a fine one.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ state: "available", reason: "penstock.capacity_available" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            state: "exhausted",
            reason: "penstock.capacity_exhausted",
            retry_after_seconds: 42,
          }),
          { status: 200 },
        ),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);
    const now = new Date("2026-06-30T08:00:00.000Z");

    function checkAs(agentId: string, token: string) {
      return gate.checkAdapter({
        adapterType: "claude_k8s",
        agentId,
        adapterConfig: {
          model: "claude-opus-5[1m]",
          env: {
            ANTHROPIC_BASE_URL: { value: "https://api.penstock.run/anthropic" },
            ANTHROPIC_AUTH_TOKEN: { value: token },
          },
        },
        now,
        env: {},
      });
    }

    const reviewer = await checkAs("agent-ally", "psk_reviewer");
    const author = await checkAs("agent-author", "psk_author");

    // Identical endpoint, provider and model; only the credential differs. A
    // key that omitted it would hand the reviewer's cached allow to the author
    // and dispatch a run that 429s before spending a token.
    expect(reviewer).toEqual({ allow: true });
    expect(author).toMatchObject({ allow: false, provider: "anthropic" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still serves one cached verdict to repeat checks on the same credential", async () => {
    // The credential dimension must not defeat caching itself: two agents
    // sharing a token (the common `process.env` fallback) stay on one probe.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ state: "available", reason: "penstock.capacity_available" }),
        { status: 200 },
      ),
    );
    const gate = gateWith(fetchMock as unknown as typeof fetch);
    const now = new Date("2026-06-30T08:00:00.000Z");

    for (const agentId of ["agent-one", "agent-two"]) {
      const result = await gate.checkAdapter({
        adapterType: "claude_k8s",
        agentId,
        adapterConfig: { model: "claude-opus-5[1m]" },
        now,
        env: {
          ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
          ANTHROPIC_API_KEY: "psk_shared",
        },
      });
      expect(result).toEqual({ allow: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

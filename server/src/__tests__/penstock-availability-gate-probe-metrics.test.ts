/**
 * Availability-gate probe instrumentation (BLO-29900).
 *
 * ## Fault injection, not absence of a storm
 *
 * The gate **fails open** on probe error, so a broken probe and a healthy one
 * produce the same dispatch decision. "No capacity storm today" therefore
 * proves nothing about either the fallback's rate or the counter's
 * correctness, and a counter that is silently mislabelled would read as a
 * measured 0% fallback share — an answer indistinguishable from the real thing
 * and pointing the opposite way.
 *
 * So every assertion here forces a specific branch and reads the series back.
 * The first two tests are a matched pair and are the load-bearing ones: the
 * same gate, the same config, differing only in whether the capacity endpoint
 * answers, must move *different* series. Either test alone can be satisfied by
 * a counter that hardcodes one `path` value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENSTOCK_AVAILABILITY_GATE_PROBE_DURATION_METRIC,
  PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
  recordPenstockAvailabilityGateProbe,
  renderMetrics,
} from "../services/metrics.js";
import { applyCcrotateCapacityDecision } from "../services/ccrotate-capacity-retry.js";
import { createPenstockAvailabilityGate } from "../services/penstock-availability-gate.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const MODEL = "claude-opus-5[1m]";

const log = { info: vi.fn(), warn: vi.fn() };

function gateWith(fetchImpl: typeof fetch, opts?: { cacheTtlMs?: number }) {
  log.info.mockClear();
  log.warn.mockClear();
  return createPenstockAvailabilityGate({
    fetchImpl,
    log,
    cacheTtlMs: opts?.cacheTtlMs ?? 30_000,
    now: () => NOW,
  });
}

function anthropicInput(overrides?: { model?: string }) {
  return {
    adapterType: "claude_k8s",
    agentId: "agent-29900",
    adapterConfig: { model: overrides?.model ?? MODEL },
    now: NOW,
    env: {
      ANTHROPIC_BASE_URL: "https://api.penstock.run/anthropic",
      ANTHROPIC_API_KEY: "psk_test_29900",
    },
  };
}

interface ProbeSeries {
  labels: Record<string, string | number>;
  value: number;
}

async function probeSeries(): Promise<ProbeSeries[]> {
  const metric = getMetricsRegistry().getSingleMetric(PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC);
  if (!metric) return [];
  const snapshot = (await metric.get()) as { values: ProbeSeries[] };
  return snapshot.values;
}

/**
 * Sum of series matching every supplied label. Returns 0 for "no such series",
 * so an assertion of 0 covers both "counted zero" and "never minted" — which is
 * the honest reading, since the counter is deliberately not pre-seeded.
 */
async function probeCount(match: Record<string, string>): Promise<number> {
  const series = await probeSeries();
  return series
    .filter((entry) => Object.entries(match).every(([key, value]) => entry.labels[key] === value))
    .reduce((total, entry) => total + entry.value, 0);
}

async function observedPaths(): Promise<string[]> {
  const series = await probeSeries();
  return [...new Set(series.map((entry) => String(entry.labels.path)))].sort();
}

function capacityAvailable(): Response {
  return new Response(JSON.stringify({ state: "available" }), { status: 200 });
}

describe("penstock availability gate probe instrumentation (BLO-29900)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("counts a conclusive capacity readback on path=capacity and mints no fallback series", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(capacityAvailable());
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    expect(await gate.checkAdapter(anthropicInput())).toEqual({ allow: true });

    // One GET, no POST: the cheap path answered, so nothing was spent against
    // the provider's inference API.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await probeCount({ path: "capacity", outcome: "ok" })).toBe(1);
    // The control half of the pair. If `path` were hardcoded or inverted, the
    // fallback series would exist here — it must not, because no fallback ran.
    expect(await observedPaths()).toEqual(["capacity"]);
  });

  it("attributes the forced fallback to path=messages_fallback, not to the capacity path", async () => {
    // Forces the `null` branch exactly as the ticket's verifying signal asks:
    // a 404 capacity endpoint, which is one of the four ways the readback
    // declines to answer.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "all subscriptions are rate-limited" }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      );
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter(anthropicInput());

    expect(result).toMatchObject({
      allow: false,
      provider: "anthropic",
      reason: "penstock.model_capacity_unavailable",
      probePath: "messages_fallback",
    });

    // The fallback really is a POST /v1/messages against the exhausted
    // provider. Asserted here so the test fails loudly if that call is ever
    // removed or changed, rather than the suppression silently landing
    // unmeasured.
    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[1]!;
    expect(String(fallbackUrl)).toBe("https://api.penstock.run/anthropic/v1/messages");
    expect((fallbackInit as RequestInit).method).toBe("POST");

    expect(await observedPaths()).toEqual(["capacity", "messages_fallback"]);
    // The capacity attempt is still counted — it is the denominator for
    // fallback share — but as `inconclusive`, which is the outcome that
    // *caused* the fallback.
    expect(await probeCount({ path: "capacity", outcome: "inconclusive" })).toBe(1);
    expect(await probeCount({ path: "messages_fallback", outcome: "deny_capacity" })).toBe(1);
    // The discriminating assertion: the 429 the fallback paid for must not be
    // booked against the cheap path. Mislabelling in that direction is what
    // would make a live fallback read as a measured 0%.
    expect(await probeCount({ path: "capacity", outcome: "deny_capacity" })).toBe(0);
  });

  it("separates a 429 denial by path so a parked row states which probe it paid for", async () => {
    const fromCapacity = await gateWith(
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ state: "exhausted", retry_after_seconds: 300 }), {
          status: 200,
        }),
      ) as unknown as typeof fetch,
    ).checkAdapter(anthropicInput());

    const fromFallback = await gateWith(
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 404 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "all subscriptions are rate-limited" }), {
            status: 429,
          }),
        ) as unknown as typeof fetch,
    ).checkAdapter(anthropicInput());

    // Same `reason` on both -- which is precisely why `reason` could not answer
    // "did this park cost a provider call?" and why `probePath` had to exist.
    expect(fromCapacity).toMatchObject({ reason: "penstock.model_capacity_unavailable" });
    expect(fromFallback).toMatchObject({ reason: "penstock.model_capacity_unavailable" });

    const capacityRow = applyCcrotateCapacityDecision(
      {},
      {
        retryAtIso: NOW.toISOString(),
        provider: "anthropic",
        model: MODEL,
        reason: fromCapacity.allow === false ? fromCapacity.reason : null,
        probePath: fromCapacity.allow === false ? fromCapacity.probePath : null,
        advertisedResumeAtIso: null,
        clampedFromIso: null,
        firstDeferredAtIso: NOW.toISOString(),
      },
    );
    const fallbackRow = applyCcrotateCapacityDecision(
      {},
      {
        retryAtIso: NOW.toISOString(),
        provider: "anthropic",
        model: MODEL,
        reason: fromFallback.allow === false ? fromFallback.reason : null,
        probePath: fromFallback.allow === false ? fromFallback.probePath : null,
        advertisedResumeAtIso: null,
        clampedFromIso: null,
        firstDeferredAtIso: NOW.toISOString(),
      },
    );

    expect(capacityRow.penstockProbePath).toBe("capacity");
    expect(fallbackRow.penstockProbePath).toBe("messages_fallback");
    expect(capacityRow.penstockReason).toBe(fallbackRow.penstockReason);
    // Two rows denied by different paths carry different persisted values --
    // the acceptance criterion, read off the persisted shape rather than off
    // the in-memory result.
    expect(capacityRow.penstockProbePath).not.toBe(fallbackRow.penstockProbePath);
  });

  it("clears a stale probe path when a re-defer lands on the other probe", async () => {
    const redeferred = applyCcrotateCapacityDecision(
      { penstockProbePath: "messages_fallback", penstockReason: "penstock.model_capacity_unavailable" },
      {
        retryAtIso: NOW.toISOString(),
        provider: "anthropic",
        model: MODEL,
        reason: "penstock.model_capacity_unavailable",
        probePath: "capacity",
        advertisedResumeAtIso: null,
        clampedFromIso: null,
        firstDeferredAtIso: NOW.toISOString(),
      },
    );

    // A lingering value would assert a provider-inference cost this park never
    // paid, which is worse than no value at all.
    expect(redeferred.penstockProbePath).toBe("capacity");
  });

  it("does not count a verdict-cache hit, so fallback share stays a ratio over real probes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(capacityAvailable());
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    await gate.checkAdapter(anthropicInput());
    await gate.checkAdapter(anthropicInput());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Counting the cache hit would understate fallback share by exactly the
    // cache hit rate, by inflating only the denominator.
    expect(await probeCount({ path: "capacity" })).toBe(1);
  });

  it("distinguishes a failed-open probe from a healthy one", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("ETIMEDOUT"));
    // codex has no messages fallback, so this isolates the capacity probe's
    // error branch with nothing downstream to mask it.
    const gate = gateWith(fetchMock as unknown as typeof fetch);

    const result = await gate.checkAdapter({
      adapterType: "opencode_k8s",
      agentId: "agent-29900",
      adapterConfig: { model: "gpt-5-codex" },
      now: NOW,
      env: {
        OPENAI_BASE_URL: "https://api.penstock.run/openai",
        OPENAI_API_KEY: "psk_test_29900",
      },
    });

    // Fails open: identical dispatch decision to a healthy probe. `outcome` is
    // the only place the difference is visible at all.
    expect(result).toEqual({ allow: true });
    expect(await probeCount({ path: "capacity", outcome: "error", provider: "codex" })).toBe(1);
    expect(await probeCount({ path: "capacity", outcome: "ok" })).toBe(0);
    // No fallback exists for codex and nothing was sent, so it must not appear
    // in the denominator.
    expect(await observedPaths()).toEqual(["capacity"]);
  });

  it("exposes both series on /metrics with the labels the acceptance criteria query", async () => {
    recordPenstockAvailabilityGateProbe({
      path: "capacity",
      outcome: "inconclusive",
      provider: "anthropic",
      model: MODEL,
      durationSeconds: 0.04,
    });
    recordPenstockAvailabilityGateProbe({
      path: "messages_fallback",
      outcome: "deny_capacity",
      provider: "anthropic",
      model: MODEL,
      durationSeconds: 0.9,
    });

    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(`${PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC}\\{[^\\n]*path="capacity"`),
    );
    expect(body).toMatch(
      new RegExp(`${PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC}\\{[^\\n]*path="messages_fallback"`),
    );
    expect(body).toMatch(
      new RegExp(`${PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC}\\{[^\\n]*model="${MODEL.replace(/[[\]]/g, "\\$&")}"`),
    );
    expect(body).toContain(PENSTOCK_AVAILABILITY_GATE_PROBE_DURATION_METRIC);
  });

  it("collapses an unrecognised path or outcome to the pessimistic label", () => {
    // Deliberately not "messages_fallback": a labelling mistake must not be
    // able to manufacture evidence that the expensive probe is hot.
    const labels = recordPenstockAvailabilityGateProbe({
      path: "something_new",
      outcome: "surprising",
      provider: null,
      model: "   ",
    });

    expect(labels).toEqual({
      path: "capacity",
      outcome: "error",
      provider: "unknown",
      model: "unknown",
    });
  });
});

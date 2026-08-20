// BLO-18278 — a provider 429 that advertises WHEN capacity returns must be
// waited out, not retried into and then stranded.
//
// `heartbeat-hintless-transient-upstream.test.ts` (BLO-18285, PR #859) covers
// the sibling case: a gateway 503 carrying nothing to honor. This file covers
// the hint-PRESENT case. Live proof it stranded is run
// 9727eaf0-9cea-461d-9101-f833f8de29fe:
//
//   API Error: Request rejected (429) · BYOS provider capacity for 'anthropic'
//   is temporarily unavailable; capacity may reset at 2026-07-26T21:29:59.782Z;
//   retry in 9571s
//
// The critical detail — and the reason a test that seeds a structured
// `retryNotBefore` would pass on master and prove nothing — is that on the k8s
// adapters the horizon arrives ONLY as that prose. claude-local/codex-local
// parse it adapter-side and hand back a structured `retryNotBefore`, but the
// shipped claude_k8s / opencode_k8s bundles under
// /opt/paperclip-bundled-adapters contain no occurrence of `retryNotBefore`,
// `capacity may reset`, `resume_at` or `retry_after` at all. So the test
// adapters below deliberately emit the message and NOTHING else, exactly as
// claude_k8s does. On master that horizon is dropped, `retryNotBefore`
// persists null, and the run takes the rate-limit family's flat 90s hop —
// ~18x short of the 9571s asked for.
//
// The end-to-end cases drive REAL heartbeat finalization through a registered
// test adapter rather than re-implementing the override chain, so they cannot
// drift from production.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import {
  RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
  heartbeatService,
  isHintlessTransientUpstreamFault,
  isRateLimitExhausted,
  parseProviderCapacityResetHorizon,
  resolveProviderCapacityHorizon,
} from "../services/heartbeat.js";
import { PROVIDER_CAPACITY_MAX_HORIZON_MS } from "../services/provider-capacity-horizon-bound.js";
import {
  CCROTATE_CAPACITY_MAX_PARK_MS,
  CCROTATE_CAPACITY_PARK_JITTER_RATIO,
} from "../services/ccrotate-capacity-retry.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

// The horizon BLO-18278's run was handed, to the second.
const ADVERTISED_RESET_SECONDS = 9571;

const BLO_18278_ERROR_MESSAGE = (resetIso: string) =>
  `API Error: Request rejected (429) · BYOS provider capacity for 'anthropic' is temporarily ` +
  `unavailable; capacity may reset at ${resetIso}; retry in ${ADVERTISED_RESET_SECONDS}s`;

// What the SDK's final event carries for this fault. `api_error_status` 429 is
// the surface isRateLimitExhausted keys on.
const BLO_18278_RESULT_JSON = { api_error_status: 429 } as const;
const PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE = "server_parse_provider_capacity_horizon";

// BLO-18285: the horizon production actually emitted, from run b48c8b30 on this
// very issue — 319565s = 88.8h, 3.7x the 24h cap. The cap was calibrated on the
// single ~2h40m sample BLO-18278 observed, so the first longer real window fell
// straight through it.
const OVER_CAP_RETRY_SECONDS = 319565;
// The literal instant run b48c8b30 was handed. Only ever used with that run's
// own clock passed in explicitly — it is in the past now, so a suite that
// replayed it against the live clock would resolve `none` (already elapsed) and
// quietly assert nothing. The e2e adapters below build the same message shape
// around a live-clock instant instead.
const BLO_18285_OVER_CAP_RESET_ISO = "2026-08-06T21:59:59.671Z";
const BLO_18285_OVER_CAP_RUN_STARTED_AT = Date.parse("2026-08-03T05:13:56.000Z");
const BLO_18285_OVER_CAP_MESSAGE = (resetIso: string) =>
  `API Error: Request rejected (429) · BYOS provider capacity for 'anthropic' is temporarily ` +
  `unavailable; capacity may reset at ${resetIso}; retry in ${OVER_CAP_RETRY_SECONDS}s`;
const BLO_18285_OVER_CAP_ERROR_MESSAGE = BLO_18285_OVER_CAP_MESSAGE(BLO_18285_OVER_CAP_RESET_ISO);

describe("parseProviderCapacityResetHorizon", () => {
  const now = Date.parse("2026-07-26T18:50:31.000Z");
  const resetIso = "2026-07-26T21:29:59.782Z";

  it("recovers the absolute horizon from the BLO-18278 message", () => {
    expect(
      parseProviderCapacityResetHorizon({ errorMessage: BLO_18278_ERROR_MESSAGE(resetIso) }, now)?.toISOString(),
    ).toBe(resetIso);
  });

  // BLO-18278 settled which fields this PARSER reads, and BLO-24490 deliberately
  // left that intact: all four still yield the instant. Parsing and parking are
  // different questions. What a model-authored reading now earns is decided at
  // the call site — it needs an observed 429, exactly as the over-cap and
  // structured paths do — so this assertion is about text, not disposition. Do
  // not read it as "prose alone can park a run"; see the resolver's
  // `machineAuthored` cases below and the e2e pair at the bottom of this file.
  it("reads the horizon from resultJson text fields too", () => {
    for (const key of ["result", "message", "error", "summary"] as const) {
      expect(
        parseProviderCapacityResetHorizon({ resultJson: { [key]: BLO_18278_ERROR_MESSAGE(resetIso) } }, now)
          ?.toISOString(),
      ).toBe(resetIso);
    }
  });

  it("falls back to the relative `retry in Ns` form when no absolute instant is given", () => {
    const parsed = parseProviderCapacityResetHorizon(
      { errorMessage: "provider capacity unavailable; retry in 9571s" },
      now,
    );
    expect(parsed?.getTime()).toBe(now + ADVERTISED_RESET_SECONDS * 1000);
  });

  it("prefers the absolute instant over the relative one when both are present", () => {
    // Emission-time skew makes "retry in Ns" drift; the timestamp does not.
    const staleRelative = `capacity may reset at ${resetIso}; retry in 30s`;
    expect(parseProviderCapacityResetHorizon({ errorMessage: staleRelative }, now)?.toISOString()).toBe(resetIso);
  });

  it("ignores a horizon that has already elapsed", () => {
    expect(
      parseProviderCapacityResetHorizon(
        { errorMessage: "capacity may reset at 2020-01-01T00:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("refuses to park verbatim on an absurd horizon", () => {
    expect(
      parseProviderCapacityResetHorizon({ errorMessage: "capacity may reset at 2031-01-01T00:00:00.000Z" }, now),
    ).toBeNull();
    expect(parseProviderCapacityResetHorizon({ errorMessage: "retry in 999999s" }, now)).toBeNull();
  });

  it("returns null for unrelated failures", () => {
    expect(parseProviderCapacityResetHorizon({ errorMessage: "TypeError: x is not a function" }, now)).toBeNull();
    expect(parseProviderCapacityResetHorizon({ resultJson: null, errorMessage: null }, now)).toBeNull();
  });
});

// BLO-18285. `parseProviderCapacityResetHorizon` answers one question — "may we
// park on this instant verbatim?" — and its `null` therefore says nothing about
// whether a horizon was advertised at all. Callers that route the fault need
// that distinction, because discarding an over-cap horizon drops the run onto
// the flat 90s curve that strands it.
describe("resolveProviderCapacityHorizon separates silence from an over-cap advertisement", () => {
  const now = Date.parse("2026-07-26T18:50:31.000Z");
  const CAP_MS = PROVIDER_CAPACITY_MAX_HORIZON_MS;

  it("reports a within-cap horizon as usable", () => {
    const resetIso = new Date(now + ADVERTISED_RESET_SECONDS * 1000).toISOString();
    const resolved = resolveProviderCapacityHorizon({ errorMessage: BLO_18278_ERROR_MESSAGE(resetIso) }, now);
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(resetIso);
  });

  it("reports genuine silence as none", () => {
    expect(resolveProviderCapacityHorizon({ errorMessage: "TypeError: x is not a function" }, now).kind).toBe("none");
    expect(resolveProviderCapacityHorizon({ resultJson: null, errorMessage: null }, now).kind).toBe("none");
  });

  // The exact payload from run b48c8b30 on BLO-18285, replayed at that run's
  // own clock: 88.8h out, 3.7x the cap. The message states the window twice —
  // `capacity may reset at 2026-08-06T21:59:59.671Z` and `retry in 319565s`,
  // which agree to 1.3s — and the absolute form is authoritative, so that is
  // the instant reported as advertised. On master this whole reading was
  // indistinguishable from the `none` case above, which is what put it on the
  // 90s curve.
  it("reports the 88.8h b48c8b30 advertisement as over_horizon, parked at the cap", () => {
    const runStartedAt = BLO_18285_OVER_CAP_RUN_STARTED_AT;
    const resolved = resolveProviderCapacityHorizon(
      { errorMessage: BLO_18285_OVER_CAP_ERROR_MESSAGE },
      runStartedAt,
    );
    expect(resolved.kind).toBe("over_horizon");
    if (resolved.kind !== "over_horizon") throw new Error("unreachable");
    expect(resolved.advertisedAt.toISOString()).toBe(BLO_18285_OVER_CAP_RESET_ISO);
    expect(resolved.parkAt.getTime()).toBe(runStartedAt + CAP_MS);

    // The park is far shorter than what was asked for — that is the point. We
    // bound the blast radius of a figure we do not trust, while still never
    // returning inside a window this long the way the 90s curve did.
    expect(resolved.advertisedAt.getTime() - runStartedAt).toBeGreaterThan(CAP_MS * 3);
    expect(resolved.parkAt.getTime()).toBeLessThan(resolved.advertisedAt.getTime());
  });

  it("treats an over-cap absolute timestamp the same way", () => {
    const resolved = resolveProviderCapacityHorizon(
      { errorMessage: "capacity may reset at 2031-01-01T00:00:00.000Z" },
      now,
    );
    expect(resolved.kind).toBe("over_horizon");
    expect(resolved.kind === "over_horizon" && resolved.parkAt.getTime()).toBe(now + CAP_MS);
  });

  // An elapsed horizon describes a window that has already reopened, so there
  // is nothing to wait for — it must stay `none` and take the normal curve
  // rather than being parked for 24h.
  it("keeps an already-elapsed horizon as none, not over_horizon", () => {
    expect(
      resolveProviderCapacityHorizon({ errorMessage: "capacity may reset at 2020-01-01T00:00:00.000Z" }, now).kind,
    ).toBe("none");
  });

  // Ordering guard: a usable horizon anywhere in the candidate set beats an
  // over-cap reading seen earlier, so the remembered over_horizon can never
  // shadow a value we could have parked on exactly.
  it("prefers a usable horizon over an over-cap one seen first", () => {
    const usableIso = new Date(now + 60_000).toISOString();
    const resolved = resolveProviderCapacityHorizon(
      {
        errorMessage: BLO_18285_OVER_CAP_ERROR_MESSAGE,
        resultJson: { result: `capacity may reset at ${usableIso}` },
      },
      now,
    );
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(usableIso);
  });

  // BLO-18285 review follow-up: model prose may not drive the 24h park.
  //
  // `resultJson.result` and `resultJson.summary` are the agent's own text
  // (claude-local assigns the SDK final-result event verbatim), which is why the
  // hint-less classifier's TRANSIENT_UPSTREAM_TEXT_KEYS already excludes them.
  // The over-cap park is the stronger claim of the two — it sidelines an issue
  // for a full day on a figure we have explicitly decided not to trust — so
  // prose that merely *quotes* some unrelated far-future reset must not reach
  // it. Before this, an agent writing "the gateway said capacity resets
  // 2031-01-01" into its own summary was enough.
  it("refuses to park on an over-cap horizon that only model prose stated", () => {
    for (const key of ["result", "summary"] as const) {
      const resolved = resolveProviderCapacityHorizon(
        { resultJson: { [key]: "capacity may reset at 2031-01-01T00:00:00.000Z" } },
        now,
      );
      expect(resolved.kind).toBe("none");
    }
    // Same for the relative form.
    expect(
      resolveProviderCapacityHorizon({ resultJson: { result: "retry in 319565s" } }, now).kind,
    ).toBe("none");
  });

  // The machine-authored surfaces still reach it — otherwise the fix would have
  // disabled the disposition rather than bounded it. This is the control for the
  // case above: same payload shape, trusted field, opposite outcome.
  it("still parks on an over-cap horizon from a machine-authored field", () => {
    for (const key of ["message", "error"] as const) {
      const resolved = resolveProviderCapacityHorizon(
        { resultJson: { [key]: "capacity may reset at 2031-01-01T00:00:00.000Z" } },
        now,
      );
      expect(resolved.kind).toBe("over_horizon");
      expect(resolved.kind === "over_horizon" && resolved.parkAt.getTime()).toBe(now + CAP_MS);
    }
  });

  // BLO-24490: the resolver still READS a within-cap horizon out of model prose
  // — `result` is dual-provenance, carrying the SDK's API-error text whenever
  // `is_error` is true (see claude-local/src/server/parse.test.ts:482), so
  // dropping it would lose genuine capacity payloads on any adapter that funnels
  // the fault there. What changed is that it now says WHO wrote it, and the call
  // site makes an untrusted reading earn an observed 429.
  it("still reads a within-cap horizon from model prose, flagged as model-authored", () => {
    const usableIso = new Date(now + 60_000).toISOString();
    for (const key of ["result", "summary"] as const) {
      const resolved = resolveProviderCapacityHorizon(
        { resultJson: { [key]: `capacity may reset at ${usableIso}` } },
        now,
      );
      expect(resolved.kind).toBe("usable");
      expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(usableIso);
      expect(resolved.kind === "usable" && resolved.machineAuthored).toBe(false);
    }
  });

  it("flags a within-cap horizon from a machine-authored field as machine-authored", () => {
    const usableIso = new Date(now + 60_000).toISOString();
    for (const input of [
      { errorMessage: `capacity may reset at ${usableIso}` },
      { resultJson: { message: `capacity may reset at ${usableIso}` } },
      { resultJson: { error: `capacity may reset at ${usableIso}` } },
    ]) {
      const resolved = resolveProviderCapacityHorizon(input, now);
      expect(resolved.kind).toBe("usable");
      expect(resolved.kind === "usable" && resolved.machineAuthored).toBe(true);
    }
  });

  // Candidate order is errorMessage → result → message → error → summary, so
  // `result` is reached before the machine-authored resultJson fields. Returning
  // on the first usable hit would report the model's instant and then make it
  // earn a 429 the machine-authored one beside it never needed. The genuine
  // horizon must win outright, not lose a race to iteration order.
  it("prefers a machine-authored horizon over model prose seen first", () => {
    const proseIso = new Date(now + 23 * 60 * 60 * 1000).toISOString();
    const genuineIso = new Date(now + 60_000).toISOString();
    const resolved = resolveProviderCapacityHorizon(
      {
        resultJson: {
          result: `capacity may reset at ${proseIso}`,
          message: `capacity may reset at ${genuineIso}`,
        },
      },
      now,
    );
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(genuineIso);
    expect(resolved.kind === "usable" && resolved.machineAuthored).toBe(true);
  });

  // A usable reading of either provenance still outranks an over-cap one, as it
  // did before BLO-24490 — the model-authored case is deferred, not demoted.
  it("keeps a model-authored usable horizon ahead of a machine-authored over-cap one", () => {
    const usableIso = new Date(now + 60_000).toISOString();
    const resolved = resolveProviderCapacityHorizon(
      {
        resultJson: {
          result: `capacity may reset at ${usableIso}`,
          message: "capacity may reset at 2031-01-01T00:00:00.000Z",
        },
      },
      now,
    );
    expect(resolved.kind).toBe("usable");
    expect(resolved.kind === "usable" && resolved.at.toISOString()).toBe(usableIso);
    expect(resolved.kind === "usable" && resolved.machineAuthored).toBe(false);
  });
});

describe("provider 429 classification (hint-present variant)", () => {
  const resetIso = new Date(Date.now() + ADVERTISED_RESET_SECONDS * 1000).toISOString();

  it("matches the BLO-18278 capacity-429 payload", () => {
    expect(isRateLimitExhausted({ ...BLO_18278_RESULT_JSON })).toBe(true);
  });

  // The mirror of the disjointness assertion in the hint-less file. Together
  // they pin the boundary from both sides: a 429 is never claimed by the
  // hint-less 503 classifier, so it keeps its own family and its own curve, and
  // the hint is what carries it past that curve.
  it("is not claimed by the hint-less transient-upstream classifier", () => {
    expect(isHintlessTransientUpstreamFault({ ...BLO_18278_RESULT_JSON })).toBe(false);
    expect(
      isHintlessTransientUpstreamFault({ ...BLO_18278_RESULT_JSON }, {
        errorMessage: BLO_18278_ERROR_MESSAGE(resetIso),
      }),
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * BLO-28919: a capacity floor must land inside the capacity ceiling regardless
 * of which surface advertised it. The park is computed at finalization, so it is
 * measured from the run's own `startedAt` where available (falling back to now,
 * which only ever makes this assertion stricter), plus jitter and a slack
 * allowance for the run's own execution time.
 */
function expectWithinCapacityCeiling(parkedIso: string, startedAt: Date | null) {
  const originMs = startedAt ? startedAt.getTime() : Date.now();
  const parkMs = new Date(parkedIso).getTime() - originMs;
  const ceiling =
    CCROTATE_CAPACITY_MAX_PARK_MS * (1 + CCROTATE_CAPACITY_PARK_JITTER_RATIO) + 60_000;
  expect(
    parkMs,
    `a capacity floor must park within the ${CCROTATE_CAPACITY_MAX_PARK_MS / 60_000}m capacity ` +
      `ceiling (+jitter), not the 24h generic backstop; got ${(parkMs / 60_000).toFixed(1)}m`,
  ).toBeLessThanOrEqual(ceiling);
  expect(parkMs).toBeGreaterThan(0);
}
const HINTED_429_TEST_ADAPTER = "provider_capacity_horizon_test";
const UNHINTED_429_TEST_ADAPTER = "provider_capacity_horizon_control_test";
const STRUCTURED_429_TEST_ADAPTER = "provider_capacity_horizon_structured_test";
const OVER_CAP_429_TEST_ADAPTER = "provider_capacity_horizon_over_cap_test";
const PROSE_OVER_CAP_429_TEST_ADAPTER = "provider_capacity_horizon_prose_over_cap_test";
const NON_429_OVER_CAP_TEST_ADAPTER = "provider_capacity_horizon_non_429_over_cap_test";
// BLO-24490: the within-cap counterparts. `usable` was the half #1142 left
// ungated, and it is reachable end-to-end from model prose ALONE — no provider
// status anywhere in the payload. isRateLimitExhausted's path 3 scans
// `result`/`summary` for cap text, so the same sentence both classifies the run
// as throttled and supplies the horizon.
const PROSE_USABLE_NO_429_TEST_ADAPTER = "provider_capacity_horizon_prose_usable_no_429_test";
const PROSE_USABLE_WITH_429_TEST_ADAPTER = "provider_capacity_horizon_prose_usable_with_429_test";
// Within the 24h cap, so it never reaches the over-cap path — but still nearly a
// full day of sidelining, which is the harm this issue is about.
const PROSE_USABLE_HORIZON_MS = 23 * 60 * 60 * 1000;
const PROSE_USABLE_MESSAGE = (resetIso: string) =>
  `I hit my usage limit partway through. The gateway earlier said capacity may reset at ${resetIso}, ` +
  `so I stopped rather than retry.`;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-capacity-horizon tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("provider 429 advertising a capacity reset honors that horizon", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Fixed for the lifetime of the suite so the adapter closure and the
  // assertions agree on the exact instant.
  const advertisedResetAt = new Date(Date.now() + ADVERTISED_RESET_SECONDS * 1000);
  const advertisedResetIso = advertisedResetAt.toISOString();

  // BLO-18285: the same fault shape, but advertising 88.8h — past the 24h cap.
  // Built off the live clock rather than replaying b48c8b30's literal instant,
  // which is now in the past and would resolve as an elapsed horizon.
  const overCapAdvertisedAt = new Date(Date.now() + OVER_CAP_RETRY_SECONDS * 1000);
  const overCapAdvertisedIso = overCapAdvertisedAt.toISOString();

  // BLO-24490: within the cap, so `resolveProviderCapacityHorizon` reports it
  // `usable` and the over-cap gate never sees it — yet it sidelines the issue
  // for 23h all the same.
  const proseUsableAt = new Date(Date.now() + PROSE_USABLE_HORIZON_MS);
  const proseUsableIso = proseUsableAt.toISOString();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-capacity-horizon-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    const testEnvironment = (type: string) => async () => ({
      adapterType: type,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });

    // Exactly what claude_k8s hands finalization: the 429 status surface and
    // the prose horizon, and NO structured `retryNotBefore` — because the
    // shipped k8s adapter bundle has no code that could produce one. This is
    // what makes the test fail on master.
    registerServerAdapter({
      type: HINTED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18278_ERROR_MESSAGE(advertisedResetIso),
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(HINTED_429_TEST_ADAPTER),
    });

    // Control: the same 429 with the capacity horizon stripped from the server
    // parse surfaces — the shape we get when the provider rejects without
    // advertising a reset. It deliberately tries to smuggle persisted reset
    // fields through adapter-owned resultJson; finalization must strip them.
    registerServerAdapter({
      type: UNHINTED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "API Error: Request rejected (429) · provider capacity temporarily unavailable",
        resultJson: {
          ...BLO_18278_RESULT_JSON,
          providerCapacityResetAt: advertisedResetIso,
          providerCapacityResetProvenance: {
            source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
            errorFamily: "rate_limit_exhausted",
            observedStatusCode: 429,
          },
        } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(UNHINTED_429_TEST_ADAPTER),
    });

    // The structured counterpart: claude-local/codex-local parse the horizon
    // adapter-side and hand back `retryNotBefore`, which makes the server's
    // prose parser skip this result entirely. Before the follow-up fix that
    // meant such a run reached recovery with NO provenance at all and was
    // forced into the generic rate-limit/quota wording — discarding a 429 we
    // can substantiate from `api_error_status` sitting right beside the hint.
    registerServerAdapter({
      type: STRUCTURED_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        // No prose horizon anywhere — the parser must not be what rescues this.
        errorMessage: "API Error: Request rejected (429) · provider capacity temporarily unavailable",
        retryNotBefore: advertisedResetIso,
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(STRUCTURED_429_TEST_ADAPTER),
    });

    // BLO-18285: identical to HINTED, except the advertised window is 88.8h —
    // past the cap. Same prose shape, same 429 surface, no structured hint.
    registerServerAdapter({
      type: OVER_CAP_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18285_OVER_CAP_MESSAGE(overCapAdvertisedIso),
        resultJson: { ...BLO_18278_RESULT_JSON } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(OVER_CAP_429_TEST_ADAPTER),
    });

    // BLO-18285 review follow-up: a GENUINE structured 429 whose only far-future
    // reset sits in model-authored prose. `errorMessage` states the 429 and no
    // horizon; `result` is the agent's own summary, which merely quotes one.
    // Both of the over-cap gate's inputs are individually satisfied — a real 429
    // and a parseable over-cap instant — so before the candidate narrowing this
    // parked the issue for 24h on the strength of text the model wrote.
    registerServerAdapter({
      type: PROSE_OVER_CAP_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "API Error: Request rejected (429) · provider capacity temporarily unavailable",
        resultJson: {
          ...BLO_18278_RESULT_JSON,
          result:
            `I hit a throttle. Earlier the gateway mentioned capacity may reset at ` +
            `${overCapAdvertisedIso}, so I stopped here.`,
        } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(PROSE_OVER_CAP_429_TEST_ADAPTER),
    });

    // BLO-18285 review follow-up: the negative counterpart for the 429 gate
    // itself. The over-cap instant here is machine-authored and trusted, but the
    // structured status is 401, not 429 — a credential/cap-window rejection that
    // the throttle families also cover. The 24h park is reserved for a capacity
    // 429 we can substantiate, so this must keep the ordinary schedule. Pins the
    // conservative side of the gate against being widened by accident.
    registerServerAdapter({
      type: NON_429_OVER_CAP_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: BLO_18285_OVER_CAP_MESSAGE(overCapAdvertisedIso),
        resultJson: { api_error_status: 401 } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(NON_429_OVER_CAP_TEST_ADAPTER),
    });

    // BLO-24490: the whole failure mode, with NO provider signal of any kind.
    // One sentence of the agent's own summary does both jobs — "usage limit"
    // trips isRateLimitExhausted's path-3 text scan so the run classifies as
    // throttled, and "capacity may reset at <23h>" then supplies the horizon.
    // There is no `api_error_status`, no `error_status`, no 429 in
    // `errorMessage`: nothing here came from the provider. This must take the
    // ordinary flat hop.
    registerServerAdapter({
      type: PROSE_USABLE_NO_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: { result: PROSE_USABLE_MESSAGE(proseUsableIso) } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(PROSE_USABLE_NO_429_TEST_ADAPTER),
    });

    // The control for the case above, and the reason this is corroboration
    // rather than a ban on prose: identical text, plus a 429 the server actually
    // observed. `result` is dual-provenance — it carries the SDK's own API-error
    // text when `is_error` is true — so a genuine capacity payload that lands
    // only there must still park, or the fix would have re-opened BLO-18278 on
    // the adapters this server-side parser exists to cover.
    registerServerAdapter({
      type: PROSE_USABLE_WITH_429_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: {
          ...BLO_18278_RESULT_JSON,
          result: PROSE_USABLE_MESSAGE(proseUsableIso),
        } as Record<string, unknown>,
      }),
      testEnvironment: testEnvironment(PROSE_USABLE_WITH_429_TEST_ADAPTER),
    });
  }, 120_000);

  afterAll(async () => {
    unregisterServerAdapter(HINTED_429_TEST_ADAPTER);
    unregisterServerAdapter(UNHINTED_429_TEST_ADAPTER);
    unregisterServerAdapter(STRUCTURED_429_TEST_ADAPTER);
    unregisterServerAdapter(OVER_CAP_429_TEST_ADAPTER);
    unregisterServerAdapter(PROSE_OVER_CAP_429_TEST_ADAPTER);
    unregisterServerAdapter(NON_429_OVER_CAP_TEST_ADAPTER);
    unregisterServerAdapter(PROSE_USABLE_NO_429_TEST_ADAPTER);
    unregisterServerAdapter(PROSE_USABLE_WITH_429_TEST_ADAPTER);
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "provider capacity horizon cleanup",
      drainTimeoutMs: 30_000,
    });
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Capacity429 ${agentId.slice(0, 8)}`,
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  function countRetriesOf(runId: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows.length);
  }

  function retryRowOf(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("schedules the continuation at the advertised reset, not the flat 90s hop", async () => {
    const { agentId } = await seedAgent(HINTED_429_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");
    // BLO-28919 supersedes the original assertion here. The horizon is still
    // recovered from prose and still persisted on both scheduler surfaces — but
    // `retryNotBefore` is a retry FLOOR, so it now carries the capacity-clamped
    // instant rather than the advertised one. Parking verbatim on a 4.6h
    // advertisement is what put 484 of 700 fleet parks at p50 4.6h under
    // `transient_failure` while correctly-gated capacity parks sat at 17.9m.
    // The advertised value is not lost: it moves to
    // `penstockCapacityParkClampedFrom`, and provenance keeps it below.
    const clampedIso = resultJson?.retryNotBefore as string | undefined;
    expect(clampedIso).toBeTruthy();
    expect(clampedIso).not.toBe(advertisedResetIso);
    expect(resultJson?.transientRetryNotBefore).toBe(clampedIso);
    expect(resultJson?.penstockCapacityParkClampedFrom).toBe(advertisedResetIso);
    expectWithinCapacityCeiling(clampedIso!, failedRun?.startedAt ?? null);
    // Provenance is unchanged and still records what the provider actually
    // advertised — that is its job, and it is now the only surface that does.
    expect(resultJson?.providerCapacityResetAt).toBe(advertisedResetIso);
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "server_prose_parse",
    });

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);

    // `scheduled_retry` is the explicit waiting posture the AC asks for, and is
    // one of the statuses hasActiveExecutionPath treats as "still alive" —
    // which is what keeps the strand sweep from escalating this issue to
    // `stranded_assigned_issue`. The run never reaches BackoffLimitExceeded.
    // This is the property BLO-18278 cared about and it is preserved: the park
    // got shorter, it did not become a strand.
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAttempt).toBe(1);

    // `dueAt` tracks the clamped floor, which is what the scheduler now reads.
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(clampedIso);

    // ...and it is still materially beyond the flat 90s the rate-limit family
    // would otherwise have used — BLO-18278's ~18x gap is not reintroduced —
    // while no longer running to the advertised horizon.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - Date.now();
    expect(scheduledInMs).toBeGreaterThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 5);
  }, 60_000);

  // The structured sibling of the case above. An adapter that parses the
  // horizon itself skips the server's prose parser, so before this fix it
  // reached recovery with no provenance and lost the 429 diagnosis — on exactly
  // the adapters that report the fault most precisely.
  it("substantiates a structured retryNotBefore paired with an observed 429", async () => {
    const { agentId } = await seedAgent(STRUCTURED_429_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");
    // BLO-28919: clamped floor, advertised value preserved beside it. A
    // structured hint is no more trustworthy as a park horizon than a parsed
    // one — it is the same provider making the same claim.
    const clampedIso = resultJson?.retryNotBefore as string | undefined;
    expect(clampedIso).toBeTruthy();
    expect(clampedIso).not.toBe(advertisedResetIso);
    expect(resultJson?.penstockCapacityParkClampedFrom).toBe(advertisedResetIso);
    expectWithinCapacityCeiling(clampedIso!, failedRun?.startedAt ?? null);

    // The horizon is re-derived server-side and re-emitted canonically rather
    // than trusted verbatim, so the value the comment can quote is ours.
    expect(resultJson?.providerCapacityResetAt).toBe(advertisedResetIso);
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "adapter_structured_retry_not_before",
    });

    // And it still parks rather than stranding — at the clamped floor now.
    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);
    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(clampedIso);
  }, 60_000);

  // Pins the causal claim: it is the advertised horizon, not merely the 429
  // family, that moves the schedule. The same fault without one still parks in
  // `scheduled_retry` (so it does not strand either) but takes the flat hop.
  it("falls back to the flat hop when the same 429 advertises no reset", async () => {
    const { agentId } = await seedAgent(UNHINTED_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");
    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.retryNotBefore ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetAt ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetProvenance ?? null).toBeNull();

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");

    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeLessThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 2);
  }, 60_000);

  // BLO-18285. The gap between the two tests above: a 429 that advertises a
  // window PAST the cap. On master the cap collapsed that reading into the same
  // `null` as the no-hint control, so this fault took the flat 90s hop — with
  // 12 attempts that is ~18min of post-gate retries against an 88.8h window,
  // every one of them landing inside it, ending in BackoffLimitExceeded and a
  // `stranded_assigned_issue`. Live proof: run b48c8b30 on BLO-18285 itself.
  //
  // Note what this test does NOT assert. A single over-cap failure parks in
  // `scheduled_retry` on master too — the strand comes from exhausting the
  // chain, not from the first hop — so "did not strand" would pass either way
  // and prove nothing. The load-bearing assertion is the schedule: ~24h out
  // instead of ~90s. That is what makes the chain unable to exhaust inside the
  // window in the first place.
  it("parks an over-cap 429 at the horizon cap instead of discarding it", async () => {
    const { agentId } = await seedAgent(OVER_CAP_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");

    // Both scheduler surfaces carry a park that is neither the advertised 88.8h
    // instant nor null. On master all three of these are null.
    //
    // BLO-28919 changed WHICH bounded park this is. BLO-18285 parked at the 24h
    // horizon cap; the floor is now additionally clamped to the capacity
    // ceiling, so the run re-probes in minutes instead of sleeping a day. That
    // preserves BLO-18285's actual requirement — never take the flat 90s hop
    // and exhaust inside a closed window, stay in `scheduled_retry` so the
    // strand sweep leaves the issue alone — and improves on it: an 88.8h
    // advertisement no longer costs 24h of silence before the first re-probe,
    // and recovery lands within one ceiling of capacity actually returning.
    // `providerCapacityResetAt` keeps recording the capped horizon, so the
    // provenance trail BLO-18285 built is intact.
    const parkedIso = resultJson?.retryNotBefore as string | undefined;
    expect(parkedIso).toBeTruthy();
    expect(resultJson?.transientRetryNotBefore).toBe(parkedIso);
    expect(parkedIso).not.toBe(overCapAdvertisedIso);
    expectWithinCapacityCeiling(parkedIso!, failedRun?.startedAt ?? null);

    // Provenance records BOTH numbers: what we parked on, and what was actually
    // asked for. Without the latter the 88.8h advertisement — the whole reason
    // this is not a verbatim park — is unrecoverable from the persisted run.
    expect(resultJson?.providerCapacityResetProvenance).toEqual({
      source: PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE,
      errorFamily: "rate_limit_exhausted",
      observedStatusCode: 429,
      observedStatusField: "api_error_status",
      observedCause: "rate_limit_exhausted",
      horizonSource: "server_prose_parse_over_horizon_park",
      advertisedResetAt: overCapAdvertisedIso,
      horizonCapMs: PROVIDER_CAPACITY_MAX_HORIZON_MS,
    });

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(parkedIso);

    // The assertion that fails on master: the continuation parks instead of
    // taking the 90s hop. BLO-28919 bounds it by the capacity ceiling rather
    // than the 24h horizon cap, so the lower bound is what matters here — it is
    // still orders of magnitude past the flat hop, and it re-probes rather than
    // sleeping to a horizon we already decided not to believe.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeGreaterThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 5);
    expect(scheduledInMs).toBeLessThanOrEqual(
      CCROTATE_CAPACITY_MAX_PARK_MS * (1 + CCROTATE_CAPACITY_PARK_JITTER_RATIO) + 60_000,
    );
  }, 60_000);

  // BLO-18285 review follow-up, and the counterpart to the test above: the same
  // real 429, the same over-cap instant, but stated only in model-authored prose.
  // It must take the ordinary flat hop, NOT the 24h park.
  //
  // This is the whole failure mode in one case. An agent that writes "capacity
  // may reset at <far future>" into its own result — quoting an older fault,
  // speculating, or simply being wrong — could otherwise sideline its issue for a
  // full day, and the 429 gate would not catch it because the 429 is genuine.
  // The two signals were independently true and wrongly treated as corroborating.
  it("does not park a 429 whose over-cap horizon appears only in model prose", async () => {
    const { agentId } = await seedAgent(PROSE_OVER_CAP_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    // No park was derived at all: prose cannot supply the over-cap claim, and
    // there is no machine-authored horizon anywhere in this payload.
    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.errorFamily).toBe("rate_limit_exhausted");
    expect(resultJson?.retryNotBefore ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetAt ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetProvenance ?? null).toBeNull();

    // Still parks in `scheduled_retry`, so this does not reintroduce a strand —
    // it takes the rate-limit family's normal schedule, which is the correct
    // disposition for a 429 that told us nothing we can trust.
    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");

    // The load-bearing assertion, and the one that fails without the narrowing:
    // ~90s out, not ~24h.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeLessThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 2);
    expect(scheduledInMs).toBeLessThan(PROVIDER_CAPACITY_MAX_HORIZON_MS * 0.1);
  }, 60_000);

  // BLO-18285 review follow-up: the 429 gate's own negative case. Trusted,
  // machine-authored, over-cap horizon — but the structured status is 401. The
  // capped park is deliberately reserved for a capacity 429, because the throttle
  // families also fire for credential cap-windows and legacy quota signals where
  // a 24h sideline is the wrong answer.
  it("does not park an over-cap horizon when the structured status is not 429", async () => {
    const { agentId } = await seedAgent(NON_429_OVER_CAP_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.providerCapacityResetAt ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetProvenance ?? null).toBeNull();

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeLessThan(PROVIDER_CAPACITY_MAX_HORIZON_MS * 0.1);
  }, 60_000);

  // BLO-24490 — the load-bearing case. #1142 closed the over-cap half of this
  // and deliberately left the within-cap half open; this closes it.
  //
  // Nothing in this payload came from the provider. The agent's own summary says
  // "usage limit", which classifies the run as throttled, and "capacity may reset
  // at <23h>", which supplies the horizon. Two readings of one sentence the model
  // wrote were enough to sideline the issue until tomorrow. The `usable` /
  // `over_horizon` line is a bound on the number, not a statement about who wrote
  // it — 23h is not meaningfully safer than 24h — so the same corroboration
  // applies on both sides of it.
  it("does not park a within-cap horizon that only model prose stated", async () => {
    const { agentId } = await seedAgent(PROSE_USABLE_NO_429_TEST_ADAPTER);
    const startedAt = Date.now();

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");
    // The prose still classifies the fault — only the horizon is refused.
    expect(failedRun?.errorCode).toBe("rate_limit_exhausted");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.retryNotBefore ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetAt ?? null).toBeNull();
    expect(resultJson?.providerCapacityResetProvenance ?? null).toBeNull();

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");

    // Fails without the call-site gate: this lands ~23h out instead of ~90s.
    const scheduledInMs = (retryRun?.scheduledRetryAt?.getTime() ?? 0) - startedAt;
    expect(scheduledInMs).toBeLessThan(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS * 2);
    expect(scheduledInMs).toBeLessThan(PROSE_USABLE_HORIZON_MS * 0.1);
  }, 60_000);

  // The control, and the half that keeps this a bound rather than a removal.
  // Same prose, same field, plus a 429 the server observed — a real capacity
  // payload landing in `result`, which is what the SDK does when `is_error` is
  // true. This must still park at the advertised instant. Without it, a green
  // suite would be equally consistent with having simply stopped reading
  // `result` at all, which is the change BLO-24490 explicitly rejected.
  it("still parks a within-cap prose horizon corroborated by an observed 429", async () => {
    const { agentId } = await seedAgent(PROSE_USABLE_WITH_429_TEST_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id, 20_000);
    expect(failedRun?.status).toBe("failed");

    const resultJson = failedRun?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.providerCapacityResetAt).toBe(proseUsableIso);

    await expect
      .poll(() => countRetriesOf(run!.id), { timeout: 5_000, interval: 50 })
      .toBe(1);

    const retryRun = await retryRowOf(run!.id);
    expect(retryRun?.status).toBe("scheduled_retry");
    // BLO-28919: corroborated prose still parks — the point of this case — but
    // at the capacity-clamped floor rather than the advertised instant.
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(resultJson?.retryNotBefore);
    expect(resultJson?.penstockCapacityParkClampedFrom).toBe(proseUsableIso);
    expectWithinCapacityCeiling(
      resultJson?.retryNotBefore as string,
      failedRun?.startedAt ?? null,
    );
  }, 60_000);
});

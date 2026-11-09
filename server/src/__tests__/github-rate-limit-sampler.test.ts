/**
 * PEN-6341 done-when 3: the continuous two-shard budget instrument.
 *
 * The App installation's `core` budget is served by several route-pinned
 * shards that drain independently, and the fleet's problem is that demand is
 * MIS-ALLOCATED across them — one exhausts mid-window while another holds
 * thousands of unreachable spare requests. Every instrument previously
 * available reports a single `core` object and therefore cannot see that.
 *
 * These tests pin the properties that make this one trustworthy:
 *
 *  1. A FAILED READ is never published as a reading. Every failure mode lands
 *     on `sample_success = 0` with the value gauges untouched — never on
 *     `remaining = 0`, which is the exhaustion signal itself and would make a
 *     broken sampler indistinguishable from the outage it failed to observe.
 *  2. A missing or malformed header is a failed read, not a zero. `Number("")`
 *     and `Number(null)` are both 0, so the natural numeric parse would
 *     manufacture exhaustion out of an absent header.
 *  3. The HTTP status is not consulted. A 403 carrying the headers is a good
 *     sample — it is the expected answer from the `actions/permissions` probe,
 *     which is the only route measured on a shard other than the fleet's hot
 *     one.
 *  4. The sampler does not go through `ghFetch`. That is the whole design:
 *     `ghFetch`'s rate-limit hold is keyed on `resource`, which is `core` for
 *     every shard, so behind it a probe of a healthy shard would be answered
 *     with a synthesized 403 borrowed from a different, exhausted one.
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMetrics } from "../services/metrics.js";
import {
  DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS,
  githubRateLimitProbes,
  readGithubRateLimitProbe,
  sampleGithubRateLimits,
  startGithubRateLimitSampler,
  type GithubRateLimitProbe,
} from "../services/github-rate-limit-sampler.js";

const PROBE: GithubRateLimitProbe = { route: "rate_limit", path: "/rate_limit" };

function response(headers: Record<string, string>, status = 200): Response {
  return new Response("{}", { status, headers });
}

function fetchReturning(...responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)]) as unknown as typeof fetch;
}

const GOOD = {
  "x-ratelimit-remaining": "4612",
  "x-ratelimit-limit": "9650",
  "x-ratelimit-used": "5038",
  "x-ratelimit-reset": "1794250878",
  "x-ratelimit-resource": "core",
};

/** The overlap flag clears in a `.finally()`; let that microtask chain drain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function metricValue(metric: string, route: string): Promise<number | null> {
  const { body } = await renderMetrics();
  const line = body.split("\n").find((l) => l.startsWith(`${metric}{route="${route}"}`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readGithubRateLimitProbe", () => {
  it("reads every header GitHub sent", async () => {
    const sample = await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(response(GOOD)),
    });
    expect(sample).toEqual({
      route: "rate_limit",
      remaining: 4612,
      limit: 9650,
      used: 5038,
      resetSeconds: 1794250878,
      resource: "core",
    });
  });

  it("accepts a 403 that carries the headers", async () => {
    // The `actions/permissions` probe answers 403 for this installation, and
    // that is why it was chosen: a permission refusal still reports the full
    // budget set and cannot have side effects.
    const sample = await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(response(GOOD, 403)),
    });
    expect(sample?.remaining).toBe(4612);
  });

  it.each([
    ["absent", {} as Record<string, string>],
    ["empty", { "x-ratelimit-remaining": "", "x-ratelimit-limit": "9650" }],
    ["blank", { "x-ratelimit-remaining": "   ", "x-ratelimit-limit": "9650" }],
    ["non-numeric", { "x-ratelimit-remaining": "none", "x-ratelimit-limit": "9650" }],
    ["negative", { "x-ratelimit-remaining": "-1", "x-ratelimit-limit": "9650" }],
    ["limit missing", { "x-ratelimit-remaining": "10" }],
  ])("returns null when remaining is %s rather than reporting a zero", async (_label, headers) => {
    const sample = await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(response(headers)),
    });
    expect(sample).toBeNull();
  });

  it("keeps a genuine zero, which is the signal this metric exists for", async () => {
    const sample = await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(response({ ...GOOD, "x-ratelimit-remaining": "0" }, 403)),
    });
    expect(sample?.remaining).toBe(0);
  });

  it("returns null when the transport throws", async () => {
    const sample = await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(sample).toBeNull();
  });
});

describe("sampleGithubRateLimits", () => {
  it("publishes a success flag beside the values", async () => {
    await sampleGithubRateLimits({
      probes: [{ route: "probe-ok", path: "/rate_limit" }],
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl: fetchReturning(response(GOOD)),
    });
    expect(await metricValue("paperclip_github_rate_limit_remaining", "probe-ok")).toBe(4612);
    expect(await metricValue("paperclip_github_rate_limit_reset_seconds", "probe-ok")).toBe(1794250878);
    expect(await metricValue("paperclip_github_rate_limit_sample_success", "probe-ok")).toBe(1);
  });

  it("a failed read leaves the last values standing and flags them stale", async () => {
    const probes = [{ route: "probe-stale", path: "/rate_limit" }];
    await sampleGithubRateLimits({
      probes,
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl: fetchReturning(response(GOOD)),
    });
    await sampleGithubRateLimits({
      probes,
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl: fetchReturning(response({})),
    });
    // NOT zero: a zeroed remaining is the exhaustion signal, so publishing one
    // on a failed read would fire the alarm the sampler is failing to observe.
    expect(await metricValue("paperclip_github_rate_limit_remaining", "probe-stale")).toBe(4612);
    expect(await metricValue("paperclip_github_rate_limit_sample_success", "probe-stale")).toBe(0);
  });

  it("flags every probe when no token can be minted", async () => {
    const fetchImpl = fetchReturning(response(GOOD));
    await sampleGithubRateLimits({
      probes: [{ route: "probe-untokened", path: "/rate_limit" }],
      credentialsConfigured: () => true,
      getToken: async () => null,
      fetchImpl,
    });
    expect(await metricValue("paperclip_github_rate_limit_sample_success", "probe-untokened")).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing at all when the App is not configured", async () => {
    const getToken = vi.fn(async () => "t");
    await sampleGithubRateLimits({
      probes: [{ route: "probe-unconfigured", path: "/rate_limit" }],
      credentialsConfigured: () => false,
      getToken,
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(await metricValue("paperclip_github_rate_limit_sample_success", "probe-unconfigured")).toBeNull();
  });

  it("probes in series, so one route's decrements cannot be read by another", async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      order.push(`start ${url}`);
      await new Promise((r) => setTimeout(r, 1));
      order.push(`end ${url}`);
      return response(GOOD);
    }) as unknown as typeof fetch;
    await sampleGithubRateLimits({
      probes: [
        { route: "a", path: "/a" },
        { route: "b", path: "/b" },
      ],
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl,
    });
    expect(order).toEqual([
      "start https://api.github.com/a",
      "end https://api.github.com/a",
      "start https://api.github.com/b",
      "end https://api.github.com/b",
    ]);
  });
});

describe("githubRateLimitProbes", () => {
  it("samples only repo-free routes when no sample repo is configured", () => {
    expect(githubRateLimitProbes("").map((p) => p.route)).toEqual(["rate_limit"]);
  });

  it("adds the second-shard witness when a repo is configured", () => {
    const routes = githubRateLimitProbes("Blockcast/paperclip").map((p) => p.route);
    // `actions/permissions` is the one route measured on a shard other than the
    // fleet's hot one (2026-11-09). Losing it makes every remaining probe a
    // sample of the same counter, which is the failure this item exists to fix.
    expect(routes).toContain("repos/actions/permissions");
    expect(routes).toContain("rate_limit");
  });

  it.each(["not-a-repo", "a/b/c", "owner/repo?x=1", "../../etc", "owner /repo", ""])(
    "ignores a malformed sample repo (%s) rather than probing a path it invented",
    (value) => {
      expect(githubRateLimitProbes(value).map((p) => p.route)).toEqual(["rate_limit"]);
    },
  );

  it("puts the configured repo in the path", () => {
    const probe = githubRateLimitProbes("Blockcast/paperclip")
      .find((p) => p.route === "repos/actions/permissions");
    expect(probe?.path).toBe("/repos/Blockcast/paperclip/actions/permissions");
  });
});

describe("the ghFetch bypass", () => {
  it("does not route probes through the shared GitHub fetch wrapper", async () => {
    // Load-bearing, and not merely a style preference. `ghFetch`'s rate-limit
    // hold is keyed on `host : sha256(authorization) : resource`, and
    // `inferRateLimitResource` answers `core` for every non-search,
    // non-graphql route -- so the key cannot tell one core SHARD from another.
    // Behind it, a probe of a healthy shard is answered from `heldResponse`
    // with a synthesized 403 borrowed from a different, exhausted shard, and
    // the sampler publishes a shard with thousands of free requests as spent.
    // That is precisely the single-counter error that makes `GET /rate_limit`
    // unusable here, so a sampler committing it would measure nothing.
    //
    // It would also stand a false `reason="forbidden"` into the refusal
    // counter on every tick, because the `actions/permissions` probe answers
    // 403 by design.
    const source = await readFile(
      new URL("../services/github-rate-limit-sampler.ts", import.meta.url),
      "utf8",
    );
    // Comments stripped first. The file EXPLAINS the bypass at length, so a
    // raw search for the identifier matches the prose arguing for the rule and
    // fails on a compliant file -- the same reason this codebase never greps
    // for a property someone phrased rather than one they compiled.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/from\s+["'][^"']*github-fetch\.js["']/);
    expect(code).not.toMatch(/\bghFetch\s*\(/);
    // Control: the stripper must leave real code behind, or this suite passes
    // on an empty string and proves nothing.
    expect(code).toMatch(/export async function sampleGithubRateLimits/);
  });
});

describe("startGithubRateLimitSampler", () => {
  it("samples immediately rather than waiting out the first interval", () => {
    const sample = vi.fn(async () => {});
    const stop = startGithubRateLimitSampler({
      scheduler: { setInterval: () => 1 as never, clearInterval: () => {} },
      sample,
    });
    expect(sample).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not stack a second tick on an unfinished one", async () => {
    let release!: () => void;
    const sample = vi.fn(() => new Promise<void>((r) => { release = r; }));
    let tick!: () => void;
    const stop = startGithubRateLimitSampler({
      scheduler: { setInterval: (cb) => { tick = cb; return 1 as never; }, clearInterval: () => {} },
      sample,
    });
    expect(sample).toHaveBeenCalledTimes(1);
    tick();
    tick();
    expect(sample).toHaveBeenCalledTimes(1);
    release();
    await flushMicrotasks();
    tick();
    expect(sample).toHaveBeenCalledTimes(2);
    stop();
  });

  it("survives a throwing tick, because a dead timer publishes nothing forever", async () => {
    const sample = vi.fn(async () => { throw new Error("boom"); });
    let tick!: () => void;
    const stop = startGithubRateLimitSampler({
      scheduler: { setInterval: (cb) => { tick = cb; return 1 as never; }, clearInterval: () => {} },
      sample,
    });
    await flushMicrotasks();
    tick();
    expect(sample).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps the default cadence well under the budget it measures", () => {
    // 3 probes at this cadence is ~36 calls/h against ~19,300/h. A sampler that
    // materially moved the number it reports would not be an instrument.
    expect(DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

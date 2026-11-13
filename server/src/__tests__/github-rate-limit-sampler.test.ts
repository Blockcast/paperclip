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
import { logger } from "../middleware/logger.js";
import { renderMetrics } from "../services/metrics.js";
import { classifyGithubApiRoute } from "../services/github-fetch.js";
import {
  DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS,
  DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO,
  GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV,
  githubRateLimitProbes,
  resetGithubRateLimitProbeWarnings,
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

/**
 * Run `fn` with the sample-repo env var genuinely ABSENT.
 *
 * `githubRateLimitProbes(undefined)` does NOT mean "unset": an explicit
 * `undefined` triggers the PARAMETER DEFAULT, which reads `process.env`. So a
 * test named for the unset case would silently assert against whatever the
 * ambient environment held -- vacuous where it matters most, since the unset
 * path is the deployed one.
 */
function withSampleRepoUnset<T>(fn: () => T): T {
  const previous = process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV];
  delete process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV];
  try {
    return fn();
  } finally {
    if (previous !== undefined) process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV] = previous;
  }
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

  it("releases the response body, including on the early-return path", async () => {
    // With undici an unconsumed body holds its socket out of the pool until GC.
    // Asserted on BOTH paths: the good read and the one that bails because the
    // headers were not well formed -- the early return is the easy one to miss.
    const cancels: string[] = [];
    const make = (headers: Record<string, string>, tag: string): Response => {
      const r = response(headers);
      Object.defineProperty(r, "body", {
        value: { cancel: async () => void cancels.push(tag) },
        configurable: true,
      });
      return r;
    };
    await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(make(GOOD, "good")),
    });
    await readGithubRateLimitProbe(PROBE, {
      token: "t",
      fetchImpl: fetchReturning(make({}, "malformed")),
    });
    expect(cancels).toEqual(["good", "malformed"]);
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

  it("drops a stale reset_seconds rather than pairing it with a fresh success", async () => {
    // `reset_seconds` is the documented shard discriminator. A good read that
    // simply omits the header must not leave the PREVIOUS reset published
    // beside `sample_success = 1`: within one scrape that groups this route
    // with the wrong shard, which is a confident wrong partition. An absent
    // series is readable; a stale number is not. Raised by Ally on #3626.
    const probes = [{ route: "probe-reset-drop", path: "/rate_limit" }];
    await sampleGithubRateLimits({
      probes,
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl: fetchReturning(response(GOOD)),
    });
    expect(await metricValue("paperclip_github_rate_limit_reset_seconds", "probe-reset-drop"))
      .toBe(1794250878);

    // A GOOD read (remaining + limit present) that omits reset and used.
    await sampleGithubRateLimits({
      probes,
      credentialsConfigured: () => true,
      getToken: async () => "t",
      fetchImpl: fetchReturning(
        response({ "x-ratelimit-remaining": "17", "x-ratelimit-limit": "9650" }),
      ),
    });
    expect(await metricValue("paperclip_github_rate_limit_sample_success", "probe-reset-drop")).toBe(1);
    expect(await metricValue("paperclip_github_rate_limit_remaining", "probe-reset-drop")).toBe(17);
    expect(await metricValue("paperclip_github_rate_limit_reset_seconds", "probe-reset-drop")).toBeNull();
    expect(await metricValue("paperclip_github_rate_limit_used", "probe-reset-drop")).toBeNull();
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
  it("still spans two shards when no sample repo is configured", () => {
    // NEGATIVE, replacing an assertion that pinned the defect. The previous
    // version asserted `["rate_limit"]` -- repo-free only -- which is the
    // DEPLOYED default, because nothing in this repo sets the env var. That
    // leaves exactly one probe, on the hot shard, so `group by reset_seconds`
    // can never return more than one group: the sampler reads as deployed and
    // cannot show the partition it exists to show. Raised by Ally on #3626.
    const routes = githubRateLimitProbes("").map((p) => p.route);
    expect(routes).toContain("repos/actions/permissions");
    expect(routes.length).toBeGreaterThan(1);
  });

  it("probes the default repository when the env var is unset", () => {
    const probe = withSampleRepoUnset(() =>
      githubRateLimitProbes().find((p) => p.route === "repos/actions/permissions"),
    );
    expect(probe?.path).toBe(`/repos/${DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO}/actions/permissions`);
  });

  it("adds the second-shard witness when a repo is configured", () => {
    const routes = githubRateLimitProbes("Blockcast/paperclip").map((p) => p.route);
    // `actions/permissions` is the one route measured on a shard other than the
    // fleet's hot one (2026-11-09). Losing it makes every remaining probe a
    // sample of the same counter, which is the failure this item exists to fix.
    expect(routes).toContain("repos/actions/permissions");
    expect(routes).toContain("rate_limit");
  });

  it("samples at least one route the local hold actually holds", () => {
    // PEN-6619. Before this, the sampled route set and the routes appearing in
    // `paperclip_github_api_held_total` were disjoint, so "was this call held
    // while its own shard had headroom?" could not be asked of any route: an
    // empty join answered UNDETERMINED and read as zero victims.
    //
    // Asserted as a NON-EMPTY INTERSECTION rather than by naming the probe,
    // because the property that matters is that some held route is sampled.
    // Naming only `repos/pulls/requested_reviewers` would pass just as well if
    // it were the last one left, which is the state this test exists to catch.
    const HELD_ROUTES = [
      "repos/check-runs",
      "repos/commits",
      "repos/commits/statuses",
      "repos/issues/comments",
      "repos/issues/timeline",
      "repos/pulls",
      "repos/pulls/commits",
      "repos/pulls/files",
      "repos/pulls/requested_reviewers",
      "repos/pulls/reviews",
      "repos/statuses",
    ];
    const routes = githubRateLimitProbes("Blockcast/paperclip").map((p) => p.route);
    expect(routes.filter((r) => HELD_ROUTES.includes(r))).not.toHaveLength(0);
  });

  it("labels the held-route probe as classifyGithubApiRoute would", () => {
    // The sampler bypasses `ghFetch`, so this label is hardcoded rather than
    // derived -- which is exactly why it can silently stop matching the label
    // the hold counter writes, and a join keyed on a label that matches
    // nothing returns empty, i.e. the same false "no victims" as before.
    const probe = githubRateLimitProbes("Blockcast/paperclip").find(
      (p) => p.route === "repos/pulls/requested_reviewers",
    );
    expect(probe?.path).toBe("/repos/Blockcast/paperclip/pulls/1/requested_reviewers");
    expect(classifyGithubApiRoute(`https://api.github.com${probe?.path ?? ""}`)).toBe(
      "repos/pulls/requested_reviewers",
    );
  });

  it.each(["not-a-repo", "a/b/c", "owner/repo?x=1", "../../etc", "owner /repo", ""])(
    "never probes a path invented from a malformed sample repo (%s)",
    (value) => {
      // The guard that matters is unchanged: the malformed value must not reach
      // a request path. What changed is the FALLBACK -- to the default repo
      // rather than to repo-free-only, since repo-free-only is the single-shard
      // failure above. So assert on the paths, not on the route list.
      for (const probe of githubRateLimitProbes(value)) {
        expect(probe.path).not.toContain(value === "" ? "\u0000never" : value);
      }
      expect(githubRateLimitProbes(value).map((p) => p.route))
        .toContain("repos/actions/permissions");
    },
  );

  it("logs once, not every tick, when it rejects a malformed sample repo", () => {
    resetGithubRateLimitProbeWarnings();
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    try {
      githubRateLimitProbes("owner/repo?x=1");
      githubRateLimitProbes("owner/repo?x=1");
      // Substituting the default silently would hide the operator typo that
      // REPO_FULL_NAME exists to catch, so it must say so -- once.
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads an ambient env value, and the unset-case helper really removes it", () => {
    // CONTROL for the two assertions above. Without this, `withSampleRepoUnset`
    // could be a no-op and the unset-case tests would still pass -- they would
    // just be asserting against the default by accident. Both arms are needed:
    // the first proves the env var is honoured at all, the second proves the
    // helper genuinely clears it rather than merely passing `undefined`.
    const previous = process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV];
    process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV] = "Other/repo";
    try {
      const pathOf = () =>
        githubRateLimitProbes().find((p) => p.route === "repos/actions/permissions")?.path;
      expect(pathOf()).toBe("/repos/Other/repo/actions/permissions");
      expect(withSampleRepoUnset(pathOf)).toBe(
        `/repos/${DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO}/actions/permissions`,
      );
      // ...and it is restored afterwards, or it would leak into later tests.
      expect(pathOf()).toBe("/repos/Other/repo/actions/permissions");
    } finally {
      if (previous === undefined) delete process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV];
      else process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV] = previous;
    }
  });

  it("does not warn when the value is simply unset", () => {
    resetGithubRateLimitProbeWarnings();
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => logger) as never);
    try {
      withSampleRepoUnset(() => githubRateLimitProbes());
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

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

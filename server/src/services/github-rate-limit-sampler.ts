/**
 * @fileoverview Periodic sampler that records GitHub's own `x-ratelimit-*`
 * headers, per probed route, into Prometheus (PEN-6341 done-when 3).
 *
 * ## Why this exists
 *
 * The App installation's `core` budget is not one counter. It is served by
 * several route-pinned shards of 9,650/h that drain INDEPENDENTLY, and the
 * fleet's demand is mis-allocated across them rather than merely large: one
 * shard exhausts mid-window while another sits on thousands of unreachable
 * spare requests. PEN-5710 established that; this records it continuously, so
 * "is the shortfall continuous or diurnal?" becomes a range query instead of
 * another hand-run measurement.
 *
 * ## Why the gauges are labelled by ROUTE and not by SHARD
 *
 * Labelling by shard is the obvious design and it bakes in a mapping that
 * decays. Measured first-party 2026-11-09: at ~11:45Z
 * `repos/:o/:r/commits/:ref/check-suites` and `.../check-runs` were on
 * different shards, and by 18:2xZ the same two routes were demonstrably ONE
 * counter — an 8-read interleave alternating them returned a strictly monotone
 * remaining sequence under an identical `reset`, which two independent counters
 * cannot produce. The partition is real (a control probe of
 * `repos/:o/:r/actions/permissions` sat on a separate counter with its own
 * `reset` throughout, so the instrument discriminates rather than matching
 * everything) — but WHICH routes share a shard moved within about seven hours.
 *
 * So a `shard="a"` label would have been written against a mapping that was
 * already stale, and it would have gone on publishing confident, wrong series.
 * A `route` label cannot go stale: routes that share a counter move together
 * and report the same `reset`, so the partition is recoverable at query time
 * and this module never has to claim to know it.
 *
 * ## Why this does not go through `ghFetch`
 *
 * Three independent reasons, each measured rather than assumed:
 *
 * 1. The local rate-limit hold (BLO-53662) WAS shard-blind, and narrowing it
 *    does not make it safe to sample through. `rateLimitHoldKey` keyed on
 *    `host : sha256(authorization) : resource`, and `inferRateLimitResource`
 *    returns `core` for every non-search, non-graphql route — so one shard's
 *    exhaustion made `ghFetch` synthesize a local 403 for the other shard's
 *    routes too, reproducing inside this process exactly the single-counter
 *    error that makes `GET /rate_limit` unusable as a budget instrument.
 *    PEN-6520 added the route to that key, so a hold is now no wider than the
 *    route the refusal was drawn on. That shrinks the blast radius; it does
 *    NOT retire this reason, because a sampler probes one route per shard and
 *    would still be answered from a hold its own previous probe armed. Reasons
 *    2 and 3 never depended on the key's width and are each sufficient alone.
 * 2. A held call answers from `heldResponse`, whose headers are a frozen echo
 *    of the last real reading. The sampler would therefore keep publishing the
 *    moment of exhaustion long after the bucket refilled, destroying the one
 *    property this item is for: that a refused probe still reports the truth.
 * 3. Probe routes are chosen for their headers, not their bodies, so a probe
 *    that answers 403 for lack of a permission is perfectly good — and
 *    `classifyGithubRefusal` would score that `forbidden` on every tick,
 *    putting a standing false signal into the refusal counter PEN-3852 built
 *    to answer this very question.
 *
 * It must also never ARM the hold: a probe deliberately reads one shard, and
 * recording its exhaustion under a key that other calls share is the defect
 * above, not a use of it. PEN-6520 narrowed that key from `core`-wide to
 * per-route, which shrinks the set of calls a probe could wrongly hold without
 * emptying it — the probe's own route is still shared with ordinary traffic.
 *
 * ## Two measured properties a future reader should not have to rediscover
 *
 * A probe reports the budget whether or not its ref or permission resolves.
 * Measured 2026-11-09: `actions/permissions` answers 403, `commits/HEAD/...`
 * answers 200, and a bogus 40-hex ref answers 422 — all three carry the full
 * `x-ratelimit-*` set. That is why probe selection optimises for a stable,
 * side-effect-free path rather than a successful one, and why the status is
 * never consulted.
 *
 * Probing a QUIET shard anchors its window. GitHub opens a window lazily, at
 * `first request after expiry + 1h`, so on a shard the fleet barely touches
 * this sampler is routinely request #1 — measured directly: shard A reset at
 * 18:33:39Z and the next probe read `used: 1` with a reset exactly one hour
 * after that probe. Harmless (the window would open on the first real request
 * anyway, and the ceiling does not move) but worth knowing before reading two
 * routes' `reset` values as independent evidence of anything.
 *
 * Bypassing means this module forgoes `ghFetch`'s attempt/refusal counters and
 * its deadline, so it carries its own deadline and is deliberately absent from
 * `paperclip_github_api_requests_total`. That is correct rather than a gap:
 * these probes are instrumentation, and folding them into the denominator
 * would make the fleet's demand figure include the thing measuring it.
 */

import { logger } from "../middleware/logger.js";
import { getInstallationToken, githubAppCredentialsConfigured } from "./github-app-auth.js";
import { setGithubRateLimitSample, type GithubRateLimitSample } from "./metrics.js";

/** One probe: a stable label value and the API path that carries the headers. */
export interface GithubRateLimitProbe {
  /** Label value. Route-shaped and closed — never caller- or URL-derived. */
  route: string;
  /** Path under the API base, leading slash included. */
  path: string;
}

/**
 * Repo-free probes, always sampled.
 *
 * `rate_limit` is documented by GitHub as not counting against the budget,
 * which makes it the one free witness available — but it reports only the
 * shard IT is pinned to, which is why it cannot be the whole instrument.
 */
const REPO_FREE_PROBES: readonly GithubRateLimitProbe[] = [
  { route: "rate_limit", path: "/rate_limit" },
];

/**
 * Probes that need a repository.
 *
 * `actions/permissions` is here because it is the only route measured on a
 * DIFFERENT shard from the fleet's hot one (2026-11-09: 7 of 8 probed routes,
 * including both `commits/:ref/check-*` routes and `rate_limit` itself, shared
 * one counter; this one did not). It answers 403 for this installation, which
 * is fine and is part of why it was chosen: a permission refusal still carries
 * the full `x-ratelimit-*` set, costs nothing to parse, and cannot have side
 * effects. `check-runs` is sampled beside it as the hot-shard witness.
 */
function repoProbes(repoFullName: string): readonly GithubRateLimitProbe[] {
  return [
    { route: "repos/actions/permissions", path: `/repos/${repoFullName}/actions/permissions` },
    { route: "repos/commits/check-runs", path: `/repos/${repoFullName}/commits/HEAD/check-runs?per_page=1` },
  ];
}

export const GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV = "PAPERCLIP_GITHUB_RATE_LIMIT_SAMPLE_REPO";

/**
 * Default repository for the repo-scoped probes.
 *
 * NOT a convenience. Without it the DEPLOYED default is `REPO_FREE_PROBES`
 * alone -- `rate_limit`, which this module's own doc above says sits on the hot
 * shard and "cannot be the whole instrument". Nothing in this repo sets the env
 * var, so unset is not a hypothetical: the series would exist, `sample_success`
 * would read 1, and grouping by `reset_seconds` could never return more than
 * one group. That is a sampler which reads as deployed and is structurally
 * incapable of showing the partition it was built to show -- the same
 * single-counter error that makes `GET /rate_limit` unusable here, reproduced
 * by this module's own default. (Raised by Ally on #3626, 2026-11-09.)
 *
 * It grants nothing and asserts nothing about access: the repo probes are
 * chosen for their HEADERS, and a 403/404/422 carries the full `x-ratelimit-*`
 * set, so an inaccessible default still samples correctly.
 */
export const DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO = "Blockcast/paperclip";

/** Default cadence. 5 min × 3 probes is ~36 calls/h against a ~19,300/h installation budget. */
export const DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS = 5 * 60_000;

const PROBE_DEADLINE_MS = 10_000;

/**
 * `owner/repo`, and nothing else.
 *
 * The value is interpolated into a request path, so an unvalidated one could
 * point the probe at a different route entirely — a `?`, a `..` or a second
 * slash is enough. It is operator-set rather than attacker-set, so this is a
 * typo guard rather than a trust boundary; it is cheap, and a probe silently
 * reading the wrong route is exactly the failure this whole module exists to
 * stop being possible.
 */
const REPO_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** One-shot, so a rejected value is reported once rather than every 5 minutes. */
let malformedSampleRepoLogged = false;

/** Per-route one-shot latch for the non-core resource warning, same reasoning. */
const unexpectedResourceLogged = new Set<string>();

/** Test seam: reset the once-only log latch. */
export function resetGithubRateLimitProbeWarnings(): void {
  malformedSampleRepoLogged = false;
  unexpectedResourceLogged.clear();
}

export function githubRateLimitProbes(
  repoFullName: string | undefined = process.env[GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV]?.trim(),
): readonly GithubRateLimitProbe[] {
  if (repoFullName && REPO_FULL_NAME.test(repoFullName)) {
    return [...REPO_FREE_PROBES, ...repoProbes(repoFullName)];
  }
  if (repoFullName && !malformedSampleRepoLogged) {
    // Set but malformed -- a typo, or a URL pasted where a slug was expected.
    // Fall back to the DEFAULT rather than to free-only, because free-only is
    // the single-shard failure described above; but say so, because silently
    // substituting would hide the very typo REPO_FULL_NAME exists to catch.
    malformedSampleRepoLogged = true;
    logger.warn(
      {
        env: GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV,
        fallback: DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO,
      },
      "github rate-limit sampler: rejected a malformed repository value; probing the default instead",
    );
  }
  return [...REPO_FREE_PROBES, ...repoProbes(DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO)];
}

/**
 * Parse one header as a non-negative integer, or null.
 *
 * Deliberately NOT `Number(...)`: `Number(null)` and `Number("")` are both 0,
 * so a numeric read of a MISSING header would publish a remaining of zero and
 * manufacture the exhaustion this gauge exists to detect. Same reasoning, and
 * the same trap, as `classifyGithubRefusal`'s trimmed-string comparison.
 */
function headerInt(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read one probe.
 *
 * Returns null for every failure — no token, transport error, deadline, or a
 * response that did not carry a well-formed `remaining` AND `limit`. The
 * caller publishes that as `sample_success = 0` and leaves the value gauges
 * untouched, so a failed read can never be mistaken for a reading.
 *
 * PASS requires PRESENT values. The HTTP status is deliberately not consulted:
 * a 403 carrying the headers is a good sample (and is the expected answer from
 * the `actions/permissions` probe), while a 200 that somehow carried none is
 * not.
 */
export async function readGithubRateLimitProbe(
  probe: GithubRateLimitProbe,
  deps: { token: string; fetchImpl?: typeof fetch; apiBase?: string } ,
): Promise<GithubRateLimitSample | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? "https://api.github.com";
  let response: Response;
  try {
    response = await fetchImpl(`${apiBase}${probe.path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${deps.token}`,
      },
      signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
    });
  } catch {
    return null;
  }
  const remaining = headerInt(response, "x-ratelimit-remaining");
  const limit = headerInt(response, "x-ratelimit-limit");
  const used = headerInt(response, "x-ratelimit-used");
  const resetSeconds = headerInt(response, "x-ratelimit-reset");
  const resource = response.headers.get("x-ratelimit-resource")?.trim() || null;

  // The headers are the whole payload as far as this probe is concerned. With
  // undici an unconsumed body holds its socket out of the pool until GC, and
  // `check-runs?per_page=1` would otherwise download a page nobody reads.
  // Cancelled BEFORE the PASS test below, so the early return cannot leak it.
  await response.body?.cancel().catch(() => {});

  if (remaining === null || limit === null) return null;

  // `resource` is not published -- it would be a second label on a closed set
  // and says nothing a reader of this gauge needs. It IS worth one line when it
  // disagrees: every probe here is expected to draw on `core`, and a probe
  // quietly reading some other budget would be grouped with `core` routes by
  // `reset_seconds` and silently mis-partition the shard view.
  if (resource !== null && resource !== "core" && !unexpectedResourceLogged.has(probe.route)) {
    unexpectedResourceLogged.add(probe.route);
    logger.warn(
      { route: probe.route, resource },
      "github rate-limit sampler: probe reported a non-core rate-limit resource",
    );
  }

  return { route: probe.route, remaining, limit, used, resetSeconds, resource };
}

/** Sample every configured probe once, publishing each result independently. */
export async function sampleGithubRateLimits(
  deps: {
    probes?: readonly GithubRateLimitProbe[];
    fetchImpl?: typeof fetch;
    apiBase?: string;
    getToken?: () => Promise<string | null>;
    credentialsConfigured?: () => boolean;
  } = {},
): Promise<void> {
  const credentialsConfigured = deps.credentialsConfigured ?? githubAppCredentialsConfigured;
  if (!credentialsConfigured()) return;
  const probes = deps.probes ?? githubRateLimitProbes();
  const token = await (deps.getToken ?? getInstallationToken)();
  if (!token) {
    for (const probe of probes) setGithubRateLimitSample(probe.route, null);
    return;
  }
  // In series. Off the request path there is no latency budget to defend, and
  // concurrent probes would race each other's decrements, so a reader could
  // not tell two routes sharing a counter from two that do not.
  for (const probe of probes) {
    const sample = await readGithubRateLimitProbe(probe, {
      token,
      fetchImpl: deps.fetchImpl,
      apiBase: deps.apiBase,
    });
    setGithubRateLimitSample(probe.route, sample);
  }
}

export interface GithubRateLimitSamplerScheduler {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
}

const defaultScheduler: GithubRateLimitSamplerScheduler = { setInterval, clearInterval };

/**
 * Start the sampler. Returns a stop function.
 *
 * Non-overlapping ticks: a slow or hung probe must not stack a second round on
 * top of the first, because the second would read the first's own decrements.
 */
export function startGithubRateLimitSampler(
  options: {
    intervalMs?: number;
    scheduler?: GithubRateLimitSamplerScheduler;
    sample?: () => Promise<void>;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS;
  const scheduler = options.scheduler ?? defaultScheduler;
  const sample = options.sample ?? (() => sampleGithubRateLimits());
  let running = false;

  const tick = () => {
    if (running) return;
    running = true;
    void sample()
      .catch((err) => {
        logger.warn({ err }, "github rate-limit sampler tick failed");
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = scheduler.setInterval(tick, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  tick();
  return () => scheduler.clearInterval(timer);
}

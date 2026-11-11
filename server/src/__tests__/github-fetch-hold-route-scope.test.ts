/**
 * PEN-6520: one `core` route's exhaustion must not hold another `core` route.
 *
 * GitHub's `core` budget is two route-pinned shards that drain independently
 * (PEN-5710), and `x-ratelimit-resource` says `core` for both. The local hold
 * keyed on (host, credential, budget) therefore answered EVERY `core` route
 * locally on the strength of a refusal that may have come from the other
 * shard -- seven measured route families behind one key.
 *
 * These assertions are the pin for the route term. They are deliberately kept
 * out of `github-fetch-rate-limit-hold.test.ts`: that file pins the hold's
 * credential/budget scoping and its counter contract, and this is a third,
 * separable property.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetGhFetchRateLimitHoldsForTest,
  classifyGithubApiRoute,
  ghFetch,
  inferRateLimitResource,
} from "../services/github-fetch.js";

// Two routes on ONE host, ONE credential, and ONE budget. Both are plain REST
// repo reads, so `inferRateLimitResource` buckets both as `core` -- the route
// is the only term that differs, which is what makes the assertions below
// about the route and not about something else.
const PULLS = "https://api.github.com/repos/o/r/pulls/1";
const CHECK_RUNS = "https://api.github.com/repos/o/r/commits/decafbad/check-runs";
const SAME_ROUTE_AS_PULLS = "https://api.github.com/repos/o/r/pulls/2";

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

function exhausted(resetSec: number, resource = "core") {
  return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(resetSec),
      "x-ratelimit-resource": resource,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetGhFetchRateLimitHoldsForTest();
});

describe("the local rate-limit hold is scoped to the route (PEN-6520)", () => {
  it("isolates the route term: the fixtures differ in route and in nothing else", () => {
    // A control, not a tautology. Without it the headline test below would
    // pass just as happily if the hold were keyed on the budget alone and the
    // two fixtures happened to draw against different budgets.
    expect(classifyGithubApiRoute(PULLS)).toBe("repos/pulls");
    expect(classifyGithubApiRoute(CHECK_RUNS)).toBe("repos/commits/check-runs");
    expect(classifyGithubApiRoute(PULLS)).not.toBe(classifyGithubApiRoute(CHECK_RUNS));

    for (const url of [PULLS, CHECK_RUNS, SAME_ROUTE_AS_PULLS]) {
      expect(new URL(url).host).toBe("api.github.com");
      // Call the real bucketing function instead of re-deriving its predicate
      // here. An inline copy keeps passing on its own terms once the two drift,
      // and this control would then be controlling nothing -- which matters
      // most for CHECK_RUNS, the fixture that by design is never held and so
      // is not covered by the headline test's `x-ratelimit-resource` assertion.
      expect(inferRateLimitResource(url)).toBe("core");
    }
  });

  it("does not hold a second core route on the strength of the first one's refusal", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);

    // Arm the hold on `repos/pulls`.
    expect((await ghFetch(PULLS, auth("a"))).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The other route's shard may have thousands of requests free, so the call
    // must reach the wire and be answered by GitHub rather than by us.
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    expect((await ghFetch(CHECK_RUNS, auth("a"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...and the armed route is still held, on the same credential and budget.
    const held = await ghFetch(PULLS, auth("a"));
    expect(held.status).toBe(403);
    expect(held.headers.get("x-ratelimit-resource")).toBe("core");
    expect(held.headers.get("x-ratelimit-reset")).toBe(String(reset));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still holds every call on the route that was refused", async () => {
    // The route term narrows the hold; it must not perforate it. A hold that
    // only ever caught the one URL that was refused would re-fire the whole
    // exhausted window one path at a time, which is the behaviour BLO-53662
    // exists to remove.
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch(PULLS, auth("a"));
    expect(classifyGithubApiRoute(SAME_ROUTE_AS_PULLS)).toBe(classifyGithubApiRoute(PULLS));

    for (const url of [PULLS, SAME_ROUTE_AS_PULLS, PULLS]) {
      expect((await ghFetch(url, auth("a"))).status).toBe(403);
    }
    // One refusal on the wire; the other three answered locally. This is also
    // the cardinality pin: keying on the URL rather than on the closed route
    // template would make the key unbounded and show up here as extra sends.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

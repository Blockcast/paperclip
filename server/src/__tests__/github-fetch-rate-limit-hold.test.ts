/**
 * BLO-53662: once GitHub reports a credential's primary budget at zero, ghFetch
 * answers further calls on that credential and budget locally until the reset,
 * instead of re-firing them into the exhausted window.
 *
 * PEN-6243 adds the instrument half. The hold removes a call from the wire, and
 * until now it removed it from every COUNTER as well -- the skip was documented
 * in a source comment and pinned by no test, so a change in either direction
 * (held calls silently folded into the refusal counter, or the new held counter
 * silently dropped) would have been invisible. The counter assertions below are
 * that pin, and they are written as a three-way claim because only the
 * conjunction is useful: held advances, attempts do not, refusals do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetGhFetchRateLimitHoldsForTest, ghFetch } from "../services/github-fetch.js";
import {
  GITHUB_API_HELD_METRIC,
  GITHUB_API_REFUSALS_METRIC,
  GITHUB_API_REQUESTS_BY_ROUTE_METRIC,
  GITHUB_API_REQUESTS_METRIC,
  ZERO_INIT_GITHUB_API_HELD_LABELS,
  renderMetrics,
} from "../services/metrics.js";

const CORE = "https://api.github.com/repos/o/r/pulls/1";
const SEARCH = "https://api.github.com/search/issues?q=x";
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

describe("ghFetch rate-limit hold (BLO-53662)", () => {
  it("does not re-send on an exhausted credential before the reset", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);

    await ghFetch(CORE, auth("a"));
    const held = await ghFetch(CORE, auth("a"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(held.status).toBe(403);
    expect(held.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(held.headers.get("x-ratelimit-reset")).toBe(String(reset));
  });

  it("scopes the hold to the credential and the budget", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(CORE, auth("a"));

    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    expect((await ghFetch(CORE, auth("b"))).status).toBe(200);
    expect((await ghFetch(SEARCH, auth("a"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never lets an exhausted api.github.com hold another host", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(CORE);

    fetchMock.mockImplementation(async () => new Response("x", { status: 200 }));
    expect((await ghFetch("https://raw.githubusercontent.com/o/r/main/SKILL.md")).status).toBe(200);
    expect((await ghFetch("https://ghes.example.com/api/v3/repos/o/r")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends again once the reset has passed", async () => {
    const fetchMock = vi.fn(async () => exhausted(Math.floor(Date.now() / 1000) - 1));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(CORE, auth("a"));
    await ghFetch(CORE, auth("a"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hold on a permission 403", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(CORE, auth("a"));
    await ghFetch(CORE, auth("a"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * Read one counter series out of the rendered exposition.
 *
 * Returns null for an ABSENT series rather than 0: the zero-init assertion
 * below turns on exactly that distinction, and a helper that collapsed it would
 * make it vacuous. Same shape as the helper in
 * `github-api-refusal-metric.test.ts`; duplicated rather than shared because
 * these two files pin opposite halves of the same contract and a shared helper
 * would let one edit move both.
 */
function counterValue(body: string, metric: string, labels?: Record<string, string>): number | null {
  for (const line of body.split("\n")) {
    if (labels) {
      if (!line.startsWith(metric + "{")) continue;
      if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    } else if (line !== metric && !line.startsWith(metric + " ")) {
      continue;
    }
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function readCounters() {
  const { body } = await renderMetrics();
  return {
    held: counterValue(body, GITHUB_API_HELD_METRIC, { resource: "core", route: "repos/pulls" }) ?? 0,
    attempts: counterValue(body, GITHUB_API_REQUESTS_METRIC) ?? 0,
    refusals:
      counterValue(body, GITHUB_API_REFUSALS_METRIC, { reason: "rate_limited", resource: "core" }) ?? 0,
  };
}

describe("the hold's own work is counted, and only in its own series (PEN-6243)", () => {
  let before: Awaited<ReturnType<typeof readCounters>>;

  beforeEach(async () => {
    before = await readCounters();
  });

  it("advances the held counter while attempts and refusals stay flat", async () => {
    // The acceptance shape from PEN-6243 done-when #2, as one assertion: in a
    // single exhaustion window the held counter must advance while the refusal
    // counter does not. Folding held calls into the refusal counter would
    // re-inflate it with calls that cost GitHub nothing and destroy its use as
    // a draw signal, which is the question an org owner sizing the PEN-3852
    // split asks it.
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => exhausted(reset));
    vi.stubGlobal("fetch", fetchMock);

    // One real refusal installs the hold; it IS an attempt and IS a refusal.
    await ghFetch(CORE, auth("held-a"));
    const afterReal = await readCounters();
    expect(afterReal.attempts - before.attempts).toBe(1);
    expect(afterReal.refusals - before.refusals).toBe(1);
    expect(afterReal.held - before.held).toBe(0);

    // Three held calls. None leaves the process, so none is either of those.
    await ghFetch(CORE, auth("held-a"));
    await ghFetch(CORE, auth("held-a"));
    await ghFetch(CORE, auth("held-a"));

    const afterHeld = await readCounters();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(afterHeld.held - afterReal.held).toBe(3);
    expect(afterHeld.attempts - afterReal.attempts).toBe(0);
    expect(afterHeld.refusals - afterReal.refusals).toBe(0);
  });

  it("labels the held call by the budget that held it and the route it blocked", async () => {
    // `resource` joins to the refusal counter's own closed set; `route`
    // attributes the blocked work to an endpoint family. Neither carries an
    // owner, repo, number or SHA.
    const reset = Math.ceil(Date.now() / 1000) + 600;
    vi.stubGlobal("fetch", vi.fn(async () => exhausted(reset, "search")));
    await ghFetch(SEARCH, auth("held-b"));

    const seen = counterValue((await renderMetrics()).body, GITHUB_API_HELD_METRIC, {
      resource: "search",
      route: "search",
    });
    const beforeHeld = seen ?? 0;
    await ghFetch(SEARCH, auth("held-b"));
    const afterHeld =
      counterValue((await renderMetrics()).body, GITHUB_API_HELD_METRIC, {
        resource: "search",
        route: "search",
      }) ?? 0;
    expect(afterHeld - beforeHeld).toBe(1);
  });

  it("publishes a zero child from process start, so 'nothing was held' is sayable", async () => {
    // An absent series reads identically as "nothing was held" and "this build
    // carries no such instrument". Only the zero-init child distinguishes them,
    // and an alert written on the first reading needs that distinction.
    const { body } = await renderMetrics();
    expect(counterValue(body, GITHUB_API_HELD_METRIC, { ...ZERO_INIT_GITHUB_API_HELD_LABELS })).not.toBeNull();
    // The denominator this is read against must be present too, for the same
    // reason: a flat attempts counter means the instrument is dead, not quiet.
    expect(counterValue(body, GITHUB_API_REQUESTS_METRIC)).not.toBeNull();
  });

  it("keeps the held call out of the per-route attempt split as well", async () => {
    // `paperclip_github_api_requests_by_route_total` is the SAME attempts, split
    // by route. A held call that leaked into it would make the per-route view
    // disagree with its own total -- and it is the view an operator reaches for
    // when asking which work the exhausted budget is blocking, which is exactly
    // the question the held counter is there to answer instead.
    const reset = Math.ceil(Date.now() / 1000) + 600;
    vi.stubGlobal("fetch", vi.fn(async () => exhausted(reset)));
    await ghFetch(CORE, auth("held-c"));

    const route = { route: "repos/pulls" };
    const beforeRoute =
      counterValue((await renderMetrics()).body, GITHUB_API_REQUESTS_BY_ROUTE_METRIC, route) ?? 0;
    await ghFetch(CORE, auth("held-c"));
    const afterRoute =
      counterValue((await renderMetrics()).body, GITHUB_API_REQUESTS_BY_ROUTE_METRIC, route) ?? 0;
    expect(afterRoute - beforeRoute).toBe(0);
  });
});

const GRAPHQL = "https://api.github.com/graphql";

/**
 * GitHub's answer to a spent GraphQL primary budget: HTTP **200**, a null
 * `data`, and the refusal in `errors`. Every status-keyed signal in
 * `github-fetch.ts` was blind to this shape until PEN-6341, which is why these
 * fixtures are 200s rather than 403s.
 */
function graphQlRateLimited(resetSec: number): Response {
  return new Response(
    JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSec),
        "x-ratelimit-resource": "graphql",
      },
    },
  );
}

/**
 * A GraphQL success, deliberately carrying `x-ratelimit-remaining: 0`.
 *
 * The zero is the point. The detector consults that header before it reads a
 * body, so a fixture with headroom would be refused at the gate and the
 * negative controls below would pass without ever reaching the parser they
 * exist to pin.
 */
function graphQlOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-resource": "graphql",
    },
  });
}

describe("GraphQL reports a spent primary budget with a 200 (PEN-6341)", () => {
  it("arms the hold from a 200 carrying a RATE_LIMITED error", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => graphQlRateLimited(reset));
    vi.stubGlobal("fetch", fetchMock);

    const first = await ghFetch(GRAPHQL, auth("gql-a"));
    const held = await ghFetch(GRAPHQL, auth("gql-a"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(held.status).toBe(403);
    expect(held.headers.get("x-ratelimit-resource")).toBe("graphql");
    expect(held.headers.get("x-ratelimit-reset")).toBe(String(reset));

    // Observing the refusal must not consume it. The detector reads a CLONE,
    // so the caller still receives GitHub's own unconsumed body -- without
    // this, `ghGraphQlQuery` would report `unreadable_body` for every refusal
    // and the reason an operator sees would name the wrong failure.
    const body = await first.json();
    expect(body.errors[0].type).toBe("RATE_LIMITED");
  });

  it("holds only the graphql budget, never core on the same credential", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const fetchMock = vi.fn(async () => graphQlRateLimited(reset));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(GRAPHQL, auth("gql-b"));

    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    expect((await ghFetch(CORE, auth("gql-b"))).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hold on an ordinary GraphQL 200", async () => {
    const fetchMock = vi.fn(async () => graphQlOk({ data: { repository: { name: "paperclip" } } }));
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(GRAPHQL, auth("gql-c"));
    await ghFetch(GRAPHQL, auth("gql-c"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hold on a RESULT that merely contains the marker", async () => {
    // The control that justifies parsing the envelope instead of grepping the
    // text. GitHub will happily return our own prose back to us, and a lexical
    // match on a PR body quoting `RATE_LIMITED` would hold every GraphQL call
    // for up to an hour against a budget that was never spent -- a
    // self-inflicted outage, arriving silently.
    const fetchMock = vi.fn(async () =>
      graphQlOk({ data: { repository: { pullRequest: { body: 'we saw type: "RATE_LIMITED" yesterday' } } } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(GRAPHQL, auth("gql-d"));
    await ghFetch(GRAPHQL, auth("gql-d"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts the refusal under rate_limited, labelled graphql", async () => {
    // Same reason as its REST equivalent, because it IS the same condition;
    // `resource` is what tells an operator which budget went. That join is the
    // whole reason this needs no new label value.
    const labels = { reason: "rate_limited", resource: "graphql" };
    const read = async () =>
      counterValue((await renderMetrics()).body, GITHUB_API_REFUSALS_METRIC, labels) ?? 0;
    const before = await read();

    const reset = Math.ceil(Date.now() / 1000) + 600;
    vi.stubGlobal("fetch", vi.fn(async () => graphQlRateLimited(reset)));
    await ghFetch(GRAPHQL, auth("gql-e"));

    expect((await read()) - before).toBe(1);
  });

  it("counts, but cannot hold, a refusal carrying no rate-limit headers", async () => {
    // That GitHub sets `x-ratelimit-remaining: 0` beside the error is an
    // expectation nobody has checked against a live exhausted graphql bucket.
    // If it is wrong, the hold cannot arm -- there is no reset to trust, and
    // inventing one would shut a live budget. What must still happen is the
    // COUNT: an exhaustion this cannot hold has to stay visible, because an
    // inert detector and a healthy budget read identically.
    const labels = { reason: "rate_limited", resource: "unknown" };
    const read = async () =>
      counterValue((await renderMetrics()).body, GITHUB_API_REFUSALS_METRIC, labels) ?? 0;
    const before = await read();

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await ghFetch(GRAPHQL, auth("gql-f"));
    await ghFetch(GRAPHQL, auth("gql-f"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await read()) - before).toBe(2);
  });
});

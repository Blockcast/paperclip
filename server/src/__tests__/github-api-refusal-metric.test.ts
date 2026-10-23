/**
 * PEN-3852: the control plane's GitHub refusal instrument.
 *
 * PEN-3776 measured eight monitoring exporters sharing one GitHub App
 * installation (138085375) with the agent seats, the merge queue and the review
 * gates, and measured the consequence: an ordinary agent seat's `gh` reads came
 * back `403 API rate limit exceeded for installation ID 138085375`. PEN-3852's
 * acceptance test is that the INTERACTIVE installation never reaches that state
 * — and nothing in this process could answer that question, because `ghFetch`
 * had no rate-limit awareness of any kind.
 *
 * These tests pin the three properties that make the answer trustworthy:
 *
 *  1. Every `reason` child, and the denominator, exist AT ZERO from process
 *     start. An instrument that renders nothing when there is nothing to report
 *     cannot distinguish "zero refusals" from "no instrument", and the
 *     acceptance test is a claim of the first kind.
 *  2. A quota refusal is never classified as a permission refusal, in either
 *     direction. That merge is what makes a 403 rate uninterpretable.
 *  3. Observing the response does not disturb it. `ghFetch`'s callers read
 *     these bodies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_API_REFUSALS_METRIC,
  GITHUB_API_REQUESTS_METRIC,
  KNOWN_GITHUB_API_REFUSAL_REASONS,
  renderMetrics,
} from "../services/metrics.js";
import { classifyGithubRefusal, ghFetch } from "../services/github-fetch.js";

const URL_UNDER_TEST = "https://api.github.com/repos/o/r";

/** GitHub's real primary-exhaustion payload, as PEN-3776 recorded it. */
const RATE_LIMIT_BODY = JSON.stringify({
  message: "API rate limit exceeded for installation ID 138085375.",
  documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
});

const SECONDARY_BODY = JSON.stringify({
  message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
  documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
});

const PERMISSION_BODY = JSON.stringify({
  message: "Resource not accessible by integration",
  documentation_url: "https://docs.github.com/rest/pulls/pulls#update-a-pull-request",
});

function githubResponse(
  status: number,
  headers: Record<string, string>,
  body: string = PERMISSION_BODY,
): Response {
  // 204/304 are null-body statuses: the Response constructor rejects a body on
  // them. 304 matters here rather than being a curiosity -- it is what
  // PEN-3851's conditional requests turn an exporter's reads into, and a 304
  // must never read as a refusal.
  const nullBody = status === 204 || status === 304;
  return new Response(nullBody ? null : body, { status, headers });
}

/**
 * Read one counter series out of the rendered exposition.
 *
 * Handles the unlabelled denominator as well as the labelled refusal children,
 * because the denominator's whole job is to be readable on its own. Returns
 * null for an ABSENT series rather than 0 — the zero-init tests below turn on
 * exactly that distinction, and a helper that collapsed it would make them
 * vacuous.
 */
function counterValue(body: string, metric: string, labels?: Record<string, string>): number | null {
  for (const line of body.split("\n")) {
    if (labels) {
      if (!line.startsWith(metric + "{")) continue;
      if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    } else if (line !== metric && !line.startsWith(metric + " ")) {
      continue;
    }
    // The sample value is the last whitespace-separated field, for BOTH shapes.
    // Slicing from `}` is wrong for the unlabelled denominator -- there is no
    // brace, `lastIndexOf` returns -1, and the whole line parses as NaN. That
    // read as "series absent", which is the one thing these tests exist to
    // distinguish from zero, so the helper would have reported a live counter
    // missing.
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) return value;
  }
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyGithubRefusal — a quota refusal is never a permission refusal", () => {
  it("reads an exhausted installation budget off x-ratelimit-remaining: 0", async () => {
    // The condition PEN-3852's done-when keys on, and the one PEN-3776
    // measured refusing an agent seat mid-sweep.
    for (const status of [403, 429]) {
      await expect(
        classifyGithubRefusal(
          URL_UNDER_TEST,
          githubResponse(status, { "x-ratelimit-remaining": "0" }, RATE_LIMIT_BODY),
        ),
      ).resolves.toBe("rate_limited");
    }
  });

  it("reads the secondary mechanism off retry-after, which is a different remedy", async () => {
    // Secondary limits are abuse detection, independent of the hourly budget:
    // the caller must slow down, and no amount of capacity or isolation helps.
    // Folding them into rate_limited would send an operator to the wrong fix.
    for (const status of [403, 429]) {
      await expect(
        classifyGithubRefusal(URL_UNDER_TEST, githubResponse(status, { "retry-after": "60" }, SECONDARY_BODY)),
      ).resolves.toBe("secondary_limit");
    }
  });

  it("falls back to the body when a secondary limit carries no retry-after", async () => {
    // `retry-after` is documented but not guaranteed on every secondary limit,
    // and the gap fails in the dangerous direction: unmatched, this lands in
    // `forbidden` and silently leaves PEN-3852's acceptance test. Both
    // spellings GitHub has used are matched.
    await expect(classifyGithubRefusal(URL_UNDER_TEST, githubResponse(403, {}, SECONDARY_BODY))).resolves.toBe(
      "secondary_limit",
    );
    await expect(
      classifyGithubRefusal(
        URL_UNDER_TEST,
        githubResponse(403, {}, JSON.stringify({ message: "You have triggered an abuse detection mechanism." })),
      ),
    ).resolves.toBe("secondary_limit");
  });

  it("calls a permission 403 forbidden, never a quota refusal", async () => {
    // The contrast class, and the reason this metric is worth more than a bare
    // 403 count. `Resource not accessible by integration` is a scope problem;
    // counting it as budget exhaustion would manufacture an outage.
    await expect(classifyGithubRefusal(URL_UNDER_TEST, githubResponse(403, {}, PERMISSION_BODY))).resolves.toBe(
      "forbidden",
    );
    // Headroom remaining is still a permission problem, not a quota one.
    await expect(
      classifyGithubRefusal(URL_UNDER_TEST, githubResponse(403, { "x-ratelimit-remaining": "4821" }, PERMISSION_BODY)),
    ).resolves.toBe("forbidden");
  });

  it("prefers primary exhaustion when a response carries both signals", async () => {
    // Order is load-bearing, not incidental. A response can carry
    // x-ratelimit-remaining: 0 AND retry-after; classifying that as the
    // secondary mechanism would move a real budget refusal out of the term
    // PEN-3852's done-when tests.
    await expect(
      classifyGithubRefusal(
        URL_UNDER_TEST,
        githubResponse(403, { "x-ratelimit-remaining": "0", "retry-after": "60" }, RATE_LIMIT_BODY),
      ),
    ).resolves.toBe("rate_limited");
  });

  it("never reads a MISSING remaining header as an exhausted budget", async () => {
    // The direction that would manufacture an outage. A numeric test would do
    // exactly this -- `Number(null)` and `Number("")` are both 0 -- so the
    // comparison is a trimmed string. A 403 with no rate-limit headers at all
    // is a permission problem and must stay one.
    await expect(classifyGithubRefusal(URL_UNDER_TEST, githubResponse(403, {}, PERMISSION_BODY))).resolves.toBe(
      "forbidden",
    );
    await expect(
      classifyGithubRefusal(URL_UNDER_TEST, githubResponse(403, { "x-ratelimit-remaining": "" }, PERMISSION_BODY)),
    ).resolves.toBe("forbidden");
  });

  it("tolerates a padded remaining header from a non-spec response double", async () => {
    // A real `Headers` strips surrounding whitespace on set, so this can only
    // arrive from a hand-rolled double -- which is most of what stubs `fetch`
    // in this repo. Missing a real exhaustion is the costly direction, so the
    // trim is cheap insurance rather than theatre.
    const padded = {
      status: 403,
      headers: { get: (name: string) => (name === "x-ratelimit-remaining" ? " 0 " : null) },
    } as unknown as Response;
    await expect(classifyGithubRefusal(URL_UNDER_TEST, padded)).resolves.toBe("rate_limited");
  });

  it("treats non-refusal statuses as no refusal at all", async () => {
    // A 404 on a private repo, a 422 on a bad payload and a 500 are different
    // failures with different remedies. Folding them in would make this a
    // generic error rate that no quota question can be asked of.
    for (const status of [200, 201, 304, 404, 422, 500, 502]) {
      await expect(classifyGithubRefusal(URL_UNDER_TEST, githubResponse(status, {}))).resolves.toBeNull();
    }
  });

  it("degrades to forbidden on a response shape it cannot read, rather than throwing", async () => {
    // Suites across this repo stub `fetch` with object literals cast to
    // Response, many carrying no headers and no clone. An observer that threw
    // on those would turn an instrument into an outage in unrelated code.
    const bare = { status: 403 } as unknown as Response;
    await expect(classifyGithubRefusal(URL_UNDER_TEST, bare)).resolves.toBe("forbidden");
  });

  it("does not consume the body it inspects", async () => {
    // ghFetch's contract is that it returns the response GitHub sent. The
    // classifier reads a CLONE; if it read the original, every caller's own
    // error reporting would get an already-disturbed body.
    const response = githubResponse(403, {}, SECONDARY_BODY);
    await classifyGithubRefusal(URL_UNDER_TEST, response);
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe(SECONDARY_BODY);
  });
});

describe("the refusal instrument renders zero rather than nothing", () => {
  it("publishes every reason child at zero from process start", async () => {
    // Load-bearing, not tidiness. prom-client does not create a labelled child
    // until its first inc(), so a counter touched only on a refusal publishes
    // NO series while healthy — and `sum(increase(...))` over no series is an
    // empty vector, so PEN-3852's acceptance test would neither pass nor fail.
    // An instrument built to prove "zero refusals" must render zero when there
    // are zero.
    const { body } = await renderMetrics();
    for (const reason of KNOWN_GITHUB_API_REFUSAL_REASONS) {
      expect(counterValue(body, GITHUB_API_REFUSALS_METRIC, { reason })).not.toBeNull();
    }
  });

  it("publishes the denominator, so a flat zero is distinguishable from a dead instrument", async () => {
    const { body } = await renderMetrics();
    expect(counterValue(body, GITHUB_API_REQUESTS_METRIC)).not.toBeNull();
  });

  it("covers exactly the three reasons the classifier can return", () => {
    // Pins the closed set against the classifier rather than restating it: a
    // fourth reason added to one and not the other is a child born at 1, which
    // is the under-count the zero-init exists to prevent.
    expect([...KNOWN_GITHUB_API_REFUSAL_REASONS].sort()).toEqual([
      "forbidden",
      "rate_limited",
      "secondary_limit",
    ]);
  });
});

describe("ghFetch counts what it sends and what it is refused", () => {
  it("counts every attempt, including one that never reaches GitHub", async () => {
    // Per-attempt, not per-response. A denominator that only advanced on a
    // resolved call would freeze during exactly the network-level outage an
    // operator is reading it through — and a frozen denominator makes a zero
    // refusal count unreadable.
    const before = counterValue((await renderMetrics()).body, GITHUB_API_REQUESTS_METRIC) ?? 0;

    vi.stubGlobal("fetch", async () => githubResponse(200, {}, "{}"));
    await ghFetch(URL_UNDER_TEST);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(ghFetch(URL_UNDER_TEST)).rejects.toBeDefined();

    const after = counterValue((await renderMetrics()).body, GITHUB_API_REQUESTS_METRIC) ?? 0;
    expect(after).toBe(before + 2);
  });

  it("counts a refused call under the reason GitHub gave, and still returns the response", async () => {
    const before = counterValue((await renderMetrics()).body, GITHUB_API_REFUSALS_METRIC, {
      reason: "rate_limited",
    }) ?? 0;

    vi.stubGlobal("fetch", async () =>
      githubResponse(403, { "x-ratelimit-remaining": "0" }, RATE_LIMIT_BODY),
    );
    const response = await ghFetch(URL_UNDER_TEST);

    // The caller's response is untouched: same status, body still readable.
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("installation ID 138085375");

    const after = counterValue((await renderMetrics()).body, GITHUB_API_REFUSALS_METRIC, {
      reason: "rate_limited",
    }) ?? 0;
    expect(after).toBe(before + 1);
  });

  it("leaves the refusal counter alone on a healthy response", async () => {
    const read = async () => {
      const { body } = await renderMetrics();
      return KNOWN_GITHUB_API_REFUSAL_REASONS.map(
        (reason) => counterValue(body, GITHUB_API_REFUSALS_METRIC, { reason }) ?? 0,
      );
    };
    const before = await read();

    vi.stubGlobal("fetch", async () => githubResponse(200, { "x-ratelimit-remaining": "8582" }, "{}"));
    await ghFetch(URL_UNDER_TEST);

    expect(await read()).toEqual(before);
  });
});

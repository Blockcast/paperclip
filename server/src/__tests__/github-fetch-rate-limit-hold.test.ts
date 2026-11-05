/**
 * BLO-53662: once GitHub reports a credential's primary budget at zero, ghFetch
 * answers further calls on that credential and budget locally until the reset,
 * instead of re-firing them into the exhausted window.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetGhFetchRateLimitHoldsForTest, ghFetch } from "../services/github-fetch.js";

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

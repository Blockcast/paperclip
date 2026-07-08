import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCredentialHeaders, loadUpstreams, matchUpstream, parseUpstreamMap } from "./upstreams.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseUpstreamMap", () => {
  it("parses a simple JSON object", () => {
    const map = parseUpstreamMap(
      '{"figma":"http://figma:8000/mcp","linear":"http://linear:8000/mcp"}',
      "test",
    );
    expect(map.figma.url).toBe("http://figma:8000/mcp");
    expect(map.linear.url).toBe("http://linear:8000/mcp");
    expect(map.figma.credentialHeaders).toEqual([]);
  });

  it("parses penstock metadata with credential env-var names only", () => {
    const map = parseUpstreamMap(
      JSON.stringify({
        upstreams: [
          {
            prefix: "ccrotate",
            name: "ccrotate",
            url: "https://ccrotate.example/mcp",
            authorizationEnv: "CCROTATE_SERVE_TOKEN",
            credentialHeaderEnvNames: { "x-api-key": "CCROTATE_API_KEY" },
          },
        ],
      }),
      "test",
    );

    expect(map.ccrotate).toEqual({
      name: "ccrotate",
      url: "https://ccrotate.example/mcp",
      credentialHeaders: [
        { header: "authorization", env: "CCROTATE_SERVE_TOKEN", scheme: "Bearer" },
        { header: "x-api-key", env: "CCROTATE_API_KEY", scheme: undefined },
      ],
    });
  });

  it("rejects credential values in state metadata", () => {
    expect(() =>
      parseUpstreamMap(
        JSON.stringify({ upstreams: [{ prefix: "ccrotate", url: "https://ccrotate.example/mcp", token: "secret-value" }] }),
        "test",
      ),
    ).toThrow(/credential value/);
  });

  it("rejects non-object roots", () => {
    expect(() => parseUpstreamMap("[1,2]", "test")).toThrow(/JSON object/);
    expect(() => parseUpstreamMap('"foo"', "test")).toThrow(/JSON object/);
  });

  it("rejects empty maps", () => {
    expect(() => parseUpstreamMap("{}", "test")).toThrow(/no prefix/);
  });

  it("rejects bad prefixes", () => {
    expect(() => parseUpstreamMap('{"foo/bar":"http://x"}', "test")).toThrow(/match/);
    expect(() => parseUpstreamMap('{"my__service":"http://x"}', "test")).toThrow(/must not contain "__"/);
    expect(() => parseUpstreamMap('{"":"http://x"}', "test")).toThrow();
  });

  it("rejects bad URLs", () => {
    expect(() => parseUpstreamMap('{"a":"ftp://x"}', "test")).toThrow(/http/);
    expect(() => parseUpstreamMap('{"a":""}', "test")).toThrow(/non-empty/);
  });
});

describe("matchUpstream", () => {
  const map = {
    figma: { url: "http://figma:8000/mcp", credentialHeaders: [] },
    "k8s-admin": { url: "http://k8s:8080/mcp", credentialHeaders: [] },
  };

  it("matches the prefix and forwards to the upstream", () => {
    const m = matchUpstream("/figma/mcp", map);
    expect(m?.upstreamUrl).toBe("http://figma:8000/mcp");
  });

  it("preserves trailing path beyond /mcp", () => {
    const m = matchUpstream("/figma/mcp/extra/path", map);
    expect(m?.upstreamUrl).toBe("http://figma:8000/mcp/extra/path");
  });

  it("matches multi-segment prefixes including hyphens", () => {
    const m = matchUpstream("/k8s-admin/mcp", map);
    expect(m?.upstreamUrl).toBe("http://k8s:8080/mcp");
  });

  it("returns null for unknown prefix", () => {
    expect(matchUpstream("/unknown/mcp", map)).toBeNull();
  });

  it("returns null for root path", () => {
    expect(matchUpstream("/", map)).toBeNull();
  });
});

describe("buildCredentialHeaders", () => {
  it("injects credential values from env without storing them in config", () => {
    const headers = buildCredentialHeaders(
      {
        url: "https://ccrotate.example/mcp",
        credentialHeaders: [
          { header: "authorization", env: "CCROTATE_SERVE_TOKEN", scheme: "Bearer" },
          { header: "x-api-key", env: "CCROTATE_API_KEY" },
        ],
      },
      { CCROTATE_SERVE_TOKEN: "serve-token", CCROTATE_API_KEY: "api-key" },
    );

    expect(headers).toEqual({ authorization: "Bearer serve-token", "x-api-key": "api-key" });
  });
});

describe("loadUpstreams", () => {
  it("writes state config to last-known-good cache", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"figma":"http://figma:8000/mcp"}', { status: 200 })));

    const map = await loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "state-token",
      PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
    });

    expect(map.figma.url).toBe("http://figma:8000/mcp");
    expect(fs.readFileSync(cacheFile, "utf8")).toBe('{"figma":"http://figma:8000/mcp"}');
    expect(fetch).toHaveBeenCalledWith("https://penstock.example/mcp-upstreams", {
      headers: { accept: "application/json", authorization: "Bearer state-token" },
    });
  });

  it("falls back to last-known-good cache when penstock state is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    fs.writeFileSync(cacheFile, '{"figma":"http://cached-figma:8000/mcp"}');
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const map = await loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
    });

    expect(map.figma.url).toBe("http://cached-figma:8000/mcp");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCredentialHeaders,
  loadUpstreams,
  matchUpstream,
  parseUpstreamMap,
  upstreamsPrincipalHash,
} from "./upstreams.js";

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

  it("retains tenant-node credential key names as non-custodial metadata", () => {
    const map = parseUpstreamMap(
      JSON.stringify({
        upstreams: [{
          prefix: "github",
          execution: "tenant_node",
          routeId: "github",
          authorizationEnv: "GITHUB_TOKEN",
        }],
      }),
      "test",
      { origin: "https://relay.example", authorization: "Bearer tenant-a" },
    );

    expect(map.github).toEqual({
      url: "https://relay.example/v1/mcp/apps/github/mcp",
      execution: "tenant_node",
      routeId: "github",
      relayAuthorization: "Bearer tenant-a",
      credentialHeaders: [{ header: "authorization", env: "GITHUB_TOKEN", scheme: "Bearer" }],
    });
  });

  it("derives tenant targets from the authenticated relay and ignores registry URLs", () => {
    const map = parseUpstreamMap(
      JSON.stringify({
        upstreams: [{
          prefix: "github",
          execution: "tenant_node",
          routeId: "github",
          url: "http://169.254.169.254/latest/meta-data",
        }],
      }),
      "test",
      { origin: "https://relay.example", authorization: "Bearer tenant-a" },
    );

    expect(map.github.url).toBe("https://relay.example/v1/mcp/apps/github/mcp");
  });

  it("rejects tenant route swaps and unauthenticated relay configuration", () => {
    const payload = JSON.stringify({
      upstreams: [{ prefix: "github", execution: "tenant_node", routeId: "linear" }],
    });
    expect(() => parseUpstreamMap(payload, "test")).toThrow(/authenticated relay/);
    expect(() =>
      parseUpstreamMap(payload, "test", { origin: "https://relay.example", authorization: "Bearer tenant-a" }),
    ).toThrow(/routeId must equal/);
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
      {
        PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS: "CCROTATE_SERVE_TOKEN,CCROTATE_API_KEY",
        CCROTATE_SERVE_TOKEN: "serve-token",
        CCROTATE_API_KEY: "api-key",
      },
    );

    expect(headers).toEqual({ authorization: "Bearer serve-token", "x-api-key": "api-key" });
  });

  it("never reads or injects credential values for a tenant-node route", () => {
    const headers = buildCredentialHeaders(
      {
        url: "https://tenant-channel.example/mcp/github",
        execution: "tenant_node",
        credentialHeaders: [{ header: "authorization", env: "GITHUB_TOKEN", scheme: "Bearer" }],
      },
      { GITHUB_TOKEN: "must-stay-on-node" },
    );

    expect(headers).toEqual({});
  });

  it("rejects credential env names that are not allowlisted", () => {
    expect(() =>
      buildCredentialHeaders(
        {
          url: "https://ccrotate.example/mcp",
          credentialHeaders: [{ header: "authorization", env: "PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN", scheme: "Bearer" }],
        },
        {
          PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS: "CCROTATE_SERVE_TOKEN",
          PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "state-token",
        },
      ),
    ).toThrow(/not listed in PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS/);
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
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8"))).toEqual({
      version: 1,
      principalHash: upstreamsPrincipalHash({ PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "state-token" }),
      stateUrl: "https://penstock.example/mcp-upstreams",
      payload: '{"figma":"http://figma:8000/mcp"}',
    });
    expect(fetch).toHaveBeenCalledWith("https://penstock.example/mcp-upstreams", {
      headers: { accept: "application/json", authorization: "Bearer state-token" },
      redirect: "error",
    });
  });

  it("falls back to last-known-good cache when penstock state is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: 1,
      principalHash: upstreamsPrincipalHash({}),
      stateUrl: "https://penstock.example/mcp-upstreams",
      payload: '{"figma":"http://cached-figma:8000/mcp"}',
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    const map = await loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
    });

    expect(map.figma.url).toBe("http://cached-figma:8000/mcp");
  });

  it("rejects a last-known-good cache from a stale tenant principal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: 1,
      principalHash: upstreamsPrincipalHash({ PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "tenant-a-token" }),
      stateUrl: "https://penstock.example/mcp-upstreams",
      payload: '{"figma":"http://cached-figma:8000/mcp"}',
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "tenant-b-token",
      PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
    })).rejects.toThrow(/no last-known-good cache/);
  });

  it.each([
    "http://relay.example",
    "https://127.0.0.1",
    "https://[::1]",
    "https://relay.example:8443",
    "https://user:pass@relay.example",
    "https://relay.internal",
    "https://relay.example/nested",
  ])("rejects unsafe tenant relay origin %s before state fetch", async (origin) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "tenant-token",
      PAPERCLIP_MCP_TENANT_RELAY_ORIGIN: origin,
    })).rejects.toThrow(/public HTTPS origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to last-known-good cache when reachable state is invalid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    fs.writeFileSync(cacheFile, '{"figma":"http://cached-figma:8000/mcp"}');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ upstreams: [{ prefix: "ccrotate", url: "https://ccrotate.example/mcp", token: "secret-value" }] }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      loadUpstreams({
        PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
        PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
      }),
    ).rejects.toThrow(/credential value/);
  });

  it("rejects state credential env names that are not allowlisted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            upstreams: [
              {
                prefix: "ccrotate",
                url: "https://ccrotate.example/mcp",
                authorizationEnv: "PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      loadUpstreams({
        PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
        PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
        PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS: "CCROTATE_SERVE_TOKEN",
        PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "state-token",
      }),
    ).rejects.toThrow(/not listed in PAPERCLIP_MCP_UPSTREAM_CREDENTIAL_ENVS/);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("does not require control-plane env allowlisting for tenant-node credential keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-upstreams-"));
    const cacheFile = path.join(dir, "lkg.json");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      upstreams: [{
        prefix: "github",
        execution: "tenant_node",
        routeId: "github",
        authorizationEnv: "GITHUB_TOKEN",
      }],
    }), { status: 200 })));

    const map = await loadUpstreams({
      PAPERCLIP_MCP_UPSTREAMS_STATE_URL: "https://penstock.example/mcp-upstreams",
      PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN: "tenant-token",
      PAPERCLIP_MCP_TENANT_RELAY_ORIGIN: "https://penstock.example",
      PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE: cacheFile,
    });

    expect(map.github.execution).toBe("tenant_node");
    expect(map.github.url).toBe("https://penstock.example/v1/mcp/apps/github/mcp");
    expect(map.github.relayAuthorization).toBe("Bearer tenant-token");
  });
});

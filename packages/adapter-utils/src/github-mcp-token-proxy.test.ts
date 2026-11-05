import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROXY_HEALTH_MARKER,
  PROXY_HEALTH_PATH,
  createProxyHandler,
  mapUpstream,
  readRotatingToken,
  rewriteLocation,
  startGitHubMcpTokenProxy,
} from "./github-mcp-token-proxy.js";

// Never a credential-shaped literal in a new commit — see the fixture note in
// github-mcp-egress-shim.test.ts. These are assembled so no line of this file
// resembles a token a scanner should care about.
const GENERATION_ONE = ["token", "generation", "one"].join("-");
const GENERATION_TWO = ["token", "generation", "two"].join("-");

const temporaryDirectories: string[] = [];
const openServers: Server[] = [];

// The BLO-40279 refusal compares the token file's st_dev against
// PAPERCLIP_HOME's, and inside an agent pod TMPDIR sits on that same
// filesystem — so every fixture token here would be refused for living on the
// shared volume, and the suite would be measuring the host's mount layout
// rather than this module. Point the comparison at a path that does not exist
// (no device to compare, check skipped) for the tests that are not about it.
// The refusal itself is exercised explicitly, with PAPERCLIP_HOME set on
// purpose, in "refuses a token on the shared ... volume" below.
const NO_SHARED_VOLUME = path.join(os.tmpdir(), "paperclip-home-absent-for-tests");
let previousPaperclipHome: string | undefined;

beforeEach(() => {
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = NO_SHARED_VOLUME;
});

afterEach(async () => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paperclip-gh-mcp-token-proxy-"));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Write a token the way kubelet does: into a `..<generation>` directory, with
 * a `..data` symlink flipped at it atomically and the real name symlinked
 * through that. Rotation here must therefore be followed through two symlinks,
 * which is exactly what the live mount requires and what a naive `readFile` of
 * a cached path would miss.
 */
function writeMountGeneration(root: string, generation: string, value: string): string {
  const directory = path.join(root, `..${generation}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "token"), value);
  const staged = path.join(root, "..data_tmp");
  rmSync(staged, { force: true });
  symlinkSync(`..${generation}`, staged);
  renameSync(staged, path.join(root, "..data"));
  const visible = path.join(root, "token");
  try {
    symlinkSync("..data/token", visible);
  } catch {
    // Already linked: rotation replaces the ..data target, not this name.
  }
  return visible;
}

/** A stand-in for api.github.com that records what it was sent. */
async function startStubUpstream(
  respond: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  },
): Promise<{ origin: string; seen: { path: string; authorization?: string; method?: string }[] }> {
  const seen: { path: string; authorization?: string; method?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization, method: req.method });
    respond(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

/** Run the handler under a real socket so headers and status codes are the
 *  ones a client actually observes, not the ones a mock was told to record. */
async function startProxyUnderTest(options: Parameters<typeof createProxyHandler>[0]): Promise<string> {
  const handler = createProxyHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function get(
  origin: string,
  requestPath: string,
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(requestPath, origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path: url.pathname + url.search, method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("github MCP token proxy", () => {
  describe("mapUpstream", () => {
    it("maps the GHES REST prefix onto the dotcom API origin", () => {
      expect(mapUpstream("/api/v3/repos/o/r")).toEqual({ host: "api.github.com", path: "/repos/o/r" });
    });

    it("preserves the query string", () => {
      expect(mapUpstream("/api/v3/search/code?q=x&page=1")).toEqual({
        host: "api.github.com",
        path: "/search/code?q=x&page=1",
      });
    });

    it("maps GraphQL off the /api/v3 prefix, which it does not carry", () => {
      expect(mapUpstream("/api/graphql")).toEqual({ host: "api.github.com", path: "/graphql" });
    });

    it("maps release uploads onto the uploads origin", () => {
      expect(mapUpstream("/api/uploads/repos/o/r/releases/1/assets")).toEqual({
        host: "uploads.github.com",
        path: "/repos/o/r/releases/1/assets",
      });
    });

    it("refuses a path it does not recognise rather than forwarding it", () => {
      // The listener holds a live credential: an unrecognised path is refused,
      // never relayed somewhere the Authorization header should not go.
      expect(mapUpstream("/some/other/thing")).toBeNull();
      expect(mapUpstream("/")).toBeNull();
    });
  });

  describe("rewriteLocation", () => {
    it("brings a GitHub redirect back through the proxy", () => {
      // Otherwise the server's own client follows it direct to GitHub with the
      // stale boot-time token, which is the whole defect reached via one 302.
      expect(rewriteLocation("https://api.github.com/repositories/1", "http://127.0.0.1")).toBe(
        "http://127.0.0.1/api/v3/repositories/1",
      );
    });

    it("uses the GraphQL prefix for a GraphQL redirect", () => {
      expect(rewriteLocation("https://api.github.com/graphql", "http://127.0.0.1")).toBe(
        "http://127.0.0.1/api/graphql",
      );
    });

    it("leaves a cross-host redirect alone", () => {
      // Go strips Authorization across hosts, so these carry no credential and
      // are typically pre-signed; rewriting them would break the download.
      const raw = "https://raw.githubusercontent.com/o/r/main/f";
      expect(rewriteLocation(raw, "http://127.0.0.1")).toBe(raw);
    });

    it("passes a relative Location through untouched", () => {
      expect(rewriteLocation("/elsewhere", "http://127.0.0.1")).toBe("/elsewhere");
    });
  });

  describe("readRotatingToken", () => {
    it("follows the kubelet symlinks and strips the trailing newline", () => {
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", `${GENERATION_ONE}\n`);
      expect(readRotatingToken(file)).toEqual({ ok: true, token: GENERATION_ONE });
    });

    it("refuses an empty file instead of presenting an empty Bearer", () => {
      const root = temporaryDirectory();
      const file = path.join(root, "token");
      writeFileSync(file, "\n");
      const result = readRotatingToken(file);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("empty");
    });

    it("refuses a file that is not readable", () => {
      const result = readRotatingToken(path.join(temporaryDirectory(), "absent"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("not readable");
    });

    it("refuses a token on the shared, agent-writable volume (BLO-40279)", () => {
      // Every agent uid can write there, so a readable file proves nothing
      // about who put it there. Same device => same refusal.
      const root = temporaryDirectory();
      const file = path.join(root, "token");
      writeFileSync(file, GENERATION_ONE);
      process.env.PAPERCLIP_HOME = root;
      const result = readRotatingToken(file);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("shared");
    });
  });

  describe("forwarding", () => {
    it("replaces the Authorization header with the live mount on every request", async () => {
      const upstream = await startStubUpstream();
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      await get(proxy, "/api/v3/user");
      expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${GENERATION_ONE}`);
    });

    it("picks up a rotation between two requests with no restart (PEN-5641)", async () => {
      // The whole defect in one assertion: the process serving both requests is
      // the same, and the second carries the generation written after the first.
      const upstream = await startStubUpstream();
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      await get(proxy, "/api/v3/user");
      writeMountGeneration(root, "gen2", GENERATION_TWO);
      await get(proxy, "/api/v3/user");

      expect(upstream.seen.map((entry) => entry.authorization)).toEqual([
        `Bearer ${GENERATION_ONE}`,
        `Bearer ${GENERATION_TWO}`,
      ]);
    });

    it("overwrites a client-supplied Authorization rather than honouring it", async () => {
      const upstream = await startStubUpstream();
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      const url = new URL("/api/v3/user", proxy);
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "GET",
            headers: { authorization: "Bearer a-stale-generation" },
          },
          (res) => { res.resume(); res.on("end", () => resolve()); },
        );
        req.on("error", reject);
        req.end();
      });
      expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${GENERATION_ONE}`);
    });

    it("answers the health path with its marker", async () => {
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file });
      const response = await get(proxy, PROXY_HEALTH_PATH);
      expect(response.status).toBe(200);
      expect(response.body).toBe(PROXY_HEALTH_MARKER);
    });

    it("reports an unreadable mount as 503, never as a 401", async () => {
      // A credential that was never presented is not GitHub refusing one.
      // Collapsing the two is the conflation PEN-5241 exists to end.
      const upstream = await startStubUpstream();
      const root = temporaryDirectory();
      const file = path.join(root, "token");
      writeFileSync(file, "");
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      const response = await get(proxy, "/api/v3/user");
      expect(response.status).toBe(503);
      expect(response.body).toContain("empty");
      expect(upstream.seen).toHaveLength(0);
    });

    it("refuses an unmapped path without contacting upstream", async () => {
      const upstream = await startStubUpstream();
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      const response = await get(proxy, "/not/a/github/path");
      expect(response.status).toBe(404);
      expect(upstream.seen).toHaveLength(0);
    });

    it("relays the upstream status and body unchanged", async () => {
      const upstream = await startStubUpstream((_req, res) => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end('{"message":"Resource not accessible by integration"}');
      });
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const proxy = await startProxyUnderTest({ tokenFile: file, apiOrigin: upstream.origin });

      const response = await get(proxy, "/api/v3/user");
      expect(response.status).toBe(403);
      expect(response.body).toContain("not accessible by integration");
    });
  });

  describe("startGitHubMcpTokenProxy", () => {
    it("is disabled by the operator kill switch", async () => {
      // Off must restore the pre-PEN-5641 behaviour exactly, so that turning
      // the proxy off is cheaper than rolling back an image.
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const previous = process.env.PAPERCLIP_GITHUB_MCP_TOKEN_PROXY;
      process.env.PAPERCLIP_GITHUB_MCP_TOKEN_PROXY = "0";
      try {
        await expect(
          startGitHubMcpTokenProxy({ tokenFile: file, port: 0, notify: () => {} }),
        ).resolves.toBeNull();
      } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_GITHUB_MCP_TOKEN_PROXY;
        else process.env.PAPERCLIP_GITHUB_MCP_TOKEN_PROXY = previous;
      }
    });

    it("stays out of the way when the credential is an env binding", async () => {
      // GH_SEAT_TOKEN_VALUE does not rotate, so there is nothing to re-read and
      // the proxy would add a hop for nothing.
      const previous = process.env.GH_SEAT_TOKEN_VALUE;
      process.env.GH_SEAT_TOKEN_VALUE = GENERATION_ONE;
      try {
        await expect(startGitHubMcpTokenProxy({ notify: () => {} })).resolves.toBeNull();
      } finally {
        if (previous === undefined) delete process.env.GH_SEAT_TOKEN_VALUE;
        else process.env.GH_SEAT_TOKEN_VALUE = previous;
      }
    });

    it("fails open when there is no token to serve", async () => {
      // Returning null leaves GITHUB_HOST unset and the server behaves exactly
      // as it did before. Failing closed would turn a stale-credential bug into
      // a total outage of every mcp__github__* tool.
      const messages: string[] = [];
      const handle = await startGitHubMcpTokenProxy({
        tokenFile: path.join(temporaryDirectory(), "absent"),
        notify: (message) => messages.push(message),
      });
      expect(handle).toBeNull();
      expect(messages.join(" ")).toContain("not readable");
    });

    it("binds a loopback port and reports a portless GITHUB_HOST", async () => {
      // ghHost deliberately carries no port: the upstream server DISCARDS the
      // port from GITHUB_HOST (measured on v1.0.3), which is why the real
      // listener has to take :80. `port` is overridable here only so the suite
      // does not contend for a privileged port.
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);
      const handle = await startGitHubMcpTokenProxy({ tokenFile: file, port: 0, notify: () => {} });
      expect(handle).not.toBeNull();
      expect(handle?.ghHost).toBe("http://127.0.0.1");
      await handle?.close();
    });

    it("never adopts a port it does not own, even one answering the health marker (PEN-5641)", async () => {
      // The important finding on PR #3410. Adoption was justified by the proxy
      // holding no per-session state, but the hazard is LIFETIME, not state:
      // the listener is unref'd inside its owner's process, so when the owning
      // MCP server exits the port vanishes while every adopter still has
      // GITHUB_HOST baked into its spawn environment — ECONNREFUSED for the
      // rest of its session, and then any local process that binds the freed
      // port receives those requests with the adopter's boot-time
      // GITHUB_PERSONAL_ACCESS_TOKEN in cleartext. Failing open costs the
      // second server its rotation coverage; adopting costs a credential.
      const root = temporaryDirectory();
      const file = writeMountGeneration(root, "gen1", GENERATION_ONE);

      // A first proxy, holding the port and answering the marker exactly as a
      // genuine sibling would — this is the case adoption used to accept.
      const first = await startGitHubMcpTokenProxy({ tokenFile: file, port: 0, notify: () => {} });
      expect(first).not.toBeNull();
      const heldPort = first?.port ?? 0;

      // Confirm the fixture really is one of ours, so the test is exercising
      // the adoption branch and not merely an unrelated-listener refusal.
      const probe = await new Promise<string>((resolve) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: heldPort, path: PROXY_HEALTH_PATH, method: "GET" },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c: string) => { text += c; });
            res.on("end", () => resolve(text.trim()));
          },
        );
        req.on("error", () => resolve(""));
        req.end();
      });
      expect(probe).toBe(PROXY_HEALTH_MARKER);

      const messages: string[] = [];
      const second = await startGitHubMcpTokenProxy({
        tokenFile: file,
        port: heldPort,
        notify: (message) => messages.push(message),
      });

      // Fail open: no handle, so the caller leaves GITHUB_HOST unset and the
      // child keeps working against its boot credential.
      expect(second).toBeNull();
      expect(messages.join(" ")).toContain("already bound");
      expect(messages.join(" ")).not.toContain("reusing");

      await first?.close();
    });
  });
});

// PEN-5641: give the `github` MCP server a credential that rotates.
//
// `gh` and the git credential helper both re-read $PAPERCLIP_GITHUB_TOKEN_FILE
// on EVERY invocation, so they pick up each kubelet rotation of the mounted
// GitHub App installation token. `github-mcp-server` cannot: it is an upstream
// Go binary that reads GITHUB_PERSONAL_ACCESS_TOKEN once at startup, and it is
// long-lived — one process spans a whole agent session, across several
// rotations (the rotator re-mints every 20 minutes). Once the mount turns over,
// the server keeps presenting the generation it booted with, indefinitely, with
// no self-heal and no error that says so.
//
// The observable shape of that, measured 2026-11-05T04:49Z, is the reason this
// exists: `curl` on a URL returned 200 while `mcp__github__*` on the identical
// URL returned `401 Bad credentials`, and `gh paperclip-auth-check` reported
// `OK` throughout — the fleet's designated credential oracle saying healthy
// while the agent's tooling said Bad credentials. That is PEN-5241's
// non-diagnostic 401 reintroduced through a second channel.
//
// ## Why a proxy rather than re-exec-ing the server
//
// The obvious fix — watch the mount and restart the child on rotation — is not
// available at the only layer that owns the child. github-mcp-egress-runtime.ts
// spawns the server with stdout and stderr INHERITED, deliberately: responses
// travel from the server to the client without passing through that process at
// all, which is a property of the process topology rather than a claim about
// the code. A restart needs the `initialize` handshake replayed and in-flight
// request ids reconciled, and both require reading the response leg. Buying
// token rotation by putting a parser on the inbound leg would spend a security
// property to fix an availability bug.
//
// So the credential is refreshed one layer lower, on the HTTP leg, where the
// server already has a supported seam: `GITHUB_HOST`. Pointed at this loopback
// listener, the server emits ordinary GitHub Enterprise-shaped requests to
// `/api/v3/...`, and this process rewrites the `Authorization` header from the
// live mount on every single one. The server's own
// GITHUB_PERSONAL_ACCESS_TOKEN becomes inert — it is overwritten before the
// request leaves the pod — so a stale generation in its environment cannot
// reach GitHub.
//
// ## The port is not a choice
//
// `GITHUB_HOST` is parsed by the upstream server with the port DISCARDED:
// `http://127.0.0.1:41487` produces requests to `http://127.0.0.1/api/v3/...`
// (measured against v1.0.3). There is therefore no port to pick — the listener
// must answer on :80 of a loopback address or not at all. That works in the
// agent pod because `net.ipv4.ip_unprivileged_port_start` is 0, and it is
// checked rather than assumed: a bind failure disables the proxy and leaves the
// previous behaviour exactly as it was.
//
// ## No adoption: one proxy per server, owned for that server's whole life
//
// An earlier revision adopted an already-bound :80 when a health probe showed
// the listener was one of ours, reasoning that the proxy holds no per-session
// state. The flaw is not state, it is LIFETIME. The listener lives inside its
// owner's runtime process and is unref'd, so when the owning MCP server exits
// the port goes away — while every adopting server still has
// `GITHUB_HOST=http://127.0.0.1` baked into the environment it was spawned
// with. From that moment its every call fails ECONNREFUSED for the rest of the
// session, which is WORSE than the defect this module fixes (that at least
// works until the first rotation), and fail-open cannot rescue it because
// GITHUB_HOST was exported at spawn and is never re-read.
//
// The second-order consequence is the one that settles it: once the port is
// free, ANY local process may bind `127.0.0.1:80` and will then receive the
// adopters' requests — carrying their boot-time GITHUB_PERSONAL_ACCESS_TOKEN
// in cleartext, because the inert credential is only inert while OUR listener
// is the one overwriting it. A credential-disclosure path is not a trade worth
// making for a second server's rotation coverage.
//
// So a bound port is never adopted. The cost is explicit and accepted: when a
// pod runs more than one GitHub MCP server, the first gets rotation coverage
// and the others keep the credential they booted with, exactly as they did
// before this module existed. Giving every server its own proxy means giving
// each a distinct loopback address (all of 127/8 is on `lo`, and upstream
// `parseAPIHost` treats any such host as GHES) — tracked as follow-up work,
// because it also requires `gh paperclip-auth-check` to report per-server
// coverage rather than a single URL.
//
// ## Fail-open, loudly
//
// If the proxy cannot start, the caller leaves GITHUB_HOST unset and the server
// runs as it does today — wedging on rotation, which is a bug but is also the
// status quo. Failing CLOSED here would turn a stale-credential bug into a
// total outage of every `mcp__github__*` tool, which is strictly worse and is
// not a trade this defect justifies. The condition is reported on stderr and is
// visible to `gh paperclip-auth-check`, which probes this listener and says
// plainly whether the MCP path is covered.

import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, statSync } from "node:fs";

/** Loopback address the proxy binds. Never a routable interface: this listener
 *  attaches the live installation token to whatever reaches it. */
export const PROXY_BIND_ADDRESS = "127.0.0.1";

/** Forced by the upstream server dropping the port from GITHUB_HOST. */
export const PROXY_PORT = 80;

/**
 * Liveness path, served before any upstream mapping.
 *
 * `gh paperclip-auth-check` needs to distinguish "something is listening on
 * loopback :80" from "the MCP token proxy is listening", because the verdict it
 * prints about the `mcp__github__*` channel turns on which one is true. An
 * unrelated listener answering 404 here is not this proxy, and the check says
 * so rather than reporting the MCP path as covered.
 */
export const PROXY_HEALTH_PATH = "/__paperclip/github-mcp-token-proxy";

/** Marker body for PROXY_HEALTH_PATH. Carries no credential material. */
export const PROXY_HEALTH_MARKER = "paperclip-github-mcp-token-proxy";

const DEFAULT_TOKEN_FILE = "/etc/paperclip/secrets/github-token/token";

/**
 * Upstream hosts this proxy will forward to, keyed by the GHES-shaped prefix
 * the server emits. An allowlist rather than a pass-through: the listener holds
 * a live credential, so a path it does not recognise is refused instead of
 * being forwarded somewhere the Authorization header should never go.
 */
const UPSTREAM_API = "api.github.com";
const UPSTREAM_UPLOADS = "uploads.github.com";

/**
 * Headers that belong to a single hop and must not be relayed. Forwarding
 * `connection`/`transfer-encoding` across a proxy boundary is how a relay ends
 * up framing a response differently from the way it received it.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface GitHubMcpTokenProxyOptions {
  /** Defaults to $PAPERCLIP_GITHUB_TOKEN_FILE, then the mount path. */
  tokenFile?: string;
  /** Overridden only by tests, which cannot bind :80 concurrently. */
  port?: number;
  bindAddress?: string;
  /** Upstream origins, overridden by tests to point at a local stub. */
  apiOrigin?: string;
  uploadsOrigin?: string;
  /** Where diagnostics go. Never receives credential material. */
  notify?: (message: string) => void;
}

export interface GitHubMcpTokenProxyHandle {
  /** Value to export as GITHUB_HOST for the MCP server child. */
  ghHost: string;
  port: number;
  close(): Promise<void>;
}

/** Result of reading the rotating mount, as a value so refusals can be served
 *  as a diagnosable status rather than thrown into a request handler. */
type TokenRead = { ok: true; token: string } | { ok: false; reason: string };

/**
 * Read the live token, applying the same refusals the shell wrappers apply.
 *
 * This is the whole point of the proxy, so it happens per request and is never
 * memoised: a cached read here would reproduce the defect one layer down.
 *
 * The shared-volume refusal is BLO-40279's and is reproduced rather than
 * relaxed — every agent uid can write /paperclip, so a readable token file on
 * that device proves nothing about who put it there. Compared by device rather
 * than by path prefix because symlinks and pinned paths reach the same
 * filesystem. A Secret mounted *under* the volume has its own tmpfs device and
 * still passes.
 */
export function readRotatingToken(tokenFile: string): TokenRead {
  let raw: string;
  try {
    raw = readFileSync(tokenFile, "utf8");
  } catch {
    return { ok: false, reason: `token file is not readable: ${tokenFile}` };
  }

  const shared = process.env.PAPERCLIP_HOME || "/paperclip";
  try {
    const sharedDev = statSync(shared).dev;
    const fileDev = statSync(tokenFile).dev;
    if (sharedDev === fileDev) {
      return {
        ok: false,
        reason: `token file is on the shared ${shared} volume, which every agent can write; refusing to use it as a credential`,
      };
    }
  } catch {
    // No shared volume present (or unreadable): nothing to compare against, so
    // there is no shared-volume finding to make. A missing /paperclip is the
    // normal case outside an agent pod.
  }

  const token = raw.replace(/[\r\n]/g, "");
  if (token.trim() === "") return { ok: false, reason: `token file is empty: ${tokenFile}` };
  return { ok: true, token };
}

/**
 * Map a GHES-shaped request path onto a dotcom origin and path.
 *
 * The server builds `<GITHUB_HOST>/api/v3/<rest>` for REST, `/api/graphql` for
 * GraphQL and `/api/uploads/<rest>` for release uploads. On dotcom those are
 * three different origins, which is why this returns the host as well as the
 * path. Anything else returns null and is refused.
 */
export function mapUpstream(
  requestPath: string,
  origins: { api: string; uploads: string } = { api: UPSTREAM_API, uploads: UPSTREAM_UPLOADS },
): { host: string; path: string } | null {
  if (requestPath === "/api/graphql" || requestPath.startsWith("/api/graphql?")) {
    return { host: origins.api, path: `/graphql${requestPath.slice("/api/graphql".length)}` };
  }
  if (requestPath === "/api/uploads" || requestPath.startsWith("/api/uploads/")) {
    return { host: origins.uploads, path: requestPath.slice("/api/uploads".length) || "/" };
  }
  if (requestPath === "/api/v3" || requestPath.startsWith("/api/v3/") || requestPath.startsWith("/api/v3?")) {
    return { host: origins.api, path: requestPath.slice("/api/v3".length) || "/" };
  }
  return null;
}

/**
 * Rewrite a redirect that points back at GitHub so the follow-up request comes
 * through this proxy too.
 *
 * Without this, a 3xx to an absolute `https://api.github.com/...` would be
 * followed by the server's own HTTP client, direct to GitHub, carrying the
 * stale GITHUB_PERSONAL_ACCESS_TOKEN it booted with — the exact failure this
 * module removes, reachable again through one redirect. Redirects to any OTHER
 * host (raw.githubusercontent.com, codeload) are left alone: Go's client strips
 * Authorization on a cross-host redirect, so those carry no credential and are
 * typically pre-signed anyway.
 */
export function rewriteLocation(location: string, selfOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    // Relative Location: already resolves against this proxy's origin.
    return location;
  }
  if (parsed.hostname === UPSTREAM_API) {
    const prefix = parsed.pathname.startsWith("/graphql") ? "/api" : "/api/v3";
    return `${selfOrigin}${prefix}${parsed.pathname}${parsed.search}`;
  }
  if (parsed.hostname === UPSTREAM_UPLOADS) {
    return `${selfOrigin}/api/uploads${parsed.pathname}${parsed.search}`;
  }
  return location;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function refuse(res: ServerResponse, status: number, message: string): void {
  // Shaped like a GitHub error body so the server surfaces `message` to the
  // agent instead of a parse failure. The agent then reads the actual fault —
  // "token file is empty" — rather than another undiagnosable 401.
  const body = JSON.stringify({ message: `paperclip-github-mcp-token-proxy: ${message}` });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Build the request handler. Exported so tests can exercise the forwarding
 * rules against a stub origin without binding the privileged port.
 */
/**
 * A browser cannot be prevented from reaching a loopback listener, so the
 * listener decides what it answers. Only the Go MCP client is served: it sends
 * `Host: 127.0.0.1` (the address it was handed in GITHUB_HOST, port discarded)
 * and no browser-origin headers. Anything presenting a different Host has been
 * rebound onto us, and anything carrying Origin / Sec-Fetch-Site is a browser
 * request regardless of what it claims.
 */
export function isTrustedLoopbackClient(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== "string") return false;
  const hostname = host.split(":")[0];
  if (hostname !== PROXY_BIND_ADDRESS) return false;
  // Present on every browser-issued request, including cross-origin "simple"
  // ones that carry no preflight. The Go client sends neither.
  if (req.headers.origin !== undefined) return false;
  if (req.headers["sec-fetch-site"] !== undefined) return false;
  return true;
}

export function createProxyHandler(options: GitHubMcpTokenProxyOptions = {}) {
  const tokenFile =
    options.tokenFile || process.env.PAPERCLIP_GITHUB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const apiOrigin = options.apiOrigin ?? `https://${UPSTREAM_API}`;
  const uploadsOrigin = options.uploadsOrigin ?? `https://${UPSTREAM_UPLOADS}`;

  const api = new URL(apiOrigin);
  const uploads = new URL(uploadsOrigin);
  const origins = { api: api.host, uploads: uploads.host };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestPath = req.url ?? "/";

    // This listener attaches a live write-scoped installation token to
    // anything that reaches loopback :80, and agent pods run a headless
    // browser in the same network namespace. A DNS-rebound page
    // (Host: attacker.example resolving to 127.0.0.1) or a cross-origin
    // "simple" request would otherwise be relayed with the Bearer attached —
    // a confused deputy holding the fleet credential. Current Chrome's
    // local-network-access checks probably block both, but "probably" and
    // "this browser version" are not the footing a credential belongs on.
    //
    // The Go client sends neither header, so refusing both costs nothing:
    // a request is forwarded only when its Host is the loopback address we
    // bound and it carries no browser-origin marking at all.
    if (!isTrustedLoopbackClient(req)) {
      refuse(res, 403, "refusing a request that did not come from the local MCP server");
      return;
    }

    if (requestPath === PROXY_HEALTH_PATH) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(PROXY_HEALTH_MARKER);
      return;
    }

    const target = mapUpstream(requestPath, origins);
    if (!target) {
      refuse(res, 404, `refusing to forward an unrecognised path (${requestPath.split("?")[0]})`);
      return;
    }

    const token = readRotatingToken(tokenFile);
    if (!token.ok) {
      // 503, not 401: the credential was never presented, so this is not
      // GitHub refusing it. Collapsing "we could not read the mount" into the
      // same 401 GitHub returns for a revoked token is the exact conflation
      // PEN-5241 exists to end.
      refuse(res, 503, token.reason);
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      refuse(res, 400, "client request body could not be read");
      return;
    }

    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === "host" || lower === "authorization" || lower === "content-length") continue;
      headers[lower] = value;
    }
    headers.host = target.host;
    // Unconditional, and after the copy loop above on purpose: the whole
    // contract is that whatever credential the server holds is replaced by the
    // live one. A conditional assignment would let a stale generation through
    // on any request the server chose to authenticate itself.
    headers.authorization = `Bearer ${token.token}`;
    if (body.length > 0) headers["content-length"] = String(body.length);

    const isTls = (target.host === origins.api ? api.protocol : uploads.protocol) === "https:";
    const doRequest = isTls ? httpsRequest : httpRequest;
    const selfOrigin = `http://${PROXY_BIND_ADDRESS}`;

    const upstream = doRequest(
      { host: target.host.split(":")[0], port: target.host.split(":")[1], path: target.path, method: req.method, headers },
      (upstreamRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value === undefined) continue;
          if (HOP_BY_HOP.has(name.toLowerCase())) continue;
          outHeaders[name] = value;
        }
        const location = upstreamRes.headers.location;
        if (typeof location === "string") outHeaders.location = rewriteLocation(location, selfOrigin);
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", (error: NodeJS.ErrnoException) => {
      // A transport failure is a different fact from any status GitHub
      // returned, and must not be dressed up as one.
      refuse(res, 502, `upstream request failed (${error.code ?? "unknown"})`);
    });

    if (body.length > 0) upstream.write(body);
    upstream.end();
  };
}

/**
 * Start a proxy this process owns for its whole life.
 *
 * Returns null when the proxy is not applicable or cannot start — the caller
 * then leaves GITHUB_HOST alone. See the fail-open note in the module header.
 *
 * A bound port is NEVER adopted, even when the health marker says it is one of
 * ours. See the "no adoption" note in the module header: a listener this
 * process does not own can disappear underneath it.
 */
export async function startGitHubMcpTokenProxy(
  options: GitHubMcpTokenProxyOptions = {},
): Promise<GitHubMcpTokenProxyHandle | null> {
  const notify = options.notify ?? ((message: string) => console.error(`paperclip-github-mcp-token-proxy: ${message}`));
  const bindAddress = options.bindAddress ?? PROXY_BIND_ADDRESS;
  const port = options.port ?? PROXY_PORT;

  // An operator kill switch, and the reason it exists rather than requiring a
  // rollback: this proxy inserts itself into the only path the MCP GitHub
  // tools have to GitHub. If it ever misbehaves, turning it off must be
  // cheaper than shipping an image. Off restores exactly the pre-PEN-5641
  // behaviour — the server keeps the credential it booted with, and
  // `gh paperclip-auth-check` reports the MCP channel as NOT COVERED.
  //
  // It is also what the test suites set, so a suite running inside an agent
  // pod — where the real mount exists and :80 is bindable — does not contend
  // for the port or start a listener holding a live credential.
  const toggle = process.env.PAPERCLIP_GITHUB_MCP_TOKEN_PROXY;
  if (toggle === "0" || toggle === "off" || toggle === "false") {
    notify("disabled by PAPERCLIP_GITHUB_MCP_TOKEN_PROXY");
    return null;
  }

  // GH_SEAT_TOKEN_VALUE is an agent-scoped binding delivered in the
  // environment, not a rotating mount. There is no file to re-read and nothing
  // to rotate, so the server's inherited credential is already correct for the
  // life of the process and the proxy would add a hop for nothing.
  if (process.env.GH_SEAT_TOKEN_VALUE !== undefined) return null;

  const tokenFile =
    options.tokenFile || process.env.PAPERCLIP_GITHUB_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const initial = readRotatingToken(tokenFile);
  if (!initial.ok) {
    // Nothing to serve. The wrappers already refuse loudly for this case; the
    // proxy staying out of the way keeps that refusal the one the agent sees.
    notify(`not started: ${initial.reason}`);
    return null;
  }

  const handler = createProxyHandler({ ...options, tokenFile });
  const server: Server = createServer((req, res) => {
    // A rejected handler must still answer: an unanswered request leaves the
    // MCP server blocked on a socket rather than reporting a tool failure.
    void handler(req, res).catch(() => {
      if (res.headersSent) res.end();
      else refuse(res, 500, "proxy failed to handle the request");
    });
  });

  const listened = await new Promise<"ok" | "in-use" | "failed">((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE" ? "in-use" : "failed");
      notify(
        error.code === "EADDRINUSE"
          ? `${bindAddress}:${port} is already bound`
          : `cannot bind ${bindAddress}:${port} (${error.code ?? "unknown"}); the MCP GitHub tools will keep the credential they start with and will NOT survive a token rotation (PEN-5641)`,
      );
    });
    server.listen(port, bindAddress, () => resolve("ok"));
  });

  if (listened === "ok") {
    // Do not hold the event loop open on the proxy's account: the runtime's
    // lifetime is the child server's, and an unref'd listener lets the process
    // exit when that child does.
    server.unref();
    // Report the port actually bound, not the one requested: with port 0 the
    // kernel assigns an ephemeral one, and a handle that echoed the request
    // back would name a port nothing is listening on. Production always asks
    // for :80, where the two coincide, so only tests exercise the difference.
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    return {
      ghHost: `http://${bindAddress}`,
      port: boundPort,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  if (listened === "in-use") {
    // Deliberately not adopted, not even when the health marker says the
    // listener is one of ours. See "no adoption" in the module header.
    notify(
      `${bindAddress}:${port} is already bound, so this server gets no proxy; it will keep the credential it starts with and will NOT survive a token rotation (PEN-5641)`,
    );
  }
  return null;
}

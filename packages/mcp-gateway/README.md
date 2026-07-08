# @paperclipai/mcp-gateway

Reverse-proxy in front of the cluster's stateful HTTP MCP servers.
Catches `Session not found` 404s from upstreams and transparently
replays the cached `initialize` request to mint a fresh upstream
session before retrying the original call. Claude Code's MCP client
doesn't auto-retry on this — the next tool call surfaces the failure
to the user otherwise. The client side never sees the upstream rotation;
its `Mcp-Session-Id` stays stable.

## Why

Streamable HTTP MCP (proto 2025-03-26) is stateful. Servers GC sessions
aggressively when idle (the `figma-mcp-server` we saw was closing on
the order of every few minutes). The Claude Code SDK does not auto-
recover. Real incident 2026-05-08 — figma drops requiring a manual
`/mcp` reload before each batch of tool calls.

Per-MCP sidecars would also work but add operational footprint.
A single multi-tenant gateway routes by path prefix
(`/figma/mcp`, `/linear/mcp`, etc.) and keeps one place to evolve
session keepalive, observability, and rate limiting.

## Configuration

Routing table is JSON: `prefix → upstream URL`. Either pass inline:

```sh
PAPERCLIP_MCP_UPSTREAMS='{"figma":"http://figma-mcp-server.paperclip.svc:8000/mcp"}' \
  node dist/server.js
```

…or via a file:

```sh
PAPERCLIP_MCP_UPSTREAMS_FILE=/config/upstreams.json node dist/server.js
```

Prefix must match `/^[a-zA-Z0-9_-]+$/`. URL must start with
`http://` or `https://`.

### Figma Credential Custody

The `/figma` prefix can be wired to Penstock's MCP app lease and server-side
credential custody path. Callers authenticate to the gateway with their
Penstock bearer; the gateway uses that bearer only for the Penstock control
plane calls, resolves the leased `credential_ref` server-side, and forwards
only the resolved Figma authorization header plus MCP/content negotiation
headers to the upstream Figma MCP server.

```sh
PAPERCLIP_MCP_FIGMA_LEASE_URL=https://proxy.example/v1/mcp-apps/leases \
PAPERCLIP_MCP_FIGMA_CREDENTIAL_BASE_URL=https://proxy.example/v1/authbot/mcp-credentials \
PAPERCLIP_MCP_UPSTREAMS='{"figma":"http://figma-mcp-server.paperclip.svc:8000/mcp"}' \
  node dist/server.js
```

Optional knobs:

- `PAPERCLIP_MCP_FIGMA_LEASE_TTL_MS` — lease TTL, default `3600000`.
- `PAPERCLIP_MCP_FIGMA_LEASE_MODE` — `exclusive` by default; may be `shared`.
- `PAPERCLIP_MCP_FIGMA_UPSTREAM_AUTH_SCHEME` — upstream auth scheme, default `Bearer`.
- `PAPERCLIP_MCP_FIGMA_TOKEN_CACHE_MAX_ENTRIES` — max in-memory custodied token cache entries, default `4096`; oldest entries evict first.

If only one of the Figma custody URLs is configured, startup fails. If custody
is configured and a request lacks caller authorization or Penstock cannot lease
or resolve the credential, the gateway fails closed and does not contact the
Figma upstream.

Resolved Figma tokens are cached in-memory per stable MCP session and caller
authorization for most of the configured lease TTL. The cache avoids repeated
exclusive lease acquisition during ordinary session traffic and is invalidated
when the upstream Figma server returns `401`. Cache keys hash caller authorization
values instead of storing raw caller bearer tokens.

## Endpoints

- `GET /healthz` — health check; returns `{ ok: true, upstreams, sessions }`.
- `GET /` — same as `/healthz`.
- `<METHOD> /<prefix>/mcp` — proxied to the upstream URL for `<prefix>`.
- `<METHOD> /<prefix>/mcp/<rest...>` — preserves the trailing path.

## Migrating an agent

1. Find the agent's `adapter_config.mcpServers.<name>.url`. Example:
   ```json
   "figma": { "url": "http://figma-mcp-server.paperclip.svc.cluster.local:8000/mcp", "type": "http" }
   ```
2. Replace it with the gateway URL using the configured prefix:
   ```json
   "figma": { "url": "http://paperclip-mcp-gateway.paperclip.svc.cluster.local:8080/figma/mcp", "type": "http" }
   ```
3. Save (no agent restart needed; mcp config is read on next run).

## Limits and known issues

- **Session cache is in-memory.** Gateway restart loses all sessions.
  Clients re-initialize transparently — graceful failure mode.
- **Initialize replay assumes the upstream is idempotent on init.**
  If the upstream's `initialize` mutates external state (rare for MCP),
  replay can double-fire. Figma / Linear / k8s / prometheus / webflow
  all have stateless initialize handlers.
- **No persistent state.** Per-prefix session maps live in the pod's
  RAM and are scoped to that gateway replica. If you scale to >1
  replica, sessions affinity-stick to the replica that handled the
  initialize. Either run `replicas: 1` or wire up sessionAffinity:
  ClientIP + Mcp-Session-Id (custom header LB).

## Test

```sh
pnpm test
```

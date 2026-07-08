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

Production routing is identity-synced from penstock state:

```sh
PAPERCLIP_MCP_UPSTREAMS_STATE_URL=https://api.penstock.run/v1/mcp/upstreams \
PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN="$STATE_TOKEN" \
PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE=/cache/upstreams-lkg.json \
  node dist/server.js
```

The state response may be either a legacy `prefix -> URL` object or metadata:

```json
{
  "upstreams": [
    {
      "prefix": "ccrotate",
      "name": "ccrotate",
      "url": "http://ccrotate-mcp-server.paperclip.svc.cluster.local:8000/mcp",
      "authorizationEnv": "CCROTATE_SERVE_TOKEN"
    }
  ]
}
```

Credential values are not valid state. State may only name the gateway env var
that holds a credential. Kubernetes Secrets remain the source of truth for those
values; the gateway injects them as upstream headers at request time. A state
payload containing fields such as `token`, `secret`, `password`, or `apiKey` is
rejected before serving.

When state fetch succeeds, the raw metadata is persisted to
`PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE`. If the control plane is unavailable on a
later startup, the gateway serves the last-known-good cache instead of losing all
routes.

For local development and bootstrap, routing table JSON is still supported:

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

## Endpoints

- `GET /healthz` — health check; returns `{ ok: true, upstreams, upstreamCallCounts, breakers, sessions }`.
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

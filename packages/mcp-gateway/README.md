# @paperclipai/mcp-gateway

Reverse-proxy in front of the cluster's stateful HTTP MCP servers. It exposes
one logical aggregate MCP endpoint at `/mcp`, rewrites aggregated tool names back
to the correct upstream server, and catches `Session not found` 404s from
upstreams by transparently replaying the cached `initialize` request. Claude
Code's MCP client doesn't auto-retry on this; the client side never sees the
upstream rotation and its `Mcp-Session-Id` stays stable.

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

Fleet clients should prefer one server URL:

```json
{
  "paperclip-fleet": { "url": "http://paperclip-mcp-gateway.paperclip.svc.cluster.local:8080/mcp", "type": "http" }
}
```

The gateway returns one aggregated `tools/list` result. To make collisions stable
and readable, tool names are rewritten as `<prefix>__<toolName>` (for example
`figma__get_file`). `tools/call` reverses that name before forwarding the call to
the matching upstream. The old `/<prefix>/mcp` endpoints remain available for
compatibility and migration.

## Configuration

Production routing is identity-synced from penstock state:

```sh
PAPERCLIP_MCP_UPSTREAMS_STATE_URL=https://api.penstock.run/v1/mcp/upstreams \
PAPERCLIP_MCP_UPSTREAMS_STATE_TOKEN="$STATE_TOKEN" \
PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE=/cache/upstreams-lkg.json \
PAPERCLIP_MCP_SESSION_STORE_FILE=/cache/sessions.json \
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

Credential-bearing tenant routes use the same schema with an explicit execution
class. Their URL is the MCP worker route exposed through the existing PEN-629
tenant-node channel, not a second tunnel:

```json
{
  "upstreams": [
    {
      "prefix": "github",
      "url": "https://tenant-channel.example/mcp/github",
      "execution": "tenant_node",
      "authorizationEnv": "GITHUB_TOKEN"
    }
  ]
}
```

For `tenant_node` entries, credential key names remain visible registry metadata,
but the central gateway never reads or injects their values. The tenant-node
worker resolves those names from its local environment before calling the real
MCP server. House servers omit `execution` (or set it to `house`) and retain the
existing central Kubernetes Secret injection path. This package routes approved
HTTP MCP servers only; it does not host customer-supplied server code.

Credential values are not valid state. State may only name the gateway env var
that holds a credential. Kubernetes Secrets remain the source of truth for those
values; the gateway injects them as upstream headers at request time. A state
payload containing fields such as `token`, `secret`, `password`, or `apiKey` is
rejected before serving.

When state fetch succeeds, the raw metadata is persisted to
`PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE`. If the control plane is unavailable on a
later startup, the gateway serves the last-known-good cache instead of losing all
routes.

Set `PAPERCLIP_MCP_SESSION_STORE_FILE` to externalize client-to-upstream session
mappings. The file contains only session ids, cached initialize payloads, and
timestamps; it must live on storage shared by all gateway replicas if the
Deployment runs with more than one pod. Without this setting, sessions remain
process-local and a replica restart requires clients to initialize again.

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

### OAuth discovery

Set both variables to publish discovery for the tenant's logical MCP URL:

```sh
PAPERCLIP_MCP_PUBLIC_URL=https://tenant.example \
PAPERCLIP_MCP_AUTHORIZATION_SERVER=https://auth.example \
  node dist/server.js
```

The gateway serves RFC 9728 protected-resource metadata at both
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. It redirects the authorization
server and OpenID discovery probes to the configured issuer. Discovery is
disabled unless both variables are present; partial configuration fails startup.

## Endpoints

- `GET /healthz` — health check; returns `{ ok: true, upstreams, upstreamCallCounts, breakers, sessions }`.
- `GET /` — same as `/healthz`.
- `GET /.well-known/oauth-protected-resource[/mcp]` — tenant MCP OAuth protected-resource metadata when configured.
- `GET /.well-known/oauth-authorization-server` — redirect to the configured authorization server's discovery document.
- `GET /.well-known/openid-configuration` — redirect to the configured OpenID issuer discovery document.
- `<METHOD> /mcp` — aggregate MCP endpoint; exposes one stable tool list with `<prefix>__<toolName>` names.
- `<METHOD> /<prefix>/mcp` — proxied to the upstream URL for `<prefix>`.
- `<METHOD> /<prefix>/mcp/<rest...>` — preserves the trailing path.

## Migrating an agent

1. Find the agent's `adapter_config.mcpServers.<name>.url`. Example:
   ```json
   "figma": { "url": "http://figma-mcp-server.paperclip.svc.cluster.local:8000/mcp", "type": "http" }
   ```
2. Prefer one aggregate gateway server:
   ```json
   "paperclip-fleet": { "url": "http://paperclip-mcp-gateway.paperclip.svc.cluster.local:8080/mcp", "type": "http" }
   ```
3. During incremental migration, the per-upstream compatibility URL is still valid:
   ```json
   "figma": { "url": "http://paperclip-mcp-gateway.paperclip.svc.cluster.local:8080/figma/mcp", "type": "http" }
   ```
4. Save (no agent restart needed; mcp config is read on next run).

## Limits and known issues

- **Initialize replay assumes the upstream is idempotent on init.**
  If the upstream's `initialize` mutates external state (rare for MCP),
  replay can double-fire. Figma / Linear / k8s / prometheus / webflow
  all have stateless initialize handlers.
- **HA session storage is file-backed.** Multi-replica deployments must mount
  `PAPERCLIP_MCP_SESSION_STORE_FILE` on shared storage. The fallback is still
  in-memory session state for local/bootstrap runs.

## Test

```sh
pnpm test
```

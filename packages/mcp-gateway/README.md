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
PAPERCLIP_MCP_TENANT_RELAY_ORIGIN=https://api.penstock.run \
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
      "execution": "tenant_node",
      "routeId": "github",
      "authorizationEnv": "GITHUB_TOKEN"
    }
  ]
}
```

For `tenant_node` entries, the registry cannot provide a URL. `routeId` must
equal the entry prefix, and the gateway derives the only valid target as
`$PAPERCLIP_MCP_TENANT_RELAY_ORIGIN/v1/mcp/apps/<routeId>/mcp`. The relay origin
must be a public HTTPS origin on the default port; IP literals, local/internal
names, userinfo, alternate ports, path components, and an origin different from
the authenticated state service fail startup. Relay calls
authenticate with the same state-token principal that scoped the registry
response, never caller-supplied identity headers, and redirects are not followed.
Credential key names remain visible registry metadata, but the central gateway
never reads or injects their values. The tenant-node worker resolves those names
from its local environment before calling the real MCP server. House servers
omit `execution` (or set it to `house`) and retain the existing central
Kubernetes Secret injection path. This package routes approved HTTP MCP servers
only; it does not host customer-supplied server code.

Credential values are not valid state. State may only name the gateway env var
that holds a credential. Kubernetes Secrets remain the source of truth for those
values; the gateway injects them as upstream headers at request time. A state
payload containing fields such as `token`, `secret`, `password`, or `apiKey` is
rejected before serving.

When state fetch succeeds, the metadata is persisted to
`PAPERCLIP_MCP_UPSTREAMS_CACHE_FILE` in an envelope bound to the state URL and a
SHA-256 fingerprint of the authenticated state-token principal. If the control
plane is unavailable on a later startup, the gateway serves that last-known-good
cache only when both bindings still match. Token rotation or a different tenant
therefore fails closed instead of reusing stale routes.

Set `PAPERCLIP_MCP_SESSION_STORE_FILE` to externalize client-to-upstream session
mappings. The file contains only session ids, cached initialize payloads, and
timestamps; it must live on storage shared by all gateway replicas if the
Deployment runs with more than one pod. Without this setting, sessions remain
process-local and a replica restart requires clients to initialize again. The
persisted snapshot is also bound to the state-token principal and each resolved
upstream route plus registry revision; principal rotation, registry changes, or
a route change invalidate stale sessions.

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

On `$PORT` (default 8080):

- `GET /healthz` — health check; returns `{ ok: true, upstreams, upstreamCallCounts, breakers, sessions }`.
- `GET /` — same as `/healthz`.
- `GET /.well-known/oauth-protected-resource[/mcp]` — tenant MCP OAuth protected-resource metadata when configured.
- `GET /.well-known/oauth-authorization-server` — redirect to the configured authorization server's discovery document.
- `GET /.well-known/openid-configuration` — redirect to the configured OpenID issuer discovery document.
- `<METHOD> /mcp` — aggregate MCP endpoint; exposes one stable tool list with `<prefix>__<toolName>` names.
- `<METHOD> /<prefix>/mcp` — proxied to the upstream URL for `<prefix>`.
- `<METHOD> /<prefix>/mcp/<rest...>` — preserves the trailing path.

On `$PAPERCLIP_MCP_HEALTH_PORT`, when set — see [Probe-only health port](#probe-only-health-port):

- `GET /healthz`, `GET /` — `{ ok: true }`, or 503 `{ ok: false }` when the proxy listener is not accepting connections.
- `HEAD` of either path — same status, no body.
- any other method on those paths — 405. Any other path — 404. No MCP route, no
  upstream, no discovery document is served here.

## Probe-only health port

`PAPERCLIP_MCP_HEALTH_PORT` binds a second listener that serves `GET /healthz`
and nothing else. Unset by default; nothing changes unless you set it.

It exists so a `NetworkPolicy` can deny the proxy port without taking the
kubelet's probes down with it. The kubelet reaches a pod from the **node's host
network**, so a Cilium `ingressDeny` with `fromEntities: [host, remote-node]` on
the proxy port denies the probes as well as the bypass it is closing. On a
Deployment whose liveness probe targets that port, adding the deny is a
CrashLoop rather than a policy change (PEN-3052).

```yaml
env:
  - name: PORT
    value: "8080"
  - name: PAPERCLIP_MCP_HEALTH_PORT
    value: "8081"
ports:
  - { name: http,   containerPort: 8080 }
  - { name: health, containerPort: 8081 }
readinessProbe:
  httpGet: { path: /healthz, port: health }
  periodSeconds: 5
  timeoutSeconds: 1
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /healthz, port: health }
  periodSeconds: 15
  timeoutSeconds: 1
  failureThreshold: 3
```

The probe fields are spelled out rather than left to defaults because the
reasoning elsewhere in this file depends on their values: `timeoutSeconds: 1` is
what the accept probe's own 250ms connect timeout sits inside, and
`failureThreshold: 3` is why three consecutive failures restart the
authenticated proxy rather than drop a sample.

Four properties this port is required to keep, all pinned in `server.test.ts`:

- **It never proxies.** The deny it exists to permit names one port, so anything
  reachable here is reachable around that deny. A health listener that routed to
  an upstream would be a wider hole than the one being closed.
- **It discloses less than the proxy port's `/healthz`,** which reports upstream
  names, breaker state and per-prefix session counts. No deny covers this port;
  treat its body as readable by anything that can route to the pod.
- **Its connections are bounded in time, not in number** — 2s headers, 5s
  request, swept every 1s, idle keep-alive reclaimed at 2s — rather than left on
  Node's 60s / 300s / 30s-sweep defaults. Those defaults suit an authenticated
  proxy port; this one is reachable by exactly the `host` and `remote-node`
  entities the deny excludes, with nothing authenticating in front of it.
  Read "in time" narrowly: what these reclaim is the **idle and the malformed**
  socket. `requestTimeout` restarts per request, so a client willing to send one
  cheap request inside each keep-alive window holds its socket indefinitely —
  roughly one 40-byte request every 2s. What the timeouts bound is therefore the
  *per-socket* cost, as a floor under the holder's effort; they do not bound the
  number of sockets, and no number here does.
  The sweep interval is the part worth stating explicitly: Node arms no
  per-socket timer for these timeouts, it reaps expired connections on
  `connectionsCheckingInterval`, which defaults to 30s and is settable only as a
  `http.createServer` option. Left at the default, the 2s headers timeout above
  is enforced in ~30s — measured at 30040ms, against ~2–3s at a 1s interval
  (measured 2007ms). Reaping happens on the sweep rather than on a per-socket
  timer, so that is a range and 2007ms is its floor, not the figure to compute
  from.
- **There is deliberately no connection cap.** An earlier revision set
  `maxConnections = 64` to keep socket-holding here from pushing the process
  toward fd pressure, since `createProxyAcceptProbe` needs a descriptor of its
  own and a failed probe turns a 503 into a liveness restart of the
  authenticated proxy. At 64 a cap makes that outcome cheaper, not rarer: Node
  closes the *incoming* handle once the cap is reached, with no response, so the
  sockets already held win and the kubelet's next probe connection is the one
  reset — moving the restart threshold down from the process fd limit to the
  cap.
  A cap set well clear of probe contention is a different proposal, and it is
  **accepted against, not refuted.** It would bound something the timeouts do
  not: how many descriptors this unauthenticated listener can take from the
  process. That is worth naming, because the cost of exhausting them is not
  confined to this port — an fd-exhausted process also cannot accept on the
  proxy port or open outbound sockets to upstreams, so the authenticated proxy
  is degraded for the window before liveness restarts the pod. Three reasons it
  is still not taken, recorded here so the next reader does not re-derive them:
  - Both designs end in a restart. A holder that can hold sockets here causes
    one either way; a high cap only changes whether the proxy keeps serving
    during the window before it.
  - It buys that window by *lowering* the effort needed to trigger the restart,
    from the process fd limit to the cap. That is the same trade the 64 cap was
    rejected for, moved along the axis rather than off it.
  - A constant cannot be shown to bind. The fd limit is set by the container
    runtime, not here, so any fixed cap is either inert (limit far above it) or
    load-bearing (limit near it) depending on deployment — and a stated bound
    that silently does not bind is worse than a recorded acceptance.
  So unbounded descriptor consumption on this port is accepted. What stands
  against it is the timeouts, which put a floor under the per-socket cost, and
  the deny-scoping of who can route here at all — not a cap.
  An EMFILE that happens anyway still reads as 503, deliberately: a process out
  of descriptors genuinely is not accepting, so the honest answer is "not
  serving" and a restart is the correct recovery.

### What the 200 actually asserts

`{ ok: true }` means the proxy listener is **bound and accepting**, not merely
bound. `server.listening` is a bare `!!this._handle` check and stays true for a
socket whose accept queue is saturated, so the check also opens a short-timeout
loopback connection to `PORT` (`createProxyAcceptProbe`). That matters only once
the probes move here: while liveness targets the proxy port directly, a wedged
accept queue times the probe out and the pod restarts on its own; served from
this port without the connect, the same state would answer 200 forever and the
pod would never self-heal.

A pod-local loopback connect is outside the deny — `fromEntities: [host,
remote-node]` does not match traffic the pod originates to itself — so this
costs no policy surface. The result is cached for 1s so that an unauthenticated
flood of health requests cannot amplify into the accept queue it measures.

A blocked event loop is caught separately: the health handler runs on that same
loop, so it simply stops answering, and the kubelet's own `timeoutSeconds`
decides. The accept probe deliberately does **not** tighten that. Its timeout
defers one loop turn (`setImmediate`) before reporting failure, because Node
services timers before poll: without the deferral, a loop that had been blocked
past the probe's 250ms delivered the expired timer ahead of a connect the kernel
had already completed, and the probe reported a healthy listener wedged — 20 of
40 trials against a real `http.Server` under a 400ms stall. That would have put
a 250ms verdict, cached for 1s, on the liveness path in place of the kubelet's
1s one, and three of them restart the authenticated proxy. Transient loop
latency is not what this probe is for.

The value must be a plain integer in 1–65535 and must differ from `PORT`.
Anything else fails startup rather than falling back — a port that silently
resolved elsewhere would leave the probes hitting a closed socket, which
liveness turns into a restart loop with no stated cause. `PORT` is parsed the
same strict way, for the same reason: `PORT="8O81"` with a letter O used to
parse to `8`, and the `must differ` guard is only as good as the number it
compares against.

An exec probe was considered and rejected for this workload: `node -e` costs
~90 ms CPU per spawn against a 200m limit (20 ms per CFS period), i.e. ~4.5
periods of the entire quota per probe, on a container already throttled 8–10% of
periods. On a liveness path that is a throttle-driven CrashLoop.

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

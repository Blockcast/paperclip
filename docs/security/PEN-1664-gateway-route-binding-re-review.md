# PEN-1664 - Gateway Route-Binding Security Re-review

Date: 2026-07-15
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Scope: PEN-1657 / Blockcast/paperclip PR #691
Immutable reviewed head: `a0565b4f69510b6a4740717b6908495c336d638b`

## Verdict

**PASS - no blocking findings in the PEN-1657 gateway slice.**

No Critical, High, Medium, or Low findings were identified in the scoped
remediation. The immutable PR head is DCO-signed, and its `packages/mcp-gateway`
content is byte-equivalent to merged implementation commit `ffe6ecab`.

This verdict closes the gateway routing and cache-isolation finding tracked by
PEN-1657. It does not approve the overall PEN-1650 release gate; sibling
node-worker remediation and re-review remain independent blocking requirements.

## Threat Boundaries

The review considered three untrusted inputs crossing the gateway boundary:

1. Registry route metadata, which must not choose the tenant relay network
   destination or authenticated route identity.
2. Caller headers, which may contain credentials or spoofed tenant/node
   identity and must not cross into the authenticated relay request.
3. Persisted route and session state, which must not survive a principal,
   registry, or resolved-route change.

The state-token principal and configured relay/state origin are trusted
deployment inputs. The registry payload and MCP caller are not.

## Scoped Results

| Control | Result | Evidence |
|---|---:|---|
| Canonical authenticated relay routing | Pass | `tenant_node` metadata cannot supply the effective URL. `parseUpstreamConfig` derives `/v1/mcp/apps/<routeId>/mcp` from the configured relay origin, requires `routeId` to equal the registry prefix, and requires authenticated relay configuration. |
| Unsafe origin and port rejection | Pass | `tenantRelayContext` requires HTTPS, default port 443, no userinfo/path/query/fragment, no IP literal or local/internal hostname, and exact origin equality with the authenticated state service. Invalid configuration fails before state fetch. |
| Redirect and route-swap resistance | Pass | State fetch uses `redirect: "error"`; tenant relay forwarding uses `redirect: "manual"`. Registry URLs are ignored for tenant routes, and route IDs that differ from the prefix are rejected. |
| Caller-secret and identity stripping | Pass | Tenant relay requests use an MCP protocol-header allowlist. Caller `Authorization`, `Cookie`, `x-api-key`, proxy credentials, and client-supplied tenant/node headers are not forwarded; `Authorization` is replaced with the server-owned state-token bearer. Central credential environment values are never read for `tenant_node` routes. |
| Two-principal LKG isolation | Pass | The LKG envelope binds the payload to SHA-256 of the authenticated state token and the state URL. A token rotation or second principal cannot load the first principal's cache, and an invalid/reachable registry response does not fall back to stale state. |
| Session binding | Pass | Persisted sessions use snapshot version 2 and bind to the authenticated principal plus execution class, route ID, resolved URL, and SHA-256 registry revision. Any principal, registry, or route change forces re-initialization. |
| Fail-closed behavior | Pass | Missing state token/relay configuration, malformed or unsafe relay origin, route mismatch, stale-principal cache, invalid reachable state, and missing relay authorization all reject rather than using an unbound route. |

## STRIDE Assessment

| Category | Scoped assessment |
|---|---|
| Spoofing | Pass: caller tenant/node headers are stripped and relay authentication comes from the state-token principal. |
| Tampering | Pass: registry-controlled URLs and route swaps cannot alter the canonical tenant target; cache/session state is revision-bound. |
| Repudiation | Pass for this slice: persisted session state is attributable to a principal and resolved route binding. |
| Information disclosure | Pass: caller secrets and centrally available tenant credential values do not cross the relay boundary. |
| Denial of service | No new issue in this route-binding slice; broader backpressure/cancellation work remains outside PEN-1657. |
| Elevation of privilege | Pass: registry metadata cannot select an arbitrary gateway network destination for tenant-node execution. |

## Verification

Commands run against exactly
`a0565b4f69510b6a4740717b6908495c336d638b`:

```sh
cd packages/mcp-gateway
pnpm test -- --run
pnpm build
```

Results:

- Vitest: 4 files passed, 92 tests passed, 0 failed.
- TypeScript: `tsc` completed successfully.
- Dependency impact: no dependency or lockfile changes in the reviewed commit;
  no new dependency-CVE finding is introduced by PEN-1657.
- Prior review evidence: PR #693 merged with no blocking review finding; all 18
  supplied PR checks passed.

## Disposition

PEN-1657 is **PASS** at immutable head
`a0565b4f69510b6a4740717b6908495c336d638b`. No remediation follow-up issue is
required for this scoped review. PEN-1650 remains gated by its separately
tracked node-worker security work.

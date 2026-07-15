# PEN-1664 - Immutable Gateway Security Re-review

Date: 2026-07-15
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Issue: `PEN-1664`
Parent finding: `PEN-1657`
Reviewed repository: `Blockcast/paperclip`
Reviewed PR: [#691](https://github.com/Blockcast/paperclip/pull/691)
Immutable reviewed head: `a0565b4f69510b6a4740717b6908495c336d638b`

## Verdict

**PASS - no blocking finding in the PEN-1657 gateway slice.**

The immutable head replaces registry-selected tenant URLs with canonical paths
under the authenticated state-service origin, uses the state principal for
relay authentication, strips caller secrets and caller-supplied tenant/node
identity, binds the last-known-good cache to the state principal, and binds
persisted sessions to the principal and resolved registry route.

This verdict clears `PEN-1657` only. It does not approve production enablement
or clear the overall `PEN-1650` gate. The sibling node-worker custody, tenant
binding, egress, response-redaction, and backpressure findings remain separate
release blockers until their immutable implementations and conformance evidence
pass re-review.

## Scope and Trust Boundaries

The reviewed flow crosses these boundaries:

1. An MCP caller sends protocol messages and untrusted headers to the gateway.
2. The gateway authenticates to Penstock state with a server-owned token and
   receives principal-scoped route metadata.
3. A `tenant_node` route crosses from the gateway to a canonical relay path on
   that same authenticated state-service origin.
4. Route and session state may survive a state outage or gateway restart via
   shared persisted caches.

The authenticated state service is trusted to classify routes as `house` or
`tenant_node` and to authorize the state token for the corresponding route.
Node-side enforcement of tenant, node, custody, and downstream egress is outside
this scoped gateway verdict and remains covered by the sibling PEN-1650 work.

## Control Matrix

| Control | Result | Evidence |
|---|---:|---|
| Canonical authenticated relay routing instead of registry-controlled tenant URLs | PASS | `packages/mcp-gateway/src/upstreams.ts:204-228` requires `routeId` to equal the registry prefix, ignores a supplied tenant URL, and derives `/v1/mcp/apps/{routeId}/mcp` under the authenticated relay origin. `upstreams.test.ts:86-112` covers malicious registry URLs, missing relay context, and route swaps. |
| Unsafe origin, userinfo, port, redirect, route-swap, and fail-closed behavior | PASS | `upstreams.ts:241-271` requires the state token, public HTTPS, no userinfo, default port, root origin, no IP/local/internal hostname, and exact state-service origin equality. Registry fetches use `redirect: "error"`; tenant relay calls use `redirect: "manual"` in `server.ts:432-449`. `upstreams.test.ts:275-306` and `server.test.ts:571-603` verify rejection occurs before fetch and that redirect targets receive no gateway request. Invalid reachable state is not replaced by LKG data (`upstreams.test.ts:308-333`). |
| Caller-secret and client-supplied tenant/node identity stripping | PASS | `server.ts:466-476` uses a positive allowlist containing only MCP protocol headers, replaces authorization with the server-owned relay bearer, and does not forward cookies, API keys, proxy authorization, or `x-penstock-*` identity. `server.test.ts:516-564` exercises synthetic secrets and spoofed tenant/node headers. |
| Central tenant credential isolation | PASS | `upstreams.ts:329-343` returns no environment credentials for `tenant_node`; `server.ts:953-961` disables central credential custody for those routes. `upstreams.test.ts:184-196` verifies that a populated control-plane token is not injected. |
| Two-principal LKG isolation and stale-principal invalidation | PASS | `upstreams.ts:112-143` persists only a versioned envelope bound to the exact state URL and SHA-256 state-token fingerprint. Mismatch returns no cached payload and fails closed. `upstreams.test.ts:257-273` writes tenant A state and proves tenant B cannot consume it. |
| Session binding to principal, registry revision, and resolved route | PASS | `server.ts:181-198` requires the persisted snapshot's principal fingerprint and per-prefix route binding to match. `server.ts:245-247` binds execution class, route ID, resolved URL, and registry revision. `upstreams.ts:90-107` derives the revision from the authenticated raw registry payload. `server.test.ts:1277-1353` covers principal rotation, registry revision changes, and resolved URL changes. |

## STRIDE Re-check

| Category | Gateway risk | Result |
|---|---|---:|
| Spoofing | Caller supplies tenant/node identity or swaps a route ID | PASS: identity headers are stripped and route ID must equal the authenticated registry prefix. |
| Tampering | Registry swaps a tenant URL or stale route/session state is reused | PASS: tenant URLs are ignored; cache and session bindings invalidate mismatched state. |
| Repudiation | Persisted session survives under a different principal or route | PASS: session restore requires matching principal, registry revision, execution class, route ID, and URL. |
| Information disclosure | Caller credentials or control-plane tenant credentials reach the relay | PASS: positive header allowlist and independent central-custody bypass prevent forwarding. |
| Denial of service | Invalid state silently falls back to stale valid state | PASS for this scope: invalid reachable state fails closed; only unavailable state may use a principal-bound LKG. |
| Elevation of privilege | Registry-selected URL reaches internal services with the relay bearer | PASS: tenant target is derived under the authenticated state-service origin and redirects are not followed. |

## Verification Evidence

- Commit `a0565b4f69510b6a4740717b6908495c336d638b` includes a DCO
  `Signed-off-by` trailer.
- `git diff --check a0565b4f^..a0565b4f` completed without errors during this
  re-review.
- All 18 PR #691 check runs completed; 17 concluded `success` and the
  informational `security-review` check concluded `neutral`. No check failed.
- The PR records `pnpm --filter @paperclipai/mcp-gateway test -- --run` with
  92 passing tests and a successful gateway build.
- PR #693 merged the original PEN-1650 review artifact. The subsequent gateway
  changes at this immutable head resolve the PEN-1657 findings reviewed here.
- No dependency manifest or lockfile changed in the PEN-1657 remediation, so
  this scoped re-review introduces no new dependency-CVE finding.

## Limitations

- This review verifies source and test behavior at the immutable gateway head;
  it does not attest which container digest is currently deployed.
- Same-origin relay validation assumes the authenticated state-service origin
  is operator-controlled and protected by deployment DNS and egress policy.
- Cache and session files provide principal/route equality binding, not an
  integrity boundary against a process that can already write the shared PVC.
- Node-side tenant audience validation, custody resolution, response safety,
  replay isolation, and downstream egress are not part of PEN-1657 and remain
  subject to the overall PEN-1650 security gate.

## Disposition

`PEN-1657` is cleared for immutable gateway head
`a0565b4f69510b6a4740717b6908495c336d638b`. No Critical, High, Medium, or Low
finding blocks this scoped verdict. `PEN-1650` remains blocked on its sibling
node-worker remediation and end-to-end conformance requirements.

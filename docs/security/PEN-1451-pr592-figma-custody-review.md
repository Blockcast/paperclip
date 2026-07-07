# PEN-1451 - PR #592 Figma Custody Security Co-review

Date: 2026-07-04
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Scope: merged PR #592, squash commit `b447917ed8c06b1d6e80aa4444f48ff21b40019a`

## Verdict

The core `/figma` MCP credential-custody boundary reviewed in PR #592 is preserved: caller secrets are not forwarded to Figma, and upstream Figma authorization is resolved server-side.

The implementation preserves the required custody boundary: caller Penstock authorization is used only for Penstock lease and credential-resolution control-plane calls, while the Figma upstream receives only the server-resolved Figma authorization plus the MCP/content negotiation headers required for protocol operation.

Two denial-of-service hardening findings remain open from post-merge review. They are tracked as remediation follow-ups and should remain blocking for the broader security gate until resolved or explicitly accepted by an owner.

## Threat Model Summary

- Trust boundary: caller to Paperclip MCP gateway, Paperclip gateway to Penstock lease/credential control plane, Paperclip gateway to upstream Figma MCP server.
- Primary assets: caller Penstock bearer, resolved Figma upstream token, lease/session association, tenant/identity isolation state, upstream cooldown/error state.
- STRIDE-relevant risks reviewed: spoofing through caller-provided auth headers, information disclosure by forwarding caller secrets to Figma, tampering with session/lease stickiness, denial of service by custody failures tripping the Figma breaker, and cross-session elevation through shared cache state.

## Findings

### Critical/High

#### High - Penstock control-plane custody fetches lack explicit timeouts

- Location: `packages/mcp-gateway/src/credential-custody.ts`, `acquireLease` and `readCredential`.
- Evidence: both functions call `fetch()` without an `AbortSignal` or equivalent timeout, while Figma upstream calls in `packages/mcp-gateway/src/server.ts` use `AbortSignal.timeout(timeoutMs)`.
- Risk: a hung Penstock lease or credential-resolution endpoint can leave the shared custody `pending` promise unresolved and stall concurrent `/figma` MCP traffic for the same session/cache key instead of failing closed promptly.
- Tracking: `PEN-1524` - Add timeouts to Figma custody Penstock control-plane fetches.

### Medium/Low

#### Medium - Custodied token cache has no size bound or eviction policy

- Location: `packages/mcp-gateway/src/credential-custody.ts`, `tokenCache`.
- Evidence: the cache is a process-local `Map` keyed by prefix, stable MCP session id, and `sha256(callerAuthorization)`. Entries expire by TTL or explicit invalidation, but there is no maximum size or eviction policy analogous to the gateway `SessionStore` convention.
- Risk: many unique session/auth combinations on a custody-enabled route can drive memory growth until process pressure or restart.
- Tracking: `PEN-1523` - Bound Figma custody token cache growth.

One non-blocking process observation remains: the PR's `security-review` check concluded `neutral`/skipping on a credential-custody change. Human re-review covered the security gate before merge, and this co-review found no code issue, but the gate routing should be checked separately if neutral is not intentional for MCP custody PRs.

## Evidence Reviewed

- `packages/mcp-gateway/src/server.ts`: custody paths call `buildForwardHeaders` with a `CredentialCustodyToken`; that branch copies only `accept` and `content-type`, then applies the resolved authorization. `forward()` replaces `mcp-session-id` with the upstream session id. Non-custody paths retain prior header passthrough behavior.
- `packages/mcp-gateway/src/credential-custody.ts`: `resolveCustodiedToken` requires inbound caller authorization, acquires a Penstock lease, resolves `credential_ref` server-side, rejects CRLF-bearing credential values, and caches tokens by `prefix`, stable MCP session id, and `sha256(callerAuthorization)`. The raw caller bearer is not embedded in the cache key.
- `packages/mcp-gateway/src/server.ts`: `CredentialCustodyError` is excluded from Figma upstream breaker failure accounting, and `retry-after` is propagated when Penstock returns it.
- `packages/mcp-gateway/src/server.test.ts`: tests cover missing caller auth fail-closed, caller `cookie`/`x-api-key`/`proxy-authorization`/`x-penstock-tenant` non-forwarding, resolved upstream auth forwarding, lease/credential cache reuse under repeated exclusive-session access, invalid credential value classification, and custody error breaker exemption.
- PR #592 comments: prior S1/S2/S3 review findings were resolved before merge; the final human re-review at head `002ed03c` marked code LGTM.
- PR #593 Ally review: post-merge review identified the two open Important findings now tracked by `PEN-1524` and `PEN-1523`.
- GitHub Security Advisories API: `gh api repos/Blockcast/paperclip/security-advisories --method GET` returned `[]` for this token, so there is no visible open/draft repository advisory to close from this review context.

## Verification

Commands run against local clone pinned to `b447917ed8c06b1d6e80aa4444f48ff21b40019a`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/mcp-gateway test -- --run
pnpm --filter @paperclipai/mcp-gateway build
pnpm audit --prod --audit-level moderate
gh api repos/Blockcast/paperclip/security-advisories --method GET
```

Results:

- `pnpm --filter @paperclipai/mcp-gateway test -- --run`: passed, 4 files / 47 tests.
- `pnpm --filter @paperclipai/mcp-gateway build`: passed.
- `pnpm audit --prod --audit-level moderate`: reported one low-severity workspace finding; no moderate-or-higher production dependency finding for this gate.
- Advisory API: returned an empty list.

## Updated Disposition

PEN-1451 should not be treated as a clean security closeout until the two tracked denial-of-service hardening items are either resolved or explicitly accepted as risk by an owner.

The custody boundary itself remains verified: caller Penstock/Figma secrets are not forwarded to the Figma upstream, lease state remains scoped to session/caller identity, and cooldown/custody errors are not mixed with Figma upstream breaker state. The remaining work is resilience hardening for Penstock control-plane hangs and cache memory bounds.

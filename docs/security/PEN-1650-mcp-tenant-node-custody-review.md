# PEN-1650 - MCP Tenant-Node Custody and Egress Security Review

Date: 2026-07-15
Reviewer: Security Engineer (`7500672d-efe6-4037-a05f-61204a670894`)
Gateway scope: Blockcast/paperclip PR #691 at `7570f30078b4991da361f860439835d056609da8`
Node scope: mutable `pen-1651/tenant-mcp-worker` working diff observed 2026-07-15; no implementation PR or immutable commit was available
Design baseline: PEN-629 custody ADR and PEN-643 custody-split requirements

## Verdict

**FAIL - High severity, release blocking.**

The reviewed code has positive node-local custody and fixed-protocol controls, but it does not establish the required tenant-bound execution chain. The gateway forwards caller secrets to a registry-selected URL without a server-owned PEN-629 audience. The node drops the frame tenant before execution, lets registry key names select unrelated process secrets, bypasses the existing egress policy, and can return credentials through incomplete response redaction.

The acceptance criterion to review both implementation PRs is also incomplete: gateway PR #691 exists, but the node-worker implementation remained an uncommitted working diff. Security approval requires re-review of immutable heads after remediation.

## System and Trust Boundaries

The reviewed flow is:

1. An authenticated MCP client sends JSON-RPC and caller headers to the central MCP gateway.
2. Penstock state supplies tenant-scoped route metadata and credential key names to the gateway.
3. The gateway selects a `tenant_node` route and is expected to relay a tenant-bound frame over the existing PEN-629 channel.
4. The authenticated tenant node validates tenant, node, registry, and route audience before reading custody.
5. The node resolves a tool credential from node-local custody and calls an approved remote MCP server through node egress policy.
6. The node returns a credential-safe response through the same tenant-bound channel.

Primary assets are tenant tool credentials, reverse-channel identity/signing material, caller authorization/session credentials, route and registry integrity, MCP session/replay state, and tenant-node egress ownership.

Trust boundaries are client-to-gateway, control-plane registry-to-gateway, gateway-to-PEN-629 relay, authenticated relay-to-node worker, node custody-to-MCP worker, and node-to-remote MCP server.

## STRIDE Summary

| Category | Risk reviewed | Result |
|---|---|---|
| Spoofing | Client- or registry-controlled tenant/node/route identity | Fail: no end-to-end authenticated tenant audience |
| Tampering | Route swaps, registry-version mismatch, replay-key collisions | Partial: node/version checks exist; tenant and replay scope do not |
| Repudiation | Correlation of calls to authenticated tenant/node/route | Fail: gateway/session and node execution state omit tenant binding |
| Information disclosure | Caller headers or node credentials cross custody boundaries | Fail: caller-header forwarding and incomplete response redaction |
| Denial of service | Unbounded blocking calls and disconnect cancellation | Fail: no node-local concurrency or task cancellation |
| Elevation of privilege | Registry key names access unrelated node secrets; SSRF reaches privileged networks | Fail |

## Blocking Findings

### High - Caller secrets cross the gateway-to-node boundary without tenant binding

- Location: `packages/mcp-gateway/src/server.ts:395-458`, `packages/mcp-gateway/src/upstreams.ts:156-180` and `:233-245`.
- Evidence: correctly labeled `tenant_node` routes suppress central environment and custody injection, but use the generic forwarding path. That path copies inbound headers except a small hop-by-hop/framing denylist. Caller `Authorization`, `Cookie`, `x-api-key`, proxy authorization, forwarding metadata, and client-supplied tenant headers can reach the registry-selected URL.
- Evidence: `UpstreamConfig` has no authenticated tenant, node, route, or audience fields. The gateway sends ordinary HTTP requests rather than a server-owned PEN-629 frame and cannot validate a relay response audience.
- Risk: caller/session credentials can be disclosed to a tenant node or arbitrary route target, and client-controlled identity can be confused with authenticated channel identity.
- Tracking: `PEN-1656`.
- Required remediation: use a tenant-node-specific header allowlist; derive relay identity from authenticated server-owned state; reject tenant/node/route mismatches before custody or egress; add a two-tenant conformance test.

### High - Gateway tenant-node routes are an SSRF sink and stale cache is not principal-bound

- Location: `packages/mcp-gateway/src/upstreams.ts:58-100` and `:115-127`; `packages/mcp-gateway/src/server.ts:395-428`.
- Evidence: URL validation accepts arbitrary HTTP(S) destinations and does not exclude loopback, RFC1918, link-local/metadata, cluster-internal targets, unsafe redirects, DNS rebinding, unexpected ports, or URL credentials.
- Evidence: last-known-good routes are stored in one fixed cache without the authenticated state-token principal, tenant, or node audience. A principal rotation followed by control-plane outage can reuse another identity's route set.
- Risk: central-network SSRF, cross-tenant route confusion, and stale route reuse.
- Tracking: `PEN-1657`.
- Required remediation: resolve a server-owned PEN-629 route identifier instead of accepting arbitrary URLs, enforce redirect- and resolution-safe target policy where URLs remain, and bind route/session caches to authenticated identity and registry version.

### High - Registry key names can select unrelated vault-node process secrets

- Location: node `src/mcp_worker.rs:78-88`, `:262-280`, and `:333-338`.
- Evidence: `EnvironmentCredentialCustody` calls `std::env::var` for any uppercase/digit/underscore name. Registry metadata can name reverse-channel tokens/private keys, helper signing/sealing keys, enrollment credentials, or any other single-line process secret and inject it into an outbound header.
- Risk: control of metadata-only registry state becomes read/exfiltration access to the entire process environment, violating the PEN-629 custody split.
- Tracking: `PEN-1659`.
- Required remediation: use a dedicated MCP credential store or locally provisioned namespace/allowlist that cannot resolve channel, identity, enrollment, signing, or sealing secrets.

### High - Node frames are node-bound but not tenant-bound, and replay state is cross-context

- Location: node `src/reverse_dial.rs:431-455`, `:1265-1310`, and generic response-cache paths around `:980-1039`; node `src/mcp_worker.rs:151-180` and `:243-260`.
- Evidence: `RequestFrame` carries `org_id`, but `execute_mcp_buffered` drops it when constructing `McpExchangeRequest`. Registry routes have no tenant field. Execution validates only frame-supplied node binding, registry version, prefix, and local node ID.
- Evidence: provider, path, and account alias can disagree with route prefix. The reverse response cache is keyed only by `requestId`, not authenticated tenant, protocol, node, registry version, or route.
- Risk: a tenant-A frame delivered on a node can use tenant-B route state when node/version/prefix align; request ID collision can replay a prior response under new correlation fields.
- Tracking: `PEN-1656`.
- Required remediation: carry the authenticated PEN-629 tenant identity into execution, bind every route and replay/session entry to it, validate all route identity fields consistently, and test same-node/wrong-tenant as well as wrong-node faults.

### High - Node MCP transport bypasses approved egress controls and permits SSRF/unsafe redirects

- Location: node `src/mcp_worker.rs:91-148` and `:318-331`.
- Evidence: `valid_https_url` is a string check that permits private address ranges, most loopback/link-local forms, DNS-to-private resolution, rebinding, arbitrary ports, and hosts outside `PENSTOCK_VAULT_EGRESS_HOSTS`.
- Evidence: the independent `ureq` agent does not use the established vault-node egress allowlist/proxy path. Redirects are enabled and destination policy is not revalidated per hop.
- Risk: metadata can turn the credential-bearing node into an SSRF primitive, bypass required provider/residential egress, or forward custom credential headers across origins.
- Tracking: `PEN-1658`.
- Required remediation: reuse the existing egress enforcement path, parse and resolve destinations safely, restrict ports/origins, and disable or fully revalidate redirects without cross-origin credentials.

### High - MCP responses can return node credentials to the control plane

- Location: node `src/mcp_worker.rs:130-146`, `:262-283`, and `:384-405`; node `src/reverse_dial.rs:1312-1329`.
- Evidence: redaction scans JSON string values but not object keys or the separately relayed `mcp-session-id`. Sequential replacement can partially disclose overlapping credentials.
- Risk: a malicious or compromised upstream can echo node-local credentials in a property name or session header and send them through the control plane.
- Tracking: `PEN-1660`.
- Required remediation: fail closed if any credential bytes occur anywhere in relayed headers or serialized response structure; add adversarial key/header/overlap tests.

### Medium - Node-local backpressure, cancellation, and replay safety are absent

- Location: node `src/reverse_dial.rs:1042-1070` and `:1305-1310`; node `src/mcp_worker.rs:95-102`.
- Evidence: every authenticated frame creates a detached blocking task with a 60-second deadline. No local semaphore enforces advertised concurrency, disconnect does not cancel work, and MCP cancellation is outside the accepted method set.
- Risk: authenticated peer faults can exhaust the node, allow a state-changing `tools/call` after session cancellation, or duplicate calls after cache eviction.
- Tracking: `PEN-1661`.
- Required remediation: enforce node-local concurrency, own tasks under the held channel/session, implement cancellation semantics, and tenant-scope replay/idempotency state without evicting in-flight operations.

## Confirmed Controls

- Correctly labeled gateway `tenant_node` routes do not read or inject central environment credential values.
- Central Figma custody resolution is skipped for correctly labeled tenant-node routes.
- Registry parsing rejects common direct credential-value fields.
- The node reuses the existing authenticated PEN-629 reverse channel; no second listener or connectivity path was added.
- Reverse envelopes are authenticated before MCP frame parsing.
- Node and registry-version mismatch checks occur before custody resolution.
- Missing route or credential fails closed without outbound execution.
- The node accepts only `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` JSON-RPC methods.
- Request duration and response size are bounded.
- Fixed outward error messages avoid direct diagnostic secret leakage.
- No customer-code upload, process spawn, dynamic module load, container execution, or custom MCP server hosting was introduced. Both changes proxy fixed HTTP MCP protocol operations only.

These controls are necessary but do not compensate for the blocking tenant, secret-selection, and egress gaps.

## Two-Tenant Conformance Assessment

**Status: FAIL / absent.**

The node test `route_mismatch_fails_before_custody_or_egress` changes only the requested node ID. It does not create tenants A and B, does not bind a route to an authenticated tenant, and cannot detect the same-node/wrong-tenant case because tenant identity is not passed into `McpWorker::execute`.

PR #691 has no relay-frame tenant/node audience and no two-tenant route-mismatch test. Its new test proves only that one central process environment token is not injected into a correctly labeled route.

Required conformance shape:

- Interleave tenant A and tenant B initialize/list/call flows through gateway and node worker.
- Fault-inject A-to-B route swaps for both different-node and same-node cases.
- Assert rejection before custody lookup, downstream connection, or side effect.
- Assert synthetic caller secrets are absent from relay and downstream frames.
- Assert node-local credentials appear only in the bound node's approved outbound request.
- Assert unavailable node, disconnect cancellation, backpressure, request-ID collision, stale registry, and stale principal cache all fail closed.

## Verification

Commands run against the observed implementations:

```sh
cd packages/mcp-gateway && pnpm test
CARGO_HOME=/runtime-cache/tmp/opencode/pen-1650-cargo \
  CARGO_TARGET_DIR=/runtime-cache/tmp/opencode/pen-1650-target \
  cargo test --features reverse-channel mcp_worker
```

Results:

- Gateway: 4 test files, 78 tests passed.
- Node worker: 4 tests passed, 0 failed, 484 filtered out.
- Gateway PR #691 CI was green at review time, but its `security-review` check was neutral and did not cover this gate.
- Passing tests do not satisfy the missing two-tenant conformance requirement.
- No dependency files changed in either reviewed slice, so this review introduced no new dependency-CVE finding. The existing `ureq` redirect behavior is captured as a design/configuration vulnerability in `PEN-1658`.

## Acceptance Status

| Criterion | Status | Evidence |
|---|---:|---|
| Review gateway implementation PR | Fail | PR #691 reviewed at immutable head; High findings `PEN-1656` and `PEN-1657` |
| Review node-worker implementation PR | Blocked | No PR or immutable commit existed; mutable diff reviewed and findings recorded |
| Tenant tool credentials remain node-local | Fail | Direct central injection is suppressed, but key-name selection and response leakage can exfiltrate node secrets |
| `tenant_node` cannot trigger central custody injection | Partial pass | Correct label suppresses injection; execution class is not structurally bound to route identity |
| Relay frames are tenant-bound | Fail | Gateway omits audience; node drops `org_id` before execution |
| No custom MCP code hosting | Pass | Fixed HTTP protocol relay only; no arbitrary code execution facility added |
| Two-tenant route-mismatch conformance | Fail | Only wrong-node unit test exists |

## Disposition

PEN-1650 remains blocked on `PEN-1656`, `PEN-1657`, `PEN-1658`, `PEN-1659`, `PEN-1660`, and `PEN-1661`, plus publication of the node-worker implementation PR.

Security Engineering must re-review the final immutable gateway and node heads and the MCP-specific two-tenant conformance output. No merge or production enablement of tenant credential-bearing MCP routes is approved before that re-review passes.

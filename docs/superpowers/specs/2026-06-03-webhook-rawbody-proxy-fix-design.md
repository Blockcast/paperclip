# Design: Fix webhook raw-body corruption in the API→worker proxy

**Date:** 2026-06-03
**Tracker:** BLO-8568 (Phase 2 Block Kit buttons), related to BLO-8617 live-evidence pass
**Repo:** `Blockcast/paperclip`
**Status:** Approved (design), pending implementation plan

## Problem

Slack interactive **Approve/Reject buttons** (Block Kit `block_actions`) on approval cards in
`#paperclip-approvals` do nothing when clicked. Reaction-based approval (✅/❌) works; buttons fail 100%.

### Root cause (verified end-to-end in source + prod logs)

`paperclip.blockcast.net` resolves to the **API tier** (`paperclip-api-*` Deployment, 2 replicas).
Plugin webhook delivery is **worker-dependent**, so the API tier reverse-proxies the route
`POST /plugins/:pluginId/webhooks/:endpointKey` to the worker tier (`paperclip-0` StatefulSet) via
`server/src/routes/worker-tier-proxy.ts`. Two compounding defects corrupt the request body in transit:

1. **`worker-tier-proxy.ts:206`** re-serializes the body:
   ```js
   // express.json() already parsed the body; re-serialize as JSON.
   // Every allowlisted mutating route is a JSON endpoint.   ← false for Slack interactivity
   body = JSON.stringify(req.body ?? {});
   headers.set("content-type", "application/json");
   ```
   This discards the original raw bytes and forces `content-type: application/json`.

2. **`server/src/app.ts:273`** registers only `express.json({ verify: captureRawBody })` — there is
   **no `express.urlencoded()` parser** anywhere in `createApp` (shared by both tiers). So a
   form-urlencoded interactivity body is never parsed and `captureRawBody` never fires for it.

### Why each webhook class behaves as observed

Slack signs the **exact bytes** it sends. The worker verifies HMAC over `v0:${ts}:${rawBody}`
(`paperclip-plugin-slack/src/worker.ts:187`). Corrupting the bytes in the proxy breaks verification:

| Webhook class | Content-Type | Proxy effect | Result |
|---|---|---|---|
| Reactions (`reaction_added/removed`) | `application/json` (compact) | `JSON.stringify(parse(x))` reproduces identical bytes | ✅ verifies |
| Rich/multibyte `message` events | `application/json` | re-serialize differs (multibyte/key order) from Slack's bytes | ❌ `hmac_mismatch` |
| **Buttons (interactivity)** | `application/x-www-form-urlencoded` | `express.json` skips → `req.body={}` → proxied as literal `"{}"` | ❌ `hmac_mismatch`, 100% |

**Ground-truth:** the worker logged the interactivity rejection with `bodyBytes:2, bodyFp:44136fa355b3`;
`sha256("{}").slice(0,12) === "44136fa355b3"`, proving the worker received the literal string `"{}"` —
exactly what `JSON.stringify(req.body ?? {})` produces for an unparsed form body.

### Scope of impact (beyond Slack)

- **Slack interactivity:** broken 100% (buttons dead).
- **Slack rich/multibyte events:** intermittently rejected. (This corrects a prior investigation that
  attributed these to "Slack signs different bytes than it delivers, Slack-side, benign" — the real
  cause is *our* proxy re-serializing the body. See note in `reference_paperclip_slack_signature_verified`.)
- **Linear webhooks** (`paperclip-plugin-linear/src/worker.ts:1274`) verify HMAC over `input.rawBody`
  the same way → also exposed to the same re-serialization corruption for non-trivial payloads.

The bug exists on **master** (the proxy body block is identical to `origin/master`); it is not specific
to any feature branch.

## Goals / Non-goals

**Goals**
- Slack interactivity buttons resolve approvals end-to-end (signature verifies + handler runs).
- Slack rich/multibyte events and Linear webhooks verify correctly (same root cause).
- No weakening of HMAC verification (it is a replay/forgery guard).

**Non-goals**
- No change to plugin signature-verification code (`verifySlackSignature` is correct).
- No signing-secret rotation (that is BLO-8723, an independent security item; not the cause here).
- No unrelated refactor of the proxy or body-parsing stack.

## Design

Two coordinated changes. Both are required: Change B fixes the **signature** (raw bytes), Change A fixes
the **handler** (the interactivity handler reads `req.body.payload`, which needs the form body parsed).

### Change A — `server/src/app.ts`: capture raw bytes for form-urlencoded

Add a `express.urlencoded` parser with the same `captureRawBody` verify hook, immediately after the
existing global `express.json()` (~line 276):

```js
app.use(express.urlencoded({
  extended: false,
  limit: DEFAULT_JSON_BODY_LIMIT,   // "10mb", reused from http/body-limits.ts
  verify: captureRawBody,
}));
```

Effect:
- **API tier:** `req.rawBody` is now populated for form-urlencoded interactivity requests (so Change B
  can forward the exact bytes).
- **Worker tier:** the forwarded form body parses into `req.body = { payload: "<json>" }`, which the
  Slack plugin's interactivity handler already expects
  (`paperclip-plugin-slack/src/worker.ts:2007` does `body?.payload ? JSON.parse(body.payload) : body`).

`extended: false` (qs off, uses the `querystring` lib) is sufficient — Slack sends a single flat
`payload=` field.

### Change B — `server/src/routes/worker-tier-proxy.ts`: forward original bytes + content-type

Replace the re-serialization block (~lines 202–208) so the proxy forwards the **captured raw buffer**
verbatim and **does not override** the content-type:

```js
let body: BodyInit | undefined;
if (hasRequestBody(req)) {
  const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (stashedRaw) {
    // Forward the exact bytes the client sent so downstream HMAC signature
    // verification (Slack/Linear webhooks) sees what the provider signed.
    // Do NOT override content-type — forwardRequestHeaders carries the original.
    body = stashedRaw;
  } else {
    // Fallback for any internal caller whose body wasn't raw-captured:
    // re-serialize the parsed JSON (legacy behavior).
    body = JSON.stringify(req.body ?? {});
    headers.set("content-type", "application/json");
  }
}
```

Notes:
- `content-length` is hop-by-hop (stripped by `forwardRequestHeaders`); `fetch` recomputes it from the
  body. No manual length handling needed.
- The original `content-type` (`application/json` or `application/x-www-form-urlencoded`) and the
  `x-slack-signature` / `x-slack-request-timestamp` headers are already forwarded by
  `forwardRequestHeaders`.
- Genuinely-JSON internal routes (config save, bridge actions) now forward their original JSON bytes
  (which are byte-identical to what they sent), so they remain correct; the fallback covers any caller
  that somehow lacks a captured raw body.

## Data flow (after fix), interactivity button

1. Slack POSTs `application/x-www-form-urlencoded` `payload=<urlencoded-json>` with
   `x-slack-signature` to `paperclip.blockcast.net` → API tier.
2. API tier `express.urlencoded({verify: captureRawBody})` parses → `req.body={payload:...}`,
   `req.rawBody=<exact bytes>`.
3. `worker-tier-proxy` forwards `req.rawBody` verbatim + original content-type + Slack headers to the
   worker.
4. Worker `express.urlencoded` re-parses → `req.body={payload:...}`, `req.rawBody=<same bytes>`.
5. `plugins.ts` dispatches `handleWebhook({ rawBody, parsedBody:req.body, headers })`.
6. Plugin `verifySlackSignature(headers, rawBody)` → HMAC over the original bytes **matches**. ✅
7. Interactivity handler reads `body.payload` → `JSON.parse` → `block_actions` →
   `approval_approve`/`approval_reject` → allowlist check → `resolvePaperclipApproval` → card
   `chat.update`. ✅

## Testing (TDD — failing test first)

1. **Proxy, form-urlencoded (RED→GREEN):** a `application/x-www-form-urlencoded` request with body
   `payload=%7B...%7D` is forwarded to the worker with the **exact same raw bytes** and the original
   `content-type` (asserts NOT `"{}"`, NOT forced `application/json`). Fails today.
2. **Proxy, JSON no-regression:** an `application/json` request forwards a byte-identical body and
   content-type.
3. **Proxy, fallback:** when `req.rawBody` is absent but `req.body` is set, the legacy
   `JSON.stringify` path is used (keeps internal callers working).
4. **App body-parsing:** a form-urlencoded POST yields `req.body.payload` populated and `req.rawBody`
   captured.
5. **Slack plugin (end-to-end-ish):** a correctly-signed `block_actions` interactivity payload passes
   `verifySlackSignature` and drives `approval_approve` → approval resolved (mirrors the live ✅ test).
6. **Regression guard for rich events:** a signed JSON event whose exact bytes differ from
   `JSON.stringify(parse(bytes))` (e.g. multibyte content) verifies after the fix — proving the same
   change resolves the rich/multibyte class.

## Rollout & verification

- Branch off `master` (the bug is on master; do not stack on the outbox branch).
- PR → CI `docker.yml` builds `harbor.blockcast.net/paperclip/paperclip:sha-<7>-k8s-vendored` and
  helm-deploys on merge to `paperclip:master`. Do NOT hand-deploy.
- Post-deploy live verify: create an approval via API → card posts → click **Approve** button →
  approval flips to `approved` (API probe) + card `chat.update`s to "approved by …"; worker logs show
  the `slack-interactivity` webhook **accepted** (no `hmac_mismatch`).
- Confirm the benign rich-message `hmac_mismatch` stream in `slack-events` also stops.

## Risks

- **Blast radius:** Change B touches all worker-dependent proxied routes. Mitigated by the raw-body
  fallback and proxy regression tests (#2, #3).
- **Body limit:** urlencoded parser uses the same 10mb limit as JSON — consistent, no new exposure.
- **Security:** HMAC stays strict; this only restores the correct bytes for verification. No relaxation.

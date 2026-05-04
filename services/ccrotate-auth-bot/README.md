# ccrotate-auth-bot

Long-lived Chromium session pool that keeps cookies warm for every
ccrotate-saved Anthropic / OpenAI account, so credential refreshes
("snap") don't require manual login per pod restart.

## Why

`ccrotate snap --force` reads `~/.claude/.credentials.json` (or
`~/.codex/auth.json`) — files written by the official `claude` / `codex`
CLIs after their OAuth callback fires. Those CLIs need a logged-in
browser session to complete OAuth.

When a ccrotate forced switch lands on an account whose stored OAuth
token has been revoked (which surfaces as `401 Unauthorized` from
`api.anthropic.com` mid-run), the only way to recover is to re-run
`<cli> /login` while a browser session for that exact email is alive.

This bot keeps one persistent profile dir per email, drives the relogin
on demand, and runs `ccrotate snap` to re-capture the new credentials.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ paperclip-0 (claude_k8s adapter)                                │
│   detects 401 from api.anthropic.com mid-run                    │
│   POST http://ccrotate-auth-bot:7000/relogin                    │
│        body: {email, target}                                    │
│   (no auth header — NetworkPolicy gates ingress to paperclip-0) │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ ccrotate-auth-bot pod                                           │
│   ├─ probe: navigate /api/account → 200? → snap, return ok      │
│   ├─ codex: fill email + password → submit → snap → return ok   │
│   ├─ claude: fill email → "code sent" → return 202 awaiting     │
│   │            (orchestrator/operator submits code)             │
│   └─ /data/profiles/<sha16(email)>/   <-- PVC, persistent       │
└─────────────────────────────────────────────────────────────────┘
```

## Endpoints

No auth headers — ingress is restricted by the bundled NetworkPolicy:
only pods labeled `app.kubernetes.io/name=paperclip` (i.e. `paperclip-0`)
can reach `:7000`. VNC ports (`5900` raw, `6080` noVNC) bind to
localhost inside the container (`x11vnc -localhost`,
`websockify localhost:6080 localhost:5900`) and are reachable only via
`kubectl port-forward`, which tunnels through the apiserver's SPDY
stream rather than the cluster pod network — no NetworkPolicy rule is
needed for operator access.

Naming note: this is `/relogin`, distinct from the kkroo plugin's
`/refresh` (`packages/plugins/paperclip-plugin-ccrotate/src/worker.ts`,
`handleRefresh`). The plugin's `/refresh` shells `ccrotate refresh` and
reuses existing tokens. This service handles the case `ccrotate refresh`
cannot — refresh_token is revoked.

| Method | Path           | Body                | Returns                                  |
|--------|----------------|---------------------|------------------------------------------|
| GET    | `/health`      | —                   | `{ ok, uptimeSec, pendingFlows }`        |
| GET    | `/accounts`    | —                   | `{ claude: [...], codex: [...] }`        |
| GET    | `/status`      | `?email=&target=`   | `{ loggedIn, observedEmail }`            |
| POST   | `/relogin`     | `{email, target}`   | `200 ok` or `202 awaitingCode`           |
| POST   | `/snap`        | `{email, target}`   | bare `ccrotate snap`, no login flow      |
| POST   | `/submitCode`  | `{email, code}`     | continues parked claude flow + snap      |
| POST   | `/logout`      | `{email, target}`   | `rm -rf` profile dir; forces relogin     |
| GET    | `/vnc-info`    | —                   | port-forward + URL                       |

## Setup

Secret already created (this session):

```sh
kubectl -n paperclip get secret paperclip-ccrotate-auth-bot-creds -o json | jq '.data | keys'
# ["accounts.json","openai_password"]
```

(If `control_token` is still present from an older v1, it's harmless —
the bot doesn't read it.)

Apply the manifest:

```sh
# Load the actual script into the configmap (the manifest ships a stub):
kubectl -n paperclip create configmap ccrotate-auth-bot-script \
  --from-file=script.mjs=services/ccrotate-auth-bot/bot.mjs \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f services/ccrotate-auth-bot/manifest.yaml
kubectl -n paperclip rollout status deploy/ccrotate-auth-bot
```

## First-time login per account

Sessions stay alive for weeks once cookies are present, so this is a
one-time cost:

```sh
kubectl -n paperclip port-forward deploy/ccrotate-auth-bot 6080:6080
open http://localhost:6080/vnc.html
```

In the VNC window, manually log in to `claude.ai` and `chatgpt.com`
once per email. Cookies land on the PVC and survive pod restarts. To
target a specific email's profile dir, set `HEADLESS=false` in the
deployment env (default is `true`) — VNC then mirrors the bot's
Chromium when an in-flight `/relogin` is running.

## postRun integration (paperclip)

Wire a postRun hook that detects 401 from upstream and pings the bot.
Sketch (TypeScript, lives next to the existing `ccrotate-state-hook.ts`):

```ts
// On run finalization, if the run failed with provider_quota_exhausted
// or stderr contained "401" from api.anthropic.com / api.openai.com,
// fire-and-forget POST to ccrotate-auth-bot. NetworkPolicy gates ingress
// to only paperclip-0, so no auth header is needed.
async function notifyAuthBot(email: string, target: "claude" | "codex") {
  await fetch("http://ccrotate-auth-bot.paperclip.svc:7000/relogin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, target }),
  }).catch(() => {});
}
```

## Operational notes

- **Sessions persist for weeks**, so `/relogin` is usually a fast no-op
  (probe says `loggedIn: true`, snap runs in <1s).
- **MFA / CAPTCHA**: codex auto-login will hit the
  `waitForURL(!/\/auth\//)` timeout if Auth0 challenges with MFA. The
  flow then expects an operator to complete it via VNC; the parked
  Chromium stays alive until the next pod restart.
- **Claude email-code flow**: the bot does not pull magic codes from
  email itself. Wire a paperclip agent with Gmail MCP enabled to
  receive the `202 awaitingCode` response and POST back the code via
  `/submitCode`. (TODO: ship that agent as a separate routine.)
- **Password rotation**: change the secret value in
  `paperclip-ccrotate-auth-bot-creds` and bounce the pod. Shared
  password across all codex accounts is a soft v1; track per-account
  passwords as `openai_creds.json: {"<email>": "<pw>", ...}` if any
  account ever needs to differ.
- **Profile dir corruption**: if Chromium starts crashlooping after a
  power-loss event, `POST /logout` for the affected email or
  `kubectl exec` and `rm -rf /data/profiles/<dir>`.

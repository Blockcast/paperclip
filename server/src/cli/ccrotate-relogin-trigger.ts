/**
 * Lifecycle hook helper: when a `provider_quota_exhausted` event fires
 * (signaling an upstream 401 / rate limit on the active ccrotate account),
 * notify the in-cluster ccrotate-auth-bot to drive a re-login + snap.
 *
 * Wire as instance setting `general.quotaExhaustedCmd`:
 *
 *   node /app/server/dist/cli/ccrotate-relogin-trigger.js
 *
 * Reads env vars set by `runQuotaExhaustedHook`:
 *   PAPERCLIP_AGENT_ID
 *   PAPERCLIP_COMPANY_ID
 *   PAPERCLIP_RUN_ID
 *   PAPERCLIP_ADAPTER_TYPE   — claude_k8s, claude_local, opencode_k8s, codex_local
 *   PAPERCLIP_ERROR_CODE
 *
 * Maps the adapter to the ccrotate target (claude vs codex), looks up the
 * currently-active email via `ccrotate active --target <t> --json`, and
 * fires `POST http://ccrotate-auth-bot.paperclip.svc:7000/relogin`. The
 * NetworkPolicy on the bot already restricts ingress to paperclip-0, so
 * no auth header is needed.
 *
 * Always exits 0 — never block the agent's recovery path on a bot side
 * problem. Failures land in stdout/stderr which `runQuotaExhaustedHook`
 * captures and logs at warn-level.
 */

import { spawnSync } from "node:child_process";

const BOT_URL = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
const REQUEST_TIMEOUT_MS = Number(process.env.CCROTATE_AUTH_BOT_TIMEOUT_MS ?? "10000");

function adapterToTarget(adapterType: string): "claude" | "codex" | null {
  if (/(^|_)(claude)(_|$)/.test(adapterType)) return "claude";
  if (/(^|_)(opencode|codex)(_|$)/.test(adapterType)) return "codex";
  return null;
}

function readActiveEmail(target: "claude" | "codex"): string | null {
  // `ccrotate --target <t> active --json` prints JSON like `{"email":"x@y","tier":"base"}`
  // when an account is active. Returns null if no active account.
  const r = spawnSync("ccrotate", ["--target", target, "active", "--json"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    const email = typeof parsed?.email === "string" ? parsed.email.trim() : "";
    return email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

async function notifyBot(email: string, target: "claude" | "codex"): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BOT_URL}/relogin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, target }),
      signal: ctrl.signal,
    });
    const body = await resp.text();
    console.log(`[ccrotate-relogin-trigger] ${resp.status} target=${target} email=${email} body=${body.slice(0, 200)}`);
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const adapterType = (process.env.PAPERCLIP_ADAPTER_TYPE ?? "").trim();
  const agentId = (process.env.PAPERCLIP_AGENT_ID ?? "").trim();
  const errorCode = (process.env.PAPERCLIP_ERROR_CODE ?? "").trim();
  if (!adapterType) {
    console.log("[ccrotate-relogin-trigger] no PAPERCLIP_ADAPTER_TYPE — skip");
    return;
  }
  const target = adapterToTarget(adapterType);
  if (!target) {
    console.log(`[ccrotate-relogin-trigger] adapterType=${adapterType} doesn't map to a ccrotate target — skip`);
    return;
  }
  const email = readActiveEmail(target);
  if (!email) {
    console.log(`[ccrotate-relogin-trigger] no active ${target} account — skip`);
    return;
  }
  console.log(`[ccrotate-relogin-trigger] agent=${agentId} adapter=${adapterType} target=${target} email=${email} errorCode=${errorCode}`);
  await notifyBot(email, target);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ccrotate-relogin-trigger] fatal: ${msg}`);
}).finally(() => {
  // Always exit 0 — recovery path must not be blocked by bot-side issues.
  process.exit(0);
});

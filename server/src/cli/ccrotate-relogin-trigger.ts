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
 * currently-active email by parsing `ccrotate --target <t> status` output,
 * and fires `POST http://ccrotate-auth-bot.paperclip.svc:7000/relogin`. The
 * NetworkPolicy on the bot already restricts ingress to paperclip-0, so
 * no auth header is needed.
 *
 * If the bot returns failure (5xx, error in body, or `awaitingCode` for the
 * claude operator-driven flow) AND `PAPERCLIP_SLACK_ESCALATION_WEBHOOK_URL`
 * is set, post a one-line escalation to Slack so an operator can intervene
 * (run `claude /login` + `ccrotate snap` locally, or drive the auth-bot's
 * VNC manual-login flow).
 *
 * Always exits 0 — never block the agent's recovery path on a bot or Slack
 * side problem. Failures land in stdout/stderr which `runQuotaExhaustedHook`
 * captures and logs at warn-level.
 */

import { spawnSync } from "node:child_process";

const BOT_URL = process.env.CCROTATE_AUTH_BOT_URL ?? "http://ccrotate-auth-bot.paperclip.svc:7000";
const REQUEST_TIMEOUT_MS = Number(process.env.CCROTATE_AUTH_BOT_TIMEOUT_MS ?? "10000");
const SLACK_WEBHOOK_URL = (process.env.PAPERCLIP_SLACK_ESCALATION_WEBHOOK_URL ?? "").trim();
const SLACK_TIMEOUT_MS = Number(process.env.PAPERCLIP_SLACK_ESCALATION_TIMEOUT_MS ?? "5000");

function adapterToTarget(adapterType: string): "claude" | "codex" | null {
  if (/(^|_)(claude)(_|$)/.test(adapterType)) return "claude";
  if (/(^|_)(opencode|codex)(_|$)/.test(adapterType)) return "codex";
  return null;
}

function readActiveEmail(target: "claude" | "codex"): string | null {
  // ccrotate has no `active` subcommand — `status` is the closest signal.
  // First line is `🔍 Checking usage tier for <email>...` (claude) or
  // `🔍 Checking Codex usage for <email>...` (codex). We pull the email out
  // of `for <email>...` (or any `<local>@<domain>` token in the output).
  const r = spawnSync("ccrotate", ["--target", target, "status"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = out.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

interface BotResponse {
  status: number;
  body: string;
  parsed: Record<string, unknown> | null;
}

async function notifyBot(email: string, target: "claude" | "codex"): Promise<BotResponse> {
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
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      // non-JSON response — treat as failure with raw body in escalation
    }
    console.log(
      `[ccrotate-relogin-trigger] ${resp.status} target=${target} email=${email} body=${body.slice(0, 200)}`,
    );
    return { status: resp.status, body, parsed };
  } finally {
    clearTimeout(t);
  }
}

interface EscalationContext {
  reason: "bot_unreachable" | "bot_returned_error" | "operator_action_required";
  detail: string;
  target: "claude" | "codex";
  email: string;
  agentId: string;
  runId: string;
  errorCode: string;
}

function classifyBotResult(
  resp: BotResponse | { error: string },
): { needsEscalation: false } | { needsEscalation: true; reason: EscalationContext["reason"]; detail: string } {
  if ("error" in resp) {
    return { needsEscalation: true, reason: "bot_unreachable", detail: resp.error };
  }
  if (resp.status >= 500) {
    return {
      needsEscalation: true,
      reason: "bot_returned_error",
      detail: `bot HTTP ${resp.status}: ${resp.body.slice(0, 200)}`,
    };
  }
  // Bot returns 202 + awaitingCode for the claude email-magic-code flow that
  // requires an operator to type the code from the inbox into the VNC session.
  // Without operator action the relogin never completes, so escalate.
  if (resp.status === 202 && resp.parsed && resp.parsed.awaitingCode === true) {
    return {
      needsEscalation: true,
      reason: "operator_action_required",
      detail: "claude email-magic-code flow waiting on operator (drive VNC + POST /submitCode)",
    };
  }
  if (resp.parsed && typeof resp.parsed.error === "string") {
    return {
      needsEscalation: true,
      reason: "bot_returned_error",
      detail: resp.parsed.error,
    };
  }
  return { needsEscalation: false };
}

async function postSlackEscalation(ctx: EscalationContext): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  const lines: string[] = [
    `:warning: *ccrotate auth-bot recovery needs human help* (${ctx.reason})`,
    `• target: \`${ctx.target}\`   email: \`${ctx.email}\``,
    `• agent: \`${ctx.agentId || "?"}\`   runId: \`${ctx.runId || "?"}\`   errorCode: \`${ctx.errorCode || "?"}\``,
    `• detail: ${ctx.detail.slice(0, 400)}`,
    ctx.target === "claude"
      ? "Recovery: run `claude /logout && claude /login` (sign in as the email above) and `ccrotate snap --force` on devbox; sync cron will mirror to cluster."
      : "Recovery: run `codex login --device-auth` (sign in as the email above) and `ccrotate --target codex snap --force` on devbox.",
  ];
  const payload = { text: lines.join("\n") };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SLACK_TIMEOUT_MS);
  try {
    const resp = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[ccrotate-relogin-trigger] slack webhook ${resp.status}: ${body.slice(0, 200)}`,
      );
      return;
    }
    console.log(`[ccrotate-relogin-trigger] slack escalation posted (reason=${ctx.reason})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ccrotate-relogin-trigger] slack post failed: ${msg}`);
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const adapterType = (process.env.PAPERCLIP_ADAPTER_TYPE ?? "").trim();
  const agentId = (process.env.PAPERCLIP_AGENT_ID ?? "").trim();
  const runId = (process.env.PAPERCLIP_RUN_ID ?? "").trim();
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

  let result: { needsEscalation: false } | { needsEscalation: true; reason: EscalationContext["reason"]; detail: string };
  try {
    const botResp = await notifyBot(email, target);
    result = classifyBotResult(botResp);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = classifyBotResult({ error: msg });
  }

  if (result.needsEscalation) {
    await postSlackEscalation({
      reason: result.reason,
      detail: result.detail,
      target,
      email,
      agentId,
      runId,
      errorCode,
    });
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ccrotate-relogin-trigger] fatal: ${msg}`);
}).finally(() => {
  // Always exit 0 — recovery path must not be blocked by bot-side issues.
  process.exit(0);
});

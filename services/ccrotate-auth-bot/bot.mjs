// ccrotate-auth-bot — keeps a Chromium session alive per ccrotate-saved
// email so we can refresh OAuth credentials without manual login each time.
//
// Architecture
// ────────────
//
//   per-email persistent profile dir → /data/profiles/<sha16(email)>
//
// Sessions on claude.ai and chatgpt.com last weeks-to-months once cookies
// are present. The bot's job is to keep those cookies around (PVC) and
// expose a control plane that:
//
//   1. probes whether profile <email> is still logged in
//   2. drives the relogin flow when it isn't:
//        - codex: shared password from secret → form fill → submit
//        - claude: email + magic-code (operator-assisted via VNC, OR
//                  agent-assisted via a /submitCode callback)
//   3. invokes `ccrotate snap --force --target <t>` AFTER the underlying
//      `claude`/`codex` CLI's credentials file has been refreshed, so the
//      ccrotate profile picks up the new tokens.
//
// IMPORTANT: ccrotate snap reads ~/.claude/.credentials.json (claude target)
// or ~/.codex/auth.json (codex target). Those files are written by the
// official `claude` and `codex` CLIs after their OAuth callback fires —
// NOT by browser cookies alone. The bot drives the browser side of the
// CLI's PKCE handshake; the CLI is what ultimately writes the file.
//
// Endpoints (no auth — cluster network is the boundary; pin further with
// NetworkPolicy if any non-paperclip-0 pod ever needs to be excluded)
// ─────────────────────────────────────────────────────────────
//
// Distinct from `paperclip-plugin-ccrotate`'s `/refresh` route
// (`packages/plugins/paperclip-plugin-ccrotate/src/worker.ts:201` —
// `handleRefresh`), which shells `ccrotate refresh` to repopulate
// tier-cache using EXISTING tokens. This service handles the case
// `ccrotate refresh` cannot — the refresh_token itself is revoked
// (Anthropic ~30d idle expiry, manual "log out everywhere" in claude.ai,
// etc.). Hence /relogin, not /refresh. NetworkPolicy in manifest.yaml
// is the auth boundary; deleting it removes the only access control.
//
//   GET  /health                       — { ok, uptimeSec, browserUp }
//   GET  /accounts                     — { claude: [...], codex: [...] }
//   GET  /status?email=&target=        — { loggedIn, observedEmail, error? }
//   POST /relogin     {email, target}  — full OAuth re-login flow: status →
//                                        login (codex auto, claude requires
//                                        VNC or /submitCode) → ccrotate snap
//   POST /snap        {email, target}  — bare ccrotate snap, no login flow
//   POST /logout      {email, target}  — clear profile dir (forces relogin)
//   POST /submitCode  {email, code}    — submit magic code for in-flight
//                                        claude relogin (orchestrator path)
//   POST /manualLogin {email, target}  — open a non-headless persistent
//                                        context to login URL for VNC-driven
//                                        manual auth. Stays open until
//                                        /closeManual or 30-min timeout.
//   POST /closeManual {email, target}  — flush cookies + close the manual
//                                        session. Operator should run
//                                        /snap afterward to capture into
//                                        ccrotate.
//   GET  /vnc-info                     — port-forward instructions
//
// Driven by paperclip's adapter postRun hook when a 401 surfaces for the
// currently-active ccrotate email.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// ─── Config (env) ──────────────────────────────────────────────────────────

const PROFILE_ROOT = process.env.PROFILE_ROOT || "/data/profiles";
const CONTROL_PORT = Number(process.env.CONTROL_PORT || "7000");
const OPENAI_PASSWORD = process.env.OPENAI_PASSWORD || "";
const ACCOUNTS_JSON_RAW = process.env.ACCOUNTS_JSON || '{"claude":[],"codex":[]}';
const CCROTATE_BIN = process.env.CCROTATE_BIN || "ccrotate";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const HEADLESS = process.env.HEADLESS !== "false";
const STATUS_TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS || "20000");
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS || "120000");

const ACCOUNTS = JSON.parse(ACCOUNTS_JSON_RAW);
const VALID_TARGETS = new Set(["claude", "codex"]);

const startedAt = Date.now();

// ─── Profile dir layout ────────────────────────────────────────────────────

function profileDir(email, target) {
  const hash = createHash("sha256").update(`${target}:${email}`).digest("hex").slice(0, 16);
  return path.join(PROFILE_ROOT, `${target}-${hash}`);
}

async function ensureProfileDir(email, target) {
  const dir = profileDir(email, target);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ─── Pending-code flow (claude email magic code) ───────────────────────────
//
// When /relogin is called for a claude account, we navigate to claude.ai/login,
// fill the email, and click "Continue". Anthropic emails a code. The browser
// is now sitting on the "enter code" screen. We park the active Page in
// `pendingCodeFlows` keyed by email and return 202 from /relogin. The
// orchestrator (or operator) hits /submitCode with the code; we type it,
// click submit, then run ccrotate snap.

const pendingCodeFlows = new Map(); // email -> { page, context, deadline, target }

function expirePendingFlows() {
  const now = Date.now();
  for (const [email, flow] of pendingCodeFlows.entries()) {
    if (flow.deadline < now) {
      pendingCodeFlows.delete(email);
      flow.context?.close().catch((e) =>
        console.error("[ccrotate-auth-bot] expirePendingFlows close failed", email, e?.message),
      );
    }
  }
}
setInterval(expirePendingFlows, 30_000).unref();

// ─── Browser context per profile ───────────────────────────────────────────

async function openContext(email, target) {
  const dir = await ensureProfileDir(email, target);
  return chromium.launchPersistentContext(dir, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
}

// ─── Login flows ───────────────────────────────────────────────────────────

// Per-(email,target) in-flight serialization. Two simultaneous /relogin
// calls would both call `chromium.launchPersistentContext` against the
// same profile dir and the second one fails with a SingletonLock error.
// Coalesce by returning the in-flight promise.
const inFlightRelogin = new Map();

// Long-lived manual-login sessions (operator drives via VNC). Same
// SingletonLock concern as inFlightRelogin — while a manual session is
// open for `${target}:${email}`, no /relogin or /status call may run
// against the same profile dir.
const manualSessions = new Map(); // key -> { context, page, deadline }
const MANUAL_SESSION_TIMEOUT_MS = 30 * 60_000; // 30 min

function expireManualSessions() {
  const now = Date.now();
  for (const [key, sess] of manualSessions.entries()) {
    if (sess.deadline < now) {
      manualSessions.delete(key);
      sess.context?.close().catch((e) =>
        console.error("[ccrotate-auth-bot] expireManual close failed", key, e?.message),
      );
    }
  }
}
setInterval(expireManualSessions, 60_000).unref();

function manualSessionKey(email, target) {
  return `${target}:${email}`;
}

async function openManualSession(email, target) {
  const key = manualSessionKey(email, target);
  if (manualSessions.has(key)) {
    return { alreadyOpen: true };
  }
  const dir = await ensureProfileDir(email, target);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false, // explicit — operator drives via VNC
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await ctx.newPage();
  const url =
    target === "claude" ? "https://claude.ai/login" : "https://chatgpt.com/auth/login";
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  manualSessions.set(key, {
    context: ctx,
    page,
    deadline: Date.now() + MANUAL_SESSION_TIMEOUT_MS,
  });
  return { alreadyOpen: false };
}

async function closeManualSession(email, target) {
  const key = manualSessionKey(email, target);
  const sess = manualSessions.get(key);
  if (!sess) return { wasOpen: false };
  manualSessions.delete(key);
  // Persistent context flushes cookies/localStorage to the profile dir on
  // close. Don't clear the dir — that's what /logout is for.
  await sess.context.close().catch((e) =>
    console.error("[ccrotate-auth-bot] closeManual ctx.close failed", key, e?.message),
  );
  return { wasOpen: true };
}

function serializeRelogin(email, target, fn) {
  const key = `${target}:${email}`;
  const existing = inFlightRelogin.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlightRelogin.delete(key);
    }
  })();
  inFlightRelogin.set(key, p);
  return p;
}

function ensureNotManuallyOpen(email, target) {
  const key = manualSessionKey(email, target);
  if (manualSessions.has(key)) {
    throw new Error(
      `manual session is open for ${key} — close it via POST /closeManual before running this op`,
    );
  }
}

async function probeStatus(email, target) {
  ensureNotManuallyOpen(email, target);
  const ctx = await openContext(email, target);
  try {
    const page = await ctx.newPage();
    if (target === "claude") {
      // claude.ai redirects logged-in users to /chats. /api/account 200 →
      // logged in, with a `email_address` field. 401 → not logged in.
      const resp = await page.goto("https://claude.ai/api/account/profile", {
        timeout: STATUS_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      const status = resp?.status() ?? 0;
      if (status === 200) {
        const json = await resp.json().catch(() => null);
        const observedEmail = json?.account?.email_address ?? json?.email_address ?? null;
        return { loggedIn: true, observedEmail };
      }
      return { loggedIn: false, observedEmail: null, httpStatus: status };
    } else {
      // chatgpt.com: /backend-api/me returns 200 with email when logged in,
      // 401/403 otherwise.
      const resp = await page.goto("https://chatgpt.com/backend-api/me", {
        timeout: STATUS_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      const status = resp?.status() ?? 0;
      if (status === 200) {
        const json = await resp.json().catch(() => null);
        const observedEmail = json?.email ?? null;
        return { loggedIn: true, observedEmail };
      }
      return { loggedIn: false, observedEmail: null, httpStatus: status };
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Click the form's primary submit button. Prefer button[type=submit]
// inside the active form (the OAuth providers' "Continue with Google /
// Apple / Microsoft" buttons all match `/continue/i` — picking by role
// alone with `.first()` clicks SSO instead of email-submit). If no
// type=submit found, fall back to the role+exact-name match.
async function clickPrimarySubmit(page, exactName) {
  const submitBtn = page.locator('form button[type="submit"]:not([disabled])').first();
  if (await submitBtn.count()) {
    await submitBtn.click();
    return;
  }
  await page.getByRole("button", { name: new RegExp(`^\\s*${exactName}\\s*$`, "i") }).first().click();
}

async function loginCodex(email) {
  if (!OPENAI_PASSWORD) {
    throw new Error("OPENAI_PASSWORD not set in secret — cannot auto-login codex");
  }
  const ctx = await openContext(email, "codex");
  const page = await ctx.newPage();
  try {
    await page.goto("https://chatgpt.com/auth/login", { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
    // OpenAI's email field. Selector is unstable across Auth0 redesigns.
    const emailInput = page.locator('input[name="username"], input[type="email"], input#email-input').first();
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(email);
    await clickPrimarySubmit(page, "Continue");
    const pwInput = page.locator('input[name="password"], input[type="password"]').first();
    await pwInput.waitFor({ timeout: 30_000 });
    await pwInput.fill(OPENAI_PASSWORD);
    await clickPrimarySubmit(page, "Continue");
    // Wait for redirect away from /auth/. If MFA is required this will hang
    // until the operator handles it via VNC.
    await page.waitForURL((url) => !/\/auth\//.test(url.toString()), { timeout: LOGIN_TIMEOUT_MS });
    return { ok: true };
  } finally {
    await ctx.close().catch((e) => console.error("[ccrotate-auth-bot] loginCodex ctx.close failed", email, e?.message));
  }
}

async function loginClaudeBegin(email) {
  // Returns immediately after submitting the email, with the page parked on
  // the "enter code" screen. Caller must follow up with /submitCode.
  const ctx = await openContext(email, "claude");
  const page = await ctx.newPage();
  await page.goto("https://claude.ai/login", { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
  const emailInput = page.locator('input[type="email"], input[name="email"], input#email-input').first();
  await emailInput.waitFor({ timeout: 30_000 });
  await emailInput.fill(email);
  // Form-scoped submit so we don't accidentally click "Continue with Google".
  await clickPrimarySubmit(page, "Continue with email");
  const codeInput = page
    .locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]')
    .first();
  await codeInput.waitFor({ timeout: 30_000 });
  pendingCodeFlows.set(email, {
    context: ctx,
    page,
    deadline: Date.now() + LOGIN_TIMEOUT_MS,
    target: "claude",
  });
  return { ok: true, awaitingCode: true };
}

async function submitClaudeCode(email, code) {
  const flow = pendingCodeFlows.get(email);
  if (!flow) throw new Error(`no pending code flow for ${email}`);
  pendingCodeFlows.delete(email);
  const { page, context } = flow;
  try {
    const codeInput = page
      .locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]')
      .first();
    await codeInput.fill(code);
    // Some auth flows auto-submit on the last digit; tolerate "no submit
    // button" by catching only that specific case. Other click failures
    // (detached frame, navigation already in flight) should propagate.
    try {
      await clickPrimarySubmit(page, "Verify");
    } catch (e) {
      const msg = e?.message ?? "";
      const benign = /no element|no nodes|not found|no buttons|locator\.count/i.test(msg);
      if (!benign) throw e;
    }
    await page.waitForURL(
      (url) => /\/chats?$/.test(url.toString()) || !/\/login/.test(url.toString()),
      { timeout: LOGIN_TIMEOUT_MS },
    );
    return { ok: true };
  } finally {
    await context
      .close()
      .catch((e) => console.error("[ccrotate-auth-bot] submitClaudeCode ctx.close failed", email, e?.message));
  }
}

// ─── ccrotate snap invocation ──────────────────────────────────────────────
//
// V1 scope: `runCcrotateSnap` only shells `ccrotate snap --force --email <x>`.
// It does NOT spawn `claude /login` or `codex login` — those would be
// needed to write fresh tokens into ~/.claude/.credentials.json or
// ~/.codex/auth.json before snap captures them.
//
// Today snap is best-effort against whatever credentials already exist in
// those files; the browser login refreshes the *cookie*, not the CLI's
// credentials file. That's enough for the case the kkroo plugin cares
// about (re-warm the active OAuth session for an account whose cookie
// expired but whose refresh_token is still alive). For the harder case
// (refresh_token revoked), wiring the actual CLI handshake is a v2 TODO —
// the bot's persistent profile context is already half the work since
// the OAuth callback would land in the bot's Chromium with a valid
// session cookie.

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    const out = [];
    const err = [];
    let killedByTimeout = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killedByTimeout = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        return reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms (signal=${signal ?? "?"})`));
      }
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

async function runCcrotateSnap(target, email) {
  const args = ["--target", target, "snap", "--force", "--email", email];
  const r = await runCmd(CCROTATE_BIN, args, { timeoutMs: 30_000 });
  if (r.code !== 0) {
    const detail =
      r.stderr.trim() ||
      r.stdout.trim() ||
      `(no output; code=${r.code} signal=${r.signal ?? "?"})`;
    throw new Error(`ccrotate snap failed (exit ${r.code}): ${detail}`);
  }
  return r.stdout.trim();
}

// ─── HTTP control plane ────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function validate({ email, target }) {
  if (!email || typeof email !== "string") return "email is required";
  if (!target || !VALID_TARGETS.has(target)) return "target must be 'claude' or 'codex'";
  const list = ACCOUNTS[target] ?? [];
  if (!list.includes(email)) return `email not in ${target} pool (${list.length} known)`;
  return null;
}

const handlers = {
  "GET /health": async (_req, res) => {
    writeJson(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      pendingFlows: Array.from(pendingCodeFlows.keys()),
    });
  },

  "GET /accounts": async (_req, res) => {
    writeJson(res, 200, ACCOUNTS);
  },

  "GET /status": async (req, res) => {
    const url = new URL(req.url, "http://x");
    const email = url.searchParams.get("email");
    const target = url.searchParams.get("target");
    const err = validate({ email, target });
    if (err) return writeJson(res, 400, { error: err });
    try {
      const result = await probeStatus(email, target);
      writeJson(res, 200, { email, target, ...result });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /status failed", { email, target, err: e?.stack ?? e?.message });
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /relogin": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const err = validate(body);
    if (err) return writeJson(res, 400, { error: err });
    const { email, target } = body;
    try {
      const result = await serializeRelogin(email, target, async () => {
        const status = await probeStatus(email, target);
        if (!status.loggedIn) {
          if (target === "codex") {
            await loginCodex(email);
          } else {
            await loginClaudeBegin(email);
            return { kind: "awaitingCode" };
          }
        }
        const snapOut = await runCcrotateSnap(target, email);
        return { kind: "ok", snapOut };
      });
      if (result.kind === "awaitingCode") {
        return writeJson(res, 202, {
          email,
          target,
          awaitingCode: true,
          note: "Claude email-code flow started. POST /submitCode {email, code} to continue.",
          expiresInSec: Math.round(LOGIN_TIMEOUT_MS / 1000),
        });
      }
      writeJson(res, 200, { email, target, ok: true, snapStdout: result.snapOut });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /relogin failed", { email, target, err: e?.stack ?? e?.message });
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /snap": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const err = validate(body);
    if (err) return writeJson(res, 400, { error: err });
    try {
      const out = await runCcrotateSnap(body.target, body.email);
      writeJson(res, 200, { ok: true, snapStdout: out });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /snap failed", { ...body, err: e?.stack ?? e?.message });
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /submitCode": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const { email, code } = body;
    if (!email || !code) return writeJson(res, 400, { error: "email and code required" });
    try {
      await submitClaudeCode(email, code);
      const out = await runCcrotateSnap("claude", email);
      writeJson(res, 200, { ok: true, snapStdout: out });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /submitCode failed", { email, err: e?.stack ?? e?.message });
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /logout": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const err = validate(body);
    if (err) return writeJson(res, 400, { error: err });
    const dir = profileDir(body.email, body.target);
    try {
      // Close any open manual session before nuking the dir, otherwise
      // Chromium can hang on detached files.
      await closeManualSession(body.email, body.target);
      await fs.rm(dir, { recursive: true, force: true });
      writeJson(res, 200, { ok: true, cleared: dir });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /logout failed", { ...body, err: e?.stack ?? e?.message });
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /manualLogin": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const err = validate(body);
    if (err) return writeJson(res, 400, { error: err });
    try {
      const result = await openManualSession(body.email, body.target);
      writeJson(res, 200, {
        ...body,
        ...result,
        expiresInSec: Math.round(MANUAL_SESSION_TIMEOUT_MS / 1000),
        note: "Drive via VNC. CLOSE THE BROWSER WINDOW (don't click Sign out) when done, then POST /closeManual to flush + POST /snap to capture.",
      });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /manualLogin failed", body, e?.stack ?? e?.message);
      writeJson(res, 500, { error: e.message });
    }
  },

  "POST /closeManual": async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const err = validate(body);
    if (err) return writeJson(res, 400, { error: err });
    try {
      const result = await closeManualSession(body.email, body.target);
      writeJson(res, 200, { ...body, ...result });
    } catch (e) {
      console.error("[ccrotate-auth-bot] /closeManual failed", body, e?.stack ?? e?.message);
      writeJson(res, 500, { error: e.message });
    }
  },

  "GET /vnc-info": async (_req, res) => {
    writeJson(res, 200, {
      portForward: "kubectl -n paperclip port-forward deploy/ccrotate-auth-bot 6080:6080",
      url: "http://localhost:6080/vnc.html",
      note: "Use VNC to manually log in to claude.ai or chatgpt.com per email; cookies persist in profile dirs.",
    });
  },
};

const server = createServer(async (req, res) => {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const handler = handlers[key];
  if (!handler) return writeJson(res, 404, { error: `no route: ${key}` });
  try {
    await handler(req, res);
  } catch (e) {
    console.error("[ccrotate-auth-bot] handler threw", key, e?.stack ?? e?.message);
    if (!res.headersSent) writeJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(CONTROL_PORT, () => {
  console.log(`[ccrotate-auth-bot] listening on :${CONTROL_PORT}`);
  console.log(`[ccrotate-auth-bot] profile root: ${PROFILE_ROOT}`);
  console.log(
    `[ccrotate-auth-bot] accounts loaded: claude=${ACCOUNTS.claude?.length ?? 0} codex=${ACCOUNTS.codex?.length ?? 0}`,
  );
});

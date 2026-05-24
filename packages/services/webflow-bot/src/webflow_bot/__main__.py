#!/usr/bin/env python3
"""
Webflow Designer bot — long-lived Camoufox session that holds an authenticated
Webflow Designer with the "Webflow MCP Bridge App" launched, exposing an HTTP
control plane on port 7000 for cluster agents to drive Designer ops.

Replaces the previous Node+Chromium implementation (script.js). Chromium got
PX-challenged on every navigation of webflow.com / *.design.webflow.com routes
even with valid session cookies, causing constant session loss. Camoufox's
binary-level fingerprint randomization passes PX both on initial login and on
sustained browsing — verified 2026-05-07: 3+ minute idle on the Designer URL
without a challenge or redirect.

HTTP endpoints (auth: X-Control-Token header)
    GET  /health                      liveness + current page url
    POST /screenshot { fullPage? }    returns image/png
    POST /eval { code }               page.evaluate wrap; returns JSON
    POST /key { key }                 page.keyboard.press(key)
    POST /click { x, y }              page.mouse.click(x, y)
    POST /selectorClick { selector }  page.locator(selector).first.click()
    POST /setHtmlEmbed { elementId,   open Edit Code modal, replace via
                         html,         CodeMirror v6 EditorView.dispatch,
                         publish? }    save, optional publish
"""

import http.server
import json
import os
import sys
import threading
import time
import re
import traceback
from typing import Any

from camoufox.sync_api import Camoufox
from playwright.sync_api import Page, BrowserContext, TimeoutError as PWTimeout


PROFILE_DIR     = os.environ.get("PROFILE_DIR", "/config/playwright-profile")
SITE_URL        = os.environ.get("SITE_URL", "https://lisa-blockcast.design.webflow.com/")
DASHBOARD_URL   = "https://webflow.com/dashboard"
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "900"))
EMAIL           = os.environ.get("WEBFLOW_EMAIL", "")
PASSWORD        = os.environ.get("WEBFLOW_PASSWORD", "")
CONTROL_PORT    = int(os.environ.get("CONTROL_PORT", "7000"))
CONTROL_TOKEN   = os.environ.get("CONTROL_TOKEN", "")
PROXY_URL       = os.environ.get("WEBFLOW_BOT_PROXY", "")

STATE_FILE      = os.path.join(PROFILE_DIR, "camoufox-storage-state.json")

if not EMAIL or not PASSWORD:
    print("FATAL: WEBFLOW_EMAIL/WEBFLOW_PASSWORD not set", file=sys.stderr)
    sys.exit(2)

os.makedirs(PROFILE_DIR, exist_ok=True)


def log(*m: Any) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print("[bot " + ts + "]", *m, flush=True)


# Playwright sync_api binds its internal greenlet to the thread that
# created the Camoufox/page objects (main thread). Cross-thread access
# raises "Cannot switch to a different thread". So the HTTP server
# runs SINGLE-THREADED in the main thread; health probes piggyback
# on HTTPServer.service_actions() between requests rather than on
# a background thread. _page_lock is RLock for re-entry guards but
# there's only one operating thread by construction.
_page_lock = threading.RLock()
_page: Page | None = None
_context: BrowserContext | None = None
_status: dict = {"ready": False, "phase": "starting"}
_last_health_at: float = 0.0


def _set_phase(phase: str) -> None:
    _status["phase"] = phase
    _status["phase_at"] = time.time()


def _do_login(context: BrowserContext) -> None:
    page = context.new_page()
    try:
        log("login -> goto webflow.com/login")
        page.goto("https://webflow.com/login", wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(3_000)
        title_lc = (page.title() or "").lower()
        if "denied" in title_lc:
            raise RuntimeError("PX-blocked even on Camoufox login (title=" + title_lc + ")")
        email_input = page.locator('input[name="email"], input[type="email"]').first
        log("login -> filling email")
        email_input.press_sequentially(EMAIL, delay=30)
        pw_input = page.locator('input[name="password"], input[type="password"]').first
        if pw_input.count() == 0 or not pw_input.is_visible(timeout=1_000):
            log("login -> password field not visible, clicking Continue to advance")
            cont = page.get_by_role("button", name="Continue", exact=True).first
            if cont.count() == 0:
                cont = page.locator('button:has-text("Continue"):not(:has-text("SSO"))').first
            cont.click(timeout=5_000)
            page.wait_for_timeout(2_000)
            pw_input = page.locator('input[name="password"], input[type="password"]').first
            pw_input.wait_for(state="visible", timeout=15_000)
        log("login -> filling password")
        pw_input.press_sequentially(PASSWORD, delay=30)
        log("login -> submitting (click primary Continue)")
        submit = page.get_by_role("button", name="Continue", exact=True).first
        if submit.count() == 0:
            submit = page.locator('button[type="submit"]').first
        try:
            submit.click(timeout=5_000)
        except Exception as exc:
            log(f"login -> click submit failed ({exc}); falling back to Enter")
            page.keyboard.press("Enter")
        deadline = time.time() + 60
        while time.time() < deadline and "/login" in page.url:
            page.wait_for_timeout(500)
        if "/login" in page.url:
            body = page.evaluate("(() => document.body ? document.body.innerText.slice(0, 600) : '')()") or ""
            raise RuntimeError("login form did not redirect — body=" + body[:400])
        log("login -> redirected to " + page.url)
    finally:
        page.close()


def _on_login_required(context: BrowserContext) -> None:
    _set_phase("login")
    _do_login(context)
    try:
        context.storage_state(path=STATE_FILE)
        log("login -> storage_state saved to " + STATE_FILE)
    except Exception as e:
        log("login -> WARN: could not save storage_state:", e)


def _park_for_manual_login(page: Page, reason: Exception | str) -> None:
    _status["manual_login_required"] = True
    _status["manual_login_reason"] = str(reason)[:500]
    _set_phase("manual-login-required")
    log("manual login required; keeping VNC/control alive:", reason)
    try:
        if "/login" not in (page.url or ""):
            page.goto("https://webflow.com/login", wait_until="commit", timeout=5_000)
    except Exception as e:
        log("manual login: could not park browser on login page:", e)


def _clear_manual_login() -> None:
    _status.pop("manual_login_required", None)
    _status.pop("manual_login_reason", None)


def _is_logged_in(page: Page) -> bool:
    # First check for a valid wfsession cookie — URL-based checks alone
    # are unreliable because Webflow's /dashboard doesn't bounce
    # anonymous Camoufox requests to /login (Camoufox doesn't trip PX
    # so doesn't get the auth-gate redirect either way).
    try:
        cookies = page.context.cookies("https://webflow.com")
        wf = next((c for c in cookies if c.get("name") == "wfsession"), None)
        if wf is None:
            return False
        exp = wf.get("expires", -1)
        if isinstance(exp, (int, float)) and 0 < exp < time.time():
            # wfsession with a sub-now expiry = explicitly cleared by Webflow
            return False
    except Exception as e:
        log("session probe: cookie inspect failed:", e)
        # fall through to URL-based check
    try:
        page.goto(DASHBOARD_URL, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2_500)
    except PWTimeout:
        log("session probe: page.goto timeout (treating as logged out)")
        return False
    url = page.url
    if "/login" in url or "/auth/" in url:
        return False
    title_lc = (page.title() or "").lower()
    if "denied" in title_lc:
        return False
    return True


def _is_on_designer(page: Page) -> bool:
    # Designer canvas is reachable via two URL forms:
    #   - https://webflow.com/design/<slug>?...  (modern, used by SITE_URL)
    #   - https://<slug>.design.webflow.com/?... (legacy; what /design/<slug> redirects to)
    # Either form, with the left-sidebar Pages button present in the DOM,
    # means we're inside the Designer chrome (not the dashboard, not a
    # CAPTCHA, not the live preview).
    try:
        url = page.url or ""
        on_designer_url = (
            ("/design/" in url) or (".design.webflow.com" in url)
        )
        if not on_designer_url:
            return False
        return bool(page.evaluate(
            "(() => !!document.querySelector('[data-automation-id=\"left-sidebar-pages-button\"]'))()"
        ))
    except Exception:
        return False


def _has_bridge_app(page: Page) -> bool:
    # The Bridge App lives in an iframe served from a webflow-ext.com
    # subdomain. Its presence in the DOM is a sufficient signal that
    # mcp__webflow__de_page_tool will reach a live MCP target.
    try:
        return bool(page.evaluate(
            "(() => !!document.querySelector('iframe[src*=\"webflow-ext\"]'))()"
        ))
    except Exception:
        return False


def _open_designer(page: Page) -> None:
    # Idempotent: if we're already on the Designer canvas with Bridge
    # alive, skip the navigation. Re-issuing page.goto closes the
    # Bridge App popup, drops the canvas focus, and (on Camoufox) can
    # land on a press-and-hold anti-bot CAPTCHA that requires manual
    # intervention to clear (verified 2026-05-08, BLO-3979 thread).
    if _is_on_designer(page):
        if _has_bridge_app(page):
            log("designer + bridge already alive — skipping nav (url=" + (page.url or "") + ")")
            return
        log("on designer but bridge missing — re-launching bridge without nav")
        _try_launch_bridge_app(page)
        return
    log("opening designer at " + SITE_URL)
    try:
        page.goto(SITE_URL, wait_until="domcontentloaded", timeout=90_000)
    except Exception as e:
        # Camoufox sometimes returns NS_BINDING_ABORTED on Webflow's
        # /design/<slug> → <slug>.design.webflow.com redirect chain.
        # If the navigation aborted but we ended up on Designer
        # anyway, treat as success — the Designer canvas DOM is what
        # matters, not whether goto returned cleanly.
        log("designer goto raised " + type(e).__name__ + " (" + str(e)[:80] + "); checking final state")
    # Wait for Designer chrome to finish booting. The React app
    # mounts the left-sidebar-pages-button shortly after
    # domcontentloaded, but the timing varies (3-15s observed). Polling
    # the selector beats a fixed wait_for_timeout: we move on the
    # instant the DOM is ready, and if the page is something else
    # entirely (CAPTCHA, dashboard, login), we time out and fall
    # through to whatever caller logic handles it.
    try:
        page.wait_for_selector(
            '[data-automation-id="left-sidebar-pages-button"]',
            timeout=20_000,
            state="attached",
        )
    except Exception as e:
        log("designer chrome did not mount within 20s: " + type(e).__name__)
    page.wait_for_timeout(1_000)
    log("designer url=" + page.url + " title=" + (page.title() or ""))


def _try_launch_bridge_app(page: Page) -> None:
    # Five-step sequence verified 2026-05-08:
    #   1. Focus the canvas — Webflow's keyboard shortcuts only
    #      register when the canvas iframe (not the body) has focus.
    #      Without this, the 'E' keypress is swallowed by whatever
    #      panel was last open (or by nothing at all).
    #   2. Press 'E' — Apps panel hotkey (aria-label is "Apps (E)").
    #   3. Click the Bridge App row at the center of its container
    #      (NOT the leaf text SPAN — that has no click handler).
    #      JS walks up the DOM to find the row container ≥150px
    #      wide and clicks at its centroid.
    #   4. Wait for any visible button matching ^Launch( App)?$ and
    #      JS-click it. The button text varies by Apps-panel state:
    #      "Launch" inline vs "Launch App" in the detail panel.
    # Verified 2026-05-08 with the OAuth tokens in the
    # paperclip-webflow-mcp-oauth secret. Two failure modes that
    # this fix addresses:
    #   (a) Playwright's :text-matches() selector misses the button
    #       intermittently when Webflow's virtualized list mounts
    #       the row late — JS .find() against a fresh DOM snapshot
    #       avoids the selector-engine timing issue.
    #   (b) Clicking the leaf text span does nothing (no bubbling
    #       click handler) — walking up to the row container is
    #       what actually opens the detail panel.
    try:
        if not _is_on_designer(page):
            log("bridge launch skipped: not on Designer (url=" + (page.url or "") + ")")
            return
        if _has_bridge_app(page):
            log("bridge launch skipped: webflow-ext iframe already mounted")
            return
        # 1. canvas focus — click somewhere inside the canvas viewport.
        #    700,400 is a safe interior coordinate at the bot's render
        #    resolution (1920x1080 with the Designer chrome occupying
        #    the outer ~80px on each side).
        page.mouse.click(700, 400)
        page.wait_for_timeout(400)
        # 2. open Apps panel via the 'E' shortcut.
        page.keyboard.press("e")
        page.wait_for_timeout(800)
        # 3. Find the Bridge App row in the Apps panel and click on
        #    its center coords (NOT the text span — that has no
        #    click handler). The row click opens a detail panel
        #    containing the "Launch App" button.
        try:
            row_info = page.evaluate(
                """
                () => {
                  // Locate the SPAN that holds the Bridge App label,
                  // then walk up to the clickable row container.
                  const span = Array.from(document.querySelectorAll("span"))
                    .find(s => (s.textContent || "").trim() === "Webflow MCP Bridge App"
                               && s.children.length === 0);
                  if (!span) return null;
                  let row = span;
                  // Walk up until we find an ancestor whose width
                  // spans most of the panel (≥150px) — that's the
                  // row container that owns the click handler.
                  for (let i = 0; i < 6 && row.parentElement; i++) {
                    const p = row.parentElement;
                    const r = p.getBoundingClientRect();
                    if (r.width >= 150) { row = p; break; }
                    row = p;
                  }
                  const r = row.getBoundingClientRect();
                  return {
                    x: Math.round(r.left + r.width / 2),
                    y: Math.round(r.top + r.height / 2),
                    width: r.width, height: r.height,
                  };
                }
                """
            )
        except Exception as e:
            log("bridge launch row-locate err: " + str(e)[:140])
            row_info = None
        if not row_info:
            log("bridge launch failed: Bridge App row not found in Apps panel")
            return
        log("bridge launch: clicking row at (" + str(row_info["x"]) + "," + str(row_info["y"]) + ")")
        page.mouse.click(row_info["x"], row_info["y"])
        page.wait_for_timeout(800)
        # 4. Detail panel mounts with the "Launch App" button. Poll
        #    via JS for any visible button matching ^Launch( App)?$.
        launch_clicked = False
        for _ in range(40):  # up to ~20s
            try:
                found = page.evaluate(
                    """
                    () => {
                      const b = Array.from(document.querySelectorAll("button"))
                        .find(b => /^Launch( App)?$/.test((b.textContent || "").trim())
                                   && b.offsetParent !== null);
                      if (!b) return null;
                      b.click();
                      return { text: b.textContent.trim() };
                    }
                    """
                )
            except Exception as e:
                log("bridge launch eval err: " + str(e)[:120])
                found = None
            if found:
                log("bridge launch: clicked '" + str(found.get("text", "")) + "'")
                launch_clicked = True
                break
            page.wait_for_timeout(500)
        if not launch_clicked:
            log("bridge launch failed: 'Launch' button never appeared after row click")
            return
        # 4. iframe handshakes with the Bridge App's external host
        #    (webflow-ext.com). Poll for mount; 10s is usually enough
        #    but slow runs occasionally need 15s.
        for _ in range(30):  # ~15s budget
            page.wait_for_timeout(500)
            if _has_bridge_app(page):
                log("bridge launched: webflow-ext iframe mounted")
                return
        log("bridge launch click sent but iframe not mounted within 15s; possibly slow load or App not enabled in workspace")
    except Exception as e:
        log("bridge launch raised " + type(e).__name__ + ": " + str(e)[:160])


class _ControlHandler(http.server.BaseHTTPRequestHandler):
    server_version = "webflow-bot/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _auth_ok(self) -> bool:
        return self.headers.get("X-Control-Token", "") == CONTROL_TOKEN

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, code: int, body: Any) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, code: int, content_type: str, data: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            return self._send_json(200, {
                "ok": True,
                "ready": _status.get("ready", False),
                "phase": _status.get("phase"),
                "url": (_page.url if _page else None),
            })
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "bad token"})
        try:
            body = self._read_json()
        except Exception as e:
            return self._send_json(400, {"error": "bad json: " + str(e)})
        try:
            with _page_lock:
                if _page is None:
                    return self._send_json(503, {"error": "page not ready"})
                handler = _ROUTES.get(self.path)
                if not handler:
                    return self._send_json(404, {"error": "not found"})
                result = handler(_page, body)
            if isinstance(result, tuple) and len(result) == 2 and isinstance(result[0], (bytes, bytearray)):
                return self._send_bytes(200, result[1], bytes(result[0]))
            return self._send_json(200, result if isinstance(result, dict) else {"result": result})
        except Exception as e:
            log("control plane error on " + self.path + ":", e)
            traceback.print_exc()
            return self._send_json(500, {"error": str(e)})


def _ep_screenshot(page, body):
    full = bool(body.get("fullPage", False))
    img = page.screenshot(full_page=full, type="png")
    return img, "image/png"


def _ep_eval(page, body):
    code = body.get("code", "")
    wrapped = "(async () => { " + code + " })()"
    return {"result": page.evaluate(wrapped)}


def _ep_key(page, body):
    page.keyboard.press(body["key"])
    return {"ok": True}


def _ep_click(page, body):
    page.mouse.click(int(body["x"]), int(body["y"]))
    return {"ok": True}


def _ep_dblclick(page, body):
    page.mouse.dblclick(int(body["x"]), int(body["y"]))
    return {"ok": True}


def _ep_drag(page, body):
    # Drag from (fromX, fromY) → (toX, toY) with intermediate steps so
    # native HTML5 drag-and-drop / React-DnD threshold detectors fire.
    # body: {fromX, fromY, toX, toY, steps?, hold_ms?}
    fx, fy = int(body["fromX"]), int(body["fromY"])
    tx, ty = int(body["toX"]), int(body["toY"])
    steps = int(body.get("steps", 20))
    hold_ms = int(body.get("hold_ms", 200))
    page.mouse.move(fx, fy)
    page.mouse.down()
    page.wait_for_timeout(hold_ms)
    page.mouse.move(fx, fy, steps=2)
    for i in range(1, steps + 1):
        ix = fx + (tx - fx) * i // steps
        iy = fy + (ty - fy) * i // steps
        page.mouse.move(ix, iy, steps=2)
    page.wait_for_timeout(hold_ms)
    page.mouse.up()
    return {"ok": True, "from": [fx, fy], "to": [tx, ty]}


def _ep_selector_click(page, body):
    page.locator(body["selector"]).first.click(timeout=int(body.get("timeout", 8000)))
    return {"ok": True}


_SET_HTML_EMBED_JS = """
async ({elementId, html}) => {
  const el = document.querySelector('[data-w-id="' + elementId + '"]');
  if (!el) return {ok: false, error: 'element not found by data-w-id'};
  el.click();
  await new Promise(r => setTimeout(r, 400));
  const editBtn = Array.from(document.querySelectorAll('button'))
    .find(b => /edit code/i.test(b.textContent || ''));
  if (!editBtn) return {ok: false, error: 'Edit Code button not found'};
  editBtn.click();
  await new Promise(r => setTimeout(r, 800));
  const cm = document.querySelector('.cm-editor');
  if (!cm) return {ok: false, error: 'CodeMirror editor not mounted'};
  const view = cm.cmView && cm.cmView.view;
  if (!view) return {ok: false, error: 'EditorView not attached to .cm-editor'};
  const previousLength = view.state.doc.length;
  view.dispatch({ changes: { from: 0, to: previousLength, insert: html } });
  const newLength = view.state.doc.length;
  return {ok: true, previousLength, newLength};
}
"""


def _ep_set_html_embed(page, body):
    payload = {"elementId": body["elementId"], "html": body["html"]}
    return page.evaluate(_SET_HTML_EMBED_JS, payload)


# Drives the Designer's "+ Add page → Create page" UI flow:
#   1. Open Pages panel via left-sidebar-pages-button
#   2. Click add-page-menu-button to open the menu
#   3. Click new-page menuitem to open the "New Page settings" modal
#   4. Type name + slug into PageSettingsForm-untitled-page-name/slug-input
#   5. Click create-new-page-button
# The Designer's React handlers don't fire on synthetic .click() events,
# so we use page.mouse.click() with bounding-rect-derived coordinates,
# which carries proper PointerEvent semantics. Selectors verified
# 2026-05-07 against lisa-blockcast.design.webflow.com.
# Use the same wrapping the /eval endpoint uses (async IIFE) for all
# internal page.evaluate calls — it's the only form Playwright sync_api
# consistently treats as an expression. Bare arrow functions and
# synchronous IIFEs both have edge cases that return None even when the
# function body executed correctly.
def _run_in_page(page: Page, code: str) -> Any:
    return page.evaluate("(async () => { " + code + " })()")


def _click_aid_by_coords(page: Page, aid: str, settle_ms: int = 600) -> dict:
    sel = '[data-automation-id=' + json.dumps(aid) + ']'
    # locator.click(force=True) skips actionability preflight (visibility,
    # stability, receives-events) which Webflow's transparent overlays
    # fail, but routes through Playwright's full pointer-event sequence.
    # That works where bare page.mouse.click() inside this same handler
    # doesn't — verified 2026-05-07: external /click HTTP requests open
    # the panel, but mouse.click() from in-handler doesn't.
    loc = page.locator(sel).first
    try:
        loc.click(force=True, timeout=8000)
    except Exception as e:
        raise RuntimeError("click failed for " + aid + ": " + str(e)[:200])
    page.wait_for_timeout(settle_ms)
    # Return the bounding rect for callers that want it (eg. _fill_aid).
    rect = _run_in_page(page,
        "const b = document.querySelector(" + json.dumps(sel) + ");"
        " if (!b) return null;"
        " const r = b.getBoundingClientRect();"
        " return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: r.width, h: r.height };"
    )
    return rect or {"x": 0, "y": 0, "w": 0, "h": 0}


def _fill_aid(page: Page, aid: str, value: str) -> None:
    # Convenience wrapper for fields keyed by full data-automation-id.
    # When the id is unstable (Webflow re-slugs the page name into
    # form-field ids on every keypress), use _fill_locator instead.
    _fill_locator(page, '[data-automation-id=' + json.dumps(aid) + ']', value)


def _fill_locator(page: Page, selector: str, value: str) -> None:
    # Same locator(force=True) pattern as _click_aid_by_coords. After
    # focus, select-all + type to overwrite Webflow's pre-filled value
    # (e.g. "Untitled"). Sequential keypresses (vs. .value=) so React's
    # onChange + form-state validators fire properly.
    loc = page.locator(selector).first
    try:
        loc.click(force=True, timeout=8000)
    except Exception as e:
        raise RuntimeError("focus failed for " + selector + ": " + str(e)[:200])
    page.keyboard.press("Control+A")
    page.keyboard.press("Delete")
    page.keyboard.type(value, delay=15)


def _ep_create_page(page, body):
    name = (body.get("name") or "").strip()
    slug = (body.get("slug") or "").strip()
    if not name:
        return {"ok": False, "error": "name required"}

    # 1. Pages panel — only click if it's not already open. The
    # left-sidebar-pages-button TOGGLES, so a blind click closes an
    # already-open panel and the next steps fail.
    already_open = _run_in_page(page,
        "const b = document.querySelector('[data-automation-id=\"left-sidebar-pages-button\"]');"
        " return b && b.getAttribute('aria-pressed') === 'true';"
    )
    if not already_open:
        _click_aid_by_coords(page, "left-sidebar-pages-button", settle_ms=800)

    # 2. Add-page menu (wait until the panel's add button is in the DOM
    # to absorb panel mount/animation latency)
    for _ in range(10):
        present = _run_in_page(page,
            "return !!document.querySelector('[data-automation-id=\"add-page-menu-button\"]');"
        )
        if present:
            break
        page.wait_for_timeout(200)
    _click_aid_by_coords(page, "add-page-menu-button", settle_ms=400)

    # 3. "Create page" menuitem
    _click_aid_by_coords(page, "new-page", settle_ms=800)

    # 4. Fill name. Webflow embeds a slugified copy of the current page
    # name in the form fields' data-automation-ids, so the IDs change
    # AS WE TYPE the name (`PageSettingsForm-untitled-...` →
    # `PageSettingsForm-<slugified-name>-...`). Using a suffix selector
    # `[data-automation-id$="-page-name-input-input"]` is stable across
    # those edits.
    _fill_locator(page, '[data-automation-id$="-page-name-input-input"]', name)
    page.wait_for_timeout(400)
    if slug:
        _fill_locator(page, '[data-automation-id$="-page-slug-input-input"]', slug)
        page.wait_for_timeout(300)

    # 5. Create
    _click_aid_by_coords(page, "create-new-page-button", settle_ms=1500)

    # Verify by reading top-bar-page-name (changes to the new page after save)
    new_page_name = _run_in_page(page,
        "const b = document.querySelector('[data-automation-id=top-bar-page-name]');"
        " return b ? (b.textContent || '').trim() : null;"
    )
    return {"ok": True, "topBarPageName": new_page_name, "url": page.url}


_ROUTES = {
    "/screenshot": _ep_screenshot,
    "/eval": _ep_eval,
    "/key": _ep_key,
    "/click": _ep_click,
    "/dblclick": _ep_dblclick,
    "/drag": _ep_drag,
    "/selectorClick": _ep_selector_click,
    "/setHtmlEmbed": _ep_set_html_embed,
    "/createPage": _ep_create_page,
}


class _ControlServer(http.server.HTTPServer):
    """Single-threaded HTTP server. Calls service_actions() between
    requests; we use that for periodic health probes that need
    same-thread access to the Playwright page."""
    allow_reuse_address = True

    def service_actions(self) -> None:
        global _last_health_at
        now = time.time()
        if now - _last_health_at >= REFRESH_SECONDS and _page is not None:
            _last_health_at = now
            try:
                with _page_lock:
                    if _status.get("manual_login_required"):
                        if _is_logged_in(_page):
                            log("manual login recovered; returning to designer")
                            _clear_manual_login()
                            _open_designer(_page)
                            _try_launch_bridge_app(_page)
                            _set_phase("serving")
                        else:
                            log("manual login still required")
                            _set_phase("manual-login-required")
                        return
                    _set_phase("health-probe")
                    # Fast path: if we're already on Designer with the
                    # Bridge App iframe mounted, skip both the
                    # session-cookie navigation AND the _open_designer
                    # re-navigation. Both reset the Designer canvas
                    # state, drop Bridge App focus, and (on Camoufox)
                    # can land on a press-and-hold anti-bot CAPTCHA
                    # that requires manual VNC intervention.
                    if _is_on_designer(_page) and _has_bridge_app(_page):
                        log("health: designer + bridge alive; skipping refresh")
                    elif not _is_logged_in(_page):
                        log("SESSION EXPIRED in health loop")
                        _on_login_required(_context)
                        _open_designer(_page)
                        _try_launch_bridge_app(_page)
                    else:
                        log("session OK; returning to designer")
                        _open_designer(_page)
                        _try_launch_bridge_app(_page)
                    _set_phase("serving")
            except Exception as e:
                log("health loop error:", e)
                traceback.print_exc()


def main() -> int:
    global _page, _context
    _set_phase("launching-camoufox")
    # headless=False routes the browser to the existing Xvfb on
    # DISPLAY=:99 (where x11vnc is watching for VNC sessions).
    # Camoufox's "virtual" mode spawns its OWN Xvfb at :103 with
    # a 1x1 screen — fine for stealth automation, but invisible
    # over VNC. Setting CAMOUFOX_VNC=1 in env opts in to the
    # vnc-friendly path; default stays "virtual" for production.
    cm_kwargs = {"headless": False if os.environ.get("CAMOUFOX_VNC") == "1" else "virtual"}
    if PROXY_URL:
        cm_kwargs["proxy"] = {"server": PROXY_URL}
        log("camoufox routing via proxy " + PROXY_URL)
    if os.path.exists(STATE_FILE):
        log("camoufox -> reusing storage_state from " + STATE_FILE)
    with Camoufox(**cm_kwargs) as browser:
        ctx_kwargs = {}
        if os.path.exists(STATE_FILE):
            ctx_kwargs["storage_state"] = STATE_FILE
        _context = browser.new_context(**ctx_kwargs)
        _page = _context.new_page()
        _set_phase("session-probe")
        if not _is_logged_in(_page):
            log("SESSION EXPIRED on cold start — running login")
            try:
                _on_login_required(_context)
            except Exception as e:
                log("automatic login failed:", e)
                traceback.print_exc()
                _park_for_manual_login(_page, e)
        if not _status.get("manual_login_required"):
            _set_phase("opening-designer")
            _open_designer(_page)
            _try_launch_bridge_app(_page)
        global _last_health_at
        _last_health_at = time.time()
        _status["ready"] = True
        if not _status.get("manual_login_required"):
            _set_phase("serving")
        server = _ControlServer(("0.0.0.0", CONTROL_PORT), _ControlHandler)
        log("control plane listening on :" + str(CONTROL_PORT))
        # poll_interval=5 so service_actions (health probe) gets called
        # at least every 5s even when no requests are arriving.
        server.serve_forever(poll_interval=5.0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)


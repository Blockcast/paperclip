#!/usr/bin/env python3
"""
Figma Designer bot — M2.

Adds lease + interaction endpoints to the M1.1 baseline. Session-holding
behavior is unchanged: persistent Camoufox profile on PVC, manual one-time
login via noVNC, periodic refresh.

HTTP endpoints (auth: X-Control-Token; interaction endpoints also require
X-Lease-Id):

  GET  /health             liveness + login state + lease snapshot
  GET  /lease/status       current lease snapshot
  POST /lease/acquire      body: {client_id, ttl?}      -> {lease_id, ttl_seconds}
  POST /lease/release      header X-Lease-Id            -> {released}
  POST /lease/heartbeat    header X-Lease-Id            -> {ok}
  POST /screenshot         X-Lease-Id                    -> {image_base64, format}
  POST /eval               body: {expression}, X-Lease-Id-> {result}
  POST /key                body: {key}, X-Lease-Id       -> {ok}
  POST /click              body: {x, y}, X-Lease-Id      -> {ok}
  POST /selectorClick      body: {selector}, X-Lease-Id  -> {ok}
  POST /use_figma          body: {js}, X-Lease-Id        -> 503 bridge_not_connected

Architecture notes:
- Playwright sync_api is main-thread-only. The control server uses
  ThreadingHTTPServer for handler concurrency, but no handler ever
  touches `page.*` directly. All Playwright work is dispatched to the
  main thread via _job_queue and waited on with a threading.Event.
- The main loop drains _job_queue continuously and runs the periodic
  session refresh on its own schedule.
- Single-tenant lease: only one lease_id active at a time. A lease
  expires when (now - last_heartbeat) > ttl. Acquiring while a live
  lease exists returns 409 lease_held_by_other.
"""

import base64
import http.server
import json
import hashlib
import os
import queue
import secrets
import signal
import socket
import socketserver
import struct
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from camoufox.sync_api import Camoufox
from playwright.sync_api import Page, BrowserContext, TimeoutError as PWTimeout


PROFILE_DIR       = os.environ.get("PROFILE_DIR", "/config/playwright-profile")
SITE_URL          = os.environ.get("SITE_URL", "https://www.figma.com/files/recent")
REFRESH_SECONDS   = int(os.environ.get("REFRESH_SECONDS", "900"))
EMAIL             = os.environ.get("FIGMA_EMAIL", "")
CONTROL_PORT      = int(os.environ.get("CONTROL_PORT", "7000"))
CONTROL_TOKEN     = os.environ.get("CONTROL_TOKEN", "")
PROXY_URL         = os.environ.get("FIGMA_BOT_PROXY", "")
JOB_TIMEOUT       = float(os.environ.get("JOB_TIMEOUT", "30"))
DEFAULT_LEASE_TTL = int(os.environ.get("DEFAULT_LEASE_TTL", "300"))
JOB_POLL_INTERVAL = 1.0
_RFB_BUTTON_HOLD_S = 0.05  # delay between PointerEvent down and up

os.makedirs(PROFILE_DIR, exist_ok=True)


def log(*m: Any) -> None:
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print("[figma-bot " + ts + "]", *m, flush=True)


_status_lock = threading.RLock()
_status: dict = {
    "ready": False,
    "phase": "starting",
    "phase_at": time.time(),
    "logged_in": False,
    "url": None,
    "session_restored_at": None,
    "cookie_count": None,
    "last_check_at": None,
}

_lease_lock = threading.RLock()
_lease: dict = {
    "lease_id": None,
    "client_id": None,
    "acquired_at": None,
    "last_heartbeat_at": None,
    "ttl_seconds": DEFAULT_LEASE_TTL,
}

IDENTITIES_PATH = os.environ.get("FIGMA_IDENTITIES_PATH",
                                 "/etc/figma-identities/identities.json")
PROFILES_ROOT  = os.environ.get("FIGMA_PROFILES_ROOT",
                                "/config/profiles")


def _slug_for(email: str) -> str:
    """Per-identity directory slug. Matches ccrotate-auth-bot convention."""
    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]


class IdentityRegistry:
    """Loads identities.json from /etc/figma-identities/. Strict on required
    fields, lenient on additions. One bad entry never poisons the whole map."""

    def __init__(self, path: str = IDENTITIES_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._mtime: Optional[float] = None
        self._map: dict[str, dict] = {}
        self._default_identity_env = (
            os.environ.get("FIGMA_DEFAULT_IDENTITY")
            or os.environ.get("FIGMA_EMAIL")
            or ""
        )
        self._load(force=True)

    @staticmethod
    def _validate_entry(email, entry) -> Optional[dict]:
        """Return entry if valid, None if it should be skipped. Logs the reason."""
        if not isinstance(email, str) or "@" not in email:
            log(f"IdentityRegistry: WARNING skipping non-email key {email!r}")
            return None
        if not isinstance(entry, dict):
            log(f"IdentityRegistry: WARNING skipping non-object value for {email}")
            return None
        password = entry.get("password")
        if not isinstance(password, str) or not password:
            log(f"IdentityRegistry: WARNING skipping {email}: missing or empty password")
            return None
        return entry

    def _load(self, force: bool = False) -> None:
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            with self._lock:
                if force or self._map:
                    log(f"IdentityRegistry: file missing at {self.path}; registry empty")
                self._mtime = None
                self._map = {}
            return
        if not force and self._mtime == st.st_mtime:
            return
        try:
            with open(self.path, "r") as f:
                raw = f.read()
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("identities.json top-level must be a JSON object")
        except (ValueError, OSError) as e:
            log(f"IdentityRegistry: ERROR parsing {self.path}: {type(e).__name__}: {str(e)[:160]}")
            with self._lock:
                self._mtime = st.st_mtime
                self._map = {}
            return
        new_map: dict[str, dict] = {}
        for email, entry in parsed.items():
            valid = self._validate_entry(email, entry)
            if valid is not None:
                new_map[email] = valid
        with self._lock:
            self._mtime = st.st_mtime
            self._map = new_map
        log(f"IdentityRegistry: loaded {len(new_map)} identities from {self.path}")

    def maybe_reload(self) -> None:
        self._load(force=False)

    def known(self) -> list[str]:
        with self._lock:
            return sorted(self._map.keys())

    def get(self, email: str) -> Optional[dict]:
        with self._lock:
            return self._map.get(email)

    def default_identity(self) -> Optional[str]:
        env = self._default_identity_env
        if env and self.get(env) is not None:
            return env
        return None


# Global registry instance; initialized in main() before the control server.
_identities: Optional[IdentityRegistry] = None


@dataclass
class IdentityState:
    consecutive_failures: int = 0
    backoff_until: Optional[float] = None  # epoch seconds
    last_login_at: Optional[float] = None
    last_failure: Optional[dict] = None    # {"at": float, "reason": str}


_identity_states: dict[str, IdentityState] = {}
_identity_states_lock = threading.RLock()

# Backoff curve after the n-th consecutive failure
_BACKOFF_SCHEDULE = [60, 300, 1800, 7200, 21600]  # 60s, 5m, 30m, 2h, 6h cap


def _get_identity_state(identity: str) -> IdentityState:
    with _identity_states_lock:
        s = _identity_states.get(identity)
        if s is None:
            s = IdentityState()
            _identity_states[identity] = s
        return s


def _record_login_success(identity: str) -> None:
    with _identity_states_lock:
        s = _get_identity_state(identity)
        s.consecutive_failures = 0
        s.backoff_until = None
        s.last_login_at = time.time()
        s.last_failure = None


def _record_login_failure(identity: str, reason: str) -> float:
    """Record a failure, set backoff_until, return the picked backoff
    duration in seconds. Callers that need a fresh retry_after_seconds
    should re-read `s.backoff_until - time.time()` via _identity_in_backoff."""
    now = time.time()
    with _identity_states_lock:
        s = _get_identity_state(identity)
        s.consecutive_failures += 1
        idx = min(s.consecutive_failures - 1, len(_BACKOFF_SCHEDULE) - 1)
        backoff = _BACKOFF_SCHEDULE[idx]
        s.backoff_until = now + backoff
        s.last_failure = {"at": now, "reason": reason}
        return backoff


def _identity_in_backoff(identity: str) -> Optional[float]:
    """Return retry_after_seconds if in backoff, else None."""
    with _identity_states_lock:
        s = _get_identity_state(identity)
        if s.backoff_until is None:
            return None
        remain = s.backoff_until - time.time()
        return remain if remain > 0 else None


class RFBConnectFailed(Exception):
    """websockify or x11vnc unreachable / handshake failed / send timed out.
    Caller maps this to reason='rfb_unreachable' on the /lease/acquire 503."""


def _rfb_click(x: int, y: int, *,
               host: str = "127.0.0.1", port: int = 6080,
               connect_timeout: float = 3.0,
               op_timeout: float = 3.0) -> None:
    """Inject a real X PointerEvent at (x,y) via websockify -> x11vnc.
    Bypasses Camoufox/Firefox isTrusted=false on React-protected buttons.
    Coords are Xvfb-native (1920x1080). Raises RFBConnectFailed on any
    socket/handshake/timeout error."""
    sock: Optional[socket.socket] = None
    try:
        import base64 as _b64
        nonce = _b64.b64encode(os.urandom(16)).decode("ascii")
        sock = socket.create_connection((host, port), timeout=connect_timeout)
        sock.settimeout(op_timeout)
        req = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {nonce}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: binary\r\n"
            f"Origin: http://{host}:{port}\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise RFBConnectFailed("ws handshake: closed before headers")
            buf += chunk
            if len(buf) > 65536:
                raise RFBConnectFailed("ws handshake: oversized response")
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            raise RFBConnectFailed(f"ws handshake: bad status {buf.split(b' ')[1] if b' ' in buf else b'?'}")

        def _sock_recv_exact(n: int) -> bytes:
            out = bytearray()
            while len(out) < n:
                chunk = sock.recv(n - len(out))
                if not chunk:
                    raise RFBConnectFailed("ws recv: socket closed mid-frame")
                out += chunk
            return bytes(out)

        def _ws_send(payload: bytes) -> None:
            mask = os.urandom(4)
            length = len(payload)
            header = bytearray([0x82])
            if length < 126:
                header.append(0x80 | length)
            elif length < (1 << 16):
                header.append(0x80 | 126)
                header += length.to_bytes(2, "big")
            else:
                header.append(0x80 | 127)
                header += length.to_bytes(8, "big")
            header += mask
            masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            sock.sendall(bytes(header) + masked)

        def _ws_recv_exact(n: int) -> bytes:
            out = bytearray()
            while len(out) < n:
                hdr = _sock_recv_exact(2)
                opcode = hdr[0] & 0x0F
                length = hdr[1] & 0x7F
                if length == 126:
                    length = int.from_bytes(_sock_recv_exact(2), "big")
                elif length == 127:
                    length = int.from_bytes(_sock_recv_exact(8), "big")
                payload = b""
                while len(payload) < length:
                    chunk = sock.recv(length - len(payload))
                    if not chunk:
                        raise RFBConnectFailed("ws recv: short payload")
                    payload += chunk
                if opcode == 0x8:
                    raise RFBConnectFailed("ws recv: server close frame")
                out += payload
            return bytes(out[:n])

        proto = _ws_recv_exact(12)
        if not proto.startswith(b"RFB "):
            raise RFBConnectFailed(f"RFB version: got {proto!r}")
        _ws_send(b"RFB 003.008\n")
        nsec = _ws_recv_exact(1)[0]
        if nsec == 0:
            n = int.from_bytes(_ws_recv_exact(4), "big")
            reason = _ws_recv_exact(n).decode("utf-8", "replace")
            raise RFBConnectFailed(f"RFB security: {reason}")
        sec_types = _ws_recv_exact(nsec)
        if 1 not in sec_types:
            raise RFBConnectFailed(f"RFB security: no None type: {list(sec_types)}")
        _ws_send(bytes([1]))
        sec_result = int.from_bytes(_ws_recv_exact(4), "big")
        if sec_result != 0:
            raise RFBConnectFailed(f"RFB security: handshake failed result={sec_result}")
        _ws_send(bytes([1]))  # ClientInit shared=1
        si = _ws_recv_exact(24)
        name_len = int.from_bytes(si[20:24], "big")
        if name_len > 0:
            _ = _ws_recv_exact(name_len)
        x16 = max(0, min(int(x), 65535))
        y16 = max(0, min(int(y), 65535))
        _ws_send(struct.pack(">BBHH", 5, 1, x16, y16))  # button down
        time.sleep(_RFB_BUTTON_HOLD_S)
        _ws_send(struct.pack(">BBHH", 5, 0, x16, y16))  # button up
    except RFBConnectFailed:
        raise
    except (OSError, socket.timeout) as e:
        raise RFBConnectFailed(f"socket error: {type(e).__name__}: {str(e)[:160]}")
    except Exception as e:
        raise RFBConnectFailed(f"unexpected: {type(e).__name__}: {str(e)[:160]}")
    finally:
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass


_job_queue: "queue.Queue" = queue.Queue()


def _set_phase(phase: str) -> None:
    with _status_lock:
        _status["phase"] = phase
        _status["phase_at"] = time.time()


def _figma_cookie_count(page: Page) -> int:
    try:
        return len(page.context.cookies("https://www.figma.com"))
    except Exception as e:
        log("cookie count probe failed: " + type(e).__name__ + ": " + str(e)[:120])
        return -1


def _is_logged_in(page: Page) -> tuple[bool, str]:
    """Probe Figma session validity via in-page fetch to /api/user/profile.
    Returns (logged_in, reason). reason is '' on success; on failure one of:
    'missing_authentication' (401), 'http_<status>', 'probe_error:<Exc>'."""
    try:
        result = page.evaluate(
            "(async()=>{const r=await fetch('https://www.figma.com/api/user/profile',"
            "{credentials:'include',headers:{accept:'application/json'}});"
            "return {status:r.status};})()"
        )
        status = int(result.get("status", 0))
        if status == 200:
            return True, ""
        if status == 401:
            return False, "missing_authentication"
        return False, f"http_{status}"
    except Exception as e:
        return False, f"probe_error:{type(e).__name__}"


def _refresh_status(page: Page) -> bool:
    li, reason = _is_logged_in(page)
    try:
        u = page.url
    except Exception:
        u = None
    with _status_lock:
        _status["logged_in"] = li
        _status["url"] = u
        _status["last_check_at"] = time.time()
        _status["last_probe_reason"] = reason
    return li


class ProfileManager:
    """Owns Camoufox + Page lifecycle for ONE identity. Single instance at a
    time (serial multi-profile). Switching identity = close() + construct new.
    Main-thread-only: launch() and close() touch Playwright sync_api which is
    main-thread-bound. HTTP handlers use _submit_job / _submit_switch_job."""

    USER_JS = (
        'user_pref("browser.link.open_newwindow", 1);\n'
        'user_pref("browser.link.open_newwindow.restriction", 0);\n'
        'user_pref("dom.disable_open_during_load", false);\n'
        'user_pref("dom.popup_maximum", 0);\n'
    )
    COOKIE_FILES = ("cookies.sqlite", "storage.sqlite")

    def __init__(self, identity: str):
        self.identity = identity
        self.slug = _slug_for(identity)
        self.profile_dir = os.path.join(PROFILES_ROOT, self.slug, "playwright-profile")
        self.backup_dir  = os.path.join(PROFILES_ROOT, self.slug, "playwright-profile-backup")
        self.email_file  = os.path.join(PROFILES_ROOT, self.slug, "email.txt")
        self._ctx = None
        self._context = None
        self.page: Optional[Page] = None
        self.switch_lock = threading.Lock()
        os.makedirs(os.path.dirname(self.profile_dir), exist_ok=True)
        os.makedirs(self.profile_dir, exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)
        if not os.path.exists(self.email_file):
            with open(self.email_file, "w") as f:
                f.write(self.identity + "\n")
        self._restore_cookies()
        self._write_user_js()

    def _write_user_js(self) -> None:
        try:
            with open(os.path.join(self.profile_dir, "user.js"), "w") as f:
                f.write(self.USER_JS)
        except OSError as e:
            log(f"ProfileManager[{self.identity}]: user.js write failed: {e}")

    def _restore_cookies(self) -> None:
        import shutil
        for name in self.COOKIE_FILES:
            live = os.path.join(self.profile_dir, name)
            bak  = os.path.join(self.backup_dir,  name)
            try:
                live_sz = os.path.getsize(live) if os.path.exists(live) else 0
                bak_sz  = os.path.getsize(bak)  if os.path.exists(bak)  else 0
                if bak_sz > 0 and bak_sz > live_sz:
                    shutil.copy(bak, live)
                    log(f"ProfileManager[{self.identity}]: restored {name} bak={bak_sz} > live={live_sz}")
            except OSError as e:
                log(f"ProfileManager[{self.identity}]: restore {name} failed: {e}")

    def backup_cookies(self) -> None:
        """Best-effort backup tick. Skips if switch_lock is held by close()."""
        if not self.switch_lock.acquire(blocking=False):
            return
        try:
            self._backup_locked()
        finally:
            self.switch_lock.release()

    def _backup_locked(self) -> None:
        import shutil
        for name in self.COOKIE_FILES:
            live = os.path.join(self.profile_dir, name)
            if not os.path.exists(live):
                continue
            bak = os.path.join(self.backup_dir, name)
            try:
                shutil.copy(live, bak)
            except OSError as e:
                log(f"ProfileManager[{self.identity}]: backup {name} failed: {e}")

    def launch(self) -> None:
        proxy_kw: dict = {}
        if PROXY_URL:
            proxy_kw["proxy"] = {"server": PROXY_URL}
        self._ctx = Camoufox(
            persistent_context=True,
            user_data_dir=self.profile_dir,
            headless=False,
            **proxy_kw,
        )
        self._context = self._ctx.__enter__()
        try:
            pages = self._context.pages
            self.page = pages[0] if pages else self._context.new_page()
        except Exception:
            try:
                self._ctx.__exit__(None, None, None)
            except Exception as e:
                log(f"ProfileManager[{self.identity}]: cleanup after launch error failed: {e}")
            self._ctx = None
            self._context = None
            self.page = None
            raise
        log(f"ProfileManager[{self.identity}]: Camoufox launched, slug={self.slug}")

    def close(self) -> None:
        with self.switch_lock:
            try:
                self._backup_locked()
            except Exception as e:
                log(f"ProfileManager[{self.identity}]: final backup failed: {e}")
            try:
                if self._ctx is not None:
                    self._ctx.__exit__(None, None, None)
            except Exception as e:
                log(f"ProfileManager[{self.identity}]: Camoufox exit failed: {e}")
            self._ctx = None
            self._context = None
            self.page = None
            log(f"ProfileManager[{self.identity}]: closed")


def _auto_login(pm: "ProfileManager") -> None:
    """Drive Google SSO for pm.identity using stored credentials.
    Single attempt; raises on failure (caller catches + records reason)."""
    if _identities is None:
        raise RuntimeError("IdentityRegistry not initialized")
    entry = _identities.get(pm.identity)
    if entry is None:
        raise RuntimeError(f"identity {pm.identity} not in registry")
    password = entry.get("password")
    if not password:
        raise RuntimeError(f"identity {pm.identity} has no password")
    page = pm.page

    def _refetch_page_after_target_closed():
        nonlocal page
        try:
            pages = pm._context.pages
            page = pages[0] if pages else pm._context.new_page()
            pm.page = page
            log(f"_auto_login[{pm.identity}]: re-acquired page after TargetClosedError")
        except Exception as e:
            raise RuntimeError(f"page re-acquire failed: {type(e).__name__}: {e}")

    log(f"_auto_login[{pm.identity}]: starting")
    try:
        page.goto("https://www.figma.com/login", wait_until="domcontentloaded", timeout=20_000)

        loc = page.locator('button:has-text("Continue with Google")')
        loc.wait_for(state="visible", timeout=10_000)
        bbox = loc.bounding_box()
        if not bbox:
            raise RuntimeError("Continue with Google button has no bbox")
        vp = page.viewport_size or {"width": 1280, "height": 720}
        xvfb_w, xvfb_h = 1920, 1080
        cx_vp = bbox["x"] + bbox["width"] / 2
        cy_vp = bbox["y"] + bbox["height"] / 2
        # Empirical default: 1:1 mapping at offset (0,0) within Xvfb.
        # If Camoufox doesn't render at viewport-native size, switch to:
        #   cx = int(round(cx_vp * (xvfb_w / vp["width"])))
        #   cy = int(round(cy_vp * (xvfb_h / vp["height"])))
        cx = int(round(cx_vp))
        cy = int(round(cy_vp))
        log(f"_auto_login[{pm.identity}]: RFB-click at xvfb=({cx},{cy}) vp=({cx_vp:.0f},{cy_vp:.0f})")
        _rfb_click(cx, cy)

        page.wait_for_load_state("domcontentloaded", timeout=20_000)
        try:
            page.wait_for_selector('input[type="email"]', state="visible", timeout=20_000)
        except PWTimeout:
            raise RuntimeError("email input did not appear within 20s")
        page.evaluate(
            "(email)=>{const em=document.querySelector('input[type=\"email\"]');"
            "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(em,email);"
            "em.dispatchEvent(new Event('input',{bubbles:true}));"
            "em.dispatchEvent(new Event('change',{bubbles:true}));}",
            pm.identity,
        )
        page.evaluate("document.getElementById('identifierNext').click()")

        try:
            page.wait_for_selector('input[type="password"]', state="visible", timeout=30_000)
        except PWTimeout:
            raise RuntimeError("password input did not appear within 30s (google challenge?)")
        page.evaluate(
            "(pw)=>{const pe=document.querySelector('input[type=\"password\"]');"
            "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
            "s.call(pe,pw);"
            "pe.dispatchEvent(new Event('input',{bubbles:true}));"
            "pe.dispatchEvent(new Event('change',{bubbles:true}));}",
            password,
        )
        page.evaluate("document.getElementById('passwordNext').click()")

        deadline = time.time() + 30
        last_url = None
        while time.time() < deadline:
            try:
                u = page.url
            except Exception:
                _refetch_page_after_target_closed()
                continue
            last_url = u
            if "://www.figma.com" in u and "/login" not in u:
                break
            time.sleep(0.5)
        else:
            if last_url and "challenge" in last_url:
                raise RuntimeError(f"google_challenge_in_url:{last_url[:120]}")
            raise RuntimeError(f"login redirect timeout; last_url={last_url}")
        log(f"_auto_login[{pm.identity}]: redirect settled at {page.url}")
    except RFBConnectFailed:
        raise
    except Exception as e:
        raise RuntimeError(f"{type(e).__name__}: {str(e)[:200]}") from e


_active_target_lock = threading.RLock()
_active_target: Optional[str] = None
_active_target_force_refresh: bool = False


def _set_active_target(identity: Optional[str], force_refresh: bool = False) -> None:
    with _active_target_lock:
        global _active_target, _active_target_force_refresh
        _active_target = identity
        _active_target_force_refresh = force_refresh


def _get_active_target() -> tuple[Optional[str], bool]:
    with _active_target_lock:
        return _active_target, _active_target_force_refresh


def _clear_force_refresh() -> None:
    with _active_target_lock:
        global _active_target_force_refresh
        _active_target_force_refresh = False


def _submit_job(fn: Callable[[Page], Any], timeout: float = JOB_TIMEOUT) -> Any:
    done = threading.Event()
    box: dict = {"result": None, "error": None}
    _job_queue.put((fn, box, done))
    if not done.wait(timeout):
        raise TimeoutError(f"Playwright job timed out after {timeout}s")
    if box["error"] is not None:
        raise box["error"]
    return box["result"]


def _lease_active(snap: dict) -> bool:
    if snap.get("lease_id") is None:
        return False
    last = snap.get("last_heartbeat_at") or snap.get("acquired_at") or 0
    return (time.time() - last) <= snap.get("ttl_seconds", DEFAULT_LEASE_TTL)


def _lease_snapshot() -> dict:
    with _lease_lock:
        snap = dict(_lease)
    snap["active"] = _lease_active(snap)
    return snap


def _acquire_lease(client_id: str, ttl: int) -> tuple[Optional[str], Optional[str]]:
    with _lease_lock:
        if _lease["lease_id"] is not None:
            last = _lease.get("last_heartbeat_at") or _lease.get("acquired_at") or 0
            if (time.time() - last) <= _lease["ttl_seconds"]:
                return None, "lease_held_by_other"
            log(f"reclaiming expired lease {_lease['lease_id']} (client={_lease['client_id']})")
        lid = secrets.token_urlsafe(16)
        now = time.time()
        _lease["lease_id"] = lid
        _lease["client_id"] = client_id
        _lease["acquired_at"] = now
        _lease["last_heartbeat_at"] = now
        _lease["ttl_seconds"] = ttl
        log(f"lease acquired: {lid} client={client_id} ttl={ttl}s")
        return lid, None


def _release_lease(lease_id: str) -> bool:
    with _lease_lock:
        if _lease["lease_id"] != lease_id:
            return False
        log(f"lease released: {lease_id} client={_lease['client_id']}")
        _lease["lease_id"] = None
        _lease["client_id"] = None
        _lease["acquired_at"] = None
        _lease["last_heartbeat_at"] = None
        return True


def _heartbeat_lease(lease_id: str) -> bool:
    with _lease_lock:
        if _lease["lease_id"] != lease_id:
            return False
        last = _lease.get("last_heartbeat_at") or _lease.get("acquired_at") or 0
        if (time.time() - last) > _lease["ttl_seconds"]:
            log(f"heartbeat on expired lease {lease_id}; refusing")
            return False
        _lease["last_heartbeat_at"] = time.time()
        return True


def _check_lease(lease_id: str) -> bool:
    with _lease_lock:
        if _lease["lease_id"] != lease_id:
            return False
        last = _lease.get("last_heartbeat_at") or _lease.get("acquired_at") or 0
        return (time.time() - last) <= _lease["ttl_seconds"]


class SwitchJobError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class _SwitchSentinel:
    __slots__ = ("identity", "force_refresh")
    def __init__(self, identity: str, force_refresh: bool):
        self.identity = identity
        self.force_refresh = force_refresh


# Queue of pending switch waiters; populated by _submit_switch_job, signalled
# by _signal_switch_done from the main loop body.
_pending_switch_done: list = []  # entries: (identity, box, done)
_pending_switch_done_lock = threading.RLock()


def _submit_switch_job(identity: str, force_refresh: bool,
                       timeout: float = 60.0) -> tuple[bool, bool]:
    """Blocking primitive. Returns (switched, login_performed).
    Raises SwitchJobError(reason) on failure."""
    box: dict = {}
    done = threading.Event()
    entry = (identity, box, done)
    with _pending_switch_done_lock:
        _pending_switch_done.append(entry)
    # Sentinel on the job queue tells the loop to pick up the new target.
    _job_queue.put((_SwitchSentinel(identity, force_refresh), box, done))
    if not done.wait(timeout=timeout):
        # Remove our entry so a later _signal_switch_done doesn't write
        # a foreign switch's result into our abandoned box.
        with _pending_switch_done_lock:
            try:
                _pending_switch_done.remove(entry)
            except ValueError:
                pass  # signal raced with timeout; entry already removed
        raise SwitchJobError("switch_timeout")
    if "error" in box:
        raise SwitchJobError(box["error"])
    return box.get("switched", False), box.get("login_performed", False)


def _signal_switch_done(identity: str, *, switched: bool,
                        login_performed: bool, error: Optional[str]) -> None:
    """Called by the main loop after a switch attempt resolves."""
    with _pending_switch_done_lock:
        still = []
        for ident, box, done in _pending_switch_done:
            if ident == identity:
                if error is None:
                    box["switched"] = switched
                    box["login_performed"] = login_performed
                else:
                    box["error"] = error
                done.set()
            else:
                still.append((ident, box, done))
        _pending_switch_done[:] = still


def _render_identities_map() -> dict:
    """Build the /health.identities map.
    Active identity reads live state; inactive identities derive from on-disk
    cookie size + in-process IdentityState."""
    out: dict = {}
    with _status_lock:
        active = _status.get("active_identity")
    if _identities is None:
        return out
    for email in _identities.known():
        s = _get_identity_state(email)
        slug = _slug_for(email)
        cookie_path = os.path.join(PROFILES_ROOT, slug, "playwright-profile", "cookies.sqlite")
        try:
            cookie_size = os.path.getsize(cookie_path) if os.path.exists(cookie_path) else 0
        except OSError:
            cookie_size = 0
        out[email] = {
            "logged_in": bool(_status.get("logged_in", False)) if email == active else False,
            "cookie_size_bytes": cookie_size,
            "last_check_at": _status.get("last_check_at") if email == active else None,
            "last_login_at": s.last_login_at,
            "last_failure": s.last_failure,
            "backoff_until": s.backoff_until,
        }
    return out


class _ControlHandler(http.server.BaseHTTPRequestHandler):
    server_version = "figma-bot/0.2.0"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _auth_ok(self) -> bool:
        if self.path in ("/health", "/lease/status"):
            return True
        return self.headers.get("X-Control-Token", "") == CONTROL_TOKEN

    def _lease_ok(self) -> bool:
        lid = self.headers.get("X-Lease-Id", "")
        if not lid:
            return False
        return _check_lease(lid)

    def _send_json(self, code: int, body: Any) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_GET(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "unauthorized"})
        if self.path == "/health":
            with _status_lock:
                snap = dict(_status)
            return self._send_json(200, {
                "ok": True,
                "ready": snap.get("ready", False),
                "phase": snap.get("phase"),
                "logged_in": snap.get("logged_in", False),
                "url": snap.get("url"),
                "active_identity": snap.get("active_identity"),
                "email": snap.get("active_identity") or EMAIL,
                "session_restored_at": snap.get("session_restored_at"),
                "cookie_count": snap.get("cookie_count"),
                "last_check_at": snap.get("last_check_at"),
                "last_probe_reason": snap.get("last_probe_reason", ""),
                "version": "figma-bot/0.3.0",
                "lease": _lease_snapshot(),
                "identities": _render_identities_map(),
            })
        if self.path == "/lease/status":
            return self._send_json(200, _lease_snapshot())
        if self.path == "/identities":
            return self._send_json(200, {
                "identities": _render_identities_map(),
                "default_identity": (
                    _identities.default_identity() if _identities else None
                ),
            })
        return self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._auth_ok():
            return self._send_json(401, {"error": "unauthorized"})

        if self.path == "/lease/acquire":
            body = self._read_json()
            client_id = str(body.get("client_id", "")).strip()
            if not client_id:
                return self._send_json(400, {"error": "client_id required"})
            ttl = int(body.get("ttl", DEFAULT_LEASE_TTL))
            ttl = max(10, min(ttl, 3600))
            force_refresh = bool(body.get("force_refresh", False))

            assert _identities is not None
            _identities.maybe_reload()
            requested = body.get("identity")
            if requested is None:
                identity = _identities.default_identity()
                if identity is None:
                    return self._send_json(400, {"error": "no_default_identity"})
            else:
                identity = str(requested).strip()
                if _identities.get(identity) is None:
                    return self._send_json(400, {
                        "error": "unknown_identity",
                        "known_identities": _identities.known(),
                    })

            remain = _identity_in_backoff(identity)
            if remain is not None:
                return self._send_json(503, {
                    "error": "identity_in_backoff",
                    "retry_after_seconds": int(remain) + 1,
                })

            lid, err = _acquire_lease(client_id, ttl)
            if err:
                return self._send_json(409, {"error": err, "lease": _lease_snapshot()})

            try:
                switched, login_performed = _submit_switch_job(identity, force_refresh)
            except SwitchJobError as e:
                _release_lease(lid)
                # Most failure reasons (login_error, launch_error,
                # rfb_unreachable) were already recorded by the main loop
                # body before it called _signal_switch_done. But
                # switch_timeout means the main loop never reached the
                # failure handler — record it here so backoff escalates.
                if e.reason == "switch_timeout":
                    _record_login_failure(identity, "switch_timeout")
                ra = _identity_in_backoff(identity) or 60
                return self._send_json(503, {
                    "error": "identity_login_failed",
                    "reason": e.reason,
                    "retry_after_seconds": int(ra) + 1,
                })

            return self._send_json(200, {
                "lease_id": lid,
                "identity": identity,
                "ttl_seconds": ttl,
                "switched": switched,
                "login_performed": login_performed,
            })

        if self.path == "/lease/release":
            lid = self.headers.get("X-Lease-Id", "")
            if not lid:
                return self._send_json(400, {"error": "X-Lease-Id required"})
            return self._send_json(200, {"released": _release_lease(lid)})

        if self.path == "/lease/heartbeat":
            lid = self.headers.get("X-Lease-Id", "")
            if not lid:
                return self._send_json(400, {"error": "X-Lease-Id required"})
            if not _heartbeat_lease(lid):
                return self._send_json(409, {"error": "lease_not_owned_or_expired"})
            return self._send_json(200, {"ok": True})

        if not self._lease_ok():
            return self._send_json(409, {"error": "lease_required"})

        if self.path == "/screenshot":
            try:
                png = _submit_job(lambda p: p.screenshot(type="png"))
                return self._send_json(200, {
                    "image_base64": base64.b64encode(png).decode("ascii"),
                    "format": "png",
                })
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/eval":
            body = self._read_json()
            expr = body.get("expression")
            if not isinstance(expr, str) or not expr:
                return self._send_json(400, {"error": "expression required"})
            try:
                result = _submit_job(lambda p: p.evaluate(expr))
                try:
                    json.dumps(result)
                    payload = result
                except (TypeError, ValueError):
                    payload = repr(result)
                return self._send_json(200, {"result": payload})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:400]})

        if self.path == "/key":
            body = self._read_json()
            key = body.get("key")
            if not isinstance(key, str) or not key:
                return self._send_json(400, {"error": "key required"})
            try:
                _submit_job(lambda p: p.keyboard.press(key))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/click":
            body = self._read_json()
            x = body.get("x")
            y = body.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                return self._send_json(400, {"error": "x and y required (numbers)"})
            try:
                _submit_job(lambda p: p.mouse.click(x, y))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/selectorClick":
            body = self._read_json()
            sel = body.get("selector")
            if not isinstance(sel, str) or not sel:
                return self._send_json(400, {"error": "selector required"})
            try:
                _submit_job(lambda p: p.locator(sel).click(timeout=10_000))
                return self._send_json(200, {"ok": True})
            except Exception as e:
                return self._send_json(500, {"error": type(e).__name__, "detail": str(e)[:200]})

        if self.path == "/use_figma":
            # Bridge App proxy lands in M3. Endpoint exists so callers can
            # wire against the API surface; always fails closed until then.
            return self._send_json(503, {
                "error": "bridge_not_connected",
                "detail": "Bridge App proxy not yet implemented; see BLO-6355 M3.",
            })

        return self._send_json(404, {"error": "not found"})


class _ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _run_control_server() -> None:
    srv = _ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), _ControlHandler)
    log("control plane listening on :" + str(CONTROL_PORT) + " (threading)")
    srv.serve_forever()


def _install_signal_handlers() -> None:
    def _on_term(signum: int, _frame: Any) -> None:
        log(f"received signal {signum}; exiting cleanly so Camoufox can close Firefox")
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)


def _drain_jobs_for(page: Page, max_seconds: float) -> None:
    deadline = time.time() + max_seconds
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return
        try:
            entry = _job_queue.get(timeout=min(remaining, JOB_POLL_INTERVAL))
        except queue.Empty:
            return
        fn, box, done = entry
        if isinstance(fn, _SwitchSentinel):
            # Record the target; main loop body picks it up next iteration.
            # We do NOT signal done here — _signal_switch_done does that.
            _set_active_target(fn.identity, fn.force_refresh)
            return  # yield to the main loop so the switch runs
        try:
            box["result"] = fn(page)
        except Exception as e:
            box["error"] = e
        finally:
            done.set()


LEGACY_PROFILE_DIR = "/config/playwright-profile"
LEGACY_BACKUP_DIR  = "/config/playwright-profile-backup"


def _migrate_legacy_profile_layout() -> None:
    """One-shot, idempotent: move /config/playwright-profile/ under
    /config/profiles/<sha16-of-default>/. Same-fs rename is atomic.
    Skips if target exists or no default identity resolvable."""
    if _identities is None:
        log("migration: skipping — IdentityRegistry not initialized")
        return
    default = _identities.default_identity()
    if default is None:
        log("migration: no default identity; legacy dir untouched")
        return
    slug = _slug_for(default)
    target_profile = os.path.join(PROFILES_ROOT, slug, "playwright-profile")
    target_backup  = os.path.join(PROFILES_ROOT, slug, "playwright-profile-backup")
    target_email   = os.path.join(PROFILES_ROOT, slug, "email.txt")
    if os.path.exists(target_profile):
        log(f"migration: target {target_profile} already exists; skipping main rename")
    elif not os.path.exists(LEGACY_PROFILE_DIR):
        log("migration: no legacy /config/playwright-profile/; skipping main rename")
    else:
        try:
            os.makedirs(os.path.join(PROFILES_ROOT, slug), exist_ok=True)
        except OSError as e:
            log(f"migration: makedirs failed for {PROFILES_ROOT}/{slug}: {e}; aborting")
            return
        try:
            os.rename(LEGACY_PROFILE_DIR, target_profile)
            log(f"migration: renamed {LEGACY_PROFILE_DIR} -> {target_profile}")
        except OSError as e:
            log(f"migration: rename profile failed: {e}; aborting")
            return
    if os.path.exists(LEGACY_BACKUP_DIR) and not os.path.exists(target_backup):
        try:
            os.rename(LEGACY_BACKUP_DIR, target_backup)
            log(f"migration: renamed {LEGACY_BACKUP_DIR} -> {target_backup}")
        except OSError as e:
            log(f"migration: rename backup failed: {e}")
    if not os.path.exists(target_email):
        try:
            with open(target_email, "w") as f:
                f.write(default + "\n")
            log(f"migration: wrote {target_email}")
        except OSError as e:
            log(f"migration: email.txt write failed: {e}")




def main() -> None:
    log("starting figma-designer-bot (multi-profile v0.3)")
    log(f"PROFILES_ROOT={PROFILES_ROOT} IDENTITIES_PATH={IDENTITIES_PATH}")

    _install_signal_handlers()

    global _identities
    _identities = IdentityRegistry()

    _migrate_legacy_profile_layout()  # added in T6

    t = threading.Thread(target=_run_control_server, daemon=True)
    t.start()

    pm: Optional[ProfileManager] = None
    next_backup = time.time() + 60
    next_refresh = time.time() + REFRESH_SECONDS

    # BLO-6870 cold-bootstrap fix:
    #
    # The /lease/acquire HTTP handler pushes a _SwitchSentinel onto
    # _job_queue and waits 60s on a threading.Event. The main loop is the
    # only consumer of _job_queue (via _drain_jobs_for), but that drain
    # only fires after `pm` is built — and pm is only built after
    # _active_target is set, which is only set by the queue drain. Cold
    # boots therefore deadlock until the 60s timeout fires "switch_timeout"
    # on every first acquire (escalating backoff 60s → 300s → 1800s).
    #
    # Break the chicken-and-egg by setting _active_target to the default
    # identity BEFORE entering the loop. The first iteration then has
    # target = default, builds pm, launches Camoufox, and from then on the
    # in-loop _drain_jobs_for handles _SwitchSentinels normally.
    default = _identities.default_identity() if _identities is not None else None
    if default is not None:
        _set_active_target(default, force_refresh=False)
        log(f"cold-boot: bootstrapped with default identity {default}")

    while True:
        target, force_refresh = _get_active_target()
        if target is None:
            time.sleep(JOB_POLL_INTERVAL)
            continue

        if pm is None or pm.identity != target or force_refresh:
            if pm is not None:
                pm.close()
                pm = None
            try:
                pm = ProfileManager(target)
                pm.launch()
            except Exception as e:
                log(f"main: ProfileManager build for {target} failed: {type(e).__name__}: {str(e)[:160]}")
                _record_login_failure(target, f"launch_error:{type(e).__name__}")
                _signal_switch_done(target, switched=False, login_performed=False,
                                    error=f"launch_error:{type(e).__name__}")
                _set_active_target(None, False)
                pm = None
                time.sleep(JOB_POLL_INTERVAL)
                continue
            if force_refresh:
                _clear_force_refresh()

            li, reason = _is_logged_in(pm.page)
            login_performed = False
            if not li:
                login_performed = True
                try:
                    _auto_login(pm)  # added in T5
                    li, reason = _is_logged_in(pm.page)
                except RFBConnectFailed:
                    li, reason = False, "rfb_unreachable"
                except Exception as e:
                    li, reason = False, f"login_error:{type(e).__name__}"
            if li:
                _record_login_success(pm.identity)
                with _status_lock:
                    if login_performed:
                        _status["session_restored_at"] = time.time()
                    _status["logged_in"] = True
                    _status["active_identity"] = pm.identity
                _signal_switch_done(pm.identity, switched=True,
                                    login_performed=login_performed, error=None)
            else:
                _record_login_failure(pm.identity, reason)
                with _status_lock:
                    _status["logged_in"] = False
                    _status["active_identity"] = pm.identity
                _signal_switch_done(pm.identity, switched=True,
                                    login_performed=login_performed, error=reason)
                pm.close()
                pm = None
                _set_active_target(None, False)
                time.sleep(JOB_POLL_INTERVAL)
                continue

        _drain_jobs_for(pm.page, JOB_POLL_INTERVAL)
        now = time.time()
        if now >= next_refresh:
            try:
                _refresh_status(pm.page)
            except Exception as e:
                log(f"refresh loop error: {type(e).__name__}: {str(e)[:160]}")
            next_refresh = now + REFRESH_SECONDS
        if now >= next_backup:
            pm.backup_cookies()
            next_backup = now + 300


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log("FATAL: " + type(e).__name__ + ": " + str(e))
        sys.exit(1)

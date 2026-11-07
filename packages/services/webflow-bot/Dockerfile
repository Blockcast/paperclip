# Pre-baked image for the long-running webflow-designer-bot Deployment.
#
# Replaces the boot-time `apt install xvfb x11vnc websockify novnc fluxbox` +
# `npm install playwright@1.49.1` + `pip install camoufox[geoip] playwright`
# + `python3 -m camoufox fetch` (~250MB Firefox download) that the previous
# inline wrapper script tried to run on every pod restart.
#
# This image ALSO serves as the base layer for sibling Python services that
# need the same Camoufox + Playwright + VNC toolchain (currently figma-bot).
# Bake once, inherit everywhere.
#
# Migrated 2026-05-24 from onprem-k8s/.planning/webflow-designer-bot-image/
# to paperclip/packages/services/webflow-bot/ as part of BLO-6870 —
# co-locates the Python source with its Dockerfile + CI + tests.

# Stay on the playwright base — it ships browser binaries (Chromium /
# Firefox / WebKit) at /ms-playwright + has Node 22 + Python 3.10.
# v1.49.1 matches the npm playwright pinned by the bot's existing script.
# The base arrives as a resolved <repo>@sha256:... reference from
# docker-webflow-bot.yml (scripts/resolve-base-digest.sh); the default below is
# the tag, so a local build still works. v1.49.1 is patch-specific but still
# mutable — the jammy layer underneath it is rebuilt — so the digest is what
# actually names this base (PEN-5927).
ARG BASE=mcr.microsoft.com/playwright:v1.49.1-jammy

FROM ${BASE}

ARG DEBIAN_FRONTEND=noninteractive

# VNC tooling (xvfb already in base image; the rest are for human VNC
# fallback when programmatic relogin is exhausted) + python3-pip for
# Camoufox install + python3-venv so downstream services (figma-bot)
# can opt into venvs without re-installing.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      xvfb \
      x11vnc \
      websockify \
      novnc \
      fluxbox \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

# The playwright base image ships npm 10.x, whose bundled `tar` 6.2.1 carries
# CVE-2026-59873 (Critical; node-tar decompression DoS — GHSA-23hp-3jrh-7fpw,
# vulnerable range `tar <= 7.5.18`, first patched 7.5.19) — BLO-51968. Every
# image built FROM this one (figma-bot) inherits it. npm@11.21.1 bundles tar
# 7.5.22 and supports the base image's Node 22 (npm 12 needs Node >=22.22.2).
#
# The tar check below fails the build if the bundled tar is below 7.5.19 —
# the advisory's fix version, NOT a major-version floor. PEN-5800: the
# original `[ "${TAR_V%%.*}" -ge 7 ]` compared only the major, so it passed
# on tar 7.5.11 — exactly what npm 10.9.x bundles. That left the single most
# likely regression (lowering this npm pin back to a 10.9.x) landing on a
# vulnerable tar and still going green. A version string that is not a plain
# X.Y.Z release also fails, so an unrecognised version can never be read as
# "new enough".
RUN npm install -g --no-audit --no-fund npm@11.21.1 \
 && TAR_PKG="$(npm root -g)/npm/node_modules/tar/package.json" \
 && node -e 'const MIN = "7.5.19"; \
const parse = s => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s)); return m ? m.slice(1).map(Number) : null; }; \
const v = require(process.argv[1]).version; \
const got = parse(v), min = parse(MIN); \
if (!got) { console.error(`FATAL: npm-bundled tar version ${JSON.stringify(v)} is not a plain X.Y.Z release; refusing to assume it is >= ${MIN} (CVE-2026-59873).`); process.exit(1); } \
const below = got[0] !== min[0] ? got[0] < min[0] : got[1] !== min[1] ? got[1] < min[1] : got[2] < min[2]; \
if (below) { console.error(`FATAL: npm-bundled tar ${v} is vulnerable to CVE-2026-59873 (GHSA-23hp-3jrh-7fpw: tar <= 7.5.18). Need >= ${MIN}; raise the npm pin above.`); process.exit(1); } \
console.log(`npm-bundled tar ${v} (>= ${MIN}, clear of CVE-2026-59873)`);' "$TAR_PKG"

# Playwright NPM module pinned at v1.49.1 — matches the browser binaries
# baked into the base image (mismatch = "browser version not found"
# at runtime). PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 prevents the postinstall
# hook from re-downloading what's already at /ms-playwright.
WORKDIR /app
RUN npm init -y >/dev/null \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm install --silent --no-audit --no-fund playwright@1.49.1

# Camoufox = stealth Firefox with binary-level fingerprint randomization
# (canvas/WebGL/audio/fonts/timing patched in the Firefox C++ layer where
# JS init scripts can't reach). Ships from pypi as a python wheel; the
# custom Firefox binary it drives downloads on first `camoufox fetch`
# from github releases (~250MB). We download it now into /opt/cf-cache
# so the running pod never makes that fetch.
#
# `[geoip]` extra pulls in MaxMind's free GeoLite2 DB so Camoufox can
# auto-align timezone/locale to the egress IP.
ENV XDG_CACHE_HOME=/opt/cf-cache
RUN pip install --no-cache-dir \
      "camoufox[geoip]==0.4.11" \
      "playwright==1.59.0" \
 && mkdir -p "$XDG_CACHE_HOME" \
 && python3 -m camoufox fetch

# Sanity check: import succeeds + binary present. Catches the "fetch
# silently 404'd" failure mode early.
RUN python3 -c "from camoufox.sync_api import Camoufox; print('camoufox import ok')" \
 && CFDIR=$(python3 -m camoufox path) \
 && test -x "$CFDIR/camoufox" \
 && echo "firefox binary: $($CFDIR/camoufox --version 2>&1 | head -1 || true)"

# Copy the webflow_bot package into the image. Build context is the
# paperclip monorepo root (see docker-webflow-bot.yml); paths below are
# relative to that root.
COPY packages/services/webflow-bot/pyproject.toml /app/
COPY packages/services/webflow-bot/src /app/src

# Install as a package so `python3 -m webflow_bot` is the canonical
# entrypoint. --no-deps because Camoufox + Playwright are already
# pinned above; pyproject.toml lists them for tooling (mypy/ruff) but
# the runtime versions live in this Dockerfile. This image has already
# copied the source into /app, so a normal wheel install avoids requiring
# editable-install support from the build backend.
#
# Upgrade pip + setuptools first — the playwright base ships Ubuntu jammy's
# python3-setuptools 59.6, which predates PEP 621 `[project]` table support
# and silently builds an empty `UNKNOWN-0.0.0` wheel. Pip's build-isolation
# is supposed to honor `[build-system].requires = ["setuptools>=68"]` but
# does not reliably with pip 22.0.2 when the system setuptools also provides
# `setuptools.build_meta`. Upgrading the system pip+setuptools is the
# durable fix.
RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
 && pip install --no-cache-dir --no-deps /app

# The bot is launched by the wrapper command in the Deployment manifest
# (Xvfb + x11vnc + websockify orchestration is a manifest concern, not
# an image concern). After BLO-6870 cutover the manifest's command
# collapses to: start Xvfb + VNC + `python3 -m webflow_bot`.

# Default user is the playwright base's `pwuser`; the Deployment's
# securityContext overrides to runAsUser:0 because `mkdir
# /config/playwright-profile` and apt-cache redirect need root.
LABEL org.opencontainers.image.title="paperclip-webflow-bot" \
      org.opencontainers.image.description="Playwright + Camoufox baked image + webflow-designer-bot service for paperclip" \
      org.opencontainers.image.source="https://github.com/Blockcast/paperclip/tree/master/packages/services/webflow-bot"

# figma-bot: multi-identity Camoufox session for the Figma Designer.
#
# Inherits the entire Camoufox + Playwright + Xvfb + x11vnc toolchain from
# the sibling paperclip-webflow-bot image (packages/services/webflow-bot/).
# Bake once, reuse — Camoufox download is 250MB; we don't want every Python
# service redoing it.

ARG WEBFLOW_BOT_TAG=latest
FROM harbor.blockcast.net/paperclip-webflow-bot/webflow-bot:${WEBFLOW_BOT_TAG}

# Copy the figma_bot package into the image. Build context is the
# paperclip monorepo root (see docker-figma-bot.yml); paths below are
# relative to that root.
COPY packages/services/figma-bot/pyproject.toml /app/figma-bot/
COPY packages/services/figma-bot/src /app/figma-bot/src

# Install as a package so `python3 -m figma_bot` is the canonical
# entrypoint. --no-deps because Camoufox + Playwright are already pinned
# in the base image; pyproject.toml lists them for tooling (mypy/ruff)
# but the runtime versions live in webflow-bot's Dockerfile.
RUN pip install --no-cache-dir --no-deps -e /app/figma-bot

# The bot is launched by the wrapper command in the Deployment manifest
# (xvfb + x11vnc + websockify orchestration is a manifest concern, not
# an image concern). After BLO-6870 cutover the manifest's command
# collapses to: start Xvfb + VNC + `python3 -m figma_bot`.

LABEL org.opencontainers.image.title="paperclip-figma-bot" \
      org.opencontainers.image.description="Multi-identity Figma Designer automation pod (inherits webflow-bot toolchain)" \
      org.opencontainers.image.source="https://github.com/Blockcast/paperclip/tree/master/packages/services/figma-bot"

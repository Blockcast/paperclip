# syntax=docker/dockerfile:1
#
# paperclip-mcp-gateway: thin reverse-proxy that catches "Session not
# found" 404s from upstream MCP servers and replays the cached
# `initialize` request before retrying. Single-binary Node service,
# no external dependencies at runtime — uses native node:http + fetch.

# The base arrives as a resolved <repo>@sha256:... reference from
# docker-mcp-gateway.yml (scripts/resolve-base-digest.sh). The default below is
# the floating tag, so a local `docker build` still works unattended — but a CI
# image is always pinned, and records which base it used in its
# org.opencontainers.image.base.name label (PEN-5927).
ARG NODE_BASE=node:22-alpine

FROM ${NODE_BASE} AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY packages/mcp-gateway ./packages/mcp-gateway
COPY tsconfig.base.json ./
RUN cd packages/mcp-gateway && pnpm install --frozen-lockfile=false --prod=false
RUN cd packages/mcp-gateway && pnpm build

FROM ${NODE_BASE}
# The runtime only runs `node dist/server.js`; the base image's bundled
# npm/corepack/yarn are dead weight that carry their own CVEs (BLO-51891:
# npm <= 10.9.8 bundles a tar that CVE-2026-59873 hits). Drop them.
#
# Do NOT reuse "npm 10.9.x ⇒ CVE-2026-59873" as a triage rule — it false-
# positives on 10.9.9+ (PEN-5690), and the bundled tar is not even constant
# within 10.9.x (10.9.5 → 6.2.1, 10.9.8 → 7.5.11; both inside the range).
# The advisory is tar <= 7.5.18, first patched 7.5.19 (GHSA-23hp-3jrh-7fpw);
# npm 10.9.9 — first shipped in Node v22.23.3, 2026-09-23 — bundles 7.5.22
# and is unaffected. Which npm lands here is a property of the base image, and
# since PEN-5927 a CI build records that base by digest rather than leaving it
# to the build date — but the removal below stays unconditional rather than
# becoming a version check, because it is correct whichever npm the base
# happens to carry, including for an unpinned local build.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/mcp-gateway/dist ./dist
COPY --from=build /app/packages/mcp-gateway/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

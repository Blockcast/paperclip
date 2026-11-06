# syntax=docker/dockerfile:1
#
# paperclip-mcp-gateway: thin reverse-proxy that catches "Session not
# found" 404s from upstream MCP servers and replays the cached
# `initialize` request before retrying. Single-binary Node service,
# no external dependencies at runtime — uses native node:http + fetch.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
COPY packages/mcp-gateway ./packages/mcp-gateway
COPY tsconfig.base.json ./
RUN cd packages/mcp-gateway && pnpm install --frozen-lockfile=false --prod=false
RUN cd packages/mcp-gateway && pnpm build

FROM node:22-alpine
# The runtime only runs `node dist/server.js`; the base image's bundled
# npm/corepack/yarn are dead weight that carry their own CVEs (BLO-51891:
# npm <= 10.9.8 bundles tar 7.5.11, which CVE-2026-59873 hits). Drop them.
#
# Do NOT reuse "npm 10.9.x ⇒ CVE-2026-59873" as a triage rule — it false-
# positives on 10.9.9+ (PEN-5690). The advisory range is tar <= 7.5.18, first
# patched 7.5.19 (GHSA-23hp-3jrh-7fpw); npm 10.9.9 — first shipped in Node
# v22.23.3, 2026-09-23 — bundles tar 7.5.22 and is unaffected. `node:22-alpine`
# is a floating tag, so which npm lands here is decided by build date, not by
# this repo. That is why the removal below is unconditional rather than a
# version check: it is correct whichever npm the base image happens to carry.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/mcp-gateway/dist ./dist
COPY --from=build /app/packages/mcp-gateway/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

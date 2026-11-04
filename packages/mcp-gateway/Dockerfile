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
# npm 10.9.x pins tar 7.5.11, CVE-2026-59873). Drop them.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/mcp-gateway/dist ./dist
COPY --from=build /app/packages/mcp-gateway/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

# Bump the default OpenCode runtime pin to 1.19.6

`src/server/runtime-pin.ts`: `DEFAULT_OPENCODE_VERSION` moves from `1.19.5`
(published 2026-10-28) to `1.19.6`, the `latest` dist-tag of `opencode-ai` on
npm when this was written (published 2026-11-17T07:22:20Z). `Dockerfile.runtime`'s
`OPENCODE_AI_VERSION` follows so the image's bundled binary matches the adapter
default.

1.19.6 changes (upstream release notes): a session whose history holds more than
25 MiB of images has its oldest images replaced with a placeholder instead of
sending an oversized request, and a provider "request body too large" error now
starts compaction and a retry instead of failing the turn. It does NOT change
429 handling: `RETRY_MAX_RETRIES` stays a compiled constant, so this bump is not
a remedy for provider-capacity failures. It also adds a desktop-only offer to
upgrade to OpenCode 2.0, which does not apply to `opencode run` in Job pods.

The cost the constant's comment warns about applies once. The db-reset guard in
`src/server/job-manifest.ts` compares `opencode --version` with the version
stamped beside each persistent `opencode.db` and deletes the DB (plus `-wal`
and `-shm`) when they differ. Every agent on the default pin therefore loses
its local OpenCode session DB on its first Job after the server deploys this. A
run that tries to resume a session from the deleted DB fails as
`session_unavailable` with `clearSession`, and the next run starts fresh. Agents
with an explicit `adapterConfig.opencodeVersion`, including `"image"`, keep
their DB.

Docs follow the constant: the `opencodeVersion` row in `README.md` and the
config doc in `src/index.ts`. The tests already read `DEFAULT_OPENCODE_VERSION`.

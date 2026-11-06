# Bump the default OpenCode runtime pin to 1.19.5

`src/server/runtime-pin.ts`: `DEFAULT_OPENCODE_VERSION` moves from `1.18.35`
(published 2026-10-06) to `1.19.5`, the `latest` dist-tag of `opencode-ai` on
npm when this was written (published 2026-10-28T06:17:11Z).

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

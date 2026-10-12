# BLO-32734 — the agent's own bundle dir stays writable under the narrowed mount

Tracking: [BLO-32734](https://paperclip.blockcast.net/BLO/issues/BLO-32734)

**Files:** `src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`

`resolveScopedWritableMounts` covered the agent's instructions via `effectiveInstructionsFilePath`, which is the prompt-cache copy whenever a prompt bundle is present. The canonical bundle (`companies/<co>/agents/<agent>/instructions/`) and the agent's `memory/` therefore sat under the read-only parent, and every self-edit hit EROFS — measured on two agent pods 2026-10-12. A new `agentInstructionsFilePath` candidate takes the raw `config.instructionsFilePath`; for a managed `.../agents/<id>/instructions/<file>` it opens the whole agent dir, otherwise the file's own dir, and never the data root. Foreign agents' dirs stay read-only. Test mutation-checked: dropping the call-site wiring or the grandparent step each fails it.

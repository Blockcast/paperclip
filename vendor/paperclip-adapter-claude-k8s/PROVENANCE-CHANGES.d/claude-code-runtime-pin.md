# Adapter-managed Claude Code runtime (`claudeCodeVersion`)

**Files:** `src/server/runtime-pin.ts` (new), `src/server/runtime-pin.test.ts` (new),
`src/server/job-manifest.ts`, `src/server/job-manifest.test.ts`, `src/server/config-schema.ts`,
`src/server/config-schema.test.ts`, `src/server/models.ts`, `src/server/models.test.ts`,
`src/index.ts`, `src/server/execute.ts`, `README.md`, `CLAUDE.md`.

**Why.** Job pods inherit this image, whose Dockerfile installs
`@anthropic-ai/claude-code@latest` into a root-owned, layer-cached
`/usr/local/lib/node_modules`. "latest" froze at 2.1.210 (layer dated 2026-08-14) even
though the image was redeployed on 2026-10-05, and Job pods run as uid 1000 so
`claude update` cannot touch it. The API refuses old clients for new models: the first
`claude-opus-5-5[1m]` heartbeat on the fleet (2026-10-06 21:12Z) failed with
`API Error: 400 Claude Code 2.1.210 does not support this model; version 2.1.280 or
newer is required`.

**What.** The adapter pins the CLI (`claudeCodeVersion`, default `2.1.292`, exact
versions only, `"image"` opts out and keeps the main command byte-identical). The Job's
main command installs the pinned package once into
`<data PVC>/.local/lib/paperclip-k8s-runtimes/claude-code/<version>` — atomic `mkdir`
lock carrying a random owner token, re-read before any delete and released only by
its owner, 20-minute stale reclaim by atomic rename (the renamed lock's age is
re-tested, so a lock another installer re-took in between is put back),
`.complete` re-checked once the lock is held, staged install published with
`mv -T` only after the fresh binary answers `--version` (a runtime a concurrent
installer already published is reused rather than nested into), `.complete` marker,
concurrent Jobs wait for the winner — prepends it to PATH ahead of the ccrotate
preflight, and sets
`DISABLE_AUTOUPDATER=1` unless the operator set it. If nothing usable exists afterwards
the run falls back to the bundled CLI and says so on stderr. The runtime is shared
across isolation keys on purpose — the first PATH executable to cross that split — and
the trust assumption is documented in `runtime-pin.ts` and at the isolation `HOME`
contract in `job-manifest.ts`. The run's `commandNotes`
report which CLI was used. The model catalog gains Fable 5.1, Opus 5.5, Sonnet 5.5 and
Opus 5.

**Upstream.** Same change as kkroo/paperclip-adapter-claude-k8s#34 (merged `73ee6853`)
plus the Fable 5.1 catalog rows from #33 (`4f3b0bc3`), ported onto the diverged
vendored tree (which carries the pod-log redactor and the external launchers in the
same command; the bootstrap sits after the env guard and before ccrotate, and the
pod-log redactor setup follows the log-directory `mkdir`).

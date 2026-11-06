# Bump the default Claude Code runtime pin to 2.1.311

`src/server/runtime-pin.ts`: `DEFAULT_CLAUDE_CODE_VERSION` moves from `2.1.292`
(published 2026-10-06) to `2.1.311`, the `stable` dist-tag of
`@anthropic-ai/claude-code` on npm when this was written (published
2026-10-26T19:47:57Z; `latest` was 2.1.318 and `next` 2.1.319). Following
`stable` rather than `latest` keeps the fleet on the build Anthropic has
promoted, while still clearing the model floors that motivated the pin
(2.1.280 for Opus 5.5, 2.1.284 for Sonnet 5.5).

No mechanism changes. Agents without `adapterConfig.claudeCodeVersion` install
the new version once into a fresh versioned directory on the data PVC (per
company on a narrowed mount) on their next Job; agents with an explicit value,
including `"image"`, are unaffected. The old `2.1.292` directory is left in
place, so pinning an agent back to it reuses that install.

Docs follow the constant: the `claudeCodeVersion` row in `README.md` and the
config doc in `src/index.ts`. `src/server/job-manifest.test.ts` derives the
shared-runtime path in its foreign-mount list from `DEFAULT_CLAUDE_CODE_VERSION`
instead of a literal, so the boundary check keeps covering the path the default
actually installs to.

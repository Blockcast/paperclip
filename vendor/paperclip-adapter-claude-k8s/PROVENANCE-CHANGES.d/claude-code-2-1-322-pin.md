# Claude Code 2.1.322 runtime pin

**Files:** `src/server/runtime-pin.ts`, `src/index.ts`, `README.md`.

**Runtime pin.** `DEFAULT_CLAUDE_CODE_VERSION` moves from `2.1.321` to `2.1.322`.
2.1.322 was published on 2026-11-10 at 01:58Z and is now the npm `latest` and `next`
dist-tag; `stable` is still 2.1.311. Its changelog has one entry: fast mode on Vertex,
falling back to standard speed when Vertex refuses it. No agent here reaches Claude
through Vertex, so for this fleet the bump only keeps the pin on `latest`.

**Smoke, before bumping.** Installed 2.1.321 and 2.1.322 side by side and ran
`claude -p` with no credentials, one version per fresh `HOME`. Both behave the same:
- Both binaries carry `claude-fable-5-2` and `claude-mythos-5-2`.
- A fresh start fails only on login ("Not logged in").
- An unparseable `.claude.json` is fatal ("Configuration error ... JSON Parse error").
- After the file is moved aside, as `buildClaudeConfigRepairShell()` does, the CLI
  warns that the file is missing and that a backup exists, then reaches the same
  login check. The next run is clean.

So the 2.1.318+ corrupt-config repair is still needed, and still sufficient.

**Rollout and rollback.** Agents without `adapterConfig.claudeCodeVersion` install
2.1.322 once into a fresh versioned directory on their next Job. Agents with an
explicit value, including `"image"`, are unaffected. To roll an agent back, pin it to
`2.1.321`; that install is still on the PVC. The `README.md` row and the config doc in
`src/index.ts` follow the constant. `Dockerfile.runtime` and its pin test in
`packages/adapter-utils` move with it.

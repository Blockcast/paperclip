# Claude Fable 5.2 and Mythos 5.2, and the Claude Code 2.1.321 runtime pin

**Files:** `src/server/models.ts`, `src/server/models.test.ts`, `src/index.ts`,
`src/server/runtime-pin.ts`, `src/server/runtime-pin.test.ts`, `src/server/job-manifest.ts`,
`src/server/job-manifest.test.ts`, `README.md`.

**Catalog.** Fable 5.2 and Mythos 5.2 were released on 2026-11-09. Direct API ids are
`claude-fable-5-2` and `claude-mythos-5-2`, each also listed with the `[1m]` 1M-context
form beside it. Bedrock geo inference ids are `us.anthropic.claude-fable-5-2` and
`us.anthropic.claude-mythos-5-2`. Fable 5.2 takes the head of the direct list, the
position Fable 5.1 held. Mythos 5.2 sits after Fable 5.1, because Anthropic's
verification programs gate access to it. `src/index.ts` and `src/server/models.ts`
carry the same rows.

**Runtime pin.** `DEFAULT_CLAUDE_CODE_VERSION` moves from `2.1.311` to `2.1.321`.
2.1.321 is the first release whose changelog adds Fable 5.2. An older client does not know
the model: 2.1.311 logs `unrecognized_model` and runs it with a 200K context and 32K max
output instead of 1M and 128K. That is a floor for the CLI, not for the API (see below). 2.1.321 is the npm `latest` and `next`
dist-tag; `stable` is still 2.1.311. This bump follows `latest` because no `stable`
build supports the new models; the 2.1.311 bump followed `stable`. Agents without
`adapterConfig.claudeCodeVersion` install 2.1.321 once into a fresh versioned
directory on their next Job. Agents with an explicit value, including `"image"`, are
unaffected. To roll an agent back, pin it to `2.1.311`; that install is still on the
PVC. The `README.md` row and the config doc in `src/index.ts` follow the constant.

**What else 2.1.321 changes for agents.** The `fable` alias now resolves to
`claude-fable-5-2`; an explicit `claude-fable-5-1` keeps the old model. No live agent used
`fable` or `best` when this landed. On the subscription path Anthropic sees the penstock
vault's `claude-cli/<version>` user agent, not this pin. The vaults present 2.1.299, and
penstock usage_metering shows `claude-fable-5-2` served to them on 2026-11-09 at 20:06Z and
20:20Z (penstock-llm-proxy-core#3267), so the vault needed no change for 5.2.

**Corrupt `.claude.json` guard.** Since 2.1.318 a non-interactive start no longer replaces a
`.claude.json` that is not valid JSON with defaults; it fails with "Configuration error in
…/.claude.json" and leaves the file (anthropics/claude-code#87551). `CLAUDE_CONFIG_DIR` is
per agent on the PVC, so one bad write would fail every later run of that agent.
`buildClaudeConfigRepairShell` runs right before `claude`, for pinned and `"image"` runs
alike, and moves an unparseable file to `.claude.json.corrupt-<epoch>` with a
`[paperclip] claude-config` line on stderr. Missing and empty files are left alone; both
start fine.

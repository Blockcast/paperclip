# syntax=harbor.blockcast.net/dockerfile/dockerfile:1.20
# Build stages use the same stable runtime as production, but explicitly reset
# NODE_ENV so dependency installers include development/build dependencies.
ARG RUNTIME_IMAGE=harbor.blockcast.net/paperclip/paperclip-runtime:latest
FROM ${RUNTIME_IMAGE} AS base
ENV NODE_ENV=development

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/google-sheets-mcp-server/package.json packages/google-sheets-mcp-server/
COPY packages/kv-demo-mcp-server/package.json packages/kv-demo-mcp-server/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/mcp-external/package.json packages/mcp-external/
COPY packages/mcp-gateway/package.json packages/mcp-gateway/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/paperclip-plugin-gbrain/package.json packages/plugins/paperclip-plugin-gbrain/
COPY packages/plugins/paperclip-plugin-linear/package.json packages/plugins/paperclip-plugin-linear/
COPY packages/plugins/paperclip-plugin-alertmanager/package.json packages/plugins/paperclip-plugin-alertmanager/
COPY packages/plugins/paperclip-plugin-slack/package.json packages/plugins/paperclip-plugin-slack/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

# pnpm store mount: re-uses the content-addressable cache of downloaded
# tarballs between builds so we only fetch packages whose hashes
# actually changed since the last build. With --frozen-lockfile, hashes
# are pinned, so most builds get near-100% cache hits.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM base AS vendor
WORKDIR /vendor
# Pinned commit SHAs for the kkroo forks of the two k8s-Job adapters.
# Bump these by pushing the fork branch and updating the ARG. Public repos,
# so no auth required at clone time.
#
# Each repo's build → `pnpm pack` (or `npm pack`) produces the .tgz the
# production stage installs. We never commit the tgz; it's reproduced on
# every image build.
# Re-pinned 2026-06-03 (BLO-8909) to kkroo/paperclip-adapter-opencode-k8s
# master 3bbc0b3 (was 7415df5): default agentDbMode to workspace_subpath so
# the agent DB lives on a per-(agent, task) subPath of the shared RWX
# workspace data PVC instead of a per-agent RWO ceph-rbd PVC. Makes durable
# the BLO-8906 mitigation for the recurring opencode_k8s Multi-Attach on
# cross-node retry; dedicated_pvc remains explicit opt-in. Verified in
# cluster via BLO-8908.
# Re-pinned 2026-06-06 to kkroo/paperclip-adapter-opencode-k8s master 380aea4
# (was 2dba034): when OPENAI_API_KEY is configured, skip the OpenCode OAuth
# bootstrap and clear stale OpenCode auth/account files so API-key backed
# agents do not attempt a stale OAuth token refresh.
# Re-pinned 2026-06-06 to kkroo/paperclip-adapter-opencode-k8s master 2d8c7b4
# (was 380aea4): bound the ccrotate Codex preflight with `timeout 30s` so a
# stuck account probe cannot block opencode_k8s Jobs before OpenCode starts.
# (was 2d8c7b4): point AGENT_HOME at the external instructions-bundle root
# (PR kkroo/paperclip-adapter-opencode-k8s#21, BLO-10267) so opencode_k8s
# agents with an external bundle can read $AGENT_HOME/{HEARTBEAT,SOUL,TOOLS}.md
# + skills/*.md instead of 100%-failing with File-not-found.
# Bumped 2026-06-16 to 6a7b9d5: always materialize the shared MCP baseline
# into claude_k8s Job pods, even when an agent has no adapterConfig.mcpServers.
# Fixes BackendEngineerGo/Ally missing paperclip/hindsight/gbrain/linear/etc.
# Bumped 2026-06-17 to af5df84: only pass --resume to Claude when the
# corresponding local Claude JSONL session exists. Paperclip runtime UUIDs
# without a Claude session file now start fresh instead of failing with
# "No conversation found with session ID".
# Bumped 2026-06-17 to f79ab9a (master tip): BLO-10699 — redirect Chrome's
# BrowserMetrics spool off the shared CephFS HOME to the per-pod /runtime-cache
# emptyDir (PR #8), so the agent-browser designer tool's headless Chrome can no
# longer leak *.pma buffers onto /paperclip and wall the fleet with EDQUOT.
# af5df84's "only --resume when the JSONL session exists" guard was pinned
# directly off an unmerged branch and was NOT on master; PR #9 ported it onto
# master (cherry-pick), so f79ab9a carries BOTH the --resume guard and the
# BrowserMetrics fix (verified present + 371 tests green). No --resume regress.
# Bumped 2026-06-28 to 3587afc: classify Claude's malformed/empty HTTP 200
# upstream failures as transient_upstream instead of adapter_failed, so the
# Paperclip scheduler can retry affected continuations instead of freezing
# blocked chains behind a generic adapter failure.
# Bumped 2026-06-28 to ddbaa94: split pod scheduling and startup waits so
# first pulls of large agent images after a bump are not killed as false
# k8s_pod_schedule_failed errors after Kubernetes has already assigned a node.
# Bumped 2026-06-30 to 56811ea: add 1M model IDs and record the configured
# model in session params so Claude jobs do not resume stale non-1M sessions.
# Bumped 2026-06-30 to 4e3cc38: add Claude Sonnet 5 model IDs and stop
# tracking generated dist artifacts; CI now builds and pack-verifies them.
# Bumped 2026-07-02 to ff8c978: per-agent Penstock session identity — merge
# `x-penstock-session: agent:<name>` into ANTHROPIC_CUSTOM_HEADERS (Claude Code
# forwards it per request; Penstock client-session extraction gives it top
# precedence), so each claude_k8s agent shows as its own live entry in
# org_penstock #accounts instead of the shared-key UNTAGGED bucket. Appends to
# existing custom headers; a manual x-penstock-session override wins. Twin of
# the opencode_k8s stamp (kkroo/paperclip-adapter-opencode-k8s#37). PR
# kkroo/paperclip-adapter-claude-k8s#15; local adapter verification: typecheck
# clean, 384/384 tests (2 new), rebased over the isolation-mode HOME/cache work.
# Bumped 2026-07-03 to c04ae02: unbreak this image's vendor build — #581
# (BLO-10889) made SessionCompactionPolicy.maxConsecutiveFailedResumes required
# in the vendored adapter-utils, and the adapter's declared policy lacked it
# (tsc TS2741, Docker red since 4dfb7fd). Adapter declares 3, mirroring the
# operative K8S_AGENT_SESSION_POLICY, and hoists the literal so it also
# compiles against published adapter-utils that don't declare the field. PR
# kkroo/paperclip-adapter-claude-k8s#16; verified: 384/384 tests + tsc clean on
# published deps, and tsc clean against an adapter-utils tgz built exactly per
# this file's vendor stage.
# Bumped 2026-07-13 to 63d00ecf (BLO-15896): omit pod-level fsGroup from
# claude_k8s Jobs. The container's primary runAsGroup=1000 and DinD's explicit
# socket group preserve access without asking kubelet to recursively chown the
# shared paperclip-data CephFS PVC. Manifest suite 141/141, typecheck, and build
# passed; live concurrent shared-PVC pods reached Ready without
# VolumePermissionChangeInProgress. PR Blockcast/paperclip#653.
# Bumped 2026-07-14 to 5f1d027 (BLO-15956): acknowledge the created Job name
# and UID before polling or cleanup. A missing/rejected acknowledgment deletes
# the Job and fails closed with k8s_job_identity_unacknowledged. PR
# kkroo/paperclip-adapter-claude-k8s#17; focused suite 86/86 and typecheck pass.
# Bumped 2026-07-14 for PEN-1305 PreToolUse env-guard (PR kkroo/paperclip-adapter-claude-k8s#18)
# Bumped 2026-07-14 to c10a12b (BLO-15957): prefer the server-owned runtime
# isolation descriptor, clone stateless review worktrees with an independent
# Git index, persist durable workspace sessions, and keep writable caches on
# the per-Job runtime-cache emptyDir. PR kkroo/paperclip-adapter-claude-k8s#19;
# typecheck, 422/422 tests, and build pass after rebasing onto the env guard.
# Bumped 2026-07-14 to 288f92a: bootstrap run-isolated jobs safely when a
# stateless review starts from the generic non-Git fallback workspace, and
# create the isolated pod-log parent before the pipefail/tee pipeline. PR
# kkroo/paperclip-adapter-claude-k8s#20; typecheck, 422/422 tests, and build pass.
# Bumped 2026-07-14 to 6b96224: terminate both run-isolation shell branches
# before their `else`/`fi` control keywords. PR
# kkroo/paperclip-adapter-claude-k8s#21; generated command parse-check,
# typecheck, 422/422 tests, and build pass.
# Bumped 2026-07-15 to d44eb4e: preserve Penstock's structured `resume_at`
# capacity hint as adapter `retryNotBefore`, avoiding blind 90-second retries.
# PR kkroo/paperclip-adapter-claude-k8s#22; typecheck and 425/425 tests pass.
# Bumped 2026-07-15 to ec788a7 (BLO-16219): set TMPDIR/TMP/TEMP to a
# tmpRoot sibling of homeRoot/sessionRoot/cacheRoot/workspaceRoot for run and
# workspace isolation modes — previously unset, so concurrent stateless Jobs
# shared the image's /tmp. Shared mode is unchanged. Pushed directly to
# kkroo/paperclip-adapter-claude-k8s master (PR creation unavailable to the
# GitHub App integration on this personal repo); typecheck and 426/426 tests
# pass.
# Bumped 2026-07-16 to e2bc983 (BLO-12558): emit isolated-start and
# concurrent-block decisions with isolation mode/key, task key, and session ID;
# fail closed on live Jobs with unknown isolation metadata; label server-owned
# shared descriptors for later guard decisions; keep telemetry non-fatal even
# if the metrics or log transport is unavailable; map legacy `isolated` labels
# to the bounded `workspace` mode. PR kkroo/paperclip-adapter-claude-k8s#23;
# typecheck, build, and 432/432 tests pass.
ARG CLAUDE_K8S_REF=e2bc98321155d857ac3ee545ff2952c3dd4a6617
# Re-pinned 2026-06-14 to kkroo/paperclip-adapter-opencode-k8s master a533d11
# (was 168688e): BLO-10448 — a transient k8s status-read error during the
# completion poll was mislabeled as a deadline, surfacing as the bogus
# "Timed out after 0s" and discarding finished (exit 0) runs (dropped PR
# reviews on the Ally path). PR kkroo/paperclip-adapter-opencode-k8s#23;
# also picks up #22 (BLO-10315 shared-docs symlink, already merged upstream).
# Re-pinned 2026-06-16 (BLO-10651) to 82c3cb2: reconciled type-crash
# classification + 5-strike adapter crashloop circuit-breaker, so a gpt-5.5
# response item missing `type` no longer crashlooped every OpenCode agent.
# Bumped 2026-06-16 (BLO-10651) to e38117b: pin agent runtime caches under the
# writable home (/paperclip/.runtime-cache) instead of inheriting the server's
# /runtime-cache mount, which agent pods don't mount — opencode agents whose
# adapterConfig.env lacked cache overrides were crashing at startup with
# EACCES mkdir '/runtime-cache' (adapter_failed). Makes per-agent cache env
# overrides redundant belt-and-suspenders.
# Bumped 2026-06-16 (PEN-906) to f1ec78b: a clean opencode run (final answer +
# step_finish reason=stop) is no longer marked adapter_failed just because an
# in-session tool call errored (e.g. a `read` on a missing /docs/*-template.md).
# Stops discarding completed work and re-billing redundant retries.
# Bumped 2026-06-16 to 5d43c07: preserve headers when translating Claude-style
# remote MCP entries into OpenCode config, so Bearer-protected gbrain connects.
# Bumped 2026-06-17 to 4b19530 (master tip): BLO-10448 — recover the failed
# pod's container stderr (one-shot non-follow log read, retries the previous
# instance) and fold it into the run error, so the opaque "Pod exited: Error
# (exit 1)" self-explains instead of needing a kubectl trip. PR
# kkroo/paperclip-adapter-opencode-k8s#27; the pin was 2 behind tip so this
# also picks up #26 (5d43c07 was the pre-merge sha; #26 merged at 09083e1).
# Bumped 2026-06-19 to 861227d (master tip): PEN-389 — mount a per-agent
# /runtime-cache emptyDir in opencode_k8s Jobs and keep regenerable XDG/Go/npm/
# Bun/pip/Playwright/TMPDIR caches there instead of on the shared /paperclip
# PVC. Also redirects Chrome BrowserMetrics to that emptyDir. PR
# kkroo/paperclip-adapter-opencode-k8s#29; local adapter verification passed
# job-manifest tests, typecheck, and build.
# Bumped 2026-06-19 to 42d2d99: reserve the runtime-cache env keys after
# adapterConfig.env merging, so stale /paperclip/.runtime-cache overrides cannot
# move regenerable caches back onto the shared PVC. PR
# kkroo/paperclip-adapter-opencode-k8s#30; local adapter verification passed
# job-manifest tests, typecheck, and build.
# Bumped 2026-06-21 to ce9b7b8: split the opencode pod schedule wait from the
# post-schedule container startup wait. Slow init containers no longer consume
# the 120s scheduler timeout and report as bogus "pod scheduling failed";
# scheduled pods get a bounded 10m startup window instead. Local adapter
# verification: execute.test.ts (101 tests) and typecheck passed.
# Bumped 2026-06-21 to 33794ca: reset the per-agent opencode.db when the
# vendored opencode binary is upgraded. A DB built by an older opencode can
# carry a schema the current binary's insert path violates — observed live on
# the Blockcast MulticastEngineer agent as `NOT NULL constraint failed:
# session_message.seq` at SessionPrompt.createUserMessage, which bricked EVERY
# run with a generic "Unexpected server error / UnknownError" thrown before any
# model call (model/ccrotate/shim all probed healthy). Best-effort,
# version-stamped, idempotent reset; never wipes a DB matching the current
# binary, never fails the run. PR kkroo/paperclip-adapter-opencode-k8s#31;
# 33794ca's parent is ce9b7b8 (no regress). Local adapter verification:
# job-manifest.test.ts (102 tests) and typecheck passed.
# Bumped 2026-06-22 to b5b99fd (v0.2.5): no-task workspace_subpath runs now
# use ephemeral emptyDir DB storage instead of a shared _no_task_ DB, while
# issue-scoped runs keep durable DBs. Also resets DB/WAL/SHM when combined
# size exceeds 500 MiB. PR kkroo/paperclip-adapter-opencode-k8s#32; local
# adapter verification passed focused tests, typecheck, build, and full tests.
# Bumped 2026-06-23 to 54426c9: set provider.openai.options.chunkTimeout=240s on
# both opencode config paths so slow gpt-5.5 reasoning streams aren't aborted
# mid-chunk. The default inter-chunk idle guard fired on long reasoning gaps as
# `API Error: Stream idle timeout - partial response`, persisting TRUNCATED
# assistant turns (issue descriptions cut mid-sentence) that then mirrored to
# Linear and read as a "sync clipped my body" bug. 240s sits just under the
# /responses shim's 255s Bun socket idle. PR
# kkroo/paperclip-adapter-opencode-k8s#33; 54426c9's parent is b5b99fd (no
# regress). Local adapter verification: job-manifest.test.ts (new chunkTimeout
# tests, red->green), full suite 494/494, and typecheck passed.
# Bumped 2026-06-23 to b405f5b: enforce the BLO-3494 monthly budget cap before
# creating opencode_k8s Kubernetes Jobs. Over-cap agents now fail fast with
# errorCode=budget_exceeded, best-effort pause metadata, and an escalation
# comment instead of continuing to spend past the cap. PR
# kkroo/paperclip-adapter-opencode-k8s#34; local adapter verification passed
# focused budget test, execute.test.ts (104/104), full suite 495/495,
# typecheck, and git diff --check.
# Bumped 2026-07-01 to 50d2af9: use model-aware proactive compact thresholds
# instead of a fixed 90k token gate, expose adapterConfig.compactThreshold for
# operator override, and request opencode_k8s session management instead of the
# opencode_local policy. PR kkroo/paperclip-adapter-opencode-k8s#36; local
# adapter verification passed focused tests, typecheck, and build.
# Bumped 2026-07-02 to 5dae60d: stamp per-agent `x-penstock-session: agent:<name>`
# on both opencode provider configs (anthropic + openai options.headers) so each
# Paperclip agent shows as its own live session entry on the org_penstock
# consumption dashboard instead of the whole fleet melting into one UNTAGGED
# bucket (Penstock's client-session extraction gives the header top precedence).
# Also repairs pre-existing breakage: master didn't typecheck (skills.ts read
# undeclared required/requiredReason fields) and 2 skill-bundle tests never
# passed — required-by-Paperclip skills now bundle unconditionally via
# forward-compat reads. PR kkroo/paperclip-adapter-opencode-k8s#37; local
# adapter verification: typecheck clean, full suite 503/503, build clean.
#
# Bumped 2026-07-08 to e7288de5: reserve opencode XDG config/data/state onto the
# writable /runtime-cache emptyDir (BLO-14003). The reserved-cache env map only
# pinned XDG_CACHE_HOME; the other three fell through to an unwritable
# /runtime-config, so opencode crashed at boot with EACCES mkdir '/runtime-config'
# and every opencode_k8s agent flipped to error (claude_k8s unaffected — shares
# the image but never hits the opencode codepath). Values are byte-identical to
# the per-agent adapterConfig.env stopgap that booted clean. PR
# kkroo/paperclip-adapter-opencode-k8s#38; local adapter verification: typecheck
# clean, job-manifest suite 112/112.
#
# Bumped 2026-07-08 to 30466007: opencode config/auth writers respect XDG_* —
# configSetup + authBootstrap now write to ${XDG_CONFIG_HOME:-$HOME/.config} and
# ${XDG_DATA_HOME:-$HOME/.local/share} instead of hardcoded HOME dirs, so a future
# no-MCP or chatgpt-oauth opencode agent's config/auth writer agrees with
# opencode's XDG reader (follow-up to #38; inert for current MCP+api-key agents).
# PR kkroo/paperclip-adapter-opencode-k8s#39; local adapter verification: typecheck
# clean, job-manifest suite 112/112, bash syntax + resolution checked.
#
# Bumped 2026-07-11 to 64c327d0: disable opencode's turn-zero workspace
# snapshot (BLO-14758). opencode's `git add --all --sparse` of the whole work
# tree into a shadow snapshot store was pegging a core in uninterruptible
# disk I/O for 20-30+ min against large/cold agent workspace dirs before the
# first LLM turn ran — observed live via `ps` (STAT=Ds) on a run that produced
# zero opencode output for 33 minutes. Sets `snapshot: false` in both opencode
# config paths (buildRuntimeConfigJson's default opencode.json and the
# MCP-path OPENCODE_CONFIG_JSON literal; opencode doesn't merge config
# sources). PR kkroo/paperclip-adapter-opencode-k8s#42; typecheck clean, full
# suite 515/515 pass (2 new tests), build clean.
# Bumped 2026-07-13 to 010f0e7e (BLO-15896): omit pod-level fsGroup from
# opencode_k8s Jobs. The container's primary runAsGroup=1000 and DinD's explicit
# socket group preserve access without asking kubelet to recursively chown the
# shared paperclip-data CephFS PVC. Manifest suite 113/113, typecheck, and build
# passed; live concurrent shared-PVC pods reached Ready without
# VolumePermissionChangeInProgress. PR Blockcast/paperclip#653.
# Bumped 2026-07-14 to 0a84868 (BLO-15956): acknowledge the created Job name
# and UID before polling or cleanup. A missing/rejected acknowledgment deletes
# the Job and fails closed with k8s_job_identity_unacknowledged. PR
# kkroo/paperclip-adapter-opencode-k8s#43; focused suite 114/114 and typecheck pass.
# Bumped 2026-07-14 for PEN-1305 permission.bash env-dump deny (PR kkroo/paperclip-adapter-opencode-k8s#44)
# Bumped 2026-07-14 to dfd13f2 (BLO-15957): consume typed run/workspace
# isolation, separate persistent XDG/session state from ephemeral build caches,
# force stateless OpenCode DBs onto emptyDir, and key durable DBs by workspace.
# PR kkroo/paperclip-adapter-opencode-k8s#45; typecheck, 523/523 tests, and
# build pass after rebasing onto the env-dump deny.
# Bumped 2026-07-15 to 4aca4ad (BLO-16219): fold in the previously
# build-time-patched run-isolation working-dir fix (now pushed directly to
# kkroo/paperclip-adapter-opencode-k8s master — the separate build-time patch
# file + git-apply step formerly below are retired) and set TMPDIR/TMP/TEMP
# to a new tmpRoot sibling of homeRoot/sessionRoot/cacheRoot/workspaceRoot
# for run and workspace isolation modes. Shared mode is unchanged. typecheck
# and 524/524 tests pass, build clean.
# Bumped 2026-07-16 to f4ca4a6 (#46): default reattachOrphanedJobs=true so a
# same-task opencode Job orphaned by a paperclip-0 restart is reattached
# (stream + await) instead of failing new runs with k8s_concurrent_run_blocked
# (observed: Players-Engineer run 8d35d883 blocked after a paperclip-0 restart).
# PR kkroo/paperclip-adapter-opencode-k8s#46; adapter suite 118/118, typecheck clean.
# Bumped 2026-07-20 to ad549a0 (#47): run isolation now detects the generic
# non-Git fallback workspace and creates a private empty run workspace instead
# of exiting before OpenCode starts. Real Git checkouts still use independent
# shared-object clones. Full adapter suite 526/526, focused manifest suite
# 119/119, typecheck, and build pass.
# Bumped 2026-07-20 to 239f2e1 (#48):
# bound the pre-Job live-Job list to 15 seconds and fail closed when Kubernetes
# does not answer. Focused suite 13/13, full adapter suite 527/527, typecheck,
# and build pass.
ARG OPENCODE_K8S_REF=239f2e1a3e27344e154600fae7ba668c13b36a5d

# Pack paperclip's in-tree adapter-utils so the bundled adapters consume
# the workspace version (may include exports newer than the latest
# npm-published canary). Source is pulled from the `deps` stage rather
# than the build context — local pnpm leaves a node_modules symlink in
# packages/adapter-utils that targets the workspace's .pnpm store outside
# the build context, and BuildKit's cache-key walker follows it and
# fails with `short read: unexpected EOF` even when .dockerignore
# excludes node_modules. The deps stage already has properly-resolved
# node_modules baked into its image layer.
# Source from the build context (the deps stage only has package.json,
# not src/ — pnpm install doesn't materialize source). The CI workflow
# nukes stale node_modules pre-build (.github/workflows/docker.yml) and
# .dockerignore excludes **/node_modules; local builds use a git-archive
# context that has no node_modules at all. Either way, BuildKit doesn't
# trip on the pnpm symlinks during context walk.
#
# `npm install --no-save` gets a freestanding copy of typescript, and
# the printf rewrites tsconfig.json to a self-contained version (the
# original extends `../../tsconfig.base.json`, which doesn't resolve
# here since we only copied the package, not the monorepo).
COPY packages/adapter-utils /vendor/adapter-utils-src
RUN cd /vendor/adapter-utils-src \
  && rm -rf node_modules \
  && printf '%s\n' '{' \
       '  "compilerOptions": {' \
       '    "target": "ES2023",' \
       '    "module": "NodeNext",' \
       '    "moduleResolution": "NodeNext",' \
       '    "esModuleInterop": true,' \
       '    "strict": true,' \
       '    "skipLibCheck": true,' \
       '    "declaration": true,' \
       '    "declarationMap": true,' \
       '    "sourceMap": true,' \
       '    "outDir": "dist",' \
       '    "rootDir": "src",' \
       '    "forceConsistentCasingInFileNames": true,' \
       '    "resolveJsonModule": true,' \
       '    "isolatedModules": true' \
       '  },' \
       '  "include": ["src"],' \
       '  "exclude": ["**/*.test.ts"]' \
       '}' > tsconfig.json \
  && npm install --no-save --cache /root/.npm typescript@^5.7.3 @types/node@^24.6.0 \
  && npx tsc \
  && node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(!p.publishConfig||!p.publishConfig.exports){console.error('FATAL: package.json missing publishConfig.exports — cannot rewrite for npm pack');process.exit(1);}Object.assign(p,p.publishConfig);delete p.publishConfig.exports;delete p.publishConfig.main;delete p.publishConfig.types;if(typeof p.exports!=='object'||!p.exports['.']||!p.exports['./*']){console.error('FATAL: rewritten exports missing required entries (./* and .)',p.exports);process.exit(1);}fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
  && npm pack \
  && mv paperclipai-adapter-utils-*.tgz /vendor/adapter-utils.tgz \
  && rm -rf /vendor/adapter-utils-src

# Vendor-stage installs benefit from cache mounts too: pinned REFs mean
# the layer invalidates only on bumps, but inside each invalidated
# rebuild we still re-resolve every transitive dep. The pnpm and npm
# caches let those resolutions reuse tarballs from prior builds.

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=secret,id=gh_token \
    GH="$(cat /run/secrets/gh_token)" \
 && git -c "url.https://x-access-token:${GH}@github.com/.insteadOf=https://github.com/" \
      clone https://github.com/kkroo/paperclip-adapter-claude-k8s.git claude-k8s \
  && cd claude-k8s && git checkout "${CLAUDE_K8S_REF}" && rm -rf .git \
  && npm ci \
  && npm install --no-save /vendor/adapter-utils.tgz \
  && npm run build \
  && npm pack \
  && mv paperclip-adapter-claude-k8s-*.tgz /vendor/paperclip-adapter-claude-k8s.tgz

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=secret,id=gh_token \
    GH="$(cat /run/secrets/gh_token)" \
 && git -c "url.https://x-access-token:${GH}@github.com/.insteadOf=https://github.com/" \
      clone https://github.com/kkroo/paperclip-adapter-opencode-k8s.git opencode-k8s \
  && cd opencode-k8s && git checkout "${OPENCODE_K8S_REF}" \
  && rm -rf .git \
  && npm ci \
  && npm install --no-save /vendor/adapter-utils.tgz \
  && npm run build \
  && npm pack \
  && mv paperclip-adapter-opencode-k8s-*.tgz /vendor/paperclip-adapter-opencode-k8s.tgz

# github-mcp-server: official Go binary for GitHub's MCP server. We bundle
# it in the image so claude can spawn it as a stdio MCP, which sidesteps
# the per-request Authorization header dance the http transport requires
# (the binary reads GITHUB_PERSONAL_ACCESS_TOKEN from env at startup).
# Pin to a release tag — bump deliberately, not via :latest.
FROM ghcr.io/github/github-mcp-server:v1.0.3 AS github-mcp

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/plugin-sdk build
# The UI is the longest independent build. Run it beside the server/plugin
# chain while keeping that chain serial to avoid a large memory spike on ARC.
RUN set -eu; \
  pnpm --filter @paperclipai/ui build & ui_pid=$!; \
  pnpm --filter @kkroo/paperclip-plugin-gbrain build; \
  pnpm --filter @kkroo/paperclip-plugin-linear build; \
  pnpm --filter paperclip-plugin-alertmanager build; \
  pnpm --filter paperclip-plugin-slack build; \
  pnpm --filter @paperclipai/mcp-server build; \
  pnpm --filter @paperclipai/server build; \
  wait "$ui_pid"
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
# The seed-init in the helm chart looks for this file to decide whether
# to write /paperclip/.mcp.json. Fail the build if it's missing instead
# of silently shipping an image where the seed quietly skips.
RUN test -f packages/mcp-server/dist/stdio.js || (echo "ERROR: mcp-server stdio bridge missing" && exit 1)

FROM ${RUNTIME_IMAGE} AS production
# Preserve the documented local-build defaults. docker-entrypoint.sh compares
# these values with the inherited passwd entry and remaps node at startup when
# a caller supplies custom USER_UID/USER_GID build args.
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
# The kkroo forks of paperclip-adapter-claude-k8s /
# paperclip-adapter-opencode-k8s are built from source in the `vendor` stage
# above and installed here.
#
# Do not install a local ccrotate CLI in this image. Paperclip production uses
# ccrotate-auth-bot / ccrotate-serve as the source of truth; a baked local
# rotator can read stale PVC state and switch agents onto exhausted accounts.
# Refresh procedure:
#   1. push the relevant kkroo fork branch (kkroo/paperclip-adapter-claude-k8s#master,
#      kkroo/paperclip-adapter-opencode-k8s#master)
#   2. bump the *_REF ARG in the `vendor` stage
RUN mkdir -p /tmp/paperclip-bundled-adapters
COPY --from=vendor /vendor/paperclip-adapter-claude-k8s.tgz /tmp/paperclip-bundled-adapters/
COPY --from=vendor /vendor/paperclip-adapter-opencode-k8s.tgz /tmp/paperclip-bundled-adapters/
# Bundle the in-tree adapter-utils alongside the adapter tgzs so the
# `npm install` below resolves `@paperclipai/adapter-utils` from local source
# (matching what the adapter built against in the vendor stage) instead of
# falling back to whatever npm publishes today.
COPY --from=vendor /vendor/adapter-utils.tgz /tmp/paperclip-bundled-adapters/
COPY --from=github-mcp /server/github-mcp-server /usr/local/bin/github-mcp-server
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm install --prefix /opt/paperclip-bundled-adapters --omit=dev --no-save --legacy-peer-deps --cache /root/.npm /tmp/paperclip-bundled-adapters/*.tgz \
  && rm -rf /tmp/paperclip-bundled-adapters \
  && chown -R node:node /opt/paperclip-bundled-adapters

# Keep dependency trees in their own stable layer. Ordinary source edits only
# replace the much smaller source/compiled payload and do not re-upload pnpm's
# node_modules tree as part of every per-commit image.
COPY --chown=node:node --from=deps /app /app
COPY --chown=node:node --from=build --exclude=node_modules --exclude=**/node_modules /app /app

ENV USER_UID=${USER_UID} USER_GID=${USER_GID}

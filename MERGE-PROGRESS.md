# Merge progress: paperclipai/paperclip v2026.513.0 → Blockcast/paperclip master

Branch: omar/merge-upstream-v2026.513.0
Started: 2026-05-13 ~23:30Z
Merge-base: 3494e84a (= canary/v2026.428.0-canary.5)
Total conflicts at start: 50

## Resolved (7 files)
- [x] Cat 1: Migrations
  - packages/db/src/migrations/meta/_journal.json (all 98 entries idx 0-97; upstream renumbered to 0088-0097)
  - 10 upstream migration files renamed: 0075→0088, 0076→0089, 0079→0090, 0080→0091, 0077→0092, 0078→0093, 0081→0094, 0082→0095, 0083→0096, 0084→0097
  - 4 upstream snapshot files renamed correspondingly
- [x] Cat 2: Build/packaging
  - Dockerfile: kept all kkroo plugins (ccrotate, linear, alertmanager, slack, mcp-gateway) AND upstream's new ones (cursor-cloud, acpx-local, plugin-llm-wiki)
  - .github/workflows/docker.yml: kept kkroo's `self-hosted` runner, upgraded timeout to upstream's 60min
  - server/package.json: combined deps (kkroo's @kubernetes/client-node + upstream's new adapters)
  - pnpm-lock.yaml: took --theirs (upstream's); regenerate via `pnpm install` post-merge
- [x] Cat 6: Shared types/validators (2 files)
  - packages/shared/src/types/issue.ts: kept both kkroo's `lastEvidenceVerdict` (evidence gate) AND upstream's new fields (`activeRecoveryAction`, `successfulRunHandoff`, `scheduledRetry`)
  - packages/shared/src/validators/agent.ts: merged kkroo's `runtimeConfigSchema` (heartbeat) into upstream's `agentRuntimeConfigSchema` (modelProfiles.cheap); kept upstream's name since it's re-exported

## Pending (43 files)
- [ ] Plugins SDK: host-client-factory.ts, testing.ts, worker-rpc-host.ts (3)
- [ ] Adapter-utils: execution-target.ts, index.ts, ssh.ts, ssh-fixture.test.ts (4)
- [ ] Adapters: claude/codex/cursor/gemini/opencode/pi-local execute/test (8)
- [ ] Server core: middleware/auth, routes/activity/agents/issues, services/environment-runtime/heartbeat/issues/plugin-host-services/plugin-loader/productivity-review, services/recovery/issue-graph-liveness/service, types/express.d.ts (12)
- [ ] Tests: agent-permissions-routes, heartbeat-issue-liveness-escalation, heartbeat-process-recovery, heartbeat-stale-queue-invalidation, issues-service, productivity-review-service (6)
- [ ] UI: api/agents, components/ActiveAgentsPanel + AgentConfigForm + CompanyRail (delete/modify) + NewIssueDialog + SidebarAgents + SidebarProjects, lib/company-routes, pages/CompanySettings (10)

## Resolution notes
- ccrotate-state.ts NOT in conflict list — markAccountExhausted patch survives clean
- CompanyRail.tsx deleted upstream; kkroo modification needs assessment (likely the rail-rewrite replaces it cleanly elsewhere)
- kkroo's evidence-gate-wiring must layer above upstream's PR #5292 review-path checks (TBD how they interact)

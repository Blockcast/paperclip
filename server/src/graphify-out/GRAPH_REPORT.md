# Graph Report - src  (2026-11-15)

## Corpus Check
- 1444 files · ~4,197,891 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 18322 nodes · 45597 edges · 583 communities (505 shown, 78 omitted from the detail section)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 1218 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3e708214`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- errorHandler
- costs-service.test.ts
- logActivity
- issueRoutes
- gc-flags-metrics.ts
- services/company-skills.ts
- services/pipelines.ts
- routes/issues.ts
- services/built-in-agents.ts
- issue-dependency-wakeups-routes.test.ts
- workspace-runtime.ts
- services/plugin-loader.ts
- github-webhook.ts
- routes/pipelines.ts
- cleanup-heartbeat-test-state.ts
- k8s-job-liveness.ts
- issue-rewake-throttle.ts
- services/tool-gateway.ts
- services/tool-access.ts
- routes/access.ts
- executeRun
- PluginWorkerManager
- heartbeatService
- productivity-review.ts
- services/teams-catalog.ts
- plugins.ts
- environment-config.ts
- evidence-gate.ts
- middleware/auth.ts
- cloud-upstreams.test.ts
- toolAccessService
- registry.ts
- tool-access-policy.ts
- recovery/index.ts
- services/attention.ts
- cases.ts
- startServer
- recoveryService
- environment-custom-images.ts
- feedback.ts
- metrics.ts
- workspace-file-resources.ts
- openapi.ts
- skills-catalog.ts
- github-app-auth.ts
- services/routines.ts
- agent-adapter-validation-routes.test.ts
- effective-run-config-fingerprints.ts
- readNonEmptyString
- penstock-availability-gate.ts
- authorization.ts
- runStrandedAssignedIssueSweep
- execution-workspace-cleanup.ts
- tool-gateway.test.ts
- reapOrphanedRuns
- issue-agent-mutation-ownership-routes.test.ts
- redaction.ts
- adapters.ts
- folderService
- services/execution-workspaces.ts
- services/issue-tree-control.ts
- better-auth.ts
- environment-runtime.ts
- storage/types.ts
- issue-attachment-routes.test.ts
- createPluginJobScheduler
- plugin-database.ts
- local-service-supervisor.ts
- services/projects.ts
- org-chart-svg.ts
- environment-run-orchestrator.ts
- issue-thread-interactions.ts
- plugin-host-services.ts
- run-liveness.ts
- services/cloud-upstreams.ts
- agentService
- company-search.ts
- task-watchdogs.ts
- git-worktree-ownership.ts
- services/smoke-lab.ts
- workspace-runtime.test.ts
- heartbeat-process-recovery.test.ts
- worktree-config.ts
- index.ts
- pluginManagedRoutineService
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- __resetMetricsForTest
- config.ts
- normalizePortablePath
- recovery/service.ts
- agent-instructions.ts
- issue-checkout-status.ts
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- aws-secrets-manager-provider.ts
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe.ts
- agent-redaction.ts
- logger.ts
- plugin-worker-manager.ts
- sweep-wake-preflight.ts
- issue-execution-policy-routes.test.ts
- tool-content-guards.ts
- budgetService
- external-objects.ts
- environment-routes.test.ts
- services/dashboard.ts
- identifier-allocator.ts
- issue-execution-policy.ts
- scrape-metrics-collector.ts
- ui-branding.ts
- agent-cross-tenant-authz-routes.test.ts
- agent-permissions-routes.test.ts
- heartbeat-workspace-branch-containment.test.ts
- activity-log.ts
- company-artifacts.ts
- productivityReviewService
- plugin-config-masking.ts
- tool-oauth-legacy-backfill.ts
- api-compression.ts
- github-review-gate-authority.ts
- live-events-ws.ts
- plugin-tool-dispatcher.ts
- source-trust.ts
- issue-continuation-summary.ts
- run-log-store.ts
- github-status-delivery-outbox.ts
- opencode-k8s-seed-transport.test.ts
- utils.ts
- server-info.ts
- low-trust-red-team-routes.test.ts
- environmentService
- issue-pull-requests.ts
- issues-service.test.ts
- getMetricsRegistry
- trust-preset-resolver.ts
- agent-skills-routes.test.ts
- issues-goal-context-routes.test.ts
- accessService
- isolation-reclaim-driver.test.ts
- heartbeat-run-runtime-status.ts
- asString
- synthetic-ssh-probe.ts
- environment-custom-image-terminal-ws.test.ts
- issue-efficiency.ts
- issueService
- successful-run-handoff.ts
- companies-route-cross-company-authz.test.ts
- version.ts
- human-gated-ageing.ts
- environmentCustomImageTerminalConnectionRegistry
- worker-tier-proxy.ts
- result
- routes/agents.ts
- pr-comment-review-gate.ts
- instanceSettingsService
- recovery-observability.ts
- agent-secret-redaction.test.ts
- db-retry.ts
- authorizationService
- human-gated-ageing-digest.ts
- listBlockedInboxIssues
- adapters/index.ts
- ac-policy-assignee-routing.ts
- company-portability-routes.test.ts
- company-issue-identity-guard.test.ts
- environment-custom-image-routes.test.ts
- log-redaction.ts
- summary-slots.test.ts
- company-search-extract.ts
- plugin-dev-watcher.ts
- createToolRuntimeSupervisor
- git-checkout-identity.ts
- FakeRuntime
- human-gated-gate-revalidation.ts
- native-memory-metrics.ts
- issue-comment-cancel-routes.test.ts
- cursor-models.ts
- health.ts
- bootstrap-claim-routes.test.ts
- work-timeline.ts
- agent-invokability.ts
- pipelineService
- issue-recovery-actions.ts
- github-write-egress-scrub.test.ts
- issue-workspace-command-authz.test.ts
- reconcileStrandedRecoveryWakeBackstopImpl
- heap-snapshot.ts
- heartbeat-stop-metadata.ts
- remote-http-endpoint-guard.ts
- run-scratch.ts
- pr-review-duplicate-issue-guard.ts
- adapter-model-refresh-routes.test.ts
- agent-instructions-routes.test.ts
- issue-feedback-routes.test.ts
- parseIssueExecutionState
- issue-recovery-actions.test.ts
- heartbeat-run-scoped-job-liveness-dispatch.test.ts
- execution-policy-bootstrap.ts
- body
- gbrain-client-factory.ts
- notFound
- issue-list-truncation-signal.test.ts
- agent-model-registry-validation.test.ts
- cgroup-memory-metrics.test.ts
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- issue-list-timeout-explain.ts
- dev-server-status.ts
- openapi-routes.test.ts
- sweep-wake-preflight.test.ts
- execution-allowlist.ts
- visibleIssueCondition
- ensureRegistry
- project-checkout-origin-reconciler.ts
- documents.ts
- isolation-workspace-reaper.ts
- redactAgentConfigPayload
- recovery-stranded-attendance-batch.test.ts
- environment-custom-image-terminal-sessions.ts
- normalizeIssueExecutionPolicy
- plugin-managed-agents.ts
- plugin-managed-skills.ts
- execution-workspace-per-run-isolation.test.ts
- approval-routes-idempotency.test.ts
- approval-withdraw-routes.test.ts
- company-portability.test.ts
- docker-opencode-runtime-pin.test.ts
- done-gate-durable-artifact.test.ts
- environment-selection-route-guards.test.ts
- isolation-reclaim-job.ts
- routines-routes.test.ts
- approval-gate-reconciler.ts
- stranded-blocked-issue-reconciler.ts
- buildOpenApiDocument
- routes/projects.ts
- runtime-api.ts
- pluginRegistryService
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- deriveSkillExportDirCandidates
- accepted-interaction-outcome-sweep.ts
- scheduler-lease.ts
- pr-review-state-reconciler.ts
- agent-test-environment-routes.test.ts
- document-annotation-routes.test.ts
- external-object-routes.test.ts
- issue-activity-events-routes.test.ts
- isPlainRecord
- middleware/index.ts
- project-goal-telemetry-routes.test.ts
- routine-document-annotation-routes.test.ts
- summary-slot-routes.test.ts
- ccrotate-state-hook.ts
- exportBundle
- plugin-secrets-handler.ts
- workspace-response-withholding-guard.test.ts
- workspace-reuse-refusal-class.ts
- branch-run-claims.ts
- http-metrics-transient-db-sqlstate.test.ts
- dev-runner-snapshot.test.ts
- company-branding-route.test.ts
- badRequest
- issue-comment-effects.ts
- invite-accept-existing-member.test.ts
- issue-closed-workspace-routes.test.ts
- project-routes-env.test.ts
- model-profile-hint.ts
- plugin-metric-exposition.test.ts
- issue-repo-binding-guard.ts
- terminal-gate-reconciler.ts
- cases-routes.test.ts
- routes/approvals.ts
- workspace-dir-claim.ts
- agent-run-health.ts
- managed-checkout-push-guard.ts
- agent-inbox-lite.ts
- approvals-service.test.ts
- approval-payload-edit-routes.test.ts
- companyPortabilityService
- issue-wake-diagnostics-routes.test.ts
- environmentRoutes
- heartbeat-timer-suppression-park-bypass.test.ts
- summarySlotService
- agent-hires-instructions-materialize.test.ts
- github-api-refusal-metric.test.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- agent-scope-pinned-config-keys-routes.test.ts
- run-secret-redaction.ts
- agent-live-run-routes.test.ts
- instrumentation.ts
- http-log-policy.ts
- redact-sensitive.ts
- issue-blocker-diagnostics-routes.test.ts
- managed-checkout-partial-clone.ts
- ccrotate-capacity-retry.ts
- zoned-cron.ts
- asNumber
- zero-token-startup-failure.ts
- builtInAgentService
- cpu-profile.ts
- recovery-stale-issue-lock-sweep.test.ts
- plugin-event-bus.ts
- process-loss-classification.ts
- issue-update-comment-wakeup-routes.test.ts
- isolation-reclaim-self.ts
- config
- evidence-truth.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- pod-log-sweeper.ts
- heartbeat-zombie-guard.test.ts
- agent-shell-guard.ts
- attachment-types.ts
- services/index.ts
- zodToOpenApiSchema
- openrouter/execute.ts
- company-export-readme.ts
- environment-capabilities-k8s.test.ts
- collectEvidence
- lifecycle-hook-command-audit.ts
- fd-class-metrics.ts
- boardAuthService
- pluginCapabilityValidator
- pen3142-live-event-transcript-scope.test.ts
- orphaned-run-terminal-result.ts
- setupEnvironmentCustomImageTerminalWebSocketServer
- setup-supertest.ts
- teams-catalog-routes.test.ts
- strand-comment-provider-capacity.test.ts
- approval-queue-metrics.test.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- gbrain-client-factory.test.ts
- zoned-cron-equivalence.test.ts
- pen3142-run-transcript-scope.test.ts
- routines-service.test.ts
- successful-run-handoff-state.ts
- agent-pinned-config-keys-survive-heartbeat-mock.test.ts
- __tests__/evidence-gate.test.ts
- cli-auth-routes.test.ts
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- heartbeat-issue-liveness-escalation.test.ts
- pipeline-case-outputs.ts
- foreign-commit-notice.ts
- issue-comment-effect-outbox-routes.test.ts
- pipelines-service.test.ts
- issue-liveness.test.ts
- approval-create-issue-link-authorization.test.ts
- pull-request-work-products.ts
- linear-webhook.test.ts
- approval-link-requested-by-self.test.ts
- dev-watch-ignore.ts
- getActiveSession
- approval-link-route-equivalence.test.ts
- applyDocumentFixups
- run-log-store.test.ts
- agent-profile-change-gate-mixing.test.ts
- approval-agent-config-authz-routes.test.ts
- done-gate.ts
- heartbeat-stale-queue-invalidation.test.ts
- plugin-config-write-race.test.ts
- authorization-service.test.ts
- routine-fire-gap-metrics.test.ts
- routine-scheduler-heartbeat.ts
- plugin-environment-driver.ts
- agent-budget-mirror-write.test.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- issue-comment-unkeyed-outbox-routes.test.ts
- claude-code-version.test.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- file
- agent-hire-source-issue-authorization.test.ts
- workspace-dir-claims.ts
- issue-monitor-scheduler.test.ts
- key
- taskWatchdogService
- readPenstockCapacity
- chain-pass-timing.ts
- HEARTBEAT.md -- CEO Heartbeat Checklist
- requestApprovalForRecordedToolCall
- heartbeat-workspace-finalize-branch.test.ts
- createToolGatewayService
- PluginWorkerHandle
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- tool-access-service.test.ts
- documentAnnotationService
- SandboxProvider
- Ally — Consolidated PR Review
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- issue-runtime-service-command-masking.test.ts
- issue-list-assignee-filter-routes.test.ts
- isolation-reclaim-job-port.ts
- issueRecoveryActionService
- live-events.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- issue-tree-hold-metrics.ts
- blocked-inbox-count-list-parity.test.ts
- pipeline-stage-workspace-runtime-authz.test.ts
- dev-runner-worktree.ts
- ac-policy-sweep.ts
- scrape-metrics-collector.test.ts
- trust-proxy.ts
- backfill-agent-bundle.ts
- github-fetch.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- fetchIssueSearchData
- heartbeat-reviewer-evidence-live-head.test.ts
- plan-review-context.ts
- unprocessable
- plugin-activation-boot-retry.test.ts
- issue-stale-execution-lock-routes.test.ts
- plugin-manifest-validator.ts
- plugin-state-store.ts
- event-loop-stall-log.ts
- embedded-postgres.ts
- plugin-fencing.ts
- heartbeat-provider-capacity-horizon.test.ts
- pr-review-head-attestation.ts
- reserveLongActiveProductivityReviewIssue
- routes/decision-training.ts
- Ally — Consolidated PR Review
- human-gated-gate-revalidation-backfill.test.ts
- startup-filesystem-io.test.ts
- chain
- ceo/AGENTS.md
- EnvironmentCustomImageSshShell
- penstock-availability-gate.test.ts
- Ally — Consolidated PR Review
- companySkillService
- workspace-dir-claims-route.test.ts
- pod-failure-label-corpus.test.ts
- issue-telemetry-routes.test.ts
- renderYamlBlock
- assertAssignableAgent
- plugin-worker-invocation-scope.cjs
- billing-classification.ts
- approval-gate-reconciler.test.ts
- evidence-gate-wiring.ts
- startup-dispatch-isolation.test.ts
- reflection-coach/AGENTS.md
- Recent agent reflection sweep
- summarizer/AGENTS.md
- Refresh stale summary slots
- metrics-route-no-db.test.ts
- reviewer-wake-outcome-log-fields.test.ts
- SOUL.md -- CEO Persona
- Wake Pre-flight (do this FIRST when woken)
- app-plugin-takeover-resync.test.ts
- authz-existence-oracle-guard.test.ts
- plugin-worker-delayed.cjs
- plugin-worker-terminated.cjs
- unclaimable-queued-run-reap-postgres.test.ts
- issue-approvals-link-coverage-read-boundary.test.ts
- recovery-candidate-phase-timer-coverage.test.ts
- default/AGENTS.md
- recovery-pause-hold-guard-call-shape.test.ts
- express.d.ts
- TOOLS.md
- approval-payload-edit-service.test.ts
- approval-gate-already-terminal.test.ts
- heartbeat-accepted-plan-workspace-refresh.test.ts
- scrape-metrics-routine-fire-gap-work.test.ts
- heartbeat-ccrotate-capacity-retry.test.ts
- ws-upgrade-url-log-guard.test.ts
- activityService
- plugin-webhook-not-ready-retryable.test.ts
- environment-instance-routes.test.ts
- codex-models.ts
- plugin-orchestration-apis.test.ts
- workspace-scan.ts
- buildLocalUpstreamExportBundle
- classifyTaskWatchdogSubtree
- heartbeat-quota-recovery-wake-scope.test.ts
- ensureServerWorkspaceLinksCurrent
- agents-service-secret-bindings.test.ts
- home-paths.ts
- db-inherited-timeout-metric.test.ts
- recovery-chain-pass-timing-wiring.test.ts
- linear-auth.ts
- privateHostnameGuard
- stranded-sweep-budget.ts
- heartbeat-finalize-cancelled-skip-dispatch.test.ts
- workspace-operation-secret-scrub.test.ts
- collectClassifierInput
- healthz-probe-route.test.ts
- orphan-reap-per-run-sub-stage-audit.test.ts
- company-skills-catalog-service.test.ts
- github-webhook-dedicated-pool.test.ts
- issue-watchdogs-routes.test.ts
- issue-monitor-convergence-message.test.ts
- company-search-service.test.ts
- execution-policy-bootstrap.test.ts
- plugin-host-service-cleanup.ts
- buildRemoteHeaders
- issue-stable-enumeration-routes.test.ts
- task-watchdogs-scheduler.test.ts
- conflict
- responsible-user-denial-run-outcomes.ts
- agent-wakeup-target.ts
- EnvironmentRuntimeDriver
- routines-fire-gap-interval.test.ts
- upsertIssueWatchdogForIssue
- plugin-ui-static.test.ts
- recovery-manual-resolution-guidance-sites.test.ts
- work-product-external-id-write-canonicalization.test.ts
- TerminalWsSocket
- issueListRequestKey
- OAuthMintBearer
- inherited-workspace-reuse-failure-summary.test.ts
- issue-assignment-wakeup.ts
- issue-adoption-execution-agent-name-key.test.ts
- issue-checkout-routine-lock-conflict.test.ts
- issue-detail-workspace-runtime-withholding.test.ts
- issue-thread-interactions-telemetry.test.ts
- permissions-upgrade-boundary-routes.test.ts
- issue-thread-interactions.test.ts
- RunLogStore
- dispatch-cross-process-claim.test.ts
- heartbeat-cost-event-write-time-attribution.test.ts

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 641 edges
2. `issueRoutes()` - 390 edges
3. `unprocessable()` - 383 edges
4. `notFound()` - 340 edges
5. `issueService()` - 288 edges
6. `logActivity()` - 267 edges
7. `recoveryService()` - 262 edges
8. `executeRun()` - 249 edges
9. `parseObject` - 197 edges
10. `agentRoutes()` - 197 edges

## Surprising Connections (you probably didn't know these)
- `captureLiveEvents()` --calls--> `subscribeCompanyLiveEvents()`  [EXTRACTED]
  __tests__/activity-log-transactional-publish.test.ts → services/live-events.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes-authz.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-auth-middleware.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-budget-mirror-write.test.ts → middleware/error-handler.ts

## Import Cycles
- 2-file cycle: `services/issues.ts -> services/task-watchdogs.ts -> services/issues.ts`

## Communities (583 total, 78 omitted from the detail section)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (314): appendWithByteCap, agentScopeOnlyConfigKeyOverrides(), createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), describeGitFailure(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS (+306 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (142): STATEMENT_TIMEOUT_SQLSTATE, ParsedExecutionWorkspaceMode, resolvePinnedIssueWorkspaceStrategyType(), getDefaultCompanyGoal(), GoalReader, MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId() (+134 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.04
Nodes (64): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), bufferToPortableBinaryFile(), buildLegacyRoutineTriggerFromRecurrence(), collectSelectedExportSlugs() (+56 more)

### Community 3 - "errorHandler"
Cohesion: 0.03
Nodes (64): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), noteTransientDbResponse() (+56 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.13
Nodes (14): createApp(), createAppWithActor(), loadCostParsers(), makeDb(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyService (+6 more)

### Community 5 - "logActivity"
Cohesion: 0.03
Nodes (190): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), pluginStateFingerprint(), pluginStateSnapshot(), PRECOMPRESSED_STATIC_EXTENSIONS (+182 more)

### Community 6 - "issueRoutes"
Cohesion: 0.02
Nodes (133): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), authenticatedActorResponsibleUserId(), buildCreateIssueActivityStatusDetails(), buildExecutionStageWakeContext(), buildExecutionStageWakeup(), buildRequestItemVerdictsWakeIdempotencyKey(), classifyIssueMentionWake() (+125 more)

### Community 7 - "gc-flags-metrics.ts"
Cohesion: 0.05
Nodes (58): GC_CYCLES_METRIC, GC_FLAG_BITS, GC_FLAGS_NONE, GC_KIND_UNKNOWN, GC_KINDS, GcCycleClassCount, GcCycleWindow, GcEntryDetail (+50 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.04
Nodes (91): skillImportPolicyResource(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillKeyAllowed(), assertImportedSkillSourceAllowed(), assertNoSymlinksInLocalTree(), assertVersionMatchesSkill(), buildMissingLocalSourceMarker(), buildMissingRuntimeSourceDetail() (+83 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.04
Nodes (97): PIPELINE_STAGE_EXIT_CANCELLATION_REASON, actorOwnsLease(), addFormVariablesForStage(), adjustParentCounts(), assertActorCanApproveStageExit(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable() (+89 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (159): IssueApprovalLinkAuthorizationIssue, ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema, AutoApprovalIssueMissingError (+151 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.04
Nodes (61): reconcileApprovedBuiltInAgent(), BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), assertAdapterAllowed(), assertKnownBuiltInAgentModel() (+53 more)

### Community 12 - "issue-dependency-wakeups-routes.test.ts"
Cohesion: 0.20
Nodes (10): createApp(), mockDb, mockFindExistingIssueBlockersResolvedWake, mockIssueService, mockListBlockedDependentIssueIds, mockRecomputeBlockedIssuesStatusIfReady, mockTx, mockTxInsertValues (+2 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (116): applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), assertDirtyQuarantineRuntimeServicesStopped(), assertServerGitDoesNotPublish(), branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), buildWorkspaceTemplateData(), clampBranchBasePreservingIdentifier() (+108 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.03
Nodes (108): BUNDLED_PLUGIN_PACKAGES, isIsolatedSdkPluginPackage(), ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH (+100 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (194): acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody(), buildDependabotRefireComment() (+186 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (94): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertNoAgentStageConfigCommandMutation(), assertNoAgentStageConfigWorkspaceRuntimeMutation(), assertPipelineAccess() (+86 more)

### Community 17 - "cleanup-heartbeat-test-state.ts"
Cohesion: 0.03
Nodes (35): runningProcesses, _settleDetachedAgentStartLockWorkForTesting(), DEP_BLOCKED_RETRY_REASON, STARVATION_ABSOLUTE_ESCALATION_MS, STARVATION_FULL_ESCALATION_MS, numberFromEnv(), parseCpuQuantityToMillicores(), mockAdapterExecute (+27 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.04
Nodes (69): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+61 more)

### Community 19 - "issue-rewake-throttle.ts"
Cohesion: 0.12
Nodes (21): computeIssueRewakeCooldownMs(), evaluateIssueRewakeThrottle(), isIssueRewakeNewInputActivity(), isIssueRewakeProgressActivity(), ISSUE_COMMENT_ADDED_ACTION, ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS, ISSUE_PROGRESS_ACTIVITY_ACTION_SET (+13 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (42): AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview(), BUILTIN_LOCAL_STDIO_RUNTIME_TEMPLATES, BUILTIN_TOOLS, ConnectedCredentialVersionSnapshot, ConnectedMcpGatewayMetadata (+34 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.03
Nodes (130): tooManyRequests(), claimFirstInstanceAdmin(), FirstAdminClaimResult, FirstAdminTransaction, collapseDuplicatePendingHumanJoinRequests(), findReusableHumanJoinRequest(), humanJoinRequestIdentity(), JoinRequestLike (+122 more)

### Community 23 - "executeRun"
Cohesion: 0.02
Nodes (157): isWorkspaceLessFallbackWorkspaceDir(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), resolveLedgerBillingType(), buildExecutionWorkspaceAdapterConfig(), cloneRecord(), ExecutionWorkspaceEnvironmentResolution, ExecutionWorkspaceEnvironmentSource (+149 more)

### Community 24 - "PluginWorkerManager"
Cohesion: 0.04
Nodes (36): PluginRouteJobDeps, PluginRouteWebhookDeps, PluginJobCoordinator, PluginJobCoordinatorOptions, PluginJobScheduler, PluginJobSchedulerOptions, SchedulerDiagnostics, TriggerJobResult (+28 more)

### Community 25 - "heartbeatService"
Cohesion: 0.02
Nodes (265): parseObject, describeDbError(), findPgError(), isDbError(), runWithTransientDbRetry(), publishPluginDomainEvent(), evaluateAgentInvokability(), shouldCancelRunsForNonInvokableAgent() (+257 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.03
Nodes (90): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, buildThresholds(), DbOrTx, DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS, DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS (+82 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (59): parseFrontmatterMarkdown(), buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext (+51 more)

### Community 28 - "plugins.ts"
Cohesion: 0.03
Nodes (68): AvailableBundledPlugin, bundledPluginMetadata(), __dirname, discoverBundledPlugins(), DiscoveredBundledPlugin, EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES, fileExists(), findPackageJsonFiles() (+60 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.08
Nodes (50): collectEnvironmentSecretRefs(), createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe() (+42 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.11
Nodes (35): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+27 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.08
Nodes (31): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+23 more)

### Community 32 - "cloud-upstreams.test.ts"
Cohesion: 0.18
Nodes (9): fetchWithTimeout(), parseRemoteResponse(), postJson(), proofHeaders(), remoteGet(), remotePost(), safeParseJson(), sealCloudUpstreamCredential() (+1 more)

### Community 33 - "toolAccessService"
Cohesion: 0.04
Nodes (127): HttpError, parseRemoteHttpEndpoint(), asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor() (+119 more)

### Community 34 - "registry.ts"
Cohesion: 0.05
Nodes (40): BUILTIN_ADAPTER_TYPES, acpxLocalAdapter, adapterAcceptsModelForConfig(), adapterModelRegistryIsClosed(), adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks (+32 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.05
Nodes (77): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+69 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.04
Nodes (88): ColdInReviewGaugeEntry, ColdInReviewIssueRow, addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding() (+80 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.06
Nodes (53): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+45 more)

### Community 38 - "cases.ts"
Cohesion: 0.06
Nodes (53): normalizeContentType(), annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany(), assertProjectBelongsToCompany(), autoLinkRunIssue() (+45 more)

### Community 39 - "startServer"
Cohesion: 0.14
Nodes (18): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge() (+10 more)

### Community 40 - "recoveryService"
Cohesion: 0.03
Nodes (135): isTerminalIssueStatus(), reconcileUndeliverableIssueMonitors(), issueLockOwnerStateMatches(), lockIssueOwnership(), buildIssueMonitorClearedPatch(), buildIssueMonitorEligibilityPatch(), isMonitorNextCheckAtLive(), lockIssueParentMutationCompany() (+127 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.10
Nodes (43): ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, environmentCustomImageTemplateFromRow(), ACTIVE_SETUP_STATUSES, addSeconds(), EnvironmentCustomImageOverview, EnvironmentCustomImageReconciliation, environmentCustomImageService(), callProviderCancel() (+35 more)

### Community 42 - "feedback.ts"
Cohesion: 0.08
Nodes (61): appendNote(), asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildClaudeTraceFiles(), buildCodexTraceFiles() (+53 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (252): createBetterAuthHandler(), normalizeAuthLocationHeader(), ACCEPTED_INTERACTION_OUTCOME_METRIC, ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC, ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC, ACCEPTED_INTERACTION_OUTCOME_RECENT_METRIC, AGENT_ERROR_REASON_NONE, AGENT_ERROR_REASON_OTHER (+244 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.06
Nodes (69): WorkspaceFileResourceService, AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments() (+61 more)

### Community 45 - "openapi.ts"
Cohesion: 0.04
Nodes (47): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+39 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.11
Nodes (29): CatalogManifestFile, CatalogManifestUnavailableError, devCatalogManifestPath, devCatalogPackageRoot, fetchCatalogSourceFile(), getCatalogManifest(), getCatalogSkills(), inferLanguageFromPath() (+21 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.03
Nodes (143): __test_stackedChildDirective, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyPullRequestNotFound(), classifyWorkflowRunNotFound() (+135 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (39): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), buildRoutineRevisionSnapshot(), canonicalSnapshot(), collectProvidedRoutineVariables() (+31 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (18): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+10 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 51 - "readNonEmptyString"
Cohesion: 0.05
Nodes (75): getServerAdapter(), buildExplicitResumeSessionOverride(), buildHeartbeatRunFailedMetricInput(), clearInteractionContinuationWakeContext(), derivePaperclipPrTaskKey(), deriveTaskKey(), deriveTaskKeyWithHeartbeatFallback(), describeSessionResetReason() (+67 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.10
Nodes (32): PenstockProbeOutcomeLabel, PenstockProbePathLabel, asRecord(), buildCapacityUrl(), buildMessagesUrl(), CacheEntry, capacityRetryFromBody(), isPenstockCapacityBody() (+24 more)

### Community 53 - "authorization.ts"
Cohesion: 0.08
Nodes (38): AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction, assignmentPolicyEffect(), loadIssueAuthorizationPolicy() (+30 more)

### Community 54 - "runStrandedAssignedIssueSweep"
Cohesion: 0.05
Nodes (65): applyIssueMonitorPolicyTransition(), agentUiLink(), buildExecutionReviewParticipantRecoveryComment(), buildExecutionReviewParticipantUnavailableComment(), buildNonRetryableEscalationComment(), classifyContinuationFailure(), describeWorkspacePreflightRecoveryCause(), didAutomaticRecoveryFail() (+57 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.07
Nodes (39): classifyRemovalProof(), decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup() (+31 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.12
Nodes (4): createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "reapOrphanedRuns"
Cohesion: 0.05
Nodes (77): bindExternalRuntimeReservationIsolation(), claimRunWithExternalRuntimeSlot(), claimRunWithExternalRuntimeSlotOutcome(), claimRunWithExternalRuntimeSlotPool(), ExternalRuntimeClaim, ExternalRuntimeClaimOutcome, ExternalRuntimeClaimRefusal, ExternalRuntimeIsolationConflictCause (+69 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.06
Nodes (71): maskUnwalkableAgentConfigForRead(), walk(), projectApprovalPayloadForRead(), RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, assignRecordKey(), BENIGN_HEADER_NAMES, classifyKeyTier() (+63 more)

### Community 60 - "adapters.ts"
Cohesion: 0.12
Nodes (41): buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter(), resolvePackageDir() (+33 more)

### Community 61 - "folderService"
Cohesion: 0.16
Nodes (42): buildFolderViews(), resolve(), FolderRow, folderService(), assertMutableFolder(), assertNoSlugConflict(), create(), currentBundledCategory() (+34 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.07
Nodes (55): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), execFileAsync, ExecutionWorkspaceBranchReconcileActor (+47 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.06
Nodes (52): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+44 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.10
Nodes (32): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+24 more)

### Community 65 - "environment-runtime.ts"
Cohesion: 0.06
Nodes (59): stripSandboxProviderEnvelope(), buildEnvironmentSecretMetadataForLeaseFingerprint(), buildReusableSandboxLeaseFingerprint(), buildReusableSandboxLeaseScope(), createSandboxEnvironmentDriver(), cleanupObsoleteReusableSandboxLeases(), destroyReusableSandboxLease(), releasePluginBackedSandboxLease() (+51 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.10
Nodes (25): Config, resolveRunLogS3(), createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), createLocalDiskStorageProvider(), normalizeObjectKey(), resolveWithin() (+17 more)

### Community 67 - "issue-attachment-routes.test.ts"
Cohesion: 0.08
Nodes (25): normalizeIssueAttachmentMaxBytes(), DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody() (+17 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.14
Nodes (23): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), ParsedCron (+15 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.05
Nodes (49): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), assertNoEscapeStringLiterals(), assertNoGucWrite(), assertNoUnextractedSchemaRefs(), assertNoUnextractedSchemaRefsInAll() (+41 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.08
Nodes (60): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+52 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.08
Nodes (42): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates(), attachGoals(), attachListMetrics() (+34 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (34): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+26 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.08
Nodes (37): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+29 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.06
Nodes (61): ACKNOWLEDGEABLE_OUTCOME_INTERACTION_KINDS, assertExpectedOutcomeRefResolves(), assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult() (+53 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.05
Nodes (64): RFC-1918, assertBelongsToCompany(), FinanceDateRange, financeService(), rangeConditions(), WakeupDispatchOutcome, ADAPTER_OVERRIDE_ALLOWED_KEYS, ALLOWED_PROTOCOLS (+56 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.13
Nodes (33): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+25 more)

### Community 77 - "services/cloud-upstreams.ts"
Cohesion: 0.07
Nodes (58): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildWarnings(), cloudUpstreamRemoteFailureReport(), cloudUpstreamRunStatus(), cloudUpstreamService() (+50 more)

### Community 78 - "agentService"
Cohesion: 0.07
Nodes (56): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, describeAgentStartLockDispatchHealth(), AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed(), assertCompanyShortnameAvailable() (+48 more)

### Community 79 - "company-search.ts"
Cohesion: 0.10
Nodes (41): artifactResult(), companySearchService(), countAgents(), countArtifacts(), countProjects(), countTotalNonIssue(), fetchAgentRows(), fetchArtifactRows() (+33 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.09
Nodes (25): TASK_WATCHDOG_ORIGIN_KIND, ActorFields, isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict(), IssueRow, IssueWatchdogRow, IssueWatchdogUpsertInput, isUniqueConstraintConflict() (+17 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.05
Nodes (42): allocateFetchAllowedLoopbackPort(), appendRedirectParam(), asRecord(), assertSmokeOAuthRedirectUri(), escapeHtml(), FETCH_BLOCKED_PORTS, FIXTURE_TOOLS, FixtureTool (+34 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.05
Nodes (49): WorkspaceOperationRecorder, createGitLinkExclusivelyForTests, executeProcessForTests, GIT_INDEX_LOCK_STALE_MS, GitCommandFailedError, GitCommandTimeoutError, isInconclusiveGitFailureForTests, isProcessGroupAliveForTests (+41 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (43): PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, drainInFlightExecutions(), expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts(), isPidAlive() (+35 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.08
Nodes (47): readConfigFile(), resolveDefaultConfigPath(), findConfigFileFromAncestors(), resolvePaperclipConfigPath(), resolvePaperclipEnvPath(), ansi, color(), EmbeddedPostgresInfo (+39 more)

### Community 86 - "index.ts"
Cohesion: 0.07
Nodes (35): autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin(), installKkrooLocalPlugins() (+27 more)

### Community 87 - "pluginManagedRoutineService"
Cohesion: 0.23
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.12
Nodes (21): AuthenticatedTerminalContext, closeUpgradeSocket(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, CustomImageTerminalService, decodeClientMessage(), IncomingMessageWithTerminalContext, isWritableUpgradeSocket(), parseJsonClientFrame() (+13 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "__resetMetricsForTest"
Cohesion: 0.04
Nodes (36): body(), BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), BRANCH_CLAIM_CONFLICT_DEFERRAL_ATTEMPT_METRIC, BRANCH_CLAIM_CONFLICT_DEFERRALS_METRIC (+28 more)

### Community 91 - "config.ts"
Cohesion: 0.07
Nodes (37): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS, numericEnv() (+29 more)

### Community 92 - "normalizePortablePath"
Cohesion: 0.10
Nodes (53): asString(), auditInstalledSkillBytes(), buildInventoryContentHash(), classifyInventoryKind(), collectLocalSkillInventory(), collectSkillFileBytes(), visit(), auditSkill() (+45 more)

### Community 93 - "recovery/service.ts"
Cohesion: 0.03
Nodes (83): DeferredWakeReopenEligibility, LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), WAKE_COMMENT_IDS_KEY, POD_GIT_TRANSPORT_FAILURE, ACTION_SCOPED_SWEEP_NAMES (+75 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.14
Nodes (40): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+32 more)

### Community 95 - "issue-checkout-status.ts"
Cohesion: 0.21
Nodes (15): checkoutRestoreStatusExpression, checkoutRestoreTargetStatus(), DbOrTransaction, hasCancelledBlocker, hasPendingBlocker, holdsDispatchableMonitor, reconcileRestoredMonitors(), restorableCheckoutPromotion (+7 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.15
Nodes (24): prepareHotRestartShutdown(), toHotRestartIntentRun(), asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent (+16 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.06
Nodes (34): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+26 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (23): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+15 more)

### Community 99 - "aws-secrets-manager-provider.ts"
Cohesion: 0.04
Nodes (69): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), awsProviderSafeMessage(), AwsSecretsManagerConfig (+61 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (37): commentEffectLedger, drizzleTableName, insertedTableNames(), installActor(), lastSelectedTable, LedgerRow, ledgerRows, mockAccessService (+29 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.09
Nodes (28): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+20 more)

### Community 102 - "environment-probe.ts"
Cohesion: 0.10
Nodes (20): ParsedEnvironmentConfig, probeEnvironment(), probeK8sEnvironment(), raceWithTimeout(), probePluginSandboxProviderDriver(), isBuiltinSandboxProvider(), probeSandboxProvider(), FakeKubeConfig (+12 more)

### Community 103 - "agent-redaction.ts"
Cohesion: 0.11
Nodes (23): asRecord(), containAgentConfig(), containAgentMetadata(), containsRedactedAdapterValue(), isRedactedEnvBinding(), keepSanitizedAgentMetadata(), maskAgentWorkspaceStrategyCommands(), maskAgentWorkspaceStrategyCommandsInner() (+15 more)

### Community 104 - "logger.ts"
Cohesion: 0.05
Nodes (34): resolveDefaultLogsDir(), httpLogger, logDir, logFile, logger, resolveServerLogDir(), sharedOpts, DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS (+26 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.05
Nodes (66): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart() (+58 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.13
Nodes (26): compareSweepWakeFrame(), currentMinuteBucket(), detectSweepWakeRace(), equalStringArrays(), getIssueSnapshot(), isCompanyFlagEnabled(), isValidIsoDate(), isValidSweepWakeFrame() (+18 more)

### Community 107 - "issue-execution-policy-routes.test.ts"
Cohesion: 0.10
Nodes (19): createApp(), issueWithClearedStalledMonitor(), issueWithTriggeredMonitor(), mockAccessService, mockDb, mockDbInsert, mockDbInsertValues, mockDbLeftJoinWhere (+11 more)

### Community 108 - "tool-content-guards.ts"
Cohesion: 0.15
Nodes (20): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+12 more)

### Community 109 - "budgetService"
Cohesion: 0.03
Nodes (92): APPROVAL_SUBJECT_KEYS, ApprovalInsertValues, hasApprovalSubject(), insertApproval(), insertApprovalRecord(), ApprovalListFilters, approvalListOrderBy(), ApprovalListPage (+84 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (23): createApp(), currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService (+15 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.11
Nodes (23): AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput, AgentScorecardOptions, AgentScorecardsResult, computeAgentScorecards(), MIN_SAMPLE_DONE (+15 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.13
Nodes (16): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+8 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.07
Nodes (55): ActorLike, actorPrincipal(), applyIssueExecutionStageTransition(), applyMonitorTransition(), AssigneeLike, assigneePrincipal(), blankExecutionState(), buildChangesRequestedState() (+47 more)

### Community 115 - "scrape-metrics-collector.ts"
Cohesion: 0.04
Nodes (72): describeHeldAgentStartLocks(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, AGENT_START_LOCK_HELD_SECONDS_METRIC, AGENT_START_LOCK_PHASE_SECONDS_METRIC, DB_POOL_CONNECTIONS_METRIC, DB_POOL_WAITING_QUERIES_METRIC (+64 more)

### Community 116 - "ui-branding.ts"
Cohesion: 0.09
Nodes (31): readBrandedStaticIndexHtml(), tempDir(), applyUiBranding(), createFaviconDataUrl(), DEFAULT_FAVICON_LINKS, deriveColorFromSeed(), escapeHtmlAttribute(), getWorktreeUiBranding() (+23 more)

### Community 117 - "agent-cross-tenant-authz-routes.test.ts"
Cohesion: 0.09
Nodes (24): assertAuthenticated(), assertBoard(), assertCompanyAccess(), assertInstanceAdmin(), baseAgent, baseKey, createApp(), getAccessibleResource() (+16 more)

### Community 118 - "agent-permissions-routes.test.ts"
Cohesion: 0.07
Nodes (25): agentActorApp(), baseAgent, createApp(), createDbStub(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService (+17 more)

### Community 119 - "heartbeat-workspace-branch-containment.test.ts"
Cohesion: 0.12
Nodes (22): adapterExecute, asRecord(), BranchContainmentCallSite, createForwardBranchMismatch(), createGitRepo(), Db, drainInFlightExecutions(), execFileAsync (+14 more)

### Community 120 - "activity-log.ts"
Cohesion: 0.04
Nodes (56): activityDetails(), createFileResourceLimiter(), createFileResourceListLimiter(), denialReasonFromError(), FileResourceLimiter, fileResourceRoutes(), logDeniedAttempt(), logListDeniedAttempt() (+48 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.14
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "productivityReviewService"
Cohesion: 0.08
Nodes (57): extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isTerminalGateClosableTriggerSet(), isTerminalIssueStatus(), isUnchangedSampleClosableTriggerSet(), productivityReviewAssignmentWakeIdempotencyKey(), productivityReviewEscalationFingerprint(), productivityReviewService() (+49 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.09
Nodes (50): RFC-6901, assignRecordKey(), ownRecordValue(), AMBIGUOUS_SCHEMA_NODE, childNodesForIndex(), childNodesForKey(), collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues() (+42 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.15
Nodes (21): awsSecretsManagerProvider, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind, RAW_OAUTH_TOKEN_KEYS (+13 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "github-review-gate-authority.ts"
Cohesion: 0.04
Nodes (73): deriveGithubWebhookMaxConcurrentDeliveries(), derivePrReviewerWakeMaxConcurrency(), GithubWebhookConfig, githubWebhookRoutes(), ghGraphQlPullRequestFields(), githubHeadChecksSettlement(), activateGithubReviewGateDelivery(), affectsProtectedBase() (+65 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.10
Nodes (16): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+8 more)

### Community 128 - "plugin-tool-dispatcher.ts"
Cohesion: 0.06
Nodes (15): PluginRouteToolDeps, createPluginToolDispatcher(), handlePluginEnabled(), registerFromDb(), PluginToolDispatcher, createPluginToolRegistry(), addTool(), buildName() (+7 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.07
Nodes (34): sourceTrustForActorWrite(), buildCaseContextMarkdown(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb (+26 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.14
Nodes (24): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates(), extractPreviousNextAction() (+16 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.10
Nodes (19): createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), describeRunLogWriteFailure(), DurableRunLogStoreOptions, isAtOrPastEnd() (+11 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.06
Nodes (50): githubAppCredentialsConfigured(), GitHubCommitStatusState, acquireGithubStatusKeyLease(), appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), COALESCED_REEVALUATION_DELAY_MS, DbHandle (+42 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "utils.ts"
Cohesion: 0.09
Nodes (27): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx, execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment() (+19 more)

### Community 135 - "server-info.ts"
Cohesion: 0.15
Nodes (16): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, buildCommitGitInfo(), createServerInfoSnapshot(), getGitLocalChanges() (+8 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.13
Nodes (8): parseWakePayloadFromMessage(), createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.09
Nodes (34): createK8sEnvironmentDriver(), createLocalEnvironmentDriver(), createSshEnvironmentDriver(), EnvironmentRuntimeService, getDriver(), requireDriver(), requireDriverKey(), ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES (+26 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.06
Nodes (53): collectCiBranchIdentifiers(), AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES (+45 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.07
Nodes (18): extractExecutiveHoldMarker(), findActiveExecutiveHold(), issueSearchArmsJoinOn(), issueSearchArmsSubquery(), issueSearchRankExpr(), parseExecutiveHoldMarkerTimestamp(), searchArmsColumn(), agentRow() (+10 more)

### Community 140 - "getMetricsRegistry"
Cohesion: 0.04
Nodes (54): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+46 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.14
Nodes (23): assertLowTrustWorkspaceIsolation(), issueIdIsDescendantOf(), LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS, workspaceIssueWithinLowTrustBoundary(), asRecord(), deny(), hasBoundaryScope(), intersectSets() (+15 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.05
Nodes (28): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, createApp(), mockAccessService, mockAdapter (+20 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "accessService"
Cohesion: 0.05
Nodes (46): createLiveEventTranscriptGate(), decisionReason(), defaultTranscriptStreamAuditor(), GateOutcome, LIVE_EVENT_TRANSCRIPT_AUDIT_ACTION, LiveEventSubscriberContext, LiveEventTranscriptAuditEntry, MembershipReader (+38 more)

### Community 145 - "isolation-reclaim-driver.test.ts"
Cohesion: 0.06
Nodes (50): driveIsolationReclaim(), DriveIsolationReclaimOptions, messageOf(), ReclaimClaimFailureKind, ReclaimClaimOutcome, ReclaimClaimPhase, ReclaimClaimTemplate, ReclaimJobPort (+42 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.21
Nodes (17): clearAllHeartbeatRunRuntimeStatuses(), cloneStatus(), getHeartbeatRunRuntimeStatus(), HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS, HeartbeatRunRuntimeStatus, isExpired(), MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS, MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS (+9 more)

### Community 147 - "asString"
Cohesion: 0.08
Nodes (59): asString, recordExecutionWorkspaceTeardown(), classifyGitCheckoutProbeFailure(), cleanupExecutionWorkspaceArtifacts(), createGitLinkExclusively(), deriveRepoNameFromRepoUrlForRuntime(), describeHusk(), detectDefaultBranch() (+51 more)

### Community 148 - "synthetic-ssh-probe.ts"
Cohesion: 0.14
Nodes (12): classifyError(), computeMedian(), execFileAsync, extractSshHandshakeMs(), readSshdAuthAttempts(), runProbeOnce(), SyntheticProbeAlert, SyntheticProbeOptions (+4 more)

### Community 149 - "environment-custom-image-terminal-ws.test.ts"
Cohesion: 0.09
Nodes (10): closeServer(), createSession(), FakeSshShell, flushPromises(), futureDate(), listen(), require, startHarness() (+2 more)

### Community 150 - "issue-efficiency.ts"
Cohesion: 0.17
Nodes (16): AdapterUsage, adapterUsageForIssues(), ApportionedAdapter, apportionIssueAcrossAdapters(), CostSource, coverageForWindow(), CoverageReport, IssueEfficiency (+8 more)

### Community 151 - "issueService"
Cohesion: 0.04
Nodes (85): defaultIssueExecutionWorkspaceSettingsForProject(), activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter(), blockedInboxIssueConditions() (+77 more)

### Community 152 - "successful-run-handoff.ts"
Cohesion: 0.06
Nodes (51): isAlertEscalationLadderOriginKind(), agentLinkRow(), AgentRow, boundedLinkText(), buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice(), decideSuccessfulRunHandoff() (+43 more)

### Community 153 - "companies-route-cross-company-authz.test.ts"
Cohesion: 0.12
Nodes (16): createApp(), createCompany(), exportPreviewResult(), exportRequest, exportResult(), importResult(), mockAccessService, mockAgentService (+8 more)

### Community 154 - "version.ts"
Cohesion: 0.14
Nodes (17): compactRecord(), DebugLog, GitDescribeCommand, hasGitMetadataBeforeNodeModulesBoundary(), hasPathSegment(), isPackagedInstall(), normalizeErrorField(), PackageJson (+9 more)

### Community 155 - "human-gated-ageing.ts"
Cohesion: 0.08
Nodes (45): AgedHumanGatedIssue, BlockerEdge, BlockerGraphInput, classifyHumanGatedWait(), comparePriority(), computeTransitivePayoff(), DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY, escalateAfterDaysFor() (+37 more)

### Community 157 - "worker-tier-proxy.ts"
Cohesion: 0.09
Nodes (27): RFC-7230, boardOrgAccessProxyGuard(), CONNECT_PHASE_ERROR_CODES, createWorkerProxyHandler(), fetchWithStartupRetry(), forwardRequestHeaders(), hasRequestBody(), HOP_BY_HOP_HEADERS (+19 more)

### Community 158 - "result"
Cohesion: 0.04
Nodes (58): AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), abortedAgentId(), abortReason(), CancellableQuery (+50 more)

### Community 159 - "routes/agents.ts"
Cohesion: 0.02
Nodes (132): describeInadmissibleClaudeCodeVersion(), describeUnregisteredModel(), restoreRedactedAgentRuntimeConfig, ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, parseOffsetParam(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams() (+124 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (132): classifyPrReviewComment(), isActionablePrReviewComment(), isReviewShapedPrComment(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead() (+124 more)

### Community 161 - "instanceSettingsService"
Cohesion: 0.07
Nodes (40): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema (+32 more)

### Community 162 - "recovery-observability.ts"
Cohesion: 0.08
Nodes (26): RESOLVED_ASSIGNEE_AGENT_ID_EVIDENCE_KEY, RESOLVED_ISSUE_STATUS_EVIDENCE_KEY, ACTIVE_STATUSES, classifyRecoveryHandoff(), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT, evaluateRecoveryRateAlert(), HandoffClass, MAX_WINDOW_WEEKS (+18 more)

### Community 163 - "agent-secret-redaction.test.ts"
Cohesion: 0.07
Nodes (23): agentActor, baseAgent, boardActor, createApp(), createDbStub(), hire(), mockAccessService, mockAgentInstructionsService (+15 more)

### Community 164 - "db-retry.ts"
Cohesion: 0.10
Nodes (21): compactErrorText(), isPostgresSqlState(), isTransientDbError(), PgErrorFields, POSTGRES_SQLSTATE_CLASSES, readString(), TRANSIENT_DB_SQLSTATES, TransientDbRetryOptions (+13 more)

### Community 165 - "authorizationService"
Cohesion: 0.09
Nodes (54): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentHasRecoveryHandoffGrantOnIssue() (+46 more)

### Community 166 - "human-gated-ageing-digest.ts"
Cohesion: 0.06
Nodes (47): db, MAX_PRS, token, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk(), collectDigest() (+39 more)

### Community 167 - "listBlockedInboxIssues"
Cohesion: 0.07
Nodes (41): activeRunMapForIssues(), activeRunMapKey(), blockedByMapForIssues(), blockedInboxAttentionResponseFields(), blockedInboxResponseDescription(), blockedInboxSearchText(), chunkList(), countBlockedInboxIssues() (+33 more)

### Community 168 - "adapters/index.ts"
Cohesion: 0.08
Nodes (30): detectAdapterModel(), filterAdapterModelsForConfiguredAllowlist(), findActiveServerAdapter(), findServerAdapter(), getDeclaredAdapterModels(), isOpenCodeAdapterType(), listAdapterModelProfiles(), listAdapterModels() (+22 more)

### Community 169 - "ac-policy-assignee-routing.ts"
Cohesion: 0.14
Nodes (15): AcPolicyAgentTargetReason, AcPolicyFilingTarget, AcPolicyFilingTargetInput, AcPolicyResolvedOwner, AcPolicySkippedAgent, AcPolicySweepAgent, AcPolicyUnroutableReason, AcPolicyUserTargetReason (+7 more)

### Community 170 - "company-portability-routes.test.ts"
Cohesion: 0.11
Nodes (13): cloudHeaders, createApp(), exportRequest, importRequest, mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService (+5 more)

### Community 171 - "company-issue-identity-guard.test.ts"
Cohesion: 0.12
Nodes (24): raiseIssueCounterAfterImport(), syncIssueIdentityFromLinearTeam(), ISSUE_IDENTITY_ACTIVITY_ACTION, IssueIdentityPlan, IssueIdentityRefusal, IssueIdentityRequest, IssueIdentityState, normalizeIssuePrefix() (+16 more)

### Community 172 - "environment-custom-image-routes.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+2 more)

### Community 173 - "log-redaction.ts"
Cohesion: 0.13
Nodes (20): CURRENT_USER_REDACTION_TOKEN, CurrentUserCandidates, CurrentUserRedactionOptions, defaultHomeDirs(), defaultUserNames(), escapeRegExp(), getDefaultCurrentUserCandidates(), isPlainObject() (+12 more)

### Community 174 - "summary-slots.test.ts"
Cohesion: 0.29
Nodes (7): withBuiltInAgentMarker(), issuePrefix(), projectSelector(), seedCompany(), seedRun(), seedSummarizer(), startGeneration()

### Community 175 - "company-search-extract.ts"
Cohesion: 0.20
Nodes (14): companySearchExtractService(), contentMatch(), escapeLikePattern(), escapeRegexPattern(), excerpt(), extractMatches(), ExtractSource, literalOccurrences() (+6 more)

### Community 176 - "plugin-dev-watcher.ts"
Cohesion: 0.11
Nodes (21): createPluginDevWatcher(), close(), handlePluginDisabled(), handlePluginEnabled(), handlePluginLoaded(), handlePluginUnloaded(), unwatchPlugin(), watchLocalPluginById() (+13 more)

### Community 177 - "createToolRuntimeSupervisor"
Cohesion: 0.14
Nodes (26): ACTIVE_SLOT_STATUSES, asRecord(), createToolRuntimeSupervisor(), activeRows(), assertCapacity(), assertLocalStdioAvailable(), assertRestartAllowed(), ensureRunningSlot() (+18 more)

### Community 178 - "git-checkout-identity.ts"
Cohesion: 0.09
Nodes (28): AgentGitIdentityEnv, buildAgentGitIdentity(), buildAgentGitIdentityEnv(), CheckoutGitIdentityResult, CheckoutGitIdentityStatus, CheckoutIdentityAgentRef, defaultGitRunner(), ensureCheckoutGitIdentity() (+20 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (50): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+42 more)

### Community 181 - "native-memory-metrics.ts"
Cohesion: 0.07
Nodes (43): DEFAULT_SAMPLE_INTERVAL_MS, EXTERNAL_PEAK_COMPONENT, finite(), HEAP_TOTAL_PEAK_COMPONENT, HEAP_USED_PEAK_COMPONENT, HeapPeakReading, HeapSizeReading, readHeapPeaks() (+35 more)

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.27
Nodes (12): collectFromJsonValue(), CursorModelsCommandResult, dedupeModels(), fetchCursorModelsFromCli(), isLikelyModelId(), listCursorModels(), mergedWithFallback(), parseCursorModelsOutput() (+4 more)

### Community 184 - "health.ts"
Cohesion: 0.13
Nodes (21): AuthCapabilities, hasDevServerStatusToken(), healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), alertFileCandidates() (+13 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.13
Nodes (25): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+17 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.13
Nodes (16): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokabilityFromDb(), invalidChainReason() (+8 more)

### Community 188 - "pipelineService"
Cohesion: 0.08
Nodes (47): redactRunError(), activityActorPatch(), assertActorProvenance(), assertReviewTargetsInSet(), defaultRetryCleanup(), descendantCaseIds(), eventActorPatch(), getCaseWithStageForUpdateOrThrow() (+39 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.09
Nodes (34): ACTIVE_RECOVERY_ACTION_STATUSES, BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, DbOrTransaction, isRecord(), IssueRecoveryActionRow, findSupersededRestoredClaim(), retryUpsertSourceScoped(), upsertSourceScopedUnlocked() (+26 more)

### Community 190 - "github-write-egress-scrub.test.ts"
Cohesion: 0.07
Nodes (31): Coverage, dockerfilePath, helpersPath, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE, serverSourceDirectory (+23 more)

### Community 191 - "issue-workspace-command-authz.test.ts"
Cohesion: 0.11
Nodes (15): AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS, createApp(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere (+7 more)

### Community 192 - "reconcileStrandedRecoveryWakeBackstopImpl"
Cohesion: 0.07
Nodes (38): buildIssueBlockersResolvedWakeIdempotencyKey(), findExistingIssueBlockersResolvedWake(), findExistingIssueBlockersResolvedWakeForAnyKey(), IDEMPOTENT_DEPENDENCY_WAKE_STATUSES, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, ActivePauseHoldRow, recordBackstopCandidateSkipped(), recordBackstopSweepCompleted() (+30 more)

### Community 193 - "heap-snapshot.ts"
Cohesion: 0.10
Nodes (36): collectPrunable(), ConcurrentSnapshotWriters, decideHeapSnapshot(), defaultHeapSnapshotRuntime, describeSentinelOutcome(), ensureHeapSnapshotDir(), findConcurrentSnapshotWriters(), HEAP_SNAPSHOT_EXTENSION (+28 more)

### Community 194 - "heartbeat-stop-metadata.ts"
Cohesion: 0.21
Nodes (17): mergeRunStopMetadataForAgent(), isMaxTurnExhaustionRun(), buildHeartbeatRunStopMetadata(), defaultTimeoutSecForAdapter(), hasOwn(), HeartbeatRunOutcome, HeartbeatRunStopMetadata, HeartbeatRunStopReason (+9 more)

### Community 195 - "remote-http-endpoint-guard.ts"
Cohesion: 0.20
Nodes (11): assertPublicRemoteHttpEndpoint(), isPrivateOrReservedIp(), isPrivateOrReservedIpv4(), isPrivateOrReservedIpv6(), LookupResult, lookupWithTimeout(), parseIpv4Address(), parseMappedIpv4Hex() (+3 more)

### Community 196 - "run-scratch.ts"
Cohesion: 0.19
Nodes (13): buildHeartbeatRunScratchEnv(), cleanupHeartbeatRunScratch(), HEARTBEAT_RUN_SCRATCH_MARKER, HeartbeatRunScratch, HeartbeatRunScratchCleanupResult, HeartbeatRunScratchEnvResult, HeartbeatRunScratchMetadata, isPathInside() (+5 more)

### Community 197 - "pr-review-duplicate-issue-guard.ts"
Cohesion: 0.07
Nodes (45): readGithubPrReviewerAgentIds(), __test_buildPrReviewerTaskLockKeys, assertNotDuplicatePrReviewIssue(), buildPrReviewTaskKey(), candidatePullRequestRefs(), canonicalReviewTitleHeadSha(), configuredPrReviewerAgentIds(), declaresNotAReviewRequest() (+37 more)

### Community 198 - "adapter-model-refresh-routes.test.ts"
Cohesion: 0.11
Nodes (14): createApp(), mockAccessService, mockAgentInstructionsService, mockApprovalService, mockBudgetService, mockCompanySkillService, mockEnvironmentService, mockHeartbeatService (+6 more)

### Community 199 - "agent-instructions-routes.test.ts"
Cohesion: 0.12
Nodes (13): createApp(), makeAgent(), makeReflectionCoachAgent(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockBuiltInAgentService, mockCompanySkillService (+5 more)

### Community 200 - "issue-feedback-routes.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockEnvironmentService, mockExecutionWorkspaceService, mockFeedbackExportService, mockFeedbackService, mockHeartbeatService (+6 more)

### Community 201 - "parseIssueExecutionState"
Cohesion: 0.09
Nodes (33): dispatchWatchdogRearmDelayMs(), clearIssueMonitorAndRecover(), dispatchClaimedIssueMonitor(), findOpenIssueMonitorRecoveryIssue(), formatIssueIdentifierLink(), monitorRecoveryComment(), monitorRecoveryDetails(), monitorRecoveryPolicy() (+25 more)

### Community 202 - "issue-recovery-actions.test.ts"
Cohesion: 0.10
Nodes (32): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, summarizeStrandedRecoveryHandBackPass(), AnyFn, blockSourceOnFreshIssue() (+24 more)

### Community 203 - "heartbeat-run-scoped-job-liveness-dispatch.test.ts"
Cohesion: 0.07
Nodes (29): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), cache (+21 more)

### Community 204 - "execution-policy-bootstrap.ts"
Cohesion: 0.24
Nodes (11): parseAdapterRegistryEnv(), ENTRY, KubernetesEnvironmentConfigInput, applyExecutionPolicyBootstrap(), bootstrapExecutionPolicyFromEnv(), ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, parseBool() (+3 more)

### Community 205 - "body"
Cohesion: 0.05
Nodes (18): __test_resolvePostedReviewObservation, CCROTATE_CAPACITY_DEFERRED_METRIC, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC, MODEL_PROFILE_UNAPPLIED_METRIC, PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC, QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC, QUEUED_RUN_OLDEST_AGE_METRIC (+10 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "notFound"
Cohesion: 0.05
Nodes (49): notFound(), assertBuiltInAgentsEnabled(), assertEnabled(), assertActiveUserMembership(), assertSummariesEnabled(), getPolicyRow(), assertCanMutateComment(), createComment() (+41 more)

### Community 208 - "issue-list-truncation-signal.test.ts"
Cohesion: 0.10
Nodes (13): clampIssueListLimit(), ISSUE_LIST_MAX_LIMIT, OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, buildApp(), mockAccess, mockIssueService, seedIssues() (+5 more)

### Community 209 - "agent-model-registry-validation.test.ts"
Cohesion: 0.08
Nodes (29): ALLOW_UNLISTED_ADAPTER_MODELS_ENV, allowsUnlistedAdapterModels(), findUnregisteredAdapterModel(), findUnregisteredModel(), introducesModel(), asModels(), claudeK8sStub(), CLI_ALIASES (+21 more)

### Community 210 - "cgroup-memory-metrics.test.ts"
Cohesion: 0.09
Nodes (33): CGROUP_ACTIVE_FILE_COMPONENT, CGROUP_ANON_COMPONENT, CGROUP_FILE_COMPONENT, CGROUP_FILE_DIRTY_COMPONENT, CGROUP_FILE_MAPPED_COMPONENT, CGROUP_FILE_WRITEBACK_COMPONENT, CGROUP_INACTIVE_FILE_COMPONENT, CGROUP_KERNEL_COMPONENT (+25 more)

### Community 212 - "issue-document-restore-routes.test.ts"
Cohesion: 0.13
Nodes (12): createApp(), mockAccessService, mockAgentService, mockDocumentsService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockIssueThreadInteractionService (+4 more)

### Community 213 - "workspace-runtime-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): createExecutionWorkspaceApp(), createProjectApp(), mockAccessService, mockAssertCanManageExecutionWorkspaceRuntimeServices, mockAssertCanManageProjectWorkspaceRuntimeServices, mockEnvironmentService, mockExecutionWorkspaceService, mockGetTelemetryClient (+6 more)

### Community 214 - "pr-review-request-ageing.ts"
Cohesion: 0.09
Nodes (43): DigestProducer, DigestSection, AgedReviewRequest, AgedReviewRequestReport, AgeingPullRequest, AGENT_AUTHOR_LOGINS, AGENT_AUTHOR_SET, ALLY_REVIEW_IDENTITY_LOGINS (+35 more)

### Community 215 - "issue-list-timeout-explain.ts"
Cohesion: 0.07
Nodes (63): buildIssueListAnalyzeProbeQuery(), captureIssueListAnalyzeProbe(), ISSUE_LIST_ANALYZE_PROBE_FLAG, ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES, ISSUE_LIST_ANALYZE_PROBE_OPTIONS, ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS, issueListAnalyzeProbeCapturesTaken(), issueListAnalyzeProbeTerm() (+55 more)

### Community 216 - "dev-server-status.ts"
Cohesion: 0.24
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.14
Nodes (21): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+13 more)

### Community 218 - "sweep-wake-preflight.test.ts"
Cohesion: 0.22
Nodes (9): composeSweepWakeFramePage(), quoteYamlScalar(), renderYamlArray(), SweepWakeFrame, SweepWakeFrameIdentity, SweepWakeIssueSnapshot, baseFrame, baseIdentity (+1 more)

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "visibleIssueCondition"
Cohesion: 0.12
Nodes (30): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+22 more)

### Community 221 - "ensureRegistry"
Cohesion: 0.03
Nodes (115): getActiveAgentIds(), rethrowIfAgentStartLockAborted(), extractWakeCommentIds(), allowsIssueInteractionWake(), BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY, CARRIES_GITHUB_WAKE_CONTEXT_KEY, classifyHeartbeatWakeClass(), classifyQueuedRunForDependencyReap() (+107 more)

### Community 222 - "project-checkout-origin-reconciler.ts"
Cohesion: 0.11
Nodes (20): PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC, ProjectCheckoutOriginMismatchEntry, setProjectCheckoutOriginMismatchMetrics(), setProjectCheckoutOriginReconcileMetricsRefreshSuccess(), directoryExists(), mapWithConcurrency() (+12 more)

### Community 223 - "documents.ts"
Cohesion: 0.09
Nodes (29): buildHarnessIssueDescription(), builtInSkillTestRunTemplate(), collectVersionFileInventory(), createTestRun(), createTestRunTemplate(), createVersion(), deleteTestRunTemplate(), ensureRunSkillVersion() (+21 more)

### Community 224 - "isolation-workspace-reaper.ts"
Cohesion: 0.06
Nodes (43): AGENT_WORKSPACE_CLAIM_PREFIX, buildIsolationReclaimPlan(), classifyIsolationWorkspaceAge(), createDbUnreachableAgentCount(), defaultScheduler, hasNestedCheckout(), IsolationWorkspaceAgeVerdict, IsolationWorkspaceReaperScheduler (+35 more)

### Community 225 - "redactAgentConfigPayload"
Cohesion: 0.18
Nodes (9): redactAgentConfigPayload(), containDefaultsPayload(), redactInviteRecord(), redactJoinRequestRecord(), hireMetadataFixture(), hireRuntimeConfigFixture(), issuePrefix(), seedCompany() (+1 more)

### Community 226 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.07
Nodes (24): PENDING_RECOVERY_WAKE_CEILING_TIMEOUT_MULTIPLIER, PENDING_INTERACTION_MAX_AGE_MS, readStrandedAttendanceWindow(), createStrandedAttendancePrefetch(), windowFor(), windowIdsFor(), DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS, DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW (+16 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.13
Nodes (17): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken(), minDate() (+9 more)

### Community 228 - "normalizeIssueExecutionPolicy"
Cohesion: 0.11
Nodes (27): isLapsedMonitorRearmPatch(), applyIssueExecutionPolicyTransition(), normalizeIssueExecutionPolicy(), normalizeMonitorNotes(), stripMonitorFromExecutionPolicy(), makeInReviewIssue(), makeStuckReviewIssue(), approvalOnlyPolicy() (+19 more)

### Community 229 - "plugin-managed-agents.ts"
Cohesion: 0.19
Nodes (27): adapterPreference(), applyInstructionTemplateVariables(), bindingExternalId(), declarationPatch(), declaredInstructionFiles(), fallbackAdapterType(), managedMetadata(), normalizeAdapterType() (+19 more)

### Community 230 - "plugin-managed-skills.ts"
Cohesion: 0.21
Nodes (22): buildDeclaredSkillFiles(), buildDefaultMarkdown(), buildPackageFiles(), buildSkillDefaults(), canonicalSkillKey(), pluginKeySlug(), pluginManagedSkillService(), declarationFor() (+14 more)

### Community 231 - "execution-workspace-per-run-isolation.test.ts"
Cohesion: 0.38
Nodes (5): createTempRepo(), execFileAsync, realizeRun(), runGit(), tempRoots

### Community 232 - "approval-routes-idempotency.test.ts"
Cohesion: 0.17
Nodes (13): createAgentApp(), createApp(), createRouteDb(), fileLivenessEscalation(), mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockEscalationCreate() (+5 more)

### Community 233 - "approval-withdraw-routes.test.ts"
Cohesion: 0.17
Nodes (9): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockLogActivity (+1 more)

### Community 234 - "company-portability.test.ts"
Cohesion: 0.08
Nodes (17): accessSvc, agentInstructionsSvc, agentSvc, assetSvc, companySkillSvc, companySvc, issueSvc, projectSvc (+9 more)

### Community 235 - "docker-opencode-runtime-pin.test.ts"
Cohesion: 0.13
Nodes (13): agentRuntimeBake, agentRuntimeImagesWorkflow, designerDockerfile, designerPackageLock, dockerAgentWorkflow, dockerDesignerWorkflow, dockerWorkflow, prWorkflow (+5 more)

### Community 236 - "done-gate-durable-artifact.test.ts"
Cohesion: 0.17
Nodes (3): createApp(), LOW_TRUST_REVIEW_PRESET, patchToDone()

### Community 237 - "environment-selection-route-guards.test.ts"
Cohesion: 0.20
Nodes (10): buildApp(), createIssueApp(), createProjectApp(), mockCompanyService, mockEnvironmentService, mockIssueReferenceService, mockIssueService, mockLogActivity (+2 more)

### Community 238 - "isolation-reclaim-job.ts"
Cohesion: 0.05
Nodes (75): main(), ParsedArgs, parseReclaimArgs(), parseReclaimPlan(), runReclaimExecutor(), stderrLogger, buildIsolationReclaimJobManifest(), DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS (+67 more)

### Community 239 - "routines-routes.test.ts"
Cohesion: 0.15
Nodes (11): createApp(), mockAccessService, mockAnnotationService, mockGetTelemetryClient, mockLogActivity, mockRoutineService, mockTrackRoutineCreated, pausedRoutine (+3 more)

### Community 240 - "approval-gate-reconciler.ts"
Cohesion: 0.14
Nodes (21): announcementBody(), announcementIdempotencyKey(), announcementMetadata(), ApprovalGateReconcileResult, ApprovalGateReconcilerOptions, CandidateCursor, CandidateRow, classifyPullRequestGateLookup() (+13 more)

### Community 241 - "stranded-blocked-issue-reconciler.ts"
Cohesion: 0.06
Nodes (39): hasReusableExecutionWorkspaceBinding(), externalWaitFromDescription(), createIssueDependencyReadiness(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds() (+31 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "routes/projects.ts"
Cohesion: 0.03
Nodes (119): appendWithCap, ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), readObject(), maskWorkspaceRuntimeTextForRead() (+111 more)

### Community 244 - "runtime-api.ts"
Cohesion: 0.56
Nodes (9): buildRuntimeApiCandidateUrls(), choosePrimaryRuntimeApiUrl(), collectReachableInterfaceHosts(), formatOrigin(), isLinkLocalHost(), isLoopbackHost(), isWildcardHost(), normalizeHost() (+1 more)

### Community 245 - "pluginRegistryService"
Cohesion: 0.09
Nodes (16): main(), readStdin(), LinearWebhookFixture, loadLinearWebhookFixtures(), sanitizeLinearWebhookFixture(), sanitizeLinearWebhookValue(), SECRET_HEADER_NAMES, listReadyPluginEnvironmentDrivers() (+8 more)

### Community 246 - "routineService"
Cohesion: 0.07
Nodes (41): incrementRoutineDispatchMetric(), mapRoutineDescriptionDocument(), mapRoutineRevision(), nextResultText(), normalizeWebhookTimestampMs(), routineService(), appendRoutineRevision(), assertGoal() (+33 more)

### Community 247 - "renderMetrics"
Cohesion: 0.03
Nodes (67): TIMER_PRE_DISPATCH_EXCLUSION_INTERVAL_MS, TIMER_PRE_DISPATCH_EXCLUSION_SOURCE, COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC, COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR, coldInReviewLeaderScopedExpr(), CRASH_RECOVERY_CANDIDATE_INDEX_NAME, CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC (+59 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "deriveSkillExportDirCandidates"
Cohesion: 0.33
Nodes (10): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+2 more)

### Community 250 - "accepted-interaction-outcome-sweep.ts"
Cohesion: 0.11
Nodes (23): ACCEPTED_OUTCOME_SWEEP_KINDS, AcceptedInteractionOutcomeBucketReport, AcceptedInteractionOutcomeReport, AcceptedInteractionOutcomeSample, AcceptedInteractionOutcomeSource, bucketFor(), buildAcceptedInteractionOutcomeReport(), ClassifiedRow (+15 more)

### Community 251 - "scheduler-lease.ts"
Cohesion: 0.14
Nodes (25): PLUGIN_HOLDER_FORWARDED_HEADER, registerPluginHolderForwardRoutes(), recordSchedulerLeaseState(), SCHEDULER_LEASE_HELD_METRIC, acquireSchedulerLease(), firstRow(), HEARTBEAT_TIMER_LEASE, LeaseDb (+17 more)

### Community 252 - "pr-review-state-reconciler.ts"
Cohesion: 0.12
Nodes (23): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+15 more)

### Community 253 - "agent-test-environment-routes.test.ts"
Cohesion: 0.15
Nodes (12): createApp(), externalAdapter, mockAccessService, mockAgentService, mockEnvironmentRuntime, mockEnvironmentService, mockInstanceSettingsService, mockReleaseRunLease (+4 more)

### Community 254 - "document-annotation-routes.test.ts"
Cohesion: 0.17
Nodes (10): annotationComment, annotationThread, createApp(), documentPayload, mockAnnotationService, mockDocumentService, mockHeartbeatService, mockIssueReferenceService (+2 more)

### Community 255 - "external-object-routes.test.ts"
Cohesion: 0.18
Nodes (7): createApp(), makeIssue(), mockAccessService, mockAgentService, mockExternalObjectsService, mockInstanceSettingsService, mockIssueService

### Community 256 - "issue-activity-events-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), defaultBoardActor, mockAccessService, mockFeedbackService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockLogActivity (+1 more)

### Community 257 - "isPlainRecord"
Cohesion: 0.15
Nodes (35): asBoolean(), asString(), buildManifestFromPackageFiles(), buildPortableCatalogProvenance(), buildPortableProjectWorkspaces(), buildSkillSourceEntry(), buildYamlFile(), clonePortableRecord() (+27 more)

### Community 258 - "middleware/index.ts"
Cohesion: 0.03
Nodes (61): createApp(), mockBumpAgentImagesForCompany, createApp(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService (+53 more)

### Community 259 - "project-goal-telemetry-routes.test.ts"
Cohesion: 0.18
Nodes (9): mockAccessService, mockEnvironmentService, mockGetTelemetryClient, mockGoalService, mockLogActivity, mockProjectService, mockSecretService, mockTelemetryTrack (+1 more)

### Community 260 - "routine-document-annotation-routes.test.ts"
Cohesion: 0.17
Nodes (10): annotationComment, annotationThread, createApp(), descriptionDocument, mockAnnotationService, mockLogActivity, mockRoutineService, routine (+2 more)

### Community 261 - "summary-slot-routes.test.ts"
Cohesion: 0.17
Nodes (9): agentActor, boardActor, createApp(), mockAccessService, mockHeartbeatWakeup, mockInstanceSettingsService, mockLogActivity, mockSummarySlotService (+1 more)

### Community 262 - "ccrotate-state-hook.ts"
Cohesion: 0.40
Nodes (9): adapterToTarget(), doExport(), doImport(), exitWith(), loadPluginIdOrExit(), PersistedSnapshot, readSnapshot(), runCcrotate() (+1 more)

### Community 263 - "exportBundle"
Cohesion: 0.11
Nodes (20): buildEnvInputMap(), buildOrgTreeFromManifest(), classifyPortableFileKind(), collectRedactedPaths(), exportBundle(), previewExport(), dedupeEnvInputs(), extractPortableEnvInputs() (+12 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.11
Nodes (27): versionMaterialHasValueDigest(), assertSecretRefBinding(), coerceLegacySecretRef(), countUuidValues(), createPluginSecretsHandler(), authorizeBoundSecret(), lookupBinding(), resolveBoundSecret() (+19 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "workspace-reuse-refusal-class.ts"
Cohesion: 0.11
Nodes (24): setWorkspaceReuseRefusalMetricsRefreshSuccess(), setWorkspaceReuseRefusalWindowMetrics(), WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, compareProjectCheckoutOrigin(), normalizeRepoIdentity(), ProjectCheckoutOriginVerdict, classifyWorkspaceReuseRefusal() (+16 more)

### Community 267 - "branch-run-claims.ts"
Cohesion: 0.18
Nodes (14): acquireBranchRunClaim(), BranchClaimConflictError, BranchClaimReadDb, BranchRunClaim, canonicalizeGitRemoteIdentity(), computeBranchClaimKey(), getHeartbeatRunState(), isConstraintConflict() (+6 more)

### Community 268 - "http-metrics-transient-db-sqlstate.test.ts"
Cohesion: 0.05
Nodes (48): composeRouteLabel(), httpMetricsMiddleware(), InstrumentableResponse, INSTRUMENTED, isApiPath(), isEmptyListBody(), TRANSIENT_DB, TransientDbResponseTag (+40 more)

### Community 269 - "dev-runner-snapshot.test.ts"
Cohesion: 0.33
Nodes (3): readdirSync(), statSync(), tempRoots

### Community 270 - "company-branding-route.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService, mockCompanyPortabilityService, mockCompanyService, mockFeedbackService (+1 more)

### Community 271 - "badRequest"
Cohesion: 0.04
Nodes (54): badRequest(), parseRunCreatedAtWindow(), assertInstanceAdmin(), activationEntityTypeBody(), cloudUpstreamRoutes(), optionalString(), stringBody(), stringQuery() (+46 more)

### Community 272 - "issue-comment-effects.ts"
Cohesion: 0.11
Nodes (32): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+24 more)

### Community 273 - "invite-accept-existing-member.test.ts"
Cohesion: 0.20
Nodes (6): accessServiceMock, ACTIVE_INVITE_EXPIRES_AT, createApp(), createAppWithActor(), logActivityMock, QueryHooks

### Community 274 - "issue-closed-workspace-routes.test.ts"
Cohesion: 0.15
Nodes (9): assigneeAgentActor, boardActor, createApp(), mockAccessService, mockExecutionWorkspaceService, mockHeartbeatService, mockIssueService, mockLogActivity (+1 more)

### Community 275 - "project-routes-env.test.ts"
Cohesion: 0.18
Nodes (8): createApp(), mockAccessService, mockEnvironmentService, mockGetTelemetryClient, mockLogActivity, mockProjectService, mockSecretService, mockWorkspaceOperationService

### Community 276 - "model-profile-hint.ts"
Cohesion: 0.11
Nodes (27): isPlanningOnlyRecoveryContextSnapshot(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS, RECOVERY_MODEL_PROFILE_KEY, RECOVERY_WORK_CLASS_KEY (+19 more)

### Community 277 - "plugin-metric-exposition.test.ts"
Cohesion: 0.10
Nodes (22): PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_DURATION_BUCKETS_SECONDS, PLUGIN_METRIC_DURATION_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+14 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "terminal-gate-reconciler.ts"
Cohesion: 0.07
Nodes (40): ISSUE_MONITOR_DISPATCH_WATCHDOG_GATE_PREFIX, adjudicableGateSignals(), armedMonitorNextCheckAt(), buildTerminalGateHumanOnlyComment(), buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler, gateSignalDigest() (+32 more)

### Community 280 - "cases-routes.test.ts"
Cohesion: 0.12
Nodes (17): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+9 more)

### Community 281 - "routes/approvals.ts"
Cohesion: 0.03
Nodes (99): AgentWorkspaceCommandViewer, ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext(), requireApprovalAccess(), resolveBoardEscalationCoalesceKey() (+91 more)

### Community 282 - "workspace-dir-claim.ts"
Cohesion: 0.16
Nodes (23): acquireWorkspaceDirClaim(), ClaimOwnerLiveness, classifySettledClaimAfterLostRace(), classifyWorkspaceDirClaim(), describeWorkspaceDirClaimRefusal(), electClaimSuccessor(), errnoOf(), formatWorkspaceDirClaim() (+15 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 285 - "agent-inbox-lite.ts"
Cohesion: 0.07
Nodes (33): issueListProbeLimit(), resolveIssueListTruncation(), AGENT_INBOX_LITE_STATUS_FILTER, AgentInboxLiteInput, InboxIssue, IssuesService, loadAgentInboxLite(), RecoveryActionsService (+25 more)

### Community 286 - "approvals-service.test.ts"
Cohesion: 0.09
Nodes (12): ApprovalRecord, expectRejectedWithoutMutation(), mockAgentService, mockLogActivity, mockNotifyHireApproved, readStatus(), withdrawalActor, candidate() (+4 more)

### Community 287 - "approval-payload-edit-routes.test.ts"
Cohesion: 0.12
Nodes (12): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockGetPullRequestGate, mockGetWorkflowRun, mockHeartbeatService (+4 more)

### Community 288 - "companyPortabilityService"
Cohesion: 0.09
Nodes (33): applySelectedFilesToSource(), collectAgentSafeImportPolicyErrors(), companyPortabilityService(), applyImportedAgentPermissionGrants(), assertImportAdapterConfigConstraints(), assertKnownImportAdapterType(), buildPreview(), importBundle() (+25 more)

### Community 289 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.05
Nodes (31): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, isDeliberateParkActive(), isIssueParkExpiryWakeStatus(), ISSUE_PARK_EXPIRED_WAKE_REASON, ISSUE_PARK_EXPIRY_WAKE_STATUSES, IssueParkExpiryWakeStatus, IssueParkReleaseInput, readMs() (+23 more)

### Community 290 - "environmentRoutes"
Cohesion: 0.13
Nodes (18): environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment(), environmentDeleteBlockMessage(), logEnvironmentCustomImageActivity() (+10 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.11
Nodes (4): PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, mockAdapterExecute

### Community 292 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "github-api-refusal-metric.test.ts"
Cohesion: 0.10
Nodes (15): GITHUB_API_HELD_METRIC, GITHUB_API_REFUSALS_METRIC, GITHUB_API_REQUESTS_BY_ROUTE_METRIC, GITHUB_API_REQUESTS_METRIC, KNOWN_GITHUB_API_REFUSAL_REASONS, KNOWN_GITHUB_API_REFUSAL_RESOURCES, OTHER_GITHUB_API_REFUSAL_RESOURCE, UNKNOWN_GITHUB_API_REFUSAL_RESOURCE (+7 more)

### Community 295 - "built-in-agent-routes.test.ts"
Cohesion: 0.18
Nodes (8): allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService, mockInstanceSettingsService, mockLogActivity, stateWithMetadata()

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "agent-scope-pinned-config-keys-routes.test.ts"
Cohesion: 0.10
Nodes (15): createApp(), hire(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity (+7 more)

### Community 298 - "run-secret-redaction.ts"
Cohesion: 0.10
Nodes (26): compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan(), characterClassCount() (+18 more)

### Community 299 - "agent-live-run-routes.test.ts"
Cohesion: 0.12
Nodes (10): createApp(), mockAccessDecide, mockAgentService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockWorkspaceOperationService (+2 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (22): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+14 more)

### Community 302 - "redact-sensitive.ts"
Cohesion: 0.29
Nodes (9): isSensitiveContainerKey(), isSensitiveKey(), isUrlishKey(), redactContainer(), redactSensitive(), SENSITIVE_CONTAINER_KEYS, SENSITIVE_KEYS, stripSecretBearingUrlParts() (+1 more)

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.05
Nodes (19): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets(), AgentRow, CompanyRow (+11 more)

### Community 304 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 305 - "ccrotate-capacity-retry.ts"
Cohesion: 0.03
Nodes (82): CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MAX_PARK_MS, CCROTATE_CAPACITY_MIN_PARK_MS (+74 more)

### Community 306 - "zoned-cron.ts"
Cohesion: 0.12
Nodes (23): assertTimeZone(), isSubHourlyCronExpression(), nextCronTickInTimeZone(), buildCronMask(), CronMask, daysInMonth(), getZonedMinuteFormatter(), getZonedMinuteParts() (+15 more)

### Community 307 - "asNumber"
Cohesion: 0.16
Nodes (21): asBoolean, asNumber, countRunsOccupyingSlots(), EXTERNAL_LIFECYCLE_ADAPTERS, hasExternalLifecycleAdapter(), isRunOccupyingSlot(), normalizeMaxConcurrentRuns(), resolveAgentConcurrencyPolicy() (+13 more)

### Community 308 - "zero-token-startup-failure.ts"
Cohesion: 0.13
Nodes (21): sessionUnavailableAdapterMismatch(), DETERMINISTIC_SKILL_FAILURE_ERROR_CODE, EXTERNAL_WAIT_YIELD_ERROR_CODE, isExternalWaitYieldRun(), isInfraClassErrorCodeRun(), isInfraFailureRun(), isLegacySessionUnavailableAdapterFailure(), isLegacySessionUnavailableAdapterMismatch() (+13 more)

### Community 309 - "builtInAgentService"
Cohesion: 0.12
Nodes (49): builtInAgentService(), autoProvisionBundledAgents(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), defaultProvisionInput(), ensure(), ensureAgentDefaultGrants() (+41 more)

### Community 310 - "cpu-profile.ts"
Cohesion: 0.19
Nodes (18): CPU_PROFILE_EXTENSION, CPU_PROFILE_SENTINEL_BASENAME, CpuProfile, CpuProfileSummary, maybeDumpStallFlightRecording(), maybeTakeCpuProfile(), onRecorder(), postTo() (+10 more)

### Community 311 - "recovery-stale-issue-lock-sweep.test.ts"
Cohesion: 0.10
Nodes (8): AGENT_POD_BUSY_MAX_STALE_MS, NON_LIVE_EXECUTION_SILENCE_MS, LOCKLESS_DEFERRED_WAKE_MIN_AGE_MS, STALE_RUNNING_ISSUE_LOCK_MS, mockProbeAgentPodActivity, mockTelemetryClient, seedDeclaredAndUndeclared(), seedStrandedPromotion()

### Community 312 - "plugin-event-bus.ts"
Cohesion: 0.11
Nodes (12): createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus, Subscription (+4 more)

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "issue-update-comment-wakeup-routes.test.ts"
Cohesion: 0.12
Nodes (19): commentEffectLedger, createApp(), drizzleTableName, lastSelectedTable, ledgerRows, makeIssue(), mockCommentEffects, mockGetActiveCompanyMembership (+11 more)

### Community 315 - "isolation-reclaim-self.ts"
Cohesion: 0.21
Nodes (15): imageRepositoryOf(), mountCoversPath(), readInClusterReclaimSelfPodIdentity(), readReclaimSelfPodIdentity(), ReadReclaimSelfPodIdentityOptions, ReclaimSelfPodIdentity, ReclaimSelfPodIdentityResult, resolveSelfDataClaimName() (+7 more)

### Community 316 - "config"
Cohesion: 0.11
Nodes (17): withPublicIssueWorkspaceSettings(), publicIssueExecutionWorkspaceSettings(), WITHHELD_WORKSPACE_RUNTIME_VIEWER, describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest() (+9 more)

### Community 317 - "evidence-truth.ts"
Cohesion: 0.11
Nodes (20): buildGithubTruthProbe(), GithubTruthDeps, LinkedPrRefs, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr, PROBE_DEADLINE_MS (+12 more)

### Community 318 - "process-crash-guard-exit.test.ts"
Cohesion: 0.14
Nodes (12): MAX_WRITE_WAIT_MS, CrashResult, fixture, here, LATE_BACKPRESSURE_RUN, PREFILL_RUN, readRemainingStderr(), runFixtureWithStalledStderr() (+4 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "pod-log-sweeper.ts"
Cohesion: 0.16
Nodes (14): createDbRunStatusLookup(), isReapablePodLogPath(), listDir(), Logger, POD_LOG_MAX_DELETES_PER_TICK, POD_LOG_RETENTION_MS, POD_LOG_SWEEP_NOT_BEFORE, podLogDirs() (+6 more)

### Community 321 - "heartbeat-zombie-guard.test.ts"
Cohesion: 0.13
Nodes (13): describeIntervalOverrunCoalesceBypass(), filterIntervalOverrunCoalesceTarget(), filterZombieCoalesceTarget(), isCoalesceTargetPastHeartbeatInterval(), isZombieRun(), resolveStalledCoalesceBudgetMs(), STALLED_COALESCE_BYPASS_SNAPSHOT_KEY, STALLED_COALESCE_INTERVAL_MULTIPLE (+5 more)

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "attachment-types.ts"
Cohesion: 0.14
Nodes (13): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isAllowedContentType(), isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES (+5 more)

### Community 324 - "services/index.ts"
Cohesion: 0.03
Nodes (72): approveHumanJoinRequestFromInvite(), assertHireSourceIssueLinksAllowed(), assertIssueLinksAllowed(), AccessDecider, evaluateAgentIssueApprovalLinkAuthorization(), evaluateTaskWatchdogSubtreeScope(), isCreatorOrManagerChainDecision(), isCurrentIssueExecutionRun() (+64 more)

### Community 325 - "zodToOpenApiSchema"
Cohesion: 0.43
Nodes (7): applyNumberChecks(), applyStringChecks(), isOptionalSchema(), parametersFromSchema(), pipeInner(), unwrapSchema(), zodToOpenApiSchema()

### Community 326 - "openrouter/execute.ts"
Cohesion: 0.13
Nodes (17): AGENT_TOOLS, callOpenRouter(), ChatMessage, execAsync, execute(), executeToolCall(), walk(), sanitize() (+9 more)

### Community 327 - "company-export-readme.ts"
Cohesion: 0.43
Nodes (6): generateOrgChartMermaid(), generateReadme(), mermaidEscape(), mermaidId(), ROLE_LABELS, skillSourceLabel()

### Community 328 - "environment-capabilities-k8s.test.ts"
Cohesion: 0.11
Nodes (17): createApp(), currentActor, mockAccessService, mockAgentService, mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService (+9 more)

### Community 329 - "collectEvidence"
Cohesion: 0.11
Nodes (33): choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), deliberateParkWindow(), deliberatePendingMonitor(), dominantErrorCode(), isDominantEpisodeShare(), isMonitorSuppressionActor() (+25 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.08
Nodes (32): basenameOf(), COMMAND_PREFIXES, findMissingHookCommandPaths(), HookCommandAuditDeps, HookCommandAuditFinding, INCLUDE_DIR_OPERAND_OPTIONS, isAbsoluteLiteral(), isScriptInterpreter() (+24 more)

### Community 331 - "fd-class-metrics.ts"
Cohesion: 0.12
Nodes (22): boundedDirLabel(), boundedSegment(), classifyFdTarget(), CollectFdClassOptions, collectFdClassSnapshot(), FD_CLASS_MAX_ENTRIES, FD_CLASS_MAX_SEGMENT_CHARS, FD_CLASS_MAX_SERIES (+14 more)

### Community 332 - "boardAuthService"
Cohesion: 0.13
Nodes (23): boardApiKeyExpiresAt(), boardAuthService(), approveCliAuthChallenge(), assertCurrentBoardKey(), cancelCliAuthChallenge(), createCliAuthChallenge(), createNamedBoardApiKey(), createServiceAccountBoardKey() (+15 more)

### Community 333 - "pluginCapabilityValidator"
Cohesion: 0.06
Nodes (19): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, CapabilityScopedInvoker, DEFAULT_GLOBALS (+11 more)

### Community 334 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 335 - "orphaned-run-terminal-result.ts"
Cohesion: 0.18
Nodes (13): locatePodLogArtifact(), OrphanedRunTerminalResult, readOptionalString(), readOrphanedRunTerminalResult(), readTerminalResult(), resultEventReportsSuccess(), runLogBasePath(), TERMINAL_RESULT_READ_DEADLINE_MS (+5 more)

### Community 336 - "setupEnvironmentCustomImageTerminalWebSocketServer"
Cohesion: 0.12
Nodes (13): clientSafeErrorMessage(), closeClient(), createSsh2EnvironmentCustomImageSshConnector(), EnvironmentCustomImageSshConnector, errorStatus(), handleClientFrame(), parseTerminalDimension(), parseTerminalPath() (+5 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.20
Nodes (8): INSTANCE_ROOT_ARTIFACT_STORE_ENV_VARS, require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance, viWithPatchFlag, WaitForOptions

### Community 338 - "teams-catalog-routes.test.ts"
Cohesion: 0.25
Nodes (5): createApp(), mockAccessService, mockAgentService, mockCatalogModule, mockTeamsCatalogService

### Community 339 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (19): PROVIDER_CAPACITY_MAX_HORIZON_MS, createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile() (+11 more)

### Community 340 - "approval-queue-metrics.test.ts"
Cohesion: 0.15
Nodes (10): BOARD_DECISION_STATUSES, MERGE_GATE_DECISION, PENDING_SINCE, refreshApprovalQueueMetrics(), APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, APPROVAL_OLDEST_PENDING_AGE_METRIC, APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC, APPROVALS_PENDING_METRIC (+2 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.60
Nodes (5): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance()

### Community 343 - "gbrain-client-factory.test.ts"
Cohesion: 0.20
Nodes (7): BearerSource, createServerGbrainClient(), NullBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 344 - "zoned-cron-equivalence.test.ts"
Cohesion: 0.12
Nodes (22): ZONED_CRON_SEARCH_MAX_AFTER_MS, ZONED_CRON_SEARCH_MIN_AFTER_MS, assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute(), nextCronTickInTimeZone() (+14 more)

### Community 345 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.05
Nodes (33): resolveDefaultSecretsKeyFilePath(), awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider, asLocalEncryptedMaterial() (+25 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.13
Nodes (18): listSuccessfulRunHandoffStates(), findAcceptedPlanDocumentInteraction(), isTreeHoldInteractionCheckoutAllowed(), listSuccessfulRunHandoffMapForIssues(), readAcceptedPlanConfirmationTarget(), readStringFromRecord(), readSuccessfulRunHandoffFromActivity(), resolveResponsibleUserIdForIssueCreate() (+10 more)

### Community 348 - "agent-pinned-config-keys-survive-heartbeat-mock.test.ts"
Cohesion: 0.12
Nodes (15): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockHeartbeatTotally(), mockLogActivity (+7 more)

### Community 349 - "__tests__/evidence-gate.test.ts"
Cohesion: 0.13
Nodes (12): EvaluateEvidenceInput, EvaluateEvidenceResult, EvidenceWorkProductLite, ALLY_CLEAN, DEFAULT_EVIDENCE_REGISTRY, DEFAULT_UNLABELED_REQUIRED, EvidenceRegistry, EvidenceRegistryEntry (+4 more)

### Community 350 - "cli-auth-routes.test.ts"
Cohesion: 0.29
Nodes (5): createApp(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity

### Community 352 - "docker-entrypoint.test.ts"
Cohesion: 0.47
Nodes (5): ENTRYPOINT, execFileAsync, installStubs(), runEntrypoint(), writeStub()

### Community 353 - "heartbeat-issue-liveness-escalation.test.ts"
Cohesion: 0.11
Nodes (14): BACKSTOP_CANDIDATES_SKIPPED_METRIC, BACKSTOP_SWEEP_COMPLETED_METRIC, ABANDONED_LIVENESS_RECOVERY_MARKER, DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS, DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS, STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER, enableAutoRecovery() (+6 more)

### Community 354 - "pipeline-case-outputs.ts"
Cohesion: 0.20
Nodes (18): contentPath(), contextFetchHint(), DELIVERABLE_TITLE_PATTERNS, deliverableDocumentRank(), downloadPath(), formatPipelineCaseOutputContextMarkdown(), normalizePreviewText(), outputSortGroup() (+10 more)

### Community 355 - "foreign-commit-notice.ts"
Cohesion: 0.18
Nodes (17): AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), buildForeignCommitNoticeBody(), CommitAuthorRef, CommitSkipReason, ForeignCommit, foreignCommitNoticeIdempotencyKey(), ForeignCommitSelection (+9 more)

### Community 356 - "issue-comment-effect-outbox-routes.test.ts"
Cohesion: 0.12
Nodes (13): BOARD_ACTOR, CommentEffectProcessor, createApp(), ledger, LedgerRow, mockCommentEffects, mockGetActiveCompanyMembership, mockHeartbeatService (+5 more)

### Community 357 - "pipelines-service.test.ts"
Cohesion: 0.13
Nodes (15): loadPipelineDescendantActiveWorkCounts(), PIPELINE_CASE_EVENTS_MAX_LIMIT, PIPELINE_CONTEXT_PACK_EVENT_LIMIT, PipelineActor, app(), plantedStageConfig(), seedCarrier(), seedCompany() (+7 more)

### Community 358 - "issue-liveness.test.ts"
Cohesion: 0.31
Nodes (7): waiting(), blockedBlocker(), blocks, deadEnd(), issue(), manager, monitorOnlyIssue()

### Community 359 - "approval-create-issue-link-authorization.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 360 - "pull-request-work-products.ts"
Cohesion: 0.07
Nodes (30): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestHasMerged() (+22 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "approval-link-requested-by-self.test.ts"
Cohesion: 0.12
Nodes (12): attachViaCreateRoute(), attachViaLinkRoute(), createApp(), createRouteDb(), mockAccessService, mockAgentService, mockApprovalService, mockHeartbeatService (+4 more)

### Community 363 - "dev-watch-ignore.ts"
Cohesion: 0.70
Nodes (3): addIgnorePath(), resolveServerDevWatchIgnorePaths(), toGlobstarPath()

### Community 364 - "getActiveSession"
Cohesion: 0.17
Nodes (18): assertNamedGatewayProtocolLimit(), assertSessionRunIsActive(), consumeProtocolRateLimit(), findGatewayForProtocolLocator(), getActiveSession(), namedGatewaySessionFromBearer(), normalizeGatewayTokenActions(), protocolLimiterKeyClass() (+10 more)

### Community 365 - "approval-link-route-equivalence.test.ts"
Cohesion: 0.13
Nodes (12): attachViaCreateRoute(), attachViaLinkRoute(), createApp(), createRouteDb(), mockAccessService, mockAgentService, mockApprovalService, mockHeartbeatService (+4 more)

### Community 366 - "applyDocumentFixups"
Cohesion: 0.60
Nodes (5): applyDocumentFixups(), applyOperationStatusOverride(), isBoardOnlyOperation(), operationKey(), resolveOperationAuthLevel()

### Community 367 - "run-log-store.test.ts"
Cohesion: 0.13
Nodes (17): readExternalLifecycleProviderCapacityRefusal(), parseProviderCapacityResetHorizon(), resolveProviderCapacityHorizon(), isRunLogUnwritableError(), begin, findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs() (+9 more)

### Community 368 - "agent-profile-change-gate-mixing.test.ts"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity, mockSecretService (+3 more)

### Community 369 - "approval-agent-config-authz-routes.test.ts"
Cohesion: 0.12
Nodes (17): boardActor, createAppWithActor(), createRouteDb(), decideAsConfiguringPeer(), decideBy(), decideWithAgentConfigRead(), expectCommandsWithheld(), mockAccessService (+9 more)

### Community 370 - "done-gate.ts"
Cohesion: 0.60
Nodes (3): DoneGateInput, hasPrLinkEvidence(), shouldBlockNarratedDone()

### Community 371 - "heartbeat-stale-queue-invalidation.test.ts"
Cohesion: 0.21
Nodes (9): mockAdapterExecute, resumeContinuationRetry(), seedCompanyAndAgent(), seedContinuationSummary(), SeedOptions, seedParkedContinuationRetry(), seedQueuedRun(), SeedResult (+1 more)

### Community 372 - "plugin-config-write-race.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), createRaceDb(), acquireAdvisoryLock(), deferred(), mockSecretService, registryFor, store, TxHandle

### Community 373 - "authorization-service.test.ts"
Cohesion: 0.24
Nodes (9): AuthorizationActor, buildFixture(), createAgent(), createCompany(), createIssue(), createProject(), grantAgentPermission(), IssueAction (+1 more)

### Community 374 - "routine-fire-gap-metrics.test.ts"
Cohesion: 0.10
Nodes (21): PROCESS_MAPPING_COUNT_METRIC, ROUTINE_DISPATCH_METRIC, ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC, ROUTINE_FIRE_INTERVAL_METRIC, ROUTINE_LAST_DONE_FIRE_AGE_METRIC, ROUTINE_LAST_FIRE_START_AGE_METRIC, setRoutineFireGapMetrics(), setRoutineFireGapMetricsRefreshSuccess() (+13 more)

### Community 375 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.19
Nodes (15): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat() (+7 more)

### Community 376 - "plugin-environment-driver.ts"
Cohesion: 0.23
Nodes (19): createPluginEnvironmentDriver(), resolvePluginDriver(), resolvePluginDriverForRelease(), pluginDriverProviderKey(), tryParseCurrentPluginConfig(), cancelPluginEnvironmentInteractiveSetup(), capturePluginEnvironmentTemplate(), deletePluginEnvironmentTemplate() (+11 more)

### Community 377 - "agent-budget-mirror-write.test.ts"
Cohesion: 0.14
Nodes (13): agentActor, agentRow, baseAgent, boardActor, createApp(), createDbStub(), mockAccessService, mockAgentService (+5 more)

### Community 378 - "graceful-shutdown-exit.test.ts"
Cohesion: 0.40
Nodes (4): fixture, here, serverRoot, tsx

### Community 379 - "invite-create-route.test.ts"
Cohesion: 0.60
Nodes (4): createApp(), createDbStub(), logActivityMock, registerModuleMocks()

### Community 380 - "issue-comment-unkeyed-outbox-routes.test.ts"
Cohesion: 0.11
Nodes (14): BOARD_ACTOR, CommentEffectProcessor, createApp(), ledger, LedgerRow, mockCommentEffects, mockGetActiveCompanyMembership, mockHeartbeatService (+6 more)

### Community 381 - "claude-code-version.test.ts"
Cohesion: 0.18
Nodes (13): CLAUDE_CODE_EXACT_VERSION_RE, CLAUDE_CODE_RUNTIME_FROM_IMAGE, CLAUDE_CODE_VERSION_CONFIG_KEY, ClaudeCodeVersionPreviousScope, findInadmissibleClaudeCodeVersion(), InadmissibleClaudeCodeVersion, introducesClaudeCodeVersion(), isAdmissibleClaudeCodeVersion() (+5 more)

### Community 382 - "mcp-seed-scrub-coverage.test.ts"
Cohesion: 0.14
Nodes (10): Coverage, EntryShape, jobManifestPath, repoRoot, resolveEntryShapes(), SCRUBBING_GATEWAY_HOSTS, SEED_COVERAGE, SeedEntry (+2 more)

### Community 383 - "stacked-pr-auto-retarget.test.ts"
Cohesion: 0.17
Nodes (10): buildApp(), linkPullRequest(), mockListOpenPrsByBase, mockResolveBranchState, mockResolveMergedBase, mockResolveMergeShape, post(), seedCompany() (+2 more)

### Community 384 - "file"
Cohesion: 0.12
Nodes (13): Access, Exactly, GrantRow, ListedMemberRow, MemberRow, file(), ALLOWED_READERS, filesNaming() (+5 more)

### Community 385 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 386 - "workspace-dir-claims.ts"
Cohesion: 0.24
Nodes (15): claimBodySchema, DEFAULT_CLAIM_ROOTS, isInsideRootInclusive(), isStrictlyInsideRoot(), realRoots(), refuseUnresolvablePath(), releaseBodySchema, resolveWorkspaceClaimRoots() (+7 more)

### Community 387 - "issue-monitor-scheduler.test.ts"
Cohesion: 0.12
Nodes (11): ISSUE_MONITOR_DISPATCH_LAPSE_MS, ISSUE_MONITOR_DISPATCH_WATCHDOG_MAX_WAIT_MS, ISSUE_MONITOR_LIVE_CONSUMER_MAX_AGE_MS, ISSUE_MONITOR_TRIGGERED_STALL_GRACE_MS, cleanupRows(), createHeartbeatWithClaimRace(), heartbeatSideEffectFingerprint(), notPreDispatchExclusion (+3 more)

### Community 388 - "key"
Cohesion: 0.14
Nodes (13): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), key(), findWakeIdempotencyReceipt() (+5 more)

### Community 389 - "taskWatchdogService"
Cohesion: 0.23
Nodes (14): buildStoppedFingerprintComment(), isWatchdogReviewDisposition(), stoppedFingerprintMetadata(), taskWatchdogService(), ensureReusableWatchdogIssue(), evaluateWatchdog(), findTaskWatchdogIssue(), hasLivePathForIssue() (+6 more)

### Community 390 - "readPenstockCapacity"
Cohesion: 0.26
Nodes (11): capacityEndpointUnavailable(), defaultCapacityRetry(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger (+3 more)

### Community 391 - "chain-pass-timing.ts"
Cohesion: 0.17
Nodes (9): createRecoveryChainTimer(), RECOVERY_CHAIN_PASS_TIMING_MESSAGE, RECOVERY_CHAIN_TIMING_MESSAGE, RecoveryChainPassOutcome, RecoveryChainPassRecord, RecoveryChainTimer, RecoveryChainTimerOptions, harness() (+1 more)

### Community 392 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 393 - "requestApprovalForRecordedToolCall"
Cohesion: 0.17
Nodes (16): backfillPendingActionRequestSignature(), assertGatewayTokenAction(), connectedCredentialVersionSnapshots(), connectedRemoteApprovalSnapshot(), credentialVersionRefHash(), requestApprovalForRecordedToolCall(), requestElicitationForRecordedToolCall(), runTestToolInvocation() (+8 more)

### Community 394 - "heartbeat-workspace-finalize-branch.test.ts"
Cohesion: 0.14
Nodes (8): adapterExecute, createGitRepo(), Db, drainInFlightExecutions(), execFileAsync, Heartbeat, runGit(), seedRunTarget()

### Community 395 - "createToolGatewayService"
Cohesion: 0.07
Nodes (67): asRecord(), auditSafeEndpoint(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions(), assertAgentInCompany(), assertGatewayContext() (+59 more)

### Community 396 - "PluginWorkerHandle"
Cohesion: 0.15
Nodes (4): PluginWorkerHandle, ApiTierPluginWorkerError, createApiTierPluginWorkerManagerStub(), WorkerDiagnostics

### Community 399 - "docker-onboard-smoke-contract.test.ts"
Cohesion: 0.50
Nodes (3): repoRoot, smokeScript, smokeWorkflow

### Community 401 - "approval-payload-title-guard.test.ts"
Cohesion: 0.29
Nodes (10): findPayloadProperty(), isApprovalsInsertValuesCall(), listSourceFiles(), objectHasTitleKey(), payloadObjectLiteralsOf(), propertyNameIs(), scanFile(), visit() (+2 more)

### Community 402 - "openclaw-invite-prompt-route.test.ts"
Cohesion: 0.25
Nodes (8): createApp(), createDbStub(), createSelectChain(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity, mockStorage

### Community 403 - "tool-access-service.test.ts"
Cohesion: 0.15
Nodes (6): createBrokerConnection(), createOAuthConnection(), createRouteApp(), mcpHttpResponse(), mcpSseResponse(), mockToolsList()

### Community 404 - "documentAnnotationService"
Cohesion: 0.12
Nodes (9): ActorInput, CaseDocumentRow, commentSelect, documentAnnotationService(), assertLinkedIssueComment(), IssueDocumentRow, RoutineDocumentRow, snapshotFromThread() (+1 more)

### Community 406 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.13
Nodes (9): createDb(), createSelectChain(), then(), values(), chartDir, BUDGET_PATH, readNumber(), readValuesInt() (+1 more)

### Community 409 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 410 - "issue-list-assignee-filter-routes.test.ts"
Cohesion: 0.17
Nodes (7): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, createApp(), seedCloudTenantMember(), createApp(), seedFixture()

### Community 411 - "isolation-reclaim-job-port.ts"
Cohesion: 0.22
Nodes (8): createInClusterIsolationReclaimJobPort(), createIsolationReclaimJobPort(), IsolationReclaimJobPortClients, RECLAIM_JOB_NAME_LABEL, RECLAIM_PORT_LOG_TIMEOUT_MS, RECLAIM_PORT_REQUEST_TIMEOUT_MS, Recorded, STATUS_SHAPES

### Community 412 - "issueRecoveryActionService"
Cohesion: 0.22
Nodes (11): issueRecoveryActionService(), dischargeActionsWithRestoredExecution(), escalateExpiredWakeHorizons(), getActiveForIssue(), getById(), listActiveForIssues(), resolveActiveForIssue(), retireWakeAction() (+3 more)

### Community 413 - "live-events.ts"
Cohesion: 0.08
Nodes (17): HeartbeatEnvironmentRuntime, emitter, LiveEventListener, LiveEventPayload, publishGlobalLiveEvent(), subscribeCompanyLiveEvents(), toLiveEvent(), captureActivityEvents() (+9 more)

### Community 421 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.18
Nodes (4): blocked(), humanGatedAgeingProducer, collect(), NOW

### Community 425 - "issue-tree-hold-metrics.ts"
Cohesion: 0.21
Nodes (12): ActivePauseHoldRow, activePauseHoldsGauge(), AGE_BUCKETS, AgeBucket, countActivePauseHolds(), ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC, IssueTreeHoldCollectorOptions, setActivePauseHolds() (+4 more)

### Community 426 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 427 - "pipeline-stage-workspace-runtime-authz.test.ts"
Cohesion: 0.14
Nodes (11): AGENT_ACTOR, BOARD_ACTOR, createPipelineApp(), MASKED_ECHO, mockAccessService, mockDb, mockLogActivity, mockPipelineService (+3 more)

### Community 428 - "dev-runner-worktree.ts"
Cohesion: 0.29
Nodes (10): bootstrapDevRunnerWorktreeEnv(), expandHomePrefix(), isLinkedGitWorktreeCheckout(), parseEnvFile(), repairStaleMigratedWorktreeEnvEntries(), resolveDefaultWorktreeHome(), resolveHomeAwarePath(), resolveWorktreeEnvFilePath() (+2 more)

### Community 431 - "ac-policy-sweep.ts"
Cohesion: 0.24
Nodes (11): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+3 more)

### Community 433 - "scrape-metrics-collector.test.ts"
Cohesion: 0.15
Nodes (9): DB, refreshAcceptedInteractionOutcomeMetrics, refreshApprovalQueueMetrics, refreshDeferredIssueExecutionWakeAgeMetrics, refreshExternalRuntimeReservationMetrics, refreshExternalRuntimeReservationStrandMetrics, refreshOverdueScheduledRetryAgeMetrics, refreshQueuedRunAgeMetrics (+1 more)

### Community 437 - "trust-proxy.ts"
Cohesion: 0.36
Nodes (7): RFC-4291, applyTrustProxy(), isValidSubnetToken(), NAMED_SUBNETS, parseTrustProxyEnv(), TrustProxyValue, appWithEnv()

### Community 438 - "backfill-agent-bundle.ts"
Cohesion: 0.23
Nodes (11): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+3 more)

### Community 442 - "github-fetch.ts"
Cohesion: 0.08
Nodes (36): abortFailure(), classifyGithubApiRoute(), classifyGithubRefusal(), classifyGithubRefusalResource(), countGithubApiAttempt(), countGithubApiHeld(), countGithubRefusal(), GITHUB_FETCH_DEADLINE_MS (+28 more)

### Community 446 - "fetchIssueSearchData"
Cohesion: 0.19
Nodes (13): activeIssueFilters(), enrichIssueSnippets(), fetchIssueSearchData(), flagFuzzyMatch(), flagScopeCondition(), flagTextMatch(), emptyFilterOptionCounts(), matchedFacetConditions() (+5 more)

### Community 447 - "heartbeat-reviewer-evidence-live-head.test.ts"
Cohesion: 0.21
Nodes (9): _resetInstallationTokenCache(), FakeReview, graphQlReviewsEnvelope(), h, isReviewsQuery(), jsonResponse(), PRIVATE_KEY_PEM, { privateKey } (+1 more)

### Community 450 - "plan-review-context.ts"
Cohesion: 0.28
Nodes (9): authorFrom(), buildPlanReviewContext(), BuildPlanReviewContextInput, getPlanInteractionContext(), nonEmptyString(), PLAN_REVIEW_CONTEXT_LIMITS, readPlanTarget(), readResult() (+1 more)

### Community 460 - "unprocessable"
Cohesion: 0.05
Nodes (86): unprocessable(), assertAgentDefaultEnvironmentSelection(), validatePolicyBody(), getSecretProvider(), isSecretProviderClientError(), update(), assertIssueCommentAuthorTypeAllowed(), resolveLabelNames() (+78 more)

### Community 461 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.07
Nodes (19): PluginRuntimeServices, WorkerToHostHandlers, FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR, SDK_INSTALL_RACE_ERROR, npmMock, tornSharedStore() (+11 more)

### Community 462 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.20
Nodes (5): createApp(), pendingReviewExecutionState(), seedCompanyAgentAndRuns(), seedPendingReviewIssueOwnedByRun(), seedPendingReviewStageIssue()

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "plugin-state-store.ts"
Cohesion: 0.23
Nodes (10): GBRAIN_RECALL_METRIC, normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), escapeLikePattern(), maybeRecordGbrainRecallOutcome(), PluginStateStore, assertPluginExists(), scopeConditions() (+2 more)

### Community 465 - "event-loop-stall-log.ts"
Cohesion: 0.36
Nodes (7): EventLoopStallLogOptions, resolveStallThresholdMs(), setEventLoopStallListener(), startEventLoopStallLogging(), blockEventLoop(), blockUntilStallObserved(), sleep()

### Community 466 - "embedded-postgres.ts"
Cohesion: 0.03
Nodes (24): seedIssue(), seedPromotedIssue(), ATTRIBUTED_SUB_STAGES, listManagedAgentJobsMock, probeAgentPodActivityMock, readAgentJobRunStatusByNameMock, MONITOR_SCHEDULING_FIELDS, seedAgent() (+16 more)

### Community 467 - "plugin-fencing.ts"
Cohesion: 0.22
Nodes (8): assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier(), ResolvedPluginFencingPrecondition, resolvePluginFencingPrecondition(), precondition()

### Community 468 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.06
Nodes (21): HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, adapterExecute, execFile, mockDeleteAgentJobExact, mockHasActiveJobForAgent, mockListAgentJobRunStatuses, mockListLiveAgentJobRunIds, mockListManagedAgentJobs (+13 more)

### Community 469 - "pr-review-head-attestation.ts"
Cohesion: 0.32
Nodes (4): allyReviewAlreadyAttestsHead(), ListPrReviewsForAttestation, PrReviewHeadAttestation, check()

### Community 470 - "reserveLongActiveProductivityReviewIssue"
Cohesion: 0.25
Nodes (7): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock(), MonitorSuppressedBeforeCreateError, productivityReviewFingerprint(), findOpenProductivityReview(), reserveLongActiveProductivityReviewIssue()

### Community 471 - "routes/decision-training.ts"
Cohesion: 0.15
Nodes (18): createSchema, decisionTrainingRoutes(), exampleIdSchema, parseExampleId(), previewSchema, requireExampleOwner(), requireHumanUser(), sourceKindSchema (+10 more)

### Community 472 - "Ally — Consolidated PR Review"
Cohesion: 0.25
Nodes (7): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Prior Findings Dispositioned (1), Recommended Action, Strengths, Suggestions (0)

### Community 473 - "human-gated-gate-revalidation-backfill.test.ts"
Cohesion: 0.25
Nodes (4): NOW, Stub, StubInteraction, StubIssue

### Community 474 - "startup-filesystem-io.test.ts"
Cohesion: 0.40
Nodes (4): repoRoot, serverSource, statefulSet, tempDirs

### Community 475 - "chain"
Cohesion: 0.18
Nodes (3): createFakeDb(), chain, VALID_HEADERS

### Community 476 - "ceo/AGENTS.md"
Cohesion: 0.29
Nodes (6): Delegation (critical), Keeping work moving, Memory and Planning, References, Safety Considerations, What you DO personally

### Community 478 - "penstock-availability-gate.test.ts"
Cohesion: 0.33
Nodes (4): createPenstockAvailabilityGate(), gateWith(), gateWith(), log

### Community 479 - "Ally — Consolidated PR Review"
Cohesion: 0.29
Nodes (6): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Recommended Action, Strengths, Suggestions (2)

### Community 480 - "companySkillService"
Cohesion: 0.06
Nodes (84): buildSkillRuntimeName(), bundledFolderLabel(), companySkillService(), actorStarClause(), applySkillReassignments(), assertCatalogSkillInstallable(), assertLocalImportSourceAllowed(), auditCatalogSkillSnapshot() (+76 more)

### Community 481 - "workspace-dir-claims-route.test.ts"
Cohesion: 0.18
Nodes (8): link(), createApp(), dbReturning(), load(), loadModule(), makeDir(), makeLinkedWorktree(), mockIssueService

### Community 482 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 483 - "issue-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockGetTelemetryClient, mockIssueService (+1 more)

### Community 484 - "renderYamlBlock"
Cohesion: 0.27
Nodes (10): buildMarkdown(), buildReferencedSkillMarkdown(), compareYamlKeys(), filterCompanyMarkdownIncludes(), isEmptyObject(), orderedYamlEntries(), renderFrontmatter(), renderYamlBlock() (+2 more)

### Community 485 - "assertAssignableAgent"
Cohesion: 0.27
Nodes (10): AgentAssignmentConflictReason, AgentAssignmentKind, assertAssignableAgent(), AssignabilityAgent, assignmentMessage(), assignmentReasonFromHealth(), conflictDetails(), getAgent() (+2 more)

### Community 486 - "plugin-worker-invocation-scope.cjs"
Cohesion: 0.40
Nodes (5): pendingNested, readline, rl, send(), sendNestedHostRequest()

### Community 487 - "billing-classification.ts"
Cohesion: 0.33
Nodes (8): CASH_ZEROING_BILLING_TYPE, DIRECT_METERED_BILLING_TYPES, isBrokeredLane(), isPenstockBaseUrl(), LaneBillingInput, normalizeLedgerBillingType(), PROVIDER_BASE_URL_ENV, readEnvString()

### Community 488 - "approval-gate-reconciler.test.ts"
Cohesion: 0.20
Nodes (8): ApprovalGateReconcilerScheduler, PullRequestGateResult, PullRequestMerger, WorkflowRunLookup, createCompany(), insertApproval(), silentLogger, starvedQueue()

### Community 489 - "evidence-gate-wiring.ts"
Cohesion: 0.26
Nodes (8): EvidenceCommentLite, EvidenceVerdict, EvidenceFetchResult, EvidenceVerdictRecord, extractGithubCommitEvidence(), FetchEvidenceForGate, runEvidenceGate(), TruthProbe

### Community 490 - "startup-dispatch-isolation.test.ts"
Cohesion: 0.33
Nodes (4): analyzeRecoveryIife(), ESCAPE_CALLS, repoRoot, serverSource

### Community 491 - "reflection-coach/AGENTS.md"
Cohesion: 0.40
Nodes (4): Applying changes (permission is gated, not automatic), Core responsibilities, Execution contract, Hard boundaries

### Community 492 - "Recent agent reflection sweep"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Recent agent reflection sweep, What this run must do

### Community 493 - "summarizer/AGENTS.md"
Cohesion: 0.40
Nodes (4): Core responsibilities, Cost discipline, Execution contract, Hard boundaries

### Community 494 - "Refresh stale summary slots"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Refresh stale summary slots, What this run must do

### Community 495 - "metrics-route-no-db.test.ts"
Cohesion: 0.40
Nodes (3): APP_SOURCE, DB_REFRESHES, INLINE_REFRESHES

### Community 496 - "reviewer-wake-outcome-log-fields.test.ts"
Cohesion: 0.50
Nodes (4): OutcomeLine, outcomeLines(), strippedSource(), WEBHOOK_SOURCE

### Community 497 - "SOUL.md -- CEO Persona"
Cohesion: 0.50
Nodes (3): SOUL.md -- CEO Persona, Strategic Posture, Voice and Tone

### Community 498 - "Wake Pre-flight (do this FIRST when woken)"
Cohesion: 0.50
Nodes (3): Fall-through write protocol, Short-circuit protocol, Wake Pre-flight (do this FIRST when woken)

### Community 499 - "app-plugin-takeover-resync.test.ts"
Cohesion: 0.20
Nodes (9): boot(), BOOT_ROWS, bootLoaded(), fakeDb, handleIds, loader, pluginRows, state (+1 more)

### Community 503 - "unclaimable-queued-run-reap-postgres.test.ts"
Cohesion: 0.24
Nodes (6): counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), UNCLAIMABLE_QUEUED_RUN_REAP_MIN_AGE_MS

### Community 504 - "issue-approvals-link-coverage-read-boundary.test.ts"
Cohesion: 0.18
Nodes (9): agentActor, createApp(), createRouteDb(), mockAccessService, mockAgentService, mockHeartbeatService, mockIssueApprovalService, mockIssueService (+1 more)

### Community 511 - "approval-payload-edit-service.test.ts"
Cohesion: 0.24
Nodes (7): approvalGatesEquivalent(), normalizeGateForComparison(), mockAgentService, mockLogActivity, asStoredGate(), JSONB_GATE_KEY_ORDER, LIVE_GATE

### Community 513 - "approval-gate-already-terminal.test.ts"
Cohesion: 0.10
Nodes (15): createAgentApp(), createRouteDb(), found(), MISMATCHED_GATE, mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockGetPullRequestGate (+7 more)

### Community 515 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 516 - "scrape-metrics-routine-fire-gap-work.test.ts"
Cohesion: 0.22
Nodes (5): db, rows, settle(), tickAt(), TRIGGERS

### Community 518 - "ws-upgrade-url-log-guard.test.ts"
Cohesion: 0.31
Nodes (8): argumentText(), COVERED, here, identifierPattern(), rawUrlLogCalls(), serverSrc, taintedLocals(), tsFilesUnder()

### Community 519 - "activityService"
Cohesion: 0.20
Nodes (15): ActivityFilters, activityService(), asRecord(), backfillMissingRunLivenessForIssue(), countValue(), dateValue(), latestDate(), readNumber() (+7 more)

### Community 520 - "plugin-webhook-not-ready-retryable.test.ts"
Cohesion: 0.18
Nodes (8): MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS, OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY, PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC, createApp(), mockLifecycle, mockRegistry, READY_MANIFEST, rejectionSeries()

### Community 521 - "environment-instance-routes.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+1 more)

### Community 522 - "codex-models.ts"
Cohesion: 0.40
Nodes (9): dedupeModels(), fetchOpenAiModels(), fingerprint(), listCodexModels(), loadCodexModels(), mergedWithFallback(), refreshCodexModels(), resetCodexModelsCacheForTests() (+1 more)

### Community 523 - "plugin-orchestration-apis.test.ts"
Cohesion: 0.32
Nodes (3): issuePrefix(), seedCompanyAndAgent(), seedIssueWithWorktree()

### Community 524 - "workspace-scan.ts"
Cohesion: 0.36
Nodes (9): CONFIG_FILE_LANGUAGES, detectProjectName(), execFileAsync, fileExists(), getGitDefaultBranch(), getGitRemoteUrl(), readReadmeExcerpt(), WorkspaceScanResult (+1 more)

### Community 525 - "buildLocalUpstreamExportBundle"
Cohesion: 0.29
Nodes (10): buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), canonicalJson(), buildBundle(), countEntityTypesForManifest(), normalizedContentHash(), normalizePortableFileEntry() (+2 more)

### Community 526 - "classifyTaskWatchdogSubtree"
Cohesion: 0.24
Nodes (9): classifyTaskWatchdogSubtree(), issueUpdatedAtIso(), optionalIso(), pathIssueIds(), stableStopFingerprint(), TaskWatchdogClassifierIssue, waitingPathIds(), classify() (+1 more)

### Community 528 - "ensureServerWorkspaceLinksCurrent"
Cohesion: 0.33
Nodes (7): discoverWorkspacePackagePaths(), visit(), ensureServerWorkspaceLinksCurrent(), findServerWorkspaceLinkMismatches(), findWorkspaceRoot(), isLinkedGitWorktreeCheckout(), readJsonFile()

### Community 530 - "home-paths.ts"
Cohesion: 0.18
Nodes (10): resolveManagedProjectWorkspaceDir(), resolveRunLogBasePath(), resolveRunLogBasePathOverride(), sanitizeFriendlyPathSegment(), getRunLogStore(), resolveSharedDocSearchBoundaryPath(), adapterExecute, allowPenstockGate (+2 more)

### Community 531 - "db-inherited-timeout-metric.test.ts"
Cohesion: 0.31
Nodes (7): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, POOL_IDLE_IN_TRANSACTION_SERIES, setDbInheritedTimeouts(), readings(), seriesFor()

### Community 532 - "recovery-chain-pass-timing-wiring.test.ts"
Cohesion: 0.29
Nodes (4): heartbeatSrc, here, indexSrc, recoverySrc

### Community 533 - "linear-auth.ts"
Cohesion: 0.11
Nodes (20): LinearTeam, LinearTeamExpectation, LinearTeamFailure, LinearTeamMatch, LinearTeamResolution, linearTeamResolutionError(), resolveLinearTeam(), registerLinearWebhook() (+12 more)

### Community 534 - "privateHostnameGuard"
Cohesion: 0.42
Nodes (7): blockedHostnameMessage(), extractHostname(), isLoopbackHostname(), normalizeAllowedHostnames(), privateHostnameGuard(), resolvePrivateHostnameAllowSet(), createApp()

### Community 536 - "stranded-sweep-budget.ts"
Cohesion: 0.33
Nodes (6): compareStrandedSweepKey(), rotateStrandedCandidates(), runBudgetedStrandedLoop(), STRANDED_SWEEP_BUDGET_MS, StrandedSweepKey, ordered

### Community 537 - "heartbeat-finalize-cancelled-skip-dispatch.test.ts"
Cohesion: 0.40
Nodes (3): getRunStatus(), mockAdapterExecute, waitForStatus()

### Community 538 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

### Community 539 - "collectClassifierInput"
Cohesion: 0.28
Nodes (9): issueIdFromRunContext(), issueIdFromWakePayload(), isTerminalIssueStatus(), readNonEmptyString(), collectClassifierInput(), collectCompletedRunIssueIds(), loadWatchdogSubtreeIssues(), revalidateMutationScope() (+1 more)

### Community 540 - "healthz-probe-route.test.ts"
Cohesion: 0.40
Nodes (3): HEALTH_PROBE_DEADLINE_MS, appSource, repoRoot

### Community 541 - "orphan-reap-per-run-sub-stage-audit.test.ts"
Cohesion: 0.50
Nodes (4): KNOWN_ORPHAN_REAP_STAGES, HEARTBEAT_SOURCE, readPerRunLoop(), stripComments()

### Community 542 - "company-skills-catalog-service.test.ts"
Cohesion: 0.25
Nodes (7): contentHash(), createService(), mockCatalogService, sampleAssetBytes, sampleCatalogSkill, sampleFiles, sha256()

### Community 548 - "issue-watchdogs-routes.test.ts"
Cohesion: 0.28
Nodes (5): createApp(), seedCloudTenantMember(), seedCompany(), seedWatchdogRun(), uniqueIssuePrefix()

### Community 549 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 551 - "execution-policy-bootstrap.test.ts"
Cohesion: 0.25
Nodes (7): bootstrap, ensureKubernetesEnvironment, ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, fakeDb, listCompanyIds, updateGeneral

### Community 552 - "plugin-host-service-cleanup.ts"
Cohesion: 0.25
Nodes (4): createPluginHostServiceCleanup(), LifecycleLike, PluginHostServiceCleanupController, PluginWorkerRuntimeEvent

### Community 553 - "buildRemoteHeaders"
Cohesion: 0.39
Nodes (8): buildRemoteHeaders(), headerName(), headerValue(), metadataHeadersForSession(), normalizeCallerHeaders(), readHeaderPolicy(), stringArray(), isSensitivePassthroughHeader()

### Community 554 - "issue-stable-enumeration-routes.test.ts"
Cohesion: 0.29
Nodes (3): createApp(), seedCompany(), uniqueIssuePrefix()

### Community 556 - "conflict"
Cohesion: 0.38
Nodes (7): conflict(), archiveMember(), assertAssignableArchiveTarget(), assertCanRemoveActiveOwner(), updateMember(), updateMemberAndPermissions(), getPendingInteractionForResolution()

### Community 557 - "responsible-user-denial-run-outcomes.ts"
Cohesion: 0.43
Nodes (4): row(), normalizeResponsibleUserDenialCode(), recordResponsibleUserDenialOnActiveRun(), publishLiveEventMock

### Community 558 - "agent-wakeup-target.ts"
Cohesion: 0.33
Nodes (4): wakeRequestTargetsAnyIssueCondition(), ARMS, dialect, RENDERINGS

### Community 560 - "routines-fire-gap-interval.test.ts"
Cohesion: 0.33
Nodes (5): deriveRoutineFireAgeHorizonMs(), EVERY_DAY, gapsFor(), SAMPLED_AT, resetRoutineFireGapsMemoForTests()

### Community 561 - "upsertIssueWatchdogForIssue"
Cohesion: 0.33
Nodes (7): assertWatchdogAgentInvokable(), assertWatchedIssue(), normalizeInstructions(), summarizeIssueWatchdog(), toIssueWatchdog(), updateIssueWatchdogRow(), upsertIssueWatchdogForIssue()

### Community 562 - "plugin-ui-static.test.ts"
Cohesion: 0.29
Nodes (3): createApp(), mockRegistry, tempDirs

### Community 563 - "recovery-manual-resolution-guidance-sites.test.ts"
Cohesion: 0.29
Nodes (4): EMITTING_FILES, EmittingFile, Handoff, SERVICES_DIR

### Community 566 - "issueListRequestKey"
Cohesion: 0.53
Nodes (6): issueListActorIdentity(), issueListClientIdentity(), issueListRequestKey(), normalizeIssueListCacheValue(), shortHash(), stableJson()

### Community 569 - "issue-assignment-wakeup.ts"
Cohesion: 0.40
Nodes (5): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail

### Community 570 - "issue-adoption-execution-agent-name-key.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedContendedIssue(), seedRun()

### Community 571 - "issue-checkout-routine-lock-conflict.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedDuplicateRoutineExecutions(), seedRun()

### Community 572 - "issue-detail-workspace-runtime-withholding.test.ts"
Cohesion: 0.40
Nodes (3): createApp(), seedScenario(), workspaceMetadata()

### Community 575 - "issue-thread-interactions.test.ts"
Cohesion: 0.50
Nodes (4): createFakeDb(), createSelectChain(), mockCreateChild, SelectRow

## Knowledge Gaps
- **4292 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Access`, `MemberRow` (+4287 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 6420 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **78 communities omitted from the detail section** — 1–15 nodes each in graph.json, 47 of them ≥3; graphify omits a community with <3 nodes once file-hub and AST-stub nodes are discounted — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `builtInAgentService()` connect `builtInAgentService` to `companySkillService`, `logActivity`, `services/built-in-agents.ts`, `conflict`, `budgetService`, `agentService`, `notFound`, `accessService`, `routineService`, `agent-instructions.ts`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `issueRoutes()` connect `issueRoutes` to `source-trust.ts`, `key`, `logActivity`, `environmentService`, `routes/issues.ts`, `trust-preset-resolver.ts`, `badRequest`, `accessService`, `issue-comment-effects.ts`, `documentAnnotationService`, `model-profile-hint.ts`, `issue-efficiency.ts`, `issueService`, `routes/approvals.ts`, `heartbeatService`, `issueRecoveryActionService`, `agent-inbox-lite.ts`, `routes/agents.ts`, `toolAccessService`, `instanceSettingsService`, `issue-wake-diagnostics-routes.test.ts`, `issue-monitor-convergence-message.test.ts`, `cases.ts`, `feedback.ts`, `metrics.ts`, `conflict`, `http-log-policy.ts`, `issueListRequestKey`, `runStrandedAssignedIssueSweep`, `issue-assignment-wakeup.ts`, `redaction.ts`, `config`, `services/execution-workspaces.ts`, `reconcileStrandedRecoveryWakeBackstopImpl`, `plan-review-context.ts`, `issue-attachment-routes.test.ts`, `attachment-types.ts`, `services/index.ts`, `services/projects.ts`, `parseIssueExecutionState`, `issue-thread-interactions.ts`, `unprocessable`, `agentService`, `notFound`, `company-search.ts`, `issue-list-truncation-signal.test.ts`, `routes/decision-training.ts`, `successful-run-handoff-state.ts`, `documents.ts`, `companySkillService`, `normalizeIssueExecutionPolicy`, `pull-request-work-products.ts`, `budgetService`, `external-objects.ts`, `stranded-blocked-issue-reconciler.ts`, `issue-execution-policy.ts`, `routes/projects.ts`, `routineService`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `heartbeatService()` connect `heartbeatService` to `heartbeat.ts`, `source-trust.ts`, `github-status-delivery-outbox.ts`, `logActivity`, `taskWatchdogService`, `environmentService`, `branch-run-claims.ts`, `trust-preset-resolver.ts`, `github-webhook.ts`, `k8s-job-liveness.ts`, `asString`, `heartbeat-run-runtime-status.ts`, `issue-rewake-throttle.ts`, `model-profile-hint.ts`, `executeRun`, `cases-routes.test.ts`, `issueService`, `successful-run-handoff.ts`, `home-paths.ts`, `result`, `instanceSettingsService`, `recovery/index.ts`, `adapters/index.ts`, `recoveryService`, `run-secret-redaction.ts`, `conflict`, `log-redaction.ts`, `responsible-user-denial-run-outcomes.ts`, `github-app-auth.ts`, `managed-checkout-partial-clone.ts`, `ccrotate-capacity-retry.ts`, `asNumber`, `readNonEmptyString`, `penstock-availability-gate.ts`, `reapOrphanedRuns`, `process-loss-classification.ts`, `redaction.ts`, `agent-invokability.ts`, `services/execution-workspaces.ts`, `services/issue-tree-control.ts`, `reconcileStrandedRecoveryWakeBackstopImpl`, `heartbeat-stop-metadata.ts`, `run-scratch.ts`, `local-service-supervisor.ts`, `environment-run-orchestrator.ts`, `parseIssueExecutionState`, `execution-policy-bootstrap.ts`, `run-liveness.ts`, `unprocessable`, `notFound`, `orphaned-run-terminal-result.ts`, `gbrain-client-factory.test.ts`, `config.ts`, `execution-allowlist.ts`, `ensureRegistry`, `visibleIssueCondition`, `issue-checkout-status.ts`, `companySkillService`, `hot-restart.ts`, `penstock-availability-gate.test.ts`, `normalizeIssueExecutionPolicy`, `pull-request-work-products.ts`, `sweep-wake-preflight.ts`, `budgetService`, `run-log-store.test.ts`, `issue-execution-policy.ts`, `routes/projects.ts`, `productivityReviewService`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Are the 45 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 45 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `captureUnrecognizedInteractionPayloadKeys()`) actually correct?**
  _`issueRoutes()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _4292 weakly-connected nodes found - possible documentation gaps or missing edges._
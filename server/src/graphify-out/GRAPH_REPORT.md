# Graph Report - src  (2026-11-22)

## Corpus Check
- 1452 files · ~4,232,599 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 18410 nodes · 45796 edges · 584 communities (509 shown, 75 omitted from the detail section)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 1224 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e668fffd`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- errorHandler
- runStrandedAssignedIssueSweep
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
- embedded-postgres.ts
- k8s-job-liveness.ts
- issue-rewake-throttle.ts
- services/tool-gateway.ts
- services/tool-access.ts
- routes/access.ts
- executeRun
- plugin-tool-dispatcher.ts
- heartbeatService
- productivity-review.ts
- services/teams-catalog.ts
- pluginLoader
- environment-custom-images.ts
- evidence-gate.ts
- middleware/auth.ts
- cloud-upstreams.test.ts
- toolAccessService
- registry.ts
- tool-access-policy.ts
- recovery/index.ts
- services/attention.ts
- cases.ts
- board-claim.ts
- recoveryService
- plugin-database.ts
- feedback.ts
- metrics.ts
- workspace-file-resources.ts
- openapi.ts
- skills-catalog.ts
- github-app-auth.ts
- services/routines.ts
- agent-adapter-validation-routes.test.ts
- effective-run-config-fingerprints.ts
- pr-review-state-reconciler.ts
- penstock-availability-gate.ts
- authorization.ts
- routes/approvals.ts
- execution-workspace-cleanup.ts
- tool-gateway.test.ts
- external-runtime-reservations.ts
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
- plugin-database.test.ts
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
- createPluginWorkerHandle
- config.ts
- wake-idempotency.test.ts
- recovery/service.ts
- agent-instructions.ts
- parseObject
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- aws-secrets-manager-provider.ts
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe-k8s.test.ts
- REDACTED_EVENT_VALUE
- normalizeIssueExecutionPolicy
- plugin-worker-manager.ts
- sweep-wake-preflight.ts
- issue-execution-policy-routes.test.ts
- tool-access-service.test.ts
- budgetService
- external-objects.ts
- environment-routes.test.ts
- services/dashboard.ts
- identifier-allocator.ts
- issue-execution-policy.ts
- process-mapping-metrics.test.ts
- ui-branding.ts
- agent-cross-tenant-authz-routes.test.ts
- agent-permissions-routes.test.ts
- heartbeat-workspace-branch-containment.test.ts
- execution-workspace-cleanup.test.ts
- company-artifacts.ts
- productivityReviewService
- plugin-config-masking.ts
- tool-oauth-legacy-backfill.ts
- api-compression.ts
- github-review-gate-authority.ts
- live-events-ws.ts
- normalizeAgentDefaultsForJoin
- source-trust.ts
- issue-continuation-summary.ts
- run-log-store.ts
- github-status-delivery-outbox.ts
- opencode-k8s-seed-transport.test.ts
- execution-workspace-policy.ts
- server-info.ts
- low-trust-red-team-routes.test.ts
- environmentService
- issue-pull-requests.ts
- issues-service.test.ts
- getMetricsRegistry
- trust-preset-resolver.ts
- agent-skills-routes.test.ts
- issues-goal-context-routes.test.ts
- live-event-transcript-gate.ts
- logger
- heartbeat-run-runtime-status.ts
- ensurePersistedExecutionWorkspaceAvailable
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
- agent-start-lock.ts
- routes/agents.ts
- pr-comment-review-gate.ts
- services/instance-settings.ts
- recovery-observability.ts
- agent-secret-redaction.test.ts
- db-retry.ts
- authorizationService
- human-gated-ageing-digest.ts
- pen3954-membership-role-write-bars.test.ts
- adapter-routes-authz.test.ts
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
- heartbeat-pr-review-gate-replay.test.ts
- startServer
- heartbeat-stop-metadata.ts
- remote-http-endpoint-guard.ts
- run-scratch.ts
- pr-review-duplicate-issue-guard.ts
- adapter-model-refresh-routes.test.ts
- agent-instructions-routes.test.ts
- issue-feedback-routes.test.ts
- join-request-dedupe.ts
- issue-recovery-actions.test.ts
- metrics-ingest.ts
- execution-policy-bootstrap.ts
- body
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite.ts
- model-validation.test.ts
- cgroup-memory-metrics.test.ts
- result
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- logger.ts
- dev-server-status.ts
- openapi-routes.test.ts
- heartbeat-dependency-scheduling.test.ts
- execution-allowlist.ts
- createIssueGraphLivenessEscalation
- dispatch-readiness.ts
- project-checkout-origin-reconciler.ts
- github-rate-limit-sampler.ts
- isolation-workspace-reaper.ts
- invite-defaults-response-boundary.test.ts
- recovery-stranded-attendance-batch.test.ts
- environment-custom-image-terminal-sessions.ts
- escalateStrandedAssignedIssue
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
- instanceSettingsService
- runtime-api.ts
- linear-webhook-fixtures.ts
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- plugin-metric-exposition.test.ts
- accepted-interaction-outcome-sweep.ts
- pr-reconciler-sweep.ts
- WorkspaceOperationLogStore
- agent-test-environment-routes.test.ts
- scheduler-lease.ts
- external-object-routes.test.ts
- issue-activity-events-routes.test.ts
- github-api-refusal-metric.test.ts
- middleware/index.ts
- project-goal-telemetry-routes.test.ts
- routine-document-annotation-routes.test.ts
- summary-slot-routes.test.ts
- ccrotate-state-hook.ts
- agent-scope-pinned-config-keys-routes.test.ts
- plugin-secrets-handler.ts
- workspace-response-withholding-guard.test.ts
- workspace-reuse-refusal-class.ts
- branch-run-claims.ts
- http-metrics-transient-db-sqlstate.test.ts
- dev-runner-snapshot.test.ts
- company-branding-route.test.ts
- routes/companies.ts
- issue-comment-effects.ts
- invite-accept-existing-member.test.ts
- issue-closed-workspace-routes.test.ts
- project-routes-env.test.ts
- model-profile-hint.ts
- accessRoutes
- issue-repo-binding-guard.ts
- terminal-gate-reconciler.ts
- agent-auth-jwt.ts
- cpu-profile.ts
- workspace-dir-claim.ts
- agent-run-health.ts
- managed-checkout-push-guard.ts
- issue-execution-lock.test.ts
- transitionCaseInTransaction
- approval-payload-edit-routes.test.ts
- unprocessable
- issue-park-expiry.ts
- environmentRoutes
- heartbeat-timer-suppression-park-bypass.test.ts
- summarySlotService
- agent-hires-instructions-materialize.test.ts
- run-liveness-continuations.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- heartbeat-context-summary.test.ts
- run-secret-redaction.ts
- agent-live-run-routes.test.ts
- instrumentation.ts
- http-log-policy.ts
- agent-redaction.ts
- issue-blocker-diagnostics-routes.test.ts
- managed-checkout-partial-clone.ts
- ccrotate-capacity-retry.ts
- zoned-cron.ts
- issueRecoveryActionService
- issue-wake-diagnostics-routes.test.ts
- builtInAgentService
- invite-rate-limit.ts
- recovery-stale-issue-lock-sweep.test.ts
- plugin-event-bus.ts
- process-loss-classification.ts
- startup-banner.ts
- isolation-reclaim-self.ts
- environment-live-ssh.test.ts
- evidence-truth.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- pod-log-sweeper.ts
- claude-agent-id-header.test.ts
- agent-shell-guard.ts
- StorageService
- services/index.ts
- zodToOpenApiSchema
- openrouter/execute.ts
- company-export-readme.ts
- environment-capabilities-k8s.test.ts
- issue-checkout-status.ts
- lifecycle-hook-command-audit.ts
- fd-class-metrics.ts
- notFound
- pluginCapabilityValidator
- pen3142-live-event-transcript-scope.test.ts
- pr-review-request-ageing-producer.ts
- setupEnvironmentCustomImageTerminalWebSocketServer
- setup-supertest.ts
- agent-pinned-config-keys-survive-heartbeat-mock.test.ts
- strand-comment-provider-capacity.test.ts
- queued-run-age-metrics.ts
- agent-secret-bindings.ts
- issue-update-comment-wakeup-routes.test.ts
- gbrain-client-factory.test.ts
- legacy-next-cron-tick-in-time-zone.ts
- pen3142-run-transcript-scope.test.ts
- routines-service.test.ts
- successful-run-handoff-state.ts
- plugin-store-consistency.test.ts
- pipeline-stage-workspace-settings-withholding.test.ts
- cli-auth-routes.test.ts
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- heartbeat-issue-liveness-escalation.test.ts
- pipeline-case-outputs.ts
- foreign-commit-notice.ts
- heartbeat-worker-crash-marking.test.ts
- pipelines-service.test.ts
- issue-liveness.test.ts
- approval-create-issue-link-authorization.test.ts
- pull-request-work-products.ts
- linear-webhook.test.ts
- kkroo-bundled-plugins.ts
- dev-watch-ignore.ts
- first-admin-claim.ts
- approval-link-route-equivalence.test.ts
- applyDocumentFixups
- heartbeat-provider-capacity-horizon.test.ts
- agent-profile-change-gate-mixing.test.ts
- approval-agent-config-authz-routes.test.ts
- done-gate.ts
- heartbeat-stale-queue-invalidation.test.ts
- plugin-config-write-race.test.ts
- authorization-service.test.ts
- routine-fire-gap-metrics.test.ts
- routine-scheduler-heartbeat.ts
- issueThreadInteractionService
- agent-budget-mirror-write.test.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- invite-summary-route.test.ts
- invite-test-resolution-route.test.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- file
- agent-hire-source-issue-authorization.test.ts
- approval-revision-exit.test.ts
- parseIssueExecutionState
- company-search-rate-limit.ts
- approval-link-requested-by-self.test.ts
- readPenstockCapacity
- chain-pass-timing.ts
- HEARTBEAT.md -- CEO Heartbeat Checklist
- task-watchdog-scope.ts
- heartbeat-workspace-finalize-branch.test.ts
- createToolGatewayService
- user-profiles.ts
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- agent-model-registry-validation.test.ts
- openclaw-invite-prompt-route.test.ts
- approvals-service.test.ts
- documents.ts
- sandbox-provider-runtime.ts
- Ally — Consolidated PR Review
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- issue-runtime-service-command-masking.test.ts
- ensureHumanRoleDefaultGrants
- isolation-reclaim-job-port.ts
- heartbeat-hard-stale-subprocess-liveness.test.ts
- live-events.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- claude-code-version.test.ts
- blocked-inbox-count-list-parity.test.ts
- cases-routes.test.ts
- taskWatchdogService
- heartbeat-cancelled-monitor-recovery.test.ts
- scrape-metrics-collector.ts
- app.ts
- readNonEmptyString
- github-fetch.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- agent-start-lock-db.ts
- issue-monitor-convergence-guard.test.ts
- issue-tree-hold-metrics.ts
- secretService
- plugin-activation-boot-retry.test.ts
- issue-stale-execution-lock-routes.test.ts
- plugin-manifest-validator.ts
- plugin-state-store.ts
- event-loop-stall-log.ts
- orphan-reap-adapter-invoke-probe-batching.test.ts
- company-skills-service.test.ts
- backfill-agent-bundle.ts
- plugin-activation-retry-provenance.test.ts
- PluginWorkerManager
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
- live-events-ws.test.ts
- pod-failure-label-corpus.test.ts
- issue-telemetry-routes.test.ts
- issues-open-assignment-census.test.ts
- assertAssignableAgent
- plugin-worker-invocation-scope.cjs
- billing-classification.ts
- issue-release-lock-only-degrade.test.ts
- heartbeat-run-summary.ts
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
- pen4902-heartbeat-runs-route-params.test.ts
- approval-gate-already-terminal.test.ts
- heartbeat-accepted-plan-workspace-refresh.test.ts
- scrape-metrics-routine-fire-gap-work.test.ts
- applyResponsibleUserIntersection
- ws-upgrade-url-log-guard.test.ts
- issue-visibility.ts
- inspectExecutionWorkspaceBranchForReconcile
- workspace-runtime-read-model.ts
- execution-workspaces-service.test.ts
- plugin-orchestration-apis.test.ts
- pr-review-state-reconciler.test.ts
- heartbeat-ccrotate-capacity-retry.test.ts
- readProjectWorkspaceRuntimeConfig
- classifyTaskWatchdogSubtree
- buildLocalUpstreamExportBundle
- agents-service-secret-bindings.test.ts
- database-backup-health.ts
- heartbeat-worktree-suppression.test.ts
- recovery-chain-pass-timing-wiring.test.ts
- heartbeat-queued-backlog-convergence.test.ts
- assignmentPolicyEffect
- expireStaleRequestConfirmationTarget
- collectClassifierInput
- heartbeat-finalize-cancelled-skip-dispatch.test.ts
- workspace-operation-secret-scrub.test.ts
- sweep-wake-preflight.test.ts
- healthz-probe-route.test.ts
- orphan-reap-per-run-sub-stage-audit.test.ts
- project-managed-plugin-defaults-boundary.test.ts
- github-webhook-dedicated-pool.test.ts
- skills-catalog-service.test.ts
- db-inherited-timeout-metric.test.ts
- issue-assignment-wakeup.ts
- emitInteractionResolvedTelemetry
- approval-list-pagination.test.ts
- issue-monitor-convergence-message.test.ts
- sse-registry.ts
- task-watchdogs-scheduler.test.ts
- responsible-user-denial-run-outcomes.ts
- agent-wakeup-target.ts
- heartbeat-per-run-sub-stage-split.test.ts
- pen4902-heartbeat-run-window.test.ts
- recovery-manual-resolution-guidance-sites.test.ts
- work-product-external-id-write-canonicalization.test.ts
- TerminalWsSocket
- feedback-share-client.ts
- OAuthMintBearer
- inherited-workspace-reuse-failure-summary.test.ts
- execution-lock-orphan-cleanup.test.ts
- invite-logo-route.test.ts
- issue-adoption-execution-agent-name-key.test.ts
- issue-checkout-routine-lock-conflict.test.ts
- issue-thread-interactions-service.test.ts
- issue-thread-interactions-telemetry.test.ts
- issue-goal-fallback.ts
- issue-thread-interactions.test.ts
- dispatch-cross-process-claim.test.ts
- config
- monitor-clear-activity-defer-publish.test.ts
- plugin-agent-invoke-wake-fanout.test.ts
- getIssueRelationSummaryMap
- parseStatusFilter
- heartbeat-start-lock-reap-coalescing.test.ts
- reviewedFingerprintForWatchdogIssue

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 644 edges
2. `issueRoutes()` - 390 edges
3. `unprocessable()` - 383 edges
4. `notFound()` - 340 edges
5. `issueService()` - 289 edges
6. `logActivity()` - 268 edges
7. `recoveryService()` - 262 edges
8. `executeRun()` - 249 edges
9. `parseObject` - 197 edges
10. `agentRoutes()` - 197 edges

## Surprising Connections (you probably didn't know these)
- `mockSettings()` --indirect_call--> `instanceSettingsService()`  [INFERRED]
  __tests__/quota-exhausted-hook.test.ts → services/instance-settings.ts
- `captureLiveEvents()` --calls--> `subscribeCompanyLiveEvents()`  [EXTRACTED]
  __tests__/activity-log-transactional-publish.test.ts → services/live-events.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes-authz.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-auth-middleware.test.ts → middleware/error-handler.ts

## Import Cycles
- 2-file cycle: `services/issues.ts -> services/task-watchdogs.ts -> services/issues.ts`

## Communities (584 total, 75 omitted from the detail section)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (336): appendWithByteCap, agentScopeOnlyConfigKeyOverrides(), jitterTransientRetryFloor(), resolveEffectiveWorkspaceStrategyType(), describeGitFailure(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS (+328 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (171): ParsedExecutionWorkspaceMode, getDefaultCompanyGoal(), GoalReader, isIssueParkExpiryWakeStatus(), ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS, AcceptedPlanDecompositionInput, AcceptedPlanDocumentInteraction, activeRunMapForIssues() (+163 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.03
Nodes (154): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), appendSkillExportDirSuffix(), applyImportAdapterRunDefaults(), applySelectedFilesToSource(), asBoolean(), asInteger() (+146 more)

### Community 3 - "errorHandler"
Cohesion: 0.02
Nodes (63): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), noteTransientDbResponse() (+55 more)

### Community 4 - "runStrandedAssignedIssueSweep"
Cohesion: 0.04
Nodes (71): applyIssueMonitorPolicyTransition(), createActivePauseHoldPrefilter(), agentUiLink(), buildExecutionReviewParticipantRecoveryComment(), buildExecutionReviewParticipantUnavailableComment(), buildNonRetryableEscalationComment(), classifyAdapterFailureForRecovery(), classifyContinuationFailure() (+63 more)

### Community 5 - "logActivity"
Cohesion: 0.03
Nodes (183): containAgentMetadata(), forbidden(), unauthorized(), validate(), assertCanGenerateOpenClawInvitePrompt(), assertCompanyPermission(), activityRoutes(), COMPANY_ACTIVITY_QUERY_PARAMS (+175 more)

### Community 6 - "issueRoutes"
Cohesion: 0.02
Nodes (133): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), authenticatedActorResponsibleUserId(), buildCreateIssueActivityStatusDetails(), buildExecutionStageWakeContext(), buildExecutionStageWakeup(), buildRequestItemVerdictsWakeIdempotencyKey(), captureUnrecognizedInteractionPayloadKeys() (+125 more)

### Community 7 - "gc-flags-metrics.ts"
Cohesion: 0.05
Nodes (58): GC_CYCLES_METRIC, GC_FLAG_BITS, GC_FLAGS_NONE, GC_KIND_UNKNOWN, GC_KINDS, GcCycleClassCount, GcCycleWindow, GcEntryDetail (+50 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.03
Nodes (149): skillImportPolicyResource(), asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillKeyAllowed() (+141 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.05
Nodes (64): PIPELINE_STAGE_EXIT_CANCELLATION_REASON, addFormVariablesForStage(), assertActorProvenance(), assertCaseKey(), assertValidParentCase(), buildCaseDeepLink(), buildPipelineAutomationIssueTitlePrefix(), buildPipelineCaseContextMarkdown() (+56 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (154): STATEMENT_TIMEOUT_SQLSTATE, IssueApprovalLinkAuthorizationIssue, ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema (+146 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.04
Nodes (57): reconcileApprovedBuiltInAgent(), BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), BUILT_IN_AGENT_DEFAULT_GRANTS, BUILT_INS_DIR (+49 more)

### Community 12 - "issue-dependency-wakeups-routes.test.ts"
Cohesion: 0.20
Nodes (10): createApp(), mockDb, mockFindExistingIssueBlockersResolvedWake, mockIssueService, mockListBlockedDependentIssueIds, mockRecomputeBlockedIssuesStatusIfReady, mockTx, mockTxInsertValues (+2 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (99): ExecutionWorkspaceTeardownTrigger, assertDirtyQuarantineRuntimeServicesStopped(), assertServerGitDoesNotPublish(), buildExecutionWorkspaceCleanupEnv(), buildNonInteractiveGitEnv(), buildWorkspaceTemplateData(), createProcessOutputCapture(), describeSubmoduleInspectionDegradation() (+91 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.04
Nodes (72): listBundledPlugins(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH, BOOT_ACTIVATION_RETRY_PATTERN, BOOT_REATTEMPT_ELIGIBLE_MARKERS, BOOT_REATTEMPT_ELIGIBLE_SUFFIX_PATTERN, buildLocalPluginBuildCommand(), buildLocalPluginBuildCommands() (+64 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (203): acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody(), buildDependabotRefireComment() (+195 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (93): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertNoAgentStageConfigCommandMutation(), assertNoAgentStageConfigWorkspaceRuntimeMutation(), assertPipelineAccess() (+85 more)

### Community 17 - "embedded-postgres.ts"
Cohesion: 0.03
Nodes (44): registerServerAdapter(), unregisterServerAdapter(), runningProcesses, _settleDetachedAgentStartLockWorkForTesting(), HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, mockAdapterExecute, mockAdapterExecute, mockAdapterExecute (+36 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.04
Nodes (93): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+85 more)

### Community 19 - "issue-rewake-throttle.ts"
Cohesion: 0.12
Nodes (21): computeIssueRewakeCooldownMs(), evaluateIssueRewakeThrottle(), isIssueRewakeNewInputActivity(), isIssueRewakeProgressActivity(), ISSUE_COMMENT_ADDED_ACTION, ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS, ISSUE_PROGRESS_ACTIVITY_ACTION_SET (+13 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (43): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview() (+35 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.05
Nodes (49): createCompanyInviteForCompany(), agentJoinGrantsFromDefaults(), AvailableSkill, companyInviteExpiresAt(), CompanyMemberRecord, createInviteToken(), defaultInviteResolutionNetwork, grantsFromDefaults() (+41 more)

### Community 23 - "executeRun"
Cohesion: 0.03
Nodes (130): getServerAdapter(), isWorkspaceLessFallbackWorkspaceDir(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), resolveStaleDependabotAlertWakeIssue(), createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), applyAgentGitIdentityToRuntimeConfig() (+122 more)

### Community 24 - "plugin-tool-dispatcher.ts"
Cohesion: 0.06
Nodes (16): PluginRouteToolDeps, createPluginToolDispatcher(), handlePluginEnabled(), registerFromDb(), PluginToolDispatcher, PluginToolDispatcherOptions, createPluginToolRegistry(), addTool() (+8 more)

### Community 25 - "heartbeatService"
Cohesion: 0.02
Nodes (184): describeDbError(), findPgError(), isDbError(), publishPluginDomainEvent(), evaluateAgentInvokability(), evaluateAgentInvokabilityFromDb(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds() (+176 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.03
Nodes (122): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock(), ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, buildThresholds() (+114 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (62): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+54 more)

### Community 28 - "pluginLoader"
Cohesion: 0.06
Nodes (34): isIsolatedSdkPluginPackage(), buildPluginWorkerEnv(), formatBootActivationRetryTag(), formatSharedDependencyConsistencyError(), getDeclaredPageRoutePaths(), getMinimumHostVersion(), isBootReattemptEligibleLatch(), isPluginPackageName() (+26 more)

### Community 29 - "environment-custom-images.ts"
Cohesion: 0.05
Nodes (91): collectEnvironmentSecretRefs(), createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe() (+83 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (53): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+45 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.10
Nodes (28): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+20 more)

### Community 32 - "cloud-upstreams.test.ts"
Cohesion: 0.18
Nodes (9): fetchWithTimeout(), parseRemoteResponse(), postJson(), proofHeaders(), remoteGet(), remotePost(), safeParseJson(), sealCloudUpstreamCredential() (+1 more)

### Community 33 - "toolAccessService"
Cohesion: 0.04
Nodes (132): HttpError, parseRemoteHttpEndpoint(), asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor() (+124 more)

### Community 34 - "registry.ts"
Cohesion: 0.06
Nodes (49): BUILTIN_ADAPTER_TYPES, acpxLocalAdapter, adapterAcceptsModelForConfig(), adapterModelRegistryIsClosed(), adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks (+41 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (71): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+63 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.04
Nodes (95): coldInReviewGaugeEntries(), ColdInReviewGaugeEntry, ColdInReviewIssueRow, addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding() (+87 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.06
Nodes (53): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+45 more)

### Community 38 - "cases.ts"
Cohesion: 0.07
Nodes (51): annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany(), assertProjectBelongsToCompany(), autoLinkRunIssue(), buildCasePatchUpdateValues() (+43 more)

### Community 39 - "board-claim.ts"
Cohesion: 0.36
Nodes (8): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge()

### Community 40 - "recoveryService"
Cohesion: 0.04
Nodes (121): buildIssueBlockersResolvedWakeIdempotencyKey(), findExistingIssueBlockersResolvedWakeForAnyKey(), recordBackstopCandidateSkipped(), recordBackstopSweepCompleted(), recordRecoveryActionAutoDischarged(), recordRecoveryHorizonExpired(), setBackstopDeferredCandidates(), withRecoveryModelProfileHint() (+113 more)

### Community 41 - "plugin-database.ts"
Cohesion: 0.11
Nodes (32): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), assertNoEscapeStringLiterals(), assertNoGucWrite(), assertNoUnextractedSchemaRefs(), assertNoUnextractedSchemaRefsInAll() (+24 more)

### Community 42 - "feedback.ts"
Cohesion: 0.07
Nodes (61): appendNote(), asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildClaudeTraceFiles(), buildCodexTraceFiles() (+53 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (246): createBetterAuthHandler(), normalizeAuthLocationHeader(), ACCEPTED_INTERACTION_OUTCOME_METRIC, ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC, ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC, ACCEPTED_INTERACTION_OUTCOME_RECENT_METRIC, AGENT_ERROR_REASON_NONE, AGENT_ERROR_REASON_OTHER (+238 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.06
Nodes (69): WorkspaceFileResourceService, AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments() (+61 more)

### Community 45 - "openapi.ts"
Cohesion: 0.04
Nodes (47): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+39 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.11
Nodes (31): CatalogManifestFile, CatalogManifestUnavailableError, copyCatalogSkillFile(), devCatalogManifestPath, devCatalogPackageRoot, getCatalogManifest(), getCatalogPackageMetadata(), getCatalogSkillOrThrow() (+23 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.03
Nodes (149): __test_stackedChildDirective, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyPullRequestNotFound(), classifyWorkflowRunNotFound() (+141 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (37): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), assertTimeZone(), buildRoutineRevisionSnapshot(), canonicalSnapshot() (+29 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (18): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+10 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 51 - "pr-review-state-reconciler.ts"
Cohesion: 0.09
Nodes (33): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+25 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.10
Nodes (33): PenstockProbeOutcomeLabel, PenstockProbePathLabel, asRecord(), buildCapacityUrl(), buildMessagesUrl(), CacheEntry, capacityRetryFromBody(), defaultCapacityRetry() (+25 more)

### Community 53 - "authorization.ts"
Cohesion: 0.07
Nodes (36): membershipColumns, principalGrantColumns, AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction (+28 more)

### Community 54 - "routes/approvals.ts"
Cohesion: 0.02
Nodes (120): AgentWorkspaceCommandViewer, parseUnsupportedPaginationParams(), assertHireSourceIssueLinksAllowed(), ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext() (+112 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.09
Nodes (30): decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup(), selectEligible() (+22 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.08
Nodes (8): mcpGatewayProtocolRoutes(), awaitRateLimitWindow(), createApprovedToolAction(), createGatewayRouteApp(), createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "external-runtime-reservations.ts"
Cohesion: 0.07
Nodes (42): bindExternalRuntimeReservationIsolation(), claimRunWithExternalRuntimeSlot(), claimRunWithExternalRuntimeSlotOutcome(), claimRunWithExternalRuntimeSlotPool(), ExternalRuntimeClaim, ExternalRuntimeClaimOutcome, ExternalRuntimeClaimRefusal, ExternalRuntimeIsolationConflictCause (+34 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.06
Nodes (74): maskAgentWorkspaceStrategyCommands(), maskAgentWorkspaceStrategyCommandsInner(), projectApprovalPayloadForRead(), RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, assignRecordKey(), BENIGN_HEADER_NAMES, classifyKeyTier() (+66 more)

### Community 60 - "adapters.ts"
Cohesion: 0.11
Nodes (43): buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter(), resolvePackageDir() (+35 more)

### Community 61 - "folderService"
Cohesion: 0.16
Nodes (38): buildFolderViews(), folderService(), assertMutableFolder(), assertNoSlugConflict(), create(), currentBundledCategory(), deleteFolder(), descendantIds() (+30 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.09
Nodes (39): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), ExecutionWorkspaceBranchReconcileActor, ExecutionWorkspaceBranchReconcileInspection (+31 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.05
Nodes (62): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActivePauseHoldRow, ActiveRunRow, ActorInput, actorMatchesComment() (+54 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.10
Nodes (33): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+25 more)

### Community 65 - "environment-runtime.ts"
Cohesion: 0.06
Nodes (55): stripSandboxProviderEnvelope(), buildEnvironmentSecretMetadataForLeaseFingerprint(), buildReusableSandboxLeaseFingerprint(), buildReusableSandboxLeaseScope(), createPluginEnvironmentDriver(), resolvePluginDriver(), resolvePluginDriverForRelease(), createSandboxEnvironmentDriver() (+47 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.09
Nodes (26): Config, DurableRunLogStoreOptions, createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), createLocalDiskStorageProvider(), normalizeObjectKey(), resolveWithin() (+18 more)

### Community 67 - "issue-attachment-routes.test.ts"
Cohesion: 0.09
Nodes (24): DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody(), Frame (+16 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.11
Nodes (28): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), parseField() (+20 more)

### Community 69 - "plugin-database.test.ts"
Cohesion: 0.10
Nodes (16): derivePluginDatabaseNamespace(), pluginDatabaseService(), ensureNamespace(), ensureNamespaceWithClient(), getNamespace(), getRuntimeNamespace(), pinSearchPath(), runWithPinnedSearchPath() (+8 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.10
Nodes (52): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+44 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.10
Nodes (32): recordProjectPrimaryWorkspaceFallback(), attachGoals(), attachListMetrics(), attachWorkspaces(), buildManagedProjectDefaults(), buildProjectListMetricMaps(), CreateWorkspaceInput, deriveNameFromCwd() (+24 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (33): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+25 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.06
Nodes (50): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+42 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.09
Nodes (24): ACKNOWLEDGEABLE_OUTCOME_INTERACTION_KINDS, assertRequestConfirmationTargetIsCurrent(), getIssueDocumentTargetSnapshot(), InteractionActor, isRequestConfirmationLikeKind(), IssueResolutionContext, IssueThreadInteractionRow, IssueTouchDb (+16 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.02
Nodes (154): RFC-1918, badRequest(), computeETag(), MIME_TYPES, PluginUiStaticRouteOptions, pluginUiStaticRoutes(), resolvePluginUiDir(), AvailableBundledPlugin (+146 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.11
Nodes (35): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+27 more)

### Community 77 - "services/cloud-upstreams.ts"
Cohesion: 0.07
Nodes (58): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildWarnings(), cloudUpstreamRemoteFailureReport(), cloudUpstreamRunStatus(), cloudUpstreamService() (+50 more)

### Community 78 - "agentService"
Cohesion: 0.07
Nodes (55): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed(), assertCompanyShortnameAvailable(), assertNoCycle() (+47 more)

### Community 79 - "company-search.ts"
Cohesion: 0.07
Nodes (56): activeIssueFilters(), artifactResult(), COMPANY_SEARCH_BRANCH_FETCH_LIMIT, companySearchBranchFetchLimit(), companySearchService(), countAgents(), countArtifacts(), countProjects() (+48 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.10
Nodes (25): ActorFields, assertWatchedIssue(), isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict(), IssueRow, IssueWatchdogRow, IssueWatchdogUpsertInput, isUniqueConstraintConflict() (+17 more)

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
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "index.ts"
Cohesion: 0.08
Nodes (31): BUNDLED_PLUGIN_PACKAGES, BetterAuthSessionResult, BetterAuthSessionUser, EmbeddedPostgresCtor, EmbeddedPostgresInstance, StartedServer, InstanceDatabaseBackupRunResult, InstanceDatabaseBackupTrigger (+23 more)

### Community 87 - "pluginManagedRoutineService"
Cohesion: 0.23
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.12
Nodes (21): AuthenticatedTerminalContext, closeUpgradeSocket(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, CustomImageTerminalService, decodeClientMessage(), IncomingMessageWithTerminalContext, isWritableUpgradeSocket(), parseJsonClientFrame() (+13 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "createPluginWorkerHandle"
Cohesion: 0.15
Nodes (31): createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart(), clearInvocation(), computeBackoffMs(), contextForWorkerMessage(), deriveCallInvocationScope() (+23 more)

### Community 91 - "config.ts"
Cohesion: 0.06
Nodes (40): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS, numericEnv() (+32 more)

### Community 92 - "wake-idempotency.test.ts"
Cohesion: 0.43
Nodes (4): findWakeIdempotencyReceipt(), attemptWakeEffect(), insertWake(), WAKE_IDEMPOTENCY_RECEIPT_STATUSES

### Community 93 - "recovery/service.ts"
Cohesion: 0.03
Nodes (92): DeferredWakeReopenEligibility, isTerminalIssueStatus(), LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), shouldReopenTerminalIssueForDeferredWake(), WAKE_COMMENT_IDS_KEY (+84 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.14
Nodes (40): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+32 more)

### Community 95 - "parseObject"
Cohesion: 0.03
Nodes (186): parseObject, runWithTransientDbRetry(), incrementDepBlockedMetric(), boundHeartbeatRunEventPayloadForStorage(), buildDepBlockedCarriedDecisionNotice(), buildHeartbeatRunFailedMetricInput(), carryRetryContextSnapshot(), coalescedContextSnapshotSql() (+178 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.13
Nodes (27): reconcileHotRestartAdoption(), isProcessAlive(), isTrackedLocalChildProcessAdapter(), mergeHotRestartAdoptionResultJson(), asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME (+19 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.08
Nodes (29): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+21 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (23): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+15 more)

### Community 99 - "aws-secrets-manager-provider.ts"
Cohesion: 0.05
Nodes (57): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), awsProviderSafeMessage(), AwsSecretsManagerConfig (+49 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (37): commentEffectLedger, drizzleTableName, insertedTableNames(), installActor(), lastSelectedTable, LedgerRow, ledgerRows, mockAccessService (+29 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.08
Nodes (29): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+21 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "REDACTED_EVENT_VALUE"
Cohesion: 0.08
Nodes (18): REDACTED_EVENT_VALUE, ConfigValidationResult, validateInstanceConfig(), hireMetadataFixture(), hireRuntimeConfigFixture(), issuePrefix(), seedCompany(), AGENT_ACTOR (+10 more)

### Community 104 - "normalizeIssueExecutionPolicy"
Cohesion: 0.11
Nodes (24): isLapsedMonitorRearmPatch(), reconcileUndeliverableIssueMonitors(), applyIssueExecutionPolicyTransition(), buildIssueMonitorEligibilityClear(), issueHoldsClearableMonitor(), monitorClearReasonForIssue(), normalizeIssueExecutionPolicy(), normalizeMonitorNotes() (+16 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.05
Nodes (35): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), spawnProcess(), HOST_STARTUP_RPC_FAILURE, HostStartupRpcFailure, isHostStartupRpcFailure() (+27 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.13
Nodes (26): compareSweepWakeFrame(), currentMinuteBucket(), detectSweepWakeRace(), equalStringArrays(), getIssueSnapshot(), isCompanyFlagEnabled(), isValidIsoDate(), isValidSweepWakeFrame() (+18 more)

### Community 107 - "issue-execution-policy-routes.test.ts"
Cohesion: 0.09
Nodes (21): isMonitorNextCheckAtLive(), parseMonitorDate(), createApp(), issueWithClearedStalledMonitor(), issueWithTriggeredMonitor(), mockAccessService, mockDb, mockDbInsert (+13 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (27): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+19 more)

### Community 109 - "budgetService"
Cohesion: 0.03
Nodes (99): redactAgentSecrets(), assertByProjectWindowWithinCap(), BY_PROJECT_MAX_WINDOW_DAYS, costRoutes(), parseCostAgentId(), parseCostDateRange(), parseCostLimit(), APPROVAL_SUBJECT_KEYS (+91 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (23): createApp(), currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService (+15 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.08
Nodes (35): dashboardRoutes(), parsePositiveNumber(), readSingleStringParam(), readUuidParam(), RECOVERY_ACTION_QUERY_KEYS, buildDismissedAtByKey(), sidebarBadgeRoutes(), AgentReviewCounts (+27 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.12
Nodes (17): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+9 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.08
Nodes (44): ActorLike, actorPrincipal(), applyIssueExecutionStageTransition(), applyMonitorTransition(), AssigneeLike, assigneePrincipal(), blankExecutionState(), buildChangesRequestedState() (+36 more)

### Community 115 - "process-mapping-metrics.test.ts"
Cohesion: 0.08
Nodes (38): PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC, PROCESS_MAPPING_RSS_BYTES_METRIC, PROCESS_MAPPING_SCAN_SECONDS_METRIC, PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC, PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC, PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC, setProcessMappingMetrics(), ANON_ALIGNED_64M_FULL_CLASS (+30 more)

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

### Community 120 - "execution-workspace-cleanup.test.ts"
Cohesion: 0.10
Nodes (20): classifyRemovalProof(), EXECUTION_WORKSPACE_CLEANUP_REASONS, EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC, EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES, EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC, EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC (+12 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.14
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "productivityReviewService"
Cohesion: 0.06
Nodes (70): reconcileDestroyedIssueParkRecoveries(), enqueueParkRecoveryWake(), findOpenParkRecoveryIssue(), visibleIssueCondition(), extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isApprovalGatedSuppression(), isMonitorScheduledSuppression() (+62 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.09
Nodes (48): RFC-6901, AMBIGUOUS_SCHEMA_NODE, childNodesForIndex(), childNodesForKey(), collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues(), collectStringLeaves(), containsMask() (+40 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.14
Nodes (22): awsSecretsManagerProvider, SecretProviderVaultRuntimeConfig, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind (+14 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "github-review-gate-authority.ts"
Cohesion: 0.05
Nodes (59): GithubWebhookConfig, ghGraphQlPullRequestFields(), githubHeadChecksSettlement(), activateGithubReviewGateDelivery(), affectsProtectedBase(), approvalAddsOnlyClearingEvidence(), Candidate, claimDueGithubReviewGateDeliveries() (+51 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.14
Nodes (15): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+7 more)

### Community 128 - "normalizeAgentDefaultsForJoin"
Cohesion: 0.19
Nodes (19): buildJoinDefaultsPayloadForAccept(), canReplayOpenClawGatewayInviteAccept(), extractHeaderEntries(), generateEd25519PrivateKeyPem(), headerMapGetIgnoreCase(), headerMapHasKeyIgnoreCase(), isDefaultHermesDashboardRoot(), isPlainObject() (+11 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.03
Nodes (61): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+53 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.14
Nodes (24): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates(), extractPreviousNextAction() (+16 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.09
Nodes (24): resolveRunLogBasePath(), resolveRunLogBasePathOverride(), key(), createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key() (+16 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.06
Nodes (52): githubAppCredentialsConfigured(), GitHubCommitStatusState, acquireGithubStatusKeyLease(), appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), COALESCED_REEVALUATION_DELAY_MS, DbHandle (+44 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "execution-workspace-policy.ts"
Cohesion: 0.04
Nodes (82): execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment(), execute(), processAdapter, summarizeStatus() (+74 more)

### Community 135 - "server-info.ts"
Cohesion: 0.15
Nodes (16): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, buildCommitGitInfo(), createServerInfoSnapshot(), getGitLocalChanges() (+8 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.14
Nodes (7): createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.16
Nodes (18): ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES, cloneRecord(), countFromRows(), EnvironmentLeaseRow, EnvironmentListFilters, EnvironmentRow, environmentService(), hasConstraintName() (+10 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.07
Nodes (46): collectCiBranchIdentifiers(), AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES (+38 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.06
Nodes (20): extractExecutiveHoldMarker(), findActiveExecutiveHold(), issueSearchArmsJoinOn(), issueSearchArmsSubquery(), issueSearchRankExpr(), parseExecutiveHoldMarkerTimestamp(), searchArmsColumn(), agentRow() (+12 more)

### Community 140 - "getMetricsRegistry"
Cohesion: 0.04
Nodes (54): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+46 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.15
Nodes (22): assertLowTrustWorkspaceIsolation(), issueIdIsDescendantOf(), LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS, workspaceIssueWithinLowTrustBoundary(), asRecord(), deny(), hasBoundaryScope(), intersectSets() (+14 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "live-event-transcript-gate.ts"
Cohesion: 0.20
Nodes (13): createLiveEventTranscriptGate(), decisionReason(), defaultTranscriptStreamAuditor(), GateOutcome, LIVE_EVENT_TRANSCRIPT_AUDIT_ACTION, LiveEventSubscriberContext, LiveEventTranscriptAuditEntry, MembershipReader (+5 more)

### Community 145 - "logger"
Cohesion: 0.06
Nodes (51): logger, driveIsolationReclaim(), DriveIsolationReclaimOptions, messageOf(), ReclaimClaimFailureKind, ReclaimClaimOutcome, ReclaimClaimPhase, ReclaimClaimTemplate (+43 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.17
Nodes (22): decorateHeartbeatRunRuntimeStatus(), recordCurrentHeartbeatRunRuntimeProgress(), isHeartbeatRunRuntimeStatusActive(), recordHeartbeatRunRuntimeProgress(), clearAllHeartbeatRunRuntimeStatuses(), clearHeartbeatRunRuntimeStatus(), cloneStatus(), getHeartbeatRunRuntimeStatus() (+14 more)

### Community 147 - "ensurePersistedExecutionWorkspaceAvailable"
Cohesion: 0.06
Nodes (71): branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), classifyGitCheckoutProbeFailure(), createGitLinkExclusively(), describeHusk(), detectDefaultBranch(), detectGitWorktreeInProgressOperation(), directoryExists() (+63 more)

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
Cohesion: 0.03
Nodes (94): activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter(), blockedInboxIssueConditions(), buildPreRealizationExecutionWorkspaceSettings() (+86 more)

### Community 152 - "successful-run-handoff.ts"
Cohesion: 0.06
Nodes (53): ALERTMANAGER_ORIGIN_KIND, isAlertEscalationLadderOriginKind(), agentLinkRow(), AgentRow, boundedLinkText(), buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice() (+45 more)

### Community 153 - "companies-route-cross-company-authz.test.ts"
Cohesion: 0.12
Nodes (16): createApp(), createCompany(), exportPreviewResult(), exportRequest, exportResult(), importResult(), mockAccessService, mockAgentService (+8 more)

### Community 154 - "version.ts"
Cohesion: 0.14
Nodes (17): compactRecord(), DebugLog, GitDescribeCommand, hasGitMetadataBeforeNodeModulesBoundary(), hasPathSegment(), isPackagedInstall(), normalizeErrorField(), PackageJson (+9 more)

### Community 155 - "human-gated-ageing.ts"
Cohesion: 0.08
Nodes (43): AgedHumanGatedIssue, BlockerEdge, classifyHumanGatedWait(), comparePriority(), computeTransitivePayoff(), DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY, escalateAfterDaysFor(), formatAge() (+35 more)

### Community 157 - "worker-tier-proxy.ts"
Cohesion: 0.09
Nodes (28): RFC-7230, boardOrgAccessProxyGuard(), CONNECT_PHASE_ERROR_CODES, createWorkerProxyHandler(), fetchWithStartupRetry(), forwardRequestHeaders(), hasRequestBody(), HOP_BY_HOP_HEADERS (+20 more)

### Community 158 - "agent-start-lock.ts"
Cohesion: 0.04
Nodes (50): cache, CacheEntry, AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), describeAgentStartLockDispatchHealth() (+42 more)

### Community 159 - "routes/agents.ts"
Cohesion: 0.03
Nodes (122): describeInadmissibleClaudeCodeVersion(), describeUnregisteredModel(), containAgentConfig(), keepSanitizedAgentMetadata(), restoreRedactedAgentRuntimeConfig, parseOffsetParam(), withholdRunEventTranscriptContent(), agentRoutes() (+114 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (134): ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead(), AllyDispositionedPriorFinding, AllyFindingRef, AllyPriorFindingDisposition (+126 more)

### Community 161 - "services/instance-settings.ts"
Cohesion: 0.19
Nodes (18): applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema, InstanceSettingsServiceOptions, isTruthyRuntimeEnvValue(), normalizeExperimentalSettings(), normalizeGeneralSettings() (+10 more)

### Community 162 - "recovery-observability.ts"
Cohesion: 0.09
Nodes (24): ACTIVE_STATUSES, classifyRecoveryHandoff(), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT, evaluateRecoveryRateAlert(), HandoffClass, MAX_WINDOW_WEEKS, RecoveryActionFacts, RecoveryActionListItem (+16 more)

### Community 163 - "agent-secret-redaction.test.ts"
Cohesion: 0.07
Nodes (24): agentActor, baseAgent, boardActor, createApp(), createDbStub(), hire(), maskedByReadPath(), mockAccessService (+16 more)

### Community 164 - "db-retry.ts"
Cohesion: 0.10
Nodes (21): compactErrorText(), isPostgresSqlState(), isTransientDbError(), PgErrorFields, POSTGRES_SQLSTATE_CLASSES, readString(), TRANSIENT_DB_SQLSTATES, TransientDbRetryOptions (+13 more)

### Community 165 - "authorizationService"
Cohesion: 0.12
Nodes (44): allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentHasRecoveryHandoffGrantOnIssue(), agentHoldsIssueAcrossDependencyEdge(), agentWithinLowTrustBoundary(), allowIssueMentionGrant() (+36 more)

### Community 166 - "human-gated-ageing-digest.ts"
Cohesion: 0.06
Nodes (46): db, MAX_PRS, token, BlockerGraphInput, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk() (+38 more)

### Community 167 - "pen3954-membership-role-write-bars.test.ts"
Cohesion: 0.16
Nodes (13): approveHumanJoinRequestFromInvite(), addCompanyMemberRemovalAccess(), assertCanManageCompanyMember(), getProtectedMemberReason(), resolveActorHumanRole(), grantsForHumanRole(), HUMAN_COMPANY_MEMBERSHIP_ROLES, normalizeHumanRole() (+5 more)

### Community 168 - "adapter-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): setOverridePaused(), createAdapter(), createApp(), installedRecord(), instanceAdmin, mocks, requestApp(), resetInstalledExternalAdapterState() (+6 more)

### Community 169 - "ac-policy-assignee-routing.ts"
Cohesion: 0.14
Nodes (15): AcPolicyAgentTargetReason, AcPolicyFilingTarget, AcPolicyFilingTargetInput, AcPolicyResolvedOwner, AcPolicySkippedAgent, AcPolicySweepAgent, AcPolicyUnroutableReason, AcPolicyUserTargetReason (+7 more)

### Community 170 - "company-portability-routes.test.ts"
Cohesion: 0.11
Nodes (13): cloudHeaders, createApp(), exportRequest, importRequest, mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService (+5 more)

### Community 171 - "company-issue-identity-guard.test.ts"
Cohesion: 0.05
Nodes (54): LinearTeam, LinearTeamExpectation, LinearTeamFailure, LinearTeamMatch, LinearTeamResolution, linearTeamResolutionError(), resolveLinearTeam(), registerLinearWebhook() (+46 more)

### Community 172 - "environment-custom-image-routes.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+2 more)

### Community 173 - "log-redaction.ts"
Cohesion: 0.21
Nodes (15): CURRENT_USER_REDACTION_TOKEN, CurrentUserCandidates, CurrentUserRedactionOptions, defaultHomeDirs(), defaultUserNames(), escapeRegExp(), getDefaultCurrentUserCandidates(), isPlainObject() (+7 more)

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
Cohesion: 0.08
Nodes (33): AgentGitIdentityEnv, buildAgentGitIdentity(), buildAgentGitIdentityEnv(), CheckoutGitIdentityResult, CheckoutGitIdentityStatus, CheckoutIdentityAgentRef, defaultGitRunner(), ensureCheckoutGitIdentity() (+25 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (50): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+42 more)

### Community 181 - "native-memory-metrics.ts"
Cohesion: 0.07
Nodes (41): DEFAULT_SAMPLE_INTERVAL_MS, EXTERNAL_PEAK_COMPONENT, finite(), HEAP_TOTAL_PEAK_COMPONENT, HEAP_USED_PEAK_COMPONENT, HeapPeakReading, HeapSizeReading, readHeapPeaks() (+33 more)

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.16
Nodes (21): dedupeModels(), fetchOpenAiModels(), fingerprint(), listCodexModels(), loadCodexModels(), mergedWithFallback(), refreshCodexModels(), resetCodexModelsCacheForTests() (+13 more)

### Community 184 - "health.ts"
Cohesion: 0.20
Nodes (11): hasDevServerStatusToken(), healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), tempDirs, createApp() (+3 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.13
Nodes (25): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+17 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.13
Nodes (14): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, invalidChainReason(), readCompanyAgentRoster() (+6 more)

### Community 188 - "pipelineService"
Cohesion: 0.09
Nodes (39): redactRunError(), activityActorPatch(), assertReviewTargetsInSet(), defaultRetryCleanup(), descendantCaseIds(), getAncestorCases(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow() (+31 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.08
Nodes (36): ACTIVE_RECOVERY_ACTION_STATUSES, BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, DbOrTransaction, isRecord(), IssueRecoveryActionRow, findSupersededRestoredClaim(), retryUpsertSourceScoped(), upsertSourceScopedUnlocked() (+28 more)

### Community 190 - "github-write-egress-scrub.test.ts"
Cohesion: 0.05
Nodes (40): _resetInstallationTokenCache(), Coverage, dockerfilePath, helpersPath, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE (+32 more)

### Community 191 - "issue-workspace-command-authz.test.ts"
Cohesion: 0.11
Nodes (15): AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS, createApp(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere (+7 more)

### Community 192 - "heartbeat-pr-review-gate-replay.test.ts"
Cohesion: 0.22
Nodes (11): allyReview(), bodyAttestsToHead(), buildApp(), deliverFreshHeadSynchronize(), extractReviewedHeadSha(), FixtureReview, latestAllyReview(), NEW_HEAD_REVIEW (+3 more)

### Community 193 - "startServer"
Cohesion: 0.08
Nodes (46): startServer(), applyMigrationsForLabel(), assertCloudDatabaseContract(), ensureMigrations(), formatPendingMigrationSummary(), isPostgresConnectionString(), promptApplyMigrations(), collectPrunable() (+38 more)

### Community 194 - "heartbeat-stop-metadata.ts"
Cohesion: 0.22
Nodes (16): isMaxTurnExhaustionRun(), buildHeartbeatRunStopMetadata(), defaultTimeoutSecForAdapter(), hasOwn(), HeartbeatRunOutcome, HeartbeatRunStopMetadata, HeartbeatRunStopReason, HeartbeatRunTimeoutPolicy (+8 more)

### Community 195 - "remote-http-endpoint-guard.ts"
Cohesion: 0.20
Nodes (11): assertPublicRemoteHttpEndpoint(), isPrivateOrReservedIp(), isPrivateOrReservedIpv4(), isPrivateOrReservedIpv6(), LookupResult, lookupWithTimeout(), parseIpv4Address(), parseMappedIpv4Hex() (+3 more)

### Community 196 - "run-scratch.ts"
Cohesion: 0.19
Nodes (13): buildHeartbeatRunScratchEnv(), cleanupHeartbeatRunScratch(), HEARTBEAT_RUN_SCRATCH_MARKER, HeartbeatRunScratch, HeartbeatRunScratchCleanupResult, HeartbeatRunScratchEnvResult, HeartbeatRunScratchMetadata, isPathInside() (+5 more)

### Community 197 - "pr-review-duplicate-issue-guard.ts"
Cohesion: 0.07
Nodes (40): readGithubPrReviewerAgentIds(), __test_buildPrReviewerTaskLockKeys, assertNotDuplicatePrReviewIssue(), buildPrReviewTaskKey(), candidatePullRequestRefs(), canonicalReviewTitleHeadSha(), configuredPrReviewerAgentIds(), declaresNotAReviewRequest() (+32 more)

### Community 198 - "adapter-model-refresh-routes.test.ts"
Cohesion: 0.11
Nodes (14): createApp(), mockAccessService, mockAgentInstructionsService, mockApprovalService, mockBudgetService, mockCompanySkillService, mockEnvironmentService, mockHeartbeatService (+6 more)

### Community 199 - "agent-instructions-routes.test.ts"
Cohesion: 0.12
Nodes (13): createApp(), makeAgent(), makeReflectionCoachAgent(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockBuiltInAgentService, mockCompanySkillService (+5 more)

### Community 200 - "issue-feedback-routes.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockEnvironmentService, mockExecutionWorkspaceService, mockFeedbackExportService, mockFeedbackService, mockHeartbeatService (+6 more)

### Community 201 - "join-request-dedupe.ts"
Cohesion: 0.54
Nodes (6): collapseDuplicatePendingHumanJoinRequests(), findReusableHumanJoinRequest(), humanJoinRequestIdentity(), JoinRequestLike, nonEmptyTrimmed(), normalizeJoinRequestEmail()

### Community 202 - "issue-recovery-actions.test.ts"
Cohesion: 0.10
Nodes (32): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, summarizeStrandedRecoveryHandBackPass(), AnyFn, blockSourceOnFreshIssue() (+24 more)

### Community 203 - "metrics-ingest.ts"
Cohesion: 0.11
Nodes (22): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), AGENT_DISPATCH_DECLINED_METRIC (+14 more)

### Community 204 - "execution-policy-bootstrap.ts"
Cohesion: 0.17
Nodes (14): AdapterRegistryEnv, parseAdapterRegistryEnv(), setAdapterDisabled, reconcileAdapterAvailability(), ENTRY, KubernetesEnvironmentConfigInput, applyExecutionPolicyBootstrap(), bootstrapExecutionPolicyFromEnv() (+6 more)

### Community 205 - "body"
Cohesion: 0.04
Nodes (25): __test_resolvePostedReviewObservation, CCROTATE_CAPACITY_DEFERRED_METRIC, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC, MODEL_PROFILE_UNAPPLIED_METRIC, PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC, body(), PR126_CLEAN_REVIEW_BODY (+17 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.15
Nodes (20): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+12 more)

### Community 208 - "agent-inbox-lite.ts"
Cohesion: 0.06
Nodes (36): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN, AGENT_INBOX_LITE_STATUS_FILTER, AgentInboxLiteInput (+28 more)

### Community 209 - "model-validation.test.ts"
Cohesion: 0.18
Nodes (15): ALLOW_UNLISTED_ADAPTER_MODELS_ENV, allowsUnlistedAdapterModels(), findUnregisteredAdapterModel(), findUnregisteredModel(), introducesModel(), asModels(), claudeK8sStub(), CLI_ALIASES (+7 more)

### Community 210 - "cgroup-memory-metrics.test.ts"
Cohesion: 0.09
Nodes (34): CGROUP_ACTIVE_FILE_COMPONENT, CGROUP_ANON_COMPONENT, CGROUP_FILE_COMPONENT, CGROUP_FILE_DIRTY_COMPONENT, CGROUP_FILE_MAPPED_COMPONENT, CGROUP_FILE_WRITEBACK_COMPONENT, CGROUP_INACTIVE_FILE_COMPONENT, CGROUP_KERNEL_COMPONENT (+26 more)

### Community 211 - "result"
Cohesion: 0.06
Nodes (21): bootstrapDevRunnerWorktreeEnv(), expandHomePrefix(), isLinkedGitWorktreeCheckout(), parseEnvFile(), repairStaleMigratedWorktreeEnvEntries(), resolveDefaultWorktreeHome(), resolveHomeAwarePath(), resolveWorktreeEnvFilePath() (+13 more)

### Community 212 - "issue-document-restore-routes.test.ts"
Cohesion: 0.13
Nodes (12): createApp(), mockAccessService, mockAgentService, mockDocumentsService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockIssueThreadInteractionService (+4 more)

### Community 213 - "workspace-runtime-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): createExecutionWorkspaceApp(), createProjectApp(), mockAccessService, mockAssertCanManageExecutionWorkspaceRuntimeServices, mockAssertCanManageProjectWorkspaceRuntimeServices, mockEnvironmentService, mockExecutionWorkspaceService, mockGetTelemetryClient (+6 more)

### Community 214 - "pr-review-request-ageing.ts"
Cohesion: 0.12
Nodes (32): AgedReviewRequest, AgedReviewRequestReport, AgeingPullRequest, AGENT_AUTHOR_LOGINS, AGENT_AUTHOR_SET, ALLY_REVIEW_IDENTITY_LOGINS, ALLY_REVIEW_IDENTITY_SET, ANSWERING_REVIEW_STATES (+24 more)

### Community 215 - "logger.ts"
Cohesion: 0.06
Nodes (67): buildIssueListAnalyzeProbeQuery(), captureIssueListAnalyzeProbe(), ISSUE_LIST_ANALYZE_PROBE_FLAG, ISSUE_LIST_ANALYZE_PROBE_MAX_CAPTURES, ISSUE_LIST_ANALYZE_PROBE_OPTIONS, ISSUE_LIST_ANALYZE_PROBE_TIMEOUT_MS, issueListAnalyzeProbeCapturesTaken(), issueListAnalyzeProbeTerm() (+59 more)

### Community 216 - "dev-server-status.ts"
Cohesion: 0.24
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.14
Nodes (21): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+13 more)

### Community 218 - "heartbeat-dependency-scheduling.test.ts"
Cohesion: 0.22
Nodes (3): DEP_BLOCKED_RETRY_REASON, mockAdapterExecute, mockGbrainCall

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "createIssueGraphLivenessEscalation"
Cohesion: 0.23
Nodes (13): buildLivenessEscalationDescription(), buildLivenessOriginalIssueComment(), formatDependencyPath(), isUniqueLivenessRecoveryConflict(), livenessRecoveryLeafFingerprint(), livenessRecoveryLeafIssueId(), createIssueGraphLivenessEscalation(), findOpenLivenessEscalation() (+5 more)

### Community 221 - "dispatch-readiness.ts"
Cohesion: 0.07
Nodes (43): extractWakeCommentIds(), allowsIssueInteractionWake(), BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY, CARRIES_GITHUB_WAKE_CONTEXT_KEY, classifyHeartbeatWakeClass(), classifyQueuedRunForDependencyReap(), contextCarriesGithubWake(), deriveCommentId() (+35 more)

### Community 222 - "project-checkout-origin-reconciler.ts"
Cohesion: 0.10
Nodes (22): PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC, ProjectCheckoutOriginMismatchEntry, setProjectCheckoutOriginMismatchMetrics(), setProjectCheckoutOriginReconcileMetricsRefreshSuccess(), directoryExists(), mapWithConcurrency() (+14 more)

### Community 223 - "github-rate-limit-sampler.ts"
Cohesion: 0.12
Nodes (19): DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_INTERVAL_MS, DEFAULT_GITHUB_RATE_LIMIT_SAMPLE_REPO, defaultScheduler, GITHUB_RATE_LIMIT_SAMPLE_REPO_ENV, GithubRateLimitProbe, githubRateLimitProbes(), GithubRateLimitSamplerScheduler, headerInt() (+11 more)

### Community 224 - "isolation-workspace-reaper.ts"
Cohesion: 0.05
Nodes (51): AGENT_WORKSPACE_CLAIM_PREFIX, classifyIsolationWorkspaceAge(), createDbUnreachableAgentCount(), DEFAULT_MAX_PLAN_AGE_MS, defaultScheduler, deriveAgentWorkspaceClaimName(), hasNestedCheckout(), IsolationReclaimStopReason (+43 more)

### Community 225 - "invite-defaults-response-boundary.test.ts"
Cohesion: 0.10
Nodes (19): buildInviteOnboardingManifest(), buildInviteOnboardingTextDocument(), buildOnboardingConnectionCandidates(), buildOnboardingDiscoveryDiagnostics(), extractInviteHumanRole(), extractInviteMessage(), inviteExpired(), inviteState() (+11 more)

### Community 226 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.08
Nodes (30): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+22 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.13
Nodes (17): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken(), minDate() (+9 more)

### Community 228 - "escalateStrandedAssignedIssue"
Cohesion: 0.12
Nodes (23): issueLockOwnerStateMatches(), lockIssueOwnership(), lockIssueParentMutationCompany(), formatIssueLinksForComment(), isBlockingRelationCycleError(), isRoutineExecutionDuplicateSuppressedRun(), ProviderQuotaMonitorRollback, RecoveryEscalationRollback (+15 more)

### Community 229 - "plugin-managed-agents.ts"
Cohesion: 0.19
Nodes (27): adapterPreference(), applyInstructionTemplateVariables(), bindingExternalId(), declarationPatch(), declaredInstructionFiles(), fallbackAdapterType(), managedMetadata(), normalizeAdapterType() (+19 more)

### Community 230 - "plugin-managed-skills.ts"
Cohesion: 0.21
Nodes (22): buildDeclaredSkillFiles(), buildDefaultMarkdown(), buildPackageFiles(), buildSkillDefaults(), canonicalSkillKey(), pluginKeySlug(), pluginManagedSkillService(), declarationFor() (+14 more)

### Community 231 - "execution-workspace-per-run-isolation.test.ts"
Cohesion: 0.21
Nodes (9): applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), clampBranchBasePreservingIdentifier(), sanitizeBranchName(), createTempRepo(), execFileAsync, realizeRun(), runGit() (+1 more)

### Community 232 - "approval-routes-idempotency.test.ts"
Cohesion: 0.17
Nodes (13): createAgentApp(), createApp(), createRouteDb(), fileLivenessEscalation(), mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockEscalationCreate() (+5 more)

### Community 233 - "approval-withdraw-routes.test.ts"
Cohesion: 0.17
Nodes (9): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockLogActivity (+1 more)

### Community 234 - "company-portability.test.ts"
Cohesion: 0.14
Nodes (10): accessSvc, agentInstructionsSvc, agentSvc, assetSvc, companySkillSvc, companySvc, issueSvc, projectSvc (+2 more)

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
Nodes (68): main(), ParsedArgs, parseReclaimArgs(), parseReclaimPlan(), runReclaimExecutor(), stderrLogger, buildIsolationReclaimJobManifest(), DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS (+60 more)

### Community 239 - "routines-routes.test.ts"
Cohesion: 0.15
Nodes (11): createApp(), mockAccessService, mockAnnotationService, mockGetTelemetryClient, mockLogActivity, mockRoutineService, mockTrackRoutineCreated, pausedRoutine (+3 more)

### Community 240 - "approval-gate-reconciler.ts"
Cohesion: 0.09
Nodes (33): gateAlreadyTerminalRefusal(), announcementBody(), announcementIdempotencyKey(), announcementMetadata(), ApprovalGateReconcileResult, ApprovalGateReconcilerOptions, ApprovalGateReconcilerScheduler, approvalGatesEquivalent() (+25 more)

### Community 241 - "stranded-blocked-issue-reconciler.ts"
Cohesion: 0.07
Nodes (36): awaitingUserInputReason(), createIssueDependencyReadiness(), findBlockedPromotionsAwaitingUserInput(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds() (+28 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "instanceSettingsService"
Cohesion: 0.03
Nodes (118): appendWithCap, ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), readObject(), redactCurrentUserValue() (+110 more)

### Community 244 - "runtime-api.ts"
Cohesion: 0.56
Nodes (9): buildRuntimeApiCandidateUrls(), choosePrimaryRuntimeApiUrl(), collectReachableInterfaceHosts(), formatOrigin(), isLinkLocalHost(), isLoopbackHost(), isWildcardHost(), normalizeHost() (+1 more)

### Community 245 - "linear-webhook-fixtures.ts"
Cohesion: 0.33
Nodes (6): main(), readStdin(), LinearWebhookFixture, sanitizeLinearWebhookFixture(), sanitizeLinearWebhookValue(), SECRET_HEADER_NAMES

### Community 246 - "routineService"
Cohesion: 0.06
Nodes (48): incrementRoutineDispatchMetric(), createRoutineDispatchFingerprint(), createRoutineEnvFingerprint(), deriveRoutineFireAgeHorizonMs(), isPlainRecord(), mapRoutineDescriptionDocument(), mapRoutineRevision(), mergeRoutineRunPayload() (+40 more)

### Community 247 - "renderMetrics"
Cohesion: 0.02
Nodes (89): BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), AGENT_START_LOCK_REAP_DISPOSITION_METRIC, COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC, COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC (+81 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "plugin-metric-exposition.test.ts"
Cohesion: 0.10
Nodes (22): PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_DURATION_BUCKETS_SECONDS, PLUGIN_METRIC_DURATION_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+14 more)

### Community 250 - "accepted-interaction-outcome-sweep.ts"
Cohesion: 0.11
Nodes (23): ACCEPTED_OUTCOME_SWEEP_KINDS, AcceptedInteractionOutcomeBucketReport, AcceptedInteractionOutcomeReport, AcceptedInteractionOutcomeSample, AcceptedInteractionOutcomeSource, bucketFor(), buildAcceptedInteractionOutcomeReport(), ClassifiedRow (+15 more)

### Community 251 - "pr-reconciler-sweep.ts"
Cohesion: 0.22
Nodes (12): computeReconcilerWindow(), ReconcileFn, ReconcileResult, reconcilerSweepTick(), ReconcilerTarget, ReconcilerTokenResolution, resolveReconcilerToken(), runReconcilerSweep() (+4 more)

### Community 253 - "agent-test-environment-routes.test.ts"
Cohesion: 0.15
Nodes (12): createApp(), externalAdapter, mockAccessService, mockAgentService, mockEnvironmentRuntime, mockEnvironmentService, mockInstanceSettingsService, mockReleaseRunLease (+4 more)

### Community 254 - "scheduler-lease.ts"
Cohesion: 0.17
Nodes (21): registerPluginHolderForwardRoutes(), recordSchedulerLeaseState(), acquireSchedulerLease(), firstRow(), HEARTBEAT_TIMER_LEASE, LeaseDb, leaseHolderUrlResolver(), readSchedulerLeaseHolderId() (+13 more)

### Community 255 - "external-object-routes.test.ts"
Cohesion: 0.18
Nodes (7): createApp(), makeIssue(), mockAccessService, mockAgentService, mockExternalObjectsService, mockInstanceSettingsService, mockIssueService

### Community 256 - "issue-activity-events-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), defaultBoardActor, mockAccessService, mockFeedbackService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockLogActivity (+1 more)

### Community 257 - "github-api-refusal-metric.test.ts"
Cohesion: 0.10
Nodes (15): GITHUB_API_HELD_METRIC, GITHUB_API_REFUSALS_METRIC, GITHUB_API_REQUESTS_BY_ROUTE_METRIC, GITHUB_API_REQUESTS_METRIC, KNOWN_GITHUB_API_REFUSAL_REASONS, KNOWN_GITHUB_API_REFUSAL_RESOURCES, OTHER_GITHUB_API_REFUSAL_RESOURCE, UNKNOWN_GITHUB_API_REFUSAL_RESOURCE (+7 more)

### Community 258 - "middleware/index.ts"
Cohesion: 0.02
Nodes (71): httpLogger, createApp(), mockBumpAgentImagesForCompany, annotationComment, annotationThread, createApp(), documentPayload, mockAnnotationService (+63 more)

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

### Community 263 - "agent-scope-pinned-config-keys-routes.test.ts"
Cohesion: 0.10
Nodes (15): createApp(), hire(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity (+7 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.11
Nodes (27): versionMaterialHasValueDigest(), assertSecretRefBinding(), coerceLegacySecretRef(), countUuidValues(), createPluginSecretsHandler(), authorizeBoundSecret(), lookupBinding(), resolveBoundSecret() (+19 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "workspace-reuse-refusal-class.ts"
Cohesion: 0.10
Nodes (26): setWorkspaceReuseRefusalMetricsRefreshSuccess(), setWorkspaceReuseRefusalWindowMetrics(), WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, compareProjectCheckoutOrigin(), normalizeRepoIdentity(), ProjectCheckoutOriginVerdict, classifyWorkspaceReuseRefusal() (+18 more)

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

### Community 271 - "routes/companies.ts"
Cohesion: 0.15
Nodes (18): assertInstanceAdmin(), assertCloudTenantCaller(), cleanupTerminalImportJobs(), cloudTenantRequestKey(), CompanyImportResult, companyRoutes(), assertImportTargetAccess(), parseDateQuery() (+10 more)

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
Cohesion: 0.10
Nodes (30): assertApprovalMutationAllowedByRunContext(), toIssueActiveRunRow(), isPlanningOnlyRecoveryContextSnapshot(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS (+22 more)

### Community 277 - "accessRoutes"
Cohesion: 0.09
Nodes (27): tooManyRequests(), accessRoutes(), assertInstanceAdmin(), getInviteCompanyBranding(), getInviteLogoAsset(), actorHasActiveUserMembership(), buildCliAuthApprovalPath(), claudeHomeDisplayLabel() (+19 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "terminal-gate-reconciler.ts"
Cohesion: 0.07
Nodes (43): ISSUE_MONITOR_DISPATCH_WATCHDOG_GATE_PREFIX, recordTerminalGateResolvedSuppression(), adjudicableGateSignals(), armedMonitorNextCheckAt(), buildTerminalGateHumanOnlyComment(), buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler (+35 more)

### Community 280 - "agent-auth-jwt.ts"
Cohesion: 0.16
Nodes (17): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+9 more)

### Community 281 - "cpu-profile.ts"
Cohesion: 0.18
Nodes (19): CPU_FLIGHT_RECORDER_PRODUCTION_OPTS, CPU_PROFILE_EXTENSION, CPU_PROFILE_SENTINEL_BASENAME, CpuProfile, CpuProfileSummary, maybeDumpStallFlightRecording(), maybeTakeCpuProfile(), onRecorder() (+11 more)

### Community 282 - "workspace-dir-claim.ts"
Cohesion: 0.07
Nodes (41): isInsideRootInclusive(), isStrictlyInsideRoot(), realRoots(), refuseUnresolvablePath(), resolveWorkspaceClaimRoots(), resolveClaimDir(), acquireWorkspaceDirClaim(), ClaimOwnerLiveness (+33 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 285 - "issue-execution-lock.test.ts"
Cohesion: 0.14
Nodes (17): ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUS_VALUES, TERMINAL_HEARTBEAT_RUN_STATUSES, ActiveRunSignals, isIssueHeldByForeignRun(), isIssueHeldByForeignScheduledRetry() (+9 more)

### Community 286 - "transitionCaseInTransaction"
Cohesion: 0.10
Nodes (39): actorOwnsLease(), adjustParentCounts(), assertActorCanApproveStageExit(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable(), assertNoOpenBlockers(), assertStageEnabled() (+31 more)

### Community 287 - "approval-payload-edit-routes.test.ts"
Cohesion: 0.10
Nodes (17): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockGetPullRequestGate, mockGetWorkflowRun, mockHeartbeatService (+9 more)

### Community 288 - "unprocessable"
Cohesion: 0.08
Nodes (40): unprocessable(), assertAgentDefaultEnvironmentSelection(), validatePolicyBody(), renderOrgChartPng(), classifyPortableFileKind(), companyPortabilityService(), applyImportedAgentPermissionGrants(), assertImportAdapterConfigConstraints() (+32 more)

### Community 289 - "issue-park-expiry.ts"
Cohesion: 0.07
Nodes (18): hasLiveDeliberatePark(), isDeliberateParkActive(), ISSUE_PARK_EXPIRED_WAKE_REASON, ISSUE_PARK_EXPIRY_WAKE_STATUSES, IssueParkExpiryWakeStatus, IssueParkHandoffInput, issueParkOwesDestroyedHandoff(), IssueParkReleaseInput (+10 more)

### Community 290 - "environmentRoutes"
Cohesion: 0.10
Nodes (22): assertBoardOrgAccess(), hasBoardOrgAccess(), environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment() (+14 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.08
Nodes (5): PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, __resetQuotaExhaustedHookStateForTesting(), mockAdapterExecute

### Community 292 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "run-liveness-continuations.ts"
Cohesion: 0.16
Nodes (16): addContinuationExhaustedCommentOnce(), handleRunLivenessContinuation(), ACTIONABLE_LIVENESS_STATES, AgentRow, buildRunLivenessContinuationIdempotencyKey(), CONTINUATION_ACTIVE_ISSUE_STATUSES, CONTINUATION_AGENT_STATUSES, decideRunLivenessContinuation() (+8 more)

### Community 295 - "built-in-agent-routes.test.ts"
Cohesion: 0.18
Nodes (8): allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService, mockInstanceSettingsService, mockLogActivity, stateWithMetadata()

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "heartbeat-context-summary.test.ts"
Cohesion: 0.10
Nodes (20): computeSessionCompactionReason(), deriveNormalizedUsageDelta(), formatCount(), evaluateSessionCompaction(), getLatestRunForSession(), getOldestRunForSession(), resolveNormalizedUsageForSession(), parkForPrompt() (+12 more)

### Community 298 - "run-secret-redaction.ts"
Cohesion: 0.12
Nodes (23): isSyntheticNonProgressRunLogChunk(), compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan() (+15 more)

### Community 299 - "agent-live-run-routes.test.ts"
Cohesion: 0.06
Nodes (20): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, createApp(), mockAccessDecide, mockAgentService (+12 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (22): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+14 more)

### Community 302 - "agent-redaction.ts"
Cohesion: 0.12
Nodes (24): asRecord(), containsRedactedAdapterValue(), isRedactedEnvBinding(), maskUnwalkableAgentConfigForRead(), walk(), OMIT_REDACTED_ADAPTER_VALUE, REDACTED_ENV_SENTINEL, restoreRedactedAdapterValue() (+16 more)

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.05
Nodes (19): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets(), AgentRow, CompanyRow (+11 more)

### Community 304 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 305 - "ccrotate-capacity-retry.ts"
Cohesion: 0.03
Nodes (68): CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MIN_PARK_MS, CCROTATE_CAPACITY_OVERRIDE_KEYS (+60 more)

### Community 306 - "zoned-cron.ts"
Cohesion: 0.07
Nodes (37): ParsedCron, EVERY_DAY, gapsFor(), SAMPLED_AT, resetRoutineFireGapsMemoForTests(), buildCronMask(), CronMask, daysInMonth() (+29 more)

### Community 307 - "issueRecoveryActionService"
Cohesion: 0.13
Nodes (13): issueRecoveryActionService(), dischargeActionsWithRestoredExecution(), escalateExpiredWakeHorizons(), getActiveForIssue(), getById(), listActiveForIssues(), resolveActiveForIssue(), retireWakeAction() (+5 more)

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.11
Nodes (12): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, AgentRow, collectWriterFiles(), columnReasonLiteralsFromDirectInserts(), CompanyRow, createApp(), Db, isProductionSource() (+4 more)

### Community 309 - "builtInAgentService"
Cohesion: 0.11
Nodes (53): assertAdapterAllowed(), assertKnownBuiltInAgentModel(), builtInAgentService(), autoProvisionBundledAgents(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), defaultProvisionInput() (+45 more)

### Community 310 - "invite-rate-limit.ts"
Cohesion: 0.21
Nodes (6): createInviteRateLimiter(), INVITE_RATE_LIMIT_MAX_REQUESTS, INVITE_RATE_LIMIT_WINDOW_MS, InviteRateLimiter, InviteRateLimitResult, createApp()

### Community 311 - "recovery-stale-issue-lock-sweep.test.ts"
Cohesion: 0.10
Nodes (8): AGENT_POD_BUSY_MAX_STALE_MS, NON_LIVE_EXECUTION_SILENCE_MS, LOCKLESS_DEFERRED_WAKE_MIN_AGE_MS, STALE_RUNNING_ISSUE_LOCK_MS, mockProbeAgentPodActivity, mockTelemetryClient, seedDeclaredAndUndeclared(), seedStrandedPromotion()

### Community 312 - "plugin-event-bus.ts"
Cohesion: 0.11
Nodes (12): createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus, Subscription (+4 more)

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "startup-banner.ts"
Cohesion: 0.17
Nodes (17): readConfigFile(), resolveDefaultConfigPath(), resolveDefaultLogsDir(), resolveServerLogDir(), findConfigFileFromAncestors(), resolvePaperclipConfigPath(), resolvePaperclipEnvPath(), ansi (+9 more)

### Community 315 - "isolation-reclaim-self.ts"
Cohesion: 0.21
Nodes (15): imageRepositoryOf(), mountCoversPath(), readInClusterReclaimSelfPodIdentity(), readReclaimSelfPodIdentity(), ReadReclaimSelfPodIdentityOptions, ReclaimSelfPodIdentity, ReclaimSelfPodIdentityResult, resolveSelfDataClaimName() (+7 more)

### Community 316 - "environment-live-ssh.test.ts"
Cohesion: 0.50
Nodes (7): describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest(), tryEnvLabFixture(), tryExplicitConfig()

### Community 317 - "evidence-truth.ts"
Cohesion: 0.11
Nodes (21): allyVerdictReviewerLane(), buildGithubTruthProbe(), GithubTruthDeps, LinkedPrRefs, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr (+13 more)

### Community 318 - "process-crash-guard-exit.test.ts"
Cohesion: 0.14
Nodes (12): MAX_WRITE_WAIT_MS, CrashResult, fixture, here, LATE_BACKPRESSURE_RUN, PREFILL_RUN, readRemainingStderr(), runFixtureWithStalledStderr() (+4 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "pod-log-sweeper.ts"
Cohesion: 0.08
Nodes (28): TERMINAL_RUN_STATUSES, locatePodLogArtifact(), OrphanedRunTerminalResult, readOptionalString(), readOrphanedRunTerminalResult(), readTerminalResult(), resultEventReportsSuccess(), runLogBasePath() (+20 more)

### Community 321 - "claude-agent-id-header.test.ts"
Cohesion: 0.33
Nodes (3): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "StorageService"
Cohesion: 0.08
Nodes (20): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isAllowedContentType(), isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES (+12 more)

### Community 324 - "services/index.ts"
Cohesion: 0.03
Nodes (74): SkillPolicyDenialResponse, SkillPolicyResourceInput, SkillTelemetryInput, SkillTestRunAssignmentAuthorizationScope, GrantInput, MemberArchiveInput, MembershipRow, ACTIVITY_ACTION_TO_PLUGIN_EVENT (+66 more)

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

### Community 329 - "issue-checkout-status.ts"
Cohesion: 0.13
Nodes (16): externalWaitDescriptionCandidate, externalWaitFromDescription(), checkoutRestoreStatusExpression, checkoutRestoreTargetStatus(), DbOrTransaction, hasCancelledBlocker, hasPendingBlocker, holdsDispatchableMonitor (+8 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.08
Nodes (32): basenameOf(), COMMAND_PREFIXES, findMissingHookCommandPaths(), HookCommandAuditDeps, HookCommandAuditFinding, INCLUDE_DIR_OPERAND_OPTIONS, isAbsoluteLiteral(), isScriptInterpreter() (+24 more)

### Community 331 - "fd-class-metrics.ts"
Cohesion: 0.12
Nodes (22): boundedDirLabel(), boundedSegment(), classifyFdTarget(), CollectFdClassOptions, collectFdClassSnapshot(), FD_CLASS_MAX_ENTRIES, FD_CLASS_MAX_SEGMENT_CHARS, FD_CLASS_MAX_SERIES (+14 more)

### Community 332 - "notFound"
Cohesion: 0.03
Nodes (82): conflict(), notFound(), assertBuiltInAgentsEnabled(), activationEntityTypeBody(), cloudUpstreamRoutes(), assertEnabled(), optionalString(), stringBody() (+74 more)

### Community 333 - "pluginCapabilityValidator"
Cohesion: 0.06
Nodes (19): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, CapabilityScopedInvoker, DEFAULT_GLOBALS (+11 more)

### Community 334 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 335 - "pr-review-request-ageing-producer.ts"
Cohesion: 0.16
Nodes (14): DigestProducer, DigestSection, DEFAULT_ESCALATE_AFTER_DAYS, formatPullRequestRef(), buildPrReviewRequestAgeingSection(), LoadedReviewState, PR_REVIEW_REQUEST_AGEING_SECTION_KEY, prReviewRequestAgeingProducer (+6 more)

### Community 336 - "setupEnvironmentCustomImageTerminalWebSocketServer"
Cohesion: 0.12
Nodes (13): clientSafeErrorMessage(), closeClient(), createSsh2EnvironmentCustomImageSshConnector(), EnvironmentCustomImageSshConnector, errorStatus(), handleClientFrame(), parseTerminalDimension(), parseTerminalPath() (+5 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.20
Nodes (8): INSTANCE_ROOT_ARTIFACT_STORE_ENV_VARS, require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance, viWithPatchFlag, WaitForOptions

### Community 338 - "agent-pinned-config-keys-survive-heartbeat-mock.test.ts"
Cohesion: 0.12
Nodes (15): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockHeartbeatTotally(), mockLogActivity (+7 more)

### Community 339 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (19): createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile(), PhaseStat (+11 more)

### Community 340 - "queued-run-age-metrics.ts"
Cohesion: 0.04
Nodes (58): deferWroteQueuedAtSql(), HeartbeatWakeClass, QUEUE_ENTERED_AT_CONTEXT_KEY, queueEnteredAtSql(), MAX_TURN_CONTINUATION_MAX_DELAY_MS, DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC, DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS (+50 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "issue-update-comment-wakeup-routes.test.ts"
Cohesion: 0.13
Nodes (18): commentEffectLedger, createApp(), drizzleTableName, lastSelectedTable, ledgerRows, makeIssue(), mockCommentEffects, mockGetActiveCompanyMembership (+10 more)

### Community 343 - "gbrain-client-factory.test.ts"
Cohesion: 0.20
Nodes (7): BearerSource, createServerGbrainClient(), NullBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 344 - "legacy-next-cron-tick-in-time-zone.ts"
Cohesion: 0.33
Nodes (9): assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute(), nextCronTickInTimeZone(), WEEKDAY_INDEX, zonedMinuteFormatterCache (+1 more)

### Community 345 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.05
Nodes (42): resolveDefaultSecretsKeyFilePath(), AwsSecretsManagerMaterial, awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider (+34 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.12
Nodes (19): listSuccessfulRunHandoffStates(), successfulRunHandoffStateFromActivity(), findAcceptedPlanDocumentInteraction(), isTreeHoldInteractionCheckoutAllowed(), listSuccessfulRunHandoffMapForIssues(), readAcceptedPlanConfirmationTarget(), readStringFromRecord(), readSuccessfulRunHandoffFromActivity() (+11 more)

### Community 348 - "plugin-store-consistency.test.ts"
Cohesion: 0.13
Nodes (7): ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), SDK_NOT_INSTALLED_ERROR_MARKER, SDK_STORE_CONSISTENCY_MIN_STABLE_MISMATCH_MS, SDK_STORE_CONSISTENCY_RECHECK_DELAYS_MS

### Community 349 - "pipeline-stage-workspace-settings-withholding.test.ts"
Cohesion: 0.19
Nodes (12): withPublicIssueWorkspaceSettings(), publicIssueExecutionWorkspaceSettings(), publicPipelineStageConfig(), WITHHELD_WORKSPACE_RUNTIME_VIEWER, ENTITLED_VIEWER, withheld(), ENTITLED_VIEWER, roundTrip() (+4 more)

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

### Community 356 - "heartbeat-worker-crash-marking.test.ts"
Cohesion: 0.12
Nodes (9): HeartbeatEnvironmentRuntime, createBudgetFixture(), insertCostEvent(), latchAgentOnBudget(), mockLogActivity, SelectResult, insertRun(), seedCrashMarkedRun() (+1 more)

### Community 357 - "pipelines-service.test.ts"
Cohesion: 0.14
Nodes (14): loadPipelineDescendantActiveWorkCounts(), PIPELINE_CASE_EVENTS_MAX_LIMIT, PIPELINE_CONTEXT_PACK_EVENT_LIMIT, PipelineActor, app(), plantedStageConfig(), seedCarrier(), seedCompany() (+6 more)

### Community 358 - "issue-liveness.test.ts"
Cohesion: 0.31
Nodes (7): waiting(), blockedBlocker(), blocks, deadEnd(), issue(), manager, monitorOnlyIssue()

### Community 359 - "approval-create-issue-link-authorization.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 360 - "pull-request-work-products.ts"
Cohesion: 0.07
Nodes (29): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_REPAIRED_BY_RECONCILER, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestHasMerged() (+21 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "kkroo-bundled-plugins.ts"
Cohesion: 0.21
Nodes (16): autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin(), installKkrooLocalPlugins() (+8 more)

### Community 363 - "dev-watch-ignore.ts"
Cohesion: 0.70
Nodes (3): addIgnorePath(), resolveServerDevWatchIgnorePaths(), toGlobstarPath()

### Community 364 - "first-admin-claim.ts"
Cohesion: 0.50
Nodes (3): claimFirstInstanceAdmin(), FirstAdminClaimResult, FirstAdminTransaction

### Community 365 - "approval-link-route-equivalence.test.ts"
Cohesion: 0.13
Nodes (12): attachViaCreateRoute(), attachViaLinkRoute(), createApp(), createRouteDb(), mockAccessService, mockAgentService, mockApprovalService, mockHeartbeatService (+4 more)

### Community 366 - "applyDocumentFixups"
Cohesion: 0.60
Nodes (5): applyDocumentFixups(), applyOperationStatusOverride(), isBoardOnlyOperation(), operationKey(), resolveOperationAuthLevel()

### Community 367 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.08
Nodes (19): readExternalLifecycleProviderCapacityRefusal(), parseProviderCapacityResetHorizon(), resolveProviderCapacityHorizon(), PROVIDER_CAPACITY_MAX_HORIZON_MS, findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), readRunLogTerminalTail() (+11 more)

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
Cohesion: 0.27
Nodes (8): buildFixture(), createAgent(), createCompany(), createIssue(), createProject(), grantAgentPermission(), IssueAction, Relation

### Community 374 - "routine-fire-gap-metrics.test.ts"
Cohesion: 0.11
Nodes (16): PROCESS_MAPPING_COUNT_METRIC, ROUTINE_DISPATCH_METRIC, ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC, ROUTINE_FIRE_INTERVAL_METRIC, ROUTINE_LAST_DONE_FIRE_AGE_METRIC, ROUTINE_LAST_FIRE_START_AGE_METRIC, ALLOWED_UNRESOLVED_REFERENCES, danglingHelpReferences() (+8 more)

### Community 375 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.23
Nodes (13): buildSchedulerFailureHeartbeatKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat(), postRoutineSchedulerFailureHeartbeat(), postSchedulerHeartbeat() (+5 more)

### Community 376 - "issueThreadInteractionService"
Cohesion: 0.11
Nodes (18): assertExpectedOutcomeRefResolves(), buildIssueDocumentTargetFromDocument(), buildTaskCreationOrder(), buildWithdrawnInteractionResult(), isCommentAtOrAfterInteraction(), isEquivalentCreateRequest(), isIssueThreadInteractionIdempotencyConflict(), isServerOwnedToolActionInteraction() (+10 more)

### Community 377 - "agent-budget-mirror-write.test.ts"
Cohesion: 0.14
Nodes (13): agentActor, agentRow, baseAgent, boardActor, createApp(), createDbStub(), mockAccessService, mockAgentService (+5 more)

### Community 378 - "graceful-shutdown-exit.test.ts"
Cohesion: 0.40
Nodes (4): fixture, here, serverRoot, tsx

### Community 379 - "invite-create-route.test.ts"
Cohesion: 0.60
Nodes (4): createApp(), createDbStub(), logActivityMock, registerModuleMocks()

### Community 380 - "invite-summary-route.test.ts"
Cohesion: 0.29
Nodes (3): ACTIVE_INVITE_EXPIRES_AT, createApp(), mockStorage

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

### Community 386 - "approval-revision-exit.test.ts"
Cohesion: 0.15
Nodes (10): BOARD_NOTE, get(), mockAgentService, mockApprovalService, mockListIssuesForApproval, mockLogActivity, mockWakeup, racingUpdates() (+2 more)

### Community 387 - "parseIssueExecutionState"
Cohesion: 0.06
Nodes (51): dispatchWatchdogRearmDelayMs(), clearIssueMonitorAndRecover(), dispatchClaimedIssueMonitor(), findOpenIssueMonitorRecoveryIssue(), formatIssueIdentifierLink(), monitorRecoveryComment(), monitorRecoveryDetails(), monitorRecoveryPolicy() (+43 more)

### Community 388 - "company-search-rate-limit.ts"
Cohesion: 0.21
Nodes (8): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), createApp(), unusedSearch()

### Community 389 - "approval-link-requested-by-self.test.ts"
Cohesion: 0.12
Nodes (12): attachViaCreateRoute(), attachViaLinkRoute(), createApp(), createRouteDb(), mockAccessService, mockAgentService, mockApprovalService, mockHeartbeatService (+4 more)

### Community 390 - "readPenstockCapacity"
Cohesion: 0.27
Nodes (10): capacityEndpointUnavailable(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger, penstockModelId() (+2 more)

### Community 391 - "chain-pass-timing.ts"
Cohesion: 0.17
Nodes (9): createRecoveryChainTimer(), RECOVERY_CHAIN_PASS_TIMING_MESSAGE, RECOVERY_CHAIN_TIMING_MESSAGE, RecoveryChainPassOutcome, RecoveryChainPassRecord, RecoveryChainTimer, RecoveryChainTimerOptions, harness() (+1 more)

### Community 392 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 393 - "task-watchdog-scope.ts"
Cohesion: 0.23
Nodes (11): rejectTaskWatchdogConfigMutation(), resolveTaskWatchdogProductBugFollowUp(), resolveWatchdogFollowUpSerializationContext(), AgentRunActor, isPlainRecord(), IssueScopeTarget, readString(), readTaskWatchdogContext() (+3 more)

### Community 394 - "heartbeat-workspace-finalize-branch.test.ts"
Cohesion: 0.14
Nodes (8): adapterExecute, createGitRepo(), Db, drainInFlightExecutions(), execFileAsync, Heartbeat, runGit(), seedRunTarget()

### Community 395 - "createToolGatewayService"
Cohesion: 0.04
Nodes (111): asRecord(), auditSafeEndpoint(), backfillPendingActionRequestSignature(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions(), assertAgentInCompany() (+103 more)

### Community 396 - "user-profiles.ts"
Cohesion: 0.25
Nodes (16): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+8 more)

### Community 399 - "docker-onboard-smoke-contract.test.ts"
Cohesion: 0.50
Nodes (3): repoRoot, smokeScript, smokeWorkflow

### Community 401 - "agent-model-registry-validation.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockFindUnregisteredAdapterModel, mockLogActivity (+6 more)

### Community 402 - "openclaw-invite-prompt-route.test.ts"
Cohesion: 0.25
Nodes (8): createApp(), createDbStub(), createSelectChain(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity, mockStorage

### Community 403 - "approvals-service.test.ts"
Cohesion: 0.11
Nodes (7): ApprovalRecord, expectRejectedWithoutMutation(), mockAgentService, mockLogActivity, mockNotifyHireApproved, withdrawalActor, orderBy()

### Community 404 - "documents.ts"
Cohesion: 0.31
Nodes (7): documentService(), extractLegacyPlanBody(), issueDocumentSelect, isUniqueViolation(), mapIssueDocumentRow(), nextAvailableDocumentKey(), normalizeDocumentKey()

### Community 405 - "sandbox-provider-runtime.ts"
Cohesion: 0.05
Nodes (41): ParsedEnvironmentConfig, probeEnvironment(), probeK8sEnvironment(), raceWithTimeout(), findReusableSandboxLeaseId(), probePluginSandboxProviderDriver(), AcquireSandboxLeaseInput, acquireSandboxProviderLease() (+33 more)

### Community 406 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.13
Nodes (9): createDb(), createSelectChain(), then(), values(), chartDir, BUDGET_PATH, readNumber(), readValuesInt() (+1 more)

### Community 409 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 410 - "ensureHumanRoleDefaultGrants"
Cohesion: 0.07
Nodes (23): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, ensureRoleDefaultGrants(), backfillPrincipalAccessCompatibility(), ensureHumanRoleDefaultGrants(), GrantInput, insertMissingPrincipalGrants() (+15 more)

### Community 411 - "isolation-reclaim-job-port.ts"
Cohesion: 0.20
Nodes (9): createInClusterIsolationReclaimJobPort(), createIsolationReclaimJobPort(), IsolationReclaimJobPortClients, RECLAIM_JOB_NAME_LABEL, RECLAIM_PORT_LOG_TIMEOUT_MS, RECLAIM_PORT_REQUEST_TIMEOUT_MS, Recorded, STATUS_SHAPES (+1 more)

### Community 412 - "heartbeat-hard-stale-subprocess-liveness.test.ts"
Cohesion: 0.14
Nodes (10): numberFromEnv(), parseCpuQuantityToMillicores(), mockDeleteAgentJobExact, mockDeleteAgentJobsForRun, mockHasActiveJobForAgent, mockListAgentJobRunStatuses, mockListLiveAgentJobRunIds, mockListManagedAgentJobs (+2 more)

### Community 413 - "live-events.ts"
Cohesion: 0.14
Nodes (12): emitter, LiveEventListener, LiveEventPayload, publishGlobalLiveEvent(), subscribeCompanyLiveEvents(), toLiveEvent(), captureActivityEvents(), captureActivityEvents() (+4 more)

### Community 421 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.11
Nodes (8): blocked(), humanGatedAgeingProducer, collect(), NOW, CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

### Community 425 - "claude-code-version.test.ts"
Cohesion: 0.18
Nodes (13): CLAUDE_CODE_EXACT_VERSION_RE, CLAUDE_CODE_RUNTIME_FROM_IMAGE, CLAUDE_CODE_VERSION_CONFIG_KEY, ClaudeCodeVersionPreviousScope, findInadmissibleClaudeCodeVersion(), InadmissibleClaudeCodeVersion, introducesClaudeCodeVersion(), isAdmissibleClaudeCodeVersion() (+5 more)

### Community 426 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 427 - "cases-routes.test.ts"
Cohesion: 0.20
Nodes (3): app(), authenticatedApp(), enableCases()

### Community 428 - "taskWatchdogService"
Cohesion: 0.21
Nodes (15): buildStoppedFingerprintComment(), isTerminalIssueStatus(), isWatchdogReviewDisposition(), stoppedFingerprintMetadata(), taskWatchdogService(), ensureReusableWatchdogIssue(), evaluateWatchdog(), findTaskWatchdogIssue() (+7 more)

### Community 431 - "heartbeat-cancelled-monitor-recovery.test.ts"
Cohesion: 0.13
Nodes (5): CLEARED_AT, GATE_SIGNALS, InertLine, LONG_PAST_CLEARED_AT, MonitorResidue

### Community 433 - "scrape-metrics-collector.ts"
Cohesion: 0.04
Nodes (57): describeHeldAgentStartLocks(), BOARD_DECISION_STATUSES, MERGE_GATE_DECISION, PENDING_SINCE, refreshApprovalQueueMetrics(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES (+49 more)

### Community 437 - "app.ts"
Cohesion: 0.03
Nodes (81): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), pluginStateFingerprint(), pluginStateSnapshot(), PRECOMPRESSED_STATIC_EXTENSIONS (+73 more)

### Community 438 - "readNonEmptyString"
Cohesion: 0.24
Nodes (14): hasOwn(), assertMonitorArmingAllowedByRunContext(), cancelScheduledRetrySupersededByComment(), resolveRunIssueWorkspaceInheritanceSource(), queueResolvedInteractionContinuationWakeup(), readCheckboxSelectionForWake(), readConfirmationResultForWake(), readInteractionWithdrawalReason() (+6 more)

### Community 442 - "github-fetch.ts"
Cohesion: 0.08
Nodes (35): classifyGithubApiRoute(), classifyGithubRefusal(), classifyGithubRefusalResource(), countGithubApiAttempt(), countGithubApiHeld(), countGithubRefusal(), GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS (+27 more)

### Community 446 - "agent-start-lock-db.ts"
Cohesion: 0.22
Nodes (13): abortedAgentId(), abortReason(), CancellableQuery, cancelQuery(), isPostgresClient(), isPromiseLike(), PostgresClient, NOTE: this is a pre-check, not cancellation. Once the real call is (+5 more)

### Community 447 - "issue-monitor-convergence-guard.test.ts"
Cohesion: 0.22
Nodes (13): computeIssueMonitorGateFingerprint(), evaluateIssueMonitorConvergence(), normalizeGateToken(), normalizeIssueMonitorConvergenceThreshold(), normalizeIssueMonitorGateSignals(), arm(), checkAt(), fire() (+5 more)

### Community 450 - "issue-tree-hold-metrics.ts"
Cohesion: 0.21
Nodes (12): ActivePauseHoldRow, activePauseHoldsGauge(), AGE_BUCKETS, AgeBucket, countActivePauseHolds(), ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC, IssueTreeHoldCollectorOptions, setActivePauseHolds() (+4 more)

### Community 460 - "secretService"
Cohesion: 0.05
Nodes (75): checkSecretProviders(), getSecretProvider(), listSecretProviders(), isSecretProviderClientError(), asRecord(), assertClass3StaticLeaseAllowed(), assertSelectableProviderConfig(), CanonicalEnvBinding (+67 more)

### Community 461 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.06
Nodes (14): PluginJobScheduler, buildPluginInstallArgs(), execFileAsync, npmInstallPlugin(), PluginRuntimeServices, WorkerToHostHandlers, FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR (+6 more)

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
Cohesion: 0.22
Nodes (8): EventLoopDelayHistogram, EventLoopStallLogOptions, resolveStallThresholdMs(), setEventLoopStallListener(), startEventLoopStallLogging(), blockEventLoop(), sleep(), stallTheLoop()

### Community 466 - "orphan-reap-adapter-invoke-probe-batching.test.ts"
Cohesion: 0.22
Nodes (4): listManagedAgentJobsMock, probeAgentPodActivityMock, readAgentJobRunStatusByNameMock, RecordedQuery

### Community 467 - "company-skills-service.test.ts"
Cohesion: 0.16
Nodes (3): Db, truncateCompanyScopedTestState(), TruncateCompanyScopedTestStateOptions

### Community 468 - "backfill-agent-bundle.ts"
Cohesion: 0.23
Nodes (11): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+3 more)

### Community 469 - "plugin-activation-retry-provenance.test.ts"
Cohesion: 0.20
Nodes (7): WorkerStartupError, createTestWorkerHandle(), FakeChild, { forkMock }, installForkMock(), spawned, wrappedInitializeFailure()

### Community 470 - "PluginWorkerManager"
Cohesion: 0.20
Nodes (5): PluginRouteWebhookDeps, PluginWorkerManager, runContract(), RuntimeContractCase, seedEnvironment()

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
Cohesion: 0.05
Nodes (104): buildSkillRuntimeName(), bundledFolderLabel(), companySkillService(), actorStarClause(), applySkillReassignments(), assertCanMutateComment(), assertCatalogSkillInstallable(), auditSkill() (+96 more)

### Community 482 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 483 - "issue-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockGetTelemetryClient, mockIssueService (+1 more)

### Community 484 - "issues-open-assignment-census.test.ts"
Cohesion: 0.18
Nodes (7): clampIssueListLimit(), OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, appAs(), oracle(), PRIORITY_RANK, rankOf()

### Community 485 - "assertAssignableAgent"
Cohesion: 0.27
Nodes (10): AgentAssignmentConflictReason, AgentAssignmentKind, assertAssignableAgent(), AssignabilityAgent, assignmentMessage(), assignmentReasonFromHealth(), conflictDetails(), getAgent() (+2 more)

### Community 486 - "plugin-worker-invocation-scope.cjs"
Cohesion: 0.40
Nodes (5): pendingNested, readline, rl, send(), sendNestedHostRequest()

### Community 487 - "billing-classification.ts"
Cohesion: 0.35
Nodes (9): CASH_ZEROING_BILLING_TYPE, DIRECT_METERED_BILLING_TYPES, isBrokeredLane(), isPenstockBaseUrl(), LaneBillingInput, normalizeLedgerBillingType(), PROVIDER_BASE_URL_ENV, readEnvString() (+1 more)

### Community 488 - "issue-release-lock-only-degrade.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedHolderRun(), seedStalePair()

### Community 489 - "heartbeat-run-summary.ts"
Cohesion: 0.33
Nodes (9): buildHeartbeatRunIssueComment(), HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS, HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS, HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES, mergeHeartbeatRunResultJson(), readCommentText(), readNumericField(), summarizeHeartbeatRunResultJson() (+1 more)

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

### Community 511 - "pen4902-heartbeat-runs-route-params.test.ts"
Cohesion: 0.17
Nodes (10): boardActor, createApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService (+2 more)

### Community 513 - "approval-gate-already-terminal.test.ts"
Cohesion: 0.10
Nodes (15): createAgentApp(), createRouteDb(), found(), MISMATCHED_GATE, mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockGetPullRequestGate (+7 more)

### Community 515 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 516 - "scrape-metrics-routine-fire-gap-work.test.ts"
Cohesion: 0.22
Nodes (5): db, rows, settle(), tickAt(), TRIGGERS

### Community 517 - "applyResponsibleUserIntersection"
Cohesion: 0.22
Nodes (9): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), applyResponsibleUserIntersection(), decide(), getResponsibleUserSnapshot(), loadResponsibleUserSnapshot(), companyIdForResource() (+1 more)

### Community 518 - "ws-upgrade-url-log-guard.test.ts"
Cohesion: 0.31
Nodes (8): argumentText(), COVERED, here, identifierPattern(), rawUrlLogCalls(), serverSrc, taintedLocals(), tsFilesUnder()

### Community 519 - "issue-visibility.ts"
Cohesion: 0.17
Nodes (15): ActivityFilters, activityService(), asRecord(), backfillMissingRunLivenessForIssue(), countValue(), dateValue(), latestDate(), readNumber() (+7 more)

### Community 520 - "inspectExecutionWorkspaceBranchForReconcile"
Cohesion: 0.32
Nodes (8): execFileAsync, explainGitWorktreeBranchReconcileInspection(), fingerprintWorkspaceBranchIncoherence(), getGitWorktreeBranchAncestryVerdict(), inspectExecutionWorkspaceBranchForReconcile(), readGitStdout(), runGit(), stableStringify()

### Community 521 - "workspace-runtime-read-model.ts"
Cohesion: 0.39
Nodes (7): loadEffectiveRuntimeServicesByExecutionWorkspace(), listCurrentRuntimeServicesForExecutionWorkspaces(), listCurrentRuntimeServicesForProjectWorkspaces(), runtimeServiceIdentityKey(), RuntimeServiceReadDb, selectCurrentRuntimeServiceRows(), WorkspaceRuntimeServiceRow

### Community 522 - "execution-workspaces-service.test.ts"
Cohesion: 0.46
Nodes (6): createTempRepo(), execFileAsync, fingerprintWorkspaceBranchIncoherenceForTest(), readGit(), runGit(), stableStringifyForTest()

### Community 523 - "plugin-orchestration-apis.test.ts"
Cohesion: 0.32
Nodes (3): issuePrefix(), seedCompanyAndAgent(), seedIssueWithWorktree()

### Community 524 - "pr-review-state-reconciler.test.ts"
Cohesion: 0.26
Nodes (9): ghFetchMock, graphQlPullRequestsEnvelope(), graphQlReviewsEnvelope(), graphQlVariables(), isPullRequestsQuery(), isReviewsQuery(), jsonResponse(), NOW (+1 more)

### Community 526 - "readProjectWorkspaceRuntimeConfig"
Cohesion: 0.81
Nodes (6): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates()

### Community 527 - "classifyTaskWatchdogSubtree"
Cohesion: 0.22
Nodes (10): classifyTaskWatchdogSubtree(), issueUpdatedAtIso(), optionalIso(), pathIssueIds(), stableStopFingerprint(), TaskWatchdogClassifierIssue, toEpochMs(), waitingPathIds() (+2 more)

### Community 528 - "buildLocalUpstreamExportBundle"
Cohesion: 0.29
Nodes (10): buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), canonicalJson(), buildBundle(), countEntityTypesForManifest(), normalizedContentHash(), normalizePortableFileEntry() (+2 more)

### Community 530 - "database-backup-health.ts"
Cohesion: 0.29
Nodes (9): alertFileCandidates(), DatabaseBackupHealthStatus, DatabaseBackupHealthWarning, DatabaseBackupHealthWarningCode, findLatestBackup(), inspectDatabaseBackupHealth(), InspectDatabaseBackupHealthOptions, readLastFailure() (+1 more)

### Community 531 - "heartbeat-worktree-suppression.test.ts"
Cohesion: 0.33
Nodes (4): armWorktreeRunExecution(), deleteHeartbeatRunsWithDependents(), drainInFlightExecutions(), isHeartbeatRunDependentFkError()

### Community 532 - "recovery-chain-pass-timing-wiring.test.ts"
Cohesion: 0.29
Nodes (4): heartbeatSrc, here, indexSrc, recoverySrc

### Community 533 - "heartbeat-queued-backlog-convergence.test.ts"
Cohesion: 0.20
Nodes (3): STARVATION_ABSOLUTE_ESCALATION_MS, STARVATION_FULL_ESCALATION_MS, mockAdapterExecute

### Community 534 - "assignmentPolicyEffect"
Cohesion: 0.47
Nodes (6): assignmentPolicyEffect(), loadIssueAuthorizationPolicy(), loadProjectAuthorizationPolicy(), loadRunPolicy(), isPlainRecord(), readPolicyObject()

### Community 535 - "expireStaleRequestConfirmationTarget"
Cohesion: 0.31
Nodes (10): buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult(), expireStaleRequestConfirmationTarget(), hydrateInteraction(), acceptRequestConfirmation(), rejectRequestConfirmation(), isTargetBoundInteractionKind() (+2 more)

### Community 536 - "collectClassifierInput"
Cohesion: 0.24
Nodes (10): watchdogMapForIssues(), issueIdFromRunContext(), issueIdFromWakePayload(), readNonEmptyString(), summarizeIssueWatchdog(), collectClassifierInput(), collectCompletedRunIssueIds(), loadWatchdogSubtreeIssues() (+2 more)

### Community 537 - "heartbeat-finalize-cancelled-skip-dispatch.test.ts"
Cohesion: 0.40
Nodes (3): getRunStatus(), mockAdapterExecute, waitForStatus()

### Community 538 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

### Community 539 - "sweep-wake-preflight.test.ts"
Cohesion: 0.22
Nodes (9): composeSweepWakeFramePage(), quoteYamlScalar(), renderYamlArray(), SweepWakeFrame, SweepWakeFrameIdentity, SweepWakeIssueSnapshot, baseFrame, baseIdentity (+1 more)

### Community 540 - "healthz-probe-route.test.ts"
Cohesion: 0.40
Nodes (3): HEALTH_PROBE_DEADLINE_MS, appSource, repoRoot

### Community 541 - "orphan-reap-per-run-sub-stage-audit.test.ts"
Cohesion: 0.50
Nodes (4): KNOWN_ORPHAN_REAP_STAGES, HEARTBEAT_SOURCE, readPerRunLoop(), stripComments()

### Community 542 - "project-managed-plugin-defaults-boundary.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), managedByPluginFixture(), mockAccessService, mockGetTelemetryClient, mockLogActivity, mockProjectService, mockSecretService, projectFixture()

### Community 548 - "skills-catalog-service.test.ts"
Cohesion: 0.20
Nodes (7): catalogSkill(), mockExistsSync, mockLoggerWarn, mockReadFile, mockReadFileSync, mockRequireResolve, mockStatSync

### Community 549 - "db-inherited-timeout-metric.test.ts"
Cohesion: 0.31
Nodes (7): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, POOL_IDLE_IN_TRANSACTION_SERIES, setDbInheritedTimeouts(), readings(), seriesFor()

### Community 550 - "issue-assignment-wakeup.ts"
Cohesion: 0.28
Nodes (6): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail, allowPenstockGate

### Community 551 - "emitInteractionResolvedTelemetry"
Cohesion: 0.25
Nodes (9): buildInteractionResolvedCounts(), deriveResolutionReason(), deriveTargetType(), emitInteractionResolvedTelemetry(), emitResolvedInteractionsTelemetry(), fetchCreatorAgentRoleById(), nonNegativeInteger(), resolveActorKind() (+1 more)

### Community 552 - "approval-list-pagination.test.ts"
Cohesion: 0.22
Nodes (7): createApp(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockSecretService

### Community 553 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 554 - "sse-registry.ts"
Cohesion: 0.39
Nodes (5): active, MAX_SSE_BACKLOG_BYTES, sseBacklogExceeded(), sseRegistry, writeSseFrame()

### Community 556 - "responsible-user-denial-run-outcomes.ts"
Cohesion: 0.43
Nodes (4): row(), normalizeResponsibleUserDenialCode(), recordResponsibleUserDenialOnActiveRun(), publishLiveEventMock

### Community 557 - "agent-wakeup-target.ts"
Cohesion: 0.33
Nodes (4): wakeRequestTargetsAnyIssueCondition(), ARMS, dialect, RENDERINGS

### Community 558 - "heartbeat-per-run-sub-stage-split.test.ts"
Cohesion: 0.29
Nodes (4): ATTRIBUTED_SUB_STAGES, listManagedAgentJobsMock, probeAgentPodActivityMock, readAgentJobRunStatusByNameMock

### Community 559 - "pen4902-heartbeat-run-window.test.ts"
Cohesion: 0.29
Nodes (4): AFTER, BEFORE, BOUNDARY, RunRow

### Community 560 - "recovery-manual-resolution-guidance-sites.test.ts"
Cohesion: 0.29
Nodes (4): EMITTING_FILES, EmittingFile, Handoff, SERVICES_DIR

### Community 567 - "invite-logo-route.test.ts"
Cohesion: 0.33
Nodes (3): ACTIVE_INVITE_EXPIRES_AT, createApp(), mockStorage

### Community 568 - "issue-adoption-execution-agent-name-key.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedContendedIssue(), seedRun()

### Community 569 - "issue-checkout-routine-lock-conflict.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedDuplicateRoutineExecutions(), seedRun()

### Community 570 - "issue-thread-interactions-service.test.ts"
Cohesion: 0.47
Nodes (5): AcceptGateInteractionKind, seedAcceptedConfirmation(), seedAcceptGateFixture(), seedAgentIssue(), seedConfirmationIssue()

### Community 572 - "issue-goal-fallback.ts"
Cohesion: 0.60
Nodes (3): MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId()

### Community 573 - "issue-thread-interactions.test.ts"
Cohesion: 0.50
Nodes (4): createFakeDb(), createSelectChain(), mockCreateChild, SelectRow

### Community 576 - "monitor-clear-activity-defer-publish.test.ts"
Cohesion: 0.50
Nodes (3): clearAudit(), helperInput(), publishLiveEvent

### Community 577 - "plugin-agent-invoke-wake-fanout.test.ts"
Cohesion: 0.60
Nodes (4): createEventBusStub(), hostServices(), issuePrefix(), seedBusyAgent()

### Community 578 - "getIssueRelationSummaryMap"
Cohesion: 0.67
Nodes (4): getIssueRelationSummaryMap(), withIssueRelationSummaries(), summarizeIssueRelationRow(), terminalExplicitBlockersByRoot()

### Community 582 - "reviewedFingerprintForWatchdogIssue"
Cohesion: 1.00
Nodes (3): normalizeStopFingerprint(), reviewedFingerprintForWatchdogIssue(), stopFingerprintFromText()

## Knowledge Gaps
- **4313 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Access`, `MemberRow` (+4308 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 6456 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **75 communities omitted from the detail section** — 1–11 nodes each in graph.json, 44 of them ≥3; graphify omits a community with <3 nodes once file-hub and AST-stub nodes are discounted — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ensureGitWorktreeBranchCoherent()` connect `ensurePersistedExecutionWorkspaceAvailable` to `workspace-runtime.ts`, `services/execution-workspaces.ts`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `executionWorkspaceService()` connect `services/execution-workspaces.ts` to `unprocessable`, `services/issues.ts`, `execution-workspace-policy.ts`, `inspectExecutionWorkspaceBranchForReconcile`, `workspace-runtime-read-model.ts`, `normalizeIssueExecutionPolicy`, `notFound`, `readProjectWorkspaceRuntimeConfig`, `issueRecoveryActionService`, `productivityReviewService`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `enqueueWakeup()` connect `parseObject` to `heartbeat.ts`, `toolAccessService`, `parseIssueExecutionState`, `escalateStrandedAssignedIssue`, `logActivity`, `execution-workspace-policy.ts`, `run-liveness-continuations.ts`, `normalizeIssueExecutionPolicy`, `notFound`, `ccrotate-capacity-retry.ts`, `issue-rewake-throttle.ts`, `executeRun`, `heartbeatService`, `dispatch-readiness.ts`?**
  _High betweenness centrality (0.003) - this node is a cross-community bridge._
- **Are the 46 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 46 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `captureUnrecognizedInteractionPayloadKeys()`) actually correct?**
  _`issueRoutes()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _4313 weakly-connected nodes found - possible documentation gaps or missing edges._
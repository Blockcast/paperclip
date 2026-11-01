# Graph Report - src  (2026-11-01)

## Corpus Check
- 1360 files · ~3,710,640 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 17189 nodes · 42903 edges · 557 communities (481 shown, 76 omitted from the detail section)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 1040 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e4467bbb`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- embedded-postgres.ts
- costs-service.test.ts
- forbidden
- issueRoutes
- gc-flags-metrics.ts
- services/company-skills.ts
- services/pipelines.ts
- routes/issues.ts
- services/built-in-agents.ts
- pause-hold-guard.ts
- workspace-runtime.ts
- services/plugin-loader.ts
- github-webhook.ts
- routes/pipelines.ts
- cleanup-heartbeat-test-state.ts
- k8s-job-liveness.ts
- parseObject
- services/tool-gateway.ts
- services/tool-access.ts
- routes/access.ts
- executeRun
- approvals-service.test.ts
- heartbeatService
- productivity-review.ts
- services/teams-catalog.ts
- plugins.ts
- environment-config.ts
- evidence-gate.ts
- middleware/auth.ts
- services/cloud-upstreams.ts
- toolAccessService
- registry.ts
- tool-access-policy.ts
- recovery/index.ts
- services/attention.ts
- cases.ts
- linear-tunnel.ts
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
- plugin-tool-dispatcher.ts
- penstock-availability-gate.ts
- authorization.ts
- approval-enforcement-reconciler.ts
- execution-workspace-cleanup.ts
- tool-gateway.test.ts
- external-runtime-reservations.ts
- issue-agent-mutation-ownership-routes.test.ts
- redaction.ts
- adapters.ts
- conflict
- services/execution-workspaces.ts
- services/issue-tree-control.ts
- better-auth.ts
- environment-runtime.ts
- storage/types.ts
- StorageService
- createPluginJobScheduler
- plugin-database.ts
- local-service-supervisor.ts
- services/projects.ts
- org-chart-svg.ts
- environment-run-orchestrator.test.ts
- issue-thread-interactions.ts
- plugin-host-services.ts
- run-liveness.ts
- badRequest
- agentService
- company-search.ts
- task-watchdogs.ts
- git-worktree-ownership.ts
- services/smoke-lab.ts
- workspace-runtime.test.ts
- heartbeat-process-recovery.test.ts
- worktree-config.ts
- index.ts
- notFound
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- board-claim.ts
- config.ts
- handleRunLivenessContinuation
- recovery/service.ts
- agent-instructions.ts
- cgroup-memory-metrics.test.ts
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- aws-secrets-manager-provider.ts
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe-k8s.test.ts
- ensurePersistedExecutionWorkspaceAvailable
- company-skills-routes.test.ts
- plugin-worker-manager.ts
- sweep-wake-preflight.ts
- isPlainObject
- tool-access-service.test.ts
- budgetService
- external-objects.ts
- environment-routes.test.ts
- services/dashboard.ts
- identifier-allocator.ts
- issue-execution-policy.ts
- issue-park-expiry.ts
- ui-branding.ts
- agent-cross-tenant-authz-routes.test.ts
- agent-permissions-routes.test.ts
- execution-workspace-policy.ts
- file-resources.ts
- company-artifacts.ts
- productivityReviewService
- plugin-config-masking.ts
- tool-oauth-legacy-backfill.ts
- api-compression.ts
- github-review-gate-authority.ts
- live-events-ws.ts
- normalizeAgentDefaultsForJoin
- low-trust-red-team-routes.test.ts
- issue-continuation-summary.ts
- run-log-store.ts
- github-status-delivery-outbox.ts
- opencode-k8s-seed-transport.test.ts
- utils.ts
- server-info.ts
- heartbeat-hintless-transient-upstream.test.ts
- isolation-reclaim-report.ts
- issue-pull-requests.ts
- issues-service.test.ts
- getMetricsRegistry
- trust-preset-resolver.ts
- agent-skills-routes.test.ts
- issues-goal-context-routes.test.ts
- accessService
- services/resource-memberships.ts
- heartbeat-run-runtime-status.ts
- issue-rewake-throttle.ts
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
- agentRoutes
- pr-comment-review-gate.ts
- instanceSettingsService
- recovery-observability.ts
- agent-secret-redaction.test.ts
- db-retry.ts
- authorizationService
- human-gated-ageing-digest.ts
- ensureHumanRoleDefaultGrants
- adapters/index.ts
- ac-policy-assignee-routing.ts
- company-portability-routes.test.ts
- linear-auth.ts
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
- github-egress-outbound-coverage.test.ts
- issue-workspace-command-authz.test.ts
- heartbeat-pr-review-gate-replay.test.ts
- heap-snapshot.ts
- heartbeat-stop-metadata.ts
- remote-http-endpoint-guard.ts
- run-scratch.ts
- pr-review-duplicate-issue-guard.ts
- adapter-model-refresh-routes.test.ts
- agent-instructions-routes.test.ts
- issue-feedback-routes.test.ts
- join-request-dedupe.ts
- issue-recovery-actions.test.ts
- logger.ts
- accepted-interaction-outcome-sweep.ts
- body
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite.ts
- heartbeat-retry-scheduling.test.ts
- execution-workspace-cleanup.test.ts
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- dev-runner-worktree.ts
- dev-server-status.ts
- openapi-routes.test.ts
- heartbeat-dependency-scheduling.test.ts
- execution-allowlist.ts
- PluginWorkerManager
- dispatch-readiness.ts
- project-checkout-origin-reconciler.ts
- oidc-rbac.ts
- isolation-workspace-reaper.ts
- buildInviteOnboardingManifest
- recovery-stranded-attendance-batch.test.ts
- environment-custom-image-terminal-sessions.ts
- github-fetch.ts
- plugin-managed-agents.ts
- plugin-managed-skills.ts
- execution-workspace-per-run-isolation.test.ts
- approval-routes-idempotency.test.ts
- approval-withdraw-routes.test.ts
- company-portability.test.ts
- docker-opencode-runtime-pin.test.ts
- done-gate-durable-artifact.test.ts
- environment-selection-route-guards.test.ts
- issue-create-deduplication-routes.test.ts
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
- truncate-company-scoped-test-state.ts
- pr-reconciler-sweep.ts
- workspace-operation-secret-scrub.test.ts
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
- routes/companies.ts
- issue-comment-effects.ts
- invite-accept-existing-member.test.ts
- issue-closed-workspace-routes.test.ts
- foreign-commit-notice.ts
- model-profile-hint.ts
- accessRoutes
- issue-repo-binding-guard.ts
- terminal-gate-reconciler.ts
- agent-auth-jwt.ts
- app.ts
- backfill-agent-bundle.ts
- agent-run-health.ts
- managed-checkout-push-guard.ts
- env
- transitionCaseInTransaction
- approval-budget-assertion-required.test.ts
- companyPortabilityService
- pr-review-state-reconciler.ts
- environmentRoutes
- heartbeat-timer-suppression-park-bypass.test.ts
- summarySlotService
- agent-hires-instructions-materialize.test.ts
- user-profiles.ts
- ac-policy-sweep.ts
- codex-local-execute.test.ts
- company-skills-catalog-service.test.ts
- run-secret-redaction.ts
- node:http
- instrumentation.ts
- http-log-policy.ts
- recovery-stale-issue-lock-sweep.test.ts
- issue-blocker-diagnostics-routes.test.ts
- managed-checkout-partial-clone.ts
- ccrotate-capacity-retry.ts
- zoned-cron.ts
- issue-subtree-diagnostics-routes.test.ts
- issue-wake-diagnostics-routes.test.ts
- builtInAgentService
- invite-rate-limit.ts
- model-validation.test.ts
- plugin-event-bus.ts
- process-loss-classification.ts
- startup-banner.ts
- agent-model-registry-validation.test.ts
- config
- evidence-truth.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- environment-capabilities-k8s.test.ts
- kkroo-bundled-plugins.ts
- agent-shell-guard.ts
- redactEventPayload
- logActivity
- zodToOpenApiSchema
- openrouter/execute.ts
- company-export-readme.ts
- company-search-service.test.ts
- plugin-environment-driver.ts
- lifecycle-hook-command-audit.ts
- fd-class-metrics.ts
- boardAuthService
- pluginCapabilityValidator
- pen3142-live-event-transcript-scope.test.ts
- isolation-reclaim-job.ts
- setupEnvironmentCustomImageTerminalWebSocketServer
- setup-supertest.ts
- chain-pass-timing.ts
- strand-comment-provider-capacity.test.ts
- scrape-metrics-collector.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- gbrain-client-factory.test.ts
- zoned-cron-equivalence.test.ts
- pen3142-run-transcript-scope.test.ts
- routines-service.test.ts
- successful-run-handoff-state.ts
- routes/routines.ts
- REDACTED_EVENT_VALUE
- cli-auth-routes.test.ts
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- heartbeat-issue-liveness-escalation.test.ts
- pipeline-case-outputs.ts
- buildPortableProjectWorkspaces
- pr-review-request-ageing-producer.ts
- pipelines-service.test.ts
- issue-liveness.test.ts
- approval-create-issue-link-authorization.test.ts
- pull-request-work-products.ts
- linear-webhook.test.ts
- heartbeat-workspace-finalize-branch.test.ts
- dev-watch-ignore.ts
- first-admin-claim.ts
- approval-link-route-equivalence.test.ts
- applyDocumentFixups
- run-log-terminal-result.ts
- agent-profile-change-gate-mixing.test.ts
- approval-agent-config-authz-routes.test.ts
- done-gate.ts
- heartbeat-stale-queue-invalidation.test.ts
- plugin-config-write-race.test.ts
- issue-goal-fallback.ts
- routine-fire-gap-metrics.test.ts
- routine-scheduler-heartbeat.ts
- issue-checkout-status.ts
- agent-budget-mirror-write.test.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- invite-summary-route.test.ts
- invite-test-resolution-route.test.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- company-issue-identity-guard.test.ts
- agent-hire-source-issue-authorization.test.ts
- routes/approvals.ts
- fetchIssueSearchData
- key
- issue-monitor-scheduler.test.ts
- readPenstockCapacity
- issue-tree-hold-metrics.ts
- HEARTBEAT.md -- CEO Heartbeat Checklist
- issue-approval-link-authorization.ts
- issues-open-assignment-census.test.ts
- createToolGatewayService
- taskWatchdogService
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- activityService
- documentAnnotationService
- sandbox-provider-runtime.ts
- Ally — Consolidated PR Review
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- issue-runtime-service-command-masking.test.ts
- issue-watchdogs-routes.test.ts
- codex-models.ts
- buildLocalUpstreamExportBundle
- heartbeat-worker-crash-marking.test.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- agent-budgets-route-config-revision.test.ts
- blocked-inbox-count-list-parity.test.ts
- cases-routes.test.ts
- adapter-registry-bootstrap.ts
- plugin-metric-exposition.test.ts
- heartbeat-ccrotate-capacity-retry.test.ts
- dispatch-decline-instrumentation.test.ts
- extractEnforcementAssertions
- approval-enforcement-reconciler.test.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- issue-telemetry-routes.test.ts
- github-write-egress-scrub.test.ts
- secretService
- plugin-activation-boot-retry.test.ts
- issue-stale-execution-lock-routes.test.ts
- plugin-manifest-validator.ts
- assertAssignableAgent
- event-loop-stall-log.ts
- agents-service-secret-bindings.test.ts
- issue-monitor-convergence-message.test.ts
- heartbeat-provider-capacity-horizon.test.ts
- pr-review-head-attestation.ts
- issue-monitor-queue-lock.ts
- billing-classification.ts
- Ally — Consolidated PR Review
- human-gated-gate-revalidation-backfill.test.ts
- startup-filesystem-io.test.ts
- chain
- ceo/AGENTS.md
- EnvironmentCustomImageSshShell
- penstock-availability-gate.test.ts
- Ally — Consolidated PR Review
- unprocessable
- live-events-ws.test.ts
- pod-failure-label-corpus.test.ts
- company-issue-identity.ts
- renderYamlBlock
- feedback-service.test.ts
- plugin-worker-invocation-scope.cjs
- issue-checkout-routine-lock-conflict.test.ts
- issue-release-lock-only-degrade.test.ts
- app-plugin-takeover-resync.test.ts
- startup-dispatch-isolation.test.ts
- reflection-coach/AGENTS.md
- Recent agent reflection sweep
- summarizer/AGENTS.md
- Refresh stale summary slots
- metrics-route-no-db.test.ts
- reviewer-wake-outcome-log-fields.test.ts
- SOUL.md -- CEO Persona
- Wake Pre-flight (do this FIRST when woken)
- agent-instructions-service.test.ts
- authz-existence-oracle-guard.test.ts
- plugin-worker-delayed.cjs
- plugin-worker-terminated.cjs
- postgres-pool-budget.test.ts
- recovery-candidate-phase-timer-coverage.test.ts
- default/AGENTS.md
- recovery-pause-hold-guard-call-shape.test.ts
- express.d.ts
- TOOLS.md
- authorization-service.test.ts
- approval-gate-already-terminal.test.ts
- parseFrontmatterMarkdown
- deriveRoutineFireGapsMs
- classifyTaskWatchdogSubtree
- heartbeat-accepted-plan-workspace-refresh.test.ts
- scrape-metrics-routine-fire-gap-work.test.ts
- issue-assignment-wakeup.ts
- markTerminalWatchdogIssueReviewed
- ws-upgrade-url-log-guard.test.ts
- inspectExecutionWorkspaceBranchForReconcile
- workspace-runtime-read-model.ts
- plugin-event-outbox.ts
- evaluateWatchdog
- execution-workspaces-service.test.ts
- issue-stable-enumeration-routes.test.ts
- plugin-orchestration-apis.test.ts
- task-watchdogs-scheduler.test.ts
- readProjectWorkspaceRuntimeConfig
- ensureServerWorkspaceLinksCurrent
- heartbeat-preferred-workspace-fail-loud.test.ts
- recoverClaimedReviewWithUnavailableVerification
- heartbeat-worktree-suppression.test.ts
- recovery-chain-pass-timing-wiring.test.ts
- materializeImportEnvInputValues
- execution-lock-orphan-cleanup.test.ts
- health.test.ts
- permissions-upgrade-boundary-routes.test.ts
- validateTerminalUpgrade
- heartbeat-result-json-write-path-audit.test.ts
- issue-approvals.ts
- external-wait-doc-contract.test.ts
- github-webhook-dedicated-pool.test.ts
- drainInFlightExecutions
- expectSourceScopedStrandedRecoveryAction
- company-skills-detail.test.ts

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 617 edges
2. `unprocessable()` - 383 edges
3. `issueRoutes()` - 382 edges
4. `notFound()` - 340 edges
5. `issueService()` - 271 edges
6. `logActivity()` - 263 edges
7. `recoveryService()` - 258 edges
8. `executeRun()` - 245 edges
9. `parseObject` - 196 edges
10. `agentRoutes()` - 188 edges

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

## Communities (557 total, 76 omitted from the detail section)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (286): appendWithByteCap, createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), resolveEffectiveWorkspaceStrategyType(), describeGitFailure(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS (+278 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (143): ParsedExecutionWorkspaceMode, getDefaultCompanyGoal(), GoalReader, ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS, AcceptedPlanDecompositionInput, AcceptedPlanDocumentInteraction, ALL_ISSUE_STATUSES, attentionBase() (+135 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.05
Nodes (52): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), bufferToPortableBinaryFile(), buildLegacyRoutineTriggerFromRecurrence(), collectSelectedExportSlugs() (+44 more)

### Community 3 - "embedded-postgres.ts"
Cohesion: 0.02
Nodes (76): STATEMENT_TIMEOUT_SQLSTATE, attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError() (+68 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.14
Nodes (14): createApp(), createAppWithActor(), loadCostParsers(), makeDb(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyService (+6 more)

### Community 5 - "forbidden"
Cohesion: 0.04
Nodes (130): forbidden(), unauthorized(), validate(), assertCanGenerateOpenClawInvitePrompt(), assertCompanyPermission(), agentImageBumpRoutes(), bumpAgentImageSchema, assertBoardCanManageAgentsForCompany() (+122 more)

### Community 6 - "issueRoutes"
Cohesion: 0.02
Nodes (128): actorMatchesExecutionParticipant(), authenticatedActorResponsibleUserId(), AutoApprovalIssueMissingError, buildAttachmentContentPath(), buildCreateIssueActivityStatusDetails(), captureUnrecognizedInteractionPayloadKeys(), compactIssueListEtag(), companySearchRateLimitActor() (+120 more)

### Community 7 - "gc-flags-metrics.ts"
Cohesion: 0.04
Nodes (63): GC_CYCLES_METRIC, GC_FLAG_BITS, GC_FLAGS_NONE, GC_KIND_UNKNOWN, GC_KINDS, GcCycleClassCount, GcCycleWindow, GcEntryDetail (+55 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.04
Nodes (150): ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillSourceAllowed(), assertNoSymlinksInLocalTree(), assertVersionMatchesSkill(), asString(), auditInstalledSkillBytes(), buildInventoryContentHash(), buildMissingLocalSourceMarker() (+142 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.04
Nodes (73): addFormVariablesForStage(), assertActorCanApproveStageExit(), assertActorProvenance(), assertCaseKey(), assertStageTransitionGates(), assertValidParentCase(), buildCaseDeepLink(), buildPipelineAutomationIssueTitlePrefix() (+65 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (152): ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), applyCreateIssueStatusDefault(), attachmentArtifactMetadataInputSchema, blockerDiagnosticLabel() (+144 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.04
Nodes (53): BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), BUILT_IN_AGENT_DEFAULT_GRANTS, BUILT_INS_DIR, BuiltInAgentBundleDefinition (+45 more)

### Community 12 - "pause-hold-guard.ts"
Cohesion: 0.19
Nodes (11): ActivePauseHoldRow, ActivePauseHoldPrefilter, ActivePauseHoldPrefilterStats, createActivePauseHoldPrefilter(), DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS, IssueTreeControlService, db, FakeHold (+3 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (113): ExecutionWorkspaceTeardownTrigger, applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), assertDirtyQuarantineRuntimeServicesStopped(), assertServerGitDoesNotPublish(), branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), buildExecutionWorkspaceCleanupEnv() (+105 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.03
Nodes (106): isIsolatedSdkPluginPackage(), ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH, BOOT_ACTIVATION_RETRY_PATTERN (+98 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (196): acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody(), buildDependabotRefireComment() (+188 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (91): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertPipelineAccess(), assertPipelineCompanyAccess(), assertPipelineWriteAccess() (+83 more)

### Community 17 - "cleanup-heartbeat-test-state.ts"
Cohesion: 0.04
Nodes (23): runningProcesses, STARVATION_ABSOLUTE_ESCALATION_MS, STARVATION_FULL_ESCALATION_MS, mockAdapterExecute, getRunStatus(), mockAdapterExecute, waitForStatus(), mockAdapterExecute (+15 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.03
Nodes (84): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+76 more)

### Community 19 - "parseObject"
Cohesion: 0.03
Nodes (165): parseObject, CcrotateTarget, mapAdapterToCcrotateTarget(), mapPenstockProviderToCcrotateTarget(), incrementDepBlockedMetric(), buildHeartbeatRunFailedMetricInput(), carryRetryContextSnapshot(), clearInteractionContinuationWakeContext() (+157 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (43): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview() (+35 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.04
Nodes (59): createCompanyInviteForCompany(), agentJoinGrantsFromDefaults(), AvailableSkill, companyInviteExpiresAt(), CompanyMemberRecord, createInviteToken(), defaultInviteResolutionNetwork, grantsFromDefaults() (+51 more)

### Community 23 - "executeRun"
Cohesion: 0.02
Nodes (149): getServerAdapter(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), applyAgentGitIdentityToRuntimeConfig(), applyPersistedExecutionWorkspaceConfig(), assertGitSensitiveAdapterWorkspaceValid(), assertPathContained(), attachPaperclipSessionMetadataToSessionParams() (+141 more)

### Community 24 - "approvals-service.test.ts"
Cohesion: 0.06
Nodes (16): createApp(), mockAccessDecide, mockAgentService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockWorkspaceOperationService (+8 more)

### Community 25 - "heartbeatService"
Cohesion: 0.03
Nodes (214): publishPluginDomainEvent(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds(), markAgentStartLockPhase(), runDetachedFromAgentStartLock(), incrementBlockerResolvedWakeMetric(), externalRuntimeReservationCanRelease(), getActiveExternalRuntimeReservation() (+206 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.03
Nodes (111): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), DbOrTx (+103 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (63): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+55 more)

### Community 28 - "plugins.ts"
Cohesion: 0.02
Nodes (80): AvailableBundledPlugin, bundledPluginMetadata(), __dirname, discoverBundledPlugins(), DiscoveredBundledPlugin, EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES, fileExists(), findPackageJsonFiles() (+72 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.15
Nodes (30): collectEnvironmentSecretRefs(), createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe() (+22 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (53): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+45 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.10
Nodes (27): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+19 more)

### Community 32 - "services/cloud-upstreams.ts"
Cohesion: 0.07
Nodes (56): activationChecklistFromReport(), activationEntityLabel(), asRecord(), buildWarnings(), cloudUpstreamRemoteFailureReport(), cloudUpstreamRunStatus(), cloudUpstreamService(), buildSummary() (+48 more)

### Community 33 - "toolAccessService"
Cohesion: 0.04
Nodes (129): HttpError, asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor(), readStdioTemplateId() (+121 more)

### Community 34 - "registry.ts"
Cohesion: 0.06
Nodes (33): BUILTIN_ADAPTER_TYPES, acpxLocalAdapter, adapterAcceptsModelForConfig(), adapterModelRegistryIsClosed(), adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks (+25 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (72): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+64 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.04
Nodes (99): ColdInReviewGaugeEntry, ColdInReviewIssueRow, addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding() (+91 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.06
Nodes (52): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+44 more)

### Community 38 - "cases.ts"
Cohesion: 0.05
Nodes (71): normalizeContentType(), hasCompanyAccess(), annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany(), assertProjectBelongsToCompany() (+63 more)

### Community 39 - "linear-tunnel.ts"
Cohesion: 0.47
Nodes (3): registerLinearWebhook(), registerWebhookWithToken(), startLinearTunnel()

### Community 40 - "recoveryService"
Cohesion: 0.03
Nodes (164): isTerminalIssueStatus(), findOpenIssueMonitorRecoveryIssue(), performIssueMonitorRecovery(), enqueueRecoveryWakeOrComment(), recordRecoveryWakeSuppression(), issueLockOwnerStateMatches(), lockIssueOwnership(), buildIssueBlockersResolvedWakeIdempotencyKey() (+156 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.07
Nodes (61): applyCustomImageTemplateToSandboxConfig(), classifyEnvironmentCustomImageConfigChange(), defaultEnvironmentCustomImageRuntimeConfigBinding(), ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS, ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS, EnvironmentCustomImageConfigChangeKind, EnvironmentCustomImageRuntimeConfigBinding (+53 more)

### Community 42 - "feedback.ts"
Cohesion: 0.08
Nodes (59): appendNote(), asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildClaudeTraceFiles(), buildCodexTraceFiles() (+51 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (240): createBetterAuthHandler(), normalizeAuthLocationHeader(), counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), UNCLAIMABLE_QUEUED_RUN_REAP_MIN_AGE_MS (+232 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.07
Nodes (64): AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments(), directoryResource() (+56 more)

### Community 45 - "openapi.ts"
Cohesion: 0.04
Nodes (45): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+37 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.11
Nodes (33): resolveRawGitHubUrl(), CatalogManifestFile, CatalogManifestUnavailableError, copyCatalogSkillFile(), devCatalogManifestPath, devCatalogPackageRoot, fetchCatalogSourceFile(), getCatalogManifest() (+25 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.05
Nodes (99): GithubWebhookConfig, githubWebhookRoutes(), __test_stackedChildDirective, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure() (+91 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (37): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), buildRoutineRevisionSnapshot(), canonicalSnapshot(), collectProvidedRoutineVariables() (+29 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (15): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+7 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 51 - "plugin-tool-dispatcher.ts"
Cohesion: 0.07
Nodes (13): PluginRouteToolDeps, createPluginToolDispatcher(), handlePluginEnabled(), registerFromDb(), PluginToolDispatcher, createPluginToolRegistry(), addTool(), buildName() (+5 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.10
Nodes (31): PenstockProbeOutcomeLabel, PenstockProbePathLabel, asRecord(), buildCapacityUrl(), buildMessagesUrl(), CacheEntry, capacityRetryFromBody(), isPenstockCapacityBody() (+23 more)

### Community 53 - "authorization.ts"
Cohesion: 0.08
Nodes (37): AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction, assignmentPolicyEffect(), loadIssueAuthorizationPolicy() (+29 more)

### Community 54 - "approval-enforcement-reconciler.ts"
Cohesion: 0.12
Nodes (25): APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND, ApprovalCandidate, ApprovalCursor, approvalCursorFrom(), ApprovalEnforcementReconcileResult, ApprovalEnforcementReconcilerScheduler, BudgetPolicyAmountAssertion, buildDriftIssueBody() (+17 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.07
Nodes (42): decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup(), selectEligible() (+34 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.09
Nodes (6): awaitRateLimitWindow(), createApprovedToolAction(), createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "external-runtime-reservations.ts"
Cohesion: 0.08
Nodes (34): bindExternalRuntimeReservationIsolation(), claimRunWithExternalRuntimeSlot(), claimRunWithExternalRuntimeSlotOutcome(), claimRunWithExternalRuntimeSlotPool(), ExternalRuntimeClaim, ExternalRuntimeIsolationConflictError, ExternalRuntimeIsolationMode, ExternalRuntimeJobNameMismatchError (+26 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.06
Nodes (36): RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, BENIGN_HEADER_NAMES, CLI_SECRET_FLAG_RE, ENV_DUMP_SECRET_ASSIGNMENT_RE, ESCAPED_JSON_SECRET_FIELD_TEXT_RE, hasOpaqueUrlPathSegment(), JSON_SECRET_FIELD_TEXT_RE (+28 more)

### Community 60 - "adapters.ts"
Cohesion: 0.12
Nodes (41): buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter(), resolvePackageDir() (+33 more)

### Community 61 - "conflict"
Cohesion: 0.10
Nodes (47): conflict(), archiveMember(), assertAssignableArchiveTarget(), assertCanRemoveActiveOwner(), updateMember(), updateMemberAndPermissions(), assertNoRunningRun(), buildFolderViews() (+39 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.09
Nodes (39): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), ExecutionWorkspaceBranchReconcileActor, ExecutionWorkspaceBranchReconcileInspection (+31 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.06
Nodes (52): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+44 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.12
Nodes (27): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+19 more)

### Community 65 - "environment-runtime.ts"
Cohesion: 0.04
Nodes (66): stripSandboxProviderEnvelope(), EnvironmentAcquisitionResult, EnvironmentErrorCode, EnvironmentRealizationResult, EnvironmentReleaseResult, EnvironmentRunErrorProbeAttempt, firstNonEmptyLine(), formatProvisionFailureDetail() (+58 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.10
Nodes (23): DurableRunLogStoreOptions, createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), createLocalDiskStorageProvider(), createStorageProviderFromConfig(), createS3StorageProvider(), normalizePrefix() (+15 more)

### Community 67 - "StorageService"
Cohesion: 0.05
Nodes (38): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES, normalizeIssueAttachmentMaxBytes() (+30 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.14
Nodes (23): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), ParsedCron (+15 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.06
Nodes (27): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), derivePluginDatabaseNamespace(), extractQualifiedRefs(), normaliseSql(), PluginDatabaseClient (+19 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.10
Nodes (52): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+44 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.10
Nodes (32): recordProjectPrimaryWorkspaceFallback(), attachGoals(), attachListMetrics(), attachWorkspaces(), buildManagedProjectDefaults(), buildProjectListMetricMaps(), CreateWorkspaceInput, deriveNameFromCwd() (+24 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (34): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+26 more)

### Community 73 - "environment-run-orchestrator.test.ts"
Cohesion: 0.09
Nodes (27): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentRunError, EnvironmentRunOrchestrator (+19 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.04
Nodes (72): ACKNOWLEDGEABLE_OUTCOME_INTERACTION_KINDS, assertExpectedOutcomeRefResolves(), assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult() (+64 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.04
Nodes (76): RFC-1918, normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier() (+68 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.11
Nodes (36): ActivityFilters, findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker() (+28 more)

### Community 77 - "badRequest"
Cohesion: 0.16
Nodes (20): badRequest(), activationEntityTypeBody(), cloudUpstreamRoutes(), assertEnabled(), optionalString(), stringBody(), stringQuery(), parseKind() (+12 more)

### Community 78 - "agentService"
Cohesion: 0.07
Nodes (56): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, describeAgentStartLockDispatchHealth(), forgetExpiredAborts(), AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed() (+48 more)

### Community 79 - "company-search.ts"
Cohesion: 0.11
Nodes (39): artifactResult(), companySearchService(), countAgents(), countProjects(), countTotalNonIssue(), fetchAgentRows(), fetchArtifactRows(), fetchProjectRows() (+31 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.10
Nodes (26): ActorFields, assertWatchdogAgentInvokable(), assertWatchedIssue(), isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict(), IssueRow, IssueWatchdogRow, IssueWatchdogUpsertInput (+18 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.06
Nodes (39): allocateFetchAllowedLoopbackPort(), appendRedirectParam(), asRecord(), assertSmokeOAuthRedirectUri(), escapeHtml(), FETCH_BLOCKED_PORTS, FIXTURE_TOOLS, FixtureTool (+31 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.06
Nodes (45): WorkspaceOperationRecorder, createGitLinkExclusivelyForTests, executeProcessForTests, GIT_INDEX_LOCK_STALE_MS, GitCommandFailedError, GitCommandTimeoutError, isInconclusiveGitFailureForTests, isProcessGroupAliveForTests (+37 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (27): PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, isPidAlive(), mockAdapterExecute, mockDeleteAgentJobsByRunId, mockDeleteAgentJobsForRun (+19 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "index.ts"
Cohesion: 0.06
Nodes (42): BUNDLED_PLUGIN_PACKAGES, dbInheritedTimeoutSeries(), BetterAuthSessionResult, BetterAuthSessionUser, EmbeddedPostgresCtor, EmbeddedPostgresInstance, StartedServer, startServer() (+34 more)

### Community 87 - "notFound"
Cohesion: 0.05
Nodes (61): notFound(), normalizeAgentReference(), assertBuiltInAgentsEnabled(), assertActiveUserMembership(), enforceScopedApiCheckout(), assertSummariesEnabled(), getPolicyRow(), assertCanMutateComment() (+53 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.13
Nodes (21): AuthenticatedTerminalContext, closeUpgradeSocket(), createSsh2EnvironmentCustomImageSshConnector(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, decodeClientMessage(), EnvironmentCustomImageSshConnector, IncomingMessageWithTerminalContext, isWritableUpgradeSocket() (+13 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "board-claim.ts"
Cohesion: 0.36
Nodes (8): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge()

### Community 91 - "config.ts"
Cohesion: 0.06
Nodes (39): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS, numericEnv() (+31 more)

### Community 92 - "handleRunLivenessContinuation"
Cohesion: 0.27
Nodes (8): addContinuationExhaustedCommentOnce(), handleRunLivenessContinuation(), buildRunLivenessContinuationIdempotencyKey(), decideRunLivenessContinuation(), DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS, findExistingRunLivenessContinuationWake(), readContinuationAttempt(), RUN_LIVENESS_CONTINUATION_REASON

### Community 93 - "recovery/service.ts"
Cohesion: 0.02
Nodes (164): DeferredWakeReopenEligibility, LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), WAKE_COMMENT_IDS_KEY, readFullRunLog(), FRESHNESS (+156 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.17
Nodes (39): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+31 more)

### Community 95 - "cgroup-memory-metrics.test.ts"
Cohesion: 0.09
Nodes (34): CGROUP_ACTIVE_FILE_COMPONENT, CGROUP_ANON_COMPONENT, CGROUP_FILE_COMPONENT, CGROUP_FILE_DIRTY_COMPONENT, CGROUP_FILE_MAPPED_COMPONENT, CGROUP_FILE_WRITEBACK_COMPONENT, CGROUP_INACTIVE_FILE_COMPONENT, CGROUP_KERNEL_COMPONENT (+26 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.16
Nodes (21): asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent, HotRestartIntentRun, HotRestartReport (+13 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.07
Nodes (30): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+22 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (22): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_ORIGIN_KIND (+14 more)

### Community 99 - "aws-secrets-manager-provider.ts"
Cohesion: 0.05
Nodes (57): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), awsProviderSafeMessage(), AwsSecretsManagerConfig (+49 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (26): installActor(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectLimit, mockDbSelectOrderBy (+18 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.08
Nodes (29): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+21 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "ensurePersistedExecutionWorkspaceAvailable"
Cohesion: 0.13
Nodes (34): classifyGitCheckoutProbeFailure(), detectDefaultBranch(), directoryExists(), ensureGitSubmodulesReady(), ensurePersistedExecutionWorkspaceAvailable(), findVerifiedManagedProjectPrimaryCheckout(), formatShortSha(), gitErrorIncludes() (+26 more)

### Community 104 - "company-skills-routes.test.ts"
Cohesion: 0.08
Nodes (24): AGENT_PROFILE_CHANGE_CONSENT_FIELDS, changeConsentGateService(), ConsumedRequestConfirmationResult, expandTargetKeysForLegacyCompatibility(), legacyTargetKeysFor(), markRequestConfirmationResultConsumed(), payloadHasDisplayedDiff(), readNonEmptyString() (+16 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.04
Nodes (70): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart() (+62 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.11
Nodes (32): compareSweepWakeFrame(), currentMinuteBucket(), detectSweepWakeRace(), equalStringArrays(), getIssueSnapshot(), isCompanyFlagEnabled(), isValidIsoDate(), isValidSweepWakeFrame() (+24 more)

### Community 107 - "isPlainObject"
Cohesion: 0.17
Nodes (29): assignRecordKey(), classifyKeyTier(), isPlainBinding(), isPlainObject(), isSecretPointerCandidate(), isSecretRefBinding(), isUserSecretRefBinding(), maskWorkspaceRuntimeForRead() (+21 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (27): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+19 more)

### Community 109 - "budgetService"
Cohesion: 0.03
Nodes (70): costRoutes(), parseCostDateRange(), parseCostLimit(), AppliedAssertion, applyApprovalEnforcement(), ApplyApprovalEnforcementResult, ApplyApprovalRefusalCode, withRefusalLogged() (+62 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (23): createApp(), currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService (+15 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.05
Nodes (47): AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput, AgentScorecardOptions, AgentScorecardsResult, computeAgentScorecards(), MIN_SAMPLE_DONE (+39 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.12
Nodes (17): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+9 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.04
Nodes (114): hasScheduledMonitor(), classifySourceRecoveryRevalidation(), isLapsedMonitorRearmPatch(), writeIssueMonitor(), summarizeIssueMonitor(), clearIssueMonitorAndRecover(), dispatchClaimedIssueMonitor(), monitorRecoveryDetails() (+106 more)

### Community 115 - "issue-park-expiry.ts"
Cohesion: 0.10
Nodes (18): hasLiveDeliberatePark(), isDeliberateParkActive(), isIssueParkExpiryWakeStatus(), ISSUE_PARK_EXPIRED_WAKE_REASON, ISSUE_PARK_EXPIRY_WAKE_STATUSES, IssueParkExpiryWakeStatus, IssueParkReleaseInput, readMs() (+10 more)

### Community 116 - "ui-branding.ts"
Cohesion: 0.09
Nodes (31): readBrandedStaticIndexHtml(), tempDir(), applyUiBranding(), createFaviconDataUrl(), DEFAULT_FAVICON_LINKS, deriveColorFromSeed(), escapeHtmlAttribute(), getWorktreeUiBranding() (+23 more)

### Community 117 - "agent-cross-tenant-authz-routes.test.ts"
Cohesion: 0.09
Nodes (24): assertAuthenticated(), assertBoard(), assertCompanyAccess(), assertInstanceAdmin(), baseAgent, baseKey, createApp(), getAccessibleResource() (+16 more)

### Community 118 - "agent-permissions-routes.test.ts"
Cohesion: 0.07
Nodes (24): baseAgent, createApp(), createDbStub(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService (+16 more)

### Community 119 - "execution-workspace-policy.ts"
Cohesion: 0.04
Nodes (81): asBoolean, asNumber, asString, countRunsOccupyingSlots(), EXTERNAL_LIFECYCLE_ADAPTERS, hasExternalLifecycleAdapter(), isRunOccupyingSlot(), normalizeMaxConcurrentRuns() (+73 more)

### Community 120 - "file-resources.ts"
Cohesion: 0.14
Nodes (22): activityDetails(), createFileResourceLimiter(), createFileResourceListLimiter(), denialReasonFromError(), FileResourceLimiter, fileResourceRoutes(), logDeniedAttempt(), logListDeniedAttempt() (+14 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.16
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "productivityReviewService"
Cohesion: 0.06
Nodes (66): buildThresholds(), extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isApprovalGatedSuppression(), isMonitorScheduledSuppression(), isSoftStopTrigger(), issueCanReceiveMonitorDispatch(), isTerminalGateClosableTriggerSet() (+58 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.07
Nodes (59): RFC-6901, isSensitiveContainerKey(), isSensitiveKey(), isUrlishKey(), redactContainer(), redactSensitive(), SENSITIVE_CONTAINER_KEYS, SENSITIVE_KEYS (+51 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.14
Nodes (22): awsSecretsManagerProvider, SecretProviderVaultRuntimeConfig, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind (+14 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "github-review-gate-authority.ts"
Cohesion: 0.07
Nodes (50): activateGithubReviewGateDelivery(), affectsProtectedBase(), Candidate, claimDueGithubReviewGateDeliveries(), COMMENT_ACTIONS, commentSignals(), createRepositoryDispatch(), deliveryClaimWhere() (+42 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.14
Nodes (15): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+7 more)

### Community 128 - "normalizeAgentDefaultsForJoin"
Cohesion: 0.22
Nodes (17): buildJoinDefaultsPayloadForAccept(), extractHeaderEntries(), generateEd25519PrivateKeyPem(), headerMapGetIgnoreCase(), headerMapHasKeyIgnoreCase(), isDefaultHermesDashboardRoot(), isPlainObject(), mergeJoinDefaultsPayloadForReplay() (+9 more)

### Community 129 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.06
Nodes (34): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+26 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.14
Nodes (24): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates(), extractPreviousNextAction() (+16 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.12
Nodes (14): createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), isAtOrPastEnd(), normalizeKeyPrefix(), resolveWithin() (+6 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.10
Nodes (34): githubAppCredentialsConfigured(), GitHubCommitStatusState, appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), DbHandle, deliveryClaimWhere(), DeliveryRow (+26 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "utils.ts"
Cohesion: 0.09
Nodes (27): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx, execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment() (+19 more)

### Community 135 - "server-info.ts"
Cohesion: 0.16
Nodes (14): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, createServerInfoSnapshot(), getGitLocalChanges(), getServerInfoSnapshot() (+6 more)

### Community 136 - "heartbeat-hintless-transient-upstream.test.ts"
Cohesion: 0.08
Nodes (26): allocationFaultStatusGate(), BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, didRunSnapshotHitGatewayAllocationFault(), isImmediatePredecessorRepeatGatewayAllocationFault(), readExternalLifecycleProviderCapacityRefusal(), isGatewayAllocationFault(), isHintlessTransientUpstreamFault(), isRateLimitExhausted() (+18 more)

### Community 137 - "isolation-reclaim-report.ts"
Cohesion: 0.11
Nodes (25): main(), ParsedArgs, parseReclaimArgs(), parseReclaimPlan(), runReclaimExecutor(), stderrLogger, encodeIsolationReclaimReport(), EXECUTION_RESULT_COUNTERS (+17 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.07
Nodes (46): AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES, matchExclusionRule() (+38 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.06
Nodes (22): deriveIssueCommentRunLogAttribution(), extractExecutiveHoldMarker(), findActiveExecutiveHold(), issueSearchMatchCondition(), enrichCommentsWithDerivedAgentAttribution(), persistDerivedIssueCommentAttribution(), readRunLogText(), parseExecutiveHoldMarkerTimestamp() (+14 more)

### Community 140 - "getMetricsRegistry"
Cohesion: 0.05
Nodes (43): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+35 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.17
Nodes (22): assertLowTrustWorkspaceIsolation(), issueIdIsDescendantOf(), LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS, workspaceIssueWithinLowTrustBoundary(), asRecord(), deny(), hasBoundaryScope(), intersectSets() (+14 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (22): managedByPlugin(), createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService (+14 more)

### Community 144 - "accessService"
Cohesion: 0.05
Nodes (51): createLiveEventTranscriptGate(), decisionReason(), defaultTranscriptStreamAuditor(), GateOutcome, LIVE_EVENT_TRANSCRIPT_AUDIT_ACTION, LiveEventSubscriberContext, LiveEventTranscriptAuditEntry, MembershipReader (+43 more)

### Community 145 - "services/resource-memberships.ts"
Cohesion: 0.12
Nodes (14): logMembershipChange(), requireBoardUserId(), resourceMembershipRoutes(), assertBoardSelfMembershipAccess(), BoardActor, evaluatePolicy(), MembershipChangeKind, MembershipUpdateResult (+6 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.17
Nodes (22): decorateHeartbeatRunRuntimeStatus(), recordCurrentHeartbeatRunRuntimeProgress(), isHeartbeatRunRuntimeStatusActive(), recordHeartbeatRunRuntimeProgress(), clearAllHeartbeatRunRuntimeStatuses(), clearHeartbeatRunRuntimeStatus(), cloneStatus(), getHeartbeatRunRuntimeStatus() (+14 more)

### Community 147 - "issue-rewake-throttle.ts"
Cohesion: 0.12
Nodes (21): computeIssueRewakeCooldownMs(), evaluateIssueRewakeThrottle(), isIssueRewakeNewInputActivity(), isIssueRewakeProgressActivity(), ISSUE_COMMENT_ADDED_ACTION, ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS, ISSUE_PROGRESS_ACTIVITY_ACTION_SET (+13 more)

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
Nodes (101): activeInboxArchiveFields(), activeRunMapForIssues(), activeRunMapKey(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter() (+93 more)

### Community 152 - "successful-run-handoff.ts"
Cohesion: 0.06
Nodes (52): isAlertEscalationLadderOriginKind(), agentLinkRow(), AgentRow, boundedLinkText(), buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice(), decideSuccessfulRunHandoff() (+44 more)

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
Cohesion: 0.06
Nodes (52): RFC-7230, boardOrgAccessProxyGuard(), CONNECT_PHASE_ERROR_CODES, createWorkerProxyHandler(), fetchWithStartupRetry(), forwardRequestHeaders(), hasRequestBody(), HOP_BY_HOP_HEADERS (+44 more)

### Community 158 - "agent-start-lock.ts"
Cohesion: 0.03
Nodes (70): AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), abortedAgentId(), abortReason(), CancellableQuery (+62 more)

### Community 159 - "agentRoutes"
Cohesion: 0.03
Nodes (106): describeUnregisteredModel(), asRecord(), containAgentConfig(), containAgentMetadata(), containsRedactedAdapterValue(), isRedactedEnvBinding(), keepSanitizedAgentMetadata(), OMIT_REDACTED_ADAPTER_VALUE (+98 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (128): classifyPrReviewComment(), isActionablePrReviewComment(), isReviewShapedPrComment(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead() (+120 more)

### Community 161 - "instanceSettingsService"
Cohesion: 0.04
Nodes (69): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), assertCanManageInstanceSettings(), auditPatchedHookCommands(), instanceSettingsRoutes(), ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES (+61 more)

### Community 162 - "recovery-observability.ts"
Cohesion: 0.08
Nodes (26): RESOLVED_ASSIGNEE_AGENT_ID_EVIDENCE_KEY, RESOLVED_ISSUE_STATUS_EVIDENCE_KEY, ACTIVE_STATUSES, classifyRecoveryHandoff(), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT, evaluateRecoveryRateAlert(), HandoffClass, MAX_WINDOW_WEEKS (+18 more)

### Community 163 - "agent-secret-redaction.test.ts"
Cohesion: 0.09
Nodes (22): agentActor, baseAgent, boardActor, createApp(), createDbStub(), hire(), maskedByReadPath(), mockAccessService (+14 more)

### Community 164 - "db-retry.ts"
Cohesion: 0.19
Nodes (12): compactErrorText(), describeDbError(), findPgError(), isDbError(), isPostgresSqlState(), isTransientDbError(), PgErrorFields, POSTGRES_SQLSTATE_CLASSES (+4 more)

### Community 165 - "authorizationService"
Cohesion: 0.10
Nodes (51): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentHoldsIssueAcrossDependencyEdge() (+43 more)

### Community 166 - "human-gated-ageing-digest.ts"
Cohesion: 0.06
Nodes (46): db, MAX_PRS, token, BlockerGraphInput, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk() (+38 more)

### Community 167 - "ensureHumanRoleDefaultGrants"
Cohesion: 0.12
Nodes (19): approveHumanJoinRequestFromInvite(), addCompanyMemberRemovalAccess(), assertCanManageCompanyMember(), getProtectedMemberReason(), resolveActorHumanRole(), ensureRoleDefaultGrants(), grantsForHumanRole(), HUMAN_COMPANY_MEMBERSHIP_ROLES (+11 more)

### Community 168 - "adapters/index.ts"
Cohesion: 0.08
Nodes (28): detectAdapterModel(), filterAdapterModelsForConfiguredAllowlist(), findActiveServerAdapter(), getDeclaredAdapterModels(), isOpenCodeAdapterType(), listAdapterModelProfiles(), listAdapterModels(), listAdapterModelsForConfig() (+20 more)

### Community 169 - "ac-policy-assignee-routing.ts"
Cohesion: 0.13
Nodes (16): AcPolicyAgentTargetReason, AcPolicyFilingTarget, AcPolicyFilingTargetInput, AcPolicyResolvedOwner, AcPolicySkippedAgent, AcPolicySweepAgent, AcPolicyUnroutableReason, AcPolicyUserTargetReason (+8 more)

### Community 170 - "company-portability-routes.test.ts"
Cohesion: 0.11
Nodes (13): cloudHeaders, createApp(), exportRequest, importRequest, mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService (+5 more)

### Community 171 - "linear-auth.ts"
Cohesion: 0.14
Nodes (18): LinearTeam, LinearTeamExpectation, LinearTeamFailure, LinearTeamMatch, LinearTeamResolution, linearTeamResolutionError(), resolveLinearTeam(), callbackPage() (+10 more)

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
Nodes (27): AgentGitIdentityEnv, buildAgentGitIdentity(), buildAgentGitIdentityEnv(), CheckoutGitIdentityResult, CheckoutGitIdentityStatus, CheckoutIdentityAgentRef, defaultGitRunner(), ensureCheckoutGitIdentity() (+19 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (50): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+42 more)

### Community 181 - "native-memory-metrics.ts"
Cohesion: 0.07
Nodes (42): DEFAULT_SAMPLE_INTERVAL_MS, EXTERNAL_PEAK_COMPONENT, finite(), HEAP_TOTAL_PEAK_COMPONENT, HEAP_USED_PEAK_COMPONENT, HeapPeakReading, HeapSizeReading, readHeapPeaks() (+34 more)

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.27
Nodes (12): collectFromJsonValue(), CursorModelsCommandResult, dedupeModels(), fetchCursorModelsFromCli(), isLikelyModelId(), listCursorModels(), mergedWithFallback(), parseCursorModelsOutput() (+4 more)

### Community 184 - "health.ts"
Cohesion: 0.13
Nodes (19): hasDevServerStatusToken(), HEALTH_PROBE_DEADLINE_MS, healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), alertFileCandidates() (+11 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.15
Nodes (24): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+16 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.13
Nodes (14): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, invalidChainReason(), readCompanyAgentRoster() (+6 more)

### Community 188 - "pipelineService"
Cohesion: 0.12
Nodes (33): redactRunError(), assertReviewTargetsInSet(), defaultRetryCleanup(), getAncestorCases(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow(), intakeFieldsForStage(), isCarryOverIdentityFieldKey() (+25 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.07
Nodes (46): agentHasRecoveryHandoffGrantOnIssue(), ACTIVE_RECOVERY_ACTION_STATUSES, BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, DbOrTransaction, isRecord(), IssueRecoveryActionRow, issueRecoveryActionService(), dischargeActionsWithRestoredExecution() (+38 more)

### Community 190 - "github-egress-outbound-coverage.test.ts"
Cohesion: 0.10
Nodes (22): Coverage, dockerfilePath, helpersPath, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE, serverSourceDirectory (+14 more)

### Community 191 - "issue-workspace-command-authz.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockExecutionWorkspaceService (+6 more)

### Community 192 - "heartbeat-pr-review-gate-replay.test.ts"
Cohesion: 0.22
Nodes (11): allyReview(), bodyAttestsToHead(), buildApp(), deliverFreshHeadSynchronize(), extractReviewedHeadSha(), FixtureReview, latestAllyReview(), NEW_HEAD_REVIEW (+3 more)

### Community 193 - "heap-snapshot.ts"
Cohesion: 0.10
Nodes (36): collectPrunable(), ConcurrentSnapshotWriters, decideHeapSnapshot(), defaultHeapSnapshotRuntime, describeSentinelOutcome(), ensureHeapSnapshotDir(), findConcurrentSnapshotWriters(), HEAP_SNAPSHOT_EXTENSION (+28 more)

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
Nodes (31): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, AnyFn, blockSourceOnFreshIssue(), createApp() (+23 more)

### Community 203 - "logger.ts"
Cohesion: 0.05
Nodes (45): resolveDefaultLogsDir(), logDir, logFile, logger, resolveServerLogDir(), sharedOpts, EMPTY_ROSTER, logGuardDecision() (+37 more)

### Community 204 - "accepted-interaction-outcome-sweep.ts"
Cohesion: 0.11
Nodes (24): ACCEPTED_OUTCOME_SWEEP_KINDS, AcceptedInteractionOutcomeBucketReport, AcceptedInteractionOutcomeReport, AcceptedInteractionOutcomeSample, AcceptedInteractionOutcomeSource, bucketFor(), buildAcceptedInteractionOutcomeReport(), ClassifiedRow (+16 more)

### Community 205 - "body"
Cohesion: 0.02
Nodes (44): __test_resolvePostedReviewObservation, BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), CCROTATE_CAPACITY_DEFERRED_METRIC, GBRAIN_RECALL_METRIC (+36 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.15
Nodes (20): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+12 more)

### Community 208 - "agent-inbox-lite.ts"
Cohesion: 0.04
Nodes (50): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN, AGENT_INBOX_LITE_STATUS_FILTER (+42 more)

### Community 209 - "heartbeat-retry-scheduling.test.ts"
Cohesion: 0.05
Nodes (36): CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS, INTERACTION_CONTINUATION_INFRA_RETRY_REASON, INTERACTION_CONTINUATION_INFRA_WAKE_REASON, JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS, MAX_TURN_CONTINUATION_RETRY_REASON, MAX_TURN_CONTINUATION_WAKE_REASON, SESSION_UNAVAILABLE_HEARTBEAT_RETRY_DELAY_MS, SESSION_UNAVAILABLE_HEARTBEAT_RETRY_MAX_ATTEMPTS (+28 more)

### Community 210 - "execution-workspace-cleanup.test.ts"
Cohesion: 0.10
Nodes (20): classifyRemovalProof(), EXECUTION_WORKSPACE_CLEANUP_REASONS, EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC, EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES, EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC, EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC (+12 more)

### Community 212 - "issue-document-restore-routes.test.ts"
Cohesion: 0.13
Nodes (12): createApp(), mockAccessService, mockAgentService, mockDocumentsService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockIssueThreadInteractionService (+4 more)

### Community 213 - "workspace-runtime-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): createExecutionWorkspaceApp(), createProjectApp(), mockAccessService, mockAssertCanManageExecutionWorkspaceRuntimeServices, mockAssertCanManageProjectWorkspaceRuntimeServices, mockEnvironmentService, mockExecutionWorkspaceService, mockGetTelemetryClient (+6 more)

### Community 214 - "pr-review-request-ageing.ts"
Cohesion: 0.12
Nodes (32): AgedReviewRequest, AgedReviewRequestReport, AgeingPullRequest, AGENT_AUTHOR_LOGINS, AGENT_AUTHOR_SET, ALLY_REVIEW_IDENTITY_LOGINS, ALLY_REVIEW_IDENTITY_SET, ANSWERING_REVIEW_STATES (+24 more)

### Community 215 - "dev-runner-worktree.ts"
Cohesion: 0.29
Nodes (10): bootstrapDevRunnerWorktreeEnv(), expandHomePrefix(), isLinkedGitWorktreeCheckout(), parseEnvFile(), repairStaleMigratedWorktreeEnvEntries(), resolveDefaultWorktreeHome(), resolveHomeAwarePath(), resolveWorktreeEnvFilePath() (+2 more)

### Community 216 - "dev-server-status.ts"
Cohesion: 0.24
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.15
Nodes (19): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+11 more)

### Community 218 - "heartbeat-dependency-scheduling.test.ts"
Cohesion: 0.20
Nodes (7): DEP_BLOCKED_MAX_RETRY_ATTEMPTS, DEP_BLOCKED_RETRY_REASON, composeSweepWakeFramePage(), quoteYamlScalar(), renderYamlArray(), mockAdapterExecute, mockGbrainCall

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "PluginWorkerManager"
Cohesion: 0.03
Nodes (43): PluginRouteJobDeps, PluginRouteWebhookDeps, PluginJobCoordinator, PluginJobCoordinatorOptions, PluginJobScheduler, PluginJobSchedulerOptions, SchedulerDiagnostics, TriggerJobResult (+35 more)

### Community 221 - "dispatch-readiness.ts"
Cohesion: 0.08
Nodes (37): extractWakeCommentIds(), allowsIssueInteractionWake(), BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY, classifyQueuedRunForDependencyReap(), deriveCommentId(), isBranchClaimRetryDeferred(), isDispatchRankReady(), isEffectivelyDependencyReadyForDispatch() (+29 more)

### Community 222 - "project-checkout-origin-reconciler.ts"
Cohesion: 0.10
Nodes (21): PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC, ProjectCheckoutOriginMismatchEntry, setProjectCheckoutOriginMismatchMetrics(), setProjectCheckoutOriginReconcileMetricsRefreshSuccess(), directoryExists(), mapWithConcurrency() (+13 more)

### Community 223 - "oidc-rbac.ts"
Cohesion: 0.15
Nodes (14): DexRbacConfig, GroupClaimRbacConfig, loadDexRbacConfig(), normalizeGroup(), parseIdTokenGroups(), reconcileDexUser(), reconcileGroupClaimUser(), ReconcileResult (+6 more)

### Community 224 - "isolation-workspace-reaper.ts"
Cohesion: 0.06
Nodes (45): buildIsolationReclaimPlan(), classifyIsolationWorkspaceAge(), createDbUnreachableAgentCount(), createDbWorkspaceUsageLookup(), DEFAULT_ISOLATION_WORKSPACE_ROOT, DEFAULT_MAX_DELETES_PER_TICK, DEFAULT_MAX_PLAN_AGE_MS, defaultScheduler (+37 more)

### Community 225 - "buildInviteOnboardingManifest"
Cohesion: 0.20
Nodes (12): buildInviteOnboardingManifest(), buildInviteOnboardingTextDocument(), buildOnboardingConnectionCandidates(), buildOnboardingDiscoveryDiagnostics(), extractInviteHumanRole(), extractInviteMessage(), isLoopbackHost(), loadJoinRequestRecords() (+4 more)

### Community 226 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.12
Nodes (19): PENDING_INTERACTION_MAX_AGE_MS, readStrandedAttendanceWindow(), createStrandedAttendancePrefetch(), windowFor(), windowIdsFor(), DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS, DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW, IssueAttendanceEvidence (+11 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.13
Nodes (17): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken(), minDate() (+9 more)

### Community 228 - "github-fetch.ts"
Cohesion: 0.13
Nodes (20): classifyGithubRefusal(), classifyGithubRefusalResource(), countGithubApiAttempt(), countGithubRefusal(), GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS, isGitHubDotCom(), refusalBody() (+12 more)

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
Cohesion: 0.18
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

### Community 238 - "issue-create-deduplication-routes.test.ts"
Cohesion: 0.10
Nodes (19): classifyIssueDuplicateCandidateLookupOutcome(), findCreateIssueDuplicateCandidates(), getReservablePostgresClient(), ISSUE_CREATE_DUPLICATE_CANDIDATE_LATENCY_BUDGET_MS, ISSUE_CREATE_DUPLICATE_CANDIDATE_ROW_CAP, ISSUE_CREATE_DUPLICATE_CANDIDATE_SCAN_CAP, raceCreateIssueDuplicateCandidateLookup(), scheduleDuplicateCandidateShownActivity() (+11 more)

### Community 239 - "routines-routes.test.ts"
Cohesion: 0.15
Nodes (11): createApp(), mockAccessService, mockAnnotationService, mockGetTelemetryClient, mockLogActivity, mockRoutineService, mockTrackRoutineCreated, pausedRoutine (+3 more)

### Community 240 - "approval-gate-reconciler.ts"
Cohesion: 0.11
Nodes (21): announcementBody(), announcementIdempotencyKey(), announcementMetadata(), ApprovalGateReconcileResult, ApprovalGateReconcilerOptions, ApprovalGateReconcilerScheduler, CandidateCursor, CandidateRow (+13 more)

### Community 241 - "stranded-blocked-issue-reconciler.ts"
Cohesion: 0.07
Nodes (36): awaitingUserInputReason(), createIssueDependencyReadiness(), findBlockedPromotionsAwaitingUserInput(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds() (+28 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "routes/projects.ts"
Cohesion: 0.05
Nodes (89): appendWithCap, readObject(), maskWorkspaceRuntimeTextForRead(), withholdWorkspaceOperationCapturedOutput(), resolveAgentSelfTrustPreset(), readRunIssueId(), getAccessibleResource(), runTranscriptReadGate() (+81 more)

### Community 244 - "runtime-api.ts"
Cohesion: 0.56
Nodes (9): buildRuntimeApiCandidateUrls(), choosePrimaryRuntimeApiUrl(), collectReachableInterfaceHosts(), formatOrigin(), isLinkLocalHost(), isLoopbackHost(), isWildcardHost(), normalizeHost() (+1 more)

### Community 245 - "pluginRegistryService"
Cohesion: 0.10
Nodes (15): main(), readStdin(), LinearWebhookFixture, loadLinearWebhookFixtures(), sanitizeLinearWebhookFixture(), sanitizeLinearWebhookValue(), SECRET_HEADER_NAMES, listReadyPluginEnvironmentDrivers() (+7 more)

### Community 246 - "routineService"
Cohesion: 0.08
Nodes (36): incrementRoutineDispatchMetric(), mapRoutineDescriptionDocument(), mapRoutineRevision(), nextResultText(), normalizeWebhookTimestampMs(), routineService(), appendRoutineRevision(), assertRoutineAccess() (+28 more)

### Community 247 - "renderMetrics"
Cohesion: 0.03
Nodes (70): TIMER_PRE_DISPATCH_EXCLUSION_INTERVAL_MS, TIMER_PRE_DISPATCH_EXCLUSION_SOURCE, AGENT_START_LOCK_PHASE_SECONDS_METRIC, COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC, COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC, COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR, coldInReviewLeaderScopedExpr(), CRASH_RECOVERY_CANDIDATE_INDEX_NAME (+62 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "deriveSkillExportDirCandidates"
Cohesion: 0.33
Nodes (10): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+2 more)

### Community 250 - "truncate-company-scoped-test-state.ts"
Cohesion: 0.15
Nodes (4): PENDING_RECOVERY_WAKE_CEILING_TIMEOUT_MULTIPLIER, Db, truncateCompanyScopedTestState(), TruncateCompanyScopedTestStateOptions

### Community 251 - "pr-reconciler-sweep.ts"
Cohesion: 0.33
Nodes (9): computeReconcilerWindow(), ReconcileFn, ReconcileResult, reconcilerSweepTick(), ReconcilerTarget, runReconcilerSweep(), selectReconcilerTargets(), SweepResult (+1 more)

### Community 252 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

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
Cohesion: 0.18
Nodes (30): asBoolean(), asString(), buildManifestFromPackageFiles(), buildPortableCatalogProvenance(), buildSkillSourceEntry(), buildYamlFile(), clonePortableRecord(), deriveManifestSkillKey() (+22 more)

### Community 258 - "middleware/index.ts"
Cohesion: 0.03
Nodes (43): httpLogger, createApp(), mockBumpAgentImagesForCompany, allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService (+35 more)

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
Cohesion: 0.10
Nodes (22): buildEnvInputMap(), buildMarkdown(), buildOrgTreeFromManifest(), buildReferencedSkillMarkdown(), classifyPortableFileKind(), collectRedactedPaths(), exportBundle(), previewExport() (+14 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.11
Nodes (27): versionMaterialHasValueDigest(), assertSecretRefBinding(), coerceLegacySecretRef(), countUuidValues(), createPluginSecretsHandler(), authorizeBoundSecret(), lookupBinding(), resolveBoundSecret() (+19 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "workspace-reuse-refusal-class.ts"
Cohesion: 0.10
Nodes (25): body(), setWorkspaceReuseRefusalMetricsRefreshSuccess(), setWorkspaceReuseRefusalWindowMetrics(), WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, compareProjectCheckoutOrigin(), normalizeRepoIdentity(), ProjectCheckoutOriginVerdict (+17 more)

### Community 267 - "branch-run-claims.ts"
Cohesion: 0.18
Nodes (14): acquireBranchRunClaim(), BranchClaimConflictError, BranchClaimReadDb, BranchRunClaim, canonicalizeGitRemoteIdentity(), computeBranchClaimKey(), getHeartbeatRunState(), isConstraintConflict() (+6 more)

### Community 268 - "http-metrics-transient-db-sqlstate.test.ts"
Cohesion: 0.06
Nodes (45): composeRouteLabel(), httpMetricsMiddleware(), InstrumentableResponse, INSTRUMENTED, isApiPath(), isEmptyListBody(), TRANSIENT_DB, TransientDbResponseTag (+37 more)

### Community 269 - "dev-runner-snapshot.test.ts"
Cohesion: 0.33
Nodes (3): readdirSync(), statSync(), tempRoots

### Community 270 - "company-branding-route.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService, mockCompanyPortabilityService, mockCompanyService, mockFeedbackService (+1 more)

### Community 271 - "routes/companies.ts"
Cohesion: 0.13
Nodes (19): assertInstanceAdmin(), assertCloudTenantCaller(), cleanupTerminalImportJobs(), cloudTenantRequestKey(), CompanyImportResult, companyRoutes(), assertImportTargetAccess(), parseDateQuery() (+11 more)

### Community 272 - "issue-comment-effects.ts"
Cohesion: 0.11
Nodes (30): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+22 more)

### Community 273 - "invite-accept-existing-member.test.ts"
Cohesion: 0.20
Nodes (6): accessServiceMock, ACTIVE_INVITE_EXPIRES_AT, createApp(), createAppWithActor(), logActivityMock, QueryHooks

### Community 274 - "issue-closed-workspace-routes.test.ts"
Cohesion: 0.08
Nodes (17): assigneeAgentActor, boardActor, createApp(), mockAccessService, mockExecutionWorkspaceService, mockHeartbeatService, mockIssueService, mockLogActivity (+9 more)

### Community 275 - "foreign-commit-notice.ts"
Cohesion: 0.15
Nodes (18): AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), buildForeignCommitNoticeBody(), CommitAuthorRef, CommitSkipReason, ForeignCommit, foreignCommitNoticeIdempotencyKey(), ForeignCommitSelection (+10 more)

### Community 276 - "model-profile-hint.ts"
Cohesion: 0.07
Nodes (42): prReviewAlreadyReviewedVetoCue(), ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runOwnsIssueExecutionLock(), runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUSES, toIssueActiveRunRow(), isStatusOnlyRecoveryContextSnapshot() (+34 more)

### Community 277 - "accessRoutes"
Cohesion: 0.08
Nodes (27): tooManyRequests(), accessRoutes(), assertInstanceAdmin(), getInviteCompanyBranding(), getInviteLogoAsset(), actorHasActiveUserMembership(), buildCliAuthApprovalPath(), canReplayOpenClawGatewayInviteAccept() (+19 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "terminal-gate-reconciler.ts"
Cohesion: 0.07
Nodes (42): PullRequestGateResult, recordTerminalGateResolvedSuppression(), armedMonitorNextCheckAt(), buildTerminalGateHumanOnlyComment(), buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler, gateSignalDigest() (+34 more)

### Community 280 - "agent-auth-jwt.ts"
Cohesion: 0.16
Nodes (17): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+9 more)

### Community 281 - "app.ts"
Cohesion: 0.04
Nodes (69): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), pluginStateFingerprint(), pluginStateSnapshot(), PRECOMPRESSED_STATIC_EXTENSIONS (+61 more)

### Community 282 - "backfill-agent-bundle.ts"
Cohesion: 0.21
Nodes (12): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+4 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 285 - "env"
Cohesion: 0.15
Nodes (10): bootstrap, ensureKubernetesEnvironment, env(), ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, fakeDb, listCompanyIds, updateGeneral (+2 more)

### Community 286 - "transitionCaseInTransaction"
Cohesion: 0.11
Nodes (34): activityActorPatch(), actorOwnsLease(), adjustParentCounts(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable(), assertNoOpenBlockers(), assertStageEnabled() (+26 more)

### Community 287 - "approval-budget-assertion-required.test.ts"
Cohesion: 0.11
Nodes (15): createAgentApp(), createRouteDb(), createUserApp(), fileCard(), mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockHeartbeatService (+7 more)

### Community 288 - "companyPortabilityService"
Cohesion: 0.11
Nodes (26): findServerAdapter(), assertKnownAdapterType(), collectAgentSafeImportPolicyErrors(), companyPortabilityService(), applyImportedAgentPermissionGrants(), assertImportAdapterConfigConstraints(), assertKnownImportAdapterType(), buildPreview() (+18 more)

### Community 289 - "pr-review-state-reconciler.ts"
Cohesion: 0.11
Nodes (29): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+21 more)

### Community 290 - "environmentRoutes"
Cohesion: 0.13
Nodes (17): environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment(), environmentDeleteBlockMessage(), logEnvironmentCustomImageActivity(), logInstanceEnvironmentActivity() (+9 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.08
Nodes (6): HeartbeatServiceOptions, PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, __resetQuotaExhaustedHookStateForTesting(), mockAdapterExecute

### Community 292 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "user-profiles.ts"
Cohesion: 0.22
Nodes (16): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+8 more)

### Community 295 - "ac-policy-sweep.ts"
Cohesion: 0.15
Nodes (17): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+9 more)

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "company-skills-catalog-service.test.ts"
Cohesion: 0.25
Nodes (7): contentHash(), createService(), mockCatalogService, sampleAssetBytes, sampleCatalogSkill, sampleFiles, sha256()

### Community 298 - "run-secret-redaction.ts"
Cohesion: 0.13
Nodes (24): isSyntheticNonProgressRunLogChunk(), compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan() (+16 more)

### Community 299 - "node:http"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, baseGoal, createApp(), loadRouteModules() (+3 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (22): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+14 more)

### Community 302 - "recovery-stale-issue-lock-sweep.test.ts"
Cohesion: 0.10
Nodes (6): AGENT_POD_BUSY_MAX_STALE_MS, NON_LIVE_EXECUTION_SILENCE_MS, LOCKLESS_DEFERRED_WAKE_MIN_AGE_MS, STALE_RUNNING_ISSUE_LOCK_MS, mockProbeAgentPodActivity, mockTelemetryClient

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 304 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 305 - "ccrotate-capacity-retry.ts"
Cohesion: 0.03
Nodes (79): applyCcrotateCapacityDecision(), CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MIN_PARK_MS (+71 more)

### Community 306 - "zoned-cron.ts"
Cohesion: 0.12
Nodes (24): assertTimeZone(), isSubHourlyCronExpression(), nextCronTickInTimeZone(), buildCronMask(), CronMask, daysInMonth(), getZonedMinuteFormatter(), getZonedMinuteParts() (+16 more)

### Community 307 - "issue-subtree-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.11
Nodes (12): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, AgentRow, collectWriterFiles(), columnReasonLiteralsFromDirectInserts(), CompanyRow, createApp(), Db, isProductionSource() (+4 more)

### Community 309 - "builtInAgentService"
Cohesion: 0.10
Nodes (56): assertAdapterAllowed(), assertKnownBuiltInAgentModel(), builtInAgentService(), autoProvisionBundledAgents(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), defaultProvisionInput() (+48 more)

### Community 310 - "invite-rate-limit.ts"
Cohesion: 0.21
Nodes (6): createInviteRateLimiter(), INVITE_RATE_LIMIT_MAX_REQUESTS, INVITE_RATE_LIMIT_WINDOW_MS, InviteRateLimiter, InviteRateLimitResult, createApp()

### Community 311 - "model-validation.test.ts"
Cohesion: 0.18
Nodes (15): ALLOW_UNLISTED_ADAPTER_MODELS_ENV, allowsUnlistedAdapterModels(), findUnregisteredAdapterModel(), findUnregisteredModel(), introducesModel(), asModels(), claudeK8sStub(), CLI_ALIASES (+7 more)

### Community 312 - "plugin-event-bus.ts"
Cohesion: 0.13
Nodes (8): createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus, Subscription

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "startup-banner.ts"
Cohesion: 0.20
Nodes (15): readConfigFile(), resolveDefaultConfigPath(), findConfigFileFromAncestors(), resolvePaperclipConfigPath(), resolvePaperclipEnvPath(), ansi, color(), EmbeddedPostgresInfo (+7 more)

### Community 315 - "agent-model-registry-validation.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockFindUnregisteredAdapterModel, mockLogActivity (+6 more)

### Community 316 - "config"
Cohesion: 0.24
Nodes (8): describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest(), tryEnvLabFixture(), tryExplicitConfig(), config()

### Community 317 - "evidence-truth.ts"
Cohesion: 0.12
Nodes (18): buildGithubTruthProbe(), GithubTruthDeps, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr, PROBE_DEADLINE_MS, probeOne() (+10 more)

### Community 318 - "process-crash-guard-exit.test.ts"
Cohesion: 0.14
Nodes (12): MAX_WRITE_WAIT_MS, CrashResult, fixture, here, LATE_BACKPRESSURE_RUN, PREFILL_RUN, readRemainingStderr(), runFixtureWithStalledStderr() (+4 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "environment-capabilities-k8s.test.ts"
Cohesion: 0.11
Nodes (17): createApp(), currentActor, mockAccessService, mockAgentService, mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService (+9 more)

### Community 321 - "kkroo-bundled-plugins.ts"
Cohesion: 0.21
Nodes (16): autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin(), installKkrooLocalPlugins() (+8 more)

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "redactEventPayload"
Cohesion: 0.17
Nodes (9): redactAgentConfigPayload(), redactEventPayload(), containDefaultsPayload(), redactJoinRequestRecord(), hireMetadataFixture(), hireRuntimeConfigFixture(), issuePrefix(), seedCompany() (+1 more)

### Community 324 - "logActivity"
Cohesion: 0.04
Nodes (63): isAllowedContentType(), ALLOWED_COMPANY_LOGO_CONTENT_TYPES, assetRoutes(), sanitizeSvgBuffer(), logCaseAnnotationRemaps(), inboxDismissalRoutes(), inboxDismissalSchema, requireBoardUser() (+55 more)

### Community 325 - "zodToOpenApiSchema"
Cohesion: 0.43
Nodes (7): applyNumberChecks(), applyStringChecks(), isOptionalSchema(), parametersFromSchema(), pipeInner(), unwrapSchema(), zodToOpenApiSchema()

### Community 326 - "openrouter/execute.ts"
Cohesion: 0.13
Nodes (17): AGENT_TOOLS, callOpenRouter(), ChatMessage, execAsync, execute(), executeToolCall(), walk(), sanitize() (+9 more)

### Community 327 - "company-export-readme.ts"
Cohesion: 0.43
Nodes (6): generateOrgChartMermaid(), generateReadme(), mermaidEscape(), mermaidId(), ROLE_LABELS, skillSourceLabel()

### Community 329 - "plugin-environment-driver.ts"
Cohesion: 0.32
Nodes (15): createPluginEnvironmentDriver(), cancelPluginEnvironmentInteractiveSetup(), capturePluginEnvironmentTemplate(), deletePluginEnvironmentTemplate(), destroyPluginEnvironmentLease(), executePluginEnvironmentCommand(), getPluginEnvironmentInteractiveSetup(), pluginDriverProviderKey() (+7 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.08
Nodes (32): basenameOf(), COMMAND_PREFIXES, findMissingHookCommandPaths(), HookCommandAuditDeps, HookCommandAuditFinding, INCLUDE_DIR_OPERAND_OPTIONS, isAbsoluteLiteral(), isScriptInterpreter() (+24 more)

### Community 331 - "fd-class-metrics.ts"
Cohesion: 0.12
Nodes (22): boundedDirLabel(), boundedSegment(), classifyFdTarget(), CollectFdClassOptions, collectFdClassSnapshot(), FD_CLASS_MAX_ENTRIES, FD_CLASS_MAX_SEGMENT_CHARS, FD_CLASS_MAX_SERIES (+14 more)

### Community 332 - "boardAuthService"
Cohesion: 0.14
Nodes (21): boardApiKeyExpiresAt(), boardAuthService(), approveCliAuthChallenge(), assertCurrentBoardKey(), cancelCliAuthChallenge(), createCliAuthChallenge(), createNamedBoardApiKey(), createServiceAccountBoardKey() (+13 more)

### Community 333 - "pluginCapabilityValidator"
Cohesion: 0.06
Nodes (19): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, CapabilityScopedInvoker, DEFAULT_GLOBALS (+11 more)

### Community 334 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 335 - "isolation-reclaim-job.ts"
Cohesion: 0.13
Nodes (23): buildIsolationReclaimJobManifest(), DEFAULT_RECLAIM_ACTIVE_DEADLINE_SECONDS, DEFAULT_RECLAIM_TTL_SECONDS, ISOLATION_WORKSPACES_CLAIM_SUBPATH, IsolationReclaimJobManifest, IsolationReclaimJobSpec, MAX_RECLAIM_PLAN_ENV_BYTES, RECLAIM_CLAIM_MOUNT_PATH (+15 more)

### Community 336 - "setupEnvironmentCustomImageTerminalWebSocketServer"
Cohesion: 0.11
Nodes (12): clientSafeErrorMessage(), closeClient(), errorStatus(), handleClientFrame(), parseTerminalDimension(), parseTerminalPath(), safeErrorName(), sendJson() (+4 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.29
Nodes (5): require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance

### Community 338 - "chain-pass-timing.ts"
Cohesion: 0.17
Nodes (9): createRecoveryChainTimer(), RECOVERY_CHAIN_PASS_TIMING_MESSAGE, RECOVERY_CHAIN_TIMING_MESSAGE, RecoveryChainPassOutcome, RecoveryChainPassRecord, RecoveryChainTimer, RecoveryChainTimerOptions, harness() (+1 more)

### Community 339 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (19): PROVIDER_CAPACITY_MAX_HORIZON_MS, createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile() (+11 more)

### Community 340 - "scrape-metrics-collector.ts"
Cohesion: 0.03
Nodes (79): BOARD_DECISION_STATUSES, refreshApprovalQueueMetrics(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, APPROVAL_OLDEST_PENDING_AGE_METRIC, APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC (+71 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.60
Nodes (5): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance()

### Community 343 - "gbrain-client-factory.test.ts"
Cohesion: 0.15
Nodes (8): authbotCredentialValue(), BearerSource, NullBearer, OAuthMintBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 344 - "zoned-cron-equivalence.test.ts"
Cohesion: 0.13
Nodes (20): assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute(), nextCronTickInTimeZone(), WEEKDAY_INDEX, zonedMinuteFormatterCache (+12 more)

### Community 345 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.05
Nodes (42): resolveDefaultSecretsKeyFilePath(), AwsSecretsManagerMaterial, awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider (+34 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.18
Nodes (12): listSuccessfulRunHandoffStates(), successfulRunHandoffStateFromActivity(), hydrateSuccessfulRunHandoffLiveness(), resolveSuccessfulRunHandoffForLaterContinuation(), resolveSuccessfulRunHandoffForTerminalIssues(), SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES, SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES, SUCCESSFUL_RUN_HANDOFF_TERMINAL_ISSUE_STATUSES (+4 more)

### Community 348 - "routes/routines.ts"
Cohesion: 0.11
Nodes (26): ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), PROJECT_ENV_VALUE_MASK, maskRoutineEnv(), maskRoutineEnvelopeEnv() (+18 more)

### Community 349 - "REDACTED_EVENT_VALUE"
Cohesion: 0.21
Nodes (10): REDACTED_EVENT_VALUE, withPublicIssueWorkspaceSettings(), publicIssueExecutionWorkspaceSettings(), WITHHELD_WORKSPACE_RUNTIME_VIEWER, ENTITLED_VIEWER, withheld(), ENTITLED_VIEWER, settings() (+2 more)

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

### Community 355 - "buildPortableProjectWorkspaces"
Cohesion: 0.24
Nodes (10): buildPortableProjectWorkspaces(), containsAbsolutePathFragment(), containsSystemDependentPathValue(), derivePortableProjectWorkspaceKey(), execFileAsync, inferPortableWorkspaceGitMetadata(), readGitOutput(), readGitRemoteUrl() (+2 more)

### Community 356 - "pr-review-request-ageing-producer.ts"
Cohesion: 0.16
Nodes (14): DigestProducer, DigestSection, DEFAULT_ESCALATE_AFTER_DAYS, formatPullRequestRef(), buildPrReviewRequestAgeingSection(), LoadedReviewState, PR_REVIEW_REQUEST_AGEING_SECTION_KEY, prReviewRequestAgeingProducer (+6 more)

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
Cohesion: 0.13
Nodes (18): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestHasMerged(), pullRequestMergeQueueState (+10 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "heartbeat-workspace-finalize-branch.test.ts"
Cohesion: 0.14
Nodes (8): adapterExecute, createGitRepo(), Db, drainInFlightExecutions(), execFileAsync, Heartbeat, runGit(), seedRunTarget()

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

### Community 367 - "run-log-terminal-result.ts"
Cohesion: 0.16
Nodes (12): begin, findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), RUN_LOG_TERMINAL_MAX_SCAN_BYTES, RUN_LOG_TERMINAL_TAIL_BYTES, RunLogRangeReader, RunLogTailRead (+4 more)

### Community 368 - "agent-profile-change-gate-mixing.test.ts"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity, mockSecretService (+3 more)

### Community 369 - "approval-agent-config-authz-routes.test.ts"
Cohesion: 0.12
Nodes (12): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService (+4 more)

### Community 370 - "done-gate.ts"
Cohesion: 0.60
Nodes (3): DoneGateInput, hasPrLinkEvidence(), shouldBlockNarratedDone()

### Community 371 - "heartbeat-stale-queue-invalidation.test.ts"
Cohesion: 0.21
Nodes (9): mockAdapterExecute, resumeContinuationRetry(), seedCompanyAndAgent(), seedContinuationSummary(), SeedOptions, seedParkedContinuationRetry(), seedQueuedRun(), SeedResult (+1 more)

### Community 372 - "plugin-config-write-race.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), createRaceDb(), acquireAdvisoryLock(), deferred(), mockSecretService, registryFor, store, TxHandle

### Community 373 - "issue-goal-fallback.ts"
Cohesion: 0.60
Nodes (3): MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId()

### Community 374 - "routine-fire-gap-metrics.test.ts"
Cohesion: 0.11
Nodes (16): PROCESS_MAPPING_COUNT_METRIC, ROUTINE_DISPATCH_METRIC, ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC, ROUTINE_FIRE_INTERVAL_METRIC, ROUTINE_LAST_DONE_FIRE_AGE_METRIC, ROUTINE_LAST_FIRE_START_AGE_METRIC, ALLOWED_UNRESOLVED_REFERENCES, danglingHelpReferences() (+8 more)

### Community 375 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.19
Nodes (15): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat() (+7 more)

### Community 376 - "issue-checkout-status.ts"
Cohesion: 0.13
Nodes (20): evaluateAgentInvokability(), evaluateAgentInvokabilityFromDb(), shouldReopenTerminalIssueForDeferredWake(), checkoutRestoreStatusExpression, checkoutRestoreTargetStatus, DbOrTransaction, hasCancelledBlocker, hasPendingBlocker (+12 more)

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

### Community 384 - "company-issue-identity-guard.test.ts"
Cohesion: 0.19
Nodes (13): syncIssueIdentityFromLinearTeam(), auditRows(), BLOCKCAST, expectSilentNoOp(), findUnguardedIdentityWrites(), IDENTITY_KEYS, IDENTITY_WRITE_ALLOW_LIST, identityOf() (+5 more)

### Community 385 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 386 - "routes/approvals.ts"
Cohesion: 0.05
Nodes (46): ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext(), requireApprovalAccess(), resolveBoardEscalationCoalesceKey(), ApprovalRunContextDecision (+38 more)

### Community 387 - "fetchIssueSearchData"
Cohesion: 0.16
Nodes (15): activeIssueFilters(), countArtifacts(), enrichIssueSnippets(), fetchIssueSearchData(), flagFuzzyMatch(), flagScopeCondition(), flagTextMatch(), emptyFilterOptionCounts() (+7 more)

### Community 388 - "key"
Cohesion: 0.12
Nodes (14): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), key(), findWakeIdempotencyReceipt() (+6 more)

### Community 389 - "issue-monitor-scheduler.test.ts"
Cohesion: 0.18
Nodes (10): ISSUE_MONITOR_DISPATCH_LAPSE_MS, ISSUE_MONITOR_LIVE_CONSUMER_MAX_AGE_MS, ISSUE_MONITOR_TRIGGERED_STALL_GRACE_MS, cleanupRows(), createHeartbeatWithClaimRace(), heartbeatSideEffectFingerprint(), notPreDispatchExclusion, reapPastOverAgeQueuedRun() (+2 more)

### Community 390 - "readPenstockCapacity"
Cohesion: 0.26
Nodes (11): capacityEndpointUnavailable(), defaultCapacityRetry(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger (+3 more)

### Community 391 - "issue-tree-hold-metrics.ts"
Cohesion: 0.21
Nodes (12): ActivePauseHoldRow, activePauseHoldsGauge(), AGE_BUCKETS, AgeBucket, countActivePauseHolds(), ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC, IssueTreeHoldCollectorOptions, setActivePauseHolds() (+4 more)

### Community 392 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 393 - "issue-approval-link-authorization.ts"
Cohesion: 0.11
Nodes (28): assertIssueLinksAllowed(), AccessDecider, evaluateAgentIssueApprovalLinkAuthorization(), evaluateTaskWatchdogSubtreeScope(), isCreatorOrManagerChainDecision(), isCurrentIssueExecutionRun(), IssueApprovalLinkAuthorizationIssue, IssueApprovalLinkVerdict (+20 more)

### Community 394 - "issues-open-assignment-census.test.ts"
Cohesion: 0.18
Nodes (7): clampIssueListLimit(), OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, appAs(), oracle(), PRIORITY_RANK, rankOf()

### Community 395 - "createToolGatewayService"
Cohesion: 0.04
Nodes (114): parseRemoteHttpEndpoint(), remoteEndpoint(), asRecord(), auditSafeEndpoint(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions() (+106 more)

### Community 396 - "taskWatchdogService"
Cohesion: 0.22
Nodes (12): watchdogMapForIssues(), issueIdFromRunContext(), issueIdFromWakePayload(), readNonEmptyString(), summarizeIssueWatchdog(), taskWatchdogService(), collectClassifierInput(), collectCompletedRunIssueIds() (+4 more)

### Community 399 - "docker-onboard-smoke-contract.test.ts"
Cohesion: 0.50
Nodes (3): repoRoot, smokeScript, smokeWorkflow

### Community 401 - "approval-payload-title-guard.test.ts"
Cohesion: 0.29
Nodes (10): findPayloadProperty(), isApprovalsInsertValuesCall(), listSourceFiles(), objectHasTitleKey(), payloadObjectLiteralsOf(), propertyNameIs(), scanFile(), visit() (+2 more)

### Community 402 - "openclaw-invite-prompt-route.test.ts"
Cohesion: 0.25
Nodes (8): createApp(), createDbStub(), createSelectChain(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity, mockStorage

### Community 403 - "activityService"
Cohesion: 0.23
Nodes (11): activityService(), asRecord(), backfillMissingRunLivenessForIssue(), countValue(), dateValue(), latestDate(), readNumber(), scheduleRunLivenessBackfill() (+3 more)

### Community 404 - "documentAnnotationService"
Cohesion: 0.08
Nodes (17): ActorInput, CaseDocumentRow, commentSelect, documentAnnotationService(), assertLinkedIssueComment(), IssueDocumentRow, RoutineDocumentRow, snapshotFromThread() (+9 more)

### Community 405 - "sandbox-provider-runtime.ts"
Cohesion: 0.05
Nodes (41): ParsedEnvironmentConfig, probeEnvironment(), probeK8sEnvironment(), raceWithTimeout(), findReusableSandboxLeaseId(), probePluginSandboxProviderDriver(), AcquireSandboxLeaseInput, acquireSandboxProviderLease() (+33 more)

### Community 406 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.20
Nodes (5): createDb(), createSelectChain(), then(), values(), chartDir

### Community 409 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 410 - "issue-watchdogs-routes.test.ts"
Cohesion: 0.28
Nodes (5): createApp(), seedCloudTenantMember(), seedCompany(), seedWatchdogRun(), uniqueIssuePrefix()

### Community 411 - "codex-models.ts"
Cohesion: 0.40
Nodes (9): dedupeModels(), fetchOpenAiModels(), fingerprint(), listCodexModels(), loadCodexModels(), mergedWithFallback(), refreshCodexModels(), resetCodexModelsCacheForTests() (+1 more)

### Community 412 - "buildLocalUpstreamExportBundle"
Cohesion: 0.29
Nodes (10): buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), canonicalJson(), buildBundle(), countEntityTypesForManifest(), normalizedContentHash(), normalizePortableFileEntry() (+2 more)

### Community 413 - "heartbeat-worker-crash-marking.test.ts"
Cohesion: 0.22
Nodes (4): HeartbeatEnvironmentRuntime, insertRun(), seedCrashMarkedRun(), published()

### Community 421 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.11
Nodes (8): blocked(), humanGatedAgeingProducer, collect(), NOW, CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

### Community 425 - "agent-budgets-route-config-revision.test.ts"
Cohesion: 0.24
Nodes (6): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets()

### Community 426 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 427 - "cases-routes.test.ts"
Cohesion: 0.20
Nodes (3): app(), authenticatedApp(), enableCases()

### Community 428 - "adapter-registry-bootstrap.ts"
Cohesion: 0.24
Nodes (8): listServerAdapters(), AdapterRegistryEnv, parseAdapterRegistryEnv(), setAdapterDisabled, ENTRY, fetchAllQuotaWindows(), providerSlugForAdapterType(), withQuotaTimeout()

### Community 430 - "plugin-metric-exposition.test.ts"
Cohesion: 0.10
Nodes (22): PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_DURATION_BUCKETS_SECONDS, PLUGIN_METRIC_DURATION_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+14 more)

### Community 433 - "dispatch-decline-instrumentation.test.ts"
Cohesion: 0.21
Nodes (11): AGENT_DISPATCH_DECLINED_METRIC, HEARTBEAT_RUN_FAILED_METRIC, KNOWN_DISPATCH_DECLINE_REASONS, normalizeDispatchDeclineReason(), UNKNOWN_DISPATCH_DECLINE_REASON, countInCode(), findUninstrumentedReturns(), findUnprovenAccumulatorReturns() (+3 more)

### Community 437 - "extractEnforcementAssertions"
Cohesion: 0.24
Nodes (12): stampPriors(), asArray(), asFiniteNumber(), asNonEmptyString(), asRecord(), extractEnforcementAssertions(), loadEnforcedBudgetPolicies(), readAmountCents() (+4 more)

### Community 438 - "approval-enforcement-reconciler.test.ts"
Cohesion: 0.18
Nodes (10): BUDGET_POLICY_AMOUNT_ASSERTION, classifyEnforcementAssertion(), diffEnforcementAssertions(), EnforcedBudgetPolicy, parseJsonBodyStrict(), AMOUNT_MOVED_AFTER_DECISION, AMOUNT_UNMOVED_SINCE_DECISION, CARD_6F45844E_DECIDED_AT (+2 more)

### Community 446 - "issue-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockGetTelemetryClient, mockIssueService (+1 more)

### Community 447 - "github-write-egress-scrub.test.ts"
Cohesion: 0.09
Nodes (17): _resetInstallationTokenCache(), FAKE_AWS_KEY_ID, FAKE_GITHUB_PAT, FAKE_URI_SECRET, h, jsonResponse(), PRIVATE_KEY_PEM, { privateKey } (+9 more)

### Community 460 - "secretService"
Cohesion: 0.05
Nodes (77): getSecretProvider(), isSecretProviderClientError(), asRecord(), assertClass3StaticLeaseAllowed(), assertSelectableProviderConfig(), CanonicalEnvBinding, canonicalizeBinding(), cleanupPreparedProviderWrite() (+69 more)

### Community 461 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.08
Nodes (12): FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR, SDK_INSTALL_RACE_ERROR, npmMock, tornSharedStore(), writeInstalledPackageVersion(), writeLockfileVersion() (+4 more)

### Community 462 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.25
Nodes (3): createApp(), seedCompanyAgentAndRuns(), seedPendingReviewStageIssue()

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "assertAssignableAgent"
Cohesion: 0.27
Nodes (10): AgentAssignmentConflictReason, AgentAssignmentKind, assertAssignableAgent(), AssignabilityAgent, assignmentMessage(), assignmentReasonFromHealth(), conflictDetails(), getAgent() (+2 more)

### Community 465 - "event-loop-stall-log.ts"
Cohesion: 0.36
Nodes (7): EventLoopStallLogOptions, resolveStallThresholdMs(), setEventLoopStallListener(), startEventLoopStallLogging(), blockEventLoop(), blockUntilStallObserved(), sleep()

### Community 466 - "agents-service-secret-bindings.test.ts"
Cohesion: 0.25
Nodes (3): mockEnsureBuiltInAgent, mockNotifyHireApproved, pendingApproval()

### Community 467 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 468 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.06
Nodes (20): HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, adapterExecute, execFile, mockDeleteAgentJobExact, mockHasActiveJobForAgent, mockListAgentJobRunStatuses, mockListLiveAgentJobRunIds, mockListManagedAgentJobs (+12 more)

### Community 469 - "pr-review-head-attestation.ts"
Cohesion: 0.32
Nodes (4): allyReviewAlreadyAttestsHead(), ListPrReviewsForAttestation, PrReviewHeadAttestation, check()

### Community 470 - "issue-monitor-queue-lock.ts"
Cohesion: 0.67
Nodes (3): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock()

### Community 471 - "billing-classification.ts"
Cohesion: 0.35
Nodes (9): CASH_ZEROING_BILLING_TYPE, DIRECT_METERED_BILLING_TYPES, isBrokeredLane(), isPenstockBaseUrl(), LaneBillingInput, normalizeLedgerBillingType(), PROVIDER_BASE_URL_ENV, readEnvString() (+1 more)

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

### Community 480 - "unprocessable"
Cohesion: 0.05
Nodes (96): unprocessable(), assertAgentDefaultEnvironmentSelection(), validatePolicyBody(), skillImportPolicyResource(), assertNoOpenBudgetIncident(), getExistingApproval(), resolveApproval(), assertImportedSkillKeyAllowed() (+88 more)

### Community 482 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 483 - "company-issue-identity.ts"
Cohesion: 0.27
Nodes (10): ISSUE_IDENTITY_ACTIVITY_ACTION, IssueIdentityPlan, IssueIdentityRefusal, IssueIdentityRequest, IssueIdentityState, normalizeIssuePrefix(), planIssueIdentityChange(), setCompanyIssueIdentity() (+2 more)

### Community 484 - "renderYamlBlock"
Cohesion: 0.53
Nodes (6): compareYamlKeys(), isEmptyObject(), orderedYamlEntries(), renderFrontmatter(), renderYamlBlock(), renderYamlScalar()

### Community 486 - "plugin-worker-invocation-scope.cjs"
Cohesion: 0.40
Nodes (5): pendingNested, readline, rl, send(), sendNestedHostRequest()

### Community 487 - "issue-checkout-routine-lock-conflict.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedDuplicateRoutineExecutions(), seedRun()

### Community 488 - "issue-release-lock-only-degrade.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedHolderRun(), seedStalePair()

### Community 489 - "app-plugin-takeover-resync.test.ts"
Cohesion: 0.20
Nodes (9): boot(), BOOT_ROWS, bootLoaded(), fakeDb, handleIds, loader, pluginRows, state (+1 more)

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

### Community 511 - "authorization-service.test.ts"
Cohesion: 0.27
Nodes (8): buildFixture(), createAgent(), createCompany(), createIssue(), createProject(), grantAgentPermission(), IssueAction, Relation

### Community 513 - "approval-gate-already-terminal.test.ts"
Cohesion: 0.11
Nodes (14): createAgentApp(), createRouteDb(), found(), MISMATCHED_GATE, mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockGetWorkflowRun (+6 more)

### Community 515 - "parseFrontmatterMarkdown"
Cohesion: 0.20
Nodes (10): applySelectedFilesToSource(), ensureMarkdownPath(), filterCompanyMarkdownIncludes(), normalizeSelectedFiles(), parseFrontmatterMarkdown(), parseYamlBlock(), parseYamlFrontmatter(), parseYamlScalar() (+2 more)

### Community 516 - "deriveRoutineFireGapsMs"
Cohesion: 0.27
Nodes (8): deriveDaySkipGapMs(), deriveRoutineFireAgeHorizonMs(), deriveRoutineFireGapsMs(), EVERY_DAY, gapsFor(), SAMPLED_AT, resetRoutineFireGapsMemoForTests(), sampleRoutineFireGapsMs()

### Community 517 - "classifyTaskWatchdogSubtree"
Cohesion: 0.24
Nodes (9): classifyTaskWatchdogSubtree(), issueUpdatedAtIso(), optionalIso(), pathIssueIds(), stableStopFingerprint(), TaskWatchdogClassifierIssue, waitingPathIds(), classify() (+1 more)

### Community 518 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 519 - "scrape-metrics-routine-fire-gap-work.test.ts"
Cohesion: 0.22
Nodes (5): db, rows, settle(), tickAt(), TRIGGERS

### Community 520 - "issue-assignment-wakeup.ts"
Cohesion: 0.28
Nodes (6): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail, allowPenstockGate

### Community 521 - "markTerminalWatchdogIssueReviewed"
Cohesion: 0.31
Nodes (9): isTerminalIssueStatus(), isWatchdogReviewDisposition(), normalizeStopFingerprint(), reviewedFingerprintForWatchdogIssue(), stopFingerprintFromText(), markTerminalWatchdogIssueReviewed(), sameFingerprintWatchdogReviewIsStillOpen(), watchdogIssueHasPendingReviewPath() (+1 more)

### Community 522 - "ws-upgrade-url-log-guard.test.ts"
Cohesion: 0.31
Nodes (8): argumentText(), COVERED, here, identifierPattern(), rawUrlLogCalls(), serverSrc, taintedLocals(), tsFilesUnder()

### Community 523 - "inspectExecutionWorkspaceBranchForReconcile"
Cohesion: 0.32
Nodes (8): execFileAsync, explainGitWorktreeBranchReconcileInspection(), fingerprintWorkspaceBranchIncoherence(), getGitWorktreeBranchAncestryVerdict(), inspectExecutionWorkspaceBranchForReconcile(), readGitStdout(), runGit(), stableStringify()

### Community 524 - "workspace-runtime-read-model.ts"
Cohesion: 0.39
Nodes (7): loadEffectiveRuntimeServicesByExecutionWorkspace(), listCurrentRuntimeServicesForExecutionWorkspaces(), listCurrentRuntimeServicesForProjectWorkspaces(), runtimeServiceIdentityKey(), RuntimeServiceReadDb, selectCurrentRuntimeServiceRows(), WorkspaceRuntimeServiceRow

### Community 525 - "plugin-event-outbox.ts"
Cohesion: 0.43
Nodes (4): pollOnce(), pruneOutbox(), resetStaleProcessing(), startPluginEventOutbox()

### Community 526 - "evaluateWatchdog"
Cohesion: 0.29
Nodes (8): buildStoppedFingerprintComment(), stoppedFingerprintMetadata(), ensureReusableWatchdogIssue(), evaluateWatchdog(), findTaskWatchdogIssue(), hasLivePathForIssue(), taskWatchdogWakeIdempotencyKey(), watchdogWakeContext()

### Community 527 - "execution-workspaces-service.test.ts"
Cohesion: 0.46
Nodes (6): createTempRepo(), execFileAsync, fingerprintWorkspaceBranchIncoherenceForTest(), readGit(), runGit(), stableStringifyForTest()

### Community 528 - "issue-stable-enumeration-routes.test.ts"
Cohesion: 0.29
Nodes (3): createApp(), seedCompany(), uniqueIssuePrefix()

### Community 529 - "plugin-orchestration-apis.test.ts"
Cohesion: 0.32
Nodes (3): issuePrefix(), seedCompanyAndAgent(), seedIssueWithWorktree()

### Community 531 - "readProjectWorkspaceRuntimeConfig"
Cohesion: 0.81
Nodes (6): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates()

### Community 532 - "ensureServerWorkspaceLinksCurrent"
Cohesion: 0.33
Nodes (7): discoverWorkspacePackagePaths(), visit(), ensureServerWorkspaceLinksCurrent(), findServerWorkspaceLinkMismatches(), findWorkspaceRoot(), isLinkedGitWorktreeCheckout(), readJsonFile()

### Community 533 - "heartbeat-preferred-workspace-fail-loud.test.ts"
Cohesion: 0.33
Nodes (4): adapterExecute, allowPenstockGate, createGitRepo(), execFileAsync

### Community 534 - "recoverClaimedReviewWithUnavailableVerification"
Cohesion: 0.43
Nodes (7): recoverClaimedReviewWithUnavailableVerification(), seedAdapterInvokeEvent(), seedEnvironmentLeaseFixture(), seedLaunchedReservation(), seedRunFixture(), seedTerminalExternalRunWithLease(), seedVanishedRun()

### Community 535 - "heartbeat-worktree-suppression.test.ts"
Cohesion: 0.33
Nodes (4): armWorktreeRunExecution(), deleteHeartbeatRunsWithDependents(), drainInFlightExecutions(), isHeartbeatRunDependentFkError()

### Community 536 - "recovery-chain-pass-timing-wiring.test.ts"
Cohesion: 0.29
Nodes (4): heartbeatSrc, here, indexSrc, recoverySrc

### Community 537 - "materializeImportEnvInputValues"
Cohesion: 0.40
Nodes (6): materializeImportEnvInputValues(), envInputScopedKey(), envInputValue(), importSecretKey(), importSecretLabel(), writeManifestEnvBinding()

### Community 539 - "health.test.ts"
Cohesion: 0.33
Nodes (4): createApp(), mockReadPersistedDevServerStatus, testServerInfo, serverVersion

### Community 541 - "validateTerminalUpgrade"
Cohesion: 0.50
Nodes (3): CustomImageTerminalService, terminalPayloadValidationError(), validateTerminalUpgrade()

### Community 544 - "external-wait-doc-contract.test.ts"
Cohesion: 0.67
Nodes (3): docPath, documentedSection(), documentedSnippet()

### Community 546 - "drainInFlightExecutions"
Cohesion: 0.50
Nodes (4): drainInFlightExecutions(), seedQueuedIssueRunFixture(), settleClaimedPrReview(), waitForRunToSettle()

### Community 547 - "expectSourceScopedStrandedRecoveryAction"
Cohesion: 0.50
Nodes (4): expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts(), waitForHeartbeatIdle(), waitForValue()

## Knowledge Gaps
- **3974 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Db`, `LogEntry` (+3969 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 5961 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **76 communities omitted from the detail section** — 1–15 nodes each in graph.json, 44 of them ≥3; graphify omits a community with <3 nodes once file-hub and AST-stub nodes are discounted — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `executionWorkspaceService()` connect `services/execution-workspaces.ts` to `unprocessable`, `services/issues.ts`, `recoveryService`, `inspectExecutionWorkspaceBranchForReconcile`, `workspace-runtime-read-model.ts`, `issue-execution-policy.ts`, `readProjectWorkspaceRuntimeConfig`, `notFound`, `execution-workspace-policy.ts`, `issue-recovery-actions.ts`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `releaseIssueExecutionAndPromote()` connect `parseObject` to `heartbeat.ts`, `toolAccessService`, `logActivity`, `recoveryService`, `managed-checkout-partial-clone.ts`, `issue-execution-policy.ts`, `issue-checkout-status.ts`, `heartbeatService`, `config.ts`, `handleRunLivenessContinuation`, `dispatch-readiness.ts`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Why does `executeRun()` connect `executeRun` to `heartbeat.ts`, `low-trust-red-team-routes.test.ts`, `heartbeat-hintless-transient-upstream.test.ts`, `branch-run-claims.ts`, `trust-preset-resolver.ts`, `workspace-runtime.ts`, `github-webhook.ts`, `heartbeat-run-runtime-status.ts`, `parseObject`, `k8s-job-liveness.ts`, `model-profile-hint.ts`, `agent-auth-jwt.ts`, `heartbeatService`, `instanceSettingsService`, `db-retry.ts`, `adapters/index.ts`, `run-secret-redaction.ts`, `log-redaction.ts`, `ccrotate-capacity-retry.ts`, `execution-workspace-cleanup.ts`, `external-runtime-reservations.ts`, `heartbeat-stop-metadata.ts`, `redactEventPayload`, `run-scratch.ts`, `local-service-supervisor.ts`, `environment-run-orchestrator.test.ts`, `heartbeat-retry-scheduling.test.ts`, `billing-classification.ts`, `execution-allowlist.ts`, `handleRunLivenessContinuation`, `dispatch-readiness.ts`, `ensurePersistedExecutionWorkspaceAvailable`, `execution-workspace-policy.ts`, `issue-checkout-status.ts`?**
  _High betweenness centrality (0.005) - this node is a cross-community bridge._
- **Are the 43 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 43 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `captureUnrecognizedInteractionPayloadKeys()`) actually correct?**
  _`issueRoutes()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _3974 weakly-connected nodes found - possible documentation gaps or missing edges._
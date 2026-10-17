# Graph Report - src  (2026-10-14)

## Corpus Check
- 1266 files · ~3,329,870 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 16101 nodes · 40335 edges · 532 communities (464 shown, 68 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 972 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2a919b83`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- embedded-postgres.ts
- costs-service.test.ts
- app.ts
- issue-create-deduplication-routes.test.ts
- routes/projects.ts
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
- parseObject
- services/tool-gateway.ts
- services/tool-access.ts
- routes/access.ts
- executeRun
- agents-service-secret-bindings.test.ts
- recovery-stale-issue-lock-sweep.test.ts
- productivity-review.ts
- services/teams-catalog.ts
- plugins.ts
- environment-config.ts
- evidence-gate.ts
- middleware/auth.ts
- services/cloud-upstreams.ts
- services/secrets.ts
- registry.ts
- tool-access-policy.ts
- recovery/index.ts
- services/attention.ts
- cases.ts
- logger
- issueRoutes
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
- environment-runtime.ts
- penstock-availability-gate.ts
- authorization.ts
- companySkillService
- execution-workspace-cleanup.ts
- tool-gateway.test.ts
- heartbeatService
- issue-agent-mutation-ownership-routes.test.ts
- redaction.ts
- adapters.ts
- conflict
- services/execution-workspaces.ts
- services/issue-tree-control.ts
- better-auth.ts
- sandbox-provider-runtime.ts
- storage/types.ts
- issue-attachment-routes.test.ts
- plugin-job-scheduler.ts
- plugin-database.ts
- local-service-supervisor.ts
- services/projects.ts
- org-chart-svg.ts
- environment-run-orchestrator.ts
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
- kkroo-bundled-plugins.ts
- unprocessable
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- toolAccessService
- config.ts
- run-liveness-continuations.ts
- recoveryService
- agent-instructions.ts
- heartbeat-hintless-transient-upstream.test.ts
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- parseIssueExecutionState
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe-k8s.test.ts
- productivityReviewService
- pluginCapabilityValidator
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
- listBlockedInboxIssues
- ui-branding.ts
- agent-cross-tenant-authz-routes.test.ts
- agent-permissions-routes.test.ts
- heartbeat-workspace-branch-containment.test.ts
- file-resources.ts
- company-artifacts.ts
- execution-workspace-policy.ts
- plugin-config-masking.ts
- tool-oauth-legacy-backfill.ts
- api-compression.ts
- index.ts
- live-events-ws.ts
- github-review-gate-authority.ts
- source-trust.ts
- issue-continuation-summary.ts
- recovery/service.ts
- github-status-delivery-outbox.ts
- opencode-k8s-seed-transport.test.ts
- successful-run-handoff.ts
- server-info.ts
- low-trust-red-team-routes.test.ts
- environmentService
- issue-pull-requests.ts
- issues-service.test.ts
- heartbeat-wake-dispatch-retry.test.ts
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
- secretService
- companies-route-cross-company-authz.test.ts
- version.ts
- human-gated-ageing.ts
- environmentCustomImageTerminalConnectionRegistry
- worker-tier-proxy.ts
- logger.ts
- company-skills-routes.test.ts
- pr-comment-review-gate.ts
- services/instance-settings.ts
- recovery-observability.ts
- agentRoutes
- db-retry.ts
- scrape-metrics-collector.ts
- authorizationService
- human-gated-ageing-digest.ts
- adapter-routes-authz.test.ts
- ac-policy-assignee-routing.ts
- company-portability-routes.test.ts
- environment-capabilities-k8s.test.ts
- environment-custom-image-routes.test.ts
- redactCurrentUserText
- built-in-agents.test.ts
- issue-visibility.ts
- plugin-dev-watcher.ts
- createToolRuntimeSupervisor
- git-checkout-identity.ts
- FakeRuntime
- human-gated-gate-revalidation.ts
- heartbeat-workspace-finalize-branch.test.ts
- issue-comment-cancel-routes.test.ts
- cursor-models.ts
- health.ts
- bootstrap-claim-routes.test.ts
- work-timeline.ts
- agent-invokability.ts
- plugin-environment-driver.ts
- issue-recovery-actions.ts
- aws-secrets-manager-provider.ts
- issue-workspace-command-authz.test.ts
- heartbeat-pr-review-gate-replay.test.ts
- gbrain-client-factory.test.ts
- heartbeat-stop-metadata.ts
- remote-http-endpoint-guard.ts
- run-scratch.ts
- pr-review-duplicate-issue-guard.ts
- adapter-model-refresh-routes.test.ts
- agent-instructions-routes.test.ts
- issue-feedback-routes.test.ts
- routes/dashboard.ts
- issue-recovery-actions.test.ts
- metrics-ingest.ts
- adapter-registry-bootstrap.ts
- builtInAgentService
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite.ts
- pipelineService
- PluginWorkerManager
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- dev-runner-worktree.ts
- dev-server-status.ts
- openapi-routes.test.ts
- body
- execution-allowlist.ts
- pluginManagedRoutineService
- extractWakeCommentIds
- github-write-egress-scrub.test.ts
- transitionCaseInTransaction
- visibleIssueCondition
- isolation-workspace-reaper.test.ts
- ac-policy-sweep.ts
- environment-custom-image-terminal-sessions.ts
- feedback-redaction.ts
- plugin-managed-agents.ts
- plugin-managed-skills.ts
- execution-workspace-per-run-isolation.test.ts
- approval-routes-idempotency.test.ts
- approval-withdraw-routes.test.ts
- company-portability.test.ts
- docker-opencode-runtime-pin.test.ts
- done-gate-durable-artifact.test.ts
- environment-selection-route-guards.test.ts
- issue-thread-interaction-routes.test.ts
- routines-routes.test.ts
- approval-gate-reconciler.ts
- stranded-blocked-issue-reconciler.ts
- buildOpenApiDocument
- workspace-command-authz.ts
- runtime-api.ts
- pluginRegistryService
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- isPlainRecord
- terminal-gate-reconciler.ts
- reconcileStrandedRecoveryWakeBackstopImpl
- workspace-operation-log-store.ts
- agent-test-environment-routes.test.ts
- document-annotation-routes.test.ts
- external-object-routes.test.ts
- issue-activity-events-routes.test.ts
- renderYamlBlock
- issue-telemetry-routes.test.ts
- project-goal-telemetry-routes.test.ts
- routine-document-annotation-routes.test.ts
- summary-slot-routes.test.ts
- ccrotate-state-hook.ts
- exportBundle
- plugin-secrets-handler.ts
- workspace-response-withholding-guard.test.ts
- issue-monitor-convergence-guard.test.ts
- branch-run-claims.ts
- http-metrics-per-route.test.ts
- dev-runner-snapshot.test.ts
- company-branding-route.test.ts
- heartbeat-accepted-plan-workspace-refresh.test.ts
- issue-approval-link-authorization.ts
- invite-accept-existing-member.test.ts
- issue-closed-workspace-routes.test.ts
- middleware/index.ts
- model-profile-hint.ts
- recovery-stranded-attendance-batch.test.ts
- issue-repo-binding-guard.ts
- managed-checkout-push-guard.ts
- agent-auth-jwt.ts
- workspace-scan.ts
- backfill-agent-bundle.ts
- agent-run-health.ts
- authorization-service.test.ts
- summarySlotService
- issue-comment-effects.ts
- managed-checkout-partial-clone.ts
- importBundle
- approval-enforcement-reconciler.ts
- createPluginJobScheduler
- heartbeat-timer-suppression-park-bypass.test.ts
- run-secret-redaction.ts
- agent-hires-instructions-materialize.test.ts
- zoned-cron.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- company-skills-catalog-service.test.ts
- issue-update-comment-wakeup-routes.test.ts
- node:http
- instrumentation.ts
- http-log-policy.ts
- redact-sensitive.ts
- issue-blocker-diagnostics-routes.test.ts
- strand-comment-provider-capacity.test.ts
- heartbeat-retry-scheduling.test.ts
- fd-class-metrics.ts
- issue-subtree-diagnostics-routes.test.ts
- issue-wake-diagnostics-routes.test.ts
- heartbeat-run-summary.ts
- zoned-cron-equivalence.test.ts
- live-events.ts
- plugin-orchestration-apis.test.ts
- process-loss-classification.ts
- openrouter/execute.ts
- evidence-truth.ts
- config
- pr-review-state-reconciler.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- pen3142-live-event-transcript-scope.test.ts
- utils.ts
- agent-shell-guard.ts
- native-memory-metrics.test.ts
- services/index.ts
- zodToOpenApiSchema
- heartbeat-provider-capacity-horizon.test.ts
- company-export-readme.ts
- company-search-service.test.ts
- collectEvidence
- lifecycle-hook-command-audit.ts
- linear-auth.ts
- boardAuthService
- environmentRoutes
- pen3142-run-transcript-scope.test.ts
- input
- project-env-response-boundary.test.ts
- setup-supertest.ts
- routes/decision-training.ts
- .call
- queued-run-age-metrics.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- OAuthMintBearer
- plugin-activation-boot-retry.test.ts
- normalizeIssueExecutionPolicy
- routines-service.test.ts
- issue-list-assignee-filter-routes.test.ts
- heartbeat-issue-liveness-escalation.test.ts
- approval-budget-assertion-required.test.ts
- asNumber
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- local-encrypted-provider.ts
- buildPortableProjectWorkspaces
- pipeline-case-outputs.ts
- heartbeat-zombie-guard.test.ts
- issue-liveness.test.ts
- issue-monitor-scheduler.test.ts
- pull-request-work-products.ts
- linear-webhook.test.ts
- pr-review-request-ageing-producer.ts
- dev-watch-ignore.ts
- pipelines-service.test.ts
- approval-create-issue-link-authorization.test.ts
- applyDocumentFixups
- user-profiles.ts
- approval-link-route-equivalence.test.ts
- issue-checkout-status.ts
- done-gate.ts
- heartbeat-stale-queue-invalidation.test.ts
- routine-scheduler-heartbeat.ts
- issue-goal-fallback.ts
- agent-profile-change-gate-mixing.test.ts
- approval-agent-config-authz-routes.test.ts
- github-fetch.ts
- board-chat.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- company-issue-identity-guard.test.ts
- activityService
- run-log-terminal-result.ts
- agent-budget-mirror-write.test.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- heartbeat-hard-stale-subprocess-liveness.test.ts
- plugin-webhook-not-ready-retryable.test.ts
- scheduler-lease.ts
- readNonEmptyString
- sweep-wake-preflight.test.ts
- agent-hire-source-issue-authorization.test.ts
- approval-revision-exit.test.ts
- issue-create-pr-review-duplicate-routes.test.ts
- company-search-rate-limit.ts
- createToolGatewayService
- HEARTBEAT.md -- CEO Heartbeat Checklist
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- extractEnforcementAssertions
- issues-open-assignment-census.test.ts
- plugin-status-metrics.ts
- readPenstockCapacity
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- github-review-posted-metric.test.ts
- issue-watchdogs-routes.test.ts
- assertAssignableAgent
- approval-enforcement-reconciler.test.ts
- company-issue-identity.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- documents.ts
- matchesTaskKey
- SandboxProvider
- sse-registry.ts
- environment-instance-routes.test.ts
- plugin-metric-exposition.test.ts
- Ally — Consolidated PR Review
- issue-runtime-service-command-masking.test.ts
- deriveSkillExportDirCandidates
- database-backup-health.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- agent-budgets-route-config-revision.test.ts
- secrets/types.ts
- blocked-inbox-count-list-parity.test.ts
- cases-routes.test.ts
- plugin-manifest-validator.ts
- plugin-state-store.ts
- scrape-metrics-routine-fire-gap-work.test.ts
- execution-lock-orphan-cleanup.test.ts
- trust-proxy.ts
- privateHostnameGuard
- pr-review-issue-scope-locks.test.ts
- closeOpenSuppressedReviews
- heartbeat-reviewer-evidence-live-head.test.ts
- permissions-upgrade-boundary-routes.test.ts
- issue-stale-execution-lock-routes.test.ts
- startup-filesystem-io.test.ts
- chain
- event-loop-stall-log.ts
- issue-monitor-convergence-message.test.ts
- Ally — Consolidated PR Review
- human-gated-gate-revalidation-backfill.test.ts
- issue-stable-enumeration-routes.test.ts
- ceo/AGENTS.md
- EnvironmentRuntimeDriver
- penstock-availability-gate.test.ts
- plugin-host-service-cleanup.ts
- ensureServerWorkspaceLinksCurrent
- Ally — Consolidated PR Review
- heartbeat-worktree-suppression.test.ts
- pod-failure-label-corpus.test.ts
- linear-tunnel.ts
- inherited-workspace-reuse-failure-summary.test.ts
- issue-assignment-wakeup.ts
- agent-auth-middleware.test.ts
- plugin-worker-invocation-scope.cjs
- issue-checkout-routine-lock-conflict.test.ts
- issue-release-lock-only-degrade.test.ts
- pen3139-transcript-credential-shapes.test.ts
- startup-dispatch-isolation.test.ts
- workspace-operation-secret-scrub.test.ts
- reflection-coach/AGENTS.md
- Recent agent reflection sweep
- summarizer/AGENTS.md
- Refresh stale summary slots
- validateTerminalUpgrade
- healthz-probe-route.test.ts
- environment-runtime-driver-contract.test.ts
- heartbeat-result-json-write-path-audit.test.ts
- issue-thread-interactions-service.test.ts
- metrics-route-no-db.test.ts
- reviewer-wake-outcome-log-fields.test.ts
- SOUL.md -- CEO Persona
- Wake Pre-flight (do this FIRST when woken)
- issues-checkout-wakeup.ts
- parseStatusFilter
- redactSecretValuesFromText
- createPluginJobCoordinator
- authz-existence-oracle-guard.test.ts
- plugin-worker-delayed.cjs
- plugin-worker-terminated.cjs
- postgres-pool-budget.test.ts
- recovery-candidate-phase-timer-coverage.test.ts
- default/AGENTS.md
- recovery-pause-hold-guard-call-shape.test.ts
- express.d.ts
- TOOLS.md

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 586 edges
2. `unprocessable()` - 381 edges
3. `issueRoutes()` - 376 edges
4. `notFound()` - 337 edges
5. `issueService()` - 264 edges
6. `logActivity()` - 258 edges
7. `recoveryService()` - 243 edges
8. `executeRun()` - 241 edges
9. `parseObject` - 193 edges
10. `agentRoutes()` - 186 edges

## Surprising Connections (you probably didn't know these)
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes-authz.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/adapter-routes.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-auth-middleware.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-budget-mirror-write.test.ts → middleware/error-handler.ts
- `createApp()` --indirect_call--> `errorHandler()`  [INFERRED]
  __tests__/agent-budgets-route-config-revision.test.ts → middleware/error-handler.ts

## Import Cycles
- 2-file cycle: `services/issues.ts -> services/task-watchdogs.ts -> services/issues.ts`

## Communities (532 total, 68 thin omitted)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (272): appendWithByteCap, createServerGbrainClient(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS, activeRunExecutions, ADAPTER_RESOLUTION_RETRY_DELAY_MS, adapterSupportsManagedMcpConfig() (+264 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (131): ParsedExecutionWorkspaceMode, getDefaultCompanyGoal(), GoalReader, ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS, AcceptedPlanDecompositionInput, AcceptedPlanDocumentInteraction, ALL_ISSUE_STATUSES, attentionBase() (+123 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.04
Nodes (57): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), buildLegacyRoutineTriggerFromRecurrence(), collectSelectedExportSlugs(), COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS (+49 more)

### Community 3 - "embedded-postgres.ts"
Cohesion: 0.02
Nodes (62): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), normalizeResponsibleUserDenialCode() (+54 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.14
Nodes (14): createApp(), createAppWithActor(), loadCostParsers(), makeDb(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyService (+6 more)

### Community 5 - "app.ts"
Cohesion: 0.03
Nodes (163): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), PRECOMPRESSED_STATIC_EXTENSIONS, resolveViteHmrHost(), resolveViteHmrPort() (+155 more)

### Community 6 - "issue-create-deduplication-routes.test.ts"
Cohesion: 0.15
Nodes (10): findCreateIssueDuplicateCandidates(), ISSUE_CREATE_DUPLICATE_CANDIDATE_LATENCY_BUDGET_MS, ISSUE_CREATE_DUPLICATE_CANDIDATE_ROW_CAP, ISSUE_CREATE_DUPLICATE_CANDIDATE_SCAN_CAP, ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS, createApp(), FilingFixture, monitorFilings (+2 more)

### Community 7 - "routes/projects.ts"
Cohesion: 0.04
Nodes (90): appendWithCap, maskWorkspaceRuntimeForRead(), maskWorkspaceRuntimeTextForRead(), REDACTED_EVENT_VALUE, withholdWorkspaceOperationCapturedOutput(), executionWorkspaceRoutes(), assertRuntimeManageAllowed(), handleExecutionWorkspaceRuntimeCommand() (+82 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.03
Nodes (87): skillImportPolicyResource(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillSourceAllowed(), assertNoSymlinksInLocalTree(), assertVersionMatchesSkill(), auditInstalledSkillBytes(), buildInventoryContentHash(), BUILT_IN_SKILL_TEST_RUN_TEMPLATE_BODY (+79 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.05
Nodes (65): addFormVariablesForStage(), assertActorProvenance(), assertCaseKey(), assertValidParentCase(), buildCaseDeepLink(), buildPipelineAutomationIssueTitlePrefix(), buildPipelineCaseContextMarkdown(), buildPipelineCaseContextPack() (+57 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (144): IssueApprovalLinkAuthorizationIssue, ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema, blockerDiagnosticLabel() (+136 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.04
Nodes (51): reconcileApprovedBuiltInAgent(), assertAdapterAllowed(), assertKnownBuiltInAgentModel(), BUILT_IN_AGENT_DEFAULT_GRANTS, BUILT_INS_DIR, BuiltInAgentBundleDefinition, BuiltInAgentDefinition, builtInAgentNotConfiguredError() (+43 more)

### Community 12 - "issue-dependency-wakeups-routes.test.ts"
Cohesion: 0.14
Nodes (12): findExistingIssueBlockersResolvedWake(), IDEMPOTENT_DEPENDENCY_WAKE_STATUSES, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, createApp(), mockDb, mockFindExistingIssueBlockersResolvedWake, mockIssueService, mockListBlockedDependentIssueIds (+4 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (152): asString, buildAgentGitIdentityEnv(), applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), assertDirtyQuarantineRuntimeServicesStopped(), branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), buildWorkspaceCommandEnv() (+144 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.02
Nodes (113): BUNDLED_PLUGIN_PACKAGES, isIsolatedSdkPluginPackage(), ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH (+105 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (191): redactSensitiveText(), acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody() (+183 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (89): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertPipelineAccess(), assertPipelineCompanyAccess(), assertPipelineWriteAccess() (+81 more)

### Community 17 - "cleanup-heartbeat-test-state.ts"
Cohesion: 0.04
Nodes (28): runningProcesses, _settleDetachedAgentStartLockWorkForTesting(), DEP_BLOCKED_MAX_RETRY_ATTEMPTS, DEP_BLOCKED_RETRY_REASON, STARVATION_ABSOLUTE_ESCALATION_MS, STARVATION_FULL_ESCALATION_MS, mockAdapterExecute, mockAdapterExecute (+20 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.05
Nodes (58): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+50 more)

### Community 19 - "parseObject"
Cohesion: 0.03
Nodes (132): parseObject, publishPluginDomainEvent(), shouldReopenTerminalIssueForDeferredWake(), incrementDepBlockedMetric(), allowsIssueInteractionWake(), boundHeartbeatRunEventPayloadForStorage(), carryRetryContextSnapshot(), computeK8sIsolationRetryDelayMs() (+124 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (45): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview() (+37 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.03
Nodes (133): tooManyRequests(), claimFirstInstanceAdmin(), FirstAdminClaimResult, FirstAdminTransaction, accessRoutes(), approveHumanJoinRequestFromInvite(), assertInstanceAdmin(), createCompanyInviteForCompany() (+125 more)

### Community 23 - "executeRun"
Cohesion: 0.02
Nodes (208): getServerAdapter(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), resolveStaleDependabotAlertWakeIssue(), createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), resolveEffectiveWorkspaceStrategyType(), describeGitFailure() (+200 more)

### Community 24 - "agents-service-secret-bindings.test.ts"
Cohesion: 0.25
Nodes (3): mockEnsureBuiltInAgent, mockNotifyHireApproved, pendingApproval()

### Community 25 - "recovery-stale-issue-lock-sweep.test.ts"
Cohesion: 0.10
Nodes (6): AGENT_POD_BUSY_MAX_STALE_MS, NON_LIVE_EXECUTION_SILENCE_MS, LOCKLESS_DEFERRED_WAKE_MIN_AGE_MS, STALE_RUNNING_ISSUE_LOCK_MS, mockProbeAgentPodActivity, mockTelemetryClient

### Community 26 - "productivity-review.ts"
Cohesion: 0.04
Nodes (74): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, DbOrTx, DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS, DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS, DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS (+66 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (60): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+52 more)

### Community 28 - "plugins.ts"
Cohesion: 0.03
Nodes (76): AvailableBundledPlugin, bundledPluginMetadata(), __dirname, discoverBundledPlugins(), DiscoveredBundledPlugin, EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES, fileExists(), findPackageJsonFiles() (+68 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.09
Nodes (37): createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe(), ParsedEnvironmentConfig (+29 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (55): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+47 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.12
Nodes (25): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+17 more)

### Community 32 - "services/cloud-upstreams.ts"
Cohesion: 0.05
Nodes (77): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), buildWarnings() (+69 more)

### Community 33 - "services/secrets.ts"
Cohesion: 0.10
Nodes (22): isSecretProviderClientError(), CanonicalEnvBinding, COMING_SOON_SECRET_PROVIDERS, defaultProviderConfigStatus(), deriveSecretNameFromExternalRef(), FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS, MissingRuntimeBinding, missingRuntimeConsumerType() (+14 more)

### Community 34 - "registry.ts"
Cohesion: 0.06
Nodes (42): BUILTIN_ADAPTER_TYPES, acpxLocalAdapter, adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks, claudeLocalAdapter, codexLocalAdapter (+34 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (72): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+64 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.05
Nodes (86): addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding(), hasAnyBlockerEdge(), hasExplicitWaitingPath() (+78 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.07
Nodes (50): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+42 more)

### Community 38 - "cases.ts"
Cohesion: 0.04
Nodes (65): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isAllowedContentType(), isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES (+57 more)

### Community 39 - "logger"
Cohesion: 0.06
Nodes (16): logger, PluginRouteToolDeps, prunePluginLogs(), startPluginLogRetention(), createPluginToolDispatcher(), handlePluginEnabled(), registerFromDb(), PluginToolDispatcher (+8 more)

### Community 40 - "issueRoutes"
Cohesion: 0.02
Nodes (123): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), authenticatedActorResponsibleUserId(), AutoApprovalIssueMissingError, buildAttachmentContentPath(), buildCreateIssueActivityStatusDetails(), buildRequestItemVerdictsWakeIdempotencyKey(), compactIssueListEtag() (+115 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.07
Nodes (61): applyCustomImageTemplateToSandboxConfig(), classifyEnvironmentCustomImageConfigChange(), defaultEnvironmentCustomImageRuntimeConfigBinding(), ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS, ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS, EnvironmentCustomImageConfigChangeKind, EnvironmentCustomImageRuntimeConfigBinding (+53 more)

### Community 42 - "feedback.ts"
Cohesion: 0.10
Nodes (37): asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildIssueContext(), buildIssuePath(), buildPayloadArtifacts() (+29 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (198): createBetterAuthHandler(), normalizeAuthLocationHeader(), counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), AGENT_ERROR_REASON_NONE (+190 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.07
Nodes (64): AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments(), directoryResource() (+56 more)

### Community 45 - "openapi.ts"
Cohesion: 0.05
Nodes (42): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+34 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.09
Nodes (37): collectSkillFileBytes(), visit(), listMaterializedFiles(), walk(), walkLocalFiles(), resolveRawGitHubUrl(), normalizePortablePath(), CatalogManifestFile (+29 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.05
Nodes (97): __test_stackedChildDirective, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyWorkflowRunNotFound(), encodeGitRefPath() (+89 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (38): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), buildRoutineRevisionSnapshot(), canonicalSnapshot(), collectProvidedRoutineVariables() (+30 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (15): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+7 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 51 - "environment-runtime.ts"
Cohesion: 0.07
Nodes (50): stripSandboxProviderEnvelope(), buildEnvironmentSecretMetadataForLeaseFingerprint(), buildReusableSandboxLeaseFingerprint(), buildReusableSandboxLeaseScope(), createK8sEnvironmentDriver(), createLocalEnvironmentDriver(), resolvePluginDriver(), resolvePluginDriverForRelease() (+42 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.11
Nodes (19): PenstockProbeOutcomeLabel, PenstockProbePathLabel, buildCapacityUrl(), buildMessagesUrl(), CacheEntry, isPenstockBaseUrl(), PenstockAvailabilityGateAllowResult, PenstockAvailabilityGateDenyResult (+11 more)

### Community 53 - "authorization.ts"
Cohesion: 0.08
Nodes (36): buildKeyedCommentEffectIntents(), persistedCommentActor(), AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction (+28 more)

### Community 54 - "companySkillService"
Cohesion: 0.05
Nodes (133): assertImportedSkillKeyAllowed(), asString(), buildHarnessIssueDescription(), buildMissingLocalSourceMarker(), buildMissingRuntimeSourceDetail(), buildSkillRuntimeName(), bundledFolderLabel(), classifyInventoryKind() (+125 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.06
Nodes (46): classifyRemovalProof(), decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup() (+38 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.09
Nodes (6): awaitRateLimitWindow(), createApprovedToolAction(), createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "heartbeatService"
Cohesion: 0.02
Nodes (219): countRunsOccupyingSlots(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds(), markAgentStartLockPhase(), rethrowIfAgentStartLockAborted(), runDetachedFromAgentStartLock(), incrementBlockerResolvedWakeMetric(), bindExternalRuntimeReservationIsolation() (+211 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.04
Nodes (96): containAgentConfig(), RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, BENIGN_HEADER_NAMES, classifyKeyTier(), CLI_SECRET_FLAG_RE, ENV_DUMP_SECRET_ASSIGNMENT_RE, ESCAPED_JSON_SECRET_FIELD_TEXT_RE (+88 more)

### Community 60 - "adapters.ts"
Cohesion: 0.12
Nodes (41): buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter(), resolvePackageDir() (+33 more)

### Community 61 - "conflict"
Cohesion: 0.11
Nodes (45): conflict(), archiveMember(), assertAssignableArchiveTarget(), assertCanRemoveActiveOwner(), updateMember(), updateMemberAndPermissions(), buildFolderViews(), FolderRow (+37 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.06
Nodes (60): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), execFileAsync, ExecutionWorkspaceBranchReconcileActor (+52 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.07
Nodes (48): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+40 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.08
Nodes (36): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+28 more)

### Community 65 - "sandbox-provider-runtime.ts"
Cohesion: 0.10
Nodes (26): findReusableSandboxLeaseId(), AcquireSandboxLeaseInput, acquireSandboxProviderLease(), assertProviderConfig(), buildFakeSandboxProbe(), DestroySandboxLeaseInput, FakeSandboxProvider, findReusableSandboxProviderLeaseId() (+18 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.05
Nodes (40): createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), DurableRunLogStoreOptions, isAtOrPastEnd(), normalizeKeyPrefix() (+32 more)

### Community 67 - "issue-attachment-routes.test.ts"
Cohesion: 0.08
Nodes (25): normalizeIssueAttachmentMaxBytes(), DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody() (+17 more)

### Community 68 - "plugin-job-scheduler.ts"
Cohesion: 0.09
Nodes (16): PluginRouteJobDeps, PluginJobCoordinator, PluginJobCoordinatorOptions, PluginJobScheduler, PluginJobSchedulerOptions, SchedulerDiagnostics, TriggerJobResult, CompleteJobRunInput (+8 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.07
Nodes (27): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), derivePluginDatabaseNamespace(), extractQualifiedRefs(), normaliseSql(), PluginDatabaseClient (+19 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.09
Nodes (55): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+47 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.09
Nodes (39): recordProjectPrimaryWorkspaceFallback(), cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates(), attachGoals() (+31 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (33): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+25 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.08
Nodes (37): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+29 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.05
Nodes (65): assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult(), buildTaskCreationOrder(), buildWithdrawnInteractionResult() (+57 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.05
Nodes (63): RFC-1918, assertBelongsToCompany(), FinanceDateRange, financeService(), rangeConditions(), ADAPTER_OVERRIDE_ALLOWED_KEYS, ALLOWED_PROTOCOLS, BufferedLogEntry (+55 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.12
Nodes (34): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+26 more)

### Community 77 - "badRequest"
Cohesion: 0.05
Nodes (45): badRequest(), assertInstanceAdmin(), parseDocumentKey(), activationEntityTypeBody(), cloudUpstreamRoutes(), optionalString(), stringBody(), stringQuery() (+37 more)

### Community 78 - "agentService"
Cohesion: 0.08
Nodes (55): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, describeAgentStartLockDispatchHealth(), AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed(), assertCompanyShortnameAvailable() (+47 more)

### Community 79 - "company-search.ts"
Cohesion: 0.08
Nodes (54): activeIssueFilters(), artifactResult(), companySearchService(), countAgents(), countArtifacts(), countProjects(), countTotalNonIssue(), enrichIssueSnippets() (+46 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.05
Nodes (65): TASK_WATCHDOG_ORIGIN_KIND, ActorFields, assertWatchdogAgentInvokable(), assertWatchedIssue(), buildStoppedFingerprintComment(), classifyTaskWatchdogSubtree(), isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict() (+57 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.06
Nodes (39): allocateFetchAllowedLoopbackPort(), appendRedirectParam(), asRecord(), assertSmokeOAuthRedirectUri(), escapeHtml(), FETCH_BLOCKED_PORTS, FIXTURE_TOOLS, FixtureTool (+31 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.07
Nodes (38): WorkspaceOperationRecorder, executeProcessForTests, ExecutionWorkspaceInput, GIT_INDEX_LOCK_STALE_MS, isProcessGroupAliveForTests, LockHolderScan, RealizedExecutionWorkspace, setLockHolderScanForTests() (+30 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (41): HEARTBEAT_RUN_FAILED_METRIC, PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, drainInFlightExecutions(), expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts() (+33 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "kkroo-bundled-plugins.ts"
Cohesion: 0.21
Nodes (16): autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin(), installKkrooLocalPlugins() (+8 more)

### Community 87 - "unprocessable"
Cohesion: 0.04
Nodes (68): notFound(), unprocessable(), assertAgentDefaultEnvironmentSelection(), normalizeAgentReference(), assertBuiltInAgentsEnabled(), assertEnabled(), validatePolicyBody(), assertActiveUserMembership() (+60 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.08
Nodes (32): AuthenticatedTerminalContext, clientSafeErrorMessage(), closeClient(), closeUpgradeSocket(), createSsh2EnvironmentCustomImageSshConnector(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, decodeClientMessage(), EnvironmentCustomImageSshConnector (+24 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "toolAccessService"
Cohesion: 0.04
Nodes (129): HttpError, asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor(), readStdioTemplateId() (+121 more)

### Community 91 - "config.ts"
Cohesion: 0.05
Nodes (57): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), readConfigFile(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS (+49 more)

### Community 92 - "run-liveness-continuations.ts"
Cohesion: 0.12
Nodes (15): RECOVERY_REASON_KINDS, ACTIONABLE_LIVENESS_STATES, AgentRow, CONTINUATION_ACTIVE_ISSUE_STATUSES, CONTINUATION_AGENT_STATUSES, DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS, HeartbeatRunRow, IDEMPOTENT_WAKE_STATUSES (+7 more)

### Community 93 - "recoveryService"
Cohesion: 0.04
Nodes (123): redactRunResultJson(), isTerminalIssueStatus(), issueLockOwnerStateMatches(), lockIssueOwnership(), buildIssueBlockersResolvedWakeIdempotencyKey(), applyIssueMonitorPolicyTransition(), isMonitorNextCheckAtLive(), lockIssueParentMutationCompany() (+115 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.14
Nodes (40): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+32 more)

### Community 95 - "heartbeat-hintless-transient-upstream.test.ts"
Cohesion: 0.10
Nodes (23): allocationFaultStatusGate(), BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, didRunSnapshotHitGatewayAllocationFault(), isImmediatePredecessorRepeatGatewayAllocationFault(), isGatewayAllocationFault(), isHintlessTransientUpstreamFault(), isPrReviewRetryContext(), isRepeatedGatewayAllocationFault() (+15 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.15
Nodes (24): prepareHotRestartShutdown(), toHotRestartIntentRun(), asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent (+16 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.09
Nodes (27): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+19 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (18): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+10 more)

### Community 99 - "parseIssueExecutionState"
Cohesion: 0.32
Nodes (11): dispatchClaimedIssueMonitor(), tickDueIssueMonitors(), shouldAutoCheckoutIssueForWake(), suppressedDispatchRearmDelayMs(), buildIssueMonitorClearedPatch(), buildIssueMonitorDispatchRearmPatch(), buildIssueMonitorTriggeredPatch(), derivePersistedMonitorState() (+3 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (26): installActor(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectLimit, mockDbSelectOrderBy (+18 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.09
Nodes (28): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+20 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "productivityReviewService"
Cohesion: 0.06
Nodes (66): buildThresholds(), extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isApprovalGatedSuppression(), isMonitorScheduledSuppression(), isSoftStopTrigger(), isTerminalGateClosableTriggerSet(), isTerminalIssueStatus() (+58 more)

### Community 104 - "pluginCapabilityValidator"
Cohesion: 0.06
Nodes (19): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, CapabilityScopedInvoker, DEFAULT_GLOBALS (+11 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.04
Nodes (71): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart() (+63 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.15
Nodes (22): composeSweepWakeFramePage(), currentMinuteBucket(), detectSweepWakeRace(), getIssueSnapshot(), isCompanyFlagEnabled(), listIssueBlockerIds(), listRecentComments(), maxBlockerCompletedAt() (+14 more)

### Community 107 - "issue-execution-policy-routes.test.ts"
Cohesion: 0.10
Nodes (19): createApp(), issueWithClearedStalledMonitor(), issueWithTriggeredMonitor(), mockAccessService, mockDb, mockDbInsert, mockDbInsertValues, mockDbLeftJoinWhere (+11 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (27): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+19 more)

### Community 109 - "budgetService"
Cohesion: 0.05
Nodes (53): AppliedAssertion, applyApprovalEnforcement(), ApplyApprovalEnforcementResult, ApplyApprovalRefusalCode, refuse(), withRefusalLogged(), AssertionEnforcementState, classifyEnforcementAssertion() (+45 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (22): currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService, mockEnvironmentService (+14 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.11
Nodes (22): AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput, AgentScorecardOptions, AgentScorecardsResult, computeAgentScorecards(), MIN_SAMPLE_DONE (+14 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.13
Nodes (16): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+8 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.09
Nodes (42): ActorLike, actorPrincipal(), applyIssueExecutionStageTransition(), applyMonitorTransition(), AssigneeLike, assigneePrincipal(), blankExecutionState(), buildChangesRequestedState() (+34 more)

### Community 115 - "listBlockedInboxIssues"
Cohesion: 0.08
Nodes (35): activeRunMapForIssues(), activeRunMapKey(), appendBlockerAttentionEdges(), blockedByMapForIssues(), blockedInboxAttentionResponseFields(), blockedInboxResponseDescription(), blockedInboxSearchText(), blockerSampleIdentifier() (+27 more)

### Community 116 - "ui-branding.ts"
Cohesion: 0.09
Nodes (31): readBrandedStaticIndexHtml(), tempDir(), applyUiBranding(), createFaviconDataUrl(), DEFAULT_FAVICON_LINKS, deriveColorFromSeed(), escapeHtmlAttribute(), getWorktreeUiBranding() (+23 more)

### Community 117 - "agent-cross-tenant-authz-routes.test.ts"
Cohesion: 0.09
Nodes (24): assertAuthenticated(), assertBoard(), assertCompanyAccess(), assertInstanceAdmin(), baseAgent, baseKey, createApp(), getAccessibleResource() (+16 more)

### Community 118 - "agent-permissions-routes.test.ts"
Cohesion: 0.08
Nodes (23): baseAgent, createApp(), createDbStub(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService (+15 more)

### Community 119 - "heartbeat-workspace-branch-containment.test.ts"
Cohesion: 0.12
Nodes (22): adapterExecute, asRecord(), BranchContainmentCallSite, createForwardBranchMismatch(), createGitRepo(), Db, drainInFlightExecutions(), execFileAsync (+14 more)

### Community 120 - "file-resources.ts"
Cohesion: 0.14
Nodes (22): activityDetails(), createFileResourceLimiter(), createFileResourceListLimiter(), denialReasonFromError(), FileResourceLimiter, fileResourceRoutes(), logDeniedAttempt(), logListDeniedAttempt() (+14 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.14
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "execution-workspace-policy.ts"
Cohesion: 0.11
Nodes (29): buildExecutionWorkspaceAdapterConfig(), cloneRecord(), defaultIssueExecutionWorkspaceSettingsForProject(), ExecutionWorkspaceEnvironmentResolution, ExecutionWorkspaceEnvironmentSource, executionWorkspaceUsesGitWorktree(), executionWorkspaceUsesPerRunScope(), gateProjectExecutionWorkspacePolicy() (+21 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.10
Nodes (44): RFC-6901, AMBIGUOUS_SCHEMA_NODE, childNodesForIndex(), childNodesForKey(), collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues(), collectStringLeaves(), containsMask() (+36 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.15
Nodes (21): awsSecretsManagerProvider, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind, RAW_OAUTH_TOKEN_KEYS (+13 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "index.ts"
Cohesion: 0.06
Nodes (56): BetterAuthSessionResult, BetterAuthSessionUser, EmbeddedPostgresCtor, EmbeddedPostgresInstance, StartedServer, startServer(), applyMigrationsForLabel(), assertCloudDatabaseContract() (+48 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.11
Nodes (16): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+8 more)

### Community 128 - "github-review-gate-authority.ts"
Cohesion: 0.05
Nodes (56): GithubWebhookConfig, activateGithubReviewGateDelivery(), affectsProtectedBase(), Candidate, claimDueGithubReviewGateDeliveries(), COMMENT_ACTIONS, commentSignals(), deliveryClaimWhere() (+48 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.16
Nodes (18): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+10 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.18
Nodes (17): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates(), extractPreviousNextAction() (+9 more)

### Community 131 - "recovery/service.ts"
Cohesion: 0.02
Nodes (119): DeferredWakeReopenEligibility, LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), WAKE_COMMENT_IDS_KEY, IssueDependencyReadiness, POD_GIT_TRANSPORT_FAILURE (+111 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.10
Nodes (34): githubAppCredentialsConfigured(), githubGetLatestCommitStatusForContext(), appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), DbHandle, deliveryClaimWhere(), DeliveryRow (+26 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "successful-run-handoff.ts"
Cohesion: 0.06
Nodes (49): agentLinkRow(), AgentRow, buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice(), decideSuccessfulRunHandoff(), DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS, FINISH_SUCCESSFUL_RUN_HANDOFF_REASON (+41 more)

### Community 135 - "server-info.ts"
Cohesion: 0.16
Nodes (13): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, createServerInfoSnapshot(), getGitLocalChanges(), GitCommand (+5 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.14
Nodes (7): createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.08
Nodes (34): ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES, cloneRecord(), countFromRows(), EnvironmentLeaseRow, EnvironmentListFilters, EnvironmentRow, environmentService(), hasConstraintName() (+26 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.06
Nodes (50): AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES, matchExclusionRule() (+42 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.06
Nodes (28): ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runOwnsIssueExecutionLock(), runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUS_VALUES, TERMINAL_HEARTBEAT_RUN_STATUSES, deriveIssueCommentRunLogAttribution(), extractExecutiveHoldMarker() (+20 more)

### Community 140 - "heartbeat-wake-dispatch-retry.test.ts"
Cohesion: 0.05
Nodes (39): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+31 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.10
Nodes (34): readObject(), resolveAgentSelfTrustPreset(), readRunIssueId(), assertAgentCanManageRuntimeServicesForWorkspace(), assertLowTrustCanManageRuntimeForActor(), assertLowTrustCanManageRuntimeForIssue(), listReportingSubtreeAgentIds(), readRunIssueId() (+26 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "accessService"
Cohesion: 0.04
Nodes (67): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge() (+59 more)

### Community 145 - "services/resource-memberships.ts"
Cohesion: 0.12
Nodes (14): logMembershipChange(), requireBoardUserId(), resourceMembershipRoutes(), assertBoardSelfMembershipAccess(), BoardActor, evaluatePolicy(), MembershipChangeKind, MembershipUpdateResult (+6 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.17
Nodes (22): decorateHeartbeatRunRuntimeStatus(), recordCurrentHeartbeatRunRuntimeProgress(), isHeartbeatRunRuntimeStatusActive(), recordHeartbeatRunRuntimeProgress(), clearAllHeartbeatRunRuntimeStatuses(), clearHeartbeatRunRuntimeStatus(), cloneStatus(), getHeartbeatRunRuntimeStatus() (+14 more)

### Community 147 - "issue-rewake-throttle.ts"
Cohesion: 0.11
Nodes (22): computeIssueRewakeCooldownMs(), evaluateIssueRewakeThrottle(), isIssueRewakeNewInputActivity(), isIssueRewakeProgressActivity(), ISSUE_COMMENT_ADDED_ACTION, ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS, ISSUE_PROGRESS_ACTIVITY_ACTION_SET (+14 more)

### Community 148 - "synthetic-ssh-probe.ts"
Cohesion: 0.14
Nodes (12): classifyError(), computeMedian(), execFileAsync, extractSshHandshakeMs(), readSshdAuthAttempts(), runProbeOnce(), SyntheticProbeAlert, SyntheticProbeOptions (+4 more)

### Community 149 - "environment-custom-image-terminal-ws.test.ts"
Cohesion: 0.07
Nodes (11): EnvironmentCustomImageSshShell, closeServer(), createSession(), FakeSshShell, flushPromises(), futureDate(), listen(), require (+3 more)

### Community 150 - "issue-efficiency.ts"
Cohesion: 0.17
Nodes (16): AdapterUsage, adapterUsageForIssues(), ApportionedAdapter, apportionIssueAcrossAdapters(), CostSource, coverageForWindow(), CoverageReport, IssueEfficiency (+8 more)

### Community 151 - "issueService"
Cohesion: 0.03
Nodes (82): activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter(), blockedInboxIssueConditions(), buildPreRealizationExecutionWorkspaceSettings() (+74 more)

### Community 152 - "secretService"
Cohesion: 0.08
Nodes (51): getSecretProvider(), asRecord(), assertClass3StaticLeaseAllowed(), assertSelectableProviderConfig(), canonicalizeBinding(), cleanupPreparedProviderWrite(), deleteLocalSecretCreateReservationOrThrow(), isUniqueConstraintViolation() (+43 more)

### Community 153 - "companies-route-cross-company-authz.test.ts"
Cohesion: 0.12
Nodes (16): createApp(), createCompany(), exportPreviewResult(), exportRequest, exportResult(), importResult(), mockAccessService, mockAgentService (+8 more)

### Community 154 - "version.ts"
Cohesion: 0.14
Nodes (17): compactRecord(), DebugLog, GitDescribeCommand, hasGitMetadataBeforeNodeModulesBoundary(), hasPathSegment(), isPackagedInstall(), normalizeErrorField(), PackageJson (+9 more)

### Community 155 - "human-gated-ageing.ts"
Cohesion: 0.10
Nodes (35): AgedHumanGatedIssue, classifyHumanGatedWait(), comparePriority(), DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY, escalateAfterDaysFor(), formatAge(), formatHumanGatedAgeingSections(), formatIssueRef() (+27 more)

### Community 157 - "worker-tier-proxy.ts"
Cohesion: 0.11
Nodes (21): RFC-7230, boardOrgAccessProxyGuard(), createWorkerProxyHandler(), fetchWithStartupRetry(), forwardRequestHeaders(), hasRequestBody(), HOP_BY_HOP_HEADERS, readPositiveIntegerEnv() (+13 more)

### Community 158 - "logger.ts"
Cohesion: 0.04
Nodes (71): httpLogger, logDir, logFile, sharedOpts, AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext (+63 more)

### Community 159 - "company-skills-routes.test.ts"
Cohesion: 0.08
Nodes (25): AGENT_PROFILE_CHANGE_CONSENT_FIELDS, changeConsentGateService(), ConsumedRequestConfirmationResult, expandTargetKeysForLegacyCompatibility(), legacyTargetKeysFor(), markRequestConfirmationResultConsumed(), payloadHasDisplayedDiff(), readNonEmptyString() (+17 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (121): classifyPrReviewComment(), isActionablePrReviewComment(), isReviewShapedPrComment(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead() (+113 more)

### Community 161 - "services/instance-settings.ts"
Cohesion: 0.17
Nodes (19): applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema, InstanceSettingsServiceOptions, isTruthyRuntimeEnvValue(), normalizeExperimentalSettings(), normalizeGeneralSettings() (+11 more)

### Community 162 - "recovery-observability.ts"
Cohesion: 0.08
Nodes (26): RESOLVED_ASSIGNEE_AGENT_ID_EVIDENCE_KEY, RESOLVED_ISSUE_STATUS_EVIDENCE_KEY, ACTIVE_STATUSES, classifyRecoveryHandoff(), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT, evaluateRecoveryRateAlert(), HandoffClass, MAX_WINDOW_WEEKS (+18 more)

### Community 163 - "agentRoutes"
Cohesion: 0.02
Nodes (135): findServerAdapter(), asRecord(), containAgentMetadata(), containsRedactedAdapterValue(), isRedactedEnvBinding(), keepSanitizedAgentMetadata(), OMIT_REDACTED_ADAPTER_VALUE, redactAgentSecrets() (+127 more)

### Community 164 - "db-retry.ts"
Cohesion: 0.19
Nodes (12): compactErrorText(), describeDbError(), findPgError(), isDbError(), isPostgresSqlState(), isTransientDbError(), PgErrorFields, POSTGRES_SQLSTATE_CLASSES (+4 more)

### Community 165 - "scrape-metrics-collector.ts"
Cohesion: 0.05
Nodes (38): BOARD_DECISION_STATUSES, refreshApprovalQueueMetrics(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, APPROVAL_OLDEST_PENDING_AGE_METRIC, APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC (+30 more)

### Community 166 - "authorizationService"
Cohesion: 0.09
Nodes (54): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentHasRecoveryHandoffGrantOnIssue() (+46 more)

### Community 167 - "human-gated-ageing-digest.ts"
Cohesion: 0.07
Nodes (43): db, MAX_PRS, token, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk(), collectDigest() (+35 more)

### Community 168 - "adapter-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): setOverridePaused(), createAdapter(), createApp(), installedRecord(), instanceAdmin, mocks, requestApp(), resetInstalledExternalAdapterState() (+6 more)

### Community 169 - "ac-policy-assignee-routing.ts"
Cohesion: 0.14
Nodes (15): AcPolicyAgentTargetReason, AcPolicyFilingTarget, AcPolicyFilingTargetInput, AcPolicyResolvedOwner, AcPolicySkippedAgent, AcPolicySweepAgent, AcPolicyUnroutableReason, AcPolicyUserTargetReason (+7 more)

### Community 170 - "company-portability-routes.test.ts"
Cohesion: 0.11
Nodes (13): cloudHeaders, createApp(), exportRequest, importRequest, mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService (+5 more)

### Community 171 - "environment-capabilities-k8s.test.ts"
Cohesion: 0.11
Nodes (17): createApp(), currentActor, mockAccessService, mockAgentService, mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService (+9 more)

### Community 172 - "environment-custom-image-routes.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+2 more)

### Community 173 - "redactCurrentUserText"
Cohesion: 0.14
Nodes (17): CURRENT_USER_REDACTION_TOKEN, CurrentUserCandidates, CurrentUserRedactionOptions, defaultHomeDirs(), defaultUserNames(), escapeRegExp(), getDefaultCurrentUserCandidates(), isPlainObject() (+9 more)

### Community 174 - "built-in-agents.test.ts"
Cohesion: 0.12
Nodes (18): BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), withBuiltInAgentMarker(), getBuiltInAgentDefinition(), listBuiltInAgentDefinitions() (+10 more)

### Community 175 - "issue-visibility.ts"
Cohesion: 0.17
Nodes (14): companySearchExtractService(), contentMatch(), escapeLikePattern(), escapeRegexPattern(), excerpt(), extractMatches(), ExtractSource, literalOccurrences() (+6 more)

### Community 176 - "plugin-dev-watcher.ts"
Cohesion: 0.11
Nodes (21): createPluginDevWatcher(), close(), handlePluginDisabled(), handlePluginEnabled(), handlePluginLoaded(), handlePluginUnloaded(), unwatchPlugin(), watchLocalPluginById() (+13 more)

### Community 177 - "createToolRuntimeSupervisor"
Cohesion: 0.14
Nodes (26): ACTIVE_SLOT_STATUSES, asRecord(), createToolRuntimeSupervisor(), activeRows(), assertCapacity(), assertLocalStdioAvailable(), assertRestartAllowed(), ensureRunningSlot() (+18 more)

### Community 178 - "git-checkout-identity.ts"
Cohesion: 0.06
Nodes (41): AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), CommitAuthorRef, CommitSkipReason, ForeignCommit, ForeignCommitSelection, normalizeEmail(), NotifiableAgentRef (+33 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (47): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+39 more)

### Community 181 - "heartbeat-workspace-finalize-branch.test.ts"
Cohesion: 0.14
Nodes (8): adapterExecute, createGitRepo(), Db, drainInFlightExecutions(), execFileAsync, Heartbeat, runGit(), seedRunTarget()

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.16
Nodes (21): dedupeModels(), fetchOpenAiModels(), fingerprint(), listCodexModels(), loadCodexModels(), mergedWithFallback(), refreshCodexModels(), resetCodexModelsCacheForTests() (+13 more)

### Community 184 - "health.ts"
Cohesion: 0.18
Nodes (13): toDevServerHealthStatus(), hasDevServerStatusToken(), healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), getServerInfoSnapshot() (+5 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.13
Nodes (25): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+17 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.14
Nodes (17): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, blocked(), CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokability() (+9 more)

### Community 188 - "plugin-environment-driver.ts"
Cohesion: 0.32
Nodes (15): createPluginEnvironmentDriver(), cancelPluginEnvironmentInteractiveSetup(), capturePluginEnvironmentTemplate(), deletePluginEnvironmentTemplate(), destroyPluginEnvironmentLease(), executePluginEnvironmentCommand(), getPluginEnvironmentInteractiveSetup(), pluginDriverProviderKey() (+7 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.11
Nodes (30): ACTIVE_RECOVERY_ACTION_STATUSES, DbOrTransaction, isRecord(), IssueRecoveryActionRow, issueRecoveryActionService(), escalateExpiredWakeHorizons(), getActiveForIssue(), listActiveForIssues() (+22 more)

### Community 190 - "aws-secrets-manager-provider.ts"
Cohesion: 0.08
Nodes (45): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), AwsSecretsManagerConfig, AwsSecretsManagerListSecretEntry (+37 more)

### Community 191 - "issue-workspace-command-authz.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockExecutionWorkspaceService (+6 more)

### Community 192 - "heartbeat-pr-review-gate-replay.test.ts"
Cohesion: 0.22
Nodes (11): allyReview(), bodyAttestsToHead(), buildApp(), deliverFreshHeadSynchronize(), extractReviewedHeadSha(), FixtureReview, latestAllyReview(), NEW_HEAD_REVIEW (+3 more)

### Community 193 - "gbrain-client-factory.test.ts"
Cohesion: 0.19
Nodes (6): BearerSource, NullBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 194 - "heartbeat-stop-metadata.ts"
Cohesion: 0.24
Nodes (13): isMaxTurnExhaustionRun(), buildHeartbeatRunStopMetadata(), defaultTimeoutSecForAdapter(), hasOwn(), HeartbeatRunOutcome, HeartbeatRunStopMetadata, HeartbeatRunStopReason, HeartbeatRunTimeoutPolicy (+5 more)

### Community 195 - "remote-http-endpoint-guard.ts"
Cohesion: 0.20
Nodes (11): assertPublicRemoteHttpEndpoint(), isPrivateOrReservedIp(), isPrivateOrReservedIpv4(), isPrivateOrReservedIpv6(), LookupResult, lookupWithTimeout(), parseIpv4Address(), parseMappedIpv4Hex() (+3 more)

### Community 196 - "run-scratch.ts"
Cohesion: 0.19
Nodes (13): buildHeartbeatRunScratchEnv(), cleanupHeartbeatRunScratch(), HEARTBEAT_RUN_SCRATCH_MARKER, HeartbeatRunScratch, HeartbeatRunScratchCleanupResult, HeartbeatRunScratchEnvResult, HeartbeatRunScratchMetadata, isPathInside() (+5 more)

### Community 197 - "pr-review-duplicate-issue-guard.ts"
Cohesion: 0.18
Nodes (21): readGithubPrReviewerAgentIds(), assertNotDuplicatePrReviewIssue(), buildPrReviewTaskKey(), candidatePullRequestRefs(), configuredPrReviewerAgentIds(), declaresNotAReviewRequest(), DuplicatePrReviewIssueGuardDb, DuplicatePrReviewIssueOptions (+13 more)

### Community 198 - "adapter-model-refresh-routes.test.ts"
Cohesion: 0.11
Nodes (14): createApp(), mockAccessService, mockAgentInstructionsService, mockApprovalService, mockBudgetService, mockCompanySkillService, mockEnvironmentService, mockHeartbeatService (+6 more)

### Community 199 - "agent-instructions-routes.test.ts"
Cohesion: 0.12
Nodes (13): createApp(), makeAgent(), makeReflectionCoachAgent(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockBuiltInAgentService, mockCompanySkillService (+5 more)

### Community 200 - "issue-feedback-routes.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockEnvironmentService, mockExecutionWorkspaceService, mockFeedbackExportService, mockFeedbackService, mockHeartbeatService (+6 more)

### Community 201 - "routes/dashboard.ts"
Cohesion: 0.14
Nodes (18): collapseDuplicatePendingHumanJoinRequests(), findReusableHumanJoinRequest(), humanJoinRequestIdentity(), JoinRequestLike, nonEmptyTrimmed(), normalizeJoinRequestEmail(), dashboardRoutes(), parsePositiveNumber() (+10 more)

### Community 202 - "issue-recovery-actions.test.ts"
Cohesion: 0.04
Nodes (43): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, summarizeStrandedRecoveryHandBackPass(), createApp(), mockAccessDecide (+35 more)

### Community 203 - "metrics-ingest.ts"
Cohesion: 0.10
Nodes (24): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), cache (+16 more)

### Community 204 - "adapter-registry-bootstrap.ts"
Cohesion: 0.23
Nodes (9): listServerAdapters(), AdapterRegistryEnv, parseAdapterRegistryEnv(), setAdapterDisabled, reconcileAdapterAvailability(), ENTRY, fetchAllQuotaWindows(), providerSlugForAdapterType() (+1 more)

### Community 205 - "builtInAgentService"
Cohesion: 0.12
Nodes (48): builtInAgentService(), autoProvisionBundledAgents(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), defaultProvisionInput(), ensure(), ensureAgentDefaultGrants() (+40 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.15
Nodes (20): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+12 more)

### Community 208 - "agent-inbox-lite.ts"
Cohesion: 0.04
Nodes (49): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN, AGENT_INBOX_LITE_STATUS_FILTER (+41 more)

### Community 209 - "pipelineService"
Cohesion: 0.08
Nodes (41): redactRunError(), activityActorPatch(), assertReviewTargetsInSet(), descendantCaseIds(), getAncestorCases(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow(), PipelinePermissionPreflightError (+33 more)

### Community 210 - "PluginWorkerManager"
Cohesion: 0.07
Nodes (18): PluginRouteWebhookDeps, isValidTransition(), LifecycleEventName, LifecycleEventPayload, PluginLifecycleEvents, pluginLifecycleManager, assertTransition(), deactivatePluginRuntime() (+10 more)

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
Cohesion: 0.23
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), writeDevServerRestartRequest() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.15
Nodes (19): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+11 more)

### Community 218 - "body"
Cohesion: 0.05
Nodes (22): BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, CCROTATE_CAPACITY_DEFERRED_METRIC, EXECUTION_WORKSPACE_CLEANUP_REASONS, EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC, EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES, EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC, EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC (+14 more)

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "pluginManagedRoutineService"
Cohesion: 0.22
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 221 - "extractWakeCommentIds"
Cohesion: 0.21
Nodes (11): extractWakeCommentIds(), buildPaperclipWakePayload(), authorFrom(), buildPlanReviewContext(), BuildPlanReviewContextInput, getPlanInteractionContext(), nonEmptyString(), PLAN_REVIEW_CONTEXT_LIMITS (+3 more)

### Community 222 - "github-write-egress-scrub.test.ts"
Cohesion: 0.08
Nodes (29): _resetInstallationTokenCache(), Coverage, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE, serverSourceDirectory, servicesDirectory (+21 more)

### Community 223 - "transitionCaseInTransaction"
Cohesion: 0.10
Nodes (39): actorOwnsLease(), adjustParentCounts(), assertActorCanApproveStageExit(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable(), assertNoOpenBlockers(), assertStageEnabled() (+31 more)

### Community 224 - "visibleIssueCondition"
Cohesion: 0.09
Nodes (38): visibleIssueCondition(), buildLivenessEscalationDescription(), buildLivenessOriginalIssueComment(), formatDependencyPath(), issueIdFromRunContext(), issueIdFromWakePayload(), isUniqueLivenessRecoveryConflict(), livenessRecoveryLeafFingerprint() (+30 more)

### Community 225 - "isolation-workspace-reaper.test.ts"
Cohesion: 0.08
Nodes (34): createDbWorkspaceUsageLookup(), DEFAULT_ISOLATION_WORKSPACE_ROOT, DEFAULT_MAX_DELETES_PER_TICK, defaultScheduler, hasNestedCheckout(), IsolationWorkspaceReaperScheduler, IsolationWorkspaceReapOptions, IsolationWorkspaceReapResult (+26 more)

### Community 226 - "ac-policy-sweep.ts"
Cohesion: 0.11
Nodes (20): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+12 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.12
Nodes (18): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, EnvironmentCustomImageTerminalPayloadValidationResult, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken() (+10 more)

### Community 228 - "feedback-redaction.ts"
Cohesion: 0.17
Nodes (25): appendNote(), buildClaudeTraceFiles(), buildCodexTraceFiles(), buildExportId(), buildFeedbackTraceBundleFromRow(), buildOpenCodeTraceFiles(), findMatchingFile(), search() (+17 more)

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

### Community 238 - "issue-thread-interaction-routes.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), mockAccessDecide, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockHeartbeatService, mockInteractionService (+2 more)

### Community 239 - "routines-routes.test.ts"
Cohesion: 0.15
Nodes (11): createApp(), mockAccessService, mockAnnotationService, mockGetTelemetryClient, mockLogActivity, mockRoutineService, mockTrackRoutineCreated, pausedRoutine (+3 more)

### Community 240 - "approval-gate-reconciler.ts"
Cohesion: 0.11
Nodes (22): announcementBody(), announcementIdempotencyKey(), announcementMetadata(), ApprovalGateReconcileResult, ApprovalGateReconcilerOptions, ApprovalGateReconcilerScheduler, CandidateCursor, CandidateRow (+14 more)

### Community 241 - "stranded-blocked-issue-reconciler.ts"
Cohesion: 0.07
Nodes (35): createIssueDependencyReadiness(), externalWaitFromDescription(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds(), lockIssuesForUpdate() (+27 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "workspace-command-authz.ts"
Cohesion: 0.51
Nodes (10): collectAgentAdapterWorkspaceCommandPaths(), collectExecutionWorkspaceCommandPaths(), collectExecutionWorkspaceConfigCommandPaths(), collectIssueWorkspaceCommandPaths(), collectProjectExecutionWorkspaceCommandPaths(), collectProjectWorkspaceCommandPaths(), collectWorkspaceStrategyCommandPaths(), hasOwn() (+2 more)

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
Nodes (53): BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), AGENT_START_LOCK_REAP_DISPOSITION_METRIC, CRASH_RECOVERY_CANDIDATE_INDEX_NAME, CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC (+45 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "isPlainRecord"
Cohesion: 0.19
Nodes (28): asBoolean(), asString(), buildManifestFromPackageFiles(), buildPortableCatalogProvenance(), buildYamlFile(), clonePortableRecord(), deriveManifestSkillKey(), derivePortableCommentAuthorType() (+20 more)

### Community 250 - "terminal-gate-reconciler.ts"
Cohesion: 0.10
Nodes (29): PullRequestGateResult, buildInitialIssueMonitorFields(), exhaustedMonitorClearReason(), issueAllowsMonitor(), parseMonitorDate(), buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler (+21 more)

### Community 251 - "reconcileStrandedRecoveryWakeBackstopImpl"
Cohesion: 0.08
Nodes (31): findExistingIssueBlockersResolvedWakeForAnyKey(), recordBackstopCandidateSkipped(), recordBackstopSweepCompleted(), setBackstopDeferredCandidates(), ActivePauseHoldPrefilter, ActivePauseHoldPrefilterStats, createActivePauseHoldPrefilter(), DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS (+23 more)

### Community 252 - "workspace-operation-log-store.ts"
Cohesion: 0.12
Nodes (11): createLocalFileWorkspaceOperationLogStore(), ensureDir(), readFileRange(), getWorkspaceOperationLogStore(), resolveWithin(), WorkspaceOperationLogFinalizeSummary, WorkspaceOperationLogHandle, WorkspaceOperationLogReadOptions (+3 more)

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

### Community 257 - "renderYamlBlock"
Cohesion: 0.25
Nodes (11): buildMarkdown(), buildReferencedSkillMarkdown(), buildSkillSourceEntry(), compareYamlKeys(), isEmptyObject(), orderedYamlEntries(), renderFrontmatter(), renderYamlBlock() (+3 more)

### Community 258 - "issue-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockGetTelemetryClient, mockIssueService (+1 more)

### Community 259 - "project-goal-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (10): createApp(), mockAccessService, mockEnvironmentService, mockGetTelemetryClient, mockGoalService, mockLogActivity, mockProjectService, mockSecretService (+2 more)

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
Cohesion: 0.09
Nodes (36): versionMaterialHasValueDigest(), collectEnvironmentSecretRefs(), persistConfigSecretRefs(), resolveConfigSecretRefsForProbe(), resolveConfigSecretRefsForRuntime(), collectSecretRefPaths(), walk(), isUuidSecretRef() (+28 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "issue-monitor-convergence-guard.test.ts"
Cohesion: 0.21
Nodes (9): computeIssueMonitorGateFingerprint(), evaluateIssueMonitorConvergence(), normalizeGateToken(), normalizeIssueMonitorConvergenceThreshold(), normalizeIssueMonitorGateSignals(), fire(), IssueFixture, MonitorInput (+1 more)

### Community 267 - "branch-run-claims.ts"
Cohesion: 0.18
Nodes (14): acquireBranchRunClaim(), BranchClaimConflictError, BranchClaimReadDb, BranchRunClaim, canonicalizeGitRemoteIdentity(), computeBranchClaimKey(), getHeartbeatRunState(), isConstraintConflict() (+6 more)

### Community 268 - "http-metrics-per-route.test.ts"
Cohesion: 0.10
Nodes (27): composeRouteLabel(), httpMetricsMiddleware(), InstrumentableResponse, INSTRUMENTED, isApiPath(), isEmptyListBody(), API_PIPELINE_STALL_MS, ApiPipelineStatus (+19 more)

### Community 269 - "dev-runner-snapshot.test.ts"
Cohesion: 0.33
Nodes (3): readdirSync(), statSync(), tempRoots

### Community 270 - "company-branding-route.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService, mockCompanyPortabilityService, mockCompanyService, mockFeedbackService (+1 more)

### Community 271 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 272 - "issue-approval-link-authorization.ts"
Cohesion: 0.11
Nodes (31): assertHireSourceIssueLinksAllowed(), assertIssueLinksAllowed(), AccessDecider, evaluateAgentIssueApprovalLinkAuthorization(), evaluateTaskWatchdogSubtreeScope(), isCreatorOrManagerChainDecision(), isCurrentIssueExecutionRun(), IssueApprovalLinkVerdict (+23 more)

### Community 273 - "invite-accept-existing-member.test.ts"
Cohesion: 0.20
Nodes (6): accessServiceMock, ACTIVE_INVITE_EXPIRES_AT, createApp(), createAppWithActor(), logActivityMock, QueryHooks

### Community 274 - "issue-closed-workspace-routes.test.ts"
Cohesion: 0.15
Nodes (9): assigneeAgentActor, boardActor, createApp(), mockAccessService, mockExecutionWorkspaceService, mockHeartbeatService, mockIssueService, mockLogActivity (+1 more)

### Community 275 - "middleware/index.ts"
Cohesion: 0.04
Nodes (38): createApp(), mockBumpAgentImagesForCompany, createApp(), mockFolderService, mockLogActivity, createApp(), mockEnvironmentService, mockHeartbeatService (+30 more)

### Community 276 - "model-profile-hint.ts"
Cohesion: 0.11
Nodes (28): toIssueActiveRunRow(), isPlanningOnlyRecoveryContextSnapshot(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS, RECOVERY_MODEL_PROFILE_KEY (+20 more)

### Community 277 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.08
Nodes (21): PENDING_INTERACTION_MAX_AGE_MS, createStrandedAttendancePrefetch(), windowFor(), windowIdsFor(), DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS, DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW, IssueAttendanceEvidence, StrandedAttendancePrefetch (+13 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 280 - "agent-auth-jwt.ts"
Cohesion: 0.18
Nodes (15): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+7 more)

### Community 281 - "workspace-scan.ts"
Cohesion: 0.36
Nodes (9): CONFIG_FILE_LANGUAGES, detectProjectName(), execFileAsync, fileExists(), getGitDefaultBranch(), getGitRemoteUrl(), readReadmeExcerpt(), WorkspaceScanResult (+1 more)

### Community 282 - "backfill-agent-bundle.ts"
Cohesion: 0.21
Nodes (12): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+4 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "authorization-service.test.ts"
Cohesion: 0.27
Nodes (8): buildFixture(), createAgent(), createCompany(), createIssue(), createProject(), grantAgentPermission(), IssueAction, Relation

### Community 285 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 286 - "issue-comment-effects.ts"
Cohesion: 0.14
Nodes (26): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+18 more)

### Community 287 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 288 - "importBundle"
Cohesion: 0.08
Nodes (32): applySelectedFilesToSource(), bufferToPortableBinaryFile(), collectAgentSafeImportPolicyErrors(), applyImportedAgentPermissionGrants(), buildPreview(), importBundle(), previewImport(), resolveImportedAssigneeAgentId() (+24 more)

### Community 289 - "approval-enforcement-reconciler.ts"
Cohesion: 0.13
Nodes (23): APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND, ApprovalCandidate, ApprovalCursor, approvalCursorFrom(), ApprovalEnforcementReconcileResult, ApprovalEnforcementReconcilerScheduler, BudgetPolicyAmountAssertion, buildDriftIssueBody() (+15 more)

### Community 290 - "createPluginJobScheduler"
Cohesion: 0.14
Nodes (23): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), ParsedCron (+15 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.08
Nodes (5): PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, __resetQuotaExhaustedHookStateForTesting(), mockAdapterExecute

### Community 292 - "run-secret-redaction.ts"
Cohesion: 0.14
Nodes (22): compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan(), characterClassCount() (+14 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "zoned-cron.ts"
Cohesion: 0.13
Nodes (24): assertTimeZone(), isSubHourlyCronExpression(), nextCronTickInTimeZone(), sampleRoutineFireGapsMs(), buildCronMask(), CronMask, daysInMonth(), getZonedMinuteFormatter() (+16 more)

### Community 295 - "built-in-agent-routes.test.ts"
Cohesion: 0.18
Nodes (8): allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService, mockInstanceSettingsService, mockLogActivity, stateWithMetadata()

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "company-skills-catalog-service.test.ts"
Cohesion: 0.25
Nodes (7): contentHash(), createService(), mockCatalogService, sampleAssetBytes, sampleCatalogSkill, sampleFiles, sha256()

### Community 298 - "issue-update-comment-wakeup-routes.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockCommentEffects, mockGetActiveCompanyMembership, mockHeartbeatService, mockIssueReferenceService, mockIssueService, mockIssueThreadInteractionService, mockLogActivity (+1 more)

### Community 299 - "node:http"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, baseGoal, createApp(), loadRouteModules() (+3 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (20): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+12 more)

### Community 302 - "redact-sensitive.ts"
Cohesion: 0.29
Nodes (9): isSensitiveContainerKey(), isSensitiveKey(), isUrlishKey(), redactContainer(), redactSensitive(), SENSITIVE_CONTAINER_KEYS, SENSITIVE_KEYS, stripSecretBearingUrlParts() (+1 more)

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 304 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (18): PROVIDER_CAPACITY_MAX_HORIZON_MS, createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile() (+10 more)

### Community 305 - "heartbeat-retry-scheduling.test.ts"
Cohesion: 0.03
Nodes (67): applyCcrotateCapacityDecision(), CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MAX_PARK_MS (+59 more)

### Community 306 - "fd-class-metrics.ts"
Cohesion: 0.12
Nodes (23): boundedDirLabel(), boundedSegment(), classifyFdTarget(), CollectFdClassOptions, collectFdClassSnapshot(), FD_CLASS_MAX_ENTRIES, FD_CLASS_MAX_SEGMENT_CHARS, FD_CLASS_MAX_SERIES (+15 more)

### Community 307 - "issue-subtree-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.11
Nodes (12): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, AgentRow, collectWriterFiles(), columnReasonLiteralsFromDirectInserts(), CompanyRow, createApp(), Db, isProductionSource() (+4 more)

### Community 309 - "heartbeat-run-summary.ts"
Cohesion: 0.33
Nodes (9): buildHeartbeatRunIssueComment(), HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS, HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS, HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES, mergeHeartbeatRunResultJson(), readCommentText(), readNumericField(), summarizeHeartbeatRunResultJson() (+1 more)

### Community 310 - "zoned-cron-equivalence.test.ts"
Cohesion: 0.11
Nodes (23): resetRoutineFireGapsMemoForTests(), ZONED_CRON_SEARCH_MAX_AFTER_MS, ZONED_CRON_SEARCH_MIN_AFTER_MS, assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute() (+15 more)

### Community 311 - "live-events.ts"
Cohesion: 0.06
Nodes (21): resetPluginEventOutboxDbForTests(), HeartbeatEnvironmentRuntime, emitter, LiveEventListener, LiveEventPayload, publishGlobalLiveEvent(), subscribeCompanyLiveEvents(), toLiveEvent() (+13 more)

### Community 312 - "plugin-orchestration-apis.test.ts"
Cohesion: 0.09
Nodes (15): createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus, Subscription (+7 more)

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "openrouter/execute.ts"
Cohesion: 0.13
Nodes (17): AGENT_TOOLS, callOpenRouter(), ChatMessage, execAsync, execute(), executeToolCall(), walk(), sanitize() (+9 more)

### Community 315 - "evidence-truth.ts"
Cohesion: 0.13
Nodes (17): buildGithubTruthProbe(), GithubTruthDeps, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr, PROBE_DEADLINE_MS, probeOne() (+9 more)

### Community 316 - "config"
Cohesion: 0.24
Nodes (8): describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest(), tryEnvLabFixture(), tryExplicitConfig(), config()

### Community 317 - "pr-review-state-reconciler.ts"
Cohesion: 0.12
Nodes (23): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+15 more)

### Community 318 - "process-crash-guard-exit.test.ts"
Cohesion: 0.14
Nodes (12): MAX_WRITE_WAIT_MS, CrashResult, fixture, here, LATE_BACKPRESSURE_RUN, PREFILL_RUN, readRemainingStderr(), runFixtureWithStalledStderr() (+4 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 321 - "utils.ts"
Cohesion: 0.09
Nodes (27): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx, execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment() (+19 more)

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "native-memory-metrics.test.ts"
Cohesion: 0.13
Nodes (22): PROCESS_MEMORY_COMPONENT_BYTES_METRIC, PROCESS_V8_CONTEXT_COUNT_METRIC, setNativeMemoryMetrics(), ARRAY_BUFFERS_COMPONENT, CollectNativeMemoryOptions, collectNativeMemorySnapshot(), DETACHED_CONTEXT_KIND, EXTERNAL_OTHER_COMPONENT (+14 more)

### Community 324 - "services/index.ts"
Cohesion: 0.03
Nodes (70): auditAgentIssueCreateAttributionSpoof(), ACTIVITY_ACTION_TO_PLUGIN_EVENT, ActivityPublish, eventTypeForActivityAction(), logActivity(), LogActivityInput, PLUGIN_EVENT_SET, readNonEmptyString() (+62 more)

### Community 325 - "zodToOpenApiSchema"
Cohesion: 0.52
Nodes (7): applyNumberChecks(), applyStringChecks(), isOptionalSchema(), parametersFromSchema(), unwrapSchema(), zodToOpenApiSchema(), zodTypeName()

### Community 326 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.05
Nodes (21): registerServerAdapter(), unregisterServerAdapter(), HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, adapterExecute, execFile, mockDeleteAgentJobExact, mockHasActiveJobForAgent, mockListAgentJobRunStatuses (+13 more)

### Community 327 - "company-export-readme.ts"
Cohesion: 0.43
Nodes (6): generateOrgChartMermaid(), generateReadme(), mermaidEscape(), mermaidId(), ROLE_LABELS, skillSourceLabel()

### Community 329 - "collectEvidence"
Cohesion: 0.11
Nodes (33): choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), deliberatePendingMonitor(), dominantErrorCode(), isDominantEpisodeShare(), isMonitorSuppressionActor(), isNeverExecutedRun() (+25 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.08
Nodes (38): assertCanManageInstanceSettings(), auditPatchedHookCommands(), instanceSettingsRoutes(), auditConfiguredHookCommandsOnBoot(), auditHookCommands(), basenameOf(), COMMAND_PREFIXES, describeHookCommandFinding() (+30 more)

### Community 331 - "linear-auth.ts"
Cohesion: 0.14
Nodes (18): LinearTeam, LinearTeamExpectation, LinearTeamFailure, LinearTeamMatch, LinearTeamResolution, linearTeamResolutionError(), resolveLinearTeam(), callbackPage() (+10 more)

### Community 332 - "boardAuthService"
Cohesion: 0.11
Nodes (26): BOARD_API_KEY_TTL_MS, boardApiKeyExpiresAt(), boardAuthService(), approveCliAuthChallenge(), assertCurrentBoardKey(), cancelCliAuthChallenge(), createCliAuthChallenge(), createNamedBoardApiKey() (+18 more)

### Community 333 - "environmentRoutes"
Cohesion: 0.12
Nodes (19): environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment(), environmentDeleteBlockMessage(), logEnvironmentCustomImageActivity() (+11 more)

### Community 334 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 335 - "input"
Cohesion: 0.15
Nodes (12): locatePodLogArtifact(), OrphanedRunTerminalResult, readOptionalString(), readOrphanedRunTerminalResult(), resultEventReportsSuccess(), runLogBasePath(), input(), createSecret() (+4 more)

### Community 336 - "project-env-response-boundary.test.ts"
Cohesion: 0.13
Nodes (17): ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), PROJECT_ENV_VALUE_MASK, derivedStageAutomationPayload(), createApp() (+9 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.29
Nodes (5): require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance

### Community 338 - "routes/decision-training.ts"
Cohesion: 0.15
Nodes (18): createSchema, decisionTrainingRoutes(), exampleIdSchema, parseExampleId(), previewSchema, requireExampleOwner(), requireHumanUser(), sourceKindSchema (+10 more)

### Community 339 - ".call"
Cohesion: 0.13
Nodes (7): awsProviderSafeMessage(), AwsSecretsManagerGateway, AwsSecretsManagerJsonGateway, classifyAwsProviderError(), loadAwsCredentials(), normalizeAwsError(), SecretProviderClientError

### Community 340 - "queued-run-age-metrics.ts"
Cohesion: 0.06
Nodes (35): DEP_BLOCKED_MAX_DELAY_MS, MAX_TURN_CONTINUATION_MAX_DELAY_MS, coerceRetryScheduleReason(), DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC, DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, normalizeAgentId(), QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC, QUEUED_RUN_OLDEST_AGE_METRIC (+27 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.60
Nodes (5): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance()

### Community 344 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.10
Nodes (8): FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR, SDK_INSTALL_RACE_ERROR, ghFetchMock, jsonResponse(), NOW, routeGithub()

### Community 345 - "normalizeIssueExecutionPolicy"
Cohesion: 0.15
Nodes (18): isLapsedMonitorRearmPatch(), applyIssueExecutionPolicyTransition(), DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS, normalizeIssueExecutionPolicy(), normalizeMonitorNotes(), state(), makeInReviewIssue(), makeStuckReviewIssue() (+10 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.11
Nodes (4): SecretProviderModule, schedulerReceipts(), seedFixture(), seedWithAlertSurface()

### Community 347 - "issue-list-assignee-filter-routes.test.ts"
Cohesion: 0.10
Nodes (16): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, listSuccessfulRunHandoffStates(), successfulRunHandoffStateFromActivity(), hydrateSuccessfulRunHandoffLiveness(), resolveSuccessfulRunHandoffForTerminalIssues(), SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES (+8 more)

### Community 348 - "heartbeat-issue-liveness-escalation.test.ts"
Cohesion: 0.11
Nodes (14): BACKSTOP_CANDIDATES_SKIPPED_METRIC, BACKSTOP_SWEEP_COMPLETED_METRIC, ABANDONED_LIVENESS_RECOVERY_MARKER, DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS, DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS, STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER, enableAutoRecovery() (+6 more)

### Community 349 - "approval-budget-assertion-required.test.ts"
Cohesion: 0.11
Nodes (15): createAgentApp(), createRouteDb(), createUserApp(), fileCard(), mockAccessService, mockApprovalService, mockDeferredActivityPublish, mockHeartbeatService (+7 more)

### Community 350 - "asNumber"
Cohesion: 0.17
Nodes (19): asBoolean, asNumber, EXTERNAL_LIFECYCLE_ADAPTERS, hasExternalLifecycleAdapter(), isRunOccupyingSlot(), normalizeMaxConcurrentRuns(), resolveAgentConcurrencyPolicy(), resolveEffectiveMaxConcurrentRuns() (+11 more)

### Community 352 - "docker-entrypoint.test.ts"
Cohesion: 0.47
Nodes (5): ENTRYPOINT, execFileAsync, installStubs(), runEntrypoint(), writeStub()

### Community 354 - "local-encrypted-provider.ts"
Cohesion: 0.17
Nodes (17): resolveDefaultSecretsKeyFilePath(), AwsSecretsManagerMaterial, asLocalEncryptedMaterial(), decodeMasterKey(), encryptValue(), enforceKeyFilePermissionsBestEffort(), inspectLocalEncryptedHealth(), loadOrCreateMasterKey() (+9 more)

### Community 355 - "buildPortableProjectWorkspaces"
Cohesion: 0.28
Nodes (9): buildPortableProjectWorkspaces(), containsAbsolutePathFragment(), containsSystemDependentPathValue(), derivePortableProjectWorkspaceKey(), execFileAsync, inferPortableWorkspaceGitMetadata(), readGitOutput(), readGitRemoteUrl() (+1 more)

### Community 356 - "pipeline-case-outputs.ts"
Cohesion: 0.18
Nodes (19): buildCaseContextMarkdown(), contentPath(), contextFetchHint(), DELIVERABLE_TITLE_PATTERNS, deliverableDocumentRank(), downloadPath(), formatPipelineCaseOutputContextMarkdown(), normalizePreviewText() (+11 more)

### Community 357 - "heartbeat-zombie-guard.test.ts"
Cohesion: 0.13
Nodes (13): describeIntervalOverrunCoalesceBypass(), filterIntervalOverrunCoalesceTarget(), filterZombieCoalesceTarget(), isCoalesceTargetPastHeartbeatInterval(), isZombieRun(), resolveStalledCoalesceBudgetMs(), STALLED_COALESCE_BYPASS_SNAPSHOT_KEY, STALLED_COALESCE_INTERVAL_MULTIPLE (+5 more)

### Community 358 - "issue-liveness.test.ts"
Cohesion: 0.36
Nodes (6): blockedBlocker(), blocks, deadEnd(), issue(), manager, monitorOnlyIssue()

### Community 359 - "issue-monitor-scheduler.test.ts"
Cohesion: 0.19
Nodes (9): ISSUE_MONITOR_DISPATCH_LAPSE_MS, ISSUE_MONITOR_LIVE_CONSUMER_MAX_AGE_MS, ISSUE_MONITOR_TRIGGERED_STALL_GRACE_MS, cleanupRows(), createHeartbeatWithClaimRace(), heartbeatSideEffectFingerprint(), reapPastOverAgeQueuedRun(), seedExpiredTriggeredFixture() (+1 more)

### Community 360 - "pull-request-work-products.ts"
Cohesion: 0.14
Nodes (17): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestMergeQueueState, PullRequestWorkProductFields (+9 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "pr-review-request-ageing-producer.ts"
Cohesion: 0.16
Nodes (14): DigestProducer, DigestSection, DEFAULT_ESCALATE_AFTER_DAYS, formatPullRequestRef(), buildPrReviewRequestAgeingSection(), LoadedReviewState, PR_REVIEW_REQUEST_AGEING_SECTION_KEY, prReviewRequestAgeingProducer (+6 more)

### Community 363 - "dev-watch-ignore.ts"
Cohesion: 0.70
Nodes (3): addIgnorePath(), resolveServerDevWatchIgnorePaths(), toGlobstarPath()

### Community 364 - "pipelines-service.test.ts"
Cohesion: 0.14
Nodes (14): loadPipelineDescendantActiveWorkCounts(), PIPELINE_CASE_EVENTS_MAX_LIMIT, PIPELINE_CONTEXT_PACK_EVENT_LIMIT, PipelineActor, app(), plantedStageConfig(), seedCarrier(), seedCompany() (+6 more)

### Community 365 - "approval-create-issue-link-authorization.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 366 - "applyDocumentFixups"
Cohesion: 0.60
Nodes (5): applyDocumentFixups(), applyOperationStatusOverride(), isBoardOnlyOperation(), operationKey(), resolveOperationAuthLevel()

### Community 367 - "user-profiles.ts"
Cohesion: 0.25
Nodes (16): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+8 more)

### Community 368 - "approval-link-route-equivalence.test.ts"
Cohesion: 0.13
Nodes (12): attachViaCreateRoute(), attachViaLinkRoute(), createApp(), createRouteDb(), mockAccessService, mockAgentService, mockApprovalService, mockHeartbeatService (+4 more)

### Community 369 - "issue-checkout-status.ts"
Cohesion: 0.14
Nodes (16): reconcileUndeliverableIssueMonitors(), WakeupOptions, checkoutRestoreStatusExpression, checkoutRestoreTargetStatus, DbOrTransaction, hasCancelledBlocker, hasPendingBlocker, holdsDispatchableMonitor (+8 more)

### Community 370 - "done-gate.ts"
Cohesion: 0.60
Nodes (3): DoneGateInput, hasPrLinkEvidence(), shouldBlockNarratedDone()

### Community 371 - "heartbeat-stale-queue-invalidation.test.ts"
Cohesion: 0.21
Nodes (9): mockAdapterExecute, resumeContinuationRetry(), seedCompanyAndAgent(), seedContinuationSummary(), SeedOptions, seedParkedContinuationRetry(), seedQueuedRun(), SeedResult (+1 more)

### Community 372 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.19
Nodes (15): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat() (+7 more)

### Community 373 - "issue-goal-fallback.ts"
Cohesion: 0.60
Nodes (3): MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId()

### Community 374 - "agent-profile-change-gate-mixing.test.ts"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity, mockSecretService (+3 more)

### Community 375 - "approval-agent-config-authz-routes.test.ts"
Cohesion: 0.12
Nodes (12): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService (+4 more)

### Community 376 - "github-fetch.ts"
Cohesion: 0.18
Nodes (12): GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS, isGitHubDotCom(), _setGhFetchDeadlineMsForTest(), assertWebhookGithubCallsAreBounded(), blankLiterals(), closingParen(), hasOwnRequestBound() (+4 more)

### Community 377 - "board-chat.ts"
Cohesion: 0.26
Nodes (8): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), createApp(), mockGetExperimental, mockIssueService, mockSpawn

### Community 378 - "graceful-shutdown-exit.test.ts"
Cohesion: 0.40
Nodes (4): fixture, here, serverRoot, tsx

### Community 379 - "invite-create-route.test.ts"
Cohesion: 0.60
Nodes (4): createApp(), createDbStub(), logActivityMock, registerModuleMocks()

### Community 380 - "company-issue-identity-guard.test.ts"
Cohesion: 0.19
Nodes (13): syncIssueIdentityFromLinearTeam(), auditRows(), BLOCKCAST, expectSilentNoOp(), findUnguardedIdentityWrites(), IDENTITY_KEYS, IDENTITY_WRITE_ALLOW_LIST, identityOf() (+5 more)

### Community 381 - "activityService"
Cohesion: 0.20
Nodes (12): ActivityFilters, activityService(), asRecord(), backfillMissingRunLivenessForIssue(), countValue(), dateValue(), latestDate(), readNumber() (+4 more)

### Community 382 - "run-log-terminal-result.ts"
Cohesion: 0.18
Nodes (12): findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), RUN_LOG_TERMINAL_MAX_SCAN_BYTES, RUN_LOG_TERMINAL_TAIL_BYTES, RunLogRangeReader, RunLogTailRead, RunLogTerminalResultEvent (+4 more)

### Community 383 - "agent-budget-mirror-write.test.ts"
Cohesion: 0.14
Nodes (13): agentActor, agentRow, baseAgent, boardActor, createApp(), createDbStub(), mockAccessService, mockAgentService (+5 more)

### Community 384 - "mcp-seed-scrub-coverage.test.ts"
Cohesion: 0.14
Nodes (10): Coverage, EntryShape, jobManifestPath, repoRoot, resolveEntryShapes(), SCRUBBING_GATEWAY_HOSTS, SEED_COVERAGE, SeedEntry (+2 more)

### Community 385 - "stacked-pr-auto-retarget.test.ts"
Cohesion: 0.17
Nodes (10): buildApp(), linkPullRequest(), mockListOpenPrsByBase, mockResolveBranchState, mockResolveMergedBase, mockResolveMergeShape, post(), seedCompany() (+2 more)

### Community 386 - "heartbeat-hard-stale-subprocess-liveness.test.ts"
Cohesion: 0.14
Nodes (10): numberFromEnv(), parseCpuQuantityToMillicores(), mockDeleteAgentJobExact, mockDeleteAgentJobsForRun, mockHasActiveJobForAgent, mockListAgentJobRunStatuses, mockListLiveAgentJobRunIds, mockListManagedAgentJobs (+2 more)

### Community 387 - "plugin-webhook-not-ready-retryable.test.ts"
Cohesion: 0.14
Nodes (11): boundWebhookRejectionPluginKey(), logPluginWebhookDeliveryRejection(), MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS, OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY, PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC, recordPluginWebhookDeliveryRejected(), createApp(), mockLifecycle (+3 more)

### Community 388 - "scheduler-lease.ts"
Cohesion: 0.23
Nodes (11): recordSchedulerLeaseState(), acquireSchedulerLease(), firstRow(), HEARTBEAT_TIMER_LEASE, LeaseDb, releaseSchedulerLease(), SCHEDULER_LEASE_RENEW_INTERVAL_MS, SCHEDULER_LEASE_TTL_MS (+3 more)

### Community 389 - "readNonEmptyString"
Cohesion: 0.23
Nodes (14): asRecord(), capacityRetryFromBody(), isPenstockCapacityBody(), parseCapacityResetIso(), parseCapacityRetry(), parseOptionalDate(), parseRetryAfterSeconds(), readCapacityReason() (+6 more)

### Community 390 - "sweep-wake-preflight.test.ts"
Cohesion: 0.15
Nodes (13): compareSweepWakeFrame(), equalStringArrays(), isValidIsoDate(), isValidSweepWakeFrame(), parseScalar(), parseSweepWakeFramePage(), sortLex(), SweepWakeFrame (+5 more)

### Community 391 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 392 - "approval-revision-exit.test.ts"
Cohesion: 0.15
Nodes (10): BOARD_NOTE, get(), mockAgentService, mockApprovalService, mockListIssuesForApproval, mockLogActivity, mockWakeup, racingUpdates() (+2 more)

### Community 393 - "issue-create-pr-review-duplicate-routes.test.ts"
Cohesion: 0.21
Nodes (9): __test_buildPrReviewerTaskLockKeys, DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE, NOT_A_REVIEW_REQUEST_MARKER, configureReviewer(), createApp(), NORMALIZED_REPO, seedAgent(), seedCompany() (+1 more)

### Community 394 - "company-search-rate-limit.ts"
Cohesion: 0.21
Nodes (8): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), createApp(), unusedSearch()

### Community 395 - "createToolGatewayService"
Cohesion: 0.04
Nodes (111): parseRemoteHttpEndpoint(), remoteEndpoint(), asRecord(), auditSafeEndpoint(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions() (+103 more)

### Community 396 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 399 - "docker-onboard-smoke-contract.test.ts"
Cohesion: 0.50
Nodes (3): repoRoot, smokeScript, smokeWorkflow

### Community 401 - "approval-payload-title-guard.test.ts"
Cohesion: 0.29
Nodes (10): findPayloadProperty(), isApprovalsInsertValuesCall(), listSourceFiles(), objectHasTitleKey(), payloadObjectLiteralsOf(), propertyNameIs(), scanFile(), visit() (+2 more)

### Community 402 - "openclaw-invite-prompt-route.test.ts"
Cohesion: 0.25
Nodes (8): createApp(), createDbStub(), createSelectChain(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity, mockStorage

### Community 403 - "extractEnforcementAssertions"
Cohesion: 0.24
Nodes (12): stampPriors(), asArray(), asFiniteNumber(), asNonEmptyString(), asRecord(), extractEnforcementAssertions(), loadEnforcedBudgetPolicies(), readAmountCents() (+4 more)

### Community 404 - "issues-open-assignment-census.test.ts"
Cohesion: 0.18
Nodes (7): clampIssueListLimit(), OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, appAs(), oracle(), PRIORITY_RANK, rankOf()

### Community 405 - "plugin-status-metrics.ts"
Cohesion: 0.27
Nodes (10): PLUGIN_ERROR_METRIC, PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC, PluginErrorStatusEntry, setPluginErrorStatus(), setPluginStatusCollectorLastSuccessSeconds(), pluginErrorEntriesFromRows(), PluginStatusCollectorOptions, PluginStatusRow (+2 more)

### Community 406 - "readPenstockCapacity"
Cohesion: 0.29
Nodes (10): capacityEndpointUnavailable(), defaultCapacityRetry(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger (+2 more)

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.20
Nodes (5): createDb(), createSelectChain(), then(), values(), chartDir

### Community 409 - "github-review-posted-metric.test.ts"
Cohesion: 0.18
Nodes (6): __test_resolvePostedReviewObservation, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC, normalizeGithubReviewRepo(), recordGithubReviewPosted(), ALLY_REVIEW_BODY

### Community 410 - "issue-watchdogs-routes.test.ts"
Cohesion: 0.28
Nodes (5): createApp(), seedCloudTenantMember(), seedCompany(), seedWatchdogRun(), uniqueIssuePrefix()

### Community 411 - "assertAssignableAgent"
Cohesion: 0.27
Nodes (10): AgentAssignmentConflictReason, AgentAssignmentKind, assertAssignableAgent(), AssignabilityAgent, assignmentMessage(), assignmentReasonFromHealth(), conflictDetails(), getAgent() (+2 more)

### Community 412 - "approval-enforcement-reconciler.test.ts"
Cohesion: 0.18
Nodes (9): BUDGET_POLICY_AMOUNT_ASSERTION, diffEnforcementAssertions(), EnforcedBudgetPolicy, parseJsonBodyStrict(), AMOUNT_MOVED_AFTER_DECISION, AMOUNT_UNMOVED_SINCE_DECISION, CARD_6F45844E_DECIDED_AT, CARD_6F45844E_EXACT_CHANGES (+1 more)

### Community 413 - "company-issue-identity.ts"
Cohesion: 0.27
Nodes (10): ISSUE_IDENTITY_ACTIVITY_ACTION, IssueIdentityPlan, IssueIdentityRefusal, IssueIdentityRequest, IssueIdentityState, normalizeIssuePrefix(), planIssueIdentityChange(), setCompanyIssueIdentity() (+2 more)

### Community 421 - "documents.ts"
Cohesion: 0.31
Nodes (7): documentService(), extractLegacyPlanBody(), issueDocumentSelect, isUniqueViolation(), mapIssueDocumentRow(), nextAvailableDocumentKey(), normalizeDocumentKey()

### Community 425 - "matchesTaskKey"
Cohesion: 0.25
Nodes (8): isSameTaskScope(), canClaimPrReviewTask(), isPrReviewTaskKey(), matchesAnyTaskKey(), matchesTaskKey(), prReviewTaskLockSpellings(), taskKeysMatch(), allowPenstockGate

### Community 427 - "sse-registry.ts"
Cohesion: 0.39
Nodes (5): active, MAX_SSE_BACKLOG_BYTES, sseBacklogExceeded(), sseRegistry, writeSseFrame()

### Community 428 - "environment-instance-routes.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+1 more)

### Community 430 - "plugin-metric-exposition.test.ts"
Cohesion: 0.07
Nodes (24): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+16 more)

### Community 431 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 433 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 437 - "deriveSkillExportDirCandidates"
Cohesion: 0.33
Nodes (10): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+2 more)

### Community 438 - "database-backup-health.ts"
Cohesion: 0.29
Nodes (9): alertFileCandidates(), DatabaseBackupHealthStatus, DatabaseBackupHealthWarning, DatabaseBackupHealthWarningCode, findLatestBackup(), inspectDatabaseBackupHealth(), InspectDatabaseBackupHealthOptions, readLastFailure() (+1 more)

### Community 446 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.20
Nodes (3): humanGatedAgeingProducer, collect(), NOW

### Community 447 - "agent-budgets-route-config-revision.test.ts"
Cohesion: 0.24
Nodes (6): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets()

### Community 460 - "secrets/types.ts"
Cohesion: 0.10
Nodes (22): awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider, checkSecretProviders(), listSecretProviders() (+14 more)

### Community 461 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 462 - "cases-routes.test.ts"
Cohesion: 0.20
Nodes (3): app(), authenticatedApp(), enableCases()

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "plugin-state-store.ts"
Cohesion: 0.14
Nodes (17): normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier(), ResolvedPluginFencingPrecondition (+9 more)

### Community 465 - "scrape-metrics-routine-fire-gap-work.test.ts"
Cohesion: 0.22
Nodes (5): db, rows, settle(), tickAt(), TRIGGERS

### Community 467 - "trust-proxy.ts"
Cohesion: 0.36
Nodes (7): RFC-4291, applyTrustProxy(), isValidSubnetToken(), NAMED_SUBNETS, parseTrustProxyEnv(), TrustProxyValue, appWithEnv()

### Community 468 - "privateHostnameGuard"
Cohesion: 0.42
Nodes (7): blockedHostnameMessage(), extractHostname(), isLoopbackHostname(), normalizeAllowedHostnames(), privateHostnameGuard(), resolvePrivateHostnameAllowSet(), createApp()

### Community 469 - "pr-review-issue-scope-locks.test.ts"
Cohesion: 0.25
Nodes (8): DuplicatePrReviewIssueCandidate, classify(), fakeDb(), GuardTx, ONE_PR, OPTIONS, Statement, TWO_PRS

### Community 470 - "closeOpenSuppressedReviews"
Cohesion: 0.20
Nodes (10): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock(), isDependencyBlockedClosableRecord(), isDependencyBlockedClosableTrigger(), isDependencyBlockedClosableTriggerSet(), issueRunScopeInSql(), closeOpenSuppressedReviews() (+2 more)

### Community 471 - "heartbeat-reviewer-evidence-live-head.test.ts"
Cohesion: 0.25
Nodes (6): FakeReview, h, jsonResponse(), PRIVATE_KEY_PEM, { privateKey }, stubGithub()

### Community 472 - "permissions-upgrade-boundary-routes.test.ts"
Cohesion: 0.16
Nodes (4): activeReservations(), Db, createApp(), Db

### Community 473 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.25
Nodes (3): createApp(), seedCompanyAgentAndRuns(), seedPendingReviewStageIssue()

### Community 474 - "startup-filesystem-io.test.ts"
Cohesion: 0.40
Nodes (4): repoRoot, serverSource, statefulSet, tempDirs

### Community 475 - "chain"
Cohesion: 0.18
Nodes (3): createFakeDb(), chain, VALID_HEADERS

### Community 476 - "event-loop-stall-log.ts"
Cohesion: 0.43
Nodes (6): EventLoopStallLogOptions, resolveStallThresholdMs(), startEventLoopStallLogging(), blockEventLoop(), blockUntilStallObserved(), sleep()

### Community 477 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 478 - "Ally — Consolidated PR Review"
Cohesion: 0.25
Nodes (7): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Prior Findings Dispositioned (1), Recommended Action, Strengths, Suggestions (0)

### Community 479 - "human-gated-gate-revalidation-backfill.test.ts"
Cohesion: 0.25
Nodes (4): NOW, Stub, StubInteraction, StubIssue

### Community 480 - "issue-stable-enumeration-routes.test.ts"
Cohesion: 0.29
Nodes (3): createApp(), seedCompany(), uniqueIssuePrefix()

### Community 481 - "ceo/AGENTS.md"
Cohesion: 0.29
Nodes (6): Delegation (critical), Keeping work moving, Memory and Planning, References, Safety Considerations, What you DO personally

### Community 483 - "penstock-availability-gate.test.ts"
Cohesion: 0.33
Nodes (4): createPenstockAvailabilityGate(), gateWith(), gateWith(), log

### Community 484 - "plugin-host-service-cleanup.ts"
Cohesion: 0.29
Nodes (3): LifecycleLike, PluginHostServiceCleanupController, PluginWorkerRuntimeEvent

### Community 485 - "ensureServerWorkspaceLinksCurrent"
Cohesion: 0.33
Nodes (7): discoverWorkspacePackagePaths(), visit(), ensureServerWorkspaceLinksCurrent(), findServerWorkspaceLinkMismatches(), findWorkspaceRoot(), isLinkedGitWorktreeCheckout(), readJsonFile()

### Community 486 - "Ally — Consolidated PR Review"
Cohesion: 0.29
Nodes (6): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Recommended Action, Strengths, Suggestions (2)

### Community 487 - "heartbeat-worktree-suppression.test.ts"
Cohesion: 0.33
Nodes (4): armWorktreeRunExecution(), deleteHeartbeatRunsWithDependents(), drainInFlightExecutions(), isHeartbeatRunDependentFkError()

### Community 488 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 489 - "linear-tunnel.ts"
Cohesion: 0.47
Nodes (3): registerLinearWebhook(), registerWebhookWithToken(), startLinearTunnel()

### Community 491 - "issue-assignment-wakeup.ts"
Cohesion: 0.40
Nodes (5): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail

### Community 492 - "agent-auth-middleware.test.ts"
Cohesion: 0.40
Nodes (3): createApp(), createDbState(), createSelectChain()

### Community 493 - "plugin-worker-invocation-scope.cjs"
Cohesion: 0.40
Nodes (5): pendingNested, readline, rl, send(), sendNestedHostRequest()

### Community 494 - "issue-checkout-routine-lock-conflict.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedDuplicateRoutineExecutions(), seedRun()

### Community 495 - "issue-release-lock-only-degrade.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedHolderRun(), seedStalePair()

### Community 496 - "pen3139-transcript-credential-shapes.test.ts"
Cohesion: 0.33
Nodes (4): CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

### Community 497 - "startup-dispatch-isolation.test.ts"
Cohesion: 0.33
Nodes (4): analyzeRecoveryIife(), ESCAPE_CALLS, repoRoot, serverSource

### Community 498 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

### Community 499 - "reflection-coach/AGENTS.md"
Cohesion: 0.40
Nodes (4): Applying changes (permission is gated, not automatic), Core responsibilities, Execution contract, Hard boundaries

### Community 500 - "Recent agent reflection sweep"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Recent agent reflection sweep, What this run must do

### Community 501 - "summarizer/AGENTS.md"
Cohesion: 0.40
Nodes (4): Core responsibilities, Cost discipline, Execution contract, Hard boundaries

### Community 502 - "Refresh stale summary slots"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Refresh stale summary slots, What this run must do

### Community 503 - "validateTerminalUpgrade"
Cohesion: 0.50
Nodes (3): CustomImageTerminalService, terminalPayloadValidationError(), validateTerminalUpgrade()

### Community 504 - "healthz-probe-route.test.ts"
Cohesion: 0.40
Nodes (3): HEALTH_PROBE_DEADLINE_MS, appSource, repoRoot

### Community 505 - "environment-runtime-driver-contract.test.ts"
Cohesion: 0.50
Nodes (3): runContract(), RuntimeContractCase, seedEnvironment()

### Community 507 - "issue-thread-interactions-service.test.ts"
Cohesion: 0.50
Nodes (4): AcceptGateInteractionKind, seedAcceptGateFixture(), seedAgentIssue(), seedConfirmationIssue()

### Community 508 - "metrics-route-no-db.test.ts"
Cohesion: 0.40
Nodes (3): APP_SOURCE, DB_REFRESHES, INLINE_REFRESHES

### Community 509 - "reviewer-wake-outcome-log-fields.test.ts"
Cohesion: 0.50
Nodes (4): OutcomeLine, outcomeLines(), strippedSource(), WEBHOOK_SOURCE

### Community 510 - "SOUL.md -- CEO Persona"
Cohesion: 0.50
Nodes (3): SOUL.md -- CEO Persona, Strategic Posture, Voice and Tone

### Community 511 - "Wake Pre-flight (do this FIRST when woken)"
Cohesion: 0.50
Nodes (3): Fall-through write protocol, Short-circuit protocol, Wake Pre-flight (do this FIRST when woken)

### Community 514 - "redactSecretValuesFromText"
Cohesion: 0.67
Nodes (4): orderedSecrets(), redactSecretValuesDeep(), walk(), redactSecretValuesFromText()

## Knowledge Gaps
- **3699 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Db`, `LogEntry` (+3694 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 5550 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **68 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `heartbeatService()` connect `heartbeatService` to `heartbeat.ts`, `source-trust.ts`, `embedded-postgres.ts`, `github-status-delivery-outbox.ts`, `app.ts`, `successful-run-handoff.ts`, `routes/projects.ts`, `environmentService`, `branch-run-claims.ts`, `workspace-runtime.ts`, `trust-preset-resolver.ts`, `k8s-job-liveness.ts`, `parseObject`, `heartbeat-run-runtime-status.ts`, `issue-rewake-throttle.ts`, `model-profile-hint.ts`, `executeRun`, `agent-auth-jwt.ts`, `issueService`, `secretService`, `logger.ts`, `managed-checkout-partial-clone.ts`, `services/instance-settings.ts`, `registry.ts`, `db-retry.ts`, `run-secret-redaction.ts`, `matchesTaskKey`, `feedback.ts`, `redactCurrentUserText`, `github-app-auth.ts`, `heartbeat-retry-scheduling.test.ts`, `environment-runtime.ts`, `heartbeat-run-summary.ts`, `companySkillService`, `execution-workspace-cleanup.ts`, `process-loss-classification.ts`, `redaction.ts`, `agent-invokability.ts`, `conflict`, `services/execution-workspaces.ts`, `services/issue-tree-control.ts`, `heartbeat-stop-metadata.ts`, `services/index.ts`, `run-scratch.ts`, `local-service-supervisor.ts`, `environment-run-orchestrator.ts`, `run-liveness.ts`, `input`, `task-watchdogs.ts`, `unprocessable`, `normalizeIssueExecutionPolicy`, `config.ts`, `execution-allowlist.ts`, `extractWakeCommentIds`, `asNumber`, `heartbeat-hintless-transient-upstream.test.ts`, `hot-restart.ts`, `recoveryService`, `visibleIssueCondition`, `parseIssueExecutionState`, `penstock-availability-gate.test.ts`, `productivityReviewService`, `pull-request-work-products.ts`, `terminal-gate-reconciler.ts`, `sweep-wake-preflight.ts`, `budgetService`, `issue-checkout-status.ts`, `execution-workspace-policy.ts`, `reconcileStrandedRecoveryWakeBackstopImpl`, `run-log-terminal-result.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `executionWorkspaceService()` connect `services/execution-workspaces.ts` to `visibleIssueCondition`, `services/issues.ts`, `services/projects.ts`, `unprocessable`, `normalizeIssueExecutionPolicy`, `execution-workspace-policy.ts`, `issue-recovery-actions.ts`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `buildHostServices()` connect `plugin-host-services.ts` to `app.ts`, `plugin-secrets-handler.ts`, `accessService`, `issueService`, `secretService`, `documents.ts`, `authorizationService`, `plugin-metric-exposition.test.ts`, `live-events.ts`, `plugin-orchestration-apis.test.ts`, `heartbeatService`, `redaction.ts`, `services/execution-workspaces.ts`, `services/index.ts`, `plugin-database.ts`, `services/projects.ts`, `issue-thread-interactions.ts`, `agentService`, `plugin-state-store.ts`, `pluginManagedRoutineService`, `plugin-managed-agents.ts`, `plugin-managed-skills.ts`, `budgetService`, `pluginRegistryService`?**
  _High betweenness centrality (0.000) - this node is a cross-community bridge._
- **Are the 41 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 41 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `executeKeyedCommentEffect()`) actually correct?**
  _`issueRoutes()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _3699 weakly-connected nodes found - possible documentation gaps or missing edges._
# Graph Report - src  (2026-10-09)

## Corpus Check
- 1226 files · ~3,184,590 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 15659 nodes · 39285 edges · 526 communities (461 shown, 65 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 944 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7cc27afb`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- errorHandler
- costs-service.test.ts
- logActivity
- issue-create-deduplication-routes.test.ts
- instanceSettingsService
- services/company-skills.ts
- services/pipelines.ts
- routes/issues.ts
- services/built-in-agents.ts
- recovery/service.ts
- workspace-runtime.ts
- services/plugin-loader.ts
- github-webhook.ts
- routes/pipelines.ts
- embedded-postgres.ts
- k8s-job-liveness.ts
- environmentRoutes
- services/tool-gateway.ts
- services/tool-access.ts
- routes/access.ts
- issueRoutes
- approvals-service.test.ts
- issueService
- productivity-review.ts
- services/teams-catalog.ts
- plugins.ts
- environment-config.ts
- evidence-gate.ts
- middleware/auth.ts
- services/cloud-upstreams.ts
- secretService
- registry.ts
- tool-access-policy.ts
- toolAccessService
- services/attention.ts
- cases.ts
- PluginWorkerManager
- productivityReviewService
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
- readNonEmptyString
- authorization.ts
- github-review-gate-authority.ts
- ensurePersistedExecutionWorkspaceAvailable
- tool-gateway.test.ts
- external-runtime-reservations.ts
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
- createPluginJobScheduler
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
- index.ts
- documentAnnotationService
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- startServer
- config.ts
- recovery/index.ts
- routes/approvals.ts
- agent-instructions.ts
- unprocessable
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- normalizeIssueExecutionPolicy
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe-k8s.test.ts
- heartbeatService
- plugin-runtime-sandbox.ts
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
- logger.ts
- ui-branding.ts
- agent-cross-tenant-authz-routes.test.ts
- agent-permissions-routes.test.ts
- heartbeat-workspace-branch-containment.test.ts
- file-resources.ts
- company-artifacts.ts
- enqueueWakeup
- plugin-config-masking.ts
- tool-oauth-legacy-backfill.ts
- api-compression.ts
- git-checkout-identity.ts
- live-events-ws.ts
- normalizeAgentDefaultsForJoin
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
- ensureHumanRoleDefaultGrants
- services/resource-memberships.ts
- heartbeat-run-runtime-status.ts
- issue-rewake-throttle.ts
- synthetic-ssh-probe.ts
- environment-custom-image-terminal-ws.test.ts
- issue-efficiency.ts
- human-gated-ageing-digest.ts
- human-gated-gate-revalidation.ts
- companies-route-cross-company-authz.test.ts
- version.ts
- human-gated-ageing.ts
- environmentCustomImageTerminalConnectionRegistry
- worker-tier-proxy.ts
- agent-start-lock.ts
- agentRoutes
- pr-comment-review-gate.ts
- services/instance-settings.ts
- recovery-observability.ts
- aws-secrets-manager-provider.ts
- db-retry.ts
- authorizationService
- execution-workspace-cleanup.ts
- normalizeHumanRole
- approval-enforcement-reconciler.ts
- ac-policy-assignee-routing.ts
- company-portability-routes.test.ts
- environment-capabilities-k8s.test.ts
- environment-custom-image-routes.test.ts
- pipelineService
- built-in-agents.test.ts
- company-search-extract.ts
- plugin-dev-watcher.ts
- createToolRuntimeSupervisor
- ensureRuntimeServicesForRun
- FakeRuntime
- services/index.ts
- heartbeat-workspace-finalize-branch.test.ts
- issue-comment-cancel-routes.test.ts
- cursor-models.ts
- health.ts
- bootstrap-claim-routes.test.ts
- work-timeline.ts
- agent-invokability.ts
- plugin-environment-driver.ts
- issue-recovery-actions.ts
- accessService
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
- join-request-dedupe.ts
- issue-recovery-actions.test.ts
- metrics-ingest.ts
- execution-policy-bootstrap.ts
- github-write-egress-scrub.test.ts
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite-truncation.test.ts
- body
- plugin-host-service-cleanup.ts
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- dev-runner-worktree.ts
- dev-server-status.ts
- openapi-routes.test.ts
- workspace-response-withholding-guard.test.ts
- execution-allowlist.ts
- pluginManagedRoutineService
- plan-review-context.ts
- k8s-job-liveness-run-scoped.test.ts
- accessRoutes
- http-metrics-per-route.test.ts
- buildInviteOnboardingManifest
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
- model-profile-hint.ts
- runtime-api.ts
- pluginRegistryService
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- isPlainRecord
- local-encrypted-provider.ts
- terminal-gate-reconciler.ts
- workspace-operation-log-store.ts
- agent-test-environment-routes.test.ts
- document-annotation-routes.test.ts
- external-object-routes.test.ts
- issue-activity-events-routes.test.ts
- renderYamlBlock
- middleware/index.ts
- project-goal-telemetry-routes.test.ts
- routine-document-annotation-routes.test.ts
- summary-slot-routes.test.ts
- ccrotate-state-hook.ts
- managed-checkout-push-guard.ts
- plugin-secrets-handler.ts
- summarySlotService
- issue-monitor-convergence-guard.test.ts
- branch-run-claims.ts
- project-env-response-boundary.test.ts
- dev-runner-snapshot.test.ts
- company-branding-route.test.ts
- heartbeat-accepted-plan-workspace-refresh.test.ts
- heartbeat-retry-scheduling.test.ts
- invite-accept-existing-member.test.ts
- issue-closed-workspace-routes.test.ts
- project-routes-env.test.ts
- ensure
- issue-comment-effects.ts
- issue-repo-binding-guard.ts
- run-secret-redaction.ts
- agent-auth-jwt.ts
- workspace-scan.ts
- backfill-agent-bundle.ts
- agent-run-health.ts
- authorization-service.test.ts
- execution-policy-bootstrap.test.ts
- routes/activity.ts
- workspace-runtime-read-model.ts
- importBundle
- builtInAgentService
- openrouter/execute.ts
- heartbeat-timer-suppression-park-bypass.test.ts
- issue-approval-link-authorization.ts
- agent-hires-instructions-materialize.test.ts
- agent-live-run-routes.test.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- company-skills-catalog-service.test.ts
- evidence-truth.ts
- node:http
- instrumentation.ts
- http-log-policy.ts
- redact-sensitive.ts
- issue-blocker-diagnostics-routes.test.ts
- fd-class-metrics.ts
- ccrotate-capacity-retry.ts
- pluginCapabilityValidator
- pr-review-state-reconciler.ts
- issue-wake-diagnostics-routes.test.ts
- attachment-types.ts
- invite-rate-limit.ts
- live-events.ts
- plugin-event-bus.ts
- process-loss-classification.ts
- managed-checkout-partial-clone.ts
- strand-comment-provider-capacity.test.ts
- config
- execution-workspaces-service.test.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- asNumber
- claude-agent-id-header.ts
- agent-shell-guard.ts
- routes/decision-training.ts
- .call
- zodToOpenApiSchema
- heartbeat-provider-capacity-horizon.test.ts
- company-export-readme.ts
- company-search-service.test.ts
- collectEvidence
- lifecycle-hook-command-audit.ts
- readProjectWorkspaceRuntimeConfig
- boardAuthService
- penstock-availability-gate.ts
- approval-budget-assertion-required.test.ts
- input
- plugin-activation-boot-retry.test.ts
- setup-supertest.ts
- teams-catalog-routes.test.ts
- pr-review-request-ageing-producer.ts
- scrape-metrics-collector.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- OAuthMintBearer
- buildRunEventRuntimeProgress
- pipeline-case-outputs.ts
- routines-service.test.ts
- successful-run-handoff-state.ts
- pipelines-service.test.ts
- pluginLifecycleManager
- cli-auth-routes.test.ts
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- feedback-service.test.ts
- recovery-stale-issue-lock-sweep.test.ts
- exportBundle
- approval-create-issue-link-authorization.test.ts
- user-profiles.ts
- issue-graph-liveness.ts
- key
- pull-request-work-products.ts
- linear-webhook.test.ts
- SmokeLabService
- dev-watch-ignore.ts
- first-admin-claim.ts
- approval-link-route-equivalence.test.ts
- applyDocumentFixups
- github-fetch.ts
- heartbeat-issue-liveness-escalation.test.ts
- routine-scheduler-heartbeat.ts
- done-gate.ts
- heartbeat-stale-queue-invalidation.test.ts
- plugin-config-write-race.test.ts
- agent-profile-change-gate-mixing.test.ts
- approval-agent-config-authz-routes.test.ts
- isPlainRecord
- services/agent-image-bump.ts
- board-chat.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- invite-summary-route.test.ts
- invite-test-resolution-route.test.ts
- pr-comment-review-gate-check.test.ts
- agent-budget-mirror-write.test.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- company-search-rate-limit.ts
- issue-execution-lock.test.ts
- heartbeat-hard-stale-subprocess-liveness.test.ts
- plugin-webhook-not-ready-retryable.test.ts
- sweep-wake-preflight.test.ts
- in-review-gate.ts
- agent-hire-source-issue-authorization.test.ts
- issue-create-pr-review-duplicate-routes.test.ts
- access-routes-permissions-upgrade.test.ts
- createToolGatewayService
- HEARTBEAT.md -- CEO Heartbeat Checklist
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- plugin-status-metrics.ts
- readPenstockCapacity
- logger-tz.test.ts
- github-review-posted-metric.test.ts
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- environment-instance-routes.test.ts
- Ally — Consolidated PR Review
- routes/companies.ts
- issue-runtime-service-command-masking.test.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- deriveSkillExportDirCandidates
- buildPortableProjectWorkspaces
- agent-budgets-route-config-revision.test.ts
- blocked-inbox-count-list-parity.test.ts
- issue-dependency-wakeups-routes.test.ts
- plugin-metric-exposition.test.ts
- scrape-metrics-collector.test.ts
- trust-proxy.ts
- privateHostnameGuard
- invite-defaults-response-boundary.test.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- resolveSource
- heartbeat-worker-crash-marking.test.ts
- syncPipelineStageAutomation
- plugin-config-masking.test.ts
- pr-review-issue-scope-locks.test.ts
- plugin-manifest-validator.ts
- smoke-lab.test.ts
- heartbeat-reviewer-evidence-live-head.test.ts
- execution-lock-orphan-cleanup.test.ts
- issue-stale-execution-lock-routes.test.ts
- issue-monitor-convergence-message.test.ts
- inspectExecutionWorkspaceBranchForReconcile
- issue-monitor-queue-lock.ts
- plugin-event-outbox.ts
- nextCronTickInTimeZone
- shared-checkout-occupancy.test.ts
- agents-service-secret-bindings.test.ts
- chain
- environment-probe.test.ts
- Ally — Consolidated PR Review
- human-gated-gate-revalidation-backfill.test.ts
- ceo/AGENTS.md
- companySkillService
- EnvironmentRuntimeDriver
- redactIssueMonitorExternalRef
- penstock-availability-gate.test.ts
- wake-idempotency.test.ts
- ensureServerWorkspaceLinksCurrent
- Ally — Consolidated PR Review
- recoverClaimedReviewWithUnavailableVerification
- heartbeat-worktree-suppression.test.ts
- issue-denied-write-recovery-persistence.test.ts
- pod-failure-label-corpus.test.ts
- issue-assignment-wakeup.ts
- applyIssueExecutionPolicyTransition
- agent-auth-middleware.test.ts
- plugin-worker-invocation-scope.cjs
- issue-blocked-patch-comment-drop.test.ts
- issue-checkout-routine-lock-conflict.test.ts
- issue-release-lock-only-degrade.test.ts
- pen3139-transcript-credential-shapes.test.ts
- workspace-operation-secret-scrub.test.ts
- reflection-coach/AGENTS.md
- Recent agent reflection sweep
- summarizer/AGENTS.md
- Refresh stale summary slots
- validateTerminalUpgrade
- RunLogStore
- environment-runtime-driver-contract.test.ts
- metrics-route-no-db.test.ts
- SOUL.md -- CEO Persona
- Wake Pre-flight (do this FIRST when woken)
- startHttpSidecar
- agent-instructions-service.test.ts
- authz-existence-oracle-guard.test.ts
- plugin-worker-delayed.cjs
- plugin-worker-terminated.cjs
- healthz-probe-route.test.ts
- postgres-pool-budget.test.ts
- default/AGENTS.md
- recovery-pause-hold-guard-call-shape.test.ts
- startup-dispatch-isolation.test.ts
- express.d.ts
- TOOLS.md

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 578 edges
2. `unprocessable()` - 377 edges
3. `issueRoutes()` - 376 edges
4. `notFound()` - 337 edges
5. `issueService()` - 257 edges
6. `logActivity()` - 253 edges
7. `executeRun()` - 240 edges
8. `recoveryService()` - 234 edges
9. `parseObject` - 192 edges
10. `forbidden()` - 184 edges

## Surprising Connections (you probably didn't know these)
- `mockSettings()` --indirect_call--> `instanceSettingsService()`  [INFERRED]
  __tests__/quota-exhausted-hook.test.ts → services/instance-settings.ts
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

## Communities (526 total, 65 thin omitted)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (483): getServerAdapter(), appendWithByteCap, resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), cache, CacheEntry, computeBranchClaimKey(), releaseBranchRunClaimForKey() (+475 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (166): ParsedExecutionWorkspaceMode, getDefaultCompanyGoal(), GoalReader, ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS, AcceptedPlanDecompositionInput, AcceptedPlanDocumentInteraction, activeRunMapForIssues(), activeRunMapKey() (+158 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.05
Nodes (49): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), buildLegacyRoutineTriggerFromRecurrence(), collectSelectedExportSlugs(), COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS (+41 more)

### Community 3 - "errorHandler"
Cohesion: 0.03
Nodes (56): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), normalizeResponsibleUserDenialCode() (+48 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.14
Nodes (14): createApp(), createAppWithActor(), loadCostParsers(), makeDb(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyService (+6 more)

### Community 5 - "logActivity"
Cohesion: 0.03
Nodes (160): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), PRECOMPRESSED_STATIC_EXTENSIONS, resolveViteHmrHost(), resolveViteHmrPort() (+152 more)

### Community 6 - "issue-create-deduplication-routes.test.ts"
Cohesion: 0.15
Nodes (10): findCreateIssueDuplicateCandidates(), ISSUE_CREATE_DUPLICATE_CANDIDATE_LATENCY_BUDGET_MS, ISSUE_CREATE_DUPLICATE_CANDIDATE_ROW_CAP, ISSUE_CREATE_DUPLICATE_CANDIDATE_SCAN_CAP, ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS, createApp(), FilingFixture, monitorFilings (+2 more)

### Community 7 - "instanceSettingsService"
Cohesion: 0.04
Nodes (98): appendWithCap, readObject(), redactCurrentUserValue(), maskWorkspaceRuntimeForRead(), maskEntry(), maskWorkspaceRuntimeTextForRead(), resolveAgentSelfTrustPreset(), readRunIssueId() (+90 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.03
Nodes (167): skillImportPolicyResource(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillKeyAllowed(), assertImportedSkillSourceAllowed(), assertNoSymlinksInLocalTree(), assertVersionMatchesSkill(), asString(), auditInstalledSkillBytes() (+159 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.04
Nodes (95): actorOwnsLease(), addFormVariablesForStage(), adjustParentCounts(), assertActorCanApproveStageExit(), assertCaseKey(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable() (+87 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (151): ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema, AutoApprovalIssueMissingError, blockerDiagnosticLabel() (+143 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.05
Nodes (43): reconcileApprovedBuiltInAgent(), BUILT_IN_AGENT_DEFAULT_GRANTS, BUILT_INS_DIR, BuiltInAgentBundleDefinition, BuiltInAgentDefinition, builtInAgentNotConfiguredError(), BuiltInAgentProvisionActor, BuiltInAgentProvisionInput (+35 more)

### Community 12 - "recovery/service.ts"
Cohesion: 0.01
Nodes (320): redactRunResultJson(), isTerminalIssueStatus(), shouldReopenTerminalIssueForDeferredWake(), checkoutRestoreStatusExpression, checkoutRestoreTargetStatus, DbOrTransaction, hasCancelledBlocker, hasPendingBlocker (+312 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (98): ExecutionWorkspaceTeardownTrigger, recordExecutionWorkspaceTeardown(), assertDirtyQuarantineRuntimeServicesStopped(), branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), buildExecutionWorkspaceCleanupEnv(), buildNonInteractiveGitEnv(), buildWorkspaceTemplateData() (+90 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.02
Nodes (112): isIsolatedSdkPluginPackage(), ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH, BOOT_ACTIVATION_RETRY_PATTERN (+104 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (193): redactSensitiveText(), acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody() (+185 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (89): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertPipelineAccess(), assertPipelineCompanyAccess(), assertPipelineWriteAccess() (+81 more)

### Community 17 - "embedded-postgres.ts"
Cohesion: 0.03
Nodes (39): runningProcesses, DEP_BLOCKED_MAX_RETRY_ATTEMPTS, DEP_BLOCKED_RETRY_REASON, mockAdapterExecute, mockAdapterExecute, mockGbrainCall, mockAdapterExecute, getRunStatus() (+31 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.06
Nodes (56): cancelExternalRuntimeReservationHoldersForAgent(), cleanupManagedJobsWithoutRun(), cleanupOrphanedManagedPods(), resolveExternalLifecycleJobLiveness(), resumeRunningExternalRuntimeRuns(), ADAPTER_TYPE_LABEL, AGENT_POD_BUSY_CPU_MILLICORES, AGENT_POD_HARD_STALE_MS (+48 more)

### Community 19 - "environmentRoutes"
Cohesion: 0.11
Nodes (20): environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment(), environmentDeleteBlockMessage(), logEnvironmentCustomImageActivity() (+12 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (48): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), auditSafeEndpoint() (+40 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.06
Nodes (44): createCompanyInviteForCompany(), agentJoinGrantsFromDefaults(), AvailableSkill, companyInviteExpiresAt(), CompanyMemberRecord, createInviteToken(), defaultInviteResolutionNetwork, grantsFromDefaults() (+36 more)

### Community 23 - "issueRoutes"
Cohesion: 0.02
Nodes (118): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), authenticatedActorResponsibleUserId(), buildCreateIssueActivityStatusDetails(), compactIssueListEtag(), companySearchRateLimitActor(), emptyWorkspaceNameMaps(), estimatedJsonBytes() (+110 more)

### Community 24 - "approvals-service.test.ts"
Cohesion: 0.09
Nodes (12): ApprovalRecord, expectRejectedWithoutMutation(), mockAgentService, mockLogActivity, mockNotifyHireApproved, readStatus(), withdrawalActor, candidate() (+4 more)

### Community 25 - "issueService"
Cohesion: 0.03
Nodes (82): MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId(), activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition() (+74 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.04
Nodes (81): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, DbOrTx, DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS, DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS, DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS (+73 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (61): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+53 more)

### Community 28 - "plugins.ts"
Cohesion: 0.03
Nodes (62): AvailableBundledPlugin, bundledPluginMetadata(), __dirname, discoverBundledPlugins(), DiscoveredBundledPlugin, EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES, fileExists(), findPackageJsonFiles() (+54 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.10
Nodes (42): collectEnvironmentSecretRefs(), createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe() (+34 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (55): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+47 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.12
Nodes (25): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+17 more)

### Community 32 - "services/cloud-upstreams.ts"
Cohesion: 0.05
Nodes (77): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), buildWarnings() (+69 more)

### Community 33 - "secretService"
Cohesion: 0.05
Nodes (74): HttpError, getSecretProvider(), isSecretProviderClientError(), asRecord(), assertClass3StaticLeaseAllowed(), assertSelectableProviderConfig(), CanonicalEnvBinding, canonicalizeBinding() (+66 more)

### Community 34 - "registry.ts"
Cohesion: 0.05
Nodes (56): acpxLocalAdapter, adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks, claudeLocalAdapter, codexLocalAdapter, cursorCloudAdapter (+48 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (71): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+63 more)

### Community 36 - "toolAccessService"
Cohesion: 0.04
Nodes (131): parseRemoteHttpEndpoint(), asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor(), readStdioTemplateId() (+123 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.06
Nodes (53): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+45 more)

### Community 38 - "cases.ts"
Cohesion: 0.05
Nodes (55): annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany(), assertProjectBelongsToCompany(), autoLinkRunIssue(), buildCasePatchUpdateValues() (+47 more)

### Community 39 - "PluginWorkerManager"
Cohesion: 0.04
Nodes (26): PluginRouteToolDeps, PluginRouteWebhookDeps, LifecycleEventName, LifecycleEventPayload, PluginLifecycleEvents, PluginLifecycleManagerOptions, VALID_TRANSITIONS, createPluginToolDispatcher() (+18 more)

### Community 40 - "productivityReviewService"
Cohesion: 0.06
Nodes (66): buildThresholds(), extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isApprovalGatedSuppression(), isMonitorScheduledSuppression(), isSoftStopTrigger(), isTerminalGateClosableTriggerSet(), isTerminalIssueStatus() (+58 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.07
Nodes (61): applyCustomImageTemplateToSandboxConfig(), classifyEnvironmentCustomImageConfigChange(), defaultEnvironmentCustomImageRuntimeConfigBinding(), ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS, ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS, EnvironmentCustomImageConfigChangeKind, EnvironmentCustomImageRuntimeConfigBinding (+53 more)

### Community 42 - "feedback.ts"
Cohesion: 0.10
Nodes (48): appendNote(), asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildClaudeTraceFiles(), buildCodexTraceFiles() (+40 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (196): createBetterAuthHandler(), normalizeAuthLocationHeader(), counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), AGENT_ERROR_REASON_NONE (+188 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.08
Nodes (61): AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments(), directoryResource() (+53 more)

### Community 45 - "openapi.ts"
Cohesion: 0.05
Nodes (42): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+34 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.12
Nodes (27): CatalogManifestFile, CatalogManifestUnavailableError, devCatalogManifestPath, devCatalogPackageRoot, getCatalogManifest(), getCatalogPackageMetadata(), getCatalogSkills(), inferLanguageFromPath() (+19 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.05
Nodes (95): asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyWorkflowRunNotFound(), encodeGitRefPath(), exactGithubLogin() (+87 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (37): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), buildRoutineRevisionSnapshot(), canonicalSnapshot(), collectProvidedRoutineVariables() (+29 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (15): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+7 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 51 - "environment-runtime.ts"
Cohesion: 0.09
Nodes (34): stripSandboxProviderEnvelope(), buildReusableSandboxLeaseScope(), resolvePluginDriver(), resolvePluginDriverForRelease(), createSandboxEnvironmentDriver(), cleanupObsoleteReusableSandboxLeases(), destroyReusableSandboxLease(), releasePluginBackedSandboxLease() (+26 more)

### Community 52 - "readNonEmptyString"
Cohesion: 0.22
Nodes (16): asRecord(), capacityRetryFromBody(), defaultCapacityRetry(), isPenstockCapacityBody(), mapAdapterToPenstockProvider(), parseCapacityResetIso(), parseCapacityRetry(), parseOptionalDate() (+8 more)

### Community 53 - "authorization.ts"
Cohesion: 0.07
Nodes (42): GrantInput, MemberArchiveInput, MembershipRow, AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect (+34 more)

### Community 54 - "github-review-gate-authority.ts"
Cohesion: 0.05
Nodes (55): GithubWebhookConfig, activateGithubReviewGateDelivery(), affectsProtectedBase(), Candidate, claimDueGithubReviewGateDeliveries(), COMMENT_ACTIONS, commentSignals(), createRepositoryDispatch() (+47 more)

### Community 55 - "ensurePersistedExecutionWorkspaceAvailable"
Cohesion: 0.10
Nodes (44): describeSubmoduleInspectionDegradation(), detectDefaultBranch(), directoryExists(), ensureGitSubmodulesReady(), ensureGitWorktreeBranchCoherent(), ensurePersistedExecutionWorkspaceAvailable(), findVerifiedManagedProjectPrimaryCheckout(), formatCommandForDisplay() (+36 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.09
Nodes (6): awaitRateLimitWindow(), createApprovedToolAction(), createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "external-runtime-reservations.ts"
Cohesion: 0.10
Nodes (33): bindExternalRuntimeReservationIsolation(), claimRunWithExternalRuntimeSlot(), claimRunWithExternalRuntimeSlotOutcome(), claimRunWithExternalRuntimeSlotPool(), ExternalRuntimeClaim, ExternalRuntimeIsolationConflictError, ExternalRuntimeIsolationMode, ExternalRuntimeJobNameMismatchError (+25 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.04
Nodes (101): asRecord(), containAgentConfig(), containAgentMetadata(), containsRedactedAdapterValue(), isRedactedEnvBinding(), keepSanitizedAgentMetadata(), OMIT_REDACTED_ADAPTER_VALUE, redactAgentSecrets() (+93 more)

### Community 60 - "adapters.ts"
Cohesion: 0.10
Nodes (46): BUILTIN_ADAPTER_TYPES, buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter() (+38 more)

### Community 61 - "conflict"
Cohesion: 0.11
Nodes (45): conflict(), archiveMember(), assertAssignableArchiveTarget(), assertCanRemoveActiveOwner(), updateMember(), updateMemberAndPermissions(), buildFolderViews(), FolderRow (+37 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.09
Nodes (39): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), ExecutionWorkspaceBranchReconcileActor, ExecutionWorkspaceBranchReconcileInspection (+31 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.07
Nodes (48): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+40 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.08
Nodes (39): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+31 more)

### Community 65 - "sandbox-provider-runtime.ts"
Cohesion: 0.07
Nodes (26): AcquireSandboxLeaseInput, acquireSandboxProviderLease(), assertProviderConfig(), buildFakeSandboxProbe(), DestroySandboxLeaseInput, FakeSandboxProvider, findReusableSandboxProviderLeaseId(), getSandboxProvider() (+18 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.13
Nodes (20): createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), createLocalDiskStorageProvider(), normalizeObjectKey(), resolveWithin(), createStorageProviderFromConfig(), assertPutFileInput() (+12 more)

### Community 67 - "issue-attachment-routes.test.ts"
Cohesion: 0.09
Nodes (24): DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody(), Frame (+16 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.06
Nodes (39): PluginRouteJobDeps, advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron() (+31 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.07
Nodes (27): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), derivePluginDatabaseNamespace(), extractQualifiedRefs(), normaliseSql(), PluginDatabaseClient (+19 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.12
Nodes (40): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+32 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.10
Nodes (32): recordProjectPrimaryWorkspaceFallback(), attachGoals(), attachListMetrics(), attachWorkspaces(), buildManagedProjectDefaults(), buildProjectListMetricMaps(), CreateWorkspaceInput, deriveNameFromCwd() (+24 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (33): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+25 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.07
Nodes (39): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+31 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.05
Nodes (65): assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult(), buildTaskCreationOrder(), buildWithdrawnInteractionResult() (+57 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.06
Nodes (37): RFC-1918, normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier() (+29 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.12
Nodes (34): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+26 more)

### Community 77 - "badRequest"
Cohesion: 0.09
Nodes (41): badRequest(), parseDateQuery(), parseIntegerQuery(), parseKind(), computeETag(), MIME_TYPES, PluginUiStaticRouteOptions, pluginUiStaticRoutes() (+33 more)

### Community 78 - "agentService"
Cohesion: 0.08
Nodes (53): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed(), assertCompanyShortnameAvailable(), assertNoCycle() (+45 more)

### Community 79 - "company-search.ts"
Cohesion: 0.08
Nodes (54): activeIssueFilters(), artifactResult(), companySearchService(), countAgents(), countArtifacts(), countProjects(), countTotalNonIssue(), enrichIssueSnippets() (+46 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.05
Nodes (66): watchdogMapForIssues(), TASK_WATCHDOG_ORIGIN_KIND, ActorFields, assertWatchdogAgentInvokable(), assertWatchedIssue(), buildStoppedFingerprintComment(), classifyTaskWatchdogSubtree(), isActiveTaskWatchdogUniqueConflict() (+58 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.09
Nodes (22): FETCH_BLOCKED_PORTS, FIXTURE_TOOLS, FixtureTool, HTTP_SERVICE_ID, isReadOnly(), OAUTH_SERVICE_ID, OAuthCodeRecord, OAuthTokenRecord (+14 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.07
Nodes (32): WorkspaceOperationRecorder, executeProcessForTests, GIT_INDEX_LOCK_STALE_MS, isProcessGroupAliveForTests, LockHolderScan, setLockHolderScanForTests(), setProcessGroupLivenessProbeForTests(), setSubmoduleInspectSettingsForTests() (+24 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (34): HEARTBEAT_RUN_FAILED_METRIC, PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, drainInFlightExecutions(), expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts() (+26 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "index.ts"
Cohesion: 0.07
Nodes (35): BUNDLED_PLUGIN_PACKAGES, autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin() (+27 more)

### Community 87 - "documentAnnotationService"
Cohesion: 0.08
Nodes (17): ActorInput, CaseDocumentRow, commentSelect, documentAnnotationService(), assertLinkedIssueComment(), IssueDocumentRow, RoutineDocumentRow, snapshotFromThread() (+9 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.08
Nodes (32): AuthenticatedTerminalContext, clientSafeErrorMessage(), closeClient(), closeUpgradeSocket(), createSsh2EnvironmentCustomImageSshConnector(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, decodeClientMessage(), EnvironmentCustomImageSshConnector (+24 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "startServer"
Cohesion: 0.06
Nodes (54): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge() (+46 more)

### Community 91 - "config.ts"
Cohesion: 0.05
Nodes (56): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), readConfigFile(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS (+48 more)

### Community 92 - "recovery/index.ts"
Cohesion: 0.03
Nodes (120): addContinuationExhaustedCommentOnce(), addSuccessfulRunHandoffCommentOnce(), buildDetectedSuccessfulRunProgressSummary(), handleRunLivenessContinuation(), handleSuccessfulRunHandoff(), hasUnmanagedBackgroundTaskEvidence(), issueUiLink(), withUnmanagedBackgroundTaskStopReason() (+112 more)

### Community 93 - "routes/approvals.ts"
Cohesion: 0.05
Nodes (54): assertHireSourceIssueLinksAllowed(), ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext(), assertIssueLinksAllowed(), requireApprovalAccess() (+46 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.17
Nodes (39): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+31 more)

### Community 95 - "unprocessable"
Cohesion: 0.06
Nodes (54): notFound(), unprocessable(), assertAgentDefaultEnvironmentSelection(), normalizeAgentReference(), assertBuiltInAgentsEnabled(), validatePolicyBody(), assertActiveUserMembership(), enforceScopedApiCheckout() (+46 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.17
Nodes (21): asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent, HotRestartIntentRun, HotRestartReport (+13 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.07
Nodes (32): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+24 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (17): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+9 more)

### Community 99 - "normalizeIssueExecutionPolicy"
Cohesion: 0.08
Nodes (46): hasScheduledMonitor(), classifySourceRecoveryRevalidation(), isLapsedMonitorRearmPatch(), summarizeIssueMonitor(), clearIssueMonitorAndRecover(), dispatchClaimedIssueMonitor(), monitorRecoveryPolicy(), reconcileUndeliverableIssueMonitors() (+38 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (26): installActor(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectLimit, mockDbSelectOrderBy (+18 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.09
Nodes (28): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+20 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "heartbeatService"
Cohesion: 0.02
Nodes (280): parseObject, publishPluginDomainEvent(), countRunsOccupyingSlots(), resolveExternalLifecycleConcurrency(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds(), markAgentStartLockPhase(), isCapacityGovernedRetryFloor() (+272 more)

### Community 104 - "plugin-runtime-sandbox.ts"
Cohesion: 0.19
Nodes (12): CapabilityScopedInvoker, DEFAULT_GLOBALS, isWithinRoot(), LoadedModule, loadPluginModuleInSandbox(), looksLikeEsm(), MODULE_PATH_SUFFIXES, normalizeModuleExports() (+4 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.04
Nodes (69): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart() (+61 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.15
Nodes (22): composeSweepWakeFramePage(), currentMinuteBucket(), detectSweepWakeRace(), getIssueSnapshot(), isCompanyFlagEnabled(), listIssueBlockerIds(), listRecentComments(), maxBlockerCompletedAt() (+14 more)

### Community 107 - "issue-execution-policy-routes.test.ts"
Cohesion: 0.09
Nodes (21): createApp(), issueWithClearedStalledMonitor(), issueWithTriggeredMonitor(), makeInReviewIssue(), makeStuckReviewIssue(), mockAccessService, mockDb, mockDbInsert (+13 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (25): PluginRouteToolGatewayDeps, canonicalToolArguments(), hashToolValue(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+17 more)

### Community 109 - "budgetService"
Cohesion: 0.07
Nodes (37): budgetApprovalIdempotencyKey(), BudgetBurnEstimate, budgetService(), buildPolicySummary(), createIncidentIfNeeded(), hydrateIncidentRows(), pauseAndCancelScopeForBudget(), pauseScopeForBudget() (+29 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (22): currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService, mockEnvironmentService (+14 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.07
Nodes (34): dashboardRoutes(), parsePositiveNumber(), buildDismissedAtByKey(), sidebarBadgeRoutes(), AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput (+26 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.13
Nodes (16): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+8 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.10
Nodes (32): ActorLike, actorPrincipal(), applyIssueExecutionStageTransition(), AssigneeLike, assigneePrincipal(), blankExecutionState(), buildChangesRequestedState(), buildCompletedState() (+24 more)

### Community 115 - "logger.ts"
Cohesion: 0.05
Nodes (38): registerLinearWebhook(), registerWebhookWithToken(), startLinearTunnel(), httpLogger, logDir, logFile, logger, sharedOpts (+30 more)

### Community 116 - "ui-branding.ts"
Cohesion: 0.09
Nodes (31): readBrandedStaticIndexHtml(), tempDir(), applyUiBranding(), createFaviconDataUrl(), DEFAULT_FAVICON_LINKS, deriveColorFromSeed(), escapeHtmlAttribute(), getWorktreeUiBranding() (+23 more)

### Community 117 - "agent-cross-tenant-authz-routes.test.ts"
Cohesion: 0.09
Nodes (24): assertAuthenticated(), assertBoard(), assertCompanyAccess(), assertInstanceAdmin(), baseAgent, baseKey, createApp(), getAccessibleResource() (+16 more)

### Community 118 - "agent-permissions-routes.test.ts"
Cohesion: 0.07
Nodes (24): baseAgent, createApp(), createDbStub(), mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService (+16 more)

### Community 119 - "heartbeat-workspace-branch-containment.test.ts"
Cohesion: 0.12
Nodes (22): adapterExecute, asRecord(), BranchContainmentCallSite, createForwardBranchMismatch(), createGitRepo(), Db, drainInFlightExecutions(), execFileAsync (+14 more)

### Community 120 - "file-resources.ts"
Cohesion: 0.14
Nodes (22): activityDetails(), createFileResourceLimiter(), createFileResourceListLimiter(), denialReasonFromError(), FileResourceLimiter, fileResourceRoutes(), logDeniedAttempt(), logListDeniedAttempt() (+14 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.14
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "enqueueWakeup"
Cohesion: 0.04
Nodes (77): asString, resolveCcrotateCapacityRetry(), CcrotateTarget, mapAdapterToCcrotateTarget(), mapPenstockProviderToCcrotateTarget(), buildExecutionWorkspaceAdapterConfig(), cloneRecord(), defaultIssueExecutionWorkspaceSettingsForProject() (+69 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.12
Nodes (24): RFC-6901, AMBIGUOUS_SCHEMA_NODE, collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues(), collectStringLeaves(), declaresSecret(), DROP_KEY, hasUnsupportedSchemaKeyword() (+16 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.14
Nodes (22): awsSecretsManagerProvider, SecretProviderVaultRuntimeConfig, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind (+14 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "git-checkout-identity.ts"
Cohesion: 0.06
Nodes (43): AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), CommitAuthorRef, CommitSkipReason, ForeignCommit, ForeignCommitSelection, normalizeEmail(), NotifiableAgentRef (+35 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.09
Nodes (20): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+12 more)

### Community 128 - "normalizeAgentDefaultsForJoin"
Cohesion: 0.19
Nodes (19): buildJoinDefaultsPayloadForAccept(), canReplayOpenClawGatewayInviteAccept(), extractHeaderEntries(), generateEd25519PrivateKeyPem(), headerMapGetIgnoreCase(), headerMapHasKeyIgnoreCase(), isDefaultHermesDashboardRoot(), isPlainObject() (+11 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.09
Nodes (27): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+19 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.16
Nodes (21): refreshContinuationSummaryForRun(), AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), continuationSummaryParksExecutor(), extractContinuationSummaryNextAction(), extractMarkdownSection() (+13 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.09
Nodes (19): createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), DurableRunLogStoreOptions, isAtOrPastEnd(), normalizeKeyPrefix() (+11 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.10
Nodes (34): githubAppCredentialsConfigured(), GitHubCommitStatusState, appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), DbHandle, deliveryClaimWhere(), DeliveryRow (+26 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "utils.ts"
Cohesion: 0.12
Nodes (24): execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment(), execute(), processAdapter, summarizeStatus() (+16 more)

### Community 135 - "server-info.ts"
Cohesion: 0.16
Nodes (14): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, createServerInfoSnapshot(), getGitLocalChanges(), getServerInfoSnapshot() (+6 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.11
Nodes (8): parseWakePayloadFromMessage(), createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.10
Nodes (32): createK8sEnvironmentDriver(), createLocalEnvironmentDriver(), createSshEnvironmentDriver(), EnvironmentRuntimeService, getDriver(), requireDriver(), requireDriverKey(), findReusableSandboxLeaseId() (+24 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.06
Nodes (50): AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES, matchExclusionRule() (+42 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.06
Nodes (23): clampIssueListLimit(), extractExecutiveHoldMarker(), findActiveExecutiveHold(), OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, parseExecutiveHoldMarkerTimestamp(), appAs(), oracle() (+15 more)

### Community 140 - "getMetricsRegistry"
Cohesion: 0.05
Nodes (35): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+27 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.15
Nodes (22): assertLowTrustWorkspaceIsolation(), issueIdIsDescendantOf(), LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS, workspaceIssueWithinLowTrustBoundary(), asRecord(), deny(), hasBoundaryScope(), intersectSets() (+14 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "ensureHumanRoleDefaultGrants"
Cohesion: 0.07
Nodes (23): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, ensureRoleDefaultGrants(), backfillPrincipalAccessCompatibility(), ensureHumanRoleDefaultGrants(), GrantInput, insertMissingPrincipalGrants() (+15 more)

### Community 145 - "services/resource-memberships.ts"
Cohesion: 0.12
Nodes (14): logMembershipChange(), requireBoardUserId(), resourceMembershipRoutes(), assertBoardSelfMembershipAccess(), BoardActor, evaluatePolicy(), MembershipChangeKind, MembershipUpdateResult (+6 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.21
Nodes (17): clearAllHeartbeatRunRuntimeStatuses(), cloneStatus(), getHeartbeatRunRuntimeStatus(), HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS, HeartbeatRunRuntimeStatus, isExpired(), MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS, MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS (+9 more)

### Community 147 - "issue-rewake-throttle.ts"
Cohesion: 0.12
Nodes (21): computeIssueRewakeCooldownMs(), evaluateIssueRewakeThrottle(), isIssueRewakeNewInputActivity(), isIssueRewakeProgressActivity(), ISSUE_COMMENT_ADDED_ACTION, ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS, ISSUE_PROGRESS_ACTIVITY_ACTION_SET (+13 more)

### Community 148 - "synthetic-ssh-probe.ts"
Cohesion: 0.14
Nodes (12): classifyError(), computeMedian(), execFileAsync, extractSshHandshakeMs(), readSshdAuthAttempts(), runProbeOnce(), SyntheticProbeAlert, SyntheticProbeOptions (+4 more)

### Community 149 - "environment-custom-image-terminal-ws.test.ts"
Cohesion: 0.07
Nodes (11): EnvironmentCustomImageSshShell, closeServer(), createSession(), FakeSshShell, flushPromises(), futureDate(), listen(), require (+3 more)

### Community 150 - "issue-efficiency.ts"
Cohesion: 0.17
Nodes (16): AdapterUsage, adapterUsageForIssues(), ApportionedAdapter, apportionIssueAcrossAdapters(), CostSource, coverageForWindow(), CoverageReport, IssueEfficiency (+8 more)

### Community 151 - "human-gated-ageing-digest.ts"
Cohesion: 0.07
Nodes (43): db, MAX_PRS, token, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk(), collectDigest() (+35 more)

### Community 152 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (47): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+39 more)

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

### Community 158 - "agent-start-lock.ts"
Cohesion: 0.05
Nodes (53): AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), abortedAgentId(), abortReason(), CancellableQuery (+45 more)

### Community 159 - "agentRoutes"
Cohesion: 0.03
Nodes (99): REDACTED_ENV_SENTINEL, restoreRedactedAgentRuntimeConfig, parseOffsetParam(), agentRoutes(), actorCanReadConfigurationsForCompany(), adapterSupportsInstructionsBundle(), allowedEnvironmentDriversForAgent(), applyCodexLocalKeyIsolation() (+91 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.04
Nodes (99): classifyPrReviewComment(), isActionablePrReviewComment(), isReviewShapedPrComment(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead() (+91 more)

### Community 161 - "services/instance-settings.ts"
Cohesion: 0.10
Nodes (28): applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema, InstanceSettingsServiceOptions, isTruthyRuntimeEnvValue(), normalizeExperimentalSettings(), normalizeGeneralSettings() (+20 more)

### Community 162 - "recovery-observability.ts"
Cohesion: 0.09
Nodes (24): ACTIVE_STATUSES, classifyRecoveryHandoff(), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT, evaluateRecoveryRateAlert(), HandoffClass, MAX_WINDOW_WEEKS, RecoveryActionFacts, RecoveryActionListItem (+16 more)

### Community 163 - "aws-secrets-manager-provider.ts"
Cohesion: 0.08
Nodes (45): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), AwsSecretsManagerConfig, AwsSecretsManagerListSecretEntry (+37 more)

### Community 164 - "db-retry.ts"
Cohesion: 0.19
Nodes (12): compactErrorText(), describeDbError(), findPgError(), isDbError(), isPostgresSqlState(), isTransientDbError(), PgErrorFields, POSTGRES_SQLSTATE_CLASSES (+4 more)

### Community 165 - "authorizationService"
Cohesion: 0.10
Nodes (48): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentWithinLowTrustBoundary() (+40 more)

### Community 166 - "execution-workspace-cleanup.ts"
Cohesion: 0.07
Nodes (39): classifyRemovalProof(), decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup() (+31 more)

### Community 167 - "normalizeHumanRole"
Cohesion: 0.27
Nodes (12): approveHumanJoinRequestFromInvite(), addCompanyMemberRemovalAccess(), assertCanManageCompanyMember(), getProtectedMemberReason(), resolveActorHumanRole(), grantsForHumanRole(), HUMAN_COMPANY_MEMBERSHIP_ROLES, normalizeHumanRole() (+4 more)

### Community 168 - "approval-enforcement-reconciler.ts"
Cohesion: 0.07
Nodes (40): APPROVAL_ENFORCEMENT_DRIFT_ORIGIN_KIND, ApprovalCandidate, ApprovalCursor, approvalCursorFrom(), ApprovalEnforcementReconcileResult, ApprovalEnforcementReconcilerScheduler, asArray(), asFiniteNumber() (+32 more)

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

### Community 173 - "pipelineService"
Cohesion: 0.08
Nodes (41): redactRunError(), activityActorPatch(), assertReviewTargetsInSet(), defaultRetryCleanup(), getAncestorCases(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow(), getPipelineOrThrow() (+33 more)

### Community 174 - "built-in-agents.test.ts"
Cohesion: 0.12
Nodes (19): BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), withBuiltInAgentMarker(), findMarkedRows(), getBuiltInAgentDefinition() (+11 more)

### Community 175 - "company-search-extract.ts"
Cohesion: 0.20
Nodes (14): companySearchExtractService(), contentMatch(), escapeLikePattern(), escapeRegexPattern(), excerpt(), extractMatches(), ExtractSource, literalOccurrences() (+6 more)

### Community 176 - "plugin-dev-watcher.ts"
Cohesion: 0.11
Nodes (21): createPluginDevWatcher(), close(), handlePluginDisabled(), handlePluginEnabled(), handlePluginLoaded(), handlePluginUnloaded(), unwatchPlugin(), watchLocalPluginById() (+13 more)

### Community 177 - "createToolRuntimeSupervisor"
Cohesion: 0.14
Nodes (26): ACTIVE_SLOT_STATUSES, asRecord(), createToolRuntimeSupervisor(), activeRows(), assertCapacity(), assertLocalStdioAvailable(), assertRestartAllowed(), ensureRunningSlot() (+18 more)

### Community 178 - "ensureRuntimeServicesForRun"
Cohesion: 0.26
Nodes (17): clearIdleTimer(), ensureRuntimeServicesForRun(), persistRuntimeServiceRecord(), readConfiguredServiceStates(), readDesiredRuntimeState(), registerRuntimeService(), releaseRuntimeServicesForRun(), resetRuntimeServicesForTests() (+9 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "services/index.ts"
Cohesion: 0.03
Nodes (82): CURRENT_USER_REDACTION_TOKEN, CurrentUserCandidates, CurrentUserRedactionOptions, defaultHomeDirs(), defaultUserNames(), escapeRegExp(), getDefaultCurrentUserCandidates(), isPlainObject() (+74 more)

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
Cohesion: 0.14
Nodes (19): hasDevServerStatusToken(), healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), alertFileCandidates(), DatabaseBackupHealthStatus, DatabaseBackupHealthWarning (+11 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.13
Nodes (25): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+17 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.15
Nodes (16): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokability(), evaluateAgentInvokabilityFromDb() (+8 more)

### Community 188 - "plugin-environment-driver.ts"
Cohesion: 0.32
Nodes (15): createPluginEnvironmentDriver(), cancelPluginEnvironmentInteractiveSetup(), capturePluginEnvironmentTemplate(), deletePluginEnvironmentTemplate(), destroyPluginEnvironmentLease(), executePluginEnvironmentCommand(), getPluginEnvironmentInteractiveSetup(), pluginDriverProviderKey() (+7 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.10
Nodes (32): agentHasRecoveryHandoffGrantOnIssue(), ACTIVE_RECOVERY_ACTION_STATUSES, DbOrTransaction, isRecord(), IssueRecoveryActionRow, issueRecoveryActionService(), escalateExpiredWakeHorizons(), getActiveForIssue() (+24 more)

### Community 190 - "accessService"
Cohesion: 0.09
Nodes (30): assertBoardOrAgent(), resolveRagHealthCompanyId(), bearerToken(), callerHeaders(), decodeAuditCursor(), detailString(), encodeAuditCursor(), gatewayToken() (+22 more)

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
Nodes (20): readGithubPrReviewerAgentIds(), assertNotDuplicatePrReviewIssue(), buildPrReviewTaskKey(), candidatePullRequestRefs(), configuredPrReviewerAgentIds(), declaresNotAReviewRequest(), DuplicatePrReviewIssueGuardDb, DuplicatePrReviewIssueOptions (+12 more)

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
Cohesion: 0.11
Nodes (26): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, summarizeStrandedRecoveryHandBackPass(), AnyFn, blockSourceOnFreshIssue() (+18 more)

### Community 203 - "metrics-ingest.ts"
Cohesion: 0.12
Nodes (21): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), AGENT_DISPATCH_DECLINED_METRIC (+13 more)

### Community 204 - "execution-policy-bootstrap.ts"
Cohesion: 0.14
Nodes (18): listServerAdapters(), AdapterRegistryEnv, parseAdapterRegistryEnv(), setAdapterDisabled, reconcileAdapterAvailability(), ENTRY, KubernetesEnvironmentConfigInput, applyExecutionPolicyBootstrap() (+10 more)

### Community 205 - "github-write-egress-scrub.test.ts"
Cohesion: 0.08
Nodes (28): Coverage, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE, serverSourceDirectory, servicesDirectory, statefulSetPath (+20 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.13
Nodes (21): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+13 more)

### Community 208 - "agent-inbox-lite-truncation.test.ts"
Cohesion: 0.06
Nodes (38): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN, AGENT_INBOX_LITE_STATUS_FILTER (+30 more)

### Community 209 - "body"
Cohesion: 0.06
Nodes (20): BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, CCROTATE_CAPACITY_DEFERRED_METRIC, EXECUTION_WORKSPACE_CLEANUP_REASONS, EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC, EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC, EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES, EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC, EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC (+12 more)

### Community 210 - "plugin-host-service-cleanup.ts"
Cohesion: 0.29
Nodes (3): LifecycleLike, PluginHostServiceCleanupController, PluginWorkerRuntimeEvent

### Community 212 - "issue-document-restore-routes.test.ts"
Cohesion: 0.13
Nodes (12): createApp(), mockAccessService, mockAgentService, mockDocumentsService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockIssueThreadInteractionService (+4 more)

### Community 213 - "workspace-runtime-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): createExecutionWorkspaceApp(), createProjectApp(), mockAccessService, mockAssertCanManageExecutionWorkspaceRuntimeServices, mockAssertCanManageProjectWorkspaceRuntimeServices, mockEnvironmentService, mockExecutionWorkspaceService, mockGetTelemetryClient (+6 more)

### Community 214 - "pr-review-request-ageing.ts"
Cohesion: 0.12
Nodes (31): AgedReviewRequest, AgedReviewRequestReport, AGENT_AUTHOR_LOGINS, AGENT_AUTHOR_SET, ALLY_REVIEW_IDENTITY_LOGINS, ALLY_REVIEW_IDENTITY_SET, ANSWERING_REVIEW_STATES, answeringHumanReviews() (+23 more)

### Community 215 - "dev-runner-worktree.ts"
Cohesion: 0.29
Nodes (10): bootstrapDevRunnerWorktreeEnv(), expandHomePrefix(), isLinkedGitWorktreeCheckout(), parseEnvFile(), repairStaleMigratedWorktreeEnvEntries(), resolveDefaultWorktreeHome(), resolveHomeAwarePath(), resolveWorktreeEnvFilePath() (+2 more)

### Community 216 - "dev-server-status.ts"
Cohesion: 0.24
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.15
Nodes (19): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+11 more)

### Community 218 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "pluginManagedRoutineService"
Cohesion: 0.22
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 221 - "plan-review-context.ts"
Cohesion: 0.44
Nodes (8): authorFrom(), buildPlanReviewContext(), BuildPlanReviewContextInput, getPlanInteractionContext(), nonEmptyString(), readPlanTarget(), readResult(), truncateText()

### Community 222 - "k8s-job-liveness-run-scoped.test.ts"
Cohesion: 0.17
Nodes (9): FakeBatchV1Api, FakeCoreV1Api, FakeKubeConfig, mockDeleteNamespacedJob, mockListNamespacedJob, mockListNamespacedPod, mockReadNamespacedJob, mockRereadAs() (+1 more)

### Community 223 - "accessRoutes"
Cohesion: 0.09
Nodes (28): tooManyRequests(), accessRoutes(), assertInstanceAdmin(), getInviteCompanyBranding(), getInviteLogoAsset(), actorHasActiveUserMembership(), buildCliAuthApprovalPath(), claudeHomeDisplayLabel() (+20 more)

### Community 224 - "http-metrics-per-route.test.ts"
Cohesion: 0.10
Nodes (27): composeRouteLabel(), httpMetricsMiddleware(), InstrumentableResponse, INSTRUMENTED, isApiPath(), isEmptyListBody(), API_PIPELINE_STALL_MS, ApiPipelineStatus (+19 more)

### Community 225 - "buildInviteOnboardingManifest"
Cohesion: 0.15
Nodes (16): buildInviteOnboardingManifest(), buildInviteOnboardingTextDocument(), buildOnboardingConnectionCandidates(), buildOnboardingDiscoveryDiagnostics(), extractInviteHumanRole(), extractInviteMessage(), inviteExpired(), inviteState() (+8 more)

### Community 226 - "ac-policy-sweep.ts"
Cohesion: 0.27
Nodes (10): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+2 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.12
Nodes (18): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, EnvironmentCustomImageTerminalPayloadValidationResult, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken() (+10 more)

### Community 228 - "feedback-redaction.ts"
Cohesion: 0.29
Nodes (11): applyPattern(), FeedbackRedactionState, FREE_TEXT_PATTERNS, increment(), isPlainRecord(), PatternReplacement, recordField(), RedactionPattern (+3 more)

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
Cohesion: 0.08
Nodes (31): awaitingUserInputReason(), createIssueDependencyReadiness(), findBlockedPromotionsAwaitingUserInput(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds() (+23 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "model-profile-hint.ts"
Cohesion: 0.11
Nodes (28): toIssueActiveRunRow(), isPlanningOnlyRecoveryContextSnapshot(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS, RECOVERY_MODEL_PROFILE_KEY (+20 more)

### Community 244 - "runtime-api.ts"
Cohesion: 0.56
Nodes (9): buildRuntimeApiCandidateUrls(), choosePrimaryRuntimeApiUrl(), collectReachableInterfaceHosts(), formatOrigin(), isLinkLocalHost(), isLoopbackHost(), isWildcardHost(), normalizeHost() (+1 more)

### Community 245 - "pluginRegistryService"
Cohesion: 0.09
Nodes (15): main(), readStdin(), LinearWebhookFixture, loadLinearWebhookFixtures(), sanitizeLinearWebhookFixture(), sanitizeLinearWebhookValue(), SECRET_HEADER_NAMES, createPluginJobCoordinator() (+7 more)

### Community 246 - "routineService"
Cohesion: 0.08
Nodes (37): incrementRoutineDispatchMetric(), deriveRoutineFireAgeHorizonMs(), mapRoutineDescriptionDocument(), mapRoutineRevision(), nextResultText(), normalizeWebhookTimestampMs(), routineService(), appendRoutineRevision() (+29 more)

### Community 247 - "renderMetrics"
Cohesion: 0.04
Nodes (45): BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), CRASH_RECOVERY_CANDIDATE_INDEX_NAME, CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC, DB_POOL_CONNECTIONS_METRIC (+37 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "isPlainRecord"
Cohesion: 0.20
Nodes (27): asBoolean(), asString(), buildManifestFromPackageFiles(), buildYamlFile(), clonePortableRecord(), deriveManifestSkillKey(), derivePortableCommentAuthorType(), exportPortableProjectExecutionWorkspacePolicy() (+19 more)

### Community 250 - "local-encrypted-provider.ts"
Cohesion: 0.10
Nodes (27): resolveDefaultSecretsKeyFilePath(), AwsSecretsManagerMaterial, asLocalEncryptedMaterial(), decodeMasterKey(), encryptValue(), enforceKeyFilePermissionsBestEffort(), inspectLocalEncryptedHealth(), loadOrCreateMasterKey() (+19 more)

### Community 251 - "terminal-gate-reconciler.ts"
Cohesion: 0.11
Nodes (25): PullRequestGateResult, buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler, gateSignalDigestSql, listCandidateIssues(), listExistingResolutionKeys(), listResolvedTerminalGates() (+17 more)

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
Cohesion: 0.53
Nodes (6): compareYamlKeys(), isEmptyObject(), orderedYamlEntries(), renderFrontmatter(), renderYamlBlock(), renderYamlScalar()

### Community 258 - "middleware/index.ts"
Cohesion: 0.04
Nodes (41): createApp(), mockBumpAgentImagesForCompany, createApp(), mockFolderService, mockLogActivity, createApp(), mockEnvironmentService, mockHeartbeatService (+33 more)

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

### Community 263 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.11
Nodes (27): versionMaterialHasValueDigest(), assertSecretRefBinding(), coerceLegacySecretRef(), countUuidValues(), createPluginSecretsHandler(), authorizeBoundSecret(), lookupBinding(), resolveBoundSecret() (+19 more)

### Community 265 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 266 - "issue-monitor-convergence-guard.test.ts"
Cohesion: 0.24
Nodes (8): computeIssueMonitorGateFingerprint(), evaluateIssueMonitorConvergence(), normalizeGateToken(), normalizeIssueMonitorConvergenceThreshold(), normalizeIssueMonitorGateSignals(), IssueFixture, MonitorInput, monitorState()

### Community 267 - "branch-run-claims.ts"
Cohesion: 0.19
Nodes (12): acquireBranchRunClaim(), BranchClaimConflictError, BranchClaimReadDb, BranchRunClaim, canonicalizeGitRemoteIdentity(), getHeartbeatRunState(), isConstraintConflict(), isHolderRunQuiesced() (+4 more)

### Community 268 - "project-env-response-boundary.test.ts"
Cohesion: 0.12
Nodes (23): ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), maskProjectEnv(), PROJECT_ENV_VALUE_MASK, maskRoutineEnv() (+15 more)

### Community 269 - "dev-runner-snapshot.test.ts"
Cohesion: 0.33
Nodes (3): readdirSync(), statSync(), tempRoots

### Community 270 - "company-branding-route.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService, mockCompanyPortabilityService, mockCompanyService, mockFeedbackService (+1 more)

### Community 271 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 272 - "heartbeat-retry-scheduling.test.ts"
Cohesion: 0.11
Nodes (20): CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS, INTERACTION_CONTINUATION_INFRA_RETRY_REASON, INTERACTION_CONTINUATION_INFRA_WAKE_REASON, JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS, MAX_TURN_CONTINUATION_RETRY_REASON, MAX_TURN_CONTINUATION_WAKE_REASON, SESSION_UNAVAILABLE_HEARTBEAT_RETRY_DELAY_MS, SESSION_UNAVAILABLE_HEARTBEAT_RETRY_MAX_ATTEMPTS (+12 more)

### Community 273 - "invite-accept-existing-member.test.ts"
Cohesion: 0.20
Nodes (6): accessServiceMock, ACTIVE_INVITE_EXPIRES_AT, createApp(), createAppWithActor(), logActivityMock, QueryHooks

### Community 274 - "issue-closed-workspace-routes.test.ts"
Cohesion: 0.18
Nodes (7): createApp(), mockAccessService, mockExecutionWorkspaceService, mockHeartbeatService, mockIssueService, mockLogActivity, mockProjectService

### Community 275 - "project-routes-env.test.ts"
Cohesion: 0.18
Nodes (8): createApp(), mockAccessService, mockEnvironmentService, mockGetTelemetryClient, mockLogActivity, mockProjectService, mockSecretService, mockWorkspaceOperationService

### Community 276 - "ensure"
Cohesion: 0.16
Nodes (29): assertAdapterAllowed(), assertKnownBuiltInAgentModel(), autoProvisionBundledAgents(), defaultProvisionInput(), ensure(), ensureAgentDefaultGrants(), ensureBuiltInAgentDefaultGrants(), ensureCompany() (+21 more)

### Community 277 - "issue-comment-effects.ts"
Cohesion: 0.14
Nodes (26): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+18 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "run-secret-redaction.ts"
Cohesion: 0.13
Nodes (21): compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan(), characterClassCount() (+13 more)

### Community 280 - "agent-auth-jwt.ts"
Cohesion: 0.18
Nodes (15): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+7 more)

### Community 281 - "workspace-scan.ts"
Cohesion: 0.36
Nodes (9): CONFIG_FILE_LANGUAGES, detectProjectName(), execFileAsync, fileExists(), getGitDefaultBranch(), getGitRemoteUrl(), readReadmeExcerpt(), WorkspaceScanResult (+1 more)

### Community 282 - "backfill-agent-bundle.ts"
Cohesion: 0.14
Nodes (14): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+6 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "authorization-service.test.ts"
Cohesion: 0.17
Nodes (4): buildKeyedCommentEffectIntents(), persistedCommentActor(), commentAuthorCanGrantIssueMention(), getActiveCompanyMembership()

### Community 285 - "execution-policy-bootstrap.test.ts"
Cohesion: 0.22
Nodes (8): bootstrap, ensureKubernetesEnvironment, env(), ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, fakeDb, listCompanyIds, updateGeneral

### Community 286 - "routes/activity.ts"
Cohesion: 0.12
Nodes (19): activityRoutes(), COMPANY_ACTIVITY_QUERY_PARAMS, companyActivityQuerySchema, createActivitySchema, rejectUnsupportedQueryParams(), uuidQueryParamSchema, ActivityFilters, activityService() (+11 more)

### Community 287 - "workspace-runtime-read-model.ts"
Cohesion: 0.39
Nodes (7): loadEffectiveRuntimeServicesByExecutionWorkspace(), listCurrentRuntimeServicesForExecutionWorkspaces(), listCurrentRuntimeServicesForProjectWorkspaces(), runtimeServiceIdentityKey(), RuntimeServiceReadDb, selectCurrentRuntimeServiceRows(), WorkspaceRuntimeServiceRow

### Community 288 - "importBundle"
Cohesion: 0.08
Nodes (30): applySelectedFilesToSource(), collectAgentSafeImportPolicyErrors(), applyImportedAgentPermissionGrants(), buildPreview(), importBundle(), previewImport(), resolveImportedAssigneeAgentId(), detectDirectToMainBundleWarnings() (+22 more)

### Community 289 - "builtInAgentService"
Cohesion: 0.20
Nodes (26): builtInAgentService(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), ensureBuiltInAgentAssignable(), getCurrentSkillFiles(), getManagedResourceBinding(), getRoutineByBinding() (+18 more)

### Community 290 - "openrouter/execute.ts"
Cohesion: 0.13
Nodes (17): AGENT_TOOLS, callOpenRouter(), ChatMessage, execAsync, execute(), executeToolCall(), walk(), sanitize() (+9 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.08
Nodes (5): PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, __resetQuotaExhaustedHookStateForTesting(), mockAdapterExecute

### Community 292 - "issue-approval-link-authorization.ts"
Cohesion: 0.12
Nodes (23): AccessDecider, evaluateTaskWatchdogSubtreeScope(), isCreatorOrManagerChainDecision(), isCurrentIssueExecutionRun(), IssueApprovalLinkAuthorizationIssue, IssueApprovalLinkVerdict, revalidateWatchdogScope(), assertFreshTaskWatchdogSourceMutation() (+15 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "agent-live-run-routes.test.ts"
Cohesion: 0.12
Nodes (10): createApp(), mockAccessDecide, mockAgentService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockWorkspaceOperationService (+2 more)

### Community 295 - "built-in-agent-routes.test.ts"
Cohesion: 0.18
Nodes (8): allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService, mockInstanceSettingsService, mockLogActivity, stateWithMetadata()

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "company-skills-catalog-service.test.ts"
Cohesion: 0.25
Nodes (7): contentHash(), createService(), mockCatalogService, sampleAssetBytes, sampleCatalogSkill, sampleFiles, sha256()

### Community 298 - "evidence-truth.ts"
Cohesion: 0.13
Nodes (17): buildGithubTruthProbe(), GithubTruthDeps, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr, PROBE_DEADLINE_MS, probeOne() (+9 more)

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

### Community 304 - "fd-class-metrics.ts"
Cohesion: 0.12
Nodes (22): boundedDirLabel(), boundedSegment(), classifyFdTarget(), CollectFdClassOptions, collectFdClassSnapshot(), FD_CLASS_MAX_ENTRIES, FD_CLASS_MAX_SEGMENT_CHARS, FD_CLASS_MAX_SERIES (+14 more)

### Community 305 - "ccrotate-capacity-retry.ts"
Cohesion: 0.05
Nodes (36): applyCcrotateCapacityDecision(), CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MAX_PARK_MS (+28 more)

### Community 306 - "pluginCapabilityValidator"
Cohesion: 0.08
Nodes (7): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, baseManifest

### Community 307 - "pr-review-state-reconciler.ts"
Cohesion: 0.12
Nodes (23): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+15 more)

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.12
Nodes (10): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, AgentRow, columnReasonLiteralsFromDirectInserts(), CompanyRow, createApp(), Db, IssueRow, lineOf() (+2 more)

### Community 309 - "attachment-types.ts"
Cohesion: 0.12
Nodes (17): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isAllowedContentType(), isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES (+9 more)

### Community 310 - "invite-rate-limit.ts"
Cohesion: 0.21
Nodes (6): createInviteRateLimiter(), INVITE_RATE_LIMIT_MAX_REQUESTS, INVITE_RATE_LIMIT_WINDOW_MS, InviteRateLimiter, InviteRateLimitResult, createApp()

### Community 311 - "live-events.ts"
Cohesion: 0.13
Nodes (12): resetPluginEventOutboxDbForTests(), emitter, LiveEventListener, LiveEventPayload, publishGlobalLiveEvent(), subscribeCompanyLiveEvents(), toLiveEvent(), captureLiveEvents() (+4 more)

### Community 312 - "plugin-event-bus.ts"
Cohesion: 0.13
Nodes (8): createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus, Subscription

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "managed-checkout-partial-clone.ts"
Cohesion: 0.13
Nodes (22): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+14 more)

### Community 315 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.11
Nodes (17): createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile(), PhaseStat (+9 more)

### Community 316 - "config"
Cohesion: 0.24
Nodes (8): describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest(), tryEnvLabFixture(), tryExplicitConfig(), config()

### Community 317 - "execution-workspaces-service.test.ts"
Cohesion: 0.46
Nodes (6): createTempRepo(), execFileAsync, fingerprintWorkspaceBranchIncoherenceForTest(), readGit(), runGit(), stableStringifyForTest()

### Community 318 - "process-crash-guard-exit.test.ts"
Cohesion: 0.14
Nodes (12): MAX_WRITE_WAIT_MS, CrashResult, fixture, here, LATE_BACKPRESSURE_RUN, PREFILL_RUN, readRemainingStderr(), runFixtureWithStalledStderr() (+4 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "asNumber"
Cohesion: 0.15
Nodes (21): asBoolean, asNumber, EXTERNAL_LIFECYCLE_ADAPTERS, hasExternalLifecycleAdapter(), isRunOccupyingSlot(), normalizeMaxConcurrentRuns(), resolveAgentConcurrencyPolicy(), resolveEffectiveMaxConcurrentRuns() (+13 more)

### Community 321 - "claude-agent-id-header.ts"
Cohesion: 0.33
Nodes (3): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "routes/decision-training.ts"
Cohesion: 0.15
Nodes (18): createSchema, decisionTrainingRoutes(), exampleIdSchema, parseExampleId(), previewSchema, requireExampleOwner(), requireHumanUser(), sourceKindSchema (+10 more)

### Community 324 - ".call"
Cohesion: 0.13
Nodes (7): awsProviderSafeMessage(), AwsSecretsManagerGateway, AwsSecretsManagerJsonGateway, classifyAwsProviderError(), loadAwsCredentials(), normalizeAwsError(), SecretProviderClientError

### Community 325 - "zodToOpenApiSchema"
Cohesion: 0.52
Nodes (7): applyNumberChecks(), applyStringChecks(), isOptionalSchema(), parametersFromSchema(), unwrapSchema(), zodToOpenApiSchema(), zodTypeName()

### Community 326 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.05
Nodes (24): BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, BLO_18138_RESULT_JSON, BLO_21803_ALLOCATION_MISSING_RESULT_JSON, executeScheduledRetryOf(), getRetryOf(), adapterExecute, execFile (+16 more)

### Community 327 - "company-export-readme.ts"
Cohesion: 0.43
Nodes (6): generateOrgChartMermaid(), generateReadme(), mermaidEscape(), mermaidId(), ROLE_LABELS, skillSourceLabel()

### Community 329 - "collectEvidence"
Cohesion: 0.12
Nodes (31): choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), deliberatePendingMonitor(), dominantErrorCode(), isDominantEpisodeShare(), isMonitorSuppressionActor(), isNeverInvokedRun() (+23 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.07
Nodes (40): assertEnvironmentSelectionForCompany(), assertCanManageInstanceSettings(), auditPatchedHookCommands(), instanceSettingsRoutes(), assertProjectEnvironmentSelection(), auditConfiguredHookCommandsOnBoot(), auditHookCommands(), basenameOf() (+32 more)

### Community 331 - "readProjectWorkspaceRuntimeConfig"
Cohesion: 0.64
Nodes (7): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates(), restartDesiredRuntimeServicesOnStartup()

### Community 332 - "boardAuthService"
Cohesion: 0.11
Nodes (25): BOARD_API_KEY_TTL_MS, boardApiKeyExpiresAt(), boardAuthService(), approveCliAuthChallenge(), assertCurrentBoardKey(), cancelCliAuthChallenge(), createCliAuthChallenge(), createNamedBoardApiKey() (+17 more)

### Community 333 - "penstock-availability-gate.ts"
Cohesion: 0.11
Nodes (18): PenstockProbeOutcomeLabel, PenstockProbePathLabel, buildCapacityUrl(), buildMessagesUrl(), CacheEntry, isPenstockBaseUrl(), PenstockAvailabilityGateAllowResult, PenstockAvailabilityGateDenyResult (+10 more)

### Community 334 - "approval-budget-assertion-required.test.ts"
Cohesion: 0.10
Nodes (16): createAgentApp(), createRouteDb(), createUserApp(), extractAssertions(), fileCard(), mockAccessService, mockApprovalService, mockDeferredActivityPublish (+8 more)

### Community 335 - "input"
Cohesion: 0.18
Nodes (11): locatePodLogArtifact(), OrphanedRunTerminalResult, readOptionalString(), readOrphanedRunTerminalResult(), resultEventReportsSuccess(), runLogBasePath(), input(), createSecret() (+3 more)

### Community 336 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.10
Nodes (8): FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR, SDK_INSTALL_RACE_ERROR, ghFetchMock, jsonResponse(), NOW, routeGithub()

### Community 337 - "setup-supertest.ts"
Cohesion: 0.29
Nodes (5): require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance

### Community 338 - "teams-catalog-routes.test.ts"
Cohesion: 0.25
Nodes (5): createApp(), mockAccessService, mockAgentService, mockCatalogModule, mockTeamsCatalogService

### Community 339 - "pr-review-request-ageing-producer.ts"
Cohesion: 0.15
Nodes (15): DigestProducer, DigestSection, AgeingPullRequest, DEFAULT_ESCALATE_AFTER_DAYS, formatPullRequestRef(), buildPrReviewRequestAgeingSection(), LoadedReviewState, PR_REVIEW_REQUEST_AGEING_SECTION_KEY (+7 more)

### Community 340 - "scrape-metrics-collector.ts"
Cohesion: 0.06
Nodes (41): EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, DEP_BLOCKED_MAX_DELAY_MS, MAX_TURN_CONTINUATION_MAX_DELAY_MS, DbPoolStats, DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC, DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC (+33 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.60
Nodes (5): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance()

### Community 344 - "buildRunEventRuntimeProgress"
Cohesion: 0.67
Nodes (6): buildRunEventRuntimeProgress(), readFirstLiveRunProgressString(), readLiveRunAssistantSnippet(), readLiveRunProgressString(), readLiveRunToolName(), sanitizeLiveRunProgressText()

### Community 345 - "pipeline-case-outputs.ts"
Cohesion: 0.18
Nodes (19): buildCaseContextMarkdown(), contentPath(), contextFetchHint(), DELIVERABLE_TITLE_PATTERNS, deliverableDocumentRank(), downloadPath(), formatPipelineCaseOutputContextMarkdown(), normalizePreviewText() (+11 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.07
Nodes (15): awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider, checkSecretProviders(), listSecretProviders() (+7 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.13
Nodes (17): listSuccessfulRunHandoffStates(), findAcceptedPlanDocumentInteraction(), isTreeHoldInteractionCheckoutAllowed(), listSuccessfulRunHandoffMapForIssues(), readAcceptedPlanConfirmationTarget(), readStringFromRecord(), readSuccessfulRunHandoffFromActivity(), resolveResponsibleUserIdForIssueCreate() (+9 more)

### Community 348 - "pipelines-service.test.ts"
Cohesion: 0.14
Nodes (14): loadPipelineDescendantActiveWorkCounts(), PIPELINE_CASE_EVENTS_MAX_LIMIT, PIPELINE_CONTEXT_PACK_EVENT_LIMIT, PipelineActor, app(), plantedStageConfig(), seedCarrier(), seedCompany() (+6 more)

### Community 349 - "pluginLifecycleManager"
Cohesion: 0.13
Nodes (8): isValidTransition(), pluginLifecycleManager, assertTransition(), deactivatePluginRuntime(), emitDomain(), requirePlugin(), stopWorkerIfRunning(), transition()

### Community 350 - "cli-auth-routes.test.ts"
Cohesion: 0.29
Nodes (5): createApp(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity

### Community 352 - "docker-entrypoint.test.ts"
Cohesion: 0.47
Nodes (5): ENTRYPOINT, execFileAsync, installStubs(), runEntrypoint(), writeStub()

### Community 354 - "recovery-stale-issue-lock-sweep.test.ts"
Cohesion: 0.11
Nodes (5): NON_LIVE_EXECUTION_SILENCE_MS, LOCKLESS_DEFERRED_WAKE_MIN_AGE_MS, STALE_RUNNING_ISSUE_LOCK_MS, mockProbeAgentPodActivity, mockTelemetryClient

### Community 355 - "exportBundle"
Cohesion: 0.10
Nodes (25): buildEnvInputMap(), buildMarkdown(), buildOrgTreeFromManifest(), buildPortableCatalogProvenance(), buildReferencedSkillMarkdown(), buildSkillSourceEntry(), classifyPortableFileKind(), collectRedactedPaths() (+17 more)

### Community 356 - "approval-create-issue-link-authorization.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 357 - "user-profiles.ts"
Cohesion: 0.25
Nodes (16): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+8 more)

### Community 358 - "issue-graph-liveness.ts"
Cohesion: 0.07
Nodes (55): addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding(), hasAnyBlockerEdge(), hasExplicitWaitingPath() (+47 more)

### Community 359 - "key"
Cohesion: 0.15
Nodes (13): key(), begin, findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), RUN_LOG_TERMINAL_MAX_SCAN_BYTES, RUN_LOG_TERMINAL_TAIL_BYTES, RunLogRangeReader (+5 more)

### Community 360 - "pull-request-work-products.ts"
Cohesion: 0.14
Nodes (17): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestMergeQueueState, PullRequestWorkProductFields (+9 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "SmokeLabService"
Cohesion: 0.16
Nodes (13): appendRedirectParam(), assertSmokeOAuthRedirectUri(), escapeHtml(), normalizeSmokeOAuthScope(), smokeFixtureToken(), SmokeLabService, assertEnabled(), assertFakeOAuthRunning() (+5 more)

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

### Community 367 - "github-fetch.ts"
Cohesion: 0.18
Nodes (13): GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS, isGitHubDotCom(), resolveRawGitHubUrl(), _setGhFetchDeadlineMsForTest(), assertWebhookGithubCallsAreBounded(), blankLiterals(), closingParen() (+5 more)

### Community 368 - "heartbeat-issue-liveness-escalation.test.ts"
Cohesion: 0.15
Nodes (13): BACKSTOP_CANDIDATES_SKIPPED_METRIC, ABANDONED_LIVENESS_RECOVERY_MARKER, DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS, DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS, STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER, enableAutoRecovery(), guardBoundary (+5 more)

### Community 369 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.19
Nodes (15): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat() (+7 more)

### Community 370 - "done-gate.ts"
Cohesion: 0.60
Nodes (3): DoneGateInput, hasPrLinkEvidence(), shouldBlockNarratedDone()

### Community 371 - "heartbeat-stale-queue-invalidation.test.ts"
Cohesion: 0.21
Nodes (9): mockAdapterExecute, resumeContinuationRetry(), seedCompanyAndAgent(), seedContinuationSummary(), SeedOptions, seedParkedContinuationRetry(), seedQueuedRun(), SeedResult (+1 more)

### Community 372 - "plugin-config-write-race.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), createRaceDb(), acquireAdvisoryLock(), deferred(), mockSecretService, registryFor, store, TxHandle

### Community 373 - "agent-profile-change-gate-mixing.test.ts"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockLogActivity, mockSecretService (+3 more)

### Community 374 - "approval-agent-config-authz-routes.test.ts"
Cohesion: 0.12
Nodes (12): boardActor, createAppWithActor(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService (+4 more)

### Community 375 - "isPlainRecord"
Cohesion: 0.29
Nodes (16): childNodesForIndex(), childNodesForKey(), containsMask(), designatedIdentityKey(), expandSchemaNodes(), identityOccurrences(), identityValue(), isPlainRecord() (+8 more)

### Community 376 - "services/agent-image-bump.ts"
Cohesion: 0.24
Nodes (11): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+3 more)

### Community 377 - "board-chat.ts"
Cohesion: 0.26
Nodes (8): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), createApp(), mockGetExperimental, mockIssueService, mockSpawn

### Community 378 - "graceful-shutdown-exit.test.ts"
Cohesion: 0.40
Nodes (4): fixture, here, serverRoot, tsx

### Community 379 - "invite-create-route.test.ts"
Cohesion: 0.60
Nodes (4): createApp(), createDbStub(), logActivityMock, registerModuleMocks()

### Community 380 - "invite-summary-route.test.ts"
Cohesion: 0.29
Nodes (3): ACTIVE_INVITE_EXPIRES_AT, createApp(), mockStorage

### Community 382 - "pr-comment-review-gate-check.test.ts"
Cohesion: 0.13
Nodes (11): runPrCommentReviewGateCheck(), serializeGateEvaluation(), h, mockFetchHeadSha, mockFetchPrAuthor, mockListComments, mockListReviews, mockPostCheckRun (+3 more)

### Community 383 - "agent-budget-mirror-write.test.ts"
Cohesion: 0.14
Nodes (13): agentActor, agentRow, baseAgent, boardActor, createApp(), createDbStub(), mockAccessService, mockAgentService (+5 more)

### Community 384 - "mcp-seed-scrub-coverage.test.ts"
Cohesion: 0.14
Nodes (10): Coverage, EntryShape, jobManifestPath, repoRoot, resolveEntryShapes(), SCRUBBING_GATEWAY_HOSTS, SEED_COVERAGE, SeedEntry (+2 more)

### Community 385 - "stacked-pr-auto-retarget.test.ts"
Cohesion: 0.17
Nodes (10): buildApp(), linkPullRequest(), mockListOpenPrsByBase, mockResolveBranchState, mockResolveMergedBase, mockResolveMergeShape, post(), seedCompany() (+2 more)

### Community 386 - "company-search-rate-limit.ts"
Cohesion: 0.19
Nodes (9): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), search(), createApp() (+1 more)

### Community 387 - "issue-execution-lock.test.ts"
Cohesion: 0.13
Nodes (18): ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runOwnsIssueExecutionLock(), runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUS_VALUES, ActiveRunSignals, isIssueHeldByForeignRun(), isIssueHeldByForeignScheduledRetry() (+10 more)

### Community 388 - "heartbeat-hard-stale-subprocess-liveness.test.ts"
Cohesion: 0.14
Nodes (10): numberFromEnv(), parseCpuQuantityToMillicores(), mockDeleteAgentJobExact, mockDeleteAgentJobsForRun, mockHasActiveJobForAgent, mockListAgentJobRunStatuses, mockListLiveAgentJobRunIds, mockListManagedAgentJobs (+2 more)

### Community 389 - "plugin-webhook-not-ready-retryable.test.ts"
Cohesion: 0.14
Nodes (11): boundWebhookRejectionPluginKey(), logPluginWebhookDeliveryRejection(), MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS, OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY, PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC, recordPluginWebhookDeliveryRejected(), createApp(), mockLifecycle (+3 more)

### Community 390 - "sweep-wake-preflight.test.ts"
Cohesion: 0.15
Nodes (13): compareSweepWakeFrame(), equalStringArrays(), isValidIsoDate(), isValidSweepWakeFrame(), parseScalar(), parseSweepWakeFramePage(), sortLex(), SweepWakeFrame (+5 more)

### Community 392 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 393 - "issue-create-pr-review-duplicate-routes.test.ts"
Cohesion: 0.21
Nodes (9): __test_buildPrReviewerTaskLockKeys, DUPLICATE_PR_REVIEW_ISSUE_ERROR_CODE, NOT_A_REVIEW_REQUEST_MARKER, configureReviewer(), createApp(), NORMALIZED_REPO, seedAgent(), seedCompany() (+1 more)

### Community 395 - "createToolGatewayService"
Cohesion: 0.05
Nodes (110): isPlainObject(), summarizeToolValue(), validateToolContent(), asRecord(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions() (+102 more)

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

### Community 403 - "plugin-status-metrics.ts"
Cohesion: 0.27
Nodes (10): PLUGIN_ERROR_METRIC, PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC, PluginErrorStatusEntry, setPluginErrorStatus(), setPluginStatusCollectorLastSuccessSeconds(), pluginErrorEntriesFromRows(), PluginStatusCollectorOptions, PluginStatusRow (+2 more)

### Community 404 - "readPenstockCapacity"
Cohesion: 0.27
Nodes (10): capacityEndpointUnavailable(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger, penstockModelId() (+2 more)

### Community 405 - "logger-tz.test.ts"
Cohesion: 0.40
Nodes (3): mockPino, mockTransport, PinoTransportOptions

### Community 406 - "github-review-posted-metric.test.ts"
Cohesion: 0.18
Nodes (6): __test_resolvePostedReviewObservation, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC, normalizeGithubReviewRepo(), recordGithubReviewPosted(), ALLY_REVIEW_BODY

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.15
Nodes (7): createDb(), createSelectChain(), then(), values(), chartDir, read(), repoRoot

### Community 409 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.18
Nodes (4): blocked(), humanGatedAgeingProducer, collect(), NOW

### Community 410 - "environment-instance-routes.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+1 more)

### Community 411 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 412 - "routes/companies.ts"
Cohesion: 0.06
Nodes (35): assertInstanceAdmin(), assertCloudTenantCaller(), cleanupTerminalImportJobs(), cloudTenantRequestKey(), CompanyImportResult, companyRoutes(), assertImportTargetAccess(), createImportJob() (+27 more)

### Community 413 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 421 - "deriveSkillExportDirCandidates"
Cohesion: 0.33
Nodes (10): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+2 more)

### Community 425 - "buildPortableProjectWorkspaces"
Cohesion: 0.24
Nodes (10): buildPortableProjectWorkspaces(), containsAbsolutePathFragment(), containsSystemDependentPathValue(), derivePortableProjectWorkspaceKey(), execFileAsync, inferPortableWorkspaceGitMetadata(), readGitOutput(), readGitRemoteUrl() (+2 more)

### Community 426 - "agent-budgets-route-config-revision.test.ts"
Cohesion: 0.24
Nodes (6): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets()

### Community 427 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 428 - "issue-dependency-wakeups-routes.test.ts"
Cohesion: 0.20
Nodes (9): createApp(), mockDb, mockFindExistingIssueBlockersResolvedWake, mockIssueService, mockListBlockedDependentIssueIds, mockRecomputeBlockedIssuesStatusIfReady, mockTx, mockTxInsertValues (+1 more)

### Community 430 - "plugin-metric-exposition.test.ts"
Cohesion: 0.07
Nodes (26): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+18 more)

### Community 431 - "scrape-metrics-collector.test.ts"
Cohesion: 0.20
Nodes (7): DB, refreshDeferredIssueExecutionWakeAgeMetrics, refreshExternalRuntimeReservationMetrics, refreshExternalRuntimeReservationStrandMetrics, refreshOverdueScheduledRetryAgeMetrics, refreshQueuedRunAgeMetrics, refreshScheduledRetryParkHorizonMetrics

### Community 433 - "trust-proxy.ts"
Cohesion: 0.36
Nodes (7): RFC-4291, applyTrustProxy(), isValidSubnetToken(), NAMED_SUBNETS, parseTrustProxyEnv(), TrustProxyValue, appWithEnv()

### Community 437 - "privateHostnameGuard"
Cohesion: 0.42
Nodes (7): blockedHostnameMessage(), extractHostname(), isLoopbackHostname(), normalizeAllowedHostnames(), privateHostnameGuard(), resolvePrivateHostnameAllowSet(), createApp()

### Community 438 - "invite-defaults-response-boundary.test.ts"
Cohesion: 0.33
Nodes (4): containDefaultsPayload(), redactInviteRecord(), redactJoinRequestRecord(), createApp()

### Community 446 - "resolveSource"
Cohesion: 0.22
Nodes (9): bufferToPortableBinaryFile(), resolveSource(), fetchBinary(), fetchOptionalText(), fetchText(), inferContentTypeFromPath(), normalizeFileMap(), normalizeGitHubSourcePath() (+1 more)

### Community 447 - "heartbeat-worker-crash-marking.test.ts"
Cohesion: 0.25
Nodes (3): HeartbeatEnvironmentRuntime, insertRun(), seedCrashMarkedRun()

### Community 460 - "syncPipelineStageAutomation"
Cohesion: 0.28
Nodes (9): assertActorProvenance(), eventActorPatch(), appendPipelineAutomationRoutineRevision(), syncPipelineStageAutomation(), reconcilePipelineStageConfigVariables(), routineActorPatch(), routineRevisionSnapshotRoutine(), sanitizePipelineRoutineVariableRecords() (+1 more)

### Community 461 - "plugin-config-masking.test.ts"
Cohesion: 0.25
Nodes (8): orderedSecrets(), PLUGIN_CONFIG_SECRET_MASK, redactSecretValuesDeep(), walk(), redactSecretValuesFromText(), TRAVERSED_SCHEMA_KEYWORDS, merge(), mergeConfig()

### Community 462 - "pr-review-issue-scope-locks.test.ts"
Cohesion: 0.25
Nodes (8): DuplicatePrReviewIssueCandidate, classify(), fakeDb(), GuardTx, ONE_PR, OPTIONS, Statement, TWO_PRS

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "smoke-lab.test.ts"
Cohesion: 0.22
Nodes (3): SMOKE_LAB_OAUTH_SCOPE, createRouteApp(), TestDb

### Community 465 - "heartbeat-reviewer-evidence-live-head.test.ts"
Cohesion: 0.25
Nodes (6): FakeReview, h, jsonResponse(), PRIVATE_KEY_PEM, { privateKey }, stubGithub()

### Community 467 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.25
Nodes (3): createApp(), seedCompanyAgentAndRuns(), seedPendingReviewStageIssue()

### Community 468 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 469 - "inspectExecutionWorkspaceBranchForReconcile"
Cohesion: 0.32
Nodes (8): execFileAsync, explainGitWorktreeBranchReconcileInspection(), fingerprintWorkspaceBranchIncoherence(), getGitWorktreeBranchAncestryVerdict(), inspectExecutionWorkspaceBranchForReconcile(), readGitStdout(), runGit(), stableStringify()

### Community 470 - "issue-monitor-queue-lock.ts"
Cohesion: 0.67
Nodes (3): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock()

### Community 471 - "plugin-event-outbox.ts"
Cohesion: 0.43
Nodes (4): pollOnce(), pruneOutbox(), resetStaleProcessing(), startPluginEventOutbox()

### Community 472 - "nextCronTickInTimeZone"
Cohesion: 0.29
Nodes (7): assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), isSubHourlyCronExpression(), matchesCronMinute(), nextCronTickInTimeZone()

### Community 473 - "shared-checkout-occupancy.test.ts"
Cohesion: 0.46
Nodes (4): describeSharedCheckoutOccupancy(), formatSharedCheckoutOccupancyWarning(), listSiblingRunningRunIds(), SHARED_CHECKOUT_WARNING_RUN_SAMPLE

### Community 474 - "agents-service-secret-bindings.test.ts"
Cohesion: 0.25
Nodes (3): mockEnsureBuiltInAgent, mockNotifyHireApproved, pendingApproval()

### Community 475 - "chain"
Cohesion: 0.18
Nodes (3): createFakeDb(), chain, VALID_HEADERS

### Community 476 - "environment-probe.test.ts"
Cohesion: 0.25
Nodes (7): mockEnsureSshWorkspaceReady, mockEnvironmentRuntimeService, mockProbePluginEnvironmentDriver, mockProbePluginSandboxProviderDriver, mockResolvePluginSandboxProviderDriverByKey, mockRuntimeAcquireRunLease, mockRuntimeReleaseRunLease

### Community 477 - "Ally — Consolidated PR Review"
Cohesion: 0.25
Nodes (7): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Prior Findings Dispositioned (1), Recommended Action, Strengths, Suggestions (0)

### Community 478 - "human-gated-gate-revalidation-backfill.test.ts"
Cohesion: 0.25
Nodes (4): NOW, Stub, StubInteraction, StubIssue

### Community 479 - "ceo/AGENTS.md"
Cohesion: 0.29
Nodes (6): Delegation (critical), Keeping work moving, Memory and Planning, References, Safety Considerations, What you DO personally

### Community 480 - "companySkillService"
Cohesion: 0.05
Nodes (82): buildHarnessIssueDescription(), buildSkillRuntimeName(), builtInSkillTestRunTemplate(), companySkillService(), actorStarClause(), assertCanMutateComment(), assertLocalImportSourceAllowed(), cancelTestRun() (+74 more)

### Community 482 - "redactIssueMonitorExternalRef"
Cohesion: 0.43
Nodes (7): buildClearedMonitorState(), buildTriggeredMonitorState(), monitorConvergenceFields(), monitorMetadataFromPolicy(), monitorMetadataFromState(), normalizeMonitorText(), redactIssueMonitorExternalRef()

### Community 483 - "penstock-availability-gate.test.ts"
Cohesion: 0.33
Nodes (4): createPenstockAvailabilityGate(), gateWith(), gateWith(), log

### Community 484 - "wake-idempotency.test.ts"
Cohesion: 0.43
Nodes (4): findWakeIdempotencyReceipt(), attemptWakeEffect(), insertWake(), WAKE_IDEMPOTENCY_RECEIPT_STATUSES

### Community 485 - "ensureServerWorkspaceLinksCurrent"
Cohesion: 0.33
Nodes (7): discoverWorkspacePackagePaths(), visit(), ensureServerWorkspaceLinksCurrent(), findServerWorkspaceLinkMismatches(), findWorkspaceRoot(), isLinkedGitWorktreeCheckout(), readJsonFile()

### Community 486 - "Ally — Consolidated PR Review"
Cohesion: 0.29
Nodes (6): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), Recommended Action, Strengths, Suggestions (2)

### Community 487 - "recoverClaimedReviewWithUnavailableVerification"
Cohesion: 0.43
Nodes (7): recoverClaimedReviewWithUnavailableVerification(), seedAdapterInvokeEvent(), seedEnvironmentLeaseFixture(), seedLaunchedReservation(), seedRunFixture(), seedTerminalExternalRunWithLease(), seedVanishedRun()

### Community 488 - "heartbeat-worktree-suppression.test.ts"
Cohesion: 0.33
Nodes (4): armWorktreeRunExecution(), deleteHeartbeatRunsWithDependents(), drainInFlightExecutions(), isHeartbeatRunDependentFkError()

### Community 489 - "issue-denied-write-recovery-persistence.test.ts"
Cohesion: 0.33
Nodes (3): captureDeniedWriteEvents(), createApp(), deniedWriteRows()

### Community 490 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 491 - "issue-assignment-wakeup.ts"
Cohesion: 0.40
Nodes (5): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail

### Community 492 - "applyIssueExecutionPolicyTransition"
Cohesion: 0.47
Nodes (5): applyIssueExecutionPolicyTransition(), changesRequestedState(), arm(), transition(), triggeredIssue()

### Community 493 - "agent-auth-middleware.test.ts"
Cohesion: 0.40
Nodes (3): createApp(), createDbState(), createSelectChain()

### Community 494 - "plugin-worker-invocation-scope.cjs"
Cohesion: 0.40
Nodes (5): pendingNested, readline, rl, send(), sendNestedHostRequest()

### Community 495 - "issue-blocked-patch-comment-drop.test.ts"
Cohesion: 0.40
Nodes (3): createApp(), seedAssignedIssue(), seedEvidenceGatedIssue()

### Community 496 - "issue-checkout-routine-lock-conflict.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedDuplicateRoutineExecutions(), seedRun()

### Community 497 - "issue-release-lock-only-degrade.test.ts"
Cohesion: 0.53
Nodes (4): seedAgent(), seedCompany(), seedHolderRun(), seedStalePair()

### Community 498 - "pen3139-transcript-credential-shapes.test.ts"
Cohesion: 0.33
Nodes (4): CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

### Community 499 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

### Community 500 - "reflection-coach/AGENTS.md"
Cohesion: 0.40
Nodes (4): Applying changes (permission is gated, not automatic), Core responsibilities, Execution contract, Hard boundaries

### Community 501 - "Recent agent reflection sweep"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Recent agent reflection sweep, What this run must do

### Community 502 - "summarizer/AGENTS.md"
Cohesion: 0.40
Nodes (4): Core responsibilities, Cost discipline, Execution contract, Hard boundaries

### Community 503 - "Refresh stale summary slots"
Cohesion: 0.40
Nodes (4): Hard limits for this routine, Output, Refresh stale summary slots, What this run must do

### Community 504 - "validateTerminalUpgrade"
Cohesion: 0.50
Nodes (3): CustomImageTerminalService, terminalPayloadValidationError(), validateTerminalUpgrade()

### Community 506 - "environment-runtime-driver-contract.test.ts"
Cohesion: 0.50
Nodes (3): runContract(), RuntimeContractCase, seedEnvironment()

### Community 507 - "metrics-route-no-db.test.ts"
Cohesion: 0.40
Nodes (3): APP_SOURCE, DB_REFRESHES, INLINE_REFRESHES

### Community 508 - "SOUL.md -- CEO Persona"
Cohesion: 0.50
Nodes (3): SOUL.md -- CEO Persona, Strategic Posture, Voice and Tone

### Community 509 - "Wake Pre-flight (do this FIRST when woken)"
Cohesion: 0.50
Nodes (3): Fall-through write protocol, Short-circuit protocol, Wake Pre-flight (do this FIRST when woken)

### Community 510 - "startHttpSidecar"
Cohesion: 0.50
Nodes (4): allocateFetchAllowedLoopbackPort(), asRecord(), startHttpSidecar(), updateHttpConnectionUrl()

## Knowledge Gaps
- **3590 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Db`, `LogEntry` (+3585 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 5381 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `heartbeatService()` connect `heartbeatService` to `heartbeat.ts`, `source-trust.ts`, `issue-continuation-summary.ts`, `errorHandler`, `github-status-delivery-outbox.ts`, `logActivity`, `instanceSettingsService`, `environmentService`, `branch-run-claims.ts`, `recovery/service.ts`, `trust-preset-resolver.ts`, `workspace-runtime.ts`, `github-webhook.ts`, `k8s-job-liveness.ts`, `heartbeat-run-runtime-status.ts`, `issue-rewake-throttle.ts`, `issueRoutes`, `agent-auth-jwt.ts`, `issueService`, `run-secret-redaction.ts`, `agent-start-lock.ts`, `agentRoutes`, `services/instance-settings.ts`, `registry.ts`, `secretService`, `db-retry.ts`, `productivityReviewService`, `github-app-auth.ts`, `ccrotate-capacity-retry.ts`, `ensureRuntimeServicesForRun`, `services/index.ts`, `readNonEmptyString`, `ensurePersistedExecutionWorkspaceAvailable`, `external-runtime-reservations.ts`, `process-loss-classification.ts`, `redaction.ts`, `agent-invokability.ts`, `conflict`, `services/execution-workspaces.ts`, `services/issue-tree-control.ts`, `asNumber`, `heartbeat-stop-metadata.ts`, `run-scratch.ts`, `environment-run-orchestrator.ts`, `execution-policy-bootstrap.ts`, `run-liveness.ts`, `input`, `task-watchdogs.ts`, `shared-checkout-occupancy.test.ts`, `config.ts`, `execution-allowlist.ts`, `recovery/index.ts`, `unprocessable`, `companySkillService`, `hot-restart.ts`, `normalizeIssueExecutionPolicy`, `penstock-availability-gate.test.ts`, `key`, `pull-request-work-products.ts`, `sweep-wake-preflight.ts`, `budgetService`, `model-profile-hint.ts`, `services/agent-image-bump.ts`, `enqueueWakeup`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `issueRoutes()` connect `issueRoutes` to `source-trust.ts`, `logActivity`, `instanceSettingsService`, `environmentService`, `routes/issues.ts`, `issues-service.test.ts`, `recovery/service.ts`, `trust-preset-resolver.ts`, `github-webhook.ts`, `issue-comment-effects.ts`, `issue-efficiency.ts`, `issueService`, `authorization-service.test.ts`, `routes/companies.ts`, `agentRoutes`, `secretService`, `issue-approval-link-authorization.ts`, `cases.ts`, `feedback.ts`, `http-log-policy.ts`, `attachment-types.ts`, `redaction.ts`, `conflict`, `accessService`, `services/execution-workspaces.ts`, `issue-recovery-actions.ts`, `routes/decision-training.ts`, `services/projects.ts`, `lifecycle-hook-command-audit.ts`, `issue-thread-interactions.ts`, `agentService`, `company-search.ts`, `agent-inbox-lite-truncation.test.ts`, `issueReferenceService`, `issue-monitor-convergence-message.test.ts`, `documentAnnotationService`, `successful-run-handoff-state.ts`, `routes/approvals.ts`, `plan-review-context.ts`, `unprocessable`, `companySkillService`, `normalizeIssueExecutionPolicy`, `wake-idempotency.test.ts`, `heartbeatService`, `pull-request-work-products.ts`, `issue-assignment-wakeup.ts`, `applyIssueExecutionPolicyTransition`, `external-objects.ts`, `stranded-blocked-issue-reconciler.ts`, `issue-execution-policy.ts`, `model-profile-hint.ts`, `routineService`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `recoveryService()` connect `recovery/service.ts` to `heartbeat.ts`, `logActivity`, `instanceSettingsService`, `github-webhook.ts`, `k8s-job-liveness.ts`, `issueService`, `services/index.ts`, `agent-invokability.ts`, `strand-comment-provider-capacity.test.ts`, `issue-recovery-actions.ts`, `services/issue-tree-control.ts`, `asNumber`, `local-service-supervisor.ts`, `config.ts`, `recovery/index.ts`, `unprocessable`, `normalizeIssueExecutionPolicy`, `issue-graph-liveness.ts`, `heartbeatService`, `budgetService`, `routine-scheduler-heartbeat.ts`?**
  _High betweenness centrality (0.000) - this node is a cross-community bridge._
- **Are the 41 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 41 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `executeKeyedCommentEffect()`) actually correct?**
  _`issueRoutes()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _3590 weakly-connected nodes found - possible documentation gaps or missing edges._
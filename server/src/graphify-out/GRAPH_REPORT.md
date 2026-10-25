# Graph Report - src  (2026-10-25)

## Corpus Check
- 1328 files · ~3,553,799 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 16787 nodes · 41966 edges · 549 communities (474 shown, 75 omitted from the detail section)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 999 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1cc063be`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- errorHandler
- costs-service.test.ts
- services/index.ts
- issueRoutes
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
- readNonEmptyString
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
- index.ts
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
- environment-runtime.ts
- penstock-availability-gate.ts
- authorization.ts
- routes/approvals.ts
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
- sandbox-provider-runtime.ts
- storage/types.ts
- body-parsers.ts
- createPluginJobScheduler
- plugin-database.ts
- local-service-supervisor.ts
- services/projects.ts
- org-chart-svg.ts
- environment-run-orchestrator.ts
- issue-thread-interactions.ts
- plugin-host-services.ts
- run-liveness.ts
- cloudUpstreamService
- agentService
- company-search.ts
- task-watchdogs.ts
- git-worktree-ownership.ts
- services/smoke-lab.ts
- workspace-runtime.test.ts
- heartbeat-process-recovery.test.ts
- worktree-config.ts
- logger.ts
- documentAnnotationService
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- board-claim.ts
- config.ts
- wake-idempotency.test.ts
- recovery/service.ts
- agent-instructions.ts
- hot-restart.ts
- process-crash-guard.ts
- productivity-review-service.test.ts
- aws-secrets-manager-provider.ts
- issue-comment-reopen-routes.test.ts
- pipelines-aggregation.ts
- environment-probe-k8s.test.ts
- ensurePersistedExecutionWorkspaceAvailable
- process-mapping-metrics.test.ts
- plugin-worker-manager.ts
- sweep-wake-preflight.ts
- plugin-tool-dispatcher.ts
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
- enqueueWakeup
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
- successful-run-handoff.ts
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
- agent-secret-redaction.test.ts
- db-retry.ts
- authorizationService
- human-gated-ageing-digest.ts
- normalizeHumanRole
- heartbeat-provider-capacity-horizon.test.ts
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
- body
- issue-workspace-command-authz.test.ts
- githubWebhookRoutes
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
- metrics-ingest.ts
- execution-policy-bootstrap.ts
- github-review-posted-metric.test.ts
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite.ts
- responsible-user-denial-run-outcomes.ts
- plugin-job-scheduler.ts
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- env
- dev-server-status.ts
- openapi-routes.test.ts
- heartbeat-dependency-scheduling.test.ts
- execution-allowlist.ts
- pluginManagedRoutineService
- dispatch-readiness.ts
- scrape-metrics-routine-fire-gap-work.test.ts
- visibleIssueCondition
- isolation-workspace-reaper.test.ts
- buildInviteOnboardingManifest
- recovery-stranded-attendance-batch.test.ts
- environment-custom-image-terminal-sessions.ts
- pluginLifecycleManager
- plugin-managed-agents.ts
- plugin-managed-skills.ts
- execution-workspace-per-run-isolation.test.ts
- approval-routes-idempotency.test.ts
- approval-withdraw-routes.test.ts
- company-portability.test.ts
- docker-opencode-runtime-pin.test.ts
- done-gate-durable-artifact.test.ts
- environment-selection-route-guards.test.ts
- cgroup-memory-metrics.test.ts
- routines-routes.test.ts
- approval-gate-reconciler.ts
- stranded-blocked-issue-reconciler.ts
- buildOpenApiDocument
- instanceSettingsService
- runtime-api.ts
- pluginRegistryService
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- deriveSkillExportDirCandidates
- recovery-expired-wake-horizon.test.ts
- accepted-interaction-outcome-sweep.ts
- workspace-operation-log-store.ts
- agent-test-environment-routes.test.ts
- document-annotation-routes.test.ts
- external-object-routes.test.ts
- github-fetch.ts
- isPlainRecord
- middleware/index.ts
- project-goal-telemetry-routes.test.ts
- routine-document-annotation-routes.test.ts
- summary-slot-routes.test.ts
- ccrotate-state-hook.ts
- exportBundle
- plugin-secrets-handler.ts
- workspace-response-withholding-guard.test.ts
- project-checkout-origin-reconciler.ts
- branch-run-claims.ts
- http-metrics-per-route.test.ts
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
- workspace-scan.ts
- backfill-agent-bundle.ts
- agent-run-health.ts
- managed-checkout-push-guard.ts
- routes/decision-training.ts
- issue-watchdogs-routes.test.ts
- plugin-environment-driver.ts
- companyPortabilityService
- pr-review-state-reconciler.ts
- environmentRoutes
- heartbeat-timer-suppression-park-bypass.test.ts
- summarySlotService
- agent-hires-instructions-materialize.test.ts
- routes/tool-gateway.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- company-skills-catalog-service.test.ts
- run-secret-redaction.ts
- agent-live-run-routes.test.ts
- instrumentation.ts
- http-log-policy.ts
- agent-redaction.ts
- issue-blocker-diagnostics-routes.test.ts
- managed-checkout-partial-clone.ts
- heartbeat-retry-scheduling.test.ts
- zoned-cron.ts
- issue-subtree-diagnostics-routes.test.ts
- issue-wake-diagnostics-routes.test.ts
- builtInAgentService
- invite-rate-limit.ts
- model-validation.test.ts
- plugin-event-bus.ts
- process-loss-classification.ts
- routes/dashboard.ts
- taskWatchdogService
- config
- evidence-truth.ts
- agent-model-registry-validation.test.ts
- security-audit-overrides.test.ts
- environment-capabilities-k8s.test.ts
- issue-approval-link-authorization.ts
- agent-shell-guard.ts
- StorageService
- logger
- zodToOpenApiSchema
- openrouter/execute.ts
- company-export-readme.ts
- company-search-service.test.ts
- collectEvidence
- lifecycle-hook-command-audit.ts
- scrape-metrics-collector.ts
- boardAuthService
- pluginCapabilityValidator
- pen3142-live-event-transcript-scope.test.ts
- services/access.ts
- setupEnvironmentCustomImageTerminalWebSocketServer
- setup-supertest.ts
- teams-catalog-routes.test.ts
- strand-comment-provider-capacity.test.ts
- queued-run-age-metrics.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- gbrain-client-factory.test.ts
- zoned-cron-equivalence.test.ts
- pen3142-run-transcript-scope.test.ts
- issue-park-expiry-sweep.test.ts
- successful-run-handoff-state.ts
- routes/routines.ts
- REDACTED_EVENT_VALUE
- cli-auth-routes.test.ts
- cursor-local-execute.test.ts
- docker-entrypoint.test.ts
- heartbeat-issue-liveness-escalation.test.ts
- pipeline-case-outputs.ts
- buildPortableProjectWorkspaces
- live-events.ts
- pipelines-service.test.ts
- issue-liveness.test.ts
- approval-create-issue-link-authorization.test.ts
- pull-request-work-products.ts
- linear-webhook.test.ts
- scheduler-lease.ts
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
- chain-pass-timing.ts
- routine-fire-gap-metrics.test.ts
- routine-scheduler-heartbeat.ts
- issue-checkout-status.ts
- agent-budget-mirror-write.test.ts
- graceful-shutdown-exit.test.ts
- invite-create-route.test.ts
- invite-summary-route.test.ts
- storage/service.ts
- mcp-seed-scrub-coverage.test.ts
- stacked-pr-auto-retarget.test.ts
- plugin-state-store.ts
- agent-hire-source-issue-authorization.test.ts
- approval-revision-exit.test.ts
- heartbeat-workspace-finalize-branch.test.ts
- company-search-rate-limit.ts
- PluginWorkerHandle
- readPenstockCapacity
- issue-create-deduplication-routes.test.ts
- HEARTBEAT.md -- CEO Heartbeat Checklist
- task-watchdog-scope.ts
- sweep-wake-preflight.test.ts
- createToolGatewayService
- plugin-status-metrics.ts
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- PluginWorkerManager
- documents.ts
- ac-policy-sweep.ts
- Ally — Consolidated PR Review
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- issue-runtime-service-command-masking.test.ts
- ensureHumanRoleDefaultGrants
- codex-models.ts
- pause-hold-guard.ts
- heartbeat-worker-crash-marking.test.ts
- ccrotate-plugin-retirement.test.ts
- environment-test-harness.test.ts
- human-gated-gate-revalidation-wiring.test.ts
- agent-budgets-route-config-revision.test.ts
- blocked-inbox-count-list-parity.test.ts
- cases-routes.test.ts
- board-chat.ts
- plugin-metric-exposition.test.ts
- heartbeat-ccrotate-capacity-retry.test.ts
- executeProcess
- createApp
- issue-telemetry-routes.test.ts
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- assertAssignableAgent
- billing-classification.ts
- unprocessable
- plugin-activation-boot-retry.test.ts
- issue-stale-execution-lock-routes.test.ts
- plugin-manifest-validator.ts
- syncPipelineStageAutomation
- environment-instance-routes.test.ts
- agents-service-secret-bindings.test.ts
- pr-issue-backlink-lock.test.ts
- classifyTaskWatchdogSubtree
- heartbeat-accepted-plan-workspace-refresh.test.ts
- issue-monitor-queue-lock.ts
- applyResponsibleUserIntersection
- Ally — Consolidated PR Review
- human-gated-gate-revalidation-backfill.test.ts
- startup-filesystem-io.test.ts
- chain
- ceo/AGENTS.md
- EnvironmentCustomImageSshShell
- penstock-availability-gate.test.ts
- Ally — Consolidated PR Review
- companySkillService
- github-api-refusal-metric.test.ts
- pod-failure-label-corpus.test.ts
- db-inherited-timeout-metric.test.ts
- renderYamlBlock
- feedback-service.test.ts
- plugin-worker-invocation-scope.cjs
- issue-checkout-routine-lock-conflict.test.ts
- issue-release-lock-only-degrade.test.ts
- invite-defaults-response-boundary.test.ts
- startup-dispatch-isolation.test.ts
- reflection-coach/AGENTS.md
- Recent agent reflection sweep
- summarizer/AGENTS.md
- Refresh stale summary slots
- metrics-route-no-db.test.ts
- reviewer-wake-outcome-log-fields.test.ts
- SOUL.md -- CEO Persona
- Wake Pre-flight (do this FIRST when woken)
- activityService
- authz-existence-oracle-guard.test.ts
- plugin-worker-delayed.cjs
- plugin-worker-terminated.cjs
- inspectExecutionWorkspaceBranchForReconcile
- postgres-pool-budget.test.ts
- recovery-candidate-phase-timer-coverage.test.ts
- default/AGENTS.md
- recovery-pause-hold-guard-call-shape.test.ts
- express.d.ts
- TOOLS.md
- workspace-runtime-read-model.ts
- performIssueMonitorRecovery
- collectClassifierInput
- execution-workspaces-service.test.ts
- task-watchdogs-scheduler.test.ts
- readProjectWorkspaceRuntimeConfig
- heartbeat-quota-recovery-wake-scope.test.ts
- upsertIssueWatchdogForIssue
- ensureServerWorkspaceLinksCurrent
- heartbeat-worktree-suppression.test.ts
- recovery-chain-pass-timing-wiring.test.ts
- materializeImportEnvInputValues
- OAuthMintBearer
- issue-assignment-wakeup.ts
- agent-auth-middleware.test.ts
- execution-lock-orphan-cleanup.test.ts
- health.test.ts
- heartbeat-finalize-cancelled-skip-dispatch.test.ts
- workspace-operation-secret-scrub.test.ts
- healthz-probe-route.test.ts
- parseYamlBlock
- readAutomationExecutionContext
- error-handler.test.ts
- plugin-agent-invoke-wake-fanout.test.ts
- github-webhook-dedicated-pool.test.ts
- services/sidebar-preferences.ts
- heartbeat-adapter-resolution-guard.test.ts

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 607 edges
2. `unprocessable()` - 382 edges
3. `issueRoutes()` - 380 edges
4. `notFound()` - 337 edges
5. `issueService()` - 270 edges
6. `logActivity()` - 259 edges
7. `recoveryService()` - 254 edges
8. `executeRun()` - 242 edges
9. `parseObject` - 196 edges
10. `agentRoutes()` - 188 edges

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

## Communities (549 total, 75 omitted from the detail section)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (300): appendWithByteCap, createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), describeGitFailure(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS, activeRunExecutions (+292 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (138): ParsedExecutionWorkspaceMode, resolvePinnedIssueWorkspaceStrategyType(), getDefaultCompanyGoal(), GoalReader, MaybeId, resolveIssueGoalId(), resolveNextIssueGoalId(), ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS (+130 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.05
Nodes (54): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), bufferToPortableBinaryFile(), buildLegacyRoutineTriggerFromRecurrence(), COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS (+46 more)

### Community 3 - "errorHandler"
Cohesion: 0.03
Nodes (47): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), createApp() (+39 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.12
Nodes (18): assertBelongsToCompany(), FinanceDateRange, financeService(), rangeConditions(), createApp(), createAppWithActor(), loadCostParsers(), makeDb() (+10 more)

### Community 5 - "services/index.ts"
Cohesion: 0.03
Nodes (153): hermesGatewayAgentConfigurationDoc, PRECOMPRESSED_STATIC_EXTENSIONS, STATIC_CONTENT_TYPES, UiMode, VITE_DEV_ASSET_PREFIXES, VITE_DEV_STATIC_PATHS, isAllowedContentType(), forbidden() (+145 more)

### Community 6 - "issueRoutes"
Cohesion: 0.02
Nodes (125): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), buildCreateIssueActivityStatusDetails(), buildExecutionStageWakeContext(), buildExecutionStageWakeup(), buildRequestItemVerdictsWakeIdempotencyKey(), compactIssueListEtag(), companySearchRateLimitActor() (+117 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.03
Nodes (152): skillImportPolicyResource(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillKeyAllowed(), assertImportedSkillSourceAllowed(), assertNoSymlinksInLocalTree(), assertVersionMatchesSkill(), asString(), auditInstalledSkillBytes() (+144 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.05
Nodes (86): actorOwnsLease(), addFormVariablesForStage(), adjustParentCounts(), assertActorCanApproveStageExit(), assertCaseKey(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertLeaseAvailable() (+78 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (149): IssueApprovalLinkAuthorizationIssue, ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema, authenticatedActorResponsibleUserId() (+141 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.04
Nodes (61): reconcileApprovedBuiltInAgent(), BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), assertAdapterAllowed(), assertKnownBuiltInAgentModel() (+53 more)

### Community 12 - "issue-dependency-wakeups-routes.test.ts"
Cohesion: 0.14
Nodes (12): findExistingIssueBlockersResolvedWake(), IDEMPOTENT_DEPENDENCY_WAKE_STATUSES, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, createApp(), mockDb, mockFindExistingIssueBlockersResolvedWake, mockIssueService, mockListBlockedDependentIssueIds (+4 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (93): ExecutionWorkspaceTeardownTrigger, applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), assertDirtyQuarantineRuntimeServicesStopped(), branchIncoherenceValidationFailure(), buildDirtyQuarantineRescueBranch(), buildWorkspaceTemplateData(), clampBranchBasePreservingIdentifier() (+85 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.02
Nodes (113): BUNDLED_PLUGIN_PACKAGES, isIsolatedSdkPluginPackage(), ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH (+105 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (184): acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), buildDependabotAlertIssueBody(), buildDependabotRefireComment(), buildDependabotSuppressedRefireComment() (+176 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (92): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertPipelineAccess(), assertPipelineCompanyAccess(), assertPipelineWriteAccess() (+84 more)

### Community 17 - "embedded-postgres.ts"
Cohesion: 0.03
Nodes (41): runningProcesses, STARVATION_ABSOLUTE_ESCALATION_MS, STARVATION_FULL_ESCALATION_MS, numberFromEnv(), SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY, mockListSkills, activeReservations(), Db (+33 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.04
Nodes (69): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+61 more)

### Community 19 - "readNonEmptyString"
Cohesion: 0.06
Nodes (54): clearInteractionContinuationWakeContext(), deriveNormalizedUsageDelta(), derivePaperclipPrTaskKey(), deriveTaskKey(), deriveTaskKeyWithHeartbeatFallback(), enrichWakeContextSnapshot(), hasInteractionContinuationWakeContext(), evaluateSessionCompaction() (+46 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (46): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview() (+38 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (56): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+48 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.05
Nodes (47): createCompanyInviteForCompany(), agentJoinGrantsFromDefaults(), AvailableSkill, companyInviteExpiresAt(), CompanyMemberRecord, createInviteToken(), defaultInviteResolutionNetwork, grantsFromDefaults() (+39 more)

### Community 23 - "executeRun"
Cohesion: 0.02
Nodes (146): getServerAdapter(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), applyAgentGitIdentityToRuntimeConfig(), applyPersistedExecutionWorkspaceConfig(), assertGitSensitiveAdapterWorkspaceValid(), assertPathContained(), attachPaperclipSessionMetadataToSessionParams() (+138 more)

### Community 24 - "approvals-service.test.ts"
Cohesion: 0.07
Nodes (16): ApprovalRecord, expectRejectedWithoutMutation(), mockAgentService, mockLogActivity, mockNotifyHireApproved, readStatus(), withdrawalActor, call() (+8 more)

### Community 25 - "heartbeatService"
Cohesion: 0.02
Nodes (290): parseObject, publishPluginDomainEvent(), countRunsOccupyingSlots(), resolveExternalLifecycleConcurrency(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds(), markAgentStartLockPhase(), rethrowIfAgentStartLockAborted() (+282 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.03
Nodes (88): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, buildThresholds(), DbOrTx, DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS, DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS (+80 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (63): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+55 more)

### Community 28 - "plugins.ts"
Cohesion: 0.03
Nodes (61): AvailableBundledPlugin, bundledPluginMetadata(), __dirname, discoverBundledPlugins(), DiscoveredBundledPlugin, EXPERIMENTAL_BUNDLED_PLUGIN_PACKAGE_NAMES, fileExists(), findPackageJsonFiles() (+53 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.09
Nodes (38): createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), getSandboxProviderConfigSchema(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe(), ParsedEnvironmentConfig (+30 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (54): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+46 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.12
Nodes (25): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+17 more)

### Community 32 - "services/cloud-upstreams.ts"
Cohesion: 0.08
Nodes (40): buildEntitiesFromPortableExport(), buildLocalChunks(), buildLocalUpstreamExportBundle(), canonicalJson(), cloudUpstreamRemoteFailureReport(), buildBundle(), ConnectionRow, countEntityTypesForManifest() (+32 more)

### Community 33 - "toolAccessService"
Cohesion: 0.04
Nodes (127): HttpError, asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor(), readStdioTemplateId() (+119 more)

### Community 34 - "registry.ts"
Cohesion: 0.05
Nodes (40): BUILTIN_ADAPTER_TYPES, ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx, acpxLocalAdapter, adapterAcceptsModelForConfig(), adapterModelRegistryIsClosed(), adaptersByType (+32 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (76): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+68 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.04
Nodes (101): ColdInReviewGaugeEntry, ColdInReviewIssueRow, addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding() (+93 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.06
Nodes (53): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+45 more)

### Community 38 - "cases.ts"
Cohesion: 0.07
Nodes (52): normalizeContentType(), annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany(), assertProjectBelongsToCompany(), autoLinkRunIssue() (+44 more)

### Community 39 - "index.ts"
Cohesion: 0.06
Nodes (45): EventLoopStallLogOptions, resolveStallThresholdMs(), setEventLoopStallListener(), startEventLoopStallLogging(), BetterAuthSessionResult, BetterAuthSessionUser, EmbeddedPostgresCtor, EmbeddedPostgresInstance (+37 more)

### Community 40 - "recoveryService"
Cohesion: 0.03
Nodes (165): isTerminalIssueStatus(), shouldReopenTerminalIssueForDeferredWake(), reconcileUndeliverableIssueMonitors(), issueLockOwnerStateMatches(), lockIssueOwnership(), buildIssueBlockersResolvedWakeIdempotencyKey(), findExistingIssueBlockersResolvedWakeForAnyKey(), buildIssueMonitorEligibilityPatch() (+157 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.07
Nodes (62): applyCustomImageTemplateToSandboxConfig(), classifyEnvironmentCustomImageConfigChange(), defaultEnvironmentCustomImageRuntimeConfigBinding(), ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS, ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS, EnvironmentCustomImageConfigChangeKind, EnvironmentCustomImageRuntimeConfigBinding (+54 more)

### Community 42 - "feedback.ts"
Cohesion: 0.08
Nodes (58): appendNote(), asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildClaudeTraceFiles(), buildCodexTraceFiles() (+50 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (222): createBetterAuthHandler(), normalizeAuthLocationHeader(), ACCEPTED_INTERACTION_OUTCOME_METRIC, ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC, ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC, ACCEPTED_INTERACTION_OUTCOME_RECENT_METRIC, AGENT_ERROR_REASON_NONE, AGENT_ERROR_REASON_OTHER (+214 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.07
Nodes (64): AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments(), directoryResource() (+56 more)

### Community 45 - "openapi.ts"
Cohesion: 0.05
Nodes (42): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+34 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.11
Nodes (33): resolveRawGitHubUrl(), CatalogManifestFile, CatalogManifestUnavailableError, copyCatalogSkillFile(), devCatalogManifestPath, devCatalogPackageRoot, fetchCatalogSourceFile(), getCatalogManifest() (+25 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.05
Nodes (97): loadConfig(), __test_stackedChildDirective, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyWorkflowRunNotFound() (+89 more)

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
Cohesion: 0.08
Nodes (32): stripSandboxProviderEnvelope(), buildEnvironmentSecretMetadataForLeaseFingerprint(), buildReusableSandboxLeaseFingerprint(), buildReusableSandboxLeaseScope(), createSandboxEnvironmentDriver(), cleanupObsoleteReusableSandboxLeases(), destroyReusableSandboxLease(), releasePluginBackedSandboxLease() (+24 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.10
Nodes (32): PenstockProbeOutcomeLabel, PenstockProbePathLabel, asRecord(), buildCapacityUrl(), buildMessagesUrl(), CacheEntry, capacityRetryFromBody(), isPenstockCapacityBody() (+24 more)

### Community 53 - "authorization.ts"
Cohesion: 0.09
Nodes (33): AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction, assignmentPolicyEffect(), loadIssueAuthorizationPolicy() (+25 more)

### Community 54 - "routes/approvals.ts"
Cohesion: 0.03
Nodes (97): ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext(), requireApprovalAccess(), resolveBoardEscalationCoalesceKey(), stampPriors() (+89 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.07
Nodes (37): classifyRemovalProof(), decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup() (+29 more)

### Community 56 - "tool-gateway.test.ts"
Cohesion: 0.09
Nodes (6): awaitRateLimitWindow(), createApprovedToolAction(), createTestToolGatewayService(), Db, FakeMcpRequest, ToolGatewayServiceOptions

### Community 57 - "external-runtime-reservations.ts"
Cohesion: 0.09
Nodes (34): bindExternalRuntimeReservationIsolation(), claimRunWithExternalRuntimeSlot(), claimRunWithExternalRuntimeSlotOutcome(), claimRunWithExternalRuntimeSlotPool(), ExternalRuntimeClaim, ExternalRuntimeIsolationConflictError, ExternalRuntimeIsolationMode, ExternalRuntimeJobNameMismatchError (+26 more)

### Community 58 - "issue-agent-mutation-ownership-routes.test.ts"
Cohesion: 0.05
Nodes (35): cheapRecoveryDedupeHarness(), collectSqlParams(), createApp(), createAuthorizationDecisionDb(), createRunContextDb(), createWatchdogDb(), DeniedWriteLookupKind, deniedWriteLookupLimitStub() (+27 more)

### Community 59 - "redaction.ts"
Cohesion: 0.06
Nodes (68): RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, assignRecordKey(), BENIGN_HEADER_NAMES, classifyKeyTier(), CLI_SECRET_FLAG_RE, ENV_DUMP_SECRET_ASSIGNMENT_RE, ESCAPED_JSON_SECRET_FIELD_TEXT_RE (+60 more)

### Community 60 - "adapters.ts"
Cohesion: 0.12
Nodes (42): buildExternalAdapters(), extractUiParserSource(), getOrExtractUiParserSource(), getUiParserSource(), loadExternalAdapterPackage(), loadFromRecord(), reloadExternalAdapter(), resolvePackageDir() (+34 more)

### Community 61 - "conflict"
Cohesion: 0.13
Nodes (45): conflict(), archiveMember(), assertAssignableArchiveTarget(), assertCanRemoveActiveOwner(), updateMember(), updateMemberAndPermissions(), buildFolderViews(), FolderRow (+37 more)

### Community 62 - "services/execution-workspaces.ts"
Cohesion: 0.09
Nodes (39): assertBranchReconcileRuntimeServicesStopped(), assertBranchReconcileWorkspaceIsSafe(), assertLockedBranchReconcileWorkspaceStillMatchesInspection(), assigneeMatchesExecutionPrincipal(), cloneRecord(), deriveAgentCwd(), ExecutionWorkspaceBranchReconcileActor, ExecutionWorkspaceBranchReconcileInspection (+31 more)

### Community 63 - "services/issue-tree-control.ts"
Cohesion: 0.07
Nodes (48): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+40 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.10
Nodes (33): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+25 more)

### Community 65 - "sandbox-provider-runtime.ts"
Cohesion: 0.07
Nodes (27): findReusableSandboxLeaseId(), AcquireSandboxLeaseInput, acquireSandboxProviderLease(), assertProviderConfig(), buildFakeSandboxProbe(), DestroySandboxLeaseInput, FakeSandboxProvider, findReusableSandboxProviderLeaseId() (+19 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.14
Nodes (13): DurableRunLogStoreOptions, createLocalDiskStorageProvider(), normalizeObjectKey(), resolveWithin(), createStorageProviderFromConfig(), createS3StorageProvider(), normalizePrefix(), S3ProviderConfig (+5 more)

### Community 67 - "body-parsers.ts"
Cohesion: 0.15
Nodes (17): DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody(), Frame (+9 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.15
Nodes (22): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), parseField() (+14 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.06
Nodes (27): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), derivePluginDatabaseNamespace(), extractQualifiedRefs(), normaliseSql(), PluginDatabaseClient (+19 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.09
Nodes (55): renderTemplate, adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService(), findLocalServiceRegistryRecordByRuntimeServiceId(), getRuntimeServiceRegistryPath() (+47 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.10
Nodes (32): recordProjectPrimaryWorkspaceFallback(), attachGoals(), attachListMetrics(), attachWorkspaces(), buildManagedProjectDefaults(), buildProjectListMetricMaps(), CreateWorkspaceInput, deriveNameFromCwd() (+24 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (34): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+26 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.08
Nodes (37): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+29 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.04
Nodes (72): ACKNOWLEDGEABLE_OUTCOME_INTERACTION_KINDS, assertExpectedOutcomeRefResolves(), assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult() (+64 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.05
Nodes (59): RFC-1918, badRequest(), parseDateQuery(), parseIntegerQuery(), parseKind(), ADAPTER_OVERRIDE_ALLOWED_KEYS, ALLOWED_PROTOCOLS, BufferedLogEntry (+51 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.11
Nodes (35): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+27 more)

### Community 77 - "cloudUpstreamService"
Cohesion: 0.09
Nodes (37): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildWarnings(), cloudUpstreamRunStatus(), cloudUpstreamService(), assertNoRunningRun() (+29 more)

### Community 78 - "agentService"
Cohesion: 0.07
Nodes (55): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, describeAgentStartLockDispatchHealth(), forgetExpiredAborts(), AgentConfigSnapshot, agentService(), assertBuiltInAgentMetadataMutationAllowed() (+47 more)

### Community 79 - "company-search.ts"
Cohesion: 0.08
Nodes (54): activeIssueFilters(), artifactResult(), companySearchService(), countAgents(), countArtifacts(), countProjects(), countTotalNonIssue(), enrichIssueSnippets() (+46 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.10
Nodes (24): ActorFields, isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict(), IssueRow, IssueWatchdogRow, IssueWatchdogUpsertInput, isUniqueConstraintConflict(), normalizeStopFingerprint() (+16 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.05
Nodes (42): allocateFetchAllowedLoopbackPort(), appendRedirectParam(), asRecord(), assertSmokeOAuthRedirectUri(), escapeHtml(), FETCH_BLOCKED_PORTS, FIXTURE_TOOLS, FixtureTool (+34 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.07
Nodes (41): WorkspaceOperationRecorder, executeProcessForTests, GIT_INDEX_LOCK_STALE_MS, isProcessGroupAliveForTests, LockHolderScan, setLockHolderScanForTests(), setProcessGroupLivenessProbeForTests(), setSubmoduleInspectSettingsForTests() (+33 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (42): PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, drainInFlightExecutions(), expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts(), isPidAlive() (+34 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "logger.ts"
Cohesion: 0.07
Nodes (36): autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin(), installKkrooLocalPlugins() (+28 more)

### Community 87 - "documentAnnotationService"
Cohesion: 0.12
Nodes (9): ActorInput, CaseDocumentRow, commentSelect, documentAnnotationService(), assertLinkedIssueComment(), IssueDocumentRow, RoutineDocumentRow, snapshotFromThread() (+1 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.11
Nodes (23): AuthenticatedTerminalContext, closeUpgradeSocket(), createSsh2EnvironmentCustomImageSshConnector(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, CustomImageTerminalService, decodeClientMessage(), EnvironmentCustomImageSshConnector, IncomingMessageWithTerminalContext (+15 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "board-claim.ts"
Cohesion: 0.36
Nodes (8): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge()

### Community 91 - "config.ts"
Cohesion: 0.05
Nodes (39): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS, numericEnv(), NumericSettingBounds (+31 more)

### Community 92 - "wake-idempotency.test.ts"
Cohesion: 0.43
Nodes (4): findWakeIdempotencyReceipt(), attemptWakeEffect(), insertWake(), WAKE_IDEMPOTENCY_RECEIPT_STATUSES

### Community 93 - "recovery/service.ts"
Cohesion: 0.02
Nodes (149): DeferredWakeReopenEligibility, LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), WAKE_COMMENT_IDS_KEY, readFullRunLog(), FRESHNESS (+141 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.14
Nodes (40): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+32 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.15
Nodes (24): prepareHotRestartShutdown(), toHotRestartIntentRun(), asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent (+16 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.06
Nodes (41): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+33 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (20): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+12 more)

### Community 99 - "aws-secrets-manager-provider.ts"
Cohesion: 0.02
Nodes (99): resolveDefaultSecretsKeyFilePath(), asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), awsProviderSafeMessage() (+91 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (26): installActor(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectLimit, mockDbSelectOrderBy (+18 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.09
Nodes (28): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+20 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "ensurePersistedExecutionWorkspaceAvailable"
Cohesion: 0.09
Nodes (47): classifyGitCheckoutProbeFailure(), describeSubmoduleInspectionDegradation(), detectDefaultBranch(), directoryExists(), ensureGitSubmodulesReady(), ensureGitWorktreeBranchCoherent(), ensurePersistedExecutionWorkspaceAvailable(), findVerifiedManagedProjectPrimaryCheckout() (+39 more)

### Community 104 - "process-mapping-metrics.test.ts"
Cohesion: 0.07
Nodes (41): PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC, PROCESS_MAPPING_RSS_BYTES_METRIC, PROCESS_MAPPING_SCAN_SECONDS_METRIC, PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC, PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC, PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC, setProcessMappingMetrics(), ANON_ALIGNED_64M_FULL_CLASS (+33 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.05
Nodes (66): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart() (+58 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.15
Nodes (22): composeSweepWakeFramePage(), currentMinuteBucket(), detectSweepWakeRace(), getIssueSnapshot(), isCompanyFlagEnabled(), listIssueBlockerIds(), listRecentComments(), maxBlockerCompletedAt() (+14 more)

### Community 107 - "plugin-tool-dispatcher.ts"
Cohesion: 0.07
Nodes (14): PluginRouteToolDeps, createPluginToolDispatcher(), handlePluginEnabled(), registerFromDb(), PluginToolDispatcher, PluginToolDispatcherOptions, createPluginToolRegistry(), addTool() (+6 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (26): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+18 more)

### Community 109 - "budgetService"
Cohesion: 0.04
Nodes (66): APPROVAL_SUBJECT_KEYS, ApprovalInsertValues, hasApprovalSubject(), insertApproval(), insertApprovalRecord(), ApprovalListFilters, approvalService(), deriveSummaryLabel() (+58 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.06
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (23): createApp(), currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService (+15 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.06
Nodes (42): AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput, AgentScorecardOptions, AgentScorecardsResult, computeAgentScorecards(), MIN_SAMPLE_DONE (+34 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.13
Nodes (16): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+8 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.03
Nodes (116): hasScheduledMonitor(), classifySourceRecoveryRevalidation(), isLapsedMonitorRearmPatch(), writeIssueMonitor(), summarizeIssueMonitor(), dispatchClaimedIssueMonitor(), tickDueIssueMonitors(), ISSUE_MONITOR_DISPATCH_LAPSE_MS (+108 more)

### Community 115 - "listBlockedInboxIssues"
Cohesion: 0.07
Nodes (41): activeRunMapForIssues(), activeRunMapKey(), appendBlockerAttentionEdges(), blockedByMapForIssues(), blockedInboxAttentionResponseFields(), blockedInboxResponseDescription(), blockedInboxSearchText(), blockerSampleIdentifier() (+33 more)

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

### Community 122 - "productivityReviewService"
Cohesion: 0.07
Nodes (60): extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isTerminalGateClosableTriggerSet(), isTerminalIssueStatus(), isUnchangedSampleClosableTriggerSet(), productivityReviewAssignmentWakeIdempotencyKey(), productivityReviewEscalationFingerprint(), productivityReviewFingerprint() (+52 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.09
Nodes (49): RFC-6901, ownRecordValue(), AMBIGUOUS_SCHEMA_NODE, childNodesForIndex(), childNodesForKey(), collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues(), collectStringLeaves() (+41 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.14
Nodes (22): awsSecretsManagerProvider, SecretProviderVaultRuntimeConfig, asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind (+14 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "github-review-gate-authority.ts"
Cohesion: 0.07
Nodes (51): gitHubIdentityFieldRedaction(), _resetInstallationTokenCache(), activateGithubReviewGateDelivery(), affectsProtectedBase(), Candidate, claimDueGithubReviewGateDeliveries(), COMMENT_ACTIONS, commentSignals() (+43 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.11
Nodes (16): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+8 more)

### Community 128 - "normalizeAgentDefaultsForJoin"
Cohesion: 0.17
Nodes (20): buildJoinDefaultsPayloadForAccept(), canReplayOpenClawGatewayInviteAccept(), extractHeaderEntries(), generateEd25519PrivateKeyPem(), hashToken(), headerMapGetIgnoreCase(), headerMapHasKeyIgnoreCase(), isDefaultHermesDashboardRoot() (+12 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.09
Nodes (27): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+19 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.14
Nodes (25): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), continuationSummaryParksExecutor(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates() (+17 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.10
Nodes (16): key(), createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), isAtOrPastEnd(), normalizeKeyPrefix() (+8 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.10
Nodes (34): githubAppCredentialsConfigured(), GitHubCommitStatusState, appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), DbHandle, deliveryClaimWhere(), DeliveryRow (+26 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "enqueueWakeup"
Cohesion: 0.03
Nodes (97): execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment(), execute(), processAdapter, summarizeStatus() (+89 more)

### Community 135 - "server-info.ts"
Cohesion: 0.16
Nodes (14): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, createServerInfoSnapshot(), getGitLocalChanges(), getServerInfoSnapshot() (+6 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.13
Nodes (8): parseWakePayloadFromMessage(), createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.10
Nodes (31): createK8sEnvironmentDriver(), createLocalEnvironmentDriver(), createSshEnvironmentDriver(), EnvironmentRuntimeService, getDriver(), requireDriver(), requireDriverKey(), ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES (+23 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.08
Nodes (42): AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES, matchExclusionRule() (+34 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.05
Nodes (33): ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runOwnsIssueExecutionLock(), runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUS_VALUES, TERMINAL_HEARTBEAT_RUN_STATUSES, clampIssueListLimit(), extractExecutiveHoldMarker() (+25 more)

### Community 140 - "heartbeat-wake-dispatch-retry.test.ts"
Cohesion: 0.04
Nodes (54): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, ActivePauseHoldRow, activePauseHoldsGauge(), AGE_BUCKETS, AgeBucket, countActivePauseHolds(), ISSUE_TREE_ACTIVE_PAUSE_HOLDS_METRIC (+46 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.10
Nodes (35): readObject(), resolveAgentSelfTrustPreset(), readRunIssueId(), assertAgentCanManageRuntimeServicesForWorkspace(), assertLowTrustCanManageRuntimeForActor(), assertLowTrustCanManageRuntimeForIssue(), listReportingSubtreeAgentIds(), readRunIssueId() (+27 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "accessService"
Cohesion: 0.06
Nodes (34): createLiveEventTranscriptGate(), decisionReason(), defaultTranscriptStreamAuditor(), GateOutcome, LIVE_EVENT_TRANSCRIPT_AUDIT_ACTION, LiveEventSubscriberContext, LiveEventTranscriptAuditEntry, MembershipReader (+26 more)

### Community 145 - "services/resource-memberships.ts"
Cohesion: 0.15
Nodes (9): assertBoardSelfMembershipAccess(), BoardActor, evaluatePolicy(), MembershipChangeKind, MembershipUpdateResult, PolicyDecision, ResourceMembershipPolicyHook, assertMutationAllowed() (+1 more)

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
Cohesion: 0.09
Nodes (10): closeServer(), createSession(), FakeSshShell, flushPromises(), futureDate(), listen(), require, startHarness() (+2 more)

### Community 150 - "issue-efficiency.ts"
Cohesion: 0.17
Nodes (16): AdapterUsage, adapterUsageForIssues(), ApportionedAdapter, apportionIssueAcrossAdapters(), CostSource, coverageForWindow(), CoverageReport, IssueEfficiency (+8 more)

### Community 151 - "issueService"
Cohesion: 0.03
Nodes (82): defaultIssueExecutionWorkspaceSettingsForProject(), activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter(), blockedInboxIssueConditions() (+74 more)

### Community 152 - "successful-run-handoff.ts"
Cohesion: 0.07
Nodes (49): agentLinkRow(), AgentRow, boundedLinkText(), buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice(), decideSuccessfulRunHandoff(), DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS (+41 more)

### Community 153 - "companies-route-cross-company-authz.test.ts"
Cohesion: 0.12
Nodes (16): createApp(), createCompany(), exportPreviewResult(), exportRequest, exportResult(), importResult(), mockAccessService, mockAgentService (+8 more)

### Community 154 - "version.ts"
Cohesion: 0.14
Nodes (17): compactRecord(), DebugLog, GitDescribeCommand, hasGitMetadataBeforeNodeModulesBoundary(), hasPathSegment(), isPackagedInstall(), normalizeErrorField(), PackageJson (+9 more)

### Community 155 - "human-gated-ageing.ts"
Cohesion: 0.10
Nodes (37): AgedHumanGatedIssue, classifyHumanGatedWait(), comparePriority(), DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY, escalateAfterDaysFor(), formatAge(), formatHumanGatedAgeingSections(), formatIssueRef() (+29 more)

### Community 157 - "worker-tier-proxy.ts"
Cohesion: 0.10
Nodes (24): RFC-7230, boardOrgAccessProxyGuard(), CONNECT_PHASE_ERROR_CODES, createWorkerProxyHandler(), fetchWithStartupRetry(), forwardRequestHeaders(), hasRequestBody(), HOP_BY_HOP_HEADERS (+16 more)

### Community 158 - "agent-start-lock.ts"
Cohesion: 0.04
Nodes (63): AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), abortedAgentId(), abortReason(), CancellableQuery (+55 more)

### Community 159 - "agentRoutes"
Cohesion: 0.03
Nodes (122): describeUnregisteredModel(), detectAdapterModel(), filterAdapterModelsForConfiguredAllowlist(), findActiveServerAdapter(), getDeclaredAdapterModels(), isOpenCodeAdapterType(), listAdapterModelProfiles(), listAdapterModels() (+114 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (131): bodyReRaisesPriorFinding(), isActionableReviewFeedbackContext(), isClaudeCodeReviewServiceNotice(), prFeedbackBody(), reRaisedPriorFindingLabels(), reRaisesPriorFinding(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN (+123 more)

### Community 161 - "services/instance-settings.ts"
Cohesion: 0.11
Nodes (27): applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema, InstanceSettingsServiceOptions, isTruthyRuntimeEnvValue(), normalizeExperimentalSettings(), normalizeGeneralSettings() (+19 more)

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
Cohesion: 0.11
Nodes (47): allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentHasRecoveryHandoffGrantOnIssue(), agentHoldsIssueAcrossDependencyEdge(), agentWithinLowTrustBoundary(), allowIssueMentionGrant() (+39 more)

### Community 166 - "human-gated-ageing-digest.ts"
Cohesion: 0.06
Nodes (46): db, MAX_PRS, token, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk(), collectDigest() (+38 more)

### Community 167 - "normalizeHumanRole"
Cohesion: 0.23
Nodes (12): approveHumanJoinRequestFromInvite(), addCompanyMemberRemovalAccess(), assertCanManageCompanyMember(), getProtectedMemberReason(), resolveActorHumanRole(), grantsForHumanRole(), HUMAN_COMPANY_MEMBERSHIP_ROLES, normalizeHumanRole() (+4 more)

### Community 168 - "heartbeat-provider-capacity-horizon.test.ts"
Cohesion: 0.04
Nodes (36): registerServerAdapter(), unregisterServerAdapter(), createAdapter(), createApp(), installedRecord(), instanceAdmin, mocks, requestApp() (+28 more)

### Community 169 - "ac-policy-assignee-routing.ts"
Cohesion: 0.13
Nodes (16): AcPolicyAgentTargetReason, AcPolicyFilingTarget, AcPolicyFilingTargetInput, AcPolicyResolvedOwner, AcPolicySkippedAgent, AcPolicySweepAgent, AcPolicyUnroutableReason, AcPolicyUserTargetReason (+8 more)

### Community 170 - "company-portability-routes.test.ts"
Cohesion: 0.11
Nodes (13): cloudHeaders, createApp(), exportRequest, importRequest, mockAccessService, mockAgentService, mockBudgetService, mockCompanyArtifactsService (+5 more)

### Community 171 - "linear-auth.ts"
Cohesion: 0.07
Nodes (41): LinearTeam, LinearTeamExpectation, LinearTeamFailure, LinearTeamMatch, LinearTeamResolution, linearTeamResolutionError(), resolveLinearTeam(), callbackPage() (+33 more)

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
Nodes (42): DEFAULT_SAMPLE_INTERVAL_MS, EXTERNAL_PEAK_COMPONENT, finite(), HEAP_TOTAL_PEAK_COMPONENT, HEAP_USED_PEAK_COMPONENT, HeapPeakReading, HeapSizeReading, readHeapPeaks() (+34 more)

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.24
Nodes (13): resetCodexModelsCacheForTests(), collectFromJsonValue(), CursorModelsCommandResult, dedupeModels(), fetchCursorModelsFromCli(), isLikelyModelId(), listCursorModels(), mergedWithFallback() (+5 more)

### Community 184 - "health.ts"
Cohesion: 0.17
Nodes (17): AuthCapabilities, hasDevServerStatusToken(), healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), alertFileCandidates() (+9 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "work-timeline.ts"
Cohesion: 0.13
Nodes (25): actorId(), dateIso(), IssueRow, maybeUuidList(), normalizeLimit(), normalizeOffset(), normalizeRunUsage(), normalizeTimelineWindow() (+17 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.14
Nodes (17): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, blocked(), CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokability() (+9 more)

### Community 188 - "pipelineService"
Cohesion: 0.08
Nodes (42): redactRunError(), activityActorPatch(), assertReviewTargetsInSet(), defaultRetryCleanup(), descendantCaseIds(), enqueueStageAutomationLedger(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow() (+34 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.06
Nodes (44): DbOrTransaction, isRecord(), IssueRecoveryActionRow, issueRecoveryActionService(), dischargeActionsWithRestoredExecution(), escalateExpiredWakeHorizons(), findSupersededRestoredClaim(), getActiveForIssue() (+36 more)

### Community 190 - "body"
Cohesion: 0.05
Nodes (35): body(), verdictBlock(), Coverage, dockerfilePath, helpersPath, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles() (+27 more)

### Community 191 - "issue-workspace-command-authz.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockExecutionWorkspaceService (+6 more)

### Community 192 - "githubWebhookRoutes"
Cohesion: 0.08
Nodes (33): deriveGithubWebhookMaxConcurrentDeliveries(), derivePrReviewerWakeMaxConcurrency(), githubWebhookRoutes(), AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), buildForeignCommitNoticeBody(), CommitAuthorRef, CommitSkipReason (+25 more)

### Community 193 - "heap-snapshot.ts"
Cohesion: 0.10
Nodes (36): collectPrunable(), ConcurrentSnapshotWriters, decideHeapSnapshot(), defaultHeapSnapshotRuntime, describeSentinelOutcome(), ensureHeapSnapshotDir(), findConcurrentSnapshotWriters(), HEAP_SNAPSHOT_EXTENSION (+28 more)

### Community 194 - "heartbeat-stop-metadata.ts"
Cohesion: 0.22
Nodes (16): isMaxTurnExhaustionRun(), buildHeartbeatRunStopMetadata(), defaultTimeoutSecForAdapter(), hasOwn(), HeartbeatRunOutcome, HeartbeatRunStopMetadata, HeartbeatRunStopReason, HeartbeatRunTimeoutPolicy (+8 more)

### Community 195 - "remote-http-endpoint-guard.ts"
Cohesion: 0.14
Nodes (16): assertPublicRemoteHttpEndpoint(), isPrivateOrReservedIp(), isPrivateOrReservedIpv4(), isPrivateOrReservedIpv6(), LookupResult, lookupWithTimeout(), parseIpv4Address(), parseMappedIpv4Hex() (+8 more)

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

### Community 201 - "join-request-dedupe.ts"
Cohesion: 0.54
Nodes (6): collapseDuplicatePendingHumanJoinRequests(), findReusableHumanJoinRequest(), humanJoinRequestIdentity(), JoinRequestLike, nonEmptyTrimmed(), normalizeJoinRequestEmail()

### Community 202 - "issue-recovery-actions.test.ts"
Cohesion: 0.10
Nodes (31): backstopSweepCompletionPath, RECOVERY_SWEEP_COVERED_ISSUE_STATUSES, STRANDED_ASSIGNED_ISSUE_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES, AnyFn, blockSourceOnFreshIssue(), createApp() (+23 more)

### Community 203 - "metrics-ingest.ts"
Cohesion: 0.09
Nodes (24): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), cache (+16 more)

### Community 204 - "execution-policy-bootstrap.ts"
Cohesion: 0.17
Nodes (14): AdapterRegistryEnv, parseAdapterRegistryEnv(), setAdapterDisabled, reconcileAdapterAvailability(), ENTRY, KubernetesEnvironmentConfigInput, applyExecutionPolicyBootstrap(), bootstrapExecutionPolicyFromEnv() (+6 more)

### Community 205 - "github-review-posted-metric.test.ts"
Cohesion: 0.22
Nodes (4): __test_resolvePostedReviewObservation, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC, ALLY_REVIEW_BODY

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.14
Nodes (20): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+12 more)

### Community 208 - "agent-inbox-lite.ts"
Cohesion: 0.05
Nodes (48): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseOffsetParam(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN (+40 more)

### Community 209 - "responsible-user-denial-run-outcomes.ts"
Cohesion: 0.43
Nodes (4): row(), normalizeResponsibleUserDenialCode(), recordResponsibleUserDenialOnActiveRun(), publishLiveEventMock

### Community 210 - "plugin-job-scheduler.ts"
Cohesion: 0.08
Nodes (17): PluginRouteJobDeps, createPluginJobCoordinator(), PluginJobCoordinator, PluginJobCoordinatorOptions, PluginJobScheduler, PluginJobSchedulerOptions, SchedulerDiagnostics, TriggerJobResult (+9 more)

### Community 212 - "issue-document-restore-routes.test.ts"
Cohesion: 0.13
Nodes (12): createApp(), mockAccessService, mockAgentService, mockDocumentsService, mockHeartbeatService, mockInstanceSettingsService, mockIssueService, mockIssueThreadInteractionService (+4 more)

### Community 213 - "workspace-runtime-routes-authz.test.ts"
Cohesion: 0.13
Nodes (14): createExecutionWorkspaceApp(), createProjectApp(), mockAccessService, mockAssertCanManageExecutionWorkspaceRuntimeServices, mockAssertCanManageProjectWorkspaceRuntimeServices, mockEnvironmentService, mockExecutionWorkspaceService, mockGetTelemetryClient (+6 more)

### Community 214 - "pr-review-request-ageing.ts"
Cohesion: 0.09
Nodes (43): DigestProducer, DigestSection, AgedReviewRequest, AgedReviewRequestReport, AgeingPullRequest, AGENT_AUTHOR_LOGINS, AGENT_AUTHOR_SET, ALLY_REVIEW_IDENTITY_LOGINS (+35 more)

### Community 215 - "env"
Cohesion: 0.11
Nodes (20): bootstrapDevRunnerWorktreeEnv(), expandHomePrefix(), isLinkedGitWorktreeCheckout(), parseEnvFile(), repairStaleMigratedWorktreeEnvEntries(), resolveDefaultWorktreeHome(), resolveHomeAwarePath(), resolveWorktreeEnvFilePath() (+12 more)

### Community 216 - "dev-server-status.ts"
Cohesion: 0.24
Nodes (10): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+2 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.15
Nodes (19): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+11 more)

### Community 218 - "heartbeat-dependency-scheduling.test.ts"
Cohesion: 0.14
Nodes (10): counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), DEP_BLOCKED_MAX_RETRY_ATTEMPTS, DEP_BLOCKED_RETRY_REASON, UNCLAIMABLE_QUEUED_RUN_REAP_MIN_AGE_MS (+2 more)

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "pluginManagedRoutineService"
Cohesion: 0.22
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 221 - "dispatch-readiness.ts"
Cohesion: 0.08
Nodes (38): extractWakeCommentIds(), allowsIssueInteractionWake(), BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY, classifyQueuedRunForDependencyReap(), deriveCommentId(), isBranchClaimRetryDeferred(), isDispatchRankReady(), isEffectivelyDependencyReadyForDispatch() (+30 more)

### Community 222 - "scrape-metrics-routine-fire-gap-work.test.ts"
Cohesion: 0.22
Nodes (6): db, rows, settle(), tickAt(), TRIGGERS, unref()

### Community 223 - "visibleIssueCondition"
Cohesion: 0.12
Nodes (30): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+22 more)

### Community 224 - "isolation-workspace-reaper.test.ts"
Cohesion: 0.08
Nodes (34): createDbWorkspaceUsageLookup(), DEFAULT_ISOLATION_WORKSPACE_ROOT, DEFAULT_MAX_DELETES_PER_TICK, defaultScheduler, hasNestedCheckout(), IsolationWorkspaceReaperScheduler, IsolationWorkspaceReapOptions, IsolationWorkspaceReapResult (+26 more)

### Community 225 - "buildInviteOnboardingManifest"
Cohesion: 0.25
Nodes (9): buildInviteOnboardingManifest(), buildInviteOnboardingTextDocument(), buildOnboardingConnectionCandidates(), buildOnboardingDiscoveryDiagnostics(), extractInviteMessage(), isLoopbackHost(), normalizeHostname(), requestBaseUrl() (+1 more)

### Community 226 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.12
Nodes (19): PENDING_INTERACTION_MAX_AGE_MS, readStrandedAttendanceWindow(), createStrandedAttendancePrefetch(), windowFor(), windowIdsFor(), DEFAULT_STRANDED_ATTENDANCE_PREFETCH_TTL_MS, DEFAULT_STRANDED_ATTENDANCE_PREFETCH_WINDOW, IssueAttendanceEvidence (+11 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.13
Nodes (17): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken(), minDate() (+9 more)

### Community 228 - "pluginLifecycleManager"
Cohesion: 0.08
Nodes (16): isValidTransition(), LifecycleEventName, LifecycleEventPayload, PluginLifecycleEvents, pluginLifecycleManager, assertTransition(), deactivatePluginRuntime(), emitDomain() (+8 more)

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

### Community 238 - "cgroup-memory-metrics.test.ts"
Cohesion: 0.10
Nodes (29): CGROUP_ANON_COMPONENT, CGROUP_FILE_COMPONENT, CGROUP_KERNEL_COMPONENT, CGROUP_KERNEL_STACK_COMPONENT, CGROUP_PAGETABLES_COMPONENT, CGROUP_SHMEM_COMPONENT, CGROUP_SLAB_COMPONENT, CGROUP_SLAB_RECLAIMABLE_COMPONENT (+21 more)

### Community 239 - "routines-routes.test.ts"
Cohesion: 0.15
Nodes (11): createApp(), mockAccessService, mockAnnotationService, mockGetTelemetryClient, mockLogActivity, mockRoutineService, mockTrackRoutineCreated, pausedRoutine (+3 more)

### Community 240 - "approval-gate-reconciler.ts"
Cohesion: 0.11
Nodes (22): announcementBody(), announcementIdempotencyKey(), announcementMetadata(), ApprovalGateReconcileResult, ApprovalGateReconcilerOptions, ApprovalGateReconcilerScheduler, CandidateCursor, CandidateRow (+14 more)

### Community 241 - "stranded-blocked-issue-reconciler.ts"
Cohesion: 0.07
Nodes (38): hasReusableExecutionWorkspaceBinding(), awaitingUserInputReason(), createIssueDependencyReadiness(), externalWaitFromDescription(), findBlockedPromotionsAwaitingUserInput(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap() (+30 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "instanceSettingsService"
Cohesion: 0.05
Nodes (88): appendWithCap, redactCurrentUserValue(), maskWorkspaceRuntimeTextForRead(), withholdWorkspaceOperationCapturedOutput(), getAccessibleResource(), executionWorkspaceRoutes(), assertRuntimeManageAllowed(), handleExecutionWorkspaceRuntimeCommand() (+80 more)

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
Cohesion: 0.02
Nodes (84): BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), AGENT_START_LOCK_PHASE_SECONDS_METRIC, AGENT_START_LOCK_REAP_DISPOSITION_METRIC, COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC (+76 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "deriveSkillExportDirCandidates"
Cohesion: 0.33
Nodes (10): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+2 more)

### Community 250 - "recovery-expired-wake-horizon.test.ts"
Cohesion: 0.12
Nodes (8): ACTIVE_RECOVERY_ACTION_STATUSES, BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, RECOVERY_HORIZON_EXPIRED_METRIC, enqueueWakeup(), dbWithCommitThenThrowOnFirstRetire(), dbWithRetireHook(), dbWithWriteDuringRetire(), escalateAndReadNotice()

### Community 251 - "accepted-interaction-outcome-sweep.ts"
Cohesion: 0.11
Nodes (23): ACCEPTED_OUTCOME_SWEEP_KINDS, AcceptedInteractionOutcomeBucketReport, AcceptedInteractionOutcomeReport, AcceptedInteractionOutcomeSample, AcceptedInteractionOutcomeSource, bucketFor(), buildAcceptedInteractionOutcomeReport(), ClassifiedRow (+15 more)

### Community 252 - "workspace-operation-log-store.ts"
Cohesion: 0.12
Nodes (10): createLocalFileWorkspaceOperationLogStore(), ensureDir(), readFileRange(), resolveWithin(), WorkspaceOperationLogFinalizeSummary, WorkspaceOperationLogHandle, WorkspaceOperationLogReadOptions, WorkspaceOperationLogReadResult (+2 more)

### Community 253 - "agent-test-environment-routes.test.ts"
Cohesion: 0.15
Nodes (12): createApp(), externalAdapter, mockAccessService, mockAgentService, mockEnvironmentRuntime, mockEnvironmentService, mockInstanceSettingsService, mockReleaseRunLease (+4 more)

### Community 254 - "document-annotation-routes.test.ts"
Cohesion: 0.17
Nodes (10): annotationComment, annotationThread, createApp(), documentPayload, mockAnnotationService, mockDocumentService, mockHeartbeatService, mockIssueReferenceService (+2 more)

### Community 255 - "external-object-routes.test.ts"
Cohesion: 0.18
Nodes (7): createApp(), makeIssue(), mockAccessService, mockAgentService, mockExternalObjectsService, mockInstanceSettingsService, mockIssueService

### Community 256 - "github-fetch.ts"
Cohesion: 0.12
Nodes (21): abortFailure(), classifyGithubRefusal(), countGithubApiAttempt(), countGithubRefusal(), GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS, isGitHubDotCom(), refusalBody() (+13 more)

### Community 257 - "isPlainRecord"
Cohesion: 0.16
Nodes (32): asBoolean(), asString(), buildManifestFromPackageFiles(), buildPortableCatalogProvenance(), buildSkillSourceEntry(), buildYamlFile(), clonePortableRecord(), collectSelectedExportSlugs() (+24 more)

### Community 258 - "middleware/index.ts"
Cohesion: 0.03
Nodes (51): createApp(), mockBumpAgentImagesForCompany, createApp(), mockFolderService, mockLogActivity, createApp(), mockEnvironmentService, mockHeartbeatService (+43 more)

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
Nodes (21): buildEnvInputMap(), buildMarkdown(), buildOrgTreeFromManifest(), buildReferencedSkillMarkdown(), classifyPortableFileKind(), collectRedactedPaths(), exportBundle(), previewExport() (+13 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.09
Nodes (36): versionMaterialHasValueDigest(), collectEnvironmentSecretRefs(), persistConfigSecretRefs(), resolveConfigSecretRefsForProbe(), resolveConfigSecretRefsForRuntime(), collectSecretRefPaths(), walk(), isUuidSecretRef() (+28 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "project-checkout-origin-reconciler.ts"
Cohesion: 0.05
Nodes (46): body(), PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC, ProjectCheckoutOriginMismatchEntry, setProjectCheckoutOriginMismatchMetrics(), setProjectCheckoutOriginReconcileMetricsRefreshSuccess(), setWorkspaceReuseRefusalMetricsRefreshSuccess() (+38 more)

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

### Community 271 - "routes/companies.ts"
Cohesion: 0.13
Nodes (20): assertInstanceAdmin(), assertCloudTenantCaller(), cleanupTerminalImportJobs(), cloudTenantRequestKey(), CompanyImportResult, companyRoutes(), assertImportTargetAccess(), assertSameCompanyCeoAgentOrBoard() (+12 more)

### Community 272 - "issue-comment-effects.ts"
Cohesion: 0.09
Nodes (33): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+25 more)

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
Cohesion: 0.08
Nodes (34): prReviewAlreadyReviewedVetoCue(), toIssueActiveRunRow(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS, RECOVERY_MODEL_PROFILE_KEY (+26 more)

### Community 277 - "accessRoutes"
Cohesion: 0.08
Nodes (35): tooManyRequests(), accessRoutes(), assertInstanceAdmin(), getInviteCompanyBranding(), getInviteLogoAsset(), actorHasActiveUserMembership(), buildCliAuthApprovalPath(), claudeHomeDisplayLabel() (+27 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "terminal-gate-reconciler.ts"
Cohesion: 0.07
Nodes (39): PullRequestGateResult, armedMonitorNextCheckAt(), buildTerminalGateHumanOnlyComment(), buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler, gateSignalDigest(), gateSignalDigestSql (+31 more)

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

### Community 284 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 285 - "routes/decision-training.ts"
Cohesion: 0.15
Nodes (18): createSchema, decisionTrainingRoutes(), exampleIdSchema, parseExampleId(), previewSchema, requireExampleOwner(), requireHumanUser(), sourceKindSchema (+10 more)

### Community 286 - "issue-watchdogs-routes.test.ts"
Cohesion: 0.12
Nodes (6): Db, truncateCompanyScopedTestState(), TruncateCompanyScopedTestStateOptions, seedCloudTenantMember(), seedCompany(), uniqueIssuePrefix()

### Community 287 - "plugin-environment-driver.ts"
Cohesion: 0.23
Nodes (19): createPluginEnvironmentDriver(), resolvePluginDriver(), resolvePluginDriverForRelease(), pluginDriverProviderKey(), tryParseCurrentPluginConfig(), cancelPluginEnvironmentInteractiveSetup(), capturePluginEnvironmentTemplate(), deletePluginEnvironmentTemplate() (+11 more)

### Community 288 - "companyPortabilityService"
Cohesion: 0.10
Nodes (30): findServerAdapter(), assertKnownAdapterType(), applySelectedFilesToSource(), collectAgentSafeImportPolicyErrors(), companyPortabilityService(), applyImportedAgentPermissionGrants(), assertImportAdapterConfigConstraints(), assertKnownImportAdapterType() (+22 more)

### Community 289 - "pr-review-state-reconciler.ts"
Cohesion: 0.11
Nodes (29): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+21 more)

### Community 290 - "environmentRoutes"
Cohesion: 0.09
Nodes (26): assertBoardOrgAccess(), hasBoardOrgAccess(), activationEntityTypeBody(), cloudUpstreamRoutes(), assertEnabled(), optionalString(), stringBody(), stringQuery() (+18 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.11
Nodes (4): PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, mockAdapterExecute

### Community 292 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

### Community 293 - "agent-hires-instructions-materialize.test.ts"
Cohesion: 0.20
Nodes (8): createApp(), mockAccessService, mockApprovalService, mockCompanySkillService, mockIssueApprovalService, mockLogActivity, mockSecretService, mockSyncInstructionsBundleConfigFromFilePath

### Community 294 - "routes/tool-gateway.ts"
Cohesion: 0.19
Nodes (17): bearerToken(), callerHeaders(), decodeAuditCursor(), detailString(), encodeAuditCursor(), gatewayToken(), handleMcpGatewayProtocol(), mcpGatewayProtocolRoutes() (+9 more)

### Community 295 - "built-in-agent-routes.test.ts"
Cohesion: 0.18
Nodes (8): allowDecision(), builtInState(), createApp(), mockAccessService, mockBuiltInAgentService, mockInstanceSettingsService, mockLogActivity, stateWithMetadata()

### Community 296 - "codex-local-execute.test.ts"
Cohesion: 0.22
Nodes (4): CapturePayload, codexHomeOverrides, fakeCodexAuthJson, LogEntry

### Community 297 - "company-skills-catalog-service.test.ts"
Cohesion: 0.25
Nodes (7): contentHash(), createService(), mockCatalogService, sampleAssetBytes, sampleCatalogSkill, sampleFiles, sha256()

### Community 298 - "run-secret-redaction.ts"
Cohesion: 0.13
Nodes (22): isSyntheticNonProgressRunLogChunk(), compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH, buildRunSecretRedactionPlan() (+14 more)

### Community 299 - "agent-live-run-routes.test.ts"
Cohesion: 0.06
Nodes (20): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, createApp(), mockAccessDecide, mockAgentService (+12 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (20): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+12 more)

### Community 302 - "agent-redaction.ts"
Cohesion: 0.12
Nodes (20): asRecord(), containsRedactedAdapterValue(), isRedactedEnvBinding(), OMIT_REDACTED_ADAPTER_VALUE, REDACTED_ENV_SENTINEL, restoreRedactedAdapterValue(), restoreRedactedAdapterValueInner(), restoreRedactedAgentMetadata() (+12 more)

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 304 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 305 - "heartbeat-retry-scheduling.test.ts"
Cohesion: 0.04
Nodes (67): applyCcrotateCapacityDecision(), CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MAX_PARK_MS (+59 more)

### Community 306 - "zoned-cron.ts"
Cohesion: 0.11
Nodes (25): ParsedCron, assertTimeZone(), isSubHourlyCronExpression(), nextCronTickInTimeZone(), resetRoutineFireGapsMemoForTests(), buildCronMask(), CronMask, daysInMonth() (+17 more)

### Community 307 - "issue-subtree-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.11
Nodes (12): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, AgentRow, collectWriterFiles(), columnReasonLiteralsFromDirectInserts(), CompanyRow, createApp(), Db, isProductionSource() (+4 more)

### Community 309 - "builtInAgentService"
Cohesion: 0.12
Nodes (49): builtInAgentService(), autoProvisionBundledAgents(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), defaultProvisionInput(), ensure(), ensureAgentDefaultGrants() (+41 more)

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

### Community 314 - "routes/dashboard.ts"
Cohesion: 0.18
Nodes (12): dashboardRoutes(), parsePositiveNumber(), buildDismissedAtByKey(), sidebarBadgeRoutes(), dashboardService(), inboxDismissalService(), recoveryObservabilityService(), ACTIONABLE_APPROVAL_STATUSES (+4 more)

### Community 315 - "taskWatchdogService"
Cohesion: 0.20
Nodes (16): buildStoppedFingerprintComment(), isTerminalIssueStatus(), isWatchdogReviewDisposition(), stoppedFingerprintMetadata(), taskWatchdogService(), ensureReusableWatchdogIssue(), evaluateWatchdog(), findTaskWatchdogIssue() (+8 more)

### Community 316 - "config"
Cohesion: 0.24
Nodes (8): describeLiveSsh, readOptionalSecret(), resolveEnvLabStatePath(), resolveSshConfig(), startEnvLabForTest(), tryEnvLabFixture(), tryExplicitConfig(), config()

### Community 317 - "evidence-truth.ts"
Cohesion: 0.09
Nodes (22): extractAllyReviewedHeadSha(), buildGithubTruthProbe(), GithubTruthDeps, MAX_LINKED_PRS, MAX_SERIAL_CALLS, PER_CALL_TIMEOUT_MS, PerPr, PROBE_DEADLINE_MS (+14 more)

### Community 318 - "agent-model-registry-validation.test.ts"
Cohesion: 0.12
Nodes (14): createApp(), mockAccessService, mockAgentService, mockBuiltInAgentService, mockEnvironmentService, mockFindServerAdapter, mockFindUnregisteredAdapterModel, mockLogActivity (+6 more)

### Community 319 - "security-audit-overrides.test.ts"
Cohesion: 0.29
Nodes (6): copyLockfileFixture(), execFileAsync, repoRoot, repoRootPath, rootPackageJson, serverPackageJson

### Community 320 - "environment-capabilities-k8s.test.ts"
Cohesion: 0.11
Nodes (17): createApp(), currentActor, mockAccessService, mockAgentService, mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService (+9 more)

### Community 321 - "issue-approval-link-authorization.ts"
Cohesion: 0.18
Nodes (16): assertHireSourceIssueLinksAllowed(), assertIssueLinksAllowed(), AccessDecider, evaluateAgentIssueApprovalLinkAuthorization(), evaluateTaskWatchdogSubtreeScope(), isCreatorOrManagerChainDecision(), isCurrentIssueExecutionRun(), IssueApprovalLinkVerdict (+8 more)

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "StorageService"
Cohesion: 0.07
Nodes (22): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES, normalizeIssueAttachmentMaxBytes() (+14 more)

### Community 324 - "logger"
Cohesion: 0.03
Nodes (53): logger, computeETag(), MIME_TYPES, PluginUiStaticRouteOptions, pluginUiStaticRoutes(), resolvePluginUiDir(), ActivityFilters, ACTIVITY_ACTION_TO_PLUGIN_EVENT (+45 more)

### Community 325 - "zodToOpenApiSchema"
Cohesion: 0.52
Nodes (7): applyNumberChecks(), applyStringChecks(), isOptionalSchema(), parametersFromSchema(), unwrapSchema(), zodToOpenApiSchema(), zodTypeName()

### Community 326 - "openrouter/execute.ts"
Cohesion: 0.13
Nodes (17): AGENT_TOOLS, callOpenRouter(), ChatMessage, execAsync, execute(), executeToolCall(), walk(), sanitize() (+9 more)

### Community 327 - "company-export-readme.ts"
Cohesion: 0.43
Nodes (6): generateOrgChartMermaid(), generateReadme(), mermaidEscape(), mermaidId(), ROLE_LABELS, skillSourceLabel()

### Community 329 - "collectEvidence"
Cohesion: 0.11
Nodes (32): choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), deliberatePendingMonitor(), dominantErrorCode(), isDominantEpisodeShare(), isMonitorSuppressionActor(), isNeverExecutedRun() (+24 more)

### Community 330 - "lifecycle-hook-command-audit.ts"
Cohesion: 0.07
Nodes (40): assertEnvironmentSelectionForCompany(), assertCanManageInstanceSettings(), auditPatchedHookCommands(), instanceSettingsRoutes(), assertProjectEnvironmentSelection(), auditConfiguredHookCommandsOnBoot(), auditHookCommands(), basenameOf() (+32 more)

### Community 331 - "scrape-metrics-collector.ts"
Cohesion: 0.04
Nodes (56): BOARD_DECISION_STATUSES, refreshApprovalQueueMetrics(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, boundedDirLabel(), boundedSegment(), classifyFdTarget() (+48 more)

### Community 332 - "boardAuthService"
Cohesion: 0.11
Nodes (26): BOARD_API_KEY_TTL_MS, boardApiKeyExpiresAt(), boardAuthService(), approveCliAuthChallenge(), assertCurrentBoardKey(), cancelCliAuthChallenge(), createCliAuthChallenge(), createNamedBoardApiKey() (+18 more)

### Community 333 - "pluginCapabilityValidator"
Cohesion: 0.06
Nodes (19): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, CapabilityScopedInvoker, DEFAULT_GLOBALS (+11 more)

### Community 334 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 335 - "services/access.ts"
Cohesion: 0.15
Nodes (13): GrantInput, MemberArchiveInput, MembershipRow, AuthorizationActor, AuthorizationResource, buildFixture(), createAgent(), createCompany() (+5 more)

### Community 336 - "setupEnvironmentCustomImageTerminalWebSocketServer"
Cohesion: 0.10
Nodes (13): clientSafeErrorMessage(), closeClient(), errorStatus(), handleClientFrame(), parseTerminalDimension(), parseTerminalPath(), safeErrorName(), safeUpgradePath() (+5 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.29
Nodes (5): require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance

### Community 338 - "teams-catalog-routes.test.ts"
Cohesion: 0.25
Nodes (5): createApp(), mockAccessService, mockAgentService, mockCatalogModule, mockTeamsCatalogService

### Community 339 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (19): PROVIDER_CAPACITY_MAX_HORIZON_MS, createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile() (+11 more)

### Community 340 - "queued-run-age-metrics.ts"
Cohesion: 0.05
Nodes (41): DEP_BLOCKED_MAX_DELAY_MS, MAX_TURN_CONTINUATION_MAX_DELAY_MS, coerceRetryScheduleReason(), DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC, DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC, normalizeAgentId(), QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC, QUEUED_RUN_OLDEST_AGE_METRIC (+33 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.50
Nodes (7): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings(), syncAgentSecretBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.60
Nodes (5): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance()

### Community 343 - "gbrain-client-factory.test.ts"
Cohesion: 0.19
Nodes (6): BearerSource, NullBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 344 - "zoned-cron-equivalence.test.ts"
Cohesion: 0.12
Nodes (21): ZONED_CRON_SEARCH_MIN_AFTER_MS, assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute(), nextCronTickInTimeZone(), WEEKDAY_INDEX (+13 more)

### Community 345 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 346 - "issue-park-expiry-sweep.test.ts"
Cohesion: 0.16
Nodes (11): tickExpiredIssueParks(), buildIssueParkExpiredWakeIdempotencyKey(), isIssueParkExpiryWakeStatus(), ISSUE_PARK_EXPIRED_WAKE_REASON, ISSUE_PARK_EXPIRY_WAKE_STATUSES, IssueParkExpiryWakeStatus, issueParkOwesReleaseWake(), IssueParkReleaseInput (+3 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.20
Nodes (12): listSuccessfulRunHandoffStates(), listSuccessfulRunHandoffMapForIssues(), hydrateSuccessfulRunHandoffLiveness(), resolveSuccessfulRunHandoffForLaterContinuation(), resolveSuccessfulRunHandoffForTerminalIssues(), SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES, SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES, SUCCESSFUL_RUN_HANDOFF_TERMINAL_ISSUE_STATUSES (+4 more)

### Community 348 - "routes/routines.ts"
Cohesion: 0.12
Nodes (25): ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), PROJECT_ENV_VALUE_MASK, maskRoutineEnv(), maskRoutineEnvelopeEnv() (+17 more)

### Community 349 - "REDACTED_EVENT_VALUE"
Cohesion: 0.13
Nodes (14): REDACTED_EVENT_VALUE, withPublicIssueWorkspaceSettings(), publicIssueExecutionWorkspaceSettings(), WITHHELD_WORKSPACE_RUNTIME_VIEWER, hireMetadataFixture(), hireRuntimeConfigFixture(), issuePrefix(), seedCompany() (+6 more)

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

### Community 356 - "live-events.ts"
Cohesion: 0.14
Nodes (12): emitter, LiveEventListener, LiveEventPayload, publishGlobalLiveEvent(), subscribeCompanyLiveEvents(), toLiveEvent(), captureActivityEvents(), captureActivityEvents() (+4 more)

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

### Community 362 - "scheduler-lease.ts"
Cohesion: 0.16
Nodes (22): registerPluginHolderForwardRoutes(), recordSchedulerLeaseState(), acquireSchedulerLease(), firstRow(), HEARTBEAT_TIMER_LEASE, LeaseDb, leaseHolderUrlResolver(), readSchedulerLeaseHolderId() (+14 more)

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
Nodes (15): readExternalLifecycleProviderCapacityRefusal(), parseProviderCapacityResetHorizon(), resolveProviderCapacityHorizon(), findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), readRunLogTerminalTail(), RUN_LOG_TERMINAL_MAX_SCAN_BYTES (+7 more)

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

### Community 373 - "chain-pass-timing.ts"
Cohesion: 0.17
Nodes (9): createRecoveryChainTimer(), RECOVERY_CHAIN_PASS_TIMING_MESSAGE, RECOVERY_CHAIN_TIMING_MESSAGE, RecoveryChainPassOutcome, RecoveryChainPassRecord, RecoveryChainTimer, RecoveryChainTimerOptions, harness() (+1 more)

### Community 374 - "routine-fire-gap-metrics.test.ts"
Cohesion: 0.09
Nodes (22): PROCESS_MAPPING_COUNT_METRIC, ROUTINE_DISPATCH_METRIC, ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC, ROUTINE_FIRE_INTERVAL_METRIC, ROUTINE_LAST_DONE_FIRE_AGE_METRIC, ROUTINE_LAST_FIRE_START_AGE_METRIC, setRoutineFireGapMetrics(), setRoutineFireGapMetricsRefreshSuccess() (+14 more)

### Community 375 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.19
Nodes (15): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineDispatchFailureHeartbeat() (+7 more)

### Community 376 - "issue-checkout-status.ts"
Cohesion: 0.12
Nodes (16): WakeupOptions, checkoutRestoreStatusExpression, checkoutRestoreTargetStatus, DbOrTransaction, hasCancelledBlocker, hasPendingBlocker, holdsDispatchableMonitor, IssueLockOwnerState (+8 more)

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

### Community 381 - "storage/service.ts"
Cohesion: 0.21
Nodes (11): createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), assertPutFileInput(), buildObjectKey(), createStorageService(), ensureCompanyPrefix(), normalizeNamespace() (+3 more)

### Community 382 - "mcp-seed-scrub-coverage.test.ts"
Cohesion: 0.14
Nodes (10): Coverage, EntryShape, jobManifestPath, repoRoot, resolveEntryShapes(), SCRUBBING_GATEWAY_HOSTS, SEED_COVERAGE, SeedEntry (+2 more)

### Community 383 - "stacked-pr-auto-retarget.test.ts"
Cohesion: 0.17
Nodes (10): buildApp(), linkPullRequest(), mockListOpenPrsByBase, mockResolveBranchState, mockResolveMergedBase, mockResolveMergeShape, post(), seedCompany() (+2 more)

### Community 384 - "plugin-state-store.ts"
Cohesion: 0.14
Nodes (17): normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier(), ResolvedPluginFencingPrecondition (+9 more)

### Community 385 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 386 - "approval-revision-exit.test.ts"
Cohesion: 0.15
Nodes (10): BOARD_NOTE, get(), mockAgentService, mockApprovalService, mockListIssuesForApproval, mockLogActivity, mockWakeup, racingUpdates() (+2 more)

### Community 387 - "heartbeat-workspace-finalize-branch.test.ts"
Cohesion: 0.14
Nodes (8): adapterExecute, createGitRepo(), Db, drainInFlightExecutions(), execFileAsync, Heartbeat, runGit(), seedRunTarget()

### Community 388 - "company-search-rate-limit.ts"
Cohesion: 0.19
Nodes (9): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), createApp(), unusedSearch() (+1 more)

### Community 389 - "PluginWorkerHandle"
Cohesion: 0.15
Nodes (4): PluginWorkerHandle, ApiTierPluginWorkerError, createApiTierPluginWorkerManagerStub(), WorkerDiagnostics

### Community 390 - "readPenstockCapacity"
Cohesion: 0.26
Nodes (11): capacityEndpointUnavailable(), defaultCapacityRetry(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger (+3 more)

### Community 391 - "issue-create-deduplication-routes.test.ts"
Cohesion: 0.15
Nodes (10): findCreateIssueDuplicateCandidates(), ISSUE_CREATE_DUPLICATE_CANDIDATE_LATENCY_BUDGET_MS, ISSUE_CREATE_DUPLICATE_CANDIDATE_ROW_CAP, ISSUE_CREATE_DUPLICATE_CANDIDATE_SCAN_CAP, ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS, createApp(), FilingFixture, monitorFilings (+2 more)

### Community 392 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 393 - "task-watchdog-scope.ts"
Cohesion: 0.19
Nodes (13): assertFreshTaskWatchdogSourceMutation(), assertTaskWatchdogCreateIssueAllowed(), rejectTaskWatchdogConfigMutation(), resolveTaskWatchdogProductBugFollowUp(), resolveWatchdogFollowUpSerializationContext(), AgentRunActor, isPlainRecord(), IssueScopeTarget (+5 more)

### Community 394 - "sweep-wake-preflight.test.ts"
Cohesion: 0.15
Nodes (13): compareSweepWakeFrame(), equalStringArrays(), isValidIsoDate(), isValidSweepWakeFrame(), parseScalar(), parseSweepWakeFramePage(), sortLex(), SweepWakeFrame (+5 more)

### Community 395 - "createToolGatewayService"
Cohesion: 0.05
Nodes (107): asRecord(), auditSafeEndpoint(), backfillPendingActionRequestSignature(), createToolGatewayService(), allTools(), approvalRequiredInstructions(), assertAgentInCompany(), assertGatewayContext() (+99 more)

### Community 396 - "plugin-status-metrics.ts"
Cohesion: 0.27
Nodes (10): PLUGIN_ERROR_METRIC, PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC, PluginErrorStatusEntry, setPluginErrorStatus(), setPluginStatusCollectorLastSuccessSeconds(), pluginErrorEntriesFromRows(), PluginStatusCollectorOptions, PluginStatusRow (+2 more)

### Community 399 - "docker-onboard-smoke-contract.test.ts"
Cohesion: 0.50
Nodes (3): repoRoot, smokeScript, smokeWorkflow

### Community 401 - "approval-payload-title-guard.test.ts"
Cohesion: 0.29
Nodes (10): findPayloadProperty(), isApprovalsInsertValuesCall(), listSourceFiles(), objectHasTitleKey(), payloadObjectLiteralsOf(), propertyNameIs(), scanFile(), visit() (+2 more)

### Community 402 - "openclaw-invite-prompt-route.test.ts"
Cohesion: 0.25
Nodes (8): createApp(), createDbStub(), createSelectChain(), mockAccessService, mockAgentService, mockBoardAuthService, mockLogActivity, mockStorage

### Community 403 - "PluginWorkerManager"
Cohesion: 0.18
Nodes (5): PluginRouteWebhookDeps, PluginWorkerManager, runContract(), RuntimeContractCase, seedEnvironment()

### Community 404 - "documents.ts"
Cohesion: 0.31
Nodes (7): documentService(), extractLegacyPlanBody(), issueDocumentSelect, isUniqueViolation(), mapIssueDocumentRow(), nextAvailableDocumentKey(), normalizeDocumentKey()

### Community 405 - "ac-policy-sweep.ts"
Cohesion: 0.24
Nodes (11): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+3 more)

### Community 406 - "Ally — Consolidated PR Review"
Cohesion: 0.18
Nodes (10): Ally — Consolidated PR Review, Critical Issues (0), Important Issues (0), On the one open gate, Prior Findings Dispositioned (2), Re-verified at this head (fresh, not carried forward), Recommended Action, Strengths (+2 more)

### Community 408 - "auth-session-route.test.ts"
Cohesion: 0.20
Nodes (5): createDb(), createSelectChain(), then(), values(), chartDir

### Community 409 - "issue-runtime-service-command-masking.test.ts"
Cohesion: 0.22
Nodes (8): createApp(), makeQueryChain(), makeRuntimeService(), makeWorkspace(), mockAccessService, mockAgentService, mockExecutionWorkspaceService, mockIssueService

### Community 410 - "ensureHumanRoleDefaultGrants"
Cohesion: 0.10
Nodes (17): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, ensureRoleDefaultGrants(), ensureHumanRoleDefaultGrants(), GrantInput, insertMissingPrincipalGrants(), PrincipalAccessCompatibilityBackfillStats (+9 more)

### Community 411 - "codex-models.ts"
Cohesion: 0.15
Nodes (23): dedupeModels(), fetchOpenAiModels(), fingerprint(), listCodexModels(), loadCodexModels(), mergedWithFallback(), refreshCodexModels(), resolveOpenAiApiKey() (+15 more)

### Community 412 - "pause-hold-guard.ts"
Cohesion: 0.19
Nodes (11): ActivePauseHoldRow, ActivePauseHoldPrefilter, ActivePauseHoldPrefilterStats, createActivePauseHoldPrefilter(), DEFAULT_ACTIVE_PAUSE_HOLD_PREFILTER_TTL_MS, IssueTreeControlService, db, FakeHold (+3 more)

### Community 413 - "heartbeat-worker-crash-marking.test.ts"
Cohesion: 0.14
Nodes (7): HeartbeatEnvironmentRuntime, ActivityService, IssueRun, insertRun(), seedCrashMarkedRun(), service(), published()

### Community 421 - "human-gated-gate-revalidation-wiring.test.ts"
Cohesion: 0.11
Nodes (8): humanGatedAgeingProducer, loadGateEvidence(), collect(), NOW, CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

### Community 425 - "agent-budgets-route-config-revision.test.ts"
Cohesion: 0.24
Nodes (6): CompanyRow, createApp(), Db, issuePrefix(), seed(), seedWithSecrets()

### Community 426 - "blocked-inbox-count-list-parity.test.ts"
Cohesion: 0.31
Nodes (6): createCompany(), EXTERNAL_WAIT_DECLARATION, insertIssue(), parkDeclaredEarly(), seedExternallyParkedRowWithCoveredBlocker(), seedParkedRows()

### Community 427 - "cases-routes.test.ts"
Cohesion: 0.20
Nodes (3): app(), authenticatedApp(), enableCases()

### Community 428 - "board-chat.ts"
Cohesion: 0.26
Nodes (8): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), createApp(), mockGetExperimental, mockIssueService, mockSpawn

### Community 430 - "plugin-metric-exposition.test.ts"
Cohesion: 0.12
Nodes (18): PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME, PLUGIN_METRIC_PROMOTABLE_TAG_KEYS, PLUGIN_METRIC_TAG_LABEL_PREFIX (+10 more)

### Community 433 - "executeProcess"
Cohesion: 0.20
Nodes (11): createProcessOutputCapture(), executeProcess(), getGitWorktreeBranchAncestryVerdict(), isProcessGroupAlive(), recordWorkspaceCommandOperation(), resolveServerGitInvocation(), resolveShell(), runWorkspaceCommand() (+3 more)

### Community 437 - "createApp"
Cohesion: 0.04
Nodes (47): acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), pluginStateFingerprint(), pluginStateSnapshot(), resolveViteHmrHost(), resolveViteHmrPort() (+39 more)

### Community 438 - "issue-telemetry-routes.test.ts"
Cohesion: 0.17
Nodes (9): createApp(), mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectWhere, mockGetTelemetryClient, mockIssueService (+1 more)

### Community 446 - "assertAssignableAgent"
Cohesion: 0.27
Nodes (10): AgentAssignmentConflictReason, AgentAssignmentKind, assertAssignableAgent(), AssignabilityAgent, assignmentMessage(), assignmentReasonFromHealth(), conflictDetails(), getAgent() (+2 more)

### Community 447 - "billing-classification.ts"
Cohesion: 0.35
Nodes (9): CASH_ZEROING_BILLING_TYPE, DIRECT_METERED_BILLING_TYPES, isBrokeredLane(), isPenstockBaseUrl(), LaneBillingInput, normalizeLedgerBillingType(), PROVIDER_BASE_URL_ENV, readEnvString() (+1 more)

### Community 460 - "unprocessable"
Cohesion: 0.04
Nodes (104): notFound(), unprocessable(), assertAgentDefaultEnvironmentSelection(), normalizeAgentReference(), assertBuiltInAgentsEnabled(), validatePolicyBody(), assertActiveUserMembership(), normalizeIssueAssigneeAgentReference() (+96 more)

### Community 461 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.07
Nodes (14): PluginRuntimeServices, WorkerToHostHandlers, FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR, SDK_INSTALL_RACE_ERROR, npmMock, tornSharedStore() (+6 more)

### Community 462 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.25
Nodes (3): createApp(), seedCompanyAgentAndRuns(), seedPendingReviewStageIssue()

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "syncPipelineStageAutomation"
Cohesion: 0.22
Nodes (11): assertActorProvenance(), eventActorPatch(), legacyPipelineAutomationTitle(), appendPipelineAutomationRoutineRevision(), syncPipelineStageAutomation(), reconcilePipelineStageConfigVariables(), resolvePipelineAutomationTitleTemplate(), routineActorPatch() (+3 more)

### Community 465 - "environment-instance-routes.test.ts"
Cohesion: 0.18
Nodes (9): createApp(), mockEnvironmentCustomImageService, mockEnvironmentService, mockExecutionWorkspaceService, mockInstanceSettingsService, mockIssueService, mockLogActivity, mockProjectService (+1 more)

### Community 466 - "agents-service-secret-bindings.test.ts"
Cohesion: 0.25
Nodes (3): mockEnsureBuiltInAgent, mockNotifyHireApproved, pendingApproval()

### Community 467 - "pr-issue-backlink-lock.test.ts"
Cohesion: 0.29
Nodes (7): __test_buildIssueBackLinkBody, __test_commentsContainBackLinkMarker, PrIssueBackLinkLockTimeouts, __test_prIssueBackLinkLockKey(), withPrIssueBackLinkLock(), fakePrCommentSurface(), Settings

### Community 468 - "classifyTaskWatchdogSubtree"
Cohesion: 0.24
Nodes (9): classifyTaskWatchdogSubtree(), issueUpdatedAtIso(), optionalIso(), pathIssueIds(), stableStopFingerprint(), TaskWatchdogClassifierIssue, waitingPathIds(), classify() (+1 more)

### Community 469 - "heartbeat-accepted-plan-workspace-refresh.test.ts"
Cohesion: 0.29
Nodes (7): adapterExecute, allowPenstockGate, createGitRepo(), createGitRepoWithOrigin(), drainInFlightExecutions(), execFileAsync, runGit()

### Community 470 - "issue-monitor-queue-lock.ts"
Cohesion: 0.67
Nodes (3): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock()

### Community 471 - "applyResponsibleUserIntersection"
Cohesion: 0.25
Nodes (9): activeActorMembership(), activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), applyResponsibleUserIntersection(), decide(), getResponsibleUserSnapshot(), companyIdForResource(), membershipRoleIsNonViewer() (+1 more)

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
Nodes (96): buildHarnessIssueDescription(), buildSkillRuntimeName(), builtInSkillTestRunTemplate(), companySkillService(), actorStarClause(), assertCanMutateComment(), assertLocalImportSourceAllowed(), auditSkill() (+88 more)

### Community 481 - "github-api-refusal-metric.test.ts"
Cohesion: 0.22
Nodes (6): GITHUB_API_REFUSALS_METRIC, GITHUB_API_REQUESTS_METRIC, KNOWN_GITHUB_API_REFUSAL_REASONS, PERMISSION_BODY, RATE_LIMIT_BODY, SECONDARY_BODY

### Community 482 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

### Community 483 - "db-inherited-timeout-metric.test.ts"
Cohesion: 0.36
Nodes (6): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, POOL_IDLE_IN_TRANSACTION_SERIES, readings(), seriesFor()

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

### Community 489 - "invite-defaults-response-boundary.test.ts"
Cohesion: 0.32
Nodes (3): containDefaultsPayload(), redactJoinRequestRecord(), createApp()

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

### Community 499 - "activityService"
Cohesion: 0.46
Nodes (8): activityService(), asRecord(), backfillMissingRunLivenessForIssue(), countValue(), dateValue(), latestDate(), readNumber(), scheduleRunLivenessBackfill()

### Community 503 - "inspectExecutionWorkspaceBranchForReconcile"
Cohesion: 0.32
Nodes (8): execFileAsync, explainGitWorktreeBranchReconcileInspection(), fingerprintWorkspaceBranchIncoherence(), getGitWorktreeBranchAncestryVerdict(), inspectExecutionWorkspaceBranchForReconcile(), readGitStdout(), runGit(), stableStringify()

### Community 511 - "workspace-runtime-read-model.ts"
Cohesion: 0.39
Nodes (7): loadEffectiveRuntimeServicesByExecutionWorkspace(), listCurrentRuntimeServicesForExecutionWorkspaces(), listCurrentRuntimeServicesForProjectWorkspaces(), runtimeServiceIdentityKey(), RuntimeServiceReadDb, selectCurrentRuntimeServiceRows(), WorkspaceRuntimeServiceRow

### Community 515 - "performIssueMonitorRecovery"
Cohesion: 0.36
Nodes (8): clearIssueMonitorAndRecover(), findOpenIssueMonitorRecoveryIssue(), formatIssueIdentifierLink(), monitorRecoveryComment(), monitorRecoveryDetails(), performIssueMonitorRecovery(), enqueueRecoveryWakeOrComment(), recordRecoveryWakeSuppression()

### Community 516 - "collectClassifierInput"
Cohesion: 0.32
Nodes (8): issueIdFromRunContext(), issueIdFromWakePayload(), readNonEmptyString(), collectClassifierInput(), collectCompletedRunIssueIds(), loadWatchdogSubtreeIssues(), revalidateMutationScope(), toEpochMs()

### Community 517 - "execution-workspaces-service.test.ts"
Cohesion: 0.46
Nodes (6): createTempRepo(), execFileAsync, fingerprintWorkspaceBranchIncoherenceForTest(), readGit(), runGit(), stableStringifyForTest()

### Community 519 - "readProjectWorkspaceRuntimeConfig"
Cohesion: 0.81
Nodes (6): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates()

### Community 521 - "upsertIssueWatchdogForIssue"
Cohesion: 0.33
Nodes (7): assertWatchdogAgentInvokable(), assertWatchedIssue(), normalizeInstructions(), summarizeIssueWatchdog(), toIssueWatchdog(), updateIssueWatchdogRow(), upsertIssueWatchdogForIssue()

### Community 522 - "ensureServerWorkspaceLinksCurrent"
Cohesion: 0.33
Nodes (7): discoverWorkspacePackagePaths(), visit(), ensureServerWorkspaceLinksCurrent(), findServerWorkspaceLinkMismatches(), findWorkspaceRoot(), isLinkedGitWorktreeCheckout(), readJsonFile()

### Community 523 - "heartbeat-worktree-suppression.test.ts"
Cohesion: 0.33
Nodes (4): armWorktreeRunExecution(), deleteHeartbeatRunsWithDependents(), drainInFlightExecutions(), isHeartbeatRunDependentFkError()

### Community 524 - "recovery-chain-pass-timing-wiring.test.ts"
Cohesion: 0.29
Nodes (4): heartbeatSrc, here, indexSrc, recoverySrc

### Community 525 - "materializeImportEnvInputValues"
Cohesion: 0.40
Nodes (6): materializeImportEnvInputValues(), envInputScopedKey(), envInputValue(), importSecretKey(), importSecretLabel(), writeManifestEnvBinding()

### Community 527 - "issue-assignment-wakeup.ts"
Cohesion: 0.40
Nodes (5): IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail

### Community 528 - "agent-auth-middleware.test.ts"
Cohesion: 0.40
Nodes (3): createApp(), createDbState(), createSelectChain()

### Community 530 - "health.test.ts"
Cohesion: 0.33
Nodes (4): createApp(), mockReadPersistedDevServerStatus, testServerInfo, serverVersion

### Community 531 - "heartbeat-finalize-cancelled-skip-dispatch.test.ts"
Cohesion: 0.40
Nodes (3): getRunStatus(), mockAdapterExecute, waitForStatus()

### Community 532 - "workspace-operation-secret-scrub.test.ts"
Cohesion: 0.40
Nodes (5): capturedAppends, capturedInserts, capturedUpdates, makeFakeDb(), runOperation()

### Community 533 - "healthz-probe-route.test.ts"
Cohesion: 0.40
Nodes (3): HEALTH_PROBE_DEADLINE_MS, appSource, repoRoot

### Community 534 - "parseYamlBlock"
Cohesion: 0.40
Nodes (5): parseYamlBlock(), parseYamlFile(), parseYamlFrontmatter(), parseYamlScalar(), prepareYamlLines()

### Community 535 - "readAutomationExecutionContext"
Cohesion: 0.60
Nodes (5): readAutomationExecutionContext(), readExecutionWorkspacePreference(), readExecutionWorkspaceSettings(), readOptionalTrimmedString(), readStageAutomationRequest()

### Community 536 - "error-handler.test.ts"
Cohesion: 0.60
Nodes (4): makeReq(), makeRes(), recordResponsibleUserDenialOnActiveRunMock, refuse()

### Community 537 - "plugin-agent-invoke-wake-fanout.test.ts"
Cohesion: 0.60
Nodes (4): createEventBusStub(), hostServices(), issuePrefix(), seedBusyAgent()

## Knowledge Gaps
- **3876 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Db`, `LogEntry` (+3871 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 5822 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **75 communities omitted from the detail section** — 1–15 nodes each in graph.json, 42 of them ≥3; graphify omits a community with <3 nodes once file-hub and AST-stub nodes are discounted — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `issueRoutes()` connect `issueRoutes` to `source-trust.ts`, `services/issues.ts`, `services/index.ts`, `enqueueWakeup`, `task-watchdog-scope.ts`, `routes/issues.ts`, `environmentService`, `issue-dependency-wakeups-routes.test.ts`, `issues-service.test.ts`, `trust-preset-resolver.ts`, `issue-assignment-wakeup.ts`, `accessService`, `issue-comment-effects.ts`, `documents.ts`, `model-profile-hint.ts`, `issue-efficiency.ts`, `issueService`, `heartbeatService`, `routes/decision-training.ts`, `toolAccessService`, `cases.ts`, `recoveryService`, `feedback.ts`, `http-log-policy.ts`, `routes/approvals.ts`, `redaction.ts`, `conflict`, `services/execution-workspaces.ts`, `issue-recovery-actions.ts`, `issue-approval-link-authorization.ts`, `StorageService`, `services/projects.ts`, `lifecycle-hook-command-audit.ts`, `plugin-host-services.ts`, `unprocessable`, `issue-thread-interactions.ts`, `agentService`, `company-search.ts`, `agent-inbox-lite.ts`, `issueReferenceService`, `documentAnnotationService`, `successful-run-handoff-state.ts`, `wake-idempotency.test.ts`, `REDACTED_EVENT_VALUE`, `dispatch-readiness.ts`, `companySkillService`, `pull-request-work-products.ts`, `budgetService`, `external-objects.ts`, `stranded-blocked-issue-reconciler.ts`, `issue-execution-policy.ts`, `instanceSettingsService`, `routineService`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `heartbeatService()` connect `heartbeatService` to `heartbeat.ts`, `source-trust.ts`, `issue-continuation-summary.ts`, `performIssueMonitorRecovery`, `github-status-delivery-outbox.ts`, `services/index.ts`, `enqueueWakeup`, `environmentService`, `branch-run-claims.ts`, `trust-preset-resolver.ts`, `github-webhook.ts`, `k8s-job-liveness.ts`, `heartbeat-run-runtime-status.ts`, `readNonEmptyString`, `issue-rewake-throttle.ts`, `model-profile-hint.ts`, `executeRun`, `agent-auth-jwt.ts`, `issueService`, `successful-run-handoff.ts`, `agent-start-lock.ts`, `agentRoutes`, `services/instance-settings.ts`, `db-retry.ts`, `recoveryService`, `run-secret-redaction.ts`, `log-redaction.ts`, `github-app-auth.ts`, `managed-checkout-partial-clone.ts`, `heartbeat-retry-scheduling.test.ts`, `penstock-availability-gate.ts`, `execution-workspace-cleanup.ts`, `external-runtime-reservations.ts`, `process-loss-classification.ts`, `agent-invokability.ts`, `redaction.ts`, `conflict`, `services/execution-workspaces.ts`, `billing-classification.ts`, `services/issue-tree-control.ts`, `taskWatchdogService`, `heartbeat-stop-metadata.ts`, `run-scratch.ts`, `local-service-supervisor.ts`, `environment-run-orchestrator.ts`, `unprocessable`, `execution-policy-bootstrap.ts`, `run-liveness.ts`, `responsible-user-denial-run-outcomes.ts`, `issue-park-expiry-sweep.test.ts`, `execution-allowlist.ts`, `dispatch-readiness.ts`, `penstock-availability-gate.test.ts`, `visibleIssueCondition`, `companySkillService`, `hot-restart.ts`, `recovery/service.ts`, `ensurePersistedExecutionWorkspaceAvailable`, `pull-request-work-products.ts`, `sweep-wake-preflight.ts`, `budgetService`, `run-log-terminal-result.ts`, `services/dashboard.ts`, `issue-execution-policy.ts`, `instanceSettingsService`, `issue-checkout-status.ts`, `productivityReviewService`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `executionWorkspaceService()` connect `services/execution-workspaces.ts` to `services/issues.ts`, `visibleIssueCondition`, `enqueueWakeup`, `readProjectWorkspaceRuntimeConfig`, `unprocessable`, `issue-execution-policy.ts`, `inspectExecutionWorkspaceBranchForReconcile`, `issue-recovery-actions.ts`, `workspace-runtime-read-model.ts`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Are the 42 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 42 INFERRED edges - model-reasoned connections that need verification._
- **Are the 7 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `captureUnrecognizedInteractionPayloadKeys()`) actually correct?**
  _`issueRoutes()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _3876 weakly-connected nodes found - possible documentation gaps or missing edges._
# Graph Report - src  (2026-10-18)

## Corpus Check
- 1288 files · ~3,419,789 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 16318 nodes · 40941 edges · 515 communities (449 shown, 66 omitted from the detail section)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 998 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7bd3bd81`
- Generator: graphify 0.9.62 via graphify-reindex.sh (AST-only `--force` rebuild, no LLM)
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- heartbeat.ts
- services/issues.ts
- company-portability.ts
- errorHandler
- costs-service.test.ts
- app.ts
- issueRoutes
- workspace-runtime-service-authz.ts
- services/company-skills.ts
- services/pipelines.ts
- routes/issues.ts
- services/built-in-agents.ts
- reconcileStrandedRecoveryWakeBackstopImpl
- workspace-runtime.ts
- services/plugin-loader.ts
- github-webhook.ts
- routes/pipelines.ts
- heartbeat-retry-scheduling.test.ts
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
- logger.ts
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
- EnvironmentRuntimeDriver
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
- cloudUpstreamService
- agentService
- company-search.ts
- task-watchdogs.ts
- git-worktree-ownership.ts
- services/smoke-lab.ts
- workspace-runtime.test.ts
- heartbeat-process-recovery.test.ts
- worktree-config.ts
- index.ts
- unprocessable
- environment-custom-image-terminal-ws.ts
- plugin-routes-authz.test.ts
- board-claim.ts
- config.ts
- run-liveness-continuations.ts
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
- runStrandedAssignedIssueSweep
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
- listBlockedInboxIssues
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
- instanceSettingsService
- recovery-observability.ts
- agent-secret-redaction.test.ts
- db-retry.ts
- authorizationService
- human-gated-ageing-digest.ts
- normalizeHumanRole
- adapters/index.ts
- ac-policy-assignee-routing.ts
- company-portability-routes.test.ts
- linear-auth.ts
- environment-custom-image-routes.test.ts
- log-redaction.ts
- built-in-agents.test.ts
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
- visibleIssueCondition
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
- metrics-ingest.ts
- execution-policy-bootstrap.ts
- body
- gbrain-client-factory.ts
- issueReferenceService
- agent-inbox-lite.ts
- responsible-user-denial-run-outcomes.ts
- pluginLoader
- claude-local-execute.test.ts
- issue-document-restore-routes.test.ts
- workspace-runtime-routes-authz.test.ts
- pr-review-request-ageing.ts
- dev-runner-worktree.ts
- dev-server-status.ts
- openapi-routes.test.ts
- heartbeat-dependency-scheduling.test.ts
- execution-allowlist.ts
- pluginManagedRoutineService
- plan-review-context.ts
- project-checkout-origin-reconciler.ts
- oidc-rbac.ts
- isolation-workspace-reaper.test.ts
- invite-defaults-response-boundary.test.ts
- recovery-stranded-attendance-batch.test.ts
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
- routes/projects.ts
- runtime-api.ts
- linear-webhook-fixtures.ts
- routineService
- renderMetrics
- codex-auth-reconciliation.ts
- deriveSkillExportDirCandidates
- recovery-expired-wake-horizon.test.ts
- pr-reconciler-sweep.ts
- workspace-operations.ts
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
- execution-policy-bootstrap.test.ts
- transitionCaseInTransaction
- createPluginWorkerHandle
- companyPortabilityService
- pr-review-state-reconciler.ts
- environmentRoutes
- heartbeat-timer-suppression-park-bypass.test.ts
- summarySlotService
- agent-hires-instructions-materialize.test.ts
- agent-live-run-routes.test.ts
- built-in-agent-routes.test.ts
- codex-local-execute.test.ts
- company-skills-catalog-service.test.ts
- redactSensitiveText
- node:http
- instrumentation.ts
- http-log-policy.ts
- agent-redaction.ts
- issue-blocker-diagnostics-routes.test.ts
- managed-checkout-partial-clone.ts
- ccrotate-capacity-retry.ts
- zoned-cron.ts
- issue-subtree-diagnostics-routes.test.ts
- issue-wake-diagnostics-routes.test.ts
- builtInAgentService
- invite-rate-limit.ts
- issue-denied-write-recovery-persistence.test.ts
- plugin-orchestration-apis.test.ts
- process-loss-classification.ts
- plugin-store-consistency.test.ts
- ensure
- config
- evidence-truth.ts
- process-crash-guard-exit.test.ts
- security-audit-overrides.test.ts
- asNumber
- adapters/types.ts
- agent-shell-guard.ts
- attachment-types.ts
- services/index.ts
- zodToOpenApiSchema
- openrouter/execute.ts
- company-export-readme.ts
- company-search-service.test.ts
- collectEvidence
- lifecycle-hook-command-audit.ts
- fd-class-metrics.ts
- boardAuthService
- pluginCapabilityValidator
- pen3142-live-event-transcript-scope.test.ts
- input
- setupEnvironmentCustomImageTerminalWebSocketServer
- setup-supertest.ts
- teams-catalog-routes.test.ts
- strand-comment-provider-capacity.test.ts
- scrape-metrics-collector.ts
- agent-secret-bindings.ts
- readPortableCatalogProvenance
- gbrain-client-factory.test.ts
- zoned-cron-equivalence.test.ts
- pen3142-run-transcript-scope.test.ts
- routines-service.test.ts
- successful-run-handoff-state.ts
- project-env-response-boundary.test.ts
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
- plugin-fencing.ts
- agent-hire-source-issue-authorization.test.ts
- approval-revision-exit.test.ts
- cloud-upstreams.test.ts
- company-search-rate-limit.ts
- readNonEmptyString
- readPenstockCapacity
- plugin-activation-retry-provenance.test.ts
- HEARTBEAT.md -- CEO Heartbeat Checklist
- task-watchdog-scope.ts
- issues-open-assignment-census.test.ts
- createToolGatewayService
- plugin-status-metrics.ts
- docker-onboard-smoke-contract.test.ts
- gemini-local-execute.test.ts
- approval-payload-title-guard.test.ts
- openclaw-invite-prompt-route.test.ts
- parked-agents-routes.test.ts
- documents.ts
- SandboxProvider
- Ally — Consolidated PR Review
- paperclip-skill-utils.test.ts
- auth-session-route.test.ts
- issue-runtime-service-command-masking.test.ts
- ensureHumanRoleDefaultGrants
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
- scrape-metrics-collector.test.ts
- trust-proxy.ts
- privateHostnameGuard
- README.md
- server-package-build-script.test.ts
- tar-security-override.test.ts
- pr-review-issue-scope-locks.test.ts
- heartbeat-reviewer-evidence-live-head.test.ts
- secretService
- plugin-activation-boot-retry.test.ts
- issue-stale-execution-lock-routes.test.ts
- plugin-manifest-validator.ts
- plugin-state-store.ts
- event-loop-stall-log.ts
- embedded-postgres.ts
- issue-monitor-convergence-message.test.ts
- heartbeat-post-terminal-run-event.test.ts
- pr-review-head-attestation.ts
- issue-monitor-queue-lock.ts
- environment-probe.test.ts
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
- TerminalWsSocket
- renderYamlBlock
- feedback-share-client.ts
- plugin-worker-invocation-scope.cjs
- issue-checkout-routine-lock-conflict.test.ts
- issue-release-lock-only-degrade.test.ts
- pen3139-transcript-credential-shapes.test.ts
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
- listNestedFiles

## God Nodes (most connected - your core abstractions)
1. `heartbeatService()` - 591 edges
2. `unprocessable()` - 381 edges
3. `issueRoutes()` - 376 edges
4. `notFound()` - 337 edges
5. `issueService()` - 266 edges
6. `logActivity()` - 259 edges
7. `recoveryService()` - 251 edges
8. `executeRun()` - 241 edges
9. `parseObject` - 194 edges
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

## Communities (515 total, 66 omitted from the detail section)

### Community 0 - "heartbeat.ts"
Cohesion: 0.01
Nodes (292): listAdapterModelProfiles(), appendWithByteCap, createEffectiveRunConfigFingerprints(), createEffectiveRunConfigSubcategoryFingerprints(), AcceptedPlanWakeRoutingDecision, ACTIVE_RUN_LOG_RUNTIME_STATUS_REFRESH_INTERVAL_MS, ACTIVE_RUN_OUTPUT_PROGRESS_FLUSH_INTERVAL_MS, activeRunExecutions (+284 more)

### Community 1 - "services/issues.ts"
Cohesion: 0.02
Nodes (132): getDefaultCompanyGoal(), GoalReader, ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS, AcceptedPlanDecompositionInput, AcceptedPlanDocumentInteraction, ALL_ISSUE_STATUSES, attentionBase(), awaitingUserInputReason() (+124 more)

### Community 2 - "company-portability.ts"
Cohesion: 0.05
Nodes (55): ADAPTER_DEFAULT_RULES_BY_TYPE, AgentLike, appendCodexImportArg(), applyImportAdapterRunDefaults(), asInteger(), bufferToPortableBinaryFile(), buildLegacyRoutineTriggerFromRecurrence(), COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS (+47 more)

### Community 3 - "errorHandler"
Cohesion: 0.03
Nodes (70): attachErrorContext(), ErrorContext, errorHandler(), getPaperclipDb(), isRedactedSkillPolicyDenial(), recordResponsibleUserDenialFromHttpError(), shouldExposeTrustedCloudTenantImportError(), createApp() (+62 more)

### Community 4 - "costs-service.test.ts"
Cohesion: 0.14
Nodes (14): createApp(), createAppWithActor(), loadCostParsers(), makeDb(), mockAccessService, mockAgentService, mockBudgetService, mockCompanyService (+6 more)

### Community 5 - "app.ts"
Cohesion: 0.03
Nodes (175): hermesGatewayAgentConfigurationDoc, acceptsGzip(), createApp(), createPrecompressedStaticMiddleware(), isDatabaseConnectionUnavailableError(), PRECOMPRESSED_STATIC_EXTENSIONS, resolveViteHmrHost(), resolveViteHmrPort() (+167 more)

### Community 6 - "issueRoutes"
Cohesion: 0.02
Nodes (124): actorMatchesExecutionParticipant(), applyCreateIssueStatusDefault(), authenticatedActorResponsibleUserId(), AutoApprovalIssueMissingError, buildCreateIssueActivityStatusDetails(), buildRequestItemVerdictsWakeIdempotencyKey(), compactIssueListEtag(), companySearchRateLimitActor() (+116 more)

### Community 7 - "workspace-runtime-service-authz.ts"
Cohesion: 0.19
Nodes (10): readObject(), resolveAgentSelfTrustPreset(), readRunIssueId(), assertAgentCanManageRuntimeServicesForWorkspace(), assertLowTrustCanManageRuntimeForActor(), assertLowTrustCanManageRuntimeForIssue(), listReportingSubtreeAgentIds(), readRunIssueId() (+2 more)

### Community 8 - "services/company-skills.ts"
Cohesion: 0.04
Nodes (162): skillImportPolicyResource(), ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS, assertImportedSkillKeyAllowed(), assertImportedSkillSourceAllowed(), asString(), auditInstalledSkillBytes(), buildInventoryContentHash(), buildMissingLocalSourceMarker() (+154 more)

### Community 9 - "services/pipelines.ts"
Cohesion: 0.04
Nodes (70): actorOwnsLease(), addFormVariablesForStage(), assertActorProvenance(), assertLeaseAvailable(), assertValidParentCase(), buildCaseDeepLink(), buildPipelineAutomationIssueTitlePrefix(), buildPipelineCaseContextMarkdown() (+62 more)

### Community 10 - "routes/issues.ts"
Cohesion: 0.02
Nodes (154): IssueApprovalLinkAuthorizationIssue, ACTIVE_REVIEW_APPROVAL_STATUSES, ActivityExecutionParticipant, activityExecutionParticipantKey(), ActivityIssueRelationSummary, applyActorMonitorScheduledBy(), attachmentArtifactMetadataInputSchema, blockerDiagnosticLabel() (+146 more)

### Community 11 - "services/built-in-agents.ts"
Cohesion: 0.05
Nodes (43): reconcileApprovedBuiltInAgent(), BUILT_IN_AGENT_DEFAULT_GRANTS, BUILT_INS_DIR, BuiltInAgentBundleDefinition, BuiltInAgentDefinition, builtInAgentNotConfiguredError(), BuiltInAgentProvisionActor, BuiltInAgentProvisionInput (+35 more)

### Community 12 - "reconcileStrandedRecoveryWakeBackstopImpl"
Cohesion: 0.06
Nodes (43): buildIssueBlockersResolvedWakeIdempotencyKey(), findExistingIssueBlockersResolvedWake(), findExistingIssueBlockersResolvedWakeForAnyKey(), IDEMPOTENT_DEPENDENCY_WAKE_STATUSES, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON, ActivePauseHoldRow, recordBackstopCandidateSkipped(), recordBackstopSweepCompleted() (+35 more)

### Community 13 - "workspace-runtime.ts"
Cohesion: 0.03
Nodes (159): asString, resolveManagedProjectWorkspaceDir(), buildAgentGitIdentityEnv(), resolveProjectCheckoutDir(), formatGitProbeRefusal(), applyIssueIdentifierToBranchName(), applyRunScopeToBranchName(), assertDirtyQuarantineRuntimeServicesStopped() (+151 more)

### Community 14 - "services/plugin-loader.ts"
Cohesion: 0.04
Nodes (83): ActivationLatchClassification, ADAPTER_ENV_PASSTHROUGH, BOOT_ACTIVATION_RETRY_PATTERN, BOOT_REATTEMPT_ELIGIBLE_MARKERS, BOOT_REATTEMPT_ELIGIBLE_SUFFIX_PATTERN, buildLocalPluginBuildCommand(), buildLocalPluginBuildCommands(), buildLocalPluginRecoveryCommand() (+75 more)

### Community 15 - "github-webhook.ts"
Cohesion: 0.02
Nodes (200): acquirePrReviewerWakeSlot(), ACTIVE_PR_REVIEWER_RUN_STATUSES, attemptPrReviewerWake(), AUTHOR_DELIVERY_SCOPED_WAKE_REASONS, backLinkAbsoluteUrl(), bodyReRaisesPriorFinding(), buildDependabotAlertIssueBody(), buildDependabotRefireComment() (+192 more)

### Community 16 - "routes/pipelines.ts"
Cohesion: 0.04
Nodes (86): acknowledgeDriftSchema, activityActorForPipelineRoute(), actorForMutation(), assertCaseAccess(), assertCurrentStageAutomationTargetWriteAccess(), assertPipelineAccess(), assertPipelineCompanyAccess(), assertPipelineWriteAccess() (+78 more)

### Community 17 - "heartbeat-retry-scheduling.test.ts"
Cohesion: 0.02
Nodes (88): runningProcesses, BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS, INTERACTION_CONTINUATION_INFRA_RETRY_REASON, INTERACTION_CONTINUATION_INFRA_WAKE_REASON, JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS, MAX_TURN_CONTINUATION_RETRY_REASON, MAX_TURN_CONTINUATION_WAKE_REASON (+80 more)

### Community 18 - "k8s-job-liveness.ts"
Cohesion: 0.04
Nodes (76): applyImageBumpToAgent(), ApplyResult, bumpAgentImagesForCompany(), BumpBatchSummary, ELIGIBLE_ADAPTER_TYPES, EligibleAgent, EXECUTING_RUN_STATUSES, isAgentExecuting() (+68 more)

### Community 19 - "readNonEmptyString"
Cohesion: 0.03
Nodes (99): extractWakeCommentIds(), resolveEffectiveWorkspaceStrategyType(), describeGitFailure(), assertGitWorktreeBaseWorkspaceReady(), assertPushCapabilityCheckoutValid(), buildPaperclipWakePayload(), clearInteractionContinuationWakeContext(), coalesceQueuedGithubStateWake() (+91 more)

### Community 20 - "services/tool-gateway.ts"
Cohesion: 0.05
Nodes (45): looksLikeJsonRpcMessage(), MCP_HTTP_ACCEPT, mcpHttpRequestHeaders(), parseMcpHttpResponseBody(), AgentToolDescriptor, ACTIVE_GATEWAY_RUN_STATUSES, approvalSnapshotsMatch(), buildHumanizedActionPreview() (+37 more)

### Community 21 - "services/tool-access.ts"
Cohesion: 0.05
Nodes (58): ACTIVE_BROKER_RUN_STATUSES, activityLogActionToLifecycleType(), actorBinding(), ActorInfo, APPROVED_STDIO_TEMPLATES, assertClass3ToolCredentialRefAllowed(), assertSameOAuthActor(), buildProfileDetails() (+50 more)

### Community 22 - "routes/access.ts"
Cohesion: 0.05
Nodes (46): createCompanyInviteForCompany(), agentJoinGrantsFromDefaults(), AvailableSkill, companyInviteExpiresAt(), CompanyMemberRecord, createInviteToken(), defaultInviteResolutionNetwork, grantsFromDefaults() (+38 more)

### Community 23 - "executeRun"
Cohesion: 0.02
Nodes (145): getServerAdapter(), resolveAgentEmptyWorkspaceSourceDir(), resolveDefaultAgentWorkspaceDir(), resolveStaleDependabotAlertWakeIssue(), buildExecutionWorkspaceAdapterConfig(), executionWorkspaceUsesGitWorktree(), executionWorkspaceUsesPerRunScope(), parseExecutionWorkspaceStrategy() (+137 more)

### Community 24 - "approvals-service.test.ts"
Cohesion: 0.08
Nodes (15): ApprovalRecord, expectRejectedWithoutMutation(), mockAgentService, mockLogActivity, mockNotifyHireApproved, readStatus(), withdrawalActor, call() (+7 more)

### Community 25 - "heartbeatService"
Cohesion: 0.02
Nodes (187): publishPluginDomainEvent(), shouldCancelRunsForNonInvokableAgent(), getActiveAgentIds(), ensureCoalescedFollowUp(), markAgentStartLockPhase(), runDetachedFromAgentStartLock(), withAgentStartLock(), incrementBlockerResolvedWakeMetric() (+179 more)

### Community 26 - "productivity-review.ts"
Cohesion: 0.04
Nodes (85): ACTIVE_RUN_STATUSES, AgentRow, APPROVAL_GATE_SUPPRESSION_STATUSES, ApprovalGatedSuppression, buildThresholds(), DbOrTx, DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS, DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS (+77 more)

### Community 27 - "services/teams-catalog.ts"
Cohesion: 0.05
Nodes (63): buildPortabilityInput(), CatalogManifestFile, catalogManifestPath, catalogPackageRootCandidates, catalogProvenance(), CatalogTargetManagerReference, CatalogTeamActorContext, CatalogTeamFileDetail (+55 more)

### Community 28 - "logger.ts"
Cohesion: 0.01
Nodes (114): httpLogger, logDir, logFile, logger, sharedOpts, AvailableBundledPlugin, bundledPluginMetadata(), __dirname (+106 more)

### Community 29 - "environment-config.ts"
Cohesion: 0.14
Nodes (27): collectEnvironmentSecretRefs(), createEnvironmentSecret(), fakeSandboxEnvironmentConfigSchema, getSandboxProvider(), normalizeEnvironmentConfig(), normalizeEnvironmentConfigForPersistence(), normalizeEnvironmentConfigForProbe(), ParsedEnvironmentConfig (+19 more)

### Community 30 - "evidence-gate.ts"
Cohesion: 0.06
Nodes (53): ALL_SHAPES, BLOCKABLE_TRUTH_SHAPES, buildAgentEvidenceText(), countDoneWhenBullets(), CriteriaSection, detectAll(), detectChecklistDoneWhen(), detectCiGreen() (+45 more)

### Community 31 - "middleware/auth.ts"
Cohesion: 0.10
Nodes (26): BetterAuthSessionResult, actorMiddleware(), ActorMiddlewareOptions, auditAgentJwtMissingResponsibleUser(), auditAgentJwtRunHeaderMismatch(), auditAgentKeyMissingResponsibleUser(), cloudTenantCompanyId(), constantTimeStringEqual() (+18 more)

### Community 32 - "services/cloud-upstreams.ts"
Cohesion: 0.10
Nodes (34): cloudUpstreamRemoteFailureReport(), ConnectionRow, consentUrlFromDiscovery(), DEFAULT_SCOPES, fetchDiscovery(), fetchWithTimeout(), firstPathSegment(), LocalUpstreamExportBundle (+26 more)

### Community 33 - "toolAccessService"
Cohesion: 0.04
Nodes (129): HttpError, asRecord(), builtInStdioTemplate(), googleSheetsAllowedSpreadsheetIds(), isGoogleSheetsConnectionConfig(), normalizeGoogleSheetsConnectionConfig(), normalizeToolDescriptor(), readStdioTemplateId() (+121 more)

### Community 34 - "registry.ts"
Cohesion: 0.06
Nodes (32): BUILTIN_ADAPTER_TYPES, acpxLocalAdapter, adaptersByType, buildCursorRuntimeCommandSpec(), buildNpmRuntimeCommandSpec(), builtinFallbacks, claudeLocalAdapter, codexLocalAdapter (+24 more)

### Community 35 - "tool-access-policy.ts"
Cohesion: 0.06
Nodes (72): argumentConditionMatches(), argumentFiltersMatch(), assertGenericPolicyType(), assertSupportedGenericPolicyShape(), assertSupportedPolicyConditions(), asToolRiskLevel(), auditOutcome(), boolCondition() (+64 more)

### Community 36 - "recovery/index.ts"
Cohesion: 0.05
Nodes (87): addAgentChainCandidates(), addOwnerCandidate(), classifyIssueGraphLiveness(), blockedFindingForLeaf(), blockedWithoutBlockersFinding(), firstBlockedChainFinding(), hasAnyBlockerEdge(), hasExplicitWaitingPath() (+79 more)

### Community 37 - "services/attention.ts"
Cohesion: 0.05
Nodes (62): activeDismissalState(), approvalDetail(), approvalTitle(), ATTENTION_SOURCE_KINDS, AttentionListOptions, attentionService(), betterDuplicate(), blockingIssueMap() (+54 more)

### Community 38 - "cases.ts"
Cohesion: 0.05
Nodes (55): ALLOWED_COMPANY_LOGO_CONTENT_TYPES, assetRoutes(), sanitizeSvgBuffer(), annotationActorInput(), assertCaseAccess(), assertCasesEnabled(), assertLabelsBelongToCompany(), assertParentCaseBelongsToCompany() (+47 more)

### Community 39 - "startServer"
Cohesion: 0.14
Nodes (14): startServer(), applyMigrationsForLabel(), assertCloudDatabaseContract(), ensureMigrations(), formatPendingMigrationSummary(), isPostgresConnectionString(), promptApplyMigrations(), registerLinearWebhook() (+6 more)

### Community 40 - "recoveryService"
Cohesion: 0.04
Nodes (130): issueLockOwnerStateMatches(), lockIssueOwnership(), lockIssueParentMutationCompany(), recordRecoveryActionAutoDischarged(), recordRecoveryHorizonExpired(), recoveryAssigneeAdapterOverrides(), describeWorkspacePreflightRecoveryCause(), escapeLikePattern() (+122 more)

### Community 41 - "environment-custom-images.ts"
Cohesion: 0.07
Nodes (63): resolveSandboxProviderSecretRefPaths(), applyCustomImageTemplateToSandboxConfig(), classifyEnvironmentCustomImageConfigChange(), defaultEnvironmentCustomImageRuntimeConfigBinding(), ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS, ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY, ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS, EnvironmentCustomImageConfigChangeKind (+55 more)

### Community 42 - "feedback.ts"
Cohesion: 0.08
Nodes (36): asBoolean(), asNumber(), asRecord(), asString(), buildAgentContext(), buildIssueContext(), buildIssuePath(), buildPayloadArtifacts() (+28 more)

### Community 43 - "metrics.ts"
Cohesion: 0.01
Nodes (220): createBetterAuthHandler(), normalizeAuthLocationHeader(), counters, DepBlockedMetricKey, getDepBlockedMetric(), resetDepBlockedMetrics(), snapshotDepBlockedMetrics(), AGENT_ERROR_REASON_NONE (+212 more)

### Community 44 - "workspace-file-resources.ts"
Cohesion: 0.07
Nodes (64): AutoDiscovered, availableFileList(), candidateFromExecutionWorkspace(), candidateFromProjectWorkspace(), contentTypeForPath(), DENIED_SEGMENTS, denyReasonForPathSegments(), directoryResource() (+56 more)

### Community 45 - "openapi.ts"
Cohesion: 0.05
Nodes (42): ACCEPTED_OPERATIONS, AUTHENTICATED_OPERATIONS, AUTHENTICATED_SECURITY, BOARD_ONLY_OPERATIONS, BOARD_ONLY_PREFIXES, BOARD_SECURITY, cloudCompanyBodySchema, cloudCompanyQuerySchema (+34 more)

### Community 46 - "skills-catalog.ts"
Cohesion: 0.06
Nodes (47): fetchJson(), fetchJson(), fetchText(), abortFailure(), ghReadBody(), GITHUB_FETCH_DEADLINE_MS, GITHUB_REQUEST_TIMEOUT_MS, isGitHubDotCom() (+39 more)

### Community 47 - "github-app-auth.ts"
Cohesion: 0.06
Nodes (92): GithubWebhookConfig, asCommitStatusFailure(), base64Url(), BranchState, ClassifiedGithubHttpFailure, classifyGithubHttpFailure(), classifyWorkflowRunNotFound(), encodeGitRefPath() (+84 more)

### Community 48 - "services/routines.ts"
Cohesion: 0.08
Nodes (38): ACTIVITY_GATE_IGNORED_ACTIONS, Actor, assertRoutineCanEnable(), assertRoutineVariableDefinitions(), assertScheduleCompatibleVariables(), buildRoutineRevisionSnapshot(), canonicalSnapshot(), collectProvidedRoutineVariables() (+30 more)

### Community 49 - "agent-adapter-validation-routes.test.ts"
Cohesion: 0.11
Nodes (15): createApp(), externalAdapter, mockAccessService, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+7 more)

### Community 50 - "effective-run-config-fingerprints.ts"
Cohesion: 0.08
Nodes (42): buildSecretManifestIndex(), CanonicalizeContext, canonicalizeEffectiveRunConfigCategory(), canonicalizeEnvRecord(), canonicalizePlainEnvValueForHash(), canonicalizeValue(), canonicalRecord(), canonicalSecretMetadata() (+34 more)

### Community 52 - "penstock-availability-gate.ts"
Cohesion: 0.11
Nodes (20): PenstockProbeOutcomeLabel, PenstockProbePathLabel, CacheEntry, capacityRetryFromBody(), parseCapacityResetIso(), parseCapacityRetry(), parseOptionalDate(), parseRetryAfterSeconds() (+12 more)

### Community 53 - "authorization.ts"
Cohesion: 0.06
Nodes (43): activeResponsibleUserCanAuthorizeAgentGrantedSkillChange(), activeResponsibleUserCanAuthorizeIssueAction(), AGENT_UNASSIGNED_CLAIM_DENIED_ORIGIN_KINDS, AgentAuthorizationRow, AgentHierarchyRow, agentIsInSubtree(), AssignmentPolicyEffect, AuthorizationAction (+35 more)

### Community 54 - "routes/approvals.ts"
Cohesion: 0.03
Nodes (103): assertHireSourceIssueLinksAllowed(), getAccessibleAgent(), ALLOWED, approvalResolutionResponse(), approvalRoutes(), approvalReadOptions(), assertApprovalMutationAllowedByRunContext(), assertIssueLinksAllowed() (+95 more)

### Community 55 - "execution-workspace-cleanup.ts"
Cohesion: 0.07
Nodes (44): classifyRemovalProof(), decodeRunAttribution(), encodeRetainedReason(), EXECUTION_WORKSPACE_IDLE_GRACE_MS, EXECUTION_WORKSPACE_LEGACY_IDLE_MS, ExecutionWorkspaceCleanupResult, executionWorkspaceCleanupService(), reconcileExecutionWorkspaceCleanup() (+36 more)

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
Cohesion: 0.07
Nodes (66): RFC-3986, AMBIGUOUS_PROMOTABLE_TOKENS, assignRecordKey(), BENIGN_HEADER_NAMES, classifyKeyTier(), CLI_SECRET_FLAG_RE, ENV_DUMP_SECRET_ASSIGNMENT_RE, ESCAPED_JSON_SECRET_FIELD_TEXT_RE (+58 more)

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
Nodes (49): ACTIVE_RUN_STATUSES, ActiveCancelSnapshot, ActiveIssueTreePauseHoldGate, activePauseHoldPredicate(), ActiveRunRow, ActorInput, actorMatchesComment(), buildAffectedAgents() (+41 more)

### Community 64 - "better-auth.ts"
Cohesion: 0.11
Nodes (28): BetterAuthGetSessionApi, BetterAuthHandlerTarget, BetterAuthInstance, BetterAuthSessionResolver, BetterAuthSessionUser, buildBetterAuthAdvancedOptions(), buildBetterAuthRateLimitOptions(), buildDexOAuthProviderConfigFromEnv() (+20 more)

### Community 65 - "environment-runtime.ts"
Cohesion: 0.04
Nodes (96): getSandboxProviderConfigSchema(), parseEnvironmentDriverConfig(), resolveEnvironmentDriverConfigForRuntime(), stripSandboxProviderEnvelope(), probeEnvironment(), probeK8sEnvironment(), raceWithTimeout(), buildEnvironmentSecretMetadataForLeaseFingerprint() (+88 more)

### Community 66 - "storage/types.ts"
Cohesion: 0.09
Nodes (25): DurableRunLogStoreOptions, resolveRunLogS3(), createStorageServiceFromConfig(), getStorageService(), signatureForConfig(), createLocalDiskStorageProvider(), normalizeObjectKey(), resolveWithin() (+17 more)

### Community 67 - "issue-attachment-routes.test.ts"
Cohesion: 0.09
Nodes (24): DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT_BYTES, captureRawBody(), registerBodyParsers(), shouldCaptureRawBody(), findRawNulInBody(), Frame (+16 more)

### Community 68 - "createPluginJobScheduler"
Cohesion: 0.11
Nodes (27): advanceToNextMonth(), FIELD_SPECS, FieldSpec, findNext(), nextCronTick(), nextCronTickFromExpression(), parseCron(), ParsedCron (+19 more)

### Community 69 - "plugin-database.ts"
Cohesion: 0.07
Nodes (27): ApplyPluginMigrationsOptions, assertAllowedPublicRead(), assertIdentifier(), assertNoBannedSql(), derivePluginDatabaseNamespace(), extractQualifiedRefs(), normaliseSql(), PluginDatabaseClient (+19 more)

### Community 70 - "local-service-supervisor.ts"
Cohesion: 0.08
Nodes (61): renderTemplate, deriveRepoNameFromRepoUrl(), resolveManagedProjectWorkspaceCheckout(), adoptLocalServiceFromPortOwner(), createLocalServiceKey(), doesLocalServiceRecordMatchCwd(), execFileAsync, findAdoptableLocalService() (+53 more)

### Community 71 - "services/projects.ts"
Cohesion: 0.09
Nodes (38): cloneRecord(), isRecord(), mergeProjectWorkspaceRuntimeConfig(), readDesiredState(), readProjectWorkspaceRuntimeConfig(), readServiceStates(), attachGoals(), attachListMetrics() (+30 more)

### Community 72 - "org-chart-svg.ts"
Cohesion: 0.10
Nodes (34): avatarGridHeight(), avatarGridRows(), avatarGridWidth(), cardHeight(), cardWidth(), collapseToAvatars(), countNodes(), defaultRenderCard() (+26 more)

### Community 73 - "environment-run-orchestrator.ts"
Cohesion: 0.07
Nodes (42): DEFAULT_K8S_REMOTE_CWD, DEFAULT_SANDBOX_REMOTE_CWD, isPlainObject(), isStringRecord(), resolveEnvironmentExecutionTarget(), resolveEnvironmentExecutionTransport(), EnvironmentAcquisitionResult, EnvironmentErrorCode (+34 more)

### Community 74 - "issue-thread-interactions.ts"
Cohesion: 0.05
Nodes (65): assertRequestConfirmationTargetIsCurrent(), buildInteractionResolvedCounts(), buildIssueDocumentTargetFromDocument(), buildIssueDocumentTargetFromSnapshot(), buildStaleTargetResult(), buildSupersededByCommentResult(), buildTaskCreationOrder(), buildWithdrawnInteractionResult() (+57 more)

### Community 75 - "plugin-host-services.ts"
Cohesion: 0.03
Nodes (82): RFC-1918, badRequest(), activationEntityTypeBody(), cloudUpstreamRoutes(), optionalString(), stringBody(), stringQuery(), parseKind() (+74 more)

### Community 76 - "run-liveness.ts"
Cohesion: 0.11
Nodes (35): findCommentNextAction(), actionabilityText(), classifyRunActionability(), classifyRunLiveness(), combinedOutput(), compactReason(), declaredBlocker(), DEFAULT_EVIDENCE (+27 more)

### Community 77 - "cloudUpstreamService"
Cohesion: 0.13
Nodes (25): activationChecklistFromReport(), activationEntityLabel(), asRecord(), assertActivationEntityType(), buildWarnings(), cloudUpstreamService(), assertNoRunningRun(), buildSummary() (+17 more)

### Community 78 - "agentService"
Cohesion: 0.07
Nodes (55): defaultPermissionsForRole(), normalizeAgentPermissions(), NormalizedAgentPermissions, describeAgentStartLockDispatchHealth(), AgentConfigSnapshot, agentService(), assertCompanyShortnameAvailable(), assertNoCycle() (+47 more)

### Community 79 - "company-search.ts"
Cohesion: 0.08
Nodes (54): activeIssueFilters(), artifactResult(), companySearchService(), countAgents(), countArtifacts(), countProjects(), countTotalNonIssue(), enrichIssueSnippets() (+46 more)

### Community 80 - "task-watchdogs.ts"
Cohesion: 0.05
Nodes (64): ActorFields, assertWatchdogAgentInvokable(), assertWatchedIssue(), buildStoppedFingerprintComment(), classifyTaskWatchdogSubtree(), isActiveTaskWatchdogUniqueConflict(), isIssueWatchdogUniqueConflict(), issueIdFromRunContext() (+56 more)

### Community 81 - "git-worktree-ownership.ts"
Cohesion: 0.13
Nodes (31): authorizeOwnedGitWorktreeCleanup(), classifyWorktreeOwnership(), describeDeclinedCleanup(), describeOwner(), describeUnreadableRegistry(), directoryExists(), findGitWorktreeRegistration(), formatWorktreeOwnerLockReason() (+23 more)

### Community 82 - "services/smoke-lab.ts"
Cohesion: 0.05
Nodes (49): assertBoardOrAgent(), resolveRagHealthCompanyId(), configuredPublicBaseUrl(), requestBaseUrl(), smokeLabBaseUrl(), smokeLabRoutes(), stringBodyValue(), allocateFetchAllowedLoopbackPort() (+41 more)

### Community 83 - "workspace-runtime.test.ts"
Cohesion: 0.08
Nodes (37): executeProcessForTests, ExecutionWorkspaceInput, GIT_INDEX_LOCK_STALE_MS, isProcessGroupAliveForTests, LockHolderScan, RealizedExecutionWorkspace, setLockHolderScanForTests(), setProcessGroupLivenessProbeForTests() (+29 more)

### Community 84 - "heartbeat-process-recovery.test.ts"
Cohesion: 0.04
Nodes (41): HEARTBEAT_RUN_FAILED_METRIC, PROCESS_LOST_LIVENESS_NULL_METRIC, PROCESS_LOST_TOTAL_METRIC, ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT, allowPenstockGate, drainInFlightExecutions(), expectSourceScopedStrandedRecoveryAction(), expectStrandedRecoveryArtifacts() (+33 more)

### Community 85 - "worktree-config.ts"
Cohesion: 0.13
Nodes (30): buildIsolatedConfig(), buildLegacyConfig(), ORIGINAL_CWD, ORIGINAL_ENV, applyRuntimePortSelectionToConfig(), buildIsolatedWorktreeConfig(), collectSiblingWorktreePorts(), expandHomePrefix() (+22 more)

### Community 86 - "index.ts"
Cohesion: 0.09
Nodes (27): BUNDLED_PLUGIN_PACKAGES, autoConfigureAlertmanagerFromEnv(), autoConfigureLinearFromEnv(), BootstrapContext, compareVersions(), enableBundledPlugin(), FetchInternal, forceReinstallLocalPlugin() (+19 more)

### Community 87 - "unprocessable"
Cohesion: 0.04
Nodes (79): notFound(), unprocessable(), assertAgentDefaultEnvironmentSelection(), normalizeAgentReference(), assertBuiltInAgentsEnabled(), assertEnabled(), validatePolicyBody(), assertActiveUserMembership() (+71 more)

### Community 88 - "environment-custom-image-terminal-ws.ts"
Cohesion: 0.13
Nodes (20): AuthenticatedTerminalContext, closeUpgradeSocket(), CUSTOM_IMAGE_TERMINAL_UTF8_ENV, CustomImageTerminalService, decodeClientMessage(), IncomingMessageWithTerminalContext, isWritableUpgradeSocket(), parseJsonClientFrame() (+12 more)

### Community 89 - "plugin-routes-authz.test.ts"
Cohesion: 0.12
Nodes (7): ragHealthBucketCache, createApp(), maskingSchema, mockLifecycle, mockRegistry, mockSecretService, withTransactionSupport()

### Community 90 - "board-claim.ts"
Cohesion: 0.36
Nodes (8): ChallengeStatus, claimBoardOwnership(), ClaimChallenge, createChallenge(), getBoardClaimWarningUrl(), getChallengeStatus(), initializeBoardClaimChallenge(), inspectBoardClaimChallenge()

### Community 91 - "config.ts"
Cohesion: 0.05
Nodes (54): CWD_ENV_PATH, DatabaseMode, describeNumericCandidate(), detectTailnetBindHost(), readConfigFile(), loadConfig(), MAX_TIMER_DELAY_MS, NUMERIC_SETTING_BOUNDS (+46 more)

### Community 92 - "run-liveness-continuations.ts"
Cohesion: 0.12
Nodes (14): ACTIONABLE_LIVENESS_STATES, AgentRow, CONTINUATION_ACTIVE_ISSUE_STATUSES, CONTINUATION_AGENT_STATUSES, DEFAULT_MAX_LIVENESS_CONTINUATION_ATTEMPTS, HeartbeatRunRow, IDEMPOTENT_WAKE_STATUSES, IssueRow (+6 more)

### Community 93 - "recovery/service.ts"
Cohesion: 0.02
Nodes (93): IssueDependencyReadiness, AGENT_POD_BUSY_MAX_STALE_MS, NON_LIVE_EXECUTION_SILENCE_MS, POD_GIT_TRANSPORT_FAILURE, ACTION_SCOPED_SWEEP_NAMES, ActionScopedSweepName, ActionScopedSweepOutcome, ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS (+85 more)

### Community 94 - "agent-instructions.ts"
Cohesion: 0.17
Nodes (39): AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary, agentInstructionsService(), deleteFile(), ensureWritableBundle(), exportFiles(), getBundle() (+31 more)

### Community 95 - "parseObject"
Cohesion: 0.04
Nodes (129): parseObject, isTerminalIssueStatus(), shouldReopenTerminalIssueForDeferredWake(), boundHeartbeatRunEventPayloadForStorage(), computeK8sIsolationRetryDelayMs(), decorateHeartbeatRunRuntimeStatus(), derivePaperclipPrReview(), describeRecoveryError() (+121 more)

### Community 96 - "hot-restart.ts"
Cohesion: 0.15
Nodes (24): prepareHotRestartShutdown(), toHotRestartIntentRun(), asBoolean(), asNumber(), asString(), HOT_RESTART_INTENT_FILENAME, HOT_RESTART_REPORT_FILENAME, HotRestartIntent (+16 more)

### Community 97 - "process-crash-guard.ts"
Cohesion: 0.07
Nodes (32): CrashTimeRunMarker, installWorkerCrashGuard(), markInFlightRunsForWorkerCrash(), registerCrashTimeRunMarker(), resetCrashTimeRunMarkerForTest(), CRASH_GUARD_EXIT_CODE, CrashGuardContext, CrashGuardLogger (+24 more)

### Community 98 - "productivity-review-service.test.ts"
Cohesion: 0.05
Nodes (20): DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY, DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS, DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS, DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS, DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS, ISSUE_MONITOR_WAKE_CLAIM_TTL_MS, PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS, PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX (+12 more)

### Community 99 - "aws-secrets-manager-provider.ts"
Cohesion: 0.05
Nodes (52): asAwsSecretsManagerMaterial(), asOptionalNonEmptyString(), assertNotManagedNamespaceExternalRef(), AwsCredentialIdentity, awsCredentialProviders, awsDateParts(), awsProviderSafeMessage(), AwsSecretsManagerConfig (+44 more)

### Community 100 - "issue-comment-reopen-routes.test.ts"
Cohesion: 0.06
Nodes (26): installActor(), mockAccessService, mockAgentService, mockDb, mockDbSelect, mockDbSelectFrom, mockDbSelectLimit, mockDbSelectOrderBy (+18 more)

### Community 101 - "pipelines-aggregation.ts"
Cohesion: 0.09
Nodes (28): ActiveWork, AttentionCaller, boundedLimit(), CASE_CHILDREN_TREE_MAX_DEPTH, CASE_CHILDREN_TREE_MAX_NODES, CaseChildNode, CaseChildrenRollup, caseDisplay() (+20 more)

### Community 102 - "environment-probe-k8s.test.ts"
Cohesion: 0.24
Nodes (6): FakeKubeConfig, mockGetCode, mockLoadFromCluster, mockLoadFromString, mockMakeApiClient, mockResolveSecretValue

### Community 103 - "runStrandedAssignedIssueSweep"
Cohesion: 0.05
Nodes (61): FRESHNESS, ISSUE_REF, agentUiLink(), buildExecutionReviewParticipantRecoveryComment(), buildExecutionReviewParticipantUnavailableComment(), buildNonRetryableEscalationComment(), didAutomaticRecoveryFail(), extractAgentMcpKeys() (+53 more)

### Community 104 - "plugin-runtime-sandbox.ts"
Cohesion: 0.19
Nodes (12): CapabilityScopedInvoker, DEFAULT_GLOBALS, isWithinRoot(), LoadedModule, loadPluginModuleInSandbox(), looksLikeEsm(), MODULE_PATH_SUFFIXES, normalizeModuleExports() (+4 more)

### Community 105 - "plugin-worker-manager.ts"
Cohesion: 0.05
Nodes (35): ActiveInvocation, ANTHROPIC_ROUTING_ENV_KEYS, anthropicRoutingEnv(), appendStderrExcerpt(), spawnProcess(), HOST_STARTUP_RPC_FAILURE, HostStartupRpcFailure, isHostStartupRpcFailure() (+27 more)

### Community 106 - "sweep-wake-preflight.ts"
Cohesion: 0.11
Nodes (32): compareSweepWakeFrame(), currentMinuteBucket(), detectSweepWakeRace(), equalStringArrays(), getIssueSnapshot(), isCompanyFlagEnabled(), isValidIsoDate(), isValidSweepWakeFrame() (+24 more)

### Community 107 - "issue-execution-policy-routes.test.ts"
Cohesion: 0.09
Nodes (20): createApp(), issueWithClearedStalledMonitor(), issueWithTriggeredMonitor(), makeInReviewIssue(), mockAccessService, mockDb, mockDbInsert, mockDbInsertValues (+12 more)

### Community 108 - "tool-access-service.test.ts"
Cohesion: 0.08
Nodes (27): canonicalToolArguments(), hashToolValue(), isPlainObject(), PROMPT_INJECTION_PATTERNS, readSignedToolArguments(), readSignedToolArgumentsPayload(), resolveToolActionSigningSecret(), scanPromptInjection() (+19 more)

### Community 109 - "budgetService"
Cohesion: 0.07
Nodes (38): costRoutes(), parseCostDateRange(), parseCostLimit(), budgetApprovalIdempotencyKey(), BudgetBurnEstimate, budgetService(), buildPolicySummary(), createIncidentIfNeeded() (+30 more)

### Community 110 - "external-objects.ts"
Cohesion: 0.05
Nodes (69): runSingleFileUpload(), addSeconds(), createExternalObjectDetectorRegistry(), detect(), createExternalObjectResolverRegistry(), find(), createPluginProviderDetector(), ExternalObjectDetection (+61 more)

### Community 111 - "environment-routes.test.ts"
Cohesion: 0.08
Nodes (23): createApp(), currentActor, mockAccessService, mockAgentService, mockCancelPluginEnvironmentInteractiveSetup, mockCapturePluginEnvironmentTemplate, mockDeletePluginEnvironmentTemplate, mockEnvironmentCustomImageService (+15 more)

### Community 112 - "services/dashboard.ts"
Cohesion: 0.08
Nodes (33): dashboardRoutes(), parsePositiveNumber(), buildDismissedAtByKey(), sidebarBadgeRoutes(), AgentReviewCounts, AgentRunCounts, AgentScorecard, AgentScorecardInput (+25 more)

### Community 113 - "identifier-allocator.ts"
Cohesion: 0.13
Nodes (16): allocateFromLinear(), allocateFromPaperclip(), allocateIdentifier(), AllocateIdentifierInput, AllocateIdentifierResult, allocationFromLinearIssue(), CreatedLinearIssue, createLinearIssue() (+8 more)

### Community 114 - "issue-execution-policy.ts"
Cohesion: 0.04
Nodes (98): hasScheduledMonitor(), classifySourceRecoveryRevalidation(), isLapsedMonitorRearmPatch(), writeIssueMonitor(), summarizeIssueMonitor(), dispatchClaimedIssueMonitor(), reconcileUndeliverableIssueMonitors(), tickDueIssueMonitors() (+90 more)

### Community 115 - "listBlockedInboxIssues"
Cohesion: 0.06
Nodes (45): activeRunMapForIssues(), activeRunMapKey(), appendBlockerAttentionEdges(), blockedByMapForIssues(), blockedInboxAttentionResponseFields(), blockedInboxResponseDescription(), blockedInboxSearchText(), blockerSampleIdentifier() (+37 more)

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
Cohesion: 0.06
Nodes (44): cloneRecord(), defaultIssueExecutionWorkspaceSettingsForProject(), ExecutionWorkspaceEnvironmentResolution, ExecutionWorkspaceEnvironmentSource, gateProjectExecutionWorkspacePolicy(), hasReusableExecutionWorkspaceBinding(), isPlainRecord(), issueExecutionWorkspaceModeForPersistedWorkspace() (+36 more)

### Community 120 - "file-resources.ts"
Cohesion: 0.14
Nodes (22): activityDetails(), createFileResourceLimiter(), createFileResourceListLimiter(), denialReasonFromError(), FileResourceLimiter, fileResourceRoutes(), logDeniedAttempt(), logListDeniedAttempt() (+14 more)

### Community 121 - "company-artifacts.ts"
Cohesion: 0.14
Nodes (24): ArtifactCursor, ArtifactGroupBy, attachmentContentPath(), buildArtifactGroups(), buildArtifactsGroupHref(), buildIssueHref(), classifyMediaKind(), companyArtifactsService() (+16 more)

### Community 122 - "productivityReviewService"
Cohesion: 0.07
Nodes (61): extractReviewTriggerFromDescription(), isActiveProductivityReviewUniqueConflict(), isApprovalGatedSuppression(), isMonitorScheduledSuppression(), isSoftStopTrigger(), isTerminalIssueStatus(), MonitorSuppressedBeforeCreateError, productivityReviewAssignmentWakeIdempotencyKey() (+53 more)

### Community 123 - "plugin-config-masking.ts"
Cohesion: 0.09
Nodes (48): RFC-6901, AMBIGUOUS_SCHEMA_NODE, childNodesForIndex(), childNodesForKey(), collectDiscardedPointerStringLeaves(), collectPluginConfigSecretValues(), collectStringLeaves(), containsMask() (+40 more)

### Community 124 - "tool-oauth-legacy-backfill.ts"
Cohesion: 0.15
Nodes (22): awsSecretsManagerProvider, getSecretProvider(), asRecord(), backfillLegacyToolOAuthTokens(), configPath(), hasRawOauthTokenKeys(), LegacyOAuthToken, OAuthTokenKind (+14 more)

### Community 125 - "api-compression.ts"
Cohesion: 0.15
Nodes (21): API_COMPRESSION_THRESHOLD_BYTES, apiCompression(), ApiCompressionOptions, deflateAsync, EncodingPreference, gzipAsync, isJsonContentType(), normalizeEndArgs() (+13 more)

### Community 126 - "github-review-gate-authority.ts"
Cohesion: 0.07
Nodes (49): affectsProtectedBase(), Candidate, claimDueGithubReviewGateDeliveries(), COMMENT_ACTIONS, commentSignals(), createRepositoryDispatch(), deliveryClaimWhere(), DeliveryRow (+41 more)

### Community 127 - "live-events-ws.ts"
Cohesion: 0.14
Nodes (15): authorizeUpgrade(), closeUpgradeSocket(), hashToken(), headersFromIncomingMessage(), IncomingMessageWithContext, isWritableUpgradeSocket(), parseBearerToken(), parseCompanyId() (+7 more)

### Community 128 - "normalizeAgentDefaultsForJoin"
Cohesion: 0.19
Nodes (19): buildJoinDefaultsPayloadForAccept(), canReplayOpenClawGatewayInviteAccept(), extractHeaderEntries(), generateEd25519PrivateKeyPem(), headerMapGetIgnoreCase(), headerMapHasKeyIgnoreCase(), isDefaultHermesDashboardRoot(), isPlainObject() (+11 more)

### Community 129 - "source-trust.ts"
Cohesion: 0.09
Nodes (27): sourceTrustForActorWrite(), fenceMarkdown(), formatPipelineConversationBodyDocumentContextMarkdown(), loadPipelineConversationBodyDocumentContext(), PIPELINE_CASE_BODY_CASE_DOCUMENT_KEY, PipelineConversationBodyDocumentContext, QueryableDb, truncateWithFlag() (+19 more)

### Community 130 - "issue-continuation-summary.ts"
Cohesion: 0.18
Nodes (18): AgentSummaryInput, asNonEmptyString(), buildContinuationSummaryMarkdown(), bulletList(), continuationSummaryParksExecutor(), extractContinuationSummaryNextAction(), extractMarkdownSection(), extractPathCandidates() (+10 more)

### Community 131 - "run-log-store.ts"
Cohesion: 0.10
Nodes (16): key(), createDurableRunLogStore(), ensureDir(), readLocalRange(), readS3Range(), s3Key(), isAtOrPastEnd(), normalizeKeyPrefix() (+8 more)

### Community 132 - "github-status-delivery-outbox.ts"
Cohesion: 0.10
Nodes (34): githubAppCredentialsConfigured(), GitHubCommitStatusState, appendDeliveryRunEvent(), claimDueGitHubCommitStatusDeliveries(), classifyReviewerEvidenceError(), DbHandle, deliveryClaimWhere(), DeliveryRow (+26 more)

### Community 133 - "opencode-k8s-seed-transport.test.ts"
Cohesion: 0.12
Nodes (24): CapturedCall, classifyCall(), completionChunk(), initializeResult(), JsonRpcMessage, listen(), opencodeBin, opencodeEnv() (+16 more)

### Community 134 - "utils.ts"
Cohesion: 0.17
Nodes (19): execute(), processAdapter, summarizeStatus(), testEnvironment(), asStringArray, buildInvocationEnvForLogs(), BuildInvocationEnvForLogsOptions, buildPaperclipEnv (+11 more)

### Community 135 - "server-info.ts"
Cohesion: 0.16
Nodes (14): DEFAULT_BUILD_COMMIT_PATH, parseBuildCommit(), readBuildCommit(), ReadTextFile, BuildCommitCommand, createServerInfoSnapshot(), getGitLocalChanges(), getServerInfoSnapshot() (+6 more)

### Community 136 - "low-trust-red-team-routes.test.ts"
Cohesion: 0.14
Nodes (7): createApp(), Db, deleteCompaniesAfterSideEffectsDrain(), deleteDocuments(), deleteHeartbeatRunsAndWakeupsAfterActivityLogDrains(), Fixture, isHeartbeatCleanupFkError()

### Community 137 - "environmentService"
Cohesion: 0.16
Nodes (18): ACTIVE_CUSTOM_IMAGE_SETUP_STATUSES, cloneRecord(), countFromRows(), EnvironmentLeaseRow, EnvironmentListFilters, EnvironmentRow, environmentService(), hasConstraintName() (+10 more)

### Community 138 - "issue-pull-requests.ts"
Cohesion: 0.08
Nodes (42): AUTHORED_LOC_EXCLUSION_RULES, AuthoredLocResult, computeAuthoredLoc(), ExclusionRule, GithubPullFile, isExcludedFromAuthoredLoc(), LOCKFILE_BASENAMES, matchExclusionRule() (+34 more)

### Community 139 - "issues-service.test.ts"
Cohesion: 0.06
Nodes (25): ISSUE_EXECUTION_LOCK_HOLDING_RUN_STATUSES, ISSUE_EXECUTION_LOCK_REAPABLE_NEVER_STARTED_RUN_STATUSES, runOwnsIssueExecutionLock(), runStatusHoldsIssueExecutionLock(), TERMINAL_HEARTBEAT_RUN_STATUS_VALUES, TERMINAL_HEARTBEAT_RUN_STATUSES, extractExecutiveHoldMarker(), findActiveExecutiveHold() (+17 more)

### Community 140 - "heartbeat-wake-dispatch-retry.test.ts"
Cohesion: 0.05
Nodes (39): GITHUB_REVIEW_DELIVERY_COUNT_KEY, JOB_FAILED_HEARTBEAT_RETRY_REASON, AGENT_ERROR_DURATION_SECONDS_METRIC, AGENT_ERROR_REASON_AGENTS_METRIC, AGENT_ERROR_REASON_OLDEST_AGE_METRIC, AGENT_HEARTBEAT_AGE_SECONDS_METRIC, AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC, AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC (+31 more)

### Community 141 - "trust-preset-resolver.ts"
Cohesion: 0.15
Nodes (22): assertLowTrustWorkspaceIsolation(), issueIdIsDescendantOf(), LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS, workspaceIssueWithinLowTrustBoundary(), asRecord(), deny(), hasBoundaryScope(), intersectSets() (+14 more)

### Community 142 - "agent-skills-routes.test.ts"
Cohesion: 0.08
Nodes (17): createApp(), mockAccessService, mockAdapter, mockAgentInstructionsService, mockAgentService, mockApprovalService, mockBudgetService, mockCompanySkillService (+9 more)

### Community 143 - "issues-goal-context-routes.test.ts"
Cohesion: 0.08
Nodes (21): createApp(), legacyProjectLinkedIssue, mockAccessService, mockAgentService, mockDb, mockDocumentsService, mockEnvironmentService, mockExecutionWorkspaceService (+13 more)

### Community 144 - "accessService"
Cohesion: 0.04
Nodes (69): createLiveEventTranscriptGate(), decisionReason(), defaultTranscriptStreamAuditor(), GateOutcome, LIVE_EVENT_TRANSCRIPT_AUDIT_ACTION, LiveEventSubscriberContext, LiveEventTranscriptAuditEntry, MembershipReader (+61 more)

### Community 145 - "services/resource-memberships.ts"
Cohesion: 0.15
Nodes (9): assertBoardSelfMembershipAccess(), BoardActor, evaluatePolicy(), MembershipChangeKind, MembershipUpdateResult, PolicyDecision, ResourceMembershipPolicyHook, assertMutationAllowed() (+1 more)

### Community 146 - "heartbeat-run-runtime-status.ts"
Cohesion: 0.21
Nodes (17): clearAllHeartbeatRunRuntimeStatuses(), cloneStatus(), getHeartbeatRunRuntimeStatus(), HEARTBEAT_RUN_RUNTIME_STATUS_TTL_MS, HeartbeatRunRuntimeStatus, isExpired(), MAX_HEARTBEAT_RUN_RUNTIME_ASSISTANT_SNIPPET_CHARS, MAX_HEARTBEAT_RUN_RUNTIME_STATUS_MESSAGE_CHARS (+9 more)

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
Nodes (84): redactRunError(), activeInboxArchiveFields(), alertmanagerAggregateCreationFingerprint(), appendAcceptanceCriteriaToDescription(), applyStatusSideEffects(), assertTransition(), assertValidAssigneeAgentFilter(), blockedInboxIssueConditions() (+76 more)

### Community 152 - "successful-run-handoff.ts"
Cohesion: 0.06
Nodes (48): agentLinkRow(), AgentRow, buildSuccessfulRunHandoffExhaustedNotice(), buildSuccessfulRunHandoffInstruction(), buildSuccessfulRunHandoffRequiredNotice(), decideSuccessfulRunHandoff(), DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS, FINISH_SUCCESSFUL_RUN_HANDOFF_REASON (+40 more)

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
Cohesion: 0.03
Nodes (69): AgentStartLockAbortedError, AgentStartLockDispatchHealth, AgentStartLockOptions, agentStartLockSweepContext, currentAgentStartLockSignal(), abortedAgentId(), abortReason(), CancellableQuery (+61 more)

### Community 159 - "agentRoutes"
Cohesion: 0.03
Nodes (116): containAgentConfig(), containAgentMetadata(), keepSanitizedAgentMetadata(), redactAgentSecrets(), restoreRedactedAgentRuntimeConfig, parseOffsetParam(), withholdRunEventTranscriptContent(), agentRoutes() (+108 more)

### Community 160 - "pr-comment-review-gate.ts"
Cohesion: 0.03
Nodes (126): classifyPrReviewComment(), isActionablePrReviewComment(), isReviewShapedPrComment(), ActionableFeedbackOptions, ALLY_CONSOLIDATED_REVIEW_HEADING_PATTERN, ALLY_VERDICT_BLOCK_PATTERN, ALLY_VERDICT_OPENER_PATTERN, allyClaimedReviewHead() (+118 more)

### Community 161 - "instanceSettingsService"
Cohesion: 0.06
Nodes (44): boardChatRoutes(), isConciergeReply(), serializeTurn(), stripActionSignals(), applyExperimentalSettingsPatch(), getRuntimeInstanceId(), instanceExperimentalSettingsStorageSchema, instanceGeneralSettingsStorageSchema (+36 more)

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
Nodes (53): activeActorMembership(), allow(), authorizationService(), agentHasMentionGrantOnIssue(), agentHasProductivityReviewGrantOnIssue(), agentWithinLowTrustBoundary(), allowIssueMentionGrant(), allowProductivityReviewGrant() (+45 more)

### Community 166 - "human-gated-ageing-digest.ts"
Cohesion: 0.07
Nodes (43): db, MAX_PRS, token, DEFAULT_MAX_ESCALATED, AGGREGATE_CHUNK_SIZE, buildDigestBody(), chunk(), collectDigest() (+35 more)

### Community 167 - "normalizeHumanRole"
Cohesion: 0.19
Nodes (17): approveHumanJoinRequestFromInvite(), assertInstanceAdmin(), addCompanyMemberRemovalAccess(), assertCanManageCompanyMember(), getProtectedMemberReason(), isLocalImplicit(), loadCompanyAccessSummary(), resolveAcceptedInviteJoinRequest() (+9 more)

### Community 168 - "adapters/index.ts"
Cohesion: 0.08
Nodes (28): detectAdapterModel(), filterAdapterModelsForConfiguredAllowlist(), findActiveServerAdapter(), findServerAdapter(), isOpenCodeAdapterType(), listAdapterModels(), refreshAdapterModels(), registerServerAdapter() (+20 more)

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

### Community 174 - "built-in-agents.test.ts"
Cohesion: 0.11
Nodes (21): assertBuiltInAgentMetadataMutationAllowed(), BUILT_IN_AGENT_METADATA_KEY, BuiltInAgentMarker, builtInAgentMarkersEqual(), isPlainRecord(), normalizeFeatureKeys(), readBuiltInAgentMarker(), withBuiltInAgentMarker() (+13 more)

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
Cohesion: 0.06
Nodes (41): AGENT_AUTHOR_EMAIL_DOMAINS, agentUrlKeyFromAuthorEmail(), CommitAuthorRef, CommitSkipReason, ForeignCommit, ForeignCommitSelection, normalizeEmail(), NotifiableAgentRef (+33 more)

### Community 179 - "FakeRuntime"
Cohesion: 0.11
Nodes (4): FakeRuntime, LogEntry, TestAcpRuntimeOptions, runtime()

### Community 180 - "human-gated-gate-revalidation.ts"
Cohesion: 0.06
Nodes (47): ACTION_OWED_RESOLUTION_KINDS, APPROVAL_ABANDONED, APPROVAL_GRANTED, APPROVAL_REFUSED, APPROVAL_UNDECIDED, ApprovalEvidence, BLOCKER_RESOLVING_STATUSES, BLOCKER_TERMINAL_NON_RESOLVING_STATUSES (+39 more)

### Community 181 - "native-memory-metrics.ts"
Cohesion: 0.07
Nodes (40): DEFAULT_SAMPLE_INTERVAL_MS, EXTERNAL_PEAK_COMPONENT, finite(), HEAP_TOTAL_PEAK_COMPONENT, HEAP_USED_PEAK_COMPONENT, HeapPeakReading, HeapSizeReading, readHeapPeaks() (+32 more)

### Community 182 - "issue-comment-cancel-routes.test.ts"
Cohesion: 0.11
Nodes (13): HeartbeatRunFixture, installActor(), mockAccessService, mockDecisionTrainingService, mockDocumentAnnotationService, mockExternalObjectService, mockFeedbackService, mockHeartbeatService (+5 more)

### Community 183 - "cursor-models.ts"
Cohesion: 0.27
Nodes (12): collectFromJsonValue(), CursorModelsCommandResult, dedupeModels(), fetchCursorModelsFromCli(), isLikelyModelId(), listCursorModels(), mergedWithFallback(), parseCursorModelsOutput() (+4 more)

### Community 184 - "health.ts"
Cohesion: 0.13
Nodes (21): hasDevServerStatusToken(), HEALTH_PROBE_DEADLINE_MS, healthRoutes(), redactedDatabaseBackupHealth(), redactedDatabaseBackupWarning(), shouldExposeFullHealthDetails(), withHealthProbeDeadline(), alertFileCandidates() (+13 more)

### Community 185 - "bootstrap-claim-routes.test.ts"
Cohesion: 0.19
Nodes (14): boardMutationGuard(), DEFAULT_DEV_ORIGINS, isTrustedBoardMutationRequest(), parseOrigin(), SAFE_METHODS, trustedOriginsForRequest(), createApp(), accessServiceMock (+6 more)

### Community 186 - "visibleIssueCondition"
Cohesion: 0.09
Nodes (42): CompanyUserRow, dayKeyExpr(), isoDay(), loadDailyStats(), loadWindowStats(), PROFILE_WINDOWS, resolveCompanyUser(), slugifyUserPart() (+34 more)

### Community 187 - "agent-invokability.ts"
Cohesion: 0.14
Nodes (17): AgentInvokability, AgentInvokabilityBlockReason, AgentOrgRow, AgentStatus, blocked(), CompanyAgentRosterReader, DIRECT_NON_INVOKABLE_STATUSES, evaluateAgentInvokability() (+9 more)

### Community 188 - "pipelineService"
Cohesion: 0.08
Nodes (42): activityActorPatch(), assertReviewTargetsInSet(), defaultRetryCleanup(), descendantCaseIds(), enqueueStageAutomationLedger(), getCaseWithStageForUpdateOrThrow(), getCaseWithStageOrThrow(), getPipelineOrThrow() (+34 more)

### Community 189 - "issue-recovery-actions.ts"
Cohesion: 0.07
Nodes (44): agentHasRecoveryHandoffGrantOnIssue(), DbOrTransaction, isRecord(), IssueRecoveryActionRow, issueRecoveryActionService(), dischargeActionsWithRestoredExecution(), escalateExpiredWakeHorizons(), findSupersededRestoredClaim() (+36 more)

### Community 190 - "github-egress-outbound-coverage.test.ts"
Cohesion: 0.07
Nodes (31): Coverage, dockerfilePath, helpersPath, repoRoot, scannedServerFilesWritingToGitHub(), scannedServerSourceFiles(), SERVER_WRITE_COVERAGE, serverSourceDirectory (+23 more)

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
Cohesion: 0.08
Nodes (36): readGithubPrReviewerAgentIds(), __test_buildPrReviewerTaskLockKeys, IssueAssignmentWakeupDeps, prReviewTargetFromIssue(), queueIssueAssignmentWakeup(), WakeupSource, WakeupTriggerDetail, assertNotDuplicatePrReviewIssue() (+28 more)

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
Cohesion: 0.10
Nodes (23): EMPTY_ROSTER, logGuardDecision(), MetricsIngestOptions, metricsIngestRoutes(), resolveRoster(), readGuardIds(), readString(), cache (+15 more)

### Community 204 - "execution-policy-bootstrap.ts"
Cohesion: 0.24
Nodes (11): parseAdapterRegistryEnv(), ENTRY, KubernetesEnvironmentConfigInput, applyExecutionPolicyBootstrap(), bootstrapExecutionPolicyFromEnv(), ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, parseBool() (+3 more)

### Community 205 - "body"
Cohesion: 0.05
Nodes (18): __test_resolvePostedReviewObservation, APPROVAL_LAST_DECISION_TIMESTAMP_METRIC, APPROVAL_OLDEST_PENDING_AGE_METRIC, APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC, APPROVALS_PENDING_METRIC, CCROTATE_CAPACITY_DEFERRED_METRIC, GITHUB_REVIEW_COMPLETION_METRIC, GITHUB_REVIEW_POSTED_METRIC (+10 more)

### Community 206 - "gbrain-client-factory.ts"
Cohesion: 0.15
Nodes (12): AuthbotCredentialEnvelope, AuthbotCredentialResponse, ClientsFile, HttpServerGbrainClient, JsonRpcResponse, OAuthMintBearerOpts, parseGbrainErrorPayload(), parseMcpResponseBody() (+4 more)

### Community 207 - "issueReferenceService"
Cohesion: 0.13
Nodes (21): diffIssueSummaries(), emptySummary(), issuePath(), issueReferenceService(), issueById(), listIssueReferenceSummary(), replaceSourceMentions(), syncAllForCompany() (+13 more)

### Community 208 - "agent-inbox-lite.ts"
Cohesion: 0.05
Nodes (48): ISSUE_LIST_APPLIED_LIMIT_HEADER, ISSUE_LIST_TRUNCATED_HEADER, issueListProbeLimit(), parseUnsupportedPaginationParams(), parseUnsupportedTimeFilterParams(), resolveIssueListTruncation(), TIME_FILTER_PARAM_PATTERN, AGENT_INBOX_LITE_STATUS_FILTER (+40 more)

### Community 209 - "responsible-user-denial-run-outcomes.ts"
Cohesion: 0.53
Nodes (3): normalizeResponsibleUserDenialCode(), recordResponsibleUserDenialOnActiveRun(), publishLiveEventMock

### Community 210 - "pluginLoader"
Cohesion: 0.08
Nodes (19): isIsolatedSdkPluginPackage(), getDeclaredPageRoutePaths(), getMinimumHostVersion(), isPluginPackageName(), pluginLoader, assertPageRoutePathsAvailable(), buildDiscoveredPlugin(), fetchAndValidate() (+11 more)

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
Cohesion: 0.22
Nodes (11): DevServerHealthStatus, DevServerRestartRequest, getDevServerRestartRequestFilePath(), normalizeStringArray(), normalizeTimestamp(), PersistedDevServerStatus, readPersistedDevServerStatus(), toDevServerHealthStatus() (+3 more)

### Community 217 - "openapi-routes.test.ts"
Cohesion: 0.15
Nodes (19): buildOpenApiSpec, openApiRoutes(), apiPrefixes, CONDITIONAL_INSTANCE_ADMIN_OPERATIONS, createApp(), __dirname, explicitOpenApiCoverageExclusions, HTTP_METHODS (+11 more)

### Community 218 - "heartbeat-dependency-scheduling.test.ts"
Cohesion: 0.20
Nodes (7): DEP_BLOCKED_MAX_RETRY_ATTEMPTS, DEP_BLOCKED_RETRY_REASON, composeSweepWakeFramePage(), quoteYamlScalar(), renderYamlArray(), mockAdapterExecute, mockGbrainCall

### Community 219 - "execution-allowlist.ts"
Cohesion: 0.23
Nodes (11): evaluateExecutionAllowlist(), ExecutionAllowlistDecision, ExecutionEnvironmentCandidate, ExecutionPolicy, isExecutionForcedToKubernetes(), isKubernetesSandboxEnvironment(), KUBERNETES_PROVIDER_KEY, fakeSandboxEnv (+3 more)

### Community 220 - "pluginManagedRoutineService"
Cohesion: 0.22
Nodes (22): buildRoutineDefaults(), managedByPlugin(), normalizeRef(), pluginManagedRoutineService(), createManagedRoutine(), declarationFor(), ensureDefaultTriggers(), get() (+14 more)

### Community 221 - "plan-review-context.ts"
Cohesion: 0.28
Nodes (9): authorFrom(), buildPlanReviewContext(), BuildPlanReviewContextInput, getPlanInteractionContext(), nonEmptyString(), PLAN_REVIEW_CONTEXT_LIMITS, readPlanTarget(), readResult() (+1 more)

### Community 222 - "project-checkout-origin-reconciler.ts"
Cohesion: 0.07
Nodes (25): PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC, PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC, ProjectCheckoutOriginMismatchEntry, setProjectCheckoutOriginMismatchMetrics(), setProjectCheckoutOriginReconcileMetricsRefreshSuccess(), directoryExists(), mapWithConcurrency() (+17 more)

### Community 223 - "oidc-rbac.ts"
Cohesion: 0.18
Nodes (13): DexRbacConfig, GroupClaimRbacConfig, normalizeGroup(), reconcileDexUser(), reconcileGroupClaimUser(), ReconcileResult, APPROVAL_SUBJECT_KEYS, ApprovalInsertValues (+5 more)

### Community 224 - "isolation-workspace-reaper.test.ts"
Cohesion: 0.08
Nodes (32): createDbWorkspaceUsageLookup(), DEFAULT_ISOLATION_WORKSPACE_ROOT, DEFAULT_MAX_DELETES_PER_TICK, defaultScheduler, hasNestedCheckout(), IsolationWorkspaceReaperScheduler, IsolationWorkspaceReapOptions, IsolationWorkspaceReapResult (+24 more)

### Community 225 - "invite-defaults-response-boundary.test.ts"
Cohesion: 0.10
Nodes (19): buildInviteOnboardingManifest(), buildInviteOnboardingTextDocument(), buildOnboardingConnectionCandidates(), buildOnboardingDiscoveryDiagnostics(), extractInviteHumanRole(), extractInviteMessage(), inviteExpired(), inviteState() (+11 more)

### Community 226 - "recovery-stranded-attendance-batch.test.ts"
Cohesion: 0.08
Nodes (30): AcPolicyCandidateClassification, AcPolicyIssueRef, AcPolicyStaleCandidate, classifyAcPolicyStaleCandidate(), formatAcPolicyStaleDashboardSections(), formatHumanClock(), formatIssueRef(), partitionAcPolicyStaleCandidates() (+22 more)

### Community 227 - "environment-custom-image-terminal-sessions.ts"
Cohesion: 0.13
Nodes (17): readFutureDate(), readNullableDate(), requireFutureCustomImageSetupExpiry(), EnvironmentCustomImageTerminalConnectionClose, EnvironmentCustomImageTerminalPayloadValidationFailureCode, environmentCustomImageTerminalSessionStore, hashTerminalSessionToken(), minDate() (+9 more)

### Community 228 - "feedback-redaction.ts"
Cohesion: 0.19
Nodes (23): appendNote(), buildClaudeTraceFiles(), buildCodexTraceFiles(), buildExportId(), buildFeedbackTraceBundleFromRow(), buildOpenCodeTraceFiles(), findMatchingFile(), search() (+15 more)

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
Nodes (36): WORKSPACE_PREFLIGHT_BLOCKED_ACTIVITY_ACTION, WORKSPACE_PREFLIGHT_CLEARED_ACTIVITY_ACTION, createIssueDependencyReadiness(), hasValidBlockerMonitor(), listBlockedIssueAutoResumeSuppressions(), listCurrentBlockerIssueIdsFor(), listIssueDependencyReadinessMap(), listPendingFinalizeBlockerIssueIds() (+28 more)

### Community 242 - "buildOpenApiDocument"
Cohesion: 0.20
Nodes (8): buildOpenApiDocument(), isZodSchema(), jsonBody(), normalizeContent(), normalizeResponses(), OpenAPIRegistry, paramsSchemaFromPath(), registerCurrentRoute()

### Community 243 - "routes/projects.ts"
Cohesion: 0.05
Nodes (88): appendWithCap, redactCurrentUserValue(), maskWorkspaceRuntimeTextForRead(), withholdWorkspaceOperationCapturedOutput(), executionWorkspaceRoutes(), assertRuntimeManageAllowed(), handleExecutionWorkspaceRuntimeCommand(), compactIssueExecutionWorkspace() (+80 more)

### Community 244 - "runtime-api.ts"
Cohesion: 0.56
Nodes (9): buildRuntimeApiCandidateUrls(), choosePrimaryRuntimeApiUrl(), collectReachableInterfaceHosts(), formatOrigin(), isLinkLocalHost(), isLoopbackHost(), isWildcardHost(), normalizeHost() (+1 more)

### Community 245 - "linear-webhook-fixtures.ts"
Cohesion: 0.29
Nodes (7): main(), readStdin(), LinearWebhookFixture, loadLinearWebhookFixtures(), sanitizeLinearWebhookFixture(), sanitizeLinearWebhookValue(), SECRET_HEADER_NAMES

### Community 246 - "routineService"
Cohesion: 0.08
Nodes (37): postRoutineDispatchFailureHeartbeat(), incrementRoutineDispatchMetric(), mapRoutineDescriptionDocument(), mapRoutineRevision(), nextResultText(), normalizeWebhookTimestampMs(), routineService(), appendRoutineRevision() (+29 more)

### Community 247 - "renderMetrics"
Cohesion: 0.03
Nodes (58): BlockerResolvedWakeMetricKey, counters, getBlockerResolvedWakeMetric(), resetBlockerResolvedWakeMetrics(), snapshotBlockerResolvedWakeMetrics(), AGENT_START_LOCK_REAP_DISPOSITION_METRIC, CRASH_RECOVERY_CANDIDATE_INDEX_NAME, CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC (+50 more)

### Community 248 - "codex-auth-reconciliation.ts"
Cohesion: 0.31
Nodes (8): ApiKeyBinding, asRecord(), classifyApiKeyBinding(), CodexAuthReconciliationSummary, readPlainEnvValue(), reconcileCodexLocalManagedHomesOnStartup(), AgentRow, managedAgentHome()

### Community 249 - "deriveSkillExportDirCandidates"
Cohesion: 0.29
Nodes (11): appendSkillExportDirSuffix(), buildSkillExportDirMap(), deriveLocalExportNamespace(), derivePrimarySkillExportDir(), deriveSkillExportDirCandidates(), hashSkillValue(), normalizeExportPathSegment(), normalizeSkillKey() (+3 more)

### Community 250 - "recovery-expired-wake-horizon.test.ts"
Cohesion: 0.07
Nodes (13): ACTIVE_RECOVERY_ACTION_STATUSES, BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES, PENDING_RECOVERY_WAKE_CEILING_TIMEOUT_MULTIPLIER, RECOVERY_HORIZON_EXPIRED_METRIC, Db, truncateCompanyScopedTestState(), TruncateCompanyScopedTestStateOptions, enqueueWakeup() (+5 more)

### Community 251 - "pr-reconciler-sweep.ts"
Cohesion: 0.29
Nodes (9): computeReconcilerWindow(), ReconcileFn, ReconcileResult, reconcilerSweepTick(), ReconcilerTarget, runReconcilerSweep(), selectReconcilerTargets(), SweepResult (+1 more)

### Community 252 - "workspace-operations.ts"
Cohesion: 0.07
Nodes (18): createLocalFileWorkspaceOperationLogStore(), ensureDir(), readFileRange(), getWorkspaceOperationLogStore(), resolveWithin(), WorkspaceOperationLogFinalizeSummary, WorkspaceOperationLogHandle, WorkspaceOperationLogReadOptions (+10 more)

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
Cohesion: 0.12
Nodes (38): asBoolean(), asString(), buildManifestFromPackageFiles(), buildYamlFile(), clonePortableRecord(), collectSelectedExportSlugs(), dedupeEnvInputs(), deriveManifestSkillKey() (+30 more)

### Community 258 - "middleware/index.ts"
Cohesion: 0.04
Nodes (38): createApp(), mockBumpAgentImagesForCompany, createApp(), mockFolderService, mockLogActivity, createApp(), mockEnvironmentService, mockHeartbeatService (+30 more)

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
Nodes (22): buildEnvInputMap(), buildMarkdown(), buildOrgTreeFromManifest(), buildReferencedSkillMarkdown(), buildSkillSourceEntry(), classifyPortableFileKind(), collectRedactedPaths(), exportBundle() (+14 more)

### Community 264 - "plugin-secrets-handler.ts"
Cohesion: 0.11
Nodes (27): versionMaterialHasValueDigest(), assertSecretRefBinding(), coerceLegacySecretRef(), countUuidValues(), createPluginSecretsHandler(), authorizeBoundSecret(), lookupBinding(), resolveBoundSecret() (+19 more)

### Community 265 - "workspace-response-withholding-guard.test.ts"
Cohesion: 0.08
Nodes (33): classifyProjectValue(), collectProjectRowLocals(), collectWorkspaceBearingLocals(), collectWorkspaceServiceReceivers(), COVERED_ROUTE_MODULES, elideMaskedCalls(), ENV_BOUNDARY_PINS, ENV_LOCAL_WITHHOLDING_HELPERS (+25 more)

### Community 266 - "workspace-reuse-refusal-class.ts"
Cohesion: 0.11
Nodes (23): setWorkspaceReuseRefusalMetricsRefreshSuccess(), setWorkspaceReuseRefusalWindowMetrics(), WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, compareProjectCheckoutOrigin(), normalizeRepoIdentity(), ProjectCheckoutOriginVerdict, classifyWorkspaceReuseRefusal() (+15 more)

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
Cohesion: 0.09
Nodes (27): assertInstanceAdmin(), assertCloudTenantCaller(), cleanupTerminalImportJobs(), cloudTenantRequestKey(), CompanyImportResult, companyRoutes(), assertImportTargetAccess(), parseDateQuery() (+19 more)

### Community 272 - "issue-comment-effects.ts"
Cohesion: 0.12
Nodes (29): claimEffect(), COMMENT_EFFECT_KINDS, CommentEffectIntent, CommentEffectKind, CommentEffectRow, completeEffect(), DEFAULT_CLAIM_LEASE_MS, EFFECT_EXHAUSTED_RETRY_DELAY_MS (+21 more)

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
Nodes (29): isPlanningOnlyRecoveryContextSnapshot(), isStatusOnlyRecoveryContextSnapshot(), PLANNING_ONLY_RECOVERY_GUARD_CONTEXT, readRecoveryRunWriteClass(), RECOVERY_GUARD_CONTEXT_KEYS, RECOVERY_MODEL_PROFILE_HINT_KEYS, RECOVERY_MODEL_PROFILE_KEY, RECOVERY_WORK_CLASS_KEY (+21 more)

### Community 277 - "accessRoutes"
Cohesion: 0.08
Nodes (25): tooManyRequests(), accessRoutes(), getInviteCompanyBranding(), getInviteLogoAsset(), actorHasActiveUserMembership(), buildCliAuthApprovalPath(), claudeHomeDisplayLabel(), createClaimSecret() (+17 more)

### Community 278 - "issue-repo-binding-guard.ts"
Cohesion: 0.14
Nodes (14): BOUND_SOURCE_LABEL, BoundRepo, codeSpan(), CompanyWorkspaceRow, evaluateIssueRepoBinding(), EvaluateIssueRepoBindingInput, formatIssueRepoBindingComment(), issueRepoBindingCommentIdempotencyKey() (+6 more)

### Community 279 - "terminal-gate-reconciler.ts"
Cohesion: 0.11
Nodes (26): PullRequestGateResult, buildTerminalGateResolvedComment(), CandidateRow, defaultScheduler, gateSignalDigestSql, listCandidateIssues(), listExistingResolutionKeys(), listResolvedTerminalGates() (+18 more)

### Community 280 - "agent-auth-jwt.ts"
Cohesion: 0.16
Nodes (17): base64UrlDecode(), base64UrlEncode(), createLocalAgentJwt(), defaultRunJwtTtlSeconds(), deriveCompanySigningKey(), jwtConfig(), JwtHeader, LocalAgentJwtClaims (+9 more)

### Community 281 - "workspace-scan.ts"
Cohesion: 0.36
Nodes (9): CONFIG_FILE_LANGUAGES, detectProjectName(), execFileAsync, fileExists(), getGitDefaultBranch(), getGitRemoteUrl(), readReadmeExcerpt(), WorkspaceScanResult (+1 more)

### Community 282 - "backfill-agent-bundle.ts"
Cohesion: 0.11
Nodes (18): Agent, api(), backfillAgentBundles(), backfillOne(), BackfillResult, main(), readWakePreflight(), sleep() (+10 more)

### Community 283 - "agent-run-health.ts"
Cohesion: 0.24
Nodes (7): AgentRunHealthInput, AgentRunHealthOptions, AgentRunHealthResult, AgentRunHealthSignal, evaluateAgentRunHealth(), WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit., NOW

### Community 284 - "managed-checkout-push-guard.ts"
Cohesion: 0.11
Nodes (29): defaultRunGit(), ensureExcluded(), ensureManagedCheckoutRejectsPushes(), execFile, isInside(), isTracked(), ManagedCheckoutPushGuardResult, ManagedCheckoutPushGuardState (+21 more)

### Community 285 - "execution-policy-bootstrap.test.ts"
Cohesion: 0.25
Nodes (7): bootstrap, ensureKubernetesEnvironment, ExecutionPolicyBootstrap, ExecutionPolicyBootstrapEnv, fakeDb, listCompanyIds, updateGeneral

### Community 286 - "transitionCaseInTransaction"
Cohesion: 0.12
Nodes (31): adjustParentCounts(), assertActorCanApproveStageExit(), assertJsonSize(), assertLatestReviewApprovalStillCurrent(), assertNoOpenBlockers(), assertStageEnabled(), assertStageTransitionGates(), childrenGateConfig() (+23 more)

### Community 287 - "createPluginWorkerHandle"
Cohesion: 0.15
Nodes (31): createPluginWorkerHandle(), attachStdioHandlers(), callInternal(), cancelPendingRestart(), clearInvocation(), computeBackoffMs(), contextForWorkerMessage(), deriveCallInvocationScope() (+23 more)

### Community 288 - "companyPortabilityService"
Cohesion: 0.11
Nodes (27): applySelectedFilesToSource(), collectAgentSafeImportPolicyErrors(), companyPortabilityService(), applyImportedAgentPermissionGrants(), assertImportAdapterConfigConstraints(), assertKnownImportAdapterType(), buildPreview(), importBundle() (+19 more)

### Community 289 - "pr-review-state-reconciler.ts"
Cohesion: 0.11
Nodes (29): DEFAULT_MAX_GATE_REDRIVES_PER_REPO, EMPTY_RESULT, emptyGateRedriveResult(), GateRedriveCandidate, GateRedriveResult, gateStatusIsStale(), isPlainResultObject(), latestReviewerReviewAt() (+21 more)

### Community 290 - "environmentRoutes"
Cohesion: 0.10
Nodes (22): assertBoardOrgAccess(), hasBoardOrgAccess(), environmentRoutes(), assertCanAccessInstanceEnvironments(), assertCanReadInstanceEnvironments(), assertCanReadSecretsForDraftProbe(), assertCustomImageCompanyAccess(), canReadFullInstanceEnvironment() (+14 more)

### Community 291 - "heartbeat-timer-suppression-park-bypass.test.ts"
Cohesion: 0.08
Nodes (6): HeartbeatServiceOptions, PenstockAvailabilityGate, PenstockAvailabilityGateCheckInput, PenstockAvailabilityGateResult, __resetQuotaExhaustedHookStateForTesting(), mockAdapterExecute

### Community 292 - "summarySlotService"
Cohesion: 0.14
Nodes (29): mapDocument(), mapRevision(), mapSlot(), ResolvedSelector, scopeLabel(), SUMMARIZER_BUILT_IN_KEY, SummaryGenerateActor, SummarySlotRow (+21 more)

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

### Community 298 - "redactSensitiveText"
Cohesion: 0.12
Nodes (23): maybeContainsSecretText(), redactSensitiveText(), compactRunLogChunk(), MAX_PERSISTED_LOG_CHUNK_CHARS, redactInlineBase64ImageData(), sanitizeRunLogChunkForStorage(), ALWAYS_REDACT_MIN_LENGTH, AMBIGUOUS_BAND_MIN_LENGTH (+15 more)

### Community 299 - "node:http"
Cohesion: 0.12
Nodes (11): createApp(), mockAccessService, mockActivityService, mockHeartbeatService, mockIssueService, baseGoal, createApp(), loadRouteModules() (+3 more)

### Community 300 - "instrumentation.ts"
Cohesion: 0.16
Nodes (7): bootstrapOtel(), ExporterProtocol, importExporter(), instrumentationReady, resolveProtocol(), shutdownInstrumentation(), importFreshInstrumentation()

### Community 301 - "http-log-policy.ts"
Cohesion: 0.14
Nodes (20): buildHttpLogProps(), createHttpLogger(), hasEntries(), LoggedRequest, LoggedResponse, normalizePath(), shouldOmitRequestBodyFromLog(), shouldSilenceHttpSuccessLog() (+12 more)

### Community 302 - "agent-redaction.ts"
Cohesion: 0.14
Nodes (21): asRecord(), containsRedactedAdapterValue(), isRedactedEnvBinding(), OMIT_REDACTED_ADAPTER_VALUE, REDACTED_ENV_SENTINEL, restoreRedactedAdapterValue(), restoreRedactedAdapterValueInner(), restoreRedactedAgentMetadata() (+13 more)

### Community 303 - "issue-blocker-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 304 - "managed-checkout-partial-clone.ts"
Cohesion: 0.12
Nodes (25): countMissingObjects(), defaultRunGit(), describePartialCloneConfig(), ensureManagedCheckoutCanServeClones(), execFile, ManagedCheckoutPartialCloneResult, ManagedCheckoutPartialCloneState, MissingObjectCounter (+17 more)

### Community 305 - "ccrotate-capacity-retry.ts"
Cohesion: 0.05
Nodes (54): applyCcrotateCapacityDecision(), CAPACITY_ESCALATION_AFTER_MS, CAPACITY_ESCALATION_HEADROOM_RATIO, CapacityEscalationPlan, CCROTATE_CAPACITY_DECISION_KEYS, CCROTATE_CAPACITY_FIRST_DEFERRED_AT_KEY, CCROTATE_CAPACITY_MAX_PARK_MS, CCROTATE_CAPACITY_MIN_PARK_MS (+46 more)

### Community 306 - "zoned-cron.ts"
Cohesion: 0.11
Nodes (26): assertTimeZone(), isSubHourlyCronExpression(), nextCronTickInTimeZone(), resetRoutineFireGapsMemoForTests(), sampleRoutineFireGapsMs(), buildCronMask(), CronMask, daysInMonth() (+18 more)

### Community 307 - "issue-subtree-diagnostics-routes.test.ts"
Cohesion: 0.13
Nodes (6): AgentRow, CompanyRow, createApp(), Db, IssueRow, ProjectRow

### Community 308 - "issue-wake-diagnostics-routes.test.ts"
Cohesion: 0.09
Nodes (18): ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS, DeferredWakeReopenEligibility, LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR, LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR, locklessDeferredWakeTerminalError(), readNonEmptyString(), WAKE_COMMENT_IDS_KEY, AgentRow (+10 more)

### Community 309 - "builtInAgentService"
Cohesion: 0.19
Nodes (28): builtInAgentService(), bundleResourceStates(), createOrResetRoutine(), currentInstructionFiles(), ensureBuiltInAgentAssignable(), getCurrentSkillFiles(), getManagedResourceBinding(), getRoutineByBinding() (+20 more)

### Community 310 - "invite-rate-limit.ts"
Cohesion: 0.21
Nodes (6): createInviteRateLimiter(), INVITE_RATE_LIMIT_MAX_REQUESTS, INVITE_RATE_LIMIT_WINDOW_MS, InviteRateLimiter, InviteRateLimitResult, createApp()

### Community 311 - "issue-denied-write-recovery-persistence.test.ts"
Cohesion: 0.33
Nodes (3): captureDeniedWriteEvents(), createApp(), deniedWriteRows()

### Community 312 - "plugin-orchestration-apis.test.ts"
Cohesion: 0.08
Nodes (16): setPluginEventBus(), createPluginEventBus(), emit(), matchesPattern(), passesFilter(), PluginEventBus, PluginEventBusEmitResult, ScopedPluginEventBus (+8 more)

### Community 313 - "process-loss-classification.ts"
Cohesion: 0.39
Nodes (6): buildProcessLossCapture(), classifyProcessLoss(), ProcessLossCapture, ProcessLossClassification, ProcessLossJobLiveness, ProcessLossSignals

### Community 314 - "plugin-store-consistency.test.ts"
Cohesion: 0.13
Nodes (7): ISOLATED_SDK_PLUGIN_PACKAGES, isolatedPluginsRoot(), resolveDefaultInstallDir(), sanitizePackageNameForPath(), SDK_NOT_INSTALLED_ERROR_MARKER, SDK_STORE_CONSISTENCY_MIN_STABLE_MISMATCH_MS, SDK_STORE_CONSISTENCY_RECHECK_DELAYS_MS

### Community 315 - "ensure"
Cohesion: 0.17
Nodes (27): assertAdapterAllowed(), assertKnownBuiltInAgentModel(), autoProvisionBundledAgents(), defaultProvisionInput(), ensure(), ensureAgentDefaultGrants(), ensureBuiltInAgentDefaultGrants(), ensureCompany() (+19 more)

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

### Community 320 - "asNumber"
Cohesion: 0.12
Nodes (25): asBoolean, asNumber, countRunsOccupyingSlots(), EXTERNAL_LIFECYCLE_ADAPTERS, hasExternalLifecycleAdapter(), isRunOccupyingSlot(), normalizeMaxConcurrentRuns(), resolveAgentConcurrencyPolicy() (+17 more)

### Community 321 - "adapters/types.ts"
Cohesion: 0.18
Nodes (8): ClaudeExecute, stampClaudeAgentIdHeader(), ExecuteCtx, execute(), httpAdapter, normalizeMethod(), summarizeStatus(), testEnvironment()

### Community 322 - "agent-shell-guard.ts"
Cohesion: 0.06
Nodes (53): AgentShellCommandDecision, classifyAgentShellCommand(), CMD_END_RE, CMD_START_RE, COMMAND_BUILTIN_LAUNCHER_RE, COMMAND_POSITION_RE, ENV_BULK_ACCESS_RE, ENV_LAUNCHER_ARGUMENT_RE (+45 more)

### Community 323 - "attachment-types.ts"
Cohesion: 0.10
Nodes (19): allowedPatterns, DEFAULT_ALLOWED_TYPES, DEFAULT_ATTACHMENT_CONTENT_TYPE, INLINE_ATTACHMENT_TYPES, isAllowedContentType(), isInlineAttachmentContentType(), matchesContentType(), MAX_ATTACHMENT_BYTES (+11 more)

### Community 324 - "services/index.ts"
Cohesion: 0.03
Nodes (73): logBuiltInAgentMutation(), logCaseAnnotationRemaps(), writePolicy(), auditAgentIssueCreateAttributionSpoof(), ACTIVITY_ACTION_TO_PLUGIN_EVENT, ActivityPublish, eventTypeForActivityAction(), logActivity() (+65 more)

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
Nodes (33): choosePrimaryTrigger(), classifyNoExecutableTurnRun(), coerceDate(), deliberatePendingMonitor(), dominantErrorCode(), isDominantEpisodeShare(), isMonitorSuppressionActor(), isNeverExecutedRun() (+25 more)

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
Cohesion: 0.08
Nodes (7): CapabilityCheckResult, FEATURE_CAPABILITIES, LAUNCHER_PLACEMENT_CAPABILITIES, OPERATION_CAPABILITIES, pluginCapabilityValidator, UI_SLOT_CAPABILITIES, baseManifest

### Community 334 - "pen3142-live-event-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (9): connectSubscriber(), connectWithKey(), FakeClientSocket, FakeUpgradeSocket, keyDb(), mockDecide, mockLogActivity, mockPublishAudit (+1 more)

### Community 335 - "input"
Cohesion: 0.13
Nodes (12): locatePodLogArtifact(), OrphanedRunTerminalResult, readOptionalString(), readOrphanedRunTerminalResult(), resultEventReportsSuccess(), runLogBasePath(), input(), createSecret() (+4 more)

### Community 336 - "setupEnvironmentCustomImageTerminalWebSocketServer"
Cohesion: 0.11
Nodes (14): clientSafeErrorMessage(), closeClient(), createSsh2EnvironmentCustomImageSshConnector(), EnvironmentCustomImageSshConnector, errorStatus(), handleClientFrame(), parseTerminalDimension(), parseTerminalPath() (+6 more)

### Community 337 - "setup-supertest.ts"
Cohesion: 0.29
Nodes (5): require, SupertestServer, SupertestTest, SupertestTestConstructor, SupertestTestInstance

### Community 338 - "teams-catalog-routes.test.ts"
Cohesion: 0.25
Nodes (5): createApp(), mockAccessService, mockAgentService, mockCatalogModule, mockTeamsCatalogService

### Community 339 - "strand-comment-provider-capacity.test.ts"
Cohesion: 0.10
Nodes (18): createPassTimer(), record(), summary(), time(), PassTimer, PassTimingSummary, percentile(), PhaseStat (+10 more)

### Community 340 - "scrape-metrics-collector.ts"
Cohesion: 0.05
Nodes (48): BOARD_DECISION_STATUSES, refreshApprovalQueueMetrics(), EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS, refreshExternalRuntimeReservationStrandMetrics(), TERMINAL_RUN_STATUSES, DEP_BLOCKED_MAX_DELAY_MS, MAX_TURN_CONTINUATION_MAX_DELAY_MS, DB_POOL_CONNECTIONS_METRIC (+40 more)

### Community 341 - "agent-secret-bindings.ts"
Cohesion: 0.62
Nodes (6): AgentSecretBindingSyncService, asRecord(), collectSecretRefs(), collectUserSecretRefs(), secretBindingSignaturesByPath(), syncAgentAdapterEnvBindings()

### Community 342 - "readPortableCatalogProvenance"
Cohesion: 0.48
Nodes (6): asCatalogString(), isCatalogRecord(), PORTABLE_CATALOG_PROVENANCE_STRING_KEYS, readCatalogStringList(), readPortableCatalogProvenance(), buildPortableCatalogProvenance()

### Community 343 - "gbrain-client-factory.test.ts"
Cohesion: 0.15
Nodes (8): authbotCredentialValue(), BearerSource, NullBearer, OAuthMintBearer, resolveBearerSource(), StaticBearer, clientWithFetch(), FAKE_CLIENTS_JSON

### Community 344 - "zoned-cron-equivalence.test.ts"
Cohesion: 0.12
Nodes (21): ZONED_CRON_SEARCH_MAX_AFTER_MS, assertTimeZone(), floorToMinute(), getZonedMinuteFormatter(), getZonedMinuteParts(), matchesCronMinute(), nextCronTickInTimeZone(), WEEKDAY_INDEX (+13 more)

### Community 345 - "pen3142-run-transcript-scope.test.ts"
Cohesion: 0.09
Nodes (17): boardActor, createApp(), createAppWithDb(), createWorkspaceApp(), mockAgentService, mockDecide, mockExecutionWorkspaceService, mockHeartbeatService (+9 more)

### Community 346 - "routines-service.test.ts"
Cohesion: 0.05
Nodes (41): resolveDefaultSecretsKeyFilePath(), AwsSecretsManagerMaterial, awsSecretsManagerProvider, gcpSecretManagerProvider, unavailableProvider(), externalFingerprint(), prepareExternalReference(), vaultProvider (+33 more)

### Community 347 - "successful-run-handoff-state.ts"
Cohesion: 0.18
Nodes (11): listSuccessfulRunHandoffStates(), successfulRunHandoffStateFromActivity(), hydrateSuccessfulRunHandoffLiveness(), resolveSuccessfulRunHandoffForTerminalIssues(), SUCCESSFUL_RUN_HANDOFF_LIVE_RUN_STATUSES, SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES, SUCCESSFUL_RUN_HANDOFF_TERMINAL_ISSUE_STATUSES, SUCCESSFUL_RUN_HANDOFF_UNSTARTED_RUN_LIVENESS_MS (+3 more)

### Community 348 - "project-env-response-boundary.test.ts"
Cohesion: 0.13
Nodes (17): ENV_VALUE_MASK, maskBinding(), maskEnvBindings(), plainValueOf(), restoreMaskedEnvBindings(), PROJECT_ENV_VALUE_MASK, derivedStageAutomationPayload(), createApp() (+9 more)

### Community 349 - "REDACTED_EVENT_VALUE"
Cohesion: 0.13
Nodes (17): REDACTED_EVENT_VALUE, withPublicIssueWorkspaceSettings(), publicIssueExecutionWorkspaceSettings(), publicPipelineStageConfig(), WITHHELD_WORKSPACE_RUNTIME_VIEWER, hireMetadataFixture(), hireRuntimeConfigFixture(), issuePrefix() (+9 more)

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
Cohesion: 0.18
Nodes (19): buildCaseContextMarkdown(), contentPath(), contextFetchHint(), DELIVERABLE_TITLE_PATTERNS, deliverableDocumentRank(), downloadPath(), formatPipelineCaseOutputContextMarkdown(), normalizePreviewText() (+11 more)

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
Cohesion: 0.36
Nodes (6): blockedBlocker(), blocks, deadEnd(), issue(), manager, monitorOnlyIssue()

### Community 359 - "approval-create-issue-link-authorization.test.ts"
Cohesion: 0.11
Nodes (10): createApp(), createRouteDb(), mockAccessService, mockApprovalService, mockHeartbeatService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 360 - "pull-request-work-products.ts"
Cohesion: 0.14
Nodes (17): buildPullRequestWorkProductFields(), OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES, PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST, PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID, pullRequestExternalId(), pullRequestMergeQueueState, PullRequestWorkProductFields (+9 more)

### Community 361 - "linear-webhook.test.ts"
Cohesion: 0.40
Nodes (4): createWebhookApp(), parseWebhookPatch(), PRIORITY_MAP, STATUS_MAP

### Community 362 - "scheduler-lease.ts"
Cohesion: 0.18
Nodes (13): recordSchedulerLeaseState(), acquireSchedulerLease(), firstRow(), HEARTBEAT_TIMER_LEASE, LeaseDb, releaseSchedulerLease(), SCHEDULER_LEASE_RENEW_INTERVAL_MS, SCHEDULER_LEASE_TTL_MS (+5 more)

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
Cohesion: 0.17
Nodes (14): readExternalLifecycleProviderCapacityRefusal(), findTerminalResultEventInRunLogTail(), parseJsonObject(), parseTimestampMs(), readRunLogTerminalTail(), RUN_LOG_TERMINAL_MAX_SCAN_BYTES, RUN_LOG_TERMINAL_TAIL_BYTES, RunLogRangeReader (+6 more)

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
Cohesion: 0.17
Nodes (11): ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC, ROUTINE_FIRE_INTERVAL_METRIC, ROUTINE_LAST_DONE_FIRE_AGE_METRIC, setRoutineFireGapMetrics(), setRoutineFireGapMetricsRefreshSuccess(), refreshRoutineFireGapMetrics(), selectScheduledRoutinesWithLastCompletedFire(), deriveRoutineFireGapsMs() (+3 more)

### Community 375 - "routine-scheduler-heartbeat.ts"
Cohesion: 0.20
Nodes (14): AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN, buildSchedulerFailureHeartbeatKey(), parseAgentHealthReceiptWindowKey(), describeSearchedWindow(), dispositionClause(), issueUiLink(), isWithinWindow(), postRoutineSchedulerFailureHeartbeat() (+6 more)

### Community 376 - "issue-checkout-status.ts"
Cohesion: 0.15
Nodes (14): WakeupOptions, checkoutRestoreStatusExpression, checkoutRestoreTargetStatus, DbOrTransaction, hasCancelledBlocker, hasPendingBlocker, holdsDispatchableMonitor, IssueLockOwnerState (+6 more)

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

### Community 384 - "plugin-fencing.ts"
Cohesion: 0.20
Nodes (9): assertIdentifier(), assertPluginFencingGeneration(), FENCING_GENERATION_LOST_CODE, PluginFencingPreconditionInput, quoteIdentifier(), ResolvedPluginFencingPrecondition, resolvePluginFencingPrecondition(), mutation() (+1 more)

### Community 385 - "agent-hire-source-issue-authorization.test.ts"
Cohesion: 0.15
Nodes (10): createApp(), createDb(), mockAccessService, mockAgentService, mockApprovalService, mockIssueApprovalService, mockIssueService, mockLogActivity (+2 more)

### Community 386 - "approval-revision-exit.test.ts"
Cohesion: 0.15
Nodes (10): BOARD_NOTE, get(), mockAgentService, mockApprovalService, mockListIssuesForApproval, mockLogActivity, mockWakeup, racingUpdates() (+2 more)

### Community 387 - "cloud-upstreams.test.ts"
Cohesion: 0.15
Nodes (8): cloudUpstreamRunStatus(), updateRun(), updateRunIfRunning(), cloudUpstreamStep(), reconcileCloudUpstreamRunsOnStartup(), runFromRow(), safeRunEvents(), sealCloudUpstreamCredential()

### Community 388 - "company-search-rate-limit.ts"
Cohesion: 0.21
Nodes (8): COMPANY_SEARCH_RATE_LIMIT_MAX_REQUESTS, COMPANY_SEARCH_RATE_LIMIT_WINDOW_MS, CompanySearchRateLimitActor, CompanySearchRateLimiter, CompanySearchRateLimitResult, createCompanySearchRateLimiter(), createApp(), unusedSearch()

### Community 389 - "readNonEmptyString"
Cohesion: 0.27
Nodes (13): asRecord(), buildCapacityUrl(), buildMessagesUrl(), isPenstockBaseUrl(), isPenstockCapacityBody(), mapAdapterToPenstockProvider(), readCapacityReason(), readCapacityState() (+5 more)

### Community 390 - "readPenstockCapacity"
Cohesion: 0.26
Nodes (11): capacityEndpointUnavailable(), defaultCapacityRetry(), denyObservation(), inconclusiveCapacityReadback(), isAuthoritativeCapacityReason(), isProbeAuthFault(), logProbeAuthFault(), PenstockAvailabilityGateLogger (+3 more)

### Community 391 - "plugin-activation-retry-provenance.test.ts"
Cohesion: 0.20
Nodes (7): WorkerStartupError, createTestWorkerHandle(), FakeChild, { forkMock }, installForkMock(), spawned, wrappedInitializeFailure()

### Community 392 - "HEARTBEAT.md -- CEO Heartbeat Checklist"
Cohesion: 0.17
Nodes (11): 1. Identity and Context, 2. Local Planning Check, 3. Approval Follow-Up, 4. Get Assignments, 5. Checkout and Work, 6. Delegation, 7. Fact Extraction, 8. Exit (+3 more)

### Community 393 - "task-watchdog-scope.ts"
Cohesion: 0.23
Nodes (11): rejectTaskWatchdogConfigMutation(), resolveTaskWatchdogProductBugFollowUp(), resolveWatchdogFollowUpSerializationContext(), AgentRunActor, isPlainRecord(), IssueScopeTarget, readString(), readTaskWatchdogContext() (+3 more)

### Community 394 - "issues-open-assignment-census.test.ts"
Cohesion: 0.18
Nodes (7): clampIssueListLimit(), OPEN_ASSIGNMENT_CENSUS_MAX_AGENT_GROUPS, OPEN_ISSUE_STATUSES, appAs(), oracle(), PRIORITY_RANK, rankOf()

### Community 395 - "createToolGatewayService"
Cohesion: 0.04
Nodes (111): parseRemoteHttpEndpoint(), remoteEndpoint(), asRecord(), auditSafeEndpoint(), createToolGatewayService(), allowPrivateRemoteEndpoints(), allTools(), approvalRequiredInstructions() (+103 more)

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

### Community 403 - "parked-agents-routes.test.ts"
Cohesion: 0.18
Nodes (3): CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY, createApp(), PROMETHEUS_RULE

### Community 404 - "documents.ts"
Cohesion: 0.31
Nodes (7): documentService(), extractLegacyPlanBody(), issueDocumentSelect, isUniqueViolation(), mapIssueDocumentRow(), nextAvailableDocumentKey(), normalizeDocumentKey()

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
Cohesion: 0.07
Nodes (23): __clearIssueListResponseCacheForTests(), __getIssueListResponseCacheSizeForTests(), ISSUE_LIST_SERVER_CACHE_MAX_ENTRIES, ensureRoleDefaultGrants(), backfillPrincipalAccessCompatibility(), ensureHumanRoleDefaultGrants(), GrantInput, insertMissingPrincipalGrants() (+15 more)

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
Cohesion: 0.20
Nodes (3): humanGatedAgeingProducer, collect(), NOW

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
Cohesion: 0.31
Nodes (7): listServerAdapters(), AdapterRegistryEnv, setAdapterDisabled, reconcileAdapterAvailability(), fetchAllQuotaWindows(), providerSlugForAdapterType(), withQuotaTimeout()

### Community 430 - "plugin-metric-exposition.test.ts"
Cohesion: 0.07
Nodes (26): dbInheritedTimeoutSeries(), DB_INHERITED_TIMEOUT_METRIC, DbInheritedTimeoutSetting, PLUGIN_METRIC_CARDINALITY_BUDGET, PLUGIN_METRIC_DROPPED_METRIC, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH, PLUGIN_METRIC_NAME_BUDGET, PLUGIN_METRIC_OVERFLOW_NAME (+18 more)

### Community 433 - "scrape-metrics-collector.test.ts"
Cohesion: 0.20
Nodes (7): DB, refreshDeferredIssueExecutionWakeAgeMetrics, refreshExternalRuntimeReservationMetrics, refreshExternalRuntimeReservationStrandMetrics, refreshOverdueScheduledRetryAgeMetrics, refreshQueuedRunAgeMetrics, refreshScheduledRetryParkHorizonMetrics

### Community 437 - "trust-proxy.ts"
Cohesion: 0.36
Nodes (7): RFC-4291, applyTrustProxy(), isValidSubnetToken(), NAMED_SUBNETS, parseTrustProxyEnv(), TrustProxyValue, appWithEnv()

### Community 438 - "privateHostnameGuard"
Cohesion: 0.42
Nodes (7): blockedHostnameMessage(), extractHostname(), isLoopbackHostname(), normalizeAllowedHostnames(), privateHostnameGuard(), resolvePrivateHostnameAllowSet(), createApp()

### Community 446 - "pr-review-issue-scope-locks.test.ts"
Cohesion: 0.25
Nodes (8): DuplicatePrReviewIssueCandidate, classify(), fakeDb(), GuardTx, ONE_PR, OPTIONS, Statement, TWO_PRS

### Community 447 - "heartbeat-reviewer-evidence-live-head.test.ts"
Cohesion: 0.25
Nodes (6): FakeReview, h, jsonResponse(), PRIVATE_KEY_PEM, { privateKey }, stubGithub()

### Community 460 - "secretService"
Cohesion: 0.05
Nodes (71): checkSecretProviders(), listSecretProviders(), isSecretProviderClientError(), asRecord(), assertClass3StaticLeaseAllowed(), assertSelectableProviderConfig(), CanonicalEnvBinding, cleanupPreparedProviderWrite() (+63 more)

### Community 461 - "plugin-activation-boot-retry.test.ts"
Cohesion: 0.07
Nodes (17): buildPluginInstallArgs(), execFileAsync, npmInstallPlugin(), PluginRuntimeServices, WorkerToHostHandlers, FAILED_CLOSED_ERROR, FORGED_MARKER_ERROR, INITIALIZE_TIMEOUT_ERROR (+9 more)

### Community 462 - "issue-stale-execution-lock-routes.test.ts"
Cohesion: 0.25
Nodes (3): createApp(), seedCompanyAgentAndRuns(), seedPendingReviewStageIssue()

### Community 463 - "plugin-manifest-validator.ts"
Cohesion: 0.22
Nodes (5): ManifestParseFailure, ManifestParseResult, ManifestParseSuccess, pluginManifestValidator, SUPPORTED_VERSIONS

### Community 464 - "plugin-state-store.ts"
Cohesion: 0.23
Nodes (10): GBRAIN_RECALL_METRIC, normalizeGbrainRecallStatus(), recordGbrainRecallOutcome(), escapeLikePattern(), maybeRecordGbrainRecallOutcome(), PluginStateStore, assertPluginExists(), scopeConditions() (+2 more)

### Community 465 - "event-loop-stall-log.ts"
Cohesion: 0.43
Nodes (6): EventLoopStallLogOptions, resolveStallThresholdMs(), startEventLoopStallLogging(), blockEventLoop(), blockUntilStallObserved(), sleep()

### Community 466 - "embedded-postgres.ts"
Cohesion: 0.11
Nodes (5): mockEnsureBuiltInAgent, mockNotifyHireApproved, pendingApproval(), seedIssue(), seedPromotedIssue()

### Community 467 - "issue-monitor-convergence-message.test.ts"
Cohesion: 0.32
Nodes (6): loadIssueUnblockOwners(), recordMonitorConvergenceEscalation(), IssueUnblockOwner, monitorConvergenceComment(), convergence, owner()

### Community 468 - "heartbeat-post-terminal-run-event.test.ts"
Cohesion: 0.29
Nodes (5): HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC, droppedCount(), NOTE: quiescence bounds the *run's* emissions, not the server's terminal, readEvents(), snapshotSettledEvents()

### Community 469 - "pr-review-head-attestation.ts"
Cohesion: 0.32
Nodes (4): allyReviewAlreadyAttestsHead(), ListPrReviewsForAttestation, PrReviewHeadAttestation, check()

### Community 470 - "issue-monitor-queue-lock.ts"
Cohesion: 0.67
Nodes (3): AdvisoryLockDb, lockIssueMonitorQueue(), withIssueMonitorQueueLock()

### Community 471 - "environment-probe.test.ts"
Cohesion: 0.25
Nodes (7): mockEnsureSshWorkspaceReady, mockEnvironmentRuntimeService, mockProbePluginEnvironmentDriver, mockProbePluginSandboxProviderDriver, mockResolvePluginSandboxProviderDriverByKey, mockRuntimeAcquireRunLease, mockRuntimeReleaseRunLease

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
Nodes (69): buildHarnessIssueDescription(), buildSkillRuntimeName(), builtInSkillTestRunTemplate(), companySkillService(), actorStarClause(), assertLocalImportSourceAllowed(), cancelTestRun(), categoryCounts() (+61 more)

### Community 482 - "pod-failure-label-corpus.test.ts"
Cohesion: 0.29
Nodes (4): executePath, FIXTURE_PATTERNS, repoRoot, testsDir

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

### Community 489 - "pen3139-transcript-credential-shapes.test.ts"
Cohesion: 0.33
Nodes (4): CARRIERS, NO_CURRENT_USER_REDACTION, Shape, VENDOR_SHAPES

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

## Knowledge Gaps
- **3744 isolated node(s):** `CEO`, `OPERATOR`, `ENGINEER`, `Db`, `LogEntry` (+3739 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 5623 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **66 communities omitted from the detail section** — 1–15 nodes each in graph.json, 37 of them ≥3; graphify omits a community with <3 nodes once file-hub and AST-stub nodes are discounted — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `heartbeatService()` connect `heartbeatService` to `heartbeat.ts`, `source-trust.ts`, `issue-continuation-summary.ts`, `github-status-delivery-outbox.ts`, `readNonEmptyString`, `app.ts`, `environmentService`, `branch-run-claims.ts`, `reconcileStrandedRecoveryWakeBackstopImpl`, `workspace-runtime.ts`, `trust-preset-resolver.ts`, `k8s-job-liveness.ts`, `readNonEmptyString`, `heartbeat-run-runtime-status.ts`, `issue-rewake-throttle.ts`, `model-profile-hint.ts`, `executeRun`, `agent-auth-jwt.ts`, `issueService`, `successful-run-handoff.ts`, `instanceSettingsService`, `db-retry.ts`, `process-loss-classification.ts`, `recoveryService`, `redactSensitiveText`, `log-redaction.ts`, `github-app-auth.ts`, `managed-checkout-partial-clone.ts`, `ccrotate-capacity-retry.ts`, `execution-workspace-cleanup.ts`, `external-runtime-reservations.ts`, `visibleIssueCondition`, `redaction.ts`, `agent-invokability.ts`, `conflict`, `services/execution-workspaces.ts`, `services/issue-tree-control.ts`, `asNumber`, `environment-runtime.ts`, `heartbeat-stop-metadata.ts`, `services/index.ts`, `run-scratch.ts`, `local-service-supervisor.ts`, `environment-run-orchestrator.ts`, `execution-policy-bootstrap.ts`, `run-liveness.ts`, `secretService`, `input`, `task-watchdogs.ts`, `responsible-user-denial-run-outcomes.ts`, `unprocessable`, `config.ts`, `execution-allowlist.ts`, `penstock-availability-gate.test.ts`, `parseObject`, `companySkillService`, `hot-restart.ts`, `pull-request-work-products.ts`, `sweep-wake-preflight.ts`, `budgetService`, `run-log-terminal-result.ts`, `issue-execution-policy.ts`, `routes/projects.ts`, `execution-workspace-policy.ts`, `productivityReviewService`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **Why does `companyPortabilityService()` connect `companyPortabilityService` to `company-portability.ts`, `app.ts`, `exportBundle`, `services/company-skills.ts`, `routes/companies.ts`, `accessService`, `issueService`, `environmentRoutes`, `cases.ts`, `adapters/index.ts`, `built-in-agents.test.ts`, `github-app-auth.ts`, `skills-catalog.ts`, `company-export-readme.ts`, `org-chart-svg.ts`, `services/projects.ts`, `secretService`, `agentService`, `unprocessable`, `agent-instructions.ts`, `companySkillService`, `routineService`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **Why does `companyService()` connect `routes/companies.ts` to `services/index.ts`, `environmentService`, `builtInAgentService`, `unprocessable`, `heartbeatService`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Are the 41 inferred relationships involving `heartbeatService()` (e.g. with `decorateHeartbeatRunRuntimeStatus()` and `buildIssueGraphLivenessAutoRecoveryPreview()`) actually correct?**
  _`heartbeatService()` has 41 INFERRED edges - model-reasoned connections that need verification._
- **Are the 6 inferred relationships involving `issueRoutes()` (e.g. with `applyCreateIssueStatusDefault()` and `executeKeyedCommentEffect()`) actually correct?**
  _`issueRoutes()` has 6 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `issueService()` (e.g. with `cancelStaleIssueContextRuns()` and `clearCheckoutRunIfTerminal()`) actually correct?**
  _`issueService()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `CEO`, `OPERATOR`, `ENGINEER` to the rest of the system?**
  _3744 weakly-connected nodes found - possible documentation gaps or missing edges._
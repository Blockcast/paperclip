import type { Request } from "express";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  ExecutionWorkspaceStrategy,
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { maskWorkspaceRuntimeForRead, maskWorkspaceRuntimeTextForRead } from "../redaction.js";
import type { accessService } from "../services/index.js";

/**
 * PEN-2852 — withholding boundary for workspace runtime configuration on response bodies.
 *
 * `workspaceRuntime` is an operator-authored `Record<string, unknown>` with no closed shape: it
 * routinely carries service commands, working directories and the environment those commands run
 * with. Until now every execution-workspace and project-workspace route answered with the raw row,
 * gated only on `company_scope:read` — which admits any same-company actor, including every agent.
 *
 * Two properties of the storage layout drive the shape of this module, and both are easy to get
 * wrong:
 *
 * 1. `config` / `runtimeConfig` are *derived views* over `metadata` — `metadata.config` and
 *    `metadata.runtimeConfig` respectively. Withholding the derived view while answering with
 *    `metadata` is a no-op: the same bytes leave one key over. Both exits must close together,
 *    which is why this module withholds them in a single function rather than at each call site.
 *
 * 2. Withholding must happen HERE, at the response boundary, and must never be pushed down into
 *    the service mappers. `routes/execution-workspaces.ts` (runtime commands, PATCH/archive),
 *    `services/heartbeat.ts` (workspace reuse) and `services/plugin-host-services.ts` all read
 *    `.metadata` off a service result and write it BACK to the row. A masked mapper would not
 *    merely hide the config — it would persist the masked value and destroy it.
 *
 * Entitlement: the raw value is disclosed on `workspace_runtime:read`, an action that exists for
 * exactly this disclosure and for nothing else.
 *
 * It is deliberately NOT `runtime:manage`, which was the first thing tried and was wrong. That
 * action reads like the right one — it is what gates *writing* this material — but it sits in the
 * standard same-company agent allow-list (`services/authorization.ts`, the `allow_company_agent`
 * branch) alongside `company_scope:read` and even `secrets:read`. Gating on it would have handed
 * every ordinary agent `revealRuntimeConfig: true`, withholding from nothing but low-trust and
 * task-bridge principals — i.e. it would have left the exact disclosure path this ticket is about
 * wide open while looking like a fix. The lesson generalizes: for an agent-facing boundary, the
 * question is never "is this action privileged-sounding" but "is this action in the blanket agent
 * allow-list".
 *
 * Who gets the raw value under the new action:
 *   - active non-viewer company members (so the workspace and project-workspace runtime EDITORS
 *     keep working — masking them unconditionally would break both), and instance admins;
 *   - nobody else by default: ordinary same-company agents, `viewer` members, `low_trust_review`
 *     agents, task-bridge keys and skill-test run tokens all get the withheld projection.
 *
 * Callers keep `hasWorkspaceRuntimeConfig` regardless of entitlement, so a UI that only needs to
 * know whether a runtime config exists never needs the contents.
 *
 * `runtimeServices` needs its own projection, and an earlier revision of this comment claimed the
 * opposite — "unaffected: a separately-typed, separately-populated field, not part of the withheld
 * blob". Separately *typed* is true and irrelevant. `command` and `cwd` are copied onto each
 * service row from the very `workspaceRuntime` entry this module withholds, so answering with a
 * raw service row hands the same operator-authored string back one key over — the same
 * derived-view trap as `config` vs `metadata` in (1) above, one level further out. `routes/issues.ts`
 * already masks that pair (`compactIssueRuntimeService`, PEN-2854 door #14); `publicRuntimeServices`
 * below is that same treatment for routes answering with service rows directly.
 *
 * It is applied in three places, not one, and the reason is the third property worth stating: the
 * workspace projections below are `{...workspace, <overrides>}`, so they disclose by DEFAULT — every
 * field not named in the override list rides through untouched. `runtimeServices` is a populated
 * field on both row types (`toExecutionWorkspace(workspace, runtimeServices)`,
 * `services/projects.ts`), so the ordinary GET and LIST routes handed the withheld pair out one key
 * over while the module read as if it had closed the boundary. A call-site guard cannot catch this:
 * `workspace-response-withholding-guard.test.ts` proves the door is USED, never that it is CLOSED.
 * Anything added to `ExecutionWorkspace` or `ProjectWorkspace` carrying operator text has to be
 * named here or it is disclosed silently.
 *
 * ## PEN-3073 — what "operator-authored command" means, decided once
 *
 * The revision above withheld `workspaceRuntime` because that is the field the door-by-door series
 * kept FINDING. Its stated rationale — "service commands, working directories and the environment
 * those commands run with" — is a rationale about a CLASS, and five sibling carriers of that same
 * class rode through untouched, under four different nouns:
 *
 *   1. `ExecutionWorkspaceConfig.provisionCommand` / `.teardownCommand` / `.cleanupCommand`
 *   2. `ProjectWorkspace.setupCommand` / `.cleanupCommand`  (top-level columns, NOT in `runtimeConfig`)
 *   3. `ExecutionWorkspaceStrategy.provisionCommand` / `.teardownCommand` / `.worktreeParentDir`
 *   4. `ProjectExecutionWorkspacePolicy.workspaceStrategy` + `.workspaceRuntime`
 *   5. `ExecutionWorkspaceCloseReadiness.plannedActions[].command` for the operator-authored kinds
 *
 * The decision: **a string this control plane hands to a shell is withheld, wherever it is stored
 * and whatever it is named.** `provisionCommand` is executed as `bash -lc <string>`
 * (`services/environment-run-orchestrator.ts`), which makes an inline `FOO_TOKEN=… ./deploy.sh` an
 * ordinary idiom — the same idiom `publicRuntimeServices` below already withholds `command` for.
 * Being a typed column bounds the KEY SET; it says nothing about the VALUE. `company-portability.ts`
 * had already reached this conclusion independently from the other side: it refuses `setupCommand`
 * on safe import and drops it from export when it carries an absolute path.
 *
 * (3) and (4) matter because they are not reachable from this module's row types at all. The same
 * two command strings live a second time on the *strategy* object, which reaches responses via
 * `issue.executionWorkspaceSettings.workspaceStrategy` and `project.executionWorkspacePolicy` — the
 * derived-view trap of (1) above at a third and fourth remove. `GET /issues/:id` served
 * `currentExecutionWorkspace.config.workspaceRuntime` masked and
 * `project.executionWorkspacePolicy.workspaceRuntime` in the clear, in one response body.
 *
 * ### Deliberately NOT withheld, and why — so the next door does not relitigate it
 *
 *  - `environmentId` — a UUID foreign key. Closed shape; carries no operator-authored text.
 *  - `desiredState` / `serviceStates` — enum-validated on the way out of the runtime-config reader
 *    (`WorkspaceRuntimeDesiredState`). Closed shape, same reason.
 *  - `hasWorkspaceRuntimeConfig` — the compensating existence flag. Withheld-is-not-absent.
 *  - `ExecutionWorkspace.cwd` / `agentCwd`, `ProjectWorkspace.cwd` — the path the agent runtime must
 *    `cd` into to do its job. Disclosing it is the feature; this is a live product decision, not an
 *    unexamined pass-through, and it is why `plannedActions` masking below is by action KIND rather
 *    than blanket: `git worktree remove --force <path>` is Paperclip-generated from a path the
 *    caller already holds, while `cleanup_command` is the operator's own string.
 *  - `ExecutionWorkspaceStrategy.type` / `.runScope` — closed enums. `.baseRef` / `.branchTemplate`
 *    are git refs and templates the branch-naming UI renders and the agent needs to name its branch.
 *  - `stdoutExcerpt` / `stderrExcerpt` / `logRef` on operations — command *output*, not a copy of a
 *    declared-withheld value (CTO Ruling F §4, BLO-33407). Unchanged by this ticket.
 *
 * ### ⚠️ KNOWN OPEN CARRIER, deliberately not closed here — `issues.executionWorkspaceSettings`
 *
 * The issue row holds a per-issue override of the SAME two objects the project policy holds:
 * `workspaceStrategy` (the command strings above) and `workspaceRuntime` (the open operator record).
 * `buildReusedExecutionWorkspaceConfigPatchFromIssueSettings` (`services/issues.ts`) copies both
 * straight onto the execution workspace's own config, so they are the same bytes, not merely the
 * same class. It is a raw JSONB column on a row this module has no projection for, and issue
 * responses are SPREADS — so it does not pass this boundary at all. That makes it a BYPASS of the
 * shipped boundary rather than a gap in this mask's width.
 *
 * ⇒ **Tracked as PEN-3252** (filed from this change, with the full twelve-site inventory and a
 * draft of the `publicIssueExecutionWorkspaceSettings` projection that closes it). Anyone reading
 * this module to decide whether the class is closed should read that ticket first.
 *
 * It is named here, in the module that would otherwise read as having closed the class, because the
 * honest scope of the fix below is "every carrier reachable through a workspace or project row" —
 * NOT "every carrier", and NOT "every workspace-runtime response exit". An unentitled same-company
 * agent still receives raw `workspaceStrategy` command strings and the raw `workspaceRuntime`
 * record from the issue routes; that disclosure is open until PEN-3252 lands, and no claim in this
 * module, its tests, or the change that introduced it should be read as covering it.
 *
 * The settings column reaches responses from ELEVEN sites in `routes/issues.ts`
 * (`GET /issues/:id`, create ×2, children, PATCH, DELETE, checkout, release ×2, admin force-release,
 * recovery-actions/resolve) plus the company-export bundle, none of which the CI guard covers.
 * Masking one of twelve would read as closure and be worse than masking none — which is why the
 * split is by BYPASS-vs-WIDTH rather than by convenience.
 */

export interface WorkspaceRuntimeViewer {
  /** True only for actors entitled to the raw `workspaceRuntime` / `metadata` values. */
  revealRuntimeConfig: boolean;
}

/** Withholds by default: any caller that cannot prove the entitlement gets the redacted view. */
export const WITHHELD_WORKSPACE_RUNTIME_VIEWER: WorkspaceRuntimeViewer = {
  revealRuntimeConfig: false,
};

export async function resolveWorkspaceRuntimeViewer(
  access: ReturnType<typeof accessService>,
  req: Request,
  companyId: string,
): Promise<WorkspaceRuntimeViewer> {
  const decision = await access.decide({
    actor: req.actor,
    action: "workspace_runtime:read",
    resource: { type: "company", companyId },
  });
  return { revealRuntimeConfig: decision.allowed };
}

/**
 * PEN-3073. Masked rather than nulled, for the same reason `publicRuntimeServices` masks: a withheld
 * reader must still be able to tell "no provision command is configured" from "the provision command
 * was withheld". `workspaceRuntime` stays `null` rather than joining them because
 * `hasWorkspaceRuntimeConfig` already carries that distinction for it, and because a nested record
 * has no single sentinel to stand in for it.
 *
 * Enumerated over a spread on purpose: a field added to `ExecutionWorkspaceConfig` later has to be
 * classified here before it can ship, instead of riding out by default.
 */
export function publicExecutionWorkspaceConfig(
  config: ExecutionWorkspaceConfig | null,
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspaceConfig | null {
  if (config === null) return null;
  if (viewer.revealRuntimeConfig) return config;
  return {
    ...config,
    provisionCommand: maskWorkspaceRuntimeTextForRead(config.provisionCommand),
    teardownCommand: maskWorkspaceRuntimeTextForRead(config.teardownCommand),
    cleanupCommand: maskWorkspaceRuntimeTextForRead(config.cleanupCommand),
    workspaceRuntime: null,
  };
}

/**
 * PEN-3073. The strategy object carries the SAME two command strings as
 * `ExecutionWorkspaceConfig` — `buildReusedExecutionWorkspaceConfigPatchFromIssueSettings`
 * (`services/issues.ts`) copies `settings.workspaceStrategy.provisionCommand` straight onto
 * `config.provisionCommand`, so they are not merely the same class, they are the same bytes.
 *
 * `worktreeParentDir` joins them: it is an operator-authored host path, and unlike `workspace.cwd`
 * no caller needs it to reach its own tree — it is the parent directory the runtime allocates under.
 */
export function publicExecutionWorkspaceStrategy(
  strategy: ExecutionWorkspaceStrategy | null | undefined,
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspaceStrategy | null | undefined {
  if (strategy === null || strategy === undefined) return strategy;
  if (viewer.revealRuntimeConfig) return strategy;
  return {
    ...strategy,
    ...(strategy.worktreeParentDir === undefined
      ? {}
      : { worktreeParentDir: maskWorkspaceRuntimeTextForRead(strategy.worktreeParentDir) }),
    ...(strategy.provisionCommand === undefined
      ? {}
      : { provisionCommand: maskWorkspaceRuntimeTextForRead(strategy.provisionCommand) }),
    ...(strategy.teardownCommand === undefined
      ? {}
      : { teardownCommand: maskWorkspaceRuntimeTextForRead(strategy.teardownCommand) }),
  };
}

export function publicExecutionWorkspace(
  workspace: ExecutionWorkspace,
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspace {
  if (viewer.revealRuntimeConfig) return workspace;
  return {
    ...workspace,
    config: publicExecutionWorkspaceConfig(workspace.config, viewer),
    metadata: null,
    runtimeServices:
      workspace.runtimeServices && publicRuntimeServices(workspace.runtimeServices, viewer),
  };
}

/** The identity fields of an execution workspace — which workspace, and nothing about its runtime. */
export type ExecutionWorkspaceIdentity = Pick<
  ExecutionWorkspace,
  "closedAt" | "id" | "mode" | "name" | "status"
>;

/**
 * Narrows an execution-workspace row to its identity fields, for responses that must say WHICH
 * workspace a caller hit without disclosing anything about it — error bodies, chiefly.
 *
 * This is a narrowing, not a mask, so unlike `publicExecutionWorkspace` it takes no viewer: none of
 * the five fields is withheld from anyone. It exists as a function rather than a declared parameter
 * type because a declared type does not narrow at runtime. A handler typed
 * `Pick<ExecutionWorkspace, …>` still serializes every property of the full row it is handed —
 * TypeScript checks excess properties at literal-assignment sites and nowhere else. That is exactly
 * how the closed-workspace 409 in `routes/issues.ts` came to serve `workspaceRuntime`: the narrow
 * type made it read as already-projected, so nobody looked.
 */
export function executionWorkspaceIdentity(
  workspace: ExecutionWorkspaceIdentity,
): ExecutionWorkspaceIdentity {
  return {
    closedAt: workspace.closedAt,
    id: workspace.id,
    mode: workspace.mode,
    name: workspace.name,
    status: workspace.status,
  };
}

export function publicExecutionWorkspaces(
  workspaces: ExecutionWorkspace[],
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspace[] {
  return workspaces.map((workspace) => publicExecutionWorkspace(workspace, viewer));
}

/**
 * Field-level, deliberately not `runtimeServices: []`. Routes answering with service rows do so
 * because the caller needs the fleet — `close-readiness` counts running services to decide whether
 * closing is destructive — so emptying the array would break the feature to protect two fields.
 *
 * `command` and `cwd` are the withheld pair: `command` is handed to `sh -c`, which makes an inline
 * `FOO_TOKEN=… npm run dev` an ordinary idiom, and `cwd` discloses host paths. Both are copied from
 * the operator's `workspaceRuntime` entry, so they are the same bytes this module withholds
 * elsewhere.
 *
 * `url` deliberately survives, and that is a measurement rather than an inherited assumption: the
 * operator-authored entry parsed by `listWorkspaceServiceCommandDefinitions`
 * (`packages/shared/src/workspace-commands.ts`) has no `url` key at all. The value is written only
 * from a runtime process report, so it is a generated local address and not operator free text —
 * and `paperclipWaitForIssueWorkspaceService` returns it to the caller, so masking it would break a
 * tool to hide a string the operator never wrote. `providerRef` is a pid. This matches the call
 * `compactIssueRuntimeService` already made for the issue projection.
 *
 * Masked rather than nulled, so a withheld reader can still tell "this service has no command" from
 * "this service's command was withheld" — the same withheld-is-not-absent contract as
 * `hasWorkspaceRuntimeConfig`.
 */
export function publicRuntimeServices(
  services: WorkspaceRuntimeService[],
  viewer: WorkspaceRuntimeViewer,
): WorkspaceRuntimeService[] {
  if (viewer.revealRuntimeConfig) return services;
  return services.map((service) => ({
    ...service,
    command: maskWorkspaceRuntimeTextForRead(service.command),
    cwd: maskWorkspaceRuntimeTextForRead(service.cwd),
  }));
}

/**
 * `WorkspaceOperation` is the third carrier of the withheld `command`/`cwd` pair, and it reaches it
 * by copy rather than by nesting: `routes/execution-workspaces.ts` records an operation with
 * `command: workspaceCommand?.command` and `cwd: existing.cwd` — the very strings
 * `publicRuntimeServices` masks one projection over. A route that withholds `workspace` and answers
 * with a raw `operation` in the same response literal hands the same bytes back one key over, which
 * is the derived-view trap of (1) above at a third remove.
 *
 * `metadata` goes through `maskWorkspaceRuntimeForRead` rather than a named-key list because it is
 * an open `Record<string, unknown>` written by ~10 recorder call sites — it carries `worktreePath`,
 * `repoRoot`, `branchName` and `baseRef` today, and whatever the next call site adds tomorrow. A
 * name list cannot cover a key that does not exist yet; the deny-by-default walk can, and it already
 * handles the array- and JSON-string-shaped bypasses this series shipped once each.
 *
 * Kept deliberately: `phase`, `status`, `exitCode`, `logBytes`, the ids and the timestamps. An
 * unentitled operator must still be able to see that an operation ran and how it ended — withholding
 * the operator's text is the point, hiding the fact of execution is not.
 *
 * `stdoutExcerpt` / `stderrExcerpt` / `logRef` are deliberately NOT withheld here. They are command
 * *output*, not a copy of a declared-withheld value, so they sit on the far side of BLO-33568's rule
 * and are a product decision rather than a projection bug (CTO Ruling F §4, BLO-33407).
 */
export function publicWorkspaceOperation(
  operation: WorkspaceOperation,
  viewer: WorkspaceRuntimeViewer,
): WorkspaceOperation {
  if (viewer.revealRuntimeConfig) return operation;
  return {
    ...operation,
    command: maskWorkspaceRuntimeTextForRead(operation.command),
    cwd: maskWorkspaceRuntimeTextForRead(operation.cwd),
    metadata: maskWorkspaceRuntimeForRead(operation.metadata) as Record<string, unknown> | null,
  };
}

export function publicWorkspaceOperations(
  operations: WorkspaceOperation[],
  viewer: WorkspaceRuntimeViewer,
): WorkspaceOperation[] {
  return operations.map((operation) => publicWorkspaceOperation(operation, viewer));
}

export function publicProjectWorkspace(
  workspace: ProjectWorkspace,
  viewer: WorkspaceRuntimeViewer,
): ProjectWorkspace {
  if (viewer.revealRuntimeConfig) return workspace;
  return {
    ...workspace,
    // PEN-3073. `ProjectWorkspaceRuntimeConfig` has no command fields, so the runtime config here is
    // already as closed as its type permits — but the row carries the same class of string one level
    // UP, as top-level columns. Reading the asymmetry off the two *config* types alone misses them.
    setupCommand: maskWorkspaceRuntimeTextForRead(workspace.setupCommand),
    cleanupCommand: maskWorkspaceRuntimeTextForRead(workspace.cleanupCommand),
    runtimeConfig:
      workspace.runtimeConfig === null ? null : { ...workspace.runtimeConfig, workspaceRuntime: null },
    metadata: null,
    runtimeServices:
      workspace.runtimeServices && publicRuntimeServices(workspace.runtimeServices, viewer),
  };
}

export function publicProjectWorkspaces(
  workspaces: ProjectWorkspace[],
  viewer: WorkspaceRuntimeViewer,
): ProjectWorkspace[] {
  return workspaces.map((workspace) => publicProjectWorkspace(workspace, viewer));
}

/**
 * Project responses EMBED their workspaces (`workspaces[]` and `primaryWorkspace`), each built by
 * the same `toWorkspace` mapper — so a project read is a second exit for exactly the same material,
 * and `GET /companies/:companyId/projects` is the widest one in the codebase. Found by running this
 * ticket's own method clause against the workspace-route fix rather than by re-reading it.
 *
 * PEN-3073 adds `executionWorkspacePolicy`. It is not a workspace row and does not reach this module
 * through one, which is exactly why the first revision missed it: the project row carries its own
 * `workspaceRuntime` — the same open operator-authored `Record<string, unknown>` — plus a
 * `workspaceStrategy`. Both rode out on the widest exit while the embedded workspaces beside them
 * were masked.
 */
export function publicProject<T extends {
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null;
}>(project: T, viewer: WorkspaceRuntimeViewer): T {
  if (viewer.revealRuntimeConfig) return project;
  return {
    ...project,
    ...(project.executionWorkspacePolicy === undefined
      ? {}
      : {
          executionWorkspacePolicy: publicProjectExecutionWorkspacePolicy(
            project.executionWorkspacePolicy,
            viewer,
          ),
        }),
    workspaces: publicProjectWorkspaces(project.workspaces, viewer),
    primaryWorkspace: project.primaryWorkspace
      ? publicProjectWorkspace(project.primaryWorkspace, viewer)
      : null,
  };
}

export function publicProjects<T extends {
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null;
}>(projects: T[], viewer: WorkspaceRuntimeViewer): T[] {
  return projects.map((project) => publicProject(project, viewer));
}

/**
 * PEN-3073. The project-level default for everything the two workspace rows carry per-instance, and
 * the source `getCloseReadiness` falls back to for a teardown command
 * (`config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand`). Same bytes, one
 * noun over.
 *
 * `workspaceRuntime` goes through the deny-by-default walk rather than to `null`: unlike the
 * workspace rows there is no `hasWorkspaceRuntimeConfig` flag beside it here, so nulling would erase
 * the operator's ability to see that a policy exists at all. The walk keeps key NAMES and structure
 * and elides values — PEN-2370 ask 1.
 *
 * `branchPolicy` / `pullRequestPolicy` / `runtimePolicy` / `cleanupPolicy` are open records too and
 * get the same walk, for the same reason `metadata` does on the operation projection: a name list
 * cannot cover a key that does not exist yet. `authorizationPolicy` is a closed trust-boundary shape
 * read by the low-trust review path and carries no operator free text, so it crosses intact.
 */
export function publicProjectExecutionWorkspacePolicy(
  policy: ProjectExecutionWorkspacePolicy | null,
  viewer: WorkspaceRuntimeViewer,
): ProjectExecutionWorkspacePolicy | null {
  if (policy === null) return null;
  if (viewer.revealRuntimeConfig) return policy;
  const maskOpenRecord = (value: Record<string, unknown> | null | undefined) =>
    value === null || value === undefined
      ? value
      : (maskWorkspaceRuntimeForRead(value) as Record<string, unknown>);
  return {
    ...policy,
    ...(policy.workspaceStrategy === undefined
      ? {}
      : { workspaceStrategy: publicExecutionWorkspaceStrategy(policy.workspaceStrategy, viewer) }),
    ...(policy.workspaceRuntime === undefined
      ? {}
      : { workspaceRuntime: maskOpenRecord(policy.workspaceRuntime) }),
    ...(policy.branchPolicy === undefined ? {} : { branchPolicy: maskOpenRecord(policy.branchPolicy) }),
    ...(policy.pullRequestPolicy === undefined
      ? {}
      : { pullRequestPolicy: maskOpenRecord(policy.pullRequestPolicy) }),
    ...(policy.runtimePolicy === undefined
      ? {}
      : { runtimePolicy: maskOpenRecord(policy.runtimePolicy) }),
    ...(policy.cleanupPolicy === undefined
      ? {}
      : { cleanupPolicy: maskOpenRecord(policy.cleanupPolicy) }),
  };
}

/**
 * PEN-3073. `GET /execution-workspaces/:id/close-readiness` answers `{ ...readiness, runtimeServices:
 * publicRuntimeServices(…) }` — it masks the service rows and spreads everything else, so
 * `plannedActions[].command` handed back `config.cleanupCommand`, the project workspace's
 * `cleanupCommand` and the resolved `teardownCommand` verbatim, beside the very services it had just
 * masked.
 *
 * Masked by action KIND, not blanket. `cleanup_command` and `teardown_command` carry the operator's
 * own string. The rest are Paperclip-generated previews of what closing will do
 * (`git worktree remove --force <path>`, `rm -rf <path>`) built from a path the caller already holds
 * on the row, and they are the entire point of the readiness preview — blanking them would break the
 * confirm-before-destroy UI to hide a string the operator never wrote. `description` for those kinds
 * is generated the same way and stays.
 */
const OPERATOR_AUTHORED_CLOSE_ACTION_KINDS = new Set(["cleanup_command", "teardown_command"]);

export function publicExecutionWorkspaceCloseReadiness(
  readiness: ExecutionWorkspaceCloseReadiness,
  viewer: WorkspaceRuntimeViewer,
): ExecutionWorkspaceCloseReadiness {
  if (viewer.revealRuntimeConfig) return readiness;
  return {
    ...readiness,
    plannedActions: readiness.plannedActions.map((action) =>
      OPERATOR_AUTHORED_CLOSE_ACTION_KINDS.has(action.kind)
        ? { ...action, command: maskWorkspaceRuntimeTextForRead(action.command) }
        : action,
    ),
    runtimeServices: publicRuntimeServices(readiness.runtimeServices, viewer),
  };
}

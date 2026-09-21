import type { Request } from "express";
import type {
  AgentEnvConfig,
  ExecutionWorkspace,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  ExecutionWorkspaceStrategy,
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { isPlainObject, maskWorkspaceRuntimeForRead, maskWorkspaceRuntimeTextForRead, withholdWorkspaceOperationCapturedOutput } from "../redaction.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";
import type { accessService } from "../services/index.js";
import { maskProjectEnv } from "./project-env-response.js";

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
 *  - `stdoutExcerpt` / `stderrExcerpt` / `logRef` / `logStore` on operations — command *output* and
 *    opaque handles. BLO-34631 surveyed the consumers and kept the excerpts disclosed: the agent's
 *    own MCP control path reads them back for the command it just triggered (see
 *    `publicWorkspaceOperation`). The route `logRef` points at does withhold its content, because
 *    that one has no agent consumer.
 *
 * ### PEN-3252 — the bypass this module recorded as open, now closed
 *
 * The issue row holds a per-issue override of the SAME two objects the project policy holds:
 * `workspaceStrategy` (the command strings above) and `workspaceRuntime` (the open operator record).
 * `buildReusedExecutionWorkspaceConfigPatchFromIssueSettings` (`services/issues.ts`) copies both
 * straight onto the execution workspace's own config, so they are the same bytes, not merely the
 * same class. It is a raw JSONB column on a row this module had no projection for, and issue
 * responses are SPREADS — so it did not pass this boundary at all. That made it a BYPASS of the
 * shipped boundary rather than a gap in this mask's width, which is why it was split out of PEN-3073
 * instead of being masked at one of its twelve sites: masking one of twelve would have read as
 * closure and been worse than masking none.
 *
 * `publicIssueExecutionWorkspaceSettings` below closes it, applied at all twelve: eleven response
 * sites in `routes/issues.ts` (`GET /issues/:id`, create ×2, children, PATCH, DELETE, checkout,
 * release ×2, admin force-release, recovery-actions/resolve) via the `withPublicIssueWorkspaceSettings`
 * helper there, plus the company-export bundle in `services/company-portability.ts`. The export is the
 * one exit that OMITS rather than masks, because a bundle is round-trippable and a sentinel would be
 * imported as a literal command string; see that call site for the reasoning.
 *
 * With that, the honest scope of this module is every carrier reachable through a workspace row, a
 * project row, or an issue row. It is still NOT a claim about "every workspace-runtime response exit"
 * in the product — a carrier on some other row type would bypass this module exactly as the issue
 * column did, and the lesson of PEN-3252 is that the question to ask of a new exit is "does the
 * response body pass THROUGH this boundary", not "is the value the same class as one it withholds".
 *
 * List paths are deliberately untouched and must stay that way: `issueListSelect`
 * (`services/issues.ts`) already projects `executionWorkspaceSettings` to SQL `null`, so
 * `GET /issues` and `GET /companies/:companyId/issues` never carry the column in either their compact
 * or their full branch. An audit that re-derives the inventory from `res.json({...issue})` shapes
 * alone will flag the full list branch as a thirteenth site; it is not one, and the reason is in the
 * SELECT rather than in the route.
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

/**
 * PEN-3252. The per-issue override of the same two objects the project policy holds, closing the
 * BYPASS this module's header previously recorded as open.
 *
 * ## Why this one cannot be a spread, unlike every other projection above
 *
 * Every sibling here projects a *typed* row: the type bounds the key set, so `{...row, <overrides>}`
 * is safe because the only keys that can exist are ones a reviewer classified. `issues.
 * executionWorkspaceSettings` is a raw `jsonb` column with **no shape guarantee at any layer** —
 * `packages/db/src/schema/issues.ts` declares `$type<Record<string, unknown>>()`, which Drizzle emits
 * no runtime check for, and the column has no `DEFAULT` and no `CHECK`
 * (`packages/db/src/migrations/0027_tranquil_tenebrous.sql`).
 *
 * That is not theoretical. The UPDATE writers rebuild the object through
 * `parseIssueExecutionWorkspaceSettings` and are closed, but the CREATE writer
 * (`services/issues.ts`, `insert(issues)`) gates on **truthiness only** and stores the caller's value
 * byte-for-byte. Two callers reach it without a strict schema — the portability import
 * (`validators/company-portability.ts`, an open `z.record`) and the plugin host
 * (`services/plugin-host-services.ts`, no runtime validation at all). So the stored value can be a
 * non-object, can carry unknown top-level keys, can hold a `workspaceStrategy` that is a string or an
 * array, and can hold a `mode` outside the enum. Children then inherit it verbatim
 * (`services/issues.ts` spreads the parent row's raw settings). The codebase already assumes this:
 * migration `0121_instance_scoped_environments.sql` guards its rewrite on
 * `jsonb_typeof(...) = 'object'`.
 *
 * Hence: **enumerate and walk, default to mask.** A key nobody has classified is withheld rather than
 * disclosed, which is the property the `{...spread}` projections above buy from their types and this
 * one has to buy from its control flow.
 *
 * ## Reuse, not re-derivation
 *
 * Normalization is `parseIssueExecutionWorkspaceSettings` — the same parser the write path uses — and
 * command masking is `publicExecutionWorkspaceStrategy` above. Neither is reimplemented here. A second
 * implementation of either is exactly how one exit ends up masked and the other not, which is the
 * failure this series keeps finding; and the parser is what makes the enum/shape normalization below
 * a single source of truth rather than a copy that can drift from the writer's.
 *
 * What crosses intact, and why each is genuinely closed *after* the parser has run:
 *  - `mode` — the parser emits it only when it matches the known enum (normalizing the two legacy
 *    aliases) and omits it otherwise, so an unparseable `mode` falls to the mask below.
 *  - `environmentId` — a UUID foreign key, matching the non-withholding call recorded for
 *    `config.environmentId`. The parser accepts *any* string here, so the UUID shape is checked
 *    below rather than assumed: on a typed column the declared type would settle it, and on this
 *    column it settles nothing. "Being a typed column bounds the KEY SET; it says nothing about the
 *    VALUE" applies with full force to a column whose type is a compile-time cast.
 *  - `workspaceStrategy` — only after `parseExecutionWorkspaceStrategy` has dropped it entirely
 *    unless `type` is one of the four known literals, stripped every key outside the seven the
 *    shared schema declares, and dropped an out-of-enum `runScope`. What survives is a genuine
 *    `ExecutionWorkspaceStrategy`, which is the precondition `publicExecutionWorkspaceStrategy`'s
 *    spread needs in order to be safe.
 *
 * Everything else — `workspaceRuntime` above all, plus any key the parser dropped and any key nobody
 * has classified — goes through `maskWorkspaceRuntimeForRead`. Masked rather than deleted, so a
 * withheld reader can still tell "withheld" from "never set"; that distinction is this module's
 * standing rule and the walk preserves it at the top level.
 *
 * The one place the distinction is NOT preserved is an unknown key *nested inside* a
 * `workspaceStrategy` that otherwise parses: the shared parser drops it before this function sees it.
 * That is safe by construction — dropping discloses strictly less than masking — and it matches what
 * the write path already does to the same key, so the read and write shapes agree.
 */
const ISSUE_WORKSPACE_SETTINGS_ENVIRONMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function publicIssueExecutionWorkspaceSettings(
  settings: unknown,
  viewer: WorkspaceRuntimeViewer,
): unknown {
  if (settings === null || settings === undefined) return settings;
  if (viewer.revealRuntimeConfig) return settings;
  // Fails closed on the array/scalar rows the CREATE writer admits: there is no key set to walk, so
  // the value is masked whole rather than spread (spreading a string would emit its characters).
  if (!isPlainObject(settings)) return maskWorkspaceRuntimeForRead(settings);

  const parsed = parseIssueExecutionWorkspaceSettings(settings, { includeEnvironmentId: true });
  // Null-prototype, because the accumulator below is keyed by operator-authored strings and an
  // ordinary `{}` inherits `Object.prototype`. The CREATE writer stores the caller's object
  // byte-for-byte and `JSON.parse` makes even `__proto__` an OWN key, so a settings row really can
  // carry `constructor` / `toString` / `valueOf` / `hasOwnProperty` / `__proto__` at the top level.
  // On an inheriting accumulator each of those is DROPPED instead of masked — twice over: the
  // already-classified guard sees the inherited member, and assigning `__proto__` hits the inherited
  // setter and re-parents the object rather than adding a key. Both failures disclose strictly less,
  // so neither leaks; what they break is the withheld-is-not-absent rule stated above, which is the
  // one thing this walk exists to hold. `Object.create(null)` removes the inherited members, which
  // fixes both. The own-key guard below is then belt-and-braces: it keeps the loop correct if this
  // seed is ever changed back, which the `__proto__` case alone would not (see PEN-3073 tests).
  const projected: Record<string, unknown> = Object.create(null);

  if (parsed?.mode !== undefined) {
    projected.mode = parsed.mode;
  }
  if (
    parsed?.environmentId === null ||
    (typeof parsed?.environmentId === "string" &&
      ISSUE_WORKSPACE_SETTINGS_ENVIRONMENT_ID_PATTERN.test(parsed.environmentId))
  ) {
    projected.environmentId = parsed.environmentId;
  }
  if (parsed?.workspaceStrategy) {
    projected.workspaceStrategy = publicExecutionWorkspaceStrategy(parsed.workspaceStrategy, viewer);
  }

  for (const [key, value] of Object.entries(settings)) {
    if (Object.prototype.hasOwnProperty.call(projected, key)) continue;
    projected[key] = maskWorkspaceRuntimeForRead(value);
  }
  return projected;
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
 * `stdoutExcerpt` / `stderrExcerpt` are NOT withheld, and as of BLO-34631 that is a measured
 * decision rather than the inherited "command output is not a copy of a declared-withheld value"
 * reading (CTO Ruling F §4, BLO-33407).
 *
 * The symmetry argument for withholding them is real and was the CTO's stated lean: the output of a
 * withheld command can disclose the command — shells echo, `npm` prints the script it runs, `set -x`
 * prints everything — and the only control standing over the bytes is the write-time
 * `redactSensitiveText` heuristic, which matches env-dump assignments, JSON secret fields and URI
 * credentials and nothing else. Host paths, repo layout and an operator's `cleanupCommand` cross it
 * intact. BLO-34631 AC 3 made that lean explicitly falsifiable by a consumer survey, and the survey
 * falsifies it:
 *
 *  - `POST /execution-workspaces/:id/runtime-services/:action` (`routes/execution-workspaces.ts`) and
 *    `POST /projects/:id/workspaces/:workspaceId/runtime-services/:action` (`routes/projects.ts`)
 *    answer with `operation: publicWorkspaceOperation(operation, viewer)`, where the operation is the
 *    one the caller just triggered and `stdout`/`stderr` are captured synchronously from it.
 *  - The first of those is the backing call for the MCP tool `paperclipControlIssueWorkspaceServices`
 *    (`packages/mcp-server/src/tools.ts`), which returns the response JSON verbatim to the calling
 *    agent, and both it and `GET /heartbeat-runs/:runId/workspace-operations` are on the sandbox
 *    callback bridge allowlist (`packages/adapter-utils/src/sandbox-callback-bridge.ts`).
 *  - Same-company agents deliberately lack `workspace_runtime:read` (PEN-2852), so masking here
 *    hands an agent `***REDACTED***` for the output of the command it just ran. `status`/`exitCode`
 *    survive, so it would still learn pass/fail — but not why, which is exactly the "debugging a
 *    failed provision" flow BLO-34631 named as the finding that settles this.
 *
 * So the disclosure is deliberate and recorded, not an unexamined pass-through. The residual it
 * accepts: an operator's service command echoed into its own output still reaches an unentitled
 * reader, and the write-time scrub is not a boundary. Narrowing it is a product decision that has to
 * keep the agent's own command-result path readable — masking the read/list routes alone would split
 * the same field across routes, which is the failure mode this series exists to close.
 *
 * `logRef` / `logStore` stay for a different reason: they are opaque handles, and the route they
 * point at (`/workspace-operations/:id/log`) DOES withhold its content on this entitlement as of
 * BLO-34631 — that route has no agent consumer (no MCP tool, not bridge-allowlisted; only
 * `ui/src/pages/AgentDetail.tsx` and `paperclip run workspace-log` read it). Masking a pointer whose
 * route still served the bytes would have been theatre.
 *
 * PEN-3204 (merge of 2026-09-20): the paragraphs above settle THIS gate — the workspace-runtime
 * entitlement — and they settle it correctly. They are NOT the whole story, because a SECOND and
 * orthogonal gate now also reads these rows: `withholdUnentitledWorkspaceOperationOutput` below,
 * which narrows the captured output to `decideRunTranscriptRead` per the PEN-3202 ruling. This one
 * answers "may you see the operator's command?"; that one answers "may you see what it printed?".
 *
 * The two do not collide, and that is a measurement rather than an assertion — BLO-34631's survey
 * is the sharpest available test of the transcript gate and does not reach it, for two independent
 * reasons:
 *
 *  - **Different key.** BLO-34631 falsified a mask keyed on `workspace_runtime:read`, which
 *    same-company agents deliberately lack (PEN-2852) — so that mask hit an agent reading its OWN
 *    output, which is the regression that settles it. The transcript gate is keyed on run
 *    OWNERSHIP: an agent reading its own run resolves to `allow_self` in `authorization.ts` and is
 *    admitted. The reader BLO-34631 protects is the one case the transcript gate never denies.
 *  - **Different routes.** The falsifying consumer is
 *    `POST /execution-workspaces/:id/runtime-services/:action` (the backing call for
 *    `paperclipControlIssueWorkspaceServices`), which answers at `:536` through
 *    `publicWorkspaceOperation` alone and is deliberately left untouched by the transcript gate.
 *    The transcript gate is applied to the two LIST routes and the per-operation `/log` only.
 *
 * What the transcript gate does narrow is the case BLO-34631's survey did not test: one agent
 * reading ANOTHER agent's run output. Neither gate covers the other, and a route that applies only
 * one is half-gated.
 *
 * BLO-34738: "no agent consumer" is NOT what bounds the loss, and reading it that way is a trap.
 * `paperclip run workspace-log` (`cli/src/commands/client/run.ts:243`) sends whatever key `ctx.api`
 * holds, so a non-sandboxed agent with a direct key does reach that route — and gets
 * `REDACTED_VALUE_SENTINEL`. What actually bounds it is the excerpt-disclosure decision recorded
 * two paragraphs above: `stdoutExcerpt`/`stderrExcerpt` still cross to an unentitled reader, so the
 * handles point at strictly less than the row already discloses. If a later ticket revisits
 * BLO-34631 AC 3 and masks those excerpts, this justification goes with it — re-decide the handles
 * in that same change rather than inheriting this paragraph.
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

/**
 * PEN-3204 (implements the PEN-3202 ruling). The SECOND, orthogonal gate on these
 * rows: `publicWorkspaceOperation` above withholds the operator's copied
 * `command`/`cwd`/`metadata` under the workspace-runtime gate; this one withholds
 * the captured OUTPUT under the run-transcript gate. Different questions, different
 * deciders, same rows — so they compose rather than nest, and neither may be taken
 * as covering the other.
 *
 * It lives here, next to the projection it composes with, so all three read routes
 * (`/heartbeat-runs/:runId/workspace-operations`,
 * `/execution-workspaces/:id/workspace-operations`, and the per-operation `/log`
 * gate that mirrors this decision) share ONE definition of who owns an operation's
 * output. Gating two of the three and leaving the third is the PEN-2777 failure the
 * `authz.ts` comment exists to prevent, and a second copy of this rule is how the
 * third one drifts.
 *
 * **Fail-closed, and deliberately tighter than the decider.** An operation with no
 * resolvable owning agent is withheld from every agent actor — including a holder of
 * the company-wide `runs:read_transcript` grant. `decideRunTranscriptRead` would fall
 * through to that grant when handed a null `agentId` (the two relational allows in
 * `authorization.ts` are both guarded on `resource.agentId` being set), so calling it
 * with an unresolved owner would NOT fail closed. Human operators keep the read,
 * matching the board carve-out the decider makes itself and the operator UI that
 * renders these excerpts.
 *
 * The return type carries `withheldFields` optionally rather than dropping it:
 * an entitled row keeps the key absent, a withheld row carries the list, and
 * that is the documented difference between "not entitled" and "captured no
 * output" (`doc/DEVELOPING.md`). Declaring the plain row type erased it.
 */
export async function withholdUnentitledWorkspaceOperationOutput(
  operations: WorkspaceOperation[],
  owners: Map<string, string>,
  gate: (agentId: string) => Promise<boolean>,
  actorIsHumanOperator: boolean,
): Promise<Array<WorkspaceOperation & { withheldFields?: string[] }>> {
  return Promise.all(operations.map(async (operation) => {
    const ownerAgentId = operation.heartbeatRunId ? owners.get(operation.heartbeatRunId) : undefined;
    if (!ownerAgentId) {
      return actorIsHumanOperator ? operation : withholdWorkspaceOperationCapturedOutput(operation);
    }
    return (await gate(ownerAgentId)) ? operation : withholdWorkspaceOperationCapturedOutput(operation);
  }));
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
  env?: AgentEnvConfig | null;
  executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null;
}>(project: T, viewer: WorkspaceRuntimeViewer): T {
  // PEN-3033: the `env` mask is applied FIRST and is not gated on `viewer`. The runtime-config
  // withholding below is an entitlement decision; a plain env value is disclosed to nobody, so it
  // must not sit behind the `revealRuntimeConfig` early return — an entitled viewer would
  // otherwise take the raw row on the very next line.
  const masked = maskProjectEnv(project);
  if (viewer.revealRuntimeConfig) return masked;
  return {
    ...masked,
    ...(masked.executionWorkspacePolicy === undefined
      ? {}
      : {
          executionWorkspacePolicy: publicProjectExecutionWorkspacePolicy(
            masked.executionWorkspacePolicy,
            viewer,
          ),
        }),
    workspaces: publicProjectWorkspaces(masked.workspaces, viewer),
    primaryWorkspace: masked.primaryWorkspace
      ? publicProjectWorkspace(masked.primaryWorkspace, viewer)
      : null,
  };
}

export function publicProjects<T extends {
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  env?: AgentEnvConfig | null;
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

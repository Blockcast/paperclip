import type { Request } from "express";
import { forbidden } from "../errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function prefixPath(prefix: string, key: string) {
  return prefix.length > 0 ? `${prefix}.${key}` : key;
}

function collectWorkspaceStrategyCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  return paths;
}

function collectExecutionWorkspaceConfigCommandPaths(raw: unknown, prefix: string): string[] {
  if (!isRecord(raw)) return [];
  const paths: string[] = [];
  if (hasOwn(raw, "provisionCommand")) {
    paths.push(prefixPath(prefix, "provisionCommand"));
  }
  if (hasOwn(raw, "teardownCommand")) {
    paths.push(prefixPath(prefix, "teardownCommand"));
  }
  if (hasOwn(raw, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function assertNoAgentHostWorkspaceCommandMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot modify host-executed workspace commands (${paths.join(", ")}).`,
  );
}

export function collectAgentAdapterWorkspaceCommandPaths(
  adapterConfig: unknown,
  prefix = "adapterConfig",
): string[] {
  if (!isRecord(adapterConfig)) return [];
  return collectWorkspaceStrategyCommandPaths(
    adapterConfig.workspaceStrategy,
    `${prefix}.workspaceStrategy`,
  );
}

export function collectProjectExecutionWorkspaceCommandPaths(policy: unknown): string[] {
  if (!isRecord(policy)) return [];
  return collectWorkspaceStrategyCommandPaths(
    policy.workspaceStrategy,
    "executionWorkspacePolicy.workspaceStrategy",
  );
}

/**
 * PEN-5226 — `setupCommand` is guarded even though nothing executes it today.
 *
 * `cleanupCommand` reaches a shell: `services/workspace-runtime.ts` builds `cleanupCommands` from
 * `input.projectWorkspace?.cleanupCommand` and runs each through `recordWorkspaceCommandOperation`.
 * `setupCommand` has **no executor** — swept repo-wide, its only consumers are the service mapper
 * (`services/projects.ts`), two masked read projections (`publicProjectWorkspace`, and the
 * issue-detail projection in `routes/issues.ts`), portability import/export, the workspace UI edit
 * form and the CLI import. None of them hands it to a shell.
 *
 * It is collected here anyway, and that is deliberate — do NOT remove it as over-caution:
 *
 *   1. The rest of the codebase already treats the column as dangerous. The read side masks it
 *      (`routes/workspace-response.ts`, under the PEN-3073 rule that a string this control plane
 *      hands to a shell is withheld wherever it is stored), and `services/company-portability.ts`
 *      treats it as host-executed in BOTH directions — it refuses it on safe import and drops it
 *      from export when it carries an absolute path. Leaving it out of the write guard made this
 *      the one subsystem of three that called it inert, so an agent could set
 *      `project_workspaces.setup_command` and then could not read it back.
 *   2. `doc/plans/workspace-product-model-and-work-product.md` plans to execute it — "`setupCommand`
 *      and `cleanupCommand` should be allowed here for workspace-root bootstrap". The guard has to
 *      exist BEFORE the executor lands, not be remembered on the day it does.
 *
 * So the invariant this collector encodes is the write-side mirror of the read-side mask: the two
 * project-workspace command columns are agent-immutable as a pair. If a third command column is
 * added to `project_workspaces`, add it here in the same commit that adds it to the mask.
 *
 * This takes nothing away from board users or the workspace UI — neither passes through
 * `assertNoAgentHostWorkspaceCommandMutation`, which returns early for any non-agent actor.
 */
export function collectProjectWorkspaceCommandPaths(
  workspacePatch: unknown,
  prefix = "",
): string[] {
  if (!isRecord(workspacePatch)) return [];
  const paths: string[] = [];
  if (hasOwn(workspacePatch, "setupCommand")) {
    paths.push(prefixPath(prefix, "setupCommand"));
  }
  if (hasOwn(workspacePatch, "cleanupCommand")) {
    paths.push(prefixPath(prefix, "cleanupCommand"));
  }
  return paths;
}

export function collectIssueWorkspaceCommandPaths(input: {
  executionWorkspaceSettings?: unknown;
  assigneeAdapterOverrides?: unknown;
}): string[] {
  const paths: string[] = [];
  if (isRecord(input.executionWorkspaceSettings)) {
    paths.push(
      ...collectWorkspaceStrategyCommandPaths(
        input.executionWorkspaceSettings.workspaceStrategy,
        "executionWorkspaceSettings.workspaceStrategy",
      ),
    );
  }
  if (isRecord(input.assigneeAdapterOverrides)) {
    const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
    if (isRecord(adapterConfig)) {
      paths.push(
        ...collectWorkspaceStrategyCommandPaths(
          adapterConfig.workspaceStrategy,
          "assigneeAdapterOverrides.adapterConfig.workspaceStrategy",
        ),
      );
    }
  }
  return paths;
}

/**
 * PEN-6418 — the keys an AGENT actor may set in an issue's
 * `assigneeAdapterOverrides.adapterConfig`. It is an ALLOWLIST, and it is EMPTY.
 *
 * Why an allowlist and not a fifth denylist entry. `adapterConfig` is typed
 * `z.record(z.string(), z.unknown())` (`packages/shared/src/validators/issue.ts`)
 * — arbitrary keys, arbitrary values — and `services/heartbeat.ts` overlays it
 * LAST onto the run config that renders the agent Job pod. Three separate keys
 * have been closed one at a time after somebody noticed them
 * (`enableGitHubPublishBroker`, PEN-5017; the four `workspaceStrategy` command
 * paths, PEN-5225; `serviceAccountName`, PEN-6247), each time against a schema
 * that admits every key. A denylist over an open record is exactly as complete
 * as its last edit; the set of pod-security-relevant keys has never been
 * enumerated, and an empty allowlist is the one shape that does not require
 * that enumeration to be complete before it is safe.
 *
 * Why EMPTY rather than "the keys we can justify". Measured company-wide
 * 2026-11-10 (PEN-6418 §3, census paged to exhaustion and reproduced): of 5,822
 * issue rows, 589 carry `assigneeAdapterOverrides`, **583 of those carry only
 * the typed `modelProfile`**, and the 4 carrying a non-empty `adapterConfig`
 * are all `done`/`cancelled`. Zero non-terminal rows depend on this surface, so
 * starting empty costs nothing live and makes every future addition a
 * deliberate, reviewed act rather than an omission.
 *
 * ⚠ THE COST, STATED. This is a real capability loss for AGENT actors, and it
 * is not nil: `paperclipCreateIssue` / `paperclipUpdateIssue` merge the shared
 * issue schemas, so an agent CAN reach this field today, and one historical row
 * (PEN-2019, `done`) used `adapterConfig.model`. The sanctioned replacement is
 * the sibling `modelProfile`, a typed `z.enum` under the same `.strict()`
 * object with 583 live uses, which this list does not touch.
 *
 * ⚠ NOT a cost for the board or the UI. `assertNoAgentIssueAdapterConfigMutation`
 * returns early for any actor that is not an agent, so the UI's "custom model
 * lane" (`ui/src/lib/issue-assignee-overrides.ts`, which emits
 * `adapterConfig.model` / `.effort` / `.variant` / `.modelReasoningEffort` /
 * `.chrome`) keeps working unchanged. Pinned by the non-agent control in
 * `issue-workspace-command-authz.test.ts`.
 *
 * ⚠ ADDING A KEY. Membership is pinned by a test, so adding one is deliberate.
 * The question to answer is not "is this key harmless?" but "is it harmless
 * when set by the LOWEST-privileged principal that can write an issue, on
 * ANOTHER agent's row?" — cross-seat overlay writes are admitted by the
 * assignment gate and durably persisted (PEN-6418, measured n=2). And note that
 * the VALUE stays `unknown`: permitting a key here permits every value of it,
 * so a key whose safety depends on its value needs a type as well as an entry.
 *
 * ⚠ SCOPE. `adapterConfig` was not the only bare
 * `z.record(z.string(), z.unknown())` an agent could write on an issue:
 * `executionWorkspaceSettings.workspaceRuntime` was a second one on the same
 * four routes, and this allowlist does not reach it. That residual was carried
 * as PEN-6430 rather than silently widened into — the blast-radius census that
 * justifies an empty permitted set was taken over `adapterConfig` alone — and
 * PEN-6430 has since CLOSED it, with its own census, through a separate
 * field-level refusal below (`collectAgentDisallowedIssueWorkspaceRuntimePaths`)
 * rather than by extending this list. ⇒ as of PEN-6430 there is no bare open
 * record left on the agent-reachable issue write surface, which is why
 * `issue-comment-reopen-routes.test.ts` no longer bounds its denied-payload
 * fixtures on one.
 *
 * ⚠ THIS IS THE WRITE SIDE ONLY. `AGENT_SCOPE_ONLY_CONFIG_KEYS` in
 * `services/heartbeat.ts` answers a different question — which SCOPE wins at
 * render — and deliberately DISCARDS rather than throws, because refusing to
 * render would let anyone who can assign an issue brick another agent's
 * dispatch. That reasoning is untouched here: an API refusal lands on the
 * WRITER, not on the target agent, so it creates no such denial of service.
 * Both layers, not either: this one cannot reach an overlay already stored, or
 * one written by a non-agent actor.
 */
export const AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS: ReadonlySet<string> = new Set<string>();

export function collectAgentDisallowedIssueAdapterConfigPaths(input: {
  assigneeAdapterOverrides?: unknown;
}): string[] {
  if (!isRecord(input.assigneeAdapterOverrides)) return [];
  const adapterConfig = input.assigneeAdapterOverrides.adapterConfig;
  if (!isRecord(adapterConfig)) return [];
  // Sorted so the refusal message is deterministic for an arbitrary input
  // object, whose key order is the caller's.
  return Object.keys(adapterConfig)
    .filter((key) => !AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS.has(key))
    .sort()
    .map((key) => prefixPath("assigneeAdapterOverrides.adapterConfig", key));
}

export function assertNoAgentIssueAdapterConfigMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot set issue adapter config overrides (${paths.join(", ")}). `
      + "Use `assigneeAdapterOverrides.modelProfile` for model selection; every other "
      + "`adapterConfig` key is agent-immutable on an issue.",
  );
}

/**
 * PEN-6430 — `executionWorkspaceSettings.workspaceRuntime` is refused WHOLE for
 * an AGENT actor. This is deliberately NOT the allowlist shape its sibling
 * `AGENT_PERMITTED_ISSUE_ADAPTER_CONFIG_KEYS` takes one screen up, and the
 * difference is the read side.
 *
 * WHY NOT AN ALLOWLIST. An allowlist's premise is that some key might one day
 * be permitted. Here that premise is false for EVERY key: `workspace_runtime:read`
 * is unmapped in `permissionForAction` and is not a `PermissionKey` at all
 * (`services/authorization.ts`), so no grant row exists that could deliver it —
 * there is no key an agent could write and then verify. A permanently-empty
 * allowlist would invite a later addition made without re-deriving that
 * asymmetry; a field-level refusal states the actual reason.
 *
 * WHY IT MATTERS. The field is an open `z.record(z.string(), z.unknown())`
 * (`packages/shared/src/validators/issue.ts`) on the same `createIssueBaseSchema`
 * object as `adapterConfig`, so it is reachable from the same four agent routes.
 * It is not inert: `parseIssueExecutionWorkspaceSettings` spreads it VERBATIM
 * with no key filtering, `services/execution-workspace-policy.ts` clones it into
 * the execution workspace's `config.workspaceRuntime`, and
 * `routes/execution-workspaces.ts` lifts `entry.command` out of it and hands it
 * to `startRuntimeServicesForWorkspaceControl`, which starts host processes.
 * `authorization.ts` says it outright: the field "routinely carries service
 * commands and the environment they run with".
 *
 * ⚠ THIS IS THE WRITE-SIDE MIRROR OF THE READ-SIDE MASK, which is the invariant
 * `collectProjectWorkspaceCommandPaths` above already encodes (PEN-5226).
 * `workspaceRuntime` was the one field where the two sides disagreed: masked on
 * read (PEN-3252 / PEN-3073), collected by nothing on write.
 *
 * ⚠ BLAST RADIUS, MEASURED. Company-wide census 2026-11-10 (PEN-6430 §DW1, every
 * id enumerated, detail route only — the LIST route projects this column as
 * `sql<null>`null`` and answers the question with a confident wrong zero):
 * 5,838 rows, 0 read errors, 2,560 carrying a non-null
 * `executionWorkspaceSettings`, and the COMPLETE set of key names company-wide is
 * `mode` (2,183) and `workspaceStrategy` (4), plus 373 empty objects.
 * **`workspaceRuntime`: zero rows.** Nothing live depends on this for an agent.
 *
 * ⚠ NOT a cost for the board or the UI: the assert below returns early for any
 * actor that is not an agent, pinned by the non-agent control in
 * `issue-workspace-command-authz.test.ts`.
 *
 * ⚠ SCOPE. `executionWorkspaceSettings.workspaceStrategy` is untouched — its two
 * host-command keys stay with the denylist in `collectIssueWorkspaceCommandPaths`
 * and the rest of that typed object remains agent-writable.
 */
export function collectAgentDisallowedIssueWorkspaceRuntimePaths(input: {
  executionWorkspaceSettings?: unknown;
}): string[] {
  if (!isRecord(input.executionWorkspaceSettings)) return [];
  // No separate `hasOwn` presence test, and its absence is deliberate rather
  // than an oversight: an absent key already reads `undefined` and is caught by
  // the nullish test below, so a presence test is REDUNDANT here — mutation
  // testing confirmed it, deleting it alone left all 19 arms green. The one
  // case where the two could differ is an OWN key explicitly set to
  // `undefined`, which `express.json()` cannot produce because its bodies are
  // `JSON.parse` output. Belt-and-braces inside one assertion is not defence in
  // depth, it is a branch no test can red; the sibling collectors use `hasOwn`
  // because they ask a genuinely different question (is this key present at
  // all, whatever its value).
  const value = input.executionWorkspaceSettings.workspaceRuntime;
  // `null` / `undefined` are the one admitted write, and the reason is measured
  // rather than assumed. `parseIssueExecutionWorkspaceSettings` drops a nullish
  // `workspaceRuntime` entirely, and BLO-27706 makes an absent key mean "leave
  // the shared workspace config intact" — so a nullish write provably cannot
  // reach `config.workspaceRuntime` at all, let alone introduce a command. It
  // can only remove the key from the ISSUE ROW's own settings object, which is
  // the one undo an agent has for a field it cannot read back.
  //
  // ⛔ `{}` is NOT in that class and is refused with everything else, even
  // though the sibling `adapterConfig: {}` is admitted. That guard enumerates
  // keys, so an empty record yields no paths; here an empty record is a real
  // value — `parse` emits `{ workspaceRuntime: {} }` because `{}` is truthy,
  // and the BLO-27706 control proves a supplied value is written THROUGH to the
  // shared `config.workspaceRuntime`. An empty record therefore REPLACES
  // whatever services an operator configured. The asymmetry is deliberate.
  //
  // Refusing a non-nullish value also closes a read/write round-trip hazard:
  // the withheld projection returns a MASKED OBJECT whose leaves are
  // `REDACTED_EVENT_VALUE` (`maskWorkspaceRuntimeForRead`), not `null`, so an
  // agent that read an issue and PATCHed its settings back would otherwise
  // write redaction markers over a live operator record.
  if (value === null || value === undefined) return [];
  return ["executionWorkspaceSettings.workspaceRuntime"];
}

export function assertNoAgentIssueWorkspaceRuntimeMutation(req: Request, paths: string[]) {
  if (req.actor.type !== "agent" || paths.length === 0) return;
  throw forbidden(
    `Agent keys cannot set issue execution workspace runtime config (${paths.join(", ")}). `
      + "`executionWorkspaceSettings.workspaceRuntime` is an open record that reaches host "
      + "process execution and is withheld from agent reads, so it is agent-immutable on an "
      + "issue; send `null` to clear it.",
  );
}

/**
 * The single guard the issue write routes call. One call per site on purpose:
 * the four entry points that admit `assigneeAdapterOverrides`
 * (`POST /companies/:companyId/issues`, `POST /issues/:id/children`,
 * `POST /issues/:id/accepted-plan-decompositions`, `PATCH /issues/:id`) are the
 * complete set — they are exactly the routes validated by a schema built on
 * `createIssueBaseSchema` — and a fifth one must not be able to pick up half of
 * this.
 *
 * ⚠ ORDER IS LOAD-BEARING FOR THE MESSAGE, not for the verdict. The
 * host-command refusal runs first so a body tripping both guards still reports
 * the more specific message, which names the path that actually reaches a
 * shell. Pinned by the two denylist tests in
 * `issue-workspace-command-authz.test.ts`.
 *
 * PEN-6430 added the third assert and APPENDED it rather than inserting it: the
 * denylist is more specific than either field refusal because it names the
 * literal command string, while the adapter-config and workspace-runtime
 * refusals are both whole-field and are at the same level of specificity, so
 * their relative order is arbitrary and is pinned only so a reader can see that
 * it was chosen rather than inherited. Every ordering refuses the same bodies.
 */
export function assertNoAgentIssueHostControlledMutation(req: Request, body: unknown) {
  const input = isRecord(body) ? body : {};
  assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(input));
  assertNoAgentIssueAdapterConfigMutation(req, collectAgentDisallowedIssueAdapterConfigPaths(input));
  assertNoAgentIssueWorkspaceRuntimeMutation(
    req,
    collectAgentDisallowedIssueWorkspaceRuntimePaths(input),
  );
}

export function collectExecutionWorkspaceCommandPaths(input: {
  config?: unknown;
  metadata?: unknown;
}): string[] {
  const paths: string[] = [];
  if (input.config !== undefined) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.config, "config"));
  }
  if (isRecord(input.metadata) && hasOwn(input.metadata, "config")) {
    paths.push(...collectExecutionWorkspaceConfigCommandPaths(input.metadata.config, "metadata.config"));
  }
  return paths;
}

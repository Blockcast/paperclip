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
 * ⚠ SCOPE, AND THE RESIDUAL THIS DOES NOT COVER. `adapterConfig` is not the
 * only bare `z.record(z.string(), z.unknown())` an agent can write on an issue:
 * `executionWorkspaceSettings.workspaceRuntime` is a second one on the same
 * four routes, and this allowlist does not reach it. It is named here rather
 * than silently widened into — the blast-radius census that justifies an empty
 * permitted set was taken over `adapterConfig` alone, and extending an
 * unmeasured field would be the unscoped change PEN-6418 exists to avoid. It is
 * carried as a follow-up, and `issue-comment-reopen-routes.test.ts` now uses
 * that field for its denied-payload-bounding fixtures precisely because it is
 * the open record that remains.
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
 */
export function assertNoAgentIssueHostControlledMutation(req: Request, body: unknown) {
  const input = isRecord(body) ? body : {};
  assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(input));
  assertNoAgentIssueAdapterConfigMutation(req, collectAgentDisallowedIssueAdapterConfigPaths(input));
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

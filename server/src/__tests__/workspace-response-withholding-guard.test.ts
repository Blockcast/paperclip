import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEnvConfig, ExecutionWorkspace, ProjectWorkspace } from "@paperclipai/shared";
import {
  WITHHELD_WORKSPACE_RUNTIME_VIEWER,
  publicExecutionWorkspace,
  publicProjectWorkspace,
} from "../routes/workspace-response.js";
import { PROJECT_ENV_VALUE_MASK, maskProjectEnv } from "../routes/project-env-response.js";

/**
 * PEN-2852 / PEN-2370 ask 3 criterion (b2) — a control that closes a CLASS rather than the nine
 * spellings this ticket happened to enumerate.
 *
 * Doors #8–#13 of the PEN-2370 series were all the same shape: a handler answers with a row that
 * carries operator-authored secret-bearing config, because nothing forces a new response through
 * the withholding boundary. Patching the nine known handlers does not stop the tenth; this guard
 * does, by failing CI when a workspace-shaped value reaches a response without passing through
 * `publicExecutionWorkspace*` / `publicProjectWorkspace*` / `publicProject*`.
 *
 * ⚠️ Scope, stated precisely so nobody reads more assurance into a green run than it earns:
 *
 *  - It covers the route modules listed in `COVERED_ROUTE_MODULES`. That list no longer goes stale
 *    silently: "requires every route module that can answer with workspace rows to be covered"
 *    fails CI when a module outside the list starts binding workspace rows, so a NEW door is caught
 *    even though the scan itself is file-scoped. What remains outside the check is a module that
 *    obtains a workspace row without going through a workspace service — see
 *    `moduleCanAnswerWithWorkspaceRows` for why that predicate is deliberately two-part.
 *  - It matches on the response ARGUMENT's identifier text. Renaming a raw workspace variable to
 *    something without "workspace" in it evades it — unless the value came from a tracked service,
 *    which is what the producer scan is for. It is built against the accidental new handler, not
 *    against deliberate evasion.
 *  - A site clears the check if ANY withholding helper appears anywhere in its argument. In a large
 *    object literal with several nouns, one wrapped noun therefore vouches for the rest. Tightening
 *    that is worthwhile and is not done here. Since `issues.ts` joined the scan, the site where
 *    this bites is the `GET /issues/:id` detail response (`issues.ts:8540` at time of writing):
 *    ONE `res.json` argument carries all four exits, so `project: compactIssueProject(…)` alone
 *    clears it — deleting the `publicProjects(…)` wrapper from `mentionedProjects` would leave the
 *    scan green. What holds that line instead is route-driven, not textual: the three withholding
 *    tests in `issue-detail-workspace-runtime-withholding.test.ts` assert on the serialized body
 *    and each fails alone under its own mutation. Anyone tightening this bullet should test
 *    against that site, because it is the one the limit is load-bearing for.
 *  - The first cases below are POSITIVE CONTROLS: they prove the detector actually fires on an
 *    unwrapped response, under both nouns the material travels under. Without them, a green run
 *    could mean "no violations" or "the detector matches nothing", and those are different claims.
 *
 * `issues.ts` was added after the fact (see `MODULE_SCANS`), and adding it found a real door the
 * two-module version could not see: the closed-workspace 409 in `respondClosedIssueExecutionWorkspace`
 * served a full row behind a five-field declared type.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(HERE, "..", "routes");

/** Route modules that answer with execution-workspace or project-workspace rows. */
const COVERED_ROUTE_MODULES = ["execution-workspaces.ts", "projects.ts", "issues.ts"];

/**
 * Helpers that clear the WORKSPACE-RUNTIME axis. This is not the file's only helper list, and the
 * omission readers notice first is deliberate: the project `env` axis has its own
 * {@link ENV_WITHHOLDING_HELPERS}, and `maskProjectEnv` / `maskEnvBindings` must NOT be added here.
 * The reason is measured rather than asserted — see "keeps the env masks out of the workspace
 * helper list" below, which fails if anyone makes that edit.
 */
const WITHHOLDING_HELPERS = [
  "publicExecutionWorkspace",
  "publicExecutionWorkspaces",
  "publicProjectWorkspace",
  "publicProjectWorkspaces",
  "publicProject",
  "publicProjects",
  // A narrowing rather than a mask, but it is the boundary's answer for error bodies that must
  // identify a workspace without describing it. See `workspace-response.ts`.
  "executionWorkspaceIdentity",
];

/**
 * Identifiers whose responses carry withheld material. `project` is here because a Project response
 * EMBEDS `workspaces[]` and `primaryWorkspace`, built by the same mapper — so `res.json(project)`
 * is an exit for this material even though the word "workspace" never appears in it. That exit was
 * missed by the first version of this guard, which is why the pattern is a list rather than one
 * regex: the material travels under more than one noun.
 */
const RESPONSE_SHAPES_CARRYING_WORKSPACE_CONFIG = [
  /\bworkspaces?\b/i,
  /\bproject\b/i,
];

/**
 * Service methods that return a value carrying (or embedding) workspace config. Any local bound to
 * one of these is treated as a withheld-material noun for that module, whatever it is called.
 *
 * This exists because matching on the NAME alone missed a real exit: the reconcile-branch handler
 * answers with `res.json(result)`, and `result.workspace` is a full row. Tracking the producer
 * rather than the identifier is what turns this from a check on nine spellings into a check on the
 * values themselves — the difference PEN-2370 ask 3 is actually asking for.
 */
const WORKSPACE_BEARING_PRODUCERS = [
  "getById",
  "list",
  "listWorkspaces",
  "create",
  "createWorkspace",
  "update",
  "updateWorkspace",
  "deleteWorkspace",
  "reconcileExecutionWorkspaceBranch",
];

/**
 * Names bound by a destructuring pattern's interior, e.g. `workspace, created` or `workspace: ws`.
 *
 * An identifier followed by `:` is a KEY, which binds nothing — its value is the binding, so
 * `workspace: ws` yields `ws`. Every other identifier is taken, which handles plain bindings, rest
 * elements (`...rest`) and nested patterns (`config: { workspaceRuntime }` yields `workspaceRuntime`)
 * without a second parser. A default (`workspace = fallback`) also contributes the identifiers in
 * its expression; that over-collects, in the same safe direction as the loose initializer match.
 */
function namesInDestructuringPattern(interior: string): string[] {
  const names: string[] = [];
  const token = /([A-Za-z_$][\w$]*)\s*(:)?/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(interior)) !== null) {
    if (!match[2]) names.push(match[1]!);
  }
  return names;
}

/** Locals in `source` bound to a workspace-bearing service call, e.g. `const result = await svc.x()`. */
export function collectWorkspaceBearingLocals(
  source: string,
  receivers: string[] = [],
  producerMethods: string[] = WORKSPACE_BEARING_PRODUCERS,
): string[] {
  const names = new Set<string>();
  const producers = producerMethods.join("|");
  // The initializer is matched loosely — anywhere on the line — so the dominant idiom in these
  // modules, `const existing = await getAccessibleResource(req, res, svc.getById(id), ...)`, is
  // caught too. Loose matching over-collects rather than under-collects: a spurious noun makes CI
  // demand a wrapper that was not strictly needed, which is the safe direction to be wrong in.
  //
  // The binding is an identifier OR a destructuring pattern. Matching only the identifier would
  // under-collect, and under-collection is not symmetric with the over-collection above: a module
  // whose producer results are ALL destructured reports no locals, which
  // `moduleCanAnswerWithWorkspaceRows` cannot distinguish from `environments.ts` — so the module
  // drops out of the coverage check into the bucket documented as safe. `const { workspace, created }
  // = await svc.create(...)` is the natural shape for the `create`/`update` producers listed above.
  // The pattern body allows one level of nesting, so `{ config: { workspaceRuntime } }` — the same
  // hole one level deeper, and the one that destructures the withheld field directly — is caught too.
  //
  // `receivers` narrows the producer call to a named service. Empty means any receiver, which is
  // right for the two modules whose services are ALL workspace services. It does not transfer to a
  // module that talks to thirty of them — see `MODULE_SCANS`.
  const receiverPrefix = receivers.length > 0 ? `(?:${receivers.join("|")})\\s*\\.\\s*` : "";
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+(?:([A-Za-z_$][\\w$]*)|\\{((?:[^{}]|\\{[^{}]*\\})*)\\})\\s*=` +
      `[^;\\n]*\\b${receiverPrefix}(?:${producers})\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) names.add(match[1]);
    else if (match[2]) for (const name of namesInDestructuringPattern(match[2])) names.add(name);
  }
  return [...names];
}

/**
 * The service factories that hand back rows carrying workspace runtime config. `projectService` is
 * here because a project row embeds `workspaces[]` and `primaryWorkspace` — the noun the material
 * travels under in `projects.ts` and `issues.ts`.
 */
const WORKSPACE_SERVICE_EXPORTS = ["executionWorkspaceService", "projectService"];

/**
 * Receivers in `source` bound to a workspace service, e.g. `const svc = executionWorkspaceService(db)`.
 *
 * Import aliases are resolved rather than assumed away. `issues.ts` does
 * `import { executionWorkspaceService as executionWorkspaceServiceDirect }`, so a scan that grepped
 * the canonical export name would have found nothing in the one module this series proved was
 * leaking — a vacuous pass on the door we already know about. The local binding is what the call
 * site uses, so the local binding is what this resolves.
 *
 * The import scan runs over the whole source rather than over import statements, so a mention of an
 * export name in a comment or a type position also contributes a local name. That is deliberate and
 * should not be "fixed" into something import-scoped: over-collecting a receiver can only DEMAND
 * coverage, never excuse it, which is the same safe direction the loose initializer match above
 * takes.
 */
export function collectWorkspaceServiceReceivers(
  source: string,
  serviceExports: string[] = WORKSPACE_SERVICE_EXPORTS,
): string[] {
  const localNames = new Set<string>();
  for (const exported of serviceExports) {
    // `{ foo }` binds `foo`; `{ foo as bar }` binds `bar`. Both spellings appear in these modules.
    const imported = new RegExp(`\\b${exported}\\b(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?`, "g");
    let match: RegExpExecArray | null;
    while ((match = imported.exec(source)) !== null) {
      localNames.add(match[1] ?? exported);
    }
  }
  const receivers = new Set<string>();
  for (const local of localNames) {
    const bound = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${local}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = bound.exec(source)) !== null) {
      if (match[1]) receivers.add(match[1]);
    }
  }
  return [...receivers];
}

/**
 * Whether `source` can answer with a workspace row: it binds a workspace service AND binds that
 * service's row-producing calls into locals.
 *
 * Both halves are load-bearing, and the second is what keeps this check honest. The obvious
 * predicate — "the module imports a workspace service" — is WRONG, and `environments.ts` is the
 * counter-example: it constructs `executionWorkspaceService` and calls
 * `clearEnvironmentSelection(...)` inside a `Promise.all`, discarding the result, then answers with
 * an environment row. Requiring it to be covered would put a permanent red on a module that
 * discloses nothing, and a guard that cries wolf is a guard somebody deletes.
 *
 * Reusing `collectWorkspaceBearingLocals` rather than writing a second producer list is deliberate:
 * one definition of "this call yields a workspace row", so the scan and this check cannot drift
 * into disagreeing about what they are looking for. Note what that reuse means for a FALSE result:
 * it says the module binds no producer result under any spelling the collector knows — identifier
 * or destructuring pattern — not merely that the obvious spelling is absent.
 */
export function moduleCanAnswerWithWorkspaceRows(source: string): boolean {
  const receivers = collectWorkspaceServiceReceivers(source);
  if (receivers.length === 0) return false;
  return collectWorkspaceBearingLocals(source, receivers).length > 0;
}

/**
 * How each covered module is scanned. The two workspace-route modules keep the original settings;
 * `issues.ts` needs its own because the heuristics tuned for them do not transfer.
 *
 * Adding `"issues.ts"` to the array above and nothing else does not work, and the failure is
 * instructive: `WORKSPACE_BEARING_PRODUCERS` are bare method names (`getById`, `list`, `create`,
 * `update`), and in a module with thirty services those bind issue, product and interaction rows.
 * Every `res.json({ error, details: { issueId: issue.id } })` then reads as an unwithheld workspace
 * response — dozens of them, none real. Qualifying the producer by RECEIVER makes the scan track
 * the service rather than the method name, and in this module it collects exactly three locals.
 */
interface ModuleScan {
  /**
   * Service receivers whose results carry workspace material; empty = any receiver.
   *
   * Where non-empty this must equal what `collectWorkspaceServiceReceivers` derives from the module
   * — pinned below. A MISSING entry is the dangerous direction (the scan stops tracking a service
   * and under-collects); a STALE entry is a dead alternation that quietly makes a false claim about
   * the module. Both are drift, so the list is held to equality rather than to a superset.
   */
  producerReceivers: string[];
  /**
   * Module-local wrappers that delegate to the shared boundary. Listing one here is a claim that it
   * withholds — the claim is checked, not assumed, by the delegation test below.
   */
  localWithholdingHelpers: string[];
}

const MODULE_SCANS: Record<string, ModuleScan> = {
  "execution-workspaces.ts": { producerReceivers: [], localWithholdingHelpers: [] },
  "projects.ts": { producerReceivers: [], localWithholdingHelpers: [] },
  "issues.ts": {
    producerReceivers: ["projectsSvc", "executionWorkspacesSvc"],
    localWithholdingHelpers: [
      "compactIssueProjectWorkspace",
      "compactIssueExecutionWorkspace",
      "compactIssueProject",
    ],
  },
};

/**
 * Module-local wrappers, and the shared boundary function each one must call.
 *
 * `MODULE_SCANS` lets a wrapper stand in for the boundary at a response site; this pins the other
 * half of that bargain. Without it, deleting the `publicProjectWorkspace(...)` line from
 * `compactIssueProjectWorkspace` would silently re-open the door AND keep the scan green, because
 * the response site still names the wrapper. Widening the scan cannot be the only thing holding
 * the line.
 */
const LOCAL_HELPER_DELEGATIONS: Array<{ module: string; wrapper: string; delegate: string }> = [
  {
    module: "issues.ts",
    wrapper: "compactIssueProjectWorkspace",
    delegate: "publicProjectWorkspace",
  },
  {
    module: "issues.ts",
    wrapper: "compactIssueExecutionWorkspace",
    delegate: "publicExecutionWorkspace",
  },
  // `compactIssueProject` does not call a `public*` helper itself — it reaches the boundary through
  // the workspace wrapper above, which is the delegation that matters for the embedded rows.
  {
    module: "issues.ts",
    wrapper: "compactIssueProject",
    delegate: "compactIssueProjectWorkspace",
  },
];

/**
 * Extracts the body of `function <name>(` in `source` by brace matching, or null if absent.
 *
 * The optional `<…>` span matters: the boundary helpers on the env axis are generic
 * (`export function publicProject<T extends { … }>(`), and a version that required `(` immediately
 * after the name returned null for them — which the pins below would have reported as "no such
 * function" rather than as the delegation check they are.
 */
export function extractFunctionBody(source: string, name: string): string | null {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*(?:<[^(]*>)?\\s*\\(`).exec(source);
  if (!declaration) return null;
  const open = source.indexOf("{", declaration.index + declaration[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Response arguments that name a workspace but carry no withheld material, each with the reason it
 * is exempt. An entry here is a claim about a specific shape — not a blanket suppression.
 */
const EXEMPT_ARGUMENT_SHAPES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^workspaces as ExecutionWorkspaceSummary\[\]$/,
    reason: "ExecutionWorkspaceSummary selects explicit columns; it has no config or metadata field",
  },
];

interface ResponseSite {
  module: string;
  line: number;
  argument: string;
}

/** Extracts the argument text of every `res.json(...)` / `res.status(n).json(...)` in `source`. */
export function collectResponseSites(module: string, source: string): ResponseSite[] {
  const sites: ResponseSite[] = [];
  const marker = /\.json\(/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    sites.push({
      module,
      line: source.slice(0, open).split("\n").length,
      argument: source.slice(open + 1, end).trim(),
    });
  }
  return sites;
}

/**
 * Removes comments from an expression, so PROSE inside a response argument is not read as code.
 *
 * These handlers carry explanatory comments INSIDE the object literal they answer with, and those
 * comments discuss the very nouns the scans below match on — `issues.ts:8724` sits inside a
 * `res.json({ … })` argument and reads "these rows are FULL project workspaces". Left in, that
 * sentence is an occurrence of `project` with no field access after it, i.e. indistinguishable from
 * a bare hand-over. The env scan reported it as a violation until this ran first.
 *
 * Ordered before literal-stripping, and `[^:]` guards the `//` branch so a `https://…` inside a
 * string is not mistaken for a line comment before that string has been collapsed.
 */
export function stripComments(expression: string): string {
  return expression.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Removes string and template literals from an expression so the workspace test below matches
 * identifiers rather than prose. Without this, every `res.json({ error: "…workspace not found" })`
 * reads as a violation — the predicate would be satisfied by the error text it was meant to ignore.
 */
export function stripLiterals(expression: string): string {
  return stripComments(expression)
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * Field reads that disclose as much as handing the row over, so `.`/`?.` before one of these is an
 * escape rather than the scalar read the `continue` below assumes.
 *
 * This is a NAMED LIST, not a rule, and deliberately so. The general form — "any object-valued
 * field" — is not decidable from the response text the scan sees, and guessing at it is what would
 * produce the noise the docstring below warns about. These six names come from the boundary's own
 * definition rather than from taste:
 *
 *   - `config` / `runtimeConfig` are the derived views the two masks null `workspaceRuntime` inside;
 *   - `metadata` is what they are derived FROM, and `workspace-response.ts:17-20` states the
 *     consequence outright: *"Withholding the derived view while answering with `metadata` is a
 *     no-op: the same bytes leave one key over. Both exits must close together."* A guard that reads
 *     `workspace.metadata` as innocuous fails exactly the property that module is built on;
 *   - `workspaceRuntime` is the withheld payload itself, reachable in one more hop
 *     (`workspace.config.workspaceRuntime` — already this module's idiom at `issues.ts:7524-7532`);
 *   - `primaryWorkspace` and `workspaces` are whole embedded workspace rows on project responses.
 *     `workspaces` is caught today anyway, but only INCIDENTALLY, because `workspaces` happens to be
 *     one of the tracked nouns. Listing it here means that catch survives someone editing the noun
 *     list, which is the sort of coupling that goes quiet rather than red.
 *
 * Keep this in step with the masks in `workspace-response.ts`: a field that starts being withheld
 * there and is not added here is a field the guard reads as a scalar.
 */
const BOUNDARY_FIELD_READ =
  /^\??\.\s*(config|runtimeConfig|metadata|workspaceRuntime|primaryWorkspace|workspaces)\b/;

/**
 * True when `code` hands the whole value named `noun` to the response, rather than reading a field
 * off it. `project.pauseReason` and `project?.id` disclose one scalar; `project`, `...project` and
 * `{ project }` disclose the row and everything embedded in it.
 *
 * Without this the guard cannot be pointed at a module that merely *mentions* these rows: every
 * `res.json({ error: project.pauseReason … })` reads as a leak. Erring the other way — treating a
 * field read as an escape — is the safe direction in principle, but in practice it produces enough
 * noise that the guard gets switched off, which is not safe at all. `BOUNDARY_FIELD_READ` is the
 * bounded exception: it re-arms that safe direction for the handful of names where "one field" and
 * "the whole disclosure" are the same thing.
 */
export function escapesAsWholeValue(code: string, noun: string): boolean {
  // Enough lookahead to read the FIELD NAME, not just the punctuation: the `.` branch below has to
  // distinguish `workspace.status` from `workspace.metadata`, and those differ only after the dot.
  // The trailing characters are matched ZERO-WIDTH so the walk's `lastIndex` still advances by the
  // noun alone — consuming them would step past a second occurrence lying within the captured span,
  // and the first is precisely the kind that says `continue`.
  const occurrences = new RegExp(`\\b${noun}\\b\\s*(?=(.{0,24}))`, "g");
  let match: RegExpExecArray | null;
  while ((match = occurrences.exec(code)) !== null) {
    const next = match[1] ?? "";
    // Nullish coalescing hands over the WHOLE row (`workspace ?? null`) and merely happens to
    // start with the same character as the two shapes below. It is the dominant idiom in
    // `issues.ts`, so reading it as a field access switches the guard off in the module it was
    // widened to cover.
    if (next.startsWith("??")) return true;
    // Checked BEFORE the `continue` below, and covering `?.` as well as `.`: optional chaining
    // discloses the same bytes as a plain read, so closing only the `.` spelling would leave the
    // class open in the direction a nullable row is actually written.
    if (BOUNDARY_FIELD_READ.test(next)) return true;
    // `.` is a field read; `?` is either optional chaining (`project?.id`) or a ternary TEST
    // (`project ? { … } : null`) — in both cases what reaches the response is decided elsewhere in
    // the expression, and that elsewhere is itself a site this scan sees.
    if (next[0] === "." || next[0] === "?") continue;
    return true;
  }
  return false;
}

/** A response site is a violation when it names a workspace but does not delegate to the boundary. */
export function findUnwithheldWorkspaceResponses(
  sites: ResponseSite[],
  workspaceBearingLocals: string[] = [],
  localWithholdingHelpers: string[] = [],
): ResponseSite[] {
  const helpers = [...WITHHOLDING_HELPERS, ...localWithholdingHelpers];
  return sites.filter((site) => {
    const code = stripLiterals(site.argument);
    const named =
      RESPONSE_SHAPES_CARRYING_WORKSPACE_CONFIG.some((shape) => shape.test(code)) ||
      workspaceBearingLocals.some((name) => new RegExp(`\\b${name}\\b`).test(code));
    if (!named) return false;
    const nouns = [
      ...["workspace", "workspaces", "project"].filter((noun) =>
        new RegExp(`\\b${noun}\\b`, "i").test(code),
      ),
      ...workspaceBearingLocals,
    ];
    if (!nouns.some((noun) => escapesAsWholeValue(code, noun))) return false;
    if (helpers.some((helper) => code.includes(helper))) return false;
    return !EXEMPT_ARGUMENT_SHAPES.some((exempt) => exempt.pattern.test(site.argument.trim()));
  });
}

/* ───────────────────────────── the project `env` axis (PEN-3033, door #17) ─────────────────────
 *
 * Everything above closes ONE disclosure axis: workspace runtime config. Door #17 travels on the
 * same rows under a different field — a project's `env`, where `{ type: "plain", value }` is stored
 * verbatim (`services/secrets.ts`) and was readable by every actor who passed
 * `assertProjectReadAllowed`. Patching the four project exits is the "instance" fix; this scan is
 * the "class" fix, and the two are not the same claim: the workspace scan stays green on a project
 * response that omits `maskProjectEnv`, because a masked env is not what it looks at.
 *
 * Three deliberate differences from the workspace scan above, each one a limitation of that scan
 * that this axis could not afford to inherit:
 *
 *  1. **Per-OCCURRENCE clearing, not per-argument.** Up there, one helper anywhere in the argument
 *     vouches for every noun in it (see the third bullet of the header docstring). On this axis that
 *     is not tolerable: `issues.ts:8706` answers with BOTH a project row and an execution workspace,
 *     so `compactIssueExecutionWorkspace(…)` elsewhere in the same literal would vouch for an
 *     unmasked `project:` sibling. Here a noun clears only if it sits INSIDE a masking call.
 *  2. **No `COVERED_ROUTE_MODULES` list.** The workspace scan is file-scoped with a separate check
 *     to catch a module joining the class; this one simply runs over every route module. A list that
 *     cannot go stale is strictly better than a list plus a staleness check, and the value-shaped
 *     classification below is precise enough to afford it — `linear-auth.ts`'s `projects:
 *     projectMap.size` and `decision-training.ts`'s `projectId: parsed.data.project` are counts and
 *     query echoes, and both classify clean without an exemption entry.
 *  3. **An explicit field projection clears.** `{ id, name, status }` cannot carry `env` whatever
 *     its source row held, so requiring a mask there would be noise. `env:` appearing in such a
 *     projection with anything but `null` puts it straight back in the row bucket.
 */

/** Helpers that mask a project `env` (or delegate to something that does). */
const ENV_WITHHOLDING_HELPERS = [
  "maskProjectEnv",
  "maskEnvBindings",
  // `publicProject`/`publicProjects` do not mask inline — they call `maskProjectEnv` first thing.
  // That claim is pinned by `ENV_HELPER_DELEGATIONS` below rather than trusted.
  "publicProject",
  "publicProjects",
];

/**
 * Module-local projections that withhold `env` themselves. Same bargain as
 * `LOCAL_HELPER_DELEGATIONS`: listing one is a claim, and the claim is checked below.
 */
const ENV_LOCAL_WITHHOLDING_HELPERS: Record<string, string[]> = {
  "issues.ts": ["compactIssueProject"],
};

/**
 * The delegation pins for this axis — the other half of the bargain the helper lists make.
 *
 * `compactIssueProject` is the interesting one: it withholds by writing `env: null` rather than by
 * calling a mask, which is a THIRD spelling of this boundary. Nothing in the scan can tell that
 * apart from an ordinary field projection, so editing that one line to `env: project.env` would
 * re-open door #17 in the widest issue response with every scan still green. This is what fails
 * instead.
 */
const ENV_BOUNDARY_PINS: Array<{ module: string; wrapper: string; contains: string }> = [
  { module: "workspace-response.ts", wrapper: "publicProject", contains: "maskProjectEnv(" },
  { module: "workspace-response.ts", wrapper: "publicProjects", contains: "publicProject(" },
  { module: "issues.ts", wrapper: "compactIssueProject", contains: "env: null" },
];

const PROJECT_SERVICE_EXPORTS = ["projectService"];

/**
 * Producers whose result is a project ROW.
 *
 * Enumerated rather than derived from `WORKSPACE_BEARING_PRODUCERS`, and the difference is not
 * cosmetic: spreading that list in drags `listWorkspaces` / `createWorkspace` / `updateWorkspace`
 * along, whose results are project WORKSPACE rows. Those carry runtime config — the axis above —
 * and no `env`, so tracking them here demanded an env mask at five workspace exits that cannot
 * disclose one. Over-collection is the safe direction for the workspace scan, where a spurious
 * noun only demands a wrapper; on this axis it is the noise that gets a guard deleted.
 *
 * `remove` is here and absent up there for the mirror-image reason: the deleted row it returns has
 * no `workspaces[]`, so it sits outside `publicProject`'s constraint and outside the workspace axis
 * entirely — but it still carries `env`, and `projects.ts:721` is exactly that exit.
 */
const PROJECT_ROW_PRODUCERS = ["getById", "list", "listByIds", "create", "update", "remove"];

/** Locals in `source` bound to a project-row producer, e.g. `const deletedProjectRow = svc.remove()`. */
export function collectProjectRowLocals(source: string): string[] {
  const receivers = collectWorkspaceServiceReceivers(source, PROJECT_SERVICE_EXPORTS);
  if (receivers.length === 0) return [];
  return collectWorkspaceBearingLocals(source, receivers, PROJECT_ROW_PRODUCERS);
}

/**
 * Replaces every `<helper>( … )` span with a neutral token, so a noun INSIDE a masking call is
 * cleared and a noun BESIDE one is not. This is the mechanism behind difference (1) above:
 * `publicProject(project, viewer)` clears `project`, while
 * `{ a: publicProject(p, v), b: otherProject }` leaves `otherProject` exposed to the scan.
 */
export function elideMaskedCalls(code: string, helpers: string[]): string {
  let out = code;
  for (const helper of helpers) {
    const call = new RegExp(`\\b${helper}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = call.exec(out)) !== null) {
      const open = match.index + match[0].length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < out.length; i += 1) {
        if (out[i] === "(") depth += 1;
        else if (out[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) break; // unbalanced — leave the rest of the argument to be scanned as-is
      out = `${out.slice(0, match.index)}${MASKED_TOKEN}${out.slice(end + 1)}`;
      call.lastIndex = 0;
    }
  }
  return out;
}

const MASKED_TOKEN = "__MASKED__";

/** The value expression that follows a `:`, to the depth-0 comma or the end of the literal. */
function valueExpression(code: string): string {
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]!;
    if ("{[(".includes(char)) depth += 1;
    else if ("}])".includes(char)) {
      if (depth === 0) return code.slice(0, i);
      depth -= 1;
    } else if (char === "," && depth === 0) return code.slice(0, i);
  }
  return code;
}

/** Splits `test ? consequent : alternate` at depth 0, or null when `expr` is not a ternary. */
function splitTernary(expr: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const char = expr[i]!;
    if ("{[(".includes(char)) depth += 1;
    else if ("}])".includes(char)) depth -= 1;
    else if (char === "?" && depth === 0 && expr[i + 1] !== "." && expr[i + 1] !== "?") {
      let inner = 0;
      for (let j = i + 1; j < expr.length; j += 1) {
        const c = expr[j]!;
        if ("{[(".includes(c)) inner += 1;
        else if ("}])".includes(c)) inner -= 1;
        else if (c === ":" && inner === 0) return [expr.slice(i + 1, j), expr.slice(j + 1)];
      }
    }
  }
  return null;
}

/**
 * What a project-keyed value actually hands over.
 *
 * `row` is the only verdict that discloses: it means the expression can carry whatever `env` the
 * source row held. A ternary is judged by its WORST branch, because the response takes one of them.
 */
export function classifyProjectValue(expression: string): "masked" | "projection" | "row" {
  const value = expression.trim();
  if (value === "") return "row";
  if (value === MASKED_TOKEN) return "masked";
  const branches = splitTernary(value);
  if (branches) {
    const verdicts = branches.map((branch) => classifyProjectValue(branch));
    return verdicts.includes("row") ? "row" : "projection";
  }
  if (value.startsWith("{")) {
    // A spread re-admits every field of the spread row, `env` included.
    if (/\.\.\.\s*[A-Za-z_$][\w$]*/.test(value)) return "row";
    const envKey = /(?:^|[,{])\s*env\s*:\s*([^,}]*)/.exec(value);
    if (envKey && envKey[1]!.trim() !== "null") return "row";
    return "projection";
  }
  // A count or a literal is not a row. `linear-auth.ts` answers `projects: projectMap.size`.
  if (/^(?:null|undefined|true|false|\d+)$/.test(value)) return "projection";
  if (/\.(?:size|length)\b/.test(value) && !value.includes("(")) return "projection";
  return "row";
}

/**
 * Project nouns handed to a response without passing through the `env` mask.
 *
 * An occurrence is judged by its immediate context: a KEY is judged by its value expression, a read
 * off another object (`parsed.data.project`) discloses whatever that read lands in — which is itself
 * another occurrence in the same argument — and anything else is the row itself.
 */
export function findUnmaskedProjectEnvResponses(
  sites: ResponseSite[],
  projectRowLocals: string[] = [],
  localWithholdingHelpers: string[] = [],
): ResponseSite[] {
  const helpers = [...ENV_WITHHOLDING_HELPERS, ...localWithholdingHelpers];
  const nouns = ["project", "projects", ...projectRowLocals];
  return sites.filter((site) => {
    const code = elideMaskedCalls(stripLiterals(site.argument), helpers);
    for (const noun of nouns) {
      // `[^\w$.?]` excludes `x.project` / `x?.project`: a read off another object is not itself a
      // hand-over, and where it LANDS is a separate occurrence this same loop sees. `\.{3}` is the
      // exception that has to be spelled out — a spread opens with the same character as a field
      // read while doing the opposite, and `{ ...project }` is the shape three of the four real
      // exits are one refactor away from.
      const occurrences = new RegExp(`(?:^|\\.{3}|[^\\w$.?])${noun}\\b`, "g");
      let match: RegExpExecArray | null;
      while ((match = occurrences.exec(code)) !== null) {
        const after = code.slice(match.index + match[0].length).replace(/^\s*/, "");
        if (after.startsWith(":")) {
          if (classifyProjectValue(valueExpression(after.slice(1))) === "row") return true;
          continue;
        }
        // `?? null` hands the row over; `?.` and the ternary TEST do not.
        if (after.startsWith("??")) return true;
        if (after.startsWith(".") || after.startsWith("?")) continue;
        return true;
      }
    }
    return false;
  });
}

describe("workspace response withholding guard (PEN-2852, PEN-2370 (b2))", () => {
  it("keeps the env masks out of the workspace helper list — the two axes clear differently", () => {
    // This file holds TWO scans. `WITHHOLDING_HELPERS` clears the workspace-runtime axis;
    // `ENV_WITHHOLDING_HELPERS` clears the project `env` axis (door #17). Reading the first list
    // alone invites a one-line "fix" — add `maskProjectEnv` / `maskEnvBindings` so "the" guard
    // covers env too — and that edit REGRESSES this axis rather than widening it. The workspace
    // scan clears per ARGUMENT (third bullet of the header docstring): one recognised helper
    // anywhere in a response vouches for every noun in it. Admitting an env mask therefore lets a
    // masked project vouch for a RAW workspace sibling in the same literal.
    //
    // Pinned as a measurement, not as prose, because prose is what gets overruled in review.
    expect(WITHHOLDING_HELPERS).not.toContain("maskProjectEnv");
    expect(WITHHOLDING_HELPERS).not.toContain("maskEnvBindings");

    const mixed = "  res.json({ project: maskProjectEnv(project), workspace });";
    const sites = collectResponseSites("synthetic.ts", mixed);

    // As shipped, the raw workspace sibling is caught.
    expect(findUnwithheldWorkspaceResponses(sites, ["workspace"])).toHaveLength(1);
    // Admitting the env mask to this axis' helper list — the tempting edit — silences that catch.
    // The third argument is appended to `WITHHOLDING_HELPERS`, so this simulates the edit exactly.
    expect(
      findUnwithheldWorkspaceResponses(sites, ["workspace"], ["maskProjectEnv"]),
      "adding an env mask to WITHHOLDING_HELPERS hid a raw workspace row",
    ).toEqual([]);

    // The env axis is not left uncovered by that separation: it recognises the same mask under its
    // own list, with per-OCCURRENCE clearing, which is why the same response classifies correctly
    // there. Coverage of `maskProjectEnv` lives in that scan — it is not missing, it is elsewhere.
    expect(ENV_WITHHOLDING_HELPERS).toEqual(
      expect.arrayContaining(["maskProjectEnv", "maskEnvBindings"]),
    );
    expect(findUnmaskedProjectEnvResponses(sites)).toEqual([]);
  });

  it("detects an unwrapped workspace response — positive control for the detector itself", () => {
    const synthetic = [
      'router.get("/synthetic", async (req, res) => {',
      "  const workspace = await svc.getById(req.params.id);",
      "  res.json(workspace);",
      "});",
    ].join("\n");

    const violations = findUnwithheldWorkspaceResponses(
      collectResponseSites("synthetic.ts", synthetic),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.argument).toBe("workspace");
  });

  it("detects an unwrapped PROJECT response — the exit that embeds workspaces under another noun", () => {
    const synthetic = [
      "  const project = await svc.getById(id);",
      "  res.json(project);",
    ].join("\n");

    const violations = findUnwithheldWorkspaceResponses(
      collectResponseSites("synthetic.ts", synthetic),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.argument).toBe("project");
  });

  it("detects a workspace embedded under an opaque local name, by tracking the producer", () => {
    const synthetic = [
      "  const result = await svc.reconcileExecutionWorkspaceBranch(id, input);",
      "  res.json(result);",
    ].join("\n");

    const violations = findUnwithheldWorkspaceResponses(
      collectResponseSites("synthetic.ts", synthetic),
      collectWorkspaceBearingLocals(synthetic),
    );

    // Name-only matching misses this: "result" contains neither "workspace" nor "project".
    expect(findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", synthetic))).toEqual([]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.argument).toBe("result");
  });

  it("does not flag a response that delegates to the withholding boundary", () => {
    const synthetic = [
      "  res.json(publicExecutionWorkspace(workspace, viewer));",
      // Both keys wrapped, deliberately. This fixture used to read `…, operation });` with the
      // sibling raw — the exact shape that WAS the live door #15 defect in the POST runtime-command
      // handler, sitting in the suite as an example of a clean response. The scan does not track
      // `operation` as a noun, so it was never the guard's verdict that made it look fine; it was
      // the fixture. See the operation cases in `workspace-runtime-response-withholding.test.ts`,
      // which hold that line behaviourally.
      "  res.json({ workspace: publicProjectWorkspace(updatedWorkspace, viewer), operation: publicWorkspaceOperation(operation, viewer) });",
      "  res.json(publicProject(project, viewer));",
    ].join("\n");

    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", synthetic)),
    ).toEqual([]);
  });

  it("ignores workspace wording inside an error message rather than reading it as a response", () => {
    const synthetic = 'res.json({ error: "Execution workspace not found" });';

    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", synthetic)),
    ).toEqual([]);
  });

  it("reads a field off a workspace row as disclosure of that field, not of the row", () => {
    const synthetic = [
      "  res.json({ error: project.pauseReason });",
      "  res.json({ name: workspace?.name, at: project.updatedAt });",
    ].join("\n");

    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", synthetic)),
    ).toEqual([]);

    // Control for the control: the same noun handed over whole IS a violation, so the clean result
    // above is about the field read and not about the noun having stopped matching.
    const whole = "  res.json({ error: project.pauseReason, project });";
    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", whole)),
    ).toHaveLength(1);

    // Spread is a whole-value escape too — everything embedded travels with it.
    const spread = "  res.json({ ...project, extra: 1 });";
    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", spread)),
    ).toHaveLength(1);
  });

  it("reads `?? null` after a workspace row as a whole-value escape, not as a field access", () => {
    // `?` after the noun is `continue`-worthy in two shapes — optional chaining (`workspace?.id`)
    // and the ternary TEST (`workspace ? … : null`) — but nullish coalescing opens with the same
    // character while handing the ROW over. One character of lookahead cannot tell them apart, so
    // the guard has to look at two. This matters more than its size suggests: `?? null` is the
    // dominant idiom in `issues.ts`, so it is what an accidental new handler in the module this
    // guard was widened to cover is most likely to write.
    const coalesced = "  res.json({ executionWorkspace: workspace ?? null });";
    expect(
      findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", coalesced)),
    ).toHaveLength(1);

    // The key is deliberately `executionWorkspace`: it does NOT match `\bworkspace\b`, so the bare
    // value is the only occurrence and the verdict rests entirely on what follows it. Spelling the
    // key `workspace` would pass for the wrong reason — the key would match first and return early.
    expect(escapesAsWholeValue("{ executionWorkspace: workspace ?? null }", "workspace")).toBe(true);

    // The two `?` shapes this must NOT swallow, kept adjacent to the case above so the distinction
    // is visible rather than inferred.
    expect(escapesAsWholeValue("{ id: workspace?.id }", "workspace")).toBe(false);
    expect(
      findUnwithheldWorkspaceResponses(
        collectResponseSites("synthetic.ts", "  res.json({ id: workspace?.id, at: project?.updatedAt });"),
      ),
    ).toEqual([]);
  });

  it("still sees a whole-value escape that follows a field read of the same noun", () => {
    // Guards the lookahead's implementation, not its policy. The scan walks occurrences with a
    // sticky `lastIndex`, so widening the capture beyond one character would step PAST a second
    // occurrence sitting inside the captured span — and the first is exactly the kind that says
    // `continue`. The capture is 24 characters wide (it has to reach the end of a field NAME, not
    // just the dot), which makes that span large enough to swallow a whole second occurrence, so
    // the zero-width match is doing more work here than when it was two. Matching the trailing
    // characters in a lookahead keeps every occurrence reachable; consuming them does not. Anyone
    // simplifying the lookahead away fails here rather than silently narrowing the guard.
    expect(escapesAsWholeValue("{ x: project.project }", "project")).toBe(true);
    expect(escapesAsWholeValue("{ x: workspace?.workspace }", "workspace")).toBe(true);
  });

  it("reads a field read of the boundary's OWN names as a whole-value escape", () => {
    // `config` / `runtimeConfig` are derived views over `metadata`, so answering with any of the
    // three discloses the same bytes one key over — `workspace-response.ts:17-20` says both exits
    // must close together. Reading them as innocuous scalar field reads (which `next[0] === "."`
    // did) means a handler can hand over the withheld payload with the guard green. No live site
    // does this; the guard exists for the handler that has not been written yet, and
    // `workspace.config.<field>` is already this module's idiom at `issues.ts:7524-7532`.
    const locals = ["workspace"];
    const leaks = [
      "  res.json({ config: workspace.config });",
      "  res.json({ metadata: workspace.metadata });",
      "  res.json({ runtimeConfig: workspace.runtimeConfig });",
      "  res.json({ rt: workspace.config.workspaceRuntime });",
      // Optional chaining discloses the same bytes as the plain read. Closing only the `.` spelling
      // would leave the class open in exactly the direction a nullable row is written.
      "  res.json({ metadata: workspace?.metadata });",
    ];
    for (const leak of leaks) {
      expect(
        findUnwithheldWorkspaceResponses(collectResponseSites("synthetic.ts", leak), locals),
        leak,
      ).toHaveLength(1);
    }

    // `primaryWorkspace` hands over a whole embedded row and is NOT itself a tracked noun, so
    // nothing else in the scan sees it.
    expect(escapesAsWholeValue("{ primary: project.primaryWorkspace }", "project")).toBe(true);
  });

  it("does not read an ordinary scalar field off a workspace row as an escape", () => {
    // The negative half of the case above. Widening the `.` branch is the direction that risks
    // noise, and noise is what gets a guard switched off — so the shapes the guard is pointed at
    // real modules to tolerate have to keep classifying clean.
    expect(escapesAsWholeValue("{ error: project.pauseReason }", "project")).toBe(false);
    expect(escapesAsWholeValue("{ status: workspace.status }", "workspace")).toBe(false);
    expect(escapesAsWholeValue("{ name: workspace?.name }", "workspace")).toBe(false);

    // The word boundary is load-bearing, not decoration: a field whose name merely BEGINS with a
    // listed name is an ordinary scalar. Dropping `\b` from `BOUNDARY_FIELD_READ` — the obvious
    // simplification — turns each of these into a violation and fails here.
    expect(escapesAsWholeValue("{ at: workspace.configuredAt }", "workspace")).toBe(false);
    expect(escapesAsWholeValue("{ v: workspace.metadataVersion }", "workspace")).toBe(false);
    expect(escapesAsWholeValue("{ n: project.workspacesCount }", "project")).toBe(false);
  });

  it("lists every top-level field the masks actually withhold", () => {
    // Keeps `BOUNDARY_FIELD_READ` honest against the module it claims to mirror, by BEHAVIOUR
    // rather than by citation: mask a sentinel-bearing row, diff the top-level keys, and require
    // the guard to treat a read of each changed key as an escape. A hand-maintained list drifts the
    // moment the boundary widens — PEN-3073 proposes exactly that — and drift here is silent, since
    // a guard that has stopped covering a field still passes. This fails instead.
    const rawExecution = {
      id: "ws-1",
      config: { workspaceRuntime: { command: "invented-fixture" }, environmentId: "env-1" },
      metadata: { config: { workspaceRuntime: { command: "invented-fixture" } } },
      name: "ws",
      status: "open",
    } as unknown as ExecutionWorkspace;
    const rawProject = {
      id: "pws-1",
      runtimeConfig: { workspaceRuntime: { command: "invented-fixture" } },
      metadata: { runtimeConfig: { workspaceRuntime: { command: "invented-fixture" } } },
      name: "pws",
    } as unknown as ProjectWorkspace;

    const changed = (raw: Record<string, unknown>, masked: Record<string, unknown>) =>
      Object.keys(raw).filter((key) => raw[key] !== masked[key]);

    const withheldKeys = [
      ...changed(
        rawExecution as unknown as Record<string, unknown>,
        publicExecutionWorkspace(rawExecution, WITHHELD_WORKSPACE_RUNTIME_VIEWER) as unknown as Record<
          string,
          unknown
        >,
      ),
      ...changed(
        rawProject as unknown as Record<string, unknown>,
        publicProjectWorkspace(rawProject, WITHHELD_WORKSPACE_RUNTIME_VIEWER) as unknown as Record<
          string,
          unknown
        >,
      ),
    ];

    // Guards the guard: if the masks stopped withholding anything the diff would be empty and every
    // assertion below would pass vacuously.
    expect(new Set(withheldKeys)).toEqual(new Set(["config", "metadata", "runtimeConfig"]));
    for (const key of withheldKeys) {
      expect(BOUNDARY_FIELD_READ.test(`.${key}`), key).toBe(true);
    }
  });

  it("qualifies producers by receiver so a same-named method on another service is not tracked", () => {
    const synthetic = [
      "  const issue = await svc.getById(id);",
      "  const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);",
    ].join("\n");

    // Unqualified: `issue` is collected purely because the method is called `getById`. That is the
    // heuristic that reports dozens of phantom violations in a module with thirty services.
    expect(collectWorkspaceBearingLocals(synthetic).sort()).toEqual(["issue", "workspace"]);
    expect(
      collectWorkspaceBearingLocals(synthetic, ["executionWorkspacesSvc", "projectsSvc"]),
    ).toEqual(["workspace"]);
  });

  it("accepts a module-local wrapper as delegation only where that module declares one", () => {
    const synthetic = "  res.json({ currentExecutionWorkspace: compactIssueExecutionWorkspace(ws, viewer) });";
    const sites = collectResponseSites("issues.ts", synthetic);

    // Undeclared, the wrapper is just an unrecognised call around a workspace noun.
    expect(findUnwithheldWorkspaceResponses(sites, ["ws"])).toHaveLength(1);
    expect(
      findUnwithheldWorkspaceResponses(sites, ["ws"], MODULE_SCANS["issues.ts"]!.localWithholdingHelpers),
    ).toEqual([]);
  });

  it("finds response sites in every covered route module — guards against scanning nothing", () => {
    for (const module of COVERED_ROUTE_MODULES) {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const sites = collectResponseSites(module, source);
      // If a rename or refactor makes this zero, the guard below would pass vacuously.
      expect(sites.length, `${module} produced no response sites`).toBeGreaterThan(0);
      expect(
        sites.some((site) =>
          RESPONSE_SHAPES_CARRYING_WORKSPACE_CONFIG.some((shape) => shape.test(stripLiterals(site.argument))),
        ),
        `${module} produced no workspace-shaped response sites`,
      ).toBe(true);
    }
  });

  it.each(COVERED_ROUTE_MODULES)(
    "%s answers with no un-withheld workspace row",
    (module) => {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const scan = MODULE_SCANS[module];
      expect(scan, `${module} has no scan configuration`).toBeDefined();
      const violations = findUnwithheldWorkspaceResponses(
        collectResponseSites(module, source),
        collectWorkspaceBearingLocals(source, scan!.producerReceivers),
        scan!.localWithholdingHelpers,
      );

      expect(
        violations.map((site) => `${site.module}:${site.line} → res.json(${site.argument})`),
      ).toEqual([]);
    },
  );

  it("collects the workspace-bearing locals it needs in every covered module", () => {
    // A receiver typo would silently collect nothing, and an empty noun list makes the scan above
    // pass by matching nothing rather than by finding nothing.
    for (const module of COVERED_ROUTE_MODULES) {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const locals = collectWorkspaceBearingLocals(source, MODULE_SCANS[module]!.producerReceivers);
      expect(locals.length, `${module} collected no workspace-bearing locals`).toBeGreaterThan(0);
    }
  });

  /**
   * The guard's own blind spot, closed.
   *
   * Every test above scans `COVERED_ROUTE_MODULES` — a hand-maintained list. A workspace response
   * added in a module NOT on that list is not caught, and the list going stale is silent: the suite
   * stays green while coverage shrinks. That is not hypothetical. It is the exact history of this
   * ticket — `issues.ts` was door #13 *because* it was out of scope, and it stayed out of scope
   * until a person went looking. This asks CI the question instead.
   */
  it("requires every route module that can answer with workspace rows to be covered", () => {
    const uncovered = readdirSync(ROUTES_DIR)
      .filter((file) => file.endsWith(".ts") && !COVERED_ROUTE_MODULES.includes(file))
      .filter((file) => moduleCanAnswerWithWorkspaceRows(readFileSync(path.join(ROUTES_DIR, file), "utf8")));

    expect(
      uncovered,
      "these route modules obtain workspace rows but are not in COVERED_ROUTE_MODULES — add them " +
        "to the scan (and give them a MODULE_SCANS entry) rather than deleting this assertion",
    ).toEqual([]);
  });

  it("detects an uncovered module even when it renames the service on import", () => {
    // Positive control for the check above: without it, a green run cannot distinguish "no
    // uncovered module answers with workspace rows" from "the detector resolves no receivers".
    // The alias spelling is the one `issues.ts` actually uses, so this pins the case that matters.
    const aliased = `
      import { executionWorkspaceService as wsSvcDirect } from "../services/execution-workspaces.js";
      export function newRoutes(db) {
        const wsSvc = wsSvcDirect(db);
        router.get("/thing/:id", async (req, res) => {
          const workspace = await wsSvc.getById(req.params.id);
          res.json(workspace);
        });
      }
    `;
    expect(collectWorkspaceServiceReceivers(aliased)).toContain("wsSvc");
    expect(moduleCanAnswerWithWorkspaceRows(aliased)).toBe(true);
  });

  it("detects an uncovered module even when it destructures the producer result", () => {
    // The other half of the resolver, and the more dangerous half. The alias test above pins how the
    // SERVICE is named; this pins how its RESULT is bound. A destructured binding used to collect no
    // locals at all, which did not merely hide one response site — it dropped the whole module out
    // of the coverage check into the `environments.ts` bucket, the one with a written rationale
    // saying the module is safe. `const { … } = await <svc>.<method>(` is an idiom already used in
    // this directory, and `create`/`update` are `WORKSPACE_BEARING_PRODUCERS`.
    const destructured = `
      import { executionWorkspaceService } from "../services/execution-workspaces.js";
      export function newRoutes(db) {
        const wsSvc = executionWorkspaceService(db);
        router.post("/thing", async (req, res) => {
          const { workspace, created } = await wsSvc.create(req.body);
          res.json({ workspace, created });
        });
      }
    `;
    expect(collectWorkspaceBearingLocals(destructured, ["wsSvc"])).toEqual(["workspace", "created"]);
    expect(moduleCanAnswerWithWorkspaceRows(destructured)).toBe(true);

    // The alias spelling inside the pattern binds the alias, since that is the name a response site
    // can mention — a key binds nothing.
    const renamed = destructured.replace("{ workspace, created }", "{ workspace: ws, created }");
    expect(collectWorkspaceBearingLocals(renamed, ["wsSvc"])).toEqual(["ws", "created"]);

    // One level deeper is the same hole, and it is the shape that destructures the withheld field
    // itself. `config` is a key and binds nothing; `workspaceRuntime` is the local that a response
    // site could then mention.
    const nested = destructured.replace("{ workspace, created }", "{ config: { workspaceRuntime } }");
    expect(collectWorkspaceBearingLocals(nested, ["wsSvc"])).toEqual(["workspaceRuntime"]);
    expect(moduleCanAnswerWithWorkspaceRows(nested)).toBe(true);
  });

  it("holds each module's hand-maintained producerReceivers to what the module actually binds", () => {
    // `producerReceivers` NARROWS the scan, so a missing entry silently stops it tracking a service.
    // This commit's own resolver makes the list derivable, so the hand-maintained copy is checked
    // against it rather than trusted — it had already drifted (`projectWorkspacesSvc` was listed and
    // bound nowhere). Equality, not superset: a dead entry is a false claim about the module.
    for (const [module, scan] of Object.entries(MODULE_SCANS)) {
      if (scan.producerReceivers.length === 0) continue; // `[]` means "any receiver" — a different mode.
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      expect(new Set(scan.producerReceivers), `${module} producerReceivers drifted`).toEqual(
        new Set(collectWorkspaceServiceReceivers(source)),
      );
    }
  });

  it("does not demand coverage from a module that only mutates through a workspace service", () => {
    // The true negative that decides the shape of the check, pinned against the real file so a
    // future edit to `environments.ts` that DOES answer with a workspace row flips it.
    //
    // `environments.ts` constructs `executionWorkspaceService` and `projectService`, so the naive
    // "imports a workspace service" predicate would flag it. It calls only
    // `clearEnvironmentSelection(...)` / `clearExecutionWorkspaceEnvironmentSelection(...)`,
    // discards both results inside a `Promise.all`, and answers with an environment row.
    const source = readFileSync(path.join(ROUTES_DIR, "environments.ts"), "utf8");
    expect(collectWorkspaceServiceReceivers(source).length).toBeGreaterThan(0);
    expect(moduleCanAnswerWithWorkspaceRows(source)).toBe(false);
  });

  it("resolves a workspace-service receiver in every covered module", () => {
    // Guards the resolver itself. If `WORKSPACE_SERVICE_EXPORTS` were misspelled, or the alias
    // branch broke, this file would resolve nothing everywhere — and the coverage check above
    // would pass by finding no candidates rather than by finding no gaps.
    for (const module of COVERED_ROUTE_MODULES) {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      expect(
        collectWorkspaceServiceReceivers(source).length,
        `${module} resolved no workspace-service receiver`,
      ).toBeGreaterThan(0);
    }
  });

  it.each(LOCAL_HELPER_DELEGATIONS)(
    "$module: $wrapper delegates to $delegate rather than re-deriving the mask",
    ({ module, wrapper, delegate }) => {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const body = extractFunctionBody(source, wrapper);

      // A renamed or deleted wrapper must fail loudly here, not vanish into a skipped assertion:
      // the scan above treats this name as standing in for the boundary.
      expect(body, `${module} has no function ${wrapper}`).not.toBeNull();
      expect(body).toContain(`${delegate}(`);
    },
  );
});

describe("project env withholding guard (PEN-3033 door #17, PEN-2370 (b2))", () => {
  const routeModules = () => readdirSync(ROUTES_DIR).filter((file) => file.endsWith(".ts"));
  const sitesFor = (source: string) => collectResponseSites("synthetic.ts", source);

  it("detects a project row handed over unmasked — positive control for the detector itself", () => {
    // Without these three, a green run over the real modules cannot be distinguished from a
    // detector that matches nothing. Each is a spelling the four real exits actually use.
    for (const leak of [
      "  res.json(project);",
      "  res.json({ project });",
      "  res.json({ ...project, extra: 1 });",
      "  res.json({ project: project ?? null });",
    ]) {
      expect(findUnmaskedProjectEnvResponses(sitesFor(leak)), leak).toHaveLength(1);
    }
  });

  it("clears a project row that passes through the mask, under each helper spelling", () => {
    for (const masked of [
      "  res.json(maskProjectEnv(project));",
      "  res.json(publicProject(project, viewer));",
      "  res.json(publicProjects(projects, viewer));",
      "  res.json({ ...detail, project: maskProjectEnv(detail.project) });",
      "  res.json({ env: maskEnvBindings(project.env) });",
    ]) {
      expect(findUnmaskedProjectEnvResponses(sitesFor(masked)), masked).toEqual([]);
    }
  });

  it("clears the masked noun only, not an unmasked sibling in the same response", () => {
    // The difference that motivates this scan existing separately. The workspace scan above clears
    // a whole argument when ANY helper appears in it, so this shape is green up there — and
    // `issues.ts:8706` is exactly this shape: a project row beside an execution workspace.
    const mixed = "  res.json({ a: publicProject(project, viewer), b: otherProject });";
    const violations = findUnmaskedProjectEnvResponses(sitesFor(mixed), ["otherProject"]);
    expect(violations).toHaveLength(1);

    // Control for the control: the same site with BOTH nouns masked is clean, so the verdict above
    // is about the unmasked sibling and not about the site being unreadable.
    const both = "  res.json({ a: publicProject(project, viewer), b: maskProjectEnv(otherProject) });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(both), ["otherProject"])).toEqual([]);
  });

  it("reads an explicit field projection as carrying no env — and an `env` key as carrying one", () => {
    // `compactIssueProject`'s shape: a hand-written field list cannot disclose `env` whatever the
    // source row held, and demanding a mask there would be the noise that gets a guard deleted.
    const projection = "  res.json({ project: project ? { id: project.id, name: project.name } : null });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(projection))).toEqual([]);

    // ...unless it names `env`. This is the one-line edit that re-opens door #17 inside a shape the
    // scan would otherwise wave through.
    const reopened = "  res.json({ project: project ? { id: project.id, env: project.env } : null });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(reopened))).toHaveLength(1);

    // `env: null` is the withholding spelling `compactIssueProject` uses, and stays clean.
    const nulled = "  res.json({ project: project ? { id: project.id, env: null } : null });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(nulled))).toEqual([]);

    // A ternary is judged by its WORST branch — the response takes one of them, not both.
    const worstBranch = "  res.json({ project: project ? { id: project.id } : project });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(worstBranch))).toHaveLength(1);
  });

  it("tracks a project row bound to an opaque local, through its producer", () => {
    // `projects.ts:721` — `svc.remove` returns a row with no `workspaces[]`, so it is outside the
    // workspace axis entirely, and the local is not named after anything the noun list knows.
    const synthetic = [
      'import { projectService } from "../services/index.js";',
      "const svc = projectService(db);",
      "const deletedProjectRow = await svc.remove(id);",
      "res.json(deletedProjectRow);",
    ].join("\n");

    // Name-only matching misses it: "deletedProjectRow" is not `\bproject\b`.
    expect(findUnmaskedProjectEnvResponses(sitesFor(synthetic))).toEqual([]);
    expect(collectProjectRowLocals(synthetic)).toContain("deletedProjectRow");
    expect(
      findUnmaskedProjectEnvResponses(sitesFor(synthetic), collectProjectRowLocals(synthetic)),
    ).toHaveLength(1);
  });

  it("does not read a count, a query echo, or prose as a project row", () => {
    // The three shapes that made a value-blind version of this scan report four phantom violations
    // across `linear-auth.ts` and `decision-training.ts`. A guard that cries wolf gets switched off,
    // so these are pinned against regression in the noisy direction as firmly as the leaks above.
    const counts = "  res.json({ ok: true, imported, projects: projectMap.size, labels: labelCache.size });";
    expect(findUnmaskedProjectEnvResponses(sitesFor(counts))).toEqual([]);

    const queryEcho = "  res.json(await svc.list(companyId, { projectId: parsed.data.project }));";
    expect(findUnmaskedProjectEnvResponses(sitesFor(queryEcho))).toEqual([]);

    const prose = [
      "  res.json({",
      "    // these rows are FULL project workspaces, so the mapper is the boundary",
      "    id: issue.id,",
      "  });",
    ].join("\n");
    expect(findUnmaskedProjectEnvResponses(sitesFor(prose))).toEqual([]);
    // And the reason it is clean is the comment stripping, not a noun that stopped matching.
    expect(stripComments("a // project\nb")).not.toContain("project");
  });

  it("masks a plain binding for real — so a green scan is not vouching for a no-op mask", () => {
    // Every assertion above is about TEXT. This one is about BEHAVIOUR: if `maskProjectEnv` stopped
    // masking, the scans would still be green because the helper NAME is still at every exit. The
    // sentinel is asserted by identity against the shared constant, never by a private copy.
    const masked = maskProjectEnv({
      id: "project-1",
      env: {
        PLAIN_OBJECT: { type: "plain", value: "invented-fixture-value" },
        PLAIN_SHORTHAND: "invented-fixture-value",
        POINTER: { type: "secret_ref", ref: "company/FIXTURE" },
      },
    } as { id: string; env: AgentEnvConfig });

    expect(masked.env.PLAIN_OBJECT).toEqual({ type: "plain", value: PROJECT_ENV_VALUE_MASK });
    // Shape-preserving: a shorthand stays a bare string, so the editor reads it the way it always did.
    expect(masked.env.PLAIN_SHORTHAND).toBe(PROJECT_ENV_VALUE_MASK);
    // A pointer carries no material and must survive untouched, or the round trip breaks.
    expect(masked.env.POINTER).toEqual({ type: "secret_ref", ref: "company/FIXTURE" });
    expect(JSON.stringify(masked)).not.toContain("invented-fixture-value");
  });

  it("finds project-shaped response sites in the modules that answer with project rows", () => {
    // Non-vacuity for the scan below. It runs over every route module rather than a list, so the
    // failure mode is not a stale list — it is a rename that leaves the scan matching nothing at
    // all, everywhere, silently.
    for (const module of ["projects.ts", "routines.ts", "issues.ts"]) {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const projectShaped = collectResponseSites(module, source).filter((site) =>
        /\bprojects?\b/i.test(stripLiterals(site.argument)),
      );
      expect(projectShaped.length, `${module} produced no project-shaped response sites`).toBeGreaterThan(0);
    }
  });

  it.each(["projects.ts", "routines.ts"])(
    "%s fails the scan when its mask is removed — the guard is load-bearing on real source",
    (module) => {
      // Mutation control against the REAL file, not a fixture: delete the mask the way a careless
      // refactor would and the scan must go red. Without this, "the real modules are clean" could
      // mean the scan never looks at them.
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const mutated = source
        .replace(/maskProjectEnv\(([^()]*)\)/g, "$1")
        .replace(/publicProjects?\(/g, "identity(");

      const violations = findUnmaskedProjectEnvResponses(
        collectResponseSites(module, mutated),
        collectProjectRowLocals(mutated),
        ENV_LOCAL_WITHHOLDING_HELPERS[module] ?? [],
      );

      expect(violations.length, `${module} stayed green with its mask removed`).toBeGreaterThan(0);
    },
  );

  it("every route module answers with no unmasked project env row", () => {
    // No `COVERED_ROUTE_MODULES` on this axis: a list that cannot go stale beats a list plus a
    // staleness check. A module that starts answering with project rows is scanned the day it is
    // added, with no edit here.
    const violations = routeModules().flatMap((module) => {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      return findUnmaskedProjectEnvResponses(
        collectResponseSites(module, source),
        collectProjectRowLocals(source),
        ENV_LOCAL_WITHHOLDING_HELPERS[module] ?? [],
      );
    });

    expect(
      violations.map((site) => `${site.module}:${site.line} → res.json(${site.argument})`),
      "these responses can carry a project `env` without passing the mask — route them through " +
        "`maskProjectEnv` (or project the fields explicitly) rather than deleting this assertion",
    ).toEqual([]);
  });

  it.each(ENV_BOUNDARY_PINS)(
    "$module: $wrapper withholds env via `$contains`",
    ({ module, wrapper, contains }) => {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      const body = extractFunctionBody(source, wrapper);

      // The scan treats these names as standing in for the mask. A renamed or gutted wrapper has to
      // fail here rather than vanish into a name that no longer means anything.
      expect(body, `${module} has no function ${wrapper}`).not.toBeNull();
      expect(body, `${wrapper} no longer withholds env`).toContain(contains);
    },
  );

  it("declares a local env helper only where that module defines one", () => {
    // `ENV_LOCAL_WITHHOLDING_HELPERS` widens what clears the scan, so a stale entry is a silent
    // hole: the name keeps clearing sites after the function behind it is gone.
    for (const [module, helpers] of Object.entries(ENV_LOCAL_WITHHOLDING_HELPERS)) {
      const source = readFileSync(path.join(ROUTES_DIR, module), "utf8");
      for (const helper of helpers) {
        expect(extractFunctionBody(source, helper), `${module} has no function ${helper}`).not.toBeNull();
      }
    }
  });
});

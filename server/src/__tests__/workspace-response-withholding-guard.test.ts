import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
 *  - It covers the route modules listed in `COVERED_ROUTE_MODULES`. A workspace response added in a
 *    module outside that list is not caught. That is the honest limit of a file-scoped guard, and
 *    the reason this file lists its covered modules explicitly rather than globbing.
 *  - It matches on the response ARGUMENT's identifier text. Renaming a raw workspace variable to
 *    something without "workspace" in it evades it — unless the value came from a tracked service,
 *    which is what the producer scan is for. It is built against the accidental new handler, not
 *    against deliberate evasion.
 *  - A site clears the check if ANY withholding helper appears anywhere in its argument. In a large
 *    object literal with several nouns, one wrapped noun therefore vouches for the rest. Tightening
 *    that is worthwhile and is not done here.
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

/** Locals in `source` bound to a workspace-bearing service call, e.g. `const result = await svc.x()`. */
export function collectWorkspaceBearingLocals(source: string, receivers: string[] = []): string[] {
  const names = new Set<string>();
  const producers = WORKSPACE_BEARING_PRODUCERS.join("|");
  // The initializer is matched loosely — anywhere on the line — so the dominant idiom in these
  // modules, `const existing = await getAccessibleResource(req, res, svc.getById(id), ...)`, is
  // caught too. Loose matching over-collects rather than under-collects: a spurious noun makes CI
  // demand a wrapper that was not strictly needed, which is the safe direction to be wrong in.
  //
  // `receivers` narrows the producer call to a named service. Empty means any receiver, which is
  // right for the two modules whose services are ALL workspace services. It does not transfer to a
  // module that talks to thirty of them — see `MODULE_SCANS`.
  const receiverPrefix = receivers.length > 0 ? `(?:${receivers.join("|")})\\s*\\.\\s*` : "";
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*\\b${receiverPrefix}(?:${producers})\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
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
  /** Service receivers whose results carry workspace material; empty = any receiver. */
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
    producerReceivers: ["projectsSvc", "executionWorkspacesSvc", "projectWorkspacesSvc"],
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

/** Extracts the body of `function <name>(` in `source` by brace matching, or null if absent. */
export function extractFunctionBody(source: string, name: string): string | null {
  const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(source);
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
 * Removes string and template literals from an expression so the workspace test below matches
 * identifiers rather than prose. Without this, every `res.json({ error: "…workspace not found" })`
 * reads as a violation — the predicate would be satisfied by the error text it was meant to ignore.
 */
export function stripLiterals(expression: string): string {
  return expression
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/**
 * True when `code` hands the whole value named `noun` to the response, rather than reading a field
 * off it. `project.pauseReason` and `project?.id` disclose one scalar; `project`, `...project` and
 * `{ project }` disclose the row and everything embedded in it.
 *
 * Without this the guard cannot be pointed at a module that merely *mentions* these rows: every
 * `res.json({ error: project.pauseReason … })` reads as a leak. Erring the other way — treating a
 * field read as an escape — is the safe direction in principle, but in practice it produces enough
 * noise that the guard gets switched off, which is not safe at all.
 */
export function escapesAsWholeValue(code: string, noun: string): boolean {
  const occurrences = new RegExp(`\\b${noun}\\b\\s*(.?)`, "g");
  let match: RegExpExecArray | null;
  while ((match = occurrences.exec(code)) !== null) {
    const next = match[1] ?? "";
    // `.` is a field read; `?` is either optional chaining (`project?.id`) or a ternary TEST
    // (`project ? { … } : null`) — in both cases what reaches the response is decided elsewhere in
    // the expression, and that elsewhere is itself a site this scan sees.
    if (next === "." || next === "?") continue;
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

describe("workspace response withholding guard (PEN-2852, PEN-2370 (b2))", () => {
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
      "  res.json({ workspace: publicProjectWorkspace(updatedWorkspace, viewer), operation });",
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

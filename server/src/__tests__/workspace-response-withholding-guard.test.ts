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
 *  - It covers the two route modules that own workspace responses. A workspace response added in a
 *    THIRD module is not caught. That is the honest limit of a file-scoped guard, and the reason
 *    this file lists its covered modules explicitly rather than globbing.
 *  - It matches on the response ARGUMENT's identifier text. Renaming a raw workspace variable to
 *    something without "workspace" in it evades it. It is built against the accidental new
 *    handler, not against deliberate evasion.
 *  - The first three cases below are POSITIVE CONTROLS: they prove the detector actually fires on
 *    an unwrapped response, under both nouns the material travels under. Without them, a green run
 *    could mean "no violations" or "the detector matches nothing", and those are different claims.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(HERE, "..", "routes");

/** Route modules that answer with execution-workspace or project-workspace rows. */
const COVERED_ROUTE_MODULES = ["execution-workspaces.ts", "projects.ts"];

const WITHHOLDING_HELPERS = [
  "publicExecutionWorkspace",
  "publicExecutionWorkspaces",
  "publicProjectWorkspace",
  "publicProjectWorkspaces",
  "publicProject",
  "publicProjects",
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
export function collectWorkspaceBearingLocals(source: string): string[] {
  const names = new Set<string>();
  const producers = WORKSPACE_BEARING_PRODUCERS.join("|");
  // The initializer is matched loosely — anywhere on the line — so the dominant idiom in these
  // modules, `const existing = await getAccessibleResource(req, res, svc.getById(id), ...)`, is
  // caught too. Loose matching over-collects rather than under-collects: a spurious noun makes CI
  // demand a wrapper that was not strictly needed, which is the safe direction to be wrong in.
  const pattern = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*\\b(?:${producers})\\(`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
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

/** A response site is a violation when it names a workspace but does not delegate to the boundary. */
export function findUnwithheldWorkspaceResponses(
  sites: ResponseSite[],
  workspaceBearingLocals: string[] = [],
): ResponseSite[] {
  const shapes = [
    ...RESPONSE_SHAPES_CARRYING_WORKSPACE_CONFIG,
    ...workspaceBearingLocals.map((name) => new RegExp(`\\b${name}\\b`)),
  ];
  return sites.filter((site) => {
    const code = stripLiterals(site.argument);
    if (!shapes.some((shape) => shape.test(code))) return false;
    if (WITHHOLDING_HELPERS.some((helper) => code.includes(helper))) return false;
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
      const violations = findUnwithheldWorkspaceResponses(
        collectResponseSites(module, source),
        collectWorkspaceBearingLocals(source),
      );

      expect(
        violations.map((site) => `${site.module}:${site.line} → res.json(${site.argument})`),
      ).toEqual([]);
    },
  );
});

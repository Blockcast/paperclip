import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Static guard against untitled approval producers (BLO-21032 / BLO-22705).
 *
 * The board UI, Inbox list, and Slack formatter all derive an approval
 * card's subject from `payload.title`. `POST /companies/:companyId/approvals`
 * enforces a non-empty `payload.title` via `createApprovalSchema`, but that
 * Zod schema only runs on that one HTTP route — any other code that calls
 * `db.insert(approvals)` directly bypasses it entirely and can file a card
 * that renders as a blank, undecidable row.
 *
 * This test parses every source file under server/src (excluding tests) and
 * fails when it finds a `db.insert(approvals).values(...)` call whose
 * payload object literal has no `title` key. Sites where the payload cannot
 * be checked syntactically (e.g. it is a caller-supplied variable) must be
 * either routed through `insertApproval()` in services/approval-insert.ts —
 * which requires `payload.title` in its own parameter type, so a missing
 * title fails to compile — or added to STATICALLY_UNVERIFIABLE_ALLOWLIST
 * below with a comment explaining where the title guarantee actually lives.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const STATICALLY_UNVERIFIABLE_ALLOWLIST = new Set([
  // insertApproval()'s own definition: `values` is a parameter, not an
  // inline object literal, so this scan can't see a `title:` key in the
  // text. The guarantee lives in insertApproval's parameter type instead
  // (`payload: ... & { title: string }`), which is exercised directly by
  // approval-insert.test.ts.
  "services/approval-insert.ts",
  // Generic approval-creation entrypoint (`approvalService(db).create`).
  // `data.payload` is caller-supplied: the HTTP route validates it with
  // createApprovalSchema (payload.title, BLO-21032/#975), and every other
  // caller (built-in-agents.ts, plugin-managed-agents.ts, routes/agents.ts)
  // sets payload.title itself when building the hire-agent payload.
  "services/approvals.ts",
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "__fixtures__") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function propertyNameIs(name: ts.PropertyName, text: string): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === text;
  return false;
}

function objectHasTitleKey(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some((prop) => {
    if (ts.isPropertyAssignment(prop)) return propertyNameIs(prop.name, "title");
    if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text === "title";
    return false;
  });
}

function findPayloadProperty(obj: ts.ObjectLiteralExpression): ts.PropertyAssignment | null {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyNameIs(prop.name, "payload")) return prop;
  }
  return null;
}

/** Returns null when the payload cannot be statically verified. */
function payloadObjectLiteralsOf(valuesArg: ts.Expression): ts.ObjectLiteralExpression[] | null {
  const candidates: ts.Expression[] = ts.isArrayLiteralExpression(valuesArg)
    ? [...valuesArg.elements]
    : [valuesArg];
  const results: ts.ObjectLiteralExpression[] = [];
  for (const candidate of candidates) {
    if (!ts.isObjectLiteralExpression(candidate)) return null;
    const payloadProp = findPayloadProperty(candidate);
    if (!payloadProp || !ts.isObjectLiteralExpression(payloadProp.initializer)) return null;
    results.push(payloadProp.initializer);
  }
  return results;
}

function isApprovalsInsertValuesCall(node: ts.CallExpression): ts.CallExpression | null {
  // Matches `<expr>.insert(approvals).values(<args>)`.
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "values") return null;
  const insertCall = node.expression.expression;
  if (!ts.isCallExpression(insertCall) || !ts.isPropertyAccessExpression(insertCall.expression)) return null;
  if (insertCall.expression.name.text !== "insert") return null;
  const [arg] = insertCall.arguments;
  if (insertCall.arguments.length !== 1 || !arg || !ts.isIdentifier(arg) || arg.text !== "approvals") return null;
  return node;
}

function scanFile(filePath: string): string[] {
  const relPath = relative(SRC_DIR, filePath).split("\\").join("/");
  if (STATICALLY_UNVERIFIABLE_ALLOWLIST.has(relPath)) return [];

  const text = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offenses: string[] = [];

  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const valuesCall = isApprovalsInsertValuesCall(node);
      if (valuesCall) {
        const [valuesArg] = valuesCall.arguments;
        if (valuesCall.arguments.length !== 1 || !valuesArg) {
          offenses.push(`${relPath}:${lineOf(node)} (unexpected .values() arity)`);
        } else {
          const payloadLiterals = payloadObjectLiteralsOf(valuesArg);
          if (payloadLiterals === null) {
            offenses.push(`${relPath}:${lineOf(node)} (payload is not a statically-checkable object literal)`);
          } else if (payloadLiterals.some((obj) => !objectHasTitleKey(obj))) {
            offenses.push(`${relPath}:${lineOf(node)} (payload object literal has no title key)`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenses;
}

describe("approval payload title guard", () => {
  it("requires every db.insert(approvals) call site to construct a payload with a title key", () => {
    const offenses = listSourceFiles(SRC_DIR).flatMap(scanFile);
    expect(
      offenses,
      "db.insert(approvals) call sites must construct payload with a `title` key so board cards "
        + "render a subject instead of a blank row (BLO-21032 / BLO-22705). Route the insert through "
        + "insertApproval() in services/approval-insert.ts (requires payload.title at the type level), "
        + "add an inline `title` key to the payload object literal, or — only if the title guarantee "
        + "genuinely lives elsewhere — add the file to STATICALLY_UNVERIFIABLE_ALLOWLIST with a comment "
        + `explaining where. Offending sites:\n${offenses.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const files = new Set(listSourceFiles(SRC_DIR).map((f) => relative(SRC_DIR, f).split("\\").join("/")));
    const stale = [...STATICALLY_UNVERIFIABLE_ALLOWLIST].filter((entry) => !files.has(entry));
    expect(stale, `Allowlist entries that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});

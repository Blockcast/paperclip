import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workflowsDir = path.resolve(".github/workflows");
const workflowFiles = (await readdir(workflowsDir))
  .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
  .sort();
const ALLOWED_RUNNERS = new Set([
  "default",
  "arc-light",
  "arc-dind",
  "arc-deploy",
  "arc-e2e",
  "arc-merge-queue",
  "arc-paperclip-buildkit",
  "arc-paperclip-general",
]);

// BLO-22428: a handful of heavy jobs route merge_group traffic to the
// dedicated arc-merge-queue pool while pull_request traffic uses the
// repository-scoped arc-paperclip-general pool, via
// `runs-on: ${{ <cond> && 'X' || 'Y' }}`. This checker
// otherwise treats the whole `${{ ... }}` value as one opaque runner name,
// which would flag that expression as an unknown label. Recognize exactly
// this one ternary shape and validate both literal branches individually;
// any other expression shape still falls through to the opaque-string path
// below and fails closed as an unrecognized runner label.
const TERNARY_RUNNER_EXPRESSION =
  /^\$\{\{\s*github\.event_name\s*==\s*'merge_group'\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'\s*\}\}$/;
const violations = [];

function stripInlineComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) {
      return value.slice(0, index);
    }
  }
  return value;
}

function unquote(value) {
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitInlineList(value) {
  const trimmed = stripInlineComment(value).trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1);
  const entries = [];
  let quote = null;
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if ((char === '"' || char === "'") && body[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "," && quote === null) {
      if (current.trim()) entries.push(unquote(current));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) entries.push(unquote(current));
  return entries;
}

function valuesFromScalar(value) {
  const inlineList = splitInlineList(value);
  if (inlineList) return inlineList;
  const scalar = unquote(value);
  if (!scalar) return [];
  const ternaryMatch = scalar.match(TERNARY_RUNNER_EXPRESSION);
  if (ternaryMatch) return [ternaryMatch[1], ternaryMatch[2]];
  return [scalar];
}

function leadingSpaces(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}

function extractRunsOnEntries(lines, runsOnLineIndex, rawValue) {
  const sourceLine = lines[runsOnLineIndex].trim();
  const inlineValues = valuesFromScalar(rawValue);
  if (inlineValues.length > 0) {
    return inlineValues.map((value) => ({ value, lineNumber: runsOnLineIndex + 1, sourceLine }));
  }

  const entries = [];
  const runsOnIndent = leadingSpaces(lines[runsOnLineIndex]);
  for (let index = runsOnLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = stripInlineComment(line).trim();
    if (!trimmed) continue;
    const indent = leadingSpaces(line);
    if (indent <= runsOnIndent) break;

    if (trimmed.startsWith("- ")) {
      for (const value of valuesFromScalar(trimmed.slice(2))) {
        entries.push({ value, lineNumber: index + 1, sourceLine: line.trim() });
      }
      continue;
    }

    const mapMatch = trimmed.match(/^[A-Za-z0-9_-]+:\s*(.*)$/);
    if (mapMatch) {
      const mapValue = mapMatch[1] ?? "";
      for (const value of valuesFromScalar(mapValue)) {
        entries.push({ value, lineNumber: index + 1, sourceLine: line.trim() });
      }
    }
  }

  return entries.length > 0
    ? entries
    : [{ value: "", lineNumber: runsOnLineIndex + 1, sourceLine }];
}

for (const file of workflowFiles) {
  const lines = (await readFile(path.join(workflowsDir, file), "utf8")).split("\n");

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*runs-on:\s*(.*)$/);
    if (!match) continue;

    const entries = extractRunsOnEntries(lines, index, match[1] ?? "");
    for (const entry of entries) {
      if (!entry.value || !ALLOWED_RUNNERS.has(entry.value)) {
        violations.push(`${file}:${entry.lineNumber}: ${entry.sourceLine}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Runner labels must use one of: ${[...ALLOWED_RUNNERS].join(", ")}:`);
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${workflowFiles.length} workflows: all runner labels use ARC.`);
}

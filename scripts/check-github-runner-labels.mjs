import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Must stay in lockstep with `self-hosted-runner.labels` in
// `.github/actionlint.yaml`, which declares the same pools to actionlint for
// the workflow-parse gate (scripts/check-workflows-parse.mjs).
//
// The two checkers are complementary rather than redundant: this one splits
// TERNARY_RUNNER_EXPRESSION below and validates both branches, which
// actionlint treats as one opaque expression. But a pool added to only one
// list produces a split verdict — the gate that does not know the label goes
// red while the other passes, on some unrelated PR. The "runner-label
// allowlists agree" test in scripts/check-workflows-parse.test.mjs asserts
// the two lists match, so that drift fails loudly and by name instead.
export const ALLOWED_RUNNERS = new Set([
  "default",
  "arc-paperclip-light",
  "arc-dind",
  "arc-deploy",
  "arc-paperclip-deploy",
  "arc-paperclip-e2e",
  "arc-merge-queue",
  "arc-paperclip-buildkit",
  "arc-paperclip-general",
  "arc-paperclip-dind",
]);

// PEN-6677/PEN-6682: pools whose bare label is answered by MORE THAN ONE org
// runner group. The bare label `arc-paperclip-buildkit` is answered both by
// this cluster's group of that name and by `arc-paperclip-buildkit-tools`, and
// a tools-cluster runner reaches THAT cluster's BuildKit rather than the
// Ceph-backed one these jobs assume -- so a bare `runs-on` picks a cluster per
// job by coin flip, which hung four image builds to their ceilings on
// 2026-11-14. Jobs on these pools must name the group explicitly:
//
//   runs-on:
//     group: arc-paperclip-buildkit
//     labels: arc-paperclip-buildkit
//
// ALLOWED_RUNNERS above already rejects the `-tools` group by name, but that is
// one entry: adding `arc-paperclip-buildkit-tools` to it for any reason would
// un-guard every buildkit job at once (measured 2026-11-14 -- widening the list
// by that single line takes the `-tools` substitution from caught at 7 of 7
// sites to caught at 0 of 7). This rule keys on the FORM instead of the name,
// so it is independent of that list and survives it being widened.
export const GROUP_PINNED_RUNNERS = new Set(["arc-paperclip-buildkit"]);

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

    const mapMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (mapMatch) {
      const mapKey = mapMatch[1];
      const mapValue = mapMatch[2] ?? "";
      for (const value of valuesFromScalar(mapValue)) {
        entries.push({ value, key: mapKey, lineNumber: index + 1, sourceLine: line.trim() });
      }
    }
  }

  return entries.length > 0
    ? entries
    : [{ value: "", lineNumber: runsOnLineIndex + 1, sourceLine }];
}

async function main() {
  const workflowsDir = path.resolve(".github/workflows");
  const workflowFiles = (await readdir(workflowsDir))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const violations = [];
  const groupPinViolations = [];

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

      // A `runs-on:` block satisfies the pin when it declares `group:` with the
      // pinned pool, so the two-key map form passes on both of its lines. A
      // bare scalar, a sequence entry, and a ternary branch all reach the pool
      // without naming a group, and are reported with the line that does it.
      const declaredGroups = new Set(
        entries.filter((entry) => entry.key === "group").map((entry) => entry.value),
      );
      for (const entry of entries) {
        if (!GROUP_PINNED_RUNNERS.has(entry.value)) continue;
        if (declaredGroups.has(entry.value)) continue;
        groupPinViolations.push(`${file}:${entry.lineNumber}: ${entry.sourceLine}`);
      }
    }
  }

  if (violations.length > 0) {
    console.error(`Runner labels must use one of: ${[...ALLOWED_RUNNERS].join(", ")}:`);
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }

  if (groupPinViolations.length > 0) {
    console.error(
      `More than one org runner group answers these pools, so a bare label picks a group per job by coin flip. Name the group explicitly (${[...GROUP_PINNED_RUNNERS].join(", ")}):`,
    );
    console.error(groupPinViolations.join("\n"));
    console.error("  runs-on:\n    group: <pool>\n    labels: <pool>");
    process.exitCode = 1;
  }

  if (violations.length === 0 && groupPinViolations.length === 0) {
    console.log(
      `Validated ${workflowFiles.length} workflows: all runner labels use ARC, and every group-pinned pool names its group.`,
    );
  }
}

// Guarded so `ALLOWED_RUNNERS` can be imported — by the allowlist-agreement
// test in scripts/check-workflows-parse.test.mjs — without the import itself
// running the checker and scanning the repo as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

#!/usr/bin/env node

/**
 * Guards against inert CODEOWNERS rules landing on master.
 *
 * GitHub silently ignores a CODEOWNERS entry naming an account without write
 * access to the repo — the rule parses fine and enforces nothing: no
 * auto-requested review, no code-owner gate. BLO-22899 found all 13 rules on
 * master invalid this way, inherited wholesale from an upstream merge
 * (c204d117) that named two read-only accounts. Nothing checked, so nothing
 * caught it until someone happened to read the raw API response.
 *
 * This asserts GitHub's own `codeowners/errors` endpoint — the exact surface
 * that silently failed — returns zero errors for the given ref.
 */

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {{line: number, kind: string, suggestion?: string}[]} errors
 * @returns {string[]} human-readable violations; empty when the ref is sound
 */
export function summarizeErrors(errors) {
  return (errors ?? []).map((error) => {
    const suggestion = error.suggestion ? ` — ${error.suggestion}` : "";
    return `line ${error.line}: ${error.kind}${suggestion}`;
  });
}

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fetchCodeownersErrors(repo, ref) {
  const raw = gh(["api", `repos/${repo}/codeowners/errors?ref=${ref}`]);
  return JSON.parse(raw).errors ?? [];
}

function main() {
  const repo =
    process.env.CODEOWNERS_GUARD_REPO ||
    process.env.GITHUB_REPOSITORY ||
    "Blockcast/paperclip";
  const ref = process.env.CODEOWNERS_GUARD_REF || process.env.GITHUB_SHA || "master";

  const errors = fetchCodeownersErrors(repo, ref);
  const summary = summarizeErrors(errors);

  if (summary.length > 0) {
    console.error(
      `CODEOWNERS guard FAILED for ${repo}@${ref} (${summary.length} error(s)):\n`,
    );
    for (const line of summary) console.error(`  ${line}`);
    console.error(
      "\nEach error names a rule GitHub will silently ignore — no auto-requested " +
        "review, no code-owner gate. See BLO-22899.",
    );
    process.exit(1);
  }

  console.log(`CODEOWNERS guard passed: 0 errors for ${repo}@${ref}.`);
}

export function isMainModule(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(argvPath) && resolve(argvPath) === fileURLToPath(moduleUrl);
}

if (isMainModule()) {
  main();
}

#!/usr/bin/env node
/**
 * check-db-transaction-alias.mjs
 *
 * Bans re-deriving the drizzle transaction-handle type inline. Import the
 * exported `DbTransaction` from `@paperclipai/db` instead.
 *
 * BLO-34656 swept 21 copies of this alias out of 20 files under five
 * different local names. BLO-34812 exists because the only thing holding it
 * at zero afterwards was a comment, and those 21 copies are the evidence that
 * a comment does not hold.
 *
 * The ban is on the SHAPE, not on one spelling: the sweep itself missed two
 * files spelled `typeof db.transaction` because it grepped for the
 * `Db["transaction"]` spelling only. It deliberately does NOT fire on nested
 * `Parameters<...>` over something that is not a transaction (a legitimate
 * shape — see the test), nor on the two-alias split in
 * packages/db/src/client.ts that defines the replacement.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Any `Parameters<...>[0]` whose first type argument mentions `transaction`.
 * The `[^>]*` confines the match to the first type argument, so an unrelated
 * `Parameters<...>` that merely mentions a transaction further right does not
 * match. The trailing `[0]` is what makes it a handle derivation: a bare
 * `Parameters<typeof db.transaction>` is the method's argument tuple (test
 * doubles spread it as `(...args: Parameters<typeof db.transaction>)`) and is
 * not the alias.
 *
 * The pattern is deliberately single-level: the canonical two-line split in
 * `packages/db/src/client.ts` (`Parameters<Db["transaction"]>[0]` feeding a
 * second `Parameters<...>[0]`) and a hand-wrapped multi-line nested form both
 * contain this single level on some line, and `git grep` is line-anchored.
 * Requiring nesting on one line let both spellings through. The definition
 * site is exempted by PATH (`DEFINITION_SITE`), not by shape.
 *
 * Only `.ts`/`.tsx` is scanned, so this file's own quoting of the shape is
 * out of scope by construction.
 */
export const TX_ALIAS_REDERIVATION = /Parameters<[^>]*transaction[^>]*>\[0\]/;

/** The one file allowed to derive the alias: it is where `DbTransaction` is defined. */
export const DEFINITION_SITE = "packages/db/src/client.ts";

export function violatesTxAliasBan(line) {
  return TX_ALIAS_REDERIVATION.test(line);
}

export const MESSAGE =
  'Do not re-derive the transaction handle type. Import `DbTransaction` from "@paperclipai/db".';

export function scanRepo({ repoRoot, exec = execFileSync } = {}) {
  try {
    const output = exec(
      "git",
      [
        "grep",
        "-nE",
        TX_ALIAS_REDERIVATION.source,
        "--",
        "*.ts",
        "*.tsx",
        `:(exclude)${DEFINITION_SITE}`,
      ],
      { encoding: "utf8", cwd: repoRoot },
    );
    return output.split("\n").filter((line) => line.trim());
  } catch (err) {
    // git grep exits 1 with empty output when nothing matched; anything else
    // (128 = not a repo, bad pathspec) is a real failure and must not read as
    // a clean tree.
    if (err.status === 1 && !String(err.stdout ?? "").trim()) return [];
    throw err;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scanRepo({ repoRoot });
  if (violations.length > 0) {
    console.error(`ERROR: ${MESSAGE}\n`);
    for (const line of violations) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("  ✓  No inline transaction-handle re-derivations.");
}

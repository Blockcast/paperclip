import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The single derivation of the server-side GitHub writer set (PEN-3391).
 *
 * ## Why this is shared rather than duplicated
 *
 * Two guards consume it — `github-write-egress-scrub.test.ts` ("leaves no
 * server-side GitHub writer outside the scrub") and
 * `github-egress-outbound-coverage.test.ts` ("classifies every server file that
 * writes to GitHub"). They carried byte-identical copies of the predicate, and
 * PEN-3157 widened only the *walk*, in both, by hand. A second divergence was
 * one edit away: the next widening would have reached whichever copy its author
 * happened to open. There is now one copy, so a widening cannot land by halves.
 *
 * ## Why the predicate is fail-CLOSED
 *
 * The predicate it replaces asked "can I see a write here?":
 *
 *     if (!source.includes("ghFetch(")) return false;
 *     return /method:\s*"(?:POST|PATCH|PUT|DELETE)"/.test(source);
 *
 * Both clauses fail OPEN — an unrecognised writer is silently classified as a
 * read, and a file the guard does not classify is a file the guard never
 * checks. That is the wrong direction for a mechanism whose entire job is to
 * catch the *next* writer, and it is the same shape this control has now been
 * bitten by three times (PEN-2527 enumerated `gh` and missed the MCP server;
 * PEN-3152 enumerated both wrappers and missed `server/`; PEN-3157 enumerated
 * `services/` and missed its own siblings). Each time an enumeration was
 * correct over a set that was quietly too small.
 *
 * So this asks the inverse — "can I PROVE this is not a write?" — and treats
 * everything else as a writer:
 *
 * - **Clause 1 widened from a call to a reference.** `source.includes("ghFetch(")`
 *   requires a literal call *in the same file*. `github-external-object-provider.ts`
 *   imports `ghFetch`, aliases it (`const fetchImpl = opts.fetch ?? ghFetch`)
 *   and calls it through the alias — so it contains no `ghFetch(` substring and
 *   was excluded before the method test was ever reached. It is a read today
 *   (headers only), but adding `method: "POST"` to that one call would have
 *   shipped an unscrubbed GitHub write with BOTH guards green. Matching
 *   `\bghFetch\b` puts every importer in the candidate set regardless of how it
 *   later spells the call.
 * - **Clause 2 inverted from an allowlist of mutating spellings to an allowlist
 *   of read spellings.** `/method:\s*"(?:POST|PATCH|PUT|DELETE)"/` recognises
 *   only an inline, double-quoted, upper-case literal. It misses `'POST'`,
 *   `` `POST` ``, `"post"` (HTTP methods are case-insensitive and `fetch`
 *   normalises the known ones, so this is a working write), a variable
 *   (`method: verb`), and the `{ method }` shorthand. Rather than chase that
 *   alphabet — the losing side of the trade, since the next spelling is always
 *   one more than the list — a candidate is read-only only when every mention
 *   of the word `method` is a quoted safe-verb literal.
 *
 * The cost of that inversion is false POSITIVES: a candidate that merely says
 * "method" in a comment, or names a variable `methodName`, is classified as a
 * writer and must carry the scrub. That is deliberate. A false positive is one
 * legible test failure naming the file; a false negative is an unscrubbed
 * credential on a public commit status. It costs nothing today — of the nine
 * files under `server/src` that reference `ghFetch`, the word `method` appears
 * in exactly the two that do write, and both already scrub.
 *
 * ## What still escapes it, and what would make that reachable
 *
 * A `RequestInit` assembled in one file and passed by reference into a
 * `ghFetch` call in another leaves no `method` token in the calling file, so
 * the caller reads as provably read-only. Nothing in the tree does this: every
 * `ghFetch` call site builds its options inline, and `ghFetch` itself
 * (`services/github-fetch.ts`) merely forwards an `init?: RequestInit` it never
 * inspects. It becomes reachable the day someone factors request-building into
 * a shared helper — a "remove the duplication between these two POSTs" refactor
 * is exactly the innocent change that would do it. Closing that needs a real
 * import graph or a typed AST walk, not a regex over one file; this is the
 * boundary of what file-granular scanning can establish, and it is recorded
 * here rather than left as an unstated assumption.
 *
 * `github-writer-derivation.test.ts` drives every shape named above through
 * these functions, including the ones the old predicate missed, so the widening
 * is pinned by a check that fails first rather than by this comment.
 */

/**
 * Any mention of `ghFetch` — an import, a call, or an alias assignment — puts a
 * file in the candidate set. Deliberately NOT `ghFetch(`: see clause 1 above.
 */
const GH_FETCH_REFERENCE = /\bghFetch\b/;

/** Every mention of the word, whatever its shape. */
const METHOD_WORD = /\bmethod\b/g;

/**
 * The only shape that proves a `method` is a read: a quoted literal naming a
 * safe verb. Any quote style, either case — the point is the VALUE is pinned in
 * source, not that it is spelled a particular way.
 */
const SAFE_READ_METHOD = /\bmethod\s*:\s*(["'`])\s*(?:GET|HEAD|OPTIONS)\s*\1/gi;

/** True when the file names `ghFetch` at all, however it later calls it. */
export function referencesGhFetch(source: string): boolean {
  return GH_FETCH_REFERENCE.test(source);
}

/**
 * True when the file cannot be issuing a mutating request: it either never says
 * `method`, or every mention is a quoted safe-verb literal.
 */
export function declaresOnlySafeReadMethods(source: string): boolean {
  const mentions = source.match(METHOD_WORD)?.length ?? 0;
  if (mentions === 0) return true;
  const safe = source.match(SAFE_READ_METHOD)?.length ?? 0;
  return safe === mentions;
}

/** A candidate this scan cannot prove is read-only. Fail-closed by construction. */
export function isSuspectedGitHubWriter(source: string): boolean {
  return referencesGhFetch(source) && !declaresOnlySafeReadMethods(source);
}

/**
 * Every non-test TypeScript file under `server/src`, relative to it with
 * forward slashes ("services/github-app-auth.ts").
 *
 * Recursive, and that is load-bearing — Ally caught a one-level walk of
 * `server/src/services` on #1754, which could not see `routes/github-webhook.ts`
 * or `services/recovery/`.
 *
 * `__tests__/` is excluded because this file lives there: a scanner that
 * described its own regexes would classify itself as an unscrubbed writer. The
 * exclusion is sound only while nothing in the running server imports from
 * `__tests__/`, which is not an assumption to leave unstated —
 * `productionFilesImportingTestHelpers` below lets the callers assert it.
 */
export function serverSourceFiles(serverSourceDirectory: string): string[] {
  return readdirSync(serverSourceDirectory, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter((entry) => !entry.startsWith("__tests__/"))
    .sort();
}

/**
 * Production files that reach into `__tests__/`. Must be empty for the
 * exclusion in `serverSourceFiles` to hold; asserted by both callers rather
 * than trusted.
 */
export function productionFilesImportingTestHelpers(serverSourceDirectory: string): string[] {
  return serverSourceFiles(serverSourceDirectory).filter((entry) =>
    /from\s*"[^"]*__tests__\//.test(readFileSync(path.join(serverSourceDirectory, entry), "utf8")),
  );
}

/** The fail-closed writer set: candidates this scan cannot prove are reads. */
export function serverFilesWritingToGitHub(serverSourceDirectory: string): string[] {
  return serverSourceFiles(serverSourceDirectory)
    .filter((entry) =>
      isSuspectedGitHubWriter(readFileSync(path.join(serverSourceDirectory, entry), "utf8")),
    )
    .sort();
}

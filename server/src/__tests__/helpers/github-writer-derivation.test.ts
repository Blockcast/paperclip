import { describe, expect, it } from "vitest";

import {
  declaresOnlySafeReadMethods,
  importsFromTestHelpers,
  isSuspectedGitHubWriter,
  referencesGhFetch,
} from "./github-writer-derivation.js";

/**
 * PEN-3391 done-when 1: "The writer predicate recognises a `ghFetch` write
 * whose method is not an inline double-quoted literal … A fail-first check is
 * required either way — a predicate that matches nothing returns the same empty
 * set as full coverage."
 *
 * That last sentence is the whole reason this file exists. The guards that
 * consume this predicate assert "every writer found carries the scrub", which
 * a predicate matching NOTHING satisfies perfectly and vacuously. Their
 * positive control (`expect(writers).toContain("services/github-app-auth.ts")`)
 * proves the derivation finds the writers that exist *today*; it cannot prove
 * it would find a writer written *tomorrow* in a shape the tree does not yet
 * contain. Only synthetic sources can, so every shape below is one the tree
 * does not contain.
 *
 * Each widened case is asserted twice: that `OLD_PREDICATE` — the exact
 * predicate on `master` before this change — misses it, and that the new one
 * catches it. The first half is what makes this a regression test rather than a
 * restatement. If a future edit narrows the predicate back, the "old misses it"
 * assertion still passes but its partner fails, and the failure names the
 * shape.
 */

/**
 * Verbatim from `github-write-egress-scrub.test.ts:386-390` and
 * `github-egress-outbound-coverage.test.ts:225-228` as they stood at PEN-3157's
 * merged head (`f097134f`). Kept as a fixture so "the widening is real" is a
 * measurement rather than a claim in a comment.
 */
function OLD_PREDICATE(source: string): boolean {
  if (!source.includes("ghFetch(")) return false;
  return /method:\s*"(?:POST|PATCH|PUT|DELETE)"/.test(source);
}

/** A write the OLD predicate already caught — the shape both real writers use. */
const INLINE_DOUBLE_QUOTED = `
  import { ghFetch } from "./github-fetch.js";
  await ghFetch(url, { method: "POST", headers, body });
`;

/**
 * Shapes the old predicate missed. Every one is a working GitHub write.
 * Prettier pins double quotes repo-wide, which is why several of these were
 * argued unreachable — but Prettier is a formatter, not a security control, and
 * it does not normalise a variable or a shorthand into a literal at all.
 */
const MISSED_BY_OLD: ReadonlyArray<readonly [string, string]> = [
  [
    "aliased through a local binding, so the file contains no `ghFetch(` at all",
    // The live instance: services/github-external-object-provider.ts imports
    // ghFetch, aliases it, and calls it through the alias. It is a read today.
    // Adding a method to that one call is the whole distance to an unscrubbed
    // write, and clause 1 excluded the file before the method test ran.
    `
      import { ghFetch } from "./github-fetch.js";
      const fetchImpl = opts.fetch ?? ghFetch;
      response = await fetchImpl(url, { method: "POST", headers, body });
    `,
  ],
  [
    "single-quoted method literal",
    `import { ghFetch } from "./github-fetch.js";
     await ghFetch(url, { method: 'POST', headers });`,
  ],
  [
    "template-literal method",
    "import { ghFetch } from \"./github-fetch.js\";\n" +
      "await ghFetch(url, { method: `POST`, headers });",
  ],
  [
    "lower-case method literal (HTTP verbs are case-insensitive; fetch normalises them)",
    `import { ghFetch } from "./github-fetch.js";
     await ghFetch(url, { method: "post", headers, body });`,
  ],
  [
    "method held in a variable",
    `import { ghFetch } from "./github-fetch.js";
     const verb = shouldReplace ? "PUT" : "PATCH";
     await ghFetch(url, { method: verb, headers, body });`,
  ],
  [
    "object shorthand",
    `import { ghFetch } from "./github-fetch.js";
     const method = "DELETE";
     await ghFetch(url, { method, headers });`,
  ],
  [
    "method assigned onto the init object after construction",
    `import { ghFetch } from "./github-fetch.js";
     const init: RequestInit = { headers };
     init.method = "POST";
     await ghFetch(url, init);`,
  ],
];

/** Genuine reads. Classifying these as writers would be a false positive. */
const GENUINE_READS: ReadonlyArray<readonly [string, string]> = [
  [
    "no method key at all — the default GET, which is what seven of the nine candidates do",
    `import { ghFetch } from "./github-fetch.js";
     const res = await ghFetch(url, { headers });`,
  ],
  [
    "explicit safe verb",
    `import { ghFetch } from "./github-fetch.js";
     await ghFetch(url, { method: "GET", headers });`,
  ],
  [
    "explicit safe verb, lower-case and single-quoted",
    `import { ghFetch } from "./github-fetch.js";
     await ghFetch(url, { method: 'head', headers });`,
  ],
  [
    "several safe verbs, every one a pinned literal",
    `import { ghFetch } from "./github-fetch.js";
     await ghFetch(a, { method: "GET", headers });
     await ghFetch(b, { method: "HEAD", headers });`,
  ],
];

describe("server GitHub writer derivation (PEN-3391)", () => {
  describe("the candidate set is every file that names ghFetch", () => {
    it("includes an importer that only ever calls through an alias", () => {
      const source = MISSED_BY_OLD[0]?.[1] as string;
      expect(source).not.toContain("ghFetch(");
      expect(referencesGhFetch(source)).toBe(true);
    });

    it("excludes a file that never names ghFetch, whatever it posts", () => {
      // Scope control. The guards only bind GitHub egress; a POST to any other
      // host is a different question and must not be dragged in here.
      const source = `await fetch("https://example.invalid", { method: "POST" });`;
      expect(referencesGhFetch(source)).toBe(false);
      expect(isSuspectedGitHubWriter(source)).toBe(false);
    });
  });

  describe("shapes the pre-PEN-3391 predicate missed", () => {
    it.each(MISSED_BY_OLD)("catches a write %s", (_label, source) => {
      // Fail-first: the old predicate really did let this through, so the new
      // assertion below is measuring a widening and not restating a pass.
      expect(OLD_PREDICATE(source)).toBe(false);
      expect(isSuspectedGitHubWriter(source)).toBe(true);
    });
  });

  describe("shapes both predicates agree on", () => {
    it("catches the inline double-quoted write the old predicate already caught", () => {
      expect(OLD_PREDICATE(INLINE_DOUBLE_QUOTED)).toBe(true);
      expect(isSuspectedGitHubWriter(INLINE_DOUBLE_QUOTED)).toBe(true);
    });

    it.each(GENUINE_READS)("does not classify %s as a writer", (_label, source) => {
      expect(declaresOnlySafeReadMethods(source)).toBe(true);
      expect(isSuspectedGitHubWriter(source)).toBe(false);
    });
  });

  describe("the read allowlist is exhaustive over the file, not satisfied by one hit", () => {
    it("a safe verb does not excuse an unpinned one elsewhere in the same file", () => {
      // The failure mode of an allowlist that merely searches: one recognised
      // read makes the whole file read-only, and any number of writes ride
      // along. Counting mentions against safe literals is what prevents it.
      const source = `import { ghFetch } from "./github-fetch.js";
        await ghFetch(readUrl, { method: "GET", headers });
        await ghFetch(writeUrl, { method: verb, headers, body });`;
      expect(declaresOnlySafeReadMethods(source)).toBe(false);
      expect(isSuspectedGitHubWriter(source)).toBe(true);
    });

    it("a capitalised safe literal in prose does not cancel an unpinned write", () => {
      // SAFE_READ_METHOD is case-insensitive, so `Method: "GET"` in a comment is
      // a safe hit. Unless the mention count is case-insensitive too, that hit
      // has no matching mention and offsets the real write below.
      const source = `import { ghFetch } from "./github-fetch.js";
        /** Method: "GET" is the default. */
        await ghFetch(url, { method: verb, headers, body });`;
      expect(declaresOnlySafeReadMethods(source)).toBe(false);
      expect(isSuspectedGitHubWriter(source)).toBe(true);
    });

    it("classifies an ambiguous mention as a writer rather than a read", () => {
      // Documenting the accepted false-positive direction. This file is a read,
      // and the predicate calls it a writer because it says "method" in prose.
      // The remedy is one legible failure naming the file; the alternative
      // direction ships an unscrubbed credential. Asserted so that anyone who
      // "fixes" the noise has to delete a test that says why it is there.
      const source = `import { ghFetch } from "./github-fetch.js";
        // Uses the default method, which is GET.
        await ghFetch(url, { headers });`;
      expect(isSuspectedGitHubWriter(source)).toBe(true);
    });
  });

  describe("the residual gap is recorded, not silently absent", () => {
    it("cannot see an init object assembled in another file", () => {
      // The honest boundary of file-granular scanning, kept as an executable
      // statement so it cannot rot into an unstated assumption. Nothing in the
      // tree has this shape today — every ghFetch call site builds its options
      // inline — and a "factor out the duplicate POST setup" refactor is what
      // would introduce it. Closing it needs an import graph or a typed AST
      // walk, which is a different mechanism, not a wider regex.
      const caller = `import { ghFetch } from "./github-fetch.js";
        import { writeInit } from "./elsewhere.js";
        await ghFetch(url, writeInit(body));`;
      expect(isSuspectedGitHubWriter(caller)).toBe(false);
    });
  });

  describe("the __tests__/ exclusion guard reads every import spelling", () => {
    /**
     * Verbatim from `productionFilesImportingTestHelpers` before this change.
     * Same fail-first shape as `OLD_PREDICATE`: each widened spelling is
     * asserted to slip past this one first, so the widening is measured rather
     * than asserted.
     */
    const OLD_TEST_IMPORT_PREDICATE = (source: string): boolean =>
      /from\s*"[^"]*__tests__\//.test(source);

    const MISSED_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
      ["single-quoted static import", `import { seed } from '../__tests__/helpers/db.js';`],
      ["backtick specifier", "export { seed } from `../__tests__/helpers/db.js`;"],
      ["dynamic import", `const { seed } = await import("../__tests__/helpers/db.js");`],
      ["single-quoted dynamic import", `await import('../__tests__/helpers/db.js');`],
      ["side-effect import", `import "../__tests__/helpers/register.js";`],
      ["require", `const { seed } = require("../__tests__/helpers/db.js");`],
    ];

    it.each(MISSED_SPELLINGS)("catches a %s", (_label, source) => {
      expect(OLD_TEST_IMPORT_PREDICATE(source)).toBe(false);
      expect(importsFromTestHelpers(source)).toBe(true);
    });

    it("still catches the double-quoted static import the old form caught", () => {
      const source = `import { seed } from "../__tests__/helpers/db.js";`;
      expect(OLD_TEST_IMPORT_PREDICATE(source)).toBe(true);
      expect(importsFromTestHelpers(source)).toBe(true);
    });

    it("does not fire on a test path named in prose", () => {
      // services/plugin-host-services.ts does exactly this. The predicate must
      // stay empty over the real tree or its callers' assertion is vacuous, so
      // matching `__tests__/` anywhere would be more fail-closed and less
      // useful. This is the case that pins the boundary.
      const source = `// See \`server/src/__tests__/plugin-events-ownership-check.test.ts\`.
        import { helper } from "./helper.js";`;
      expect(importsFromTestHelpers(source)).toBe(false);
    });

    it("does not fire on an unrelated import elsewhere in the file", () => {
      const source = `import { a } from "./a.js";
        const label = "__tests__/ is excluded from the walk";`;
      expect(importsFromTestHelpers(source)).toBe(false);
    });
  });
});

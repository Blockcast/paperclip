import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginDatabaseCoreReadTable,
  PluginMigrationRecord,
} from "@paperclipai/shared";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;

/**
 * Everything Postgres treats as nothing between two tokens: whitespace, a line
 * comment, a block comment.
 *
 * A comment is not decoration here, it is a SEPARATOR -- `public/**\/.secrets` and
 * `public--x\n.secrets` are both exactly `public.secrets` to the database. Spanning
 * it in the pattern itself is what makes the RAW statement sufficient to see a
 * qualified name, and that is the whole point: the raw statement is the bytes the
 * database gets, so a pattern that spans this gap cannot be blinded by a lexer bug
 * (PEN-6600). Relying on `stripSqlComments` to remove the comment first put the
 * lexer back on the trust path, and a mis-lex there deleted the name outright.
 *
 * A line comment ends at a CARRIAGE RETURN as well as a newline -- Postgres's
 * `scan.l` defines `newline [\n\r]`, so `--x\r` is a complete comment. Matching only
 * `\n` meant this fragment could not span `public--x\r.secrets`, and `scanSqlSpans`
 * ran the same comment to end of input and DELETED the name from the stripped text:
 * one byte, both texts blind, no literal and no desync needed (PEN-6600 round 7).
 *
 * ⚠ WHAT THIS FRAGMENT STILL CANNOT SPAN, and why that is no longer a residual:
 * Postgres block comments NEST, and a regular expression provably cannot count, so
 * the block-comment branch stops at the first `*\/` and always will. Round 6 left
 * that form to the lexer alone -- and a lexer desync combined with a nested comment
 * is exactly how both round-7 findings reached `public.secrets`. `assertNoBannedSql`
 * now REFUSES a nested block comment in the raw statement instead, so this fragment
 * never has to span one. See `hasNestedBlockComment`.
 *
 * The branches are written to be unambiguous (no two can match the same first
 * character, and the block-comment branch is the linear-time form) so the outer `*`
 * cannot backtrack catastrophically.
 */
const SQL_TOKEN_GAP = String.raw`(?:\s|--[^\n\r]*[\n\r]|/\*[^*]*\*+(?:[^/*][^*]*\*+)*/)*`;

/**
 * One schema-qualified name, as Postgres lexes it.
 *
 * `.` is an ordinary token to Postgres rather than part of an identifier, so
 * whitespace, a newline or a comment may sit on either side of it. `public . secrets`,
 * `public .secrets`, `public. secrets`, `"public" . "secrets"` and
 * `public/**\/.secrets` all name public.secrets and all of them execute.
 *
 * This used to be written inline in each of the three patterns below with a BARE
 * `\.`, so none of those forms extracted a ref at all. That is only half a defect on
 * its own; the other half is that `validatePluginRuntimeQuery` had no floor, so an
 * empty ref set fell out of its loop and returned normally -- i.e. ALLOWED (PEN-6600).
 *
 * It is ONE shared fragment so the three patterns cannot drift apart again.
 */
const QUALIFIED_NAME =
  String.raw`"?([A-Za-z_][A-Za-z0-9_]*)"?` +
  SQL_TOKEN_GAP +
  String.raw`\.` +
  SQL_TOKEN_GAP +
  String.raw`"?([A-Za-z_][A-Za-z0-9_]*)"?`;

/**
 * Every ADJACENT qualified pair in a name chain, including the overlapping ones.
 *
 * A zero-width lookahead makes the matches overlap, so `a.b.c` yields `a.b` AND `b.c`;
 * the lookbehind refuses a start in the middle of an identifier, so `xpublic.secrets`
 * yields only `xpublic.secrets` and never `public.secrets`. The capture groups sit
 * inside the lookahead, so groups 1 and 2 stay schema and table exactly as in
 * `QUALIFIED_NAME`.
 */
const OVERLAPPING_QUALIFIED_NAME = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?=` + QUALIFIED_NAME + String.raw`)`,
  "gi",
);

/**
 * The schemas that can exist in this database besides a plugin's own namespace:
 * `public` (the core schema), the catalogs, and every other plugin's namespace --
 * `derivePluginDatabaseNamespace` always emits a `plugin_` prefix.
 *
 * A left side matching this is ALWAYS adjudicated, whatever else the statement used
 * that word for -- so a statement cannot buy an exemption for `public.secrets` by
 * also aliasing something `public`.
 *
 * It is NOT the test for "is this a schema?". It used to be: a left side outside this
 * set was skipped as a column read through a table alias (`cursor.id`, `EXCLUDED.y`),
 * which made the set an allowlist of schemas to CHECK and left every other real schema
 * unchecked -- `drizzle.__drizzle_migrations` in a non-first position was ignored,
 * while the same name in first position was correctly refused (PEN-6604). The skip is
 * now `assertNoUnextractedSchemaRefs`'s known-schema test instead: a left side that is
 * not a schema in this database is exempt there, which is what the correlation-name
 * exemption used to do and does not need a name list to get right.
 */
const SCHEMA_SHAPED_RE = /^(?:public|information_schema|pg_[a-z0-9_]*|plugin_[a-z0-9_]*)$/;

type SqlRef = { schema: string; table: string; keyword: string };
type QualifiedRefPattern =
  | { pattern: RegExp; groups: "keyword-schema-table" }
  | { pattern: RegExp; groups: "schema-table"; keyword: string };

export type PluginDatabaseRuntimeResult<T = Record<string, unknown>> = {
  rows?: T[];
  rowCount?: number;
};

export function derivePluginDatabaseNamespace(
  pluginKey: string,
  namespaceSlug?: string,
): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug = (namespaceSlug ?? pluginKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 36) || "plugin";
  const namespace = `plugin_${slug}_${hash}`;
  return namespace.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH);
}

function assertIdentifier(value: string, label = "identifier"): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Unsafe SQL ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value).replaceAll("\"", "\"\"")}"`;
}

/**
 * A character that can appear inside an unquoted identifier.
 *
 * Postgres: `ident_cont [A-Za-z\200-\377_0-9\$]`. The `\200-\377` is every byte a
 * non-ASCII character is encoded from, so `\u0080-\uFFFF` is the UTF-16 equivalent.
 * Leaving it out made `e$b$c` read as an identifier and `\u00e9$b$c` read as a
 * non-identifier followed by a dollar-quote opener, which opened a span to the end
 * of the statement and inverted this lexer's parity (PEN-6600 round 7).
 */
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/**
 * The opening (and therefore closing) tag of a dollar-quoted string, matched
 * STICKILY at a candidate `$`. The tag body is optional, so both `$$` and `$tag$`
 * are openers; a bare `$1` placeholder is not, because the trailing `$` is required.
 */
const DOLLAR_QUOTE_TAG = /\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/y;

type SqlSpanKind = "code" | "quoted" | "comment";
type SqlSpan = { kind: SqlSpanKind; start: number; end: number; quote?: "'" | "\"" };

/**
 * A SQL lexer: contiguous spans covering the whole input, classifying each region
 * as executable code, a quoted literal/identifier, or a comment.
 *
 * Its only consumer HERE is `stripSqlComments`, which the ref extractor and the
 * qualified-name detector both read. A comment is whitespace to Postgres, so a
 * regex that spans `\s*` cannot see `public/**\/.secrets` -- and neither could the
 * detector meant to backstop it, because it matched the same raw text (PEN-6600).
 * Lexing is the only way to tell a comment from the `/` of an operator or from a
 * `--` living inside a string literal, and a chain of regexes provably cannot:
 * strip quotes first and an apostrophe in a comment pairs with the next real
 * string; strip `--` first and it truncates a literal that legitimately contains
 * one.
 *
 * ⚠ `splitSqlStatements` and `stripSqlForKeywordScan` in this file do NOT yet read
 * these spans -- they still carry their own scanner and regex chain respectively,
 * exactly as on `master`. Routing those two through this lexer is PEN-5951 /
 * `Blockcast/paperclip#3734`.
 *
 * ⛔ THIS FUNCTION IS NO LONGER BYTE-IDENTICAL TO `#3734`'s COPY, and that changes
 * the rebase obligation recorded on PEN-5951. Until PEN-6600 round 6 the two copies
 * matched and whichever PR landed second could simply DELETE its duplicate. This
 * version adds the three literal and comment forms whose absence let a mis-lex delete
 * real SQL -- `E'\''` backslash escapes, dollar quotes, and nested block comments --
 * so the copy in `#3734` is now the STRICTLY OLDER one. Whichever lands second must
 * keep THIS body, not drop it; `#3734` routes two more callers through the lexer, and
 * routing them through the older copy reintroduces the parity desync for all three.
 */
function scanSqlSpans(input: string): SqlSpan[] {
  const spans: SqlSpan[] = [];
  let codeStart = 0;

  const closeCode = (end: number): void => {
    if (end > codeStart) spans.push({ kind: "code", start: codeStart, end });
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];

    if (char === "-" && next === "-") {
      closeCode(i);
      // Postgres: `newline [\n\r]`, so a CARRIAGE RETURN ends a line comment too.
      // Stopping only at `\n` ran `--x\r.secrets` to end of input and deleted the
      // qualified name from `stripSqlComments` output (PEN-6600 round 7).
      const lf = input.indexOf("\n", i);
      const cr = input.indexOf("\r", i);
      const terminator = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      const end = terminator === -1 ? input.length : terminator;
      spans.push({ kind: "comment", start: i, end });
      // The newline itself stays code, so it still separates tokens.
      i = end - 1;
      codeStart = end;
      continue;
    }

    if (char === "/" && next === "*") {
      closeCode(i);
      // Postgres block comments NEST: `/* a /* b */ c */` is ONE comment, so a scan
      // that stopped at the first `*/` ended the comment early and handed the rest
      // of it back as executable code.
      let depth = 1;
      let j = i + 2;
      while (j < input.length && depth > 0) {
        if (input[j] === "/" && input[j + 1] === "*") {
          depth += 1;
          j += 2;
          continue;
        }
        if (input[j] === "*" && input[j + 1] === "/") {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      // An unterminated comment runs to end of input, as an unterminated literal does.
      const end = depth === 0 ? j : input.length;
      spans.push({ kind: "comment", start: i, end });
      i = end - 1;
      codeStart = end;
      continue;
    }

    // A dollar-quoted string: `$tag$ ... $tag$`, tag optional. Nothing inside it is
    // escaped and nothing inside it ends it except the matching tag, so an
    // apostrophe in `$$'$$` is ordinary text. Reading it as a quote-open was what
    // inverted this lexer's parity and let the strip delete real SQL (PEN-6600).
    // `$1` is a parameter placeholder, not an opener: DOLLAR_QUOTE_TAG requires the
    // closing `$` of the tag, which a placeholder does not have.
    //
    // `$` is also a legal NON-INITIAL identifier character, so `a$b$c` is ONE
    // identifier to Postgres and its `$b$` is not an opener. Without the preceding
    // character test, lexing it as one would open a span to the end of the statement
    // -- reintroducing, through this very fix, the parity inversion it closes.
    if (char === "$" && !IDENTIFIER_CHAR_RE.test(input[i - 1] ?? "")) {
      DOLLAR_QUOTE_TAG.lastIndex = i;
      const opener = DOLLAR_QUOTE_TAG.exec(input);
      if (opener) {
        closeCode(i);
        const tag = opener[0]!;
        const closed = input.indexOf(tag, i + tag.length);
        const end = closed === -1 ? input.length : closed + tag.length;
        spans.push({ kind: "quoted", start: i, end });
        i = end - 1;
        codeStart = end;
        continue;
      }
    }

    if (char === "'" || char === "\"") {
      closeCode(i);
      const quote = char;
      // `E'...'` is an escape-string literal, where a backslash escapes the next
      // character -- so Postgres reads `E'\''` as ONE complete one-character literal.
      // Without this rule the span closed at the second quote and a new one opened at
      // the third, inverting quote parity for the whole rest of the statement
      // (PEN-6600). Plain `'...'` has no backslash escape under the default
      // `standard_conforming_strings`, so this must stay keyed on the `E`.
      const escapeString =
        quote === "'" &&
        (input[i - 1] === "E" || input[i - 1] === "e") &&
        !IDENTIFIER_CHAR_RE.test(input[i - 2] ?? "");
      let j = i + 1;
      for (; j < input.length; j += 1) {
        if (escapeString && input[j] === "\\") {
          j += 1;
          continue;
        }
        if (input[j] !== quote) continue;
        // A doubled quote is an escaped quote, not the end of the literal.
        if (input[j + 1] === quote) {
          j += 1;
          continue;
        }
        break;
      }
      // An unterminated literal runs to end of input, as the splitter always did.
      const end = j < input.length ? j + 1 : input.length;
      spans.push({ kind: "quoted", start: i, end, quote });
      i = end - 1;
      codeStart = end;
      continue;
    }
  }

  closeCode(input.length);
  return spans;
}

/**
 * The same input with comments replaced by a single space, and everything else --
 * code AND quoted spans -- kept verbatim.
 *
 * ⛔ LIMIT, and it is a trust boundary: "verbatim" holds only while `scanSqlSpans`
 * gets the quote parity RIGHT. Once parity is inverted, a `/*` inside a REAL string
 * literal is read as a comment open and every byte up to the next `*\/` is DELETED
 * from the output -- arbitrary real SQL, not just a comment. That is not a
 * hypothetical: it shipped here, and `master` refused statements this file allowed
 * (PEN-6600).
 *
 * The literal and comment forms that inverted parity -- `E'\''`, `$tag$...$`, a
 * NESTED block comment, a `\r`-terminated line comment and a high-bit character in
 * an identifier or a dollar-quote tag -- are now lexed. "No form I currently know
 * of" is the honest strength of that claim, and it is weaker than the one this
 * output needs: round 6 wrote "no form Postgres has is known to desync it" and two
 * more forms were found against the very next head. Do not promote it again.
 *
 * ⇒ Do NOT route a check through this function on the assumption that its output is
 * a superset, or even a faithful rendering, of the statement. A check must read this
 * output IN ADDITION TO the raw statement, never instead of it; see
 * `collectQualifiedRefs`, which exists for exactly that reason. Collapsing the three
 * scanners in this file onto this one lexer is still PEN-5951.
 *
 * This is what `extractQualifiedRefs` must read. The keyword scan blanks quoted
 * spans because it only cares about keywords; the ref extractor cannot, because a
 * quoted IDENTIFIER (`"schema"."table"`) is a ref, and because blanking literals
 * would hide the text the splitter already mis-lexed into one giant quoted span.
 *
 * The ref extractor used to regex the RAW statement while the keyword scan read
 * comment-stripped text, so the two halves of the validator disagreed about a block
 * comment placed between `UPDATE` and the table name: the keyword scan saw a legal
 * `UPDATE`, while `(update|into|from)` followed by whitespace could not match across
 * the comment. The real write target was therefore never extracted, and the
 * namespace check adjudicated some other in-namespace ref instead.
 *
 * ⚠ This closes that disagreement for the REF half only -- the extractor and the
 * detector now read one text. The keyword scan still reads its own
 * `stripSqlForKeywordScan` output, which blanks quoted spans because it only cares
 * about keywords; the ref extractor cannot blank them, because a quoted IDENTIFIER
 * (`"schema"."table"`) is a ref. Making all three read ONE lexer is PEN-5951.
 */
function stripSqlComments(input: string): string {
  let out = "";
  for (const span of scanSqlSpans(input)) {
    out += span.kind === "comment" ? " " : input.slice(span.start, span.end);
  }
  return out;
}


function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;

  for (const span of scanSqlSpans(input)) {
    if (span.kind !== "code") continue;
    for (let i = span.start; i < span.end; i += 1) {
      if (input[i] !== ";") continue;
      const statement = input.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlForKeywordScan(input: string): string {
  let out = "";
  for (const span of scanSqlSpans(input)) {
    if (span.kind === "code") {
      out += input.slice(span.start, span.end);
      continue;
    }
    if (span.kind === "quoted") {
      // `quote` is set only for `'` and `"`. A DOLLAR-quoted span (`$tag$ ... $tag$`)
      // has none, and this arm used to render it `""` -- erasing the `$$` that
      // `\bdo\s+\$\$` keys on, so `DO $$ ... $$` stopped matching the ban the moment
      // the lexer learned dollar-quoting (PEN-6600 rebase onto PEN-5951). An EMPTY
      // dollar-quoted string is the exact analogue of `''` and `""`: it hides the
      // body and keeps the delimiter the keyword scan reads.
      out += span.quote === "'" ? "''" : span.quote === '"' ? '""' : "$$$$";
      continue;
    }
    // A comment is whitespace to Postgres, so it must SEPARATE the tokens either
    // side of it. Replacing it with "" glued `create/**/extension` into a single
    // token that `\bcreate\s+extension\b` could not see.
    out += " ";
  }
  return out;
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const patterns: QualifiedRefPattern[] = [
    {
      pattern: new RegExp(String.raw`\b(from|join|references|into|update)\s+` + QUALIFIED_NAME, "gi"),
      groups: "keyword-schema-table",
    },
    {
      pattern: new RegExp(
        String.raw`\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?` +
          QUALIFIED_NAME,
        "gi",
      ),
      groups: "keyword-schema-table",
    },
    {
      pattern: new RegExp(
        String.raw`\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+` +
          QUALIFIED_NAME,
        "gi",
      ),
      groups: "schema-table",
      keyword: "create index",
    },
  ];

  for (const { pattern, ...mapping } of patterns) {
    for (const match of statement.matchAll(pattern)) {
      if (mapping.groups === "keyword-schema-table") {
        refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
      } else {
        refs.push({ keyword: mapping.keyword, schema: match[1]!, table: match[2]! });
      }
    }
  }
  return refs;
}

/**
 * Every qualified ref visible in EITHER the raw statement or its comment-stripped
 * form, plus both texts, so a caller can adjudicate against both.
 *
 * `stripSqlComments` is a PRE-PASS, and a pre-pass may only ever ADD to what gets
 * checked -- never remove. It removed: once `scanSqlSpans` had its quote parity
 * inverted, a `/*` sitting inside a REAL string literal was lexed as the start of a
 * comment and everything up to the next `*\/` -- arbitrary real SQL, including
 * `public.secrets` -- was replaced by a single space. Reading only the stripped text
 * then adjudicates a statement the database never sees, which `master` refused and
 * this file briefly allowed (PEN-6600).
 *
 * ⛔ READING BOTH IS NOT, BY ITSELF, SOUND, AND THIS DOCBLOCK SAID IT WAS. The
 * claim was that "a mis-lex can only ever hide a name from ONE of them". It is false
 * whenever TWO mechanisms are combined, because the two texts have two different
 * blind spots and one statement can carry both:
 *
 *   - a comment INSIDE the name (`public/**\/.secrets`, `public--x\n.secrets`) hid it
 *     from the RAW text, because `QUALIFIED_NAME` spanned `\s*` and not a comment;
 *   - an `E'\''` or `$$'$$` desync hid it from the STRIPPED text, by deleting it.
 *
 * Measured: six such statements -- on the query, execute and migration paths, one of
 * them an `INSERT ... SELECT` that copies core rows into a plugin-readable table --
 * were ALLOWED (PEN-6600 round 5, found by Ally). So the two blind spots are closed
 * SEPARATELY, and the union is what is left over rather than the argument:
 *
 *   1. `QUALIFIED_NAME` now spans `SQL_TOKEN_GAP`, so the RAW statement -- the exact
 *      bytes the database receives -- shows a comment-separated name with no lexer
 *      involved at all. This is the half that cannot be broken by a lexer bug.
 *   2. `scanSqlSpans` now lexes `E'\''`, dollar quotes, NESTED block comments,
 *      `\r`-terminated line comments and high-bit identifier and tag characters.
 *
 * ⛔ ROUND 6 STATED A RESIDUAL HERE AND THE RESIDUAL WAS THE NEXT TWO FINDINGS. It
 * read: "a NESTED block comment inside a qualified name is spanned by (2) and NOT by
 * (1), so for that one form the control does rest on the lexer being right. Every
 * other comment form is covered by both." Both halves were wrong. A `\r`-terminated
 * line comment was covered by NEITHER text, and the nested form was reachable by
 * pairing it with any lexer desync -- which is what a residual resting on the lexer
 * MEANS, and it was written down as though stating it made it safe.
 *
 * ⇒ A stated residual is not a closed one. (1) can never span a nested comment
 * because a regular expression cannot count, so the nesting is REFUSED in the raw
 * statement instead (`hasNestedBlockComment`) and (1) never meets one.
 *
 * That turns (1) from "covers every form we thought of" into a COMPLETENESS claim
 * for the one position that matters -- a comment sitting INSIDE a qualified name.
 * Such a comment has text after it, so it is terminated, so it is one of exactly
 * three forms, and every one is accounted for without consulting the lexer:
 *
 *   - a line comment ended by `\n` or `\r`  -> SPANNED by SQL_TOKEN_GAP
 *   - a non-nested block comment             -> SPANNED by SQL_TOKEN_GAP
 *   - a NESTED block comment                 -> REFUSED by `hasNestedBlockComment`
 *
 * (an unterminated comment is not a fourth case: Postgres rejects the statement.)
 *
 * ⚠ MEASURED CONSEQUENCE, recorded because it looks like a reason to delete (2):
 * once (1) is complete, (2) cannot change a VERDICT, so no test in this file pins
 * the high-bit character classes -- reverting them leaves the suite green (measured,
 * PEN-6600 round 7). They are kept anyway, and NOT as belt-and-braces: `scanSqlSpans`
 * is a lexer, its correctness is its own property, and PEN-5951 routes
 * `splitSqlStatements` and `stripSqlForKeywordScan` through it. Against THOSE callers
 * a desync is redundant with nothing. Do not drop them because the suite stays green.
 *
 * Measured over the 204 shipped plugin statements: 0 carry a schema-shaped qualified
 * name visible in one of these texts and not the other, so adjudicating both refuses
 * nothing that ships today.
 */
function collectQualifiedRefs(statement: string): {
  refs: SqlRef[];
  texts: readonly string[];
} {
  const stripped = stripSqlComments(statement);
  const texts = stripped === statement ? [statement] : [statement, stripped];
  const refs: SqlRef[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const ref of extractQualifiedRefs(text)) {
      const key = `${ref.keyword}\u0000${ref.schema.toLowerCase()}\u0000${ref.table.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return { refs, texts };
}

/**
 * Runs the unextracted-ref detector over every text the refs were collected from.
 *
 * Both halves of the control must read every text, not one each: a name the extractor
 * could not reach in the text where it IS visible is exactly what the detector exists
 * to refuse.
 */
function assertNoUnextractedSchemaRefsInAll(
  texts: readonly string[],
  refs: readonly SqlRef[],
  namespace: string,
  knownSchemas: ReadonlySet<string>,
): void {
  for (const text of texts) {
    assertNoUnextractedSchemaRefs(text, refs, namespace, knownSchemas);
  }
}

/**
 * Refuses a statement that names a schema-qualified object the ref patterns did not
 * extract.
 *
 * Every pattern above is anchored on a keyword (`FROM x.y`, `UPDATE x.y`, ...), so
 * each one only ever reads the FIRST operand of a relation list. In
 * `FROM plugin_ns.rows, public.secrets` the second relation is matched by nothing,
 * and the loops below then adjudicate the statement on the one ref that WAS read.
 * A `refs.length === 0` floor cannot see that case, because the ref count is 1.
 *
 * Rather than enumerate the positions a keyword-anchored pattern misses -- that is a
 * blocklist, and the next form nobody anticipated reopens the hole -- this asserts
 * the invariant the callers actually rely on: every schema-qualified name in the
 * statement was adjudicated. Anything the extractor could not read is refused
 * instead of ignored.
 *
 * It reads the SAME text the extractor read, for the reason recorded on PEN-5951:
 * two halves of one control that disagree about what the text says are exploitable
 * in whichever direction the gap opens.
 *
 * This reads the CHARACTERS of a name, so it holds only while the characters are the
 * name. `assertNoBannedSql` refuses `U&"..."` to keep that true -- see
 * `UNICODE_ESCAPE_IDENTIFIER`.
 *
 * The scan OVERLAPS, which a plain `matchAll` does not. Postgres accepts a three-part
 * `catalog.schema.table` when the catalog is the current database, and a plugin can
 * learn that name with `SELECT current_database()`. A non-overlapping scan of
 * `paperclip.public.secrets` matches `paperclip.public` -- whose schema `paperclip` is
 * neither the namespace nor schema-shaped, so it is skipped as a table alias -- and
 * then resumes AFTER `public`, so `public.secrets` is never considered at all and the
 * invariant this function exists to assert quietly did not hold (PEN-6600).
 *
 * Matching every adjacent pair instead of every other one closes that for any depth,
 * rather than banning the three-part form -- a ban is a blocklist, and the four-part
 * name reopens it. The lookbehind keeps the scan anchored to identifier starts: without
 * it, a lookahead scan also matches `public.secrets` INSIDE `xpublic.secrets`, which
 * refuses a statement naming a schema nobody asked about.
 */
function assertNoUnextractedSchemaRefs(
  statement: string,
  refs: readonly SqlRef[],
  namespace: string,
  knownSchemas: ReadonlySet<string>,
): void {
  const extracted = new Set(
    refs.map((ref) => `${ref.schema.toLowerCase()}.${ref.table.toLowerCase()}`),
  );
  for (const match of statement.matchAll(OVERLAPPING_QUALIFIED_NAME)) {
    const schema = match[1]!;
    const table = match[2]!;
    if (extracted.has(`${schema.toLowerCase()}.${table.toLowerCase()}`)) continue;
    const schemaLower = schema.toLowerCase();
    // A name that really is a schema is adjudicated unconditionally; only a left side
    // that is NOT a schema can be exempt.
    // The old test was the other way round -- skip unless the left side LOOKED like a
    // schema -- which silently exempted every real schema the pattern did not
    // anticipate, `drizzle` among them (PEN-6604).
    //
    // `knownSchemas` is what makes the exemption SOUND rather than a guess: if a name
    // is not a schema in this database, `name.table` cannot be a relation reference at
    // all, so skipping it cannot hide one. Without it the exemption is only as good as
    // `SCHEMA_SHAPED_RE`, and a statement buys itself an exemption by declaring an
    // alias or CTE named after the schema it wants (reproduced on #3739). Every
    // runtime and migration call site passes it.
    const namesAnExistingSchema =
      schemaLower === namespace.toLowerCase() ||
      SCHEMA_SHAPED_RE.test(schemaLower) ||
      knownSchemas.has(schemaLower);
    // Not a schema in this database ⇒ `name.table` cannot be a relation reference at
    // all, so exempting it cannot hide one. That also covers a name the statement
    // declared for itself (an alias, a CTE) and a name that is an artefact of a
    // comment sitting inside a real name -- `plugin_test--c\n.rows` scans as `c.rows`
    // in the raw text (PEN-6600). Refusing those would be a false refusal on ordinary
    // in-namespace SQL, which is what `#3737`'s `xpublic.secrets` and `c.rows` cases
    // pin. A name that IS a schema is adjudicated unconditionally, so a declared
    // correlation can no longer buy an exemption for one (PEN-6604, the `drizzle`
    // bypass) -- consulting the real schema set subsumes the correlation test that
    // used to guard this, which is why no correlation lookup remains here.
    if (!namesAnExistingSchema) continue;
    throw new Error(
      `Plugin SQL names ${schema}.${table} in a position this validator cannot adjudicate`,
    );
  }
}

function assertAllowedPublicRead(
  ref: SqlRef,
  allowedCoreReadTables: ReadonlySet<string>,
): void {
  if (ref.schema !== "public") return;
  if (!allowedCoreReadTables.has(ref.table)) {
    throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
  }
  if (!["from", "join", "references"].includes(ref.keyword)) {
    throw new Error(`Plugin SQL cannot mutate or define objects in public.${ref.table}`);
  }
}

/**
 * Postgres lets an identifier be spelled with Unicode escapes, so `U&"\0070ublic"` IS
 * `public` -- the characters that write the name and the name it resolves to are two
 * different strings. Every control in this file reads the characters. `QUALIFIED_NAME`
 * matches its leftmost candidate inside `U&"\0070ublic".secrets` at `ublic".secrets`,
 * yielding schema `ublic`, which `SCHEMA_SHAPED_RE` then skips as a table alias -- so
 * the extractor, the detector and the write-target reader all agree the statement does
 * not touch `public`, and it reads `public.secrets`. Measured against a real Postgres
 * engine: it returns the row.
 *
 * This is NOT one more entry in a blocklist of positions, which is the shape this
 * validator is built to avoid. `U&"..."` is the ONLY form in the grammar where a
 * quoted identifier's decoded name differs from the characters spelling it: the sole
 * escape inside a plain `"..."` is `""`, which can produce a literal quote and so can
 * never spell a DIFFERENT schema. Refusing the form closes the class.
 *
 * ⛔ It closes the class ONLY BECAUSE IT READS THE RAW STATEMENT. Testing `normaliseSql`
 * output instead -- which is what this guard did when it was first written -- blanks
 * quoted spans through `stripSqlForKeywordScan`, whose regex chain has no
 * backslash-escape rule. (`scanSqlSpans` has had one since PEN-6600 round 6, but this
 * guard does not read it, and the keyword chain is a SEPARATE scanner -- that is what
 * PEN-5951 exists to collapse.) Postgres reads `E'\''` as a complete one-character
 * literal; the chain closes the span at the second quote and opens a new one at the
 * third, so every character up to the next quote is blanked -- including a `U&"` living
 * in it. Measured: `… WHERE a = E'\'' AND b IN (SELECT 1 FROM
 * U&"\0070ublic".secrets) …` ALLOWED on all three paths against the blanked text and
 * REFUSES against the raw text, while the same statement naming a plain `public.secrets`
 * refused either way -- so the desync was specific to this guard.
 *
 * Reading raw costs nothing a blanked read was buying: a genuine `"..."` identifier can
 * never contain a `U&"` (it would have to open a second quote), so blanking could only
 * ever hide the thing this looks for. A `U&"` inside a string literal or a comment is
 * now refused too. That fails CLOSED and matches 0 shipped statements -- there are 0
 * occurrences of `u&"` anywhere in this repo's plugin corpus.
 *
 * The alternative -- decoding the escapes here -- would put a second identifier lexer
 * in the file that PEN-5951 exists to collapse to one, to buy a syntax no plugin uses.
 *
 * `U&'...'` -- the STRING form -- stays allowed on purpose: a literal cannot name a
 * relation, so it reaches none of this. `\b` is load-bearing; without it a column
 * named `menu` bitwise-anded with a quoted name (`menu&"x"`) would be refused, and
 * that is not this form.
 */
const UNICODE_ESCAPE_IDENTIFIER = /\bu&"/;

/**
 * A block comment that contains another block-comment opener.
 *
 * Postgres block comments NEST: `/* a /* b *\/ c *\/` is ONE comment. `SQL_TOKEN_GAP`
 * reads the RAW statement and so is the half of this control that a lexer bug cannot
 * blind -- but a regular expression provably cannot count, so it stops at the first
 * `*\/` and can never span a nested comment. Round 6 recorded that as a residual
 * covered "by the lexer instead", and round 7 found both of the statements that
 * residual admits: pair a nested comment with ANY desync of `scanSqlSpans` and the
 * name is invisible to both texts at once.
 *
 * Refusing the form is what removes the dependency rather than restating it. The
 * check reads the raw statement and deliberately does NOT lex: consulting
 * `scanSqlSpans` to find out which `/*` are "really" comments would put this guard
 * back on the trust path it exists to leave.
 *
 * ⚠ The cost of not lexing, stated because it is a real false refusal: a statement
 * whose STRING LITERALS carry an unbalanced `/*` (`a = '/*' AND b = '/*'`) is counted
 * as nesting and refused. That fails CLOSED, and it is measured: 0 of the 190 shipped
 * plugin statements contain `/*` at all, so nothing that ships today pays it. Two
 * separate, properly closed block comments are NOT nesting and stay allowed -- that
 * is the control in the tests, because "refuse a second comment" would be a far
 * wider rule wearing the same name.
 */
function hasNestedBlockComment(statement: string): boolean {
  let depth = 0;
  for (let i = 0; i + 1 < statement.length; i += 1) {
    if (statement[i] === "/" && statement[i + 1] === "*") {
      depth += 1;
      if (depth > 1) return true;
      i += 1;
      continue;
    }
    if (statement[i] === "*" && statement[i + 1] === "/") {
      if (depth > 0) depth -= 1;
      i += 1;
    }
  }
  return false;
}

/**
 * Postgres escape strings (`E'...'`) treat a backslash as an escape, so `E'\''`
 * is a literal containing one quote. `scanSqlSpans` does not lex backslashes -- it
 * reads `''` as a doubled quote and keeps going -- so an escape string lets a
 * caller hide a `;` and a whole second statement inside what the lexer believes is
 * one unterminated literal. `splitSqlStatements` then reports a single statement
 * and the keyword scan sees only the blanked literal.
 *
 * Refusing the prefix is the fail-closed answer and costs nothing: no `.sql` file
 * in this repo uses one. Lexing backslash escapes would mean tracking
 * `standard_conforming_strings`, which the host cannot see.
 *
 * Dollar-quoting (`$$ ... $$`) is NOT in this family: the lexer does not know it
 * either, but that makes a `;` inside it read as CODE, so the statement splitter
 * refuses it as more than one statement rather than swallowing it.
 */
function assertNoEscapeStringLiterals(statement: string): void {
  for (const span of scanSqlSpans(statement)) {
    if (span.kind !== "quoted" || span.quote !== "'") continue;
    const prefix = statement[span.start - 1];
    if (prefix !== "e" && prefix !== "E") continue;
    // `LIKE'x'` is legal SQL and ends in an E; only a STANDALONE e/E is a prefix.
    const beforePrefix = statement[span.start - 2];
    if (beforePrefix !== undefined && /[A-Za-z0-9_]/.test(beforePrefix)) continue;
    throw new Error(
      "Plugin SQL cannot use escape string literals (E'...'): backslash escapes are not lexed",
    );
  }
}

function assertNoBannedSql(statement: string): void {
  assertNoEscapeStringLiterals(statement);
  const normalized = normaliseSql(statement);
  // RAW text, deliberately -- NOT `normalized`. See `hasNestedBlockComment`.
  if (hasNestedBlockComment(statement)) {
    throw new Error(
      "Plugin SQL contains a nested block comment, which the raw-statement name scan cannot span",
    );
  }
  // RAW text, deliberately -- NOT `normalized`. See `UNICODE_ESCAPE_IDENTIFIER`.
  if (UNICODE_ESCAPE_IDENTIFIER.test(statement.toLowerCase())) {
    throw new Error(
      "Plugin SQL uses a Unicode-escape identifier (U&\"...\"), whose decoded name this validator cannot adjudicate",
    );
  }
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) {
    throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
  }
}

/**
 * The write target of a runtime `execute`, read from the statement's LEADING
 * keyword rather than found among the refs.
 *
 * `refs.find(keyword in {into, update, from})` returned the first ref carrying ANY
 * write-ish keyword, and `from` is in that set because `DELETE FROM x.y` needs it.
 * So in `UPDATE agents SET name = $1 FROM plugin_ns.rows` -- whose real target is
 * unqualified and therefore extracted by nothing -- the in-namespace `FROM` operand
 * was promoted into the target slot and the statement passed, writing `public.agents`
 * through `search_path`. The target has to come from the one position that IS the
 * target, and an operand that is not a qualified name there is refused rather than
 * replaced by a later one.
 */
const LEADING_WRITE_TARGET = new RegExp(
  String.raw`^\s*(?:insert\s+into|update|delete\s+from)\s+` + QUALIFIED_NAME,
  "i",
);

function extractLeadingWriteTarget(scanText: string): { schema: string; table: string } | null {
  const match = LEADING_WRITE_TARGET.exec(scanText);
  if (!match) return null;
  return { schema: match[1]!, table: match[2]! };
}

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
  knownSchemas: ReadonlySet<string>,
): void {
  assertIdentifier(namespace, "namespace");
  assertNoBannedSql(statement);

  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) {
    throw new Error("Destructive plugin migrations are not allowed in Phase 1");
  }

  if (/\bdelete\s+from\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot delete data");
  }

  const ddlOrBackfillAllowed =
    /^(create|alter|comment)\b/.test(normalized) ||
    /^(insert\s+into|update)\b/.test(normalized) ||
    (normalized.startsWith("with ") && /\b(insert\s+into|update)\b/.test(normalized));
  if (!ddlOrBackfillAllowed) {
    throw new Error("Plugin migrations may contain DDL or namespace-scoped backfill statements only");
  }

  const { refs, texts } = collectQualifiedRefs(statement);
  if (refs.length === 0 && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }

  // `COMMENT ON COLUMN` names a THREE-part object (schema.table.column) that the ref
  // patterns were never built to read, which is why the floor above already exempts
  // it. The detector inherits that same carve-out rather than inventing a second rule
  // which would disagree with it. Measured: without this, five shipped
  // `COMMENT ON TABLE`/`COMMENT ON COLUMN` statements change verdict.
  if (!normalized.startsWith("comment ")) {
    assertNoUnextractedSchemaRefsInAll(texts, refs, namespace, knownSchemas);
  }

  const objectRefKeywords = new Set([
    "alter table",
    "create index",
    "create table",
    "create view",
    "drop table",
    "into",
    "truncate table",
    "update",
  ]);
  const hasQualifiedObjectRef = refs.some((ref) => objectRefKeywords.has(ref.keyword));
  if (!hasQualifiedObjectRef && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }

  const allowedCoreReadTables = new Set(coreReadTables);
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`Plugin SQL references schema "${ref.schema}" outside namespace "${namespace}"`);
  }
}

export function validatePluginRuntimeQuery(
  query: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
  knownSchemas: ReadonlySet<string>,
): void {
  // BEFORE the split, deliberately. The whole reason this prefix is banned is that a
  // backslash escape can hide a statement boundary, so the splitter must not be the
  // first thing to adjudicate input that carries one. `assertNoBannedSql` also calls
  // this, which is what covers the migration path -- it is handed a single statement.
  assertNoEscapeStringLiterals(query);
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("ctx.db.query only allows SELECT statements");
  }
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
  }

  const allowedCoreReadTables = new Set(coreReadTables);
  const { refs, texts } = collectQualifiedRefs(statement);
  // `validatePluginMigrationStatement` has carried this floor all along; this path did
  // not, so a statement the extractor could not read fell straight out of the loop
  // below and returned normally -- ALLOWED. This is the half of PEN-6600 that fails
  // closed on a lexical form nobody anticipated, where the pattern fix only closes the
  // forms we did think of.
  //
  // Measured against the `ctx.db.query`/`ctx.db.execute` statements shipped in this
  // repo: every one of them already qualifies at least one relation, so no currently
  // valid statement changes verdict.
  //
  // LIMIT, stated because an earlier draft of this comment claimed more than the code
  // does: the floor closes an UNQUALIFIED relation name -- which `search_path` resolves
  // against `public` -- only when the statement qualifies NOTHING. One in-namespace
  // relation makes the count 1 and the floor cannot fire, so `FROM plugin_ns.rows,
  // secrets` still reads `public.secrets`. Nothing here can close that: the detector
  // below sees qualified names only, and telling a relation name from a column name
  // needs a real parse. The structural answer is to pin `search_path` on the
  // connection that runs plugin SQL, which is PEN-6604, not this validator.
  if (refs.length === 0) {
    throw new Error("ctx.db.query must name every relation it reads as schema.table");
  }
  assertNoUnextractedSchemaRefsInAll(texts, refs, namespace, knownSchemas);
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
  }
}

export function validatePluginRuntimeExecute(
  query: string,
  namespace: string,
  knownSchemas: ReadonlySet<string>,
): void {
  // BEFORE the split, deliberately. The whole reason this prefix is banned is that a
  // backslash escape can hide a statement boundary, so the splitter must not be the
  // first thing to adjudicate input that carries one. `assertNoBannedSql` also calls
  // this, which is what covers the migration path -- it is handed a single statement.
  assertNoEscapeStringLiterals(query);
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain DDL keywords");
  }

  const { refs, texts } = collectQualifiedRefs(statement);
  // Before the target is chosen, not after: a write target the extractor could not
  // read used to promote some other in-namespace ref into its place, so the namespace
  // check adjudicated the wrong object.
  assertNoUnextractedSchemaRefsInAll(texts, refs, namespace, knownSchemas);
  // Read from the leading keyword, so an unqualified target is REFUSED rather than
  // replaced by a later in-namespace ref. See `extractLeadingWriteTarget`.
  //
  // Read from EVERY text for the same reason the refs are: a mis-lex can only hide
  // the target from one of them, and a target that is out of namespace in ANY reading
  // is refused. A comment between the keyword and the name (`INSERT INTO /*c*/ x.y`)
  // yields no target in the raw text at all, which is why one non-null is enough.
  const targets = texts
    .map((text) => extractLeadingWriteTarget(text))
    .filter((t): t is { schema: string; table: string } => t !== null);
  if (targets.length === 0) {
    throw new Error(
      "ctx.db.execute must name its write target as schema.table directly after INSERT INTO, UPDATE or DELETE FROM",
    );
  }
  for (const target of targets) {
    if (target.schema !== namespace) {
      throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
    }
  }
  for (const ref of refs) {
    if (ref.schema !== namespace) {
      throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
    }
  }
}

function bindSql(statement: string, params: readonly unknown[] = []): SQL {
  // Safe only after callers run the plugin SQL validators above.
  if (params.length === 0) return sql.raw(statement);
  const chunks: SQL[] = [];
  let cursor = 0;
  const placeholderPattern = /\$(\d+)/g;
  const seen = new Set<number>();

  for (const match of statement.matchAll(placeholderPattern)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > params.length) {
      throw new Error(`SQL placeholder $${match[1]} has no matching parameter`);
    }
    chunks.push(sql.raw(statement.slice(cursor, match.index)));
    // sql.param binds one value; a bare sql`${array}` expands to ($1, $2, …)
    // and breaks `= ANY($n::text[])` (BLO-51097).
    chunks.push(sql`${sql.param(params[index - 1])}`);
    seen.add(index);
    cursor = match.index! + match[0].length;
  }
  chunks.push(sql.raw(statement.slice(cursor)));
  if (seen.size !== params.length) {
    throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
  }
  return sql.join(chunks, sql.raw(""));
}

async function listSqlMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function resolveMigrationsDir(packageRoot: string, migrationsDir: string): string {
  const resolvedRoot = path.resolve(packageRoot);
  const resolvedDir = path.resolve(resolvedRoot, migrationsDir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plugin migrationsDir escapes package root: ${migrationsDir}`);
  }
  return resolvedDir;
}

type PluginDatabaseClient = Pick<Db, "select" | "insert" | "update" | "execute">;
type PluginDatabaseRootClient = PluginDatabaseClient & Partial<Pick<Db, "transaction">>;

export interface ApplyPluginMigrationsOptions {
  /**
   * Persist failed migration ledger rows. Fresh install uses false because the
   * caller owns a larger transaction and must roll back the plugin row and
   * namespace together.
   */
  persistFailure?: boolean;
}

export function pluginDatabaseService(db: PluginDatabaseRootClient) {
  async function getPluginRecord(pluginId: string) {
    const rows = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    const plugin = rows[0];
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  async function ensureNamespaceWithClient(
    client: PluginDatabaseClient,
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
  ) {
    if (!manifest.database) return null;
    const namespaceName = derivePluginDatabaseNamespace(
      manifest.id,
      manifest.database.namespaceSlug,
    );
    await client.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespaceName)}`));
    const rows = await client
      .insert(pluginDatabaseNamespaces)
      .values({
        pluginId,
        pluginKey: manifest.id,
        namespaceName,
        namespaceMode: "schema",
        status: "active",
      })
      .onConflictDoUpdate({
        target: pluginDatabaseNamespaces.pluginId,
        set: {
          pluginKey: manifest.id,
          namespaceName,
          namespaceMode: "schema",
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0] ?? null;
  }

  async function ensureNamespace(pluginId: string, manifest: PaperclipPluginManifestV1) {
    return ensureNamespaceWithClient(db, pluginId, manifest);
  }

  async function getNamespace(pluginId: string) {
    const rows = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginId, pluginId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The schemas that exist in this database, lowercased.
   *
   * `assertNoUnextractedSchemaRefs` needs this to tell a schema name from a relation
   * alias: if a left side is not a schema here, `name.table` cannot be a relation
   * reference, so exempting it cannot hide one. Without it the exemption is only as
   * strong as `SCHEMA_SHAPED_RE`, and a statement buys an exemption for `drizzle` by
   * declaring an alias or a CTE of that name (#3739 review).
   *
   * Memoised for the life of the service and deliberately never invalidated. It is a
   * SUPPLEMENT to `SCHEMA_SHAPED_RE`, never a replacement: every schema this system
   * creates after startup is a plugin namespace, which `derivePluginDatabaseNamespace`
   * always prefixes `plugin_`, so the regex already covers it and a stale set cannot
   * open a gap. What the read adds is the schemas created by core migrations --
   * `drizzle` today -- which exist before any plugin runs.
   *
   * It fails CLOSED: a failed read rejects the statement rather than falling back to
   * the shape guess this exists to replace.
   */
  let knownSchemaNames: ReadonlySet<string> | null = null;
  async function loadKnownSchemaNames(
    client: PluginDatabaseClient,
  ): Promise<ReadonlySet<string>> {
    if (knownSchemaNames) return knownSchemaNames;
    const rows = await client.execute(sql`SELECT nspname FROM pg_catalog.pg_namespace`);
    const names = new Set(
      Array.from(rows as Iterable<{ nspname?: unknown }>)
        .map((row) => String(row.nspname ?? "").toLowerCase())
        .filter((name) => name.length > 0),
    );
    if (names.size === 0) {
      throw new Error("Could not read the database schema list to validate plugin SQL");
    }
    knownSchemaNames = names;
    return knownSchemaNames;
  }

  /**
   * Runs one already-validated plugin statement with `search_path` pinned to the
   * plugin's own namespace, inside its own transaction.
   *
   * WHY, and it is not a second validator: the lexical validators above adjudicate
   * SCHEMA-QUALIFIED names. An UNQUALIFIED relation name is not one, so
   * `FROM plugin_ns.rows, secrets` names `secrets` in a position no pattern is
   * anchored on, the `refs.length === 0` floor cannot fire because the statement
   * qualifies one relation, and `assertNoUnextractedSchemaRefs` sees qualified names
   * only, by construction. Postgres then resolved `secrets` through `search_path`,
   * which nothing on this path set -- so it reached `public` (PEN-6604).
   *
   * Telling a relation name from a column name lexically needs a real parse of the
   * relation list, and the shipped corpus contains the shapes that make that
   * dangerous (`SELECT EXTRACT(DOW FROM created_at) ... FROM ns.rows` is an existing
   * positive control in `plugin-database.test.ts`). A false refusal here breaks a
   * live plugin at request time, which is worse than the residual it would close.
   * Pinning `search_path` needs no parse and cannot false-refuse: an unqualified name
   * now resolves inside the namespace, or does not resolve at all.
   *
   * ONE EXCEPTION, and it is not closed here: `pg_catalog` is searched implicitly and
   * BEFORE anything this sets, so an unqualified catalog relation --
   * `FROM plugin_ns.anchor, pg_stat_activity` -- still resolves outside the namespace,
   * even though the qualified `pg_catalog.pg_stat_activity` form is refused. Postgres
   * offers no way to take `pg_catalog` out of the path, so closing it would need the
   * lexical refusal of bare `pg_*` relation names this comment's own argument rejects
   * -- `pg_typeof(...)`, `pg_size_pretty(...)` and friends are legitimate, so the rule
   * would have to tell a function call from a relation. Raised on #3739 and left open
   * deliberately; it is a read of cluster metadata, not of tenant data.
   *
   * `pg_catalog` stays implicitly searched whatever this sets, so `now()`, `count()`,
   * `EXTRACT`, `gen_random_uuid()` (core since PG 13) and every built-in type keep
   * resolving. `public` is deliberately NOT in the path.
   *
   * For a core TABLE that costs nothing: `FROM public.issues` is qualified, and the
   * validators adjudicate it against `coreReadTables` as they always did.
   *
   * For a core FUNCTION it is a real narrowing, and the honest statement is stronger
   * than "qualify it": a `public` function becomes unreachable from plugin SQL
   * altogether. Unqualified it no longer resolves; qualified, `public.f(...)` is
   * refused by `assertNoUnextractedSchemaRefs`, because no ref pattern is anchored on
   * a function call and `public` is a schema it must adjudicate. That second refusal
   * predates this change. Measured on this repo's plugin corpus: no plugin SQL calls
   * a function or uses an operator class living in `public` -- `pg_trgm`, `btree_gin`
   * and `fuzzystrmatch` ARE installed there by the core migrations and nothing in a
   * plugin reaches for them -- so nothing breaks today. A plugin that needs one will
   * need this validator changed, not just a qualification.
   *
   * `SET LOCAL` and not `SET`: `db` is the shared pool, so a session-level `SET`
   * would leak this plugin's namespace onto every later user of that connection.
   * `SET LOCAL` is scoped to the surrounding transaction, which is why this opens
   * one. A client with no `transaction` is REFUSED rather than run unpinned -- an
   * unpinned fallback would silently restore the hole on exactly the path this
   * exists to close. Every production caller passes a full `Db`
   * (`buildHostServices`), so the refusal is unreachable there; the `Partial<>` in
   * `PluginDatabaseRootClient` exists for narrower test doubles.
   */
  async function runWithPinnedSearchPath(namespace: string, statement: SQL): Promise<unknown> {
    if (typeof db.transaction !== "function") {
      throw new Error(
        "Plugin runtime SQL needs a transactional database client so search_path can be pinned to the plugin namespace",
      );
    }
    return db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${quoteIdentifier(namespace)}`));
      return tx.execute(statement);
    });
  }

  async function getRuntimeNamespace(pluginId: string) {
    const namespace = await getNamespace(pluginId);
    if (!namespace || namespace.status !== "active") {
      throw new Error("Plugin database namespace is not active");
    }
    return namespace.namespaceName;
  }

  async function recordMigrationFailure(client: PluginDatabaseClient, input: {
    pluginId: string;
    pluginKey: string;
    namespaceName: string;
    migrationKey: string;
    checksum: string;
    pluginVersion: string;
    error: unknown;
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await client
      .insert(pluginMigrations)
      .values({
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        namespaceName: input.namespaceName,
        migrationKey: input.migrationKey,
        checksum: input.checksum,
        pluginVersion: input.pluginVersion,
        status: "failed",
        errorMessage: message,
      })
      .onConflictDoUpdate({
        target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
        set: {
          checksum: input.checksum,
          pluginVersion: input.pluginVersion,
          status: "failed",
          errorMessage: message,
          startedAt: new Date(),
          appliedAt: null,
        },
      });
    await client
      .update(pluginDatabaseNamespaces)
      .set({ status: "migration_failed", updatedAt: new Date() })
      .where(eq(pluginDatabaseNamespaces.pluginId, input.pluginId));
  }

  return {
    ensureNamespace,

    async applyMigrations(
      pluginId: string,
      manifest: PaperclipPluginManifestV1,
      packageRoot: string,
      options: ApplyPluginMigrationsOptions = {},
    ) {
      if (!manifest.database) return null;
      const namespace = await ensureNamespace(pluginId, manifest);
      if (!namespace) return null;

      const migrationDir = resolveMigrationsDir(packageRoot, manifest.database.migrationsDir);
      const migrationFiles = await listSqlMigrationFiles(migrationDir);
      const coreReadTables = manifest.database.coreReadTables ?? [];
      const lockKey = Number.parseInt(createHash("sha256").update(pluginId).digest("hex").slice(0, 12), 16);
      const persistFailure = options.persistFailure ?? true;

      const applyWithClient = async (client: PluginDatabaseClient) => {
        await client.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        for (const migrationKey of migrationFiles) {
          const content = await readFile(path.join(migrationDir, migrationKey), "utf8");
          const checksum = createHash("sha256").update(content).digest("hex");
          const existingRows = await client
            .select()
            .from(pluginMigrations)
            .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.migrationKey, migrationKey)))
            .limit(1);
          const existing = existingRows[0] as PluginMigrationRecord | undefined;
          if (existing?.status === "applied") {
            if (existing.checksum !== checksum) {
              throw new Error(`Plugin migration checksum mismatch for ${migrationKey}`);
            }
            continue;
          }

          const statements = splitSqlStatements(content);
          try {
            // Inside the `try`, so a failed schema read records a migration failure row
            // like every other validation refusal on this path rather than throwing past
            // the ledger (#3739 review). It still fails closed either way.
            const knownSchemas = await loadKnownSchemaNames(client);
            if (statements.length === 0) {
              throw new Error(`Plugin migration ${migrationKey} is empty`);
            }
            for (const statement of statements) {
              validatePluginMigrationStatement(
                statement,
                namespace.namespaceName,
                coreReadTables,
                knownSchemas,
              );
              await client.execute(sql.raw(statement));
            }
            await client
              .insert(pluginMigrations)
              .values({
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                status: "applied",
                appliedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
                set: {
                  checksum,
                  pluginVersion: manifest.version,
                  status: "applied",
                  errorMessage: null,
                  startedAt: new Date(),
                  appliedAt: new Date(),
                },
              });
          } catch (error) {
            if (persistFailure) {
              await recordMigrationFailure(db, {
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                error,
              });
            }
            throw error;
          }
        }
      };

      if (typeof db.transaction === "function") {
        await db.transaction(async (tx) => applyWithClient(tx as PluginDatabaseClient));
      } else {
        await applyWithClient(db);
      }

      return namespace;
    },

    getRuntimeNamespace,

    async query<T = Record<string, unknown>>(pluginId: string, statement: string, params?: unknown[]): Promise<T[]> {
      const plugin = await getPluginRecord(pluginId);
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeQuery(
        statement,
        namespace,
        plugin.manifestJson.database?.coreReadTables ?? [],
        await loadKnownSchemaNames(db),
      );
      const result = await runWithPinnedSearchPath(namespace, bindSql(statement, params));
      return Array.from(result as Iterable<T>);
    },

    async execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }> {
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeExecute(statement, namespace, await loadKnownSchemaNames(db));
      const result = await runWithPinnedSearchPath(namespace, bindSql(statement, params));
      return { rowCount: Number((result as { count?: number | string }).count ?? 0) };
    },
  };
}

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issueRelations,
  issues,
  pluginConfig,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";
import { buildPluginWorkerEnv, pluginLoader } from "../services/plugin-loader.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const multiMigrationPluginKey = "paperclip.dbfixture";
const llmWikiPluginKey = "paperclipai.plugin-llm-wiki";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin database tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("plugin database SQL validation", () => {
  it("allows namespace migrations with whitelisted public foreign keys", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
  });

  it("allows qualified index creation and namespace-scoped migration backfills", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE INDEX IF NOT EXISTS rows_issue_idx ON plugin_test.rows (issue_id)",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `
        WITH source_rows AS (
          SELECT id FROM plugin_test.rows
        )
        INSERT INTO plugin_test.row_copies (id)
        SELECT id FROM source_rows
        ON CONFLICT (id) DO NOTHING
        `,
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        `
        UPDATE plugin_test.rows r
        SET copied_from_id = s.id
        FROM plugin_test.source_rows s
        WHERE s.id = r.id
        `,
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("keeps migration backfill writes scoped to the plugin namespace", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/fully qualified/i);
    expect(() =>
      validatePluginMigrationStatement(
        "WITH source_rows AS (SELECT id FROM plugin_test.rows) INSERT INTO public.issues (id) SELECT id FROM source_rows",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
    expect(() =>
      validatePluginMigrationStatement(
        "UPDATE public.issues SET title = 'bad'",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("rejects migrations that create public objects", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE public.rows (id uuid PRIMARY KEY)",
        "plugin_test",
        ["issues"],
      )
    ).toThrow(/public/i);
  });

  it("allows whitelisted runtime reads but rejects public writes", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id",
        "plugin_test",
        ["issues"],
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute("UPDATE public.issues SET title = $1", "plugin_test")
    ).toThrow(/namespace/i);
  });

  it("accepts a migration whose line comment carries an odd number of apostrophes", () => {
    // The comment's last unpaired apostrophe used to pair with the opening quote of
    // the first real literal, swallowing the statement keyword with it (PEN-5951).
    expect(() =>
      validatePluginMigrationStatement(
        "-- it's a note\nCOMMENT ON TABLE plugin_test.rows IS 'the attendance note'",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement(
        "-- it's the operator's own 'note\nCOMMENT ON TABLE plugin_test.rows IS 'note'",
        "plugin_test",
      )
    ).not.toThrow();
    // The even-apostrophe cases were always fine; they are the control.
    expect(() =>
      validatePluginMigrationStatement(
        "-- it's the operator's note\nCOMMENT ON TABLE plugin_test.rows IS 'note'",
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("still sees a banned statement hidden behind an apostrophe in a line comment", () => {
    const bannedFunction =
      "CREATE OR REPLACE FUNCTION plugin_test.f() RETURNS int AS " +
      "'update plugin_test.rows set id = id; select 1' LANGUAGE sql";
    expect(() => validatePluginMigrationStatement(bannedFunction, "plugin_test")).toThrow(
      /disallowed/i,
    );
    // Same statement, preceded by an allowed keyword and a comment holding one
    // apostrophe. That used to normalise to a bare "create" and be accepted.
    expect(() =>
      validatePluginMigrationStatement(`CREATE -- it's fine\n${bannedFunction}`, "plugin_test")
    ).toThrow(/disallowed/i);
  });

  it("hides neither comments nor literals from the runtime validators", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "-- it's a read\nSELECT id FROM plugin_test.rows WHERE note = 'x'",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginRuntimeExecute(
        "-- it's a write\nUPDATE plugin_test.rows SET note = 'x'",
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("keeps a string literal that legitimately contains a double hyphen", () => {
    // Guards the tempting fix of stripping `--` first, which would truncate this
    // literal and leave the statement with an unbalanced quote.
    expect(() =>
      validatePluginMigrationStatement(
        "COMMENT ON TABLE plugin_test.rows IS 'an operator pause -- the one that matters'",
        "plugin_test",
      )
    ).not.toThrow();
  });

  it("treats a block comment as whitespace rather than gluing the tokens either side", () => {
    // Postgres reads `CREATE/**/EXTENSION` as `CREATE EXTENSION`; replacing the
    // comment with "" produced the single token `createextension`, which the ban
    // list could not see.
    expect(() =>
      validatePluginMigrationStatement("CREATE/**/EXTENSION pg_trgm", "plugin_test")
    ).toThrow(/disallowed/i);
    expect(() =>
      validatePluginMigrationStatement("DO/**/$$ BEGIN END $$", "plugin_test")
    ).toThrow(/disallowed/i);
  });

  // PEN-6600. Postgres lexes `.` as its own token, so a qualifying dot may carry
  // whitespace, a newline or a comment on either side. The ref patterns used to
  // require a BARE dot, so every form below extracted NO ref at all -- and
  // `validatePluginRuntimeQuery` had no floor, so an empty ref set read as
  // permission. Each `toThrow` here passes on the fixed extractor and fails on the
  // old one; the `not.toThrow` controls fail on a guard that simply refuses
  // everything.
  describe("a qualifying dot that is not bare (PEN-6600)", () => {
    const unreadableReads = {
      "a space on both sides": "SELECT * FROM public . secrets",
      "a space on the left only": "SELECT * FROM public .secrets",
      "a space on the right only": "SELECT * FROM public. secrets",
      "quoted identifiers and spaces": 'SELECT * FROM "public" . "secrets"',
      "a newline": "SELECT * FROM public\n.\nsecrets",
      "a block comment as the separator": "SELECT * FROM public/**/.secrets",
      "a block comment before the schema": "SELECT * FROM/**/public.secrets",
    };

    for (const [label, statement] of Object.entries(unreadableReads)) {
      it(`refuses a cross-schema read written with ${label}`, () => {
        expect(() => validatePluginRuntimeQuery(statement, "plugin_test", ["issues"])).toThrow();
      });
    }

    it("refuses a cross-schema WRITE whose target the extractor cannot read", () => {
      // The in-namespace FROM ref used to be promoted into `target` while the real
      // write target was never extracted at all, so the namespace check adjudicated
      // the wrong object and allowed the write.
      expect(() =>
        validatePluginRuntimeExecute(
          'UPDATE "public" . "agents" SET name = $1 FROM plugin_test.rows',
          "plugin_test",
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO public . agents SELECT id FROM plugin_test.rows",
          "plugin_test",
        )
      ).toThrow();
    });

    it("still reads a ref written with a bare dot", () => {
      // The positive control for the pattern change: tolerating whitespace must not
      // stop the extractor reading the ordinary form, in either verdict direction.
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM plugin_test.rows", "plugin_test")
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM public.issues", "plugin_test", ["issues"])
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM public.secrets", "plugin_test", ["issues"])
      ).toThrow(/whitelisted/i);
    });
  });

  // The half that fails closed on a lexical form nobody anticipated. The pattern fix
  // above is a blocklist of the shapes we thought of; this refuses an extraction that
  // yielded nothing, whatever caused it.
  describe("ctx.db.query refuses a statement it could not read (PEN-6600)", () => {
    it("refuses a statement that qualifies no relation at all", () => {
      // Nothing on this path sets `search_path`, so an UNQUALIFIED name resolves
      // against `public` and reads a core table. The floor closes that only when the
      // statement qualifies NOTHING -- `FROM plugin_test.rows, secrets` makes the ref
      // count 1 and still reads `public.secrets`. See PEN-6604; do not read these two
      // cases as the hole being shut.
      expect(() => validatePluginRuntimeQuery("SELECT * FROM issues", "plugin_test", ["issues"]))
        .toThrow(/schema\.table/i);
      expect(() => validatePluginRuntimeQuery("SELECT * FROM secrets", "plugin_test"))
        .toThrow(/schema\.table/i);
    });

    it("refuses a relation the keyword-anchored patterns cannot reach", () => {
      // A ref COUNT floor cannot see this one: the first operand of the list is read
      // and adjudicated, and the second is matched by nothing.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/adjudicate/i);
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE plugin_test.a SET x = 1 FROM plugin_test.b, public.secrets",
          "plugin_test",
        )
      ).toThrow(/adjudicate/i);
    });

    it("leaves a column read through a table alias alone", () => {
      // The detector keys on SCHEMA-shaped left-hand sides, so ordinary aliased
      // column reads are none of its business. Without this the guard would refuse
      // essentially every real query.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT c.id, p.name FROM plugin_test.cursors c LEFT JOIN public.issues p ON p.id = c.issue_id",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO plugin_test.a (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("still allows a migration COMMENT on a three-part name", () => {
      // `COMMENT ON COLUMN` names schema.table.column, which the ref patterns were
      // never built to read -- which is why the migration floor already exempts
      // `comment `. The detector inherits the same carve-out rather than inventing a
      // second rule that disagrees with it.
      expect(() =>
        validatePluginMigrationStatement(
          "COMMENT ON COLUMN plugin_test.rows.id IS 'the row id'",
          "plugin_test",
        )
      ).not.toThrow();
    });
  });

  // Ally's round-1 review of this PR reproduced both of these as ALLOW at head
  // 478a92f4, and both were pre-existing on master rather than introduced here.
  describe("a relation the extractor could not lex, and a write target it could not read (PEN-6600)", () => {
    it("refuses a qualified name whose dot is separated by a comment", () => {
      // `public/**/.secrets` is one schema-qualified name to Postgres: a comment is
      // whitespace. The ref patterns span `\s*` only, so before `stripSqlComments`
      // this was invisible to the extractor AND to the detector that backstops it,
      // and the `refs.length === 0` floor could not fire because the OTHER relation
      // in the list made the count 1.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public/**/.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows JOIN public/**/.secrets ON true",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE public/**/.agents SET name = $1 FROM plugin_test.rows",
          "plugin_test",
        )
      ).toThrow();
    });

    it("refuses an execute whose write target is not a schema-qualified name", () => {
      // The target used to be the first ref carrying any of {into, update, from}.
      // `from` is in that set for `DELETE FROM x.y`, so an UNQUALIFIED target --
      // extracted by nothing -- promoted the in-namespace FROM operand into the
      // target slot and the write landed on `public.agents` through `search_path`.
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE agents SET name = $1 FROM plugin_test.rows",
          "plugin_test",
        )
      ).toThrow(/schema\.table/i);
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO agents SELECT * FROM plugin_test.rows",
          "plugin_test",
        )
      ).toThrow(/schema\.table/i);
      expect(() =>
        validatePluginRuntimeExecute("DELETE FROM issues WHERE id = $1", "plugin_test")
      ).toThrow(/schema\.table/i);
    });

    it("still allows the write shapes the shipped plugins actually use", () => {
      // Positive controls taken from the alertmanager and llm-wiki corpora: an
      // aliased UPDATE ... FROM, an aliased INSERT ... ON CONFLICT, and a DELETE.
      // A target rule that refused these would break a live plugin.
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE plugin_test.members AS m SET resolved_at = NULL FROM plugin_test.covers c WHERE c.id = m.cover_id",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO plugin_test.spaces AS s (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "DELETE FROM plugin_test.claims WHERE company_id = $1",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          'UPDATE "plugin_test"."rows" SET name = $1',
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("keeps a comment that is not inside a qualified name harmless", () => {
      // `stripSqlComments` replaces a comment with the single space Postgres already
      // treats it as, so stripping must not glue two tokens together or change a
      // verdict on ordinary commented SQL.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT id -- the row id\nFROM plugin_test.rows",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginMigrationStatement(
          "CREATE TABLE plugin_test.t /* new */ (id uuid PRIMARY KEY)",
          "plugin_test",
        )
      ).not.toThrow();
    });
  });


  describe("an identifier whose decoded name is not the characters that spell it (PEN-6600)", () => {
    it("refuses a Unicode-escape identifier on all three paths", () => {
      // `U&"\0070ublic"` IS `public` to Postgres -- measured against a real engine,
      // `SELECT name FROM U&"\0070ublic".secrets` returns the row, and the negative
      // control `U&"\0070ubliz"` fails with `relation "publiz.secrets" does not exist`,
      // so the decode is what resolves the name.
      //
      // Every control in this file reads the CHARACTERS. `QUALIFIED_NAME` matches its
      // leftmost candidate at `ublic".secrets`, yielding schema `ublic`, which
      // `SCHEMA_SHAPED_RE` skips as a table alias -- so the extractor, the detector and
      // the write-target reader all agreed the statement did not touch `public`.
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows, U&"\0070ublic".secrets`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/unicode-escape identifier/i);
      expect(() =>
        validatePluginRuntimeExecute(
          String.raw`INSERT INTO plugin_test.rows SELECT * FROM U&"\0070ublic".secrets`,
          "plugin_test",
        )
      ).toThrow(/unicode-escape identifier/i);
      expect(() =>
        validatePluginMigrationStatement(
          String.raw`WITH t AS (UPDATE U&"\0070ublic".agents SET name='x' RETURNING id) INSERT INTO plugin_test.log SELECT id FROM t`,
          "plugin_test",
          ["agents"],
        )
      ).toThrow(/unicode-escape identifier/i);
    });

    it("refuses it through an escape-string literal that desyncs the quote scanner", () => {
      // The guard reads the RAW statement, not `normaliseSql` output. Postgres reads
      // `E'\''` as a complete one-character literal; `stripSqlForKeywordScan` and
      // `scanSqlSpans` both close the span at the second quote and open a new one at
      // the third, so everything up to the next quote is blanked -- including a `U&"`
      // living in it. Against the blanked text all three of these ALLOWED.
      //
      // The control below is the point: the same shape naming a plain `public.secrets`
      // refused either way, so this was specific to the `U&` guard's input, not a
      // general desync of the detector.
      //
      // REBASE NOTE (PEN-6600 onto PEN-5951): these three inputs now meet PEN-5951's
      // `assertNoEscapeStringLiterals` first, so they are refused for carrying an
      // `E'...'` prefix rather than for the `U&"..."` inside it. The refusal is the
      // same and it is strictly EARLIER; the message is what moved. The `U&` guard
      // itself stays pinned by the three sibling assertions above, which carry no
      // escape string at all -- so this loosening costs the guard no coverage.
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows WHERE a = E'\'' AND b IN (SELECT 1 FROM U&"\0070ublic".secrets) AND c = ''`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/escape string literal|unicode-escape identifier/i);
      expect(() =>
        validatePluginRuntimeExecute(
          String.raw`INSERT INTO plugin_test.rows SELECT E'\'' FROM U&"\0070ublic".secrets WHERE ''=''`,
          "plugin_test",
        )
      ).toThrow(/escape string literal|unicode-escape identifier/i);
      expect(() =>
        validatePluginRuntimeExecute(
          String.raw`UPDATE plugin_test.rows SET a = E'\'' FROM U&"\0070ublic".secrets WHERE ''=''`,
          "plugin_test",
        )
      ).toThrow(/escape string literal|unicode-escape identifier/i);
      // Control: plain `public.secrets` in the same shape was refused before this fix
      // too, by the detector rather than by this guard.
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows WHERE a = E'\'' AND b IN (SELECT 1 FROM public.secrets) AND c = ''`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("does not refuse an ordinary `&` that merely ends in u", () => {
      // The refusal is anchored on a word boundary. Without it, a column whose name
      // ends in `u` bitwise-anded with a quoted name would be refused, and that is a
      // different token sequence entirely -- a guard that refuses it refuses valid SQL.
      expect(() =>
        validatePluginRuntimeQuery(
          'SELECT menu&"mask" AS flags FROM plugin_test.rows',
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("keeps allowing the quoted identifiers the shipped plugins do use", () => {
      expect(() =>
        validatePluginRuntimeQuery('SELECT * FROM "plugin_test".rows', "plugin_test")
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeQuery('SELECT * FROM "plugin_test"."rows"', "plugin_test")
      ).not.toThrow();
    });

    it("refuses a relation smuggled past the extractor by a dollar-quoted string", () => {
      // PINS A DELIBERATE NON-CHANGE. `scanSqlSpans` has no dollar-quote rule, so the
      // apostrophe inside `$$x'y$$` opens a quoted span that runs to end of input and
      // swallows the rest of the statement. `stripSqlComments` keeps quoted spans
      // VERBATIM, so the extractor and the detector still read that tail and refuse the
      // `public.secrets` in it. Measured against a real Postgres engine: this statement
      // is ACCEPTED and returns the row, so the refusal is load-bearing.
      //
      // ⛔ Blanking `'`-quoted spans before the detector -- an obvious way to stop a
      // string LITERAL that merely contains a dotted name from being refused -- turns
      // this case ALLOW, because a span this lexer calls "quoted" is not always a
      // literal. Teaching the lexer dollar-quoting is PEN-5951; until then this test is
      // what makes that trade visible instead of silent.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = $$x'y$$ AND b IN (SELECT secrets.c FROM plugin_test.t, public.secrets)",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("refuses a ref the comment strip DELETED when a quote desync inverted parity", () => {
      // REGRESSION, caught by Ally at e4dd4f956. Routing the extractor and the detector
      // through `stripSqlComments` closed the `public/**\/.secrets` form and opened a
      // worse one: `scanSqlSpans` has no rule for `E'\''` or for dollar quotes, so once
      // quote parity is inverted a `/*` inside a REAL string literal reads as a comment
      // open and every byte to the next `*\/` is deleted from the stripped text --
      // taking `public.secrets` with it. `master` refused all three of these; the
      // reviewed head ALLOWED them, and the third COPIES core rows into a plugin table.
      //
      // The fix is not a new ban: a pre-pass may only ADD to what gets checked, so both
      // halves now read the raw statement AND the stripped one. See
      // `collectQualifiedRefs`.
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows WHERE a = E'\'' AND b = ' /* ' UNION SELECT * FROM public.secrets WHERE c = ' */ '`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows WHERE a = $'$ AND b = ' /* ' UNION SELECT * FROM public.secrets WHERE c = ' */ '`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          String.raw`INSERT INTO plugin_test.rows (v) SELECT $'$ || ' /* ' FROM public.secrets WHERE ' */ ' = ''`,
          "plugin_test",
        )
      ).toThrow();
      // CONTROL, and it is the load-bearing arm: the same shape with no desync trigger
      // refused at the reviewed head too, so the hole was specific to what the strip
      // REMOVED and not a general failure of the detector.
      expect(() =>
        validatePluginRuntimeQuery(
          String.raw`SELECT * FROM plugin_test.rows WHERE a = 'x' AND b = ' /* ' UNION SELECT * FROM public.secrets WHERE c = ' */ '`,
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("still reads a comment sitting inside a qualified name", () => {
      // POSITIVE CONTROL for the arm above: the stripped text is still required, so the
      // fix must be a UNION of both texts and not a revert to reading raw only.
      // `plugin_test/**\/.rows` is one name to Postgres and is invisible in raw text.
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM plugin_test/**/.rows", "plugin_test")
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO /*c*/ plugin_test.rows (v) VALUES ($1)",
          "plugin_test",
        )
      ).not.toThrow();
      // A `/*` inside a literal with BALANCED quotes is not a comment and deletes
      // nothing, so this must keep passing.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = ' /* still a literal */ '",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("refuses a three-part catalog.schema.table name", () => {
      // Postgres accepts `db.schema.table` when `db` is the current database, and a
      // plugin can learn that name with `SELECT current_database()`. The detector's
      // scan was NON-overlapping, so `paperclip.public.secrets` matched
      // `paperclip.public` -- schema `paperclip`, skipped as a table alias -- and then
      // resumed after `public`, so `public.secrets` was never considered. ALLOWED on
      // master and at the reviewed head, which contradicted the invariant this file
      // claims to hold.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, paperclip.public.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/cannot adjudicate|cannot read schema/i);
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO plugin_test.rows SELECT * FROM paperclip.public.secrets",
          "plugin_test",
        )
      ).toThrow();
      // Matching every ADJACENT pair closes this at any depth, where banning the
      // three-part form would be a blocklist the four-part name walks straight past.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, a.b.public.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("does not refuse a qualifier that merely ENDS with a schema name", () => {
      // The lookbehind is load-bearing and this is its control. An overlapping scan
      // without it also matches `public.secrets` INSIDE `xpublic.secrets`, which
      // refuses a statement naming a schema nobody asked about. Measured: with the
      // lookbehind removed, this case flips to REFUSE.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT xpublic.secrets FROM plugin_test.rows",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("keeps the COMMENT ON carve-out the migration path depends on", () => {
      // `COMMENT ON COLUMN` names a three-part `schema.table.column`. The overlapping
      // scan would see `rows.note` there, so the migration path's existing exemption
      // has to keep covering it -- without this, five shipped statements change verdict.
      expect(() =>
        validatePluginMigrationStatement(
          "COMMENT ON COLUMN plugin_test.rows.note IS 'x'",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginMigrationStatement(
          "COMMENT ON TABLE plugin_test.rows IS 'x'",
          "plugin_test",
        )
      ).not.toThrow();
    });
  });

  describe("a comment inside the name PLUS a quote desync (PEN-6600)", () => {
    // Round 5 shipped a union -- adjudicate the raw statement AND the
    // comment-stripped one -- on the claim that "a mis-lex can only ever hide a name
    // from ONE of them". Ally falsified it: the two texts have two DIFFERENT blind
    // spots and one statement can carry both. A comment inside the name hid it from
    // the RAW text; an `E'\''` or `$$'$$` desync made the lexer delete it from the
    // STRIPPED text. Every statement here was measured ALLOW at head 653a04164 and on
    // `master`, so each one is a live fail-open these assertions pin shut.
    it("refuses a line comment inside the name behind an E'' desync", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = E'\\'' UNION SELECT * FROM public--x\n.secrets -- '",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("refuses a line comment inside the name behind a dollar-quote desync", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = $$'$$ UNION SELECT * FROM public--x\n.secrets -- '",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("refuses a block comment inside the name behind an E'' desync", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = E'\\'' AND b = ' /* ' UNION SELECT * FROM public/**/.secrets WHERE c = ' */ '",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    // The one that actually moves core data into a table the plugin can read.
    it("refuses the exfiltrating INSERT ... SELECT on every path that runs it", () => {
      const statement = "INSERT INTO plugin_test.rows SELECT E'\\'' FROM public--x\n.secrets -- '";
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test")).toThrow();
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).toThrow();
    });

    it("refuses UPDATE ... FROM a commented-out core name", () => {
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE plugin_test.rows SET a = E'\\'' FROM public--x\n.agents -- '",
          "plugin_test",
        )
      ).toThrow();
    });

    // Postgres block comments NEST. `scanSqlSpans` stopped at the first `*/`, so it
    // handed the rest of the comment back as executable code -- and SQL_TOKEN_GAP
    // cannot span a nested comment either. This form was ALLOWED on `master` and at
    // 653a04164 with no desync trigger at all, so it is a separate fail-open from
    // the five above; it is the one case covered by the lexer ALONE.
    it("refuses a NESTED block comment inside the name", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public/* /* */ */.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    // ---- CONTROLS. A guard that refuses everything passes every test above. ----

    it("still allows a comment sitting inside the plugin's OWN name", () => {
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM plugin_test/**/.rows", "plugin_test", ["issues"])
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM plugin_test--c\n.rows", "plugin_test", ["issues"])
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO /*c*/ plugin_test.rows (v) VALUES (1)",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("still allows a literal that merely CONTAINS comment punctuation", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = ' /* x */ ' AND b = '-- y'",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
    });

    // The lexer now reads `$tag$...$tag$`. `$1` is a PLACEHOLDER and must not be
    // mistaken for an opener, or every parameterised statement in the corpus becomes
    // one giant quoted span.
    it("still allows parameter placeholders next to a dollar sign", () => {
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE plugin_test.rows SET a = $1, b = $2 WHERE id = $3",
          "plugin_test",
        )
      ).not.toThrow();
    });

    // `$` is a legal non-initial identifier character, so `a$b$c` is ONE identifier
    // and its `$b$` is not a dollar-quote opener. Lexing it as one would open a span
    // running to the end of the statement, which is the same parity inversion this
    // block exists to close -- so the name after it must still be adjudicated.
    it("does not read a dollar inside an identifier as a quote opener", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT a$b$c FROM plugin_test.rows, public.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
      expect(() =>
        validatePluginRuntimeQuery("SELECT a$b$c FROM plugin_test.rows", "plugin_test", ["issues"])
      ).not.toThrow();
    });
  });

  describe("a line terminator and a character class Postgres has and this file did not (PEN-6600)", () => {
    // Round 6 closed the two blind spots separately and stated one residual: a
    // NESTED block comment inside a name is spanned by the lexer and NOT by the raw
    // text. Ally then found both halves of that statement were still reachable.
    //
    // Postgres's `scan.l` is the specification both of our readers are approximating,
    // and it was approximated too narrowly in three character classes:
    //
    //   newline     [\n\r]                     -- a line comment ends at EITHER
    //   ident_cont  [A-Za-z\200-\377_0-9\$]    -- high-bit bytes are identifier text
    //   dolq_start  [A-Za-z\200-\377_]         -- and dollar-quote tag text
    //
    // Every statement in this block was measured ALLOW at head 97ab8aa4c and on
    // `master`, and accepted by a real Postgres engine, so each one is a live
    // fail-open these assertions pin shut.

    // ---- `\r` ends a line comment. Neither reader knew that, and they failed in
    // OPPOSITE directions on the same byte: SQL_TOKEN_GAP's `--[^\n]*\n` could not
    // span the comment, so the RAW text saw no qualified name; scanSqlSpans ran the
    // comment to end of input, so the STRIPPED text had the name DELETED. One byte,
    // both texts blind, no literal and no desync needed.
    it("refuses a name split by a line comment that a CARRIAGE RETURN ends", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public--x\r.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("refuses the \\r-commented exfiltrating INSERT ... SELECT on every path", () => {
      const statement = "INSERT INTO plugin_test.rows SELECT * FROM public--x\r.secrets";
      expect(() => validatePluginRuntimeExecute(statement, "plugin_test")).toThrow();
      expect(() => validatePluginMigrationStatement(statement, "plugin_test")).toThrow();
    });

    it("refuses UPDATE ... FROM a name split by a \\r comment", () => {
      expect(() =>
        validatePluginRuntimeExecute(
          "UPDATE plugin_test.rows SET a = 1 FROM public--x\r.agents",
          "plugin_test",
        )
      ).toThrow();
    });

    // CRLF is the same comment followed by ordinary whitespace, so the gap must span
    // both characters rather than stopping at the one it now recognises.
    it("refuses a name split by a CRLF-terminated line comment", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public--x\r\n.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    // ---- High-bit characters. Two separate desyncs, both ending in a span that
    // swallowed the rest of the statement and took the name out of the stripped text.
    it("refuses a nested-comment name behind a NON-ASCII identifier desync", () => {
      // `é$b$c` is ONE identifier to Postgres (`$` is ident_cont, `é` is too), so its
      // `$b$` is not an opener. Reading `é` as a non-identifier character made it one.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT 1 AS é$b$c FROM plugin_test.rows, public/* /* */ */.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    it("refuses a nested-comment name behind a NON-ASCII dollar-quote tag", () => {
      // `$é$ ... $é$` is a dollar-quoted literal, so the apostrophe inside it is
      // ordinary text. Not recognising the tag let that apostrophe open a false string.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = $é$'$é$ AND b IN (SELECT 1 FROM public/* /* */ */.secrets) AND c = ''",
          "plugin_test",
          ["issues"],
        )
      ).toThrow();
    });

    // ---- The residual itself. A regular expression provably cannot count, so the
    // RAW half can never span an arbitrarily nested block comment -- round 6 stated
    // that and left the lexer as the only reader covering it, which is exactly the
    // dependency both findings above exploited. Refusing the form instead makes the
    // raw half independent of the lexer for EVERY comment form.
    it("refuses a nested block comment by its own guard, not by the lexer", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, public/* /* */ */.secrets",
          "plugin_test",
          ["issues"],
        )
      ).toThrow(/nested/i);
    });

    // ---- CONTROLS. A guard that refuses everything passes every test above. ----

    it("still allows a \\r comment sitting inside the plugin's OWN name", () => {
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM plugin_test--c\r.rows", "plugin_test", ["issues"])
      ).not.toThrow();
    });

    it("still allows a literal that merely CONTAINS a carriage return", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = '-- x\r' AND b = 'y'",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
    });

    it("still allows a NON-ASCII dollar-quoted literal", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows WHERE a = $é$ hello $é$",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
    });

    it("still allows a NON-ASCII identifier that contains a dollar sign", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT é$b$c FROM plugin_test.rows",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
    });

    // The nesting refusal must be a refusal of NESTING, not of a second comment.
    it("still allows two separate block comments in one statement", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT /* a */ * FROM /* b */ plugin_test.rows",
          "plugin_test",
          ["issues"],
        )
      ).not.toThrow();
    });
  });

  describe("a schema the shape allowlist did not anticipate (PEN-6604)", () => {
    // `SCHEMA_SHAPED_RE` used to decide whether a left side was a schema AT ALL, so a
    // real schema outside its pattern was skipped as if it were a table alias. The
    // same name in FIRST position was refused, because a keyword-anchored pattern
    // reaches it -- so the two positions disagreed about one statement.
    it("refuses a non-public schema in a position no keyword reaches", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows, drizzle.__drizzle_migrations",
          "plugin_test",
        )
      ).toThrow(/cannot adjudicate/i);
    });

    it("refuses it identically in first position, which already worked", () => {
      // The control for the test above: the defect was the DISAGREEMENT between the
      // two positions, so a fix that only moved the second one is not enough.
      expect(() =>
        validatePluginRuntimeQuery("SELECT * FROM drizzle.__drizzle_migrations", "plugin_test")
      ).toThrow(/drizzle/i);
    });

    it("refuses a migration that reaches such a schema the same way", () => {
      expect(() =>
        validatePluginMigrationStatement(
          "INSERT INTO plugin_test.rows (id) SELECT id FROM plugin_test.src, drizzle.__drizzle_migrations",
          "plugin_test",
        )
      ).toThrow(/cannot adjudicate/i);
    });

    it("still leaves a column read through a table alias alone", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT s.id, s.label FROM plugin_test.rows s WHERE s.id = $1",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO plugin_test.rows (id, y) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET y = EXCLUDED.y",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("still leaves an alias declared on a subquery or a function alone", () => {
      // The alias here follows `)`, not a relation name, so the relation-alias anchor
      // cannot see it. Refusing these is the false-refusal this exemption exists to
      // avoid, and a false refusal breaks a live plugin at request time.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT sub.id FROM (SELECT id FROM plugin_test.rows) sub WHERE sub.id = $1",
          "plugin_test",
        )
      ).not.toThrow();
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT e.value FROM plugin_test.rows r, jsonb_array_elements(r.payload) AS e",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("still leaves an alias on a comma-continued relation alone", () => {
      // `y` is declared after a comma, which is also where an output-column alias
      // lives, so this exemption cannot tell the two apart and takes both. Refusing
      // it would be a false refusal on ordinary in-namespace SQL.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT y.label FROM plugin_test.rows x, other_rows y WHERE y.id = x.id",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("still leaves a CTE name alone", () => {
      expect(() =>
        validatePluginRuntimeQuery(
          "WITH recent AS (SELECT id FROM plugin_test.rows) SELECT recent.id FROM recent",
          "plugin_test",
        )
      ).not.toThrow();
    });

    it("does not let a declared name buy an exemption for a schema that exists", () => {
      // Reproduced in review on #3739: the exemption is only as strong as what it
      // consults BEFORE it. One extra word -- an alias or a CTE named after the target
      // schema -- used to put `drizzle` in the correlation set and skip the real
      // reference. A relation alias cannot shadow a schema in a FROM list, so Postgres
      // still read `drizzle.__drizzle_migrations`.
      const schemas = new Set(["public", "information_schema", "drizzle", "plugin_test"]);
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows drizzle, drizzle.__drizzle_migrations",
          "plugin_test",
          [],
          schemas,
        )
      ).toThrow(/cannot adjudicate/i);
      expect(() =>
        validatePluginRuntimeQuery(
          "WITH drizzle AS (SELECT 1) SELECT * FROM plugin_test.rows, drizzle.__drizzle_migrations",
          "plugin_test",
          [],
          schemas,
        )
      ).toThrow(/cannot adjudicate/i);
      expect(() =>
        validatePluginRuntimeExecute(
          "INSERT INTO plugin_test.rows SELECT * FROM plugin_test.src drizzle, drizzle.__drizzle_migrations",
          "plugin_test",
          schemas,
        )
      ).toThrow(/cannot adjudicate/i);
    });

    it("still exempts a declared name that is not a schema in this database", () => {
      // The control for the test above, and the reason the schema set is a set rather
      // than a refusal of every declared name: `s` and `sub` are not schemas, so
      // exempting them cannot hide a relation reference.
      const schemas = new Set(["public", "information_schema", "drizzle", "plugin_test"]);
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT s.id, sub.n FROM plugin_test.rows s, (SELECT count(*) AS n FROM plugin_test.rows) sub",
          "plugin_test",
          [],
          schemas,
        )
      ).not.toThrow();
    });

    it("does not let an alias buy an exemption for a real schema name", () => {
      // The exemption is consulted ONLY for a left side that is neither the namespace
      // nor schema-shaped, so aliasing a relation `public` cannot make `public.secrets`
      // skippable. Without that ordering the exemption would be a bypass.
      expect(() =>
        validatePluginRuntimeQuery(
          "SELECT * FROM plugin_test.rows public, public.secrets",
          "plugin_test",
        )
      ).toThrow(/cannot adjudicate|public/i);
    });
  });

  it("targets anonymous DO blocks without rejecting do-prefixed aliases", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_test.rows",
        "plugin_test",
      )
    ).not.toThrow();
    expect(() =>
      validatePluginMigrationStatement("DO $$ BEGIN END $$;", "plugin_test")
    ).toThrow(/disallowed/i);
  });

  it("reads the write target through a comment instead of adjudicating some other ref", () => {
    // PEN-5951 review round. Mapping a comment to whitespace made the keyword scan
    // read what Postgres reads, but `extractQualifiedRefs` still regexed the RAW
    // statement, where `update` is not followed by whitespace. The real target was
    // therefore never extracted and the namespace check settled for the in-namespace
    // `FROM` ref instead, accepting a write to public. Both halves read one text now.
    expect(() =>
      validatePluginRuntimeExecute(
        "UPDATE/**/public.agents SET name = 'x' FROM plugin_test.rows",
        "plugin_test",
      )
    ).toThrow(/inside plugin namespace/i);
    expect(() =>
      validatePluginRuntimeExecute(
        "DELETE FROM/**/other_ns.t WHERE id IN (SELECT id FROM plugin_test.rows)",
        "plugin_test",
      )
    ).toThrow(/inside plugin namespace/i);
    expect(() =>
      validatePluginRuntimeExecute(
        "INSERT INTO/**/public.agents (id) SELECT id FROM plugin_test.rows",
        "plugin_test",
      )
    ).toThrow(/inside plugin namespace/i);
    // Control: the same statement without the comment was refused before and after.
    expect(() =>
      validatePluginRuntimeExecute(
        "UPDATE public.agents SET name = 'x' FROM plugin_test.rows",
        "plugin_test",
      )
    ).toThrow(/inside plugin namespace/i);
    // Control: an in-namespace write is still allowed.
    expect(() =>
      validatePluginRuntimeExecute("UPDATE plugin_test.rows SET name = 'x'", "plugin_test")
    ).not.toThrow();
  });

  it("sees a commented-out read of a core table that no ref would otherwise report", () => {
    // Pre-existing on master and closed by the same fix: with no ref extracted at
    // all, the namespace loop ran zero times and a missing ref read as allowed.
    expect(() =>
      validatePluginRuntimeQuery("SELECT * FROM/**/public.secrets", "plugin_test")
    ).toThrow(/public\.secrets/i);
    expect(() =>
      validatePluginRuntimeQuery("SELECT * FROM plugin_test.rows", "plugin_test")
    ).not.toThrow();
  });

  it("refuses escape string literals, which hide a second statement from the splitter", () => {
    // `scanSqlSpans` does not lex backslashes, so it reads the `''` in E'\'' as a
    // doubled quote and runs to end of input. The splitter then reports ONE
    // statement and the keyword scan sees only the blanked literal, so a whole
    // second statement rides along. Refusing the prefix is the fail-closed answer;
    // no .sql file in this repo uses one.
    expect(() =>
      validatePluginRuntimeQuery(String.raw`SELECT E'\'' ; DROP SCHEMA public CASCADE; --'`, "plugin_test")
    ).toThrow(/escape string literal/i);
    expect(() =>
      validatePluginRuntimeExecute(String.raw`UPDATE plugin_test.rows SET n = e'\n'`, "plugin_test")
    ).toThrow(/escape string literal/i);
    // Control: the smuggling only works through the escape string. A bare second
    // statement is still caught by the splitter.
    expect(() =>
      validatePluginRuntimeQuery("SELECT 1; DROP SCHEMA public CASCADE", "plugin_test")
    ).toThrow(/exactly one statement/i);
    // Control: `LIKE'x'` is legal SQL that ends in an E. Only a STANDALONE e/E is a
    // prefix, so this must still pass.
    expect(() =>
      validatePluginRuntimeExecute(
        "UPDATE plugin_test.rows SET n = 'y' WHERE n LIKE'%a%'",
        "plugin_test",
      )
    ).not.toThrow();
    // Control: an apostrophe in a line comment is not a literal at all.
    expect(() =>
      validatePluginRuntimeExecute(
        "-- it's a write\nUPDATE plugin_test.rows SET n = 'x'",
        "plugin_test",
      )
    ).not.toThrow();
  });
});

describe("buildPluginWorkerEnv", () => {
  const instanceInfo = {
    deploymentMode: "authenticated",
    deploymentExposure: "public",
  };

  it("passes only model provider keys through to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        ANTHROPIC_API_KEY: "anthropic-token",
        OPENAI_API_KEY: "openai-token",
        GEMINI_API_KEY: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      ANTHROPIC_API_KEY: "anthropic-token",
      OPENAI_API_KEY: "openai-token",
    });
  });

  it("passes in-cluster Kubernetes service-discovery vars to environment driver plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["environment.drivers.register"] },
      instanceInfo,
      processEnv: {
        KUBERNETES_SERVICE_HOST: "10.0.0.1",
        KUBERNETES_SERVICE_PORT: "443",
        KUBERNETES_SERVICE_PORT_HTTPS: " ",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    });
  });

  it("does not pass provider keys to non-environment plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { capabilities: ["ui.slots.register"] },
      instanceInfo,
      processEnv: {
        OPENAI_API_KEY: "openai-token",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });

  it("passes only non-secret Authbot coordinates to the bundled gbrain plugin", () => {
    const env = buildPluginWorkerEnv({
      manifest: { id: "kkroo.gbrain", capabilities: ["events.subscribe"] },
      instanceInfo,
      processEnv: {
        PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL:
          "https://api.penstock.run/v1/authbot/mcp-credentials/gbrain-plugin-oauth-clients",
        PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE: "/var/run/authbot/gbrain-plugin-service-key",
        PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY: "service-key-must-not-leak",
        DATABASE_URL: "postgres://must-not-leak",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
      PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL:
        "https://api.penstock.run/v1/authbot/mcp-credentials/gbrain-plugin-oauth-clients",
      PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE: "/var/run/authbot/gbrain-plugin-service-key",
    });
  });

  it("does not pass gbrain Authbot coordinates to other plugins", () => {
    const env = buildPluginWorkerEnv({
      manifest: { id: "kkroo.slack", capabilities: ["events.subscribe"] },
      instanceInfo,
      processEnv: {
        PAPERCLIP_GBRAIN_OAUTH_CLIENTS_URL:
          "https://api.penstock.run/v1/authbot/mcp-credentials/gbrain-plugin-oauth-clients",
        PAPERCLIP_GBRAIN_AUTHBOT_SERVICE_KEY_FILE: "/var/run/authbot/gbrain-plugin-service-key",
      },
    });

    expect(env).toEqual({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    });
  });
});

describeEmbeddedPostgres("plugin database namespaces", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let packageRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-db-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    for (const pluginKey of ["paperclip.dbtest", "paperclip.escape", "paperclip.refresh", multiMigrationPluginKey, llmWikiPluginKey]) {
      const namespace = derivePluginDatabaseNamespace(pluginKey);
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    }
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${derivePluginDatabaseNamespace(llmWikiPluginKey, "llm_wiki")}" CASCADE`));
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(companies);
    await Promise.all(packageRoots.map((root) => rm(root, { recursive: true, force: true })));
    packageRoots = [];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createPluginPackage(manifest: PaperclipPluginManifestV1, migrationSql: string) {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-package-"));
    packageRoots.push(packageRoot);
    const migrationsDir = path.join(packageRoot, manifest.database!.migrationsDir);
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(path.join(migrationsDir, "001_init.sql"), migrationSql, "utf8");
    return packageRoot;
  }

  /**
   * An isolated plugin install dir with the SDK physically installed, for
   * tests that drive `loadSingle` but are not about the plugin store.
   *
   * Without an explicit `localPluginDir`, `pluginLoader` falls back to the real
   * `~/.paperclip/plugins`, and activation then runs its torn-store guard
   * against whatever happens to be on the developer's or runner's disk. That
   * made this suite depend on ambient state it never set up: the guard treated
   * a completely empty store as congruent, so activation passed while no SDK
   * existed anywhere. It now fails closed on that shape (BLO-31857), which is
   * the correct behaviour and correctly exposed this fixture as vacuous.
   */
  async function createSdkPopulatedPluginStore(): Promise<string> {
    const installDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-store-"));
    packageRoots.push(installDir);
    const sdkDir = path.join(installDir, "node_modules", "@paperclipai", "plugin-sdk");
    await mkdir(sdkDir, { recursive: true });
    await writeFile(
      path.join(sdkDir, "package.json"),
      JSON.stringify({ name: "@paperclipai/plugin-sdk", version: "2026.817.0" }),
      "utf8",
    );
    return installDir;
  }

  function llmWikiManifest(): PaperclipPluginManifestV1 {
    return {
      id: llmWikiPluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "LLM Wiki",
      description: "Local-file LLM Wiki plugin.",
      author: "Paperclip",
      categories: ["automation", "ui"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        namespaceSlug: "llm_wiki",
        migrationsDir: "migrations",
        coreReadTables: ["companies", "issues", "projects", "agents"],
      },
    };
  }

  async function createInstallablePluginPackage(
    pluginManifest: PaperclipPluginManifestV1,
    migrationSql: string,
  ) {
    const packageRoot = await createPluginPackage(pluginManifest, migrationSql);
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: pluginManifest.id,
        version: pluginManifest.version,
        type: "module",
        paperclipPlugin: { manifest: "./manifest.js" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(packageRoot, "manifest.js"),
      `export default ${JSON.stringify(pluginManifest, null, 2)};\n`,
      "utf8",
    );
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "dist", "worker.js"), "export {};\n", "utf8");
    return packageRoot;
  }

  async function installPluginRecord(manifest: PaperclipPluginManifestV1) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    return pluginId;
  }

  function manifest(pluginKey = "paperclip.dbtest"): PaperclipPluginManifestV1 {
    return {
      id: pluginKey,
      apiVersion: 1,
      version: "1.0.0",
      displayName: "DB Test",
      description: "Exercises restricted plugin database access.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: [
        "database.namespace.migrate",
        "database.namespace.read",
        "database.namespace.write",
      ],
      entrypoints: { worker: "./dist/worker.js" },
      database: {
        migrationsDir: "migrations",
        coreReadTables: ["issues"],
      },
    };
  }

  it("applies multi-file plugin migrations through the production validator", async () => {
    const pluginManifest = manifest(multiMigrationPluginKey);
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.source_rows (id uuid PRIMARY KEY, label text NOT NULL);`,
    );
    await writeFile(
      path.join(packageRoot, pluginManifest.database!.migrationsDir, "002_derived.sql"),
      `CREATE TABLE ${namespace}.derived_rows (
        id uuid PRIMARY KEY,
        source_id uuid NOT NULL REFERENCES ${namespace}.source_rows(id)
      );`,
      "utf8",
    );
    const pluginId = await installPluginRecord(pluginManifest);
    await pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(2);
  });

  it("applies the bundled LLM Wiki migrations through the production validator", async () => {
    const pluginManifest = llmWikiManifest();
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "plugin-llm-wiki");
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id, pluginManifest.database?.namespaceSlug);
    const pluginId = await installPluginRecord(pluginManifest);

    await pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations.map((migration) => migration.migrationKey)).toEqual([
      "001_llm_wiki.sql",
      "002_paperclip_distillation.sql",
      "003_spaces.sql",
    ]);

    const constraintRows = Array.from(
      await db.execute(
        sql<{ table_name: string; conname: string; columns: string[] }>`
          SELECT t.relname AS table_name, c.conname, array_agg(a.attname ORDER BY constraint_columns.ordinality)::text[] AS columns
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN unnest(c.conkey) WITH ORDINALITY AS constraint_columns(attnum, ordinality) ON true
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = constraint_columns.attnum
          WHERE c.connamespace = ${namespace}::regnamespace AND c.contype = 'u'
          GROUP BY t.relname, c.conname
          ORDER BY t.relname, c.conname
        `,
      ) as Iterable<{ table_name: string; conname: string; columns: string[] }>,
    );
    const constraints = constraintRows.map((row) => row.conname);
    const uniqueColumnSets = new Set(
      constraintRows.map((row) => `${row.table_name}:${row.columns.join(",")}`),
    );
    expect(constraints).toEqual(
      expect.arrayContaining([
        "wiki_pages_company_wiki_space_path_key",
        "distillation_cursors_company_wiki_space_scope_key",
        "distillation_work_items_company_wiki_space_idempotency_key",
        "page_bindings_company_wiki_space_page_path_key",
      ]),
    );
    expect(constraints).not.toContain("wiki_pages_company_id_wiki_id_path_key");
    expect(constraints).not.toContain("paperclip_distillation_cursor_company_id_wiki_id_source_sco_key");
    expect(constraints).not.toContain("paperclip_distillation_work_i_company_id_wiki_id_idempotenc_key");
    expect(constraints).not.toContain("paperclip_page_bindings_company_id_wiki_id_page_path_key");
    expect(uniqueColumnSets).not.toContain("wiki_pages:company_id,wiki_id,path");
    expect(uniqueColumnSets).not.toContain("paperclip_distillation_cursors:company_id,wiki_id,source_scope,scope_key,source_kind");
    expect(uniqueColumnSets).not.toContain("paperclip_distillation_work_items:company_id,wiki_id,idempotency_key");
    expect(uniqueColumnSets).not.toContain("paperclip_page_bindings:company_id,wiki_id,page_path");
  });

  it("applies migrations once and allows whitelisted core joins at runtime", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `
      CREATE TABLE ${namespace}.mission_rows (
        id uuid PRIMARY KEY,
        issue_id uuid NOT NULL REFERENCES public.issues(id),
        label text NOT NULL
      );
      `,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Joined issue",
      status: "todo",
      priority: "medium",
      identifier: "TST-1",
    });

    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await pluginDb.execute(
      pluginId,
      `INSERT INTO ${namespace}.mission_rows (id, issue_id, label) VALUES ($1, $2, $3)`,
      [randomUUID(), issueId, "alpha"],
    );
    const rows = await pluginDb.query<{ label: string; title: string }>(
      pluginId,
      `SELECT m.label, i.title FROM ${namespace}.mission_rows m JOIN public.issues i ON i.id = m.issue_id`,
    );
    expect(rows).toEqual([{ label: "alpha", title: "Joined issue" }]);

    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.status, "applied")));
    expect(migrations).toHaveLength(1);
  });

  it("binds an array parameter as one value for = ANY($n::text[])", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.tags (id uuid PRIMARY KEY, label text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
    for (const label of ["a", "b", "c"]) {
      await pluginDb.execute(pluginId, `INSERT INTO ${namespace}.tags (id, label) VALUES ($1, $2)`, [randomUUID(), label]);
    }

    const rows = await pluginDb.query<{ label: string }>(
      pluginId,
      `SELECT label FROM ${namespace}.tags WHERE NOT (label = ANY($1::text[])) ORDER BY label`,
      [["a", "b"]],
    );
    expect(rows).toEqual([{ label: "c" }]);
  });

  describe("runtime search_path is pinned to the plugin namespace (PEN-6604)", () => {
    /**
     * An UNQUALIFIED relation name is not a schema-qualified name, so no lexical
     * validator in this file adjudicates it, and `FROM <ns>.rows, secrets` qualifies
     * one relation so the `refs.length === 0` floor cannot fire either. Postgres then
     * resolved `secrets` through `search_path`, which nothing set -- so it reached
     * `public`. These prove the resolution, not the verdict: all three statements
     * below are ALLOWED by the validators, before and after.
     */
    async function installShadowFixture() {
      const pluginManifest = manifest();
      const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
      const packageRoot = await createPluginPackage(
        pluginManifest,
        `
        CREATE TABLE ${namespace}.anchor (id int PRIMARY KEY);
        CREATE TABLE ${namespace}.shadow_rows (label text NOT NULL);
        CREATE TABLE ${namespace}.sink (label text NOT NULL);
        `,
      );
      const pluginId = await installPluginRecord(pluginManifest);
      const pluginDb = pluginDatabaseService(db);
      await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);
      await db.execute(sql.raw(`INSERT INTO "${namespace}".anchor (id) VALUES (1)`));
      await db.execute(sql.raw(`INSERT INTO "${namespace}".shadow_rows (label) VALUES ('from-namespace')`));
      // The core-schema objects an unpinned statement used to reach.
      await db.execute(sql.raw("CREATE TABLE public.shadow_rows (label text NOT NULL)"));
      await db.execute(sql.raw("INSERT INTO public.shadow_rows (label) VALUES ('from-public')"));
      await db.execute(sql.raw("CREATE TABLE public.pen6604_only_public (label text NOT NULL)"));
      await db.execute(sql.raw("INSERT INTO public.pen6604_only_public (label) VALUES ('from-public')"));
      return { pluginId, namespace, pluginDb };
    }

    afterEach(async () => {
      await db.execute(sql.raw("DROP TABLE IF EXISTS public.shadow_rows"));
      await db.execute(sql.raw("DROP TABLE IF EXISTS public.pen6604_only_public"));
    });

    it("resolves an unqualified name inside the namespace when public also has it", async () => {
      const { pluginId, namespace, pluginDb } = await installShadowFixture();

      // Control: both tables exist and carry DIFFERENT values, so the assertion below
      // discriminates rather than matching whichever row happens to be there.
      const shadowed = await db.execute(sql.raw("SELECT label FROM public.shadow_rows"));
      expect(Array.from(shadowed as Iterable<{ label: string }>)).toEqual([{ label: "from-public" }]);

      const rows = await pluginDb.query<{ label: string }>(
        pluginId,
        `SELECT label FROM ${namespace}.anchor, shadow_rows`,
      );
      expect(rows).toEqual([{ label: "from-namespace" }]);
    });

    it("cannot reach a core table the namespace does not shadow", async () => {
      const { pluginId, namespace, pluginDb } = await installShadowFixture();

      // Control: the table is really there, so the rejection below is `search_path`
      // and not a missing relation.
      const present = await db.execute(sql.raw("SELECT label FROM public.pen6604_only_public"));
      expect(Array.from(present as Iterable<{ label: string }>)).toEqual([{ label: "from-public" }]);

      await expect(
        pluginDb.query(pluginId, `SELECT label FROM ${namespace}.anchor, pen6604_only_public`),
      ).rejects.toThrow(/pen6604_only_public/i);
    });

    it("pins the execute path too", async () => {
      const { pluginId, namespace, pluginDb } = await installShadowFixture();

      await pluginDb.execute(
        pluginId,
        `INSERT INTO ${namespace}.sink (label) SELECT label FROM shadow_rows`,
      );
      const rows = await pluginDb.query<{ label: string }>(
        pluginId,
        `SELECT label FROM ${namespace}.sink`,
      );
      expect(rows).toEqual([{ label: "from-namespace" }]);
    });

    it("leaves no search_path behind on the pooled connection", async () => {
      // `SET LOCAL` is scoped to the transaction the pin opens. A session-level `SET`
      // would leak this plugin's namespace onto every later user of the pool, which is
      // the reason this runs in a transaction at all.
      const { pluginId, namespace, pluginDb } = await installShadowFixture();
      await pluginDb.query(pluginId, `SELECT label FROM ${namespace}.anchor, shadow_rows`);

      const after = await db.execute(sql.raw("SELECT label FROM shadow_rows"));
      expect(Array.from(after as Iterable<{ label: string }>)).toEqual([{ label: "from-public" }]);
    });

    it("puts a public function out of reach, both ways", async () => {
      // Asked for in review on #3739, and it pins a stronger contract than the one an
      // earlier draft of this module's comment claimed. UNQUALIFIED, a `public`
      // function no longer resolves, because `public` is out of the path. QUALIFIED,
      // it is refused by the validator -- no ref pattern is anchored on a function
      // call, so `public.f` reaches `assertNoUnextractedSchemaRefs` as a name it must
      // adjudicate. That second half predates this change.
      const { pluginId, namespace, pluginDb } = await installShadowFixture();
      await db.execute(
        sql.raw("CREATE FUNCTION public.pen6604_marker() RETURNS text AS $$ SELECT 'public-fn' $$ LANGUAGE sql"),
      );
      try {
        // Control: the function is really there and really callable.
        const present = await db.execute(sql.raw("SELECT public.pen6604_marker() AS v"));
        expect(Array.from(present as Iterable<{ v: string }>)).toEqual([{ v: "public-fn" }]);

        await expect(
          pluginDb.query(pluginId, `SELECT pen6604_marker() AS v FROM ${namespace}.anchor`),
        ).rejects.toThrow(/pen6604_marker/i);

        await expect(
          pluginDb.query(pluginId, `SELECT public.pen6604_marker() AS v FROM ${namespace}.anchor`),
        ).rejects.toThrow(/cannot adjudicate/i);
      } finally {
        await db.execute(sql.raw("DROP FUNCTION IF EXISTS public.pen6604_marker()"));
      }
    });

    it("reads the real schema list, so a declared name cannot exempt one", async () => {
      // End to end: `drizzle` exists in this database because the core migrations
      // created it, so the alias cannot buy an exemption even though `SCHEMA_SHAPED_RE`
      // does not match the name.
      const { pluginId, namespace, pluginDb } = await installShadowFixture();

      // Control: the schema really is there, so the rejection is adjudication and not
      // a missing relation.
      const schemas = await db.execute(
        sql.raw("SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = 'drizzle'"),
      );
      expect(Array.from(schemas as Iterable<{ nspname: string }>)).toEqual([{ nspname: "drizzle" }]);

      await expect(
        pluginDb.query(
          pluginId,
          `SELECT * FROM ${namespace}.anchor drizzle, drizzle.__drizzle_migrations`,
        ),
      ).rejects.toThrow(/cannot adjudicate/i);
    });

    it("refuses to run plugin SQL on a client it cannot pin", async () => {
      // Every production caller passes a full `Db`, so this is unreachable there. It
      // is asserted because the alternative -- running unpinned when `transaction` is
      // missing -- would silently restore the hole on exactly this path.
      const { pluginId, namespace } = await installShadowFixture();
      // Built by hand rather than spread: `{ ...db }` drops the prototype methods and
      // fails on `db.select` long before it reaches the pin.
      const unpinnable = pluginDatabaseService({
        select: db.select.bind(db),
        insert: db.insert.bind(db),
        update: db.update.bind(db),
        execute: db.execute.bind(db),
      });

      await expect(
        unpinnable.query(pluginId, `SELECT label FROM ${namespace}.anchor`),
      ).rejects.toThrow(/transactional database client/i);
    });
  });

  it("rejects runtime writes to public core tables", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.notes (id uuid PRIMARY KEY, body text NOT NULL);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await expect(
      pluginDb.execute(pluginId, "UPDATE public.issues SET title = $1", ["bad"]),
    ).rejects.toThrow(/plugin namespace/i);
  });

  it("records a failed migration when SQL escapes the plugin namespace", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const packageRoot = await createPluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const pluginId = await installPluginRecord(pluginManifest);

    await expect(
      pluginDatabaseService(db).applyMigrations(pluginId, pluginManifest, packageRoot),
    ).rejects.toThrow(/public\.plugin_escape|public/i);

    const [migration] = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginId, pluginId));
    expect(migration?.status).toBe("failed");
  });

  it("rolls back plugin install when migration validation fails", async () => {
    const pluginManifest = manifest("paperclip.escape");
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      pluginManifest,
      "CREATE TABLE public.plugin_escape (id uuid PRIMARY KEY);",
    );
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ localPath: packageRoot }))
      .rejects.toThrow(/public\.plugin_escape|public/i);

    const installedPlugins = await db
      .select()
      .from(plugins)
      .where(eq(plugins.pluginKey, pluginManifest.id));
    const namespaces = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginKey, pluginManifest.id));
    const migrations = await db
      .select()
      .from(pluginMigrations)
      .where(eq(pluginMigrations.pluginKey, pluginManifest.id));
    const schemaRows = Array.from(
      await db.execute(
        sql<{ schema_name: string }>`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${namespace}`,
      ) as Iterable<{ schema_name: string }>,
    );

    expect(installedPlugins).toHaveLength(0);
    expect(namespaces).toHaveLength(0);
    expect(migrations).toHaveLength(0);
    expect(schemaRows).toHaveLength(0);
  });

  it("refreshes persisted manifests from disk before activation", async () => {
    const staleManifest = manifest("paperclip.refresh");
    const refreshedManifest: PaperclipPluginManifestV1 = {
      ...staleManifest,
      capabilities: [...staleManifest.capabilities, "agent.tools.register"],
      database: {
        ...staleManifest.database!,
        coreReadTables: ["companies"],
      },
      tools: [
        {
          name: "db-smoke",
          displayName: "DB Smoke",
          description: "Exercises plugin tool registration worker lookup.",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    };
    const namespace = derivePluginDatabaseNamespace(refreshedManifest.id);
    const packageRoot = await createInstallablePluginPackage(
      refreshedManifest,
      `
      CREATE TABLE ${namespace}.company_refs (
        id uuid PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES public.companies(id)
      );
      `,
    );
    const pluginId = await installPluginRecord(staleManifest);
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Plugin Bootstrap Co",
      issuePrefix: "PBC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(pluginConfig).values({
      pluginId,
      companyId,
      configJson: { enabled: true },
    });
    await db
      .update(plugins)
      .set({
        packagePath: packageRoot,
        status: "ready",
      })
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      getWorker: vi.fn().mockReturnValue(undefined),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    const toolDispatcher = {
      registerPluginTools: vi.fn(),
    };
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      localPluginDir: await createSdkPopulatedPluginStore(),
    }, {
      workerManager,
      eventBus: {
        forPlugin: vi.fn(() => ({})),
        subscriptionCount: vi.fn(() => 0),
      },
      jobScheduler: {
        registerPlugin: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      jobStore: {
        syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
      },
      toolDispatcher,
      lifecycleManager: {
        markError: vi.fn().mockResolvedValue(undefined),
      },
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: {
        instanceId: "test-instance",
        hostVersion: "1.0.0",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      },
    } as never);

    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    expect(workerManager.startWorker).toHaveBeenCalledWith(
      pluginId,
      expect.objectContaining({
        bootstrapCompanyId: companyId,
        databaseNamespace: namespace,
        env: expect.objectContaining({
          PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
          PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
        }),
        manifest: expect.objectContaining({
          database: expect.objectContaining({ coreReadTables: ["companies"] }),
        }),
      }),
    );
    expect(toolDispatcher.registerPluginTools).toHaveBeenCalledWith(
      refreshedManifest.id,
      expect.objectContaining({
        tools: refreshedManifest.tools,
      }),
      pluginId,
    );
    const [plugin] = await db
      .select()
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    expect(plugin?.manifestJson.database?.coreReadTables).toEqual(["companies"]);
  });

  it("rejects checksum changes for already applied migrations", async () => {
    const pluginManifest = manifest();
    const namespace = derivePluginDatabaseNamespace(pluginManifest.id);
    const packageRoot = await createPluginPackage(
      pluginManifest,
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY);`,
    );
    const pluginId = await installPluginRecord(pluginManifest);
    const pluginDb = pluginDatabaseService(db);
    await pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot);

    await writeFile(
      path.join(packageRoot, "migrations", "001_init.sql"),
      `CREATE TABLE ${namespace}.checksum_rows (id uuid PRIMARY KEY, note text);`,
      "utf8",
    );

    await expect(pluginDb.applyMigrations(pluginId, pluginManifest, packageRoot))
      .rejects.toThrow(/checksum mismatch/i);
  });
});

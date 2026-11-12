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

type SqlSpanKind = "code" | "quoted" | "comment";
type SqlSpan = { kind: SqlSpanKind; start: number; end: number; quote?: "'" | "\"" };

/**
 * The single SQL lexer shared by statement splitting and the keyword scan.
 *
 * Returns contiguous spans covering the whole input, classifying each region as
 * executable code, a quoted literal/identifier, or a comment.
 *
 * Both consumers MUST agree on what is a comment and what is a literal. They used
 * not to: `splitSqlStatements` scanned characters and tracked line comments, while
 * `stripSqlForKeywordScan` ran a chain of regexes that replaced quoted literals
 * BEFORE line comments. An apostrophe inside a `--` comment was therefore live when
 * the literal regex ran and paired with the opening quote of the next real string,
 * swallowing everything between them -- including the statement keyword. That cut
 * both ways: it refused valid migrations whose comment carried an odd number of
 * apostrophes, and it hid banned statements from `assertNoBannedSql` (PEN-5951).
 *
 * Fixing it by reordering the regexes is NOT equivalent and is not safe: stripping
 * `--` first truncates any string literal that legitimately contains `--`, leaving
 * unbalanced quotes. Only one lexer settles both directions.
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
      const newline = input.indexOf("\n", i);
      const end = newline === -1 ? input.length : newline;
      spans.push({ kind: "comment", start: i, end });
      // The newline itself stays code, so it still separates tokens.
      i = end - 1;
      codeStart = end;
      continue;
    }

    if (char === "/" && next === "*") {
      closeCode(i);
      const closed = input.indexOf("*/", i + 2);
      const end = closed === -1 ? input.length : closed + 2;
      spans.push({ kind: "comment", start: i, end });
      i = end - 1;
      codeStart = end;
      continue;
    }

    if (char === "'" || char === "\"") {
      closeCode(i);
      const quote = char;
      let j = i + 1;
      for (; j < input.length; j += 1) {
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
      out += span.quote === "'" ? "''" : "\"\"";
      continue;
    }
    // A comment is whitespace to Postgres, so it must SEPARATE the tokens either
    // side of it. Replacing it with "" glued `create/**/extension` into a single
    // token that `\bcreate\s+extension\b` could not see.
    out += " ";
  }
  return out;
}

/**
 * The same input with comments replaced by a single space, and everything else --
 * code AND quoted spans -- kept verbatim.
 *
 * This is what `extractQualifiedRefs` must read. The keyword scan blanks quoted
 * spans because it only cares about keywords; the ref extractor cannot, because a
 * quoted IDENTIFIER (`"schema"."table"`) is a ref, and because blanking literals
 * would hide the text the splitter already mis-lexed into one giant quoted span.
 *
 * Before PEN-5951 the ref extractor regexed the RAW statement while the keyword
 * scan read comment-stripped text, so the two halves of the validator disagreed
 * about a block comment placed between `UPDATE` and the table name: the keyword
 * scan saw a legal `UPDATE`, while `(update|into|from)` followed by whitespace
 * could not match across the comment. The real write target was therefore never
 * extracted, and the namespace check adjudicated some other in-namespace ref
 * instead. Both halves now read the same text.
 */
function stripSqlComments(input: string): string {
  let out = "";
  for (const span of scanSqlSpans(input)) {
    out += span.kind === "comment" ? " " : input.slice(span.start, span.end);
  }
  return out;
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

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const patterns: QualifiedRefPattern[] = [
    {
      pattern: /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern: /\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern: /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
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

function assertNoBannedSql(statement: string): void {
  assertNoEscapeStringLiterals(statement);
  const normalized = normaliseSql(statement);
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

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
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

  const refs = extractQualifiedRefs(stripSqlComments(statement));
  if (refs.length === 0 && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
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
): void {
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
  for (const ref of extractQualifiedRefs(stripSqlComments(statement))) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
  }
}

export function validatePluginRuntimeExecute(query: string, namespace: string): void {
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

  const refs = extractQualifiedRefs(stripSqlComments(statement));
  const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
  if (!target || target.schema !== namespace) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
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
            if (statements.length === 0) {
              throw new Error(`Plugin migration ${migrationKey} is empty`);
            }
            for (const statement of statements) {
              validatePluginMigrationStatement(statement, namespace.namespaceName, coreReadTables);
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
      validatePluginRuntimeQuery(statement, namespace, plugin.manifestJson.database?.coreReadTables ?? []);
      const result = await db.execute(bindSql(statement, params));
      return Array.from(result as Iterable<T>);
    },

    async execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }> {
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeExecute(statement, namespace);
      const result = await db.execute(bindSql(statement, params));
      return { rowCount: Number((result as { count?: number | string }).count ?? 0) };
    },
  };
}

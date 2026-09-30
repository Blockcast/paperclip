import { sql, type SQL } from "drizzle-orm";
import { conflict } from "../errors.js";

/**
 * Fencing-generation preconditions for host mutations made on a plugin's behalf.
 *
 * A plugin that owns a resource under its own fence can enforce that fence on
 * its *own* database writes — a single statement whose `WHERE` carries the
 * generation. It cannot enforce it on a host RPC: `ctx.issues.update`,
 * `.create`, and `.createComment` are calls into another service, so the best a
 * plugin can do alone is a check-before-act barrier:
 *
 *     assertGeneration()          // still mine?
 *        <- a steal committing HERE is not caught
 *     await ctx.issues.update()   // commits under the new owner's generation
 *
 * That window is irreducible from inside the plugin. It is closable here,
 * because a plugin's tables live in a schema of the *same* database as the host
 * tables (`plugin_<slug>_<hash>`; see `plugin-database.ts`). So the host can
 * evaluate the plugin's generation inside the very transaction that performs
 * the mutation, which is the standard fencing-token result: the token is
 * enforced by the resource being mutated.
 *
 * Two properties make this a lock rather than another barrier:
 *
 *  - `FOR SHARE` — deliberately not `FOR KEY SHARE`. The generation lives in a
 *    non-key column (alertmanager's `firing_token`), and `FOR KEY SHARE` only
 *    conflicts with key updates and deletes, so it would let an ordinary
 *    `UPDATE ... SET firing_token = ...` steal commit straight through this
 *    check. `FOR SHARE` conflicts with that write, so a steal racing an
 *    in-flight mutation *blocks* until the mutation's transaction ends.
 *  - The lock is taken inside the mutation's transaction and held to commit.
 *    Under READ COMMITTED each statement takes a fresh snapshot, so a check in
 *    a *separate* statement without a row lock would still admit a steal
 *    committing between check and write. Holding the share lock removes that
 *    interleaving entirely: the steal either commits first (this read then sees
 *    the new generation and rejects) or waits (and observes the mutation).
 *
 * The caller never names the schema — it is resolved host-side from the
 * authenticated plugin id — and table/column names are validated as plain
 * identifiers before quoting, so this does not widen a plugin's SQL reach
 * beyond its own namespace.
 */

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;
const MAX_MATCH_COLUMNS = 8;
const MAX_MATCH_VALUE_LENGTH = 512;

/**
 * Error code forwarded to the plugin worker. `plugin-worker-manager.ts` only
 * marshals a string `details.code` across the RPC boundary, so a plugin can
 * discriminate "I was displaced" from "the RPC failed" without matching prose.
 */
export const FENCING_GENERATION_LOST_CODE = "fencing_generation_lost";

/** Caller-supplied shape, as it arrives over the plugin RPC protocol. */
export type PluginFencingPreconditionInput = {
  /** Table in the calling plugin's own namespace that holds the generation. */
  table: string;
  /** Column -> required value. All must match one row for the mutation to run. */
  match: Record<string, string | number | null>;
};

/** Validated form, safe to interpolate. Only built by `resolve...` below. */
export type ResolvedPluginFencingPrecondition = {
  namespace: string;
  table: string;
  match: Array<readonly [string, string | number | null]>;
};

function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value) || value.length > MAX_POSTGRES_IDENTIFIER_LENGTH) {
    throw conflict(`Invalid fencing precondition ${label}`, {
      code: "fencing_precondition_invalid",
      label,
    });
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Validate a caller-supplied precondition and bind it to the plugin's own
 * namespace. `namespace` must come from the host's own record for the
 * authenticated plugin (`pluginDatabaseService.getRuntimeNamespace`), never
 * from the request.
 */
export function resolvePluginFencingPrecondition(
  namespace: string,
  input: PluginFencingPreconditionInput | null | undefined,
): ResolvedPluginFencingPrecondition | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object") {
    throw conflict("Invalid fencing precondition", { code: "fencing_precondition_invalid" });
  }

  const table = assertIdentifier(input.table, "table");
  const rawMatch = input.match;
  if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) {
    throw conflict("Invalid fencing precondition match", {
      code: "fencing_precondition_invalid",
      label: "match",
    });
  }

  const entries = Object.entries(rawMatch);
  if (entries.length === 0 || entries.length > MAX_MATCH_COLUMNS) {
    throw conflict("Invalid fencing precondition match arity", {
      code: "fencing_precondition_invalid",
      label: "match",
    });
  }

  const match = entries.map(([column, value]) => {
    assertIdentifier(column, "match column");
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      throw conflict("Invalid fencing precondition match value", {
        code: "fencing_precondition_invalid",
        label: column,
      });
    }
    if (typeof value === "string" && value.length > MAX_MATCH_VALUE_LENGTH) {
      throw conflict("Invalid fencing precondition match value", {
        code: "fencing_precondition_invalid",
        label: column,
      });
    }
    return [column, value] as const;
  });

  return {
    namespace: assertIdentifier(namespace, "namespace"),
    table,
    match,
  };
}

/**
 * Take a share lock on the plugin's generation row inside `tx`, and reject the
 * mutation if it no longer matches.
 *
 * Must be called on the transaction that performs the mutation, and before it.
 * Calling it on a different connection, or outside a transaction, degrades this
 * back to the barrier it exists to replace: the lock would be released the
 * moment the statement ended.
 */
export async function assertPluginFencingGeneration(
  tx: { execute: (query: SQL) => Promise<unknown> },
  precondition: ResolvedPluginFencingPrecondition | null | undefined,
): Promise<void> {
  if (!precondition) return;

  const target = sql.raw(
    `${quoteIdentifier(precondition.namespace)}.${quoteIdentifier(precondition.table)}`,
  );
  const conditions = precondition.match.map(([column, value]) => {
    const identifier = sql.raw(quoteIdentifier(column));
    return value === null ? sql`${identifier} IS NULL` : sql`${identifier} = ${value}`;
  });

  const rows = Array.from(
    (await tx.execute(
      sql`SELECT 1 FROM ${target} WHERE ${sql.join(conditions, sql` AND `)} FOR SHARE`,
    )) as Iterable<unknown>,
  );

  if (rows.length === 0) {
    throw conflict(
      "Plugin fencing generation is no longer current; refusing the mutation",
      {
        code: FENCING_GENERATION_LOST_CODE,
        table: precondition.table,
      },
    );
  }
}

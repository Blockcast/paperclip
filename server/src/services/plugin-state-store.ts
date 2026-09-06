import { and, asc, eq, isNull, like } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginState } from "@paperclipai/db";
import type {
  PluginStateScopeKind,
  SetPluginState,
  ListPluginState,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import {
  assertPluginFencingGeneration,
  type ResolvedPluginFencingPrecondition,
} from "./plugin-fencing.js";
import { recordGbrainRecallOutcome } from "./metrics.js";

/**
 * gbrain-context recall outcomes are counted here rather than in the gbrain
 * plugin worker (BLO-25892): the worker runs out-of-process with no access to
 * the server's Prometheus registry, but every prefetch result already
 * round-trips through this exact write path to persist to `plugin_state`, so
 * hooking it is free of a second RPC. See metrics.ts's GBRAIN_RECALL_METRIC
 * doc comment for the 2026-08-08 outage this detection path closes.
 *
 * Deliberately selects on (scopeKind, stateKey) and NOT on pluginId, matching
 * the RAG-health route at routes/plugins.ts:626 one-for-one. Two reasons, in
 * order of weight:
 *
 *   1. The counter exists to corroborate that route. If it filtered on plugin
 *      identity and the route did not, the two would silently disagree — and
 *      the counter is the half that gets alerted on.
 *   2. Filtering would mean hardcoding the plugin's identity ("kkroo.gbrain",
 *      a personal-scope vendor id) here as a fourth cross-package literal with
 *      no brake: a re-vendoring would zero the detector silently, which is the
 *      exact failure mode this metric was written to close.
 *
 * The residual risk it accepts is inflation, not blindness: a second plugin
 * would have to adopt the literal key `gbrain-context` under run scope, and
 * its payload would land in the "other" bucket unless it also emitted a
 * matching status string. A false zero is catastrophic for a detector; a
 * visible over-count is not. Revisit if a second writer of this key appears.
 */
const GBRAIN_CONTEXT_STATE_KEY = "gbrain-context";

function maybeRecordGbrainRecallOutcome(input: SetPluginState): void {
  if (input.scopeKind !== "run" || input.stateKey !== GBRAIN_CONTEXT_STATE_KEY) return;
  const value = input.value as { status?: unknown } | null | undefined;
  const status = typeof value?.status === "string" ? value.status : undefined;
  try {
    recordGbrainRecallOutcome(status);
  } catch {
    // Never fail a committed write on instrumentation. Both call sites are
    // post-commit, so throwing from here would report a prefetch failure for a
    // write that actually landed — and the plugin's retry would then
    // double-count. Losing one sample is strictly cheaper than corrupting the
    // caller's view of a durable write.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default namespace used when the plugin does not specify one. */
const DEFAULT_NAMESPACE = "default";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Build the WHERE clause conditions for a scoped state lookup.
 *
 * The five-part composite key is:
 *   `(pluginId, scopeKind, scopeId, namespace, stateKey)`
 *
 * `scopeId` may be null (for `instance` scope) or a non-empty string.
 */
function scopeConditions(
  pluginId: string,
  scopeKind: PluginStateScopeKind,
  scopeId: string | undefined | null,
  namespace: string,
  stateKey: string,
) {
  const conditions = [
    eq(pluginState.pluginId, pluginId),
    eq(pluginState.scopeKind, scopeKind),
    eq(pluginState.namespace, namespace),
    eq(pluginState.stateKey, stateKey),
  ];

  if (scopeId != null && scopeId !== "") {
    conditions.push(eq(pluginState.scopeId, scopeId));
  } else {
    conditions.push(isNull(pluginState.scopeId));
  }

  return and(...conditions);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Plugin State Store — scoped key-value persistence for plugin workers.
 *
 * Provides `get`, `set`, `delete`, and `list` operations over the
 * `plugin_state` table. Each plugin's data is strictly namespaced by
 * `pluginId` so plugins cannot read or write each other's state.
 *
 * This service implements the server-side backing for the `ctx.state` SDK
 * client exposed to plugin workers. The host is responsible for:
 * - enforcing `plugin.state.read` capability before calling `get` / `list`
 * - enforcing `plugin.state.write` capability before calling `set` / `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface (`ctx.state`)
 * @see PLUGIN_SPEC.md §15.1 — Capabilities: Plugin State
 * @see PLUGIN_SPEC.md §21.3 — `plugin_state` table
 */
export function pluginStateStore(db: Db) {
  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function assertPluginExists(pluginId: string): Promise<void> {
    const rows = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.id, pluginId));
    if (rows.length === 0) {
      throw notFound(`Plugin not found: ${pluginId}`);
    }
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    /**
     * Read a state value.
     *
     * Returns the stored JSON value, or `null` if no entry exists for the
     * given scope and key.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param stateKey - The key to read
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    get: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<unknown> => {
      const rows = await db
        .select()
        .from(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));

      return rows[0]?.valueJson ?? null;
    },

    /**
     * Write (create or replace) a state value.
     *
     * Uses an upsert so the caller does not need to check for prior existence.
     * On conflict (same composite key) the existing row's `value_json` and
     * `updated_at` are overwritten.
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * When `fencingPrecondition` is supplied the upsert runs inside a
     * transaction that first takes a share lock on the plugin's own generation
     * row and holds it to commit. That is what makes this a fence rather than a
     * barrier: a plugin that has been displaced since it read its own generation
     * cannot land a stale value, because a concurrent steal either commits first
     * (this write is rejected) or blocks on the lock until this write is done.
     * Without it the write is unconditional, exactly as before.
     *
     * @param pluginId - UUID of the owning plugin
     * @param input - Scope key and value to store
     * @param fencingPrecondition - Optional generation the caller must still hold
     */
    set: async (
      pluginId: string,
      input: SetPluginState,
      fencingPrecondition?: ResolvedPluginFencingPrecondition | null,
    ): Promise<void> => {
      await assertPluginExists(pluginId);

      const namespace = input.namespace ?? DEFAULT_NAMESPACE;
      const scopeId = input.scopeId ?? null;

      const values = {
        pluginId,
        scopeKind: input.scopeKind,
        scopeId,
        namespace,
        stateKey: input.stateKey,
        valueJson: input.value,
        updatedAt: new Date(),
      };
      const onConflict = {
        target: [
          pluginState.pluginId,
          pluginState.scopeKind,
          pluginState.scopeId,
          pluginState.namespace,
          pluginState.stateKey,
        ],
        set: {
          valueJson: input.value,
          updatedAt: new Date(),
        },
      };

      if (!fencingPrecondition) {
        await db.insert(pluginState).values(values).onConflictDoUpdate(onConflict);
        maybeRecordGbrainRecallOutcome(input);
        return;
      }

      await db.transaction(async (tx) => {
        // First statement in the transaction, deliberately: a displaced caller
        // is rejected before the upsert, and the share lock taken here is held
        // to commit so a steal cannot interleave with the write below.
        await assertPluginFencingGeneration(tx, fencingPrecondition);
        await tx.insert(pluginState).values(values).onConflictDoUpdate(onConflict);
      });
      // Both write paths are counted, and both only after the write has
      // committed: a fencing rejection or a failed upsert throws above, so a
      // displaced caller never inflates the recall counter. The reverse
      // direction is guarded inside maybeRecordGbrainRecallOutcome, so the
      // ordering guarantee holds in both directions rather than just one.
      maybeRecordGbrainRecallOutcome(input);
    },

    /**
     * Delete a state value.
     *
     * No-ops silently if the entry does not exist (idempotent by design).
     *
     * Requires `plugin.state.write` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param scopeKind - Granularity of the scope
     * @param stateKey - The key to delete
     * @param scopeId - Identifier for the scoped entity (null for `instance` scope)
     * @param namespace - Sub-namespace (defaults to `"default"`)
     */
    delete: async (
      pluginId: string,
      scopeKind: PluginStateScopeKind,
      stateKey: string,
      {
        scopeId,
        namespace = DEFAULT_NAMESPACE,
      }: { scopeId?: string; namespace?: string } = {},
    ): Promise<void> => {
      await db
        .delete(pluginState)
        .where(scopeConditions(pluginId, scopeKind, scopeId, namespace, stateKey));
    },

    /**
     * List all state entries for a plugin, optionally filtered by scope.
     *
     * Returns all matching rows as `PluginStateRecord`-shaped objects.
     * The `valueJson` field contains the stored value.
     *
     * Requires `plugin.state.read` capability (enforced by the caller).
     *
     * @param pluginId - UUID of the owning plugin
     * @param filter - Optional scope filters (scopeKind, scopeId, namespace)
     */
    list: async (pluginId: string, filter: ListPluginState = {}): Promise<{
      rows: typeof pluginState.$inferSelect[];
      hasMore: boolean;
    }> => {
      const conditions = [eq(pluginState.pluginId, pluginId)];
      const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(filter.limit ?? DEFAULT_LIST_LIMIT)));
      const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

      if (filter.scopeKind !== undefined) {
        conditions.push(eq(pluginState.scopeKind, filter.scopeKind));
      }
      if (filter.scopeId !== undefined) {
        conditions.push(eq(pluginState.scopeId, filter.scopeId));
      }
      if (filter.namespace !== undefined) {
        conditions.push(eq(pluginState.namespace, filter.namespace));
      }
      if (filter.stateKeyPrefix !== undefined) {
        conditions.push(like(pluginState.stateKey, `${escapeLikePattern(filter.stateKeyPrefix)}%`));
      }

      const rows = await db
        .select()
        .from(pluginState)
        .where(and(...conditions))
        .orderBy(asc(pluginState.scopeKind), asc(pluginState.scopeId), asc(pluginState.namespace), asc(pluginState.stateKey))
        .limit(limit + 1)
        .offset(offset);

      return {
        rows: rows.slice(0, limit),
        hasMore: rows.length > limit,
      };
    },

    /**
     * Delete all state entries owned by a plugin.
     *
     * Called during plugin uninstall when `removeData = true`. Also useful
     * for resetting a plugin's state during testing.
     *
     * @param pluginId - UUID of the owning plugin
     */
    deleteAll: async (pluginId: string): Promise<void> => {
      await db
        .delete(pluginState)
        .where(eq(pluginState.pluginId, pluginId));
    },
  };
}

export type PluginStateStore = ReturnType<typeof pluginStateStore>;

/**
 * Company-scoped read/write of a fingerprint's dedup row, with pre-BLO-20467
 * migration.
 *
 * Lives in its own module rather than in `webhook-handler.ts` because both
 * readers need it and `webhook-handler.ts` already imports from
 * `escalation.ts` — putting it in either would make that edge a cycle.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { alertStateRef, legacyInstanceAlertStateRef } from "./constants.js";
import type { AlertStateRecord } from "./types.js";

/**
 * A fingerprint's dedup row plus everything needed to write it back.
 *
 * Pair every `readAlertState` with `writeAlertState` rather than calling
 * `ctx.state.set(handle.ref, ...)` directly — the handle carries the legacy key
 * whose cleanup would otherwise be missed.
 */
export interface AlertStateHandle {
  /** Company-scoped key this record belongs at, and must be written back to. */
  readonly ref: ReturnType<typeof alertStateRef>;
  /** The record, or `null` when this fingerprint is unknown to this company. */
  readonly record: AlertStateRecord | null;
  /**
   * The legacy instance-scoped key the record was read from, when the company
   * scope had no row yet. `null` whenever there is nothing to clean up — the
   * scoped row already existed, no legacy row exists, or the legacy row belongs
   * to a different tenant and must be left alone.
   */
  readonly legacyRef: ReturnType<typeof legacyInstanceAlertStateRef> | null;
}

/**
 * Read a fingerprint's dedup row, falling back to a pre-BLO-20467
 * instance-scoped row when the company scope has none yet.
 *
 * The fallback is gated on `paperclipCompanyId`: a legacy row is surfaced only
 * to the company whose issue it actually tracks. A row belonging to another
 * tenant is ignored (and left in place), which is precisely the cross-tenant
 * reuse this change exists to stop. Without the read-through, every alert
 * firing at upgrade time would look new — duplicating live issues and orphaning
 * the originals so their resolution could never close them.
 *
 * Both the webhook path and the escalation sweep must go through this. A sweep
 * that read only the scoped key would see `null` for any alert still firing
 * across the upgrade and skip its ladder silently, because a ladder can fall
 * due before Alertmanager's next `repeat_interval` delivery arrives to migrate
 * the row — turning a missed escalation into a wait of up to `repeat_interval`.
 *
 * THIS FUNCTION WRITES NOTHING, and that is deliberate. An earlier version
 * copied the legacy row to the scoped key here, which made a read racy against
 * a concurrent writer: a webhook and a sweep could both observe an empty scope
 * and read the same snapshot, and whichever copied it *second* would land a
 * verbatim pre-migration record on top of a scoped row the other had already
 * advanced or resolved — dropping `resolvedAt` and replaying an escalation
 * rung. `ctx.state` offers no compare-and-swap to guard that write against
 * (`PluginStateClient` is get/list/set/delete, and `plugin_state` has no
 * version column), so the fix is to not make the write at all.
 *
 * Migration therefore happens as a side effect of the caller's own write: every
 * reader here goes on to persist a record *derived from* what it read, via
 * `writeAlertState`. That write carries the caller's intended mutation instead
 * of reverting to a snapshot, so the ordering of two racing callers can no
 * longer lose a resolution outright.
 *
 * The second migration-specific hazard — a concurrent adopter deleting the
 * legacy row between this function's two reads, making a tracked alert look
 * new — is closed by the confirming re-read at the end. See the comment there
 * for why `writeAlertState`'s ordering makes that conclusive.
 *
 * What remains is the ordinary last-write-wins of any read-modify-write over a
 * store without CAS: a sweep that reads a record, decides to act, and writes an
 * advanced rung can still land on top of a resolution a webhook wrote in
 * between. That hazard is NOT introduced here and is not specific to adoption —
 * it is identical for a row that has been company-scoped since it was created
 * and never went near the legacy key, which `escalation.test.ts` asserts
 * directly so the claim is checked rather than argued. Serializing it needs
 * either CAS on `ctx.state` or the contended key moved into the plugin's own
 * namespace (where `ctx.db.execute` can do a guarded upsert, as `escalation.ts`
 * already does for cover membership). Tracked in BLO-20650 — deliberately out
 * of scope here because it applies to every escalation write, not to migration.
 *
 * The narrower things this DOES buy: a reader that decides to take no action
 * now writes nothing at all, so it can no longer destroy a concurrent
 * resolution just by having looked; and adoption can no longer duplicate an
 * issue for an alert another caller has already migrated.
 */
export async function readAlertState(
  ctx: PluginContext,
  companyId: string,
  fingerprint: string,
): Promise<AlertStateHandle> {
  const ref = alertStateRef(companyId, fingerprint);
  const scoped = (await ctx.state.get(ref)) as AlertStateRecord | null;
  if (scoped) return { ref, record: scoped, legacyRef: null };

  const legacyRef = legacyInstanceAlertStateRef(fingerprint);
  const legacy = (await ctx.state.get(legacyRef)) as AlertStateRecord | null;
  if (legacy) {
    return legacy.paperclipCompanyId === companyId
      ? { ref, record: legacy, legacyRef }
      : { ref, record: null, legacyRef: null };
  }

  // No scoped row and no legacy row. That reads as "this fingerprint is new",
  // but during migration it has a second cause: a concurrent caller adopted the
  // legacy row between our two reads, so it deleted the row we just missed.
  //
  // Confirm before declaring the alert new. `writeAlertState` migrates in a
  // fixed order — scoped row written FIRST, legacy row deleted second — so the
  // only way the legacy row can have vanished under us is that its scoped
  // successor already exists. Re-reading the scoped key therefore SETTLES the
  // question rather than merely narrowing the window: either we find the row
  // the other caller published, or there genuinely never was one.
  //
  // Without this, that interleaving makes `readAlertState` return
  // `record: null` for an alert we are already tracking, and `handleFiring`
  // takes its create path — filing a duplicate issue and orphaning the original
  // so its resolution can never close it. That is the exact failure the
  // read-through fallback exists to prevent, reintroduced by a race.
  const adopted = (await ctx.state.get(ref)) as AlertStateRecord | null;
  if (adopted) return { ref, record: adopted, legacyRef: null };

  return { ref, record: null, legacyRef: null };
}

/**
 * Persist a dedup row to its company scope, retiring the legacy row it was
 * adopted from.
 *
 * Order matters: the scoped write lands first, so a failure between the two
 * leaves the legacy row in place and the next read simply adopts it again.
 * Once the scoped row exists the legacy row is unreachable — `readAlertState`
 * returns before ever looking at it — so failing to delete it costs an inert
 * row, never correctness.
 */
export async function writeAlertState(
  ctx: PluginContext,
  handle: AlertStateHandle,
  record: AlertStateRecord,
): Promise<void> {
  await ctx.state.set(handle.ref, record);
  if (!handle.legacyRef) return;
  try {
    await ctx.state.delete(handle.legacyRef);
  } catch (err) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: migrated alert ${handle.ref.stateKey} to company scope but could not remove the legacy row: ${String(err)}`,
    );
  }
}

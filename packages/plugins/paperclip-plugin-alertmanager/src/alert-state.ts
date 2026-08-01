/**
 * Company-scoped read of a fingerprint's dedup row, with pre-BLO-20467
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
 * Read a fingerprint's dedup row from its owning company's scope, migrating a
 * pre-BLO-20467 instance-scoped row on first sight.
 *
 * The migration is gated on `paperclipCompanyId`: a legacy row is adopted only
 * by the company whose issue it actually tracks. A row belonging to another
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
 */
export async function readAlertState(
  ctx: PluginContext,
  companyId: string,
  fingerprint: string,
): Promise<{ ref: ReturnType<typeof alertStateRef>; record: AlertStateRecord | null }> {
  const ref = alertStateRef(companyId, fingerprint);
  const scoped = (await ctx.state.get(ref)) as AlertStateRecord | null;
  if (scoped) return { ref, record: scoped };

  const legacyRef = legacyInstanceAlertStateRef(fingerprint);
  const legacy = (await ctx.state.get(legacyRef)) as AlertStateRecord | null;
  if (legacy && legacy.paperclipCompanyId === companyId) {
    await ctx.state.set(ref, legacy);
    try {
      await ctx.state.delete(legacyRef);
    } catch (err) {
      // The scoped copy is already durable, so the migration has taken effect;
      // a stale legacy row is inert (only this company could ever adopt it, and
      // it will never be read again now that the scoped row exists).
      ctx.logger.warn(
        `paperclip-plugin-alertmanager: migrated alert ${fingerprint} to company scope but could not remove the legacy row: ${String(err)}`,
      );
    }
    return { ref, record: legacy };
  }
  return { ref, record: null };
}

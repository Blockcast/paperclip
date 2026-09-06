import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  setGbrainContextCoverageMetrics,
  setGbrainContextCoverageRefreshSuccess,
} from "./metrics.js";

/**
 * Refresh gbrain-context coverage from the activity side (BLO-30067).
 *
 * The LEFT JOIN is deliberate: a plugin outage writes no plugin_state row,
 * so grouping plugin_state alone would erase the hour from the result set.
 * A failed refresh leaves the previous values in place and marks them stale.
 */
export async function refreshGbrainContextCoverageMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const result = await db.execute(sql`
      with activity as (
        select count(*)::double precision as runs
        from heartbeat_runs
        where started_at >= ${windowStart}::timestamptz
      ), state as (
        select count(*)::double precision as rows
        from plugin_state
        where state_key = 'gbrain-context'
          and scope_kind = 'run'
          and updated_at >= ${windowStart}::timestamptz
      )
      select activity.runs, coalesce(state.rows, 0)::double precision as rows
      from activity
      left join state on true
    `);
    const row = Array.from(result)[0] as { runs: number | string; rows: number | string };
    setGbrainContextCoverageMetrics({
      runsLastHour: Number(row?.runs ?? 0),
      stateRowsLastHour: Number(row?.rows ?? 0),
      refreshSucceeded: true,
    });
  } catch (error) {
    // Preserve the last good activity snapshot. Zeroing it would turn a dead
    // detector into a healthy-looking "no traffic" reading.
    setGbrainContextCoverageRefreshSuccess(false);
    throw error;
  }
}

import {
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  type InheritedTimeoutSettings,
} from "@paperclipai/db";
import {
  POOL_IDLE_IN_TRANSACTION_SERIES,
  type DbInheritedTimeoutSetting,
} from "./services/metrics.js";

/**
 * The series `startServer` publishes through `setDbInheritedTimeouts`
 * (PEN-3365): the three settings the pool inherits from the server, plus the
 * pool's own idle-in-transaction bound from its startup packet.
 *
 * Built here rather than inline at the call site so the fourth series has a
 * failing test if it is dropped: without the pool series the gauge reverts to
 * the inherited-only reading, and the `LOOSENED:` verdict goes back to living
 * only in a startup log line nobody reads. It lives outside `metrics.ts`
 * because that module deliberately keeps no dependency on `@paperclipai/db`.
 */
export function dbInheritedTimeoutSeries(
  inherited: InheritedTimeoutSettings,
): DbInheritedTimeoutSetting[] {
  return [
    inherited.statementTimeout,
    inherited.idleInTransactionSessionTimeout,
    inherited.lockTimeout,
    {
      name: POOL_IDLE_IN_TRANSACTION_SERIES,
      valueMs: POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      source: "startup_packet",
    },
  ];
}

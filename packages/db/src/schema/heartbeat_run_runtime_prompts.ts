import { customType, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** Private startup input scoped by the owning heartbeat run. */
export const heartbeatRunRuntimePrompts = pgTable(
  "heartbeat_run_runtime_prompts",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    prompt: bytea("prompt").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index("heartbeat_run_runtime_prompts_expires_at_idx").on(table.expiresAt),
  }),
);

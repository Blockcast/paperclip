import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const externalRuntimeReservations = pgTable(
  "external_runtime_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    slotId: integer("slot_id").notNull(),
    state: text("state").notNull().default("reserved"),
    expectedJobName: text("expected_job_name"),
    jobName: text("job_name"),
    jobUid: text("job_uid"),
    isolationMode: text("isolation_mode"),
    isolationKey: text("isolation_key"),
    isolationBoundAt: timestamp("isolation_bound_at", { withTimezone: true }),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    launchingAt: timestamp("launching_at", { withTimezone: true }),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: uniqueIndex("external_runtime_reservations_run_idx").on(table.runId),
    activeSlotIdx: uniqueIndex("external_runtime_reservations_active_slot_idx")
      .on(table.agentId, table.slotId)
      .where(sql`${table.releasedAt} is null`),
    activeIsolationWriterIdx: uniqueIndex("external_runtime_reservations_active_isolation_writer_idx")
      .on(table.isolationKey)
      .where(sql`${table.releasedAt} is null and ${table.isolationKey} is not null`),
    activeAgeIdx: index("external_runtime_reservations_active_age_idx")
      .on(table.reservedAt)
      .where(sql`${table.releasedAt} is null`),
    activeStateIdx: index("external_runtime_reservations_active_state_idx")
      .on(table.state)
      .where(sql`${table.releasedAt} is null`),
    stateCheck: check(
      "external_runtime_reservations_state_check",
      sql`${table.state} in ('reserved', 'launching', 'launched', 'release_pending', 'released')`,
    ),
    isolationModeCheck: check(
      "external_runtime_reservations_isolation_mode_check",
      sql`${table.isolationMode} is null or ${table.isolationMode} in ('shared', 'run', 'workspace')`,
    ),
    isolationBindingCheck: check(
      "external_runtime_reservations_isolation_binding_check",
      sql`(${table.isolationMode} is null and ${table.isolationKey} is null and ${table.isolationBoundAt} is null)
        or (${table.isolationMode} is not null and ${table.isolationKey} is not null and ${table.isolationBoundAt} is not null)`,
    ),
  }),
);

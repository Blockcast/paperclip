import { pgTable, uuid, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    // BLO-34578: serves the heartbeat timer's baseline read
    // (`MAX(requested_at) ... WHERE source = 'timer' GROUP BY agent_id`), which
    // runs on every scheduler pass. `agentRequestedIdx` above cannot: it has no
    // `source` column, so Postgres must read each agent's entire history and
    // filter — and this is the largest table in the schema, pruned only to a
    // 14-day window, so that scan grows with the whole retained window.
    // ⚠️ The pruning is OUT OF THIS REPO and cannot be found by grepping it:
    // onprem-k8s `paperclip/postgres-retention.yaml`, CronJob
    // `paperclip-pg-retention` (ns `paperclip`, 04:30Z daily, runtime_days=14).
    // It nulls `heartbeat_runs.wakeup_request_id` past the same cutoff FIRST,
    // which releases the FK exemption on the DELETE below it.
    // Partial on `source = 'timer'` keeps it O(1) per agent regardless of size.
    timerBaselineIdx: index("agent_wakeup_requests_timer_baseline_idx")
      .on(table.agentId, table.requestedAt.desc())
      .where(sql`${table.source} = 'timer'`),
    // PEN-3734: serves the oldest-pending-deferred-wake age aggregate
    // (`MIN(requested_at) ... WHERE status = 'deferred_issue_execution'
    //  GROUP BY agent_id`), run by the scrape-metrics collector every 15s.
    // Neither index above can bound it: `companyAgentStatusIdx` leads with
    // `company_id`, so a status-only predicate cannot probe it, and
    // `agentRequestedIdx` carries no `status`. Without this the aggregate is a
    // full scan of the largest table in the schema, on a 15s cadence.
    //
    // Partial on the one status, `requested_at` ASC after `agent_id` so each
    // agent's MIN is the first entry under its key. The pending-deferred set is
    // bounded by the number of issues under concurrent contention — a handful
    // — and a row leaves the index the moment it is promoted, so the object
    // stays tiny no matter how large the table grows.
    deferredIssueExecutionIdx: index("agent_wakeup_requests_deferred_issue_execution_idx")
      .on(table.agentId, table.requestedAt)
      .where(sql`${table.status} = 'deferred_issue_execution'`),
    // PEN-6104: the four payload-target indexes. Until migration 0278 this
    // table carried NO index of any kind on `payload`, so the membership
    // predicate five subsystems issue --
    //
    //   payload ->> 'issueId' = $1 or payload ->> 'taskId' = $1
    //   or payload -> '_paperclipWakeContext' ->> 'issueId' = $1
    //   or payload -> '_paperclipWakeContext' ->> 'taskId' = $1
    //
    // -- could only be answered by walking `companyRequestedIdx` with all four
    // arms as a per-row recheck, each needing a heap fetch and a `jsonb`
    // detoast. The `LIMIT` on those reads does not bound it: it short-circuits
    // only while matches are DENSE near the top of the range, and a row whose
    // wakes are sparse in the window -- most rows, and every row an operator is
    // likely to be investigating -- is answered only after the entire window
    // has been walked. Measured in production between two rows of this same
    // table: a 2,664-wake issue answered in 5.4 ms after rejecting 3,086 rows;
    // a 6-wake issue took 237.6 ms and rejected all 158,651 rows in the window.
    //
    // ⭐ FOUR OBJECTS, NOT ONE, AND THE READER MUST CARRY A `?` GUARD. The
    // disjunction is a MEMBERSHIP test over four independent keys; a single
    // `coalesce(...)` scalar models ATTRIBUTION instead and silently drops a
    // row whose nested context names a different issue from its top level
    // (measured, `packages/db/src/agent-wakeup-payload-target-semantics.test.ts`).
    // A GIN index on `payload` carries neither `company_id` nor `requested_at`
    // and so cannot supply the ordering the `LIMIT` needs -- it made the common
    // dense path 42x WORSE. A stored generated column takes an `ACCESS
    // EXCLUSIVE` table rewrite, 74.9 s at 2M rows and linear, on the table
    // every heartbeat writes to. These four partial btrees are the only shape
    // that is exact, serves the ordering, and is reachable with
    // `CREATE INDEX CONCURRENTLY` alone.
    //
    // ⛔ The partial predicate is `payload ? '<key>'` and a query arm written
    // as a bare `payload ->> '<key>' = $1` CANNOT REACH IT -- the planner has
    // to PROVE the query implies the index predicate, and `->> = $1` does not
    // imply `? '<key>'` even though it entails it semantically. Built without
    // the guarded reader these four objects are 124 MB that nothing ever uses:
    // measured 253.8 ms, i.e. the unindexed plan unchanged. Every reader must
    // go through `wakeRequestTargetsIssueCondition` /
    // `wakeRequestTargetsAnyIssueCondition` in
    // `server/src/services/agent-wakeup-target.ts`, which carry the guards.
    //
    // Price, measured at 2M seeded rows: 124 MB total (~20% of heap) and ~35%
    // of insert throughput on this table. Paid deliberately -- the sparse path
    // above degrades LINEARLY with the table while this cost does not, and the
    // read I/O it removes lands on the same device as the writes.
    //
    // On a populated database these are created out of band with
    // `CREATE INDEX CONCURRENTLY`, one at a time (migration 0278, registered in
    // PENDING_CONCURRENT_INDEXES). Declared here so drizzle's schema diff stays
    // clean and fresh/bootstrap databases get them automatically.
    payloadIssueIdx: index("agent_wakeup_requests_payload_issue_idx")
      .on(table.companyId, sql`(${table.payload} ->> 'issueId')`, table.requestedAt.desc())
      .where(sql`${table.payload} ? 'issueId'`),
    payloadTaskIdx: index("agent_wakeup_requests_payload_task_idx")
      .on(table.companyId, sql`(${table.payload} ->> 'taskId')`, table.requestedAt.desc())
      .where(sql`${table.payload} ? 'taskId'`),
    payloadContextIssueIdx: index("agent_wakeup_requests_payload_context_issue_idx")
      .on(
        table.companyId,
        sql`((${table.payload} -> '_paperclipWakeContext') ->> 'issueId')`,
        table.requestedAt.desc(),
      )
      .where(sql`${table.payload} -> '_paperclipWakeContext' ? 'issueId'`),
    payloadContextTaskIdx: index("agent_wakeup_requests_payload_context_task_idx")
      .on(
        table.companyId,
        sql`((${table.payload} -> '_paperclipWakeContext') ->> 'taskId')`,
        table.requestedAt.desc(),
      )
      .where(sql`${table.payload} -> '_paperclipWakeContext' ? 'taskId'`),
  }),
);

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// BLO-36017: the backstop rotation cursors used to be in-memory closure variables, so every
// process replacement reset them to null and restarted the rotation at page 1. Under worker
// churn shorter than one rotation that meant the tail beyond page 1 was never visited, and
// the sweep-completion counter -- which only fires on the tail tick, where
// `candidateLimitSkipped` reaches 0 -- never incremented at all. Measured over a 66h churn
// window: `increase(paperclip_backstop_sweep_completed_total[2h])` was flat 0 on both streams.
//
// One row per sweep rotation. `sweep` is composed by the service as `<name>:<companyId ?? "*">`
// so a company-scoped call keeps its own rotation instead of advancing the global one -- the
// previous shared-closure behaviour let a scoped call clobber the global cursor.
//
// ponytail: last-writer-wins across processes. Two workers racing a tick can re-visit one page,
// which costs a duplicate pass and never skips a row. Take a row lock here if the deployment
// ever runs more than one worker replica.
export const backstopSweepCursors = pgTable("backstop_sweep_cursors", {
  sweep: text("sweep").primaryKey(),
  // Null means "start the rotation at the head" -- both the initial state and the value written
  // by the tail tick that completes a rotation.
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

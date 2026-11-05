import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * BLO-52499: one row per GitHub status key (`lower(repo)#sha`) while an
 * evaluation of that head holds it. A lease rather than a session advisory
 * lock, so a holder that has checked it before a GitHub write can finish that
 * write before anyone else takes the key (see migration 0273).
 */
export const githubStatusKeyLeases = pgTable("github_status_key_leases", {
  key: text("key").primaryKey(),
  /** One per evaluation, so two evaluations in one process exclude each other. */
  token: text("token").notNull(),
  /** Database clock. Past this, any evaluation may take the key. */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

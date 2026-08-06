import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Durable inbox for signed GitHub webhook deliveries that revoke and
 * reconcile the review gate outside the request lifecycle.
 */
export const githubReviewGateDeliveries = pgTable(
  "github_review_gate_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: text("delivery_id").notNull(),
    repoFullName: text("repo_full_name").notNull(),
    eventName: text("event_name").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadDigest: text("payload_digest").notNull(),
    statusContext: text("status_context").notNull(),
    reviewerBotLogin: text("reviewer_bot_login").notNull(),
    baseRef: text("base_ref").notNull(),
    dispatchEventType: text("dispatch_event_type").notNull(),
    expectedAppId: text("expected_app_id").notNull(),
    expectedInstallationId: text("expected_installation_id").notNull(),
    /** queued -> processing -> delivered; governance failures retry indefinitely. */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    deliveryIdUq: uniqueIndex("github_review_gate_deliveries_delivery_id_uq").on(
      table.deliveryId,
    ),
    statusDueIdx: index("github_review_gate_deliveries_status_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
  }),
);

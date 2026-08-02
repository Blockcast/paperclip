import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    sourceTrust: row.sourceTrust ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function workProductService(db: Db) {
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    /**
     * Insert-or-update a work product that has a stable external identity
     * (BLO-19566). Used by the GitHub webhook, where one PR emits many events
     * (opened, synchronize, ready_for_review, closed) that must converge on a
     * single row rather than appending one per delivery.
     *
     * Atomic via the partial unique index on
     * (company_id, issue_id, provider, type, external_id) -- a plain
     * select-then-insert has no row to lock before the first insert, so two
     * concurrent `synchronize` deliveries would both miss and both insert.
     *
     * `insertOnly` fields are applied when the row is created and preserved on
     * update, so first-seen provenance (createdByRunId, isPrimary) is not
     * rewritten by later events.
     */
    upsertByExternalId: async (
      issueId: string,
      companyId: string,
      key: { provider: string; type: string; externalId: string },
      data: Omit<
        typeof issueWorkProducts.$inferInsert,
        "issueId" | "companyId" | "provider" | "type" | "externalId"
      >,
    ) => {
      const now = new Date();
      const incomingSourceEventOrder = sql<number>`case
        when excluded.metadata->>'sourceEventOrder' ~ '^[0-9]+$'
          then (excluded.metadata->>'sourceEventOrder')::int
        when excluded.status = 'merged' then 30
        when excluded.status = 'closed' then 20
        else 10
      end`;
      const existingSourceEventOrder = sql<number>`case
        when ${issueWorkProducts.metadata}->>'sourceEventOrder' ~ '^[0-9]+$'
          then (${issueWorkProducts.metadata}->>'sourceEventOrder')::int
        when ${issueWorkProducts.status} = 'merged' then 30
        when ${issueWorkProducts.status} = 'closed' then 20
        else 10
      end`;
      const incomingSourceEventTimestampMs = sql<number | null>`case
        when excluded.metadata->>'sourceEventTimestampMs' ~ '^[0-9]+$'
          then (excluded.metadata->>'sourceEventTimestampMs')::bigint
        else null
      end`;
      const existingSourceEventTimestampMs = sql<number | null>`case
        when ${issueWorkProducts.metadata}->>'sourceEventTimestampMs' ~ '^[0-9]+$'
          then (${issueWorkProducts.metadata}->>'sourceEventTimestampMs')::bigint
        else null
      end`;
      const incomingIsReopen = sql`excluded.metadata->>'lastEventAction' in ('reopened', 'ready_for_review')`;
      const acceptIncoming = sql`case
        when ${incomingSourceEventTimestampMs} is not null and ${existingSourceEventTimestampMs} is not null
          then ${incomingSourceEventTimestampMs} > ${existingSourceEventTimestampMs}
            or (
              ${incomingSourceEventTimestampMs} = ${existingSourceEventTimestampMs}
              and ${incomingSourceEventOrder} > ${existingSourceEventOrder}
            )
        when ${incomingSourceEventTimestampMs} is not null and ${existingSourceEventTimestampMs} is null
          then ${incomingSourceEventOrder} > ${existingSourceEventOrder}
            or (${existingSourceEventOrder} = 10 and ${incomingSourceEventOrder} = 10)
            or ${incomingIsReopen}
        else ${incomingSourceEventOrder} > ${existingSourceEventOrder}
          or ${incomingIsReopen}
      end`;
      const row = await db
        .insert(issueWorkProducts)
        .values({
          ...data,
          companyId,
          issueId,
          provider: key.provider,
          type: key.type,
          externalId: key.externalId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            issueWorkProducts.companyId,
            issueWorkProducts.issueId,
            issueWorkProducts.provider,
            issueWorkProducts.type,
            issueWorkProducts.externalId,
          ],
          targetWhere: isNotNull(issueWorkProducts.externalId),
          set: {
            title: sql`case when ${acceptIncoming} then excluded.title else ${issueWorkProducts.title} end`,
            url: sql`case when ${acceptIncoming} then excluded.url else ${issueWorkProducts.url} end`,
            status: sql`case when ${acceptIncoming} then excluded.status else ${issueWorkProducts.status} end`,
            summary: sql`case when ${acceptIncoming} then excluded.summary else ${issueWorkProducts.summary} end`,
            metadata: sql`case when ${acceptIncoming} then excluded.metadata else ${issueWorkProducts.metadata} end`,
            sourceTrust: sql`case when ${acceptIncoming} then excluded.source_trust else ${issueWorkProducts.sourceTrust} end`,
            updatedAt: sql`case when ${acceptIncoming} then ${now} else ${issueWorkProducts.updatedAt} end`,
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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
      // Bound as an ISO string with an explicit cast, NOT as a JS `Date`.
      // postgres.js cannot infer a parameter type for a Date interpolated into
      // a raw `sql` fragment (as opposed to a drizzle-mapped column value), and
      // throws ERR_INVALID_ARG_TYPE "Received an instance of Date" -- which the
      // webhook's best-effort catch swallowed, silently disabling every PR
      // work-product write.
      const nowSql = sql`${now.toISOString()}::timestamptz`;
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
      // Rank for events that cannot be ordered by source timestamp -- same
      // second, or a legacy row written before the timestamp was recorded.
      //
      // `reopened`/`ready_for_review` sit deliberately ABOVE `closed` rather
      // than at their nonterminal rank. GitHub's `pull_request.updated_at` is
      // second-granular, so a rapid close-then-reopen carries one timestamp and
      // no field in the payload recovers the true order. Ranking the reopen
      // higher makes the pair converge on "open" whichever way the two
      // deliveries arrive, instead of letting arrival order decide. `merged`
      // stays on top and absorbing, so no same-second stray event un-merges a
      // PR.
      const tieRank = (
        statusExpr: SQL | typeof issueWorkProducts.status,
        metadataExpr: SQL | typeof issueWorkProducts.metadata,
      ) => sql<number>`case
        when ${statusExpr} = 'merged' then 30
        when ${metadataExpr}->>'lastEventAction' in ('reopened', 'ready_for_review') then 25
        when ${statusExpr} = 'closed' then 20
        else 10
      end`;
      const incomingTieRank = tieRank(sql`excluded.status`, sql`excluded.metadata`);
      const existingTieRank = tieRank(issueWorkProducts.status, issueWorkProducts.metadata);
      // Total order over same-rank payloads, so two distinct same-second events
      // (typically two pushes) resolve to the same row regardless of which is
      // delivered first. This is a *stability* rule, not a causality claim: at
      // equal rank and equal timestamp the source carries no evidence of which
      // event came first, so the tie is settled by content instead of by
      // arrival. Equal keys mean the two payloads are indistinguishable on
      // every field this row stores, so rejecting the incoming one is what
      // keeps redeliveries idempotent and preserves `updatedAt`.
      const contentKey = (
        statusExpr: SQL | typeof issueWorkProducts.status,
        titleExpr: SQL | typeof issueWorkProducts.title,
        urlExpr: SQL | typeof issueWorkProducts.url,
        metadataExpr: SQL | typeof issueWorkProducts.metadata,
      ) => sql<string>`concat_ws(
        chr(1),
        coalesce(${metadataExpr}->>'headSha', ''),
        coalesce(${statusExpr}, ''),
        coalesce(${titleExpr}, ''),
        coalesce(${urlExpr}, '')
      )`;
      const incomingContentKey = contentKey(
        sql`excluded.status`,
        sql`excluded.title`,
        sql`excluded.url`,
        sql`excluded.metadata`,
      );
      const existingContentKey = contentKey(
        issueWorkProducts.status,
        issueWorkProducts.title,
        issueWorkProducts.url,
        issueWorkProducts.metadata,
      );
      const tieBreak = sql`(
        ${incomingTieRank} > ${existingTieRank}
        or (${incomingTieRank} = ${existingTieRank} and ${incomingContentKey} > ${existingContentKey})
      )`;
      const acceptIncoming = sql`case
        when ${incomingSourceEventTimestampMs} is not null and ${existingSourceEventTimestampMs} is not null
          then case
            when ${incomingSourceEventTimestampMs} > ${existingSourceEventTimestampMs} then true
            when ${incomingSourceEventTimestampMs} < ${existingSourceEventTimestampMs} then false
            else ${tieBreak}
          end
        else ${tieBreak}
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
            updatedAt: sql`case when ${acceptIncoming} then ${nowSql} else ${issueWorkProducts.updatedAt} end`,
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

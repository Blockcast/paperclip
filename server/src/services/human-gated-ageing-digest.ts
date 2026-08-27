/**
 * Human-gated ageing digest delivery (BLO-29420).
 *
 * `human-gated-ageing.ts` shipped as a pure report builder with 35 tests and
 * **zero production importers** — it had never fired once. This module is the
 * missing half: the DB query that populates the human clock, and a delivery
 * channel for the rendered digest.
 *
 * Three properties the delivery has to preserve, because they are the reason
 * the ageing module exists:
 *
 * 1. **Not agent-silenceable.** The body is recomputed every period from
 *    `lastHumanTouchAt` — the newest `issue_comments.author_type = 'user'` /
 *    `activity_log.actor_type = 'user'` timestamp. An agent commenting on a
 *    listed issue writes `author_type = 'agent'`, which does not advance that
 *    clock, so it cannot alter what the digest reports. Deriving the clock from
 *    `updatedAt` / `lastActivityAt` would reintroduce exactly that hole: both
 *    are bumped by agent writes via DB trigger.
 * 2. **Idempotent.** One durable row per company, keyed on
 *    `(originKind, originId)` — refreshed in place rather than minting a row
 *    per fire. Re-running a tick with unchanged input rewrites nothing, so it
 *    cannot produce a second row or a duplicate notification.
 * 3. **Bounded.** The ageing module's `DEFAULT_MAX_ESCALATED` cap is honoured;
 *    the remainder is reported as a count, never silently dropped.
 *
 * The sweep never closes the digest row while work is still overdue, and
 * reopens it if something closed it — a digest that can be marked `done` while
 * the queue is still ageing is not an escalation. The off-switch is the config
 * flag, not the row's status.
 *
 * Delivery is a **producer registry**, not a bespoke hook: the digest body is
 * assembled from N registered producers. That is what lets a second ageing
 * source join the same seam without re-deciding the channel.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companyMemberships, issueComments, issues } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import {
  DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
  DEFAULT_MAX_ESCALATED,
  HUMAN_GATED_OPEN_STATUSES,
  formatHumanGatedAgeingSections,
  sanitizeRenderedField,
  selectAgedHumanGatedIssues,
  type HumanGatedIssue,
} from "./human-gated-ageing.js";

/** Stable `originKind` for the durable digest row. */
export const HUMAN_GATED_DIGEST_ORIGIN_KIND = "human-gated-ageing-digest";

/**
 * Stable `originId` — company-scoped and constant across periods, so there is
 * exactly one durable row per company for all time. The *period* is carried in
 * the body marker, not in the key: keying on the period would mint a new row
 * every week, which is the "row per fire" shape this seam exists to avoid.
 */
export function humanGatedDigestOriginId(companyId: string): string {
  return `${HUMAN_GATED_DIGEST_ORIGIN_KIND}:${companyId}`;
}

/** How long one digest period lasts. The module's own framing is a weekly digest. */
export const DEFAULT_DIGEST_PERIOD_DAYS = 7;

const DAY_MS = 86_400_000;

/** Rows per `inArray` chunk — keeps each aggregate's parameter list bounded. */
const AGGREGATE_CHUNK_SIZE = 500;

const DIGEST_TITLE = "[user-cover] Human-gated work is ageing past its escalation threshold";
const UNKNOWN_PRODUCER = "(unknown producer)";
const UNKNOWN_FAILURE_REASON = "(no reason provided)";

type DigestLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/**
 * A period identifier derived from wall-clock alone, so every replica computes
 * the same value without coordination. Epoch-relative rather than calendar
 * weeks: no locale, no timezone, no week-numbering edge cases.
 */
export function digestPeriodKey(now: Date, periodDays: number = DEFAULT_DIGEST_PERIOD_DAYS): string {
  if (!Number.isFinite(periodDays) || periodDays <= 0) {
    throw new Error(`periodDays must be a positive finite number, received ${String(periodDays)}`);
  }
  return `p${Math.floor(now.getTime() / (periodDays * DAY_MS))}`;
}

function periodMarker(periodKey: string): string {
  return `<!-- human-gated-digest period=${periodKey} -->`;
}

/** One rendered contribution to the digest body. */
export type DigestSection = {
  key: string;
  /** Rendered markdown. Producers own their own untrusted-data delimiting. */
  markdown: string;
  /** How many items this section is reporting; 0 means "ran clean, nothing overdue". */
  itemCount: number;
};

export type DigestProducerContext = {
  db: Db;
  companyId: string;
  now: Date;
  logger: DigestLogger;
};

/**
 * A digest producer. `collect` returns `null` when the producer has nothing to
 * say this period; anything else is rendered into the durable row.
 *
 * A producer that throws is reported in the digest as a failed section rather
 * than silently omitted — an absent section and a healthy one must not look
 * identical, which is the failure class this whole issue is about.
 */
export type DigestProducer = {
  key: string;
  collect: (ctx: DigestProducerContext) => Promise<DigestSection | null>;
};

// ---------------------------------------------------------------------------
// The human clock (AC2)
// ---------------------------------------------------------------------------

type HumanTouchRow = { issueId: string; latestAt: string | Date | null };

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function newerIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Newest human-attributable comment per issue.
 *
 * `issue_comments.author_type` is nullable — it was added without a backfill
 * (migration `0093_white_darwin.sql`), so a bare `author_type = 'user'` drops
 * every legacy row and under-reports human touches, which reads as *more*
 * silence than there really was. The `IS NULL` arm mirrors the repo's canonical
 * `deriveIssueCommentAuthorType` fallback (`issues.ts`): no agent author and a
 * user author means a human wrote it.
 */
async function latestHumanCommentAt(
  db: Db,
  companyId: string,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const ids of chunk(issueIds, AGGREGATE_CHUNK_SIZE)) {
    const rows = (await db
      .select({
        issueId: issueComments.issueId,
        latestAt: sql<string | Date | null>`MAX(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, ids as string[]),
          isNull(issueComments.deletedAt),
          sql`(${issueComments.authorType} = 'user' OR (${issueComments.authorType} IS NULL AND ${issueComments.authorAgentId} IS NULL AND ${issueComments.authorUserId} IS NOT NULL))`,
        ),
      )
      .groupBy(issueComments.issueId)) as HumanTouchRow[];
    for (const row of rows) {
      const iso = toIso(row.latestAt);
      if (iso) result.set(row.issueId, iso);
    }
  }
  return result;
}

/**
 * Newest human-attributable activity-log entry per issue.
 *
 * `activity_log` has no `issue_id` column: it is polymorphic on
 * `(entity_type, entity_id)`, and `entity_id` is `text` while `issues.id` is
 * `uuid` — hence the `inArray` over string ids rather than a join.
 */
async function latestHumanActivityAt(
  db: Db,
  companyId: string,
  issueIds: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const ids of chunk(issueIds, AGGREGATE_CHUNK_SIZE)) {
    const rows = (await db
      .select({
        issueId: activityLog.entityId,
        latestAt: sql<string | Date | null>`MAX(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.actorType, "user"),
          inArray(activityLog.entityId, ids as string[]),
        ),
      )
      .groupBy(activityLog.entityId)) as HumanTouchRow[];
    for (const row of rows) {
      const iso = toIso(row.latestAt);
      if (iso) result.set(row.issueId, iso);
    }
  }
  return result;
}

/**
 * The digest row is itself an open issue assigned to a human, so without this
 * it lands in its own candidate set: it inflates the scanned count on every
 * pass (which alone defeats the unchanged-body check and makes each tick a
 * write), and once it is older than its own priority's threshold it escalates
 * itself. An escalation that reports itself as overdue work is noise that
 * trains a human to ignore the row.
 */
const EXCLUDE_DIGEST_ROWS = sql`${issues.originKind} IS DISTINCT FROM ${HUMAN_GATED_DIGEST_ORIGIN_KIND}`;

export type LoadHumanGatedIssuesOptions = {
  /** Hold candidate issue rows through the caller's surrounding transaction. */
  lockRows?: boolean;
};

/**
 * Load the open, human-gated issues for one company with their human clock
 * populated — the input `human-gated-ageing.ts` was written against and has
 * never once been handed in production.
 */
export async function loadHumanGatedIssues(
  db: Db,
  companyId: string,
  options: LoadHumanGatedIssuesOptions = {},
): Promise<HumanGatedIssue[]> {
  const query = db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeUserId: issues.assigneeUserId,
      createdAt: issues.createdAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...HUMAN_GATED_OPEN_STATUSES]),
        sql`${issues.assigneeUserId} IS NOT NULL`,
        EXCLUDE_DIGEST_ROWS,
      ),
    )
    // Acquire candidate locks in a stable order. Human-clock mutation triggers
    // take FOR SHARE on the same rows, while comment foreign keys take the
    // compatible FOR KEY SHARE mode. This makes the aggregate snapshot atomic
    // without introducing a lock inversion for bulk comment inserts.
    .orderBy(asc(issues.id));

  const rows = options.lockRows ? await query.for("no key update") : await query;

  if (rows.length === 0) return [];

  const issueIds = rows.map((row) => row.id);
  const [commentTouch, activityTouch] = await Promise.all([
    latestHumanCommentAt(db, companyId, issueIds),
    latestHumanActivityAt(db, companyId, issueIds),
  ]);

  return rows.map((row) => {
    const createdAt = toIso(row.createdAt);
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assigneeUserId: row.assigneeUserId,
      // `createdAt` is notNull in the schema; the fallback only guards an
      // unparseable value, which the ageing module reports as malformed rather
      // than silently treating as "no clock".
      createdAt: createdAt ?? "",
      lastHumanTouchAt: newerIso(
        commentTouch.get(row.id) ?? null,
        activityTouch.get(row.id) ?? null,
      ),
    } satisfies HumanGatedIssue;
  });
}

// ---------------------------------------------------------------------------
// Producers
// ---------------------------------------------------------------------------

/** The BLO-19130 human-gated ageing report, wired to the real human clock. */
export const humanGatedAgeingProducer: DigestProducer = {
  key: "human-gated-ageing",
  collect: async ({ db, companyId, now }) => {
    // Collection runs inside the company delivery transaction. Keep the
    // candidate rows locked through the digest decision so a concurrent human
    // resolution cannot commit between the ageing snapshot and its delivery.
    const candidates = await loadHumanGatedIssues(db, companyId, { lockRows: true });
    if (candidates.length === 0) return null;

    const report = selectAgedHumanGatedIssues(candidates, {
      now,
      escalateAfterDaysByPriority: DEFAULT_ESCALATE_AFTER_DAYS_BY_PRIORITY,
      // Explicit rather than defaulted: the cap is an acceptance criterion, so
      // it should be visible at the call site rather than inherited silently.
      maxEscalated: DEFAULT_MAX_ESCALATED,
    });

    // A malformed row is reported even at zero escalations: "nothing is
    // overdue" computed from input we could not read is the false all-clear
    // the ageing module was built to refuse.
    if (report.totalOverThreshold === 0 && report.malformed.length === 0) return null;

    return {
      key: "human-gated-ageing",
      markdown: formatHumanGatedAgeingSections(report),
      itemCount: report.totalOverThreshold,
    };
  },
};

/** Producers contributing to the digest, in render order. */
export const DEFAULT_DIGEST_PRODUCERS: readonly DigestProducer[] = Object.freeze([
  humanGatedAgeingProducer,
]);

// ---------------------------------------------------------------------------
// Body assembly
// ---------------------------------------------------------------------------

export type DigestBodyInput = {
  periodKey: string;
  /**
   * Kept in the input shape for callers that already provide the sweep time.
   * The timestamp is deliberately not rendered: the description is also the
   * idempotency representation for a period and must not change on every tick.
   */
  now: Date;
  sections: readonly DigestSection[];
  failures: readonly { key: string; reason: string }[];
};

export function buildDigestBody(input: DigestBodyInput): string {
  const lines: string[] = [
    periodMarker(input.periodKey),
    "",
    `_Digest period \`${input.periodKey}\`._`,
    "",
    "This row is refreshed in place by the human-gated ageing sweep (BLO-29420).",
    "It is measured on the **human clock** — the newest `issue_comments.author_type = 'user'`",
    "or `activity_log.actor_type = 'user'` timestamp — so agent activity cannot age it out",
    "or silence it. Closing this row does not stop the sweep; the sweep will reopen it while",
    "work is still overdue. Turn it off with `PAPERCLIP_HUMAN_GATED_DIGEST_ENABLED=false`.",
    "",
  ];

  if (input.failures.length > 0) {
    lines.push(
      `> ⚠ ${input.failures.length} producer${input.failures.length === 1 ? "" : "s"} failed this period and ${input.failures.length === 1 ? "is" : "are"} NOT represented below — this digest is incomplete, not an all-clear.`,
    );
    for (const failure of input.failures) {
      // Producer keys and thrown messages are untrusted: this body is fed to a
      // governance-agent prompt, so keep both fields bounded and on this row.
      const key = sanitizeRenderedField(failure.key, UNKNOWN_PRODUCER);
      const reason = sanitizeRenderedField(failure.reason, UNKNOWN_FAILURE_REASON);
      lines.push(`> - \`${key}\`: ${reason}`);
    }
    lines.push("");
  }

  if (input.sections.length === 0) {
    lines.push("### Nothing overdue this period", "", "- None.");
    return lines.join("\n");
  }

  for (const [index, section] of input.sections.entries()) {
    if (index > 0) lines.push("", "---", "");
    lines.push(section.markdown);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Delivery (AC3)
// ---------------------------------------------------------------------------

/**
 * The human this digest is assigned to: owner, then admin, then the oldest
 * active membership. Mirrors `resolveEscalationOwnerUserId` in
 * `productivity-review.ts` — an escalation nobody is named on is not an
 * escalation.
 */
export async function resolveDigestOwnerUserId(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      userId: companyMemberships.principalId,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .orderBy(
      sql`case when ${companyMemberships.membershipRole} = 'owner' then 0 when ${companyMemberships.membershipRole} = 'admin' then 1 else 2 end`,
      companyMemberships.createdAt,
      companyMemberships.id,
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Is this user still an active human member of the company?
 *
 * First delivery refuses to assign a digest to anyone who is not — the query
 * above filters on `status = 'active'` — so every later assignment decision has
 * to apply the same test. A membership can be revoked between a digest being
 * retired and the next actionable period reopening it, and retaining the
 * recorded id across that gap hands the escalation to someone who cannot act on
 * it while still reading as owned.
 */
async function isActiveCompanyMember(
  db: Db,
  companyId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function findDigestIssue(db: Db, companyId: string) {
  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      description: issues.description,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND),
        eq(issues.originId, humanGatedDigestOriginId(companyId)),
        isNull(issues.hiddenAt),
      ),
    )
    .orderBy(desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

const DIGEST_DELIVERY_LOCK_PREFIX = "paperclip:human-gated-ageing-digest:";

export type DigestDeliveryOutcome = {
  companyId: string;
  issueId: string | null;
  identifier: string | null;
  action:
    | "created"
    | "refreshed"
    | "reopened"
    | "retired"
    | "unchanged"
    | "skipped_no_owner"
    | "skipped_empty";
  itemCount: number;
};

/** What the producers had to say for one company, in one period. */
export type DigestCollection = {
  body: string;
  itemCount: number;
  /** True when a producer returned a meaningful section, including zero items. */
  hasContent: boolean;
  failures: readonly { key: string; reason: string }[];
};

export async function deliverDigest(
  db: Db,
  input: {
    companyId: string;
    /**
     * Produce the digest body. Invoked **inside** the delivery transaction with
     * the company lock already held, so the snapshot the body is rendered from
     * cannot move between being read and being written.
     *
     * Collecting before the lock is what let a human resolve the last overdue
     * candidate in the gap and still get a digest created — or a retired one
     * reopened — naming work that was no longer overdue. The lock serializes
     * digest-row writes; it only makes the *decision* sound if the read that
     * feeds it happens under the same lock.
     */
    collect: (txDb: Db) => Promise<DigestCollection>;
    logger: DigestLogger;
  },
): Promise<DigestDeliveryOutcome> {
  const { companyId, logger } = input;

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    // Serialize the complete read/decide/create-or-update lifecycle. There is
    // no matching uniqueness constraint for this origin shape, so every digest
    // writer must acquire this company-scoped lock before its first read.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${DIGEST_DELIVERY_LOCK_PREFIX + companyId}, 0))`,
    );

    const { body, itemCount, hasContent } = await input.collect(txDb);

    const existing = await findDigestIssue(txDb, companyId);

    if (!existing) {
      // A clean run with no producer output must not mint an empty escalation.
      if (!hasContent) {
        return { companyId, issueId: null, identifier: null, action: "skipped_empty", itemCount };
      }

      const ownerUserId = await resolveDigestOwnerUserId(txDb, companyId);
      if (!ownerUserId) {
        // A digest assigned to nobody is the inertness this issue is about, one
        // layer up. Say so loudly rather than creating an unowned row.
        logger.warn(
          { companyId },
          "human-gated ageing digest has no active human member to assign; skipping delivery",
        );
        return { companyId, issueId: null, identifier: null, action: "skipped_no_owner", itemCount };
      }
      const created = await issueService(txDb).create(companyId, {
        title: DIGEST_TITLE,
        description: body,
        status: "todo",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: ownerUserId,
        originKind: HUMAN_GATED_DIGEST_ORIGIN_KIND,
        originId: humanGatedDigestOriginId(companyId),
        originFingerprint: humanGatedDigestOriginId(companyId),
        // The recent-open-title guard would suppress the *first* re-create after
        // a manual delete; the origin lookup above is this row's real dedupe.
        allowDuplicate: true,
      });
      return {
        companyId,
        issueId: created.id,
        identifier: created.identifier,
        action: "created",
        itemCount,
      };
    }

    const wasTerminal = TERMINAL_STATUSES.has(existing.status);

    if (!wasTerminal && !hasContent) {
      // Once every producer is clean and has nothing to report, an open digest
      // is no longer an escalation. Retire it instead of leaving an assigned
      // `todo` row that says there is no overdue work and gets rewritten every
      // period. A later actionable pass will reopen this same durable row.
      await issueService(txDb).update(existing.id, {
        description: body,
        status: "done",
      });
      return {
        companyId,
        issueId: existing.id,
        identifier: existing.identifier,
        action: "retired",
        itemCount,
      };
    }

    if (wasTerminal && !hasContent) {
      // A terminal row still needs reconciliation when its last actionable
      // candidate resolves. Keeping the old body would leave a closed digest
      // claiming that already-resolved work is overdue forever. Preserve the
      // terminal status while replacing only the stale report when needed.
      if (existing.description === body) {
        return {
          companyId,
          issueId: existing.id,
          identifier: existing.identifier,
          action: "unchanged",
          itemCount,
        };
      }
      await issueService(txDb).update(existing.id, { description: body });
      return {
        companyId,
        issueId: existing.id,
        identifier: existing.identifier,
        action: "refreshed",
        itemCount,
      };
    }

    const patch: Parameters<ReturnType<typeof issueService>["update"]>[1] = { description: body };

    if (!wasTerminal) {
      // Validate the live owner before the unchanged-body fast path. A body
      // can remain byte-for-byte identical while its recorded human member is
      // revoked; returning unchanged in that case strands the escalation on a
      // user who can no longer receive or act on it.
      const ownerStillActive =
        existing.assigneeUserId !== null &&
        (await isActiveCompanyMember(txDb, companyId, existing.assigneeUserId));
      if (!ownerStillActive) {
        const ownerUserId = await resolveDigestOwnerUserId(txDb, companyId);
        if (!ownerUserId) {
          // Keep the actionable row in the digest population so a later sweep
          // can assign it when a human member returns, but never leave it
          // visibly assigned to a revoked member.
          if (existing.assigneeUserId !== null) {
            await issueService(txDb).update(existing.id, {
              assigneeAgentId: null,
              assigneeUserId: null,
            });
          }
          logger.warn(
            { companyId, issueId: existing.id, staleAssigneeUserId: existing.assigneeUserId },
            "human-gated ageing digest has no active human member for its live row; clearing stale owner",
          );
          return {
            companyId,
            issueId: existing.id,
            identifier: existing.identifier,
            action: "skipped_no_owner",
            itemCount,
          };
        }
        patch.assigneeUserId = ownerUserId;
        patch.assigneeAgentId = null;
      }

      // Unchanged body on a live row: rewriting would be a no-op write and,
      // worse, a bumped `updatedAt` that makes the row look freshly handled.
      // If owner repair populated `patch`, the write is still required.
      if (existing.description === body && patch.assigneeUserId === undefined) {
        return {
          companyId,
          issueId: existing.id,
          identifier: existing.identifier,
          action: "unchanged",
          itemCount,
        };
      }
    }

    if (wasTerminal) {
      // AC3: refresh it if it was closed. A digest an agent can retire while the
      // queue is still ageing is not an escalation — the config flag is the
      // off-switch, not this row's status.
      patch.status = "todo";
      patch.completedAt = null;
      patch.cancelledAt = null;
      // Reassign when the row is unowned *or* when the recorded owner has since
      // been deactivated or removed. Checking only for null would let a reopen
      // deliver to an inactive member, which first delivery explicitly refuses
      // to do — the two paths have to agree on what a valid owner is.
      const ownerStillActive =
        existing.assigneeUserId !== null &&
        (await isActiveCompanyMember(txDb, companyId, existing.assigneeUserId));
      if (!ownerStillActive) {
        const ownerUserId = await resolveDigestOwnerUserId(txDb, companyId);
        if (!ownerUserId) {
          // Symmetric with creation: rather than reopen an escalation named on
          // nobody (or on someone who can no longer act), leave it terminal and
          // say so. A later period reopens the same durable row once the company
          // has an active human again.
          logger.warn(
            { companyId, issueId: existing.id, staleAssigneeUserId: existing.assigneeUserId },
            "human-gated ageing digest has no active human member to reopen against; leaving retired",
          );
          return {
            companyId,
            issueId: existing.id,
            identifier: existing.identifier,
            action: "skipped_no_owner",
            itemCount,
          };
        }
        patch.assigneeUserId = ownerUserId;
        patch.assigneeAgentId = null;
      }
    }

    await issueService(txDb).update(existing.id, patch);
    return {
      companyId,
      issueId: existing.id,
      identifier: existing.identifier,
      action: wasTerminal ? "reopened" : "refreshed",
      itemCount,
    };
  });
}

// ---------------------------------------------------------------------------
// The wired tick (AC1)
// ---------------------------------------------------------------------------

export type HumanGatedDigestTickInput = {
  now?: Date;
  periodDays?: number;
  producers?: readonly DigestProducer[];
  /** Restrict the sweep to one company. Omitted means every candidate/digest company. */
  companyId?: string;
  logger?: DigestLogger;
};

export type HumanGatedDigestTickResult = {
  periodKey: string;
  companiesScanned: number;
  outcomes: DigestDeliveryOutcome[];
};

/**
 * Companies with either an open, human-gated issue or an existing digest row.
 * Existing rows must remain in the population after the last candidate is
 * resolved, otherwise an open digest stays stale forever and a terminal row
 * can never be reconciled.
 */
async function selectDigestCompanyIds(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ companyId: issues.companyId })
    .from(issues)
    .where(
      and(
        isNull(issues.hiddenAt),
        or(
          and(
            inArray(issues.status, [...HUMAN_GATED_OPEN_STATUSES]),
            sql`${issues.assigneeUserId} IS NOT NULL`,
            EXCLUDE_DIGEST_ROWS,
          ),
          eq(issues.originKind, HUMAN_GATED_DIGEST_ORIGIN_KIND),
        ),
      ),
    );
  return rows.map((row) => row.companyId);
}

/**
 * One sweep pass. This is the wired entry point — the thing an integration test
 * must exercise. Calling the pure `selectAgedHumanGatedIssues` directly is what
 * passed for two years of green CI while the escalation never fired.
 */
/**
 * Run every registered producer and render the body.
 *
 * `db` here is the *transaction-scoped* handle supplied by `deliverDigest`, so
 * the snapshot this reads is the one the delivery decision is made against.
 */
async function collectDigest(input: {
  db: Db;
  companyId: string;
  now: Date;
  periodKey: string;
  producers: readonly DigestProducer[];
  logger: DigestLogger;
}): Promise<DigestCollection> {
  const { db, companyId, now, periodKey, producers, logger } = input;
  const sections: DigestSection[] = [];
  const failures: { key: string; reason: string }[] = [];

  for (const producer of producers) {
    try {
      const section = await producer.collect({ db, companyId, now, logger });
      if (section) sections.push(section);
    } catch (err) {
      // A thrown producer must not read as a clean section. Record it so the
      // rendered body says the digest is incomplete.
      failures.push({
        key: producer.key,
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.error({ err, companyId, producer: producer.key }, "digest producer failed");
    }
  }

  return {
    body: buildDigestBody({ periodKey, now, sections, failures }),
    itemCount: sections.reduce((sum, section) => sum + section.itemCount, 0),
    // A non-null producer section is meaningful even when it contains zero
    // escalated items (for example, a malformed-input warning). Producer
    // failures are likewise durable signal, not an empty sweep.
    hasContent: sections.length > 0 || failures.length > 0,
    failures,
  };
}

export async function humanGatedDigestTick(
  db: Db,
  input: HumanGatedDigestTickInput = {},
): Promise<HumanGatedDigestTickResult> {
  const now = input.now ?? new Date();
  const periodDays = input.periodDays ?? DEFAULT_DIGEST_PERIOD_DAYS;
  const producers = input.producers ?? DEFAULT_DIGEST_PRODUCERS;
  const logger = input.logger ?? defaultLogger;
  const periodKey = digestPeriodKey(now, periodDays);

  const companyIds = input.companyId ? [input.companyId] : await selectDigestCompanyIds(db);
  const outcomes: DigestDeliveryOutcome[] = [];

  for (const companyId of companyIds) {
    outcomes.push(
      await deliverDigest(db, {
        companyId,
        logger,
        // Deliberately a callback rather than a value: it runs under the
        // company lock inside the delivery transaction, so a candidate cannot
        // be resolved between the snapshot and the write it justifies.
        collect: (txDb) =>
          collectDigest({ db: txDb, companyId, now, periodKey, producers, logger }),
      }),
    );
  }

  return { periodKey, companiesScanned: companyIds.length, outcomes };
}

// ---------------------------------------------------------------------------
// Worker-tier singleton
// ---------------------------------------------------------------------------

export type HumanGatedDigestScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: HumanGatedDigestScheduler = { setInterval, clearInterval };

export function startHumanGatedDigestSweep(
  db: Db,
  intervalMs: number,
  options: Omit<HumanGatedDigestTickInput, "now"> = {},
  scheduler: HumanGatedDigestScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    if (inFlight) return;
    inFlight = humanGatedDigestTick(db, options)
      .then((result) => {
        const delivered = result.outcomes.filter(
          (outcome) => outcome.action !== "unchanged" && outcome.action !== "skipped_empty",
        );
        if (delivered.length > 0) {
          defaultLogger.info(
            { periodKey: result.periodKey, delivered },
            "human-gated ageing digest delivered",
          );
        }
      })
      .catch((err) => {
        defaultLogger.error({ err }, "human-gated ageing digest sweep failed");
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}

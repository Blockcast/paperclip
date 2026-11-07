import type {
  PluginApiRequestInput,
  PluginApiResponse,
  PluginContext,
} from "@paperclipai/plugin-sdk";
import {
  ATTENDANCE_TABLE,
  UNDELIVERED_WAKE_OUTCOMES,
  type AttendanceDisposition,
  type ObservedAlertLiveness,
  type WakeOutcome,
} from "./attendance-record.js";

/**
 * PEN-2918 (D) — a read path for `alert_attendance_observations`.
 *
 * ## ⛔ This OVERTURNS a shipped decision. Read why before changing it.
 *
 * `migrations/007_attendance_observations.sql` states, and the module header of
 * `attendance-record.ts` repeated, that there is *"deliberately no route or SDK
 * read for this table — 'queryable in the plugin namespace' is the whole
 * claim"*. That was not an oversight; it was a considered position with a good
 * reason behind it: PEN-2918 is a row about an alert delivered ~4,900 times
 * over 96h that changed nothing, so it refuses *delivery*, *durability* and
 * *volume* as remedies **by measurement**, and the 2026-10-03 ruling on
 * PEN-3315 separately refused a second audit surface beside Paperclip.
 *
 * The reason this module exists anyway, authorized by the CEO on
 * 2026-11-07T05:0xZ: **that reason is sound about NOTIFICATION and does not
 * transfer to AUDIT.** A read path nobody is obliged to poll creates no
 * obligation surface and no second place anyone must look. The original
 * sentence collapsed the two. PEN-2918's own second criterion had already
 * required this in its own words — it closes when a determination is written
 * *and readable* — so this is the unbuilt half of #3202, not new scope.
 *
 * It was also overturned on evidence, not taste. On 2026-11-07 the question
 * *"is this table being written at all?"* was asked with the source open and
 * **could not be answered**, which produced a confident, false "zero
 * observations can exist" on PEN-2918 — an inference from the wrong
 * population (rows are appended per ladder **determination over an already-open
 * alert row**, not per alert row created). An instrument that cannot be read
 * cannot be caught being wrong.
 *
 * ## ⛔ What this does NOT do
 *
 * 1. **It obliges nobody.** Nothing polls it, nothing alerts on it, nothing
 *    pages. There is no schedule, no notification, no channel, no dashboard
 *    anyone is expected to watch. Making non-acknowledgement *readable* is not
 *    making it *bind*; PEN-2918's third criterion is untouched here, and this
 *    estate has no on-call owner **by board decision** (card `b94c4d7d`,
 *    Option B) rather than by omission.
 * 2. **It writes nothing.** Every statement is a SELECT, and that is enforced
 *    by the host rather than merely intended: `ctx.db.query` rejects anything
 *    that is not `SELECT`/`WITH` (`validatePluginRuntimeQuery`). The ladder is
 *    untouched — no file under the escalation path is changed by the commit
 *    that added this module.
 * 3. **It does not record `executed`.** It reports what the ladder observed
 *    about *attendance*. Whether the work was done has a different source.
 *
 * ## ⚠️ The first answer will look like mass neglect. It is not.
 *
 * The ladder's attendance test is `hasArmedMonitor(issue, now) ||
 * hasLiveBlocker(...)` and nothing else — **`parkedUntil` appears nowhere in
 * it**. A deliberately parked row, with an unpark condition written on it by
 * its owner, is attended by this estate's primary attendance instrument and is
 * nevertheless classified `unattended_*` here. Measured 2026-11-07: of the six
 * open alertmanager-origin rows, five were attended solely by a park.
 *
 * So a high `unattended_*` count is **first** evidence that the instrument is
 * miscalibrated against how this company works, and only after that evidence
 * about the estate. That caveat ships *inside the response body* rather than
 * only in this comment, because a qualification a reader has to go and find is
 * the exact failure PEN-2918 measures. See `SUMMARY_CAVEATS`.
 */

/** Route keys; must match `apiRoutes` in `manifest.ts`. */
export const ATTENDANCE_SUMMARY_ROUTE = "attendance-observations-summary";
export const ATTENDANCE_UNDELIVERED_ROUTE = "attendance-observations-undelivered";

/** Window applied when the caller names none. Matches the README's worked query. */
export const DEFAULT_WINDOW_HOURS = 24 * 7;
/** Upper bound on the window a caller may request, to keep the read bounded. */
export const MAX_WINDOW_HOURS = 24 * 365;
/** Row caps for the undelivered listing. */
export const DEFAULT_UNDELIVERED_LIMIT = 100;
export const MAX_UNDELIVERED_LIMIT = 500;

/**
 * Fixed sentences returned beside the counts.
 *
 * These travel with the numbers deliberately. PEN-2918's own finding is that a
 * record which exists where a diligent reader *would* find it is not a record
 * that *reaches* the next reader, so the one qualification that decides how
 * these counts should be read is attached to them rather than left in a README.
 * They are constant strings — not computed, not per-row, never an error
 * message — so they add no channel and leak nothing.
 */
export const SUMMARY_CAVEATS: readonly string[] = [
  "unattended_* does not mean nobody is attending: the ladder's attendance test is an armed monitor or a live blockedBy edge only, and parkedUntil appears nowhere in it. A deliberately parked row reads unattended here.",
  "enqueued means the host accepted the wake. It is not evidence that a run started, and it is never acknowledgement. Acknowledgement is recorded only from the attended_* dispositions.",
  "This table records attendance, never whether the work was executed. That is a different question with a different source.",
];

export interface AttendanceSummaryBucket {
  disposition: AttendanceDisposition | string;
  wakeOutcome: WakeOutcome | string;
  observations: number;
  issues: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export interface AttendanceSummary {
  since: string;
  windowHours: number;
  totalObservations: number;
  totalIssues: number;
  byDisposition: Record<string, number>;
  byWakeOutcome: Record<string, number>;
  buckets: AttendanceSummaryBucket[];
  caveats: readonly string[];
}

export interface UndeliveredObservation {
  observedAt: string;
  alertIssueId: string;
  alertname: string;
  disposition: AttendanceDisposition | string;
  escalationAttempt: number | null;
  subjectAgentId: string | null;
  wakeOutcome: WakeOutcome | string;
  wakeDetail: string | null;
  alertLiveness: ObservedAlertLiveness | string;
}

type SummaryRow = {
  disposition: string;
  wake_outcome: string;
  observations: string | number;
  issues: string | number;
  first_observed_at: string | Date;
  last_observed_at: string | Date;
};

type UndeliveredRow = {
  observed_at: string | Date;
  alert_issue_id: string;
  alertname: string;
  disposition: string;
  escalation_attempt: number | null;
  subject_agent_id: string | null;
  wake_outcome: string;
  wake_detail: string | null;
  alert_liveness: string;
};

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Postgres returns bigint aggregates as strings over the wire. */
function int(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Caller input is rejected with a fixed message, never echoed back. */
export class AttendanceQueryInputError extends Error {}

/**
 * Resolves the window start from `since` (ISO-8601) or `sinceHours`.
 *
 * Both are rejected rather than silently coerced when unparseable. A window
 * that quietly fell back to a default would answer a *different question* than
 * the one asked while looking like an answer to it — which is the shape of
 * defect this whole row exists to measure.
 */
export function resolveSince(
  query: Record<string, string | string[]>,
  now: Date = new Date(),
): { since: Date; windowHours: number } {
  const sinceRaw = firstQueryValue(query.since);
  const hoursRaw = firstQueryValue(query.sinceHours);
  if (sinceRaw && hoursRaw) {
    throw new AttendanceQueryInputError("pass either since or sinceHours, not both");
  }

  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AttendanceQueryInputError("since must be an ISO-8601 timestamp");
    }
    const windowMs = now.getTime() - parsed.getTime();
    if (windowMs < 0) {
      throw new AttendanceQueryInputError("since must not be in the future");
    }
    const windowHours = windowMs / 3_600_000;
    if (windowHours > MAX_WINDOW_HOURS) {
      throw new AttendanceQueryInputError(`since must be within ${MAX_WINDOW_HOURS} hours`);
    }
    return { since: parsed, windowHours: Math.round(windowHours * 100) / 100 };
  }

  let windowHours = DEFAULT_WINDOW_HOURS;
  if (hoursRaw !== undefined) {
    const parsed = Number(hoursRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_WINDOW_HOURS) {
      throw new AttendanceQueryInputError(
        `sinceHours must be a number between 0 and ${MAX_WINDOW_HOURS}`,
      );
    }
    windowHours = parsed;
  }
  return { since: new Date(now.getTime() - windowHours * 3_600_000), windowHours };
}

export function resolveLimit(query: Record<string, string | string[]>): number {
  const raw = firstQueryValue(query.limit);
  if (raw === undefined) return DEFAULT_UNDELIVERED_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_UNDELIVERED_LIMIT) {
    throw new AttendanceQueryInputError(
      `limit must be an integer between 1 and ${MAX_UNDELIVERED_LIMIT}`,
    );
  }
  return parsed;
}

/**
 * The `IN (...)` list for the undelivered query, rendered from
 * `UNDELIVERED_WAKE_OUTCOMES` so the two cannot drift.
 *
 * ⛔ Rendered as literals rather than bound as a parameter, on purpose, and the
 * reason is the partial index. `alert_attendance_observations_undelivered_idx`
 * is `WHERE wake_outcome IN ('refused', 'declined')`, and Postgres can only use
 * a partial index when it can prove the query predicate implies the index
 * predicate — which it cannot do against a bind parameter whose value is
 * unknown at plan time. Hardcoding the literals here instead would reintroduce
 * exactly the drift the migration warns about: `refused` alone was the original
 * predicate, and it was wrong in the direction that reads CLEAN, because
 * `declined` is the commoner token.
 *
 * Every token is asserted to be a bare lowercase identifier before it reaches
 * the SQL text, so this cannot become an injection site even if the constant is
 * later edited carelessly.
 */
export function undeliveredWakeOutcomeSqlList(
  outcomes: readonly string[] = UNDELIVERED_WAKE_OUTCOMES,
): string {
  if (outcomes.length === 0) {
    throw new Error("UNDELIVERED_WAKE_OUTCOMES must not be empty");
  }
  return outcomes
    .map((outcome) => {
      if (!/^[a-z_]+$/.test(outcome)) {
        throw new Error(`wake outcome token is not a bare identifier: ${outcome}`);
      }
      return `'${outcome}'`;
    })
    .join(", ");
}

/**
 * Acceptance question (a): how many observations exist, by disposition, over a
 * window.
 *
 * Grouped by `(disposition, wake_outcome)` — the README's own worked query —
 * because the disposition alone cannot distinguish "the rung advanced and the
 * owner was woken" from "the rung advanced and the wake was dropped on the
 * floor". The per-disposition totals the question literally asks for are
 * summed from these buckets rather than fetched separately, so the two can
 * never disagree.
 */
export async function summariseAttendance(
  ctx: PluginContext,
  companyId: string,
  since: Date,
  windowHours: number,
): Promise<AttendanceSummary> {
  const rows = await ctx.db.query<SummaryRow>(
    `SELECT disposition,
            wake_outcome,
            count(*) AS observations,
            count(DISTINCT alert_issue_id) AS issues,
            min(observed_at) AS first_observed_at,
            max(observed_at) AS last_observed_at
       FROM ${ctx.db.namespace}.${ATTENDANCE_TABLE}
      WHERE company_id = $1
        AND observed_at >= $2
      GROUP BY disposition, wake_outcome
      ORDER BY count(*) DESC, disposition ASC, wake_outcome ASC`,
    [companyId, since.toISOString()],
  );

  const buckets: AttendanceSummaryBucket[] = rows.map((row) => ({
    disposition: row.disposition,
    wakeOutcome: row.wake_outcome,
    observations: int(row.observations),
    issues: int(row.issues),
    firstObservedAt: iso(row.first_observed_at),
    lastObservedAt: iso(row.last_observed_at),
  }));

  const byDisposition: Record<string, number> = {};
  const byWakeOutcome: Record<string, number> = {};
  let totalObservations = 0;
  for (const bucket of buckets) {
    byDisposition[bucket.disposition] = (byDisposition[bucket.disposition] ?? 0) + bucket.observations;
    byWakeOutcome[bucket.wakeOutcome] = (byWakeOutcome[bucket.wakeOutcome] ?? 0) + bucket.observations;
    totalObservations += bucket.observations;
  }

  // Issue counts do NOT sum across buckets — one issue contributes to several —
  // so the distinct total is read separately rather than derived from them.
  const [totals] = await ctx.db.query<{ issues: string | number }>(
    `SELECT count(DISTINCT alert_issue_id) AS issues
       FROM ${ctx.db.namespace}.${ATTENDANCE_TABLE}
      WHERE company_id = $1
        AND observed_at >= $2`,
    [companyId, since.toISOString()],
  );

  return {
    since: since.toISOString(),
    windowHours,
    totalObservations,
    totalIssues: totals ? int(totals.issues) : 0,
    byDisposition,
    byWakeOutcome,
    buckets,
    caveats: SUMMARY_CAVEATS,
  };
}

/**
 * Acceptance question (b): every pass whose wake never reached a run.
 *
 * This is the sharpest read of the set. The rung posts `"waking current owner
 * <name>"` as an issue comment *before* calling `issues.requestWakeup`, and
 * swallows a dropped wake by design so the rung does not repeat — so a row here
 * is a thread that asserts a wake which never happened. Before this route the
 * only way to count them was direct database access.
 */
export async function listUndeliveredWakes(
  ctx: PluginContext,
  companyId: string,
  since: Date,
  limit: number,
): Promise<UndeliveredObservation[]> {
  const rows = await ctx.db.query<UndeliveredRow>(
    `SELECT observed_at,
            alert_issue_id,
            alertname,
            disposition,
            escalation_attempt,
            subject_agent_id,
            wake_outcome,
            wake_detail,
            alert_liveness
       FROM ${ctx.db.namespace}.${ATTENDANCE_TABLE}
      WHERE company_id = $1
        AND observed_at >= $2
        AND wake_outcome IN (${undeliveredWakeOutcomeSqlList()})
      ORDER BY observed_at DESC
      LIMIT $3`,
    [companyId, since.toISOString(), limit],
  );

  return rows.map((row) => ({
    observedAt: iso(row.observed_at),
    alertIssueId: row.alert_issue_id,
    alertname: row.alertname,
    disposition: row.disposition,
    escalationAttempt: row.escalation_attempt ?? null,
    subjectAgentId: row.subject_agent_id ?? null,
    wakeOutcome: row.wake_outcome,
    wakeDetail: row.wake_detail ?? null,
    alertLiveness: row.alert_liveness,
  }));
}

/** `null` when this request is not for one of the attendance routes. */
export function isAttendanceRoute(routeKey: string): boolean {
  return routeKey === ATTENDANCE_SUMMARY_ROUTE || routeKey === ATTENDANCE_UNDELIVERED_ROUTE;
}

function inputError(message: string): PluginApiResponse {
  return { status: 400, body: { error: message } };
}

/**
 * Worker implementation of the two read routes.
 *
 * Company scope is enforced twice: the host resolves and authorizes
 * `companyId` from the query string before the worker sees the request
 * (`companyResolution` in the manifest), and this handler additionally refuses
 * any request whose requested company is not the one the host resolved. The
 * second check is redundant by design — it is the same defense-in-depth the
 * recovery routes apply, and it means a host-side regression cannot silently
 * turn this into a cross-tenant read.
 *
 * Unlike `recover`, nothing here is audited to the activity log: an activity
 * row per diagnostic poll is noise, and this route cannot change anything. A
 * debug line keeps the read attributable.
 */
export async function handleAttendanceApiRequest(
  ctx: PluginContext,
  input: PluginApiRequestInput,
): Promise<PluginApiResponse> {
  const requestedCompanyId = firstQueryValue(input.query.companyId);
  if (!requestedCompanyId || requestedCompanyId !== input.companyId) {
    return inputError("companyId must match the authorized company");
  }

  let since: Date;
  let windowHours: number;
  let limit = DEFAULT_UNDELIVERED_LIMIT;
  try {
    ({ since, windowHours } = resolveSince(input.query));
    if (input.routeKey === ATTENDANCE_UNDELIVERED_ROUTE) {
      limit = resolveLimit(input.query);
    }
  } catch (err) {
    if (err instanceof AttendanceQueryInputError) return inputError(err.message);
    throw err;
  }

  ctx.logger.debug(
    `alert-attendance: ${input.routeKey} read by ${input.actor.actorType} ${input.actor.actorId} for company ${input.companyId} since ${since.toISOString()}`,
  );

  try {
    if (input.routeKey === ATTENDANCE_SUMMARY_ROUTE) {
      return {
        headers: { "cache-control": "no-store" },
        body: await summariseAttendance(ctx, input.companyId, since, windowHours),
      };
    }
    return {
      headers: { "cache-control": "no-store" },
      body: {
        since: since.toISOString(),
        windowHours,
        limit,
        wakeOutcomes: UNDELIVERED_WAKE_OUTCOMES,
        observations: await listUndeliveredWakes(ctx, input.companyId, since, limit),
      },
    };
  } catch {
    // Fixed message: the same discipline as the recovery routes and as
    // `readAlertLiveness`. A raw database error carries resolved addresses and
    // response bytes, and this route is readable by an agent.
    throw new Error("Alertmanager attendance observation read failed");
  }
}

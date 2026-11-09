import { randomUUID } from "node:crypto";
import { PLUGIN_STATE_PRECONDITION_FAILED_CODE, type PluginContext } from "@paperclipai/plugin-sdk";
import { isNonHumanUserSentinel } from "@paperclipai/shared";
import {
  DEFAULT_COVER_CLOSE_HOLD_MINUTES,
  DEFAULT_COVER_DEDUP_WINDOW_MINUTES,
  DEFAULT_COVER_LIVENESS_RECHECK_LIMIT_MINUTES,
  DEFAULT_ESCALATION_DEADLINE_MINUTES,
  alertStateRef,
} from "./constants.js";
import { createSweepSourceStateReader, hasPrometheusEndpoint, type SourceStateReader } from "./prometheus-source-state.js";
import { UNDELIVERED_WAKE_OUTCOMES, type WakeOutcome, recordAttendanceObservation } from "./attendance-record.js";
import { resolveIssueRoute } from "./issue-route-resolver.js";
import { ORIGIN_KIND, type AlertmanagerAlert, type AlertmanagerPluginConfig, type AlertStateRecord } from "./types.js";

/** Origin kind stamped on board-owned "chain exhausted" cover issues. */
export const COVER_ORIGIN = "plugin:paperclip-plugin-alertmanager:escalation";
const MAX_ATTEMPTS = 3;
/**
 * PEN-6121 — how many extra sweeps a rung may spend trying to DELIVER its wake
 * before the ladder climbs past the agent it announced.
 *
 * Not a poll: a retry happens once per rung interval (the escalation deadline,
 * tens of minutes to hours), on the sweep that was going to run anyway, and
 * only while the alert is still firing and the row still unattended. Nothing
 * here can hit a busy agent repeatedly — the host dedups by
 * `alert-escalation:<issue>:<rung>` and the retry is one call per sweep.
 *
 * Bounded because the plugin cannot tell a recoverable cause from a permanent
 * one: the host folds `paused` (clears when a seat resumes) and `terminated`
 * (never clears) into one `agent.not_invokable` token and deliberately does not
 * forward the finer status to a worker process. Unbounded retries would pin the
 * whole ladder on a dead seat; two bounded ones cost a dead seat two rung
 * intervals and then climb exactly as before.
 */
const MAX_WAKE_DELIVERY_RETRIES = 2;

/**
 * What one `issues.requestWakeup` attempt actually did.
 *
 * `cause` is the host's own machine-readable token — `agent.not_invokable`,
 * `heartbeat.cooldown`, … — and is `null` when the host named none. It is the
 * triage field; see `wakeDetailFor` for the operator-readable sentence.
 */
interface WakeAttempt {
  outcome: WakeOutcome;
  cause: string | null;
}
const COVERS_TABLE = "alert_escalation_covers";
const MEMBERS_TABLE = "alert_escalation_cover_members";
const STUCK_COVER_RECONCILE_LIMIT = 200;
/**
 * Per-call cap on the Alertmanager liveness read (BLO-40739), covering the
 * whole exchange — headers AND body. The sweep runs every minute and walks due
 * issues sequentially, so a reachable-but-hanging Alertmanager must cost it
 * seconds, not the 30s the host's own fetch allows. Combined with
 * `createSweepLivenessReader`'s short-circuit, one hanging Alertmanager costs a
 * sweep at most one of these, however many issues are due.
 */
export const ALERTMANAGER_READ_TIMEOUT_MS = 5_000;

function q(ns: string, table: string): string {
  return `${ns}.${table}`;
}

export function escalationDeadlineMs(alert: AlertmanagerAlert, config: AlertmanagerPluginConfig): number | null {
  const severity = alert.labels.severity ?? "unknown";
  const minutes = resolveIssueRoute(alert, config.issueRouteMap).route?.escalationDeadlineMinutes
    ?? config.escalationDeadlineMinutes?.[severity]
    ?? DEFAULT_ESCALATION_DEADLINE_MINUTES[severity];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
}

/**
 * Interval between ladder rungs for an already-tracked alert. Prefers the
 * route/severity-resolved interval captured at firing time; state records
 * written before that field existed fall back to severity config.
 */
function rungIntervalMs(state: AlertStateRecord, config: AlertmanagerPluginConfig): number {
  if (typeof state.escalationIntervalMs === "number" && Number.isFinite(state.escalationIntervalMs) && state.escalationIntervalMs > 0) {
    return state.escalationIntervalMs;
  }
  const minutes = config.escalationDeadlineMinutes?.[state.severity]
    ?? DEFAULT_ESCALATION_DEADLINE_MINUTES[state.severity];
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 60 * 60_000;
}

/**
 * True when `issueId` has at least one blocker that is still live, meaning
 * neither `done` nor `cancelled` (BLO-40673). That is the edge
 * `issue_blockers_resolved_sweep` will eventually drain. A `cancelled`
 * blocker never drains, so it is deliberately not counted here: parking a row
 * `blocked` behind it would leave the row with no wake path at all.
 *
 * Fails toward `false`. A relations read that throws leaves the caller on its
 * pre-BLO-40673 behaviour (`todo`, ladder advances), which keeps the row
 * reachable. Failing toward `true` would let one RPC error park a firing alert.
 */
export async function hasLiveBlocker(ctx: PluginContext, issueId: string, companyId: string): Promise<boolean> {
  try {
    const { blockedBy } = await ctx.issues.relations.get(issueId, companyId);
    return blockedBy.some((b) => b.status !== "done" && b.status !== "cancelled");
  } catch (err) {
    ctx.logger.warn(`alertmanager: blocker read for issue ${issueId} failed; treating as unblocked: ${String(err)}`);
    return false;
  }
}

/**
 * True when `issue` carries a monitor wake still in the future (PEN-4337).
 *
 * Attendance in this platform is the UNION of two mechanisms — an unresolved
 * `blockedBy` edge and an armed monitor — and this ladder only consulted the
 * first. An alert row whose owner has deliberately scheduled their own return
 * was therefore indistinguishable from an abandoned one, so the ladder woke
 * them early, reassigned the row out from under the monitor they armed, and
 * finally minted a founder-assigned `[user-cover]` for work that was already
 * attended. Measured on PEN-4261: parked `blocked` with a monitor on its
 * blocker, it still drew rungs at 11:28Z / 15:29Z / 19:29Z and a cover at
 * 23:29Z on 2026-10-18.
 *
 * Accepts `Date` and `string` because BOTH shapes are real. The host hands
 * plugins the whole issue row, and the worker boundary is JSON-RPC over stdio
 * (`plugin-worker-manager.ts`), so a `Date` column arrives in production as an
 * ISO string while the in-process test harness supplies a real `Date`. A guard
 * written against `Date` alone would pass its tests and be inert in production
 * — the exact failure shape this one exists to remove.
 *
 * Fails toward `false`, matching `hasLiveBlocker`: an absent, null, or
 * unparseable stamp is NOT a wake, and reading one as attendance would hold a
 * firing alert forever.
 */
export function hasArmedMonitor(issue: { monitorNextCheckAt?: Date | string | null }, now: Date): boolean {
  const raw = issue.monitorNextCheckAt;
  if (raw === null || raw === undefined) return false;
  const at = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(at) && at > now.getTime();
}

function holdUntil(comments: Array<{ body: string }>): number | null {
  let latest: number | null = null;
  for (const { body } of comments) {
    const value = /do not retry before\s+([^\n]+)/i.exec(body)?.[1]?.trim();
    const parsed = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed) && (latest === null || parsed > latest)) latest = parsed;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// BLO-40739 — alert liveness
//
// Every user-visible message this ladder posts used to assert the alert was
// still firing. Nothing read alert state: the ladder fires on the ISSUE being
// non-terminal, and its only resolution signal is `state.resolvedAt`, written
// solely when Alertmanager DELIVERS a resolve webhook.
//
// That delivery is at-most-once. Alertmanager retries a failing webhook bounded
// by `group_interval` and then gives up, and a fully-resolved alert is never
// re-sent — so a webhook outage loses the resolution permanently and
// `resolvedAt: null` degrades from "still firing" to "we never heard", with
// nothing distinguishing the two at this call site.
//
// The two are not independent, which is what makes this worth pulling for:
// many of these alerts are ABOUT the Paperclip API and are delivered TO the
// Paperclip API, so the outage that fires the alert is the outage that eats its
// resolution. Measured on BLO-40579 (2026-10-05): the alert's last `ALERTS`
// sample was 23:08Z, Alertmanager logged ~339 failed webhook notifications
// between 22:50Z and 23:30Z, and this ladder then posted "Alert is still
// firing" at 23:42Z and reassigned a `critical` to the CTO at 00:12Z — on an
// alert that had been dead for an hour. The receiving run's correct response to
// "still firing" is to treat it as a live incident, so the false claim does not
// merely waste a run, it points the run at the wrong shape of problem.
//
// Hence: pull when we can, and when we cannot, say so rather than guess.
// ---------------------------------------------------------------------------

type AlertLiveness =
  | { state: "firing"; readAt: string; detail: string }
  | { state: "not-firing"; readAt: string }
  /** `unreachable`: the request itself failed (refused, timed out), not just this alertname's answer. */
  | { state: "unknown"; reason: string; unreachable?: true };

/** Reads liveness for one alertname; see `createSweepLivenessReader`. */
type LivenessReader = (alertname: string) => Promise<AlertLiveness>;

/**
 * Asks Alertmanager whether `alertname` currently has any instance.
 *
 * `active=true&silenced=true&inhibited=true` is deliberate: a SUPPRESSED alert
 * is firing and merely not paging (inhibited by a parent, or silenced).
 * Excluding those would read a live incident as resolved and hold a real
 * escalation — the expensive direction of this guard.
 *
 * Fails open to `unknown` on every error path. An unreachable Alertmanager must
 * never silence the escalation ladder; it only costs the liveness claim.
 *
 * Uses Node's global `fetch`, NOT `ctx.http.fetch`, on purpose. The host's
 * plugin fetch is an SSRF guard that refuses any target whose resolved
 * addresses are all private (`plugin-host-services.ts`, `isPrivateIP`), and
 * the Alertmanager this reads is a cluster-internal ClusterIP (10.x) with no
 * public address — through `ctx.http` every read failed, so the feature was
 * inert in production while mocked tests passed. The SDK permits direct
 * `fetch` (`PluginHttpClient` docs); the target is operator configuration, not
 * request input. Losing the host's 30s cap is why the timeout is our own, and
 * losing its `http:`/`https:` allowlist is why the scheme check is too.
 *
 * Every `reason` is a fixed sentence: it is written into issue comments, and
 * raw error text carries resolved addresses, ports, and response bytes. The
 * raw error goes to the plugin log instead.
 */
/**
 * The instance config wins; `PAPERCLIP_ALERTMANAGER_API_URL` (forwarded to the
 * worker by the host, BLO-42694) is only the deploy-time default, so a board
 * stopgap set in the UI is never overridden. Empty when neither is set.
 */
export function resolveAlertmanagerApiUrl(
  config: AlertmanagerPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = config.alertmanagerApiUrl?.trim() || env.PAPERCLIP_ALERTMANAGER_API_URL?.trim() || "";
  return raw.replace(/\/+$/, "");
}

async function readAlertLiveness(
  config: AlertmanagerPluginConfig,
  alertname: string,
  now: Date,
  logger: PluginContext["logger"],
): Promise<AlertLiveness> {
  const base = resolveAlertmanagerApiUrl(config);
  if (!base) return { state: "unknown", reason: "no alertmanagerApiUrl is configured for this instance" };
  // `fetch` takes any scheme. A `data:` URL answers with a body of the
  // configurer's choosing — `[]` would read every alert as clear and hold
  // every ladder — so only an actual HTTP request counts as a read.
  if (!["http:", "https:"].includes(URL.parse(base)?.protocol ?? "")) {
    return { state: "unknown", reason: "alertmanagerApiUrl is not an http:// or https:// URL, so it was not read" };
  }
  // Matcher values are double-quoted strings: escape `\` and `"` so a label
  // containing either still yields a well-formed matcher.
  const filter = encodeURIComponent(`alertname="${alertname.replace(/[\\"]/g, "\\$&")}"`);
  const url = `${base}/api/v2/alerts?active=true&silenced=true&inhibited=true&filter=${filter}`;
  const failed = (err: unknown) => {
    const cause = err instanceof Error && err.cause !== undefined ? ` (cause: ${String(err.cause)})` : "";
    logger.warn(`alert-escalation: Alertmanager liveness read for ${alertname} failed: ${String(err)}${cause}`);
  };
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ALERTMANAGER_READ_TIMEOUT_MS),
    });
    // The body is transport too, under the same signal: a server that sends
    // headers and then stalls fails HERE, and must short-circuit the pass
    // like one that never answered.
    text = res.ok ? await res.text() : "";
  } catch (err) {
    failed(err);
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      state: "unknown",
      reason: timedOut
        ? `the Alertmanager request did not complete within ${ALERTMANAGER_READ_TIMEOUT_MS / 1_000}s`
        : "the Alertmanager request failed; the error is in the plugin log",
      unreachable: true,
    };
  }
  if (!res.ok) return { state: "unknown", reason: `Alertmanager returned HTTP ${res.status}` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    failed(err);
    return { state: "unknown", reason: "Alertmanager returned a body that is not valid JSON" };
  }
  if (!Array.isArray(body)) return { state: "unknown", reason: "Alertmanager returned a non-array body" };
  // Re-apply the filter locally. The server-side `filter` is the belt; this
  // is the braces, and it guards the fail-open direction: an Alertmanager
  // that ignored or mis-parsed the filter returns the WHOLE alert set, which
  // would read as "firing" for every alertname on the cluster and silently
  // restore the behaviour this guard exists to remove.
  const matching = body.filter(
    (entry) => (entry as { labels?: Record<string, string> } | null)?.labels?.alertname === alertname,
  );
  const readAt = now.toISOString();
  if (matching.length === 0) return { state: "not-firing", readAt };
  const states = [
    ...new Set(matching.map((entry) => (entry as { status?: { state?: string } } | null)?.status?.state ?? "unknown")),
  ].sort();
  return { state: "firing", readAt, detail: `${matching.length} instance(s), state=${states.join("/")}` };
}

/**
 * One liveness reader per sweep pass. The sweep walks due issues sequentially,
 * so without this a hanging Alertmanager stalls it by one read timeout PER due
 * issue — during exactly the correlated outage this read exists for, when many
 * ladders come due together.
 *
 *  - Memoised by alertname: issues sharing an alert share one read, which is
 *    also one consistent answer across them for this pass.
 *  - Once a request fails at the transport level — connect, headers, or body
 *    read, including the timeout on any of them — the rest of the pass reuses
 *    that failure instead of re-trying. A non-2xx or bad body is
 *    alertname-specific and does not short-circuit other alertnames.
 */
function createSweepLivenessReader(
  config: AlertmanagerPluginConfig,
  now: Date,
  logger: PluginContext["logger"],
): LivenessReader {
  const reads = new Map<string, AlertLiveness>();
  let unreachable: AlertLiveness | null = null;
  return async (alertname) => {
    const cached = reads.get(alertname) ?? unreachable;
    if (cached) return cached;
    const read = await readAlertLiveness(config, alertname, now, logger);
    reads.set(alertname, read);
    if (read.state === "unknown" && read.unreachable) unreachable = read;
    return read;
  };
}

/**
 * The liveness sentence appended to every rung message.
 *
 * Narrowed to exclude `not-firing` on purpose: that outcome never reaches a
 * rung, because `advanceIssueLadder` holds the ladder instead of posting.
 */
function livenessLine(
  liveness: Extract<AlertLiveness, { state: "firing" | "unknown" }>,
  state: AlertStateRecord,
  now: Date,
): string {
  if (liveness.state === "firing") {
    return `Alert liveness: \`${state.alertname}\` read live from Alertmanager at ${liveness.readAt} — ${liveness.detail}.`;
  }
  const lastFired = Date.parse(state.lastFiredAt ?? "");
  const seen = Number.isFinite(lastFired)
    ? `last firing notification received ${state.lastFiredAt} (${Math.round((now.getTime() - lastFired) / 60_000)}m ago)`
    : "last firing notification time not recorded";
  return `⚠ Alert liveness NOT verified (${liveness.reason}). This rung fires on the ISSUE still being open, not on alert state. What was actually measured: no resolve notification has been received for \`${state.alertname}\`; ${seen}. A resolve notification that was never delivered is indistinguishable from a live alert here, so confirm against Alertmanager before treating this as a live incident.`;
}

/** Prefix of the hold notice, and the dedup key for it. */
const NOT_FIRING_MARKER = "[alert-escalation] Source alert is not firing";

/**
 * The alert is confirmed clear, so the ladder stops here: no comment claiming
 * an incident, and above all no reassignment up the `reportsTo` chain.
 *
 * Re-arms the SAME rung one interval out rather than setting
 * `escalationComplete`. Completing would be wrong in the one case that matters:
 * this path is reached precisely when the resolve was never delivered, so
 * `resolvedAt` is still null and a later re-fire arrives as an ordinary dedup
 * hit that does not rebuild the ladder — a completed ladder would then stay
 * dead for an alert that is firing again. Re-arming also keeps the
 * minute-cadence sweep from re-posting this notice sixty times an hour; the
 * marker dedup covers the window before the re-arm lands.
 *
 * Deliberately does NOT close, cancel, or reassign the issue. An alert row is
 * frequently the work ticket for the underlying fix and legitimately outlives
 * its alert; disposition is the assignee's call, not this sweep's.
 */
async function holdLadderForClearedAlert(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  issue: SweepIssue,
  companyId: string,
  ref: ReturnType<typeof alertStateRef>,
  state: AlertStateRecord,
  comments: Array<{ body: string }>,
  readAt: string,
  now: Date,
): Promise<void> {
  // The re-arm goes FIRST and the notice sits behind it, the same invariant as
  // the rung path: a webhook that re-fired the alert while this read was in
  // flight wins the record, and losing the swap must abort before the issue is
  // told the alert is clear. Posting first would leave that false notice
  // behind — and, since the marker dedups for the life of the issue, let it
  // suppress every correct hold notice after it.
  const held = await casAlertState(ctx, ref, state, {
    ...state,
    nextEscalationAt: new Date(now.getTime() + rungIntervalMs(state, config)).toISOString(),
  });
  if (!held) {
    ctx.logger.info(`alert-escalation: abandoned hold for ${issue.identifier ?? issue.id}; alert state changed under the sweep`);
    return;
  }
  if (!comments.some((comment) => comment.body.startsWith(NOT_FIRING_MARKER))) {
    await ctx.issues.createComment(
      issue.id,
      `${NOT_FIRING_MARKER} — escalation held.\n\n`
        + `Read from Alertmanager at ${readAt}: \`${state.alertname}\` has no active, silenced, or inhibited instance. `
        + `The ladder is paused instead of climbing the reportsTo chain, and nothing was reassigned.\n\n`
        + `This issue is still open, which may well be correct — an alert row is often the work ticket for the underlying fix and outlives the alert. Disposition is the assignee's call. The ladder resumes on its own if the alert fires again.`,
      companyId,
    );
  }
  // PEN-2918: the hold is a determination too, and it is the one most easily
  // mistaken for inaction — nothing is reassigned and, after the first, no
  // comment is posted either, because the marker dedups for the life of the
  // issue. Without this row a long hold is indistinguishable from a ladder
  // that stopped running.
  await recordAttendanceObservation(ctx, {
    companyId,
    alertIssueId: issue.id,
    alertname: state.alertname,
    disposition: "held_alert_clear",
    alertLiveness: "not_firing",
    wakeOutcome: "not_attempted",
    escalationAttempt: state.escalationAttempt ?? 0,
  });
}


/**
 * Bucketed dedup key for the board-cover storm-batching invariant (BLO-15982):
 * concurrent ladders for the same alertname that reach the cover rung within
 * the same window bucket share one cover. Deliberately NOT a rolling window
 * — a fixed bucket is expressible as a DB unique-key equality, which is what
 * makes the create-or-attach race safe under concurrent workers (see
 * `createCover`). The tradeoff is a possible split right at a bucket
 * boundary; acceptable against "at most one cover per storm."
 */
function coverDedupFingerprint(alertname: string, windowMinutes: number, now: Date): string {
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const bucket = Math.floor(now.getTime() / windowMs);
  return `cover:${alertname}:${bucket}`;
}

/** Matches the 409 the host throws when `issues_active_alert_escalation_cover_uq` rejects a create(). */
function isCoverDedupConflict(err: unknown): boolean {
  const message = err instanceof Error
    ? err.message
    : typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);
  return message.includes("Alert escalation cover conflict");
}

/**
 * Idempotently upserts `alertIssueId` as an OPEN member of `coverIssueId`.
 * A brand-new pairing inserts a fresh row; a pairing that previously
 * resolved (the alert re-fired into the same still-open cover) reopens it.
 * Backed by the `(cover_issue_id, alert_issue_id)` unique constraint, so
 * concurrent callers racing the same pairing serialize at the DB and only
 * one of them observes `rowCount > 0` (used to gate the one-time
 * "sibling attached" comment — a retried attach is a silent no-op).
 */
async function upsertOpenMember(ctx: PluginContext, coverIssueId: string, alertIssueId: string): Promise<boolean> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `INSERT INTO ${q(ns, MEMBERS_TABLE)} (id, cover_issue_id, alert_issue_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (cover_issue_id, alert_issue_id)
     DO UPDATE SET resolved_at = NULL, updated_at = now()
     WHERE ${q(ns, MEMBERS_TABLE)}.resolved_at IS NOT NULL`,
    [randomUUID(), coverIssueId, alertIssueId],
  );
  return result.rowCount > 0;
}

/**
 * Creates (or joins) the board-owned "chain exhausted" cover for `issue`.
 *
 * Race safety has two independent layers:
 *  1. `originFingerprint` carries the alertname+window dedup key, backed by
 *     a partial unique index on the host (`issues_active_alert_escalation_cover_uq`).
 *     Two concurrent same-alertname ladders both calling `ctx.issues.create()`
 *     cannot both win the *issue* — the DB constraint, not a read-then-create
 *     check here, is the source of truth. The loser catches the 409 and
 *     joins the winner's cover instead of creating a duplicate.
 *  2. Membership in that cover (winner's own alert, plus every losing
 *     sibling) is a durable, race-safe row in `alert_escalation_cover_members`
 *     (BLO-16120) — not a free-form comment — so resolving any one member
 *     never has to guess whether siblings are still firing.
 */
/**
 * `createdAt` as a sortable number.
 *
 * Typed `Date` by the SDK and delivered as an ISO string in production — the
 * worker boundary is JSON-RPC, the same split `hasArmedMonitor` documents. A
 * comparator written against `Date` alone sorts production's strings as `NaN`,
 * which leaves the array untouched and silently restores the ordering bug this
 * exists to fix. Unparseable stamps sort oldest, so they can never displace a
 * comment whose time is known from the carried set.
 */
function commentTime(comment: { createdAt?: Date | string | null }): number {
  const raw = comment.createdAt;
  if (raw === null || raw === undefined) return 0;
  const at = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(at) ? at : 0;
}

/**
 * Defuses agent mentions in text carried from another row.
 *
 * `[@Name](agent://<uuid>)` is this platform's wake primitive: there is one
 * mention syntax and it carries no courtesy register, so copying a
 * predecessor's comment verbatim into a new issue description would re-assert
 * every mention it contained — waking seats who were addressed about a cover
 * that has already closed, from a row none of them has anything to do with.
 * Reduced to the plain label, which is what a CITATION should have been in the
 * first place.
 *
 * Precautionary rather than a measured defect: whether descriptions are
 * mention-parsed on create is the host's business and may change. The cost of
 * being wrong in the other direction is spurious wakes, which is the whole
 * failure class PEN-2918 is about, so this does not wait for a measurement.
 */
function defuseAgentMentions(body: string): string {
  return body.replace(/\[([^\]]*)\]\(agent:\/\/[^)]*\)/g, "$1");
}

/** Upper bounds on the carried excerpt — see `previousCoverCarryOver`. */
const CARRY_OVER_MAX_COMMENTS = 3;
const CARRY_OVER_MAX_CHARS = 1_800;

/**
 * PEN-6236 defect B — what the predecessor cover was told, carried into its
 * successor.
 *
 * ## The defect
 *
 * A cover's body is a fixed two-sentence template plus a liveness line.
 * Nothing else ever reaches it. When the ladder restarts — a genuine
 * resolve-and-re-fire, a suppression window reopening, or defect A cancelling
 * the cover underneath a condition that never cleared — `escalationAttempt`
 * resets, the rung-3 branch runs again, and it mints a BRAND NEW cover from
 * that same template. Whatever the previous cover accumulated is left behind
 * on a closed row, and nothing wakes anyone to re-write it.
 *
 * Re-minting is the dominant pattern, not an edge case: measured 2026-11-09,
 * 14 covers against 7 distinct source alerts, so half of all covers ever
 * minted are re-mints of a source that already had one. PEN-5903 was furnished
 * by two seats with executable dispositions, was auto-closed, and its
 * successor PEN-6224 arrived carrying the bare template.
 *
 * ## What is carried, and why a pointer is not enough on its own
 *
 * Both: a link the assignee can follow, AND a bounded excerpt of the most
 * recent furnished comments. The excerpt is what makes the pointer worth
 * following — a bare "see PEN-5903" reads as boilerplate, and the whole
 * failure mode here is a board member opening a row that looks like it has
 * nothing in it.
 *
 * Plugin-authored comments are excluded by prefix: every one this module
 * writes starts `[alert-escalation]`, and carrying them forward would fill the
 * section with the machine's own sentences — which is precisely the content
 * that is NOT furnished.
 *
 * ## Fail-safe, in the direction that keeps the cover
 *
 * Every failure here is swallowed and degrades the section, never the cover.
 * A cover that exists without its history is the status quo; a cover that
 * failed to mint because a history lookup threw is a board escalation that
 * never happened. `createCover` is already the last rung of the ladder, so
 * there is nothing behind it to catch that.
 */
async function previousCoverCarryOver(
  ctx: PluginContext,
  companyId: string,
  alertname: string,
): Promise<string> {
  const ns = ctx.db.namespace;
  try {
    const rows = await ctx.db.query<{ cover_issue_id: string; close_verdict: string | null }>(
      `SELECT cover_issue_id, close_verdict
         FROM ${q(ns, COVERS_TABLE)}
        WHERE company_id = $1 AND alertname = $2 AND cancelled_at IS NOT NULL
        ORDER BY cancelled_at DESC
        LIMIT 1`,
      [companyId, alertname],
    );
    const previous = rows[0];
    if (!previous) return "";
    const priorIssue = await ctx.issues.get(previous.cover_issue_id, companyId);
    const label = priorIssue?.identifier ?? previous.cover_issue_id;
    const header = `\n\n---\n\n## Previous cover for \`${alertname}\`: ${label}\n\nThis is not the first cover opened for this source. ${label} covered it before and is now closed`
      + (previous.close_verdict ? ` (close verdict \`${previous.close_verdict}\`)` : "")
      + `. Anything decided there still applies unless it is superseded here — the ladder restarted, the ask did not.`;

    const comments = await ctx.issues.listComments(previous.cover_issue_id, companyId);
    // ⚠ SORT, DO NOT TRUST THE HOST'S ORDER. `ctx.issues.listComments` reaches
    // `issues.listComments(issueId)` with no options, and that function
    // DEFAULTS TO `order: "desc"` — so this array arrives NEWEST-FIRST. An
    // earlier draft took `.slice(-N)` of it, which is the N OLDEST, and
    // rendered the first remarks on the predecessor while dropping exactly the
    // later executable dispositions that defect B exists to carry. It passed
    // its test only because the mock seeded ascending order, which is the
    // shape production never sends.
    //
    // Sorting explicitly rather than reversing makes this independent of that
    // default: whichever way the host orders the page, the N carried here are
    // the N most recent, rendered oldest-first so the section reads forwards.
    const furnished = comments
      .filter((c) => !c.deletedAt && c.authorType !== "system" && !c.body.startsWith("[alert-escalation]"))
      .sort((a, b) => commentTime(a) - commentTime(b))
      .slice(-CARRY_OVER_MAX_COMMENTS);
    if (furnished.length === 0) {
      return `${header}\n\n${label} carried no furnished comment of its own, so there is nothing to quote here.`;
    }
    const quoted = furnished.map((c) => {
      // `createdAt` is typed `Date` but crosses the worker JSON-RPC boundary
      // as an ISO string in production, the same split `hasArmedMonitor`
      // documents. Rendering a `[object Object]` here would be cosmetic; being
      // wrong about which shape arrives is how a guard passes its tests and is
      // inert in production, so both are handled.
      const at = c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt ?? "");
      const safe = defuseAgentMentions(c.body);
      const body = safe.length > CARRY_OVER_MAX_CHARS
        ? `${safe.slice(0, CARRY_OVER_MAX_CHARS)}\n\n… truncated; the full comment is on ${label}.`
        : safe;
      return `**${at}**\n\n${body.split("\n").map((line) => `> ${line}`).join("\n")}`;
    }).join("\n\n");
    return `${header}\n\n### Carried from ${label} (${furnished.length} most recent furnished comment(s))\n\n${quoted}`;
  } catch (err) {
    ctx.logger.warn(`alert-escalation: could not carry over the previous cover for ${alertname}: ${String(err)}`);
    return "";
  }
}

async function createCover(
  ctx: PluginContext,
  issue: NonNullable<Awaited<ReturnType<PluginContext["issues"]["get"]>>>,
  companyId: string,
  state: AlertStateRecord,
  liveness: Extract<AlertLiveness, { state: "firing" | "unknown" }>,
  config: AlertmanagerPluginConfig,
  now: Date,
) {
  const ns = ctx.db.namespace;
  const alertname = state.alertname;

  // Already an open member of a still-open cover? Reopen (in case this is a
  // re-fire racing the sweep) and stop — idempotent guard against a partial
  // failure earlier in this same sweep tick retrying from the top. Excludes
  // covers that already won the closing claim (`closing_claimed_at IS NOT
  // NULL`): those are mid-`closeCoverIfEligible`/`finalizeCoverCancellation`
  // (or sitting in the stuck-reconcile window) and about to cancel — silently
  // reopening membership there would let the cover finalize anyway (it only
  // re-checks the claim timestamps, not membership) and orphan this re-fire
  // from any cover. Falling through instead routes it into `createCover`'s
  // normal create-or-join path, which opens/joins a fresh cover (BLO-16120
  // PR #662 review).
  if ((await reopenOpenCoverMembership(ctx, issue.id)) > 0) return;

  const windowMinutes = config.coverDedupWindowMinutes ?? DEFAULT_COVER_DEDUP_WINDOW_MINUTES;
  const fingerprint = coverDedupFingerprint(alertname, windowMinutes, now);
  // PEN-6236: read once, ahead of the create/join loop, so a retry of the
  // conflict branch does not pay for it twice and the two attempts cannot
  // disagree about what the predecessor said.
  const carryOver = await previousCoverCarryOver(ctx, companyId, alertname);
  const members = await ctx.access.members.list({ companyId });
  // `local-board` is a real `user` row with an owner membership, so a bare
  // role test picks it first and the cover — whose whole text is "Board
  // direction is required" — is addressed to a principal no person reads.
  // Measured on BLO-19560: 19 of 19 live covers, 100% undelivered. Skipping
  // the sentinel falls through to a genuine board member; when none exists
  // the `?? null` below is unchanged.
  const owner = members.find(
    (member) =>
      member.principalType === "user" &&
      member.status === "active" &&
      !isNonHumanUserSentinel(member.principalId) &&
      ["owner", "admin"].includes(member.membershipRole ?? ""),
  );

  // At most 2 attempts: the second only fires if the conflicting cover
  // vanished (or already fully resolved) between our failed create and the
  // follow-up lookup — in that narrow race the dedup slot is free again.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await ctx.issues.create({
        companyId,
        parentId: issue.id,
        projectId: issue.projectId ?? undefined,
        goalId: issue.goalId ?? undefined,
        title: `[user-cover] unresolved alert escalation: ${issue.identifier ?? issue.title}`,
        description: `Alert ${issue.identifier ?? issue.id} exhausted its agent chain while this issue remained open. Board direction is required.\n\n${livenessLine(liveness, state, now)}${carryOver}`,
        status: "todo",
        priority: issue.priority,
        assigneeUserId: owner?.principalId ?? null,
        originKind: COVER_ORIGIN,
        originId: issue.id,
        originFingerprint: fingerprint,
      });
      await ctx.db.execute(
        `INSERT INTO ${q(ns, COVERS_TABLE)} (cover_issue_id, company_id, dedup_fingerprint, alertname)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cover_issue_id) DO NOTHING`,
        [created.id, companyId, fingerprint, alertname],
      );
      await upsertOpenMember(ctx, created.id, issue.id);
      return;
    } catch (err) {
      if (!isCoverDedupConflict(err)) throw err;
      const [retained] = await ctx.issues.list({ companyId, originKind: COVER_ORIGIN, originFingerprint: fingerprint, limit: 1 });
      if (!retained || retained.status === "done" || retained.status === "cancelled") continue;
      // Defensive upsert: makes the covers-row bootstrap convergent from
      // whichever caller reaches it first, even if the winner's own insert
      // above hasn't landed yet (or failed) when this loser runs.
      await ctx.db.execute(
        `INSERT INTO ${q(ns, COVERS_TABLE)} (cover_issue_id, company_id, dedup_fingerprint, alertname)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cover_issue_id) DO NOTHING`,
        [retained.id, companyId, fingerprint, alertname],
      );
      const attached = await upsertOpenMember(ctx, retained.id, issue.id);
      if (attached) {
        await ctx.issues.createComment(
          retained.id,
          `[alert-escalation] Sibling alert ${issue.identifier ?? issue.id} ("${alertname}") also exhausted its agent chain within the dedup window; tracked here instead of opening a duplicate cover.`,
          companyId,
        );
      }
      return;
    }
  }
}

/**
 * Marks `alertIssueId` OPEN again in every still-open, unclaimed cover it
 * belongs to, returning how many memberships matched. Used by `createCover`
 * as its "already covered" guard, and by `handleFiring` on a re-fire
 * (BLO-42259): a flap that resolves and re-fires inside the close hold must
 * put the member back to unresolved, or the cover would close at hold expiry
 * while the alert is firing again.
 */
export async function reopenOpenCoverMembership(ctx: PluginContext, alertIssueId: string): Promise<number> {
  const ns = ctx.db.namespace;
  const result = await ctx.db.execute(
    `UPDATE ${q(ns, MEMBERS_TABLE)} AS m
     SET resolved_at = NULL, updated_at = now()
     FROM ${q(ns, COVERS_TABLE)} c
     WHERE m.cover_issue_id = c.cover_issue_id
       AND m.alert_issue_id = $1
       AND c.cancelled_at IS NULL
       AND c.closing_claimed_at IS NULL`,
    [alertIssueId],
  );
  return result.rowCount;
}

/**
 * Attempts to close `coverIssueId` once every represented source alert has
 * resolved and stayed resolved for `holdMinutes` (BLO-42259). The claim (who gets to run the resolution comment + terminal
 * transition) is a single atomic UPDATE of `closing_claimed_at`, guarded by
 * `NOT EXISTS (unresolved members)` — under concurrent callers (duplicate
 * resolve deliveries, two siblings resolving at once), Postgres row-level
 * locking on the covers row serializes the UPDATEs, so exactly one caller
 * observes `rowCount > 0`. Only that caller proceeds inline; every other
 * concurrent caller returns immediately rather than racing the winner
 * through `ctx.issues.update` — a second read-then-write "is it cancelled
 * yet" check there would reintroduce exactly the race this claim exists to
 * prevent. A winner that crashes before finishing relies on the sweep's
 * reconciliation pass (`reconcileStuckCovers`) to resume, not on another
 * concurrent resolve.
 *
 * `closing_claimed_at` is deliberately a separate column from
 * `resolution_comment_posted_at` (BLO-16120 PR #662 review): the claim must
 * be won before the comment is attempted (that's what makes it an exclusive
 * claim), but the comment isn't durably posted until `createComment`
 * resolves. Conflating the two into one flag set ahead of the fact it names
 * meant a `createComment` failure left the cover reading as "resolution
 * comment posted" when it never was, and nothing ever retried it.
 */
async function closeCoverIfEligible(
  ctx: PluginContext,
  companyId: string,
  coverIssueId: string,
  holdMinutes: number,
  guard: CoverCloseGuard | null,
): Promise<void> {
  const ns = ctx.db.namespace;
  const verdict = await decideCoverClose(ctx, coverIssueId, holdMinutes, guard);
  if (!verdict) return; // not eligible yet, or the guard is holding the close open
  const claim = await ctx.db.execute(
    `UPDATE ${q(ns, COVERS_TABLE)} AS c
     SET closing_claimed_at = now(), updated_at = now(),
         close_verdict = $3, close_verdict_detail = $4
     WHERE c.cover_issue_id = $1
       AND c.closing_claimed_at IS NULL
       AND c.cancelled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${q(ns, MEMBERS_TABLE)} m
         WHERE m.cover_issue_id = c.cover_issue_id
           AND (m.resolved_at IS NULL OR m.resolved_at > now() - make_interval(mins => $2::int))
       )`,
    [coverIssueId, holdMinutes, verdict.verdict, verdict.detail],
  );
  if (claim.rowCount === 0) return; // not yet eligible (open member, or still inside the hold), or another caller already claimed it
  await finalizeCoverCancellation(ctx, companyId, coverIssueId);
}

/**
 * PEN-6236 — the close decision, ahead of the claim.
 *
 * Returns the verdict to stamp, or `null` to leave the cover open.
 *
 * ## Why this read sits BEFORE the claim and not inside it
 *
 * The claim is a single atomic UPDATE and must stay that way — it is what
 * serialises concurrent closers. A network read cannot live inside it. So this
 * runs first, as a cheap indexed SELECT that also short-circuits the HTTP call
 * for the overwhelmingly common case of a cover that is not eligible anyway
 * (an unresolved member, or still inside the hold).
 *
 * That ordering has a benign race: between this read and the claim, a member
 * can re-open. The claim's own `NOT EXISTS` still sees it and refuses, so the
 * cover stays open — the race can only make the close MORE conservative, never
 * less. The verdict stamped is then simply never written, because the UPDATE
 * that would have written it matched no row.
 *
 * ## Polarity
 *
 * `pending` and `unknown` both defer, inside a window bounded by
 * `recheckLimitMinutes` measured from the newest member `resolved_at`. Past
 * that window the cover closes with a verdict naming which of the two it was.
 * A deferral is therefore strictly bounded and cannot become the unbounded
 * freeze that a longer hold would be — see
 * `DEFAULT_COVER_LIVENESS_RECHECK_LIMIT_MINUTES`.
 */
async function decideCoverClose(
  ctx: PluginContext,
  coverIssueId: string,
  holdMinutes: number,
  guard: CoverCloseGuard | null,
): Promise<{ verdict: CoverCloseVerdict; detail: string | null } | null> {
  const ns = ctx.db.namespace;
  // Short-circuit ahead of the SELECT, not after it: an instance with no
  // Prometheus configured must issue exactly the queries it issued before this
  // change, so "behaviour-neutral until configured" is a property of the call
  // graph rather than of the answers.
  if (!guard || !guard.configured) return { verdict: "liveness_check_unconfigured", detail: null };
  const [row] = await ctx.db.query<{ alertname: string | null; eligible: boolean; within_recheck: boolean }>(
    `SELECT c.alertname,
            NOT EXISTS (
              SELECT 1 FROM ${q(ns, MEMBERS_TABLE)} m
              WHERE m.cover_issue_id = c.cover_issue_id
                AND (m.resolved_at IS NULL OR m.resolved_at > now() - make_interval(mins => $2::int))
            ) AS eligible,
            EXISTS (
              SELECT 1 FROM ${q(ns, MEMBERS_TABLE)} m
              WHERE m.cover_issue_id = c.cover_issue_id
                AND m.resolved_at > now() - make_interval(mins => $3::int)
            ) AS within_recheck
       FROM ${q(ns, COVERS_TABLE)} c
      WHERE c.cover_issue_id = $1
        AND c.closing_claimed_at IS NULL
        AND c.cancelled_at IS NULL`,
    [coverIssueId, holdMinutes, holdMinutes + guard.recheckLimitMinutes],
  );
  if (!row || !row.eligible) return null;
  if (!row.alertname) return { verdict: "alertname_unknown", detail: null };

  const sourceState = await guard.readSourceState(row.alertname);
  if (sourceState.state === "cleared") {
    return { verdict: "source_cleared", detail: `Read at ${sourceState.readAt}.` };
  }
  if (row.within_recheck) {
    // Still inside the bounded window: hold the cover open and say so. This is
    // the whole of defect A — today the cover is cancelled here, underneath a
    // rule that is re-accumulating `for:` and cannot re-fire in time to reopen
    // membership. It also covers the inverse race: a rule that has ALREADY
    // re-fired in Prometheus but whose webhook has not landed, where
    // `reopenOpenCoverMembership` has not run and nothing else would stop the
    // close.
    await ctx.db.execute(
      `UPDATE ${q(ns, COVERS_TABLE)}
          SET close_deferral_count = close_deferral_count + 1,
              last_close_deferral_at = now(), updated_at = now()
        WHERE cover_issue_id = $1 AND closing_claimed_at IS NULL AND cancelled_at IS NULL`,
      [coverIssueId],
    );
    ctx.logger.info(
      sourceState.state === "live"
        ? `alert-escalation: holding cover ${coverIssueId} open; source alertname ${row.alertname} is still live in Prometheus (${sourceState.detail})`
        : `alert-escalation: holding cover ${coverIssueId} open; the Prometheus source-state check for ${row.alertname} was inconclusive (${sourceState.reason})`,
    );
    return null;
  }
  return sourceState.state === "live"
    ? { verdict: "source_live_recheck_expired", detail: `Last read at ${sourceState.readAt}: ${sourceState.detail}.` }
    : { verdict: "liveness_check_unavailable", detail: `Reason: ${sourceState.reason}.` };
}

/**
 * Completes the terminal transition for a cover that has already won the
 * closing claim (`closing_claimed_at` set). Called by the claim winner
 * inline, and by the sweep's `reconcileStuckCovers` pass when a prior winner
 * claimed but crashed (or failed) before finishing — never by a losing
 * concurrent caller, which avoids a second read-then-write "is it cancelled
 * yet" race here.
 *
 * Posts the resolution comment first if a prior attempt claimed but never
 * got it to land (`resolution_comment_posted_at` still null) — the flag is
 * only set once `createComment` actually resolves, so a `createComment`
 * failure here just leaves the claim intact for the next call to retry,
 * instead of silently finalizing with no audit trail.
 */
async function finalizeCoverCancellation(ctx: PluginContext, companyId: string, coverIssueId: string): Promise<void> {
  const ns = ctx.db.namespace;
  const [row] = await ctx.db.query<{ closing_claimed_at: string | null; resolution_comment_posted_at: string | null; cancelled_at: string | null; close_verdict: string | null; close_verdict_detail: string | null }>(
    `SELECT closing_claimed_at, resolution_comment_posted_at, cancelled_at, close_verdict, close_verdict_detail FROM ${q(ns, COVERS_TABLE)} WHERE cover_issue_id = $1`,
    [coverIssueId],
  );
  if (!row || !row.closing_claimed_at || row.cancelled_at) return;
  if (!row.resolution_comment_posted_at) {
    // PEN-6236: the verdict is carried in the comment as well as the column.
    // The column is what a census reads; the comment is what the board member
    // who was asked for direction actually opens, and until now it said the
    // same thing whether the condition had cleared or its alert state had just
    // been discarded underneath it.
    //
    // Read from the row rather than passed in, so the sweep's
    // `reconcileStuckCovers` resumption posts the verdict the ORIGINAL claim
    // decided rather than re-deriving one from a world that has since moved.
    // A row written before this migration has `close_verdict` NULL, which
    // renders as the legacy sentence alone — an honest absence, not a guess.
    const verdictLine = row.close_verdict
      ? `\n\n${closeVerdictLine(row.close_verdict as CoverCloseVerdict, row.close_verdict_detail)}`
      : "";
    await ctx.issues.createComment(
      coverIssueId,
      `[alert-escalation] All source alerts represented by this cover have resolved; closing.${verdictLine}`,
      companyId,
    );
    await ctx.db.execute(
      `UPDATE ${q(ns, COVERS_TABLE)} SET resolution_comment_posted_at = now(), updated_at = now() WHERE cover_issue_id = $1 AND resolution_comment_posted_at IS NULL`,
      [coverIssueId],
    );
  }
  const issue = await ctx.issues.get(coverIssueId, companyId);
  if (issue && issue.status !== "done" && issue.status !== "cancelled") {
    await ctx.issues.update(coverIssueId, { status: "cancelled" }, companyId);
  }
  await ctx.db.execute(
    `UPDATE ${q(ns, COVERS_TABLE)} SET cancelled_at = now(), updated_at = now() WHERE cover_issue_id = $1 AND cancelled_at IS NULL`,
    [coverIssueId],
  );
}

/**
 * BLO-16120 aggregate-aware cascade cleanup: marks `alertIssueId` resolved
 * within every cover it's a member of (idempotent — a retried resolve is a
 * no-op UPDATE), then attempts to close each of those covers. A cover only
 * actually closes once its LAST unresolved member resolves — resolving the
 * winning source before a sibling leaves the cover open. Membership lookup
 * is a single indexed query keyed on `alert_issue_id`, so it can't silently
 * stop short the way a paginated `ctx.issues.list(..., limit: 50)` scan can.
 */
export async function recordSourceResolvedAndCloseCovers(
  ctx: PluginContext,
  companyId: string,
  alertIssueId: string,
  holdMinutes = 0,
  // PEN-6236. Defaulted rather than required so the many call sites that only
  // mark membership resolved stay unchanged — but every PRODUCTION caller
  // passes one, and `null` is the explicit "no pending check is possible here"
  // value, which `decideCoverClose` records as a named verdict rather than
  // treating as a clear.
  guard: CoverCloseGuard | null = null,
): Promise<void> {
  const ns = ctx.db.namespace;
  const resolved = await ctx.db.execute(
    `UPDATE ${q(ns, MEMBERS_TABLE)}
     SET resolved_at = COALESCE(resolved_at, now()), updated_at = now()
     WHERE alert_issue_id = $1`,
    [alertIssueId],
  );
  if (resolved.rowCount === 0) return; // never joined a cover — nothing to cascade

  const coverRows = await ctx.db.query<{ cover_issue_id: string }>(
    `SELECT DISTINCT cover_issue_id FROM ${q(ns, MEMBERS_TABLE)} WHERE alert_issue_id = $1`,
    [alertIssueId],
  );
  for (const { cover_issue_id: coverIssueId } of coverRows) {
    await closeCoverIfEligible(ctx, companyId, coverIssueId, holdMinutes, guard);
  }
}

/**
 * Deferred close for the hold (BLO-42259): with a non-zero hold the resolve
 * cascade cannot close a cover itself, and no further webhook arrives once
 * every member has resolved — so the sweep is the trigger that closes a cover
 * whose members have all stayed resolved past the hold.
 */
async function closeHeldCovers(ctx: PluginContext, companyId: string, holdMinutes: number, guard: CoverCloseGuard): Promise<void> {
  const ns = ctx.db.namespace;
  const ready = await ctx.db.query<{ cover_issue_id: string }>(
    `SELECT c.cover_issue_id FROM ${q(ns, COVERS_TABLE)} c
     WHERE c.company_id = $1 AND c.closing_claimed_at IS NULL AND c.cancelled_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${q(ns, MEMBERS_TABLE)} m
         WHERE m.cover_issue_id = c.cover_issue_id AND m.resolved_at IS NULL
       )
     LIMIT ${STUCK_COVER_RECONCILE_LIMIT}`,
    [companyId],
  );
  for (const { cover_issue_id: coverIssueId } of ready) {
    try {
      await closeCoverIfEligible(ctx, companyId, coverIssueId, holdMinutes, guard);
    } catch (err) {
      ctx.logger.warn(`alert-escalation: failed to close held cover ${coverIssueId}: ${String(err)}`);
    }
  }
}

/**
 * Sweep backstop for the durable-retry requirement: a cover whose closing
 * claim succeeded but whose terminal transition never completed (a crash or
 * transient failure — including a failed `createComment`, BLO-16120 PR #662
 * review — anywhere between claiming and cancelling) has no further inbound
 * trigger — no more alerts will resolve into an already-fully-resolved
 * cover. The sweep already runs every minute (see manifest `jobs`), so it
 * doubles as the retry loop via the partial index on "claimed but not
 * cancelled". `finalizeCoverCancellation` itself re-checks whether the
 * comment landed, so this resumes correctly whether the prior attempt died
 * before or after posting it.
 */
async function reconcileStuckCovers(ctx: PluginContext, companyId: string): Promise<void> {
  const ns = ctx.db.namespace;
  const stuck = await ctx.db.query<{ cover_issue_id: string }>(
    `SELECT cover_issue_id FROM ${q(ns, COVERS_TABLE)}
     WHERE company_id = $1 AND closing_claimed_at IS NOT NULL AND cancelled_at IS NULL
     LIMIT ${STUCK_COVER_RECONCILE_LIMIT}`,
    [companyId],
  );
  for (const { cover_issue_id: coverIssueId } of stuck) {
    try {
      await finalizeCoverCancellation(ctx, companyId, coverIssueId);
    } catch (err) {
      ctx.logger.warn(`alert-escalation: failed to finalize stuck cover ${coverIssueId}: ${String(err)}`);
    }
  }
}

export async function runAlertEscalationSweep(ctx: PluginContext, config: AlertmanagerPluginConfig, now = new Date()): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId) return;
  const issues = await ctx.issues.list({ companyId, originKind: ORIGIN_KIND, limit: 200 });
  const readLiveness = createSweepLivenessReader(config, now, ctx.logger);
  // PEN-6236 — one guard per pass, memoised by alertname like the liveness
  // reader, so a correlated outage that brings many covers ready at once costs
  // at most one Prometheus timeout for the whole pass.
  const closeGuard = buildCoverCloseGuard(config, now, ctx.logger);
  for (const issue of issues) {
    try {
      await advanceIssueLadder(ctx, config, issue, companyId, now, readLiveness, closeGuard);
    } catch (err) {
      // One broken issue must not stall the sweep for the rest of the fleet
      // (live incident 2026-07-11: a throwing requestWakeup aborted the whole
      // sweep before the state write, repeating rung 1 every minute).
      ctx.logger.warn(`alert-escalation: skipping issue ${issue.identifier ?? issue.id}: ${String(err)}`);
    }
  }
  try {
    await reconcileStuckCovers(ctx, companyId);
  } catch (err) {
    ctx.logger.warn(`alert-escalation: cover reconciliation pass failed: ${String(err)}`);
  }
  try {
    await closeHeldCovers(ctx, companyId, coverCloseHoldMinutes(config), closeGuard);
  } catch (err) {
    ctx.logger.warn(`alert-escalation: held-cover close pass failed: ${String(err)}`);
  }
}

export function coverCloseHoldMinutes(config: AlertmanagerPluginConfig): number {
  return config.coverCloseHoldMinutes ?? DEFAULT_COVER_CLOSE_HOLD_MINUTES;
}

/**
 * PEN-6236 — everything the cover CLOSE path needs to decide whether the
 * source condition really cleared, built once per sweep pass or per webhook
 * delivery.
 *
 * `configured` is a separate field rather than something inferred from the
 * reader's answers, and that is load-bearing. An instance with no
 * `prometheusApiUrl` gets `unknown` from every read, and treating `unknown` as
 * "defer" would silently delay every close on such an instance by up to
 * `recheckLimitMinutes`. With the flag, an unconfigured instance closes
 * exactly when it does today and records the verdict
 * `liveness_check_unconfigured` — so this change is behaviour-neutral until an
 * operator points it at a Prometheus.
 */
export interface CoverCloseGuard {
  readSourceState: SourceStateReader;
  recheckLimitMinutes: number;
  configured: boolean;
}

export function buildCoverCloseGuard(
  config: AlertmanagerPluginConfig,
  now: Date,
  logger: PluginContext["logger"],
): CoverCloseGuard {
  return {
    readSourceState: createSweepSourceStateReader(config, now, logger),
    recheckLimitMinutes: config.coverLivenessRecheckLimitMinutes ?? DEFAULT_COVER_LIVENESS_RECHECK_LIMIT_MINUTES,
    configured: hasPrometheusEndpoint(config),
  };
}

/**
 * Why a cover closed. Written at the moment the closing claim is won, so a
 * closed cover's row answers a question the identical "all source alerts have
 * resolved" sentence never could: did the condition CLEAR, or was its alert
 * state DISCARDED while it still held?
 *
 * ⚠ Only `source_cleared` is positive evidence. The other four each name a
 * specific reason the check could not be made, and a census that counts them
 * as clears is making exactly the error this vocabulary exists to expose.
 */
export type CoverCloseVerdict =
  /** Prometheus was read and carried NO `ALERTS` series for the alertname at all. */
  | "source_cleared"
  /** No `prometheusApiUrl` on this instance; the check is not available at all. */
  | "liveness_check_unconfigured"
  /** Configured but unreadable past the recheck window; closed without the check. */
  | "liveness_check_unavailable"
  /** The source was still `pending` or `firing` past the recheck window; closed anyway, bounded. */
  | "source_live_recheck_expired"
  /** The cover carries no alertname (a pre-migration row whose fingerprint did not parse). */
  | "alertname_unknown";

/** The sentence the close comment carries, one per verdict. */
function closeVerdictLine(verdict: CoverCloseVerdict, detail: string | null): string {
  const suffix = detail ? ` ${detail}` : "";
  switch (verdict) {
    case "source_cleared":
      return `Close verdict: \`source_cleared\` — Prometheus carries no \`ALERTS\` series for this cover's source alertname in any state, so the rule is neither firing nor re-accumulating \`for:\`.${suffix}`;
    case "liveness_check_unconfigured":
      return `⚠ Close verdict: \`liveness_check_unconfigured\` — no \`prometheusApiUrl\` is configured, so nothing checked whether the source rule is still live. Alertmanager cannot answer that question (it has no \`pending\` state), so the absence of an active alert is NOT evidence the condition cleared.${suffix}`;
    case "liveness_check_unavailable":
      return `⚠ Close verdict: \`liveness_check_unavailable\` — the Prometheus source-state check could not be completed within the recheck window, and the cover was closed without it. The condition may still hold.${suffix}`;
    case "source_live_recheck_expired":
      return `⚠ Close verdict: \`source_live_recheck_expired\` — the source alertname still had a live \`ALERTS\` series in Prometheus when the recheck window expired, so this close is BOUNDED rather than evidenced: the condition may well still hold.${suffix}`;
    case "alertname_unknown":
      return `⚠ Close verdict: \`alertname_unknown\` — this cover predates the alertname column and its dedup fingerprint did not parse, so the pending check could not be addressed to anything.${suffix}`;
  }
}

type SweepIssue = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];

/**
 * True for the host's compare-and-swap rejection on `ctx.state.set`.
 *
 * Two shapes, both real in this repo: out-of-process the code arrives as
 * `data.code` on the RPC error (`plugin-worker-manager.ts` forwards only a
 * string `details.code` across that boundary), while a host error thrown
 * directly carries `details.code`. Matching the code — never the prose — is
 * what makes this a contract rather than a substring guess.
 */
function isStatePreconditionFailed(err: unknown): boolean {
  for (const key of ["data", "details"] as const) {
    const carrier = (err as Record<string, unknown> | null)?.[key];
    if (carrier && typeof carrier === "object"
      && (carrier as { code?: unknown }).code === PLUGIN_STATE_PRECONDITION_FAILED_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Compare-and-swap the alert's state record, returning whether the write
 * landed (BLO-20650).
 *
 * The sweep is a *speculative* writer. It read `previous` several awaits ago —
 * `listComments`, `agents.get`, and on the cover rung a whole issue creation —
 * and a webhook may have resolved or re-fired the alert in that window. A plain
 * `set()` of `{ ...previous, ... }` would write the stale fields back, and the
 * field that matters is `resolvedAt`: resurrecting it as `null` restarts a
 * ladder on an alert that has already cleared, which is a page for something
 * that is no longer happening, and every subsequent rung repeats the mistake
 * because nothing re-derives the resolution.
 *
 * `ifMatch` moves the check into the host's own UPDATE statement, so there is
 * no window between the comparison and the write for the webhook to land in.
 *
 * A refusal is a normal outcome, not an error: the authoritative writer (the
 * webhook) won, and the next sweep re-reads and re-decides against fresh state.
 * Callers must therefore treat `false` as "abandon this rung", never as "retry
 * now" — a retry loop here would race the same webhook again.
 */
async function casAlertState(
  ctx: PluginContext,
  ref: ReturnType<typeof alertStateRef>,
  previous: AlertStateRecord,
  next: AlertStateRecord,
): Promise<boolean> {
  try {
    await ctx.state.set(ref, next, { ifMatch: previous });
    return true;
  } catch (err) {
    if (!isStatePreconditionFailed(err)) throw err;
    return false;
  }
}

async function advanceIssueLadder(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  issue: SweepIssue,
  companyId: string,
  now: Date,
  readLiveness: LivenessReader,
  closeGuard: CoverCloseGuard,
): Promise<void> {
  if (["done", "cancelled"].includes(issue.status) || !issue.originId) return;
  const ref = alertStateRef(companyId, issue.originId);
  const state = await ctx.state.get(ref) as AlertStateRecord | null;
  if (!state || state.resolvedAt || state.escalationComplete || !state.nextEscalationAt || Date.parse(state.nextEscalationAt) > now.getTime()) return;
  const comments = await ctx.issues.listComments(issue.id, companyId);
  const hold = holdUntil(comments);
  if (hold && hold > now.getTime()) {
    // Refusal needs no branch: re-arming the schedule is idempotent and the
    // next sweep recomputes it from whatever the webhook wrote.
    await casAlertState(ctx, ref, state, { ...state, nextEscalationAt: new Date(hold).toISOString() });
    return;
  }

  // The row is ATTENDED, by either of the two mechanisms this platform uses.
  // Defer the rung by one interval; whichever mechanism clears puts the ladder
  // back on its normal schedule at the next sweep.
  //
  // BLO-40673 — an unresolved `blockedBy` edge: the row is waiting on that
  // blocker's owner, not on this row's. Waking it is refused by the host anyway
  // (`requestWakeup` rejects unresolved blockers), and the later rungs would
  // reassign it up the chain and mint a [user-cover] for work nobody can start.
  //
  // PEN-4337 — an armed monitor: the owner has already scheduled their own
  // return, so a rung here is a spurious wake, a reassign that orphans the
  // monitor its armer owns, and ultimately a founder-assigned cover for work
  // that was never abandoned. Deliberately checked FIRST: it reads a field the
  // sweep already has, so an attended row costs no `relations.get` round trip.
  //
  // Both are deferrals rather than permanent skips, which is what keeps a
  // genuinely abandoned row reachable: neither mechanism is a promise that the
  // work happens, only that a wake exists, so the ladder has to re-ask.
  //
  // The two are evaluated into named locals rather than inlined into the `||`
  // so the deferral can say WHICH mechanism held the rung. The short-circuit is
  // preserved deliberately: `hasLiveBlocker` is an RPC and is still not called
  // when the monitor is armed.
  //
  // PEN-4337 follow-up — this branch has to log. A deferral writes only
  // `nextEscalationAt` into plugin state, which has no read API, emits no
  // metric, and posts no comment; its sole external trace was the ABSENCE of a
  // cover row. That is indistinguishable from a ladder that was already spent,
  // so "the guard is working" could not be told apart from "the guard never
  // ran" on live traffic — the gap that left this fix unverifiable in
  // production after it shipped.
  const monitorArmed = hasArmedMonitor(issue, now);
  const blockerLive = monitorArmed ? false : await hasLiveBlocker(ctx, issue.id, companyId);
  if (monitorArmed || blockerLive) {
    const deferredTo = new Date(now.getTime() + rungIntervalMs(state, config)).toISOString();
    const deferred = await casAlertState(ctx, ref, state, { ...state, nextEscalationAt: deferredTo });
    if (!deferred) {
      ctx.logger.info(`alert-escalation: abandoned deferral for ${issue.identifier ?? issue.id}; alert state changed under the sweep`);
      return;
    }
    ctx.logger.info(
      `alert-escalation: deferred rung for ${issue.identifier ?? issue.id}; attended by ${monitorArmed ? "armed monitor" : "unresolved blocker"}; next attempt ${deferredTo}`,
    );
    // PEN-2918: this is the acknowledgement signal, and until now it existed
    // only as the log line above. It is recorded from an OBSERVATION OF
    // ATTENDANCE — an armed monitor or a live blocker — never from a wake
    // having been dispatched successfully. That direction is the whole point:
    // this row's founding measurement is ~4,900 perfect deliveries and zero
    // action, so an `acknowledged` derived from delivery would be the same
    // defect with a schema on it.
    //
    // `alertLiveness: "not_read"` is accurate rather than lazy: both branches
    // above short-circuit ahead of `readLiveness`, so the determination
    // genuinely was made without consulting Alertmanager.
    await recordAttendanceObservation(ctx, {
      companyId,
      alertIssueId: issue.id,
      alertname: state.alertname,
      disposition: monitorArmed ? "attended_monitor" : "attended_blocker",
      alertLiveness: "not_read",
      wakeOutcome: "not_attempted",
      escalationAttempt: state.escalationAttempt ?? 0,
      subjectAgentId: issue.assigneeAgentId ?? null,
    });
    return;
  }

  // BLO-40739: pull alert state before ANY rung side effect. The guard above
  // only knows what the webhook delivered; this is the one place that can tell
  // "still firing" apart from "the resolve never arrived".
  const liveness = await readLiveness(state.alertname);
  if (liveness.state === "not-firing") {
    await holdLadderForClearedAlert(ctx, config, issue, companyId, ref, state, comments, liveness.readAt, now);
    return;
  }

  const attempt = state.escalationAttempt ?? 0;
  const current = issue.assigneeAgentId ? await ctx.agents.get(issue.assigneeAgentId, companyId) : null;

  // PEN-6121 — is this sweep finishing a rung whose wake the host never
  // delivered, rather than starting a new one?
  //
  // The marker is compared against the issue's CURRENT assignee on purpose. If
  // an operator (or a later rung) moved the row, the agent we failed to wake is
  // no longer the owner, so re-waking them would be wrong and the marker
  // retires itself with no special case.
  const wakeRetries = state.escalationWakeRetries ?? 0;
  const pendingWakeAgentId = state.escalationWakePendingAgentId ?? null;
  const retryingWakeDelivery =
    pendingWakeAgentId !== null &&
    pendingWakeAgentId === (issue.assigneeAgentId ?? null) &&
    wakeRetries < MAX_WAKE_DELIVERY_RETRIES;
  // Retry sweeps spent at this rung once THIS attempt is counted. A fresh rung
  // resets to 0: the count belongs to the rung, not to the alert.
  const nextRetryCount = retryingWakeDelivery ? wakeRetries + 1 : 0;
  const retriesRemainAfterThisAttempt = nextRetryCount < MAX_WAKE_DELIVERY_RETRIES;

  // `retryingWakeDelivery` short-circuits the cover branch: the chain is not
  // exhausted while the rung it is standing on was never actually delivered.
  // Covering here would hand the board an escalation whose own last rung
  // reached nobody — the exact shape PEN-6121 measured on `02f0018c` and
  // `f57196cd`, each of which ran all three rungs undelivered.
  if (!retryingWakeDelivery && !(attempt === 0 && current) && !(current?.reportsTo && attempt < MAX_ATTEMPTS)) {
    // Chain exhausted (or no agent owner at all): board cover. Cover creation
    // stays ahead of the state write — it dedups via originKind/originId (and,
    // cross-issue, via originFingerprint), so a partial failure retries next
    // sweep instead of silently never covering.
    //
    // Claiming the state first would trade this rung's race for a strictly
    // worse one: `escalationComplete: true` with a failed `createCover` is
    // short-circuited by the `state.escalationComplete` guard at the top of
    // every later sweep, so the alert would never be covered at all — silence
    // where a board escalation belongs. So the CAS stays behind the cover, and
    // the case it cannot prevent is compensated below instead.
    await createCover(ctx, issue, companyId, state, liveness, config, now);
    const claimed = await casAlertState(ctx, ref, state, { ...state, escalationAttempt: MAX_ATTEMPTS, escalationComplete: true, nextEscalationAt: null });
    if (!claimed) {
      // A webhook won the record while the cover was being created. If it was a
      // resolve, its own cascade may have run before the cover existed and so
      // could not see it — which would leave an open board-assigned cover for
      // an alert that has already cleared. Re-running the cascade here against
      // the cover we just created is the compensating close.
      //
      // BLO-33497: this branch is reached only when the swap is REFUSED, which
      // is exactly the half `handleResolved` cannot see for itself. It pairs
      // with the second `recordSourceResolvedAndCloseCovers` there, behind its
      // commit point: a swap that SUCCEEDS means the webhook had not yet stored
      // `resolvedAt` when we claimed, so its post-commit cascade still lies
      // ahead of it and will find the cover we just created. Keep the two in
      // step — drop that call and this compensation stops being sufficient on
      // its own.
      //
      // Safe to run unconditionally on a resolved winner: the cascade is
      // idempotent (`COALESCE(resolved_at, now())` plus the single-UPDATE
      // closing claim), and it only cancels a cover whose every member has
      // resolved — so a storm-batched sibling that is still firing correctly
      // keeps the cover open. A re-fire rather than a resolve leaves it open
      // too, which is what a firing alert should have.
      const winner = await ctx.state.get(ref) as AlertStateRecord | null;
      if (winner?.resolvedAt) await recordSourceResolvedAndCloseCovers(ctx, companyId, issue.id, coverCloseHoldMinutes(config), closeGuard);
      ctx.logger.info(`alert-escalation: abandoned cover rung for ${issue.identifier ?? issue.id}; alert state changed under the sweep`);
      return;
    }
    await ctx.issues.createComment(issue.id, `[alert-escalation] Agent chain exhausted with this issue still open; created a [user-cover] escalation.\n\n${livenessLine(liveness, state, now)}`, companyId);
    await recordAttendanceObservation(ctx, {
      companyId,
      alertIssueId: issue.id,
      alertname: state.alertname,
      disposition: "unattended_cover",
      alertLiveness: liveness.state,
      // The cover rung raises no wake of its own: it mints a board-assigned
      // [user-cover] row, whose own assignment is the notification.
      wakeOutcome: "not_attempted",
      escalationAttempt: MAX_ATTEMPTS,
      subjectAgentId: issue.assigneeAgentId ?? null,
    });
    return;
  }

  // Persist the advanced rung BEFORE side effects: a failing comment or wake
  // then degrades to a missed notification on this rung, never a per-sweep
  // repeat of the same rung (comment storm). The reassign rung re-reads the
  // live assignee next time, so an interrupted rung self-heals upward.
  //
  // That ordering is also what makes the CAS worth having here: the rung's
  // user-visible effects (the escalation comment and the wake) all sit behind
  // this write, so losing the swap aborts the rung before anyone is paged
  // rather than after.
  const next = attempt + 1;
  // PEN-6121 — a retry re-claims the SAME rung. The counter must not advance,
  // or "retry the delivery" silently becomes "escalate", which is the behaviour
  // being fixed. `nextEscalationAt` still moves forward, so a retry costs one
  // rung interval and never spins.
  const claimedAttempt = retryingWakeDelivery ? attempt : next;
  const claimed: AlertStateRecord = {
    ...state,
    escalationAttempt: claimedAttempt,
    escalationComplete: false,
    nextEscalationAt: new Date(now.getTime() + rungIntervalMs(state, config)).toISOString(),
  };
  const advanced = await casAlertState(ctx, ref, state, claimed);
  if (!advanced) {
    // A webhook rewrote the record while this rung was being assembled. It is
    // the authoritative writer, so it wins; re-deciding happens next sweep
    // against fresh state. Logged at info because this is the guard working,
    // not a fault.
    ctx.logger.info(`alert-escalation: abandoned rung ${next} for ${issue.identifier ?? issue.id}; alert state changed under the sweep`);
    return;
  }

  // PEN-6121 — the wake is attempted BEFORE the comment that reports it, and
  // the comment states the outcome.
  //
  // PEN-2918 captured the outcome into `wake_outcome` and deliberately left
  // this ordering alone as "a separate decision with a separate blast radius".
  // The first read of that column is that decision's evidence: 23 of 29 rung
  // wakes never reached a run (79.3%), over 11 alert rows, every one with the
  // alert still firing — and the thread asserted every one of them. An agent
  // arriving at "[alert-escalation 1/3] waking current owner Cto" had no way
  // to learn that no run was ever enqueued.
  //
  // The comment-storm property the old ordering protected is preserved: the
  // comment still sits BEHIND the CAS above, so a sweep that loses the swap
  // posts nothing. What changes is only that the sentence is written after its
  // subject is known. The reassignment stays ahead of the wake because
  // `requestWakeup` wakes the issue's ASSIGNEE — the new owner has to be the
  // assignee before there is anyone to wake.
  let notified: string | null = null;
  let attemptedWake: WakeAttempt | null = null;
  if (retryingWakeDelivery) {
    // The rung was already announced and the owner already set; only the
    // DELIVERY failed. Re-attempt it without reassigning anyone and without a
    // second escalation comment — a repeat announcement would be the comment
    // storm the CAS ordering exists to prevent, and nothing has changed that a
    // reader needs told until the outcome does.
    notified = issue.assigneeAgentId ?? null;
    attemptedWake = await requestWakeupBestEffort(ctx, issue, companyId, attempt);
    if (attemptedWake.outcome === "enqueued") {
      await ctx.issues.createComment(issue.id, `[alert-escalation ${attempt}/${MAX_ATTEMPTS}] The wake for ${current?.name ?? "the current owner"} reached the queue on retry ${wakeRetries + 1}; the earlier attempt at this rung was not delivered.\n\n${livenessLine(liveness, state, now)}`, companyId);
    } else if (UNDELIVERED_WAKE_OUTCOMES.includes(attemptedWake.outcome) && !retriesRemainAfterThisAttempt) {
      // PEN-6229 — the LAST retry for this rung has just failed. Say so, once.
      //
      // Without this the thread read: "this rung is NOT spent: the next sweep
      // retries the delivery before the ladder escalates" → silence → "[2/3]
      // Escalation deadline reached again". The reader is never told the
      // retries happened and failed, so the escalation appears to contradict
      // the standing promise the rung-opening comment made. That is the same
      // defect class PEN-6121 fixed one step earlier — there a FALSE assertion
      // of delivery, here an UNRESOLVED forward-looking promise.
      //
      // ⛔ Bounded by the retry count, not by the sweep count: this is an
      // `else if` on an UNDELIVERED outcome, so a delivered wake adds nothing
      // (the `enqueued` arm above already reports that), and the
      // `retriesRemainAfterThisAttempt` guard fires only on the final attempt.
      // At `MAX_WAKE_DELIVERY_RETRIES = 2` a fully-failing rung therefore costs
      // exactly ONE extra comment — retry 1's failure stays silent because the
      // promise still holds while a retry remains. PEN-2918 measured volume as
      // a non-remedy, so the budget here is honesty, not frequency.
      //
      // Unreachable at `MAX_WAKE_DELIVERY_RETRIES = 0` (the kill switch): the
      // retry branch never runs, and `wakeSentence`'s own spent-budget arm
      // carries the same wording on the rung-opening comment instead. The two
      // never both fire.
      await ctx.issues.createComment(issue.id, `[alert-escalation ${attempt}/${MAX_ATTEMPTS}] ${retryBudgetSpentSentence(current?.name ?? "the current owner", attemptedWake, wakeRetries + 1)}\n\n${livenessLine(liveness, state, now)}`, companyId);
    }
  } else if (attempt === 0 && current) {
    notified = current.id ?? issue.assigneeAgentId ?? null;
    attemptedWake = await requestWakeupBestEffort(ctx, issue, companyId, next);
    await ctx.issues.createComment(issue.id, `[alert-escalation 1/${MAX_ATTEMPTS}] Escalation deadline reached with this issue still open; ${wakeSentence(current.name, attemptedWake, retriesRemainAfterThisAttempt)}\n\n${livenessLine(liveness, state, now)}`, companyId);
  } else if (current?.reportsTo) {
    const manager = await ctx.agents.get(current.reportsTo, companyId);
    notified = current.reportsTo;
    await ctx.issues.update(issue.id, { assigneeAgentId: current.reportsTo, assigneeUserId: null }, companyId);
    // Plugin-side issues.update does not fire core's assignment wake, so the
    // new owner is woken explicitly — otherwise the reassignment just sits in
    // their backlog until the next scheduled heartbeat.
    attemptedWake = await requestWakeupBestEffort(ctx, issue, companyId, next);
    await ctx.issues.createComment(issue.id, `[alert-escalation ${next}/${MAX_ATTEMPTS}] Escalation deadline reached again with this issue still open; reassigned from ${current.name} to ${manager?.name ?? current.reportsTo}. ${wakeSentence(manager?.name ?? current.reportsTo, attemptedWake, retriesRemainAfterThisAttempt)}\n\n${livenessLine(liveness, state, now)}`, companyId);
  }

  const wake: WakeOutcome = attemptedWake?.outcome ?? "not_attempted";
  await recordAttendanceObservation(ctx, {
    companyId,
    alertIssueId: issue.id,
    alertname: state.alertname,
    disposition: "unattended_rung",
    alertLiveness: liveness.state,
    wakeOutcome: wake,
    wakeDetail: wakeDetailFor(wake),
    wakeCause: attemptedWake?.cause ?? null,
    escalationAttempt: claimedAttempt,
    subjectAgentId: notified,
  });

  // PEN-6121 — persist (or retire) the undelivered-wake marker, so the next
  // sweep retries the DELIVERY rather than climbing past an agent who was
  // never woken.
  //
  // A second CAS rather than folding this into the claim above, because the
  // outcome is not known until the wake has been attempted and the claim has
  // to stay ahead of the side effects. Losing this swap is benign and is not
  // retried here: an authoritative webhook rewrote the record, so the next
  // sweep re-decides against ITS state, which is the same rule every other CAS
  // in this file follows.
  const markerNext: AlertStateRecord = UNDELIVERED_WAKE_OUTCOMES.includes(wake) && retriesRemainAfterThisAttempt
    ? { ...claimed, escalationWakePendingAgentId: notified, escalationWakeRetries: nextRetryCount }
    : { ...claimed, escalationWakePendingAgentId: null, escalationWakeRetries: 0 };
  // Skipped when nothing moves, which is the common case: a delivered wake on a
  // rung that carried no marker writes the same two fields it already had. That
  // keeps a healthy rung at exactly one state write, as before this change.
  const markerMoved =
    (markerNext.escalationWakePendingAgentId ?? null) !== (claimed.escalationWakePendingAgentId ?? null) ||
    (markerNext.escalationWakeRetries ?? 0) !== (claimed.escalationWakeRetries ?? 0);
  if (markerMoved && !await casAlertState(ctx, ref, claimed, markerNext)) {
    ctx.logger.info(`alert-escalation: wake-delivery marker for ${issue.identifier ?? issue.id} was not stored; alert state changed under the sweep`);
  }
}

/**
 * The half-sentence the escalation comment uses to report what the wake did.
 *
 * ⛔ Written so that the UNDELIVERED cases are the explicit ones. The defect
 * this replaces was not a missing sentence — it was a confident one ("waking
 * current owner X") that was wrong 79.3% of the time. A reader who skims must
 * come away knowing whether anyone was actually woken, so the failure wording
 * leads with the fact and never with the intent.
 *
 * `enqueued` is stated as "queued a run", not "woke": the host ACCEPTED the
 * request. It is not evidence that a run started and it is never
 * acknowledgement — the same distinction `wake_outcome` carries.
 *
 * ℹ️ `willRetry` is false only when retries are DISABLED
 * (`MAX_WAKE_DELIVERY_RETRIES = 0`), because a first attempt always has the
 * whole budget ahead of it and the retry branch does not call this function on
 * a failure. That arm is therefore the kill switch's wording, not dead code:
 * setting the bound to 0 restores the pre-PEN-6121 climb-immediately behaviour
 * while keeping the thread honest about what happened.
 *
 * ⚠️ PEN-6229 — so at the SHIPPED bound this function never tells a reader the
 * budget ran out, because it is not called again after the opening comment.
 * `retryBudgetSpentSentence` carries that for the exhausted case, word-for-word
 * identical in its closing clause. If you change either wording, change both:
 * they are two reachable paths to one statement, and a reader (or a grep)
 * should match one string.
 *
 * ⛔ The closing clause says the ladder MOVES ON, not that it will ESCALATE.
 * Escalating is only one of the things the next sweep can do, and which one is
 * a function of the CAUSE, which this sentence does not branch on: a
 * `issue.not_wakeable` rung is terminal and a `issue.no_assignee` one has
 * nobody to climb to, so for those the next sweep covers the alert or stops.
 * Promising a climb would be a forward-looking assertion the ladder may not
 * keep — the same defect class PEN-6121 exists to remove, one tense later, so
 * the sentence states what is true for every cause instead. (Raised by Ally on
 * #3589; the wording was inherited from the kill-switch arm above.)
 */
function wakeSentence(name: string, wake: WakeAttempt, willRetry: boolean): string {
  const retryClause = willRetry
    ? " This rung is NOT spent: the next sweep retries the delivery before the ladder escalates."
    : " The retry budget for this rung is spent; the ladder moves on at the next sweep.";
  const cause = wake.cause ? ` (${wake.cause})` : "";
  switch (wake.outcome) {
    case "enqueued":
      return `queued a run for current owner ${name}.`;
    case "refused":
      return `**no run was queued for ${name}** — the host refused the wake${cause}.${retryClause}`;
    case "declined":
      return `**no run was queued for ${name}** — the host accepted the request and enqueued nothing${cause}.${retryClause}`;
    default:
      return `no wake was attempted for ${name}.`;
  }
}

/**
 * PEN-6229 — the sentence posted when the LAST retry for a rung has failed.
 *
 * It exists to retract a promise. `wakeSentence` told the reader "This rung is
 * NOT spent: the next sweep retries the delivery before the ladder escalates",
 * and that sentence is true when written and silently stops being true once the
 * budget runs out. Nothing else in the thread ever says so — the ladder simply
 * escalates, and a reader comparing the two comments sees a contradiction
 * rather than a sequence.
 *
 * ⛔ Leads with the OUTCOME, not with the retry bookkeeping, for the same
 * reason `wakeSentence` does: the one fact a skimming reader must come away
 * with is that nobody was woken. The retry count is context for why the ladder
 * is about to move, not the headline.
 *
 * The closing clause is deliberately WORD-FOR-WORD `wakeSentence`'s
 * `willRetry === false` arm. One rung-is-spent wording, reachable two ways —
 * here on an exhausted budget, there on the `MAX_WAKE_DELIVERY_RETRIES = 0`
 * kill switch — so a reader (or a grep) matches one string, not two.
 */
function retryBudgetSpentSentence(name: string, wake: WakeAttempt, retryNumber: number): string {
  const cause = wake.cause ? ` (${wake.cause})` : "";
  const how = wake.outcome === "refused"
    ? `the host refused the wake${cause}`
    : `the host accepted the request and enqueued nothing${cause}`;
  return `**No run was queued for ${name}** — ${how}. Retry ${retryNumber} of ${MAX_WAKE_DELIVERY_RETRIES} failed. The retry budget for this rung is spent; the ladder moves on at the next sweep.`;
}

/**
 * The operator-readable sentence for a wake outcome. Fixed strings only — never
 * raw error text (same discipline as the `wake_detail` column comment).
 *
 * `refused` and `declined` get DIFFERENT sentences because they are different
 * events with different remedies: a refusal is about this issue (terminal
 * status, blocker, budget), a decline is about the agent or the company
 * (heartbeats disabled, cooldown, suppression, capacity). One sentence saying
 * "threw" would have been false for every decline.
 *
 * ⛔ PEN-6121 — BOTH sentences used to end "The escalation comment posted
 * immediately before this asserts the wake regardless", which was true and is
 * now false: the comment is written after the wake and states its outcome. They
 * also used to route a reader to the plugin log for the cause, which never
 * contained it — the ladder stringified the error and dropped the `details`
 * carrying the discriminator. The cause now has its own column; these sentences
 * point at it rather than restating a disjunction.
 */
function wakeDetailFor(wake: WakeOutcome): string | null {
  switch (wake) {
    case "refused":
      return "issues.requestWakeup threw: the host refused the wake. Read wake_cause for which gate -- pre-wake in the plugin host (issue.no_assignee, issue.not_wakeable, issue.blocked, budget.blocked, company.inactive) or downstream in enqueueWakeup (budget.blocked, company.inactive, agent.not_invokable). That set GROWS; it is documentation, not a closed list. A null cause means the host named none. The escalation comment for this rung reports this outcome and does not assert a wake.";
    case "declined":
      return "issues.requestWakeup resolved queued=false: the host accepted the call and enqueued no run. Read wake_cause for which gate (heartbeats disabled, cooldown, inactive company, scheduling suppressed, worktree cutoff, or a capacity deferral); a null cause means the host named none. The escalation comment for this rung reports this outcome and does not assert a wake.";
    default:
      return null;
  }
}

/**
 * Returns the outcome rather than discarding it (PEN-2918). The swallow itself
 * is unchanged and deliberate — a dropped wake must not repeat the rung — but
 * the caller now records which outcome occurred, so "the wake never happened"
 * stops being visible only as a log line next to a comment claiming it
 * succeeded.
 *
 * ⛔ **The resolved value is READ, not merely awaited, and that is the point of
 * this function.** The host drops a wake in two different ways and only one of
 * them throws:
 *
 *  - it **rejects** ⇒ `refused`. Seven gates throw: four pre-wake in the
 *    plugin host — no assignee, a terminal status, an unresolved blocker, an
 *    invocation budget block (PEN-6229 codes all four) — and three downstream
 *    in `enqueueWakeup`: `budget.blocked`, `company.inactive`,
 *    `agent.not_invokable`;
 *  - it **resolves `{ queued: false }`** when `enqueueWakeup` returns `null` —
 *    `heartbeat.wakeOnDemand.disabled`, the heartbeat cooldown,
 *    `company.inactive`, `heartbeat.scheduling_suppressed`,
 *    `worktree_execution_cutoff`, and the provider-capacity deferral ⇒
 *    `declined`.
 *
 * Awaiting without reading files that second, larger and quieter population
 * under `enqueued`, i.e. under "the host accepted the wake" — which would put
 * this row's own founding defect inside the table built to measure it, in the
 * direction that reads clean. `undelivered_idx` covers both tokens for the
 * same reason.
 *
 * `enqueued` means the host accepted the request. It is not evidence that a run
 * started, and it is not acknowledgement.
 */
async function requestWakeupBestEffort(ctx: PluginContext, issue: SweepIssue, companyId: string, rung: number): Promise<WakeAttempt> {
  try {
    const result = await ctx.issues.requestWakeup(issue.id, companyId, { reason: "alert_escalation_deadline", contextSource: "alertmanager-escalation", idempotencyKey: `alert-escalation:${issue.id}:${rung}` });
    // Tested against `=== false` rather than falsiness on purpose: a host (or
    // a fake) that resolves without the field is making no claim either way,
    // and must not be reported as a drop.
    if ((result as { queued?: boolean } | null | undefined)?.queued === false) {
      const cause = readWakeCause((result as { undeliveredReason?: unknown } | null | undefined)?.undeliveredReason);
      ctx.logger.warn(`alert-escalation: wakeup for ${issue.identifier ?? issue.id} rung ${rung} was declined by the host (queued=false, cause=${cause ?? "unrecorded"})`);
      return { outcome: "declined", cause };
    }
    return { outcome: "enqueued", cause: null };
  } catch (err) {
    // PEN-6121 — the cause is lifted off the error BEFORE it is stringified.
    // `String(err)` keeps the message and discards `details`, and the host puts
    // its machine-readable token in `details.code` (forwarded to a worker as
    // `PluginRpcError.data.code`). That discard is why 15 refusals were
    // recorded over four days with `wake_detail` saying "the error is in the
    // plugin log" and the log not containing the discriminator.
    const cause = readWakeCause((err as { data?: { code?: unknown } } | null)?.data?.code);
    ctx.logger.warn(`alert-escalation: wakeup for ${issue.identifier ?? issue.id} rung ${rung} failed (cause=${cause ?? "unrecorded"}): ${String(err)}`);
    return { outcome: "refused", cause };
  }
}

/**
 * Accepts the host's cause token only when it is a non-empty string.
 *
 * A host predating PEN-6121 omits the field, and `undefined` must record as
 * `null` ("not recorded") rather than as the string "undefined" — this column
 * is the triage key, and a literal "undefined" bucket would read as a cause.
 */
function readWakeCause(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

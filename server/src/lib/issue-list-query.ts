// BLO-24495: `GET /companies/:companyId/issues` only ever implemented
// limit/offset pagination. `page`/`perPage` were silently dropped (never read
// from req.query), so every page number replayed the same limit/offset-default
// window with no error — a confident, wrong result set. Detect their presence
// so the route can reject explicitly instead.
//
// This lives in lib/ rather than services/issues.ts on purpose: the route calls
// it on every issue-list request, and services/issues.ts is wholesale-mocked by
// nine route test suites (`vi.doMock("../services/issues.js", () => ({ issueService }))`).
// A route-hot-path import from there resolves to undefined under those mocks and
// turns every list request into a 500. lib/ is mocked by nobody.
//
// BLO-40714: `per_page` is the third spelling and was the one that fell
// through. It is what GitHub's own API uses, so it is the plausible first
// reach for a hand-written request — and a caller who reaches for it gets the
// pre-BLO-24495 behaviour back: a 200 over window 0 with no error. Matching
// all three is what makes "rejected" a property of the CONCEPT rather than of
// a spelling. Note `limit` is deliberately absent and must stay absent:
// `GET /companies/:id/issues` genuinely implements it, so a surface that does
// not (`/agents/me/inbox-lite`) rejects it with its own endpoint-local check.
export function parseUnsupportedPaginationParams(query: {
  page?: unknown;
  perPage?: unknown;
  per_page?: unknown;
}): string[] {
  return [
    ...(query.page !== undefined ? ["page"] : []),
    ...(query.perPage !== undefined ? ["perPage"] : []),
    ...(query.per_page !== undefined ? ["per_page"] : []),
  ];
}

// BLO-40145: the same endpoint implements NO time-bound filter at all, and
// Express hands unknown query params through unread. So `?updated_after=T` is
// discarded exactly like a fabricated param name — measured: `updated_after`
// set to the year 2099 returns byte-identical rows to no filter and to
// `?zzz_not_a_filter=1`.
//
// That is worse than the BLO-24495 page/perPage case it mirrors, because the
// default sort is priority-band then recency: the head of the `critical` band
// is churning alert rows updated seconds ago, so a spot check with a recent
// floor and a small `limit` PASSES on rows that were never filtered. The
// filter looks honoured until a second filter moves the window off that
// recency-hot prefix, which reads as "the time bound composes badly" rather
// than "there is no time bound". A census written as "rows in class C since
// the fix" silently becomes "the first N rows of the corpus", and since the
// fix is recent almost nothing in that prefix post-dates it — so the read
// returns a small number, or zero, and that reads as the fix holding.
//
// Matched by SHAPE rather than an enumerated denylist: a caller reaching for a
// time bound invents `updated_after`, `updatedSince`, `createdBefore` and so
// on, and listing them one at a time only ever catches the alias someone
// already tripped over. No supported param on this route has this shape, so
// the rule cannot swallow a real filter. An allowlist over every param would
// be the fuller fix and is deliberately not taken here: this is a hot read
// path shared with the board UI, and one missing entry turns a wrong-census
// bug into a 400 on every list request.
const TIME_FILTER_PARAM_PATTERN =
  /^(updated|created|started|completed|resolved|closed|modified)_?(after|before|since|until|within|from|to)$/i;

export function parseUnsupportedTimeFilterParams(query: Record<string, unknown>): string[] {
  return Object.keys(query)
    .filter((key) => TIME_FILTER_PARAM_PATTERN.test(key))
    .sort();
}

/**
 * Parse an `offset` query param for a paged issue-list surface.
 *
 * Returns the offset, or `null` when the caller supplied something that is not
 * a non-negative integer — callers reject that with a 400 rather than silently
 * replaying window 0, which is the BLO-24495 failure one param over.
 *
 * `^\d+$` guarantees sign but NOT a usable number: it passes a digit string
 * of any length, and `Number.parseInt` of one past `Number.MAX_VALUE` (e.g.
 * 309 nines) is `Infinity`. The services gate `offset` on `Number.isFinite`
 * and fall back to 0, so without the `Number.isSafeInteger` check below that
 * input is a 200 serving window 0. The same check rejects digit strings past
 * `Number.MAX_SAFE_INTEGER`, which cannot be represented exactly, and covers
 * the `Number.isInteger`/`< 0` arm the two route copies this replaces carried.
 *
 * Lives here, not in services/issues.ts, for the same reason as
 * {@link parseUnsupportedPaginationParams} — that module is wholesale-mocked by
 * the route suites and a hot-path import from it resolves to undefined there.
 */
export function parseOffsetParam(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const offset = Number.parseInt(raw, 10);
  return Number.isSafeInteger(offset) ? offset : null;
}

// BLO-33741: the same endpoint clamps an oversized `limit` to
// ISSUE_LIST_MAX_LIMIT and returns a bare JSON array — no total, no cursor. A
// caller that asks for 3000 and gets 1000 cannot tell "that is all of them"
// from "there are more", and the failure is silent in the reassuring
// direction: a sweep reports the cap as if it were the population.
//
// Fixed with an over-fetch probe rather than a COUNT(*): ask the database for
// one row beyond the page, and if it comes back the page is a truncated
// prefix. One extra row costs nothing next to a second aggregate query over
// the same predicate.
//
// Header names, not a body envelope, because the response body is a bare array
// with no place to hang a flag — wrapping it would break every existing
// consumer, and the ETag on the compact view is computed over that body.
export const ISSUE_LIST_APPLIED_LIMIT_HEADER = "X-Applied-Limit";
export const ISSUE_LIST_TRUNCATED_HEADER = "X-Result-Truncated";

/**
 * Row count to request from the service so truncation is detectable.
 *
 * Paired with {@link resolveIssueListTruncation}: this asks for the extra row,
 * that one consumes it. Keep them together — a probe that does not over-fetch
 * makes `truncated` permanently false, which is exactly the silent-wrong-answer
 * this exists to kill.
 */
export function issueListProbeLimit(limit: number): number {
  return limit + 1;
}

/**
 * Split an over-fetched result into the page the caller asked for and whether
 * the database has more matching rows beyond it.
 *
 * Runs on the RAW probed window (see {@link issueListProbeLimit}). `rows` is
 * the raw page — the same `offset`/`limit` window a caller pages by — and
 * `truncated` says a matching row exists past it. For an actor who may read
 * every row that is the whole answer. For a restricted actor it is NOT: the
 * page still has to be ACL-filtered, and "a row exists beyond" has to become
 * "a row THIS ACTOR MAY READ exists beyond", which the route settles by
 * scanning forward (`actorHasReadableIssueFrom` in routes/issues.ts). Deriving
 * the restricted signal from the filtered page length instead is wrong in both
 * directions: filtering can only shorten the page, so a full raw window with
 * sparse readable rows reads as "complete" while readable rows sit past it,
 * and counting unreadable probe rows leaks their existence.
 */
export function resolveIssueListTruncation<T>(
  rows: T[],
  limit: number,
): { rows: T[]; truncated: boolean } {
  return rows.length > limit
    ? { rows: rows.slice(0, limit), truncated: true }
    : { rows, truncated: false };
}

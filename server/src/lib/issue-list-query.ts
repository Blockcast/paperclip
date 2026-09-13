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
export function parseUnsupportedPaginationParams(query: {
  page?: unknown;
  perPage?: unknown;
}): string[] {
  return [
    ...(query.page !== undefined ? ["page"] : []),
    ...(query.perPage !== undefined ? ["perPage"] : []),
  ];
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
 * more rows exist beyond it.
 *
 * MUST run on the raw service rows, BEFORE any per-actor ACL filtering:
 * filtering drops rows, so a filtered page shorter than `limit` says nothing
 * about whether the underlying query was truncated. Slicing here also keeps the
 * emitted body byte-identical to the pre-BLO-33741 response.
 */
export function resolveIssueListTruncation<T>(
  rows: T[],
  limit: number,
): { rows: T[]; truncated: boolean } {
  return rows.length > limit
    ? { rows: rows.slice(0, limit), truncated: true }
    : { rows, truncated: false };
}

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

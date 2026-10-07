import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseUnsupportedTimeFilterParams } from "../lib/issue-list-query.ts";

/**
 * Regression test for BLO-40145.
 *
 * `GET /companies/:companyId/issues` implements no time-bound filter, and
 * Express passes unknown query params through unread — so `?updated_after=T`
 * was discarded exactly like a fabricated param name. Measured before the fix:
 * `updated_after=2099-01-01` returned byte-identical rows to no filter at all
 * and to `?zzz_not_a_filter=1`.
 *
 * It was originally reported as "the time bound is dropped when combined with
 * `q` or `originKind`", because the default sort is priority-band then
 * recency: the head of the `critical` band is churning alert rows updated
 * seconds ago, so a spot check with a recent floor and a small `limit` passes
 * on rows that were never filtered. Adding a second filter moves the window
 * off that recency-hot prefix and exposes the missing bound — which reads as a
 * composition bug rather than an absent feature. The `boundRejectionIsNotAboutComposition`
 * cases below pin that down: the param is rejected alone, so no caller can
 * re-derive the composition theory.
 *
 * Mirrors the reject-with-400 branch in `server/src/routes/issues.ts`,
 * importing the same `parseUnsupportedTimeFilterParams` helper the route calls
 * so the test regresses if that contract changes — not a copy of it.
 */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/companies/:companyId/issues", (req, res) => {
    const unsupportedTimeFilterParams = parseUnsupportedTimeFilterParams(req.query);
    if (unsupportedTimeFilterParams.length > 0) {
      res.status(400).json({ unsupportedParams: unsupportedTimeFilterParams });
      return;
    }
    res.status(200).json({ ok: true });
  });
  return app;
}

const get = (url: string) => request(buildApp()).get(url);

describe("issue list time-filter rejection", () => {
  it("rejects the reported ?updated_after=T and names it", async () => {
    const res = await get("/api/companies/c1/issues?updated_after=2026-10-04T13:31:15Z&limit=3");
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["updated_after"]);
  });

  // The originally-filed reproducer: rejected whether or not a narrowing
  // filter is present, so the composition theory cannot survive the fix.
  it.each([
    ["alone", "?updated_after=2026-10-04T13:31:15Z"],
    ["with q", "?updated_after=2026-10-04T13:31:15Z&q=Cilium"],
    ["with originKind", "?updated_after=2026-10-04T13:31:15Z&originKind=plugin:paperclip-plugin-alertmanager"],
    ["with both", "?updated_after=2026-10-04T13:31:15Z&q=Cilium&originKind=manual"],
  ])("boundRejectionIsNotAboutComposition: rejects %s", async (_label, qs) => {
    const res = await get(`/api/companies/c1/issues${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["updated_after"]);
  });

  // Shape-matched, not an enumerated denylist: listing aliases one at a time
  // only ever catches the one someone already tripped over.
  it.each([
    "updatedAfter",
    "updated_before",
    "updatedSince",
    "updated_within",
    "createdAfter",
    "created_before",
    "completedSince",
    "closedUntil",
    "modified_from",
  ])("rejects the %s alias", async (param) => {
    const res = await get(`/api/companies/c1/issues?${param}=2026-10-04T00:00:00Z`);
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual([param]);
  });

  it("names every offending param when several are passed", async () => {
    const res = await get("/api/companies/c1/issues?updatedAfter=A&created_before=B");
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["created_before", "updatedAfter"]);
  });

  // Non-vacuity: a suite that only asserts 400s passes just as well on a
  // helper that rejects everything, which would 400 the board UI's own reads.
  // These are the real params this route serves.
  it.each([
    "status=blocked",
    "q=Cilium",
    "originKind=manual",
    "assigneeAgentId=d6f327a4-f2f2-4a83-bc5a-173d993cf9b6",
    "projectId=584f37b3-a054-4678-a149-38e9eab86d2c",
    "labelId=584f37b3-a054-4678-a149-38e9eab86d2c",
    "limit=100&offset=100",
    "sortField=id&afterId=abc",
    "includeBlockedBy=true",
    "parentId=584f37b3-a054-4678-a149-38e9eab86d2c",
    "attention=blocked",
    "view=compact",
  ])("does not reject supported param %s", async (qs) => {
    const res = await get(`/api/companies/c1/issues?${qs}`);
    expect(res.status).toBe(200);
  });

  // `afterId` starts with neither a time-entity prefix nor a bare operator —
  // the nearest-miss against the pattern, and a real param on this route.
  it("does not reject the lookalike afterId", async () => {
    const res = await get("/api/companies/c1/issues?afterId=abc");
    expect(res.status).toBe(200);
  });

  it("does not reject a request with no params at all", async () => {
    const res = await get("/api/companies/c1/issues");
    expect(res.status).toBe(200);
  });
});

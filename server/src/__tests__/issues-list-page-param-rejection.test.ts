import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseUnsupportedPaginationParams } from "../lib/issue-list-query.ts";

/**
 * Regression test for BLO-24495.
 *
 * `GET /companies/:companyId/issues` only ever implemented `limit`/`offset`
 * pagination. `page` and `perPage` were never read from `req.query`, so a
 * caller using `page=N` got the same limit/offset-default window back on
 * every page with no error — a silent-wrong-data bug, not a crash. Mirrors
 * the reject-with-400 branch added at `server/src/routes/issues.ts` right
 * after the limit/offset parsing, importing the same
 * `parseUnsupportedPaginationParams` helper the route calls so the test
 * actually regresses if that contract changes — not a copy of it.
 */

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/companies/:companyId/issues", (req, res) => {
    const unsupportedPaginationParams = parseUnsupportedPaginationParams(req.query);
    if (unsupportedPaginationParams.length > 0) {
      res.status(400).json({
        error: "page/perPage pagination is not supported on this endpoint; use limit and offset instead",
        unsupportedParams: unsupportedPaginationParams,
      });
      return;
    }
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("issue list page/perPage rejection", () => {
  it("rejects ?page=N with 400 and names the unsupported param", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?status=blocked&page=2");
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["page"]);
  });

  it("rejects ?perPage=100 with 400 and names the unsupported param", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?perPage=100");
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["perPage"]);
  });

  it("rejects combined ?perPage=100&page=2 and names both unsupported params", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?status=blocked&perPage=100&page=2",
    );
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["page", "perPage"]);
  });

  // BLO-40714: `per_page` is GitHub's spelling and was the one that still fell
  // through the helper, so a caller reaching for it got the pre-BLO-24495
  // behaviour back — a 200 over window 0. The mitigation was that such a
  // caller usually sends `page` too and is caught by that arm; this case is
  // deliberately `per_page` ALONE, so it fails if the new arm is reverted and
  // cannot be satisfied by the `page` arm.
  it("rejects ?per_page=100 on its own with 400 and names the unsupported param", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?per_page=100");
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["per_page"]);
  });

  it("names all three spellings when a caller sends all three", async () => {
    const res = await request(buildApp()).get(
      "/api/companies/c1/issues?page=2&perPage=100&per_page=100",
    );
    expect(res.status).toBe(400);
    expect(res.body.unsupportedParams).toEqual(["page", "perPage", "per_page"]);
  });

  // The positive control for every case above: `limit` is NOT a pagination
  // param this helper rejects, and must never become one — the endpoint this
  // helper serves genuinely implements it. The behavioural half of that pin
  // lives in issue-list-truncation-signal.test.ts, which drives the real route.
  it("does not reject requests using limit/offset", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?limit=100&offset=100");
    expect(res.status).toBe(200);
  });

  it("does not reject requests with no pagination params", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?status=blocked");
    expect(res.status).toBe(200);
  });
});

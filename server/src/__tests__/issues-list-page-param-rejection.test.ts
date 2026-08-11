import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseUnsupportedPaginationParams } from "../services/issues.ts";

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

  it("does not reject requests using limit/offset", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?limit=100&offset=100");
    expect(res.status).toBe(200);
  });

  it("does not reject requests with no pagination params", async () => {
    const res = await request(buildApp()).get("/api/companies/c1/issues?status=blocked");
    expect(res.status).toBe(200);
  });
});

/**
 * BLO-30608 — the backfill script's API acquisition path.
 *
 * The property under test is that a *capped* run still reports the size of the
 * queue it did not look at. The API path applies the probe budget while
 * acquiring (its per-issue approvals call is the only unbounded cost in the
 * pass), which means `revalidateGates` never sees the rows that were dropped —
 * its own `notProbed` is `inputs.length - classified`, so on a pre-trimmed list
 * it is structurally zero. Without the `omitted` count reconciled back in, a
 * 2-of-500 sample would print as a complete split and understate the backlog
 * this backfill exists to size.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFromApi,
  renderReport,
} from "../../../scripts/blo-30608-gate-revalidation-backfill.js";
import { revalidateGates } from "../services/human-gated-gate-revalidation.js";
import { HUMAN_GATED_DIGEST_ORIGIN_KIND } from "../services/human-gated-ageing.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-29T00:00:00.000Z");

type StubIssue = {
  id: string;
  identifier: string;
  status: string;
  assigneeUserId: string | null;
  createdAt: string;
  hiddenAt?: string | null;
  originKind?: string | null;
  blockedBy?: { id: string; identifier: string; status: string }[];
};

/**
 * Five human-gated rows, all `blocked`, created oldest-first so the ranking is
 * deterministic: `orderByHumanSilenceDescending` puts the largest silence first
 * and the API path ranks on `createdAt` alone.
 */
function humanGatedRows(): StubIssue[] {
  return [
    // Deliberately NOT in age order, so a pass that probes in response order
    // rather than ranked order picks a different pair and fails the assertion.
    { id: "i-3", identifier: "BLO-3", status: "blocked", assigneeUserId: "u1", createdAt: "2026-08-20T00:00:00.000Z" },
    { id: "i-1", identifier: "BLO-1", status: "blocked", assigneeUserId: "u1", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "i-5", identifier: "BLO-5", status: "blocked", assigneeUserId: "u1", createdAt: "2026-08-25T00:00:00.000Z" },
    { id: "i-2", identifier: "BLO-2", status: "blocked", assigneeUserId: "u1", createdAt: "2026-02-01T00:00:00.000Z" },
    { id: "i-4", identifier: "BLO-4", status: "blocked", assigneeUserId: "u1", createdAt: "2026-08-22T00:00:00.000Z" },
  ];
}

/** Rows the population predicate must drop before the budget is applied. */
function excludedRows(): StubIssue[] {
  return [
    { id: "x-agent", identifier: "BLO-X1", status: "blocked", assigneeUserId: null, createdAt: "2020-01-01T00:00:00.000Z" },
    { id: "x-hidden", identifier: "BLO-X2", status: "blocked", assigneeUserId: "u1", createdAt: "2020-01-01T00:00:00.000Z", hiddenAt: "2026-01-01T00:00:00.000Z" },
    {
      id: "x-digest",
      identifier: "BLO-X3",
      status: "blocked",
      assigneeUserId: "u1",
      createdAt: "2020-01-01T00:00:00.000Z",
      originKind: HUMAN_GATED_DIGEST_ORIGIN_KIND,
    },
  ];
}

type Stub = { requests: string[]; restore: () => void };

function stubApi(rowsByStatus: Record<string, StubIssue[]>): Stub {
  const original = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);

    const approvals = url.pathname.match(/^\/api\/issues\/([^/]+)\/approvals$/);
    if (approvals) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    const status = url.searchParams.get("status") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? "0");
    // Single page per status; the caller stops when a page is short.
    const page = offset === 0 ? (rowsByStatus[status] ?? []) : [];
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;

  return { requests, restore: () => { globalThis.fetch = original; } };
}

describe("BLO-30608 backfill — API acquisition", () => {
  let stub: Stub | null = null;

  beforeEach(() => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.test";
    process.env.PAPERCLIP_API_KEY = "test-key";
  });

  afterEach(() => {
    stub?.restore();
    stub = null;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
  });

  it("reports the rows a capped run never examined", async () => {
    stub = stubApi({ blocked: humanGatedRows() });

    const acquisition = await acquireFromApi(COMPANY_ID, 2, NOW);

    // The whole human-gated population is counted, not just the sample.
    expect(acquisition.population).toBe(5);
    expect(acquisition.evidence).toHaveLength(2);
    // The three rows the budget dropped are carried, not silently lost. This is
    // the assertion that fails if acquisition-side truncation goes unrecorded.
    expect(acquisition.omitted).toBe(3);
    expect(acquisition.population).toBe(acquisition.evidence.length + acquisition.omitted);
  });

  it("spends the budget on the oldest rows, not on response order", async () => {
    stub = stubApi({ blocked: humanGatedRows() });

    const acquisition = await acquireFromApi(COMPANY_ID, 2, NOW);

    expect(acquisition.evidence.map((e) => e.identifier)).toEqual(["BLO-1", "BLO-2"]);
  });

  it("carries the omitted rows into the rendered report as unexamined", async () => {
    stub = stubApi({ blocked: humanGatedRows() });

    const acquisition = await acquireFromApi(COMPANY_ID, 2, NOW);
    const report = revalidateGates(acquisition.evidence, { maxProbes: 2 });

    // The classifier alone cannot see the truncation: it was handed a list that
    // had already been cut to the budget.
    expect(report.notProbed).toBe(0);

    const notProbed = report.notProbed + acquisition.omitted;
    const rendered = renderReport(report, {
      population: acquisition.population,
      calls: acquisition.calls,
      elapsedMs: 1_000,
      source: "api",
      notProbed,
    });

    expect(rendered).toContain("Open human-gated population : 5");
    expect(rendered).toContain("Probed                      : 2 (3 beyond the budget)");
  });

  it("excludes agent-owned, hidden, and digest rows from the population", async () => {
    stub = stubApi({ blocked: [...humanGatedRows(), ...excludedRows()] });

    const acquisition = await acquireFromApi(COMPANY_ID, null, NOW);

    expect(acquisition.population).toBe(5);
    expect(acquisition.omitted).toBe(0);
    expect(acquisition.evidence.map((e) => e.identifier)).toEqual([
      "BLO-1",
      "BLO-2",
      "BLO-3",
      "BLO-4",
      "BLO-5",
    ]);
  });

  it("omits nothing on an uncapped run", async () => {
    stub = stubApi({ blocked: humanGatedRows() });

    const acquisition = await acquireFromApi(COMPANY_ID, null, NOW);

    expect(acquisition.population).toBe(5);
    expect(acquisition.evidence).toHaveLength(5);
    expect(acquisition.omitted).toBe(0);
  });

  it("bounds the per-issue approvals cost by the budget, not the population", async () => {
    stub = stubApi({ blocked: humanGatedRows() });

    const acquisition = await acquireFromApi(COMPANY_ID, 2, NOW);

    const approvalCalls = stub.requests.filter((path) => path.includes("/approvals"));
    expect(approvalCalls).toHaveLength(2);
    // 5 status pages + 2 approvals. Reported as the AC5 cost figure.
    expect(acquisition.calls).toBe(7);
  });
});

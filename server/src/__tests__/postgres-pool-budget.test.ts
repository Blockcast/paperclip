import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { POSTGRES_POOL_MAX } from "@paperclipai/db";

/**
 * BLO-37330: `POSTGRES_POOL_MAX` was sized three times by incident and never
 * against the server it connects to, because no server-side budget was written
 * down. `doc/DATABASE-CONNECTION-BUDGET.md` is now that budget.
 *
 * A document alone reproduces the original failure one step later: it can
 * silently disagree with the constant it justifies, and nothing notices. These
 * assertions make the two move together, and — more importantly — pin the
 * *safety* property the budget exists to protect, so raising the pool past what
 * the server can serve fails here rather than in production as a connection
 * refusal.
 */
const BUDGET_PATH = fileURLToPath(
  new URL("../../../doc/DATABASE-CONNECTION-BUDGET.md", import.meta.url),
);

/** Peak concurrent application processes sharing this Postgres instance. */
const PEAK_APP_PROCESSES = 4;

/**
 * Non-application connections the budget reserves: postgres-exporter,
 * overlapping `psql` cronjob one-shots, transient `createUtilitySql` pools and
 * operator headroom. Kept as one number because the budget doc is where the
 * breakdown belongs.
 */
const NON_APP_RESERVED = 17;

function readBudget(): string {
  return readFileSync(BUDGET_PATH, "utf8");
}

function readNumber(doc: string, pattern: RegExp, label: string): number {
  const match = doc.match(pattern);
  if (!match) throw new Error(`budget doc does not state ${label}`);
  return Number(match[1]);
}

describe("postgres connection budget", () => {
  it("states the same pool size the code ships", () => {
    const stated = readNumber(
      readBudget(),
      /`POSTGRES_POOL_MAX = (\d+)`/,
      "POSTGRES_POOL_MAX",
    );
    // If this fails, one of the two was changed alone. Fix the doc's arithmetic
    // rather than just this number — the whole point of the row is that the
    // constant must stay derived from a budget, not restated in prose.
    expect(stated).toBe(POSTGRES_POOL_MAX);
  });

  it("keeps peak demand inside the server's advertised ceiling", () => {
    const doc = readBudget();
    const maxConnections = readNumber(doc, /\| `max_connections` \| \*\*(\d+)\*\*/, "max_connections");
    const superuserReserved = readNumber(
      doc,
      /\| `superuser_reserved_connections` \| \*\*(\d+)\*\*/,
      "superuser_reserved_connections",
    );

    const availableToPaperclip = maxConnections - superuserReserved;
    const peakDemand = PEAK_APP_PROCESSES * POSTGRES_POOL_MAX + NON_APP_RESERVED;

    // The failure this guards is asymmetric: too small is a client-side queue,
    // too large is Postgres refusing connections outright. Only the second one
    // takes the fleet down, so the ceiling is the side that gets the assertion.
    expect(peakDemand).toBeLessThanOrEqual(availableToPaperclip);
  });
});

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

  it("keeps peak demand inside the server's ceiling with the stated margin", () => {
    const doc = readBudget();

    // Every input is parsed, none restated. An earlier revision hardcoded the
    // peak-process count and the non-application reserve here while parsing the
    // other two, which let the half that encodes the consumer model drift out
    // of step with the doc silently — the exact failure mode this file exists
    // to catch, reproduced one level up.
    const maxConnections = readNumber(doc, /\| `max_connections` \| \*\*(\d+)\*\*/, "max_connections");
    const superuserReserved = readNumber(
      doc,
      /\| `superuser_reserved_connections` \| \*\*(\d+)\*\*/,
      "superuser_reserved_connections",
    );
    // The arithmetic block is written with U+2212 MINUS and U+00F7 DIVISION, so
    // every anchor below accepts the ASCII lookalike too. Retyping a reserve
    // line with `-` would otherwise fail as "budget doc does not state <x>",
    // pointing at the doc's content when the cause is an invisible character.
    const appPoolBudget = readNumber(doc, /^= *(\d+) +for application pools$/m, "application pool budget");
    const margin = readNumber(doc, /^[−-] *(\d+) +estimation margin$/m, "estimation margin");
    const peakAppProcesses = readNumber(doc, /^[÷/] *(\d+) +peak processes/m, "peak processes");

    const availableToPaperclip = maxConnections - superuserReserved;
    // Summed from the reserve lines, not derived by subtraction. An earlier
    // revision computed this as `availableToPaperclip - appPoolBudget`, which
    // cancels the ceiling out of the comparison below: the verdict reduced to
    // `peakAppProcesses x POSTGRES_POOL_MAX <= appPoolBudget - margin`, so a
    // measured `max_connections` change that left the arithmetic block alone
    // still passed while the budget overflowed.
    const nonAppReserved =
      readNumber(doc, /^[−-] *(\d+) +postgres-exporter$/m, "postgres-exporter reserve") +
      readNumber(doc, /^[−-] *(\d+) +overlapping cronjob one-shots$/m, "cronjob reserve") +
      readNumber(doc, /^[−-] *(\d+) +transient createUtilitySql pools$/m, "createUtilitySql reserve") +
      readNumber(doc, /^[−-] *(\d+) +operator headroom$/m, "operator headroom reserve");
    // The block's own subtotal must follow from the table and the reserves, so
    // a ceiling re-measured in the table but not carried into the arithmetic
    // fails here even in the direction that would otherwise pass (more room).
    expect(availableToPaperclip - nonAppReserved).toBe(appPoolBudget);
    // `= 72 budgeted` and `= 18 per pool` close the block and were the only two
    // lines nothing parsed — pure display, free to drift out of step with the
    // values actually checked while every input around them stayed pinned. With
    // these, each line of the arithmetic follows from the one above it, so a
    // reader cannot be handed a chain that no longer adds up.
    expect(
      readNumber(doc, /^= *(\d+) +budgeted to application pools$/m, "budgeted application pool total"),
    ).toBe(appPoolBudget - margin);
    expect(readNumber(doc, /^= *(\d+) +per pool$/m, "per-pool allocation")).toBe(POSTGRES_POOL_MAX);
    const peakDemand = peakAppProcesses * POSTGRES_POOL_MAX + nonAppReserved;

    // The failure this guards is asymmetric: too small is a client-side queue,
    // too large is Postgres refusing connections outright. Only the second one
    // takes the fleet down, so the ceiling is the side that gets the assertion.
    //
    // The margin is subtracted rather than merely documented. Asserting against
    // the bare ceiling passes at exact equality — peak demand consuming 100% of
    // what the role can open — and the doc is explicit that its own inputs are
    // declared configuration rather than observed backends. One un-modelled
    // consumer past a zero-slack budget is `FATAL: sorry, too many clients
    // already`, so the guard has to fail before the ceiling, not at it.
    expect(peakDemand).toBeLessThanOrEqual(availableToPaperclip - margin);
  });
});

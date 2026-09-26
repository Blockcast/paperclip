/**
 * PEN-3365 — the inherited timeout reading must be answerable by query.
 *
 * `readInheritedTimeoutSettings` already shipped (#1921) and already writes a
 * `Database timeout environment: …` line at startup, which is what PEN-3365
 * step 3 is gated on. That line turned out to be write-only in practice:
 * measured 2026-09-26, no `paperclip-api` or worker pod had restarted in over
 * two days, the API log runs ~2.2 lines/sec so the line sat ~390k lines behind
 * the tail, `kubectl logs` is 403 from an agent seat, and the read-only k8s
 * tooling exposes only `tail`. These assertions pin the gauge that makes the
 * same reading obtainable at any moment.
 *
 * The encoding assertions are the load-bearing ones: a reader who mistakes
 * `disabled` for a missing measurement, or who reads the value in the probe's
 * milliseconds while the series is named `_seconds`, gets the step-3 decision
 * backwards in the direction that silently leaves the pool unbounded.
 *
 * The series name is asserted for the same reason. It reports what the pool
 * INHERITS, which for `idle_in_transaction_session_timeout` is provably not
 * its effective value — `createDb` sets that to 120 s in its own startup
 * packet and the probe deliberately reads on a connection carrying none of
 * those overrides. Under an `_effective_` name that series reading `0` would
 * say "unbounded" about the one setting #1921 already bounds, and the name is
 * what lands in PromQL where no doc comment is read.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DB_INHERITED_TIMEOUT_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setDbInheritedTimeouts,
} from "../services/metrics.js";

afterEach(() => {
  __resetMetricsForTest();
});

async function seriesFor(metric: string): Promise<string[]> {
  const { body } = await renderMetrics();
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${metric}{`) || line.startsWith(`${metric} `));
}

/** Parse `metric{setting="x",source="y"} 1.5` into a keyed lookup. */
async function readings(): Promise<Map<string, { value: number; source: string }>> {
  const out = new Map<string, { value: number; source: string }>();
  for (const line of await seriesFor(DB_INHERITED_TIMEOUT_METRIC)) {
    const setting = line.match(/setting="([^"]+)"/)?.[1];
    const source = line.match(/source="([^"]+)"/)?.[1];
    const value = Number(line.slice(line.lastIndexOf(" ") + 1));
    if (setting && source) out.set(setting, { value, source });
  }
  return out;
}

describe("inherited DB timeout exposition (PEN-3365)", () => {
  it("names the series for what it measures: inherited, not effective", () => {
    // Not cosmetic. `createDb` bounds idle-in-transaction at 120s in the pool's
    // startup packet (#1921) and this probe deliberately does not observe that,
    // so under an `_effective_` name the resulting 0 would assert "unbounded"
    // about a setting that is bounded. The name is the part that reaches
    // PromQL, dashboards and alert rules; the help string is not read there.
    expect(DB_INHERITED_TIMEOUT_METRIC).toBe("paperclip_db_inherited_timeout_seconds");
    expect(DB_INHERITED_TIMEOUT_METRIC).not.toContain("effective");
  });

  it("publishes one series per setting, carrying the attributing source", async () => {
    setDbInheritedTimeouts([
      { name: "statement_timeout", valueMs: 30_000, source: "user" },
      { name: "idle_in_transaction_session_timeout", valueMs: 120_000, source: "database" },
      { name: "lock_timeout", valueMs: null, source: "default" },
    ]);

    const seen = await readings();
    expect([...seen.keys()].sort()).toEqual([
      "idle_in_transaction_session_timeout",
      "lock_timeout",
      "statement_timeout",
    ]);
    // `source` is the half that answers whether a role-level bound exists at
    // all: `default` means nothing sets it, despite two places in this repo
    // asserting a role-level 30s statement_timeout.
    expect(seen.get("statement_timeout")?.source).toBe("user");
    expect(seen.get("lock_timeout")?.source).toBe("default");
  });

  it("converts the probe's milliseconds to the seconds the metric name promises", async () => {
    setDbInheritedTimeouts([{ name: "statement_timeout", valueMs: 30_000, source: "user" }]);

    // 30 not 30000 — a reader sizing an explicit timeout against a 1000x
    // overstatement would conclude we already inherit a bound three orders of
    // magnitude looser than reality.
    expect((await readings()).get("statement_timeout")?.value).toBe(30);
  });

  it("publishes a disabled timeout as 0, the way Postgres encodes it", async () => {
    setDbInheritedTimeouts([{ name: "statement_timeout", valueMs: null, source: "default" }]);

    // This is the unbounded case PEN-3365 exists for. It must be a present
    // series reading 0, never an absent one: absence is reserved for "the
    // probe did not complete", and conflating the two would make the
    // step-3 branch unanswerable in exactly the case that decides it.
    const seen = await readings();
    expect(seen.has("statement_timeout")).toBe(true);
    expect(seen.get("statement_timeout")?.value).toBe(0);
  });

  it("retires a stale source series when the reading moves", async () => {
    setDbInheritedTimeouts([{ name: "statement_timeout", valueMs: null, source: "default" }]);
    setDbInheritedTimeouts([{ name: "statement_timeout", valueMs: 30_000, source: "user" }]);

    // Without reset() both label sets would persist, and a reader taking the
    // first or the max would get the retired `default`/0 reading back.
    const lines = await seriesFor(DB_INHERITED_TIMEOUT_METRIC);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('source="user"');
  });

  it("exposes nothing at all until the probe reports", async () => {
    // The probe is wrapped so it can never block startup, so "no series" is a
    // real state and must stay distinguishable from any reading.
    expect(await seriesFor(DB_INHERITED_TIMEOUT_METRIC)).toHaveLength(0);
  });
});

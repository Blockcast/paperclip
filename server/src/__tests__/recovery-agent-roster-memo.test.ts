import { describe, expect, it } from "vitest";

import {
  createAgentRosterMemo,
  DEFAULT_AGENT_ROSTER_MEMO_TTL_MS,
} from "../services/recovery/agent-roster-memo.js";
import {
  type AgentOrgRow,
  evaluateAgentInvokabilityFromDb,
} from "../services/agent-invokability.js";

/**
 * PEN-3636. The stranded sweep evaluates agent invokability once per candidate, and that
 * evaluation takes TWO round-trips: `getAgent(agentId)` for the subject's own row, then a
 * roster read scoped to the *company* with no id filter. The second is identical for every
 * candidate of that company, and one measured pass put ≥994 candidates through that site.
 *
 * These tests pin the properties the optimisation rests on, each of which fails silently if
 * broken: a memo that never caches is merely slow (invisible); one that leaks between
 * companies returns the wrong org chart (wrong verdict, no error); one with an unbounded
 * window reintroduces the pass-duration-scaled staleness the TTL exists to cap; and one that
 * memoised the *subject's* row would widen the freshness trade from "ancestors only" to the
 * whole verdict, which is the claim the doc comment makes and the reason the trade is
 * acceptable.
 */

function agent(partial: Partial<AgentOrgRow> & Pick<AgentOrgRow, "id">): AgentOrgRow {
  return {
    companyId: "company-1",
    name: partial.id,
    reportsTo: null,
    status: "active",
    ...partial,
  };
}

/**
 * A `Pick<Db, "select">` stand-in that answers each read with the next prepared row set.
 *
 * Returning a DIFFERENT roster per read is deliberate: it lets a test prove the memo handed
 * back the rows belonging to the company it was asked about, rather than merely counting
 * reads. A read counter alone cannot tell a correct memo from one that keys every company to
 * the same entry.
 */
function fakeRosterDb(responses: AgentOrgRow[][]) {
  let reads = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          const rows = responses[Math.min(reads, responses.length - 1)] ?? [];
          reads += 1;
          return rows;
        },
      }),
    }),
  } as never;
  return { db, reads: () => reads };
}

describe("agent roster memo", () => {
  it("answers repeated candidates of one company from a single roster read", async () => {
    const roster = [agent({ id: "a" })];
    const { db, reads } = fakeRosterDb([roster]);
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    for (let i = 0; i < 50; i += 1) {
      expect(await memo.companyAgents("company-1")).toEqual(roster);
    }

    expect(reads()).toBe(1);
  });

  it("keys per company, and returns each company's own rows", async () => {
    const rosterA = [agent({ id: "a", companyId: "company-1" })];
    const rosterB = [agent({ id: "b", companyId: "company-2" })];
    const { db, reads } = fakeRosterDb([rosterA, rosterB]);
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    expect(await memo.companyAgents("company-1")).toEqual(rosterA);
    expect(await memo.companyAgents("company-2")).toEqual(rosterB);
    // The load-bearing assertion: company-1 must come back with ITS rows, not company-2's
    // entry that was written more recently. A memo keyed on nothing passes the read count
    // below and fails here.
    expect(await memo.companyAgents("company-1")).toEqual(rosterA);

    expect(reads()).toBe(2);
  });

  it("bounds staleness by the TTL rather than by pass duration", async () => {
    // The sweep this serves runs for ~29 minutes. The window that matters must be the TTL,
    // not the pass, or a slow pass silently widens the trade.
    const { db, reads } = fakeRosterDb([[agent({ id: "a" })]]);
    let clock = 0;
    const memo = createAgentRosterMemo(db, { ttlMs: 5_000, now: () => clock });

    await memo.companyAgents("c");
    clock = 4_999;
    await memo.companyAgents("c");
    expect(reads()).toBe(1);

    clock = 5_000;
    await memo.companyAgents("c");
    expect(reads()).toBe(2);
  });

  it("observes an org-chart change once the window expires", async () => {
    // The staleness this trades away, asserted as a bounded window rather than described.
    const before = [agent({ id: "boss" }), agent({ id: "a", reportsTo: "boss" })];
    const after = [agent({ id: "boss", status: "terminated" }), agent({ id: "a", reportsTo: "boss" })];
    const { db } = fakeRosterDb([before, after]);
    let clock = 0;
    const memo = createAgentRosterMemo(db, { ttlMs: 5_000, now: () => clock });

    expect(await memo.companyAgents("c")).toEqual(before);
    clock = 4_999;
    expect(await memo.companyAgents("c")).toEqual(before);

    clock = 5_000;
    expect(await memo.companyAgents("c")).toEqual(after);
  });

  it("keeps the default TTL short enough to stay well inside one recovery tick", () => {
    // The recovery chain ticks every 30 s. A default at or above that would let the window
    // the TTL exists to bound span a whole tick.
    expect(DEFAULT_AGENT_ROSTER_MEMO_TTL_MS).toBeGreaterThan(0);
    expect(DEFAULT_AGENT_ROSTER_MEMO_TTL_MS).toBeLessThanOrEqual(10_000);
  });

  it("counts the round-trips it took and the ones it removed", async () => {
    // Without this the saving is a projection. `memoHits` must equal exactly the number of
    // roster reads that did not happen, or the figure reported on the issue measures nothing.
    const { db, reads } = fakeRosterDb([[agent({ id: "a" })], [agent({ id: "b" })]]);
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    expect(memo.stats()).toEqual({ liveReads: 0, memoHits: 0 });

    for (let i = 0; i < 10; i += 1) await memo.companyAgents("company-1");
    await memo.companyAgents("company-2");

    expect(memo.stats()).toEqual({ liveReads: 2, memoHits: 9 });
    // The counters must agree with the collaborator rather than merely be self-consistent.
    expect(reads()).toBe(2);
  });

  it("books a failed read as a round-trip taken, not as a saving", async () => {
    // Counting on return would flatter the saving on exactly the passes where the database
    // is in trouble — the reading would improve as the system degraded.
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("connection terminated");
          },
        }),
      }),
    } as never;
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    await expect(memo.companyAgents("c")).rejects.toThrow("connection terminated");

    expect(memo.stats()).toEqual({ liveReads: 1, memoHits: 0 });
  });

  it("does not memoise a read that threw", async () => {
    // A failed read must not populate the cache: serving an empty roster from a read that
    // never returned would report every agent in the company as org-chain-broken.
    let fail = true;
    const roster = [agent({ id: "a" })];
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            if (fail) throw new Error("connection terminated");
            return roster;
          },
        }),
      }),
    } as never;
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    await expect(memo.companyAgents("c")).rejects.toThrow("connection terminated");

    fail = false;
    // Same company, same instant — a cached entry would short-circuit here and return the
    // rows of a read that never completed.
    expect(await memo.companyAgents("c")).toEqual(roster);
  });
});

describe("evaluateAgentInvokabilityFromDb with a roster memo", () => {
  it("is behaviour-preserving for callers that pass no memo", async () => {
    // Every call site outside the sweep keeps today's fully live roster read per call.
    const roster = [agent({ id: "a" })];
    const { db, reads } = fakeRosterDb([roster]);

    for (let i = 0; i < 3; i += 1) {
      expect(await evaluateAgentInvokabilityFromDb(db, roster[0])).toEqual({ invokable: true });
    }

    expect(reads()).toBe(3);
  });

  it("routes the roster read through the memo when one is passed", async () => {
    // The wiring test. Falsified by dropping the third argument: reads goes 1 -> 3.
    const roster = [agent({ id: "a" })];
    const { db, reads } = fakeRosterDb([roster]);
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    for (let i = 0; i < 3; i += 1) {
      expect(await evaluateAgentInvokabilityFromDb(db, roster[0], memo)).toEqual({
        invokable: true,
      });
    }

    expect(reads()).toBe(1);
    expect(memo.stats()).toEqual({ liveReads: 1, memoHits: 2 });
  });

  it("keeps the subject agent's own status live while the roster is memoised", async () => {
    // ⭐ This is the property that makes the freshness trade narrow enough to accept, and it
    // is the one a reader is most likely to assume away. Only the ORG CHAIN comes from the
    // memo; the subject's row arrives live from `getAgent` on every candidate, so a status
    // change is observed immediately even on a memo hit. If the subject's row were ever
    // served from the roster snapshot this test goes red.
    const live = agent({ id: "a" });
    const { db, reads } = fakeRosterDb([[live]]);
    const memo = createAgentRosterMemo(db, { now: () => 1_000 });

    expect(await evaluateAgentInvokabilityFromDb(db, live, memo)).toEqual({ invokable: true });

    const pausedNow = { ...live, status: "paused" as const };
    expect(await evaluateAgentInvokabilityFromDb(db, pausedNow, memo)).toMatchObject({
      invokable: false,
      reason: "paused",
    });

    // ...and the verdict flipped without a second roster read, which is what proves the
    // freshness came from the live argument rather than from cache expiry.
    expect(reads()).toBe(1);
  });

  it("still reports a stale-roster org-chain verdict, which is the trade being made", async () => {
    // The honest converse of the test above, pinned rather than described: an ancestor
    // terminated inside the TTL window is NOT seen, so the subject still reads invokable.
    // This is the accepted exposure — bounded at 5 s and to ancestors only.
    const boss = agent({ id: "boss" });
    const subject = agent({ id: "a", reportsTo: "boss" });
    const { db } = fakeRosterDb([
      [boss, subject],
      [{ ...boss, status: "terminated" as const }, subject],
    ]);
    let clock = 0;
    const memo = createAgentRosterMemo(db, { ttlMs: 5_000, now: () => clock });

    expect(await evaluateAgentInvokabilityFromDb(db, subject, memo)).toEqual({ invokable: true });

    clock = 4_999;
    expect(await evaluateAgentInvokabilityFromDb(db, subject, memo)).toEqual({ invokable: true });

    clock = 5_000;
    expect(await evaluateAgentInvokabilityFromDb(db, subject, memo)).toMatchObject({
      invokable: false,
      reason: "manager_terminated",
    });
  });
});

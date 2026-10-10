import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeIssuePrefix,
  planIssueIdentityChange,
} from "../services/company-issue-identity.js";

// BLO-31228: `companies.issuePrefix` / `companies.issueCounter` are the identity
// of every issue in a company, and the Linear OAuth callback used to overwrite
// both unconditionally. On the Blockcast company that would have rewritten
// BLO -> EGY and moved the counter BACKWARDS 31222 -> 363, re-issuing
// identifiers that already exist. BLO-31227 made team selection deterministic;
// this is the other half — a wrong selection must not be destructive.

const BLOCKCAST = { issuePrefix: "BLO", issueCounter: 31222 };

describe("planIssueIdentityChange — prefix", () => {
  it("is a no-op when a reconnect computes the prefix the company already has", () => {
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "BLO", counter: 31222 });
    expect(plan.changed).toBe(false);
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toEqual([]);
  });

  it("matches case-insensitively, so a lowercase team key is still a no-op", () => {
    expect(planIssueIdentityChange(BLOCKCAST, { prefix: "blo" }).changed).toBe(false);
  });

  it("REFUSES a different prefix when nothing confirmed the change", () => {
    // The exact BLO-31227 shape arriving at this guard: sole-team EGY resolved
    // for a company whose identity is BLO.
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "EGY" });
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toContain("prefix-change-unconfirmed");
  });

  it("applies a different prefix only when explicitly confirmed", () => {
    const plan = planIssueIdentityChange(
      BLOCKCAST,
      { prefix: "EGY" },
      { confirmPrefixChange: true },
    );
    expect(plan.prefix).toBe("EGY");
    expect(plan.refusals).toEqual([]);
  });

  it("still auto-configures a company that has minted nothing yet", () => {
    // The useful first-time-connection behaviour this came from. The bug was
    // treating "already has an identity" the same as "has none".
    // `issue_prefix` is NOT NULL DEFAULT 'PAP', so a never-touched company is
    // "PAP"/0 — not blank. Keying on blankness would refuse every first
    // connection, which is the other way to get this wrong.
    const fresh = [
      { issuePrefix: "PAP", issueCounter: 0 },
      { issuePrefix: null, issueCounter: 0 },
      { issuePrefix: "", issueCounter: 0 },
    ];
    for (const current of fresh) {
      const plan = planIssueIdentityChange(current, { prefix: "EGY", counter: 363 });
      expect(plan.prefix).toBe("EGY");
      expect(plan.counter).toBe(363);
      expect(plan.refusals).toEqual([]);
    }
  });

  it("REFUSES once identifiers exist, even with a 0 counter", () => {
    // The Linear import's "start fresh" path leaves rows behind a 0 counter,
    // so the counter alone is not proof that nothing was minted.
    const plan = planIssueIdentityChange(
      { issuePrefix: "PAP", issueCounter: 0, hasMintedIdentifiers: true },
      { prefix: "EGY" },
    );
    expect(plan.prefix).toBeNull();
    expect(plan.refusals).toContain("prefix-change-unconfirmed");
  });
});

describe("planIssueIdentityChange — counter", () => {
  it("REFUSES a lower computed counter and keeps the stored one", () => {
    // 31222 -> 363 is the live regression: a backwards counter re-issues
    // identifiers that already exist, so it collides with history.
    const plan = planIssueIdentityChange(BLOCKCAST, { prefix: "BLO", counter: 363 });
    expect(plan.counter).toBeNull();
    expect(plan.changed).toBe(false);
    expect(plan.refusals).toContain("counter-regression");
  });

  it("refuses a regression even when the prefix change IS confirmed", () => {
    // Confirmation is about re-identifying the company; it never licenses
    // handing out an identifier twice.
    const plan = planIssueIdentityChange(
      BLOCKCAST,
      { prefix: "EGY", counter: 363 },
      { confirmPrefixChange: true },
    );
    expect(plan.prefix).toBe("EGY");
    expect(plan.counter).toBeNull();
    expect(plan.refusals).toContain("counter-regression");
  });

  it("raises the counter when the computed value is higher", () => {
    const plan = planIssueIdentityChange(BLOCKCAST, { counter: 40000 });
    expect(plan.counter).toBe(40000);
    expect(plan.refusals).toEqual([]);
  });

  it("ignores an absent or non-numeric counter rather than zeroing it", () => {
    for (const counter of [undefined, null, Number.NaN]) {
      const plan = planIssueIdentityChange(BLOCKCAST, { counter });
      expect(plan.counter).toBeNull();
      expect(plan.refusals).toEqual([]);
    }
  });
});

describe("normalizeIssuePrefix", () => {
  it("keeps the board endpoint's long-standing cleaning", () => {
    expect(normalizeIssuePrefix(" blo-1 ")).toBe("BLO1");
    expect(normalizeIssuePrefix("   ")).toBeNull();
    expect(normalizeIssuePrefix(null)).toBeNull();
  });
});

describe("linear-auth identity writes", () => {
  // AC3: both columns go through the one guarded path. A pure-function guard
  // nothing calls is documentation, so this is the test that fails if the raw
  // `update(companies)` on identity columns is ever reintroduced.
  const source = readFileSync(
    fileURLToPath(new URL("../routes/linear-auth.ts", import.meta.url)),
    "utf8",
  );

  it("routes every identity write through setCompanyIssueIdentity", () => {
    expect(source).toContain("setCompanyIssueIdentity");
    const rawIdentityWrite = /\.set\(\s*\{[^}]*issue(Prefix|Counter)/s;
    expect(rawIdentityWrite.test(source)).toBe(false);
  });

  it("never passes confirmPrefixChange from the OAuth callback", () => {
    const callback = source.slice(0, source.indexOf("/configure"));
    expect(callback).toContain("confirmPrefixChange: false");
    expect(callback).not.toContain("confirmPrefixChange: true");
  });
});

describe("setCompanyIssueIdentity", () => {
  // The "has anything been minted?" question is answered from the issues table,
  // not from the counter — the counter lies on the import's "start fresh" path.
  const source = readFileSync(
    fileURLToPath(new URL("../services/company-issue-identity.ts", import.meta.url)),
    "utf8",
  );

  it("asks the issues table rather than trusting the counter", () => {
    expect(source).toMatch(/\.from\(issues\)/);
    expect(source).toContain("hasMintedIdentifiers:");
  });
});

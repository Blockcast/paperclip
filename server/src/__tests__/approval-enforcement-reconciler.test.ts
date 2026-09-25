/**
 * Approval-enforcement reconciler — pure-layer tests (BLO-24631).
 *
 * The fixture in this file is not synthetic. `CARD_6F45844E_EXACT_CHANGES` is
 * the verbatim `payload.exact_changes` of approval `6f45844e-1a0a-4a71-ba63-82fecb1e42f6`,
 * which restated the decision of `304ea443-0979-475c-9dcc-cd033c7919c6` (the
 * net-zero reallocation approved 2026-08-04). `from_usd` is the enforced
 * `budget_policies.amount` at the time the drift was discovered — five days
 * after the decision, with **zero of eight** changes applied — and `to_usd` is
 * what was decided. So:
 *
 *   enforced := from_usd  -> the historical pre-fix state -> expect 8 drifts
 *   enforced := to_usd    -> the state after manual repair -> expect silence
 *
 * That pair is the regression fixture and the verifying signal from the issue,
 * expressed without needing a database or a five-day-old snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  BUDGET_POLICY_AMOUNT_ASSERTION,
  classifyEnforcementAssertion,
  diffEnforcementAssertions,
  extractEnforcementAssertions,
  isApprovalEnforcementDriftConflict,
  parseJsonBodyStrict,
  type EnforcedBudgetPolicy,
} from "../services/approval-enforcement-reconciler.ts";
/** Verbatim payload.exact_changes from approval 6f45844e. */
const CARD_6F45844E_EXACT_CHANGES = [
  { agent: "CTO", to_usd: 32000, from_usd: 19000, policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", delta_usd: "+13000.00" },
  { agent: "Ally", to_usd: 38000, from_usd: 25000, policyId: "a894e681-9691-4678-88ad-063059210a14", delta_usd: "+13000.00" },
  { agent: "PlatformSREEngineer", to_usd: 13000, from_usd: 10000, policyId: "37c1fefd-b8bd-4a45-a61c-c2b2c8a4afb1", delta_usd: "+3000.00" },
  { agent: "QA Engineer", to_usd: 4000, from_usd: 3900, policyId: "87a4c0a1-676e-4dde-bb53-cc65aea7c8b5", delta_usd: "+100.00" },
  { agent: "UXDesigner", to_usd: 10000, from_usd: 30011.4, policyId: "34da6e60-3937-444a-a796-bc5565c186da", delta_usd: "-20011.40" },
  { agent: "BackendEngineerGo", to_usd: 7000, from_usd: 9120.54, policyId: "c0ad42ab-8a61-4202-9a3a-7591757dab1a", delta_usd: "-2120.54" },
  { agent: "OCMBackendEngineer", to_usd: 6000, from_usd: 10000, policyId: "5ab306aa-089b-4d49-9177-506b9d91bc75", delta_usd: "-4000.00" },
  { agent: "TrafficOpsEngineer", to_usd: 7000, from_usd: 10000, policyId: "4a4500ac-ab39-4d68-819a-8e5ef2b950fe", delta_usd: "-3000.00" },
];

const CARD_6F45844E_PAYLOAD = {
  title:
    "APPLY the net-zero budget reallocation you already approved on 2026-08-04 (card 304ea443)",
  exact_changes: CARD_6F45844E_EXACT_CHANGES,
  recurrence_note: "free-form prose the reconciler must ignore",
};

/**
 * Card `6f45844e` was decided at this instant. Everything the classifier does in
 * its terminal branch is a comparison against it.
 */
const CARD_6F45844E_DECIDED_AT = new Date("2026-08-10T17:51:20.638Z");
/** A cap that moved after the decision — i.e. a real supersession. */
const AMOUNT_MOVED_AFTER_DECISION = new Date("2026-08-18T23:07:40.381Z");
/** A cap unmoved since before the decision: nothing can have superseded it. */
const AMOUNT_UNMOVED_SINCE_DECISION = new Date("2026-08-04T10:04:45.877Z");

function enforcedFrom(
  key: "from_usd" | "to_usd",
  overrides: Record<string, Partial<EnforcedBudgetPolicy>> = {},
): Map<string, EnforcedBudgetPolicy | null> {
  const map = new Map<string, EnforcedBudgetPolicy | null>();
  for (const change of CARD_6F45844E_EXACT_CHANGES) {
    map.set(change.policyId, {
      policyId: change.policyId,
      amount: Math.round(change[key] * 100),
      isActive: true,
      amountUpdatedAt: AMOUNT_MOVED_AFTER_DECISION,
      ...(overrides[change.policyId] ?? {}),
    });
  }
  return map;
}

describe("extractEnforcementAssertions", () => {
  it("extracts all eight budget assertions from the historical card's legacy shape", () => {
    const assertions = extractEnforcementAssertions(CARD_6F45844E_PAYLOAD);
    expect(assertions).toHaveLength(8);
    expect(assertions.every((a) => a.kind === BUDGET_POLICY_AMOUNT_ASSERTION)).toBe(true);
    expect(assertions.every((a) => a.source === "legacy_exact_changes")).toBe(true);
    const cto = assertions.find((a) => a.policyId === "eafeb342-8dfd-403f-a489-c7c91988612c");
    expect(cto).toMatchObject({ expectedAmountCents: 3_200_000, label: "CTO" });
  });

  it("rounds fractional dollar figures to whole cents rather than truncating", () => {
    // 30011.4 USD must land on 3001140, not 3001139 — a truncation bug here
    // would make the reconciler fire forever on a correctly-applied policy.
    const assertions = extractEnforcementAssertions({
      title: "t",
      exact_changes: [{ policyId: "34da6e60-3937-444a-a796-bc5565c186da", to_usd: 30011.4 }],
    });
    expect(assertions[0]?.expectedAmountCents).toBe(3_001_140);
  });

  it("reads the canonical declared shape and prefers it over a legacy duplicate", () => {
    const assertions = extractEnforcementAssertions({
      title: "t",
      enforcement_assertions: [
        {
          kind: BUDGET_POLICY_AMOUNT_ASSERTION,
          policyId: "eafeb342-8dfd-403f-a489-c7c91988612c",
          expected_usd: 32000,
          label: "CTO",
        },
      ],
      exact_changes: [
        { policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", to_usd: 999, agent: "CTO" },
      ],
    });
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({ expectedAmountCents: 3_200_000, source: "declared" });
  });

  it("accepts expected_amount_cents directly", () => {
    const assertions = extractEnforcementAssertions({
      title: "t",
      enforcement_assertions: [
        {
          kind: BUDGET_POLICY_AMOUNT_ASSERTION,
          policyId: "eafeb342-8dfd-403f-a489-c7c91988612c",
          expected_amount_cents: 1_234_567,
        },
      ],
    });
    expect(assertions[0]?.expectedAmountCents).toBe(1_234_567);
  });

  it("returns nothing for prose-only cards, which is the common case", () => {
    // Cards 1f03d8b8 (permission grant) and 8e863f20 (merge-queue setting)
    // carry only prose. They must yield zero assertions — skipped, not
    // silently reported as agreeing.
    expect(
      extractEnforcementAssertions({
        title: "Grant CTO the agents:configure permission key",
        summary: "…",
        evidence: ["…"],
        risks: ["…"],
      }),
    ).toEqual([]);
  });

  it("never throws on malformed or hostile payloads", () => {
    const inputs: unknown[] = [
      null,
      undefined,
      "a string",
      42,
      [],
      { title: "t", exact_changes: "not an array" },
      { title: "t", exact_changes: [null, 3, "x"] },
      { title: "t", exact_changes: [{ policyId: "not-a-uuid", to_usd: 1 }] },
      { title: "t", exact_changes: [{ policyId: "eafeb342-8dfd-403f-a489-c7c91988612c" }] },
      { title: "t", exact_changes: [{ policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", to_usd: "NaN" }] },
      { title: "t", exact_changes: [{ policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", to_usd: -5 }] },
      { title: "t", enforcement_assertions: [{ kind: "some_unknown_kind", policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", expected_usd: 1 }] },
    ];
    for (const input of inputs) {
      expect(() => extractEnforcementAssertions(input)).not.toThrow();
      expect(extractEnforcementAssertions(input)).toEqual([]);
    }
  });

  it("parses numeric strings, which agents routinely emit", () => {
    const assertions = extractEnforcementAssertions({
      title: "t",
      exact_changes: [{ policyId: "eafeb342-8dfd-403f-a489-c7c91988612c", to_usd: "32,000.00" }],
    });
    expect(assertions[0]?.expectedAmountCents).toBe(3_200_000);
  });
});

describe("diffEnforcementAssertions — BLO-24631 regression fixture", () => {
  const assertions = extractEnforcementAssertions(CARD_6F45844E_PAYLOAD);

  it("reproduces the historical drift: zero of eight changes applied", () => {
    const drifts = diffEnforcementAssertions(assertions, enforcedFrom("from_usd"));
    expect(drifts).toHaveLength(8);
    expect(drifts.every((d) => d.reason === "amount_mismatch")).toBe(true);

    const cto = drifts.find(
      (d) => d.assertion.policyId === "eafeb342-8dfd-403f-a489-c7c91988612c",
    );
    // The measured instance: decided $32,000, enforced $19,000. The CTO was at
    // 82.83% of the un-raised cap and projected to auto-pause.
    expect(cto?.assertion.expectedAmountCents).toBe(3_200_000);
    expect(cto?.actualAmountCents).toBe(1_900_000);
  });

  it("stays silent once decided and enforced agree", () => {
    expect(diffEnforcementAssertions(assertions, enforcedFrom("to_usd"))).toEqual([]);
  });

  it("detects partial application, which is the hazard the card called out", () => {
    const enforced = enforcedFrom("to_usd");
    enforced.set("a894e681-9691-4678-88ad-063059210a14", {
      policyId: "a894e681-9691-4678-88ad-063059210a14",
      amount: 2_500_000,
      isActive: true,
    });
    const drifts = diffEnforcementAssertions(assertions, enforced);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.assertion.label).toBe("Ally");
  });

  it("treats an absent enforcing row as drift, not as a skip", () => {
    const enforced = enforcedFrom("to_usd");
    enforced.set("eafeb342-8dfd-403f-a489-c7c91988612c", null);
    const drifts = diffEnforcementAssertions(assertions, enforced);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.reason).toBe("missing_policy");
  });

  it("treats an inactive policy as drift even when the amount matches", () => {
    // An inactive policy enforces nothing, so a matching `amount` on it is a
    // decision that has not taken effect.
    const enforced = enforcedFrom("to_usd", {
      "37c1fefd-b8bd-4a45-a61c-c2b2c8a4afb1": { isActive: false },
    });
    const drifts = diffEnforcementAssertions(assertions, enforced);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.reason).toBe("inactive_policy");
  });

  it("is silent for an approval carrying no assertions", () => {
    expect(diffEnforcementAssertions([], enforcedFrom("from_usd"))).toEqual([]);
  });
});

/**
 * Supersession vs never-applied (BLO-32796).
 *
 * The live state of approval `6f45844e` on 2026-09-14, which is what makes this
 * worth pinning: five of its eight policies sit at the decided figure and three
 * sit *above* it, because humans raised those caps after the card was decided.
 * A decided-vs-enforced comparison calls all three drift, which is what filed
 * BLO-33160, BLO-33397, BLO-33416 and BLO-33772 — four issues on one card in
 * four days, each closed by hand as "superseded, do not apply".
 */
describe("classifyEnforcementAssertion — supersession (BLO-32796)", () => {
  const assertions = extractEnforcementAssertions(CARD_6F45844E_PAYLOAD);
  const byPolicy = (id: string) => assertions.find((a) => a.policyId === id)!;
  const CTO = "eafeb342-8dfd-403f-a489-c7c91988612c";
  const ALLY = "a894e681-9691-4678-88ad-063059210a14";
  const SRE = "37c1fefd-b8bd-4a45-a61c-c2b2c8a4afb1";

  const policy = (
    id: string,
    amountUsd: number,
    amountUpdatedAt: Date | null = AMOUNT_MOVED_AFTER_DECISION,
  ): EnforcedBudgetPolicy => ({
    policyId: id,
    amount: Math.round(amountUsd * 100),
    isActive: true,
    amountUpdatedAt,
  });
  const classify = (
    assertion: Parameters<typeof classifyEnforcementAssertion>[0],
    enforced: EnforcedBudgetPolicy | null,
  ) => classifyEnforcementAssertion(assertion, enforced, CARD_6F45844E_DECIDED_AT);
  const diff = (
    assertionList: Parameters<typeof diffEnforcementAssertions>[0],
    enforced: Map<string, EnforcedBudgetPolicy | null>,
  ) => diffEnforcementAssertions(assertionList, enforced, CARD_6F45844E_DECIDED_AT);

  it("reads the card's recorded starting figure", () => {
    expect(byPolicy(CTO).priorAmountCents).toBe(1_900_000);
    // 30011.4 -> 3001140, rounded not truncated, same as the target figure.
    expect(byPolicy("34da6e60-3937-444a-a796-bc5565c186da").priorAmountCents).toBe(3_001_140);
  });

  it("separates the three states from the same two-way disagreement", () => {
    expect(classify(byPolicy(CTO), policy(CTO, 32000))).toBe("applied");
    expect(classify(byPolicy(CTO), policy(CTO, 19000))).toBe("never_applied");
    // Neither the starting figure nor the decided one: a later decision set it.
    expect(classify(byPolicy(CTO), policy(CTO, 56000))).toBe("superseded");
  });

  it("is silent on the live 2026-09-14 state of card 6f45844e", () => {
    // The regression this exists to prevent. Five applied, three superseded by
    // later raises; the pre-fix comparison reported three drifts here and
    // re-filed an issue for them every sweep.
    //
    // Also the guard on the fix below: those three caps were all raised after
    // 2026-08-10, so the amount-change split must still read them as
    // supersessions.
    const enforced = enforcedFrom("to_usd");
    enforced.set(CTO, policy(CTO, 56000));
    enforced.set(ALLY, policy(ALLY, 110000));
    enforced.set(SRE, policy(SRE, 20000));
    expect(diff(assertions, enforced)).toEqual([]);
  });

  it("reports an untouched policy that matches neither figure, rather than assuming supersession", () => {
    // Ally's first finding on #1846: `from_usd` is free-form payload text that
    // nothing validated at decision time, so a *wrong* prior lands in the
    // terminal branch and would have silently become `superseded` — a real
    // enforcement gap erased by an untrusted field. The database-owned
    // amount-change time is the fact to split on: this cap has not moved since
    // the decision, so there is no later decision for it to have been
    // superseded by.
    const stale = policy(CTO, 56000, AMOUNT_UNMOVED_SINCE_DECISION);
    expect(classify(byPolicy(CTO), stale)).toBe("never_applied");
    const enforced = enforcedFrom("to_usd");
    enforced.set(CTO, stale);
    expect(diff(assertions, enforced)).toHaveLength(1);
  });

  it("is not fooled by a post-decision edit that left the cap alone", () => {
    // Ally's second finding on #1846. The split first shipped against
    // `budget_policies.updated_at`, which `budgetService.upsertPolicy` bumps
    // for warn percent, hard stop, notify and active-state edits too. So an
    // operator toggling warn percent — at `AMOUNT_MOVED_AFTER_DECISION` here,
    // well after the decision — on a policy whose approved raise never landed
    // moved `updated_at` past `decidedAt` and turned a real gap into a
    // supersession: unreported by the sweep, and refused by the apply route.
    //
    // `amount_updated_at` only moves when the cap does, so the metadata edit is
    // invisible to this classifier by construction. The distinguishing input is
    // exactly the one this test pins: same enforced figure, same decided
    // figure, same wrong prior, same *row* write time — only the amount-change
    // time differs.
    const metadataOnlyEdit = policy(CTO, 56000, AMOUNT_UNMOVED_SINCE_DECISION);
    expect(classify(byPolicy(CTO), metadataOnlyEdit)).toBe("never_applied");
    const capActuallyMoved = policy(CTO, 56000, AMOUNT_MOVED_AFTER_DECISION);
    expect(classify(byPolicy(CTO), capActuallyMoved)).toBe("superseded");
  });

  it("treats an unknown amount-change time as unclassifiable, not as either answer", () => {
    // Both directions are dangerous to guess: `superseded` hides a real gap,
    // `never_applied` licenses the executor to revert a raise. Report and
    // refuse instead.
    expect(classify(byPolicy(CTO), policy(CTO, 56000, null))).toBe("unverifiable_mismatch");
  });

  it("still fires when a superseded policy is reverted to the starting figure", () => {
    // Supersession suppression must not become a blanket amnesty: back at the
    // `from` figure the decision is once again unapplied, and that is drift.
    const enforced = enforcedFrom("to_usd");
    enforced.set(CTO, policy(CTO, 19000));
    const drifts = diff(assertions, enforced);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.assertion.label).toBe("CTO");
  });

  it("reports a mismatch it cannot classify, rather than assuming supersession", () => {
    // A declared assertion with no recorded `from` collapses to the two-way
    // comparison. Failing to report a real gap is worse than reporting a
    // supersession we cannot rule out, so this stays drift.
    const [declared] = extractEnforcementAssertions({
      title: "t",
      enforcement_assertions: [
        { kind: BUDGET_POLICY_AMOUNT_ASSERTION, policyId: CTO, expected_usd: 32000 },
      ],
    });
    expect(declared?.priorAmountCents).toBeNull();
    expect(classify(declared!, policy(CTO, 56000))).toBe("unverifiable_mismatch");
    expect(diff([declared!], new Map([[CTO, policy(CTO, 56000)]]))).toHaveLength(1);
  });

  it("carries a declared from_usd through when the card records one", () => {
    const [declared] = extractEnforcementAssertions({
      title: "t",
      enforcement_assertions: [
        {
          kind: BUDGET_POLICY_AMOUNT_ASSERTION,
          policyId: CTO,
          expected_usd: 32000,
          from_usd: 19000,
        },
      ],
    });
    expect(declared?.priorAmountCents).toBe(1_900_000);
    expect(classify(declared!, policy(CTO, 56000))).toBe("superseded");
  });

  it("keeps missing and inactive policies ahead of the amount comparison", () => {
    expect(classify(byPolicy(CTO), null)).toBe("missing_policy");
    expect(classify(byPolicy(CTO), { ...policy(CTO, 32000), isActive: false })).toBe(
      "inactive_policy",
    );
  });
});

describe("parseJsonBodyStrict — SPA catch-all guard", () => {
  it("rejects the 200-with-HTML catch-all that an unprefixed probe hits", () => {
    // The recorded hazard: GET /companies/{id}/budgets/overview (no /api)
    // answers 200 with ~2.7 KB of HTML. Status alone says "route exists".
    const result = parseJsonBodyStrict(
      200,
      "text/html; charset=utf-8",
      '<!doctype html><html><head><title>Paperclip</title></head><body><div id="root"></div></body></html>',
    );
    expect(result).toEqual({ ok: false, reason: "non_json_content_type:text/html; charset=utf-8" });
  });

  it("accepts a real JSON body", () => {
    const result = parseJsonBodyStrict(200, "application/json", '{"policies":[]}');
    expect(result).toEqual({ ok: true, value: { policies: [] } });
  });

  it("rejects a JSON content-type with an unparseable body", () => {
    expect(parseJsonBodyStrict(200, "application/json", "{oops")).toEqual({
      ok: false,
      reason: "unparseable_json_body",
    });
  });

  it("rejects a JSON scalar, which cannot be an enforced-state snapshot", () => {
    expect(parseJsonBodyStrict(200, "application/json", "null")).toEqual({
      ok: false,
      reason: "json_body_not_object",
    });
  });

  it("rejects non-2xx regardless of body", () => {
    expect(parseJsonBodyStrict(404, "application/json", "{}")).toEqual({
      ok: false,
      reason: "http_404",
    });
  });
});

describe("isApprovalEnforcementDriftConflict", () => {
  it("recognizes the dedup constraint when Postgres wraps it as a cause", () => {
    const wrapped = new Error("reconciliation insert failed", {
      cause: new Error("database operation failed", {
        cause: {
          code: "23505",
          constraint_name: "issues_active_approval_enforcement_drift_uq",
        },
      }),
    });

    expect(isApprovalEnforcementDriftConflict(wrapped)).toBe(true);
  });
});

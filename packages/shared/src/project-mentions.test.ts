import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractMentionBindingReport,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUnboundMentionTokens,
  extractUserMentionIds,
  MAX_UNBOUND_MENTION_TOKENS,
  parseAgentMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseSkillMentionHref,
  parseUserMentionHref,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("round-trips user mentions", () => {
    const href = buildUserMentionHref("user-123");
    expect(parseUserMentionHref(href)).toEqual({
      userId: "user-123",
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual(["user-123"]);
  });

  it("round-trips skill mentions with slug metadata", () => {
    const href = buildSkillMentionHref("skill-123", "release-changelog");
    expect(parseSkillMentionHref(href)).toEqual({
      skillId: "skill-123",
      slug: "release-changelog",
    });
    expect(extractSkillMentionIds(`[/release-changelog](${href})`)).toEqual(["skill-123"]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref("routine-123");
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: "routine-123",
    });
    expect(extractRoutineMentionIds(`[/routine:Weekly review](${href})`)).toEqual(["routine-123"]);
  });
});

// PEN-5180: a plain `@Ceo` binds to nobody and raises no wake, and the write
// still returns 200 with nothing the author can read saying so. These assert
// the signal that makes that drop readable — including the positive control
// that a correctly-formed `agent://` mention produces NO signal, which is what
// keeps the field meaningful rather than constant noise.
describe("extractUnboundMentionTokens", () => {
  const BOUND_AGENT_ID = "agent-ceo-1";
  const boundHref = buildAgentMentionHref(BOUND_AGENT_ID, null);

  it("reports a plain @Name that matches no mention extractor", () => {
    expect(extractUnboundMentionTokens("@Ceo please rule on this")).toEqual(["Ceo"]);
  });

  it("POSITIVE CONTROL: a correctly-formed agent:// mention produces no signal", () => {
    expect(
      extractUnboundMentionTokens(`[@Ceo](${boundHref}) please rule on this`, {
        boundAgentIds: [BOUND_AGENT_ID],
      }),
    ).toEqual([]);
  });

  it("reports the plain token when both forms appear in one body", () => {
    expect(
      extractUnboundMentionTokens(`[@Ceo](${boundHref}) and @Cfo should both see this`, {
        boundAgentIds: [BOUND_AGENT_ID],
      }),
    ).toEqual(["Cfo"]);
  });

  it("reports a well-formed agent link whose target resolved to nobody", () => {
    // Same silent drop as a plain name: the href parses, the wake is still
    // delivered to no one. Reporting it is the whole point of the field.
    expect(
      extractUnboundMentionTokens(`[@Ghost](${buildAgentMentionHref("agent-gone", null)})`, {
        boundAgentIds: [BOUND_AGENT_ID],
      }),
    ).toEqual(["Ghost"]);
  });

  it("does not report non-agent mention schemes, which are a different subject", () => {
    const body = `[@Taylor](${buildUserMentionHref("user-1")}) and [@App](${buildProjectMentionHref("project-1", null)})`;
    expect(extractUnboundMentionTokens(body)).toEqual([]);
  });

  it("ignores @ tokens inside fenced code blocks", () => {
    const body = ["```ts", 'const handle = "@Ceo";', "```", "", "no mention here"].join("\n");
    expect(extractUnboundMentionTokens(body)).toEqual([]);
  });

  it("ignores @ tokens inside inline code", () => {
    expect(extractUnboundMentionTokens("the literal `@Ceo` is documented above")).toEqual([]);
  });

  it("ignores @ tokens inside a quoted prior comment", () => {
    const body = ["> @Ceo asked for a ruling", "", "I am recording that here."].join("\n");
    expect(extractUnboundMentionTokens(body)).toEqual([]);
  });

  it("ignores email addresses and URLs", () => {
    const body = "mail ops@example.com or see https://example.com/@Ceo/profile";
    expect(extractUnboundMentionTokens(body)).toEqual([]);
  });

  it("does not treat a mid-word @ as a mention", () => {
    expect(extractUnboundMentionTokens("build artifact v1@Sha256 is fine")).toEqual([]);
  });

  it("trims trailing prose punctuation and dedupes case-insensitively", () => {
    expect(extractUnboundMentionTokens("@Ceo, @ceo. and @Ceo again")).toEqual(["Ceo"]);
  });

  it("caps the reported token count so a pathological body cannot inflate a response", () => {
    const body = Array.from({ length: MAX_UNBOUND_MENTION_TOKENS + 15 }, (_, i) => `@name${i}`).join(" ");
    expect(extractUnboundMentionTokens(body)).toHaveLength(MAX_UNBOUND_MENTION_TOKENS);
  });

  // PEN-5187: `AT_TOKEN_RE` treated any `@`-shaped token as a candidate, so a
  // scoped package written in unquoted prose reported a name nobody wrote.
  // Engineering comments here name scoped packages and GitHub org paths
  // constantly, which made that a SYSTEMATIC false entry rather than an
  // occasional one — and a field that is usually wrong is a field people learn
  // to skip, which is the silent drop PEN-5180 exists to end, wearing a better
  // outfit.
  describe("scoped packages and org paths written in prose (PEN-5187)", () => {
    it("does not report an npm scope written in unquoted prose", () => {
      expect(extractUnboundMentionTokens("we should pin @types/node to match CI")).toEqual([]);
    });

    it("does not report a first-party scope written in unquoted prose", () => {
      expect(extractUnboundMentionTokens("the helper lives in @paperclipai/shared now")).toEqual([]);
    });

    it("does not report a GitHub org path written in unquoted prose", () => {
      expect(
        extractUnboundMentionTokens("review is owned by @Blockcast/onprem-k8s-ally-reviewer"),
      ).toEqual([]);
    });

    // The load-bearing half of the rule. Skipping on a bare `/` would also drop
    // this, and dropping a REAL unbound mention is the expensive failure.
    it("POSITIVE CONTROL: still reports a slash-separated mention pair", () => {
      expect(extractUnboundMentionTokens("cc @Ceo/@Cto for a ruling")).toEqual(["Ceo", "Cto"]);
    });

    // Done-when: the suppression must not have cost the signal it protects.
    it("POSITIVE CONTROL: a genuine unbound @Name beside a scope is still reported", () => {
      expect(
        extractUnboundMentionTokens("@Ceo please rule on pinning @types/node in CI"),
      ).toEqual(["Ceo"]);
    });

    it("POSITIVE CONTROL: a resolved agent:// mention beside a scope still reports nothing", () => {
      expect(
        extractUnboundMentionTokens(`[@Ceo](${boundHref}) owns the @types/node pin`, {
          boundAgentIds: [BOUND_AGENT_ID],
        }),
      ).toEqual([]);
    });

    // ACCEPTED, NOT FIXED — asserted so the decision is executable rather than
    // merely written down. A bare decorator is lexically identical to a bare
    // name mention, and agent names here are capitalized too, so every
    // candidate discriminator would also drop real mentions. Reporting it costs
    // one glance; suppressing it would cost a class of real mention. If this
    // test ever fails, the suppression that broke it is the regression.
    it("ACCEPTED: a bare decorator in prose is still reported, by decision", () => {
      expect(extractUnboundMentionTokens("mark the provider @Injectable first")).toEqual([
        "Injectable",
      ]);
    });

    it("masks the common backticked decorator form, as before", () => {
      expect(extractUnboundMentionTokens("mark the provider `@Injectable` first")).toEqual([]);
    });

    // A trailing slash with nothing after it is not a scope, so the scanner
    // keeps reporting — unchanged fail-toward-reporting posture.
    it("still reports a token whose slash opens nothing", () => {
      expect(extractUnboundMentionTokens("ask @Ceo/ about this")).toEqual(["Ceo"]);
    });

    // The scope-char class is lowercase-and-digit, because npm scope segments
    // and GitHub team slugs are lowercase while agent names here are
    // capitalized. These two are the mentions a wider class silently swallowed,
    // and a swallowed real mention is the failure PEN-5180 exists to end.
    it("POSITIVE CONTROL: reports a capitalized name before a slash", () => {
      expect(extractUnboundMentionTokens("cc @Ceo/Cto for a ruling")).toEqual(["Ceo"]);
    });

    it("POSITIVE CONTROL: reports a capitalized name before a slashed role", () => {
      expect(extractUnboundMentionTokens("cc @Ceo/PlatformSRE please")).toEqual(["Ceo"]);
    });

    // An npm name cannot begin with `.`, `_` or `-`, so none of these opens a
    // real scope path and the token before them is still a candidate name.
    it("reports a name whose slash opens a character npm cannot start with", () => {
      expect(extractUnboundMentionTokens("@Ceo/. then @Cto/-x then @Ceo/_y")).toEqual([
        "Ceo",
        "Cto",
      ]);
    });

    // ACCEPTED COST of the lowercase narrowing, asserted so it is visible
    // rather than discovered. A capitalized repo segment reports its org again.
    // That is a false positive costing one glance, bought with a false
    // negative; the lowercase paths this corpus actually writes stay suppressed.
    it("ACCEPTED: an org path with a capitalized repo segment reports the org", () => {
      expect(extractUnboundMentionTokens("see @Blockcast/Network-Operator-Portal")).toEqual([
        "Blockcast",
      ]);
    });

    it("keeps suppressing the lowercase org paths this corpus actually writes", () => {
      expect(
        extractUnboundMentionTokens("@Blockcast/paperclip and @Blockcast/penstock-llm-proxy-core"),
      ).toEqual([]);
    });

    // Remaining residual, stated rather than hidden: an all-lowercase pair is
    // lexically indistinguishable from a scope and stays dropped.
    it("RESIDUAL: an all-lowercase slashed pair is still read as a scope", () => {
      expect(extractUnboundMentionTokens("ping @ceo/cto")).toEqual([]);
    });
  });

  it("returns nothing for an empty or mention-free body", () => {
    expect(extractUnboundMentionTokens("")).toEqual([]);
    expect(extractUnboundMentionTokens("a comment with no mentions at all")).toEqual([]);
  });
});

// PEN-5364. `unbound` is deduped on the token text, not on the occurrence, so
// the mixed-form body — one `agent://` link plus loose prose for the same name —
// produces a receipt byte-identical to a body that only ever wrote the bare
// form. One raised the wake; the other dropped it. These assert the `bound`
// half tells them apart, and that the asymmetry runs the cheap way: an
// unreadable label reports nothing and costs a re-send, never a false all-clear.
describe("extractMentionBindingReport", () => {
  const BOUND_AGENT_ID = "agent-cfo-1";
  const boundHref = buildAgentMentionHref(BOUND_AGENT_ID, null);
  const opts = { boundAgentIds: [BOUND_AGENT_ID] };

  it("THE DEFECT: a mixed-form body is now readable", () => {
    // Before `bound`, this body and the bare-only body below were the same
    // receipt. The link RESOLVED here — whether a wake followed is gated
    // elsewhere, on the comment author (PEN-5367).
    expect(
      extractMentionBindingReport(
        `[@Cfo](${boundHref}) please rule — @Cfo also owns the ledger question`,
        opts,
      ),
    ).toEqual({ bound: ["Cfo"], unbound: ["Cfo"], withoutGrant: [] });
  });

  it("CONTRAST: the bare-only body reports the same unbound list and NO bound one", () => {
    expect(extractMentionBindingReport("@Cfo please rule on this", opts)).toEqual({
      bound: [],
      unbound: ["Cfo"],
      withoutGrant: [],
    });
  });

  it("link-only reports the bound name and nothing unbound", () => {
    expect(extractMentionBindingReport(`[@Cfo](${boundHref}) please rule`, opts)).toEqual({
      bound: ["Cfo"],
      unbound: [],
      withoutGrant: [],
    });
  });

  it("does not report a link whose target resolved to nobody as bound", () => {
    // The wake was dropped, so the name belongs in `unbound` and must not
    // appear in `bound` — reporting it there would manufacture the exact false
    // all-clear this field exists to prevent.
    expect(
      extractMentionBindingReport(`[@Ghost](${buildAgentMentionHref("agent-gone", null)})`, opts),
    ).toEqual({ bound: [], unbound: ["Ghost"], withoutGrant: [] });
  });

  it("does not report non-agent mention schemes as bound", () => {
    const body = `[@Taylor](${buildUserMentionHref("user-1")})`;
    expect(extractMentionBindingReport(body, opts)).toEqual({ bound: [], unbound: [], withoutGrant: [] });
  });

  it("reads a bare label, the `[Cfo](agent://…)` form", () => {
    expect(extractMentionBindingReport(`[Cfo](${boundHref}) please rule`, opts)).toEqual({
      bound: ["Cfo"],
      unbound: [],
      withoutGrant: [],
    });
  });

  it("reads the @-token out of a label carrying extra prose", () => {
    expect(
      extractMentionBindingReport(`[@Cfo — please rule](${boundHref}) and @Cfo again`, opts),
    ).toEqual({ bound: ["Cfo"], unbound: ["Cfo"], withoutGrant: [] });
  });

  it("RESIDUAL: a label with no name in it reports nothing bound", () => {
    // Costs one redundant re-send, which is the cheap direction. Inventing a
    // name by taking the first word would put prose in a list of names.
    expect(extractMentionBindingReport(`[the CFO](${boundHref}) please rule`, opts)).toEqual({
      bound: [],
      unbound: [],
      withoutGrant: [],
    });
  });

  it("dedupes bound names case-insensitively, as `unbound` does", () => {
    expect(
      extractMentionBindingReport(`[@Cfo](${boundHref}) and [@cfo](${boundHref})`, opts),
    ).toEqual({ bound: ["Cfo"], unbound: [], withoutGrant: [] });
  });

  it("reports a bound link inside a code fence, because the wake really fires", () => {
    // `findMentionedAgents` runs `extractAgentMentionIds` over the UNMASKED
    // body, so a fenced `agent://` link does raise a wake. Masking it here
    // would report a wake that happened as one that did not.
    const body = ["```md", `[@Cfo](${boundHref})`, "```"].join("\n");
    expect(extractMentionBindingReport(body, opts)).toEqual({ bound: ["Cfo"], unbound: [], withoutGrant: [] });
  });

  it("returns both halves empty for a mention-free body", () => {
    expect(extractMentionBindingReport("no mentions at all", opts)).toEqual({
      bound: [],
      unbound: [],
      withoutGrant: [],
    });
    expect(extractMentionBindingReport("", opts)).toEqual({ bound: [], unbound: [], withoutGrant: [] });
  });

  it("extractUnboundMentionTokens stays the unbound half, unchanged", () => {
    const body = `[@Cfo](${boundHref}) and @Ceo`;
    expect(extractUnboundMentionTokens(body, opts)).toEqual(
      extractMentionBindingReport(body, opts).unbound,
    );
  });

  // PEN-5812. `withoutGrant` reports the subset of `bound` the CALLER says the
  // author was not entitled to wake. It cannot be derived here: resolution is a
  // property of the body, entitlement a property of the author and the row.
  describe("withoutGrant (PEN-5812)", () => {
    const OTHER_AGENT_ID = "agent-qa-1";
    const otherHref = buildAgentMentionHref(OTHER_AGENT_ID, null);

    it("CONTROL ARM: two bound links, only the non-grantable one is reported", () => {
      // Identical in every respect except which side of the caller's predicate
      // they fall on. `bound` carries both — it has no access to that axis —
      // and `withoutGrant` carries one.
      expect(
        extractMentionBindingReport(`[@Cfo](${boundHref}) and [@Qa](${otherHref})`, {
          boundAgentIds: [BOUND_AGENT_ID, OTHER_AGENT_ID],
          withoutGrantAgentIds: [OTHER_AGENT_ID],
        }),
      ).toEqual({ bound: ["Cfo", "Qa"], unbound: [], withoutGrant: ["Qa"] });
    });

    it("is empty when the caller names nobody", () => {
      expect(
        extractMentionBindingReport(`[@Cfo](${boundHref}) please rule`, opts),
      ).toEqual({ bound: ["Cfo"], unbound: [], withoutGrant: [] });
    });

    it("reduces the name exactly as `bound` does, so the lists stay comparable", () => {
      // Same `boundLabelName` reduction: the @-token is read out of a label
      // carrying prose, and a label with no name in it reports nothing.
      expect(
        extractMentionBindingReport(`[@Cfo — please rule](${boundHref})`, {
          ...opts,
          withoutGrantAgentIds: [BOUND_AGENT_ID],
        }),
      ).toEqual({ bound: ["Cfo"], unbound: [], withoutGrant: ["Cfo"] });
      expect(
        extractMentionBindingReport(`[the CFO](${boundHref})`, {
          ...opts,
          withoutGrantAgentIds: [BOUND_AGENT_ID],
        }),
      ).toEqual({ bound: [], unbound: [], withoutGrant: [] });
    });

    it("dedupes case-insensitively, as both siblings do", () => {
      expect(
        extractMentionBindingReport(`[@Cfo](${boundHref}) and [@cfo](${boundHref})`, {
          ...opts,
          withoutGrantAgentIds: [BOUND_AGENT_ID],
        }),
      ).toEqual({ bound: ["Cfo"], unbound: [], withoutGrant: ["Cfo"] });
    });

    it("ignores an id that did not resolve, so the three lists stay disjoint from `unbound`", () => {
      // A mention that never bound is already reported in `unbound`. Naming it
      // here too would stop the lists partitioning cleanly.
      expect(
        extractMentionBindingReport("@Ceo please rule", {
          boundAgentIds: [],
          withoutGrantAgentIds: ["agent-never-resolved"],
        }),
      ).toEqual({ bound: [], unbound: ["Ceo"], withoutGrant: [] });
    });

    it("a name past the `bound` cap is still reported, so this is NOT a strict subset", () => {
      // The two lists are capped independently. With more distinct resolved
      // names than MAX_UNBOUND_MENTION_TOKENS, a non-grantable name can be
      // pushed out of `bound` and still appear in `withoutGrant`.
      //
      // Deliberate: an extra "this may not have reached anyone" costs one
      // re-send, dropping it costs the coordination path. Gating on `bound`
      // having room would discard the inert-mention warning FIRST at the cap.
      // This test exists so the doc comment cannot quietly re-acquire a
      // "strict subset by construction" claim the code does not honour.
      const ids = Array.from({ length: MAX_UNBOUND_MENTION_TOKENS + 1 }, (_, i) => `agent-${i}`);
      const body = ids
        .map((id, i) => `[@N${i}](${buildAgentMentionHref(id, null)})`)
        .join(" ");
      const last = ids[ids.length - 1]!;
      const report = extractMentionBindingReport(body, {
        boundAgentIds: ids,
        withoutGrantAgentIds: [last],
      });

      expect(report.bound).toHaveLength(MAX_UNBOUND_MENTION_TOKENS);
      expect(report.bound).not.toContain("N20");
      expect(report.withoutGrant).toEqual(["N20"]);
    });

    it("leaves `bound` and `unbound` byte-identical to a call without the option", () => {
      const body = `[@Cfo](${boundHref}) please rule — @Ceo also owns this`;
      const without = extractMentionBindingReport(body, opts);
      const with_ = extractMentionBindingReport(body, {
        ...opts,
        withoutGrantAgentIds: [BOUND_AGENT_ID],
      });
      expect(with_.bound).toEqual(without.bound);
      expect(with_.unbound).toEqual(without.unbound);
      expect(with_.withoutGrant).toEqual(["Cfo"]);
      expect(without.withoutGrant).toEqual([]);
    });
  });
});

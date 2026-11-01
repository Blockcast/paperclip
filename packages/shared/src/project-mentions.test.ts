import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
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

  it("returns nothing for an empty or mention-free body", () => {
    expect(extractUnboundMentionTokens("")).toEqual([]);
    expect(extractUnboundMentionTokens("a comment with no mentions at all")).toEqual([]);
  });
});

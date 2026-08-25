import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { externalWaitFromDescription } from "../services/issues.js";

/**
 * BLO-28618: the external-wait escape hatch was implemented (BLO-24662) but never
 * documented with its required syntax. `doc/execution-semantics.md` told agents to
 * "name the external owner and concrete action" — wording any prose sentence satisfies,
 * while `externalWaitFromDescription` requires two literal `key: value` lines. An agent
 * that read the doc and complied in good faith still evaluated `false` and still got a
 * liveness escalation minted against a deliberately parked issue.
 *
 * A test that only exercised the matcher would not have caught that: the matcher was
 * always correct. The defect lived in the gap between the doc and the matcher, so this
 * test parses the snippet *out of the doc* and feeds it to the real parser. If either
 * side moves without the other, this fails.
 */

const docPath = fileURLToPath(new URL("../../../doc/execution-semantics.md", import.meta.url));

function documentedSnippet(): string {
  const doc = readFileSync(docPath, "utf8");
  const heading = "#### Declaring an external wait";
  const headingIndex = doc.indexOf(heading);
  expect(headingIndex, `"${heading}" is missing from doc/execution-semantics.md`).toBeGreaterThan(-1);

  // Bound the search to this section: stop at the next heading of any level, so a fence
  // added further down the document can never be picked up by mistake.
  const rest = doc.slice(headingIndex + heading.length);
  const nextHeading = rest.search(/\n#{1,6} /);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  // Take the fenced block that actually declares an external wait, rather than whichever
  // fence happens to come first — an unrelated example added above it must not retarget
  // this test onto text the matcher was never meant to accept.
  const fences = [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const snippet = fences.find((body) => /^\s*external owner\s*:/im.test(body));
  expect(
    snippet,
    `no fenced example declaring "external owner:" under "${heading}"`,
  ).toBeTruthy();
  return snippet!;
}

describe("external-wait declaration: doc and matcher agree", () => {
  it("the syntax documented in execution-semantics.md is accepted by the matcher", () => {
    // Substitute the <placeholders> the doc uses, leaving the key/line shape untouched.
    const description = documentedSnippet()
      .replace(/<who must act[^>]*>/, "CTO")
      .replace(/<the concrete action they must take>/, "Approve the ruleset change");

    expect(externalWaitFromDescription(description)).toEqual({
      owner: "CTO",
      action: "Approve the ruleset change",
    });
  });

  it("the prose form the doc warns against is still rejected", () => {
    // The doc explicitly calls this out as non-matching. If the matcher ever grows to
    // accept free prose, the warning becomes wrong and must be rewritten.
    expect(
      externalWaitFromDescription("waiting on the CTO to approve the ruleset change"),
    ).toBeNull();
  });

  it("requires both lines — either alone is not a declaration", () => {
    expect(externalWaitFromDescription("external owner: CTO")).toBeNull();
    expect(externalWaitFromDescription("external action: Approve the ruleset change")).toBeNull();
  });

  it("rejects a value on the line below the key", () => {
    // The doc requires each declaration "on a line of its own". The whitespace around
    // the colon must therefore be horizontal only: `\s*` spans line terminators, which
    // silently accepted a shape the doc calls invalid.
    expect(
      externalWaitFromDescription("external owner:\nCTO\nexternal action: Approve it"),
    ).toBeNull();
    expect(
      externalWaitFromDescription("external owner: CTO\nexternal action:\nApprove it"),
    ).toBeNull();
  });

  it("an empty key does not consume the following declaration", () => {
    // Sharper consequence of the same defect: with a line-spanning `\s*`, an owner key
    // left blank swallowed the *next* line, so this parsed as
    // `{ owner: "external action: Approve it", action: "Approve it" }` — a successful
    // parse carrying a garbage owner, which then reached the redaction path. A blank
    // value is an incomplete declaration and must not match at all.
    expect(
      externalWaitFromDescription("external owner:\nexternal action: Approve it"),
    ).toBeNull();
  });

  it("tolerates the case and leading whitespace the doc promises", () => {
    // The doc claims case-insensitivity and leading space/tab tolerance. Nothing
    // asserted it, so the prose could have drifted from the matcher in the permissive
    // direction as easily as the strict one.
    expect(
      externalWaitFromDescription("\t External Owner :  CTO\n  EXTERNAL ACTION:\tApprove it"),
    ).toEqual({ owner: "CTO", action: "Approve it" });
  });

  it("truncates at the caps the doc documents", () => {
    // The doc now states the 120/240 caps, and those numbers are load-bearing: the
    // parsed values are the needles `redactExternalWaitDescription` strikes out of the
    // blocked-inbox description, so anything past a cap survives redaction verbatim.
    // Without this, editing `slice(0, 120)` would silently make the doc wrong while the
    // suite stayed green — the same doc-vs-code drift this file exists to catch, just
    // moved from prose-vs-parser to number-vs-parser.
    const parsed = externalWaitFromDescription(
      `external owner: ${"A".repeat(200)}\nexternal action: ${"B".repeat(300)}`,
    );
    expect(parsed?.owner).toHaveLength(120);
    expect(parsed?.action).toHaveLength(240);
  });
});

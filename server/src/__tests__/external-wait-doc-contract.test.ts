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

  // First fenced block after the heading is the canonical syntax example.
  const fence = doc.slice(headingIndex).match(/```\n([\s\S]*?)```/);
  expect(fence?.[1], "no fenced syntax example under the external-wait heading").toBeTruthy();
  return fence![1];
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
});

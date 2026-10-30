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

const HEADING = "#### Declaring an external wait";

function documentedSection(): string {
  const doc = readFileSync(docPath, "utf8");
  const headingIndex = doc.indexOf(HEADING);
  expect(headingIndex, `"${HEADING}" is missing from doc/execution-semantics.md`).toBeGreaterThan(-1);

  // Bound the search to this section: stop at the next heading of any level, so a fence
  // added further down the document can never be picked up by mistake.
  const rest = doc.slice(headingIndex + HEADING.length);
  const nextHeading = rest.search(/\n#{1,6} /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function documentedSnippet(): string {
  const section = documentedSection();

  // Take the fenced block that actually declares an external wait, rather than whichever
  // fence happens to come first — an unrelated example added above it must not retarget
  // this test onto text the matcher was never meant to accept.
  const fences = [...section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const snippet = fences.find((body) => /^\s*external owner\s*:/im.test(body));
  expect(
    snippet,
    `no fenced example declaring "external owner:" under "${HEADING}"`,
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

  it("states that the declaration is read only on a `blocked` row", () => {
    // PEN-5065: every mechanical sentence in this section already happened to be scoped
    // to `blocked` — all three consumers are (`isDeadEndBlocked`, the blocked-inbox
    // `external_wait` attention, and the auto-resume suppression) — but the scope was
    // never stated as a rule, so a reader writing the two lines onto a `todo` row had no
    // way to learn they bought nothing. Measured 2026-10-29 across 756 open rows: 12
    // carried a well-formed declaration, 6 of them on a non-`blocked` status.
    //
    // This is a prose assertion rather than a parser one on purpose, and it is the same
    // drift this file exists to catch — just in the one direction a parser test cannot
    // reach. There is no code path to exercise, because the defect IS the absence of
    // feedback: the matcher never sees `status` and never will, so this section is the
    // only thing that can tell an author about the scope. The announcement half is
    // pinned separately in `stranded-blocked-issue-reconciler.test.ts`; the two regress
    // independently, so both are asserted.
    const section = documentedSection();
    expect(section).toMatch(/read only on a `blocked` (issue|row)/i);
    expect(section).toMatch(/\binert\b/i);
  });

  it("names a working instrument for each status the declaration does not cover", () => {
    // Stating the restriction without naming the alternative would convert a silent
    // no-op into a dead end: an agent that has correctly diagnosed a human gate on a
    // `todo` row still needs somewhere to put it. A deliberate park is the general
    // answer, because both strandedness sweeps count one on any status.
    const section = documentedSection();
    for (const status of ["todo", "in_progress", "in_review", "backlog"]) {
      expect(section, `the section does not mention \`${status}\``).toContain(status);
    }
    expect(section).toContain("parkedDisposition");
  });

  it("does not offer a park as the `in_review` review path", () => {
    // The one recommendation in that table that fails on the WRITE path rather than
    // silently, and therefore the one most worth pinning. `assertAgentInReviewReviewPath`
    // (server/src/routes/issues.ts) excludes a live park from the accepted `in_review`
    // review paths deliberately (BLO-33572) — a park asserts nobody is acting on the row,
    // which is the opposite of what `in_review` claims — and its remedy is to park on
    // `todo`/`backlog` instead of moving to review. A park DOES hold an `in_review` row
    // against both strandedness sweeps, which is exactly why the wrong advice looks
    // right; the doc has to name the write-side refusal or a reader will reach for it.
    const section = documentedSection();
    const inReviewRow = section
      .split("\n")
      .find((line) => line.startsWith("| `in_review`"));
    expect(inReviewRow, "no `in_review` row in the per-status instrument table").toBeTruthy();
    expect(inReviewRow!).toMatch(/not a park/i);
    // ...and at least one path the write-side gate actually accepts.
    expect(inReviewRow!).toMatch(/interaction|approval|assigneeUserId|currentParticipant/);
  });

  it("truncates at the caps the doc documents", () => {
    // The doc now states the 120/240 caps, and those numbers are load-bearing: the
    // parsed values are the needles `redactExternalWaitDescription` strikes out of the
    // blocked-inbox description, so anything past a cap survives redaction verbatim.
    // Without this, editing `slice(0, 120)` would silently make the doc wrong while the
    // suite stayed green — the same doc-vs-code drift this file exists to catch, just
    // moved from prose-vs-parser to number-vs-parser.
    const owner = Array.from({ length: 200 }, (_, index) => String(index % 10)).join("");
    const action = Array.from({ length: 300 }, (_, index) => String((index + 3) % 10)).join("");
    const parsed = externalWaitFromDescription(
      `external owner: ${owner}\nexternal action: ${action}`,
    );
    expect(parsed?.owner).toBe(owner.slice(0, 120));
    expect(parsed?.action).toBe(action.slice(0, 240));
  });
});

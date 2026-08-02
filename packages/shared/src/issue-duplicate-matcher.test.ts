import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clusterIssueDuplicates,
  describeIssueDuplicateCandidate,
  extractIssueDuplicateFeatures,
  findIssueDuplicateCandidates,
  type IssueDuplicateDocument,
} from "./issue-duplicate-matcher.js";

/**
 * The four real filings of the monitor defect from 2026-07-29 (BLO-18799).
 * Titles and descriptions are verbatim from the database so the regression is
 * anchored to the actual incident rather than a paraphrase of it.
 */
interface FilingFixture {
  identifier: string;
  title: string;
  description: string;
  createdAt: string;
}

const filings: FilingFixture[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/issue-duplicate-monitor-filings.json", import.meta.url)),
    "utf8",
  ),
) as FilingFixture[];

const asDocument = (filing: FilingFixture): IssueDuplicateDocument => ({
  id: filing.identifier,
  identifier: filing.identifier,
  title: filing.title,
  description: filing.description,
});

/**
 * Unrelated-but-same-project issues. These share the Paperclip vocabulary
 * (agent, issue, run, server test, acceptance criteria) and the same issue
 * template, which is exactly the false-positive shape the guard must survive.
 */
const distractors: IssueDuplicateDocument[] = [
  {
    id: "distractor-ui-density",
    identifier: "BLO-17001",
    title: "Issue list rows wrap at 1280px, hiding the assignee avatar column",
    description: [
      "The issue list table in `ui/src/pages/IssueList.tsx` wraps its trailing columns",
      "below 1280px viewport width, so the assignee avatar and priority chip drop out of",
      "view. `IssueRow` sets a fixed `min-width` on the title cell which forces the",
      "overflow.",
      "",
      "## Acceptance criteria",
      "- Assignee avatar and priority chip stay visible down to 1024px.",
      "- No horizontal scrollbar appears on the issue list at 1024px.",
      "",
      "## Verifying signal",
      "- Server test is not applicable; add a `ui` snapshot test at 1024px and 1280px.",
      "- Manual: load /BLO/issues at both widths and confirm the columns render.",
    ].join("\n"),
  },
  {
    id: "distractor-worker-backoff",
    identifier: "BLO-17002",
    title: "Worker retry backoff resets on process restart, hammering the adapter",
    description: [
      "`server/src/services/workers.ts` keeps retry backoff state in memory, so a worker",
      "restart resets `attemptCount` to zero and the adapter gets retried immediately.",
      "Under a crashloop this produces a request storm against the adapter endpoint.",
      "",
      "The backoff schedule should be derived from a persisted `nextAttemptAt` column",
      "instead of an in-process counter.",
      "",
      "## Acceptance criteria",
      "- Backoff survives a worker restart: `nextAttemptAt` is read from the database.",
      "- A crashlooping worker issues at most one adapter request per backoff window.",
      "",
      "## Verifying signal",
      "- Server test asserting backoff is preserved across a simulated restart.",
      "- Dashboard: adapter request rate stays flat during a worker rollout.",
    ].join("\n"),
  },
  {
    id: "distractor-label-filter",
    identifier: "BLO-17003",
    title: "Label filter on the issue list ignores labels applied at creation time",
    description: [
      "Filtering the issue list by label misses issues whose `labelIds` were supplied to",
      "`paperclipCreateIssue` at creation, because `syncIssueLabels` runs after the",
      "response is returned and the filter reads a stale materialized column.",
      "",
      "## Acceptance criteria",
      "- An issue created with `labelIds` appears under that label filter immediately.",
      "",
      "## Verifying signal",
      "- Server test creating an issue with `labelIds` then filtering by that label.",
    ].join("\n"),
  },
];

describe("extractIssueDuplicateFeatures", () => {
  it("classifies symbols, paths, references and prose terms", () => {
    const features = extractIssueDuplicateFeatures({
      title: "`paperclipUpdateIssue` drops the monitor param",
      description: [
        "See `server/src/routes/issues.ts:8242` and BLO-18168, plus PR #806.",
        "The nested `executionPolicy.monitor` shape persists correctly.",
      ].join("\n"),
    });

    expect(features.get("paperclipupdateissue")).toBe("symbol");
    expect(features.get("executionpolicy.monitor")).toBe("symbol");
    // Dotted symbols also contribute their trailing component.
    expect(features.get("monitor")).toBe("symbol");
    // Line numbers are stripped so two issues citing different lines still match.
    expect(features.get("server/src/routes/issues.ts")).toBe("path");
    expect(features.get("blo-18168")).toBe("reference");
    expect(features.get("#806")).toBe("reference");
    expect(features.get("nested")).toBe("term");
  });

  it("does not treat prose slashes or bare short words as paths or symbols", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Either and/or is fine",
      description: "Runs 24/7 with no issue.",
    });
    expect(features.has("and/or")).toBe(false);
    expect(features.has("24/7")).toBe(false);
  });

  /**
   * Regression: the inline span `` `monitor` `` used to be erased outright. The
   * fenced-block language-tag pattern consumed the opening backtick plus the
   * all-letters body, and the closing replacement removed the remaining
   * backtick, so lowercase inline identifiers never reached the symbol class —
   * the exact tokens this defect class is recognised by.
   */
  it("keeps a lowercase inline identifier as a symbol", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Re-arm ignored once the monitor is `triggered`",
      description: "The `monitor` stays null even after a `scheduled` write lands.",
    });

    expect(features.get("monitor")).toBe("symbol");
    expect(features.get("triggered")).toBe("symbol");
    expect(features.get("scheduled")).toBe("symbol");
  });

  it("keeps a multi-backtick inline span as symbol evidence", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Retry leaves the inline monitor unchanged",
      description: "The span ```` ```monitor``` ```` is inline code, not a fenced block.",
    });

    expect(features.get("monitor")).toBe("symbol");
  });

  it("drops a fenced block's language tag without swallowing its body", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Read-back is null",
      description: ["```typescript", "const monitorNextCheckAt = null;", "```"].join("\n"),
    });

    expect(features.get("monitornextcheckat")).toBe("symbol");
    // The info string is markup, not evidence: it must not become a symbol.
    expect(features.get("typescript")).not.toBe("symbol");
  });

  it("drops a fenced block's full info string without turning it into symbol evidence", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Read-back is still null",
      description: ["```ts filename=handler.ts", "const monitorNextCheckAt = null;", "```"].join("\n"),
    });

    expect(features.get("monitornextcheckat")).toBe("symbol");
    expect(features.get("ts")).not.toBe("symbol");
    expect(features.get("handler.ts")).not.toBe("symbol");
  });

  it("does not close a longer fenced block on a shorter backtick line", () => {
    const features = extractIssueDuplicateFeatures({
      title: "Nested fence marker remains code",
      description: [
        "````ts",
        "const beforeShortFence = true;",
        "```",
        "const afterShortFence = true;",
        "````",
      ].join("\n"),
    });

    expect(features.get("beforeshortfence")).toBe("symbol");
    expect(features.get("aftershortfence")).toBe("symbol");
    expect(features.get("ts")).not.toBe("symbol");
  });

  it("handles many unmatched fenced-code openers in bounded time", () => {
    const description = Array.from({ length: 8_000 }, () => "```ts").join("\n");

    const started = performance.now();
    const features = extractIssueDuplicateFeatures({
      title: "Malformed unmatched code fences",
      description,
    });
    const elapsedMs = performance.now() - started;

    expect(features.get("malformed")).toBe("term");
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("handles an unmatched inline backtick run in bounded time", () => {
    const description = "`".repeat(1_200);

    const started = performance.now();
    const features = extractIssueDuplicateFeatures({
      title: "Malformed inline code run",
      description,
    });
    const elapsedMs = performance.now() - started;

    expect(features.get("malformed")).toBe("term");
    expect(features.get("inline")).toBe("term");
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe("findIssueDuplicateCandidates — the four real monitor filings", () => {
  it("has all four filings in the fixture", () => {
    expect(filings.map((filing) => filing.identifier).sort()).toEqual([
      "BLO-18168",
      "BLO-18782",
      "BLO-18783",
      "BLO-18790",
    ]);
  });

  it("clusters all four filings as a single duplicate group", () => {
    const clusters = clusterIssueDuplicates([...filings.map(asDocument), ...distractors]);

    expect(clusters).toHaveLength(1);
    expect([...clusters[0]!.identifiers].sort()).toEqual([
      "BLO-18168",
      "BLO-18782",
      "BLO-18783",
      "BLO-18790",
    ]);
  });

  it.each([1, 2, 3])(
    "flags filing #%i+1 as a duplicate of every earlier filing",
    (index) => {
      const subject = asDocument(filings[index]!);
      const corpus = [...filings.slice(0, index).map(asDocument), ...distractors];

      const { candidates } = findIssueDuplicateCandidates(subject, corpus);

      const flagged = candidates.map((candidate) => candidate.identifier).sort();
      const earlier = filings.slice(0, index).map((filing) => filing.identifier).sort();
      expect(flagged).toEqual(earlier);
    },
  );

  it("explains a match with the shared evidence tokens", () => {
    const subject = asDocument(filings[3]!);
    const { candidates } = findIssueDuplicateCandidates(subject, [
      asDocument(filings[0]!),
      ...distractors,
    ]);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    const tokens = candidate!.sharedFeatures.map((feature) => feature.token);
    // The evidence that title matching could never see.
    expect(tokens).toContain("monitornextcheckat");
    expect(describeIssueDuplicateCandidate(candidate!)).toContain("BLO-18168");
  });
});

describe("findIssueDuplicateCandidates — precision", () => {
  it("does not flag distinct issues that share a project and vocabulary", () => {
    for (const subject of distractors) {
      const corpus = [
        ...distractors.filter((entry) => entry.id !== subject.id),
        ...filings.map(asDocument),
      ];
      const { candidates } = findIssueDuplicateCandidates(subject, corpus);
      expect(
        candidates.map((candidate) => candidate.identifier),
        `${subject.identifier} should not match anything`,
      ).toEqual([]);
    }
  });

  it("returns no candidates against an empty corpus", () => {
    expect(findIssueDuplicateCandidates(asDocument(filings[0]!), []).candidates).toEqual([]);
  });

  it("never matches a document against itself", () => {
    const document = asDocument(filings[0]!);
    expect(findIssueDuplicateCandidates(document, [document]).candidates).toEqual([]);
  });
});

/**
 * Regression: feature classes must stay per-document.
 *
 * Classifying a token at the strongest class *any* document in the window gave
 * it let one author's formatting reclassify that word everywhere. Two issues
 * overlapping only in prose could then clear both the score threshold and
 * `minSharedDistinctiveFeatures` on the strength of a third, unrelated issue —
 * breaking the stated invariant that prose overlap alone can never match.
 *
 * Against the pre-fix matcher the pair below scored 0.66 with 8 "distinctive"
 * features, every one of them a prose word promoted by `codeMarker`.
 */
describe("findIssueDuplicateCandidates — distinctive features are pair-local", () => {
  const shared = "request handler payload response timeout retry window closes";

  /** Two unrelated issues whose only overlap is the generic prose above. */
  const proseOnlyA: IssueDuplicateDocument = {
    id: "prose-a",
    identifier: "BLO-17101",
    title: "Billing export drops the trailing month",
    description: `The billing export skips a month whenever the ${shared} mid-cycle, so the report is short.`,
  };
  const proseOnlyB: IssueDuplicateDocument = {
    id: "prose-b",
    identifier: "BLO-17102",
    title: "Avatar upload rejects large images",
    description: `The avatar upload rejects a image whenever the ${shared} mid-cycle, so the report is short.`,
  };

  /** A third, unrelated issue that happens to list those words as code. */
  const codeMarker: IssueDuplicateDocument = {
    id: "code-marker",
    identifier: "BLO-17103",
    title: "Adapter contract review",
    description: ["```", ...shared.split(" "), "```"].join("\n"),
  };

  it("does not match on prose alone", () => {
    const { candidates } = findIssueDuplicateCandidates(proseOnlyA, [proseOnlyB]);
    expect(candidates.map((candidate) => candidate.identifier)).toEqual([]);
  });

  it("does not let a third issue's code block promote that prose into evidence", () => {
    const { candidates } = findIssueDuplicateCandidates(proseOnlyA, [proseOnlyB, codeMarker]);
    expect(candidates.map((candidate) => candidate.identifier)).toEqual([]);
  });

  it("still counts a token both sides marked as code", () => {
    const withCode = (document: IssueDuplicateDocument): IssueDuplicateDocument => ({
      ...document,
      description: `${document.description}\n${codeMarker.description}`,
    });
    const { candidates } = findIssueDuplicateCandidates(withCode(proseOnlyA), [
      withCode(proseOnlyB),
    ]);
    const [candidate] = candidates;
    expect(candidate?.identifier).toBe("BLO-17102");
    expect(candidate!.sharedDistinctiveFeatureCount).toBeGreaterThanOrEqual(5);
  });
});

describe("anti-vacuity: the previous title-only matcher fails these cases", () => {
  /** The pre-BLO-18799 guard, reproduced verbatim in behaviour. */
  const normalizeTitle = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();
  const titleOnlyMatches = (a: FilingFixture, b: FilingFixture) =>
    normalizeTitle(a.title) === normalizeTitle(b.title);

  it("finds no duplicate among the four filings by normalized title", () => {
    const pairs = filings.flatMap((left, i) =>
      filings.slice(i + 1).map((right) => titleOnlyMatches(left, right)),
    );
    expect(pairs).toHaveLength(6);
    expect(pairs.some(Boolean)).toBe(false);
  });

  it("would therefore have created all four issues", () => {
    const created: FilingFixture[] = [];
    for (const filing of filings) {
      if (!created.some((existing) => titleOnlyMatches(existing, filing))) created.push(filing);
    }
    expect(created).toHaveLength(4);
  });
});

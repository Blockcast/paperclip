/**
 * Tests for the GitHub webhook receiver. Two layers:
 *   - Pure functions (identifier extraction, signature verification,
 *     event-context resolution) — no DB.
 *   - Full route integration (Express handler + DB + heartbeat wake).
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  issueWorkProducts,
  POSTGRES_POOL_MAX,
} from "@paperclipai/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  __test_backLinkAbsoluteUrl,
  __test_buildDependabotAlertIssueBody,
  __test_buildIssueBackLinkBody,
  __test_buildPrReviewerTaskKey,
  __test_buildPrReviewerWakeIdempotencyKey,
  __test_buildPrReviewFeedbackComment,
  __test_classifyWorkflowRunSupersession,
  __test_commentsContainBackLinkMarker,
  __test_extractPaperclipIdentifiers,
  __test_hasActionablePrReviewFeedback,
  __test_isClaudeCodeReviewServiceNotice,
  __test_isReviewerSelfEchoReview,
  __test_isSelfReviewedPr,
  __test_hasPrReviewerRequestMention,
  __test_hasPrReviewerAgentRequestMarker,
  __test_hasAllyConsolidatedReviewHeading,
  __test_hasAllyConsolidatedReviewHeader,
  __test_idempotentWakeStatuses,
  __test_prReviewerWakeIdempotencyScope,
  __test_recordWorkflowRunSighting,
  __test_resolvePrCommentReviewGateWebhookTrigger,
  __test_resolveDependabotAlertContext,
  __test_resolveEventContext,
  __test_shouldFirePrReviewerWake,
  __test_verifyGithubSignature,
  __resetWorkflowRunSupersessionTrackingForTest,
  derivePrReviewerWakeMaxConcurrency,
  githubWebhookRoutes,
  reconcileContendedPrReviewerWakes,
  type GithubWebhookConfig,
} from "../routes/github-webhook.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  GITHUB_REVIEW_REQUEST_DELIVERY_METRIC,
  GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC,
  __resetMetricsForTest,
  getMetricsRegistry,
} from "../services/metrics.js";
import {
  resolveLinkSourceForIdentifier,
  resolveOwningPaperclipIdentifiers,
} from "../services/paperclip-identifiers.js";
import { PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID } from "../services/pull-request-work-products.js";
import { issueService } from "../services/issues.js";
import { errorHandler } from "../middleware/index.js";

/**
 * Sum {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} across every `reason`
 * series for one funnel state (BLO-18859).
 */
async function deliveryCount(state: string): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_DELIVERY_METRIC);
  if (!metric) throw new Error(`${GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} is not registered`);
  const data = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values
    .filter((entry) => entry.labels.state === state)
    .reduce((sum, entry) => sum + entry.value, 0);
}

/**
 * Sum {@link GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} for one suppression
 * cause, or across all causes when omitted (BLO-18859 review follow-up).
 */
async function suppressionCount(cause?: string): Promise<number> {
  const metric = getMetricsRegistry().getSingleMetric(GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC);
  if (!metric) throw new Error(`${GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC} is not registered`);
  const data = (await metric.get()) as {
    values: Array<{ labels: Record<string, string>; value: number }>;
  };
  return data.values
    .filter((entry) => cause === undefined || entry.labels.cause === cause)
    .reduce((sum, entry) => sum + entry.value, 0);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping GitHub webhook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("github-webhook pure helpers", () => {
  it("extracts paperclip identifiers from branch / title / body", () => {
    expect(__test_extractPaperclipIdentifiers("fix/BLO-3182-webflow-blog")).toEqual(["BLO-3182"]);
    expect(__test_extractPaperclipIdentifiers(null, "Fix BLO-3182: missing handler", undefined)).toEqual(["BLO-3182"]);
    // Multiple in body, deduped.
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182 and PCL-44")).toEqual(["BLO-3182", "PCL-44"]);
    expect(__test_extractPaperclipIdentifiers("Closes BLO-3182/3183 and PC1A2-7/8")).toEqual([
      "BLO-3182",
      "BLO-3183",
      "PC1A2-7",
      "PC1A2-8",
    ]);
    // 4-letter prefixes match (XBLO is itself a valid identifier shape;
    // paperclip company prefixes can be 2-10 letters). The lookup
    // against issues.identifier disambiguates -- only real prefixes
    // turn into wakes.
    expect(__test_extractPaperclipIdentifiers("XBLO-3182")).toEqual(["XBLO-3182"]);
    // But mid-word matches don't fire.
    expect(__test_extractPaperclipIdentifiers("frontend-X-44")).toEqual([]);
    // Punctuation around match is fine.
    expect(__test_extractPaperclipIdentifiers("(BLO-3182): work")).toEqual(["BLO-3182"]);
  });

  it("resolves the PR's OWNING identifier as title > labeled Fixes:/Closes:/Refs: body line > branch, never a bare Related: mention (BLO-20886)", () => {
    // Title outranks everything else.
    expect(
      resolveOwningPaperclipIdentifiers({
        branch: "fix/BLO-9-stale-branch",
        title: "fix BLO-1 thing",
        body: "Refs: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });

    // No title ref: a labeled body line outranks the branch. This ordering is
    // load-bearing -- branches get repurposed, so a branch ref goes stale
    // while the curated title/body stays current (observed: #909's branch says
    // blo-20049 while both its title and body name BLO-20467, the issue it
    // actually fixes). Ranking the branch above them would reintroduce this
    // ticket's own defect.
    expect(
      resolveOwningPaperclipIdentifiers({
        branch: "fix/blo-20049-stale-branch",
        title: "fix(alertmanager-plugin): resolve webhook token per delivery",
        body: "- Fixes: BLO-20467",
      }),
    ).toEqual({ owning: ["BLO-20467"] });

    // Branch is the LAST resort, and matches case-insensitively so that a
    // conventional lowercase branch resolves at all -- the identifier pattern
    // is uppercase-only, which left the branch tier inert and failed 24 of 175
    // recent PRs closed to `no_owning_reference`, dropping author wakes that
    // should have been delivered.
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "sre/blo-20886-pr-review-wake-routing" }),
    ).toEqual({ owning: ["BLO-20886"] });
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "qa/blo-21079-master-artifact" }),
    ).toEqual({ owning: ["BLO-21079"] });
    // ...but only when nothing curated resolved: a `Related:`-only body still
    // does not promote a Related: entry, and the branch answers instead.
    expect(
      resolveOwningPaperclipIdentifiers({
        branch: "fix/blo-1-thing",
        body: "Related: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });

    // No branch/title: a Fixes:/Closes:/Resolves:/Refs: labeled line counts,
    // colon optional -- this repo's own PR bodies use both "Closes: BLO-1"
    // and the natural-language "Closes BLO-1 and BLO-2" (multiple owners).
    expect(
      resolveOwningPaperclipIdentifiers({ body: "Fixes: BLO-1" }),
    ).toEqual({ owning: ["BLO-1"] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: "Closes BLO-1 and BLO-2" }),
    ).toEqual({ owning: ["BLO-1", "BLO-2"] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: "closed: BLO-1" }),
    ).toEqual({ owning: ["BLO-1"] }); // case-insensitive, closing-keyword variant

    // The exact incident shape: Refs: wins, Related: never counts as owning.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Refs:    BLO-19132\nRelated: BLO-20810, BLO-20129, BLO-19079\n",
      }),
    ).toEqual({ owning: ["BLO-19132"] });

    // A bare Related: list with no owning line at all resolves to nothing --
    // not to the first (or any) Related: entry.
    expect(
      resolveOwningPaperclipIdentifiers({ body: "Related: BLO-20810, BLO-20129" }),
    ).toEqual({ owning: [] });

    // Nothing anywhere.
    expect(resolveOwningPaperclipIdentifiers({})).toEqual({ owning: [] });
  });

  it("treats a markdown-bulleted owning reference as owning -- the PR template's own house style (BLO-20886)", () => {
    // .github/PULL_REQUEST_TEMPLATE.md renders "## Linked Issues or Issue
    // Description" as a bullet list, so real PR bodies in this repo write
    // `- Refs: BLO-1`, not a bare `Refs: BLO-1` line. An earlier revision of
    // this rule anchored the keyword to the start of the line and therefore
    // matched nothing on the majority of real bodies, failing every such PR
    // closed to `no_owning_reference` and dropping an author wake that should
    // have been delivered. Each of these is a real formatting shape.
    for (const body of [
      "- Refs: BLO-1",
      "* Refs: BLO-1",
      "+ Fixes: BLO-1",
      "1. Closes: BLO-1",
      "  - Resolves: BLO-1", // indented sub-bullet
      "- Refs: [BLO-1](https://paperclip.blockcast.net/BLO/issues/BLO-1)", // markdown link
    ]) {
      expect(resolveOwningPaperclipIdentifiers({ body })).toEqual({ owning: ["BLO-1"] });
    }

    // A bulleted Related: is still never owning -- the list marker must not
    // become a way to smuggle an informational mention into the owning tier.
    expect(
      resolveOwningPaperclipIdentifiers({ body: "- Related: BLO-2, BLO-3" }),
    ).toEqual({ owning: [] });

    // PR #953's body verbatim (trimmed to the section that matters): a
    // bulleted `Refs:` owner alongside a bulleted `Related:` list. This is the
    // shape the live misroute actually had -- the pre-existing test above uses
    // a synthesized bare-line form that does not reproduce it.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: [
          "## Linked Issues or Issue Description",
          "",
          "- Refs: [BLO-19132](https://paperclip.blockcast.net/BLO/issues/BLO-19132)",
          "- Supersedes: #945",
          "- Related: [BLO-20810](https://paperclip.blockcast.net/BLO/issues/BLO-20810), [BLO-20129](https://paperclip.blockcast.net/BLO/issues/BLO-20129), [BLO-19079](https://paperclip.blockcast.net/BLO/issues/BLO-19079)",
        ].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-19132"] });
  });

  it("ignores owning-looking Markdown code and trailing non-owning labels (BLO-20886)", () => {
    expect(
      resolveOwningPaperclipIdentifiers({
        body: [
          "```md",
          "Refs: BLO-2",
          "```",
          "~~~",
          "Fixes: BLO-3",
          "~~~~",
          "    Closes: BLO-4",
          "\tResolves: BLO-5",
          "Refs: BLO-1; Related: BLO-6",
        ].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-1"] });

    expect(
      resolveOwningPaperclipIdentifiers({
        body: "```\nRefs: BLO-2\n```\n    Fixes: BLO-3",
      }),
    ).toEqual({ owning: [] });
  });

  it("does not let a list-prefixed pseudo-closer reopen a fence (BLO-20886)", () => {
    // A closing fence admits only the marker run and whitespace. The OPENING
    // grammar tolerates a list marker (a fence nested in a list item is
    // ordinary Markdown), and reusing it to detect the close meant a `- ``` `
    // line -- which CommonMark renders as fenced CONTENT -- ended the block
    // early and exposed the following example as an ownership claim.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```", "- ```", "Refs: BLO-777", "```"].join("\n"),
      }),
    ).toEqual({ owning: [] });

    // Same for a numbered-list prefix, and for a tilde fence.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["~~~", "1. ~~~", "Fixes: BLO-778", "~~~"].join("\n"),
      }),
    ).toEqual({ owning: [] });

    // The genuine closer still closes: an owning line AFTER a real fence is
    // owning, so this did not simply wedge every fence open.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```", "Refs: BLO-2", "```", "Refs: BLO-1"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-1"] });
  });

  it("closes a fence indented by its list container, without loosening a root fence (BLO-20886)", () => {
    // CommonMark measures a closing fence's three-space allowance from the
    // fence's CONTAINER, not from column zero. Bounding it at three raw spaces
    // meant a fence opened inside a list item never closed: the scanner
    // swallowed the rest of the body and suppressed every genuinely visible
    // owning line after it, dropping a wake that should have been delivered.
    //
    // Every expectation here was checked against a real CommonMark
    // implementation (marked 16.4.2) rather than read off the spec.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["- outer", "  - inner:", "", "  ```md", "  Refs: BLO-999", "    ```", "", "Refs: BLO-555"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-555"] });

    // A fence opened on its own list-marker line closes at the item's content
    // indent.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["- ```md", "  Refs: BLO-999", "  ```", "", "Refs: BLO-555"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-555"] });

    // The counter-case that keeps this from becoming a leak: with NO list
    // container, a four-space `` ``` `` is fenced content, not a closer, so the
    // fence stays open and everything after it stays unowning. marked agrees --
    // it renders BLO-555 inside the code block. This is the fail-closed
    // direction and must not regress into an early close.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```md", "Refs: BLO-999", "    ```", "", "Refs: BLO-555"].join("\n"),
      }),
    ).toEqual({ owning: [] });

    // Same when the opener carries its own 1-3 spaces but no container: the
    // allowance does not grow with the opener's own indent, only with the
    // container's.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["   ```md", "   Refs: BLO-999", "    ```", "", "Refs: BLO-555"].join("\n"),
      }),
    ).toEqual({ owning: [] });
  });

  it("treats mixed space-tab indentation as code by expanded columns (BLO-20886)", () => {
    // CommonMark expands tabs to 4-column stops, so ` \t`, `  \t` and `   \t`
    // are all four columns of indent -- an indented code block, exactly like
    // `    `. Matching only the two literal prefixes `\t` and `    ` left the
    // mixed forms eligible to declare an owner from inside a code example.
    for (const indent of [" \t", "  \t", "   \t", "\t", "    ", "     "]) {
      expect(
        resolveOwningPaperclipIdentifiers({ body: `${indent}Refs: BLO-888` }),
      ).toEqual({ owning: [] });
    }

    // Up to three columns is still a normal line, not code.
    for (const indent of ["", " ", "  ", "   "]) {
      expect(
        resolveOwningPaperclipIdentifiers({ body: `${indent}Refs: BLO-1` }),
      ).toEqual({ owning: ["BLO-1"] });
    }
  });

  it("hides house-reference labels inside code, comments and indents (BLO-21312/BLO-20886)", () => {
    // The house tier was added last and scanned the RAW body, so it skipped
    // the fence/comment/indent filtering the closing-keyword tier already had.
    // An `Issue:` line that renders as nothing -- or as a quoted example --
    // could therefore route an author-directed "push a follow-up commit" wake
    // to an issue no reader of the PR would call its owner.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["```", "Issue: BLO-111", "```"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["<!--", "Issue: BLO-222", "-->"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: "    Paperclip task: BLO-333" }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: "  \tPaperclip issue: BLO-334" }),
    ).toEqual({ owning: [] });

    // A fenced example does not suppress a real house label elsewhere.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```", "Issue: BLO-111", "```", "Issue: BLO-1"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-1"] });
  });

  it("measures the indented-code threshold from the list container (BLO-23893)", () => {
    // The four-column code threshold is relative to the enclosing CONTAINER,
    // exactly as the closing-fence allowance already was. A list continuation
    // expands to four RAW columns while sitting only two columns inside the
    // item's content, so measuring from column zero threw away an ordinary
    // visible paragraph as "code" and lost the owner it declared. marked 16.4.2
    // renders this as `<li>item\n   Refs: BLO-1</li>` -- a paragraph, no <pre>.
    expect(
      resolveOwningPaperclipIdentifiers({ body: "- item\n \tRefs: BLO-1" }),
    ).toEqual({ owning: ["BLO-1"] });

    // The counter-cases that keep this from becoming a leak. Four columns PAST
    // the container is still code, at root and at depth -- marked renders both
    // inside <pre><code>. This is the direction that matters: the relative
    // measurement must not make genuinely-fenced-off text eligible to own.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["- item", "", "      Refs: BLO-999"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["- a", "  - b", "", "        Refs: BLO-999"].join("\n"),
      }),
    ).toEqual({ owning: [] });

    // With no container at all the threshold is unchanged from column zero, so
    // the BLO-20886 mixed space-tab case above does not regress.
    expect(
      resolveOwningPaperclipIdentifiers({ body: "  \tRefs: BLO-999" }),
    ).toEqual({ owning: [] });
  });

  it("does not open an HTML comment from an indented-code delimiter (BLO-23893)", () => {
    // Comment state used to advance before the indented-code early-out, so a
    // `    <!--` -- which CommonMark renders literally, escaped, inside
    // <pre><code> -- opened a comment that then swallowed every following
    // VISIBLE line up to the next `-->`, suppressing an owner a reader of the
    // PR can plainly see. Fail-closed, but still a dropped wake.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["    <!--", "Issue: BLO-1"].join("\n") }),
    ).toEqual({ owning: ["BLO-1"] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["    <!--", "Refs: BLO-2"].join("\n") }),
    ).toEqual({ owning: ["BLO-2"] });

    // The converse must hold too: indentation does not create a code block
    // INSIDE an open HTML block, so an indented `-->` still closes the comment
    // rather than wedging it open forever. marked closes it here.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["<!--", "    hidden -->", "Issue: BLO-3"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-3"] });

    // And the fail-closed guarantees are untouched: a real comment still hides
    // its body, an unterminated one still swallows the rest, and a comment
    // opened on a fence-opener line still hides its own body.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["<!--", "Issue: BLO-999", "-->"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["<!--", "Issue: BLO-999"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```x <!--", "```", "Issue: BLO-999", "-->"].join("\n"),
      }),
    ).toEqual({ owning: [] });
  });

  it("does not manufacture a branch owner from a version number (BLO-20886)", () => {
    // Uppercasing a whole branch to match the uppercase-only identifier
    // pattern also turns ordinary words-followed-by-a-number into
    // "identifiers". Measured over the 200 most recently-updated PRs in this
    // repo, that invented UNDICI-7, URI-3, ADDRESS-10, PR-870, FOLD-977 and
    // EXPANSION-5. A spurious owner is not harmless: it hands an
    // author-directed "push a follow-up commit" wake to whoever is assigned
    // the same-named issue, which is this ticket's own defect.
    for (const branch of [
      "blo-21612-undici-7.29.0",
      "blo-21611-fast-uri-3.1.5",
      "blo-21613-ip-address-10.3.1",
      "blo-21610-brace-expansion-5.0.9",
      "sre/blo-20867-fold-977-metrics",
    ]) {
      const { owning } = resolveOwningPaperclipIdentifiers({ branch });
      expect(owning).toHaveLength(1);
      expect(owning[0]).toMatch(/^BLO-\d+$/);
    }

    // A branch carrying no ref at all still resolves nothing, rather than
    // coining one from a trailing digit.
    expect(resolveOwningPaperclipIdentifiers({ branch: "relay-wave-0" })).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "migration-members-page" }),
    ).toEqual({ owning: [] });

    // The real ref still resolves, at the branch start or after any `/`.
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "sre/blo-20886-pr-review-wake-routing" }),
    ).toEqual({ owning: ["BLO-20886"] });
    expect(resolveOwningPaperclipIdentifiers({ branch: "blo-21610-thing" })).toEqual({
      owning: ["BLO-21610"],
    });
  });

  it("does not manufacture a branch owner from a Dependabot path (BLO-20886 round 6)", () => {
    // The segment anchor alone only discriminates when the package name sits
    // MID-segment (`blo-21612-undici-7.29.0`). Dependabot puts it at the START
    // of a segment, so `undici-7` clears the anchor and the following `.`
    // supplies the word boundary -- the leak the anchor was believed to close.
    // Each of these manufactured an owner before the version-continuation
    // guard, and each would route a dependency PR's author wake to whoever is
    // assigned the same-named issue.
    for (const branch of [
      "dependabot/npm_and_yarn/undici-7.29.0",
      "dependabot/npm_and_yarn/types/node-20.11.5",
      "dependabot/github_actions/actions/checkout-4.2.0",
      "dependabot/npm_and_yarn/fast-uri-3.1.5",
    ]) {
      expect(resolveOwningPaperclipIdentifiers({ branch })).toEqual({ owning: [] });
    }

    // The guard keys on `.` + any word character, which never occurs inside a
    // real ref. Real refs continue with `-`, `/` or end, so no shape regresses.
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "cto/blo-20886-round5-ownership-leaks" }),
    ).toEqual({ owning: ["BLO-20886"] });
    expect(resolveOwningPaperclipIdentifiers({ branch: "sre/blo-20886" })).toEqual({
      owning: ["BLO-20886"],
    });
  });

  it("does not manufacture a branch owner from a wildcard version or a bot namespace (BLO-20886 round 7)", () => {
    // A `.<digit>` guard left WILDCARD versions live. A dependency PR names no
    // issue in its title or body, so the branch tier is the only one consulted
    // and a manufactured token would be the PR's SOLE owner.
    for (const branch of ["renovate/node-20.x", "renovate/undici-7.x", "bump-undici-7.29.0"]) {
      expect(resolveOwningPaperclipIdentifiers({ branch })).toEqual({ owning: [] });
    }

    // A version guard cannot be the whole answer, and this is the measurement
    // that shows it: these carry NO version suffix for the guard to key on, yet
    // still manufactured `NODE-20` / `UNDICI-7`. Skipping the two reserved bot
    // namespaces is what closes them -- a dependency bot names its branch after
    // the package it bumps, so nothing in one is an ownership claim.
    for (const branch of [
      "renovate/node-20",
      "dependabot/npm_and_yarn/undici-7",
      "renovate/blo-1-not-an-owner",
    ]) {
      expect(resolveOwningPaperclipIdentifiers({ branch })).toEqual({ owning: [] });
    }

    // Ordinary branches keep their refs, including the sub-issue `/` form.
    expect(resolveOwningPaperclipIdentifiers({ branch: "kkroo/blo-19132-approval-dedupe-v2" })).toEqual({
      owning: ["BLO-19132"],
    });
    expect(
      resolveOwningPaperclipIdentifiers({ branch: "blo-21610-brace-expansion-5.0.9" }),
    ).toEqual({ owning: ["BLO-21610"] });
  });

  it("classifies a lowercase branch-only owner as branch_ref, not body_ref (BLO-20886 round 6)", () => {
    // Ownership accepts a lowercase branch case-insensitively, but link-source
    // classification used the uppercase-only broad extractor, so the very shape
    // branchTemplate produces resolved to nothing here and fell through to
    // `body_ref`. With a related issue also named in the body, both candidates
    // then carried equal strength and insertion order decided which one a
    // merged PR was persisted against -- losing the authoritative branch owner
    // to a bare `Related:` mention.
    const fields = {
      branch: "cto/blo-20886-round5-ownership-leaks",
      title: "fix(github-webhook): close ownership-parsing leaks",
      body: "Refs: BLO-20886\nRelated: BLO-19132",
    };
    expect(resolveLinkSourceForIdentifier("BLO-20886", fields)).toBe("branch_ref");
    // The related-only identifier is still body-sourced, and the branch tier
    // does not start claiming identifiers it does not carry.
    expect(resolveLinkSourceForIdentifier("BLO-19132", fields)).toBe("body_ref");
    // An uppercase branch keeps working, and a Dependabot branch stays unowned.
    expect(resolveLinkSourceForIdentifier("BLO-20886", { branch: "CTO/BLO-20886-x" })).toBe(
      "branch_ref",
    );
    expect(
      resolveLinkSourceForIdentifier("UNDICI-7", {
        branch: "dependabot/npm_and_yarn/undici-7.29.0",
      }),
    ).toBeNull();
  });

  it("falls back to a non-closing house-reference body line when title/keyword/branch all resolve nothing (BLO-21312)", () => {
    // `github_pr_review_requested` arrives via `issue_comment`, whose payload
    // carries no `pull_request.head.ref` -- `branch` is never populated on
    // that path, so the case-insensitive branch tier (BLO-20886) is
    // structurally unreachable there. These are the real house-label shapes
    // observed on Blockcast/paperclip#931, #963, #976, #916.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Issue: https://paperclip.blockcast.net/BLO/issues/BLO-20172",
      }),
    ).toEqual({ owning: ["BLO-20172"] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "- Paperclip task: [BLO-20396](https://paperclip.blockcast.net/BLO/issues/BLO-20396)",
      }),
    ).toEqual({ owning: ["BLO-20396"] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Paperclip QA task: https://paperclip.blockcast.net/BLO/issues/BLO-21079",
      }),
    ).toEqual({ owning: ["BLO-21079"] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Paperclip issue: https://paperclip.blockcast.net/BLO/issues/BLO-19771",
      }),
    ).toEqual({ owning: ["BLO-19771"] });

    // Still never widens far enough to make a bare `Related:` mention owning,
    // even alongside a house label elsewhere in the same body -- the
    // BLO-20886 guarantee holds unchanged.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Related: BLO-1, BLO-2\nIssue: BLO-3\n",
      }),
    ).toEqual({ owning: ["BLO-3"] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: "Related: BLO-1, BLO-2\n" }),
    ).toEqual({ owning: [] });

    // Ranked below the closing-keyword tier: a Fixes:/Closes:/Refs: line
    // still wins over a house label in the same body.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Fixes: BLO-1\nPaperclip issue: BLO-2\n",
      }),
    ).toEqual({ owning: ["BLO-1"] });

    // Ranked below the branch tier too: on a `pull_request` event (branch
    // populated), the measured branch answer still wins over an unmeasured
    // house label in the same body.
    expect(
      resolveOwningPaperclipIdentifiers({
        branch: "fix/blo-1-thing",
        body: "Paperclip issue: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });

    // Title still outranks a house label.
    expect(
      resolveOwningPaperclipIdentifiers({
        title: "fix BLO-1 thing",
        body: "Paperclip issue: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });

    // The colon is mandatory for this weaker tier (unlike the closing-keyword
    // tier, where "Closes BLO-1" is unambiguous natural language). "Issue" is
    // an ordinary noun that also starts ordinary sentences, so an optional
    // colon here would treat prose as an ownership claim. Neither of these is
    // a house label -- both must resolve to nothing.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Issue filed a related bug, see BLO-1",
      }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Issue description for BLO-2",
      }),
    ).toEqual({ owning: [] });

    // A house-reference line carrying a second, explicitly different label on
    // the SAME line must resolve only the house label's own direct value --
    // the semicolon-separated Related: mention must not become owning just
    // because it shares a line with a real house label (BLO-20886's
    // guarantee applied to this new tier).
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Issue: BLO-1; Related: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });
    expect(
      resolveOwningPaperclipIdentifiers({
        body: "Paperclip issue: BLO-1, Related: BLO-2",
      }),
    ).toEqual({ owning: ["BLO-1"] });
  });

  it("keeps owning-looking text unreachable inside list-nested fences and unclosed fences (BLO-20886)", () => {
    // A fence nested in a list item is ordinary Markdown -- it is how a bullet
    // quotes an example PR body -- but its opening line starts with the list
    // marker. A root-level-only fence scanner never opened a fence here, so the
    // indented `Refs:` line inside the example declared an owner and could
    // capture an author-directed "push a follow-up commit" wake.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["- ```md", "  Refs: BLO-999", "  ```"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["1. ~~~", "   Closes: BLO-998", "   ~~~"].join("\n") }),
    ).toEqual({ owning: [] });

    // CommonMark allows only whitespace after a CLOSING fence's marker run, so
    // ``` js inside an open fence is content. Treating it as the close reopened
    // the remainder of the block to the ownership scan.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["```", "example:", "``` js", "Refs: BLO-997", "```"].join("\n"),
      }),
    ).toEqual({ owning: [] });

    // An unterminated fence swallows the rest of the body rather than falling
    // back to matching -- ambiguity fails closed, never toward a guessed owner.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["```", "Refs: BLO-996"].join("\n") }),
    ).toEqual({ owning: [] });

    // The fence rules must not swallow the real thing: a closed fence releases
    // the lines after it, and the repo's bulleted house style still owns.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["- ```md", "  Refs: BLO-999", "  ```", "- Refs: BLO-19132"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-19132"] });
  });

  it("never lets an HTML comment declare an owner (BLO-20886)", () => {
    // A comment renders as nothing, so an owner declared inside one is
    // invisible to every human reading the PR -- an unexplainable misroute.
    // The opener and its `-->` sit on different lines in the repo's own
    // PULL_REQUEST_TEMPLATE.md, so the state has to cross the line loop.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["<!--", "Refs: BLO-888", "-->"].join("\n") }),
    ).toEqual({ owning: [] });
    expect(resolveOwningPaperclipIdentifiers({ body: "<!-- Refs: BLO-887 -->" })).toEqual({
      owning: [],
    });
    // A comment cannot hide the fence that would otherwise contain it, either.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["<!-- ```", "-->", "Refs: BLO-886"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-886"] });
    // Unterminated: the rest of the body stays commented out, failing closed.
    expect(
      resolveOwningPaperclipIdentifiers({ body: ["<!--", "Refs: BLO-885"].join("\n") }),
    ).toEqual({ owning: [] });
    // A visible owner beside a commented decoy resolves to the visible one only.
    expect(
      resolveOwningPaperclipIdentifiers({
        body: ["<!-- Fixes: BLO-884 -->", "Refs: BLO-19132"].join("\n"),
      }),
    ).toEqual({ owning: ["BLO-19132"] });
  });

  it("rejects payloads with bad signatures and accepts ones with good signatures", () => {
    const secret = "test-webhook-secret-do-not-use-in-prod";
    const body = Buffer.from(JSON.stringify({ action: "completed" }), "utf8");
    const goodSig =
      "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(__test_verifyGithubSignature(body, goodSig, secret)).toBe(true);
    expect(__test_verifyGithubSignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(__test_verifyGithubSignature(body, "sha1=" + goodSig.slice(7), secret)).toBe(false);
  });

  it("resolves wake context from a check_run.completed payload with PR head_branch", () => {
    const ctx = __test_resolveEventContext("check_run", {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow-blog",
        head_sha: "abc123",
        html_url: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_check_completed",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      eventUrl: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
      headSha: "abc123",
    });
  });

  it("ignores non-completed check_run actions", () => {
    expect(
      __test_resolveEventContext("check_run", {
        action: "created",
        check_run: { head_branch: "fix/BLO-3182" },
      }),
    ).toBeNull();
  });

  it("resolves pull_request synchronize with PR-scoped task keys and delivery-scoped idempotency", () => {
    const ctx1 = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        number: 318,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "fix/BLO-3182", sha: "push2sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const ctx2 = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        number: 318,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "fix/BLO-3182", sha: "push3sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx1).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_synchronized",
      prNumber: 318,
      repoFullName: "Blockcast/paperclip",
      headSha: "push2sha",
    });
    expect(ctx2).toMatchObject({
      wakeReason: "github_pr_synchronized",
      prNumber: 318,
      headSha: "push3sha",
    });
    expect(__test_shouldFirePrReviewerWake(ctx1)).toBe(true);
    expect(__test_shouldFirePrReviewerWake(ctx2)).toBe(true);
    if (!__test_shouldFirePrReviewerWake(ctx1) || !__test_shouldFirePrReviewerWake(ctx2)) {
      throw new Error("expected synchronize pull_request contexts with PR numbers");
    }
    // taskKey controls reviewer affinity and queued-run coalescing. The
    // idempotency key is delivery-scoped so a coalesced push cannot poison
    // every future synchronize event for the PR.
    expect(__test_buildPrReviewerTaskKey(ctx1)).toBe("pr_review:Blockcast/paperclip:318");
    expect(__test_buildPrReviewerTaskKey(ctx2)).toBe(__test_buildPrReviewerTaskKey(ctx1));
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx1, "delivery-push-2")).toBe(
      "pr_review:Blockcast/paperclip:318:github_pr_synchronized:delivery:delivery-push-2",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx2, "delivery-push-3")).toBe(
      "pr_review:Blockcast/paperclip:318:github_pr_synchronized:delivery:delivery-push-3",
    );
  });

  it("scopes terminal-status idempotency to request-scoped keys only (BLO-18953)", () => {
    const requestScoped = (action: string, reason: string) => {
      const ctx = __test_resolveEventContext("pull_request", {
        action,
        pull_request: {
          number: 991,
          title: "Fix BLO-3182 webflow blog",
          body: null,
          draft: false,
          html_url: "https://github.com/Blockcast/magma/pull/991",
          head: { ref: "fix/BLO-3182-webflow-blog", sha: "readysha" },
        },
        repository: { full_name: "Blockcast/magma" },
      });
      expect(ctx?.wakeReason).toBe(reason);
      return ctx as NonNullable<typeof ctx>;
    };

    // Delivery-scoped: the key can only recur as a redelivery, so a terminal
    // completed/cancelled row must dedup it.
    for (const [action, reason] of [
      ["ready_for_review", "github_pr_ready_for_review"],
      ["synchronize", "github_pr_synchronized"],
    ] as const) {
      const ctx = requestScoped(action, reason);
      expect(__test_prReviewerWakeIdempotencyScope(ctx, "delivery-1")).toBe("request");
    }

    // Stable PR+reason keys keep the original exclusion: a NEW event reuses the
    // key, so terminal statuses must not block it.
    const opened = requestScoped("opened", "github_pr_opened");
    expect(__test_prReviewerWakeIdempotencyScope(opened, "delivery-1")).toBe("stable");

    // A suffix with no per-event identity at all cannot distinguish two
    // distinct events, so it must NOT get the terminal-dedup rule.
    const noIdentity = requestScoped("ready_for_review", "github_pr_ready_for_review");
    expect(__test_prReviewerWakeIdempotencyScope(noIdentity, null)).toBe("stable");

    expect(__test_idempotentWakeStatuses("stable")).not.toContain("completed");
    expect(__test_idempotentWakeStatuses("stable")).not.toContain("cancelled");
    expect(__test_idempotentWakeStatuses("request")).toEqual(
      expect.arrayContaining(["completed", "cancelled", "queued", "running", "coalesced"]),
    );
    // A wake that never produced a review still deserves a fresh attempt.
    expect(__test_idempotentWakeStatuses("request")).not.toContain("failed");
    expect(__test_idempotentWakeStatuses("request")).not.toContain("dispatch_failed_exhausted");
  });

  it("does not build reviewer debounce keys for malformed PR contexts without a PR number", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "synchronize",
      pull_request: {
        title: "No paperclip link",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/318",
        head: { ref: "refresh/no-identifier", sha: "push2sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: [],
      wakeReason: "github_pr_synchronized",
      prNumber: null,
      repoFullName: "Blockcast/paperclip",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(false);
    expect(() => __test_buildPrReviewerWakeIdempotencyKey(ctx as never, "delivery-push-2")).toThrow(
      "PR reviewer wake idempotency key requires prNumber",
    );
  });

  it("resolves a wake reason for pull_request opened", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 200,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/200",
        head: { ref: "feat/BLO-3182", sha: "def456" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-3182"],
      wakeReason: "github_pr_opened",
      prNumber: 200,
      prTitle: "Fix BLO-3182 webflow blog",
      prUrl: "https://github.com/Blockcast/paperclip/pull/200",
      eventUrl: "https://github.com/Blockcast/paperclip/pull/200",
      headSha: "def456",
    });
  });

  it("waits for ready_for_review before waking the reviewer for a draft PR", () => {
    const openedDraft = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "draft-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const ready = __test_resolveEventContext("pull_request", {
      action: "ready_for_review",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: false,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "ready-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const converted = __test_resolveEventContext("pull_request", {
      action: "converted_to_draft",
      pull_request: {
        number: 201,
        title: "Draft queue work",
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/201",
        head: { ref: "draft/reviewer-queue", sha: "draft-again-sha" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    expect(openedDraft).toMatchObject({ prDraft: true, wakeReason: "github_pr_opened" });
    expect(__test_shouldFirePrReviewerWake(openedDraft)).toBe(false);
    expect(ready).toMatchObject({ prDraft: false, wakeReason: "github_pr_ready_for_review" });
    expect(__test_shouldFirePrReviewerWake(ready)).toBe(true);
    expect(converted).toMatchObject({
      prDraft: true,
      wakeReason: "github_pr_converted_to_draft",
    });
    expect(__test_shouldFirePrReviewerWake(converted)).toBe(false);
  });

  it("scopes the ready_for_review idempotency key to the delivery so every toggle is a fresh request (BLO-18953)", () => {
    const readyAt = (sha: string) =>
      __test_resolveEventContext("pull_request", {
        action: "ready_for_review",
        pull_request: {
          number: 822,
          title: "Anchor review marker at byte 0",
          draft: false,
          html_url: "https://github.com/Blockcast/paperclip/pull/822",
          head: { ref: "cto/blo-18865", sha },
        },
        repository: { full_name: "Blockcast/paperclip" },
      });

    const firstToggle = readyAt("ea8697d1");
    const secondToggle = readyAt("3f6db574");
    if (
      !__test_shouldFirePrReviewerWake(firstToggle) ||
      !__test_shouldFirePrReviewerWake(secondToggle)
    ) {
      throw new Error("expected ready_for_review contexts to fire a reviewer wake");
    }

    // Keyed on repo+pr+reason alone, the first toggle's wake row — which lands
    // on the terminal `coalesced` status, an IDEMPOTENT_REVIEWER_WAKE_STATUS —
    // blocked every later toggle on the PR forever. Delivery scoping keeps each
    // deliberate draft->ready transition its own request.
    expect(__test_buildPrReviewerWakeIdempotencyKey(firstToggle, "delivery-ready-1")).toBe(
      "pr_review:Blockcast/paperclip:822:github_pr_ready_for_review:delivery:delivery-ready-1",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2")).not.toBe(
      __test_buildPrReviewerWakeIdempotencyKey(firstToggle, "delivery-ready-1"),
    );

    // A GitHub redelivery reuses the delivery id, so genuine retries still dedup.
    expect(__test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2")).toBe(
      __test_buildPrReviewerWakeIdempotencyKey(secondToggle, "delivery-ready-2"),
    );

    // The task key stays PR-scoped: it also scopes reviewer affinity, the task
    // lock, and the cancel-on-close sweep.
    expect(__test_buildPrReviewerTaskKey(secondToggle)).toBe(
      __test_buildPrReviewerTaskKey(firstToggle),
    );
  });

  it("extracts the PR author login from pull_request.opened for the self-review-skip gate (BLO-9293)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 235,
        title: "Fix BLO-9293",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/235",
        head: { ref: "fix/BLO-9293", sha: "9f3ac21" },
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });
    expect(ctx).toMatchObject({
      wakeReason: "github_pr_opened",
      prNumber: 235,
      prAuthorLogin: "allyblockcast[bot]",
    });
  });

  it("resolves pull_request reopened as a reviewer wake signal (BLO-7426)", () => {
    const ctx = __test_resolveEventContext("pull_request", {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry review for BLO-7426",
        body: null,
        head: { ref: "fix/BLO-7426-reopen-wake" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-7426"],
      wakeReason: "github_pr_reopened",
      prNumber: 980,
      repoFullName: "Blockcast/magma",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
    if (!ctx || !ctx.prNumber) {
      throw new Error("expected reopened pull_request context with PR number");
    }
    // @ts-expect-error – test fixture omits the prNumber field required by the narrow union
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-reopened")).toBe(
      "pr_review:Blockcast/magma:980:github_pr_reopened",
    );
  });

  it("treats @ally in a PR comment as an explicit reviewer wake request", () => {
    expect(__test_hasPrReviewerRequestMention("@ally re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @Ally after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@blockcast-ci-packages re-review please")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("@allyblockcast please review")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("cc @AllyBlockcast after the fix")).toBe(true);
    expect(__test_hasPrReviewerRequestMention("ally should not match without the tag")).toBe(false);
    expect(__test_hasPrReviewerRequestMention("email me at ops@ally.example")).toBe(false);

    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 47,
        title: "BLO-6000 migrate auth",
        body: null,
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
        pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
      },
      comment: {
        id: 123456,
        body: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });

    expect(ctx).toMatchObject({
      identifiers: ["BLO-6000"],
      wakeReason: "github_pr_review_requested",
      prNumber: 47,
      repoFullName: "Blockcast/Network-Operator-Portal",
      commentId: 123456,
      commentAuthorLogin: "kkroo",
      commentBody: "@ally re-review requested. Auth branch is refreshed and Docker builder passed.",
      prUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47",
      eventUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
      commentUrl: "https://github.com/Blockcast/Network-Operator-Portal/pull/47#issuecomment-123456",
    });
    if (!__test_shouldFirePrReviewerWake(ctx)) {
      throw new Error("expected @ally PR comment to fire a reviewer wake");
    }
    expect(__test_buildPrReviewerTaskKey(ctx)).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47",
    );
    expect(__test_buildPrReviewerWakeIdempotencyKey(ctx, "delivery-1")).toBe(
      "pr_review:Blockcast/Network-Operator-Portal:47:github_pr_review_requested:comment:123456",
    );
  });

  it("does not treat the reviewer bot's own comment as a review request, even when it mentions its own alias (BLO-13247 follow-up)", () => {
    // Observed live on Blockcast/paperclip#583: a template-completion nudge
    // that greets the bot by its own handle in the salutation, and
    // separately the bot's own explanatory reply quoting the alias as a
    // backtick-quoted example, each re-fired github_pr_review_requested --
    // an indefinite self-perpetuating loop on any bot-authored PR that gets
    // an automated reply mentioning the bot by name.
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: {
          id: 1,
          body: "Hey @allyblockcast[bot]! Before this PR can be reviewed...",
          user: { login: "allyblockcast[bot]" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      }),
    ).toBeNull();

    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: {
          id: 2,
          body: "The comment-scoped suffix is `comment:${commentId}`, so a later distinct `@ally` comment still wakes the author.",
          user: { login: "allyblockcast[bot]" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      }),
    ).toBeNull();

    // Sanity check: the same body from a DIFFERENT author still fires the
    // reviewer-request wake -- this guard is author-scoped, not a
    // body-content change.
    const fromHuman = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 583,
        title: "BLO-13247 precheck idempotency key",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
      },
      comment: {
        id: 3,
        body: "Hey @allyblockcast[bot]! Before this PR can be reviewed...",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(fromHuman).toMatchObject({ wakeReason: "github_pr_review_requested" });
  });

  it("treats a marker-prefixed reviewer-bot comment as an AGENT review request (BLO-18865)", () => {
    // Agents post PR comments through the Paperclip GitHub App, so the author
    // login is allyblockcast[bot] -- Ally's own identity. Before BLO-18865 the
    // author-scoped guard dropped every agent-issued @ally request, leaving
    // agents with no comment-based and no push-based way to get a re-review
    // (Blockcast/paperclip#814: two pushes + two @ally comments, nothing in
    // 2h19m). The explicit start-of-body marker restores that path.
    const agentRequest = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 814,
        title: "BLO-18797 creator + manager-chain issue authz",
        html_url: "https://github.com/Blockcast/paperclip/pull/814",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/814" },
      },
      comment: {
        id: 4900000001,
        body: "<!-- paperclip:review-request -->\n@ally please re-review at head 2e6a1b71 — the active-run guard is restored.",
        html_url: "https://github.com/Blockcast/paperclip/pull/814#issuecomment-4900000001",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(agentRequest).toMatchObject({
      wakeReason: "github_pr_review_requested",
      prNumber: 814,
      commentAuthorLogin: "allyblockcast[bot]",
    });
    if (!__test_shouldFirePrReviewerWake(agentRequest)) {
      throw new Error("expected a marker-prefixed agent request to fire a reviewer wake");
    }
    // Comment-scoped idempotency: each distinct request comment gets its own
    // wake, so a later re-review request at a newer head is not swallowed.
    expect(__test_buildPrReviewerWakeIdempotencyKey(agentRequest, "delivery-agent-req")).toBe(
      "pr_review:Blockcast/paperclip:814:github_pr_review_requested:comment:4900000001",
    );

    // Marker may carry provenance attributes. It must still start at byte 0.
    const withAttributes = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 814,
        title: "BLO-18797 creator + manager-chain issue authz",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/814" },
      },
      comment: {
        id: 4900000002,
        body: "<!--  paperclip:review-request agent=cto issue=BLO-18865  -->\nRe-review please, @ally.",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(withAttributes).toMatchObject({ wakeReason: "github_pr_review_requested" });
  });

  it("classifies agent and human review requests identically once the marker is present (BLO-18865)", () => {
    const request = (login: string, body: string) =>
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 820,
          title: "BLO-18865 agent review requests",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/820" },
        },
        comment: { id: 77, body, user: { login } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // The marker is an authorization to *fire the reviewer wake* -- nothing
    // more. It rides the shared Paperclip GitHub App identity, so it proves
    // no requester identity and the resolved context carries no
    // agent-vs-human discriminator for downstream code to branch on. An agent
    // request is therefore shaped exactly like a human one; in particular the
    // author wake is preserved for both (see suppressAuthorWake).
    const fromAgent = request(
      "allyblockcast[bot]",
      "<!-- paperclip:review-request -->\n@ally re-review please",
    );
    const fromHumanRequest = request("kkroo", "@ally re-review please");
    expect(fromAgent).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(fromHumanRequest).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(fromAgent).not.toHaveProperty("agentReviewRequest");
    expect(fromHumanRequest).not.toHaveProperty("agentReviewRequest");
  });

  it("reports a markerless reviewer-bot @ally request instead of dropping it silently (BLO-18273)", () => {
    // The markerless drop is the failure mode BLO-18273 was filed for: the
    // request is recognized as one, suppressed by the author guard, and leaves
    // NO trace -- so the requesting agent ends its run believing it handed off
    // and the PR waits forever. resolveEventContext still returns null (the
    // #583 loop must stay closed); it now reports the drop on the way out.
    const resolve = (body: string, login: string) => {
      const suppressed: unknown[] = [];
      const context = __test_resolveEventContext(
        "issue_comment",
        {
          action: "created",
          issue: {
            number: 1659,
            title: "BLO-18157 platform-sre backup RBAC",
            pull_request: { url: "https://api.github.com/repos/Blockcast/onprem-k8s/pulls/1659" },
          },
          comment: {
            id: 7001,
            body,
            user: { login },
            html_url: "https://github.com/Blockcast/onprem-k8s/pull/1659#issuecomment-7001",
          },
          repository: { full_name: "Blockcast/onprem-k8s" },
        },
        {
          prReviewerBotLogin: "allyblockcast[bot]",
          onSuppressedReviewRequest: (info) => suppressed.push(info),
        },
      );
      return { context, suppressed };
    };

    // The lost handoff: bot login, real ask, no marker.
    const dropped = resolve("@ally please review the RBAC scoping", "allyblockcast[bot]");
    expect(dropped.context).toBeNull();
    expect(dropped.suppressed).toHaveLength(1);
    expect(dropped.suppressed[0]).toMatchObject({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1659,
      commentId: 7001,
      commentAuthorLogin: "allyblockcast[bot]",
      commentUrl: "https://github.com/Blockcast/onprem-k8s/pull/1659#issuecomment-7001",
      reason: "missing_marker",
    });

    // With the marker it is a real request, so there is nothing to report.
    const honoured = resolve(
      "<!-- paperclip:review-request -->\n@ally please review the RBAC scoping",
      "allyblockcast[bot]",
    );
    expect(honoured.context).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(honoured.suppressed).toHaveLength(0);

    // Ally's OWN output mentioning the alias is a correct suppression, not a
    // lost handoff. Reporting it would bury the real signal in #583-shaped
    // noise on every review Ally posts, so it must stay quiet.
    const selfEcho = resolve(
      "## Ally — Consolidated PR Review\n\nNo blocking findings; @ally ran 3 lenses.",
      "allyblockcast[bot]",
    );
    expect(selfEcho.context).toBeNull();
    expect(selfEcho.suppressed).toHaveLength(0);

    // The commitperclip template gate greets the bot by its LOGIN, not the
    // alias, and does so repeatedly on the same PR (a 2026-07-31 sweep found 7
    // on Blockcast/paperclip#812, 3 on #820). This is the original #583 body:
    // suppressing it is correct, so it must not be reported or the real signal
    // drowns. This is the case that decides bare-alias vs general mention.
    const gateNudge = resolve(
      "Hey @allyblockcast[bot]! Before this PR can be reviewed, a few things need attention:\n\n" +
        "**Missing or incomplete:**\n- [ ] Missing section: **## Thinking Path**\n",
      "allyblockcast[bot]",
    );
    expect(gateNudge.context).toBeNull();
    expect(gateNudge.suppressed).toHaveLength(0);

    // A human's markerless @ally was never suppressed, so it is not reported.
    const human = resolve("@ally please review the RBAC scoping", "kkroo");
    expect(human.context).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(human.suppressed).toHaveLength(0);
  });

  it("reports a marker-prefixed agent request disqualified by an incidental heading match (BLO-21618)", () => {
    // The second invisible drop this file had: a genuine marker-prefixed agent
    // request (marker + mention, exactly what BLO-18865 exists to recognize)
    // whose body ALSO contains a standalone line matching the Ally
    // consolidated-review heading -- e.g. quoting a prior review while asking
    // for a fresh pass. `agentReviewRequest`'s heading exclusion (load-bearing
    // for keeping the #583 loop closed on Ally's own output) disqualifies it,
    // and until now the original suppression report ALSO excluded
    // heading-bearing bodies, so this case left zero trace: no wake, no log,
    // no counter. Observed as the root-cause candidate investigated for
    // Blockcast/paperclip#993 (BLO-21618) before that PR's own request bodies
    // were confirmed clean of this pattern.
    const resolve = (body: string) => {
      const suppressed: { reason: string }[] = [];
      const context = __test_resolveEventContext(
        "issue_comment",
        {
          action: "created",
          issue: {
            number: 993,
            title: "BLO-21309 recovery-stale-issue-lock-sweep basis swap",
            pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/993" },
          },
          comment: {
            id: 5170314705,
            body,
            user: { login: "allyblockcast[bot]" },
            html_url: "https://github.com/Blockcast/paperclip/pull/993#issuecomment-5170314705",
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
        {
          prReviewerBotLogin: "allyblockcast[bot]",
          onSuppressedReviewRequest: (info) => suppressed.push(info as { reason: string }),
        },
      );
      return { context, suppressed };
    };

    // Marker + mention + an incidental heading-shaped line quoting the prior
    // review: disqualified, but now reported with its own distinguishable
    // reason instead of vanishing.
    const disqualified = resolve(
      "<!-- paperclip:review-request -->\n@ally re-review at head 1620f3a.\n\n" +
        "For context, your last pass here:\n## Ally — Consolidated PR Review\nsaid the lock basis was fine.",
    );
    expect(disqualified.context).toBeNull();
    expect(disqualified.suppressed).toHaveLength(1);
    expect(disqualified.suppressed[0]).toMatchObject({
      repoFullName: "Blockcast/paperclip",
      prNumber: 993,
      commentId: 5170314705,
      commentAuthorLogin: "allyblockcast[bot]",
      reason: "marker_disqualified_by_heading",
    });

    // Same marker and mention, no heading collision: an ordinary honoured
    // request, nothing to report. (This is the actual shape of #993's two
    // real review-request comments.)
    const clean = resolve(
      "<!-- paperclip:review-request -->\n@ally please review at head df19e7b — BLO-21309.\n\n" +
        "Focus on the one judgement call: this inverts a deliberate, tested behavior.",
    );
    expect(clean.context).toMatchObject({ wakeReason: "github_pr_review_requested" });
    expect(clean.suppressed).toHaveLength(0);

    // Ally's own routine output is never marker-prefixed (the marker must be
    // the literal first byte; Ally's output opens with the heading instead),
    // so the new branch cannot fire on a genuine self-echo.
    const selfEcho = resolve("## Ally — Consolidated PR Review\n\nNo blocking findings.");
    expect(selfEcho.context).toBeNull();
    expect(selfEcho.suppressed).toHaveLength(0);
  });

  it("keeps the #583 self-refire loop closed: a quoted or reviewer-output marker is not a request (BLO-18865)", () => {
    const botComment = (id: number, body: string) =>
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 583,
          title: "BLO-13247 precheck idempotency key",
          pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/583" },
        },
        comment: { id, body, user: { login: "allyblockcast[bot]" } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // The #583 loop was driven by bot-authored bodies mentioning the alias
    // SOMEWHERE. The marker is anchored to offset 0, so Ally quoting the
    // marker back while explaining the request it is answering cannot re-arm
    // the trigger -- this is the case that would relight the loop.
    expect(
      botComment(
        10,
        "Thanks — for future runs, prefix the comment with `<!-- paperclip:review-request -->` and mention @ally.",
      ),
    ).toBeNull();

    // A fenced/indented marker is likewise mid-body, not a request.
    expect(botComment(11, "Example:\n\n    <!-- paperclip:review-request -->\n    @ally review\n")).toBeNull();

    // ...and the same example with NOTHING before it. Four leading spaces is a
    // Markdown indented code block -- the canonical way a reviewer renders
    // "here is the marker to use" -- so this is a quoted example too, but it
    // is the one an offset-0-modulo-whitespace anchor would misread as a real
    // request. Each such comment would mint a fresh comment-scoped
    // idempotency key, so nothing downstream would dedup the refire. This is
    // the #583 loop; the anchor is at literal byte 0 to keep it closed.
    expect(botComment(14, "    <!-- paperclip:review-request -->\n    @ally review\n")).toBeNull();
    expect(botComment(15, "\n<!-- paperclip:review-request -->\n@ally review\n")).toBeNull();
    expect(botComment(16, "> <!-- paperclip:review-request -->\n> @ally review\n")).toBeNull();

    // Even at offset 0, Ally's own review output is never a request: the
    // consolidated-review header disqualifies it regardless of the marker.
    expect(
      botComment(
        12,
        "<!-- paperclip:review-request -->\n## Ally — Consolidated PR Review\n\nSee findings below; @ally ran 3 lenses.",
      ),
    ).toBeNull();

    // And the original #583 bodies stay suppressed (no marker at all).
    expect(botComment(13, "Hey @allyblockcast[bot]! Before this PR can be reviewed...")).toBeNull();

    // ...but a real request that merely REFERS to a past review in prose is
    // still a request. The exclusion keys on Ally's own output shape (the
    // header on its own line), not on the phrase appearing anywhere, so
    // citing the review as context does not silently drop the ask.
    expect(
      botComment(
        17,
        "<!-- paperclip:review-request -->\n@ally re-review at head abc123 — your earlier Ally — Consolidated PR Review flagged the vault probe; that is fixed now.",
      ),
    ).not.toBeNull();

    // A quoted copy of the header is likewise context, not Ally's output.
    expect(
      botComment(
        18,
        "<!-- paperclip:review-request -->\n@ally re-review at head abc123. For context:\n\n> ## Ally — Consolidated PR Review\n> Fix I1 before merge.\n",
      ),
    ).not.toBeNull();
  });

  it("scopes the consolidated-review exclusion to Ally's own output shape (BLO-18865)", () => {
    // Ally's actual review opens with the header as a Markdown heading.
    expect(__test_hasAllyConsolidatedReviewHeading("## Ally — Consolidated PR Review\n\nFindings...")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("# Ally - Consolidated PR Review")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("###### Ally: Consolidated PR Review")).toBe(true);
    // Bold and bare-line variants stay excluded so a format change on Ally's
    // side cannot silently lapse this layer.
    expect(__test_hasAllyConsolidatedReviewHeading("**Ally — Consolidated PR Review**")).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeading("Ally — Consolidated PR Review\n\nFindings...")).toBe(true);
    // Still catches Ally echoing the marker at byte 0 -- the #583 layer.
    expect(
      __test_hasAllyConsolidatedReviewHeading(
        "<!-- paperclip:review-request -->\n## Ally — Consolidated PR Review\n\n@ally ran 3 lenses.",
      ),
    ).toBe(true);

    // A mid-line prose reference is a citation, not Ally's output.
    expect(
      __test_hasAllyConsolidatedReviewHeading("@ally re-review — your Ally — Consolidated PR Review flagged X"),
    ).toBe(false);
    // A blockquoted or indented copy is a quote, not Ally's output.
    expect(__test_hasAllyConsolidatedReviewHeading("> ## Ally — Consolidated PR Review")).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading("    ## Ally — Consolidated PR Review")).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading(null)).toBe(false);
    expect(__test_hasAllyConsolidatedReviewHeading(undefined)).toBe(false);

    // The WHOLE-body helper keeps its broader behaviour: it gates a different
    // call site (isActionablePrReviewComment), where a relayed review body must
    // still count as review feedback whoever forwarded it.
    expect(
      __test_hasAllyConsolidatedReviewHeader("@ally re-review — your Ally — Consolidated PR Review flagged X"),
    ).toBe(true);
    expect(__test_hasAllyConsolidatedReviewHeader("> ## Ally — Consolidated PR Review")).toBe(true);
  });

  it("anchors the agent review-request marker to literal byte 0 of the body (BLO-18865)", () => {
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-request -->\n@ally")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!--paperclip:review-request-->")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- PAPERCLIP:REVIEW-REQUEST agent=cto -->")).toBe(true);
    expect(__test_hasPrReviewerAgentRequestMarker("<!--\tpaperclip:review-request\t-->")).toBe(true);

    // NOT anchored at byte 0 -> not a marker. Leading whitespace is rejected
    // on purpose: 4 spaces makes the line a Markdown indented code block, so
    // an indented marker at body start is a rendered EXAMPLE, and accepting it
    // would let a reviewer-authored example re-arm the #583 refire loop.
    expect(__test_hasPrReviewerAgentRequestMarker("    <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("\n<!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(" <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("> <!-- paperclip:review-request -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("please use <!-- paperclip:review-request -->")).toBe(false);

    // The token must end at whitespace or the closing `-->`, so a longer
    // lookalike token is not a match.
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-request-evil -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review-requested -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("<!-- paperclip:review -->")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker("@ally please review")).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(null)).toBe(false);
    expect(__test_hasPrReviewerAgentRequestMarker(undefined)).toBe(false);
  });

  it("suppresses only AUTOMATIC reviewer wakes on a draft PR, not explicit requests (BLO-18865)", () => {
    const draftCtx = (wakeReason: string) => ({ wakeReason, prNumber: 900, prDraft: true }) as never;
    // Automatic reasons stay suppressed while the PR is a draft: a push to a
    // draft must not spend a review pass per commit, so draft PRs are never
    // reviewed until marked ready.
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_opened"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_synchronized"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_reopened"))).toBe(false);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_review_submitted"))).toBe(false);
    // An explicit ask is not churn and is honoured even on a draft. This
    // exemption is belt-and-braces today (resolveEventContext's issue_comment
    // branch does not populate prDraft, so the check is not reached that way);
    // it is asserted directly so populating prDraft later cannot silently
    // re-strand agents.
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_review_requested"))).toBe(true);
    expect(__test_shouldFirePrReviewerWake(draftCtx("github_pr_ready_for_review"))).toBe(true);
  });

  it("ignores issue comments that are not PR @ally review requests", () => {
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: {
          number: 47,
          title: "BLO-6000 migrate auth",
          pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/47" },
        },
        comment: { id: 123456, body: "Looks good to me", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
    expect(
      __test_resolveEventContext("issue_comment", {
        action: "created",
        issue: { number: 47, title: "BLO-6000 not a PR" },
        comment: { id: 123456, body: "@ally re-review please", user: { login: "kkroo" } },
        repository: { full_name: "Blockcast/Network-Operator-Portal" },
      }),
    ).toBeNull();
  });

  it("treats an actionable Ally consolidated PR review comment as author feedback, not a reviewer request", () => {
    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 269,
        title: "Fix PEN-1126 hosted vault follow-up",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
      },
      comment: {
        id: 4784546377,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nI1: The vault health probe still points at the wrong route.\n\n### Recommended Action\n\nFix I1 before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    });

    expect(ctx).toMatchObject({
      identifiers: ["PEN-1126"],
      wakeReason: "github_pr_review_feedback",
      prNumber: 269,
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      commentId: 4784546377,
      commentAuthorLogin: "allyblockcast[bot]",
    });
    expect(ctx ? __test_shouldFirePrReviewerWake(ctx) : true).toBe(false);
  });

  it("keeps a lowercase branch-only owner in the candidate identifiers (BLO-20886)", () => {
    // The owning tiers uppercase the branch (real branches are lowercase and
    // PAPERCLIP_IDENTIFIER_PATTERN is uppercase-only); the broad `identifiers`
    // extraction does not. A PR whose ONLY ref is a lowercase branch therefore
    // resolved an owner while `identifiers` came back empty -- and the route
    // drops such a delivery at the `no_paperclip_identifier` gate before the
    // owner is ever consulted. Past that gate it is still unreachable, because
    // author wakes are `matched.filter(m => owning.includes(m.identifier))`
    // and `matched` derives from `identifiers`. Either way the wake this
    // module exists to deliver is lost, so the owner must appear in both.
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 962,
        title: "tidy up the webhook",
        body: "No issue reference in this body at all.",
        head: { ref: "fix/blo-20886-only", sha: "deadbeef" },
        user: { login: "kkroo" },
      },
      review: { state: "changes_requested", body: "please fix", user: { login: "ally" } },
      repository: { full_name: "Blockcast/paperclip" },
    });

    expect(ctx?.owningIdentifiers).toEqual(["BLO-20886"]);
    expect(ctx?.identifiers).toContain("BLO-20886");
  });

  it("extracts review body / state / author from pull_request_review.submitted so the assignee wake can render it inline (BLO-6300)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat(cdn): BLO-5269 aggregator",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/953",
        head: { ref: "feat/BLO-5269", sha: "feedface" },
      },
      review: {
        body: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        state: "commented",
        html_url: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({
      identifiers: ["BLO-5269"],
      wakeReason: "github_pr_review_submitted",
      prNumber: 953,
      repoFullName: "Blockcast/magma",
      reviewBody: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
      reviewState: "commented",
      reviewAuthorLogin: "ally",
      prUrl: "https://github.com/Blockcast/magma/pull/953",
      eventUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      reviewUrl: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
      headSha: "feedface",
    });
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(true);
  });

  // Review finding (PR #1125): the reviewed-head provenance must be the
  // review's own immutable `commit_id`, not `pull_request.head.sha` -- the
  // latter reflects whatever the branch is at NOW, which can have advanced
  // past what the review actually looked at by the time this webhook is
  // processed.
  it("prefers review.commit_id over pull_request.head.sha for headSha when the branch has since advanced (PR #1125 review finding)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat(cdn): BLO-5269 aggregator",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/953",
        // The branch has advanced past what this review actually reviewed.
        head: { ref: "feat/BLO-5269", sha: "advanced-after-review" },
      },
      review: {
        body: "Critical: PushExtCDNCacheHitRates POSTs to a read-only serializer.",
        state: "commented",
        html_url: "https://github.com/Blockcast/magma/pull/953#pullrequestreview-99",
        user: { login: "ally" },
        commit_id: "reviewed-this-commit",
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx).toMatchObject({ headSha: "reviewed-this-commit" });
  });

  it("flags the reviewer's own pull_request_review.submitted as a self-echo (BLO-15799)", () => {
    const reviewCtx = (login: string) =>
      __test_resolveEventContext("pull_request_review", {
        action: "submitted",
        pull_request: {
          number: 730,
          title: "Some PR",
          body: null,
          head: { ref: "some-branch", sha: "abc123" },
          user: { login: "codex" },
        },
        review: { body: "Consolidated review findings.", state: "commented", user: { login } },
        repository: { full_name: "Blockcast/paperclip" },
      });

    // Observed posting identities, current and historical.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("allyblockcast[bot]")!, "allyblockcast[bot]")).toBe(true);
    expect(__test_isReviewerSelfEchoReview(reviewCtx("blockcast-ci-packages[bot]")!, "allyblockcast[bot]")).toBe(true);
    // The default posting identity applies when no login is configured.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("allyblockcast[bot]")!, null)).toBe(true);
    // A custom configured posting identity is honored.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("my-review-bot[bot]")!, "my-review-bot[bot]")).toBe(true);
    // Human reviews and OTHER bots' reviews are not self-echoes.
    expect(__test_isReviewerSelfEchoReview(reviewCtx("kkroo")!, "allyblockcast[bot]")).toBe(false);
    expect(__test_isReviewerSelfEchoReview(reviewCtx("coderabbitai[bot]")!, "allyblockcast[bot]")).toBe(false);
  });

  it("scopes the self-echo filter to github_pr_review_submitted, never other wake reasons (BLO-15799)", () => {
    // A pull_request.opened context (even one authored by the reviewer bot)
    // must never be treated as a self-echo — pr opened/synchronize/comment
    // wakes are untouched by the filter.
    const openedCtx = __test_resolveEventContext("pull_request", {
      action: "opened",
      pull_request: {
        number: 731,
        title: "Some PR",
        body: null,
        head: { ref: "some-branch" },
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(openedCtx?.wakeReason).toBe("github_pr_opened");
    expect(__test_isReviewerSelfEchoReview(openedCtx!, "allyblockcast[bot]")).toBe(false);
  });

  it("truncates oversize review bodies to ~4KB with a marker so the contextSnapshot row stays small (BLO-6300)", () => {
    // 5000-byte body — 1KB over the 4096-byte cap.
    const longBody = "x".repeat(5000);
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        title: "feat: BLO-5269",
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: longBody,
        state: "commented",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toMatch(/…\(truncated\)$/);
    // 4096-byte body + truncation marker (~14 bytes), but always less than
    // the raw 5000 bytes — confirms we actually cut something.
    expect(ctx?.reviewBody?.length).toBeLessThan(5000);
  });

  it("returns null reviewBody when the reviewer submitted an empty body (state-only review)", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      action: "submitted",
      pull_request: {
        number: 953,
        head: { ref: "feat/BLO-5269" },
      },
      review: {
        body: "",
        state: "approved",
        user: { login: "ally" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    expect(ctx?.reviewBody).toBeNull();
    expect(ctx?.reviewState).toBe("approved");
  });

  it("resolves a dependabot_alert.created payload into a remediation context", () => {
    const ctx = __test_resolveDependabotAlertContext({
      action: "created",
      alert: {
        number: 58,
        html_url: "https://github.com/Blockcast/paperclip/security/dependabot/58",
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity: "critical",
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity: "critical",
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(ctx).toMatchObject({
      action: "created",
      alertNumber: 58,
      severity: "critical",
      packageName: "vitest",
      ecosystem: "npm",
      manifestPath: "packages/mcp-gateway/package.json",
      ghsaId: "GHSA-5xrq-8626-4rwp",
      cveId: "CVE-2026-47429",
      vulnerableRange: "< 3.2.6",
      patchedVersion: "3.2.6",
      alertUrl: "https://github.com/Blockcast/paperclip/security/dependabot/58",
    });
  });

  it("builds Dependabot alert instructions with separate remediation and dismissal paths", () => {
    const alert = __test_resolveDependabotAlertContext({
      action: "created",
      alert: {
        number: 58,
        html_url: "https://github.com/Blockcast/paperclip/security/dependabot/58",
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity: "critical",
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity: "critical",
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    expect(alert).not.toBeNull();

    const description = __test_buildDependabotAlertIssueBody({
      repoFullName: "Blockcast/paperclip",
      alert: alert!,
    });

    expect(description).toContain("Remediation path:");
    expect(description).toContain("Dismissal path:");
    expect(description).toContain("A GitHub alert-state receipt is sufficient but not required");
    expect(description).toContain("terminal dismissal webhook receipt");
    expect(description).toMatch(
      /^1\. The default-branch manifest `packages\/mcp-gateway\/package\.json` in `Blockcast\/paperclip` resolves vitest at 3\.2\.6 or newer, outside the vulnerable range < 3\.2\.6, with advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429 cited in the evidence\.$/m,
    );
  });

  it("resolves terminal dependabot alert actions for receipt recording", () => {
    for (const action of ["fixed", "dismissed", "auto_dismissed"]) {
      expect(
        __test_resolveDependabotAlertContext({
          action,
          alert: { number: 7, security_vulnerability: { severity: "critical" } },
        }),
      ).toMatchObject({ action, alertNumber: 7, severity: "critical" });
    }

    expect(
      __test_resolveDependabotAlertContext({
        action: "dismissed",
        alert: {
          number: 8,
          dismissed_reason: "tolerable_risk",
          dismissed_comment: "Not reachable in production.",
        },
      }),
    ).toMatchObject({
      dismissalReason: "tolerable_risk",
      dismissalComment: "Not reachable in production.",
    });
  });

  it("returns null for dependabot payloads without a numeric alert number", () => {
    expect(__test_resolveDependabotAlertContext({ action: "created", alert: {} })).toBeNull();
    expect(__test_resolveDependabotAlertContext({ action: "created" })).toBeNull();
  });
});

describe("workflow_run supersession classification (BLO-21078 AC3)", () => {
  beforeEach(() => {
    __resetWorkflowRunSupersessionTrackingForTest();
  });

  it("classifies none when no other run has been sighted on the branch", () => {
    expect(
      __test_classifyWorkflowRunSupersession("Blockcast/paperclip", "blo-1-x", 100, Date.parse("2026-08-02T19:34:01Z")),
    ).toBe("none");
  });

  it("classifies none for the run's own sighting (same runId is not a supersession)", () => {
    const createdAt = Date.parse("2026-08-02T19:31:32Z");
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "cto/blo-18278-capacity-reset", 930, createdAt);
    expect(
      __test_classifyWorkflowRunSupersession(
        "Blockcast/paperclip",
        "cto/blo-18278-capacity-reset",
        930,
        Date.parse("2026-08-02T19:34:01Z"),
      ),
    ).toBe("none");
  });

  it("classifies superseded when a newer run on the same branch already existed by the time this one ended", () => {
    // Mirrors the benign shape from BLO-21078's own investigation: run
    // 30796167940 on staff/blo-20742-ally-concurrency-v2, created 08:07:35Z,
    // cancelled 08:22:15Z after a newer push created a run at 08:21:26Z.
    __test_recordWorkflowRunSighting(
      "Blockcast/paperclip",
      "staff/blo-20742-ally-concurrency-v2",
      30796167940,
      Date.parse("2026-08-03T08:07:35Z"),
    );
    __test_recordWorkflowRunSighting(
      "Blockcast/paperclip",
      "staff/blo-20742-ally-concurrency-v2",
      30796200001,
      Date.parse("2026-08-03T08:21:26Z"),
    );
    expect(
      __test_classifyWorkflowRunSupersession(
        "Blockcast/paperclip",
        "staff/blo-20742-ally-concurrency-v2",
        30796167940,
        Date.parse("2026-08-03T08:22:15Z"),
      ),
    ).toBe("superseded");
  });

  it("classifies none when the only newer sighting arrived after this run already ended", () => {
    // The genuine-kill shape: nothing newer existed yet when this run died.
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "blo-20613-claude-oom-signal", 1, Date.parse("2026-08-02T19:13:27Z"));
    expect(
      __test_classifyWorkflowRunSupersession(
        "Blockcast/paperclip",
        "blo-20613-claude-oom-signal",
        1,
        Date.parse("2026-08-02T19:34:01Z"),
      ),
    ).toBe("none");
    // A later push on the same branch, sighted only after the cancellation
    // instant, must not retroactively mark the earlier kill as superseded.
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "blo-20613-claude-oom-signal", 2, Date.parse("2026-08-02T20:00:00Z"));
    expect(
      __test_classifyWorkflowRunSupersession(
        "Blockcast/paperclip",
        "blo-20613-claude-oom-signal",
        1,
        Date.parse("2026-08-02T19:34:01Z"),
      ),
    ).toBe("none");
  });

  it("keeps branches independent -- a supersession on one branch never leaks onto another", () => {
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "branch-a", 1, Date.parse("2026-08-02T19:00:00Z"));
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "branch-a", 2, Date.parse("2026-08-02T19:05:00Z"));
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "branch-b", 3, Date.parse("2026-08-02T19:00:00Z"));
    expect(
      __test_classifyWorkflowRunSupersession("Blockcast/paperclip", "branch-b", 3, Date.parse("2026-08-02T19:10:00Z")),
    ).toBe("none");
  });

  it("ignores an out-of-order (older) sighting so it cannot regress an already-newer record", () => {
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "branch-c", 2, Date.parse("2026-08-02T19:10:00Z"));
    // A late/duplicate delivery for an older run must not evict the newer one.
    __test_recordWorkflowRunSighting("Blockcast/paperclip", "branch-c", 1, Date.parse("2026-08-02T19:05:00Z"));
    expect(
      __test_classifyWorkflowRunSupersession("Blockcast/paperclip", "branch-c", 1, Date.parse("2026-08-02T19:11:00Z")),
    ).toBe("superseded");
  });
});

describe("comment-review gate webhook trigger", () => {
  const repo = "Blockcast/paperclip";
  const head = "1234567890abcdef1234567890abcdef12345678";
  const reviewer = "allyblockcast[bot]";

  function issueCommentPayload(author = reviewer, body = "## Ally — Consolidated PR Review\n### Important Issues (0)") {
    return {
      action: "created",
      repository: { full_name: repo },
      issue: {
        number: 1049,
        html_url: `https://github.com/${repo}/pull/1049`,
        pull_request: { url: `https://api.github.com/repos/${repo}/pulls/1049` },
      },
      comment: { user: { login: author }, body },
    };
  }

  it("triggers for a trusted Ally PR comment even with no Paperclip identifier", () => {
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "issue_comment",
        issueCommentPayload(),
        reviewer,
      ),
    ).toEqual({
      repoFullName: repo,
      prNumber: 1049,
      prUrl: `https://github.com/${repo}/pull/1049`,
    });
  });

  it("rejects a same-shaped human comment and a prose mention of the heading", () => {
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "issue_comment",
        issueCommentPayload("allyblockcast"),
        reviewer,
      ),
    ).toBeNull();
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "issue_comment",
        issueCommentPayload(reviewer, "Please revisit your Ally — Consolidated PR Review."),
        reviewer,
      ),
    ).toBeNull();
  });

  it.each(["opened", "reopened", "synchronize"])("starts a fresh status check on pull_request.%s", (action) => {
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "pull_request",
        {
          action,
          repository: { full_name: repo },
          pull_request: { number: 1049, html_url: `https://github.com/${repo}/pull/1049`, head: { sha: head } },
        },
        reviewer,
      ),
    ).toEqual({
      repoFullName: repo,
      prNumber: 1049,
      headSha: head,
      prUrl: `https://github.com/${repo}/pull/1049`,
    });
  });

  it("does not run on unrelated PR lifecycle actions", () => {
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "pull_request",
        {
          action: "closed",
          repository: { full_name: repo },
          pull_request: { number: 1049, head: { sha: head } },
        },
        reviewer,
      ),
    ).toBeNull();
  });

  // BLO-29853. The event carrying 33 of 33 real consolidated reviews in this
  // repo was absent from this matrix entirely — neither asserted to trigger nor
  // asserted not to — while the block around it read as exhaustive. That
  // omission is why the gate shipped able to publish only "not evaluated".
  function reviewPayload(
    overrides: {
      action?: string;
      author?: string;
      body?: string;
      commitId?: string;
    } = {},
  ) {
    return {
      action: overrides.action ?? "submitted",
      repository: { full_name: repo },
      pull_request: { number: 1049, html_url: `https://github.com/${repo}/pull/1049`, head: { sha: head } },
      review: {
        state: "commented",
        commit_id: overrides.commitId ?? head,
        user: { login: overrides.author ?? reviewer },
        body: overrides.body ?? `## Ally — Consolidated PR Review\nReviewed head: ${head}`,
      },
    };
  }

  // `submitted` is the live repro from BLO-29853: Ally submitted a COMMENTED
  // review carrying an open Important at the then-current head of #1471 and the
  // gate never re-ran, leaving its push-time green standing for 6h+ on a
  // mergeable PR. `edited` because the verdict is a pure function of the review
  // bodies, so editing one changes it.
  it.each(["submitted", "edited"])("re-evaluates the gate on pull_request_review.%s", (action) => {
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger("pull_request_review", reviewPayload({ action }), reviewer),
    ).toEqual({
      repoFullName: repo,
      prNumber: 1049,
      prUrl: `https://github.com/${repo}/pull/1049`,
    });
  });

  // Asserted as its own case because it is a design decision, not an omission:
  // resolving the live head lets the carried-finding path see an unattested new
  // head when a review lands against one the branch has moved past. Trusting
  // `review.commit_id` (or this payload's snapshot) would instead write a status
  // to a non-head commit, where branch protection cannot see it.
  it("leaves the head unresolved so the gate reads the live head, not the reviewed one", () => {
    const trigger = __test_resolvePrCommentReviewGateWebhookTrigger(
      "pull_request_review",
      reviewPayload({ commitId: "feedfacefeedfacefeedfacefeedfacefeedface" }),
      reviewer,
    );
    expect(trigger).not.toBeNull();
    expect(trigger).not.toHaveProperty("headSha");
  });

  it("rejects a review from any author but the configured reviewer", () => {
    // Same near-miss login the issue_comment path guards: the bot suffix matters.
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "pull_request_review",
        reviewPayload({ author: "allyblockcast" }),
        reviewer,
      ),
    ).toBeNull();
  });

  it("rejects a reviewer review that is not a consolidated review", () => {
    // Not an attestation the evaluator would count either, so triggering would
    // re-publish an identical verdict for the cost of three API calls.
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "pull_request_review",
        reviewPayload({ body: "Looks good, shipping." }),
        reviewer,
      ),
    ).toBeNull();
  });

  it("does not re-evaluate on pull_request_review.dismissed", () => {
    // Dismissal leaves the review body, and therefore the verdict, unchanged.
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger(
        "pull_request_review",
        reviewPayload({ action: "dismissed" }),
        reviewer,
      ),
    ).toBeNull();
  });

  it("rejects a review payload carrying no resolvable PR number", () => {
    // The gate keys every read and the status write on the PR number, so a
    // payload without one has to drop rather than reach the API with a guess.
    const { pull_request: _omitted, ...withoutPr } = reviewPayload();
    expect(
      __test_resolvePrCommentReviewGateWebhookTrigger("pull_request_review", withoutPr, reviewer),
    ).toBeNull();
  });
});

describeEmbeddedPostgres("github-webhook route", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "test-webhook-secret-do-not-use-in-prod";
  const allowPenstockGate: NonNullable<GithubWebhookConfig["heartbeatOptions"]>["penstockAvailabilityGate"] = {
    checkAdapter: async () => ({ allow: true }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-webhook-test-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    if (!db) return;
    // These route tests default to skipQueuedRunDispatch, and several cases
    // intentionally seed queued/running rows to exercise coalescing. Finalize
    // test-owned rows directly so cleanup does not spend 30s waiting on
    // heartbeat runs that will never dispatch in this suite.
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    await tempDb?.cleanup();
  }, 60_000);

  function buildApp(config: Pick<GithubWebhookConfig, "prReviewerAgentIds" | "prReviewerAgentId" | "prReviewerBotLogin" | "runPrCommentReviewGateCheck" | "selfReviewEscalationThreshold" | "dependabotAgentId" | "dependabotMinSeverity" | "heartbeatOptions"> = {}) {
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, {
      webhookSecret,
      ...config,
      runPrCommentReviewGateCheck: config.runPrCommentReviewGateCheck ?? (async () => ({
        posted: false as const,
        reason: "not_configured" as const,
      })),
      heartbeatOptions: {
        penstockAvailabilityGate: allowPenstockGate,
        skipQueuedRunDispatch: true,
        ...config.heartbeatOptions,
      },
    }));
    app.use(errorHandler);
    return app;
  }

  function signedRequest(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const signature =
      "sha256=" + crypto.createHmac("sha256", webhookSecret).update(Buffer.from(body, "utf8")).digest("hex");
    return { body, signature };
  }

  async function seedIssueWithIdentifier(identifier: string, opts?: { status?: string; assignee?: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = identifier.split("-")[0]!;
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix,
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: opts?.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: opts?.assignee === false ? null : agentId,
      issueNumber: Number(identifier.split("-")[1] ?? 1),
      identifier,
    });
    return { companyId, agentId, issueId };
  }

  async function seedCompanyAndAgent(opts?: { agentName?: string; companyStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
      ...(opts?.companyStatus ? { status: opts.companyStatus } : {}),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts?.agentName ?? "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("rejects unsigned requests with 401", async () => {
    const app = buildApp();
    const { body, signature: _ } = signedRequest({ action: "completed", check_run: { head_branch: "fix/X-1" } });
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("503s when the webhook secret is not configured", async () => {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    }}));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, { webhookSecret: null }));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", "sha256=anything")
      .set("content-type", "application/json")
      .send(Buffer.from("{}", "utf8"));
    expect(res.status).toBe(503);
  });

  it("ignores events not in the wake-driving set", async () => {
    const app = buildApp();
    const payload = { action: "opened", issue: {} };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "push")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "push" });
  });

  it("skips terminal-status issues -- a stale CI ping shouldn't reopen done work", async () => {
    const { agentId } = await seedIssueWithIdentifier("BLO-3000", { status: "done" });
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3000",
        pull_requests: [{ number: 50, head: { ref: "fix/BLO-3000" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(0);
    expect(res.body.skipped).toEqual([
      { issueIdentifier: "BLO-3000", reason: "terminal_status" },
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(0);
  });

  it("acks events with no matching paperclip issue without erroring", async () => {
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/UNKNOWN-1234",
        pull_requests: [{ number: 1, head: { ref: "fix/UNKNOWN-1234" } }],
      },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: "no_matching_issue", identifiers: ["UNKNOWN-1234"] });
  });

  it("runs the comment-review gate for a trusted Ally comment without a Paperclip identifier", async () => {
    const calls: Array<{
      repoFullName: string;
      prNumber: number;
      headSha?: string | null;
      prUrl?: string | null;
    }> = [];
    let markCalled!: () => void;
    const called = new Promise<void>((resolve) => {
      markCalled = resolve;
    });
    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      runPrCommentReviewGateCheck: async (input) => {
        calls.push(input);
        markCalled();
        return { posted: true, verdict: { state: "success", reason: "test" } };
      },
    });
    const payload = {
      action: "created",
      repository: { full_name: "Blockcast/paperclip" },
      issue: {
        number: 1049,
        title: "No tracker reference here",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/1049" },
      },
      comment: {
        user: { login: "allyblockcast[bot]" },
        body: "## Ally — Consolidated PR Review\n### Important Issues (0)",
      },
    };
    const { body, signature } = signedRequest(payload);

    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);
    await called;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ignored: "no_paperclip_identifier" });
    expect(calls).toEqual([{
      repoFullName: "Blockcast/paperclip",
      prNumber: 1049,
      prUrl: "https://github.com/Blockcast/paperclip/pull/1049",
    }]);
  });

  it("leaves reviewer wakes queued when the webhook runs on the API tier", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({
      prReviewerAgentId: agentId,
      heartbeatOptions: {
        paperclipNodeRole: "api",
        skipQueuedRunDispatch: false,
      },
    });
    const payload = {
      action: "opened",
      pull_request: {
        number: 977,
        title: "Fence API-tier reviewer dispatch",
        body: null,
        head: { ref: "fix/api-reviewer-dispatch-fence", sha: "api-fence-head" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-api-reviewer-fence")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reviewerWakeFired: true });

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("queued");
  });

  // BLO-19566 AC4. Before this, nothing wrote a `pull_request` work product,
  // so productivity/liveness accounting -- whose own verdict criteria ask for
  // "a non-stale PR/MR link in the source issue's evidence" -- could never find
  // one, and an assignee pushing commits to an open PR read as zero progress.
  describe("pull_request work products", () => {
    function prPayload(opts: {
      action: string;
      identifier: string;
      number?: number;
      title?: string | null;
      draft?: boolean;
      merged?: boolean;
      beforeSha?: string | null;
      headSha?: string;
      updatedAt?: string;
    }) {
      const defaultUpdatedAtByAction: Record<string, string> = {
        opened: "2026-04-30T10:00:00Z",
        synchronize: "2026-04-30T10:05:00Z",
        ready_for_review: "2026-04-30T10:10:00Z",
        converted_to_draft: "2026-04-30T10:10:00Z",
        closed: "2026-04-30T10:15:00Z",
        reopened: "2026-04-30T10:20:00Z",
      };
      return {
        action: opts.action,
        ...(opts.beforeSha ? { before: opts.beforeSha } : {}),
        pull_request: {
          number: opts.number ?? 4242,
          title: opts.title === undefined ? `Fix ${opts.identifier}` : opts.title,
          body: null,
          html_url: `https://github.com/Blockcast/paperclip/pull/${opts.number ?? 4242}`,
          updated_at: opts.updatedAt ?? defaultUpdatedAtByAction[opts.action] ?? "2026-04-30T10:00:00Z",
          draft: opts.draft ?? false,
          merged: opts.merged ?? false,
          head: { ref: `fix/${opts.identifier.toLowerCase()}`, sha: opts.headSha ?? "head-one" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      };
    }

    async function postPr(
      app: express.Express,
      payload: Record<string, unknown>,
      deliveryId: string,
    ) {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    }

    it("creates a pull_request work product on the referenced issue", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40001");
      const app = buildApp();

      const res = await postPr(app, prPayload({ action: "opened", identifier: "BLO-40001" }), "wp-opened");
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#4242",
        url: "https://github.com/Blockcast/paperclip/pull/4242",
        status: "ready_for_review",
        title: "Fix BLO-40001",
      });
      expect(rows[0]?.metadata).toMatchObject({
        source: "github_pull_request_webhook",
        sourceEventOrder: 10,
        sourceEventActionOrder: 10,
        sourceEventTimestamp: "2026-04-30T10:00:00.000Z",
      });
      expect(rows[0]?.sourceTrust).toMatchObject({
        preset: "standard",
        disposition: "promoted",
        promotedByActorType: "system",
        promotedByActorId: PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
      });
    });

    it("updates the same row on a later push instead of appending one per event", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40002");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40002", number: 4243 }), "wp-seq-1");
      const afterOpen = await db
        .select({ id: issueWorkProducts.id, updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(afterOpen).toHaveLength(1);

      await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "BLO-40002",
          number: 4243,
          headSha: "head-two",
          updatedAt: "2026-04-30T10:15:00Z",
        }),
        "wp-seq-2",
      );

      const afterPush = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      // One PR, one row -- the identity excludes the head SHA on purpose.
      expect(afterPush).toHaveLength(1);
      expect(afterPush[0]?.id).toBe(afterOpen[0]?.id);
      expect(afterPush[0]?.metadata).toMatchObject({ headSha: "head-two", lastEventAction: "synchronize" });
      // updatedAt is what liveness reads as "the PR moved"; it must advance.
      expect(afterPush[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(afterOpen[0]!.updatedAt.getTime());
    });

    it("records the terminal state when the PR merges", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40003");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40003", number: 4244 }), "wp-merge-1");
      await postPr(
        app,
        prPayload({ action: "closed", identifier: "BLO-40003", number: 4244, merged: true }),
        "wp-merge-2",
      );

      const rows = await db
        .select({ status: issueWorkProducts.status })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
    });

    it("does not let a stale synchronize event overwrite a terminal merge state", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40006");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40006", number: 4247 }), "wp-order-1");
      await postPr(
        app,
        prPayload({
          action: "closed",
          identifier: "BLO-40006",
          number: 4247,
          merged: true,
          headSha: "merge-head",
          updatedAt: "2026-04-30T10:20:00Z",
        }),
        "wp-order-2",
      );
      const afterMerge = await db
        .select({ updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .then((rows) => rows[0]);
      await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "BLO-40006",
          number: 4247,
          headSha: "stale-sync-head",
          updatedAt: "2026-04-30T10:10:00Z",
        }),
        "wp-order-3",
      );

      const rows = await db
        .select({
          status: issueWorkProducts.status,
          metadata: issueWorkProducts.metadata,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "merge-head",
        lastEventAction: "closed",
        sourceEventOrder: 30,
      });
      expect(rows[0]?.updatedAt.getTime()).toBe(afterMerge?.updatedAt.getTime());
    });

    it("accepts a newer reopened event after a closed PR", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40008");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "opened",
        identifier: "BLO-40008",
        number: 4249,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-reopen-1");
      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40008",
        number: 4249,
        merged: false,
        updatedAt: "2026-04-30T10:10:00Z",
      }), "wp-reopen-2");
      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40008",
        number: 4249,
        headSha: "reopened-head",
        updatedAt: "2026-04-30T10:20:00Z",
      }), "wp-reopen-3");

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("ready_for_review");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "reopened-head",
        lastEventAction: "reopened",
        sourceEventTimestamp: "2026-04-30T10:20:00.000Z",
      });
    });

    // GitHub's `pull_request.updated_at` is second-granular, so a rapid
    // close/reopen pair carries an identical timestamp and the two true source
    // orders are indistinguishable. Action rank can only satisfy one of them, so
    // the tie resolves toward the terminal state: keeping an open state on a
    // truly-closed PR is permanent (a closed PR emits nothing further), whereas
    // keeping a closed state on a truly-open PR is corrected by the next event.
    // Both orders are covered here, plus the self-correction that pays for the
    // one we deliberately get wrong.
    it("keeps closed for a same-second reopened event after a closed PR", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40020");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40020",
        number: 4260,
        merged: false,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reopen-1");
      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40020",
        number: 4260,
        headSha: "same-second-reopen-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reopen-2");

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("closed");
      expect(rows[0]?.metadata).toMatchObject({ lastEventAction: "closed" });
    });

    it("restores a genuinely reopened PR on the next strictly-later event", async () => {
      // The cost of resolving the ambiguous tie toward `closed` is bounded: a PR
      // that really is open emits further events, and the first one carrying a
      // later `updated_at` is accepted outright.
      const { issueId } = await seedIssueWithIdentifier("BLO-40023");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40023",
        number: 4263,
        merged: false,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-selfheal-1");
      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40023",
        number: 4263,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-selfheal-2");
      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40023",
        number: 4263,
        headSha: "selfheal-head",
        updatedAt: "2026-04-30T10:00:01Z",
      }), "wp-same-second-selfheal-3");

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("ready_for_review");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "selfheal-head",
        lastEventAction: "synchronize",
      });
    });

    it("applies a distinct same-second push instead of retaining stale head metadata", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40021");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "opened",
        identifier: "BLO-40021",
        number: 4261,
        headSha: "first-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-push-1");
      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40021",
        number: 4261,
        headSha: "second-head",
        beforeSha: "first-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-push-2");

      const rows = await db
        .select({ metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "second-head",
        previousHeadSha: "first-head",
        lastEventAction: "synchronize",
      });
    });

    it("keeps closed when a same-second close follows a reopen, whether delayed or genuine", async () => {
      // This used to assert the reopen survives, on the reading that such a
      // close must be a delayed redelivery. That reading is not available from
      // the payloads: a genuinely stale close carries the *old* close's
      // `updated_at` and is already rejected on timestamp before reaching the
      // tie-break (covered below), so everything that gets here is same-second
      // and genuinely ambiguous -- byte-identical whether the close came first
      // or second. It is also the order rank alone gets wrong: the incoming
      // close ranks 30 below the stored reopen's 40, so a pure rank tie-break
      // would leave this PR `ready_for_review` and progress-eligible forever.
      const { issueId } = await seedIssueWithIdentifier("BLO-40024");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40024",
        number: 4264,
        headSha: "same-second-reopened-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reverse-reopen-1");
      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40024",
        number: 4264,
        merged: false,
        headSha: "same-second-closed-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reverse-reopen-2");

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("closed");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "same-second-closed-head",
        lastEventAction: "closed",
      });
    });

    it("still rejects a genuinely older close on timestamp, not on rank", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40025");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40025",
        number: 4265,
        headSha: "older-close-reopened-head",
        updatedAt: "2026-04-30T10:05:00Z",
      }), "wp-older-close-1");
      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40025",
        number: 4265,
        merged: false,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-older-close-2");

      const rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("ready_for_review");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "older-close-reopened-head",
        lastEventAction: "reopened",
      });
    });

    it("keeps the newest same-second push when deliveries arrive newest first", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40024");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40024",
        number: 4264,
        beforeSha: "second-head",
        headSha: "third-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reverse-push-1");
      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40024",
        number: 4264,
        beforeSha: "first-head",
        headSha: "second-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-reverse-push-2");

      const rows = await db
        .select({ metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "third-head",
        previousHeadSha: "second-head",
        lastEventAction: "synchronize",
      });
    });

    it("does not let a same-second stray event un-merge a merged PR", async () => {
      // `merged` is absorbing: the same-second reopen allowance must not become
      // a path for demoting a terminal merge.
      const { issueId } = await seedIssueWithIdentifier("BLO-40022");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "closed",
        identifier: "BLO-40022",
        number: 4262,
        merged: true,
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-merged-1");
      await postPr(app, prPayload({
        action: "reopened",
        identifier: "BLO-40022",
        number: 4262,
        headSha: "post-merge-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-same-second-merged-2");

      const rows = await db
        .select({ status: issueWorkProducts.status })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
    });

    it("ignores delayed equal-rank deliveries instead of refreshing PR liveness", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40009");
      const app = buildApp();

      await postPr(app, prPayload({
        action: "opened",
        identifier: "BLO-40009",
        number: 4250,
        headSha: "opened-head",
        updatedAt: "2026-04-30T10:00:00Z",
      }), "wp-equal-rank-1");
      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40009",
        number: 4250,
        headSha: "newer-sync-head",
        updatedAt: "2026-04-30T10:20:00Z",
      }), "wp-equal-rank-2");
      const afterNewerSync = await db
        .select({ updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .then((rows) => rows[0]);

      await postPr(app, prPayload({
        action: "synchronize",
        identifier: "BLO-40009",
        number: 4250,
        headSha: "stale-sync-head",
        updatedAt: "2026-04-30T10:05:00Z",
      }), "wp-equal-rank-3");

      const rows = await db
        .select({
          metadata: issueWorkProducts.metadata,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "newer-sync-head",
        lastEventAction: "synchronize",
        sourceEventTimestamp: "2026-04-30T10:20:00.000Z",
      });
      expect(rows[0]?.updatedAt.getTime()).toBe(afterNewerSync?.updatedAt.getTime());
    });

    it("does not refresh updatedAt for an exact webhook redelivery", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40010");
      const app = buildApp();
      const payload = prPayload({
        action: "synchronize",
        identifier: "BLO-40010",
        number: 4251,
        headSha: "same-head",
        updatedAt: "2026-04-30T10:30:00Z",
      });

      await postPr(app, payload, "wp-redelivery-1");
      const afterFirst = await db
        .select({ updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .then((rows) => rows[0]);

      await postPr(app, payload, "wp-redelivery-2");

      const rows = await db
        .select({ metadata: issueWorkProducts.metadata, updatedAt: issueWorkProducts.updatedAt })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "same-head",
        sourceEventTimestamp: "2026-04-30T10:30:00.000Z",
      });
      expect(rows[0]?.updatedAt.getTime()).toBe(afterFirst?.updatedAt.getTime());
    });

    it("keeps updating a previously linked PR row after the identifier is removed", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40007");
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40007", number: 4248 }), "wp-link-1");
      const syncWithoutIdentifier = await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "no-ticket",
          number: 4248,
          title: "Retitled without paperclip id",
          headSha: "head-without-id",
        }),
        "wp-link-2",
      );
      expect(syncWithoutIdentifier.status).toBe(200);
      expect(syncWithoutIdentifier.body).toMatchObject({ ignored: "no_matching_issue" });

      let rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("ready_for_review");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "head-without-id",
        lastEventAction: "synchronize",
      });

      const closeWithoutIdentifier = await postPr(
        app,
        prPayload({
          action: "closed",
          identifier: "no-ticket",
          number: 4248,
          title: "Retitled without paperclip id",
          merged: true,
          headSha: "merge-without-id",
        }),
        "wp-link-3",
      );
      expect(closeWithoutIdentifier.status).toBe(200);
      expect(closeWithoutIdentifier.body).toMatchObject({ ignored: "no_matching_issue" });

      rows = await db
        .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("merged");
      expect(rows[0]?.metadata).toMatchObject({
        headSha: "merge-without-id",
        lastEventAction: "closed",
        sourceEventOrder: 30,
      });
    });

    it("does not treat actor-created PR rows as previous webhook links", async () => {
      const { companyId, issueId } = await seedIssueWithIdentifier("BLO-40011");
      const app = buildApp();
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        externalId: "Blockcast/paperclip#4252",
        title: "Actor-authored PR claim",
        url: "https://github.com/Blockcast/paperclip/pull/4252",
        status: "ready_for_review",
        metadata: { source: "manual", headSha: "manual-head" },
        sourceTrust: null,
      });

      const res = await postPr(
        app,
        prPayload({
          action: "synchronize",
          identifier: "no-ticket",
          number: 4252,
          title: "Retitled without paperclip id",
          headSha: "webhook-head",
          updatedAt: "2026-04-30T10:45:00Z",
        }),
        "wp-manual-link-1",
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ignored: "no_paperclip_identifier" });
      const rows = await db
        .select({
          metadata: issueWorkProducts.metadata,
          sourceTrust: issueWorkProducts.sourceTrust,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toEqual({ source: "manual", headSha: "manual-head" });
      expect(rows[0]?.sourceTrust).toBeNull();
    });

    it("records a draft PR as draft rather than ready_for_review", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40004");
      const app = buildApp();

      await postPr(
        app,
        prPayload({ action: "opened", identifier: "BLO-40004", number: 4245, draft: true }),
        "wp-draft",
      );

      const rows = await db
        .select({ status: issueWorkProducts.status })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows[0]?.status).toBe("draft");
    });

    it("writes a row for an unassigned issue (evidence about the PR, not a wake)", async () => {
      const { issueId } = await seedIssueWithIdentifier("BLO-40005", { assignee: false });
      const app = buildApp();

      await postPr(app, prPayload({ action: "opened", identifier: "BLO-40005", number: 4246 }), "wp-unassigned");

      const rows = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId));
      expect(rows).toHaveLength(1);
    });
  });

  it("does not coalesce reviewer PR wakes into a thin null-scope automation run (BLO-7457)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const activeRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        wakeReason: "github_pr_opened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
      },
    });

    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Migrate members page",
        body: null,
        head: { ref: "migration-blo-4959-members-page" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7457")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const activeRun = runs.find((run) => run.id === activeRunId);
    expect(activeRun?.contextSnapshot).toMatchObject({
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
    });
    expect((activeRun?.contextSnapshot as Record<string, unknown> | undefined)?.githubPrNumber).toBeUndefined();

    const reviewerRun = runs.find((run) => run.id !== activeRunId);
    expect(reviewerRun?.status).toBe("queued");
    expect(reviewerRun?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:976",
      wakeReason: "github_pr_opened",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentSource: "github",
      githubEvent: "pull_request",
      githubDeliveryId: "delivery-blo-7457",
      githubPrNumber: 976,
      githubRepoFullName: "Blockcast/magma",
      reviewKind: "pr_review",
      prRole: "reviewer",
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.status)).not.toContain("coalesced");
    expect(wakes).toContainEqual(expect.objectContaining({
      status: "queued",
      reason: "github_pr_opened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:976",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7457",
        prNumber: 976,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    }));
  });

  it("counts scheduled retries when assigning to the least-loaded invokable reviewer", async () => {
    const { companyId, agentId: busyReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const idleReviewerId = randomUUID();
    await db.insert(agents).values({
      id: idleReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: busyReviewerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
      scheduledRetryReason: "ccrotate_capacity",
      contextSnapshot: { taskKey: "pr_review:blockcast/magma:975" },
    });

    const app = buildApp({ prReviewerAgentIds: [busyReviewerId, idleReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Load-balanced review",
        body: null,
        head: { ref: "review-pool" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-load")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const assigned = await db
      .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, idleReviewerId));
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:976",
      githubPrNumber: 976,
    });
  });

  it("uses a task-scoped tie-break when invokable reviewers have equal load", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 977,
        title: "Spread equal-load reviews",
        body: null,
        head: { ref: "review-pool-tie-break" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-tie-break")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toEqual([{ agentId: secondReviewerId }]);
  });

  it("does not assign PR review wakes to a terminated reviewer", async () => {
    const { companyId, agentId: activeReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const terminatedReviewerId = randomUUID();
    await db.insert(agents).values({
      id: terminatedReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "terminated",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: activeReviewerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: "pr_review:blockcast/magma:975" },
    });

    const app = buildApp({
      prReviewerAgentIds: [activeReviewerId, terminatedReviewerId],
    });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Active reviewer only",
        body: null,
        head: { ref: "review-pool-active" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-pool-active")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const activeRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, activeReviewerId));
    expect(activeRuns).toHaveLength(2);
    expect(activeRuns).toContainEqual(
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          taskKey: "pr_review:Blockcast/magma:976",
        }),
      }),
    );
    const terminatedRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, terminatedReviewerId));
    expect(terminatedRuns).toHaveLength(0);
  });

  it("assigns a PR review wake to an error-status reviewer with a healthy org chain", async () => {
    const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, reviewerId));

    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 978,
        title: "Wake the reviewer after a recoverable adapter error",
        body: null,
        head: { ref: "reviewer-error-status" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-reviewer-error-status")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reviewerWakeFired).toBe(true);
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId));
    expect(runs).toEqual([{ agentId: reviewerId, status: "queued" }]);
  });

  it("dedupes a replayed reviewer delivery across the whole reviewer pool", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 976,
        title: "Pool-wide dedupe",
        body: null,
        head: { ref: "review-pool-dedupe" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const send = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-review-pool-dedupe")
        .set("content-type", "application/json")
        .send(body);

    const first = await send();
    const replay = await send();

    expect(first.status).toBe(200);
    expect(first.body.reviewerWakeFired).toBe(true);
    expect(replay.status).toBe(200);
    expect(replay.body.reviewerWakeFired).toBe(false);
    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toHaveLength(1);
  });

  it("records a durable retry instead of bypassing an issue-create PR lock", async () => {
    const { companyId, agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const taskKey = "pr_review:blockcast/paperclip:20526";
    let releaseIssueCreate!: () => void;
    let reportGuardPassed!: () => void;
    const guardPassed = new Promise<void>((resolve) => {
      reportGuardPassed = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseIssueCreate = resolve;
    });
    const previousReviewerIds = process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;
    process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS = reviewerId;
    const issueCreate = issueService(db).create(companyId, {
      title: "Review Blockcast/paperclip PR #20526",
      description: "Please review https://github.com/blockcast/paperclip/pull/20526.",
      assigneeAgentId: reviewerId,
      status: "todo",
      priority: "medium",
      beforeSideEffects: async () => {
        reportGuardPassed();
        await release;
      },
    });
    try {
      await Promise.race([
        guardPassed,
        issueCreate.then(() => {
          throw new Error("issue create committed before reaching the guarded pause");
        }),
      ]);

      const payload = {
        action: "opened",
        pull_request: {
          number: 20526,
          title: "Do not lose a contended review wake",
          body: null,
          head: { ref: "cto/blo-20526" },
        },
        repository: { full_name: "Blockcast/paperclip" },
      };
      const { body, signature } = signedRequest(payload);
      const contended = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-20526-lock-contention")
        .set("content-type", "application/json")
        .send(body);

      // The invariant this test exists for: the webhook must never dispatch
      // outside the lock while issue-create holds the PR scope. That is
      // asserted by the zero-runs check below and is unchanged.
      //
      // What changed (BLO-21995): losing the scope no longer costs the wake, so
      // the response is no longer a 503 asking GitHub to redeliver. It is a 200
      // plus a durable retry record the reconciler owns. Answering 503 here now
      // would be worse than useless — GitHub does not auto-redeliver, and a
      // manual redelivery would race our own replay.
      expect(contended.status).toBe(200);
      expect(contended.body.reviewerWakeFired).toBe(false);
      expect(await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended")))
        .toHaveLength(1);
      expect(await db
        .select({ contextTaskKey: heartbeatRuns.contextTaskKey })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, reviewerId),
          sql`lower(${heartbeatRuns.contextTaskKey}) = ${taskKey}`,
        )))
        .toHaveLength(0);
    } finally {
      releaseIssueCreate();
      try {
        await issueCreate;
      } finally {
        if (previousReviewerIds === undefined) delete process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS;
        else process.env.PAPERCLIP_PR_REVIEWER_AGENT_IDS = previousReviewerIds;
      }
    }

    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(1);
    expect(await db
      .select({ contextTaskKey: heartbeatRuns.contextTaskKey })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, reviewerId),
        sql`lower(${heartbeatRuns.contextTaskKey}) = ${taskKey}`,
      )))
      .toHaveLength(0);
  }, 10_000);

  it("counts a review-request delivery as received+queued once, and does not count a deduped replay (BLO-18859)", async () => {
    __resetMetricsForTest();
    const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });

    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 18859,
        title: "Delivery funnel counters",
        body: null,
        // Deliberately carries no Paperclip ref in branch, title or body: this
        // test is about the reviewer-wake delivery counters, and needs the
        // route to stop at `no_paperclip_identifier` so nothing else runs. The
        // branch used to read `platform/blo-18859-...`, which only stayed
        // inert because a lowercase branch-only ref was silently dropped
        // before routing (BLO-20886) -- scaffolding that stopped being inert
        // once that was fixed.
        head: { ref: "platform/github-delivery-metrics" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const send = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-18859-funnel")
        .set("content-type", "application/json")
        .send(body);

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.reviewerWakeFired).toBe(true);

    // One delivery that cleared every gate and durably queued: both states move
    // together, and nothing was retried or lost.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(1);
    expect(await deliveryCount("retried")).toBe(0);
    expect(await deliveryCount("dead_lettered")).toBe(0);

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.reviewerWakeFired).toBe(false);

    // The replay is suppressed by the idempotency gate, which is a correct
    // no-op — NOT a received delivery. Counting it would make `received` track
    // GitHub's redelivery behavior instead of intent-to-wake, and would show a
    // permanent received/queued gap on a healthy fleet.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(1);
  });

  // BLO-21995: a sanctioned review request that loses the PR-scope advisory
  // lock used to be dropped silently — the route answered 200 with
  // reviewerWakeFired:false and wrote nothing, and GitHub only redelivers what
  // it recorded as failed. These pin the durable-retry path that replaces it.
  describe("contended PR-reviewer wake durable retry (BLO-21995)", () => {
    const REPO = "Blockcast/paperclip";

    function reviewerConfig(reviewerId: string): GithubWebhookConfig {
      return {
        webhookSecret,
        prReviewerAgentIds: [reviewerId],
        heartbeatOptions: {
          penstockAvailabilityGate: allowPenstockGate,
          skipQueuedRunDispatch: true,
        },
      };
    }

    async function runsForTask(taskKey: string) {
      return await db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.contextTaskKey, taskKey));
    }

    function openedPayload(prNumber: number) {
      return {
        action: "opened",
        pull_request: {
          number: prNumber,
          title: "Durable retry for contended reviewer wakes",
          body: null,
          head: { ref: "cto/blo-21995-durable-pr-review-retry" },
        },
        repository: { full_name: REPO },
      };
    }

    it("durably retries an initially paused reviewer and recovers when it returns", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 22003;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-initially-paused")
        .set("content-type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.reviewerWakeFired).toBe(false);
      expect(await runsForTask(taskKey)).toHaveLength(0);

      const retryRows = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(retryRows).toHaveLength(1);
      const retry = (retryRows[0]!.payload as Record<string, any>).prReviewerContendedRetry;
      expect(retry.availabilityAttempts).toBe(1);
      expect(typeof retry.unavailableSince).toBe("string");
      expect(new Date(retry.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewerId));
      const recovered = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 60_000),
      );
      expect(recovered).toMatchObject({ recovered: 1, exhausted: 0, superseded: 0 });
      expect(await runsForTask(taskKey)).toHaveLength(1);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    }, 30_000);

    it("does not retry a paused reviewer whose reporting chain is invalid", async () => {
      const { companyId, agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const terminatedManagerId = randomUUID();
      await db.insert(agents).values({
        id: terminatedManagerId,
        companyId,
        name: "Terminated manager",
        role: "manager",
        status: "terminated",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db
        .update(agents)
        .set({ status: "paused", reportsTo: terminatedManagerId })
        .where(eq(agents.id, reviewerId));
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });

      const { body, signature } = signedRequest(openedPayload(22005));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-invalid-paused-reviewer")
        .set("content-type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.reviewerWakeFired).toBe(false);
      const retryRows = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(retryRows).toHaveLength(0);
    });

    it("coalesces duplicate marker requests while the reviewer is paused", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
      const app = buildApp({
        prReviewerAgentIds: [reviewerId],
        prReviewerBotLogin: "allyblockcast[bot]",
      });
      const prNumber = 22004;
      const taskKey = `pr_review:${REPO}:${prNumber}`;
      const payload = {
        action: "created",
        issue: {
          number: prNumber,
          title: "Durable marker request while reviewer is paused",
          html_url: `https://github.com/${REPO}/pull/${prNumber}`,
          pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${prNumber}` },
          user: { login: "codex" },
        },
        comment: {
          id: 49000022004,
          body: "<!-- paperclip:review-request -->\n@ally please re-review",
          html_url: `https://github.com/${REPO}/pull/${prNumber}#issuecomment-49000022004`,
          user: { login: "allyblockcast[bot]" },
        },
        repository: { full_name: REPO },
      };
      const { body, signature } = signedRequest(payload);
      const send = (deliveryId: string) =>
        request(app)
          .post("/api/webhooks/github")
          .set("x-github-event", "issue_comment")
          .set("x-hub-signature-256", signature)
          .set("x-github-delivery", deliveryId)
          .set("content-type", "application/json")
          .send(body);

      const [first, replay] = await Promise.all([
        send("delivery-blo-21995-marker-paused-1"),
        send("delivery-blo-21995-marker-paused-2"),
      ]);
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(first.body.reviewerWakeFired).toBe(false);
      expect(replay.body.reviewerWakeFired).toBe(false);

      const retryRows = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(retryRows).toHaveLength(1);

      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewerId));
      await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 60_000),
      );
      expect(await runsForTask(taskKey)).toHaveLength(1);
      expect(await deliveryCount("queued")).toBe(1);
    }, 40_000);

    it("persists a durable record when the PR scope is contended, then dispatches exactly one wake", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 21995;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      // Hold the PR scope in a competing transaction for longer than
      // PR_REVIEWER_TASK_LOCK_TIMEOUT_MS (2s) so the delivery provably loses
      // the race rather than merely racing it.
      let releaseScope: (() => void) | null = null;
      const scopeReleased = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const scopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await scopeReleased;
      });
      // Let the holder actually acquire before the delivery arrives.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-contended")
        .set("content-type", "application/json")
        .send(body);

      expect(res.status).toBe(200);
      // Not fired *yet* — the response must never claim a run that only the
      // reconciler will enqueue.
      expect(res.body.reviewerWakeFired).toBe(false);
      // Nothing reached heartbeat while the scope was held.
      expect(await runsForTask(taskKey)).toHaveLength(0);

      // ...but the delivery is durably recorded rather than lost.
      const contended = await db
        .select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(contended).toHaveLength(1);
      expect(await deliveryCount("received")).toBe(1);
      expect(await deliveryCount("deferred")).toBe(1);
      expect(await deliveryCount("queued")).toBe(0);

      releaseScope!();
      await scopeHolder;

      // Drive the worker with a clock past the first backoff so the record is due.
      const reconciled = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 10_000),
      );
      expect(reconciled.recovered).toBe(1);
      expect(reconciled.exhausted).toBe(0);

      const runs = await runsForTask(taskKey);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.agentId).toBe(reviewerId);

      // Funnel arithmetic stays balanced across the deferral: each *attempt* is
      // one intent-to-wake that ends in exactly one terminal arm, so the
      // contended attempt lands on `deferred` and the replay on `queued` —
      // received(2) == queued(1) + deferred(1). Nothing is dead-lettered.
      expect(await deliveryCount("received")).toBe(2);
      expect(await deliveryCount("deferred")).toBe(1);
      expect(await deliveryCount("queued")).toBe(1);
      expect(await deliveryCount("retried")).toBe(1);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    }, 30_000);

    it("keeps a redelivered contended event to exactly one wake", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 21996;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      let releaseScope: (() => void) | null = null;
      const scopeReleased = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const scopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await scopeReleased;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const send = () =>
        request(app)
          .post("/api/webhooks/github")
          .set("x-github-event", "pull_request")
          .set("x-hub-signature-256", signature)
          .set("x-github-delivery", "delivery-blo-21995-redelivered")
          .set("content-type", "application/json")
          .send(body);

      // GitHub redelivers the same delivery id while the scope is still held.
      // Concurrently, not sequentially: a sequential pair is satisfied by a
      // plain select-then-insert and would not catch the race where both
      // arrivals observe no row and both write one.
      await Promise.all([send(), send()]);

      // One retry record per delivery id, not one per arrival.
      const contended = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(contended).toHaveLength(1);

      releaseScope!();
      await scopeHolder;

      // Two reconciler passes must not double-wake either.
      await reconcileContendedPrReviewerWakes(db, reviewerConfig(reviewerId), new Date(Date.now() + 10_000));
      await reconcileContendedPrReviewerWakes(db, reviewerConfig(reviewerId), new Date(Date.now() + 20_000));

      expect(await runsForTask(taskKey)).toHaveLength(1);
      expect(await deliveryCount("queued")).toBe(1);
    }, 40_000);

    it("records a contended wake even when the reviewer is paused at persistence time", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 21997;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      // The reviewer is configured but not invokable right now — a config push,
      // a restart, a transient pause. This must NOT make the contended delivery
      // unrecordable: availability is transient and the durable record exists
      // precisely to outlive it.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));

      let releaseScope: (() => void) | null = null;
      const scopeReleased = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const scopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await scopeReleased;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-paused-at-persist")
        .set("content-type", "application/json")
        .send(body);

      // 200, not 503: the delivery is durable, so GitHub must not also hold it
      // for manual redelivery.
      expect(res.status).toBe(200);
      expect(res.body.reviewerWakeFired).toBe(false);
      const contended = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(contended).toHaveLength(1);

      releaseScope!();
      await scopeHolder;

      // The reviewer comes back, and the recorded wake is still dispatchable.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewerId));
      const reconciled = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 10_000),
      );
      expect(reconciled.recovered).toBe(1);

      const runs = await runsForTask(taskKey);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.agentId).toBe(reviewerId);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    }, 40_000);

    it("re-arms rather than retiring when the reviewer is paused at reconcile time", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 21998;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      let releaseScope: (() => void) | null = null;
      const scopeReleased = new Promise<void>((resolve) => {
        releaseScope = resolve;
      });
      const scopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await scopeReleased;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-paused-at-reconcile")
        .set("content-type", "application/json")
        .send(body);

      releaseScope!();
      await scopeHolder;

      // The reviewer goes down between persistence and the first retry.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
      const firstPass = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 10_000),
      );
      // The critical assertion: a transiently unavailable reviewer must not
      // retire the record. Retiring here would drop a sanctioned review request
      // because the reviewer happened to be down for the seconds this pass ran.
      expect(firstPass.recovered).toBe(0);
      expect(firstPass.superseded).toBe(0);
      expect(firstPass.exhausted).toBe(0);
      expect(firstPass.stillContended).toBe(1);
      expect(await runsForTask(taskKey)).toHaveLength(0);
      const stillArmed = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(stillArmed).toHaveLength(1);

      // It comes back, and the next due pass dispatches exactly one wake.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewerId));
      const secondPass = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 60_000),
      );
      expect(secondPass.recovered).toBe(1);

      const runs = await runsForTask(taskKey);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.agentId).toBe(reviewerId);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    }, 40_000);

    // Ally's review of this PR: the bound was hardcoded to 4 and reasoned from
    // postgres.js's *default* pool size in prose, so a deployment that shrank
    // the pool below 9 would silently reintroduce the hard deadlock. Pinning
    // the invariant on the derivation covers pool sizes no integration test
    // could practically stand up.
    it("derives the wake concurrency bound from the pool size, leaving a spare connection", () => {
      // Each winner needs 2 connections (its lock transaction + the enqueue),
      // so the bound must leave at least one connection over for the retry
      // poller and the rest of the API tier on the same pool.
      for (const poolMax of [4, 6, 9, 10, 16, 20, 50]) {
        const bound = derivePrReviewerWakeMaxConcurrency(poolMax);
        expect(bound).toBeGreaterThanOrEqual(1);
        expect(bound * 2).toBeLessThan(poolMax);
      }
      // Never zero, even on a pathologically small pool: one winner at a time
      // still makes progress, where zero would wedge the path entirely.
      for (const poolMax of [1, 2, 3]) {
        expect(derivePrReviewerWakeMaxConcurrency(poolMax)).toBe(1);
      }
      // The shipped pool keeps the previously-hardcoded value, so this is a
      // refactor of *how* the bound is obtained, not a behaviour change.
      expect(derivePrReviewerWakeMaxConcurrency(POSTGRES_POOL_MAX)).toBe(4);
    });

    // Ally's review of this PR: `no_reviewer` re-armed on the *contention*
    // budget (~380s over 4 attempts), sized for a competing delivery holding a
    // lock. A rolling restart or a paused agent routinely exceeds that, so the
    // ordinary act of deploying the reviewer would dead-letter a sanctioned
    // review request — the exact loss this PR exists to prevent.
    it("outlives a reviewer outage longer than the whole lock-contention budget", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 22001;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      let releaseLongOutageScope: (() => void) | null = null;
      const longOutageScopeReleased = new Promise<void>((resolve) => {
        releaseLongOutageScope = resolve;
      });
      const longOutageScopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await longOutageScopeReleased;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-long-outage")
        .set("content-type", "application/json")
        .send(body);

      releaseLongOutageScope!();
      await longOutageScopeHolder;

      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));

      // Six passes spanning 45 minutes — comfortably more attempts *and* more
      // wall-clock than the contention ladder's 4 attempts / ~380s total.
      const base = Date.now();
      for (const offsetMs of [10_000, 60_000, 300_000, 600_000, 1_500_000, 2_700_000]) {
        const pass = await reconcileContendedPrReviewerWakes(
          db,
          reviewerConfig(reviewerId),
          new Date(base + offsetMs),
        );
        expect(pass.exhausted).toBe(0);
        expect(pass.superseded).toBe(0);
        expect(pass.recovered).toBe(0);
      }
      // Still armed, and crucially never dead-lettered: availability spent its
      // own wall-clock budget, not the contention attempt budget.
      expect(await deliveryCount("dead_lettered")).toBe(0);
      expect(await runsForTask(taskKey)).toHaveLength(0);

      // The availability ladder must actually escalate. Indexing it with the
      // (deliberately frozen) contention `attempts` would pin every re-arm to
      // the 30s rung and poll ~720 times across a 6h outage; the separate
      // counter is what makes the backoff grow.
      const armed = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(armed).toHaveLength(1);
      const armedReplay = (armed[0]!.payload as Record<string, any>).prReviewerContendedRetry;
      expect(armedReplay.availabilityAttempts).toBe(6);
      // The contention budget is untouched — that is the whole point.
      expect(armedReplay.attempts).toBe(0);
      expect(typeof armedReplay.unavailableSince).toBe("string");
      // Last re-arm sat on the ladder's tail (15 min), not its head (30s).
      expect(
        new Date(armedReplay.nextAttemptAt).getTime() - (base + 2_700_000),
      ).toBe(900_000);

      // The reviewer returns after the outage and the request is still there.
      // Clock is past the last re-arm's due time (base + 2_700_000 + 900_000).
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewerId));
      const recoveryPass = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(base + 3_700_000),
      );
      expect(recoveryPass.recovered).toBe(1);
      const outageRuns = await runsForTask(taskKey);
      expect(outageRuns).toHaveLength(1);
      expect(outageRuns[0]!.agentId).toBe(reviewerId);
      expect(await deliveryCount("dead_lettered")).toBe(0);
    }, 60_000);

    // Ally's review of this PR: the due-ness filter cast `nextAttemptAt` to
    // timestamptz for every candidate row, so one malformed record would throw
    // and fail the whole batch — stranding every other due retry behind it.
    it("drains a malformed retry record without poisoning the rest of the batch", async () => {
      __resetMetricsForTest();
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });
      const prNumber = 22002;
      const taskKey = `pr_review:${REPO}:${prNumber}`;

      let releaseMalformedScope: (() => void) | null = null;
      const malformedScopeReleased = new Promise<void>((resolve) => {
        releaseMalformedScope = resolve;
      });
      const malformedScopeHolder = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`);
        await malformedScopeReleased;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      const { body, signature } = signedRequest(openedPayload(prNumber));
      await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-blo-21995-alongside-malformed")
        .set("content-type", "application/json")
        .send(body);

      releaseMalformedScope!();
      await malformedScopeHolder;

      const healthyRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "pr_reviewer_dispatch_contended"));
      expect(healthyRows).toHaveLength(1);
      const healthy = healthyRows[0]!;
      const healthyPayload = (healthy.payload ?? {}) as Record<string, unknown>;
      const healthyReplay = healthyPayload.prReviewerContendedRetry as Record<string, unknown>;

      // A sibling record whose nextAttemptAt is not timestamp-castable. Written
      // by hand because no current code path produces one — the point is that a
      // future one, or a partially-rolled-out deploy, must not take the whole
      // reconciler down with it.
      await db.insert(agentWakeupRequests).values({
        ...healthy,
        id: randomUUID(),
        idempotencyKey: `${healthy.idempotencyKey}-malformed`,
        payload: {
          ...healthyPayload,
          prReviewerContendedRetry: { ...healthyReplay, nextAttemptAt: "not-a-timestamp" },
        },
      });

      // One pass must both retire the garbage and dispatch the healthy record.
      const pass = await reconcileContendedPrReviewerWakes(
        db,
        reviewerConfig(reviewerId),
        new Date(Date.now() + 10_000),
      );
      expect(pass.recovered).toBe(1);
      expect(pass.superseded).toBe(1);

      const malformedRuns = await runsForTask(taskKey);
      expect(malformedRuns).toHaveLength(1);
      expect(malformedRuns[0]!.agentId).toBe(reviewerId);
    }, 40_000);

    it("completes rather than deadlocking when concurrent distinct-PR deliveries saturate the pool", async () => {
      const { agentId: reviewerId } = await seedCompanyAndAgent({ agentName: "Ally" });
      const app = buildApp({ prReviewerAgentIds: [reviewerId] });

      // createDb's pool defaults to 10 connections. Each lock winner holds one
      // for its lock-owning transaction while heartbeat's enqueue checks out a
      // second, so >pool/2 concurrent winners on *distinct* scopes (which never
      // block each other on the advisory lock) is the saturation shape.
      const deliveries = Array.from({ length: 12 }, (_, index) => {
        const prNumber = 21_100 + index;
        const { body, signature } = signedRequest(openedPayload(prNumber));
        return request(app)
          .post("/api/webhooks/github")
          .set("x-github-event", "pull_request")
          .set("x-hub-signature-256", signature)
          .set("x-github-delivery", `delivery-blo-21995-pool-${prNumber}`)
          .set("content-type", "application/json")
          .send(body);
      });

      const responses = await Promise.all(deliveries);
      for (const res of responses) {
        expect(res.status).toBe(200);
      }
      // Every distinct scope is uncontended, so each delivery must produce its
      // own wake — none may be lost to pool starvation.
      expect(responses.filter((res) => res.body.reviewerWakeFired === true)).toHaveLength(12);
    }, 60_000);
  });

  it("counts a scheduling-gate-declined wake as suppressed, not queued, and does not claim reviewerWakeFired (BLO-18859)", async () => {
    __resetMetricsForTest();
    // A paused company makes enqueueWakeup take its `company.inactive` branch:
    // it writes a status="skipped" row and resolves *null* rather than throwing.
    // The pre-fix code counted that as `queued`, so a review that never ran
    // rendered as a healthy received+queued delivery — the exact
    // false-success this test pins down.
    const { agentId: reviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
      companyStatus: "paused",
    });

    const app = buildApp({ prReviewerAgentIds: [reviewerId] });
    const payload = {
      action: "opened",
      pull_request: {
        number: 18860,
        title: "Suppressed delivery",
        body: null,
        // No Paperclip ref anywhere, for the same reason as above.
        head: { ref: "platform/suppressed-delivery" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-18859-suppressed")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    // The 200 body must not advertise a wake that produced no run.
    expect(res.body.reviewerWakeFired).toBe(false);

    // The delivery cleared every receiver-side gate, so `received` still counts
    // it — the loss happened downstream, which is what makes the
    // received-vs-queued gap meaningful.
    expect(await deliveryCount("received")).toBe(1);
    expect(await deliveryCount("queued")).toBe(0);
    expect(await deliveryCount("suppressed")).toBe(1);
    expect(await deliveryCount("retried")).toBe(0);
    expect(await deliveryCount("dead_lettered")).toBe(0);
    // End-to-end through the real route: the cause comes from the gate inside
    // enqueueWakeup, which the route cannot see — so this also pins that the
    // route no longer emits its own causeless `suppressed` increment (that would
    // read as 2 here and desync the two counters).
    expect(await suppressionCount("company.inactive")).toBe(1);
    expect(await suppressionCount()).toBe(1);

    // Ground the counter against the durable record: a skipped row, no run.
    const wakeRows = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerId));
    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0]!.status).toBe("skipped");
    expect(wakeRows[0]!.reason).toBe("company.inactive");
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId));
    expect(runs).toHaveLength(0);
  });

  it("keeps follow-up PR review wakes with the reviewer already handling that PR", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const pullRequest = {
      number: 976,
      title: "Keep reviewer affinity",
      body: null,
      html_url: "https://github.com/Blockcast/magma/pull/976",
      head: { ref: "review-pool-affinity", sha: "first-head" },
    };
    const opened = signedRequest({
      action: "opened",
      pull_request: pullRequest,
      repository: { full_name: "Blockcast/magma" },
    });
    const openedRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", opened.signature)
      .set("x-github-delivery", "delivery-review-pool-affinity-opened")
      .set("content-type", "application/json")
      .send(opened.body);

    const synchronized = signedRequest({
      action: "synchronize",
      pull_request: {
        ...pullRequest,
        head: { ...pullRequest.head, sha: "second-head" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    const synchronizedRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", synchronized.signature)
      .set("x-github-delivery", "delivery-review-pool-affinity-synchronized")
      .set("content-type", "application/json")
      .send(synchronized.body);

    expect(openedRes.status).toBe(200);
    expect(openedRes.body.reviewerWakeFired).toBe(true);
    expect(synchronizedRes.status).toBe(200);
    expect(synchronizedRes.body.reviewerWakeFired).toBe(true);

    const runs = await db
      .select({
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, [firstReviewerId, secondReviewerId]));
    expect(runs).toHaveLength(1);
    // Which member of the pool wins the initial tie is a sha256(taskKey)
    // spreading detail, not the property under test — asserting a specific id
    // re-breaks this test every time the task key's spelling changes. What must
    // hold is that the follow-up delivery lands on whoever already owns the PR,
    // producing exactly one run carrying the newest head.
    const owningReviewerId = runs[0]!.agentId;
    expect([firstReviewerId, secondReviewerId]).toContain(owningReviewerId);
    expect(runs[0]).toMatchObject({
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:976",
        githubPrNumber: 976,
        githubHeadSha: "second-head",
      }),
    });

    const wakes = await db
      .select({
        agentId: agentWakeupRequests.agentId,
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, [firstReviewerId, secondReviewerId]));
    expect(wakes).toHaveLength(2);
    expect(wakes.every((wake) => wake.agentId === owningReviewerId)).toBe(true);
    expect(wakes).toContainEqual(expect.objectContaining({
      status: "coalesced",
      idempotencyKey:
        "pr_review:Blockcast/magma:976:github_pr_synchronized:delivery:delivery-review-pool-affinity-synchronized",
    }));
  });

  it("keeps follow-up wakes with the reviewer whose PR run is scheduled for retry", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const taskKey = "pr_review:Blockcast/magma:977";
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: firstReviewerId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
        scheduledRetryReason: "ccrotate_capacity",
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          githubPrNumber: 977,
          githubRepoFullName: "Blockcast/magma",
        },
      },
      {
        id: randomUUID(),
        companyId,
        agentId: firstReviewerId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { taskKey: "pr_review:Blockcast/other:1" },
      },
    ]);

    const app = buildApp({ prReviewerAgentIds: [firstReviewerId, secondReviewerId] });
    const delivery = signedRequest({
      action: "synchronize",
      pull_request: {
        number: 977,
        title: "Keep scheduled retry affinity",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/977",
        head: { ref: "review-pool-retry-affinity", sha: "second-head" },
      },
      repository: { full_name: "Blockcast/magma" },
    });
    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", delivery.signature)
      .set("x-github-delivery", "delivery-review-pool-retry-affinity")
      .set("content-type", "application/json")
      .send(delivery.body);

    expect(response.status).toBe(200);
    expect(response.body.reviewerWakeFired).toBe(true);
    const prRuns = await db
      .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.contextTaskKey, taskKey));
    expect(prRuns).toEqual([{ agentId: firstReviewerId, status: "scheduled_retry" }]);
    const [wake] = await db
      .select({ agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          "pr_review:Blockcast/magma:977:github_pr_synchronized:delivery:delivery-review-pool-retry-affinity",
        ),
      );
    expect(wake).toEqual({ agentId: firstReviewerId, status: "coalesced" });
  });

  it("serializes concurrent first events for the same PR before assigning a reviewer", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    const reviewerAgentIds = [firstReviewerId, secondReviewerId];
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const taskKey = "pr_review:blockcast/magma:978";
    let reportLockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      reportLockAcquired = resolve;
    });
    const releaseSignal = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockHolder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${taskKey}, 0))`,
      );
      reportLockAcquired();
      await releaseSignal;
    });
    await lockAcquired;

    const app = buildApp({ prReviewerAgentIds: reviewerAgentIds });
    const send = (action: "opened" | "synchronize", deliveryId: string, headSha: string) => {
      const signed = signedRequest({
        action,
        pull_request: {
          number: 978,
          title: "Serialize reviewer assignment",
          body: null,
          html_url: "https://github.com/Blockcast/magma/pull/978",
          head: { ref: "review-pool-concurrency", sha: headSha },
        },
        repository: { full_name: "Blockcast/magma" },
      });
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signed.signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(signed.body);
    };
    const responsesPromise = Promise.all([
      send("opened", "delivery-review-pool-concurrent-opened", "first-head"),
      send("synchronize", "delivery-review-pool-concurrent-sync", "second-head"),
    ]);

    try {
      const completedBeforeRelease = await Promise.race([
        responsesPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]);
      expect(completedBeforeRelease).toBe(false);
    } finally {
      releaseLock();
      await lockHolder;
    }

    const responses = await responsesPromise;
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.every((response) => response.body.reviewerWakeFired === true)).toBe(true);

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, reviewerAgentIds));
    expect(runs).toHaveLength(1);

    const wakes = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, reviewerAgentIds));
    expect(wakes).toHaveLength(2);
    expect(new Set(wakes.map((wake) => wake.agentId))).toEqual(
      new Set([runs[0]?.agentId]),
    );
  });

  it("ignores a GitHub redelivery of a ready_for_review event whose wake already completed (BLO-18953)", async () => {
    const { companyId } = await seedIssueWithIdentifier("BLO-3182");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const readyPayload = {
      action: "ready_for_review",
      pull_request: {
        number: 991,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        draft: false,
        html_url: "https://github.com/Blockcast/magma/pull/991",
        head: { ref: "fix/BLO-3182-webflow-blog", sha: "readysha" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const deliver = async () => {
      const signed = signedRequest(readyPayload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signed.signature)
        // GitHub reuses the delivery id when it retries or an operator replays.
        .set("x-github-delivery", "delivery-ready-replay")
        .set("content-type", "application/json")
        .send(signed.body);
    };

    const firstRes = await deliver();
    expect(firstRes.status).toBe(200);

    const idempotencyKey =
      "pr_review:Blockcast/magma:991:github_pr_ready_for_review:delivery:delivery-ready-replay";

    const reviewerWakes = async () =>
      db
        .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, reviewerAgentId));

    expect(await reviewerWakes()).toEqual([{ status: "queued", idempotencyKey }]);

    // The run consumed the wake and finished. Before BLO-18953's second pass,
    // `completed` was excluded from the precheck for EVERY reason, so replaying
    // this delivery enqueued the already-consumed request all over again.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    const replayRes = await deliver();
    expect(replayRes.status).toBe(200);
    expect(await reviewerWakes()).toEqual([{ status: "completed", idempotencyKey }]);

    // Same rule for a request retired by pull_request.converted_to_draft: a late
    // replay must not resurrect reviewer work on a PR that is a draft again.
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    const replayAfterCancel = await deliver();
    expect(replayAfterCancel.status).toBe(200);
    expect(await reviewerWakes()).toEqual([{ status: "cancelled", idempotencyKey }]);

    const reviewerRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(reviewerRuns).toHaveLength(1);
  });

  it("dedupes rapid pull_request.synchronize pushes and suppresses only synchronize author wakes", async () => {
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-3182");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 981,
        title: "Fix BLO-3182 webflow blog",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/981",
        head: { ref: "fix/BLO-3182-webflow-blog", sha: headSha },
      },
      repository: { full_name: "Blockcast/magma" },
    });

    const first = signedRequest(synchronizePayload("push1sha"));
    const firstRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", first.signature)
      .set("x-github-delivery", "delivery-sync-1")
      .set("content-type", "application/json")
      .send(first.body);

    const second = signedRequest(synchronizePayload("push2sha"));
    const secondRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", second.signature)
      .set("x-github-delivery", "delivery-sync-2")
      .set("content-type", "application/json")
      .send(second.body);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(firstRes.body.wakes).toEqual([]);
    expect(secondRes.body.wakes).toEqual([]);

    const reviewerWakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes).toHaveLength(2);
    expect(reviewerWakes).toContainEqual(expect.objectContaining({
      status: "queued",
      reason: "github_pr_synchronized",
      idempotencyKey: "pr_review:Blockcast/magma:981:github_pr_synchronized:delivery:delivery-sync-1",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:981",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-sync-1",
        prNumber: 981,
        repoFullName: "Blockcast/magma",
        headSha: "push1sha",
        paperclipIdentifiers: ["BLO-3182"],
        reviewKind: "pr_review",
      }),
    }));
    expect(reviewerWakes).toContainEqual(expect.objectContaining({
      status: "coalesced",
      reason: "github_pr_synchronized",
      idempotencyKey: "pr_review:Blockcast/magma:981:github_pr_synchronized:delivery:delivery-sync-2",
    }));

    const reviewerRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerAgentId));
    expect(reviewerRuns).toHaveLength(1);
    expect(reviewerRuns[0]?.contextSnapshot).toMatchObject({
      taskKey: "pr_review:Blockcast/magma:981",
      githubHeadSha: "push2sha",
      githubDeliveryId: "delivery-sync-2",
    });

    const authorWakesAfterSynchronize = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakesAfterSynchronize).toHaveLength(0);

    const ciPayload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow-blog",
        head_sha: "push2sha",
        html_url: "https://github.com/Blockcast/magma/actions/runs/1/job/2",
        pull_requests: [{ number: 981, head: { ref: "fix/BLO-3182-webflow-blog" } }],
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const ci = signedRequest(ciPayload);
    const ciRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", ci.signature)
      .set("x-github-delivery", "delivery-ci-after-sync")
      .set("content-type", "application/json")
      .send(ci.body);

    expect(ciRes.status).toBe(200);
    expect(ciRes.body.wakes).toEqual([{ issueIdentifier: "BLO-3182", agentId: authorAgentId }]);
    const authorWakesAfterCi = await db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakesAfterCi).toHaveLength(1);
    expect(authorWakesAfterCi[0]).toMatchObject({
      reason: "github_check_completed",
      payload: expect.objectContaining({
        source: "github",
        event: "check_run",
        deliveryId: "delivery-ci-after-sync",
        prNumber: 981,
        repoFullName: "Blockcast/magma",
      }),
    });
  });

  it("cancels queued reviewer runs across the reviewer pool when the PR closes", async () => {
    const { companyId, agentId: firstReviewerId } = await seedCompanyAndAgent({
      agentName: "Ally",
    });
    const secondReviewerId = randomUUID();
    const reviewerAgentIds = [firstReviewerId, secondReviewerId];
    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Ally 2",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const taskKey = "pr_review:blockcast/paperclip:981";
    const wakeupIds = [randomUUID(), randomUUID()];
    const runIds = [randomUUID(), randomUUID()];

    await db.insert(agentWakeupRequests).values(
      wakeupIds.map((id, index) => ({
        id,
        companyId,
        agentId: reviewerAgentIds[index],
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_synchronized",
        status: "queued",
        runId: runIds[index],
      })),
    );
    await db.insert(heartbeatRuns).values(
      runIds.map((id, index) => ({
        id,
        companyId,
        agentId: reviewerAgentIds[index],
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupIds[index],
        contextSnapshot: {
          taskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_synchronized",
          githubPrNumber: 981,
          githubRepoFullName: "Blockcast/paperclip",
        },
      })),
    );

    const app = buildApp({ prReviewerAgentIds: reviewerAgentIds });
    const payload = {
      action: "closed",
      pull_request: {
        number: 981,
        title: "Fix reviewer queue",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/981",
        merged: true,
        head: { ref: "fix/reviewer-queue", sha: "head-sha" },
        user: { login: "codex" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-pr-closed")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
      reviewerRunsCancelled: 2,
    });

    const runs = await db
      .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.agentId, reviewerAgentIds));
    const wakeups = await db
      .select({ agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, reviewerAgentIds));
    expect(new Set(runs.map((run) => run.agentId))).toEqual(new Set(reviewerAgentIds));
    expect(new Set(wakeups.map((wake) => wake.agentId))).toEqual(new Set(reviewerAgentIds));
    expect(runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(wakeups.map((wake) => wake.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("cancels pending reviewer work when the PR becomes a draft", async () => {
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-982");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const taskKey = "pr_review:blockcast/paperclip:982";
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
      scheduledRetryReason: "ccrotate_capacity",
      contextSnapshot: {
        taskKey,
        reviewKind: "pr_review",
        wakeReason: "github_pr_synchronized",
        githubPrNumber: 982,
        githubRepoFullName: "Blockcast/paperclip",
      },
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const payload = {
      action: "converted_to_draft",
      pull_request: {
        number: 982,
        title: "BLO-982 Pause reviewer work",
        body: null,
        draft: true,
        html_url: "https://github.com/Blockcast/paperclip/pull/982",
        merged: false,
        head: { ref: "draft/reviewer-queue", sha: "head-sha" },
        user: { login: "codex" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const response = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-pr-converted-to-draft")
      .set("content-type", "application/json")
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      wakes: [],
      reviewerRunsCancelled: 1,
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(run?.status).toBe("cancelled");

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakes).toEqual([]);
  });

  it("dedups a legacy-spelled redelivery against a normalized idempotency key (BLO-20526 rollout regression)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const deliveryId = "delivery-redelivered-across-rollout";

    // A normalized row can already exist from a canary or interrupted rollout.
    // Phase-one producers retain the legacy spelling for old-reader safety, so
    // the compatibility read must also work in this direction.
    const normalizedIdempotencyKey = `pr_review:blockcast/paperclip:631:github_pr_synchronized:delivery:${deliveryId}`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_synchronized",
      idempotencyKey: normalizedIdempotencyKey,
      status: "queued",
      payload: { taskKey: "pr_review:blockcast/paperclip:631" },
    });

    // GitHub reuses the delivery id when it retries a delivery, so this is the
    // same request arriving again through the phase-one legacy producer.
    const redelivery = signedRequest({
      action: "synchronize",
      pull_request: {
        number: 631,
        title: "feat(issues): reject duplicate PR-review issues",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/631",
        head: { ref: "cto/blo-20526-guard", sha: "5ec17d77" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", redelivery.signature)
      .set("x-github-delivery", deliveryId)
      .set("content-type", "application/json")
      .send(redelivery.body);

    expect(res.status).toBe(200);

    // Byte-exact equality makes the normalized row invisible to the legacy
    // spelling and queues a SECOND review. Exactly one wake must remain.
    const reviewerWakes = await db
      .select({
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes).toEqual([
      { idempotencyKey: normalizedIdempotencyKey, status: "queued" },
    ]);
  });

  it("does not permanently block reviewer wakes once a dispatch retry chain is exhausted (BLO-14395 regression)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 630,
        title: "fix(heartbeat): wake-dispatch retry",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/630",
        head: { ref: "fix/blo-14395-wake-dispatch-retry", sha: headSha },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    // Simulate a prior synchronize event whose wake dispatch retried and
    // exhausted (5 attempts, all failed) under the old stable key. Fresh
    // synchronize deliveries must not be blocked by that stale row.
    const staleIdempotencyKey = "pr_review:blockcast/paperclip:630:github_pr_synchronized";
    // Canonical mixed-case: the phase-one producer preserves GitHub's spelling.
    const freshIdempotencyKey =
      "pr_review:Blockcast/paperclip:630:github_pr_synchronized:delivery:delivery-post-exhaustion";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_synchronized",
      idempotencyKey: staleIdempotencyKey,
      status: "dispatch_failed_exhausted",
      payload: { taskKey: "pr_review:blockcast/paperclip:630" },
    });

    const fresh = signedRequest(synchronizePayload("freshsha"));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", fresh.signature)
      .set("x-github-delivery", "delivery-post-exhaustion")
      .set("content-type", "application/json")
      .send(fresh.body);

    expect(res.status).toBe(200);

    const queuedWakes = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.idempotencyKey, freshIdempotencyKey),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    expect(queuedWakes).toHaveLength(1);
    expect(queuedWakes[0]?.payload).toMatchObject({ headSha: "freshsha" });
  });

  it("re-reviews a PR after a fixup push even though the prior review completed (stale-head regression)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const synchronizePayload = (headSha: string) => ({
      action: "synchronize",
      pull_request: {
        number: 813,
        title: "feat: some change",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/813",
        head: { ref: "feat/some-change", sha: headSha },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    // A prior synchronize was reviewed to COMPLETION on an earlier head under
    // the old stable key. Fresh synchronize deliveries must not be blocked by
    // that stale row.
    const staleIdempotencyKey = "pr_review:blockcast/paperclip:813:github_pr_synchronized";
    // Canonical mixed-case: the phase-one producer preserves GitHub's spelling.
    const freshIdempotencyKey =
      "pr_review:Blockcast/paperclip:813:github_pr_synchronized:delivery:delivery-fixup-after-completed-review";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_synchronized",
      idempotencyKey: staleIdempotencyKey,
      status: "completed",
      payload: { taskKey: "pr_review:blockcast/paperclip:813", headSha: "oldhead" },
    });

    // Author pushes a fixup; the review gate is now pending on the new head. A
    // completed review of the earlier head must NOT permanently block this
    // re-review (that was the stale-head bug: `completed` in
    // IDEMPOTENT_REVIEWER_WAKE_STATUSES).
    const fresh = signedRequest(synchronizePayload("newhead"));
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", fresh.signature)
      .set("x-github-delivery", "delivery-fixup-after-completed-review")
      .set("content-type", "application/json")
      .send(fresh.body);

    expect(res.status).toBe(200);

    const queuedWakes = await db
      .select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.idempotencyKey, freshIdempotencyKey),
          eq(agentWakeupRequests.status, "queued"),
        ),
      );
    expect(queuedWakes).toHaveLength(1);
    expect(queuedWakes[0]?.payload).toMatchObject({ headSha: "newhead" });
  });

  it("does not let a completed opened wake suppress a fresh delivery and still dedupes its replay", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Phase-one producers keep GitHub's canonical mixed-case spelling, so this
    // is the key the route actually writes. The seeded stale row below stays
    // lowercase on purpose: it stands in for a row a normalized build wrote,
    // and the compatibility read has to see across the two spellings.
    const idempotencyKey = "pr_review:Blockcast/magma:1368:github_pr_opened";
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerAgentId,
      source: "github",
      reason: "github_pr_opened",
      idempotencyKey,
      status: "completed",
      payload: { taskKey: "pr_review:blockcast/magma:1368" },
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const payload = {
      action: "opened",
      pull_request: {
        number: 1368,
        title: "RELAY Wave 0",
        body: null,
        head: { ref: "relay-wave-0", sha: "opened-head-sha" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const sendDelivery = () =>
      request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", "delivery-opened-fresh")
        .set("content-type", "application/json")
        .send(body);

    const first = await sendDelivery();
    const duplicate = await sendDelivery();

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    const reviewerWakes = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes.filter((wake) => wake.status === "queued")).toEqual([
      expect.objectContaining({ idempotencyKey }),
    ]);
  });

  it("still defers to a pending or resolved dispatch-retry row (dispatch_failed / dispatch_recovered / dispatch_superseded)", async () => {
    const reviewerAgentId = randomUUID();
    const { companyId } = await seedCompanyAndAgent();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const app = buildApp({ prReviewerAgentId: reviewerAgentId });
    const openedPayload = (prNumber: number) => ({
      action: "opened",
      pull_request: {
        number: prNumber,
        title: "Some PR",
        body: null,
        head: { ref: "some-branch" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });

    let prNumber = 700;
    for (const status of ["dispatch_failed", "dispatch_recovered", "dispatch_superseded"] as const) {
      prNumber += 1;
      const idempotencyKey = `pr_review:blockcast/paperclip:${prNumber}:github_pr_opened`;
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: reviewerAgentId,
        source: "github",
        reason: "github_pr_opened",
        idempotencyKey,
        status,
        payload: { taskKey: `pr_review:blockcast/paperclip:${prNumber}` },
      });

      const { body, signature } = signedRequest(openedPayload(prNumber));
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", `delivery-opened-${status}`)
        .set("content-type", "application/json")
        .send(body);
      expect(res.status).toBe(200);

      const queuedWakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, reviewerAgentId),
            eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            eq(agentWakeupRequests.status, "queued"),
          ),
        );
      expect(queuedWakes).toHaveLength(0);
    }
  });

  it("drives a reviewer wake for pull_request.reopened even without a paperclip identifier (BLO-7426)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "reopened",
      pull_request: {
        number: 980,
        title: "Retry reviewer wake",
        body: null,
        head: { ref: "retry-review" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-7426")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        wakeReason: "github_pr_reopened",
        wakeSource: "automation",
        wakeTriggerDetail: "system",
        commentSource: "github",
        githubEvent: "pull_request",
        githubDeliveryId: "delivery-blo-7426",
        githubPrNumber: 980,
        githubRepoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
        prRole: "reviewer",
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      reason: "github_pr_reopened",
      payload: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:980",
        source: "github",
        event: "pull_request",
        deliveryId: "delivery-blo-7426",
        prNumber: 980,
        repoFullName: "Blockcast/magma",
        reviewKind: "pr_review",
      }),
    });
  });

  it("skips the reviewer wake for the reviewer's own review self-echo but still wakes for human and other-bot reviews (BLO-15799)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId, prReviewerBotLogin: "allyblockcast[bot]" });
    const reviewSubmittedPayload = (prNumber: number, reviewAuthorLogin: string) => ({
      action: "submitted",
      pull_request: {
        number: prNumber,
        title: "Some PR",
        body: null,
        html_url: `https://github.com/Blockcast/paperclip/pull/${prNumber}`,
        head: { ref: "some-branch", sha: "cafef00d" },
        user: { login: "codex" },
      },
      review: {
        body: "Consolidated review findings.",
        state: "commented",
        html_url: `https://github.com/Blockcast/paperclip/pull/${prNumber}#pullrequestreview-${prNumber}1`,
        user: { login: reviewAuthorLogin },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const send = async (payload: Record<string, unknown>, deliveryId: string) => {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "pull_request_review")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    };

    // 1. GitHub echoes the reviewer's own just-posted review straight back as
    //    pull_request_review.submitted — the observed live loop: the echo run
    //    spun a full pod, held the single run slot 1-3 minutes, and exited as
    //    an "already reviewed this head" no-op. No wake may be enqueued.
    const selfEcho = await send(reviewSubmittedPayload(1012, "allyblockcast[bot]"), "delivery-self-echo");
    expect(selfEcho.status).toBe(200);
    expect(selfEcho.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    // 2. A human review on the SAME PR still wakes — the self-echo skip must
    //    not consume the PR+reason idempotency key.
    const humanReview = await send(reviewSubmittedPayload(1012, "kkroo"), "delivery-human-review");
    expect(humanReview.status).toBe(200);
    expect(humanReview.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    // 3. Another bot's review still wakes — the filter targets the reviewer's
    //    own posting identity, not bots in general.
    const otherBotReview = await send(reviewSubmittedPayload(1013, "coderabbitai[bot]"), "delivery-other-bot");
    expect(otherBotReview.status).toBe(200);
    expect(otherBotReview.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });

    const wakes = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.map((wake) => wake.idempotencyKey).sort()).toEqual([
      "pr_review:Blockcast/paperclip:1012:github_pr_review_submitted",
      "pr_review:Blockcast/paperclip:1013:github_pr_review_submitted",
    ]);
    expect(wakes.every((wake) => wake.reason === "github_pr_review_submitted")).toBe(true);

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
  });

  it("dedupes replayed @ally PR comment reviewer wakes by comment-scoped idempotency key", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Ally" });
    const app = buildApp({ prReviewerAgentId: agentId });
    const payload = {
      action: "created",
      issue: {
        number: 1193,
        title: "feat(tenants): restore admin capability and ASN APIs",
        body: null,
        html_url: "https://github.com/Blockcast/magma/pull/1193",
        pull_request: { url: "https://api.github.com/repos/Blockcast/magma/pulls/1193" },
        user: { login: "codex" },
      },
      comment: {
        id: 4746466885,
        body: "@ally please review tenant admin API auth and migration safety.",
        html_url: "https://github.com/Blockcast/magma/pull/1193#issuecomment-4746466885",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/magma" },
    };
    const { body, signature } = signedRequest(payload);

    const first = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-comment-1")
      .set("content-type", "application/json")
      .send(body);
    const replay = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-review-comment-2")
      .set("content-type", "application/json")
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: true,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      reviewerWakeFired: false,
    });

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        taskKey: "pr_review:Blockcast/magma:1193",
        wakeReason: "github_pr_review_requested",
        githubCommentId: 4746466885,
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      idempotencyKey: "pr_review:Blockcast/magma:1193:github_pr_review_requested:comment:4746466885",
    });
  });

  it("dedupes a duplicate GitHub delivery of the same @ally review-request comment on the author wake too (BLO-13247)", async () => {
    // BLO-13247: two heartbeatRuns were observed created 19-45ms apart for
    // the same issue, both carrying the IDENTICAL x-github-delivery id and
    // comment url -- the same delivery got processed twice, and unlike the
    // reviewer-wake path above (which prechecks its idempotency key before
    // inserting), the author-wake loop only ever passed its key to
    // heartbeat.wakeup without checking for an existing wake first. This
    // reproduces that duplicate-delivery shape against a matched issue (a
    // BLO- identifier in the PR title) so the author-wake loop actually
    // runs, not just the independent reviewer-wake path.
    const { agentId } = await seedIssueWithIdentifier("BLO-9001");
    const app = buildApp();
    const payload = {
      action: "created",
      issue: {
        number: 582,
        title: "fix(docker): wrap gh to read live GitHub App token (BLO-9001)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/582",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/582" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4871387911,
        body: "@ally please review",
        html_url: "https://github.com/Blockcast/paperclip/pull/582#issuecomment-4871387911",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const first = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-author-dupe-1")
      .set("content-type", "application/json")
      .send(body);
    const replay = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-author-dupe-2")
      .set("content-type", "application/json")
      .send(body);

    expect(first.status).toBe(200);
    expect(first.body.wakes).toEqual([{ issueIdentifier: "BLO-9001", agentId }]);
    expect(replay.status).toBe(200);
    expect(replay.body.wakes).toEqual([]);
    expect(replay.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9001",
      reason: "duplicate_pr_author_wake",
    });

    const runs = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      contextSnapshot: expect.objectContaining({
        wakeReason: "github_pr_review_requested",
        prRole: "author",
      }),
    });

    const wakes = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      idempotencyKey: expect.stringContaining(
        ":Blockcast/paperclip:582:github_pr_review_requested:comment:4871387911",
      ),
    });
  });

  it("routes an author wake to the PR's owning Refs: issue, never an unrelated Related: backlink assignee (BLO-20886)", async () => {
    // Reproduces the live incident (Blockcast/paperclip#953): the PR body
    // carried `Refs: BLO-19132` (the owning issue) plus
    // `Related: BLO-20810, BLO-20129, BLO-19079` -- three bare informational
    // mentions. Before this fix, the author-wake loop treated every matched
    // identifier as equally-weighted and woke BLO-20129's assignee (the
    // THIRD Related: entry) with a "push a follow-up commit" directive for a
    // PR that agent had no relationship to at all.
    //
    // All four identifiers share the BLO prefix (as in the real incident),
    // so they're seeded as four issues under ONE company/agent set --
    // seedIssueWithIdentifier creates a fresh company per call and company
    // issue_prefix is unique, so four BLO- calls would collide.
    const { companyId } = await seedCompanyAndAgent();
    async function seedBloIssue(identifier: string) {
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent-${identifier}`,
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Test issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: Number(identifier.split("-")[1]),
        identifier,
      });
      return { agentId, issueId };
    }
    const refsIssue = await seedBloIssue("BLO-19132");
    const relatedB = await seedBloIssue("BLO-20810");
    const relatedC = await seedBloIssue("BLO-20129");
    const relatedD = await seedBloIssue("BLO-19079");
    const app = buildApp();
    const payload = {
      action: "created",
      issue: {
        number: 953,
        title: "approval dedupe v2",
        body: "Refs:    BLO-19132\nRelated: BLO-20810, BLO-20129, BLO-19079\n",
        html_url: "https://github.com/Blockcast/paperclip/pull/953",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/953" },
        user: { login: "kkroo" },
      },
      comment: {
        id: 5156328634,
        body: "@ally review exact head d9f28c1e0e6595ce8de9515bf0158b04d136a204",
        html_url: "https://github.com/Blockcast/paperclip/pull/953#issuecomment-5156328634",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-20886")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.wakes).toEqual([{ issueIdentifier: "BLO-19132", agentId: refsIssue.agentId }]);

    const allWakes = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, [
        refsIssue.agentId,
        relatedB.agentId,
        relatedC.agentId,
        relatedD.agentId,
      ]));
    // Only the Refs: owner was ever woken -- not one of the three Related:
    // assignees, and specifically never BLO-20129's (relatedC), the one that
    // fired live.
    expect(allWakes.map((w) => w.agentId)).toEqual([refsIssue.agentId]);
  });

  it("suppresses the author wake with a logged reason when a PR carries only Related: mentions and no owning reference (BLO-20886)", async () => {
    // No Refs:/Fixes:/Closes:/Resolves: line and no branch/title ref -- the
    // PR names issues but doesn't claim ownership of any of them. Acceptance
    // criterion: this must drop with a suppressionReason, not fall through to
    // an arbitrary Related: assignee.
    const relatedOnly = await seedIssueWithIdentifier("BLO-20811");
    const app = buildApp();
    const payload = {
      action: "created",
      issue: {
        number: 954,
        title: "misc cleanup",
        body: "Related: BLO-20811\n",
        html_url: "https://github.com/Blockcast/paperclip/pull/954",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/954" },
        user: { login: "kkroo" },
      },
      comment: {
        id: 5156328700,
        body: "@ally review please",
        html_url: "https://github.com/Blockcast/paperclip/pull/954#issuecomment-5156328700",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-20886-no-owner")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.wakes).toEqual([]);
    expect(res.body.skipped).toContainEqual({
      issueIdentifier: null,
      reason: "no_owning_reference",
    });

    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, relatedOnly.agentId));
    expect(wakes).toHaveLength(0);
  });

  it("routes an issue_comment @ally-review author wake to a PR's owning issue named only by a house-reference label, not a Related: mention (BLO-21312)", async () => {
    // github_pr_review_requested arrives via issue_comment, whose payload
    // carries no pull_request.head.ref -- BLO-20886's branch-tier recovery
    // can never reach this path. This PR's title and body carry no
    // Fixes:/Closes:/Resolves:/Refs: line, only a "Paperclip issue:" house
    // label (the real shape observed on Blockcast/paperclip#916) plus an
    // unrelated Related: mention -- reproducing the gap and its guardrail in
    // one payload. Both issues share the BLO prefix (as in the real PR body),
    // so they're seeded under one company -- seedIssueWithIdentifier creates
    // a fresh company per call and company issue_prefix is unique, so two
    // BLO- calls would collide.
    const { companyId } = await seedCompanyAndAgent();
    async function seedBloIssue(identifier: string) {
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Agent-${identifier}`,
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Test issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: Number(identifier.split("-")[1]),
        identifier,
      });
      return { agentId, issueId };
    }
    const owner = await seedBloIssue("BLO-19771");
    const relatedOnly = await seedBloIssue("BLO-20811");
    const app = buildApp();
    const payload = {
      action: "created",
      issue: {
        number: 916,
        title: "fix(pipelines): retire exited stage automation issues",
        body: "## Linked Issues or Issue Description\n\nPaperclip issue: https://paperclip.blockcast.net/BLO/issues/BLO-19771\nRelated: BLO-20811\n",
        html_url: "https://github.com/Blockcast/paperclip/pull/916",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/916" },
        user: { login: "kkroo" },
      },
      comment: {
        id: 5156328800,
        body: "@ally review please",
        html_url: "https://github.com/Blockcast/paperclip/pull/916#issuecomment-5156328800",
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-21312-house-label")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.wakes).toEqual([{ issueIdentifier: "BLO-19771", agentId: owner.agentId }]);
    expect(res.body.skipped).not.toContainEqual(
      expect.objectContaining({ reason: "no_owning_reference" }),
    );

    const allWakes = await db
      .select({ agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.agentId, [owner.agentId, relatedOnly.agentId]));
    // Only the house-label owner was woken -- never the Related: mention.
    expect(allWakes.map((w) => w.agentId)).toEqual([owner.agentId]);
  });

  it("delivers a lowercase branch-only author wake end-to-end (BLO-20886)", async () => {
    // Route-level companion to the pure-helper test above. The owning tiers
    // match the branch case-insensitively but the broad `identifiers`
    // extraction is uppercase-only, so a PR whose ONLY ref is a lowercase
    // branch resolved an owner and then died at the `no_paperclip_identifier`
    // gate before that owner was ever consulted -- a dropped author wake that
    // no test covered, because every existing branch fixture also carries the
    // ref in its title or body.
    const owner = await seedIssueWithIdentifier("BLO-20886");
    const app = buildApp();
    const payload = {
      action: "submitted",
      pull_request: {
        number: 962,
        title: "fix(github-webhook): tidy the receiver",
        body: "No issue reference anywhere in this body.",
        html_url: "https://github.com/Blockcast/paperclip/pull/962",
        head: { ref: "sre/blo-20886-pr-review-wake-routing", sha: "17532d7f" },
        user: { login: "kkroo" },
      },
      review: {
        state: "changes_requested",
        body: "one nit",
        html_url: "https://github.com/Blockcast/paperclip/pull/962#pullrequestreview-1",
        user: { login: "someone-else" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);

    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request_review")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-blo-20886-lowercase-branch")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    // Specifically NOT dropped as `no_paperclip_identifier`.
    expect(res.body.ignored).toBeUndefined();
    expect(res.body.wakes).toEqual([
      { issueIdentifier: "BLO-20886", agentId: owner.agentId },
    ]);
  });

  it("dedupes an @ally comment redelivery on the author wake after it completed or was cancelled (BLO-18953)", async () => {
    // Route-level companion to the reviewer redelivery test above. BLO-18953's
    // final pass made terminal-status dedup depend on the key's SCOPE, and the
    // author path shares that helper: its github_pr_review_requested key is
    // comment-scoped, i.e. request-scoped, so `completed` and `cancelled` must
    // dedup here too. __test_idempotentWakeStatuses pins the classification,
    // and the BLO-13247 test above only redelivers while the wake is still
    // `queued` -- neither proves the author dispatch threads the scope through
    // to its precheck, so that wiring could regress with both staying green.
    const { agentId } = await seedIssueWithIdentifier("BLO-9002");
    const app = buildApp();
    const commentPayload = (commentId: number) => ({
      action: "created",
      issue: {
        number: 846,
        title: "fix(github-webhook): dedup request-scoped redeliveries (BLO-9002)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/846",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/846" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: commentId,
        body: "@ally please review",
        html_url: `https://github.com/Blockcast/paperclip/pull/846#issuecomment-${commentId}`,
        user: { login: "kkroo" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const deliver = async (commentId: number, deliveryId: string) => {
      const signed = signedRequest(commentPayload(commentId));
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "issue_comment")
        .set("x-hub-signature-256", signed.signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(signed.body);
    };
    const authorWakes = async () =>
      db
        .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
    const authorHeartbeatRuns = async () =>
      db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const keyForComment = (commentId: number) =>
      expect.stringContaining(
        `:Blockcast/paperclip:846:github_pr_review_requested:comment:${commentId}`,
      );

    const first = await deliver(4900000021, "delivery-author-terminal-1");
    expect(first.status).toBe(200);
    expect(first.body.wakes).toEqual([{ issueIdentifier: "BLO-9002", agentId }]);
    expect(await authorWakes()).toEqual([
      { status: "queued", idempotencyKey: keyForComment(4900000021) },
    ]);

    // The author's run consumed the wake and finished. Replaying that one
    // delivery must not re-enqueue the request it already served.
    await db
      .update(agentWakeupRequests)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.agentId, agentId));

    const afterCompleted = await deliver(4900000021, "delivery-author-terminal-2");
    expect(afterCompleted.status).toBe(200);
    expect(afterCompleted.body.wakes).toEqual([]);
    expect(afterCompleted.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    expect(await authorWakes()).toEqual([
      { status: "completed", idempotencyKey: keyForComment(4900000021) },
    ]);

    // Same rule once the request has been retired to `cancelled`.
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.agentId, agentId));

    const afterCancelled = await deliver(4900000021, "delivery-author-terminal-3");
    expect(afterCancelled.status).toBe(200);
    expect(afterCancelled.body.wakes).toEqual([]);
    expect(afterCancelled.body.skipped).toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    expect(await authorWakes()).toEqual([
      { status: "cancelled", idempotencyKey: keyForComment(4900000021) },
    ]);

    expect(await authorHeartbeatRuns()).toHaveLength(1);

    // The other half of the scope rule: terminal dedup must stay confined to
    // the redelivered event. A genuinely NEW @ally comment carries a new
    // comment id, so the precheck lets it through -- otherwise request-scoping
    // would inherit exactly the permanent block that stable keys suffer.
    //
    // Its wake lands `coalesced` rather than `queued` because the first run is
    // still sitting in `queued`, and merging into a not-yet-started run is the
    // benign case BLO-18953 deliberately preserved: that run reads live PR
    // state when it starts, so the request is served, not lost. The point here
    // is that a wake row for the new comment EXISTS at all -- under the old
    // stable-key rule the terminal row above would have suppressed it forever.
    const laterComment = await deliver(4900000022, "delivery-author-terminal-4");
    expect(laterComment.status).toBe(200);
    expect(laterComment.body.wakes).toEqual([{ issueIdentifier: "BLO-9002", agentId }]);
    expect(laterComment.body.skipped ?? []).not.toContainEqual({
      issueIdentifier: "BLO-9002",
      reason: "duplicate_pr_author_wake",
    });
    const wakesAfterLaterComment = await authorWakes();
    expect(wakesAfterLaterComment).toHaveLength(2);
    expect(wakesAfterLaterComment).toEqual(
      expect.arrayContaining([
        { status: "cancelled", idempotencyKey: keyForComment(4900000021) },
        { status: "coalesced", idempotencyKey: keyForComment(4900000022) },
      ]),
    );
    expect(await authorHeartbeatRuns()).toHaveLength(1);
  });

  it("drives the reviewer wake AND preserves the author wake for a marker-prefixed agent review request (BLO-18865)", async () => {
    // Route-level coverage for the marker path: the pure-helper tests stop at
    // context classification, so dispatch wiring could regress while they stay
    // green. Asserts the two counts that matter -- exactly one reviewer wake,
    // and the author wake still fires.
    //
    // The author wake is the regression guard. The marker rides the shared
    // Paperclip GitHub App identity, so the route cannot tell "the PR author
    // is asking for a re-review of its own work" from "a manager or peer agent
    // is asking for a review of someone else's PR". Suppressing the author
    // wake on the marker alone silently drops the notification in the second
    // case. Here the PR is authored by `codex` and the request arrives under
    // the app identity -- a third-party request -- and BLO-18865's assignee
    // must still be woken.
    const { companyId, agentId: authorAgentId } = await seedIssueWithIdentifier("BLO-18865");
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const app = buildApp({
      prReviewerAgentId: reviewerAgentId,
      prReviewerBotLogin: "allyblockcast[bot]",
    });

    const commentPayload = (commentId: number, body: string) => ({
      action: "created",
      issue: {
        number: 822,
        title: "fix(github-webhook): let agents request an Ally re-review (BLO-18865)",
        body: null,
        html_url: "https://github.com/Blockcast/paperclip/pull/822",
        pull_request: { url: "https://api.github.com/repos/Blockcast/paperclip/pulls/822" },
        user: { login: "codex" },
      },
      comment: {
        id: commentId,
        body,
        html_url: `https://github.com/Blockcast/paperclip/pull/822#issuecomment-${commentId}`,
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    });
    const send = async (payload: Record<string, unknown>, deliveryId: string) => {
      const { body, signature } = signedRequest(payload);
      return request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", "issue_comment")
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", deliveryId)
        .set("content-type", "application/json")
        .send(body);
    };

    const marked = await send(
      commentPayload(4900000010, "<!-- paperclip:review-request -->\n@ally please re-review at head ea8697d1."),
      "delivery-agent-marker",
    );
    expect(marked.status).toBe(200);
    // NB: the response only carries `reviewerWakeFired` on the
    // no_paperclip_identifier early-return. This PR's title matches BLO-18865,
    // so the reviewer wake is asserted against the DB below instead.
    expect(marked.body.wakes).toEqual([{ issueIdentifier: "BLO-18865", agentId: authorAgentId }]);

    // The same body INDENTED at byte 0 is a Markdown code block -- a rendered
    // example, not a request -- and must not re-arm the #583 refire loop. This
    // is the offset-zero anchor asserted through the route, not just the
    // helper: a fresh comment id means nothing downstream would dedup it.
    const indentedExample = await send(
      commentPayload(4900000011, "    <!-- paperclip:review-request -->\n    @ally review\n"),
      "delivery-indented-example",
    );
    expect(indentedExample.status).toBe(200);
    // Not a request and not review feedback, so resolveEventContext returns
    // null and the route short-circuits before any identifier matching --
    // which is why `reviewerWakeFired` is observable on this one.
    expect(indentedExample.body).toMatchObject({ reviewerWakeFired: false });
    expect(indentedExample.body.wakes ?? []).toEqual([]);

    // Exactly one reviewer wake, from the marked request only.
    const reviewerWakes = await db
      .select({ reason: agentWakeupRequests.reason, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewerWakes).toHaveLength(1);
    expect(reviewerWakes[0]).toMatchObject({
      reason: "github_pr_review_requested",
      idempotencyKey:
        "pr_review:Blockcast/paperclip:822:github_pr_review_requested:comment:4900000010",
    });

    // ...and exactly one author wake, carrying the author role.
    const authorWakes = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, authorAgentId));
    expect(authorWakes).toHaveLength(1);
    expect(authorWakes[0]).toMatchObject({ reason: "github_pr_review_requested" });

    const authorRuns = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, authorAgentId));
    expect(authorRuns).toHaveLength(1);
    expect(authorRuns[0]).toMatchObject({
      contextSnapshot: expect.objectContaining({
        wakeReason: "github_pr_review_requested",
        prRole: "author",
      }),
    });
  });

  it("drives a wake on check_run.completed when the PR head_branch references a paperclip issue (CI completion)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("BLO-3182");
    const app = buildApp();
    const payload = {
      action: "completed",
      check_run: {
        head_branch: "fix/BLO-3182-webflow",
        pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "check_run")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-abc-123")
      .set("content-type", "application/json")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.wakes).toHaveLength(1);
    expect(res.body.wakes[0]).toMatchObject({
      issueIdentifier: "BLO-3182",
      agentId,
    });
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    const payload0 = wakes[0]!.payload as Record<string, unknown>;
    expect(payload0).toMatchObject({
      issueId,
      source: "github",
      event: "check_run",
      deliveryId: "delivery-abc-123",
      prNumber: 117,
      repoFullName: "Blockcast/paperclip",
      prUrl: "https://github.com/Blockcast/paperclip/pull/117",
      paperclipIdentifiers: ["BLO-3182"],
    });
    expect(wakes[0]!.reason).toBe("github_check_completed");
  });

  it("coalesces GitHub check/suite/workflow completion bursts into one queued issue wake", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("BLO-3182");
    const app = buildApp();
    const deliveries = [
      {
        event: "check_run",
        delivery: "delivery-check-run",
        payload: {
          action: "completed",
          check_run: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-check-run",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/1/job/2",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
      {
        event: "check_suite",
        delivery: "delivery-check-suite",
        payload: {
          action: "completed",
          check_suite: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-check-suite",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/1",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
      {
        event: "workflow_run",
        delivery: "delivery-workflow-run",
        payload: {
          action: "completed",
          workflow_run: {
            head_branch: "fix/BLO-3182-webflow",
            head_sha: "sha-workflow-run",
            html_url: "https://github.com/Blockcast/paperclip/actions/runs/2",
            display_title: "Fix BLO-3182 webflow",
            pull_requests: [{ number: 117, head: { ref: "fix/BLO-3182-webflow" } }],
          },
          repository: { full_name: "Blockcast/paperclip" },
        },
      },
    ];

    for (const delivery of deliveries) {
      const { body, signature } = signedRequest(delivery.payload);
      const res = await request(app)
        .post("/api/webhooks/github")
        .set("x-github-event", delivery.event)
        .set("x-hub-signature-256", signature)
        .set("x-github-delivery", delivery.delivery)
        .set("content-type", "application/json")
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.wakes).toEqual([{ issueIdentifier: "BLO-3182", agentId }]);
    }

    const runs = await db
      .select({
        status: heartbeatRuns.status,
        triggerDetail: heartbeatRuns.triggerDetail,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "queued",
      triggerDetail: "system",
      contextSnapshot: expect.objectContaining({
        issueId,
        taskId: issueId,
        wakeReason: "github_workflow_completed",
        githubDeliveryId: "delivery-workflow-run",
        githubHeadSha: "sha-workflow-run",
        githubEvent: "workflow_run",
      }),
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        coalescedCount: agentWakeupRequests.coalescedCount,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt);
    expect(wakes).toHaveLength(3);
    expect(wakes[0]).toMatchObject({
      status: "queued",
      reason: "github_workflow_completed",
      coalescedCount: 2,
      payload: expect.objectContaining({
        event: "workflow_run",
        deliveryId: "delivery-workflow-run",
        headSha: "sha-workflow-run",
      }),
    });
    expect(wakes.slice(1)).toEqual([
      expect.objectContaining({ status: "coalesced", reason: "github_state_change_queued_coalesced" }),
      expect.objectContaining({ status: "coalesced", reason: "github_state_change_queued_coalesced" }),
    ]);
  });

  it("reopens an in_review issue when Ally posts actionable PR feedback and ignores done siblings on the same PR", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Already finished child",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1124,
      identifier: "PEN-1124",
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126 and PEN-1124",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "codex-bot" },
      },
      comment: {
        id: 4784546377,
        body: [
          "## Ally — Consolidated PR Review",
          "",
          "### Important Issues (1)",
          "",
          "I1: The vault health probe still points at the wrong route.",
          "",
          "### Recommended Action",
          "",
          "Fix I1 before merge.",
        ].join("\n"),
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-1")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.reopened).toEqual([
      { issueIdentifier: "PEN-1126", commentId: expect.any(String) },
    ]);
    expect(res.body.wakes).toEqual([
      { issueIdentifier: "PEN-1126", agentId },
    ]);
    expect(res.body.skipped).toContainEqual({
      issueIdentifier: "PEN-1124",
      reason: "terminal_status",
    });

    const [updatedIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");

    const comments = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("## Changes Requested");
    expect(comments[0]!.body).toContain("https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546377");

    const wakes = await db
      .select({
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: "github_pr_review_feedback",
      payload: expect.objectContaining({
        issueId,
        wakeCommentId: comments[0]!.id,
        source: "github",
        event: "issue_comment",
        prNumber: 269,
        repoFullName: "Blockcast/penstock-llm-proxy-core",
      }),
    });

    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      commentId: comments[0]!.id,
      wakeCommentId: comments[0]!.id,
      githubReviewFeedbackCommentId: comments[0]!.id,
    });

    const duplicateRes = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-1")
      .set("content-type", "application/json")
      .send(body);
    expect(duplicateRes.status).toBe(200);
    expect(duplicateRes.body.skipped).toContainEqual({
      issueIdentifier: "PEN-1126",
      reason: "duplicate_review_feedback",
    });

    const commentsAfterDuplicate = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(commentsAfterDuplicate).toHaveLength(1);
    const wakesAfterDuplicate = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesAfterDuplicate).toHaveLength(1);
  });

  it("does not count same-number PR feedback cycles from other repos", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "system",
      body: "Prior feedback from another repo with the same PR number.",
      metadata: {
        kind: "github_pr_review_feedback",
        repoFullName: "Blockcast/other-repo",
        prNumber: 269,
      } as never,
    });

    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 2,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546378,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546378",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-repo-scope")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toBeUndefined();
    expect(res.body.wakes).toEqual([{ issueIdentifier: "PEN-1126", agentId }]);
  });

  it("counts legacy PR feedback cycles without repo metadata for the same issue and PR", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorType: "system",
      body: "Prior feedback before repoFullName was persisted in metadata.",
      metadata: {
        kind: "github_pr_review_feedback",
        prNumber: 269,
      } as never,
    });

    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 2,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546380,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546380",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-legacy-repo-metadata")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: null, ownerType: "board", cycles: 2 },
    ]);
    expect(res.body.wakes).toEqual([]);

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(authorWakes).toEqual([]);
  });

  it("escalates self-reviewed PR feedback at threshold without re-waking the assignee", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    const app = buildApp({
      prReviewerBotLogin: "allyblockcast[bot]",
      selfReviewEscalationThreshold: 1,
    });
    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "allyblockcast[bot]" },
      },
      comment: {
        id: 4784546379,
        body: "## Ally — Consolidated PR Review\n\n### Important Issues (1)\n\nFix before merge.",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-4784546379",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const { body, signature } = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", "delivery-ally-feedback-self-review-escalate")
      .set("content-type", "application/json")
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: null, ownerType: "board", cycles: 1 },
    ]);
    expect(res.body.wakes).toEqual([]);

    const actions = await db
      .select({ ownerType: issueRecoveryActions.ownerType, ownerAgentId: issueRecoveryActions.ownerAgentId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toEqual([{ ownerType: "board", ownerAgentId: null }]);

    const authorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(authorWakes).toEqual([]);
  });

  // BLO-19497: second and later Ally reviews on the same PR must still
  // produce a Changes-Requested comment. Before this fix,
  // reopenInReviewIssueForActionablePrFeedback short-circuited the ENTIRE
  // write -- comment included -- unless `issue.status === "in_review"`.
  // Review #1 flips status to `in_progress` as part of handing the PR back to
  // its author, so review #2+ on the same PR always found a non-`in_review`
  // status and silently produced zero comment, forever.
  function reviewSubmittedFeedbackPayload(input: {
    prNumber: number;
    reviewId: number;
    state: string;
    headSha: string;
    identifier: string;
    reviewAuthorLogin?: string;
    body?: string;
  }) {
    return {
      action: "submitted",
      pull_request: {
        number: input.prNumber,
        title: `Fix hosted vault onboarding (${input.identifier})`,
        body: null,
        html_url: `https://github.com/Blockcast/paperclip/pull/${input.prNumber}`,
        head: { ref: "codex/fix-vault", sha: input.headSha },
        user: { login: "codex-bot" },
      },
      review: {
        id: input.reviewId,
        body: input.body ?? "Please fix before merge.",
        state: input.state,
        html_url: `https://github.com/Blockcast/paperclip/pull/${input.prNumber}#pullrequestreview-${input.reviewId}`,
        user: { login: input.reviewAuthorLogin ?? "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
  }

  async function sendReviewSubmitted(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown>,
    deliveryId: string,
  ) {
    const { body, signature } = signedRequest(payload);
    return request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request_review")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", deliveryId)
      .set("content-type", "application/json")
      .send(body);
  }

  it("emits a Changes-Requested comment for every distinct review on a PR, not just the first, and dedupes redelivery of one review id (BLO-19497)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });

    const review1 = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 111,
      state: "changes_requested",
      headSha: "sha-one",
      identifier: "PEN-1126",
    });
    const res1 = await sendReviewSubmitted(app, review1, "delivery-review-1");
    expect(res1.status).toBe(200);
    expect(res1.body.reopened).toEqual([{ issueIdentifier: "PEN-1126", commentId: expect.any(String) }]);

    const [afterFirst] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(afterFirst?.status).toBe("in_progress");

    // Review #2: a genuinely new review (distinct review id, distinct head
    // sha) lands while the issue is still `in_progress` -- nothing moved it
    // back to `in_review` between the two reviews, which is the normal case
    // when the author hasn't resubmitted for review yet.
    const review2 = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 222,
      state: "changes_requested",
      headSha: "sha-two",
      identifier: "PEN-1126",
    });
    const res2 = await sendReviewSubmitted(app, review2, "delivery-review-2");
    expect(res2.status).toBe(200);
    expect(res2.body.reopened).toEqual([]);
    expect(res2.body.skipped).not.toContainEqual(
      expect.objectContaining({ issueIdentifier: "PEN-1126" }),
    );

    const comments = await db
      .select({ body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const feedbackComments = comments.filter(
      (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback",
    );
    expect(feedbackComments).toHaveLength(2);
    expect(feedbackComments.some((c) => c.body.includes("Reviewed head SHA: `sha-one`"))).toBe(true);
    expect(feedbackComments.some((c) => c.body.includes("Reviewed head SHA: `sha-two`"))).toBe(true);

    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(2);

    // Redelivery of the exact same review id must still dedupe to one comment.
    const res1Replay = await sendReviewSubmitted(app, review1, "delivery-review-1-replay");
    expect(res1Replay.status).toBe(200);
    const commentsAfterReplay = await db
      .select({ id: issueComments.id, metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      commentsAfterReplay.filter(
        (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback",
      ),
    ).toHaveLength(2);
  });

  // BLO-23267: real-world reproduction of the same defect via the
  // COMMENT-shaped path (issue_comment, not pull_request_review.submitted) --
  // the shape Ally's consolidated review actually takes. Payload bodies and
  // comment ids are taken verbatim from Blockcast/paperclip#1123: round 1
  // (5211484248) posted "## Changes Requested" 2s later; round 2 (5221029179,
  // ~16.5h later) re-reported the same unresolved finding as still-present
  // under a "### Prior Findings Dispositioned" heading, alongside its own
  // non-zero "### Important Issues (1)" bucket, and produced nothing before
  // this fix -- BLO-20775 sat unattended for 13h46m as a result.
  it("wakes the author again on a second comment-shaped Ally review that re-reports an unresolved finding as still-present (BLO-23267 / #1123)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const issuePayload = {
      number: 269,
      title: "Fix hosted vault onboarding",
      body: "Closes PEN-1126",
      html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
      pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
      user: { login: "codex-bot" },
    };

    const round1Payload = {
      action: "created",
      issue: issuePayload,
      comment: {
        id: 5211484248,
        body: [
          "## Ally — Consolidated PR Review",
          "",
          "Reviewed head: eb12af73f34d0d9735148505d2f338dfe5de42a2",
          "",
          "### Critical Issues (0)",
          "",
          "### Important Issues (1)",
          "- **[tests/code]** The asserted stale-useful/fresh-output state is not produced by the current running-output path.",
          "",
          "### Recommended Action",
          "1. Address the Important issue this cycle before merge.",
        ].join("\n"),
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-5211484248",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };
    const round1 = signedRequest(round1Payload);
    const round1Res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", round1.signature)
      .set("x-github-delivery", "delivery-blo23267-round1")
      .set("content-type", "application/json")
      .send(round1.body);
    expect(round1Res.status).toBe(200);
    expect(round1Res.body.reopened).toEqual([{ issueIdentifier: "PEN-1126", commentId: expect.any(String) }]);
    expect(round1Res.body.wakes).toEqual([{ issueIdentifier: "PEN-1126", agentId }]);

    const [afterRound1] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(afterRound1?.status).toBe("in_progress");

    const round2Payload = {
      action: "created",
      issue: issuePayload,
      comment: {
        id: 5221029179,
        body: [
          "## Ally — Consolidated PR Review",
          "",
          "Reviewed head: ed97d2530c67a12a3c2e8bd9c33cb73eb2b8acbc",
          "",
          "### Prior Findings Dispositioned (1)",
          "- **prior:eb12af7 important 1** — still-present — the replacement reachability rationale is still not valid.",
          "",
          "### Critical Issues (0)",
          "",
          "### Important Issues (1)",
          "- **[prior:eb12af7 important 1]** The source comment and external-Job test still imply an unreachable claim.",
          "",
          "### Recommended Action",
          "1. Correct the remaining cross-adapter reachability claim before merge.",
        ].join("\n"),
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-5221029179",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };
    const round2 = signedRequest(round2Payload);
    const round2Res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", round2.signature)
      .set("x-github-delivery", "delivery-blo23267-round2")
      .set("content-type", "application/json")
      .send(round2.body);

    expect(round2Res.status).toBe(200);
    expect(round2Res.body.skipped ?? []).not.toContainEqual(
      expect.objectContaining({ issueIdentifier: "PEN-1126" }),
    );
    expect(round2Res.body.wakes).toEqual([{ issueIdentifier: "PEN-1126", agentId }]);

    const commentsAfterRound2 = await db
      .select({ body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const feedbackCommentsAfterRound2 = commentsAfterRound2.filter(
      (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback",
    );
    expect(feedbackCommentsAfterRound2).toHaveLength(2);
    expect(feedbackCommentsAfterRound2.some((c) => c.body.includes("issuecomment-5211484248"))).toBe(true);
    expect(feedbackCommentsAfterRound2.some((c) => c.body.includes("issuecomment-5221029179"))).toBe(true);

    const wakesAfterRound2 = await db
      .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesAfterRound2).toHaveLength(2);
    expect(wakesAfterRound2.some((w) => w.reason === "github_pr_review_feedback")).toBe(true);
  });

  // BLO-23267 (CEO follow-up, #1125 live specimen): an issue identifier that
  // appears ONLY in the review's narrative prose -- not in the reviewed PR's
  // own title/body -- must not attribute a Changes-Requested wake to that
  // issue. Live case: a comment-shaped Ally review on Blockcast/paperclip#1125
  // (which is actually bound to BLO-20775's sibling PEN-1126) narrated the
  // unrelated BLO-20775 stall as motivation; the substring match alone fired
  // a wake on BLO-20775 within 246ms even though #1125 has no relationship
  // to it -- its own PR was #1123 (a different PR entirely). ACM-9099 here
  // stands in for that unrelated issue: it exists (different company/prefix
  // so it can't collide with PEN-1126 in the seed helper), it is bound to a
  // DIFFERENT PR, and its identifier shows up only inside this review's prose.
  it("does not wake an issue whose identifier appears only in the review's narrative prose, not the reviewed PR's own title/body (BLO-23267 / #1125)", async () => {
    const { agentId, issueId } = await seedIssueWithIdentifier("PEN-1126", { status: "in_review" });
    const { agentId: unrelatedAgentId, issueId: unrelatedIssueId } = await seedIssueWithIdentifier("ACM-9099", {
      status: "in_review",
    });
    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });

    const payload = {
      action: "created",
      issue: {
        number: 269,
        title: "Fix hosted vault onboarding",
        // The PR's own binding -- this is the only issue this review should
        // be able to affect.
        body: "Closes PEN-1126",
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269",
        pull_request: { url: "https://api.github.com/repos/Blockcast/penstock-llm-proxy-core/pulls/269" },
        user: { login: "codex-bot" },
      },
      comment: {
        id: 5231388259,
        body: [
          "## Ally — Consolidated PR Review",
          "",
          "Reviewed head: 3cb288e711d900283d3562b3adc9431f1a206a5f",
          "",
          "### Critical Issues (0)",
          "",
          "### Important Issues (1)",
          // ACM-9099 appears here ONLY as background narrative about a
          // different incident -- never in this PR's own title/body.
          "- **[docs]** Note: this fix is motivated by the ACM-9099 stall this cycle, which sat unattended for hours.",
          "",
          "### Recommended Action",
          "1. Tighten the wording of the motivation paragraph.",
        ].join("\n"),
        html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/269#issuecomment-5231388259",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };
    const signed = signedRequest(payload);
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "issue_comment")
      .set("x-hub-signature-256", signed.signature)
      .set("x-github-delivery", "delivery-blo23267-prose-mention")
      .set("content-type", "application/json")
      .send(signed.body);

    expect(res.status).toBe(200);
    // The PR's own bound issue still gets its legitimate wake...
    expect(res.body.reopened).toEqual([{ issueIdentifier: "PEN-1126", commentId: expect.any(String) }]);
    expect(res.body.wakes).toEqual([{ issueIdentifier: "PEN-1126", agentId }]);
    // ...but the issue mentioned only in prose must not appear anywhere in
    // the response: not reopened, not woken, not even "skipped" (skipped
    // implies it was matched and then deliberately passed over -- it must
    // never have been matched at all).
    expect(res.body.reopened).not.toContainEqual(expect.objectContaining({ issueIdentifier: "ACM-9099" }));
    expect(res.body.wakes).not.toContainEqual(expect.objectContaining({ issueIdentifier: "ACM-9099" }));
    expect(res.body.skipped ?? []).not.toContainEqual(expect.objectContaining({ issueIdentifier: "ACM-9099" }));

    const unrelatedComments = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, unrelatedIssueId));
    expect(unrelatedComments).toEqual([]);

    const unrelatedWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unrelatedAgentId));
    expect(unrelatedWakes).toEqual([]);
  });

  it("still emits the review-feedback comment and escalates to the manager when the assignee's monitor is triggered with no scheduled re-check (BLO-19497 AC #5)", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "PEN",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      reportsTo: managerId,
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // Monitor left `triggered` -- no scheduled nextCheckAt, but it has fired
    // before -- exactly the wedge BLO-19497 describes: nothing re-arms it but
    // the assignee, and the assignee isn't awake to do so.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1126,
      identifier: "PEN-1126",
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date(),
      monitorAttemptCount: 1,
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const blockingReview = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 333,
      state: "changes_requested",
      headSha: "sha-triggered",
      identifier: "PEN-1126",
    });
    const res = await sendReviewSubmitted(app, blockingReview, "delivery-monitor-triggered");

    expect(res.status).toBe(200);
    expect(res.body.reopened).toEqual([]);
    expect(res.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: managerId, ownerType: "agent", cycles: 0 },
    ]);

    const comments = await db
      .select({ body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    const feedbackComment = comments.find(
      (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback",
    );
    expect(feedbackComment?.body).toContain("Reviewed head SHA: `sha-triggered`");
    const escalationComment = comments.find(
      (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback_escalation",
    );
    expect(escalationComment).toBeTruthy();
    expect(escalationComment?.body).toContain("Manager");

    const managerWakes = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, managerId));
    expect(managerWakes).toEqual([{ reason: "unseen_blocking_review_feedback" }]);

    // A non-blocking review (formal state "commented", but with body
    // findings that still make it actionable) landing on the same wedged
    // monitor must not escalate -- AC #5 is scoped to blocking severity
    // (`changes_requested`), not every actionable review.
    const nonBlockingReview = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 334,
      state: "commented",
      headSha: "sha-triggered-2",
      identifier: "PEN-1126",
      body: "### Important Issues (1)\n\nWorth a look when convenient, not blocking.",
    });
    const res2 = await sendReviewSubmitted(app, nonBlockingReview, "delivery-monitor-triggered-non-blocking");
    expect(res2.status).toBe(200);
    expect(res2.body.escalated).toBeUndefined();

    const commentsAfterNonBlocking = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      commentsAfterNonBlocking.filter(
        (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback",
      ),
    ).toHaveLength(2);
    expect(
      commentsAfterNonBlocking.filter(
        (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback_escalation",
      ),
    ).toHaveLength(1);
  });

  // Review finding (PR #1125): isIssueMonitorTriggered used to infer
  // "triggered" from the historical columns alone (monitorLastTriggeredAt /
  // monitorAttemptCount), which stay populated forever once a monitor has
  // ever fired -- even after it was later explicitly cleared. A cleared
  // monitor has a live wake path again (whatever cleared it re-armed or
  // resolved the issue's execution), so escalating past it is a false
  // escalation, exactly the noise AC #5's manager-wake exists to avoid
  // manufacturing.
  it("does not escalate when the assignee's monitor was explicitly cleared, even though historical trigger columns are still set (PR #1125 review finding)", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "PEN",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      reportsTo: managerId,
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1126,
      identifier: "PEN-1126",
      // Historical columns still carry a prior trigger -- exactly as they
      // would right after a monitor was cleared, since nothing zeroes them.
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date(),
      monitorAttemptCount: 1,
      executionState: { monitor: { status: "cleared", clearedAt: new Date().toISOString(), clearReason: "resolved" } },
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const blockingReview = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 335,
      state: "changes_requested",
      headSha: "sha-cleared",
      identifier: "PEN-1126",
    });
    const res = await sendReviewSubmitted(app, blockingReview, "delivery-monitor-cleared");

    expect(res.status).toBe(200);
    expect(res.body.escalated ?? []).toEqual([]);

    const commentsAfterCleared = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(
      commentsAfterCleared.filter(
        (c) => (c.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback_escalation",
      ),
    ).toHaveLength(0);

    const managerWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, managerId));
    expect(managerWakes).toEqual([]);
  });

  // Review finding (PR #1125): escalation used to be gated on the outer
  // caller's reopen.commentInserted, so once the feedback comment for a
  // review existed (including from a first, otherwise-successful delivery),
  // no later redelivery could ever retry a failed escalation -- a transient
  // failure between the escalation comment write and the manager wakeup
  // permanently dropped the manager wake. This reproduces that exact window:
  // the escalation comment exists but the manager was never woken (the
  // simulated failure point), then a redelivery of the same review must
  // complete the wake without double-posting the escalation comment.
  it("retries a stalled manager escalation on redelivery without duplicating the escalation comment (PR #1125 review finding)", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "PEN",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      reportsTo: managerId,
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1126,
      identifier: "PEN-1126",
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date(),
      monitorAttemptCount: 1,
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const blockingReview = reviewSubmittedFeedbackPayload({
      prNumber: 850,
      reviewId: 336,
      state: "changes_requested",
      headSha: "sha-stalled",
      identifier: "PEN-1126",
    });
    const firstRes = await sendReviewSubmitted(app, blockingReview, "delivery-escalation-stall-1");
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: managerId, ownerType: "agent", cycles: 0 },
    ]);

    // Simulate the failure window this finding is about: the escalation
    // comment landed, but the manager wake did not (e.g. heartbeat.wakeup
    // threw after the comment insert committed). Mutate the recorded wake's
    // idempotency key rather than deleting the row -- a heartbeat run FKs to
    // it -- so the retry's idempotency lookup finds nothing, exactly as it
    // would if the wake had never been recorded.
    await db
      .update(agentWakeupRequests)
      .set({ idempotencyKey: "consumed-by-test-simulated-failure" })
      .where(eq(agentWakeupRequests.agentId, managerId));

    // GitHub redelivers the identical review (new delivery id, same review
    // id -- the feedback comment already exists and dedupes).
    const secondRes = await sendReviewSubmitted(app, blockingReview, "delivery-escalation-stall-2");
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.escalated).toEqual([
      { issueIdentifier: "PEN-1126", ownerAgentId: managerId, ownerType: "agent", cycles: 0 },
    ]);

    const escalationOnly = (
      await db
        .select({ metadata: issueComments.metadata })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
    ).filter((r) => (r.metadata as Record<string, unknown> | null)?.kind === "github_pr_review_feedback_escalation");
    // The comment was NOT duplicated even though escalation ran twice.
    expect(escalationOnly).toHaveLength(1);


    // The wake, however, was successfully redriven on retry: the original
    // (idempotency-key-mutated) row is still there, plus a fresh one from
    // the retry with the real idempotency key restored.
    const managerWakes = await db
      .select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, managerId));
    expect(managerWakes).toHaveLength(2);
    expect(managerWakes.some((w) => w.idempotencyKey === "consumed-by-test-simulated-failure")).toBe(true);
    expect(
      managerWakes.some(
        (w) => w.idempotencyKey?.startsWith("unseen_blocking_review_escalation:") && w.idempotencyKey !== "consumed-by-test-simulated-failure",
      ),
    ).toBe(true);
  });

  // Ally review on PR #1125: escalateUnseenBlockingReviewFeedback's comment
  // write was a read-then-insert (SELECT by metadata.externalKey, then
  // INSERT if none found) -- the same check-then-write race BLO-19037 fixed
  // for the dependabot receipt path above. Two concurrent redeliveries of the
  // identical review can both observe "no existing escalation comment"
  // before either commits, double-posting the escalation. Firing both
  // requests through `Promise.all` interleaves them at the same await
  // boundaries a second paperclip-api replica would race across.
  it("dedupes concurrent redeliveries of the same blocking review to a single escalation comment", async () => {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "PEN",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: managerId,
      companyId,
      name: "Manager",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      reportsTo: managerId,
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1127,
      identifier: "PEN-1127",
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date(),
      monitorAttemptCount: 1,
    });

    const app = buildApp({ prReviewerBotLogin: "allyblockcast[bot]" });
    const blockingReview = reviewSubmittedFeedbackPayload({
      prNumber: 851,
      reviewId: 337,
      state: "changes_requested",
      headSha: "sha-race",
      identifier: "PEN-1127",
    });

    // Warm the connection pool to >=2 physical connections before racing --
    // see the dependabot concurrency test above for why this is necessary.
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select 1`)));

    const [first, second] = await Promise.all([
      sendReviewSubmitted(app, blockingReview, "delivery-escalation-race"),
      sendReviewSubmitted(app, blockingReview, "delivery-escalation-race"),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const escalationComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          sql`${issueComments.metadata}->>'kind' = 'github_pr_review_feedback_escalation'`,
        ),
      );
    expect(escalationComments).toHaveLength(1);
  });

  function dependabotPayload(severity: string, action = "created", alertNumber = 58) {
    return {
      action,
      alert: {
        number: alertNumber,
        html_url: `https://github.com/Blockcast/paperclip/security/dependabot/${alertNumber}`,
        dependency: {
          package: { ecosystem: "npm", name: "vitest" },
          manifest_path: "packages/mcp-gateway/package.json",
        },
        security_advisory: {
          ghsa_id: "GHSA-5xrq-8626-4rwp",
          cve_id: "CVE-2026-47429",
          summary: "When Vitest UI server is listening, arbitrary file can be read and executed",
          severity,
        },
        security_vulnerability: {
          package: { ecosystem: "npm", name: "vitest" },
          severity,
          vulnerable_version_range: "< 3.2.6",
          first_patched_version: { identifier: "3.2.6" },
        },
      },
      repository: { full_name: "Blockcast/paperclip" },
    };
  }

  async function postDependabot(
    app: ReturnType<typeof buildApp>,
    payload: Record<string, unknown>,
    deliveryId = "delivery-dependabot-1",
  ) {
    const { body, signature } = signedRequest(payload);
    return request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "dependabot_alert")
      .set("x-hub-signature-256", signature)
      .set("x-github-delivery", deliveryId)
      .set("content-type", "application/json")
      .send(body);
  }

  it("drives a remediation wake for a critical dependabot alert", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      dependabotWakeFired: true,
    });

    const runs = await db
      .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    const contextSnapshot = runs[0]!.contextSnapshot as Record<string, unknown>;
    expect(contextSnapshot).toMatchObject({
      taskKey: "github-dependabot:Blockcast/paperclip#58",
      wakeReason: "github_dependabot_alert",
      dependabotAlertNumber: 58,
      dependabotSeverity: "critical",
      dependabotPackage: "vitest",
      dependabotGhsaId: "GHSA-5xrq-8626-4rwp",
      dependabotCveId: "CVE-2026-47429",
      dependabotPatchedVersion: "3.2.6",
      dependabotManifestPath: "packages/mcp-gateway/package.json",
    });

    // BLO-16319: the wake must be scoped to a real, assigned Paperclip issue
    // so PAPERCLIP_TASK_ID and the task markdown are populated instead of an
    // empty task that falls back to whatever workspace was last used.
    const issueId = contextSnapshot.issueId as string | undefined;
    expect(typeof issueId).toBe("string");
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId!)));
    expect(issue).toBeTruthy();
    expect(issue!.status).toBe("todo");
    expect(issue!.assigneeAgentId).toBe(agentId);
    expect(issue!.originKind).toBe("github_dependabot_alert");
    expect(issue!.originId).toBe("github-dependabot:Blockcast/paperclip#58");
    expect(issue!.title).toContain("Blockcast/paperclip#58");
    expect(issue!.description).toContain("Blockcast/paperclip");
    expect(issue!.description).toContain("#58");
    expect(issue!.description).toContain("vitest");
    expect(issue!.description).toContain("GHSA-5xrq-8626-4rwp");
    expect(issue!.description).toContain("CVE-2026-47429");
    expect(issue!.description).toContain("critical");
    expect(issue!.description).toContain("< 3.2.6");
    expect(issue!.description).toContain("3.2.6");
    expect(issue!.description).toContain("packages/mcp-gateway/package.json");
    expect(issue!.description).toContain("security/dependabot/58");
  });

  // BLO-19113: the verifying signal used to be a single bullet holding a
  // three-branch disjunction, followed by a bare paragraph about the Dependabot
  // Alerts REST API. A downstream task author read that block, silently dropped
  // the merged-PR branch, and re-read the operational REST aside as an
  // evidentiary rule ("authenticated UI or webhook only") — a standard no agent
  // can satisfy. That misreading blocked an already-remediated high-severity CVE
  // for six days. These assertions pin the disambiguated wording so the
  // disjunction cannot be flattened back into prose.
  it("keeps Dependabot acceptance criteria consistent with agent-executable closure evidence", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical"));
    expect(res.status).toBe(200);

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_alert")));
    const description = issue!.description!;

    // All three sufficient branches survive, each on its own numbered line.
    expect(description).toContain("Any ONE of the following is sufficient and complete evidence");
    expect(description).toMatch(/^1\. The default-branch manifest/m);
    expect(description).toMatch(/^2\. .*shows `state: fixed` for advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429\.$/m);
    expect(description).toMatch(
      /^3\. A documented dismissal reason is recorded, and either a terminal dismissal webhook receipt on this issue or .*shows `state: dismissed` for advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429\.$/m,
    );
    // Branch 1 names the same concrete closure fields as remediation acceptance,
    // so it is actionable without re-deriving anything from the alert page.
    expect(description).toMatch(
      /^1\. The default-branch manifest `packages\/mcp-gateway\/package\.json` in `Blockcast\/paperclip` resolves vitest at 3\.2\.6 or newer, outside the vulnerable range < 3\.2\.6, with advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429 cited in the evidence\.$/m,
    );

    // Acceptance criteria split remediation from dismissal instead of implying
    // the dismissal path also needs a merged PR.
    expect(description).toContain("Remediation path:");
    expect(description).toContain("Dismissal path:");
    expect(description).toMatch(
      /^- Remediation path: the default-branch manifest `packages\/mcp-gateway\/package\.json` in `Blockcast\/paperclip` resolves vitest at 3\.2\.6 or newer, outside the vulnerable range < 3\.2\.6, and the evidence cites advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429\. A GitHub alert-state receipt is sufficient but not required\.$/m,
    );
    expect(description).toMatch(
      /^- Dismissal path: a documented dismissal reason is recorded, and either a terminal dismissal webhook receipt on this issue or direct terminal-state observation from GitHub shows the alert is dismissed for advisory GHSA-5xrq-8626-4rwp \/ CVE-2026-47429\.$/m,
    );
    expect(description).not.toContain("alert's state on GitHub moves to `fixed`");
    expect(description).not.toContain("alert's state on GitHub is `dismissed`");

    // The two sentences that directly refute the misreading.
    expect(description).toContain("Do NOT require a screenshot of the alert page");
    expect(description).toContain("never prerequisites");

    // The REST note is a separately-headed operational aside, not a rule about
    // which evidence counts.
    expect(description).toContain("## Note on the Dependabot Alerts REST API (operational, not evidentiary)");
    expect(description).toContain("403 Dependabot alerts are disabled for this repository");
    expect(description).toContain("It is NOT an evidentiary standard");
    expect(description).toContain("does not forbid the repository contents API or GraphQL");

    // Preserve the operational prohibition verbatim while changing closure criteria.
    expect(description).toContain(
      "Every field under **Alert** above comes from this delivery's GitHub webhook payload. Do NOT call the GitHub Dependabot Alerts REST API to re-derive them: some repositories return `403 Dependabot alerts are disabled for this repository` on that endpoint even though the webhook still fires. Treat that 403 as expected and work from this issue instead of chasing the API.",
    );
  });

  it("does not wake below the severity floor (default high)", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("medium"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("honors a lowered severity floor", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId, dependabotMinSeverity: "medium" });

    const res = await postDependabot(app, dependabotPayload("medium"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: true });
  });

  it("acks dependabot alerts without waking when no remediation agent is configured", async () => {
    const app = buildApp();

    const res = await postDependabot(app, dependabotPayload("critical"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ignored: "no_paperclip_identifier",
      dependabotWakeFired: false,
    });
  });

  // BLO-26613: the Dependabot alert route has exactly one configured owner
  // and no fallback. A paused (or otherwise uninvokable) configured agent
  // must not receive the new alert issue silently -- it should file
  // unassigned so `allow_company_agent` lets any agent pick it up. The wake
  // to the paused agent itself still fails (heartbeat.wakeup rejects a
  // paused target and the error is caught/logged a few lines below) --
  // that is a pre-existing, separate mechanism this change does not touch.
  // The point of this test is that the ISSUE doesn't silently inherit the
  // paused assignee merely because the wake attempt happened to fail too.
  it("files a new dependabot alert issue unassigned when the configured agent is paused", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_alert")));
    expect(issue).toBeTruthy();
    expect(issue!.assigneeAgentId).toBeNull();
    expect(issue!.assigneeUserId).toBeNull();
    expect(issue!.status).toBe("todo");
  });

  it("dedupes a redelivered dependabot created alert via the idempotency key", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical"), "delivery-1");
    const res2 = await postDependabot(app, dependabotPayload("critical"), "delivery-2");

    expect(res2.status).toBe(200);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toHaveLength(1);
  });

  it("reuses the open issue when a reintroduced alert redelivers for the same alert number", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const created = await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    expect(created.body).toMatchObject({ dependabotWakeFired: true });

    const reintroduced = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-reintroduced",
    );
    expect(reintroduced.body).toMatchObject({ dependabotWakeFired: true });

    // One issue per alert (BLO-16319 verifying signal: "replaying the fixture
    // yields a scoped issue ... that the Release Engineer can ... dedupe").
    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "github_dependabot_alert"));
    expect(alertIssues).toHaveLength(1);

    // The reintroduced wake shares the alert's taskKey with the still-queued
    // "created" run, so enqueueWakeup's generic task-scope coalescing
    // (coalescePendingTaskScopeWake) merges it into that one heartbeat run
    // rather than queuing a second -- the same de-duplication every other
    // taskKey-scoped wake gets. `dependabotWakeFired: true` above confirms
    // both deliveries were processed; what matters here is that the run(s)
    // that do exist all point at the single reused issue.
    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const run of runs) {
      expect((run.contextSnapshot as Record<string, unknown>).issueId).toBe(alertIssues[0]!.id);
    }
  });

  it("records a terminal webhook receipt on the alert issue and closes it", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    const terminal = await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");

    expect(terminal.status).toBe(200);
    expect(terminal.body).toMatchObject({ dependabotWakeFired: false });
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).toBe("done");
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toContain("Action: `fixed`");
    expect(receipts[0]!.body).toContain("GitHub delivery: `delivery-fixed`");
    expect(receipts[0]!.body).toContain("no Dependabot REST or GraphQL query was used");
  });

  // BLO-28981: `issues_active_dependabot_alert_uq` only constrains non-terminal
  // rows, so once a cycle's issue closed, the next re-fire matched nothing in
  // findOpenDependabotAlertIssue and the intake minted a brand-new full-weight
  // row. On `Blockcast/magma` that produced 8 alerts x 3 cycles = 24 rows under
  // 8 identical originIds, each one context-free -- the adjudication that closed
  // the previous cycle never travelled with the alert, so the same conclusion
  // was re-derived every cycle at ~8 agent runs a time.
  it("reopens the adjudicated issue instead of refiling when a closed alert re-fires", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    const [originalIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(originalIssue!.status).toBe("todo");

    // The cycle is adjudicated and closed.
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");
    const [closed] = await db.select().from(issues).where(eq(issues.id, originalIssue!.id));
    expect(closed!.status).toBe("done");

    // GitHub re-fires the same alert.
    const refire = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-1",
    );
    expect(refire.status).toBe(200);
    expect(refire.body).toMatchObject({ dependabotWakeFired: true });

    // The row count does not grow: this is the fourth-row check the production
    // verifying signal watches for.
    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(alertIssues).toHaveLength(1);
    expect(alertIssues[0]!.id).toBe(originalIssue!.id);

    // ...and it is reopened, assigned, and no longer carrying the closed row's
    // completion timestamp or a stale execution lock.
    const reopened = alertIssues[0]!;
    expect(reopened.status).toBe("todo");
    expect(reopened.assigneeAgentId).toBe(agentId);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.checkoutRunId).toBeNull();
    expect(reopened.executionRunId).toBeNull();

    // The re-fire is recorded on the row, so the next agent to pick it up reads
    // that this is a repeat rather than starting cold.
    const refireComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, reopened.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    expect(refireComments).toHaveLength(1);
    expect(refireComments[0]!.body).toContain("reopened in place");
    expect(refireComments[0]!.body).toContain("Action: `reintroduced`");
    expect(refireComments[0]!.body).toContain("GitHub delivery: `delivery-refire-1`");
    // The prior adjudication is the terminal receipt already on this row.
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, reopened.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toHaveLength(1);
  });

  // The regression signal must survive the dedupe: reopening changes WHICH row
  // the alert lands on, never whether it reaches someone. A dependency that was
  // genuinely fixed and then reintroduced by a later commit still has to wake an
  // assignee.
  it("still wakes an assignee when a closed alert is genuinely reintroduced", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");

    const refire = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-2",
    );
    expect(refire.body).toMatchObject({ dependabotWakeFired: true });

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue!.status).toBe("todo");
    expect(issue!.assigneeAgentId).toBe(agentId);

    // The re-fire enqueued its own wake, keyed on this delivery. Do NOT assert a
    // run-count delta here: the re-fire shares the alert's taskKey with the
    // "created" run, so if that run is still queued, enqueueWakeup's generic
    // coalescing (coalescePendingTaskScopeWake) merges the re-fire into it
    // instead of queuing a second -- see the sibling "reuses the open issue"
    // test. Whether it coalesces depends on how far the earlier run has
    // progressed, which is not deterministic across suite orderings. The wake
    // request is the durable evidence that the regression reached the assignee.
    const wakes = await db
      .select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(
      wakes.some((wake) =>
        wake.idempotencyKey === "github-dependabot:Blockcast/paperclip#58:reintroduced:delivery-refire-2",
      ),
    ).toBe(true);

    // ...and whichever run(s) exist all point at the one surviving issue.
    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const run of runs) {
      expect((run.contextSnapshot as Record<string, unknown>).issueId).toBe(issue!.id);
    }
  });

  // The normal path must not regress: an alert nobody has seen before still gets
  // a full-weight issue, with no reopen machinery involved.
  it("still files a fresh issue for a first-ever alert with no prior adjudication", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(app, dependabotPayload("critical", "created", 4242), "delivery-first");
    expect(res.body).toMatchObject({ dependabotWakeFired: true });

    const alertIssues = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originId, "github-dependabot:Blockcast/paperclip#4242"),
        ),
      );
    expect(alertIssues).toHaveLength(1);
    const issue = alertIssues[0]!;
    expect(issue.status).toBe("todo");
    expect(issue.assigneeAgentId).toBe(agentId);
    // Full alert body, not a reopen notice.
    expect(issue.description).toContain("## Acceptance criteria");
    expect(issue.description).toContain("security/dependabot/4242");

    const refireComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    expect(refireComments).toHaveLength(0);
  });

  // Pre-fix history: the 24 rows already in production sit under the same
  // originId as terminal siblings. The reopened row must name them so the whole
  // adjudication chain stays reachable from the one row that survives.
  it("carries prior adjudication rows into the reopened issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");

    // An older, already-closed duplicate from before this fix shipped. Terminal
    // rows are outside the partial unique index, which is exactly why the old
    // behaviour could stack them.
    const [legacyDuplicate] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Dependabot critical alert: vitest in Blockcast/paperclip#58",
        description: "Adjudicated in an earlier cycle.",
        status: "done",
        priority: "critical",
        originKind: "github_dependabot_alert",
        originId: "github-dependabot:Blockcast/paperclip#58",
        originFingerprint: "github-dependabot:Blockcast/paperclip#58",
        // Real rows carry an identifier from issueService.create; a raw insert
        // does not, and the identifier is what the reopen notice links to.
        issueNumber: 22652,
        identifier: "BLO-22652",
        completedAt: new Date("2026-08-06T00:00:00.000Z"),
        createdAt: new Date("2026-08-06T00:00:00.000Z"),
      })
      .returning({ id: issues.id, identifier: issues.identifier });

    await postDependabot(app, dependabotPayload("critical", "reintroduced"), "delivery-refire-3");

    // Still no new row: two terminal rows existed, and the newest was reopened.
    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(alertIssues).toHaveLength(2);
    const open = alertIssues.filter((row) => row.status === "todo");
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(legacyDuplicate!.id);

    const [refireComment] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, open[0]!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    expect(refireComment!.body).toContain("Earlier rows for this same alert (1)");
    expect(refireComment!.body).toContain(legacyDuplicate!.identifier!);
    expect(refireComment!.body).toContain("adjudicated before");
  });

  // A replayed delivery never reaches the reopen path at all: the wake
  // pre-check in the dependabot handler keys on
  // `${taskKey}:${action}:${deliveryId}` and short-circuits before
  // resolveDependabotAlertIssue runs. That is the outermost of the two dedupe
  // layers, and this pins it: the replay is dropped whole, so the row is left
  // exactly as the *previous* delivery left it -- still closed. The
  // comment-level guard is a separate layer, exercised by the next test.
  it("short-circuits a replayed re-fire delivery at the wake pre-check", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");
    await postDependabot(app, dependabotPayload("critical", "reintroduced"), "delivery-refire-4");

    // Close it again, then replay the exact same re-fire delivery id.
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed-2");
    const replay = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-4",
    );

    // The replay was dropped at the wake gate, so no wake fired...
    expect(replay.body).toMatchObject({ dependabotWakeFired: false });

    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(alertIssues).toHaveLength(1);
    // ...and the reopen never ran, so the row is still where delivery-fixed-2
    // left it. Asserting the status is what separates "deduped" from "silently
    // processed twice"; the row count alone cannot tell those apart.
    expect(alertIssues[0]!.status).toBe("done");

    const refireComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, alertIssues[0]!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    // Exactly the one written by the first (non-replayed) re-fire.
    expect(refireComments).toHaveLength(1);
  });

  // The inner layer: a delivery that gets PAST the wake pre-check but carries a
  // delivery id already seen by the reopen path. `reintroduced` and `reopened`
  // produce distinct wake idempotency keys for the same delivery id, so the
  // second one runs the reopen for real -- and the refire comment's externalKey
  // (`${originId}:refire:${deliveryId}`) collides, so onConflictDoNothing is the
  // only thing preventing a duplicate notice. Unlike the test above, the row IS
  // re-queued here, which is what proves the guard suppressed the comment
  // rather than the whole delivery.
  it("dedupes a re-fire comment on delivery id when the reopen path runs twice", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");

    const first = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-shared",
    );
    expect(first.body).toMatchObject({ dependabotWakeFired: true });

    // Close it, then re-fire under a DIFFERENT action with the SAME delivery
    // id: distinct wake key, identical comment externalKey.
    await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed-3");
    const second = await postDependabot(
      app,
      dependabotPayload("critical", "reopened"),
      "delivery-refire-shared",
    );
    expect(second.body).toMatchObject({ dependabotWakeFired: true });

    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(alertIssues).toHaveLength(1);
    // The reopen DID run this time -- the row came back out of `done`.
    expect(alertIssues[0]!.status).toBe("todo");
    expect(alertIssues[0]!.assigneeAgentId).toBe(agentId);

    // ...but the notice was not stacked.
    const refireComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, alertIssues[0]!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    expect(refireComments).toHaveLength(1);
    // The surviving comment is the first delivery's, not the second's.
    expect(refireComments[0]!.body).toContain("Action: `reintroduced`");
  });

  // BLO-28981 / BLO-28864: cancelling an alert issue is a deliberate "stop
  // re-adjudicating this" decision, and it is the only suppression lever the
  // intake has. Reopening a cancelled row would null out `cancelledAt` and
  // re-queue the alert on every subsequent re-fire forever, leaving no way to
  // silence a phantom alert at all.
  it("suppresses a re-fire against a cancelled alert issue instead of reopening it", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    const [originalIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));

    // A human cancels it: this alert is not worth re-adjudicating.
    const cancelledAt = new Date("2026-08-19T00:00:00.000Z");
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt })
      .where(eq(issues.id, originalIssue!.id));

    const refire = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-cancelled",
    );
    expect(refire.status).toBe(200);
    // No agent was woken -- that cost is exactly what cancelling stops.
    expect(refire.body).toMatchObject({ dependabotWakeFired: false });

    const alertIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    // Still no new row, AND the cancellation survived intact.
    expect(alertIssues).toHaveLength(1);
    expect(alertIssues[0]!.status).toBe("cancelled");
    expect(alertIssues[0]!.cancelledAt).toEqual(cancelledAt);

    // The suppressed delivery is auditable rather than silently dropped.
    const suppressed = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, originalIssue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire_suppressed'`,
        ),
      );
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.body).toContain("not** re-queued");
    expect(suppressed[0]!.body).toContain("GitHub delivery: `delivery-refire-cancelled`");
    expect(suppressed[0]!.body).toContain(cancelledAt.toISOString());

    // And it was not reopened by the other path.
    const refireComments = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, originalIssue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_refire'`,
        ),
      );
    expect(refireComments).toHaveLength(0);
  });

  // The suppression lever above has to survive the alert's OWN lifecycle, not
  // just a re-fire. `recordDependabotTerminalReceipt` resolves its target with a
  // fallback query that has no status filter, so a later terminal delivery
  // (`fixed`, or any dismissal) lands on the cancelled row -- and moving it to
  // `done` would null `cancelledAt` and hand every subsequent re-fire back to
  // the reopen path, defeating the suppression through a different door.
  it("does not un-cancel an alert issue when a later terminal delivery arrives", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");
    const [originalIssue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));

    const cancelledAt = new Date("2026-08-19T00:00:00.000Z");
    await db
      .update(issues)
      .set({ status: "cancelled", cancelledAt })
      .where(eq(issues.id, originalIssue!.id));

    // `fixed` sets hasCompleteTerminalEvidence unconditionally -- the ordinary
    // way this arrives, not a contrived payload.
    const terminal = await postDependabot(
      app,
      dependabotPayload("critical", "fixed"),
      "delivery-terminal-after-cancel",
    );
    expect(terminal.status).toBe(200);

    const afterTerminal = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(afterTerminal).toHaveLength(1);
    expect(afterTerminal[0]!.status).toBe("cancelled");
    expect(afterTerminal[0]!.cancelledAt).toEqual(cancelledAt);

    // The terminal delivery is still recorded, so nothing is silently dropped.
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, originalIssue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toHaveLength(1);

    // The proof that matters: the lever still works afterwards. A re-fire is
    // still suppressed rather than reopening a now-`done` row.
    const refire = await postDependabot(
      app,
      dependabotPayload("critical", "reintroduced"),
      "delivery-refire-after-terminal",
    );
    expect(refire.status).toBe(200);
    expect(refire.body).toMatchObject({ dependabotWakeFired: false });

    const afterRefire = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(afterRefire).toHaveLength(1);
    expect(afterRefire[0]!.status).toBe("cancelled");
    expect(afterRefire[0]!.cancelledAt).toEqual(cancelledAt);
  });

  it("dedupes terminal delivery replays against legacy metadata-key receipts", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).toBe("todo");

    const externalKey = "github-dependabot:Blockcast/paperclip#58:fixed:delivery-fixed";
    await db.insert(issueComments).values({
      companyId: issue!.companyId,
      issueId: issue!.id,
      authorType: "system",
      idempotencyKey: null,
      body: "legacy terminal receipt",
      metadata: {
        kind: "github_dependabot_terminal_receipt",
        source: "github",
        externalKey,
        repoFullName: "Blockcast/paperclip",
        alertNumber: 58,
        action: "fixed",
        deliveryId: "delivery-fixed",
      } as never,
    });

    const terminal = await postDependabot(app, dependabotPayload("critical", "fixed"), "delivery-fixed");
    expect(terminal.status).toBe(200);

    const [closedIssue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue!.id));
    expect(closedIssue?.status).toBe("done");

    const receipts = await db
      .select({
        body: issueComments.body,
        idempotencyKey: issueComments.idempotencyKey,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          isNull(issueComments.deletedAt),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toEqual([
      {
        body: "legacy terminal receipt",
        idempotencyKey: null,
      },
    ]);
  });

  // BLO-19037: the receipt dedup guard was a read-then-insert -- two
  // concurrent deliveries of the same event both observe "no existing
  // receipt" before either writes, so both write. A *sequential* replay (the
  // "records a terminal webhook receipt" test above, and the orphan-issue
  // test below) does not exercise that window: each request's INSERT
  // completes and commits before the next request runs its SELECT. Firing
  // both requests through `Promise.all` interleaves them at the same await
  // boundaries a second paperclip-api replica would race across.
  it("dedupes concurrent replays of the same terminal delivery to a single receipt comment", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("critical", "created"), "delivery-created");

    // Warm the connection pool to >=2 physical connections before racing.
    // Every prior test in this suite runs its queries sequentially, so by
    // this point the pool has settled on exactly one warm connection; firing
    // only two concurrent requests here would let the first reuse that warm
    // connection while the second cold-establishes a brand new one (tens of
    // ms on embedded Postgres), which is slow enough that the first request
    // always finishes before the second even starts its query -- masking the
    // race instead of exercising it.
    await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select 1`)));

    const terminalPayload = dependabotPayload("critical", "fixed");
    const [first, second] = await Promise.all([
      postDependabot(app, terminalPayload, "delivery-fixed-concurrent"),
      postDependabot(app, terminalPayload, "delivery-fixed-concurrent"),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).toBe("done");

    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toContain("GitHub delivery: `delivery-fixed-concurrent`");
  });

  it("records dismissal evidence before closing a Dependabot alert issue", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });
    const dismissed = dependabotPayload("high", "dismissed");
    Object.assign(dismissed.alert, {
      dismissed_reason: "tolerable_risk",
      dismissed_comment: "The vulnerable code path is not used in production.",
    });

    await postDependabot(app, dependabotPayload("high", "created"), "delivery-created");
    await postDependabot(app, dismissed, "delivery-dismissed");

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.description).toContain("a documented dismissal reason is recorded");
    expect(issue?.status).toBe("done");

    const [receipt] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipt?.body).toContain('Dismissal reason: "tolerable_risk"');
    expect(receipt?.body).toContain(
      'Dismissal comment: "The vulnerable code path is not used in production."',
    );
    expect(receipt?.metadata).toMatchObject({
      dismissalReason: "tolerable_risk",
      dismissalComment: "The vulnerable code path is not used in production.",
    });
  });

  it("keeps a dismissed Dependabot alert issue open when the webhook has no documented reason", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("high", "created"), "delivery-created");
    await postDependabot(app, dependabotPayload("high", "dismissed"), "delivery-dismissed");

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).not.toBe("done");
  });

  it("keeps a dismissed Dependabot alert issue open when the webhook only has a comment", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });
    const dismissed = dependabotPayload("high", "dismissed");
    Object.assign(dismissed.alert, {
      dismissed_comment: "The vulnerable code path is not used in production.",
    });

    await postDependabot(app, dependabotPayload("high", "created"), "delivery-created");
    await postDependabot(app, dismissed, "delivery-dismissed");

    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#58"));
    expect(issue?.status).not.toBe("done");

    const [receipt] = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issue!.id),
          sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`,
        ),
      );
    expect(receipt?.body).toContain("Dismissal reason: not provided in the webhook payload");
    expect(receipt?.body).toContain(
      'Dismissal comment: "The vulnerable code path is not used in production."',
    );
  });

  it("creates a durable closed receipt issue for an orphan terminal delivery", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const dismissed = dependabotPayload("high", "dismissed", 1591);
    Object.assign(dismissed.alert, { dismissed_reason: "not_used" });
    await postDependabot(app, dismissed, "delivery-dismissed");
    await postDependabot(app, dismissed, "delivery-dismissed");
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1591"));

    expect(issue?.status).toBe("done");
    expect(issue?.title).toContain("terminal receipt");
    expect(issue?.description).toContain("delivery-dismissed");
    expect(issue?.description).toContain(
      "has a documented dismissal reason from a permitted webhook delivery",
    );
    expect(issue?.description).not.toContain("dismissal reason or comment");
    const receiptIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1591"));
    expect(receiptIssues).toHaveLength(1);
    const receipts = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(sql`${issueComments.metadata}->>'kind' = 'github_dependabot_terminal_receipt'`);
    expect(receipts).toHaveLength(1);
  });

  it("records an incomplete orphan terminal dismissal as diagnostic before a reintroduced remediation issue", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });
    const originId = "github-dependabot:Blockcast/paperclip#1593";

    await postDependabot(app, dependabotPayload("high", "dismissed", 1593), "delivery-orphan-dismissed");

    const orphanAlertIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.originId, originId));
    expect(orphanAlertIssues).toHaveLength(0);

    const [diagnostic] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "github_dependabot_webhook_diagnostic"),
          eq(issues.originId, "dependabot_alert:delivery-orphan-dismissed"),
        ),
      );
    expect(diagnostic?.status).toBe("todo");
    expect(diagnostic?.description).toContain("did not include a documented dismissal reason");

    const reintroduced = await postDependabot(
      app,
      dependabotPayload("high", "reintroduced", 1593),
      "delivery-reintroduced",
    );
    expect(reintroduced.body).toMatchObject({ dependabotWakeFired: true });

    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, "github_dependabot_alert"), eq(issues.originId, originId)));
    expect(issue?.status).toBe("todo");
    expect(issue?.title).toContain("vitest");
    expect(issue?.description).toContain("Vulnerable range: < 3.2.6");
    expect(issue?.description).toContain("Patched version: 3.2.6");
    expect(issue?.description).not.toContain("terminal receipt");
  });

  it("records terminal receipts below the remediation severity floor", async () => {
    const { agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    await postDependabot(app, dependabotPayload("medium", "fixed", 1592), "delivery-medium-fixed");
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, "github-dependabot:Blockcast/paperclip#1592"));

    expect(issue?.status).toBe("done");
  });

  it("records a durable diagnostic instead of silently dropping a malformed alert payload", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const res = await postDependabot(
      app,
      { action: "created", alert: {}, repository: { full_name: "Blockcast/paperclip" } },
      "delivery-malformed",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);

    const diagnostics = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_webhook_diagnostic")));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.assigneeAgentId).toBe(agentId);
    expect(diagnostics[0]!.description).toContain("dependabot_alert");
    expect(diagnostics[0]!.description).toContain("delivery-malformed");
    expect(diagnostics[0]!.description).toContain("Blockcast/paperclip");
  });

  it("records a durable diagnostic when the alert payload has no repository", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Release Engineer" });
    const app = buildApp({ dependabotAgentId: agentId });

    const payloadWithoutRepo: Record<string, unknown> = { ...dependabotPayload("critical") };
    delete payloadWithoutRepo.repository;
    const res = await postDependabot(app, payloadWithoutRepo, "delivery-no-repo");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dependabotWakeFired: false });

    const diagnostics = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "github_dependabot_webhook_diagnostic")));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.description).toContain("#58");
    expect(diagnostics[0]!.description).toContain("delivery-no-repo");
  });
});

describe("hasActionablePrReviewFeedback — reviewer taxonomy", () => {
  // Regression guard for the #973 / BLO-12541 stall: a same-identity self-review
  // arrives as an issue_comment (no formal `changes_requested` state), so the
  // author wake depends entirely on the body-text heuristic. The reviewer's
  // output had drifted to "Critical Issues" + "before merging", which the old
  // heuristic ("Important Issues" + "before merge") silently missed.
  it("treats a 'Critical Issues (N>0)' bucket as actionable", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "### Critical Issues (1)",
      "- probePort points at :3443 but the Service only listens on :443.",
      "### Recommended Action",
      "1. Fix the probePort mismatch (Critical) before merging.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("matches the 'before merging' inflection in the recommended-action heuristic", () => {
    const body = "### Recommended Action\nFix the dial host before merging.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("still detects the legacy 'Important Issues' + 'before merge' format", () => {
    const body = "### Important Issues (1)\n\n### Recommended Action\nFix I1 before merge.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask a non-zero bucket that follows a zero-count bucket", () => {
    const body = "### Critical Issues (0)\n### Important Issues (2)\n- one\n- two";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask an uncounted heading with another label's zero-count bucket", () => {
    const body = [
      "### Critical Issues (0)",
      "",
      "### Important Issues",
      "- Auth check bypasses validation.",
      "",
      "### Recommended Action",
      "Fix before shipping.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("does not mask an uncounted heading with the same label's zero-count bucket", () => {
    const body = [
      "### Important Issues (0)",
      "",
      "### Important Issues",
      "- Retry logic can still drop the author wake.",
      "",
      "### Recommended Action",
      "Fix before shipping.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("is not actionable when only zero-count severity buckets are present", () => {
    const body = "### Critical Issues (0)\n### Important Issues (0)\n\nLGTM, ship it.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(false);
  });

  it("is not actionable when emphasized severity headings only carry zero counts", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "### **Critical Issues** (0)",
      "None.",
      "",
      "### **Important Issues** (0)",
      "None.",
      "",
      "### Recommended Action",
      "Merge when required CI passes.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "approved")).toBe(false);
  });

  it("still treats emphasized non-zero severity buckets as actionable", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "### **Critical Issues** (0)",
      "None.",
      "",
      "### **Important Issues** (1)",
      "- The retry remains stranded.",
      "",
      "### Recommended Action",
      "Fix before merge.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "commented")).toBe(true);
  });

  it("still short-circuits on a formal changes_requested review state", () => {
    expect(__test_hasActionablePrReviewFeedback("looks fine overall", "changes_requested")).toBe(true);
  });

  // Ally review on #654 (BLO-15942): the negation scan originally looked back to
  // the start of the sentence, so a negation cue far earlier in a long sentence
  // could mask a genuine, unrelated "changes requested" later in that same
  // sentence. Bounding the lookback to NEGATION_LOOKBACK_WORDS words shrinks that
  // false-negative window while still suppressing the close-proximity negations
  // (like "No changes requested...") this heuristic exists to catch.
  it("does not let a negation cue far earlier in a long sentence mask a later genuine match", () => {
    const body =
      "not one of these old fixture issues affected the merge outcome whatsoever, so changes requested here.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(true);
  });

  it("still suppresses a negation cue close to the match within the same sentence", () => {
    const body = "Clean pass, no changes requested at this time.";
    expect(__test_hasActionablePrReviewFeedback(body)).toBe(false);
  });

  // BLO-19067: Ally's APPROVED review on Network-Operator-Portal#591 read
  // "Looks good. No Critical or Important issues found." The uncounted-heading
  // branch matched the trailing "Important issues" mid-sentence, classified a
  // clean approval as actionable, and bounced the PR back to its author.
  it("does not treat a prose denial of findings as an uncounted findings heading", () => {
    const body = [
      "## Ally — Consolidated PR Review",
      "",
      "Looks good. No Critical or Important issues found.",
      "",
      "### Recommended Action",
      "1. Merge after required CI completes.",
    ].join("\n");
    expect(__test_hasActionablePrReviewFeedback(body, "approved")).toBe(false);
  });

  it("still matches an uncounted findings heading behind list or emphasis decoration", () => {
    expect(__test_hasActionablePrReviewFeedback("- Important Issues\n- Auth check bypassed.")).toBe(true);
    expect(__test_hasActionablePrReviewFeedback("**Critical Issues**\nprobePort mismatch.")).toBe(true);
  });
});

describe("PR review feedback comment heading (BLO-19067)", () => {
  // The heading and the directive beneath it are the highest-salience text in
  // the wake this comment produces. Hardcoding them to the changes-requested
  // case told the author of an APPROVED PR to make another implementation
  // pass; the resulting no-op push invalidates the approval and restarts a
  // 2.2h CI suite.
  const reviewPayload = (state: string, body: string) => ({
    action: "submitted",
    pull_request: {
      number: 591,
      title: "fix(nop): dynamic-service card spacing",
      head: { ref: "fix/BLO-18833", sha: "1db166824d532cda20e321ebb26c6e4702e0dd32" },
    },
    review: {
      body,
      state,
      html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/591#pullrequestreview-1",
      user: { login: "allyblockcast" },
    },
    repository: { full_name: "Blockcast/Network-Operator-Portal" },
  });

  const commentFor = (state: string, body = "### Critical Issues (1)\n- probePort mismatch.") => {
    const ctx = __test_resolveEventContext("pull_request_review", reviewPayload(state, body));
    expect(ctx).not.toBeNull();
    return __test_buildPrReviewFeedbackComment(ctx!);
  };

  it("titles an APPROVED review as approved, with no implementation-pass directive", () => {
    const comment = commentFor("approved");
    expect(comment).toContain("## Review Approved");
    expect(comment).not.toContain("Changes Requested");
    expect(comment).not.toContain("requires another implementation pass");
    expect(comment).toContain("- State: approved");
  });

  it("titles a CHANGES_REQUESTED review as changes requested", () => {
    const comment = commentFor("changes_requested");
    expect(comment).toContain("## Changes Requested");
    expect(comment).toContain("requires another implementation pass");
    expect(comment).not.toContain("Review Approved");
    // BLO-19497 AC: the reviewed head SHA is recorded so a reader can tell a
    // stale review from a current one.
    expect(comment).toContain("Reviewed head SHA: `1db166824d532cda20e321ebb26c6e4702e0dd32`");
  });

  it("distinguishes a COMMENTED review from both other states", () => {
    const comment = commentFor("commented");
    expect(comment).toContain("## Review Comments");
    expect(comment).not.toContain("Changes Requested");
    expect(comment).not.toContain("Review Approved");
    expect(comment).not.toContain("requires another implementation pass");
  });

  it("keeps the changes-requested wording when no review state is present", () => {
    // Body-heuristic path: an `issue_comment` review carries no formal state
    // and only reaches this builder when the body already carries findings.
    const ctx = __test_resolveEventContext("issue_comment", {
      action: "created",
      issue: {
        number: 591,
        pull_request: { url: "https://api.github.com/repos/Blockcast/Network-Operator-Portal/pulls/591" },
        user: { login: "codex-bot" },
      },
      comment: {
        id: 1,
        body: "### Important Issues (1)\n\nI1: wrong route.",
        html_url: "https://github.com/Blockcast/Network-Operator-Portal/pull/591#issuecomment-1",
        user: { login: "allyblockcast[bot]" },
      },
      repository: { full_name: "Blockcast/Network-Operator-Portal" },
    });
    expect(ctx).not.toBeNull();
    const comment = __test_buildPrReviewFeedbackComment(ctx!);
    expect(comment).toContain("## Changes Requested");
  });
});

describe("GitHub review state → stage signal mapping (BLO-15942)", () => {
  // Fixture derived from the real payload shape of Ally's review 4682219268 on
  // Blockcast/trafficcontrol#1115: a COMMENTED, zero-Critical/Important-finding
  // confirmation pass ("No changes requested from this lens"). The old heuristic's
  // bare `changes\s+requested` match fired on that negated phrase and emitted a
  // `## Changes Requested` system comment, bouncing a fully-approved deliverable
  // and deadlocking BLO-15813's review stage (only the mandate-bound reviewer
  // could act on it, and it correctly declined).
  const commentedZeroFindingsReviewPayload = {
    action: "submitted",
    pull_request: {
      number: 1115,
      title: "design(marketplace): location-vocabulary translator",
      head: { ref: "feat/BLO-15022", sha: "f88a7442e43f54b967b400a710bcfe943fc741da" },
    },
    review: {
      body: [
        "## Ally — Consolidated PR Review",
        "",
        "### Critical Issues (0)",
        "None.",
        "",
        "### Important Issues (0)",
        "None. Both of kkroo's blocking findings are correctly resolved in f88a7442e:",
        "",
        "### Recommended Action",
        "Clean. No changes requested from this lens - ready per kkroo's \"merge on full-CI green\" gate.",
      ].join("\n"),
      state: "commented",
      html_url: "https://github.com/Blockcast/trafficcontrol/pull/1115#pullrequestreview-4682219268",
      user: { login: "allyblockcast[bot]" },
    },
    repository: { full_name: "Blockcast/trafficcontrol" },
  };

  it("COMMENTED + zero-finding body maps to a neutral signal, not changes_requested", () => {
    const ctx = __test_resolveEventContext("pull_request_review", commentedZeroFindingsReviewPayload);
    expect(ctx?.reviewState).toBe("commented");
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(false);
  });

  it("CHANGES_REQUESTED maps to changes_requested even with an otherwise-clean body", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      ...commentedZeroFindingsReviewPayload,
      review: { ...commentedZeroFindingsReviewPayload.review, state: "changes_requested" },
    });
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(true);
  });

  it("APPROVED does not map to changes_requested", () => {
    const ctx = __test_resolveEventContext("pull_request_review", {
      ...commentedZeroFindingsReviewPayload,
      review: {
        ...commentedZeroFindingsReviewPayload.review,
        state: "approved",
        body: "Approved — merge on full-CI green.",
      },
    });
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(false);
  });
});

describe("PR→issue back-link (BLO-13353)", () => {
  it("builds an absolute issue URL from the public base, prefix, and identifier", () => {
    expect(__test_backLinkAbsoluteUrl("https://paperclip.blockcast.net", "BLO", "BLO-12541")).toBe(
      "https://paperclip.blockcast.net/BLO/issues/BLO-12541",
    );
  });

  it("strips a trailing slash on the public base and falls back to 'company' prefix when blank", () => {
    expect(__test_backLinkAbsoluteUrl("https://paperclip.blockcast.net/", "", "PAP-1")).toBe(
      "https://paperclip.blockcast.net/company/issues/PAP-1",
    );
  });

  it("renders a marked, linked comment body for one issue", () => {
    const body = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-12541", issuePrefix: "BLO" },
    ]);
    expect(body).toContain("<!-- paperclip-issue-backlink -->");
    expect(body).toContain("[BLO-12541](https://p.example/BLO/issues/BLO-12541)");
  });

  it("lists every matched issue when a PR maps to more than one", () => {
    const body = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-1", issuePrefix: "BLO" },
      { identifier: "PAP-2", issuePrefix: "PAP" },
    ]);
    expect(body).toContain("[BLO-1](https://p.example/BLO/issues/BLO-1)");
    expect(body).toContain("[PAP-2](https://p.example/PAP/issues/PAP-2)");
  });

  it("detects the dedup marker so a re-post is suppressed, and ignores unmarked comments", () => {
    const posted = __test_buildIssueBackLinkBody("https://p.example", [
      { identifier: "BLO-1", issuePrefix: "BLO" },
    ]);
    expect(__test_commentsContainBackLinkMarker(["unrelated", posted])).toBe(true);
    expect(__test_commentsContainBackLinkMarker(["just a normal comment", "LGTM"])).toBe(false);
    expect(__test_commentsContainBackLinkMarker([])).toBe(false);
  });
});

describe("self-review non-convergence detection (BLO-13353)", () => {
  const ctx = (prAuthorLogin: string | null) =>
    ({ prAuthorLogin }) as unknown as Parameters<typeof __test_isSelfReviewedPr>[0];

  it("flags a PR authored by the reviewer bot as a self-review (case-insensitive)", () => {
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), "allyblockcast[bot]")).toBe(true);
    expect(__test_isSelfReviewedPr(ctx("AllyBlockcast[bot]"), "allyblockcast[bot]")).toBe(true);
  });

  it("does not flag a PR authored by someone other than the reviewer bot", () => {
    expect(__test_isSelfReviewedPr(ctx("some-human"), "allyblockcast[bot]")).toBe(false);
  });

  it("returns false when the author or reviewer-bot login is missing", () => {
    expect(__test_isSelfReviewedPr(ctx(null), "allyblockcast[bot]")).toBe(false);
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), null)).toBe(false);
    expect(__test_isSelfReviewedPr(ctx("allyblockcast[bot]"), "")).toBe(false);
  });
});

// BLO-23059: Claude Code Review's "paused" org-settings notice arrives as a
// FORMAL pull_request_review (state COMMENTED, commit_id = current head), so
// BLO-21489's existence + non-staleness check passes it and both wakes fire —
// the reviewer counter-review pass and the PR-author wake whose directive claims
// "a reviewer just posted findings on YOUR pull request".
describe("claude[bot] Code Review service notice suppression (BLO-23059)", () => {
  // Verbatim body of review 4887250738 on Blockcast/Network-Operator-Portal#657,
  // read from the GitHub API on 2026-08-10. Do not paraphrase: the whole point of
  // the filter is that it keys on this exact notice rather than on the absence of
  // findings.
  const PAUSED_NOTICE_BODY = [
    "## Claude Code Review",
    "",
    "**Claude Code Review is paused for this repository.** To reconnect it, an admin of this " +
      "repository's GitHub organization (or the account owner, for personal repositories) who can " +
      "also manage your Claude organization's Code Review settings needs to re-link GitHub in " +
      "[Code Review settings](https://claude.ai/admin-settings/claude-code). This is a one-time step.",
    "",
    "<sub>Tip: disable this comment in your organization's " +
      "[Code Review settings](https://claude.ai/admin-settings/claude-code).</sub>",
  ].join("\n");

  const reviewPayload = (
    overrides: { body?: string; state?: string; login?: string; type?: string | null } = {},
  ) => ({
    action: "submitted",
    pull_request: {
      number: 657,
      title: "cdnplus-a8: pin the measured tint population",
      head: { ref: "feat/cdnplus-a8", sha: "3ff9b6390000000000000000000000000000000a" },
      user: { login: "allyblockcast[bot]" },
    },
    review: {
      body: overrides.body ?? PAUSED_NOTICE_BODY,
      state: overrides.state ?? "commented",
      html_url:
        "https://github.com/Blockcast/Network-Operator-Portal/pull/657#pullrequestreview-4887250738",
      user: {
        login: overrides.login ?? "claude[bot]",
        // GitHub's own account classification. "type" in overrides is honoured
        // even when explicitly null, so the absent-field case is testable.
        type: "type" in overrides ? overrides.type : "Bot",
      },
    },
    repository: { full_name: "Blockcast/Network-Operator-Portal" },
  });

  const resolve = (
    payload: ReturnType<typeof reviewPayload>,
    onSuppressedReviewSubmission?: (info: unknown) => void,
  ) =>
    __test_resolveEventContext("pull_request_review", payload, {
      prReviewerBotLogin: "allyblockcast[bot]",
      ...(onSuppressedReviewSubmission ? { onSuppressedReviewSubmission } : {}),
    });

  it("drops the paused notice at the event, killing both wakes", () => {
    const ctx = resolve(reviewPayload());
    // null context is the common ancestor of BOTH wake sites: the reviewer wake
    // (shouldFirePrReviewerWake) and the PR-author wake (the `isPrWake` fallback,
    // which fires for any github_pr_* reason with a prNumber regardless of
    // isActionableReviewFeedbackContext).
    expect(ctx).toBeNull();
    expect(__test_shouldFirePrReviewerWake(ctx)).toBe(false);
  });

  it("reports the suppression with review-shaped provenance", () => {
    const seen: unknown[] = [];
    expect(resolve(reviewPayload(), (info) => seen.push(info))).toBeNull();
    expect(seen).toEqual([
      {
        repoFullName: "Blockcast/Network-Operator-Portal",
        prNumber: 657,
        reviewAuthorLogin: "claude[bot]",
        reviewState: "commented",
        reviewUrl:
          "https://github.com/Blockcast/Network-Operator-Portal/pull/657#pullrequestreview-4887250738",
      },
    ]);
  });

  it("does not suppress a terse but genuine review — the false-suppression case", () => {
    // The named objection to filtering at the webhook. A findings-free rule would
    // eat these; a named-instance rule cannot, because neither carries the notice.
    for (const body of ["LGTM", "One nit inline, otherwise good.", ""]) {
      const ctx = resolve(reviewPayload({ body }));
      expect(ctx, `terse body ${JSON.stringify(body)} must survive`).not.toBeNull();
      expect(ctx?.wakeReason).toBe("github_pr_review_submitted");
    }
  });

  it("does not suppress a human or a non-Claude bot quoting the notice", () => {
    // Someone discussing THIS issue in a review must still reach the author.
    for (const login of ["kkroo", "allyblockcast[bot]", "dependabot[bot]"]) {
      const ctx = resolve(reviewPayload({ login }));
      expect(ctx, `login ${login} must survive`).not.toBeNull();
    }
  });

  it("does not suppress the bare `claude` / `claude-code` USER accounts", () => {
    // Ally review on #1255: the login matcher originally made the `[bot]` suffix
    // optional, so these two — ordinary registerable GitHub logins, not the App —
    // matched. A person on either account reviewing a PR that quotes the notice
    // (this repo's own PRs do) would have had BOTH their wakes silently dropped.
    // Suffix required + type gate, so each of the three shapes below fails alone.
    for (const [login, type] of [
      ["claude", "User"],
      ["claude-code", "User"],
      // Right login shape, but GitHub does not call it a Bot — fail open.
      ["claude[bot]", "User"],
    ] as const) {
      const ctx = resolve(reviewPayload({ login, type }));
      expect(ctx, `${login} (${type}) must survive`).not.toBeNull();
      expect(ctx?.wakeReason).toBe("github_pr_review_submitted");
    }
  });

  it("fails open when the payload carries no user type at all", () => {
    // Absent `type` must not be read as Bot: an unrecognised payload shape
    // regresses to today's behaviour rather than dropping a real review.
    const ctx = resolve(reviewPayload({ type: null }));
    expect(ctx).not.toBeNull();
  });

  it("does not suppress a claude[bot] review that carries the notice AND findings", () => {
    const ctx = resolve(
      reviewPayload({ body: `${PAUSED_NOTICE_BODY}\n\n### Critical Issues (1)\n- auth bypass.` }),
    );
    expect(ctx).not.toBeNull();
    expect(__test_hasActionablePrReviewFeedback(ctx?.reviewBody, ctx?.reviewState)).toBe(true);
  });

  it("does not suppress a merge-gate review state", () => {
    // APPROVED / CHANGES_REQUESTED carry a gate signal regardless of body text.
    for (const state of ["approved", "changes_requested", "dismissed"]) {
      expect(resolve(reviewPayload({ state })), `state ${state} must survive`).not.toBeNull();
    }
  });

  describe("isClaudeCodeReviewServiceNotice — predicate", () => {
    const notice = (body: string, state = "commented", login = "claude[bot]", type = "Bot") =>
      __test_isClaudeCodeReviewServiceNotice(body, state, login, type);

    it("matches the paused and disabled variants under any heading depth", () => {
      expect(notice(PAUSED_NOTICE_BODY)).toBe(true);
      expect(
        notice("### Claude Code Review\n\nClaude Code Review is disabled for this repository."),
      ).toBe(true);
    });

    it("requires the heading, the sentence, and a Claude author together", () => {
      // Sentence without the heading.
      expect(notice("Claude Code Review is paused for this repository.")).toBe(false);
      // Heading without the sentence.
      expect(notice("## Claude Code Review\n\nTwo findings below.")).toBe(false);
      // Both, wrong author.
      expect(notice(PAUSED_NOTICE_BODY, "commented", "kkroo")).toBe(false);
      // A heading that merely mentions the phrase mid-line is not the notice heading.
      expect(
        notice("## Notes on Claude Code Review\n\nClaude Code Review is paused for this repository."),
      ).toBe(false);
    });

    it("requires the [bot] suffix AND a Bot user type", () => {
      // The two halves of the Ally-#1255 narrowing, pinned independently so
      // neither can be dropped without reddening a test.
      expect(notice(PAUSED_NOTICE_BODY, "commented", "claude")).toBe(false);
      expect(notice(PAUSED_NOTICE_BODY, "commented", "claude-code")).toBe(false);
      expect(notice(PAUSED_NOTICE_BODY, "commented", "claude[bot]", "User")).toBe(false);
      expect(notice(PAUSED_NOTICE_BODY, "commented", "claude-code[bot]", "Bot")).toBe(true);
    });

    it("rejects absent author or body rather than throwing", () => {
      expect(notice(PAUSED_NOTICE_BODY, "commented", null as unknown as string)).toBe(false);
      expect(notice(null as unknown as string)).toBe(false);
      expect(
        __test_isClaudeCodeReviewServiceNotice(PAUSED_NOTICE_BODY, null, "claude[bot]", "Bot"),
      ).toBe(false);
      // Absent user type => fail open.
      expect(
        __test_isClaudeCodeReviewServiceNotice(
          PAUSED_NOTICE_BODY,
          "commented",
          "claude[bot]",
          null,
        ),
      ).toBe(false);
    });
  });
});
